import { Service } from "../agent/service.js";
import { GatewayClient } from "../gateway/ws-client.js";
import { TuiApp, tuiHelp, type TuiDeps, type Item } from "../tui/app.js";
import {
  addProvider,
  canonicalModelRef,
  formatProviders,
  parseProviderAddArgs,
  removeProvider,
  testProvider,
} from "../config/providers.js";

// --- TUI: embedded (no sockets, fastest on a phone) ------------------------

export async function tuiLocal(): Promise<number> {
  const service = new Service();
  service.bootstrap();
  let sessionKey = "main:main";
  let modelOverride: string | undefined;

  const deps: TuiDeps = {
    header: () => {
      // Task 35: the footer answers "where is my code?" — derived from the open
      // session's binding, so switching sessions switches the line.
      const binding = service.store.getSessionRepo(sessionKey);
      return {
        agent: service.config.agents.defaults.id,
        session: sessionKey,
        model: modelOverride ?? service.config.agents.defaults.model ?? "(unset)",
        target: "local",
        ...(binding ? { repo: binding.repo, branch: binding.branch } : {}),
      };
    },
    onSubmit: (text) => {
      // Every visual update flows through the service subscription below, so a
      // reply is never rendered twice.
      void service.send({
        sessionKey,
        text,
        isMainSession: true,
        source: "tui",
        model: modelOverride,
        reply: async () => {},
        onDelta: () => {},
        onTool: () => {},
      });
    },
    onAbort: () => service.loop.abort(sessionKey),
    onCommand: async (name, args) => {
      switch (name) {
        case "help":
          return tuiHelp;
        case "model": {
          const raw = args.trim();
          if (!raw) return `model: ${modelOverride ?? service.config.agents.defaults.model ?? "(unset)"}`;
          const save = /\s--save$/.test(raw);
          const typed = save ? raw.replace(/\s--save$/, "").trim() : raw;
          // a bare model id ("kilo/nvidia/x") becomes "<provider>/<id>"
          const ref = save ? (canonicalModelRef(service.config, typed) ?? typed) : typed;
          if (save) {
            const { validateModelRef } = await import("../config/providers.js");
            const invalid = validateModelRef(service.config, ref);
            if (invalid) return `invalid model reference: ${invalid}`;
            const result = service.configSvc.setPath("agents.defaults.model", ref);
            if (!result.ok) return result.errors.join("; ");
            service.applyConfig();
            modelOverride = ref;
            return `default model saved: ${ref}`;
          }
          modelOverride = ref;
          return `model override for this session: ${modelOverride}  (add --save to make it default)`;
        }
        case "provider": {
          const [sub = "list", ...rest] = args.split(/\s+/).filter(Boolean);
          switch (sub) {
            case "list":
              return formatProviders(service.config);
            case "add": {
              if (!rest[0]) return "usage: /provider add <name> [baseUrl|apiKey] [apiKey] [models,a,b]";
              const opts = parseProviderAddArgs(rest);
              const added = await addProvider(service.configSvc, opts.name ?? "", opts);
              if (added.ok) service.applyConfig();
              return added.message;
            }
            case "remove": {
              if (!rest[0]) return "usage: /provider remove <name>";
              const removed = removeProvider(service.configSvc, rest[0]);
              if (removed.ok) service.applyConfig();
              return removed.message;
            }
            case "test": {
              if (!rest[0]) return "usage: /provider test <name>";
              const tested = await testProvider(service.config, rest[0]);
              return tested.message;
            }
            default:
              return `unknown /provider ${sub} — try: list, add, remove, test`;
          }
        }
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
        case "quit":
        case "exit":
          app?.quit();
          return "";
        default: {
          // Unified surface (Partial #10): every command the TUI doesn't own
          // goes through the shared router in service.send, so web chat and
          // Telegram resolve the exact same text to the exact same reply. The
          // reply arrives via the service subscription below as the usual
          // chat events (final/idle), never double-rendered here.
          void service.send({
            sessionKey,
            text: `/${name}${args ? ` ${args}` : ""}`,
            isMainSession: true,
            source: "tui",
            model: modelOverride,
            reply: async () => {},
            onDelta: () => {},
            onTool: () => {},
              });
          return null;
        }
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
    repos: async () => {
      try {
        const rows = await service.githubRepos({ page: 1 });
        return rows.map((r) => `${r.fullName}  ${r.private ? "private" : "public"} · ${r.defaultBranch}`);
      } catch (err) {
        app?.push({ kind: "system", text: (err as Error).message });
        return [];
      }
    },
    branches: async (repo) => {
      try {
        const rows = await service.githubBranches({ repo });
        return rows.map((b) => `${b.default ? "●" : " "} ${b.name}${b.protected ? "  (protected)" : ""}`);
      } catch (err) {
        app?.push({ kind: "system", text: (err as Error).message });
        return [];
      }
    },
    newSession: (spec) => {
      sessionKey = `main:${Date.now().toString(36)}`;
      app?.push({ kind: "system", text: `new session: ${sessionKey}` });
      if (spec.kind === "code" && spec.repo) {
        void service.bindRepo({ sessionKey, repo: spec.repo, branch: spec.branch }).then((res) => {
          app?.push({
            kind: "system",
            text: res.ok ? `working in ${res.repo} · ${res.branch}${res.branch === res.base ? " (the default branch)" : ` (from ${res.base})`}` : res.error,
          });
          if (res.ok) void app?.loadHistory();
        });
      }
      // The transcript belongs to the new key now, and nothing else on screen
      // should keep showing the previous session's messages.
      if (app) app.items = [];
      void app?.loadHistory();
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
      case "final":
        // The usage line rides `footer`, not the text (Task 23) — the web chat
        // draws it in its own element, the TUI keeps it inline.
        app.completeAssistant(e.footer ? `${e.text}\n\n${e.footer}` : e.text);
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
  // Remote mode has no local store, so the footer's repo line is whatever this
  // client bound in this run — never a guess about the gateway's state.
  const repoBindings = new Map<string, { repo: string; branch: string }>();
  const { TuiApp } = await import("../tui/app.js");
  let app: InstanceType<typeof TuiApp> | null = null;

  client.onEvent((event, payload) => {
    // One stream: "chat" envelopes carry every run event (the gateway no
    // longer emits per-event chat.delta/chat.reply/… frames).
    if (event !== "chat") return;
    const data = payload as {
      sessionKey?: string;
      event?: {
        type: string;
        text?: string;
        message?: string;
        name?: string;
        status?: string;
        detail?: string;
        callId?: string;
        tool?: string;
        args?: Record<string, unknown>;
        exec?: { mode: string; mintable: boolean; reason: string };
        /** /usage line for the final reply (a field, not text — Task 23). */
        footer?: string;
      };
    };
    if (data.sessionKey && data.sessionKey !== sessionKey) return;
    const e = data.event ?? ({} as NonNullable<typeof data.event>);
    switch (e.type) {
      case "start":
        if (app) app.busy = true;
        break;
      case "delta":
        app?.push({ kind: "assistant", text: String(e.text ?? ""), streaming: true });
        break;
      case "tool":
        app?.push({ kind: "tool", name: e.name ?? "?", status: (e.status as "running") ?? "done", detail: e.detail });
        break;
      case "final":
        app?.completeAssistant(
          e?.footer ? `${String(e.text ?? "")}\n\n${String(e.footer)}` : String(e.text ?? ""),
        );
        if (app) app.busy = false;
        break;
      case "error":
        app?.completeAssistant(`⚠ ${String(e.message ?? "error")}`);
        if (app) app.busy = false;
        break;
      case "idle":
        if (app) app.busy = false;
        break;
    }
  });

  const deps: TuiDeps = {
    header: () => {
      const binding = repoBindings.get(sessionKey);
      return {
        agent: "main",
        session: sessionKey,
        model: "-",
        target: url,
        ...(binding ? { repo: binding.repo, branch: binding.branch } : {}),
      };
    },
    onSubmit: (text) => {
      void client.request("chat.send", { sessionKey, text, isMainSession: true, key: crypto.randomUUID() });
    },
    onAbort: () => void client.request("chat.abort", { sessionKey }),
    onCommand: async (name, args) => {
      if (name === "help") return tuiHelp;
      if (name === "session" && args) {
        sessionKey = args.trim();
        return `session: ${sessionKey}`;
      }
      if (name === "new") {
        sessionKey = `main:${Date.now().toString(36)}`;
        void app?.loadHistory();
        return `new session: ${sessionKey}`;
      }
      if (name === "quit" || name === "exit") {
        app?.quit();
        return "";
      }
      // Unified surface (Partial #10): forward every other command to the
      // gateway — it runs the shared router and the reply arrives over the
      // chat envelope as a normal final event.
      void client.request("chat.send", {
        sessionKey,
        text: `/${name}${args ? ` ${args}` : ""}`,
        isMainSession: true,
        key: crypto.randomUUID(),
      });
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
    repos: async () => {
      try {
        const res = (await client.request("github.repos", { page: 1 })) as { repos?: { fullName: string; private: boolean; defaultBranch: string }[] };
        return (res.repos ?? []).map((r) => `${r.fullName}  ${r.private ? "private" : "public"} · ${r.defaultBranch}`);
      } catch (err) {
        return [];
      }
    },
    branches: async (repo) => {
      try {
        const res = (await client.request("github.branches", { repo })) as { branches?: { name: string; default?: boolean; protected?: boolean }[] };
        return (res.branches ?? []).map((b) => `${b.default ? "●" : " "} ${b.name}${b.protected ? "  (protected)" : ""}`);
      } catch {
        return [];
      }
    },
    newSession: (spec) => {
      sessionKey = `main:${Date.now().toString(36)}`;
      if (spec.kind === "code" && spec.repo) {
        void client
          .request("repo.bind", { sessionKey, repo: spec.repo, ...(spec.branch ? { branch: spec.branch } : {}) })
          .then((res) => {
            const bound = res as { repo?: string; branch?: string; base?: string };
            if (bound.repo) repoBindings.set(sessionKey, { repo: bound.repo, branch: bound.branch ?? "?" });
            app?.push({ kind: "system", text: `working in ${bound.repo ?? spec.repo} · ${bound.branch ?? "?"}` });
          })
          .catch((err: Error) => app?.push({ kind: "system", text: err.message }));
      }
      if (app) app.items = [];
      void app?.loadHistory();
    },
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

