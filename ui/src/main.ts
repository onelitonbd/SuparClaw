// SuparClaw Control UI — app shell: rail, drawer, sheet, routing, wiring.

import { Chat } from "./chat.js";
import { el, esc, fmtTime, modal, toast } from "./dom.js";
import { pickModel } from "./picker.js";
import { gateway, type ConnState } from "./rpc.js";
import { Settings } from "./settings.js";
import { onGatewayEvent } from "./notifications.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let sessionKey = localStorage.getItem("sc.session") || "main:main";
let currentModel = "";
let busy = false;
let models: { value: string; label: string; group: string }[] = [];
let toolCount = 0;
let settings: Settings | null = null;

/* ---------------- chat ---------------- */

const chat = new Chat(document.body, {
  send: (text, attachments) => {
    chat.user(text, attachments);
    busy = true;
    chat.setBusy(true);
    const payload: Record<string, unknown> = { sessionKey, text, isMainSession: true };
    if (attachments && attachments.length > 0) {
      payload["attachments"] = attachments.map((a) => ({ name: a.name, mime: a.mime, data: a.dataUrl }));
    }
    gateway.request("chat.send", payload)
      .then((ack) => {
        // Partial attachment rejections ride the ack as warnings (their
        // "failures stay visible" rule) — toast them, the rest was sent.
        const warnings = (ack as { warnings?: string[] }).warnings ?? [];
        for (const w of warnings) toast(`skipped: ${w}`, "err");
      })
      .catch((err) => {
        busy = false;
        chat.setBusy(false);
        chat.notice(`not sent: ${err.message}`);
        toast((err as Error).message, "err");
      });
  },
  abort: () => { void gateway.request("chat.abort", { sessionKey }); },
  approve: (callId, decision) => { void gateway.request("chat.approval", { callId, decision }); },
  // Remove just that queued message (their chat.abort runId parity).
  cancelQueued: (runId) => { void gateway.request("chat.abort", { sessionKey, runId }); },
  // ask_user card answers (P2 #8) ride their own RPC (session-scoped).
  questionAnswer: (_id, answers) => { void gateway.request("chat.questionAnswer", { sessionKey, answers }); },
});

/* ---------------- events ---------------- */

gateway.on((event, payload) => {
  if (event === "tick") return;
  // Settings → Alerts (their Settings → Notifications): approvals default-on,
  // replies opt-in, quiet-hours filtered, generic lock-screen text only.
  try { onGatewayEvent(event, payload); } catch { /* notification quirks are non-fatal */ }
  if (event === "session.updated") {
    // Auto-title landed on a session row — re-render the list so the name
    // shows up (in any open UI) without a reload.
    void refresh();
    return;
  }
  if (event === "approvals.updated") {
    // An allow-always grant was minted or a policy entry changed — an open
    // Tools tab re-reads the ledger live.
    if (settings && !$("settings-view").hidden) void settings.render();
    return;
  }
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
        (e.status as "running" | "done" | "error" | "pending" | "skipped") ?? "running",
        e.detail as string | undefined,
        e.ms as number | undefined,
        e.callId as string | undefined,
      );
      break;
    case "queued":
      // Waiting input keeps its identity — the ✕ row cancels just that one.
      chat.queued(String(e.runId ?? crypto.randomUUID()), String(e.text ?? ""));
      if (String(e.mode ?? "") === "steer") chat.notice("steering into the active turn…");
      break;
    case "dequeued":
      chat.dequeued(String(e.runId ?? ""), String(e.reason ?? ""));
      break;
    case "steered":
      chat.dequeued(String(e.runId ?? ""));
      break;
    case "collect": {
      for (const rid of (e.runIds as string[] | undefined) ?? []) chat.dequeued(rid);
      break;
    }
    case "retry": {
      // Always visible (no collapse): show what failed and that a retry is
      // running - "error ... retrying (attempt N/7)".
      const error = String(e.error ?? "provider error");
      const attempt = Number(e.attempt ?? 1);
      const max = Number(e.max ?? 7);
      chat.notice(`error: ${error} — retrying (attempt ${attempt}/${max})...`, "notice--error");
      break;
    }
    case "approval": {
      const exec = e.exec && typeof e.exec === "object"
        ? (e.exec as { mode: string; mintable: boolean; reason: string })
        : undefined;
      chat.approval(String(e.callId), String(e.tool), e.args, exec);
      break;
    }
    case "question": {
      chat.question(String(e.id), (e.questions as { id: string; question: string; options: string[]; multi: boolean }[]) ?? []);
      break;
    }
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
      gateway.request("sessions.list", { limit: 30, includeArchived: true }),
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
    syncQueue((sessionRes as any).sessions ?? []);
    void refreshQueueDepth();
    // Archived current session: read-only transcript + Unarchive banner
    // (their composer-disabled contract).
    const curRow = ((sessionRes as any).sessions ?? []).find((r: SessionListRow) => r.key === sessionKey);
    chat.setArchived(Number(curRow?.archived ?? 0) === 1, () => void setSessionArchived(sessionKey, false));
  } catch { /* gateway reconnecting */ }
}

// Drawer prune action (P4 #33): dry-run first, confirm with the real counts,
// then enforce — their two-step destructive-action pattern.
$("sessions-prune").addEventListener("click", async () => {
  try {
    const report = (await gateway.request("sessions.cleanup", { dryRun: true })) as any;
    const total = Number(report.archivedAge ?? 0) + Number(report.archivedCap ?? 0) + Number(report.deletedCapArchives ?? 0);
    if (total === 0) { toast("nothing to prune", "info"); return; }
    const ok = window.confirm(
      `Retention policy would archive ${report.archivedAge + report.archivedCap} session(s) and delete ${report.deletedCapArchives} archived session(s). Apply now?`,
    );
    if (!ok) return;
    const done = (await gateway.request("sessions.cleanup", { enforce: true })) as any;
    toast(`pruned: ${done.archivedAge + done.archivedCap} archived, ${done.deletedCapArchives} deleted`, "ok");
    await refresh();
  } catch (err) {
    toast(`prune failed: ${(err as Error).message}`, "err");
  }
});

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

/* ---------------- per-session queue mode (P4 #37 — their /queue) ----------- */

/** Mirror of syncThinking: the header select reflects the session's durable
 *  queue override (config default shown as "queue" when no override). */
function syncQueue(sessions: { key: string; queue_mode?: string | null }[]): void {
  const select = $("queue-select") as HTMLSelectElement;
  const row = (sessions ?? []).find((s) => s.key === sessionKey);
  const desired = row?.queue_mode ?? "inherit";
  for (const opt of Array.from(select.querySelectorAll("option"))) {
    if (opt.getAttribute("value") === desired) opt.setAttribute("selected", "");
    else opt.removeAttribute("selected");
  }
  try {
    select.value = desired;
  } catch { /* getter-only DOM */ }
}

$("queue-select").addEventListener("change", async () => {
  const select = $("queue-select") as HTMLSelectElement;
  const value = select.value;
  if (value && !["inherit", "steer", "followup", "collect", "interrupt"].includes(value)) {
    select.value = "inherit";
    return;
  }
  try {
    if (value === "inherit") {
      await gateway.request("queue.set", { sessionKey, reset: true });
      toast("queue mode: config default", "ok");
    } else {
      await gateway.request("queue.set", { sessionKey, mode: value });
      toast(`queue mode: ${value}`, "ok");
    }
    void refresh();
  } catch (err) {
    toast((err as Error).message, "err");
  }
});

/** Queued-input depth from queue.status (their queued-count chip). */
async function refreshQueueDepth(): Promise<void> {
  const chip = $("queue-depth");
  try {
    const status = (await gateway.request("queue.status", { sessionKey })) as {
      mode?: string; queued?: unknown[]; queuedCount?: number; steering?: number;
    };
    const n = typeof status.queuedCount === "number" ? status.queuedCount : Array.isArray(status.queued) ? status.queued.length : 0;
    chip.hidden = n === 0;
    chip.textContent = n > 0 ? String(n) : "";
    chip.title = n > 0 ? `${n} input(s) queued for this session` : "";
  } catch {
    chip.hidden = true;
  }
}



/* ---------------- sessions drawer ---------------- */

// Cache of the plain drawer list so session search can restore it (Esc /
// clear) without another round trip.
interface SessionListRow { key: string; last_msg_at?: number; title?: string; name?: string | null; archived?: number; }
let lastSessionList: SessionListRow[] = [];

/** Session row menu (P4 #33 — their session menu): rename, export, archive,
 *  delete. One floating menu, closed by Esc / outside click / action. */
let sessionMenu: HTMLElement | null = null;
function closeSessionMenu(): void {
  sessionMenu?.remove();
  sessionMenu = null;
  document.removeEventListener("click", closeSessionMenuOnOutside, true);
}
function closeSessionMenuOnOutside(e: Event): void {
  if (sessionMenu && !sessionMenu.contains(e.target as Node)) closeSessionMenu();
}

function openSessionMenu(row: SessionListRow, x: number, y: number): void {
  closeSessionMenu();
  const archived = Number(row.archived ?? 0) === 1;
  const item = (label: string, fn: () => void | Promise<void>, danger = false) => {
    const b = el("button", { class: `menu__item${danger ? " menu__item--danger" : ""}`, type: "button" }, [label]);
    b.onclick = async () => { closeSessionMenu(); await fn(); };
    return b;
  };
  const menu = el("div", { class: "menu", id: "session-menu", role: "menu" });
  menu.style.left = `${Math.min(x, window.innerWidth - 190)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 190)}px`;
  menu.append(
    item("Rename…", () => renameSession(row.key)),
    item("Export transcript (.md)", () => exportSession(row.key)),
    item(archived ? "Unarchive" : "Archive", () => setSessionArchived(row.key, !archived)),
    item("Delete…", () => deleteSession(row.key), true),
  );
  document.body.append(menu);
  sessionMenu = menu;
  setTimeout(() => document.addEventListener("click", closeSessionMenuOnOutside, true), 0);
  document.addEventListener("keydown", function esc(e) {
    if (e.key === "Escape") { closeSessionMenu(); document.removeEventListener("keydown", esc); }
  });
}

async function exportSession(key: string): Promise<void> {
  try {
    const res = (await gateway.request("sessions.export", { sessionKey: key })) as {
      filename: string; content: string; dir: string; messageCount: number;
    };
    const blob = new Blob([res.content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: res.filename }) as HTMLAnchorElement;
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast(`exported ${res.messageCount} message(s) — also saved under ${res.dir}`, "ok");
  } catch (err) {
    toast(`export failed: ${(err as Error).message}`, "err");
  }
}

async function setSessionArchived(key: string, archived: boolean): Promise<void> {
  try {
    await gateway.request("sessions.patch", { sessionKey: key, archived });
    toast(archived ? "session archived" : "session unarchived", "ok");
    await refresh();
  } catch (err) {
    toast((err as Error).message, "err");
  }
}

async function deleteSession(key: string): Promise<void> {
  if (!window.confirm(`Delete session "${key}" and all its messages? This cannot be undone.`)) return;
  try {
    const res = (await gateway.request("sessions.delete", { sessionKey: key })) as { deleted: boolean; messages: number };
    toast(res.deleted ? `deleted session + ${res.messages} message(s)` : "session not found", res.deleted ? "ok" : "err");
    if (key === sessionKey) {
      sessionKey = "main:main";
      localStorage.setItem("sc.session", sessionKey);
      $("session-title").textContent = sessionKey;
      await loadHistory();
    }
    await refresh();
  } catch (err) {
    toast((err as Error).message, "err");
  }
}

function renderSessions(list: SessionListRow[]): void {
  lastSessionList = list;
  closeSessionMenu();
  const host = $("sessions");
  host.innerHTML = "";
  if (list.length === 0) list = [{ key: sessionKey }];
  const seen = new Set<string>();
  // Archived rows sink to a dimmed group (their archived-group parity).
  const ordered = [
    ...list.filter((s) => Number(s.archived ?? 0) !== 1),
    ...list.filter((s) => Number(s.archived ?? 0) === 1),
  ];
  let archivedHeaderShown = false;
  for (const s of ordered) {
    if (seen.has(s.key)) continue;
    seen.add(s.key);
    const archived = Number(s.archived ?? 0) === 1;
    if (archived && !archivedHeaderShown) {
      archivedHeaderShown = true;
      host.append(el("div", { class: "sessions__group" }, ["Archived"]));
    }
    const kebab = el("button", { class: "session__kebab", type: "button", "aria-label": `Menu for ${s.key}` }, ["⋯"]);
    kebab.onclick = (e) => { e.stopPropagation(); openSessionMenu(s, (e as MouseEvent).clientX, (e as MouseEvent).clientY); };
    const btn = el("button", {
      class: `session${s.key === sessionKey ? " is-active" : ""}${archived ? " session--archived" : ""}`,
      type: "button",
    }, [
      el("span", { class: "session__text" }, [
        el("span", { class: "session__title" }, [s.name || s.title || s.key]),
        el("span", { class: "session__meta" }, [
          archived ? "archived" : s.last_msg_at ? fmtTime(s.last_msg_at) : "no messages",
        ]),
      ]),
      busy && s.key === sessionKey ? el("span", { class: "dot dot--live" }) : null,
      kebab,
    ].filter(Boolean) as Node[]);
    btn.onclick = () => void switchSession(s.key);
    btn.oncontextmenu = (e) => { e.preventDefault(); openSessionMenu(s, e.clientX, e.clientY); };
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

async function loadHistory(anchorMid?: number): Promise<void> {
  // Fetch first, replace after: a failed request must never wipe the visible
  // transcript (clear-before-fetch silently blanked the chat whenever the
  // gateway was briefly unreachable). One retry for a gateway that is still
  // settling after a reconnect.
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await gateway.request("chat.history", {
        sessionKey,
        limit: anchorMid ? 40 : 60,
        ...(anchorMid ? { messageId: anchorMid } : {}),
      });
      const messages = (res as any).messages ?? [];
      const rendered = chat.replaceThread(
        messages.map((m: any) => ({
          id: typeof m.id === "number" ? m.id : undefined,
          role: String(m.role ?? ""),
          content: String(m.content ?? ""),
        })),
      );
      if (anchorMid !== undefined) {
        // Reopen parity: land on the search hit's own row with a brief pulse.
        const node = chat.anchorMap.get(anchorMid);
        if (node) {
          node.scrollIntoView({ block: "center" });
          node.classList.add("msg--anchor");
          setTimeout(() => node.classList.remove("msg--anchor"), 2400);
        }
      }
      if (rendered === 0) {
        chat.notice(`Session started · ${statusTools()} tools enabled`);
      }
      // Waiting inputs survive reconnects (they stay queued until consumed).
      try {
        const q = await gateway.request("queue.status", { sessionKey });
        chat.queueReplace(((q as any).queued ?? []) as { runId: string; text: string; at: number }[]);
      } catch { /* older gateway: no queue surface yet */ }
      return;
    } catch (err) {
      lastError = err as Error;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
    }
  }
  chat.notice(`could not load history: ${lastError?.message ?? "gateway unavailable"}`);
}

/* ---------------- session search (Partial #3) ---------------- */

// Live search inside the sessions drawer (their palette/Threads parity in our
// list shape): Sessions group = title/identifier matches, Messages group =
// exact-word transcript hits (last word stays a prefix). Server-side search —
// the drawer never downloads a roster to search.
let searchSeq = 0;

function snippetNodes(snippet: string): (Node | string)[] {
  // Server marks hits with « »; escape everything else, promote marks to <mark>.
  const out: (Node | string)[] = [];
  let rest = snippet;
  for (;;) {
    const open = rest.indexOf("«");
    const close = open < 0 ? -1 : rest.indexOf("»", open);
    if (open < 0 || close < 0) { out.push(rest); break; }
    out.push(rest.slice(0, open));
    out.push(el("mark", {}, [rest.slice(open + 1, close)]));
    rest = rest.slice(close + 1);
  }
  return out;
}

async function openSearchHit(sessionKeyHit: string, messageId?: number): Promise<void> {
  if (sessionKeyHit !== sessionKey) {
    sessionKey = sessionKeyHit;
    localStorage.setItem("sc.session", sessionKeyHit);
    $("session-title").textContent = sessionKeyHit;
  }
  closeDrawer();
  await loadHistory(messageId);
  void refresh();
}

function renderSessionSearch(q: string, result: { titleHits?: any[]; messageHits?: any[] }): void {
  const host = $("sessions");
  host.innerHTML = "";
  const titleHits = result.titleHits ?? [];
  const messageHits = result.messageHits ?? [];
  host.append(el("div", { class: "srccap" }, [
    `${titleHits.length} sessions · ${messageHits.length} messages`,
    el("button", { class: "srccap__clear", type: "button" }, ["clear"]),
  ]));
  host.querySelector(".srccap__clear")?.addEventListener("click", () => {
    const input = $("sessions-search") as HTMLInputElement;
    input.value = "";
    input.dispatchEvent(new Event("input"));
    input.focus();
  });
  for (const h of titleHits) {
    const btn = el("button", { class: "session searchrow", type: "button" }, [
      el("span", { class: "session__text" }, [
        el("span", { class: "session__title" }, [h.title || h.sessionKey]),
        el("span", { class: "session__meta" }, [
          `${h.sessionKey}${h.lastMsgAt ? ` · ${fmtTime(h.lastMsgAt)}` : ""}`,
        ]),
      ]),
    ]);
    btn.onclick = () => void openSearchHit(String(h.sessionKey));
    host.append(btn);
  }
  for (const h of messageHits) {
    const btn = el("button", { class: "session searchrow searchrow--msg", type: "button" }, [
      el("span", { class: "session__text" }, [
        el("span", { class: "session__title" }, [h.title || h.sessionKey]),
        el("span", { class: "session__meta" }, [
          `${h.role}${h.createdAt ? ` · ${fmtTime(h.createdAt)}` : ""}`,
        ]),
        el("span", { class: "searchrow__snippet" }, snippetNodes(String(h.snippet ?? ""))),
      ]),
    ]);
    const mid = Number(h.messageId);
    btn.onclick = () => void openSearchHit(String(h.sessionKey), Number.isFinite(mid) ? mid : undefined);
    host.append(btn);
  }
  if (titleHits.length + messageHits.length === 0) {
    host.append(el("div", { class: "srccap" }, [`no matches for “${q}”`]));
  }
}

function initSessionSearch(): void {
  const input = $("sessions-search") as HTMLInputElement | null;
  if (!input) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async (): Promise<void> => {
    const q = input.value.trim();
    if (q.length < 2) { searchSeq++; renderSessions(lastSessionList); return; }
    const seq = ++searchSeq;
    try {
      const res = await gateway.request("sessions.search", { query: q, limit: 25 });
      if (seq !== searchSeq) return; // a newer keystroke already answered
      renderSessionSearch(q, res as { titleHits?: any[]; messageHits?: any[] });
    } catch {
      // Search must never blank the drawer: keep whatever is on screen.
    }
  };
  input.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void run(), 150);
  };
  input.onkeydown = (e) => {
    if (e.key === "Escape") {
      input.value = "";
      input.dispatchEvent(new Event("input"));
      input.blur();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const first = document.querySelector("#sessions .searchrow") as HTMLButtonElement | null;
      first?.click();
    }
  };
}

initSessionSearch();

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

/* ---------------- sub-agents panel (their Subagents view, compact) ---------------- */

function openSubagentsPanel(): void {
  type Row = {
    child_session_key: string; run_id: string; label: string; task_name: string;
    status: string; result_stats: string | null; outcome: string | null;
  };
  const renderRows = async (box: HTMLElement, refill: () => Promise<Row[]>) => {
    box.innerHTML = "";
    let rows: Row[] = [];
    try {
      rows = await refill();
    } catch {
      box.append(el("div", { class: "sgalist__empty" }, ["could not load sub-agents"]));
      return;
    }
    if (rows.length === 0) {
      box.append(el("div", { class: "sgalist__empty" }, ["No sub-agents for this session yet."]));
      return;
    }
    const running = rows.filter((r) => r.status === "running");
    const finished = rows.filter((r) => r.status !== "running");
    const list = el("div", { class: "sgalist" });
    if (running.length > 0) list.append(el("div", { class: "qrow__label" }, ["Running"]));
    for (const r of running) {
      const stop = el("button", { class: "btn sm row__stop", type: "button" }, ["Stop"]);
      stop.onclick = async () => {
        try {
          await gateway.request("subagents.cancel", { sessionKey, target: r.run_id });
          toast("sub-agent stopping…", "ok");
        } catch (err) {
          toast((err as Error).message, "err");
        }
      };
      list.append(el("div", { class: "row" }, [
        el("span", { class: "row__label" }, [r.label || r.task_name || r.child_session_key]),
        el("span", { class: "row__meta row__meta--run" }, ["running…"]),
        stop,
      ]));
    }
    if (finished.length > 0) list.append(el("div", { class: "qrow__label" }, ["Finished"]));
    for (const r of finished) {
      const open = el("button", { class: "btn sm row__stop", type: "button" }, ["Open"]);
      open.onclick = () => void switchSession(r.child_session_key);
      list.append(el("div", { class: "row" }, [
        el("span", { class: "row__label" }, [r.label || r.task_name || r.child_session_key]),
        el("span", { class: "row__meta" }, [`${r.status}${r.result_stats ? ` · ${r.result_stats}` : ""}`]),
        open,
      ]));
    }
    box.append(list);
  };
  const fetchRows = async (): Promise<Row[]> => ((await gateway.request("subagents.list", { sessionKey })) as any).children ?? [];
  modal({
    title: "Sub-agents",
    cancelLabel: "Close",
    render: (box) => {
      const rerender = () => void renderRows(box, fetchRows);
      rerender();
      const refreshBtn = el("button", { class: "btn sm", type: "button" }, ["↻ Refresh"]);
      refreshBtn.style.marginTop = "10px";
      refreshBtn.onclick = rerender;
      box.append(refreshBtn);
    },
  });
}

$("subagents-btn").onclick = () => openSubagentsPanel();
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
