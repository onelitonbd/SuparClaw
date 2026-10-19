// SuparClaw Control UI — app shell: rail, sidebar, routing, event wiring.

import { Chat } from "./chat.js";
import { el, esc, fmtTime, modal, toast } from "./dom.js";
import { pickModel } from "./picker.js";
import { gateway, type ConnState } from "./rpc.js";
import { Settings } from "./settings.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let sessionKey = localStorage.getItem("sc.session") || "main:main";
let currentModel = "";
let busy = false;
let models: string[] = [];

/* ---------------- chat ---------------- */

const chat = new Chat(document.body, {
  send: (text) => {
    chat.user(text);
    busy = true;
    chat.setBusy(true);
    gateway.request("chat.send", { sessionKey, text, isMainSession: true }).catch((err) => {
      busy = false;
      chat.setBusy(false);
      chat.system(`not sent: ${err.message}`, "error");
    });
  },
  abort: () => { void gateway.request("chat.abort", { sessionKey }); },
  approve: (callId, approve) => { void gateway.request("chat.approval", { callId, approve }); },
});

/* ---------------- events ---------------- */

gateway.on((event, payload) => {
  if (event === "tick") { void health(); return; }
  if (event === "chat") {
    const p = payload ?? {};
    if (p.sessionKey && p.sessionKey !== sessionKey) return;
    handleChatEvent(p.event ?? {});
    return;
  }
  // individual frames from older gateways
  if (event === "chat.delta") { chat.assistantStart(); chat.delta(String(payload?.delta ?? "")); }
  if (event === "chat.reply") { chat.finish(String(payload?.text ?? "")); }
  if (event === "chat.tool") {
    const t = payload?.event ?? {};
    chat.tool(String(t.name ?? "tool"), t.status ?? "running", t.detail);
  }
});

function handleChatEvent(e: { type: string; [k: string]: unknown }): void {
  switch (e.type) {
    case "start":
      busy = true;
      chat.setBusy(true);
      chat.assistantStart();
      break;
    case "delta":
      chat.delta(String(e.text ?? ""));
      break;
    case "tool":
      chat.tool(String(e.name ?? "tool"), (e.status as "running" | "done" | "error") ?? "running", e.detail as string | undefined);
      break;
    case "approval":
      chat.approval(String(e.callId), String(e.tool), e.args);
      break;
    case "final": {
      const usage = e.usage as Record<string, number> | undefined;
      if (usage?.["total_tokens"]) chat.setTokenHint(`${usage["total_tokens"]} tokens last run`);
      chat.finish(String(e.text ?? ""));
      busy = false;
      break;
    }
    case "error":
      chat.finish();
      chat.system(`error: ${e.message}`, "error");
      busy = false;
      chat.setBusy(false);
      break;
    case "idle":
      busy = false;
      chat.setBusy(false);
      break;
  }
}

/* ---------------- connection ---------------- */

const connPill = $("conn-pill");
const brandDot = $("brand-dot");

gateway.onState = (state: ConnState) => {
  connPill.textContent =
    state === "online" ? "connected" : state === "connecting" ? "connecting…" :
    state === "unauthorized" ? "unauthorized" : "disconnected";
  connPill.className = "pill state-pill " + (state === "online" ? "online" : state === "connecting" ? "" : "offline");
  if (state === "online") { void refresh(); void loadHistory(); }
  if (state === "unauthorized") askToken();
};

function askToken(): void {
  modal({
    title: "Gateway token",
    body: "This gateway requires a token. Run `sc token` on the device and paste it here.",
    fields: [{ name: "token", label: "token", placeholder: "paste token" }],
    confirmLabel: "Connect",
    cancelLabel: "Later",
    onConfirm: (v) => {
      if (!v.token) return;
      gateway.setToken(v.token);
      gateway.connect();
    },
  });
}

/* ---------------- refresh ---------------- */

async function refresh(): Promise<void> {
  try {
    const [statusRes, modelRes, sessionRes] = await Promise.all([
      gateway.request("status"),
      gateway.request("models.list"),
      gateway.request("sessions.list", { limit: 30 }),
    ]);
    const status = statusRes as any;
    models = (modelRes as any).models ?? [];
    currentModel = status.model || models[0] || "";
    $("model-pill").textContent = currentModel || "choose model…";
    renderSessions((sessionRes as any).sessions ?? []);
    renderStats(status);
  } catch { /* gateway reconnecting */ }
}

async function health(): Promise<void> {
  try {
    const h = await fetch("/health").then((r) => r.json());
    $("tok").textContent = `${h.sessions} session${h.sessions === 1 ? "" : "s"} · up ${Math.round(h.uptimeMs / 1000)}s`;
  } catch { /* ignore */ }
}

function renderSessions(list: { key: string; last_msg_at?: number; title?: string }[]): void {
  const host = $("sessions");
  host.innerHTML = "";
  if (list.length === 0) list = [{ key: sessionKey }];
  const seen = new Set<string>();
  for (const s of list) {
    if (seen.has(s.key)) continue;
    seen.add(s.key);
    const btn = el("button", { class: `session${s.key === sessionKey ? " active" : ""}` }, [
      el("span", { class: "key" }, [s.key]),
      el("span", { class: "meta" }, [s.last_msg_at ? fmtTime(s.last_msg_at) : "no messages"]),
    ]);
    btn.onclick = () => switchSession(s.key);
    btn.oncontextmenu = (e) => { e.preventDefault(); renameSession(s.key); };
    host.append(btn);
  }
}

function renderStats(status: any): void {
  $("stats").innerHTML =
    `<div>model <b>${esc(currentModel || "unset")}</b></div>` +
    `<div>tools <b>${status.tools?.length ?? 0}</b> · skills <b>${status.skills?.length ?? 0}</b></div>` +
    `<div>telegram <b>${status.telegram?.enabled ? "on" : "off"}</b> · cron <b>${status.cron?.enabled ? `${status.cron.jobs} jobs` : "off"}</b></div>`;
}

async function switchSession(key: string): Promise<void> {
  if (key === sessionKey) return;
  sessionKey = key;
  localStorage.setItem("sc.session", key);
  $("session-pill").textContent = key;
  closeDrawer();
  await loadHistory();
  void refresh();
}

async function loadHistory(): Promise<void> {
  chat.clear();
  try {
    const res = await gateway.request("chat.history", { sessionKey, limit: 60 });
    for (const m of (res as any).messages ?? []) {
      if (m.role === "user") chat.user(String(m.content ?? ""));
      else if (m.role === "assistant" && m.content) chat.assistant(String(m.content));
    }
    $("session-pill").textContent = sessionKey;
  } catch { /* ignore */ }
}

function renameSession(key: string): void {
  modal({
    title: "Rename session",
    fields: [{ name: "name", label: "session name", value: key.includes(":") ? key.split(":").slice(1).join(":") : key }],
    confirmLabel: "Rename",
    onConfirm: async (v) => {
      if (!v.name) return;
      const prefix = key.includes(":") ? key.split(":")[0] : "main";
      const next = `${prefix}:${v.name}`;
      try {
        await gateway.request("sessions.rename", { sessionKey: key, newKey: next });
        if (key === sessionKey) { sessionKey = next; localStorage.setItem("sc.session", next); }
        toast("session renamed");
        void refresh();
      } catch (err) { toast((err as Error).message, "error"); }
    },
  });
}

function newSession(): void {
  modal({
    title: "New session",
    fields: [{ name: "name", label: "name", placeholder: "fix-bug" }],
    confirmLabel: "Create",
    onConfirm: async (v) => {
      const name = (v.name || `s${Date.now().toString(36)}`).replace(/\s+/g, "-");
      const key = `main:${name}`;
      try {
        await gateway.request("sessions.rename", { sessionKey: key, newKey: key }); // ensure row exists
      } catch { /* ignore */ }
      await switchSession(key);
      chat.system(`session ${key}`);
    },
  });
}

/* ---------------- rail + routing ---------------- */

$("model-pill").onclick = () => {
  pickModel({
    current: currentModel,
    models,
    onPick: async (ref) => {
      $("model-pill").textContent = ref;
      try {
        await gateway.request("config.set", { path: "agents.defaults.model", value: ref });
        currentModel = ref;
        toast(`model → ${ref}`);
        void refresh();
      } catch (err) {
        toast((err as Error).message, "error");
      }
    },
  });
};

$("theme-btn").onclick = () => {
  const root = document.documentElement;
  const light = root.dataset.themeMode === "light";
  root.dataset.themeMode = light ? "dark" : "light";
  localStorage.setItem("sc.theme", root.dataset.themeMode);
};

$("settings-btn").onclick = () => { location.hash = location.hash === "#/settings" ? "" : "#/settings"; };
$("new-session").onclick = newSession;
$("drawer-btn").onclick = () => $("sidebar").classList.toggle("open");

function closeDrawer(): void {
  $("sidebar").classList.remove("open");
}

function route(): void {
  const settings = location.hash === "#/settings";
  $("chat-view").hidden = settings;
  $("settings-view").hidden = !settings;
  if (settings) {
    new Settings($("settings-view"), () => { void refresh(); }).render();
  }
}
window.addEventListener("hashchange", route);

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "l") {
    e.preventDefault();
    $("model-pill").click();
  }
  if (e.key === "Escape" && busy) void gateway.request("chat.abort", { sessionKey });
});

/* ---------------- boot ---------------- */

if (localStorage.getItem("sc.theme")) document.documentElement.dataset.themeMode = localStorage.getItem("sc.theme")!;
$("session-pill").textContent = sessionKey;
$("session-pill").title = `session ${sessionKey} — right-click a session to rename`;
$("session-pill").onclick = () => { void loadHistory(); };
brandDot.classList.add("busy");
route();
gateway.connect();
void health();
