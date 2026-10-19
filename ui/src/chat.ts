// Chat surface: transcript, streaming, tool cards, approvals, composer.

import { el, esc, fmtDuration, fmtTime } from "./dom.js";
import { renderMarkdown } from "./markdown.js";

export interface ChatHandlers {
  send(text: string): void;
  abort(): void;
  approve(callId: string, approve: boolean): void;
}

type ToolStatus = "running" | "done" | "error";

interface ToolCard {
  root: HTMLElement;
  stateEl: HTMLElement;
  status: ToolStatus;
  startedAt: number;
  timer?: number;
}

const GLYPH: Record<ToolStatus, string> = { running: "◌", done: "✓", error: "✗" };

export class Chat {
  readonly thread: HTMLElement;
  #empty: HTMLElement;
  #input: HTMLTextAreaElement;
  #sendBtn: HTMLButtonElement;
  #stopBtn: HTMLButtonElement;
  #composerBox: HTMLElement;
  #approvalBar: HTMLElement;
  #jump: HTMLElement;
  #tok: HTMLElement;
  #handlers: ChatHandlers;

  #bubble: HTMLElement | null = null;      // live streaming bubble
  #bubbleBody: HTMLElement | null = null;
  #streamText = "";
  #streamDirty = false;
  #raf = 0;
  #startedAt = 0;
  #elapsedTimer = 0;
  #autoScroll = true;
  #pendingApprovals = new Map<string, { tool: string; args: unknown }>();

  constructor(root: HTMLElement, handlers: ChatHandlers) {
    this.#handlers = handlers;
    this.thread = root.querySelector("#thread") as HTMLElement;
    this.#empty = root.querySelector("#empty-state") as HTMLElement;
    this.#input = root.querySelector("#input") as HTMLTextAreaElement;
    this.#sendBtn = root.querySelector("#send-btn") as HTMLButtonElement;
    this.#stopBtn = root.querySelector("#stop-btn") as HTMLButtonElement;
    this.#composerBox = root.querySelector(".composer-box") as HTMLElement;
    this.#approvalBar = root.querySelector("#approval-bar") as HTMLElement;
    this.#jump = root.querySelector("#jump") as HTMLElement;
    this.#tok = root.querySelector("#tok") as HTMLElement;

    const suggestions = root.querySelector("#suggestions") as HTMLElement;
    for (const s of ["What can you do?", "Summarise my workspace", "List the files here", "Set a reminder in 10 minutes"]) {
      suggestions.append(el("button", {}, [s]));
      (suggestions.lastElementChild as HTMLElement).onclick = () => {
        this.#input.value = s;
        this.#autosize();
        this.submit();
      };
    }

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

    this.thread.addEventListener("scroll", () => {
      const nearBottom = this.thread.scrollHeight - this.thread.scrollTop - this.thread.clientHeight < 90;
      this.#autoScroll = nearBottom;
      this.#jump.hidden = nearBottom;
    });
    this.#jump.onclick = () => {
      this.#autoScroll = true;
      this.thread.scrollTop = this.thread.scrollHeight;
      this.#jump.hidden = true;
    };
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
    this.#composerBox.classList.toggle("busy", busy);
    if (busy) this.#startElapsed();
    else this.#stopElapsed();
  }

  setTokenHint(text: string): void {
    this.#tok.textContent = text;
  }

  clear(): void {
    this.thread.querySelectorAll(".row, .system").forEach((n) => n.remove());
    this.#bubble = null;
    this.#bubbleBody = null;
    this.#empty.hidden = false;
  }

  /** ---- transcript writers ---- */

  user(text: string): void {
    this.#hideEmpty();
    const body = el("div", { class: "body" });
    for (const line of text.split("\n")) body.append(document.createTextNode(line + "\n"));
    body.normalize();
    // plain text, but keep line breaks
    body.innerHTML = text.split("\n").map((l) => esc(l)).join("<br>");
    this.thread.append(el("div", { class: "row" }, [el("div", { class: "msg user" }, [
      el("div", { class: "who" }, ["you"]), body,
    ])]));
    this.#scrollToBottom();
  }

  assistantStart(): void {
    this.#hideEmpty();
    if (this.#bubble) return;
    this.#streamText = "";
    this.#startedAt = Date.now();
    const body = el("div", { class: "body" });
    body.append(el("div", { class: "thinking" }, [el("i"), el("i"), el("i")]));
    const who = el("div", { class: "who" }, [
      "suparclaw",
      el("span", { class: "elapsed" }),
    ]);
    this.#bubble = el("div", { class: "msg bot" }, [who, body]);
    this.thread.append(el("div", { class: "row" }, [this.#bubble]));
    this.#bubbleBody = body;
    this.#scrollToBottom();
  }

  delta(text: string): void {
    if (!this.#bubble) this.assistantStart();
    this.#streamText += text;
    this.#streamDirty = true;
    this.#scheduleStreamRender();
  }

  /** Replace the live bubble with the final text (never appended twice). */
  finish(text?: string): void {
    if (!this.#bubble) {
      if (text) this.assistant(text);
      return;
    }
    if (text !== undefined) this.#streamText = text;
    const body = this.#bubbleBody;
    if (body) {
      body.innerHTML = renderMarkdown(this.#streamText);
      body.append(el("span", { class: "caret", style: "opacity:.55" }));
      setTimeout(() => body.querySelector(".caret")?.remove(), 900);
    }
    const elapsed = this.#bubble.querySelector(".elapsed");
    if (elapsed) elapsed.textContent = fmtDuration(Date.now() - this.#startedAt);
    this.#bubble = null;
    this.#bubbleBody = null;
    this.#streamText = "";
    this.setBusy(false);
    this.#scrollToBottom();
  }

  assistant(text: string): void {
    this.#hideEmpty();
    const body = el("div", { class: "body" });
    body.innerHTML = renderMarkdown(text);
    this.thread.append(el("div", { class: "row" }, [el("div", { class: "msg bot" }, [
      el("div", { class: "who" }, ["suparclaw"]), body,
    ])]));
    this.#scrollToBottom();
  }

  system(text: string, kind: "info" | "error" = "info"): void {
    if (!text) return;
    this.thread.append(el("div", { class: `system${kind === "error" ? " error" : ""}` }, [text]));
    this.#scrollToBottom();
  }

  tool(name: string, status: ToolStatus, detail?: string): void {
    this.#hideEmpty();
    const existing = this.thread.querySelector<HTMLElement>(`.tool[data-tool="${CSS.escape(name)}"][data-live="1"]`);
    if (existing && status === "running") return; // already shown as running

    const stateEl = el("span", { class: "state" }, [status === "running" ? "…" : ""]);
    const card = el("div", { class: `tool ${status}`, "data-tool": name }, [
      el("button", { class: "tool-head", type: "button" }, [
        el("span", { class: `glyph${status === "running" ? " spin" : ""}` }, [GLYPH[status]]),
        el("span", { class: "name" }, [name]),
        stateEl,
      ]),
      el("div", { class: "detail" }, []),
    ]);
    if (detail) (card.querySelector(".detail") as HTMLElement).append(el("pre", {}, [detail]));

    const head = card.querySelector(".tool-head") as HTMLElement;
    head.onclick = () => card.classList.toggle("open");

    const entry: ToolCard = { root: card, stateEl, status, startedAt: Date.now() };
    if (status === "running") {
      card.setAttribute("data-live", "1");
      entry.timer = window.setInterval(() => {
        stateEl.textContent = fmtDuration(Date.now() - entry.startedAt);
      }, 200);
      stateEl.textContent = "…";
    } else {
      stateEl.textContent = fmtDuration(Date.now() - entry.startedAt);
    }
    this.thread.append(el("div", { class: "row" }, [card]));
    this.#scrollToBottom();
  }

  /** ---- approvals ---- */

  approval(callId: string, tool: string, args: unknown): void {
    this.#pendingApprovals.set(callId, { tool, args });
    this.#renderApprovals();
  }

  #renderApprovals(): void {
    this.#approvalBar.innerHTML = "";
    const [callId, pending] = this.#pendingApprovals.entries().next().value ?? [];
    if (!callId || !pending) {
      this.#approvalBar.hidden = true;
      return;
    }
    this.#approvalBar.hidden = false;
    this.#approvalBar.append(
      el("span", {}, [`Allow `, el("b", {}, [pending.tool]), `?`]),
      el("span", { class: "args" }, [JSON.stringify(pending.args ?? {})]),
      el("span", { class: "grow" }),
      el("button", { class: "btn" }, ["Deny"]),
      el("button", { class: "btn primary" }, ["Allow"]),
    );
    const [deny, allow] = Array.from(this.#approvalBar.querySelectorAll("button")) as HTMLElement[];
    if (deny) deny.onclick = () => { this.#resolveApproval(callId, false); };
    if (allow) allow.onclick = () => { this.#resolveApproval(callId, true); };
  }

  #resolveApproval(callId: string, approve: boolean): void {
    this.#pendingApprovals.delete(callId);
    this.#renderApprovals();
    this.#handlers.approve(callId, approve);
    this.system(approve ? "approved" : "denied");
  }

  /** ---- internals ---- */

  #scheduleStreamRender(): void {
    if (this.#raf) return;
    this.#raf = requestAnimationFrame(() => {
      this.#raf = 0;
      if (!this.#streamDirty || !this.#bubbleBody) return;
      this.#streamDirty = false;
      const caret = el("span", { class: "caret" });
      this.#bubbleBody.innerHTML = renderMarkdown(this.#streamText);
      this.#bubbleBody.append(caret);
      const elapsed = this.#bubble?.querySelector(".elapsed");
      if (elapsed) elapsed.textContent = fmtDuration(Date.now() - this.#startedAt);
      if (this.#autoScroll) this.thread.scrollTop = this.thread.scrollHeight;
    });
  }

  #startElapsed(): void {
    this.#stopElapsed();
    this.#elapsedTimer = window.setInterval(() => {
      const elapsed = this.#bubble?.querySelector(".elapsed");
      if (elapsed) elapsed.textContent = fmtDuration(Date.now() - this.#startedAt);
    }, 250);
  }

  #stopElapsed(): void {
    if (this.#elapsedTimer) clearInterval(this.#elapsedTimer);
    this.#elapsedTimer = 0;
  }

  #hideEmpty(): void {
    this.#empty.hidden = true;
  }

  #scrollToBottom(): void {
    if (!this.#autoScroll) {
      this.#jump.hidden = false;
      return;
    }
    requestAnimationFrame(() => { this.thread.scrollTop = this.thread.scrollHeight; });
  }

  #autosize(): void {
    this.#input.style.height = "auto";
    this.#input.style.height = `${Math.min(this.#input.scrollHeight, window.innerHeight * 0.38)}px`;
  }

  get input(): HTMLTextAreaElement {
    return this.#input;
  }
}
