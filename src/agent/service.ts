import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { isImageMime, sanitizeAttachName, type ParsedAttachment } from "../gateway/web-attachments.js";
import { ConfigService } from "../config/load.js";
import type { SuparClawConfig } from "../config/schema.js";
import { Store } from "../state/db.js";
import { runSessionMaintenance, settingsFromConfig, defaultDiskBytes } from "../state/maintenance.js";
import { realRunCli, realTranscribeAudio } from "./media-understanding.js";
import { createLogger, type Logger } from "../util/log.js";
import { dbPath, ensureDirs, logsDir, readTextSafe, stateDir, workspaceDir } from "../util/paths.js";
import { AgentLoop, type QueueMode, type RunEvent } from "../agent/loop.js";
import { matchTextReply, type AskUserQuestion, type AskUserResult } from "./ask-user.js";
import { assertWebhookUrl, postWebhook, webhookPayload, resolveDelivery, isEmptySummary, errorStreak, shouldAlert } from "../cron/delivery.js";
import type { JobRow } from "../state/db.js";
import { Subagents } from "../agent/subagents.js";
import { LlmClient, resolveModel } from "../agent/llm.js";
import { modelProfile, execModeOf, type UsageMode } from "../config/schema.js";
import { usageFooter } from "../util/usage.js";
import {
  evaluateExec,
  unattendedDecision,
  loadApprovalsDoc,
  type UnattendedMode,
  saveApprovalsDoc,
  mintAlwaysEntry,
  ledgerEntries,
  type ApprovalsDoc,
  type ExecVerdict,
} from "../agent/exec-policy.js";
import { DREAM_SESSION_KEY, armDream, cleanTitle, titlePrompt, type DreamHandle, runSweep, promotePreview, backfillPreview, lightStage, consolidateGated } from "../agent/dream.js";
import { writeWorkspaceTemplates, todayStamp } from "../agent/workspace.js";
import { handleSlashExtension } from "./slash-commands.js";
import { resolveConfiguredProviders, markAuthOutcome, profileStatus, profileCheck, profileId, resolveAuthProfileOrder } from "../agent/auth.js";
import { pluginById } from "../agent/provider-plugins.js";
import { deviceLogin } from "../agent/oauth-device.js";
import { fetchModels } from "../config/providers.js";
import { TelegramChannel, describeError, probeTelegramApi } from "../channels/telegram.js";
import { detectWorkingProxy } from "../channels/telegram-proxy.js";
import { Scheduler } from "../cron/scheduler.js";

export interface ChatPayload {
  sessionKey: string;
  text: string;
  isMainSession?: boolean;
  source: "tui" | "gateway" | "telegram" | "cron" | "cli" | "webhook" | "imap" | "heartbeat";
  /** Per-run model override (surface-level choice); unset means the default. */
  model?: string;
  /** Per-run thinking effort override; unset means session/default policy. */
  reasoning?: string;
  /** chat.send parity: force the queue mode just for this message. */
  queueMode?: QueueMode;
  /** Inline media for vision turns (Telegram inbound photos — P1 A5). */
  attachments?: { kind: "image"; dataUri: string; name: string }[];
  reply: (text: string) => void | Promise<void>;
  /** Final text plus provider usage when the loop captured it (HTTP surfaces). */
  onFinal?: (text: string, usage?: Record<string, number>) => void | Promise<void>;
  /** P3 #26 heartbeat: skip workspace bootstrap files on this turn (lightContext). */
  lightContext?: boolean;
  onDelta?: (delta: string) => void | Promise<void>;
  onTool?: (event: Extract<RunEvent, { type: "tool" }>) => void | Promise<void>;
  onApproval?: (event: Extract<RunEvent, { type: "approval" }>) => void | Promise<void>;
  /** ask_user (P2 #8): the surface renders the question set inline. */
  onQuestion?: (event: Extract<RunEvent, { type: "question" }>) => void | Promise<void>;
}

export type ServiceEvent =
  | { type: "chat"; sessionKey: string; event: RunEvent }
  | { type: "presence"; online: boolean }
  | { type: "tick"; at: number }
  /** Session row changed (auto-title landed) — UIs refresh their list. */
  | { type: "session.updated"; sessionKey: string; name: string };

export type ApprovalDecision = "once" | "always" | "deny";

/** Live ask_user set (P2 #8): closure + per-question answers. */
interface PendingQuestionSet {
  id: string;
  sessionKey: string;
  questions: AskUserQuestion[];
  partial: Record<string, string[]>;
  explicitSkip: Set<string>;
  awaitingOther: string | null;
  resolve: (r: AskUserResult) => void;
}

export class Service {
  readonly log: Logger;
  readonly configSvc: ConfigService;
  readonly store: Store;
  readonly loop: AgentLoop;
  readonly events = new EventEmitter();
  readonly startedAt = Date.now();

  #telegram: TelegramChannel | null = null;
  #cron: Scheduler | null = null;
  #imap: import("../automation/imap.js").ImapWatcher | null = null;
  /** P3 #26 — system-owned heartbeat cadence (their gateway/heartbeat automation). */
  #heartbeat: import("../automation/heartbeat.js").Heartbeat | null = null;
  /** Surfaces read the live heartbeat (target:last bookkeeping, status). */
  get heartbeat(): import("../automation/heartbeat.js").Heartbeat | null {
    return this.#heartbeat;
  }

  /** P3 #28 — WebChat attachment persistence (their telegram-media parity):
   *  every accepted upload lands under workspace/media with a unique,
   *  sanitized name so the agent can fs_read / pdf-tool it later; images
   *  additionally keep a data URI for the vision content-part path. */
  async saveWebAttachments(files: ParsedAttachment[]): Promise<{
    saved: { name: string; mime: string; size: number; path: string; dataUri?: string }[];
  }> {
    const dir = join(workspaceDir(), "media");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const stamp = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
    const saved: { name: string; mime: string; size: number; path: string; dataUri?: string }[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i]!;
      const safe = sanitizeAttachName(f.name);
      const ext = extname(safe) || (isImageMime(f.mime) ? `.${f.mime.split("/")[1]!.replace("jpeg", "jpg")}` : "");
      const base = safe.slice(0, Math.max(1, safe.length - ext.length));
      const file = `${stamp}-${i + 1}-${base}${ext}`;
      writeFileSync(join(dir, file), f.buf);
      saved.push({
        name: f.name,
        mime: f.mime,
        size: f.buf.length,
        path: `media/${file}`,
        dataUri: isImageMime(f.mime) ? `data:${f.mime};base64,${f.buf.toString("base64")}` : undefined,
      });
    }
    return { saved };
  }

  /** P3 #27 (row Missing!#28) — automations dashboard payload (their
   *  Control-UI Automations page): cron jobs + runs, heartbeat cadence
   *  state, IMAP watcher states. Pure reads — no secrets, no mail
   *  subjects/bodies (their reject-log privacy rule). */
  async automationsState(): Promise<{
    cron: { enabled: boolean; jobs: unknown[]; runs: unknown[] };
    heartbeat: {
      armed: boolean;
      every: string;
      target: string;
      lightContext: boolean;
      isolatedSession: boolean;
      timeoutSeconds: number;
      activeHours: { start: string; end: string; timezone: string };
      lastTargetChat: number | null;
    };
    imap: {
      enabled: boolean;
      accounts: {
        name: string;
        mailbox: string;
        dispatchTo: string;
        unhealthy: boolean;
        cursor: number;
        lastError: string;
        skips: number;
      }[];
    };
  }> {
    const cfg = this.config;
    const heart = cfg.agents.defaults.heartbeat;
    let imapState: import("../automation/imap.js").ImapStateFile | null = null;
    if (cfg.imap?.enabled) {
      const { readImapState, imapStatePath } = await import("../automation/imap.js");
      imapState = readImapState(imapStatePath(stateDir()));
    }
    // Last cron runs — store keeps run history; store API reads through here
    // so the UI never opens the db directly.
    return {
      cron: {
        enabled: Boolean(cfg.cron.enabled),
        jobs: this.store.listJobs(),
        runs: this.store.lastJobRuns(10),
      },
      heartbeat: {
        armed: this.#heartbeat ? this.#heartbeat.stats().armed : false,
        every: heart.every,
        target: heart.target,
        lightContext: heart.lightContext,
        isolatedSession: heart.isolatedSession,
        timeoutSeconds: heart.timeoutSeconds,
        activeHours: heart.activeHours,
        lastTargetChat: this.#heartbeat ? this.#heartbeat.stats().lastTargetChat : null,
      },
      imap: {
        enabled: Boolean(cfg.imap?.enabled),
        accounts: Object.entries(cfg.imap?.accounts ?? {}).map(([name, a]) => {
          const st = imapState?.accounts?.[name];
          return {
            name,
            mailbox: a.mailbox,
            dispatchTo: a.watch.mode === "idle" ? "imap-idle" : `poll:${a.watch.pollSeconds}s`,
            unhealthy: st?.unhealthy ?? false,
            cursor: st?.cursor ?? 0,
            lastError: st?.lastError ?? "",
            skips: st ? Object.keys(st.skips).length : 0,
          };
        }),
      },
    };
  }
  /** Per-job last-failure-alert stamp (P2 #14 cooldown bookkeeping). */
  #cronAlertedAt = new Map<string, number>();
  /** Pending ask_user sets (P2 #8): id → live closure + per-question state. */
  #questions = new Map<string, PendingQuestionSet>();
  /** sessionKey → last payload's onQuestion hook (for telegram surfacing). */
  #questionHooks = new Map<string, ChatPayload["onQuestion"]>();
  /** sessionKey → last payload's onApproval hook (telegram IS a surface). */
  #approvalHooks = new Map<string, NonNullable<ChatPayload["onApproval"]>>();
  #dream: DreamHandle | null = null;
  #dreamSig = "";
  #titleBusy = new Set<string>();
  /**
   * Pending human-decision calls. No timers (rule 9): a decision arrives from
   * a connected surface, or from an abort; askFallback only applies when no
   * surface is connected at all.
   */
  #approvals = new Map<string, {
    resolve: (decision: ApprovalDecision) => void;
    execVerdict?: ExecVerdict;
    sessionKey: string;
    workspace: string;
  }>();
  /** Which surface count currently counts as "someone is watching" (set by the gateway / local TUI). */
  #approvalSurface: () => boolean = () => false;
  /** Per-session exec mode overrides (/exec slash; null = follow global). */
  #sessionExecModes = new Map<string, string>();
  /** Latest payload source per session (P2 #10) — cron/webhook = unattended. */
  #sessionSources = new Map<string, string>();
  #closing = false;
  /** Sub-agent lifecycle owner (spawn/yield/announce/cancel). */
  #subagents: Subagents | null = null;
  /** Channel sinks for internal announcements (telegram replies need a send). */
  #channelSinks = new Map<string, (text: string) => void | Promise<void>>();
  /** Hourly session-maintenance timer (P3 #19). */
  #maintenanceTimer: ReturnType<typeof setInterval> | null = null;

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
      requestApproval: (callId, tool, args, ctx) => this.requestApproval(callId, tool, args, ctx),
      askUser: (sessionKey, questions) => this.#askUser(sessionKey, questions),
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
    this.#reconcileTelegram(config);
  }

  /** Bring the live channel in line with saved config after ANY write path
   *  (config.set RPC, hot reload): enabled+token → running; disabled → down.
   *  When the connect materially changes while it is running, bounce it. */
  #appliedTgKey = "";
  #reconcileTelegram(config: SuparClawConfig): void {
    const tg = config.channels.telegram;
    const key = `${tg.enabled ? "1" : "0"}|${tg.token ?? ""}`;
    if (key === this.#appliedTgKey) return;
    const running = Boolean(this.#telegram?.running);
    const wantRunning = Boolean(tg.enabled && tg.token);
    if (wantRunning === running && running) {
      // same intent but the token changed → restart cleanly
      void this.#telegram!.stop().then(() => void this.#startTelegram());
    } else if (wantRunning && !running) {
      void this.#startTelegram();
    } else if (!wantRunning && running) {
      void this.#telegram!.stop();
    }
    this.#appliedTgKey = key;
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

  /** Hot reload for edits made outside config.set (sc config set, hand edits).
   *  The telegram lifecycle lives solely in applyConfig/#reconcileTelegram so
   *  this watcher and the config.set RPC can never double-start the bot. */
  watchConfig(): void {
    this.configSvc.watchForChanges((config) => {
      this.applyConfig(config);
      if (this.#cron) void this.#cron.reconcile();
      void this.armDreaming();
      this.log.info("config hot-reloaded");
    });
  }

  #telegramError = "";

  async #startTelegram(): Promise<void> {
    const tg = this.config.channels.telegram;
    this.#appliedTgKey = `${tg.enabled ? "1" : "0"}|${tg.token ?? ""}`;
    this.#telegram = new TelegramChannel(this, this.log);
    try {
      await this.#telegram.start();
      this.#telegramError = "";
    } catch (err) {
      this.#telegramError = describeError(err);
      this.log.error(`telegram failed to start: ${this.#telegramError}`);
    }
  }

  /** Live channel health for Settings → Channels (their channels status). */
  channelsStatus(): { telegram: { enabled: boolean; hasToken: boolean; running: boolean; username: string; error: string } } {
    const tg = this.config.channels.telegram;
    const running = Boolean(this.#telegram?.running);
    return {
      telegram: {
        enabled: Boolean(tg.enabled),
        hasToken: /^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(String(tg.token ?? "")) || Boolean(tg.token),
        running,
        username: running ? this.#telegram?.username ?? "" : "",
        // Show the start failure plainly so a wrong token or blocked network
        // is visible instead of a silent "offline" (they report the same way).
        error: tg.enabled && !running ? this.#telegramError : "",
      },
    };
  }

  /** One-line smoke test for the whole path (their channels send parity):
   *  resolves the recipient — explicit id/@handle first, then the first
   *  allowFrom entry (which is the user themselves after pairing), then a
   *  plain "DM the bot first" explanation — and delivers over the live
   *  channel (proxy included). */
  resolveTelegramRecipient(ref: string | number | undefined): number | string | null {
    if (ref !== undefined && ref !== null && String(ref).trim()) {
      const v = String(ref).trim();
      if (/^-?\d+$/.test(v)) return Number(v);
      if (v.startsWith("@")) return v;
      return v;
    }
    const mine = (this.config.channels.telegram.allowFrom ?? []).map((x) => String(x).trim()).find(Boolean);
    if (!mine) return null;
    if (/^-?\d+$/.test(mine)) return Number(mine);
    return mine.startsWith("@") ? mine : `@${mine}`;
  }

  async telegramSend(ref: string | number | undefined, text: string): Promise<{ ok: boolean; to?: string; error?: string }> {
    const tg = this.config.channels.telegram;
    if (!tg.enabled) return { ok: false, error: "channels.telegram.enabled is off — enable it first" };
    if (!this.#telegram?.running) return { ok: false, error: `telegram is offline (${this.#telegramError || "not connected"}) — run: sc channels connect` };
    const to = this.resolveTelegramRecipient(ref);
    if (to === null) {
      return { ok: false, error: "no recipient: pass one — sc channels send <chat-id> hi — or message the bot first so it knows you, or add yourself to channels.telegram.allowFrom" };
    }
    const body = text.trim() || "suparclaw smoke test — telegram path works";
    try {
      await this.#telegram.sendText(to, body);
      return { ok: true, to: String(to) };
    } catch (err) {
      let error = describeError(err);
      if (/chat not found|user not found/i.test(error)) {
        error += " — Telegram only lets bots DM users who have messaged them first: open the bot and press START (or fix the id/@handle).";
      }
      return { ok: false, error };
    }
  }

  /** Their one-tap Connect: stops any old instance, starts fresh, and returns
   *  the real outcome so the UI can say "@bot online" or WHY it failed —
   *  unlike the fs-watcher path which is silent (and may not fire at all on
   *  some filesystems). */
  async telegramReconnect(triedAutoProxy = false): Promise<{ ok: boolean; username?: string; error?: string; note?: string }> {
    const tg = this.config.channels.telegram;
    if (!tg.enabled) return { ok: false, error: "channels.telegram.enabled is off" };
    if (!tg.token) return { ok: false, error: "channels.telegram.token is empty — paste a @BotFather token first" };
    // Placeholder traps: sample strings copied verbatim from docs/hints work
    // at exactly zero endpoints — call them out before any attempt.
    if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(String(tg.token).trim())) {
      if (/ABC|TOKEN|BOT|\.\.\.|…/.test(String(tg.token))) {
        return { ok: false, error: `channels.telegram.token looks like a doc example, not your real @BotFather token — set the real one: sc config set channels.telegram.token 1234567890:AAxx...` };
      }
    }
    if (/:(PORT|HOST|EXAMPLE)\/?$/.test(String(tg.proxy).trim())) {
      return { ok: false, error: `channels.telegram.proxy "${String(tg.proxy).trim()}" still has the PORT placeholder from the hint — replace PORT with the number your proxy/VPN app actually listens on (typically 7890, 8080, 10808). No proxy app installed? Telegram can't be reached while your carrier blocks it — and sc channels connect will auto-detect a local proxy if one is running.` };
    }
    try {
      if (this.#telegram?.running) await this.#telegram.stop();
    } catch { /* stopping is best-effort */ }
    await this.#startTelegram();
    if (this.#telegram?.running) return { ok: true, username: this.#telegram.username };
    let error = this.#telegramError || "start failed";
    // Diagnose like their connect flow does: the Bot API itself may be
    // unreachable from this device entirely (carrier blocks) — then the
    // remedy is a proxy, not a new token.
    const probe = await probeTelegramApi(2500);
    if (!probe.ok) {
      // If no proxy is configured, try the well-known local proxy ports
      // (Clash/sing-box/v2ray shapes) once — a running VPN app means the
      // channel connects with zero config.
      if (!String(tg.proxy).trim() && !triedAutoProxy) {
        const found = await detectWorkingProxy(8000).catch(() => null);
        if (found) {
          this.configSvc.setPath("channels.telegram.proxy", found);
          this.applyConfig();
          const retry = await this.telegramReconnect(true);
          retry.note = `no proxy was configured; auto-detected one on this device (${found}) — saved to channels.telegram.proxy and retried. Clear with: sc config set channels.telegram.proxy ""`;
          return retry;
        }
        error += ` — api.telegram.org is unreachable from this device (${probe.why}); the network likely blocks Telegram, and no local proxy was detected on the usual ports (7890/8080/10808/10809/1080). If you have a VPN/proxy app, turn on its local port and retry; otherwise Telegram can't connect on this network — you can still use SuparClaw from the Web UI at this device`;
      } else {
        error += ` — api.telegram.org is unreachable from this device (${probe.why}); the network likely blocks Telegram. Check the proxy (${String(tg.proxy).trim() || "env/none"}) is actually listening, then retry: sc channels connect`;
      }
    } else if (/network|fetch/i.test(error)) {
      error += " — api.telegram.org is reachable, so the credential itself is the problem; paste a fresh @BotFather token (or /revoke + re-issue) and retry";
    }
    return { ok: false, error };
  }

  /** Re-arm cron jobs changed outside the daemon (sc cron add, other tools). */
  async cronReconcile(): Promise<void> {
    if (this.#cron) await this.#cron.reconcile();
  }

  /**
   * Media understanding deps (P3 #22): provider auth inventory + the image/
   * transcription executors + CLI runner. Channels collect media facts; this
   * is the engine's real world.
   */
  mediaUnderstandingDeps(): import("./media-understanding.js").MediaEngineDeps {
    const providers = this.#authProviders().providers;
    const providerAuths = Object.entries(providers).map(([id, p]) => {
      const withAuth = p as { baseUrl?: string; apiKey?: string; model?: string };
      return { id, baseUrl: String(withAuth.baseUrl ?? ""), apiKey: String(withAuth.apiKey ?? "") };
    });
    const replyModel = this.configSvc.current.agents.defaults.model;
    return {
      providerAuths,
      replyProvider: providerAuths.find((p) => p.apiKey)
        ? { baseUrl: providerAuths.find((p) => p.apiKey)!.baseUrl, apiKey: providerAuths.find((p) => p.apiKey)!.apiKey, model: replyModel }
        : undefined,
      transcribeAudio: (opts) => realTranscribeAudio(opts),
      runCli: (cmd, args, timeoutMs) => realRunCli(cmd, args, timeoutMs),
      describeImage: async (dataUri, prompt, model, timeoutMs) => {
        let out = "";
        for await (const ev of this.loop.llm.stream({
          messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: dataUri } }] }] as never,
          model: model || undefined,
          signal: AbortSignal.timeout(timeoutMs),
        })) {
          if (ev.type === "text") out += ev.text;
        }
        return out;
      },
    };
  }

  /**
   * Session maintenance (P3 #19): CLI/RPC surface for `sc sessions cleanup`
   * (their `openclaw sessions cleanup` when delegated through the gateway).
   * Busy sessions are protected; dryRun/enforce come from the caller.
   */
  sessionCleanup(opts: { dryRun?: boolean; enforce?: boolean } = {}) {
    const cfg = this.configSvc.current.session.maintenance;
    return runSessionMaintenance(this.store, settingsFromConfig(cfg), {
      dryRun: opts.dryRun === true,
      enforce: opts.enforce === true,
      activeKeys: this.loop.busySessions(),
      diskBytes: defaultDiskBytes(dbPath()),
    });
  }

  /** Hourly runtime application (their batched-on-writes cleanup). */
  #sessionMaintenanceTick(why: "startup" | "interval"): void {
    try {
      const report = this.sessionCleanup({});
      const total = report.archivedAge + report.archivedCap + report.deletedCapArchives;
      if (report.mode === "warn" && report.actions.length > 0) {
        this.log.warn(
          `session maintenance (${why}, warn mode): would archive ${report.archivedAge + report.archivedCap}` +
          `${report.overBudget ? ", disk over budget" : ""} — set session.maintenance.mode=enforce to apply`,
        );
      } else if (total > 0 || report.overBudget) {
        this.log.info(
          `session maintenance (${why}): archived ${report.archivedAge + report.archivedCap}` +
          ` (${report.archivedAge} age, ${report.archivedCap} cap)` +
          `${report.deletedCapArchives ? `, evicted ${report.deletedCapArchives} cap archives (${report.freedBytes} bytes)` : ""}` +
          `${report.kept ? `, ${report.kept} protected` : ""}` +
          `${report.overBudget ? ", disk still over budget" : ""}`,
        );
      }
    } catch (err) {
      this.log.warn(`session maintenance (${why}) failed: ${(err as Error).message}`);
    }
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
      this.#cron = new Scheduler(this.store, this.log, () => this.config.cron, async (job) => {
        // P2 #14: capture once, record once, deliver once. The reply callback
        // distinguishes the loop's "⚠ <error>" frame from a real final text.
        let status: "done" | "error" = "done";
        let detail = "";
        let finalText = "";
        try {
          await this.send({
            sessionKey: job.session_key,
            text: job.prompt,
            isMainSession: false,
            source: "cron",
            reply: async (text) => {
              if (text.startsWith("⚠ ")) {
                status = "error";
                detail = text.slice(2);
              } else {
                finalText = text;
              }
            },
          });
        } catch (err) {
          status = "error";
          detail = (err as Error).message;
        }
        this.store.recordJobRun(job.id, status, (detail || finalText).slice(0, 2000));
        if (status === "done") {
          await this.#deliverCronResult(job, finalText);
        }
        await this.#maybeCronFailureAlert(job, detail || finalText);
      });
      await this.#cron.start();
      this.log.info(`cron scheduler started (${this.#cron.count} jobs)`);
    }

    if (config.channels.telegram.enabled && config.channels.telegram.token) {
      await this.#startTelegram();
    }
    // The dreaming sweep has its own timer (config.memory.dreaming), separate
    // from the user's cron jobs — it must not show up in `sc cron list`.
    void this.armDreaming();
    // Session-store maintenance (P3 #19; their session.maintenance batched on
    // writes — hourly + once shortly after boot here, config read live each
    // tick so edits apply without a restart).
    this.#maintenanceTimer = setInterval(() => this.#sessionMaintenanceTick("interval"), 60 * 60 * 1000);
    this.#maintenanceTimer.unref?.();
    {
      const boot = setTimeout(() => this.#sessionMaintenanceTick("startup"), 15_000);
      boot.unref?.();
    }
    // Config edits made outside config.set (sc config set, hand edits) must
    // reach the running daemon too.
    this.watchConfig();

    // System-owned heartbeat automation (P3 #26 — their gateway/heartbeat):
    // periodic turns in the main session by default, quiet by default
    // (NO_REPLY contract; only meaningful alerts are delivered).
    {
      const { Heartbeat, DEFAULT_HEARTBEAT_PROMPT } = await import("../automation/heartbeat.js");
      void DEFAULT_HEARTBEAT_PROMPT; // referenced by the schema default
      this.#heartbeat = new Heartbeat({
        config: () => this.config,
        busy: () => this.loop.isBusy("main:main"),
        sendTurn: async ({ sessionKey, prompt, lightContext, isolatedSession, timeoutSeconds }) => {
          void timeoutSeconds; // run-timeout enforcement lives in the loop budget
          let finalText = "";
          await this.send({
            sessionKey,
            text: prompt,
            isMainSession: !isolatedSession,
            source: "heartbeat",
            lightContext,
            reply: async (text) => {
              finalText = text;
            },
          });
          return finalText;
        },
        deliver: async (chatId, text) => {
          if (!this.#telegram?.running) throw new Error("telegram is not running");
          await this.#telegram.sendText(chatId, `💓 ${text}`);
        },
        log: (s) => this.log.info(s),
        hostTimezone: "local",
      });
      this.#heartbeat.start();
    }

    // IMAP email trigger (P3 #25 — their automation/imap plugin): per-account
    // watchers dispatch admitted mail to isolated hook:imap:... reader runs.
    if (this.config.imap?.enabled) {
      const { ImapWatcher, imapStatePath } = await import("../automation/imap.js");
      this.#imap = new ImapWatcher(() => this.config.imap, {
        log: this.log,
        statePath: imapStatePath(stateDir()),
        dispatch: async ({ sessionKey, prompt, deliver, to, account }) => {
          let finalText = "";
          await this.send({
            sessionKey,
            text: prompt,
            isMainSession: false,
            source: "imap",
            reply: async (text) => {
              finalText = text;
            },
          });
          if (deliver) await this.#deliverImap(account, finalText, to);
        },
      });
      this.#imap.start();
      this.log.info("imap watcher started (their automation/imap lane)");
    }
  }

  async #deliverImap(account: string, text: string, to: string): Promise<void> {
    if (!to) return; // store-only (their deliver:false default surface)
    const tg = /^telegram:(\d+)$/.exec(to) ?? /^(\d+)$/.exec(to);
    if (tg && this.#telegram?.running) {
      await this.#telegram.sendText(Number(tg[1]), `📧 imap/${account}\n\n${text}`).catch((e) => this.log.warn(`imap deliver failed: ${(e as Error).message}`));
    } else if (tg) {
      this.log.warn(`imap deliver target ${to} but telegram is not running`);
    }
  }

  /**
   * P2 #14 — post a finished cron result by its delivery plan (their
   * announce/webhook/none + empty-suppression). "announce" without a
   * destination leaves the result where it landed (the cron session's own
   * transcript — nothing extra to write).
   */
  async #deliverCronResult(job: JobRow, text: string): Promise<void> {
    const delivery = resolveDelivery(job, this.config.cron);
    if (delivery.mode === "none") return;
    if (delivery.suppressEmpty && isEmptySummary(text)) {
      this.log.info(`cron ${job.name}: empty result suppressed (${delivery.mode})`);
      return;
    }
    if (delivery.mode === "webhook") {
      try {
        const url = await assertWebhookUrl(delivery.to, this.config.cron.webhookAllowHostnames);
        const status = await postWebhook(url, webhookPayload(job, text));
        this.log.info(`cron ${job.name}: webhook delivered to ${url.hostname} (${status})`);
      } catch (err) {
        this.log.error(`cron ${job.name}: webhook delivery failed: ${(err as Error).message}`);
      }
      return;
    }
    // announce
    if (!delivery.to) return; // result already lives in the cron transcript
    const tg = /^telegram:(\d+)$/.exec(delivery.to) ?? (/^(\d+)$/.exec(delivery.to));
    if (tg && this.#telegram?.running) {
      try {
        await this.#telegram.sendText(Number(tg[1]), `⏰ ${job.name}\n\n${text}`);
        this.log.info(`cron ${job.name}: announced to telegram:${tg[1]}`);
      } catch (err) {
        this.log.error(`cron ${job.name}: telegram announce failed: ${(err as Error).message}`);
      }
      return;
    }
    const sessMatch = /^session:(.+)$/.exec(delivery.to);
    if (sessMatch) {
      const key = sessMatch[1]!;
      const sess = this.store.ensureSession(key);
      const rowId = this.store.appendMessage(sess.id, "assistant", `⏰ ${job.name}\n\n${text}`);
      this.events.emit("event", { type: "chat", sessionKey: key, event: { type: "final", runId: `cron-${rowId}`, text: `⏰ ${job.name}\n\n${text}` } } satisfies ServiceEvent);
      return;
    }
    if (tg) {
      this.log.warn(`cron ${job.name}: telegram announce target ${delivery.to} but telegram is not running`);
    } else {
      this.log.warn(`cron ${job.name}: unsupported announce destination "${delivery.to}" (want telegram:<chatId> | session:<key>)`);
    }
  }

  /** P2 #14 — consecutive-failure operator alert with threshold + cooldown. */
  async #maybeCronFailureAlert(job: JobRow, lastDetail: string): Promise<void> {
    const alerts = this.config.cron.failureAlerts;
    if (!alerts.enabled) return;
    const streak = errorStreak(this.store.lastJobRuns(50), job.id);
    if (!shouldAlert(streak, alerts.threshold, this.#cronAlertedAt.get(job.id), alerts.cooldownMinutes)) return;
    this.#cronAlertedAt.set(job.id, Date.now());
    const msg =
      `⚠ Cron job "${job.name}" failed ${streak} time(s) in a row.\n` +
      `Last error: ${lastDetail.slice(0, 400)}`;
    const to = alerts.to;
    const tg = /^telegram:(\d+)$/.exec(to) ?? (/^(\d+)$/.exec(to));
    if (tg && this.#telegram?.running) {
      try {
        await this.#telegram.sendText(Number(tg[1]), msg);
        this.log.warn(`cron ${job.name}: failure alert sent to telegram:${tg[1]} (streak ${streak})`);
        return;
      } catch (err) {
        this.log.error(`cron ${job.name}: failure alert DM failed: ${(err as Error).message}`);
      }
    }
    // Fallback: the operator's main session transcript (their in-app alert).
    const sess = this.store.ensureSession(":main");
    this.store.appendMessage(sess.id, "assistant", msg);
    this.events.emit("event", { type: "chat", sessionKey: ":main", event: { type: "final", runId: `cronalert-${Date.now().toString(36)}`, text: msg } } satisfies ServiceEvent);
    this.log.warn(`cron ${job.name}: failure streak ${streak} — alerted main session`);
  }

  // ---- ask_user (P2 #8) ----------------------------------------------------

  /**
   * Pose a validated question set and await the operator's input (their
   * contract: broadcast to every surface, resolve wherever the answer came
   * from first; house rule: NO timeout — humans answer when they answer).
   */
  #askUser(sessionKey: string, questions: AskUserQuestion[]): Promise<AskUserResult> {
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    const qEvent: Extract<RunEvent, { type: "question" }> = { type: "question", id, sessionKey, questions };
    return new Promise<AskUserResult>((resolve) => {
      this.#questions.set(id, { id, sessionKey, questions, partial: {}, explicitSkip: new Set(), awaitingOther: null, resolve });
      this.events.emit("event", { type: "chat", sessionKey, event: qEvent } satisfies ServiceEvent);
      void this.#questionHooks.get(sessionKey)?.(qEvent);
      this.log.info(`ask_user ${id}: ${questions.length} question(s) for ${sessionKey}`);
    });
  }

  /** Full-set resolution: every qid must have a value (empty = skipped that one). */
  #questionMaybeResolve(q: PendingQuestionSet): boolean {
    if (!q.questions.every((qq) => q.partial[qq.id] !== undefined)) return false;
    this.#questions.delete(q.id);
    const skipped = q.questions.every((qq) => (q.partial[qq.id] ?? []).length === 0) && q.explicitSkip.size > 0;
    const answers: Record<string, string[]> = {};
    for (const qq of q.questions) answers[qq.id] = q.partial[qq.id] ?? [];
    // Transcript audit: the question set + everything the operator answered.
    const sess = this.store.getSessionByKey(q.sessionKey);
    if (sess) {
      const lines = q.questions.map((qq) => {
        const a = q.partial[qq.id] ?? [];
        return `  ${qq.id}: ${qq.question} → ${a.length > 0 ? a.join(", ") : "(skipped)"}`;
      });
      this.store.appendMessage(sess.id, "tool", `[ask_user ${q.id}${skipped ? " · skipped" : ""}]\n${lines.join("\n")}`);
    }
    this.log.info(`ask_user ${q.id}: resolved${skipped ? " (skipped)" : ""}`);
    q.resolve({ answers, skipped });
    return true;
  }

  /**
   * Surface-agnostic single-question answer (telegram buttons / future cards):
   * returns a short acknowledgment or null when the id/question is wrong.
   */
  answerQuestionPart(id: string, qid: string, values: string[], opts: { skip?: boolean; custom?: boolean } = {}): string | null {
    const q = this.#questions.get(id);
    if (!q) return null;
    if (!q.questions.some((qq) => qq.id === qid)) return null;
    q.awaitingOther = null;
    q.partial[qid] = values;
    if (opts.skip) q.explicitSkip.add(qid);
    this.#questionMaybeResolve(q);
    return opts.skip ? "skipped" : values.length > 0 ? values.join(", ") : (opts.custom ? "" : "ok");
  }

  /** Arm free-text capture after a surface chose "Other" (next text = answer). */
  questionNeedsOther(id: string, qid: string): boolean {
    const q = this.#questions.get(id);
    if (!q || !q.questions.some((qq) => qq.id === qid)) return false;
    q.awaitingOther = qid;
    return true;
  }

  /** Live pending set for a session (the /question re-render hook). */
  pendingQuestion(sessionKey: string): { id: string; questions: AskUserQuestion[] } | null {
    for (const q of this.#questions.values()) if (q.sessionKey === sessionKey) return { id: q.id, questions: q.questions };
    return null;
  }

  /** Lookup by set id (telegram callback router). */
  pendingQuestionForId(id: string): { id: string; sessionKey: string; questions: AskUserQuestion[] } | null {
    const q = this.#questions.get(id);
    return q ? { id: q.id, sessionKey: q.sessionKey, questions: q.questions } : null;
  }

  /** Re-emit a pending question set (the /question command). */
  reopenQuestion(sessionKey: string): boolean {
    const pending = this.pendingQuestion(sessionKey);
    if (!pending) return false;
    const qEvent: Extract<RunEvent, { type: "question" }> = { type: "question", id: pending.id, sessionKey, questions: pending.questions };
    this.events.emit("event", { type: "chat", sessionKey, event: qEvent } satisfies ServiceEvent);
    void this.#questionHooks.get(sessionKey)?.(qEvent);
    return true;
  }

  /**
   * Text-reply interception (their "text replies answer by number/label,
   * running BEFORE queueing"): the strict forms only — numbers, exact/
   * prefixed labels, "other …", "skip"; anything else falls through to the
   * normal pipeline so users can still talk while a card waits. Returns a
   * confirmation line when it consumed the text, else null.
   */
  #tryQuestionReply(sessionKey: string, text: string): string | null {
    const pending = this.pendingQuestion(sessionKey);
    if (!pending) return null;
    const q = this.#questions.get(pending.id)!;
    // Free-text "Other" capture beats everything.
    if (q.awaitingOther) {
      const qid = q.awaitingOther;
      this.answerQuestionPart(pending.id, qid, [text], { custom: true });
      return `noted — "${text.length > 60 ? `${text.slice(0, 60)}…` : text}"`;
    }
    // One unanswered question at a time gets text answers (their rule: answer
    // the FIRST unknown question; buttons/explicit ids handle the rest).
    const target = q.questions.find((qq) => q.partial[qq.id] === undefined);
    if (!target) return null;
    const verdict = matchTextReply(target, text);
    if (!verdict) return null;
    if (verdict.kind === "skip") {
      this.answerQuestionPart(pending.id, target.id, [], { skip: true });
      return `question ${target.id} skipped`;
    }
    this.answerQuestionPart(pending.id, target.id, verdict.value, { custom: verdict.custom });
    return verdict.custom && verdict.value.length === 0 ? null : `answer recorded: ${verdict.value.join(", ")}`;
  }

  /**
   * Chat commands shared by every surface (their /queue, /followup, /steer,
   * /subagents, /stop). Returns null for ordinary messages, or a payload
   * rewrite (or a direct reply) for commands.
   */
  async #commands(rawText: string, payload: ChatPayload): Promise<{ rewrite?: string; reply?: string; mode?: QueueMode } | null> {
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
    // /usage off|tokens|full|cost — per-session reply-usage footer (P2 #15;
    // their usage-tracking shapes, persisted per session like their /usage).
    if (cmd === "/usage") {
      const USAGE_MODES = ["off", "tokens", "full", "cost"] as const;
      const metaKey = `usage:${payload.sessionKey}`;
      if (!rest) {
        const override = this.store.getMeta(metaKey);
        const cur = override ?? this.config.agents.defaults.usage;
        return { reply: `Reply usage for this session: ${cur}${override ? " (session override)" : " (default)"}. Use /usage ${USAGE_MODES.join("|")} to change.` };
      }
      const mode = rest.toLowerCase() as (typeof USAGE_MODES)[number];
      if (!USAGE_MODES.includes(mode)) {
        return { reply: `unknown usage mode "${rest}" — use ${USAGE_MODES.join(" | ")}` };
      }
      this.store.setMeta(metaKey, mode);
      return { reply: `Reply usage for this session: ${mode}.` };
    }
    // /question (P2 #8) — re-show the pending ask_user set (their reopen).
    if (cmd === "/question") {
      if (this.reopenQuestion(payload.sessionKey)) {
        return { reply: "re-showing the pending question…" };
      }
      return { reply: "no pending question for this session" };
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
    // /stop (alias /abort) — cancel queued work first, then the active run (their order).
    if (cmd === "/stop" || cmd === "/abort") {
      this.denyApprovalsFor(payload.sessionKey);
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
    // Partial #10: the shared extension router (help/status/dream/title/…).
    // Every surface funnels here, so a command answers the same way no matter
    // where it was typed. Unknown `/…` text gets a catalog pointer instead of
    // confusing the model with noise (matches Telegram's existing behavior).
    const ext = await handleSlashExtension(this, cmd, rest, payload);
    if (ext !== null) return { reply: ext };
    return { reply: `unknown command ${cmd} — try /commands` };
  }

  /** One entry point for every surface: TUI, WS clients, Telegram, cron. */
  async send(payload: ChatPayload): Promise<void> {
    // ask_user text-reply interception (P2 #8; their "before queueing" rule):
    // strict answer forms get consumed with a confirmation, everything else
    // falls through untouched.
    if (!payload.text.trim().startsWith("/")) {
      const consumed = this.#tryQuestionReply(payload.sessionKey, payload.text);
      if (consumed !== null) {
        await payload.reply(consumed);
        return;
      }
    }
    // Command surface first (never reaches the model).
    const cmd = await this.#commands(payload.text, payload);
    if (cmd?.reply !== undefined) {
      await payload.reply(cmd.reply);
      // Sockets render replies through the broadcast "chat" envelope, not the
      // reply callback (which the gateway intentionally no-ops) — so record the
      // exchange in the transcript and emit final/idle like a real reply did.
      // Without this, command replies only ever reached direct-callback
      // channels (local TUI / Telegram) and vanished on every socket surface.
      const sess = this.store.ensureSession(payload.sessionKey);
      this.store.appendMessage(sess.id, "user", payload.text);
      this.store.appendMessage(sess.id, "assistant", cmd.reply);
      this.events.emit("event", { type: "chat", sessionKey: payload.sessionKey, event: { type: "final", runId: `cmd-${Date.now().toString(36)}`, text: cmd.reply } } satisfies ServiceEvent);
      this.events.emit("event", { type: "chat", sessionKey: payload.sessionKey, event: { type: "idle", sessionKey: payload.sessionKey } } satisfies ServiceEvent);
      return;
    }
    const text = cmd?.rewrite ?? payload.text;
    const queueMode = cmd?.mode ?? payload.queueMode;

    // Remember how to reach this session's channel for internal announcements.
    if (payload.source === "telegram") {
      this.#channelSinks.set(payload.sessionKey, payload.reply);
    }
    // Unattended exec policy (P2 #10): the approval path consults the source.
    this.#sessionSources.set(payload.sessionKey, payload.source);
    // ask_user surfacing (P2 #8): remember how THIS surface wants questions.
    if (payload.onQuestion) this.#questionHooks.set(payload.sessionKey, payload.onQuestion);
    if (payload.onApproval) this.#approvalHooks.set(payload.sessionKey, payload.onApproval);

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
      attachments: payload.attachments,
      lightContext: payload.lightContext === true,
      // Channel (durable-ingress style) inputs never coalesce in collect mode.
      exclusive: payload.source === "telegram",
      onEvent: (event) => {
        // Reply-usage footer (P2 #15): SURFACE-ONLY decoration on the final
        // text — the transcript row stays clean, and the same footed text
        // reaches the WS broadcast, onFinal and the channel reply alike.
        let out = event;
        if (event.type === "final") {
          const mode = (this.store.getMeta(`usage:${payload.sessionKey}`) as UsageMode | undefined) ?? this.config.agents.defaults.usage;
          const prof = modelProfile(this.config, payload.model ?? "");
          const foot = usageFooter(mode, event.usage, prof.label, prof.pricing);
          if (foot) out = { ...event, text: `${event.text}\n\n${foot}` };
        }
        this.events.emit("event", { type: "chat", sessionKey: payload.sessionKey, event: out } satisfies ServiceEvent);
        // Auto-title fires once the reply settles: non-blocking, best-effort.
        if (out.type === "final") void this.#maybeAutoTitle(payload.sessionKey);
        if (out.type === "delta") void payload.onDelta?.(out.text);
        else if (out.type === "tool") void payload.onTool?.(out);
        else if (out.type === "approval") void payload.onApproval?.(out);
        else if (out.type === "final") {
          void payload.onFinal?.(out.text, out.usage);
          void payload.reply(out.text);
        }
        else if (out.type === "error") void payload.reply(`⚠ ${out.message}`);
      },
    });
  }

  /** Register "which connected surface count counts as watching" (gateway or local TUI). */
  setApprovalSurface(fn: () => boolean): void {
    this.#approvalSurface = fn;
  }

  private requestApproval(
    callId: string,
    tool: string,
    args: Record<string, unknown>,
    ctx?: { sessionKey: string; workspace: string; onPrompt?: (info: { exec?: { mode: string; mintable: boolean; reason: string } }) => void },
  ): Promise<boolean | { approved: boolean; execVerdict?: ExecVerdict }> {
    const sessionKey = ctx?.sessionKey ?? "";
    const workspace = ctx?.workspace ?? workspaceDir();

    if (tool !== "exec") {
      // Non-exec approvals stay boolean prompts (rare; configured tools).
      this.log.info(`approval requested: ${tool} ${JSON.stringify(args).slice(0, 200)}`);
      // Telegram cards (P2 #17) count as a surface for their own sessions.
      if (!this.#approvalSurface() && !this.#approvalHooks.has(sessionKey)) return Promise.resolve(false);
      ctx?.onPrompt?.({});
      return new Promise<{ approved: boolean }>((resolve) => {
        this.#approvals.set(callId, {
          sessionKey,
          workspace,
          resolve: (decision) => resolve({ approved: decision === "once" || decision === "always" }),
        });
      });
    }

    const command = String(args.command ?? "");
    const doc = loadApprovalsDoc(this.store);
    const exec = this.configSvc.current.tools.exec;
    const verdict = evaluateExec({
      config: this.configSvc.current,
      doc,
      command,
      cwd: workspace,
      pathEnv: process.env.PATH ?? "/bin:/usr/bin",
      sessionMode: (this.#sessionExecModes.get(sessionKey) ?? undefined) as import("../config/schema.js").ExecMode | undefined,
    });
    this.log.info(`exec approval: mode=${verdict.mode} decision=${verdict.decision} reason=${verdict.reason} cmd=${command.slice(0, 120)}`);

    if (verdict.decision === "allow") return Promise.resolve({ approved: true, execVerdict: verdict });
    if (verdict.decision === "deny") return Promise.resolve({ approved: false, execVerdict: verdict });

    // Unattended sources (P2 #10): cron/webhook runs never get a surface —
    // the tools.exec.unattended policy decides INSTEAD of askFallback, and
    // every auto-decision lands in the log AND the session transcript.
    const src = this.#sessionSources.get(sessionKey) ?? "";
    if (src === "cron" || src === "webhook") {
      const mode = (exec.unattended ?? "deny") as UnattendedMode;
      const decision = unattendedDecision(mode, verdict);
      this.log.info(`unattended exec (${src}, ${sessionKey}): ${decision.audit} ⇒ ${command.slice(0, 120)}`);
      const sess = this.store.getSessionByKey(sessionKey);
      if (sess) this.store.appendMessage(sess.id, "tool", `[${decision.audit}]\n$ ${command.slice(0, 500)}`);
      return Promise.resolve({ approved: decision.allowed, execVerdict: verdict });
    }

    // ask: nobody watching → askFallback verdict (deny keeps silent for cron).
    // A telegram card sitting in the chat IS someone watching (P2 #17).
    if (!this.#approvalSurface() && !this.#approvalHooks.has(sessionKey)) {
      const fb = exec.askFallback ?? "deny";
      if (fb === "deny") {
        this.log.info(`exec ask with no surface: askFallback=deny (${verdict.reason})`);
        return Promise.resolve({ approved: false, execVerdict: verdict });
      }
      // allowlist/full fallback: re-decide under that mode
      const fbVerdict = evaluateExec({
        config: this.configSvc.current,
        doc,
        command,
        cwd: workspace,
        pathEnv: process.env.PATH ?? "/bin:/usr/bin",
        sessionMode: fb,
      });
      this.log.info(`exec ask with no surface: askFallback=${fb} → ${fbVerdict.decision}`);
      return Promise.resolve({ approved: fbVerdict.decision === "allow", execVerdict: fbVerdict });
    }

    ctx?.onPrompt?.({ exec: { mode: verdict.mode, mintable: verdict.mintable, reason: verdict.reason } });
    return new Promise<{ approved: boolean; execVerdict: ExecVerdict }>((resolve) => {
      this.#approvals.set(callId, {
        sessionKey,
        workspace,
        execVerdict: verdict,
        resolve: (decision) => {
          if (decision === "always") {
            // Mint the durable grant exactly at this boundary (allow-always =
            // exact argv + cwd; nothing mints for carriers/unparseable input).
            try {
              const plan = verdict.segments[0];
              if (verdict.mintable && plan) {
                mintAlwaysEntry(this.store, {
                  argv0: plan.argv0,
                  argv: plan.argv,
                  cwd: workspace,
                  resolvedPath: plan.resolvedPath,
                  command,
                });
                this.#broadcastApprovalsChanged();
              }
            } catch (err) {
              this.log.warn(`allow-always mint failed: ${(err as Error).message}`);
            }
          }
          resolve({ approved: decision !== "deny", execVerdict: verdict });
        },
      });
    });
  }

  /** Resolve a pending decision. Legacy boolean accepted everywhere. */
  resolveApproval(callId: string, decision: boolean | ApprovalDecision): boolean {
    const pending = this.#approvals.get(callId);
    if (!pending) return false;
    this.#approvals.delete(callId);
    pending.resolve(typeof decision === "boolean" ? (decision ? "once" : "deny") : decision);
    return true;
  }

  /** Deny every pending decision for one session (abort paths). */
  denyApprovalsFor(sessionKey: string): number {
    let n = 0;
    for (const [callId, pending] of [...this.#approvals.entries()]) {
      if (pending.sessionKey !== sessionKey) continue;
      this.#approvals.delete(callId);
      pending.resolve("deny");
      n++;
    }
    return n;
  }

  /** Broadcasts that the ledger/policy changed so open UIs re-read. */
  #broadcastApprovalsChanged(): void {
    this.events.emit("event", { type: "approvals.updated", sessionKey: "", name: "" });
  }

  /** Effective exec policy snapshot for RPC/CLI display. */
  approvalsState(): { enabled: boolean; mode: string; askFallback: string; strictInlineEval: boolean; entries: ReturnType<typeof ledgerEntries> } {
    const exec = this.configSvc.current.tools.exec;
    const doc = loadApprovalsDoc(this.store);
    return {
      enabled: exec.enabled,
      mode: execModeOf(exec),
      askFallback: exec.askFallback ?? "deny",
      strictInlineEval: exec.strictInlineEval === true,
      entries: ledgerEntries(doc),
    };
  }

  approvalsDoc(): ApprovalsDoc {
    return loadApprovalsDoc(this.store);
  }

  saveApprovalsDoc(doc: ApprovalsDoc): void {
    saveApprovalsDoc(this.store, doc);
    this.#broadcastApprovalsChanged();
  }

  /** Presets: mode + askFallback pairs in one move (their approvals --preset). */
  setExecPreset(name: "cautious" | "deny-all" | "yolo"): string {
    const presets = { cautious: { mode: "ask", askFallback: "deny" }, "deny-all": { mode: "deny", askFallback: "deny" }, yolo: { mode: "full", askFallback: "full" } } as const;
    const p = presets[name];
    this.configSvc.setPath("tools.exec.mode", p.mode);
    this.configSvc.setPath("tools.exec.askFallback", p.askFallback);
    this.#broadcastApprovalsChanged();
    return `preset ${name}: mode=${p.mode} askFallback=${p.askFallback}`;
  }

  /** /compact — force a rolling-summarization sweep now (P1 A2). */
  async compactNow(sessionKey: string, focus?: string): Promise<string> {
    const r = await this.loop.compactSession(sessionKey, { focus });
    return r.message;
  }

  compactionStats(sessionKey: string): { count: number; chars: number; upto: number } | null {
    return this.loop.compactionStats(sessionKey);
  }

  setSessionExecMode(sessionKey: string, mode: string | null): void {
    if (mode === null) this.#sessionExecModes.delete(sessionKey);
    else this.#sessionExecModes.set(sessionKey, mode);
  }

  getSessionExecMode(sessionKey: string): string | null {
    return this.#sessionExecModes.get(sessionKey) ?? null;
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

    // Inbound webhooks: enabled without a token is a closed door — warn loudly.
    const hk = config.hooks;
    if (!hk.enabled) {
      checks.push({ name: "hooks", status: "ok", detail: "disabled" });
    } else if (!hk.token) {
      checks.push({ name: "hooks", status: "warn", detail: `enabled but no hooks.token — ${hk.path} returns 503` });
    } else {
      checks.push({ name: "hooks", status: "ok", detail: `${hk.path} armed · token ${hk.token.slice(0, 4)}…${hk.token.slice(-2)}` });
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
    if (this.#maintenanceTimer) clearInterval(this.#maintenanceTimer);
    this.#cron?.stop();
    this.#heartbeat?.stop();
    this.#dream?.stop();
    await this.#telegram?.stop();
    this.store.close();
    this.log.info("service stopped");
  }
}