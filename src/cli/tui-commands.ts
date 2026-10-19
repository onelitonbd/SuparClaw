import { Service } from "../agent/service.js";
import { GatewayClient } from "../gateway/ws-client.js";
import { TuiApp, tuiHelp, type TuiDeps, type Item } from "../tui/app.js";

// --- TUI: embedded (no sockets, fastest on a phone) ------------------------

export async function tuiLocal(): Promise<number> {
  const service = new Service();
  service.bootstrap();
  let sessionKey = "main:main";
  let modelOverride: string | undefined;

  const deps: TuiDeps = {
    header: () => ({
      agent: service.config.agents.defaults.id,
      session: sessionKey,
      model: modelOverride ?? service.config.agents.defaults.model ?? "(unset)",
      target: "local",
    }),
    onSubmit: (text) => {
      // Every visual update flows through the service subscription below, so a
      // reply is never rendered twice.
      void service.send({
        sessionKey,
        text,
        isMainSession: true,
        source: "tui",
        reply: async () => {},
        onDelta: () => {},
        onTool: () => {},
        onApproval: () => {},
      });
    },
    onAbort: () => service.loop.abort(sessionKey),
    onApproval: (callId, ok) => {
      service.resolveApproval(callId, ok);
    },
    onCommand: async (name, args) => {
      switch (name) {
        case "help":
          return tuiHelp;
        case "status":
          return `model ${modelOverride ?? service.config.agents.defaults.model ?? "(unset)"} · busy: ${
            service.loop.isBusy(sessionKey) ? "yes" : "no"
          }`;
        case "model": {
          if (!args) return `model: ${modelOverride ?? service.config.agents.defaults.model}`;
          modelOverride = args.trim();
          return `model override for this session: ${modelOverride}`;
        }
        case "tools":
          return `tools: ${service.loop.tools.map((t) => t.name).join(", ")}`;
        case "skills":
          return service.loop.skills
            .map((s) => `${s.eligible ? "•" : "○"} ${s.name} — ${s.description || "(no description)"}${s.reason ? ` [${s.reason}]` : ""}`)
            .join("\n") || "(no skills)";
        case "session": {
          if (!args) return `session: ${sessionKey}`;
          sessionKey = args.trim();
          return `session: ${sessionKey}`;
        }
        case "new":
          sessionKey = `main:${Date.now().toString(36)}`;
          return `new session: ${sessionKey}`;
        case "clear":
          if (app) app.items = [];
          return "transcript cleared";
        case "abort":
          service.loop.abort(sessionKey);
          return "aborted";
        case "quit":
        case "exit":
          app?.quit();
          return "";
        default:
          return `unknown command /${name} — try /help`;
      }
    },
    listSessions: async () => service.store.listSessions(50).map((s) => s.key),
    pickSession: (key) => {
      sessionKey = key;
    },
    history: async () => {
      const session = service.store.ensureSession(sessionKey);
      return service.store.recentMessages(session.id, 40).map((m) => ({ role: m.role, content: m.content }));
    },
    models: async () => service.loop.llm.listModels(),
    setModel: async (model) => {
      modelOverride = model;
      return `model override for this session: ${model}`;
    },
    quit: () => app?.quit(),
  };

  // Late binding: the app is constructed inside runTui below.
  const { TuiApp } = await import("../tui/app.js");
  let app: InstanceType<typeof TuiApp> | null = null;
  const unsubscribe = service.subscribe((event) => {
    if (event.type !== "chat" || !app) return;
    const e = event.event;
    switch (e.type) {
      case "start":
        app.busy = true;
        app.setStatus("thinking…");
        break;
      case "delta":
        app.busy = true;
        app.push({ kind: "assistant", text: e.text, streaming: true });
        break;
      case "tool":
        app.push({ kind: "tool", name: e.name, status: e.status, detail: e.detail });
        break;
      case "approval":
        app.approvals.push({ callId: e.callId, tool: e.tool, args: e.args });
        break;
      case "final":
        app.completeAssistant(e.text);
        app.tokenHint = e.usage ? `${e.usage["total_tokens"] ?? 0}` : app.tokenHint;
        app.busy = false;
        app.setStatus("idle");
        break;
      case "error":
        app.push({ kind: "system", text: `error: ${e.message}` });
        app.busy = false;
        app.setStatus("error");
        break;
      case "idle":
        app.busy = false;
        if (app.status !== "error") app.setStatus("idle");
        break;
    }
  });

  app = new TuiApp(deps);
  app.toolCount = service.loop.tools.length;
  app.skillCount = service.loop.skills.length;
  await app.loadHistory();
  await app.start();
  unsubscribe();
  await service.stop();
  return 0;
}

// --- TUI: remote gateway mode ---------------------------------------------

export async function tuiRemote(url: string, token: string): Promise<number> {
  const client = await GatewayClient.connect(url, token);
  const health = (await client.request("health")) as { ok: boolean };
  let sessionKey = "main:main";
  const { TuiApp } = await import("../tui/app.js");
  let app: InstanceType<typeof TuiApp> | null = null;

  client.onEvent((event, payload) => {
    const data = payload as { sessionKey?: string; delta?: string; text?: string; event?: { type: string; name?: string; status?: string; detail?: string; callId?: string; tool?: string; args?: Record<string, unknown> } };
    if (event === "chat.delta" && data.delta) {
      app?.push({ kind: "assistant", text: data.delta, streaming: true });
    } else if (event === "chat.reply" && data.text) {
      app?.completeAssistant(data.text);
      if (app) app.busy = false;
    } else if (event === "chat.tool" && data.event) {
      app?.push({ kind: "tool", name: data.event.name ?? "?", status: (data.event.status as "running") ?? "done", detail: data.event.detail });
    } else if (event === "chat.approval" && data.event) {
      app?.approvals.push({ callId: data.event.callId ?? "", tool: data.event.tool ?? "", args: data.event.args ?? {} });
    }
  });

  const deps: TuiDeps = {
    header: () => ({ agent: "main", session: sessionKey, model: "-", target: url }),
    onSubmit: (text) => {
      void client.request("chat.send", { sessionKey, text, isMainSession: true, key: crypto.randomUUID() });
    },
    onAbort: () => void client.request("chat.abort", { sessionKey }),
    onApproval: (callId, ok) => {
      void client.request("chat.approval", { callId, approve: ok });
    },
    onCommand: async (name, args) => {
      if (name === "help") return tuiHelp;
      if (name === "session" && args) {
        sessionKey = args.trim();
        return `session: ${sessionKey}`;
      }
      if (name === "quit" || name === "exit") {
        app?.quit();
        return "";
      }
      return null;
    },
    listSessions: async () => {
      const res = (await client.request("sessions.list")) as { sessions: { key: string }[] };
      return res.sessions.map((s) => s.key);
    },
    pickSession: (key) => {
      sessionKey = key;
    },
    history: async () => {
      const res = (await client.request("chat.history", { sessionKey })) as {
        messages: { role: string; content: string }[];
      };
      return res.messages;
    },
    models: async () => {
      const res = (await client.request("models.list")) as { models: string[] };
      return res.models;
    },
    setModel: async () => "model is configured on the gateway (sc config set agents.defaults.model)",
    quit: () => {
      app?.quit();
      client.close();
    },
  };

  app = new TuiApp(deps);
  await app.loadHistory();
  await app.start();
  client.close();
  void health;
  return 0;
}

