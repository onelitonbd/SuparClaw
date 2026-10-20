import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ConfigService } from "../config/load.js";
import type { SuparClawConfig } from "../config/schema.js";
import { Store } from "../state/db.js";
import { createLogger, type Logger } from "../util/log.js";
import { dbPath, ensureDirs, logsDir, stateDir, workspaceDir } from "../util/paths.js";
import { AgentLoop, type RunEvent } from "../agent/loop.js";
import { LlmClient, resolveModel } from "../agent/llm.js";
import { writeWorkspaceTemplates } from "../agent/workspace.js";
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
  | { type: "tick"; at: number };

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
    if (!existsSync(join(ws, "AGENTS.md"))) created.push(...writeWorkspaceTemplates(ws));
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
    await this.#telegram?.stop();
    this.store.close();
    this.log.info("service stopped");
  }
}