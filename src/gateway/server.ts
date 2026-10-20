import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import type { WebSocketServer as WsServer, WebSocket } from "ws";
import type { Service } from "../agent/service.js";
import type { Logger } from "../util/log.js";
import { errFrame, eventFrame, okFrame, parseFrame, type ClientFrame } from "./protocol.js";

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
    this.#wss = new WebSocketServer({ noServer: true });
    return this.#wss;
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
    this.#timer = setInterval(() => this.#broadcast("tick", { at: Date.now() }), 30_000);

    for (const [key, at] of this.#dedupe) if (Date.now() - at > 300_000) this.#dedupe.delete(key);
  }

  stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#unsubscribe?.();
    for (const client of this.#clients) client.close();
    return new Promise((resolve) => this.#http.close(() => resolve()));
  }

  #onUpgrade(req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void {
    const url = req.url ?? "/";
    if (!url.startsWith("/ws")) {
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
    // Mode "none" trusts everything; loopback bypass trusts this device's own browser.
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
        if (!authorized && token && provided !== token) {
          send(
            errFrame(
              "connect",
              "unauthorized",
              loopback
                ? "bad gateway token — run: sc token"
                : "bad or missing gateway token — run: sc token",
            ),
          );
          ws.close(4401, "unauthorized");
          return;
        }
        authorized = true;
        send({ type: "hello-ok", payload: { version: "0.1.0", methods: this.#methods() } });
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
      "sessions.list",
      "sessions.rename",
      "models.list",
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
        case "status":
          send(okFrame(id, service.status()));
          return;
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
          this.#clients.add(ws);
          void service.send({
            sessionKey,
            text,
            isMainSession: params["isMainSession"] === true,
            source: "gateway",
            model: typeof params["model"] === "string" && params["model"] ? params["model"] : undefined,
            reply: async (final) => this.#broadcast("chat.reply", { sessionKey, text: final }),
            onDelta: async (delta) => this.#broadcast("chat.delta", { sessionKey, delta }),
            onTool: async (event) => this.#broadcast("chat.tool", { sessionKey, event }),
            onApproval: async (event) => this.#broadcast("chat.approval", { sessionKey, event }),
          });
          return;
        }
        case "chat.history": {
          const sessionKey = String(params["sessionKey"] ?? "main:main");
          const session = service.store.ensureSession(sessionKey);
          send(
            okFrame(id, {
              sessionKey,
              messages: service.store.recentMessages(session.id, Number(params["limit"] ?? 40)).map((m) => ({
                role: m.role,
                content: m.content,
                createdAt: m.created_at,
              })),
            }),
          );
          return;
        }
        case "chat.abort":
          send(okFrame(id, { aborted: service.loop.abort(String(params["sessionKey"] ?? "main:main")) }));
          return;
        case "chat.approval":
          send(
            okFrame(id, {
              resolved: service.resolveApproval(String(params["callId"] ?? ""), params["approve"] === true),
            }),
          );
          return;
        case "sessions.list":
          send(okFrame(id, { sessions: service.store.listSessions(Number(params["limit"] ?? 50)) }));
          return;
        case "sessions.rename": {
          service.store.renameSession(String(params["id"] ?? ""), String(params["name"] ?? ""));
          send(okFrame(id, { renamed: true }));
          return;
        }
        case "models.list":
          send(okFrame(id, { models: service.loop.llm.listModels() }));
          return;
        case "tools.list":
          send(okFrame(id, { tools: service.loop.tools.map((t) => ({ name: t.name, description: t.description })) }));
          return;
        case "skills.list":
          send(
            okFrame(id, {
              skills: service.loop.skills.map((s) => ({
                name: s.name,
                description: s.description,
                readWhen: s.readWhen,
                root: s.root,
                eligible: s.eligible,
                reason: s.reason,
              })),
            }),
          );
          return;
        case "cron.list":
          send(okFrame(id, { jobs: service.store.listJobs(), runs: service.store.lastJobRuns(10) }));
          return;
        case "config.get":
          send(okFrame(id, { config: service.config, path: service.configSvc.path }));
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
          const result = service.configSvc.setPath(path, params["value"]);
          if (!result.ok) {
            send(errFrame(id, "bad_config", result.errors.join("; ")));
            return;
          }
          // Apply live so a provider or model saved from the UI takes effect now.
          service.applyConfig();
          send(okFrame(id, { ok: true, config: service.config }));
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

    if (url === "/health" || url === "/api/health") {
      const body = JSON.stringify(this.service.health());
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(body);
      return;
    }
    if (url === "/api/status") {
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
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