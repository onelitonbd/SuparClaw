import { EventEmitter } from "node:events";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ConfigService } from "../config/load.js";
import type { SuparClawConfig } from "../config/schema.js";
import { Store } from "../state/db.js";
import { createLogger, type Logger } from "../util/log.js";
import { dbPath, ensureDirs, logsDir, readTextSafe, stateDir, workspaceDir } from "../util/paths.js";
import { AgentLoop, type QueueMode, type RunEvent } from "../agent/loop.js";
import { Subagents } from "../agent/subagents.js";
import { LlmClient, resolveModel } from "../agent/llm.js";
import { modelProfile } from "../config/schema.js";
import { DREAM_SESSION_KEY, armDream, cleanTitle, titlePrompt, type DreamHandle, runSweep, promotePreview, backfillPreview, lightStage, consolidateGated } from "../agent/dream.js";
import { writeWorkspaceTemplates, todayStamp } from "../agent/workspace.js";
import { resolveConfiguredProviders, markAuthOutcome, profileStatus, profileCheck, profileId, resolveAuthProfileOrder } from "../agent/auth.js";
import { pluginById } from "../agent/provider-plugins.js";
import { deviceLogin } from "../agent/oauth-device.js";
import { fetchModels } from "../config/providers.js";
import { TelegramChannel } from "../channels/telegram.js";
import { Scheduler } from "../cron/scheduler.js";

export interface ChatPayload {
  sessionKey: string;
  text: string;
  isMainSession?: boolean;
  source: "tui" | "gateway" | "telegram" | "cron" | "cli";
  /** Per-run model override (surface-level choice); unset means the default. */
  model?: string;
  /** Per-run thinking effort override; unset means session/default policy. */
  reasoning?: string;
  /** chat.send parity: force the queue mode just for this message. */
  queueMode?: QueueMode;
  reply: (text: string) => void | Promise<void>;
  onDelta?: (delta: string) => void | Promise<void>;
  onTool?: (event: Extract<RunEvent, { type: "tool" }>) => void | Promise<void>;
  onApproval?: (event: Extract<RunEvent, { type: "approval" }>) => void | Promise<void>;
}

export type ServiceEvent =
  | { type: "chat"; sessionKey: string; event: RunEvent }
  | { type: "presence"; online: boolean }
  | { type: "tick"; at: number }
  /** Session row changed (auto-title landed) — UIs refresh their list. */
  | { type: "session.updated"; sessionKey: string; name: string };

const APPROVAL_TIMEOUT_MS = 90_000;

export class Service {
  readonly log: Logger;
  readonly configSvc: ConfigService;
  readonly store: Store;
  readonly loop: AgentLoop;
  readonly events = new EventEmitter();
  readonly startedAt = Date.now();

  #telegram: TelegramChannel | null = null;
  #cron: Scheduler | null = null;
  #dream: DreamHandle | null = null;
  #dreamSig = "";
  #titleBusy = new Set<string>();
  #approvals = new Map<string, (ok: boolean) => void>();
  #closing = false;
  /** Sub-agent lifecycle owner (spawn/yield/announce/cancel). */
  #subagents: Subagents | null = null;
  /** Channel sinks for internal announcements (telegram replies need a send). */
  #channelSinks = new Map<string, (text: string) => void | Promise<void>>();

  constructor(configPathOverride?: string) {
    ensureDirs();
    this.log = createLogger({ file: join(logsDir(), "suparclaw.log") });
    this.configSvc = new ConfigService(this.log, configPathOverride);
    this.store = Store.open(dbPath());
    this.store.setMeta("state_dir", stateDir());
    const config = this.configSvc.current;
    // Auth-profile binding: providers resolve credentials from the stored
    // profiles (literal keys untouched); health outcomes flow back to the
    // profile store (cooldown/last-good).
    const llm = new LlmClient(
      this.#authProviders().providers,
      { model: config.agents.defaults.model, fallbacks: config.agents.defaults.fallbacks },
      (info) => this.log.warn(`llm retry ${info.model} #${info.attempt}: ${info.error}`),
      this.#authHooks(),
    );
    this.loop = new AgentLoop({
      config,
      store: this.store,
      log: this.log,
      llm,
      requestApproval: (callId, tool, args) => this.requestApproval(callId, tool, args),
      onRunFinished: (key, info) => this.#subagents?.onRunFinished(key, info),
    });
    // Boot recovery: children still "running" when the gateway restarted are
    // interrupted — their results stay in the awaiting-delivery prompt block.
    const swept = this.store.sweepInterruptedSubagents();
    if (swept > 0) this.log.info(`subagents: ${swept} interrupted run(s) swept on boot`);
    this.#subagents = new Subagents({
      store: this.store,
      log: this.log,
      loop: this.loop,
      config: () => this.config,
      emitChild: (sessionKey, event) => {
        this.events.emit("event", { type: "chat", sessionKey, event } satisfies ServiceEvent);
        // Announcement/wake turns must reach the session's channel (Telegram
        // gets a real outgoing message, not just the event stream).
        if (event.type === "final") void this.#channelSinks.get(sessionKey)?.(event.text);
      },
    });
    this.loop.setSubagents(this.#subagents);

    this.events.setMaxListeners(64);
  }

  get subagents(): Subagents | null {
    return this.#subagents;
  }

  get config(): SuparClawConfig {
    return this.configSvc.current;
  }

  /** First run scaffolding: workspace files + a generated gateway token. */
  bootstrap(): { created: string[]; token: string } {
    const created: string[] = [];
    const ws = workspaceDir();
    // Self-healing: writeWorkspaceTemplates skips files that already exist, so
    // call it unconditionally — older workspaces (AGENTS.md-only) still get
    // SOUL.md/IDENTITY.md and keep their identity with them.
    created.push(...writeWorkspaceTemplates(ws));
    let token = this.config.gateway.auth.token;
    if (this.config.gateway.auth.mode === "token" && !token) {
      token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
      const result = this.configSvc.setPath("gateway.auth.token", token);
      if (!result.ok) this.log.error(`could not persist gateway token: ${result.errors[0]}`);
      created.push("config.json5 (gateway token)");
    }
    return { created, token };
  }

  /** Push a fresh config into the live components (called after any config write). */
  applyConfig(_next?: SuparClawConfig): void {
    const config = this.config;
    this.loop.setConfig(config);
    this.loop.llm.setConfig(this.#authProviders().providers, config.agents.defaults, this.#authHooks());
    this.log.info(`config applied — model ${config.agents.defaults.model || "(unset)"}`);
  }

  /** Effective providers with stored-profile bindings resolved to material. */
  #authProviders(): { providers: Record<string, import("./llm.js").ProviderConfig>; profileOf: Record<string, string> } {
    return resolveConfiguredProviders(this.store, this.config);
  }

  #authHooks(): { profileOf: Record<string, string>; onOutcome: (id: string, ok: boolean) => void } {
    const { profileOf } = resolveConfiguredProviders(this.store, this.config);
    const store = this.store;
    return { profileOf, onOutcome: (id, ok) => markAuthOutcome(store, id, ok) };
  }

  /** Hot reload for edits made outside config.set (sc config set, hand edits). */
  watchConfig(): void {
    let prev = this.config.channels.telegram;
    this.configSvc.watchForChanges((config) => {
      this.applyConfig(config);
      const tg = config.channels.telegram;
      const changed = tg.enabled !== prev.enabled || tg.token !== prev.token;
      prev = tg;
      if (changed && this.#telegram?.running) {
        void this.#telegram.stop().then(() => {
          if (tg.enabled && tg.token) void this.#startTelegram();
        });
      } else if (changed && tg.enabled && tg.token && !this.#telegram?.running) {
        void this.#startTelegram();
      }
      if (this.#cron) void this.#cron.reconcile();
      void this.armDreaming();
      this.log.info("config hot-reloaded");
    });
  }

  async #startTelegram(): Promise<void> {
    this.#telegram = new TelegramChannel(this, this.log);
    try {
      await this.#telegram.start();
    } catch (err) {
      this.log.error(`telegram failed to start: ${(err as Error).message}`);
    }
  }

  /** Re-arm cron jobs changed outside the daemon (sc cron add, other tools). */
  async cronReconcile(): Promise<void> {
    if (this.#cron) await this.#cron.reconcile();
  }

  /** Arm (or re-arm) the dreaming sweep from config.memory.dreaming. */
  async armDreaming(): Promise<void> {
    const d = this.config.memory?.dreaming;
    const sig = `${d?.enabled ? "1" : "0"}|${d?.schedule ?? ""}`;
    if (sig === this.#dreamSig) return;
    this.#dreamSig = sig;
    this.#dream?.stop();
    this.#dream = null;
    if (!d?.enabled || !d.schedule) return;
    try {
      this.#dream = await armDream(d.schedule, () => this.dreamNow());
      this.log.info(`dreaming sweep armed (${d.schedule})`);
    } catch (err) {
      this.log.error(`dreaming schedule invalid (${d.schedule}): ${(err as Error).message}`);
    }
  }

  /**
   * One dreaming sweep: consolidate the daily notes into MEMORY.md and write
   * the DREAMS.md diary entry. Also the `sc dream` / `dream.run` manual path —
   * an empty sweep ("nothing new") is a normal outcome.
   */
  /**
   * One dreaming sweep (Partial #5): light stages, REM reflects, deep scores
   * and gates, then a tool-free consolidation completion writes MEMORY.md
   * (append-only fallback when the model is unavailable). The completion runs
   * on the agent's default model without a chat session, like theirs.
   */
  async dreamNow(): Promise<string> {
    this.events.emit("event", { type: "chat", sessionKey: DREAM_SESSION_KEY, event: { type: "start", runId: "dream-sweep", sessionKey: DREAM_SESSION_KEY } } satisfies ServiceEvent);
    const verdict = await runSweep({
      store: this.store,
      workspace: workspaceDir(),
      llmComplete: (prompt) => this.#dreamCompletion(prompt),
    });
    this.log.info(`dreaming sweep done: ${verdict.summary.slice(0, 120)}`);
    return verdict.summary;
  }

  /** Tool-free background completion shared by dream consolidation/diary. */
  async #dreamCompletion(prompt: string): Promise<string> {
    let out = "";
    const stream = this.loop.llm.stream({
      messages: [{ role: "user", content: prompt }],
      model: modelProfile(this.config, "").ref,
      maxTokens: 1600,
    });
    for await (const ev of stream) {
      if (ev.type === "text") out += ev.text;
    }
    return out;
  }

  /** `sc dream promote` — deep-phase preview over the staged recall store. */
  dreamPromotePreview(limit: number) {
    return promotePreview(this.store, workspaceDir(), limit);
  }

  /** `sc dream promote --apply` — consolidate the gated candidates now. */
  async dreamPromoteApply(limit: number) {
    const gated = this.dreamPromotePreview(limit).filter((d) => d.verdict === "promote");
    return consolidateGated({ store: this.store, workspace: workspaceDir(), llmComplete: (p) => this.#dreamCompletion(p) }, gated, todayStamp());
  }

  /** `sc dream backfill` lanes (their rem-backfill): preview/stage/rollback. */
  dreamBackfillPreview(days: number) {
    return backfillPreview(workspaceDir(), days);
  }

  dreamBackfillApply(days: number) {
    return lightStage(this.store, backfillPreview(workspaceDir(), days), "backfill");
  }

  dreamBackfillRollback(): number {
    return this.store.rollbackDreamBackfill();
  }

  // ══ auth profiles (Partial #6) — one entry point like their models auth ══

  authProfilesView(provider?: string) {
    const rows = provider ? this.store.authProfiles(provider) : this.store.authProfiles();
    return rows.map((r) => profileStatus(r));
  }

  /** Paste-key login (Control UI "Connect provider" → api-key/token method). */
  async authLoginWithKey(args: { provider: string; method: "api_key" | "token"; material: string; label?: string; setDefault?: boolean }): Promise<
    { ok: boolean; error?: string; profile?: string; models?: number }
  > {
    const id = args.provider.toLowerCase().trim();
    const descriptor = pluginById(id);
    if (!descriptor) return { ok: false, error: `unknown provider "${args.provider}" (custom providers can bind any stored profile id in config)` };
    if (!args.material.trim()) return { ok: false, error: "empty credential" };
    const pid = profileId(id, args.method === "token" ? "token" : "key");
    this.store.upsertAuthProfile({
      id: pid,
      provider: id,
      type: args.method,
      material: args.material.trim(),
      label: args.label?.trim() || `${id} ${args.method === "token" ? "token" : "API key"}`,
    });
    this.#bindProvider(id, descriptor.baseUrl, pid);
    this.applyConfig();
    const models = await this.#refreshCatalog(id, args.material.trim());
    if (args.setDefault && models.length) this.configSvc.setPath("agents.defaults.model", `${id}/${models[0] ?? "model"}`);
    this.#broadcastAuthChanged();
    return { ok: true, profile: pid, models: models.length };
  }

  /** In-flight device-code flows (gateway-mediated wizard, their RPC shape). */
  #deviceFlows = new Map<string, { provider: string; done: Promise<{ ok: boolean; profile?: string; models?: number; error?: string }> }>();

  async authBeginDeviceCode(provider: string): Promise<
    | { ok: true; flow: string; userCode: string; verificationUri: string; interval: number; expiresIn: number }
    | { ok: false; error: string }
  > {
    const id = provider.toLowerCase().trim();
    const descriptor = pluginById(id);
    if (!descriptor?.oauth) return { ok: false, error: `provider "${provider}" offers no device-code method` };
    const flowId = crypto.randomUUID();
    let visible: { userCode: string; verificationUri: string; interval: number; expiresIn: number } | null = null;
    const done = deviceLogin({
      descriptor: descriptor.oauth,
      onCode: (a) => {
        visible = { userCode: a.user_code, verificationUri: a.verification_uri_complete ?? a.verification_uri, interval: a.interval, expiresIn: a.expires_in };
      },
    })
      .then(async (token) => {
        const pid = profileId(id, "oauth");
        this.store.upsertAuthProfile({
          id: pid,
          provider: id,
          type: "oauth",
          material: token.access_token,
          expires: token.expiresAt,
          label: `${id} device-code login`,
        });
        this.#bindProvider(id, descriptor.baseUrl, pid);
        this.applyConfig();
        const models = await this.#refreshCatalog(id, token.access_token);
        this.#deviceFlows.delete(flowId);
        this.#broadcastAuthChanged();
        return { ok: true, profile: pid, models: models.length };
      })
      .catch((err) => {
        this.#deviceFlows.delete(flowId);
        return { ok: false, error: (err as Error).message };
      });
    this.#deviceFlows.set(flowId, { provider: id, done });
    // The code arrives on the first network hop; surface it once known.
    for (let i = 0; i < 100 && !visible; i++) await new Promise((r) => setTimeout(r, 50));
    if (!visible) return { ok: false, error: "device-code request timed out reaching the provider" };
    const v = visible as { userCode: string; verificationUri: string; interval: number; expiresIn: number };
    return { ok: true, flow: flowId, userCode: v.userCode, verificationUri: v.verificationUri, interval: v.interval, expiresIn: v.expiresIn };
  }

  async authPollDeviceCode(flowId: string, opts: { setDefault?: boolean } = {}): Promise<
    { status: "pending" } | { status: "ok"; profile: string; models: number } | { status: "denied" | "expired" | "failed"; error?: string }
  > {
    const flow = this.#deviceFlows.get(flowId);
    if (!flow) return { status: "failed", error: "no such flow (expired or completed already)" };
    const settled = await Promise.race([flow.done.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 0))]);
    if (!settled) return { status: "pending" };
    const out = await flow.done;
    if (!out.ok) return { status: /denied|declined/i.test(out.error ?? "") ? "denied" : "expired", error: out.error };
    if (opts.setDefault && out.models) {
      const first = this.config.providers[flow.provider]?.models?.[0];
      if (first) this.configSvc.setPath("agents.defaults.model", `${flow.provider}/${first}`);
    }
    return { status: "ok", profile: out.profile!, models: out.models ?? 0 };
  }

  authRemove(pid: string): { ok: boolean; error?: string } {
    if (!this.store.authProfile(pid)) return { ok: false, error: `no profile "${pid}"` };
    this.store.removeAuthProfile(pid);
    for (const [name, p] of Object.entries(this.config.providers ?? {})) {
      if (p.apiKey === pid) this.configSvc.setPath(`providers.${name}.apiKey`, "");
      if ((p.authProfiles ?? []).includes(pid)) {
        this.configSvc.setPath(`providers.${name}.authProfiles`, (p.authProfiles ?? []).filter((x) => x !== pid));
      }
    }
    this.applyConfig();
    this.#broadcastAuthChanged();
    return { ok: true };
  }

  authSetOrder(provider: string, ids: string[] | null): { provider: string; order: string[]; source: string } {
    if (ids) {
      for (const p of ids) {
        if (this.store.authProfile(p)?.provider !== provider) throw new Error(`no ${provider} profile "${p}"`);
      }
      this.store.setAuthOrder(provider, ids.length ? ids : []);
      this.applyConfig();
    }
    const stored = this.store.authOrder(provider);
    const eff = resolveAuthProfileOrder(this.store, this.config, provider);
    return {
      provider,
      order: eff.ordered.map((r) => r.id),
      source: stored.length ? "store" : "config",
    };
  }

  /** Their models status --probe analog: eligibility + catalog reachability. */
  async authProbe(provider?: string): Promise<Record<string, unknown>[]> {
    const results: Record<string, unknown>[] = [];
    for (const row of provider ? this.store.authProfiles(provider) : this.store.authProfiles()) {
      const check = profileCheck(row);
      const { excluded } = resolveAuthProfileOrder(this.store, this.config, row.provider);
      const reason = excluded.some((r) => r.id === row.id) ? "excluded_by_auth_order" : check.reason;
      const entry: Record<string, unknown> = { profile: row.id, provider: row.provider, status: "ok", reasonCode: reason ?? null };
      if (reason) {
        entry["status"] = "auth";
      } else {
        const base = String(this.config.providers[row.provider]?.baseUrl ?? "");
        const found = base ? await fetchModels(base, row.material) : { models: [], error: "provider not configured" };
        if (found.error) {
          entry["status"] = "unknown";
          entry["detail"] = found.error;
        }
        entry["models"] = found.models.length;
      }
      results.push(entry);
    }
    return results;
  }

  #bindProvider(provider: string, baseUrl: string, pid: string): void {
    if (!this.config.providers[provider]) this.configSvc.setPath(`providers.${provider}`, {});
    if (!this.config.providers[provider]?.baseUrl && baseUrl) this.configSvc.setPath(`providers.${provider}.baseUrl`, baseUrl);
    this.configSvc.setPath(`providers.${provider}.apiKey`, pid);
  }

  async #refreshCatalog(provider: string, key: string): Promise<string[]> {
    const base = String(this.config.providers[provider]?.baseUrl ?? "");
    if (!base) return [];
    const found = await fetchModels(base, key);
    if (!found.error && found.models.length) this.configSvc.setPath(`providers.${provider}.models`, found.models.slice(0, 200));
    return found.models;
  }

  #broadcastAuthChanged(): void {
    this.events.emit("event", { type: "models.auth", profiles: this.authProfilesView() });
  }

  // ══ local services (Partial #7) — implicit discovery + one-tap add ════

  async modelsLocalScan() {
    const { scanLocalServices } = await import("./local-services.js");
    const results = await scanLocalServices();
    return {
      services: results,
      configured: Object.fromEntries(
        Object.entries(this.config.providers ?? {})
          .filter(([name]) => results.some((r) => r.id === name)),
      ),
    };
  }

  async modelsLocalAdd(id: string, setDefault: boolean) {
    const { scanLocalServices, addLocalService } = await import("./local-services.js");
    const scan = (await scanLocalServices()).find((r) => r.id === id);
    if (!scan) return { ok: false, error: `unknown local service "${id}"` };
    const res = addLocalService(this.configSvc, id, scan);
    if (!res.ok) return { ok: false, error: res.message };
    if (setDefault && res.models.length) {
      this.configSvc.setPath("agents.defaults.model", `${id}/${res.models[0]}`);
    }
    this.applyConfig();
    return { ok: true, models: res.models, message: res.message };
  }

  /**
   * What the web UI Memory tab shows (OpenClaw's Dreams tab, adapted): the
   * dreaming enabled state, schedule, next run, last sweep, and the memory
   * counts (curated lines, daily notes, diary entries).
   */
  async dreamStatus(): Promise<{
    enabled: boolean;
    schedule: string;
    scheduleError?: string;
    nextRunAt: number | null;
    lastDreamAt: number | null;
    lastVerdict: string | null;
    lastRejected: Record<string, number>;
    counts: { memoryLines: number; dailyNotes: number; diaryEntries: number; staged: number; promotedToday: number };
  }> {
    const d = this.config.memory.dreaming;
    let scheduleError: string | undefined;
    let nextRunAt: number | null = null;
    if (d.enabled) {
      try {
        const { Cron } = await import("croner");
        const probe = new Cron(d.schedule);
        nextRunAt = this.#dream?.nextRunAt() ?? probe.nextRun()?.getTime() ?? null;
        probe.stop();
      } catch {
        scheduleError = `invalid cron schedule "${d.schedule}" (want 5 fields, e.g. 0 3 * * *)`;
      }
    }
    const ws = workspaceDir();
    const memory = readTextSafe(join(ws, "MEMORY.md"));
    const diary = readTextSafe(join(ws, "DREAMS.md"));
    let dailyNotes = 0;
    try {
      dailyNotes = readdirSync(join(ws, "memory")).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).length;
    } catch {
      /* no memory/ dir yet */
    }
    let lastDreamAt: number | null = null;
    try {
      lastDreamAt = Math.trunc(statSync(join(ws, "DREAMS.md")).mtimeMs);
    } catch {
      /* no diary yet */
    }
    const all = this.store.dreamCandidates({ includePromoted: true });
    const todayStart = Date.parse(`${todayStamp()}T00:00:00Z`);
    const staged = all.filter((c) => c.promoted_at === null).length;
    const promotedToday = all.filter((c) => (c.promoted_at ?? 0) >= todayStart).length;
    const lastRun = this.store.lastDreamRun();
    let lastRejected: Record<string, number> = {};
    try {
      lastRejected = lastRun ? (JSON.parse(lastRun.rejected) as Record<string, number>) : {};
    } catch {
      lastRejected = {};
    }
    return {
      enabled: d.enabled,
      schedule: d.schedule,
      scheduleError,
      nextRunAt,
      lastDreamAt,
      lastVerdict: lastRun?.verdict ?? null,
      lastRejected,
      counts: {
        memoryLines: memory ? memory.split("\n").filter((l) => l.trim()).length : 0,
        dailyNotes,
        diaryEntries: diary ? (diary.match(/^## Deep Sleep - /gm) ?? []).length : 0,
        staged,
        promotedToday,
      },
    };
  }

  /**
   * The diary + curated memory for the Memory tab reader. The diary is for
   * humans only - it is never promoted back into memory (OpenClaw's rule).
   */
  dreamDiary(): { dreamsPath: string; dreams: string; memoryPath: string; memory: string } {
    const ws = workspaceDir();
    const dreamsPath = join(ws, "DREAMS.md");
    const memoryPath = join(ws, "MEMORY.md");
    return {
      dreamsPath,
      dreams: readTextSafe(dreamsPath) ?? "",
      memoryPath,
      memory: readTextSafe(memoryPath) ?? "",
    };
  }

  /**
   * OpenClaw-style session naming: once the first reply settles, a tiny model
   * call turns the opening user message into a 2-6 word title. Non-blocking,
   * one attempt per session, and it never disturbs the chat path.
   */
  async #maybeAutoTitle(sessionKey: string): Promise<void> {
    try {
      if (sessionKey.startsWith("system:") || sessionKey === DREAM_SESSION_KEY) return;
      if (this.#titleBusy.has(sessionKey)) return;
      const row = this.store.getSessionByKey(sessionKey);
      if (!row || row.name) return;
      const msgs = this.store.recentMessages(row.id, 50);
      const firstUser = msgs.find((m) => m.role === "user");
      if (!firstUser) return;
      this.#titleBusy.add(sessionKey);
      let raw = "";
      const stream = this.loop.llm.stream({
        messages: [{ role: "user", content: titlePrompt(firstUser.content.slice(0, 400)) }],
        model: modelProfile(this.config, "").ref,
        maxTokens: 24,
      });
      for await (const ev of stream) {
        if (ev.type === "text") raw += ev.text;
      }
      const title = cleanTitle(raw);
      if (!title) return;
      this.store.renameSession(row.id, title);
      this.log.info(`session auto-titled: ${sessionKey} -> ${title}`);
      this.events.emit("event", { type: "session.updated", sessionKey, name: title } satisfies ServiceEvent);
    } catch (err) {
      // Best-effort by design — log and move on.
      this.log.warn(`auto-title failed for ${sessionKey}: ${(err as Error).message}`);
    } finally {
      this.#titleBusy.delete(sessionKey);
    }
  }

  async startChannels(): Promise<void> {
    const config = this.config;
    if (config.cron.enabled) {
      this.#cron = new Scheduler(this.store, this.log, (job) =>
        this.send({
          sessionKey: job.session_key,
          text: job.prompt,
          isMainSession: false,
          source: "cron",
          reply: async (text) => {
            this.store.recordJobRun(job.id, "done", text.slice(0, 2000));
          },
        }),
      );
      await this.#cron.start();
      this.log.info(`cron scheduler started (${this.#cron.count} jobs)`);
    }

    if (config.channels.telegram.enabled && config.channels.telegram.token) {
      await this.#startTelegram();
    }
    // The dreaming sweep has its own timer (config.memory.dreaming), separate
    // from the user's cron jobs — it must not show up in `sc cron list`.
    void this.armDreaming();
    // Config edits made outside config.set (sc config set, hand edits) must
    // reach the running daemon too.
    this.watchConfig();
  }

  /**
   * Chat commands shared by every surface (their /queue, /followup, /steer,
   * /subagents, /stop). Returns null for ordinary messages, or a payload
   * rewrite (or a direct reply) for commands.
   */
  #commands(rawText: string, payload: ChatPayload): { rewrite?: string; reply?: string; mode?: QueueMode } | null {
    const raw = rawText.trim();
    if (!raw.startsWith("/")) return null;
    const [head, ...restParts] = raw.split(/\s+/);
    const rest = raw.slice((head ?? "").length).trim();
    const cmd = (head ?? "").toLowerCase();
    const MODES = ["steer", "followup", "collect", "interrupt"];

    // /queue — show or set this session's override (their per-session /queue).
    if (cmd === "/queue") {
      const firstArg = (restParts[0] ?? "").toLowerCase();
      if (!rest) {
        const status = this.loop.queueStatus(payload.sessionKey);
        const session = this.store.getSessionByKey(payload.sessionKey);
        return {
          reply:
            `Queue for this session: mode ${status.mode}` +
            (session?.queue_mode ? " (session override)" : " (config)") +
            `, ${status.queued.length} queued input(s), ${status.steering} steering.`,
        };
      }
      if (["default", "reset"].includes(firstArg)) {
        this.store.setSessionQueue(payload.sessionKey, null, null);
        return { reply: "Queue mode reset — the config default applies again." };
      }
      if (!MODES.includes(firstArg)) {
        return { reply: `unknown queue mode "${firstArg}" — use ${MODES.join(", ")} (or /queue default to reset)` };
      }
      const opts: { debounceMs?: number; cap?: number; drop?: string } = {};
      for (const part of restParts.slice(1)) {
        const [k, v] = part.split(":");
        if (k === "debounce" && v) {
          const m = /^(\d+(?:\.\d+)?)(ms|s)?$/.exec(v);
          if (m) opts.debounceMs = Math.round(Number(m[1]) * (m[2] === "s" ? 1000 : 1));
        }
        if (k === "cap" && v && Number(v) >= 1) opts.cap = Math.floor(Number(v));
        if (k === "drop" && v && ["summarize", "old", "new"].includes(v)) opts.drop = v;
      }
      this.store.setSessionQueue(payload.sessionKey, firstArg, Object.keys(opts).length > 0 ? opts : null);
      return {
        reply:
          `Queue mode for this session: ${firstArg}` +
          (opts.debounceMs !== undefined ? `, debounce ${opts.debounceMs}ms` : "") +
          (opts.cap !== undefined ? `, cap ${opts.cap}` : "") +
          (opts.drop !== undefined ? `, drop ${opts.drop}` : "") +
          ". (/queue default resets to config.)",
      };
    }
    // /followup <msg> — one specific message as its own turn, mode untouched.
    if (cmd === "/followup") {
      if (!rest) return { reply: "usage: /followup <message>" };
      return { rewrite: rest, mode: "followup" };
    }
    // /steer <msg> (alias /tell) — inject into the live turn at the next
    // boundary; when nothing is active it starts an ordinary turn.
    if (cmd === "/steer" || cmd === "/tell") {
      if (!rest) return { reply: "usage: /steer <message>" };
      return { rewrite: rest, mode: "steer" };
    }
    // /stop — cancel queued work first, then the active run (their order).
    if (cmd === "/stop") {
      const stopped = this.loop.abort(payload.sessionKey);
      return { reply: stopped ? "Stopped — queued inputs cancelled, active run aborted." : "Nothing to stop in this session." };
    }
    // /subagents — the Running/Finished panel as text (UI has the real panel).
    if (cmd === "/subagents") {
      const rows = (this.#subagents?.list(payload.sessionKey, 20) ?? []).reverse();
      if (rows.length === 0) return { reply: "No sub-agents for this session." };
      const text = rows
        .map((r) => `- ${r.label || r.task_name} — ${r.status === "running" ? "running…" : r.status}${r.result_stats ? ` [${r.result_stats}]` : ""}`)
        .join("\n");
      return { reply: `Sub-agents:\n${text}` };
    }
    return null;
  }

  /** One entry point for every surface: TUI, WS clients, Telegram, cron. */
  async send(payload: ChatPayload): Promise<void> {
    // Command surface first (never reaches the model).
    const cmd = this.#commands(payload.text, payload);
    if (cmd?.reply !== undefined) {
      await payload.reply(cmd.reply);
      return;
    }
    const text = cmd?.rewrite ?? payload.text;
    const queueMode = cmd?.mode ?? payload.queueMode;

    // Remember how to reach this session's channel for internal announcements.
    if (payload.source === "telegram") {
      this.#channelSinks.set(payload.sessionKey, payload.reply);
    }

    // Lifecycle events (start/delta/tool/approval/final/idle) all come from the loop with
    // the real runId — no synthetic start here, so surfaces never see two runs.
    await this.loop.run({
      sessionKey: payload.sessionKey,
      text,
      isMainSession: payload.isMainSession,
      model: payload.model,
      reasoning: payload.reasoning,
      source: payload.source,
      queueMode,
      // Channel (durable-ingress style) inputs never coalesce in collect mode.
      exclusive: payload.source === "telegram",
      onEvent: (event) => {
        this.events.emit("event", { type: "chat", sessionKey: payload.sessionKey, event } satisfies ServiceEvent);
        // Auto-title fires once the reply settles: non-blocking, best-effort.
        if (event.type === "final") void this.#maybeAutoTitle(payload.sessionKey);
        if (event.type === "delta") void payload.onDelta?.(event.text);
        else if (event.type === "tool") void payload.onTool?.(event);
        else if (event.type === "approval") void payload.onApproval?.(event);
        else if (event.type === "final") void payload.reply(event.text);
        else if (event.type === "error") void payload.reply(`⚠ ${event.message}`);
      },
    });
  }

  private requestApproval(callId: string, tool: string, args: Record<string, unknown>): Promise<boolean> {
    this.log.info(`approval requested: ${tool} ${JSON.stringify(args).slice(0, 200)}`);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.#approvals.delete(callId);
        resolve(false);
      }, APPROVAL_TIMEOUT_MS);
      this.#approvals.set(callId, (ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
    });
  }

  resolveApproval(callId: string, ok: boolean): boolean {
    const resolver = this.#approvals.get(callId);
    if (!resolver) return false;
    resolver(ok);
    return true;
  }

  subscribe(listener: (event: ServiceEvent) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  health(): { ok: boolean; version: string; uptimeMs: number; sessions: number; busy: string[] } {
    return {
      ok: true,
      version: "0.1.0",
      uptimeMs: Date.now() - this.startedAt,
      sessions: this.store.listSessions(200).length,
      busy: this.loop.busySessions(),
    };
  }

  /**
   * Subsystem readiness — "is everything actually connected?", asked of the
   * live components (OpenClaw's `status --deep` idea at our scale).
   */
  readiness(): { name: string; status: "ok" | "warn" | "fail"; detail: string }[] {
    const checks: { name: string; status: "ok" | "warn" | "fail"; detail: string }[] = [];
    const config = this.config;

    checks.push(
      this.configSvc.errors.length === 0
        ? { name: "config", status: "ok", detail: "valid" }
        : { name: "config", status: "fail", detail: this.configSvc.errors[0] ?? "invalid" },
    );

    try {
      this.store.getMeta("schema_version");
      checks.push({
        name: "store",
        status: "ok",
        detail: `sqlite open · fts ${this.store.fts ? "on" : "like-fallback"}`,
      });
    } catch (err) {
      checks.push({ name: "store", status: "fail", detail: (err as Error).message });
    }

    const modelRef = config.agents.defaults.model;
    if (!modelRef) {
      checks.push({ name: "model", status: "warn", detail: "no default model — run: sc setup" });
    } else {
      try {
        const resolved = resolveModel(modelRef, config.providers);
        checks.push({
          name: "model",
          status: "ok",
          detail: `${modelRef} → ${resolved.provider} · ${resolved.model}`,
        });
      } catch (err) {
        checks.push({ name: "model", status: "fail", detail: (err as Error).message });
      }
    }

    const toolCount = this.loop.tools.length;
    checks.push({
      name: "tools",
      status: toolCount > 0 ? "ok" : "fail",
      detail: `${toolCount} registered`,
    });

    const readySkills = this.loop.skills.filter((s) => s.eligible).length;
    checks.push({
      name: "skills",
      status: "ok",
      detail: `${readySkills}/${this.loop.skills.length} ready`,
    });

    const ws = workspaceDir();
    checks.push(
      existsSync(join(ws, "AGENTS.md"))
        ? { name: "workspace", status: "ok", detail: ws }
        : { name: "workspace", status: "warn", detail: "no AGENTS.md — run: sc init" },
    );

    if (config.cron.enabled) {
      const armed = this.#cron?.count ?? 0;
      const total = this.store.listJobs().filter((j) => j.enabled).length;
      checks.push({
        name: "cron",
        status: armed === total ? "ok" : "warn",
        detail:
          armed === total
            ? `${armed} job${armed === 1 ? "" : "s"} armed`
            : `${armed}/${total} armed — reconciling`,
      });
    } else {
      checks.push({ name: "cron", status: "ok", detail: "disabled" });
    }

    const tg = config.channels.telegram;
    if (!tg.enabled) {
      checks.push({ name: "telegram", status: "ok", detail: "disabled" });
    } else if (this.#telegram?.running) {
      checks.push({
        name: "telegram",
        status: "ok",
        detail: `online${this.#telegram.username ? ` as @${this.#telegram.username}` : ""}`,
      });
    } else {
      checks.push({
        name: "telegram",
        status: "fail",
        detail: "enabled but not connected — check channels.telegram.token",
      });
    }

    return checks;
  }

  status(): Record<string, unknown> {
    const config = this.config;
    return {
      model: config.agents.defaults.model || "(unset)",
      fallbacks: config.agents.defaults.fallbacks,
      providers: Object.keys(config.providers),
      tools: this.loop.tools.map((t) => t.name),
      skills: this.loop.skills.map((s) => ({ name: s.name, root: s.root, eligible: s.eligible })),
      telegram: {
        enabled: config.channels.telegram.enabled,
        running: this.#telegram?.running ?? false,
        dmPolicy: config.channels.telegram.dmPolicy,
      },
      cron: { enabled: config.cron.enabled, jobs: this.#cron?.count ?? 0 },
      workspace: workspaceDir(),
      checks: this.readiness(),
    };
  }

  async stop(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    this.configSvc.stop();
    this.#cron?.stop();
    this.#dream?.stop();
    await this.#telegram?.stop();
    this.store.close();
    this.log.info("service stopped");
  }
}