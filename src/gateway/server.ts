import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import type { WebSocketServer as WsServer, WebSocket } from "ws";
import type { Service } from "../agent/service.js";
import type { Logger } from "../util/log.js";
import {
  addProvider,
  canonicalModelRef,
  discoverModels,
  removeProvider,
  testProvider,
  validateModelRef,
} from "../config/providers.js";
import { redactSecrets, resolveRedacted } from "../config/redact.js";
import { modelProfiles } from "../config/schema.js";
import { readSkillBody, skillSlug, writeSkill } from "../agent/skills.js";
import { workspaceDir } from "../util/paths.js";
import { hostAllowed, originAllowed, type TrustPolicy } from "./trust.js";
import { errFrame, eventFrame, okFrame, parseFrame, type ClientFrame } from "./protocol.js";

// The thinking ladder the UI renders. OpenClaw keeps this provider-profile
// driven; SuparClaw has one OpenAI-compatible transport, so one ladder is the
// single source of truth (mirrors agents.defaults.reasoningEffort's values).
export const THINKING_LEVELS = ["inherit", "off", "low", "medium", "high", "xhigh", "max"] as const;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** One daemon, one port: HTTP for the web UI + /health, WS for every client. */
export class Gateway {
  #http = createServer((req, res) => this.#onHttp(req, res));
  #wss: WsServer | null = null;
  #clients = new Set<WebSocket>();
  #dedupe = new Map<string, number>();
  #timer: NodeJS.Timeout | null = null;
  #unsubscribe: (() => void) | null = null;

  constructor(
    private readonly service: Service,
    private readonly log: Logger,
    private readonly webRoot?: string,
  ) {
    this.#http.on("upgrade", (req, socket, head) => this.#onUpgrade(req, socket, head));
  }

  /** `ws` is only loaded when a client actually connects. */
  async #ensureWss(): Promise<WsServer> {
    if (this.#wss) return this.#wss;
    const { WebSocketServer } = await import("ws");
    // 1 MB is generous for chat frames; the default (100 MB) is a DoS surface.
    this.#wss = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });
    return this.#wss;
  }

  get #trust(): TrustPolicy {
    const cfg = this.service.config.gateway;
    return {
      bind: cfg.bind,
      allowedHosts: cfg.allowedHosts,
      allowedOrigins: cfg.allowedOrigins,
    };
  }

  get address(): string {
    const cfg = this.service.config.gateway;
    return `${cfg.bind === "lan" ? "0.0.0.0" : "127.0.0.1"}:${cfg.port}`;
  }

  async start(): Promise<void> {
    const { port, bind } = this.service.config.gateway;
    await new Promise<void>((resolve, reject) => {
      this.#http.once("error", reject);
      this.#http.listen(port, bind === "lan" ? "0.0.0.0" : "127.0.0.1", () => {
        this.#http.off("error", reject);
        resolve();
      });
    });
    this.log.info(`gateway listening on ws://${this.address}/ws`);

    this.#unsubscribe = this.service.subscribe((event) => {
      this.#broadcast(event.type === "chat" ? "chat" : event.type, event);
    });
    this.#timer = setInterval(() => {
      // keep the send-dedupe map from growing on a long-lived daemon
      for (const [key, at] of this.#dedupe) if (Date.now() - at > 300_000) this.#dedupe.delete(key);
      // pick up job changes written by other processes (sc cron add etc)
      void this.service.cronReconcile();
      this.#broadcast("tick", { at: Date.now() });
    }, 30_000);
  }

  stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#unsubscribe?.();
    for (const client of this.#clients) client.close();
    return new Promise((resolve) => this.#http.close(() => resolve()));
  }

  #onUpgrade(req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void {
    const url = req.url ?? "/";
    const host = req.headers.host ?? "";
    const origin = req.headers.origin;
    if (!url.startsWith("/ws") || !hostAllowed(host, this.#trust)) {
      socket.destroy();
      return;
    }
    // CSWSH defense: a browser connection must be same-origin (or explicitly
    // allowlisted). No-Origin clients are native (TUI, scripts) and continue
    // to the connect-frame token check.
    if (!originAllowed(origin, host, this.#trust)) {
      this.log.warn(`ws upgrade refused: origin ${origin ?? "(none)"} for host ${host}`);
      socket.write("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const remote = req.socket.remoteAddress ?? "";
    const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    void this.#ensureWss().then((wss) => wss.handleUpgrade(req, socket, head, (ws) => this.#onConnection(ws, loopback)));
  }

  #onConnection(ws: WebSocket, loopback: boolean): void {
    const auth = this.service.config.gateway.auth;
    const token = auth.token;
    // Mode "none" trusts everything. Loopback bypass trusts this device's own
    // browser/native clients (Origin policy already held at the upgrade).
    // Token matching is fail-closed: an empty token in token mode can never
    // authorize a client that is not covered by the bypass.
    let authorized = auth.mode === "none" || (loopback && auth.loopbackBypass);
    let seenConnect = false;
    const send = (frame: unknown) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    };

    ws.on("message", (data) => {
      const frame = parseFrame(data.toString()) as ClientFrame | null;
      if (!frame) {
        send(errFrame("?", "bad_frame", "expected JSON frame"));
        return;
      }

      if (frame.type === "connect") {
        seenConnect = true;
        const provided = frame.params?.token ?? "";
        if (!authorized && token && provided === token) {
          authorized = true;
        }
        if (!authorized) {
          send(
            errFrame(
              "connect",
              "unauthorized",
              loopback
                ? token
                  ? "bad gateway token — run: sc token"
                  : "gateway token is not set — run: sc init (token auth is fail-closed)"
                : "bad or missing gateway token — run: sc token",
            ),
          );
          ws.close(4401, "unauthorized");
          return;
        }
        send({ type: "hello-ok", payload: { version: "0.1.0", methods: this.#methods() } });
        // Register as an event subscriber immediately after auth so observers
        // (second tabs, remote TUIs) receive broadcasts — not just sockets
        // that happen to have sent a chat.send.
        this.#clients.add(ws);
        return;
      }

      if (!authorized) {
        send(errFrame("req", "unauthorized", "connect first"));
        return;
      }
      if (frame.type === "ping") {
        send({ type: "pong", at: Date.now() });
        return;
      }
      if (!seenConnect) return;

      if (frame.type === "req") {
        void this.#handleRequest(frame.id, frame.method, frame.params ?? {}, send, ws);
      }
    });

    ws.on("close", () => this.#clients.delete(ws));
    ws.on("error", () => this.#clients.delete(ws));
  }

  #methods(): string[] {
    return [
      "health",
      "status",
      "chat.send",
      "chat.history",
      "chat.abort",
      "chat.approval",
      "queue.set",
      "queue.status",
      "subagents.list",
      "subagents.cancel",
      "sessions.list",
      "sessions.search",
      "sessions.patch",
      "sessions.rename",
      "models.list",
      "models.plugins",
      "models.local.scan",
      "models.local.add",
      "models.auth.list",
      "models.auth.addKey",
      "models.auth.beginDeviceCode",
      "models.auth.pollDeviceCode",
      "models.auth.remove",
      "models.auth.order",
      "models.auth.probe",
      "providers.add",
      "providers.remove",
      "providers.test",
      "tools.list",
      "skills.list",
      "cron.list",
      "config.get",
      "config.path",
      "config.set",
    ];
  }

  async #handleRequest(
    id: string,
    method: string,
    params: Record<string, unknown>,
    send: (frame: unknown) => void,
    ws: WebSocket,
  ): Promise<void> {
    const service = this.service;
    try {
      switch (method) {
        case "health":
          send(okFrame(id, service.health()));
          return;
        case "status": {
          const status = service.status() as Record<string, unknown>;
          const main = service.store.getSessionByKey("main:main");
          send(
            okFrame(id, {
              ...status,
              thinkingLevels: THINKING_LEVELS,
              thinkingDefault: String(service.config.agents.defaults.reasoningEffort ?? "inherit"),
              reasoningView: String(service.config.agents.defaults.reasoningView ?? "on"),
              thinking: main?.thinking ?? null,
            }),
          );
          return;
        }
        case "chat.send": {
          const sessionKey = String(params["sessionKey"] ?? "main:main");
          const text = String(params["text"] ?? "");
          const dedupeKey = typeof params["key"] === "string" ? (params["key"] as string) : null;
          if (dedupeKey) {
            if (this.#dedupe.has(dedupeKey)) {
              send(okFrame(id, { deduped: true }));
              return;
            }
            this.#dedupe.set(dedupeKey, Date.now());
          }
          if (!text.trim()) {
            send(errFrame(id, "bad_request", "text is required"));
            return;
          }
          send(okFrame(id, { accepted: true, sessionKey }));
          // Single event stream: service.subscribe already fans every run event
          // (start/delta/tool/approval/final/error/idle) out to ALL sockets as
          // "chat" envelopes. Broadcasting again from these callbacks produced
          // a second copy of every event — doubled streaming text and a
          // duplicate assistant bubble per reply in every client.
          const queueMode = ["steer", "followup", "collect", "interrupt"].includes(String(params["queueMode"]))
            ? (params["queueMode"] as "steer" | "followup" | "collect" | "interrupt")
            : undefined;
          void service.send({
            sessionKey,
            text,
            isMainSession: params["isMainSession"] === true,
            source: "gateway",
            queueMode,
            model: typeof params["model"] === "string" && params["model"] ? params["model"] : undefined,
            reasoning:
              typeof params["reasoning"] === "string" && params["reasoning"] ? params["reasoning"] : undefined,
            reply: async () => {
              /* final text rides the "chat" envelope (event.type === "final") */
            },
          });
          return;
        }
        case "chat.history": {
          const sessionKey = String(params["sessionKey"] ?? "main:main");
          // Read path: a history fetch must never create a session. The old
          // ensureSession() here spawned ghost rows in the sidebar whenever
          // the UI asked about a key that no longer existed.
          const session = service.store.getSessionByKey(sessionKey);
          // Anchored read (their session-search rule): reopen the transcript
          // surrounded around a search hit's messageId; a missing or off-path
          // anchor returns empty — never the newest tail.
          const anchor = Number.isFinite(Number(params["messageId"])) ? Number(params["messageId"]) : undefined;
          const rows = session
            ? anchor !== undefined
              ? service.store.messagesAround(session.id, anchor, Number(params["limit"] ?? 40))
              : service.store.recentMessages(session.id, Number(params["limit"] ?? 40))
            : [];
          send(
            okFrame(id, {
              sessionKey,
              anchor: anchor ?? null,
              messages: rows.map((m) => ({
                id: m.id,
                role: m.role,
                content: m.content,
                createdAt: m.created_at,
              })),
            }),
          );
          return;
        }
        case "sessions.search": {
          // Session search (Partial #3): literal-word FTS over user/assistant
          // transcript text (tool rows excluded), plus token-matched titles.
          // { query, limit?, sessionKeys? (repeatable narrowing), scope? }
          const query = String(params["query"] ?? "");
          const result = service.store.searchSessions(query.slice(0, 4096), {
            limit: Math.max(1, Math.min(Number(params["limit"] ?? 25) || 25, 25)),
            sessionKeys: Array.isArray(params["sessionKeys"]) ? (params["sessionKeys"] as string[]).map(String) : undefined,
            scope: params["scope"] === "all" ? "all" : "visible",
          });
          send(okFrame(id, result));
          return;
        }
        case "chat.abort":
          // runId cancels just that queued/steering input; without it, queued
          // work is cancelled first, then the active run (their order).
          send(
            okFrame(id, {
              aborted: service.loop.abort(
                String(params["sessionKey"] ?? "main:main"),
                typeof params["runId"] === "string" && params["runId"] ? params["runId"] : undefined,
              ),
            }),
          );
          return;
        case "queue.set": {
          // Per-session /queue override (mode + optional debounce/cap/drop).
          const sessionKey = String(params["sessionKey"] ?? "main:main");
          const MODE = ["steer", "followup", "collect", "interrupt"];
          const mode = MODE.includes(String(params["mode"])) ? String(params["mode"]) : null;
          const reset = params["reset"] === true;
          const opts: { debounceMs?: number; cap?: number; drop?: string } = {};
          if (typeof params["debounceMs"] === "number" && params["debounceMs"] >= 0) opts.debounceMs = params["debounceMs"];
          if (typeof params["cap"] === "number" && params["cap"] >= 1) opts.cap = Math.floor(params["cap"]);
          if (typeof params["drop"] === "string" && ["summarize", "old", "new"].includes(params["drop"])) opts.drop = params["drop"];
          // No explicit mode/opts → keep the session's existing override.
          const cur = service.store.getSessionByKey(sessionKey);
          let curOpts: { debounceMs?: number; cap?: number; drop?: string } | null = null;
          try { curOpts = cur?.queue_opts ? JSON.parse(cur.queue_opts) : null; } catch { curOpts = null; }
          service.store.setSessionQueue(
            sessionKey,
            reset ? null : (mode ?? cur?.queue_mode ?? null),
            reset ? null : (Object.keys(opts).length > 0 ? opts : curOpts),
          );
          send(okFrame(id, { ok: true, ...service.loop.queueStatus(sessionKey) }));
          return;
        }
        case "queue.status": {
          const sessionKey = String(params["sessionKey"] ?? "main:main");
          send(okFrame(id, service.loop.queueStatus(sessionKey)));
          return;
        }
        case "subagents.list": {
          const sessionKey = String(params["sessionKey"] ?? "main:main");
          send(okFrame(id, { sessionKey, children: service.subagents?.list(sessionKey) ?? [] }));
          return;
        }
        case "subagents.cancel": {
          const sessionKey = String(params["sessionKey"] ?? "main:main");
          const target = String(params["target"] ?? "");
          const rows = service.subagents?.list(sessionKey) ?? [];
          const row =
            rows.find((r) => r.task_name === target) ??
            rows.find((r) => r.child_session_key === target) ??
            rows.find((r) => r.run_id === target);
          if (!row || !service.subagents) {
            send(errFrame(id, "not_found", `no running sub-agent matching "${target}"`));
            return;
          }
          const stopped = service.subagents.cancel(row.child_session_key);
          send(okFrame(id, { cancelled: stopped, childSessionKey: row.child_session_key }));
          return;
        }
        case "chat.approval":
          send(
            okFrame(id, {
              resolved: service.resolveApproval(String(params["callId"] ?? ""), params["approve"] === true),
            }),
          );
          return;
        case "dream.run": {
          // Manual dreaming trigger (same sweep as the nightly schedule):
          // consolidates memory/YYYY-MM-DD.md notes into MEMORY.md and appends
          // the dated "Deep Sleep" entry to DREAMS.md. Awaits the sweep — with
          // a real provider this can take a minute or two.
          const text = await service.dreamNow();
          send(okFrame(id, { text }));
          return;
        }
        case "service.status": {
          // The Service card (Runtime tab) — OpenClaw's `status --deep`, lite:
          // manager, boot state, pid/supervisor, uptime, restart capability.
          const rt = (await import("../cli/service.js")).serviceRuntimeInfo();
          send(okFrame(id, { ...rt, ...service.health() }));
          return;
        }
        case "service.logs": {
          const tail = (await import("../cli/service.js")).serviceLogTail(Number(params["lines"] ?? 30));
          send(okFrame(id, tail));
          return;
        }
        case "service.restart": {
          // Parity with OpenClaw's gateway.restart.request: only survives the
          // exit when a supervisor (sc gateway / runit / systemd) respawns us.
          const rt = (await import("../cli/service.js")).serviceRuntimeInfo();
          const willComeBack = rt["restartSupported"] === true;
          send(okFrame(id, { restarting: true, willComeBack }));
          // Graceful SIGTERM to self: runs the normal shutdown path, then the
          // supervisor (or runit/systemd) brings the gateway right back.
          setTimeout(() => { try { process.kill(process.pid, "SIGTERM"); } catch { /* gone */ } }, 150).unref();
          return;
        }
        case "dream.status":
          // The Memory settings tab (OpenClaw's Dreams tab): dreaming state,
          // schedule, next run, last sweep, and the memory counts.
          send(okFrame(id, await service.dreamStatus()));
          return;
        case "dream.diary":
          // DREAMS.md + MEMORY.md for the tab's reader. Humans-only content —
          // the diary never feeds back into memory.
          send(okFrame(id, service.dreamDiary()));
          return;
        case "sessions.list":
          send(okFrame(id, { sessions: service.store.listSessions(Number(params["limit"] ?? 50)) }));
          return;
        case "sessions.patch": {
          // Thinking-level picker writes here immediately (OpenClaw's model):
          // an explicit per-session override, cleared by passing null. The
          // saved choice survives reloads and applies to later turns.
          const key = String(params["sessionKey"] ?? params["key"] ?? "");
          const thinking = params["thinking"] === null ? null : String(params["thinkingLevel"] ?? params["thinking"] ?? "");
          service.store.setSessionThinking(key, thinking === "" ? null : thinking);
          const row = service.store.getSessionByKey(key);
          send(
            okFrame(id, {
              patched: true,
              sessionKey: key,
              thinking: row?.thinking ?? null,
              thinkingLevels: THINKING_LEVELS,
              thinkingDefault: String(service.config.agents.defaults.reasoningEffort ?? "inherit"),
            }),
          );
          return;
        }
        case "sessions.rename": {
          // The web UI renames a session KEY ({sessionKey, newKey}) — the
          // messages follow the row. The old handler read {id, name} which the
          // UI never sent, so every rename was a silent no-op and the UI's
          // localStorage then pointed at a session that had no messages.
          const oldKey = String(params["sessionKey"] ?? params["id"] ?? "");
          const newKey = String(params["newKey"] ?? "");
          if (newKey) {
            const result = service.store.renameSessionKey(oldKey, newKey);
            if (!result.ok) {
              send(errFrame(id, "bad_request", result.error ?? "rename failed"));
              return;
            }
            send(okFrame(id, { renamed: true, sessionKey: newKey }));
            return;
          }
          service.store.renameSession(oldKey, String(params["name"] ?? ""));
          send(okFrame(id, { renamed: true }));
          return;
        }
        case "models.list": {
          // Live inventory: saved rows served immediately, TTL-stale providers
          // refresh in the background; {refresh:true} fetches now (OpenClaw's
          // explicit Refresh). Failed refreshes keep saved rows + a warning.
          const result = await discoverModels(service.configSvc, {
            refresh: params["refresh"] === true,
          });
          send(okFrame(id, { ...result, configured: modelProfiles(service.config), auth: service.authProfilesView() }));
          return;
        }
        case "models.plugins": {
          const { pluginSummaries } = await import("../agent/provider-plugins.js");
          send(okFrame(id, { plugins: pluginSummaries() }));
          return;
        }
        case "models.local.scan": {
          send(okFrame(id, await service.modelsLocalScan()));
          return;
        }
        case "models.local.add": {
          const out = await service.modelsLocalAdd(String(params["service"] ?? ""), params["setDefault"] === true);
          if (!out.ok) send(errFrame(id, "bad_request", out.error ?? "could not add"));
          else send(okFrame(id, out));
          return;
        }
        case "models.auth.list": {
          send(okFrame(id, { profiles: service.authProfilesView(String(params["provider"] ?? "") || undefined) }));
          return;
        }
        case "models.auth.addKey": {
          const out = await service.authLoginWithKey({
            provider: String(params["provider"] ?? ""),
            method: params["method"] === "token" ? "token" : "api_key",
            material: String(params["key"] ?? ""),
            label: String(params["label"] ?? ""),
            setDefault: params["setDefault"] === true,
          });
          if (!out.ok) send(errFrame(id, "bad_request", out.error ?? "login failed"));
          else send(okFrame(id, out));
          return;
        }
        case "models.auth.beginDeviceCode": {
          const out = await service.authBeginDeviceCode(String(params["provider"] ?? ""));
          if (!out.ok) send(errFrame(id, "bad_request", out.error ?? "device login unavailable"));
          else send(okFrame(id, out));
          return;
        }
        case "models.auth.pollDeviceCode": {
          const out = await service.authPollDeviceCode(String(params["flow"] ?? ""), {
            setDefault: params["setDefault"] === true,
          });
          send(okFrame(id, out));
          return;
        }
        case "models.auth.remove": {
          const out = service.authRemove(String(params["profile"] ?? ""));
          if (!out.ok) send(errFrame(id, "not_found", out.error ?? "no such profile"));
          else send(okFrame(id, out));
          return;
        }
        case "models.auth.order": {
          const out = service.authSetOrder(String(params["provider"] ?? ""), Array.isArray(params["ids"]) ? (params["ids"] as string[]) : null);
          send(okFrame(id, out));
          return;
        }
        case "models.auth.probe": {
          const out = await service.authProbe(String(params["provider"] ?? "") || undefined);
          send(okFrame(id, { probe: out }));
          return;
        }
        case "models.save": {
          // Upsert one curated profile (Settings → Models). Identity follows
          // the fetched model: id = slug(ref) unless explicitly given, so one
          // fetched model = one config entry (the UI selects from fetched
          // lists; labels never fork the identity).
          const profileId = skillSlug(String(params["id"] ?? params["ref"] ?? params["label"] ?? ""));
          if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(profileId)) {
            send(errFrame(id, "bad_request", "id must be 1-64 lowercase letters, numbers, or hyphens"));
            return;
          }
          const ref = String(params["ref"] ?? "").trim();
          if (!ref) {
            send(errFrame(id, "bad_request", "ref is required (provider/model)"));
            return;
          }
          // Merge with the existing entry: a checkbox toggle or label edit
          // must never wipe stored tuning (context window etc.).
          type ModelEntry = {
            label?: string;
            enabled?: boolean;
            contextWindow?: number;
            maxTokens?: number;
            temperature?: number;
            reasoningEffort?: string;
          };
          const prev: ModelEntry = (service.config.models ?? {})[profileId] ?? {};
          const num = (key: string, whole = true): number | undefined => {
            const v = Number(params[key]);
            if (params[key] === undefined || params[key] === "" || !Number.isFinite(v)) return undefined;
            return whole ? Math.max(0, Math.trunc(v)) : v;
          };
          const entry: Record<string, unknown> = {
            ref,
            label: params["label"] !== undefined ? String(params["label"] ?? "").trim() : (prev.label ?? ""),
            enabled: params["enabled"] !== undefined ? params["enabled"] !== false : (prev.enabled ?? true),
            contextWindow: num("contextWindow") ?? prev.contextWindow ?? 0,
            maxTokens: num("maxTokens") ?? prev.maxTokens ?? 0,
            reasoningEffort:
              params["reasoningEffort"] !== undefined
                ? String(params["reasoningEffort"] ?? "inherit")
                : (prev.reasoningEffort ?? "inherit"),
          };
          const temp = num("temperature", false);
          const keepTemp = (prev as { temperature?: number }).temperature;
          if (temp !== undefined) entry["temperature"] = temp;
          else if (typeof keepTemp === "number") entry["temperature"] = keepTemp;
          const result = service.configSvc.setPath(`models.${profileId}`, entry);
          if (!result.ok) {
            send(errFrame(id, "bad_request", result.errors[0] ?? "invalid model entry"));
            return;
          }
          service.applyConfig();
          send(okFrame(id, { ok: true, id: profileId, models: modelProfiles(service.config) }));
          return;
        }
        case "models.remove": {
          const key = String(params["id"] ?? "");
          const rest = { ...service.config.models };
          if (!(key in rest)) {
            send(errFrame(id, "not_found", `no model profile named ${key}`));
            return;
          }
          delete rest[key];
          const result = service.configSvc.set("models", rest);
          if (!result.ok) {
            send(errFrame(id, "bad_request", result.errors[0] ?? "could not remove model"));
            return;
          }
          service.applyConfig();
          send(okFrame(id, { ok: true, models: modelProfiles(service.config) }));
          return;
        }
        case "providers.add": {
          const name = String(params["name"] ?? "");
          // The UI edits keys through redaction sentinels; a rename carries the
          // sentinel from the OLD record, so resolve against that one.
          const prev =
            typeof params["previousName"] === "string" && params["previousName"]
              ? params["previousName"]
              : name;
          const stored = service.config.providers[prev.trim().toLowerCase()] as
            | { apiKey?: string }
            | undefined;
          const apiKeyRaw = typeof params["apiKey"] === "string" ? params["apiKey"] : undefined;
          const result = await addProvider(service.configSvc, name, {
            baseUrl: typeof params["baseUrl"] === "string" ? params["baseUrl"] : undefined,
            apiKey:
              apiKeyRaw !== undefined
                ? (resolveRedacted(stored?.apiKey ?? "", apiKeyRaw) as string)
                : undefined,
            models: Array.isArray(params["models"])
              ? (params["models"] as unknown[]).filter((m): m is string => typeof m === "string")
              : undefined,
          });
          if (!result.ok) {
            send(errFrame(id, "bad_request", result.message));
            return;
          }
          service.applyConfig();
          send(okFrame(id, { ok: true, message: result.message, config: redactSecrets(service.config) }));
          return;
        }
        case "providers.remove": {
          const result = removeProvider(service.configSvc, String(params["name"] ?? ""));
          if (!result.ok) {
            send(errFrame(id, "bad_request", result.message));
            return;
          }
          service.applyConfig();
          send(okFrame(id, { ok: true, message: result.message, config: redactSecrets(service.config) }));
          return;
        }
        case "providers.test": {
          const result = await testProvider(service.config, String(params["name"] ?? ""));
          send(okFrame(id, { ok: result.ok, message: result.message }));
          return;
        }
        case "tools.list":
          // Read-only inventory — neither the UI nor the agent can add tools.
          send(
            okFrame(id, {
              tools: service.loop.tools.map((t) => ({
                name: t.name,
                description: t.description,
                needsApproval: t.needsApproval === true,
              })),
            }),
          );
          return;
        case "skills.list":
          send(
            okFrame(id, {
              skills: service.loop.skills.map((s) => ({
                name: s.name,
                description: s.description,
                readWhen: s.readWhen,
                root: s.root,
                path: s.path,
                eligible: s.eligible,
                reason: s.reason,
                userInvocable: s.userInvocable,
                disableModelInvocation: s.disableModelInvocation,
              })),
            }),
          );
          return;
        case "skills.get": {
          const name = String(params["name"] ?? "");
          const skill = service.loop.skills.find((s) => s.name === name);
          if (!skill) {
            send(errFrame(id, "not_found", `no skill named ${name}`));
            return;
          }
          send(
            okFrame(id, {
              name: skill.name,
              description: skill.description,
              root: skill.root,
              path: skill.path,
              body: readSkillBody(skill),
            }),
          );
          return;
        }
        case "skills.save": {
          // The shared save path (Settings "+", CLI, and `skill_save` tool
          // writes go through workspace/skills directly). Writes
          // <workspace>/skills/<name>/SKILL.md and re-discovers immediately.
          const result = writeSkill(
            workspaceDir(),
            String(params["name"] ?? ""),
            String(params["description"] ?? ""),
            String(params["body"] ?? params["content"] ?? ""),
          );
          if (!result.ok) {
            send(errFrame(id, "bad_request", result.error ?? "could not save skill"));
            return;
          }
          service.loop.refreshSkills();
          send(okFrame(id, { ok: true, name: result.name, path: result.path }));
          return;
        }
        case "cron.list":
          // Reconcile here so jobs added by other processes (`sc cron add`)
          // show up — and arm — without waiting for the next tick.
          await service.cronReconcile();
          send(okFrame(id, { jobs: service.store.listJobs(), runs: service.store.lastJobRuns(10) }));
          return;
        case "config.get":
          // Never serialize raw secrets on the wire — the UI edits through
          // sentinels (see config/redact.ts).
          send(okFrame(id, { config: redactSecrets(service.config), path: service.configSvc.path }));
          return;
        case "config.path":
          send(okFrame(id, { path: service.configSvc.path }));
          return;
        case "config.set": {
          const path = String(params["path"] ?? "");
          if (!path) {
            send(errFrame(id, "bad_request", "path is required"));
            return;
          }
          // Sentinels sent back by an editor mean "keep the stored value".
          let value = resolveRedacted(service.configSvc.get(path), params["value"]);
          // A model reference is stored canonically as "<provider>/<model>".
          // Model ids often contain slashes, so a bare id has to be looked up
          // instead of split on its first slash.
          if (path === "agents.defaults.model" && typeof value === "string") {
            // A curated profile id (Settings → Models) is a valid default
            // model: the loop resolves it to its wire ref + tuning at run time.
            // Only bare provider refs go through canonicalization/validation.
            const isProfileId = Boolean((service.config.models ?? {})[value.trim()]);
            if (!isProfileId) {
              const modelRef = canonicalModelRef(service.config, value) ?? value;
              value = modelRef;
              const invalid = modelRef.trim() ? validateModelRef(service.config, modelRef) : null;
              if (invalid) {
                send(errFrame(id, "bad_model", invalid));
                return;
              }
            }
          } else if (path === "agents.defaults.fallbacks" && Array.isArray(value)) {
            const fallbacks = value.map((m) => {
              if (typeof m !== "string") return m;
              const t = m.trim();
              // Profile ids (Settings → Models) are valid fallback entries —
              // the loop resolves them to wire refs. Keep them untouched.
              if ((service.config.models ?? {})[t]) return t;
              return canonicalModelRef(service.config, t) ?? t;
            });
            for (const m of fallbacks) {
              if (typeof m !== "string" || !m.trim()) continue;
              if ((service.config.models ?? {})[m.trim()]) continue;
              const invalid = validateModelRef(service.config, m);
              if (invalid) {
                send(errFrame(id, "bad_model", invalid));
                return;
              }
            }
            value = fallbacks;
          }
          const result = service.configSvc.setPath(path, value);
          if (!result.ok) {
            send(errFrame(id, "bad_config", result.errors.join("; ")));
            return;
          }
          // Apply live so a provider or model saved from the UI takes effect now.
          service.applyConfig();
          send(okFrame(id, { ok: true, config: redactSecrets(service.config) }));
          return;
        }
        default:
          send(errFrame(id, "unknown_method", method));
      }
    } catch (err) {
      send(errFrame(id, "internal", (err as Error).message));
    }
  }

  #broadcast(event: string, payload: unknown): void {
    const frame = eventFrame(event, payload);
    const json = JSON.stringify(frame);
    for (const client of this.#clients) {
      if (client.readyState === client.OPEN) client.send(json);
    }
  }

  #onHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = (req.url ?? "/").split("?")[0] ?? "/";

    // DNS-rebinding defense: a browser tricked into resolving attacker.com to
    // 127.0.0.1 still sends Host: attacker.com — refused here.
    if (!hostAllowed(req.headers.host ?? "", this.#trust)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("forbidden host\n");
      return;
    }

    if (url === "/health" || url === "/api/health") {
      const body = JSON.stringify(this.service.health());
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
      return;
    }
    if (url === "/api/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(this.service.status()));
      return;
    }

    const cfg = this.service.config;
    if (!cfg.gateway.controlUi.enabled || !this.webRoot || !existsSync(this.webRoot)) {
      const looked = this.webRoot ? `looked in ${this.webRoot}` : "no ui/ directory found next to the install";
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end(
        `SuparClaw gateway is running (${cfg.gateway.controlUi.enabled ? "web UI disabled or missing" : "web UI disabled in config"}).\n${looked}\n` +
          "The Control UI is plain HTML — there is no build step. Re-run the installer:\n" +
          "  curl -fsSL https://raw.githubusercontent.com/onelitonbd/SuparClaw/main/install.sh | bash\n",
      );
      return;
    }

    const base = cfg.gateway.controlUi.basePath.replace(/\/$/, "");
    const rel = normalize(url.slice(base.length) || "/").replace(/^(\.\.[/\\])+/, "");
    let file = join(this.webRoot, rel);
    if (!file.startsWith(this.webRoot)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(this.webRoot, "index.html");
    if (!existsSync(file)) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const type = MIME[extname(file)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
    res.end(readFileSync(file));
  }
}