import { EventEmitter } from "node:events";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ConfigService } from "../config/load.js";
import type { SuparClawConfig } from "../config/schema.js";
import { Store } from "../state/db.js";
import { createLogger, type Logger } from "../util/log.js";
import { dbPath, ensureDirs, logsDir, readTextSafe, stateDir, workspaceDir } from "../util/paths.js";
import { AgentLoop, type RunEvent } from "../agent/loop.js";
import { LlmClient, resolveModel } from "../agent/llm.js";
import { modelProfile } from "../config/schema.js";
import { DREAM_SESSION_KEY, armDream, cleanTitle, dreamPrompt, titlePrompt, type DreamHandle } from "../agent/dream.js";
import { writeWorkspaceTemplates, todayStamp } from "../agent/workspace.js";
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

  constructor(configPathOverride?: string) {
    ensureDirs();
    this.log = createLogger({ file: join(logsDir(), "suparclaw.log") });
    this.configSvc = new ConfigService(this.log, configPathOverride);
    this.store = Store.open(dbPath());
    this.store.setMeta("state_dir", stateDir());
    const config = this.configSvc.current;
    const llm = new LlmClient(
      config.providers,
      { model: config.agents.defaults.model, fallbacks: config.agents.defaults.fallbacks },
      (info) => this.log.warn(`llm retry ${info.model} #${info.attempt}: ${info.error}`),
    );
    this.loop = new AgentLoop({
      config,
      store: this.store,
      log: this.log,
      llm,
      requestApproval: (callId, tool, args) => this.requestApproval(callId, tool, args),
    });

    this.events.setMaxListeners(64);
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
    this.loop.llm.setConfig(config.providers, config.agents.defaults);
    this.log.info(`config applied — model ${config.agents.defaults.model || "(unset)"}`);
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
  async dreamNow(): Promise<string> {
    const today = todayStamp();
    this.events.emit("event", { type: "chat", sessionKey: DREAM_SESSION_KEY, event: { type: "start", runId: "dream-" + today, sessionKey: DREAM_SESSION_KEY } } satisfies ServiceEvent);
    let text = "";
    await this.loop.run({
      sessionKey: DREAM_SESSION_KEY,
      text: dreamPrompt(today),
      isMainSession: true,
      reasoning: "off",
      onEvent: (event) => {
        if (event.type === "delta") text += event.text;
      },
    });
    const summary = text || "nothing new";
    this.log.info(`dreaming sweep done: ${summary.slice(0, 120)}`);
    return summary;
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
    counts: { memoryLines: number; dailyNotes: number; diaryEntries: number };
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
        scheduleError = `invalid cron schedule "${d.schedule}" (want 5 fields, e.g. 0 4 * * *)`;
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
    return {
      enabled: d.enabled,
      schedule: d.schedule,
      scheduleError,
      nextRunAt,
      lastDreamAt,
      counts: {
        memoryLines: memory ? memory.split("\n").filter((l) => l.trim()).length : 0,
        dailyNotes,
        diaryEntries: diary ? (diary.match(/^## Deep Sleep - /gm) ?? []).length : 0,
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

  /** One entry point for every surface: TUI, WS clients, Telegram, cron. */
  async send(payload: ChatPayload): Promise<void> {
    // Lifecycle events (start/delta/tool/final/idle) all come from the loop with
    // the real runId — no synthetic start here, so surfaces never see two runs.
    await this.loop.run({
      sessionKey: payload.sessionKey,
      text: payload.text,
      isMainSession: payload.isMainSession,
      model: payload.model,
      reasoning: payload.reasoning,
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