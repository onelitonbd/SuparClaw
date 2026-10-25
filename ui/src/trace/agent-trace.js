// Agent Trace — a stream-driven trace card (timeline rail).
//
// Design rules (mirrors OpenClaw's chat transcript behaviour):
//   • live runs stay expanded; completed runs collapse into one "Worked for…"
//     disclosure with kind-aware operation counts ("13 commands · 6 reads");
//   • commentary / thinking / tool activity share that one disclosure, while
//     the final answer stays below it;
//   • tool rows show a semantic icon + purpose, never `tool_name({...})`;
//   • a failed-then-succeeded call is one row with a "retried" badge;
//   • the newest running call names the live group header.
//
// Everything is rendered from state. The reducer (`applyEvent`) is a pure
// module-level export so a persisted event log can be replayed after reload.

/** @typedef {import("./types.ts").TraceEvent} TraceEvent */
/** @typedef {import("./types.ts").TraceState} TraceState */

const SVG_NS = "http://www.w3.org/2000/svg";

/* ------------------------------------------------------------------ icons */

const ICON_PATHS = {
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/>',
  write: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6"/><path d="M12 16.5h.01"/>',
  minus: '<path d="M6 12h12"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  retry: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>',
  spinner: '<circle cx="12" cy="12" r="9" opacity=".25"/><path d="M21 12a9 9 0 0 0-9-9"/>',
  arrowDown: '<path d="M12 5v14M5 12l7 7 7-7"/>',
};

function svg(name, size = 14, cls = "", doc = globalThis.document) {
  const el = doc.createElementNS(SVG_NS, "svg");
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("width", String(size));
  el.setAttribute("height", String(size));
  el.setAttribute("fill", "none");
  el.setAttribute("stroke", "currentColor");
  el.setAttribute("stroke-width", "1.8");
  el.setAttribute("stroke-linecap", "round");
  el.setAttribute("stroke-linejoin", "round");
  el.setAttribute("aria-hidden", "true");
  if (cls) el.setAttribute("class", cls);
  el.innerHTML = ICON_PATHS[name] || ICON_PATHS.doc;
  return el;
}

const TOOL_ICON_ALIASES = {
  fs_read: "file",
  fs_write: "write",
  fs_edit: "write",
  fs_list: "file",
  exec: "terminal",
  web_search: "search",
  web_fetch: "globe",
  pdf: "doc",
  memory_search: "search",
  memory_append: "file",
  sessions_spawn: "layers",
  skill_read: "doc",
  skill_list: "doc",
  skill_save: "doc",
};

export function toolIconName(tool, icon) {
  if (icon && ICON_PATHS[icon]) return icon;
  const t = String(tool || "").toLowerCase();
  if (TOOL_ICON_ALIASES[t]) return TOOL_ICON_ALIASES[t];
  if (/search|find|query/.test(t)) return "search";
  if (/write|edit|patch|save/.test(t)) return "write";
  if (/read|cat|list|file|glob/.test(t)) return "file";
  if (/exec|shell|command|run/.test(t)) return "terminal";
  if (/fetch|http|browse|web/.test(t)) return "globe";
  if (/spawn|agent|skill/.test(t)) return "layers";
  if (/doc|pdf|page/.test(t)) return "doc";
  return "doc";
}

/* -------------------------------------------------------------- formatting */

/** "0.8s" · "4.1s" · "34s" · "1m 12s" */
export function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "";
  const s = n / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 59.5) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  return rest === 0 ? `${m}m` : `${m}m ${rest}s`;
}

function fmtCount(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function humanTool(tool) {
  const t = String(tool || "").replace(/[_-]+/g, " ").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "Tool";
}

const GROUP_NOUN = {
  web_search: ["query", "queries"],
  fs_read: ["file", "files"],
  fs_list: ["folder", "folders"],
  fs_write: ["file", "files"],
  fs_edit: ["edit", "edits"],
  exec: ["command", "commands"],
  web_fetch: ["page", "pages"],
  memory_search: ["memory search", "memory searches"],
  sessions_spawn: ["sub-agent", "sub-agents"],
};

const GROUP_VERB = {
  web_search: "Searched the web",
  web_fetch: "Fetched pages",
  fs_read: "Read files",
  fs_list: "Listed folders",
  fs_write: "Wrote files",
  fs_edit: "Edited files",
  exec: "Ran commands",
  memory_search: "Searched memory",
  memory_append: "Saved memory",
  sessions_spawn: "Started sub-agents",
  skill_read: "Read skills",
  skill_save: "Saved skills",
  pdf: "Read documents",
};

const OP_CATEGORY = {
  fs_read: ["read", "reads"],
  fs_list: ["listing", "listings"],
  fs_write: ["write", "writes"],
  fs_edit: ["edit", "edits"],
  exec: ["command", "commands"],
  web_search: ["search", "searches"],
  web_fetch: ["fetch", "fetches"],
  memory_search: ["memory search", "memory searches"],
  memory_append: ["memory write", "memory writes"],
  sessions_spawn: ["sub-agent", "sub-agents"],
  skill_read: ["skill read", "skill reads"],
  pdf: ["document", "documents"],
};

/* ------------------------------------------------------------ state model */

const now = () => Date.now();

export function createState(runId = "", ts = now()) {
  return {
    runId,
    status: "running",
    startedAt: ts,
    endedAt: null,
    items: [],
    finalAnswer: null,
    waitingApproval: null,
    error: null,
  };
}

function findItem(state, id) {
  return state.items.find((i) => i.id === id) || null;
}

function findCall(state, stepId) {
  for (const item of state.items) {
    if (item.kind !== "tool") continue;
    const call = item.calls.find((c) => c.id === stepId);
    if (call) return { item, call };
  }
  return null;
}

function errorText(v) {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    const o = v;
    if (typeof o.message === "string") return o.message;
    if (typeof o.error === "string") return o.error;
  }
  return String(v);
}

/**
 * Fold one wire event into the render-ready state. Pure with respect to the
 * DOM; mutates (and returns) `state` so it can also be used for replay.
 */
export function applyEvent(state, ev) {
  const ts = Number(ev.ts) > 0 ? Number(ev.ts) : now();
  switch (ev.type) {
    case "run_start": {
      state.runId = ev.runId;
      state.status = "running";
      state.startedAt = ts;
      state.endedAt = null;
      state.items = [];
      state.finalAnswer = null;
      state.waitingApproval = null;
      state.error = null;
      return state;
    }

    case "thinking_start": {
      const existing = findItem(state, ev.stepId);
      if (existing && existing.kind === "thinking") {
        existing.status = "running";
        existing.endedAt = null;
        return state;
      }
      state.items.push({
        kind: "thinking",
        id: ev.stepId,
        status: "running",
        text: "",
        startedAt: ts,
        endedAt: null,
      });
      return state;
    }

    case "thinking_delta": {
      const item = findItem(state, ev.stepId);
      if (item && item.kind === "thinking") item.text += String(ev.text ?? "");
      return state;
    }

    case "thinking_end": {
      const item = findItem(state, ev.stepId);
      if (item && item.kind === "thinking") {
        item.status = "done";
        item.endedAt = ts;
      }
      return state;
    }

    case "message_delta": {
      let item = findItem(state, ev.stepId);
      if (!item || item.kind !== "message") {
        item = {
          kind: "message",
          id: ev.stepId,
          text: "",
          startedAt: ts,
          endedAt: null,
        };
        state.items.push(item);
      }
      item.text += String(ev.text ?? "");
      if (ev.final) {
        // The final message is the answer, not a trace step (OpenClaw keeps
        // the answer below the "Worked for…" disclosure).
        state.finalAnswer = item.text;
        item.endedAt = ts;
        state.items = state.items.filter((i) => i !== item);
      }
      return state;
    }

    case "tool_start": {
      // A retry may re-emit tool_start with the same call id while the row is
      // still running. Keep one row: refresh the pending call instead of
      // appending a duplicate.
      const pending = findCall(state, ev.stepId);
      if (pending && pending.call.status === "running") {
        pending.call.label = String(ev.label ?? pending.call.label);
        pending.call.input = ev.input;
        pending.item.label = pending.call.label;
        return state;
      }
      const tail = state.items[state.items.length - 1];
      const canMerge =
        tail &&
        tail.kind === "tool" &&
        ((ev.groupId && tail.groupId === ev.groupId) ||
          (!ev.groupId && tail.tool === ev.tool));
      const call = {
        id: ev.stepId,
        tool: String(ev.tool ?? "tool"),
        icon: toolIconName(ev.tool, ev.icon),
        label: String(ev.label ?? humanTool(ev.tool)),
        input: ev.input,
        status: "running",
        startedAt: ts,
        endedAt: null,
        error: null,
        retried: false,
        retryNote: undefined,
        output: undefined,
        summary: undefined,
        meta: undefined,
        outcome: undefined,
        progress: undefined,
      };
      if (canMerge) {
        tail.calls.push(call);
        tail.label = call.label;
        tail.status = "running";
        tail.endedAt = null;
      } else {
        state.items.push({
          kind: "tool",
          id: ev.groupId || ev.stepId,
          groupId: ev.groupId,
          tool: call.tool,
          icon: call.icon,
          label: call.label,
          status: "running",
          calls: [call],
          startedAt: ts,
          endedAt: null,
        });
      }
      return state;
    }

    case "tool_end": {
      const hit = findCall(state, ev.stepId);
      if (!hit) return state;
      const { item, call } = hit;
      call.status = ev.outcome === "error" ? "error" : "done";
      call.endedAt = ts;
      call.output = ev.output;
      call.summary = ev.summary;
      call.meta = ev.meta;
      call.outcome = ev.outcome;
      // If a call failed and then succeeded, it is one row with the retried
      // badge even when the backend forgets to set `retried` explicitly.
      call.retried = Boolean(ev.retried) || call.retried || Boolean(call.hadError);
      call.retryNote = ev.retryNote ?? call.retryNote;
      call.error = call.status === "error" ? errorText(ev.output) || "Tool failed" : null;
      if (call.retried) {
        item.retried = true;
        item.retryNote = ev.retryNote ?? item.retryNote;
      }
      const running = item.calls.some((c) => c.status === "running");
      item.status = running ? "running" : item.calls.some((c) => c.status === "error") ? "error" : "done";
      if (!running) item.endedAt = ts;
      return state;
    }

    case "tool_error": {
      const hit = findCall(state, ev.stepId);
      if (!hit) return state;
      const { item, call } = hit;
      call.error = String(ev.message ?? "Tool failed");
      call.hadError = true;
      if (!ev.willRetry) {
        call.status = "error";
        call.endedAt = ts;
        if (!item.calls.some((c) => c.status === "running")) {
          item.status = "error";
          item.endedAt = ts;
        }
      }
      return state;
    }

    case "approval_request": {
      const existing = findItem(state, ev.stepId);
      if (!existing) {
        state.items.push({
          kind: "approval",
          id: ev.stepId,
          description: String(ev.description ?? "Approval required"),
          decision: null,
          startedAt: ts,
          endedAt: null,
        });
      }
      state.status = "waiting";
      state.waitingApproval = ev.stepId;
      return state;
    }

    case "subagent_start": {
      const tail = state.items[state.items.length - 1];
      if (tail && tail.kind === "subagent" && ev.groupId && tail.groupId === ev.groupId) {
        tail.label = String(ev.label ?? tail.label);
        return state;
      }
      state.items.push({
        kind: "subagent",
        id: ev.groupId || ev.stepId,
        groupId: ev.groupId,
        label: String(ev.label ?? "Sub-agent"),
        icon: ev.icon || "layers",
        status: "running",
        progress: undefined,
        startedAt: ts,
        endedAt: null,
      });
      return state;
    }

    case "subagent_update": {
      const item = findItem(state, ev.stepId);
      if (item && item.kind === "subagent") {
        if (ev.label) item.label = String(ev.label);
        if (ev.progress) item.progress = String(ev.progress);
      }
      return state;
    }

    case "subagent_end": {
      const item = findItem(state, ev.stepId);
      if (item && item.kind === "subagent") {
        item.status = ev.status;
        item.endedAt = ts;
        item.progress = undefined;
      }
      return state;
    }

    case "run_end": {
      state.status = ev.status;
      state.endedAt = ts;
      state.waitingApproval = null;
      if (ev.status === "error") {
        const errored = [...state.items]
          .reverse()
          .find((i) => i.kind === "tool" && i.status === "error");
        state.error =
          ev.message ||
          (errored && errored.kind === "tool"
            ? errored.calls.find((c) => c.status === "error")?.error
            : null) ||
          "The run ended unexpectedly.";
      }
      return state;
    }

    default:
      return state;
  }
}

/** Steps shown in the collapsed header: thinking + tool group + message. */
export function countSteps(state) {
  return state.items.filter(
    (i) => i.kind === "thinking" || i.kind === "tool" || i.kind === "message",
  ).length;
}

/** Kind-aware operation counts ("2 reads · 3 searches") — OpenClaw's summary
 *  is operation counts, not a claim about distinct files. */
export function operationSummary(state) {
  const counts = new Map();
  for (const item of state.items) {
    if (item.kind !== "tool") continue;
    for (const call of item.calls) {
      const [one, many] = OP_CATEGORY[call.tool] || [call.tool.replace(/[_-]+/g, " "), `${call.tool.replace(/[_-]+/g, " ")}s`];
      const key = many;
      const prev = counts.get(key) || { n: 0, one, many };
      prev.n += 1;
      counts.set(key, prev);
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, 4)
    .map((c) => `${c.n} ${c.n === 1 ? c.one : c.many}`)
    .join(" · ");
}

/* ------------------------------------------------------------- component */

let uid = 0;

export class AgentTrace {
  #jumpEnabled = false;

  /**
   * @param {HTMLElement} root container the trace card is appended to
   * @param {{
   *   scrollRoot?: HTMLElement,
   *   onApproval?: (decision: "allow"|"deny", step: {id: string; description: string}) => void,
   *   onRetry?: (state: TraceState) => void,
   *   onStatus?: (status: "running"|"waiting"|"done"|"error"|"stopped") => void,
   *   announce?: (text: string) => void
   * }} [opts]
   */
  constructor(root, opts = {}) {
    this.root = root;
    this.doc = root.ownerDocument || globalThis.document;
    this.opts = opts;
    this.state = createState();
    this.expanded = true;
    this.userExpanded = null;
    this.itemExpanded = new Set();
    this.itemCollapsed = new Set();
    this.callExpanded = new Set();
    this.nodes = new Map();
    this.following = true;
    this.startedTimer = false;
    this.liveLabel = "Working…";
    this.finalIsCustom = false;
    this.lastAnnounced = "";
    this.lastStatus = "running";
    this.announceTimer = 0;
    this.timer = 0;
    this.collapseTimer = 0;
    this.scrollRoot = opts.scrollRoot || null;
    this.#jumpEnabled = opts.jump !== false;
    this.#build();
    if (this.scrollRoot) {
      this.onScroll = () => {
        const el = this.scrollRoot;
        const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        this.following = near;
        if (this.#jumpEnabled) this.jumpEl.hidden = near;
      };
      this.scrollRoot.addEventListener("scroll", this.onScroll, { passive: true });
    }
  }

  /* --------------------------------------------------------------- shell */

  #build() {
    const doc = this.doc;
    const id = `agent-trace-body-${++uid}`;
    this.el = doc.createElement("div");
    this.el.className = "agent-trace agent-trace--running agent-trace--expanded";
    this.el.innerHTML = `
      <div class="agent-trace__card">
        <button class="agent-trace__header" type="button" aria-expanded="true" aria-controls="${id}" aria-disabled="true">
          <span class="agent-trace__status-icon" data-icon></span>
          <span class="agent-trace__head">
            <span class="agent-trace__title"><span class="agent-trace__shimmer" data-title>Working…</span></span>
            <span class="agent-trace__sub" data-sub></span>
          </span>
          <span class="agent-trace__tail">
            <span class="agent-trace__timer" data-timer>0s</span>
            <span class="agent-trace__chips" data-chips></span>
            <span class="agent-trace__chev" data-chev hidden></span>
          </span>
        </button>
        <div class="agent-trace__body" id="${id}" data-body>
          <div class="agent-trace__body-clip">
            <div class="agent-trace__scroller" data-scroller>
              <div class="agent-trace__steps" data-steps></div>
              <div class="agent-trace__errorbox" data-errorbox hidden></div>
            </div>
          </div>
        </div>
      </div>
      <div class="agent-trace__final" data-final hidden></div>
      <button class="agent-trace__jump" type="button" data-jump hidden>
        <span class="agent-trace__jump-icon" data-jump-icon></span>Jump to latest
      </button>
      <div class="agent-trace__sr" role="status" aria-live="polite" aria-atomic="true" data-live></div>
    `;
    this.root.appendChild(this.el);
    this.card = this.el.querySelector(".agent-trace__card");
    this.header = this.el.querySelector(".agent-trace__header");
    this.iconEl = this.el.querySelector("[data-icon]");
    this.titleEl = this.el.querySelector("[data-title]");
    this.subEl = this.el.querySelector("[data-sub]");
    this.timerEl = this.el.querySelector("[data-timer]");
    this.chipsEl = this.el.querySelector("[data-chips]");
    this.chevEl = this.el.querySelector("[data-chev]");
    this.bodyEl = this.el.querySelector("[data-body]");
    this.scroller = this.el.querySelector("[data-scroller]");
    this.stepsEl = this.el.querySelector("[data-steps]");
    this.finalEl = this.el.querySelector("[data-final]");
    this.jumpEl = this.el.querySelector("[data-jump]");
    this.liveEl = this.el.querySelector("[data-live]");
    this.errorBox = this.el.querySelector("[data-errorbox]");
    this.chevEl.appendChild(svg("chevron", 16, "", this.doc));
    this.el.querySelector("[data-jump-icon]").appendChild(svg("arrowDown", 13, "", this.doc));

    this.header.addEventListener("click", () => {
      if (this.#isLive()) return; // running / waiting: header is not collapsible
      this.setExpanded(!this.expanded, true);
    });
    this.jumpEl.addEventListener("click", () => {
      this.following = true;
      this.jumpEl.hidden = true;
      this.scrollToLatest();
    });
    this.#setHeaderIcon("spinner");
    this.#layout();
  }

  #isLive() {
    return this.state.status === "running" || this.state.status === "waiting";
  }

  /* --------------------------------------------------------------- input */

  /** Feed one event. */
  push(ev) {
    const wasLive = this.#isLive();
    const isStart = ev.type === "run_start";
    if (isStart) this.#reset();

    applyEvent(this.state, ev);

    if (ev.type === "run_start") {
      this.startedTimer = true;
      this.#startTimer();
    }
    if (ev.type === "tool_start") this.liveLabel = ev.label || humanTool(ev.tool);
    if (ev.type === "thinking_start") this.liveLabel = "Thinking…";
    if (ev.type === "thinking_end" && !this.#hasRunningTool()) this.liveLabel = "Thinking…";
    if (ev.type === "message_delta" && !ev.final) this.liveLabel = "Writing…";

    this.#render();
    if (ev.type === "run_end") this.#finish(wasLive);
    this.#announce(this.#announcement());
    this.#follow();
  }

  /** Rebuild from a persisted event log (page reload mid-run). */
  replay(events) {
    this.#reset();
    for (const ev of events || []) {
      applyEvent(this.state, ev);
      if (ev.type === "tool_start") this.liveLabel = ev.label || humanTool(ev.tool);
    }
    this.#render();
    if (this.#isLive()) {
      this.startedTimer = true;
      this.#startTimer();
    } else {
      this.#finish(false);
    }
  }

  /** Restore a serialized TraceState (fast path; same renderer as replay). */
  restore(snapshot) {
    this.#reset();
    this.state = {
      ...createState(snapshot.runId || "", snapshot.startedAt || now()),
      ...snapshot,
      items: Array.isArray(snapshot.items) ? snapshot.items : [],
    };
    this.#render();
    if (this.#isLive()) {
      this.startedTimer = true;
      this.#startTimer();
    } else {
      this.#finish(false);
    }
  }

  getState() {
    return this.state;
  }

  /** UI-only approval response: updates the row without invoking callbacks. */
  setDecision(stepId, decision) {
    const item = this.state.items.find((i) => i.kind === "approval" && (!stepId || i.id === stepId));
    if (!item || item.kind !== "approval" || item.decision) return;
    item.decision = decision;
    item.endedAt = now();
    this.state.waitingApproval = null;
    if (this.state.status === "waiting") this.state.status = "running";
    this.#render();
    this.#announce(decision === "allow" ? "Approved" : "Denied");
    this.#follow();
  }

  /** Approval response: updates the row and forwards to opts.onApproval. */
  decide(stepId, decision) {
    const item = this.state.items.find((i) => i.kind === "approval" && (!stepId || i.id === stepId));
    if (!item || item.kind !== "approval" || item.decision) return;
    this.setDecision(stepId, decision);
    this.opts.onApproval?.(decision, { id: item.id, description: item.description });
  }

  setFinalAnswer(content) {
    this.finalEl.hidden = !content;
    this.finalEl.replaceChildren();
    this.finalIsCustom = Boolean(content) && typeof content !== "string";
    if (!content) return;
    if (typeof content === "string") this.finalEl.textContent = content;
    else this.finalEl.appendChild(content);
    this.#follow();
  }

  setExpanded(on, manual = false) {
    this.expanded = Boolean(on);
    if (manual) this.userExpanded = this.expanded;
    this.el.classList.toggle("agent-trace--expanded", this.expanded);
    this.header.setAttribute("aria-expanded", this.expanded ? "true" : "false");
    this.#layout();
  }

  destroy() {
    this.#stopTimer();
    clearTimeout(this.announceTimer);
    clearTimeout(this.collapseTimer);
    if (this.scrollRoot && this.onScroll) this.scrollRoot.removeEventListener("scroll", this.onScroll);
    this.el.remove();
  }

  /* ------------------------------------------------------------- render */

  #reset() {
    this.#stopTimer();
    clearTimeout(this.collapseTimer);
    this.state = createState();
    this.nodes.clear();
    this.stepsEl.replaceChildren();
    this.finalEl.hidden = true;
    this.finalEl.replaceChildren();
    this.finalIsCustom = false;
    this.errorBox.hidden = true;
    this.itemExpanded.clear();
    this.itemCollapsed.clear();
    this.callExpanded.clear();
    this.liveLabel = "Working…";
    this.jumpEl.hidden = !this.#jumpEnabled;
    this.chipsEl.replaceChildren();
    this.el.classList.remove("agent-trace--done", "agent-trace--expired", "agent-trace--stopped", "agent-trace--error");
    this.el.classList.add("agent-trace--running", "agent-trace--expanded");
    this.card.hidden = false;
    this.expanded = true;
    this.userExpanded = null;
    this.timerEl.hidden = false;
    this.chevEl.hidden = true;
    this.header.setAttribute("aria-disabled", "true");
  }

  #render() {
    const live = this.#isLive();
    if (this.state.status !== this.lastStatus) {
      this.lastStatus = this.state.status;
      this.opts.onStatus?.(this.state.status);
    }
    this.el.classList.toggle("agent-trace--running", this.state.status === "running");
    this.el.classList.toggle("agent-trace--waiting", this.state.status === "waiting");
    this.el.classList.toggle("agent-trace--done", this.state.status === "done");
    this.el.classList.toggle("agent-trace--stopped", this.state.status === "stopped");
    this.el.classList.toggle("agent-trace--error", this.state.status === "error");

    // Items (append-only; the one exception is an interim message promoted to
    // the final answer, which the reducer removes).
    const alive = new Set();
    for (const item of this.state.items) {
      alive.add(item.id);
      let node = this.nodes.get(item.id);
      if (!node) {
        node = this.#createItem(item);
        this.nodes.set(item.id, node);
        this.stepsEl.appendChild(node);
        node.classList.add("agent-trace__item--new");
      }
      this.#fillItem(item, node);
    }
    for (const [id, node] of this.nodes) {
      if (!alive.has(id)) {
        node.remove();
        this.nodes.delete(id);
      }
    }

    this.#updateHeader();

    // Final answer (streamed through message_delta {final:true} or set directly)
    if (this.state.finalAnswer && !this.finalIsCustom) {
      this.setFinalAnswer(this.state.finalAnswer);
    }

    if (live) {
      this.el.classList.add("agent-trace--expanded");
      this.expanded = true;
      this.chevEl.hidden = true;
      this.header.setAttribute("aria-disabled", "true");
    } else {
      this.chevEl.hidden = false;
      this.header.removeAttribute("aria-disabled");
    }
    this.#layout();
  }

  #createItem(item) {
    const doc = this.doc;
    const node = doc.createElement("div");
    node.className = `agent-trace__item agent-trace__item--${item.kind}`;
    node.dataset.id = item.id;
    const rail = doc.createElement("div");
    rail.className = "agent-trace__rail";
    rail.innerHTML = '<span class="agent-trace__rail-cell" data-rail></span><span class="agent-trace__rail-line"></span>';
    const content = doc.createElement("div");
    content.className = "agent-trace__content";
    content.dataset.content = "";
    node.append(rail, content);
    return node;
  }

  #fillItem(item, node) {
    const rail = node.querySelector("[data-rail]");
    const content = node.querySelector("[data-content]");
    rail.replaceChildren();
    content.replaceChildren();
    if (item.kind === "thinking") this.#fillThinking(item, rail, content);
    else if (item.kind === "message") this.#fillMessage(item, rail, content);
    else if (item.kind === "tool") this.#fillTool(item, rail, content, node);
    else if (item.kind === "approval") this.#fillApproval(item, rail, content);
    else if (item.kind === "subagent") this.#fillSubagent(item, rail, content);
  }

  #fillThinking(item, rail, content) {
    rail.appendChild(this.doc.createElement("span")).className = "agent-trace__dot";
    const btn = this.doc.createElement("button");
    btn.type = "button";
    btn.className = "agent-trace__row agent-trace__row--thinking";
    btn.setAttribute("aria-expanded", this.itemExpanded.has(item.id) ? "true" : "false");
    const label = this.doc.createElement("span");
    label.className = "agent-trace__label agent-trace__label--muted";
    label.textContent =
      item.status === "running"
        ? "Thinking…"
        : `Thought for ${formatDuration((item.endedAt || now()) - item.startedAt)}`;
    const chev = this.doc.createElement("span");
    chev.className = "agent-trace__chev-sm";
    chev.appendChild(svg("chevron", 14, "", this.doc));
    btn.append(label, chev);
    btn.addEventListener("click", () => this.#toggleItem(item));
    content.appendChild(btn);

    const detail = this.doc.createElement("div");
    detail.className = "agent-trace__detail agent-trace__detail--thought";
    detail.hidden = !this.itemExpanded.has(item.id);
    detail.textContent = item.text || (item.status === "running" ? "…" : "");
    content.appendChild(detail);
  }

  #fillMessage(item, rail, content) {
    rail.appendChild(this.doc.createElement("span")).className =
      "agent-trace__dot agent-trace__dot--accent";
    const text = this.doc.createElement("p");
    text.className = "agent-trace__message";
    text.textContent = item.text;
    content.appendChild(text);
  }

  #fillTool(item, rail, content) {
    const doc = this.doc;
    const cell = doc.createElement("span");
    cell.className = "agent-trace__circle";
    if (item.status === "running") {
      cell.classList.add("agent-trace__circle--spinner");
    } else if (item.status === "error") {
      cell.classList.add("agent-trace__circle--error");
      cell.appendChild(svg("alert", 13, "", this.doc));
    } else {
      cell.appendChild(svg(item.icon || "doc", 13, "", this.doc));
    }
    rail.appendChild(cell);

    const multi = item.calls.length > 1;
    // A single-call row expands its INPUT/OUTPUT detail; a multi-call group
    // expands the indented sub-rows. Their aria-expanded must track the
    // matching state or the chevron lies.
    const open = multi ? this.#isItemOpen(item) : this.callExpanded.has(item.calls[0].id);
    const row = doc.createElement("button");
    row.type = "button";
    row.className = "agent-trace__row agent-trace__row--tool";
    row.setAttribute("aria-expanded", open ? "true" : "false");
    row.title = item.calls.length === 1 ? item.calls[0]?.tool || item.tool : item.tool;

    const label = doc.createElement("span");
    label.className = "agent-trace__label";
    label.textContent = this.#toolTitle(item);
    row.setAttribute("aria-label", `${label.textContent || item.label}, ${item.tool}`);

    row.appendChild(label);
    if (item.retried || item.calls.some((c) => c.retried)) {
      const badge = doc.createElement("span");
      badge.className = "agent-trace__badge";
      badge.textContent = "retried";
      badge.title = item.retryNote || item.calls.find((c) => c.retryNote)?.retryNote || "Retried automatically";
      row.appendChild(badge);
    }
    const meta = doc.createElement("span");
    meta.className = "agent-trace__meta-inline";
    meta.textContent = this.#toolMeta(item);
    if (meta.textContent) row.appendChild(meta);
    const dur = this.#toolDuration(item);
    if (dur) {
      const d = doc.createElement("span");
      d.className = "agent-trace__duration";
      d.textContent = dur;
      row.appendChild(d);
    }
    const chev = doc.createElement("span");
    chev.className = "agent-trace__chev-sm";
    chev.appendChild(svg("chevron", 14, "", this.doc));
    row.appendChild(chev);
    row.addEventListener("click", () => {
      if (multi) this.#toggleItem(item);
      else this.#toggleCall(item.id, item.calls[0].id);
    });
    content.appendChild(row);

    if (multi) {
      const subs = doc.createElement("div");
      subs.className = "agent-trace__subrows";
      subs.hidden = !open;
      for (const call of item.calls) {
        subs.appendChild(this.#subrow(item, call));
      }
      content.appendChild(subs);
    } else {
      content.appendChild(this.#callDetail(item.calls[0], this.callExpanded.has(item.calls[0].id)));
    }
  }

  #toolTitle(item) {
    if (this.#isLive() && item.status === "running") {
      const running = [...item.calls].reverse().find((c) => c.status === "running");
      if (running) return running.label || humanTool(running.tool);
    }
    const n = item.calls.length;
    if (n <= 1) return item.calls[0]?.label || item.label || humanTool(item.tool);
    const mixed = new Set(item.calls.map((c) => c.tool)).size > 1;
    if (mixed) return `${humanTool(item.tool)} and ${n - 1} more`;
    const [one, many] = GROUP_NOUN[item.tool] || ["call", "calls"];
    return `${GROUP_VERB[item.tool] || humanTool(item.tool)} · ${fmtCount(n, one, many)}`;
  }

  #toolMeta(item) {
    if (item.calls.length === 1) {
      const call = item.calls[0];
      if (call.status === "error") return call.meta || "Failed";
      if (call.outcome === "unknown") return call.meta || "Outcome unknown";
      return call.meta || call.summary || "";
    }
    const failed = item.calls.filter((c) => c.status === "error").length;
    const unknown = item.calls.filter((c) => c.outcome === "unknown").length;
    if (failed) return `${failed} failed`;
    if (unknown) return `${unknown} outcome unknown`;
    return "";
  }

  #toolDuration(item) {
    const started = Math.min(...item.calls.map((c) => c.startedAt).filter(Boolean));
    const ended = item.calls.every((c) => c.endedAt) ? Math.max(...item.calls.map((c) => c.endedAt)) : null;
    if (!Number.isFinite(started) || !ended) return "";
    return formatDuration(ended - started);
  }

  #subrow(item, call) {
    const doc = this.doc;
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "agent-trace__subrow";
    const open = this.callExpanded.has(call.id);
    btn.setAttribute("aria-expanded", open ? "true" : "false");

    const state = doc.createElement("span");
    state.className = "agent-trace__subrow-state";
    if (call.status === "running") {
      const sp = doc.createElement("span");
      sp.className = "agent-trace__mini-spinner";
      state.appendChild(sp);
    } else if (call.status === "error") {
      state.classList.add("agent-trace__subrow-state--error");
      state.appendChild(svg("alert", 12, "", this.doc));
    } else if (call.outcome === "unknown") {
      state.classList.add("agent-trace__subrow-state--unknown");
      state.appendChild(svg("minus", 12, "", this.doc));
    } else {
      state.classList.add("agent-trace__subrow-state--ok");
      state.appendChild(svg("check", 12, "", this.doc));
    }

    const label = doc.createElement("span");
    label.className = "agent-trace__subrow-label";
    if (/search|fetch/.test(call.tool)) label.classList.add("agent-trace__mono");
    label.textContent = call.summary || call.label;

    const meta = doc.createElement("span");
    meta.className = "agent-trace__subrow-meta";
    meta.textContent = call.meta || "";

    btn.append(state, label);
    if (meta.textContent) btn.appendChild(meta);
    btn.addEventListener("click", () => this.#toggleCall(item.id, call.id));

    const wrap = doc.createElement("div");
    wrap.className = "agent-trace__subrow-wrap";
    wrap.append(btn, this.#callDetail(call, open));
    return wrap;
  }

  #callDetail(call, open) {
    const doc = this.doc;
    const detail = doc.createElement("div");
    detail.className = "agent-trace__detail";
    detail.hidden = !open;
    if (!open) return detail;

    if (call.retryNote || call.retried) {
      const note = doc.createElement("p");
      note.className = "agent-trace__retry-note";
      note.textContent =
        call.retryNote ||
        "The first attempt failed. Retried automatically and succeeded.";
      detail.appendChild(note);
    }
    if (call.error) {
      const err = doc.createElement("p");
      err.className = "agent-trace__call-error";
      err.textContent = call.error;
      detail.appendChild(err);
    }

    const sections = [
      ["Input", formatValue(call.input)],
      ["Output", call.output !== undefined ? formatValue(call.output) : call.summary || "—"],
    ];
    for (const [label, value] of sections) {
      const box = doc.createElement("div");
      box.className = "agent-trace__detail-section";
      const cap = doc.createElement("div");
      cap.className = "agent-trace__detail-label";
      cap.textContent = label;
      const pre = doc.createElement("pre");
      pre.className = "agent-trace__pre";
      pre.textContent = value || "—";
      box.append(cap, pre);
      detail.appendChild(box);
    }

    const raw = doc.createElement("button");
    raw.type = "button";
    raw.className = "agent-trace__raw-toggle";
    raw.setAttribute("aria-expanded", "false");
    raw.textContent = "Show raw JSON";
    const pre = doc.createElement("pre");
    pre.className = "agent-trace__pre agent-trace__raw";
    pre.hidden = true;
    pre.textContent = JSON.stringify({ input: call.input, output: call.output }, null, 2);
    raw.addEventListener("click", () => {
      const show = raw.getAttribute("aria-expanded") !== "true";
      raw.setAttribute("aria-expanded", show ? "true" : "false");
      raw.textContent = show ? "Hide raw JSON" : "Show raw JSON";
      pre.hidden = !show;
      this.#layout();
    });
    detail.append(raw, pre);
    return detail;
  }

  #fillApproval(item, rail, content) {
    const doc = this.doc;
    rail.appendChild(doc.createElement("span")).className = "agent-trace__dot agent-trace__dot--warn";
    const card = doc.createElement("div");
    card.className = "agent-trace__approval";
    const title = doc.createElement("div");
    title.className = "agent-trace__approval-title";
    title.textContent = "Permission needed";
    const desc = doc.createElement("p");
    desc.className = "agent-trace__approval-desc";
    desc.textContent = item.description;
    card.append(title, desc);

    if (item.decision) {
      const done = doc.createElement("p");
      done.className = "agent-trace__approval-done";
      done.textContent = item.decision === "allow" ? "Allowed" : "Denied";
      card.appendChild(done);
    } else {
      const actions = doc.createElement("div");
      actions.className = "agent-trace__approval-actions";
      const deny = doc.createElement("button");
      deny.type = "button";
      deny.className = "agent-trace__btn";
      deny.textContent = "Deny";
      deny.addEventListener("click", () => this.decide(item.id, "deny"));
      const allow = doc.createElement("button");
      allow.type = "button";
      allow.className = "agent-trace__btn agent-trace__btn--primary";
      allow.textContent = "Allow";
      allow.addEventListener("click", () => this.decide(item.id, "allow"));
      actions.append(deny, allow);
      card.appendChild(actions);
    }
    content.appendChild(card);
  }

  #fillSubagent(item, rail, content) {
    const doc = this.doc;
    const cell = doc.createElement("span");
    cell.className = "agent-trace__circle agent-trace__circle--nested";
    cell.appendChild(svg(item.icon || "layers", 13, "", this.doc));
    rail.appendChild(cell);
    const row = doc.createElement("div");
    row.className = "agent-trace__row agent-trace__row--subagent";
    const label = doc.createElement("span");
    label.className = "agent-trace__label";
    label.textContent = item.label;
    const meta = doc.createElement("span");
    meta.className = "agent-trace__meta-inline";
    meta.textContent = item.progress || item.status;
    if (item.status === "running") {
      const sp = doc.createElement("span");
      sp.className = "agent-trace__mini-spinner";
      row.append(label, sp);
    } else {
      row.append(label, meta);
    }
    content.appendChild(row);
  }

  #isItemOpen(item) {
    if (this.itemCollapsed.has(item.id)) return false;
    if (this.itemExpanded.has(item.id)) return true;
    // While a run is live, show the individual calls in a parallel group so
    // the newest query/command is visible as it runs (OpenClaw's live rows).
    return this.#isLive() && item.kind === "tool" && item.calls.length > 1;
  }

  #toggleItem(item) {
    if (this.#isItemOpen(item)) {
      this.itemExpanded.delete(item.id);
      this.itemCollapsed.add(item.id);
    } else {
      this.itemCollapsed.delete(item.id);
      this.itemExpanded.add(item.id);
    }
    this.#render();
  }

  #toggleCall(itemId, callId) {
    if (this.callExpanded.has(callId)) this.callExpanded.delete(callId);
    else this.callExpanded.add(callId);
    this.#render();
  }

  /* ------------------------------------------------------------- header */

  #updateHeader() {
    const s = this.state;
    const dur = formatDuration((s.endedAt || now()) - (s.startedAt || now()));
    const n = countSteps(s);
    const stepText = `${n} ${n === 1 ? "step" : "steps"}`;

    this.el.classList.toggle("agent-trace--expanded", this.expanded);
    this.header.setAttribute("aria-expanded", this.expanded ? "true" : "false");

    // State is carried by the title's own words (and colour), not by a
    // tick/cross badge sitting in the left slot — only the live spinner
    // ever renders there.
    this.titleEl.classList.toggle("agent-trace__title--error", s.status === "error");
    this.titleEl.classList.toggle("agent-trace__title--warning", s.status === "waiting");

    if (s.status === "running") {
      this.#setHeaderIcon("spinner");
      this.titleEl.classList.add("agent-trace__shimmer");
      this.titleEl.textContent = this.liveLabel || "Working…";
      this.subEl.textContent = "";
      this.timerEl.hidden = false;
      this.timerEl.textContent = dur || "0s";
    } else if (s.status === "waiting") {
      this.#setHeaderIcon(null);
      this.titleEl.classList.remove("agent-trace__shimmer");
      this.titleEl.textContent = "Waiting for your approval";
      this.subEl.textContent = "";
      this.timerEl.hidden = false;
      this.timerEl.textContent = dur;
    } else if (s.status === "done") {
      this.#setHeaderIcon(null);
      this.titleEl.classList.remove("agent-trace__shimmer");
      this.titleEl.textContent = `Worked for ${dur || "0.0s"}`;
      const ops = operationSummary(s);
      this.subEl.textContent = ops ? `${stepText} · ${ops}` : stepText;
      this.timerEl.hidden = true;
      this.#renderChips();
    } else if (s.status === "stopped") {
      this.#setHeaderIcon(null);
      this.titleEl.classList.remove("agent-trace__shimmer");
      this.titleEl.textContent = `Stopped after ${dur} · ${stepText}`;
      this.subEl.textContent = "";
      this.timerEl.hidden = true;
      this.#renderChips();
    } else {
      this.#setHeaderIcon(null);
      this.titleEl.classList.remove("agent-trace__shimmer");
      this.titleEl.textContent = "Run failed";
      this.subEl.textContent = stepText;
      this.timerEl.hidden = true;
      this.#renderChips();
      this.#renderErrorBox();
    }
  }

  #setHeaderIcon(name) {
    this.iconEl.replaceChildren();
    if (!name) {
      this.iconEl.hidden = true;
      this.iconEl.className = "agent-trace__status-icon";
      return;
    }
    this.iconEl.hidden = false;
    this.iconEl.className = `agent-trace__status-icon agent-trace__status-icon--${name}`;
    if (name === "spinner") {
      const sp = this.doc.createElement("span");
      sp.className = "agent-trace__spinner";
      this.iconEl.appendChild(sp);
      return;
    }
    const size = 16;
    this.iconEl.appendChild(svg(name, size, "", this.doc));
  }

  #renderChips() {
    this.chipsEl.replaceChildren();
    const tools = new Map();
    for (const item of this.state.items) {
      if (item.kind === "tool") {
        for (const call of item.calls) {
          if (!tools.has(call.tool)) tools.set(call.tool, call.icon);
        }
      } else if (item.kind === "subagent") {
        if (!tools.has("subagent")) tools.set("subagent", "layers");
      }
    }
    let shown = 0;
    for (const [tool, icon] of tools) {
      if (shown >= 5) {
        const more = this.doc.createElement("span");
        more.className = "agent-trace__chip agent-trace__chip--more";
        more.textContent = `+${tools.size - 5}`;
        this.chipsEl.appendChild(more);
        break;
      }
      const chip = this.doc.createElement("span");
      chip.className = "agent-trace__chip";
      chip.title = tool;
      chip.appendChild(svg(icon || "doc", 12, "", this.doc));
      this.chipsEl.appendChild(chip);
      shown++;
    }
  }

  #renderErrorBox() {
    const s = this.state;
    this.errorBox.hidden = false;
    this.errorBox.replaceChildren();
    const title = this.doc.createElement("p");
    title.className = "agent-trace__error-title";
    title.textContent = "The run stopped before finishing.";
    const msg = this.doc.createElement("p");
    msg.className = "agent-trace__error-copy";
    msg.textContent = s.error || "No error details were recorded.";
    this.errorBox.append(title, msg);
    if (this.opts.onRetry) {
      const retry = this.doc.createElement("button");
      retry.type = "button";
      retry.className = "agent-trace__btn";
      retry.textContent = "Retry";
      retry.addEventListener("click", () => this.opts.onRetry?.(this.state));
      this.errorBox.appendChild(retry);
    }
  }

  #finish(wasLive) {
    this.#stopTimer();
    const s = this.state;
    const dur = formatDuration((s.endedAt || now()) - (s.startedAt || now()));
    this.timerEl.textContent = dur;
    if (s.status !== "done") {
      // Interrupted / failed runs stay expanded so the partial trace remains
      // inspectable (OpenClaw keeps interrupted activity visible).
      this.setExpanded(true);
      this.chevEl.hidden = false;
      return;
    }
    // A turn with no tools or thinking is just a message — no trace card.
    const hasTrace = s.items.some((i) => i.kind === "tool" || i.kind === "thinking");
    if (!hasTrace) {
      this.card.hidden = true;
      this.jumpEl.hidden = true;
      return;
    }
    this.chevEl.hidden = false;
    if (!wasLive) this.setExpanded(false);
    else if (this.userExpanded === null) {
      this.collapseTimer = setTimeout(() => {
        if (this.state.status === "done" && this.userExpanded === null) this.setExpanded(false);
      }, 400);
    }
  }

  /* --------------------------------------------------------------- timer */

  #startTimer() {
    this.#stopTimer();
    const tick = () => {
      const s = this.state;
      if (!this.#isLive()) return;
      this.timerEl.hidden = false;
      this.timerEl.textContent = formatDuration((s.endedAt || now()) - (s.startedAt || now()));
      if (s.status === "running") this.titleEl.textContent = this.liveLabel || "Working…";
    };
    tick();
    this.timer = setInterval(tick, 1000);
  }

  #stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = 0;
  }

  /* ------------------------------------------------------------ announce */

  #announcement() {
    const s = this.state;
    if (s.status === "waiting") return "Waiting for your approval";
    if (s.status === "done") {
      const n = countSteps(s);
      return `Finished after ${formatDuration((s.endedAt || now()) - (s.startedAt || now()))}, ${n} ${n === 1 ? "step" : "steps"}`;
    }
    if (s.status === "stopped") return "Run stopped";
    if (s.status === "error") return "Run failed";
    return this.liveLabel || "Working";
  }

  #announce(text) {
    if (!text || text === this.lastAnnounced) return;
    clearTimeout(this.announceTimer);
    this.announceTimer = setTimeout(() => {
      this.lastAnnounced = text;
      this.liveEl.textContent = text;
    }, 650);
  }

  /* ------------------------------------------------------------ layout */

  #hasRunningTool() {
    return this.state.items.some(
      (i) => i.kind === "tool" && i.calls.some((c) => c.status === "running"),
    );
  }

  #layout() {
    if (!this.bodyEl) return;
    if (this.expanded) {
      this.bodyEl.style.maxHeight = `${this.bodyEl.scrollHeight || 0}px`;
    } else {
      this.bodyEl.style.maxHeight = "0px";
    }
  }

  #follow() {
    if (!this.scrollRoot) {
      this.#layout();
      return;
    }
    if (this.following) this.scrollToLatest();
    else if (this.#jumpEnabled) this.jumpEl.hidden = false;
  }

  scrollToLatest() {
    if (!this.scrollRoot) return;
    this.scrollRoot.scrollTop = this.scrollRoot.scrollHeight;
    this.jumpEl.hidden = true;
  }
}

/* ---------------------------------------------------- final-answer helpers */

/** Human-readable INPUT/OUTPUT: `key: value` prose, never raw JSON by default. */
export function formatValue(value) {
  if (value === undefined || value === null) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, 12).map((v) => (typeof v === "object" ? formatValue(v) : String(v)));
    const extra = value.length > 12 ? `\n… ${value.length - 12} more` : "";
    return items.join("\n") + extra;
  }
  if (typeof value === "object") {
    const obj = value;
    const preferred = obj.text ?? obj.message ?? obj.summary ?? obj.result;
    if (typeof preferred === "string") return preferred;
    const lines = [];
    for (const [k, v] of Object.entries(obj).slice(0, 16)) {
      lines.push(`${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
    }
    return lines.join("\n");
  }
  return String(value);
}

/** Compact result table for the final answer (tabular numbers, +/- signs). */
export function createResultTable(doc, columns, rows) {
  const table = doc.createElement("table");
  table.className = "agent-trace__table";
  const thead = doc.createElement("thead");
  const hr = doc.createElement("tr");
  for (const col of columns) {
    const th = doc.createElement("th");
    th.textContent = col;
    th.scope = "col";
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  const tbody = doc.createElement("tbody");
  for (const row of rows) {
    const tr = doc.createElement("tr");
    for (const cell of row) {
      const td = doc.createElement("td");
      if (typeof cell === "number") {
        td.classList.add("agent-trace__num");
        td.textContent =
          cell > 0 ? `+${cell.toLocaleString()}` : cell < 0 ? `−${Math.abs(cell).toLocaleString()}` : "0";
        td.classList.add(cell > 0 ? "agent-trace__pos" : cell < 0 ? "agent-trace__neg" : "agent-trace__zero");
      } else {
        td.textContent = String(cell);
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  return table;
}

/** File / attachment chip (32px tinted icon + name + muted subtitle). */
export function createFileChip(doc, name, subtitle, icon = "doc") {
  const chip = doc.createElement("a");
  chip.className = "agent-trace__file";
  chip.href = "#";
  chip.addEventListener("click", (e) => e.preventDefault());
  const tint = doc.createElement("span");
  tint.className = "agent-trace__file-icon";
  tint.appendChild(svg(icon, 16, "", doc));
  const body = doc.createElement("span");
  body.className = "agent-trace__file-body";
  const n = doc.createElement("span");
  n.className = "agent-trace__file-name";
  n.textContent = name;
  const s = doc.createElement("span");
  s.className = "agent-trace__file-sub";
  s.textContent = subtitle;
  body.append(n, s);
  chip.append(tint, body);
  return chip;
}

export default AgentTrace;
