// SuparClaw Control UI — app shell: rail, drawer, sheet, routing, wiring.

import { Chat } from "./chat.js";
import { el, esc, fmtTime, modal, toast } from "./dom.js";
import { pickModel } from "./picker.js";
import { gateway, type ConnState } from "./rpc.js";
import { Settings } from "./settings.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let sessionKey = localStorage.getItem("sc.session") || "main:main";
let currentModel = "";
let busy = false;
let models: { value: string; label: string; group: string }[] = [];
let toolCount = 0;
let settings: Settings | null = null;

/* ---------------- chat ---------------- */

const chat = new Chat(document.body, {
  send: (text) => {
    chat.user(text);
    busy = true;
    chat.setBusy(true);
    gateway.request("chat.send", { sessionKey, text, isMainSession: true }).catch((err) => {
      busy = false;
      chat.setBusy(false);
      chat.notice(`not sent: ${err.message}`);
      toast((err as Error).message, "err");
    });
  },
  abort: () => { void gateway.request("chat.abort", { sessionKey }); },
  approve: (callId, approve) => { void gateway.request("chat.approval", { callId, approve }); },
});

/* ---------------- events ---------------- */

gateway.on((event, payload) => {
  if (event === "tick") return;
  if (event === "chat") {
    const p = payload ?? {};
    if (p.sessionKey && p.sessionKey !== sessionKey) return;
    handleChatEvent(p.event ?? {});
    return;
  }
  // One stream only. The gateway used to also emit per-event chat.delta /
  // chat.reply / chat.tool frames; applying both copies doubled the streaming
  // text and rendered every reply twice. Those frames are gone server-side.
});

const finalizedRuns = new Set<string>();

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
    case "reasoning":
      chat.reasoningDelta(String(e.text ?? ""));
      break;
    case "tool":
      chat.tool(
        String(e.name ?? "tool"),
        (e.status as "running" | "done" | "error") ?? "running",
        e.detail as string | undefined,
        e.ms as number | undefined,
        e.callId as string | undefined,
      );
      break;
    case "approval":
      chat.approval(String(e.callId), String(e.tool), e.args);
      break;
    case "final": {
      // A final for an already-rendered run must never append a second copy
      // (late replay after history reload — the OpenClaw #167052 class).
      const runId = String(e.runId ?? crypto.randomUUID());
      if (finalizedRuns.has(runId)) return;
      finalizedRuns.add(runId);
      if (finalizedRuns.size > 32) {
        finalizedRuns.delete(finalizedRuns.values().next().value as string);
      }
      const usage = e.usage as Record<string, number> | undefined;
      if (usage?.["total_tokens"]) chat.setTokenHint(`${usage["total_tokens"]} tokens`);
      chat.finish(String(e.text ?? ""));
      busy = false;
      break;
    }
    case "error":
      chat.fail(String(e.message ?? "error"));
      busy = false;
      chat.setBusy(false);
      toast(String(e.message ?? "error"), "err");
      break;
    case "idle":
      busy = false;
      chat.setBusy(false);
      break;
  }
}

/* ---------------- connection ---------------- */

const connDot = $("conn-dot");
const connLabel = $("conn-label");

gateway.onState = (state: ConnState) => {
  const label =
    state === "online" ? "Online" :
    state === "connecting" ? "Connecting…" :
    state === "unauthorized" ? "Unauthorized" : "Offline";
  connLabel.textContent = label;
  connDot.className = "dot" + (
    state === "online" ? " dot--ok" :
    state === "connecting" ? " dot--warn" :
    state === "unauthorized" ? " dot--err" : " dot--err");
  if (state === "online") {
    void refresh();
    void loadHistory();
  }
  // the settings page needs live data — re-render it whenever the connection
  // state changes so it shows the waiting/offline state instead of stale cards
  if (settings && !$("settings-view").hidden) void settings.render();
  if (state === "unauthorized") askToken();
};

function askToken(): void {
  modal({
    title: "Authentication required",
    body: "The gateway rejected the connection (code 4401). Enter a valid auth token.",
    fields: [{ name: "token", label: "Auth token", type: "password", placeholder: "paste token" }],
    confirmLabel: "Connect",
    cancelLabel: "Later",
    onConfirm: (v) => {
      if (!v.token) { toast("Enter a token first", "err"); return; }
      gateway.setToken(v.token);
      gateway.connect();
      toast("Token saved. Reconnecting…", "info");
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
    toolCount = (status.tools ?? []).length;
    // Strict filter: only models selected in Settings → Models appear
    // anywhere in the system. Nothing selected = empty picker with a hint.
    const configured = (((modelRes as any).configured ?? []) as any[]).filter((m) => m.enabled);
    models = configured.map((m) => ({
      value: String(m.id),
      label: String(m.label || m.ref || m.id),
      group: String(m.ref ?? "").split("/")[0] || "default",
    }));
    currentModel = status.model || models[0]?.value || "";
    $("model-name").textContent = models.find((m) => m.value === currentModel)?.label || currentModel || "no model";
    renderSessions((sessionRes as any).sessions ?? []);
    syncThinking(status, (sessionRes as any).sessions ?? []);
  } catch { /* gateway reconnecting */ }
}

/* ---------------- thinking level + preview ---------------- */

function syncThinking(status: any, sessions: { key: string; thinking?: string | null }[]): void {
  const select = $("think") as HTMLSelectElement;
  const levels: string[] =
    status?.thinkingLevels ?? ["inherit", "off", "low", "medium", "high", "xhigh", "max"];
  const current = select.querySelectorAll("option");
  if (current.length !== levels.length) {
    select.innerHTML = "";
    for (const level of levels) {
      const opt = document.createElement("option");
      opt.value = level;
      opt.textContent = level === "inherit" ? "auto" : level;
      select.append(opt);
    }
  }
  // Explicit session override, or "auto" when inheriting — selecting a level
  // patches the session immediately (survives refresh); the choice applies to
  // later turns and never interrupts one in flight.
  const row = (sessions ?? []).find((s) => s.key === sessionKey);
  const desired = row?.thinking ?? "inherit";
  // Attribute first (works in every DOM), then the value setter where it
  // exists — a throwing setter must never skip the selection.
  for (const opt of Array.from(select.querySelectorAll("option"))) {
    if (opt.getAttribute("value") === desired) opt.setAttribute("selected", "");
    else opt.removeAttribute("selected");
  }
  try {
    select.value = desired;
  } catch { /* getter-only DOM */ }
}

$("think").addEventListener("change", async () => {
  const select = $("think") as HTMLSelectElement;
  const value = select.value === "inherit" ? null : select.value;
  try {
    await gateway.request("sessions.patch", { sessionKey, thinking: value });
    toast(value ? `thinking: ${value}` : "thinking: inherited", "ok");
  } catch (err) {
    toast((err as Error).message, "err");
  }
});



/* ---------------- sessions drawer ---------------- */

function renderSessions(list: { key: string; last_msg_at?: number; title?: string }[]): void {
  const host = $("sessions");
  host.innerHTML = "";
  if (list.length === 0) list = [{ key: sessionKey }];
  const seen = new Set<string>();
  for (const s of list) {
    if (seen.has(s.key)) continue;
    seen.add(s.key);
    const btn = el("button", {
      class: `session${s.key === sessionKey ? " is-active" : ""}`,
      type: "button",
    }, [
      el("span", { class: "session__text" }, [
        el("span", { class: "session__title" }, [s.title || s.key]),
        el("span", { class: "session__meta" }, [
          s.last_msg_at ? fmtTime(s.last_msg_at) : "no messages",
        ]),
      ]),
      busy && s.key === sessionKey ? el("span", { class: "dot dot--live" }) : null,
    ].filter(Boolean) as Node[]);
    btn.onclick = () => void switchSession(s.key);
    btn.oncontextmenu = (e) => { e.preventDefault(); renameSession(s.key); };
    host.append(btn);
  }
}

async function switchSession(key: string): Promise<void> {
  if (key === sessionKey) return;
  sessionKey = key;
  localStorage.setItem("sc.session", key);
  $("session-title").textContent = key;
  closeDrawer();
  await loadHistory();
  void refresh();
}

async function loadHistory(): Promise<void> {
  // Fetch first, replace after: a failed request must never wipe the visible
  // transcript (clear-before-fetch silently blanked the chat whenever the
  // gateway was briefly unreachable). One retry for a gateway that is still
  // settling after a reconnect.
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await gateway.request("chat.history", { sessionKey, limit: 60 });
      const messages = (res as any).messages ?? [];
      const rendered = chat.replaceThread(
        messages.map((m: any) => ({ role: String(m.role ?? ""), content: String(m.content ?? "") })),
      );
      if (rendered === 0) {
        chat.notice(`Session started · ${statusTools()} tools enabled`);
      }
      return;
    } catch (err) {
      lastError = err as Error;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
    }
  }
  chat.notice(`could not load history: ${lastError?.message ?? "gateway unavailable"}`);
}

function statusTools(): number {
  return toolCount;
}

function renameSession(key: string): void {
  modal({
    title: "Rename session",
    fields: [{ name: "name", label: "Session name", value: key.includes(":") ? key.split(":").slice(1).join(":") : key }],
    confirmLabel: "Rename",
    onConfirm: async (v) => {
      if (!v.name) return;
      const prefix = key.includes(":") ? key.split(":")[0] : "main";
      const next = `${prefix}:${v.name}`;
      try {
        await gateway.request("sessions.rename", { sessionKey: key, newKey: next });
        if (key === sessionKey) { sessionKey = next; localStorage.setItem("sc.session", next); $("session-title").textContent = next; }
        toast("session renamed", "ok");
        void refresh();
      } catch (err) { toast((err as Error).message, "err"); }
    },
  });
}

function newSession(): void {
  modal({
    title: "New session",
    fields: [{ name: "name", label: "Session name", placeholder: "fix-bug" }],
    confirmLabel: "Create",
    onConfirm: async (v) => {
      const name = (v.name || `s${Date.now().toString(36)}`).replace(/\s+/g, "-");
      const key = `main:${name}`;
      await switchSession(key); // loadHistory creates the row server-side
      chat.notice(`session ${key}`);
    },
  });
}

/* ---------------- drawer ---------------- */

const drawerOverlay = $("drawer-overlay");

function openDrawer(): void {
  drawerOverlay.hidden = false;
  $("drawer-btn").classList.add("is-on");
  $("drawer-btn").setAttribute("aria-expanded", "true");
}

function closeDrawer(): void {
  drawerOverlay.hidden = true;
  $("drawer-btn").classList.remove("is-on");
  $("drawer-btn").setAttribute("aria-expanded", "false");
}

$("drawer-btn").onclick = () => {
  if (drawerOverlay.hidden) openDrawer(); else closeDrawer();
};
$("drawer-close").onclick = closeDrawer;
$("drawer-scrim").onclick = closeDrawer;
$("new-session").onclick = newSession;

/* ---------------- model sheet ---------------- */

$("model-btn").onclick = () => {
  pickModel({
    current: currentModel,
    models,
    onPick: async (value) => {
      const label = models.find((m) => m.value === value)?.label || value;
      $("model-name").textContent = label;
      try {
        await gateway.request("config.set", { path: "agents.defaults.model", value });
        currentModel = value;
        toast(`model → ${label}`, "ok");
        void refresh();
      } catch (err) {
        toast((err as Error).message, "err");
      }
    },
  });
};

/* ---------------- chrome ---------------- */

$("theme-btn").onclick = () => {
  const root = document.documentElement;
  const dark = root.dataset.themeMode === "dark";
  root.dataset.themeMode = dark ? "light" : "dark";
  localStorage.setItem("sc.theme", root.dataset.themeMode);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", dark ? "#F4F3EF" : "#0E0E11");
};

$("settings-btn").onclick = () => {
  location.hash = location.hash === "#/settings" ? "" : "#/settings";
};
$("settings-back").onclick = () => { location.hash = ""; };
$("session-btn").onclick = () => { void loadHistory(); };

/* ---------------- routing ---------------- */

function route(): void {
  const settingsOpen = location.hash === "#/settings";
  $("chat-view").hidden = settingsOpen;
  $("settings-view").hidden = !settingsOpen;
  $("settings-btn").classList.toggle("is-on", settingsOpen);
  if (settingsOpen) {
    settings = new Settings($("settings-body"), () => { void refresh(); });
    void settings.render();
    closeDrawer();
  }
}
window.addEventListener("hashchange", route);

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "l") {
    e.preventDefault();
    $("model-btn").click();
  }
  if (e.key === "Escape" && busy) void gateway.request("chat.abort", { sessionKey });
});

/* ---------------- boot ---------------- */

const savedTheme = localStorage.getItem("sc.theme");
if (savedTheme) document.documentElement.dataset.themeMode = savedTheme;
$("session-title").textContent = sessionKey;
route();
gateway.connect();
void refresh();
