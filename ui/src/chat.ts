// Chat surface: transcript, streaming, tool cards, approvals, composer.
//
// Markup follows the "SuperClaw Mobile" design reference:
//   .msg.msg--user      > .bubble
//   .msg.msg--assistant > .msg__head (.msg__avatar, .msg__name, .msg__status)
//                       > .msg__tools (.tool > .tool__row + .tool__body)
//                       > .msg__body

import { el, fmtDuration, icon, toast } from "./dom.js";
import { renderMarkdown } from "./markdown.js";

/**
 * Provider errors arrive as raw JSON blobs ({"error":{"message":"..."}} or
 * [{...}]). Surface the human message instead of the JSON wall — the raw
 * text stays in storage, the UI shows what a person needs.
 */
export function prettyError(message: string): string {
  let text = message;
  for (let pass = 0; pass < 3; pass++) {
    const start = text.search(/[{[]/);
    if (start < 0) break;
    let found: string | null = null;
    try {
      const parsed: unknown = JSON.parse(text.slice(start));
      const extract = (value: unknown): string | null => {
        if (!value || typeof value !== "object") return null;
        const obj = value as Record<string, unknown>;
        if (typeof obj["message"] === "string") return obj["message"] as string;
        const inner = obj["error"] ?? (Array.isArray(obj["errors"]) ? obj["errors"][0] : undefined);
        return extract(inner);
      };
      found = Array.isArray(parsed) ? extract(parsed[0]) : extract(parsed);
    } catch {
      // Truncated blob (providers cap error bodies mid-JSON): pull the first
      // "message" string out of the debris instead of showing the wall.
      const m = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"?/.exec(text.slice(start));
      if (m?.[1]) {
        try {
          found = JSON.parse(`"${m[1]}"`);
        } catch {
          found = m[1];
        }
      }
    }
    if (!found || found === text.slice(start)) break;
    text = (start > 0 ? text.slice(0, start).trim().replace(/[:\s]+$/, "") + ": " : "") + found;
  }
  return text;
}

export interface ChatHandlers {
  send(text: string): void;
  abort(): void;
  approve(callId: string, approve: boolean): void;
}

type ToolStatus = "running" | "done" | "error" | "pending";

const SPARKLE =
  '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/></svg>';

const CHECK =
  '<svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

const CROSS =
  '<svg aria-hidden="true" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

const PAUSE =
  '<svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"><path d="M9 6v12M15 6v12"/></svg>';

const SPINNER =
  '<svg class="spin" aria-label="Running" role="img" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="9" opacity=".25"/><path d="M21 12a9 9 0 0 0-9-9"/></svg>';

const CHEVRON =
  '<svg class="tool__chev" aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';

const CHIPS = [
  "Explain this repository",
  "Find and fix a failing test",
  "Review my last diff",
];

interface Live {
  root: HTMLElement;
  head: HTMLElement;
  status: HTMLElement;
  tools: HTMLElement;
  body: HTMLElement;
  thought?: ThoughtBlock;
  startedAt: number;
}

interface ThoughtBlock {
  root: HTMLElement;
  body: HTMLElement;
  status: HTMLElement;
  text: string;
}

export class Chat {
  readonly stack: HTMLElement;
  #thread: HTMLElement;
  #input: HTMLTextAreaElement;
  #sendBtn: HTMLButtonElement;
  #stopBtn: HTMLButtonElement;
  #composer: HTMLElement;
  #approval: HTMLElement;
  #jump: HTMLElement;
  #tok: HTMLElement;
  #handlers: ChatHandlers;

  #live: Live | null = null;
  #streamText = "";
  #streamDirty = false;
  #raf = 0;
  #autoScroll = true;
  #toolStart = new Map<string, number>();
  #pendingApprovals = new Map<string, { tool: string; args: unknown }>();

  constructor(root: HTMLElement, handlers: ChatHandlers) {
    this.#handlers = handlers;
    this.stack = root.querySelector("#stack") as HTMLElement;
    this.#thread = root.querySelector("#thread") as HTMLElement;
    this.#input = root.querySelector("#input") as HTMLTextAreaElement;
    this.#sendBtn = root.querySelector("#send-btn") as HTMLButtonElement;
    this.#stopBtn = root.querySelector("#stop-btn") as HTMLButtonElement;
    this.#composer = root.querySelector("#composer") as HTMLElement;
    this.#approval = root.querySelector("#approval") as HTMLElement;
    this.#jump = root.querySelector("#jump") as HTMLElement;
    this.#tok = root.querySelector("#tok") as HTMLElement;

    this.#renderEmpty();

    this.#input.addEventListener("input", () => {
      this.#autosize();
      this.#sendBtn.disabled = this.#input.value.trim().length === 0;
    });
    this.#input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.submit();
      }
    });
    this.#sendBtn.onclick = () => this.submit();
    this.#stopBtn.onclick = () => this.#handlers.abort();

    this.#thread.addEventListener("scroll", () => {
      const nearBottom = this.#thread.scrollHeight - this.#thread.scrollTop - this.#thread.clientHeight < 80;
      this.#autoScroll = nearBottom;
      this.#jump.hidden = nearBottom;
    });
    this.#jump.onclick = () => {
      this.#autoScroll = true;
      this.#thread.scrollTop = this.#thread.scrollHeight;
      this.#jump.hidden = true;
    };

    // copy a message
    this.stack.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const copy = target.closest<HTMLElement>("[data-copy]");
      if (!copy) return;
      const msg = copy.closest<HTMLElement>(".msg");
      const text = msg?.querySelector<HTMLElement>(".msg__body, .bubble")?.innerText ?? "";
      void navigator.clipboard?.writeText(text).then(
        () => toast("copied to clipboard", "ok"),
        () => toast("copy failed", "err"),
      );
    });
  }

  submit(): void {
    const text = this.#input.value.trim();
    if (!text) return;
    this.#input.value = "";
    this.#autosize();
    this.#sendBtn.disabled = true;
    this.#handlers.send(text);
  }

  setBusy(busy: boolean): void {
    this.#stopBtn.hidden = !busy;
    this.#sendBtn.hidden = busy;
    this.#sendBtn.disabled = busy || this.#input.value.trim().length === 0;
    if (busy) this.#input.focus();
  }

  setTokenHint(text: string): void {
    this.#tok.textContent = text;
  }

  clear(): void {
    this.stack.innerHTML = "";
    this.#live = null;
    this.#looseThought = null;
    this.#streamText = "";
    this.#renderEmpty();
  }

  /**
   * Replace the transcript with fetched history rows — the ONLY safe way to
   * reload a thread. A run that is still streaming keeps its bubble (history
   * predates it), one bad row cannot kill the rest, and an empty result shows
   * the empty state rather than a blank screen.
   *
   * Rows replay as ONE assistant bubble per turn — the same layout the live
   * stream produces (thought block(s) → tool cards → answer body). Row-by-row
   * replay used to scatter every tool card into its own "Assistant Tools"
   * bubble with thinking floating between them.
   */
  replaceThread(rows: { role: string; content: string }[]): number {
    const live = this.#live;
    const liveText = this.#streamText;
    this.stack.innerHTML = "";
    this.#live = null;
    this.#looseThought = null;
    this.#streamText = "";
    let rendered = 0;

    type ReplayTool = { name: string; status: ToolStatus; detail: string; ms?: number; key: string };
    type TurnGroup = { thoughts: string[]; tools: ReplayTool[]; text: string };
    let group: TurnGroup | null = null;
    const newGroup = (): TurnGroup => ({ thoughts: [], tools: [], text: "" });
    const flushGroup = (): void => {
      if (!group) return;
      const has = group.text || group.tools.length > 0 || group.thoughts.length > 0;
      if (has) this.#renderTurn(group);
      group = null;
    };

    for (const [index, row] of rows.entries()) {
      try {
        if (row.role === "user") {
          flushGroup();
          this.user(row.content);
          rendered++;
        } else if (row.role === "assistant" && row.content) {
          group ??= newGroup();
          group.text += (group.text ? "\n\n" : "") + row.content;
          rendered++;
        } else if (row.role === "tool" && row.content) {
          // Persisted tool row: "→ name · 6ms\n<output>"
          const lines = row.content.split("\n");
          const head = (lines[0] ?? "").replace(/^→\s*/, "");
          const timed = head.match(/^(.*?)\s*·\s*(\d+)ms$/);
          const name = (timed?.[1] ?? head).trim() || "tool";
          const duration = timed?.[2] ? Number(timed[2]) : undefined;
          const output = lines.slice(1).join("\n");
          group ??= newGroup();
          group.tools.push({
            name,
            status: output.startsWith("error") ? "error" : "done",
            detail: output,
            ms: duration,
            key: `row-${index}`,
          });
          rendered++;
        } else if (row.role === "error" && row.content) {
          // fail() with no live bubble renders the same "error: …" notice the
          // user saw live — errors were live-only and vanished on refresh.
          flushGroup();
          this.fail(row.content);
          rendered++;
        } else if (row.role === "reasoning" && row.content) {
          group ??= newGroup();
          group.thoughts.push(row.content);
          rendered++;
        }
      } catch {
        /* one bad message must not take the thread with it */
      }
    }
    flushGroup();
    if (rendered === 0) this.#renderEmpty();
    if (live) {
      this.assistantStart();
      this.delta(liveText);
    }
    return rendered;
  }

  /** One assistant turn: thought block(s) → tool cards → answer body (live order). */
  #renderTurn(group: { thoughts: string[]; tools: { name: string; status: ToolStatus; detail: string; ms?: number; key: string }[]; text: string }): void {
    const status = group.text ? "Done" : group.tools.length > 0 ? "Tools" : "Thinking";
    const head = this.#head(status);
    const tools = el("div", { class: "msg__tools" });
    const body = el("div", { class: "msg__body" });
    if (group.text) body.innerHTML = renderMarkdown(group.text);
    const root = el("div", { class: "msg msg--assistant" }, [head, tools, body]);
    for (const thought of group.thoughts) {
      const block = this.#thought();
      block.text = thought;
      block.body.innerHTML = renderMarkdown(thought);
      root.insertBefore(block.root, tools);
    }
    this.stack.append(root);
    for (const t of group.tools) {
      this.tool(t.name, t.status, t.detail, t.ms, t.key, tools);
    }
    this.#scrollToBottom();
  }

  /** ---- transcript writers ---- */

  user(text: string): void {
    this.#clearEmpty();
    const bubble = el("div", { class: "bubble" });
    bubble.textContent = text;
    this.stack.append(el("div", { class: "msg msg--user" }, [bubble]));
    this.#scrollToBottom();
  }

  assistantStart(): void {
    this.#clearEmpty();
    if (this.#live) return;
    const head = this.#head("Thinking");
    const tools = el("div", { class: "msg__tools" });
    const body = el("div", { class: "msg__body" }, [
      el("div", { class: "dots", role: "status", "aria-label": "Thinking" }, [
        el("span"), el("span"), el("span"),
      ]),
    ]);
    const root = el("div", { class: "msg msg--assistant" }, [head, tools, body]);
    // Thinking that arrived before the bubble opened moves INSIDE it — the
    // turn is one visual unit (thought → tools → answer), live and on replay.
    const loose = this.#looseThought;
    if (loose) root.insertBefore(loose.root, tools);
    this.stack.append(root);
    this.#live = {
      root, head, status: head.querySelector(".msg__status") as HTMLElement,
      tools, body, startedAt: Date.now(),
      thought: loose ?? undefined,
    };
    this.#looseThought = null;
    this.#scrollToBottom();
  }

  delta(text: string): void {
    if (!this.#live) this.assistantStart();
    this.#streamText += text;
    this.#streamDirty = true;
    this.#scheduleStreamRender();
  }

  finish(text?: string): void {
    if (!this.#live) {
      if (text) this.assistant(text);
      return;
    }
    if (text !== undefined) this.#streamText = text;
    const live = this.#live;
    live.body.innerHTML = renderMarkdown(this.#streamText);
    live.status.textContent = "Done";
    live.status.classList.remove("is-live");
    if (live.thought) live.thought.status.textContent = "";
    this.#live = null;
    this.#looseThought = null;
    this.#streamText = "";
    this.setBusy(false);
    this.#scrollToBottom();
  }

  /** A run that died: keep the partial text, but never label it "Done". */
  fail(message: string): void {
    const pretty = prettyError(message);
    this.notice(`error: ${pretty}`, "notice--error");
    if (!this.#live) return;
    const live = this.#live;
    live.body.innerHTML = renderMarkdown(this.#streamText);
    live.status.textContent = `Error · ${pretty.slice(0, 80)}`;
    live.status.classList.remove("is-live");
    live.status.classList.add("is-error");
    this.#live = null;
    this.#looseThought = null;
    this.#streamText = "";
    this.setBusy(false);
    this.#scrollToBottom();
  }

  assistant(text: string): void {
    this.#clearEmpty();
    const head = this.#head("Done");
    const body = el("div", { class: "msg__body" });
    body.innerHTML = renderMarkdown(text);
    this.stack.append(el("div", { class: "msg msg--assistant" }, [head, body]));
    this.#scrollToBottom();
  }

  notice(text: string, variant?: string): void {
    this.#clearEmpty();
    this.stack.append(el("div", { class: variant ? `notice mono ${variant}` : "notice mono" }, [text]));
    this.#scrollToBottom();
  }

  tool(name: string, status: ToolStatus, detail?: string, ms?: number, key?: string, host?: HTMLElement): void {
    this.#clearEmpty();
    // Cards are keyed per call (callId live, synthetic on replay) — consecutive
    // calls of the same tool must each get their own pill. running→done of one
    // call share a key and land on the same card.
    const cardKey = key ?? name;
    let card = this.stack.querySelector<HTMLElement>(`.tool[data-tool="${CSS.escape(cardKey)}"]`);
    if (!card) {
      const started = Date.now();
      this.#toolStart.set(cardKey, started);
      const row = el("button", { class: "tool__row", type: "button", "aria-expanded": "false" }, [
        icon(SPINNER, "tool__icon tool__icon--run"),
        el("span", { class: "tool__name" }, [name]),
        el("span", { class: "tool__summary" }, [""]),
        el("span", { class: "tool__dur" }, ["…"]),
        icon(CHEVRON),
      ]);
      const body = el("div", { class: "tool__body", hidden: "" });
      row.onclick = () => {
        const open = row.getAttribute("aria-expanded") !== "true";
        row.setAttribute("aria-expanded", String(open));
        body.hidden = !open;
      };
      card = el("div", { class: "tool", "data-tool": cardKey }, [row, body]);
      const target = host ?? this.#live?.tools ?? null;
      if (target) {
        target.append(card);
      } else {
        const head = this.#head("Tools");
        const tools = el("div", { class: "msg__tools" }, [card]);
        this.stack.append(el("div", { class: "msg msg--assistant" }, [head, tools]));
      }
    }

    const iconBox = card.querySelector(".tool__icon") as HTMLElement;
    const summary = card.querySelector(".tool__summary") as HTMLElement;
    const dur = card.querySelector(".tool__dur") as HTMLElement;
    const body = card.querySelector(".tool__body") as HTMLElement;

    const elapsed = ms ?? Date.now() - (this.#toolStart.get(cardKey) ?? Date.now());
    if (status === "running") {
      iconBox.className = "tool__icon tool__icon--run";
      iconBox.innerHTML = SPINNER;
      dur.textContent = "…";
    } else if (status === "done") {
      iconBox.className = "tool__icon tool__icon--ok";
      iconBox.innerHTML = CHECK;
      dur.textContent = fmtDuration(elapsed);
    } else if (status === "pending") {
      iconBox.className = "tool__icon tool__icon--wait";
      iconBox.innerHTML = PAUSE;
      dur.textContent = "waiting";
    } else {
      iconBox.className = "tool__icon tool__icon--err";
      iconBox.innerHTML = CROSS;
      dur.textContent = "failed";
    }

    if (detail) {
      summary.textContent = detail.split("\n")[0]!.slice(0, 80);
      body.innerHTML = "";
      body.append(el("div", {}, [
        el("div", { class: "tool__label" }, ["Output"]),
        el("pre", {}, [detail]),
      ]));
    }
    this.#scrollToBottom();
  }

  /* ---- thinking preview (always visible — never collapsed, never toggled) ---- */

  /** Thinking block shared by live streams and history replay. Body is always
   * shown: the preview must never hide what the model is thinking (the user
   * rejected both the on/off toggle and collapsed-by-default blocks). */
  #thought(): ThoughtBlock {
    const body = el("div", { class: "thought__body" });
    const status = el("span", { class: "thought__status mono" }, ["Thinking…"]);
    const head = el(
      "div",
      { class: "thought__row" },
      [icon(SPARKLE), el("span", { class: "thought__title" }, ["Thinking"]), status],
    );
    const root = el("div", { class: "thought" }, [head, body]);
    return { root, body, status, text: "" };
  }

  /**
   * Stream a thinking fragment. Lands in the live bubble's thought block
   * (positioned above the tools/answer), or as its own block if the run has
   * not opened a bubble yet — fragments accumulate into ONE visible block.
   */
  reasoningDelta(text: string): void {
    if (!this.#live) {
      if (!this.#looseThought) {
        this.#looseThought = this.#thought();
        this.#clearEmpty();
        this.stack.append(this.#looseThought.root);
      }
      const block = this.#looseThought;
      block.text += text;
      block.status.textContent = "Thinking…";
      this.#scheduleThoughtRender(block);
      return;
    }
    const live = this.#live;
    if (!live.thought) {
      const block = this.#thought();
      live.thought = block;
      live.root.insertBefore(block.root, live.tools);
    }
    const block = live.thought;
    block.text += text;
    block.status.textContent = "Thinking…";
    this.#scheduleThoughtRender(block);
  }

  /** Standalone thinking block reused across fragments until the run ends. */
  #looseThought: ThoughtBlock | null = null;

  #thoughtPending = new Set<ThoughtBlock>();
  #thoughtFrame = 0;

  #scheduleThoughtRender(block: ThoughtBlock): void {
    this.#thoughtPending.add(block);
    if (this.#thoughtFrame) return;
    this.#thoughtFrame = requestAnimationFrame(() => {
      this.#thoughtFrame = 0;
      for (const b of this.#thoughtPending) {
        b.body.innerHTML = renderMarkdown(b.text);
      }
      this.#thoughtPending.clear();
      this.#scrollToBottom();
    });
  }

  /** A complete, saved thinking segment (history replay) — always visible. */
  reasoning(text: string): void {
    this.#clearEmpty();
    const block = this.#thought();
    block.text = text;
    block.body.innerHTML = renderMarkdown(text);
    block.status.textContent = "";
    this.stack.append(block.root);
    this.#scrollToBottom();
  }

  /** ---- approvals ---- */

  approval(callId: string, tool: string, args: unknown): void {
    this.#pendingApprovals.set(callId, { tool, args });
    this.#renderApprovals();
  }

  #renderApprovals(): void {
    const first = this.#pendingApprovals.entries().next().value as
      | [string, { tool: string; args: unknown }]
      | undefined;
    if (!first) {
      this.#approval.hidden = true;
      this.#composer.classList.remove("composer--attached");
      return;
    }
    const [callId, pending] = first;
    this.#approval.hidden = false;
    this.#composer.classList.add("composer--attached");
    (document.getElementById("approval-tool") as HTMLElement).textContent = pending.tool;
    (document.getElementById("approval-args") as HTMLElement).textContent =
      typeof pending.args === "string" ? pending.args : JSON.stringify(pending.args ?? {});
    (document.getElementById("approval-deny") as HTMLElement).onclick = () => this.#resolve(callId, false);
    (document.getElementById("approval-allow") as HTMLElement).onclick = () => this.#resolve(callId, true);
  }

  #resolve(callId: string, approve: boolean): void {
    this.#pendingApprovals.delete(callId);
    this.#renderApprovals();
    this.#handlers.approve(callId, approve);
    this.notice(approve ? "approved" : "denied");
  }

  /** ---- internals ---- */

  #head(status: string): HTMLElement {
    const statusEl = el("span", { class: "msg__status mono" }, [status]);
    return el("div", { class: "msg__head" }, [
      icon(SPARKLE, "msg__avatar"),
      el("span", { class: "msg__name" }, ["Assistant"]),
      statusEl,
    ]);
  }

  #renderEmpty(): void {
    const chips = el("div", { class: "chips" });
    for (const label of CHIPS) {
      const chip = el("button", { class: "chip", type: "button" }, [label]);
      chip.onclick = () => {
        this.#input.value = label;
        this.#autosize();
        this.#sendBtn.disabled = false;
        this.#input.focus();
      };
      chips.append(chip);
    }
    this.stack.append(el("div", { class: "empty" }, [
      mark(),
      el("h1", {}, ["What are we building?"]),
      el("p", {}, ["Ask anything, or pick a starting point. Tools ask before they run."]),
      chips,
    ]));
  }

  #clearEmpty(): void {
    this.stack.querySelector(".empty")?.remove();
  }

  #scheduleStreamRender(): void {
    if (this.#raf) return;
    this.#raf = requestAnimationFrame(() => {
      this.#raf = 0;
      if (!this.#streamDirty || !this.#live) return;
      this.#streamDirty = false;
      const live = this.#live;
      live.body.innerHTML = renderMarkdown(this.#streamText);
      live.body.append(el("span", { class: "caret" }));
      live.status.textContent = `Streaming · ${mmss(Date.now() - live.startedAt)}`;
      live.status.classList.add("is-live");
      if (this.#autoScroll) this.#thread.scrollTop = this.#thread.scrollHeight;
    });
  }

  #scrollToBottom(): void {
    if (!this.#autoScroll) {
      this.#jump.hidden = false;
      return;
    }
    requestAnimationFrame(() => { this.#thread.scrollTop = this.#thread.scrollHeight; });
  }

  #autosize(): void {
    this.#input.style.height = "auto";
    this.#input.style.height = `${Math.min(this.#input.scrollHeight, 140)}px`;
  }

  get input(): HTMLTextAreaElement {
    return this.#input;
  }
}

function mark(): HTMLElement {
  const node = el("div", { class: "empty__mark" });
  node.innerHTML =
    '<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h5l3-8 3 16 3-8h4"/></svg>';
  return node;
}

function mmss(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
