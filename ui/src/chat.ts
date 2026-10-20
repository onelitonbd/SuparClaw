// Chat surface: transcript groups, streaming, tool cards, approvals, composer.
//
// The DOM follows OpenClaw's Control UI anatomy (ui/src/pages/chat/**):
//   .chat-group(.user|.assistant|.tool).chat-group--with-footer
//     > .chat-avatar
//     > .chat-group-messages > .chat-bubble > .chat-text
//     > .chat-group-footer > .chat-group-footer__meta / .chat-group-footer-actions
// Tool calls render as .chat-bubble--tool-shell > .chat-tools-inline with a
// .chat-inline-disclosure toggle and a .chat-tool-msg-body panel.

import { el, esc, fmtDuration, fmtTime, toast } from "./dom.js";
import { renderMarkdown } from "./markdown.js";

export interface ChatHandlers {
  send(text: string): void;
  abort(): void;
  approve(callId: string, approve: boolean): void;
}

type ToolStatus = "running" | "done" | "error";

const GLYPH: Record<ToolStatus, string> = { running: "◌", done: "✓", error: "✗" };

const SUGGESTIONS = [
  "What can you do?",
  "Summarise my workspace",
  "List the files here",
  "Set a reminder in 10 minutes",
];

interface Live {
  group: HTMLElement;
  messages: HTMLElement;
  bubble: HTMLElement;
  text: HTMLElement | null;
  stamp: HTMLElement;
  startedAt: number;
}

export class Chat {
  readonly thread: HTMLElement;
  #empty: HTMLElement;
  #input: HTMLTextAreaElement;
  #sendBtn: HTMLButtonElement;
  #stopBtn: HTMLButtonElement;
  #composerShell: HTMLElement;
  #approvalBar: HTMLElement;
  #jump: HTMLElement;
  #tok: HTMLElement;
  #handlers: ChatHandlers;

  #live: Live | null = null;
  #streamText = "";
  #streamDirty = false;
  #raf = 0;
  #autoScroll = true;
  #pendingApprovals = new Map<string, { tool: string; args: unknown }>();

  constructor(root: HTMLElement, handlers: ChatHandlers) {
    this.#handlers = handlers;
    this.thread = root.querySelector("#thread") as HTMLElement;
    this.#empty = root.querySelector("#empty-state") as HTMLElement;
    this.#input = root.querySelector("#input") as HTMLTextAreaElement;
    this.#sendBtn = root.querySelector("#send-btn") as HTMLButtonElement;
    this.#stopBtn = root.querySelector("#stop-btn") as HTMLButtonElement;
    this.#composerShell = root.querySelector(".agent-chat__composer-shell") as HTMLElement;
    this.#approvalBar = root.querySelector("#approval-bar") as HTMLElement;
    this.#jump = root.querySelector("#jump") as HTMLElement;
    this.#tok = root.querySelector("#tok") as HTMLElement;

    const suggestions = root.querySelector("#suggestions") as HTMLElement;
    for (const s of SUGGESTIONS) {
      const btn = el("button", { class: "agent-chat__suggestion", type: "button" }, [s]);
      btn.onclick = () => {
        this.#input.value = s;
        this.#autosize();
        this.submit();
      };
      suggestions.append(btn);
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

    // code block chrome: soft wrap + expand, message copy
    this.thread.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const wrap = target.closest<HTMLElement>(".code-block-wrap");
      if (wrap) {
        const box = wrap.closest<HTMLElement>(".code-block-wrapper");
        box?.classList.toggle("is-wrapped");
        return;
      }
      const expand = target.closest<HTMLElement>(".code-block-expand");
      if (expand) {
        const box = expand.closest<HTMLElement>(".code-block-wrapper");
        if (!box) return;
        const open = box.classList.toggle("is-expanded");
        expand.firstChild!.textContent = open ? "show less" : "show more";
        return;
      }
      const copy = target.closest<HTMLElement>(".chat-copy-btn");
      if (copy) {
        const group = copy.closest<HTMLElement>(".chat-group");
        const text = group?.querySelector<HTMLElement>(".chat-text")?.innerText ?? "";
        void navigator.clipboard?.writeText(text).then(
          () => toast("copied to clipboard"),
          () => toast("copy failed", "error"),
        );
      }
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
    this.#composerShell.classList.toggle("sc-busy", busy);
    if (busy) this.#input.focus();
  }

  setTokenHint(text: string): void {
    this.#tok.textContent = text;
  }

  clear(): void {
    this.thread.querySelectorAll(".chat-group, .sc-system").forEach((n) => n.remove());
    this.#live = null;
    this.#streamText = "";
    this.#empty.hidden = false;
  }

  /** ---- transcript writers ---- */

  user(text: string): void {
    this.#hideEmpty();
    const { group, messages } = this.#makeGroup("user");
    const bubble = el("div", { class: "chat-bubble chat-bubble--first" });
    const body = el("div", { class: "chat-text" });
    body.innerHTML = text.split("\n").map((l) => esc(l)).join("<br>");
    bubble.append(body);
    messages.append(bubble);
    this.#stampFooter(group);
    this.thread.append(group);
    this.#scrollToBottom();
  }

  assistantStart(): void {
    this.#hideEmpty();
    if (this.#live) return;
    const { group, messages } = this.#makeGroup("assistant");
    const bubble = el("div", { class: "chat-bubble chat-bubble--first" });
    const thinking = el("div", { class: "chat-thinking" }, [
      el("span", { class: "chat-bubble-dots chat-bubble-dots--working" }, [
        el("span"), el("span"), el("span"),
      ]),
    ]);
    bubble.append(thinking);
    messages.append(bubble);
    const stamp = this.#stampFooter(group);
    this.thread.append(group);
    this.#live = { group, messages, bubble, text: null, stamp, startedAt: Date.now() };
    this.#scrollToBottom();
  }

  delta(text: string): void {
    if (!this.#live) this.assistantStart();
    this.#streamText += text;
    this.#streamDirty = true;
    this.#scheduleStreamRender();
  }

  /** Replace the live bubble with the final text (never appended twice). */
  finish(text?: string): void {
    if (!this.#live) {
      if (text) this.assistant(text);
      return;
    }
    if (text !== undefined) this.#streamText = text;
    const live = this.#live;
    this.#renderStream(live, true);
    live.stamp.classList.remove("sc-live");
    live.stamp.textContent = `${fmtTime(live.startedAt)} · ${fmtDuration(Date.now() - live.startedAt)}`;
    this.#live = null;
    this.#streamText = "";
    this.setBusy(false);
    this.#scrollToBottom();
  }

  assistant(text: string): void {
    this.#hideEmpty();
    const { group, messages } = this.#makeGroup("assistant");
    const bubble = el("div", { class: "chat-bubble chat-bubble--first" });
    const body = el("div", { class: "chat-text" });
    body.innerHTML = renderMarkdown(text);
    bubble.append(body);
    messages.append(bubble);
    this.#stampFooter(group);
    this.thread.append(group);
    this.#scrollToBottom();
  }

  system(text: string, kind: "info" | "error" = "info"): void {
    if (!text) return;
    const notice = el("div", { class: "sc-system" }, [
      el("div", { class: `chat-notice${kind === "error" ? " sc-error" : ""}` }, [text]),
    ]);
    this.thread.append(notice);
    this.#scrollToBottom();
  }

  tool(name: string, status: ToolStatus, detail?: string): void {
    this.#hideEmpty();
    const key = `${name}`;
    const live = this.#live;
    let shell = live
      ? live.messages.querySelector<HTMLElement>(`.chat-bubble--tool-shell[data-tool="${CSS.escape(key)}"]`)
      : null;

    if (!shell) {
      const { group, messages } = live
        ? { group: live.group, messages: live.messages }
        : this.#makeGroup("tool");
      shell = el("div", { class: "chat-bubble chat-bubble--tool-shell", "data-tool": key });
      const tools = el("div", { class: "chat-tools-inline" });
      const toggle = el("button", { class: "chat-inline-disclosure", type: "button", "aria-expanded": "false" });
      const summary = el("span", { class: "chat-tool-msg-summary" }, [
        el("span", { class: "chat-tool-msg-summary__icon" }, [GLYPH.running]),
        el("span", { class: "chat-tool-msg-summary__label" }, [name]),
        el("span", { class: "chat-tool-msg-summary__preview" }, [""]),
      ]);
      const chevron = el("span", { class: "chat-tool-row__chevron" }, ["▸"]);
      toggle.append(summary, chevron);
      const body = el("div", { class: "chat-tool-msg-body", hidden: "" });
      toggle.onclick = () => {
        const open = toggle.getAttribute("aria-expanded") !== "true";
        toggle.setAttribute("aria-expanded", String(open));
        body.hidden = !open;
      };
      tools.append(toggle);
      shell.append(tools, body);
      messages.append(shell);
      if (!live) {
        this.#stampFooter(group);
        this.thread.append(group);
      }
    }

    const icon = shell.querySelector(".chat-tool-msg-summary__icon") as HTMLElement;
    const preview = shell.querySelector(".chat-tool-msg-summary__preview") as HTMLElement;
    const body = shell.querySelector(".chat-tool-msg-body") as HTMLElement;
    icon.textContent = GLYPH[status];
    shell.dataset.status = status;
    if (detail) {
      preview.textContent = detail.split("\n")[0]!.slice(0, 80);
      const out = el("div", { class: "chat-text" });
      out.textContent = detail;
      body.innerHTML = "";
      body.append(out);
    }
    this.#scrollToBottom();
  }

  /** ---- approvals ---- */

  approval(callId: string, tool: string, args: unknown): void {
    this.#pendingApprovals.set(callId, { tool, args });
    this.#renderApprovals();
  }

  #renderApprovals(): void {
    this.#approvalBar.innerHTML = "";
    const first = this.#pendingApprovals.entries().next().value as
      | [string, { tool: string; args: unknown }]
      | undefined;
    if (!first) {
      this.#approvalBar.hidden = true;
      return;
    }
    const [callId, pending] = first;
    this.#approvalBar.hidden = false;
    this.#approvalBar.dataset.tone = "warn";
    const band = el("div", { class: "agent-chat__composer-status-band" }, [
      el("span", { class: "agent-chat__composer-status-icon" }, ["!"]),
      el("span", { class: "agent-chat__composer-status-text" }, [`Allow ${pending.tool}?`]),
      el("span", { class: "sc-approval-args" }, [JSON.stringify(pending.args ?? {})]),
    ]);
    const actions = el("span", { class: "sc-approval-actions" });
    const deny = el("button", { class: "btn btn--sm", type: "button" }, ["Deny"]);
    const allow = el("button", { class: "btn primary btn--sm", type: "button" }, ["Allow"]);
    deny.onclick = () => this.#resolveApproval(callId, false);
    allow.onclick = () => this.#resolveApproval(callId, true);
    actions.append(deny, allow);
    band.append(actions);
    this.#approvalBar.append(band);
  }

  #resolveApproval(callId: string, approve: boolean): void {
    this.#pendingApprovals.delete(callId);
    this.#renderApprovals();
    this.#handlers.approve(callId, approve);
    this.system(approve ? "approved" : "denied");
  }

  /** ---- internals ---- */

  #makeGroup(kind: "user" | "assistant" | "tool"): { group: HTMLElement; messages: HTMLElement } {
    const avatar =
      kind === "user"
        ? el("span", { class: "chat-avatar user" }, ["Y"])
        : kind === "tool"
          ? el("span", { class: "chat-avatar tool" }, ["⚙"])
          : el("span", { class: "chat-avatar assistant" }, ["✳"]);
    const messages = el("div", { class: "chat-group-messages" });
    const group = el("div", { class: `chat-group ${kind} chat-group--with-footer chat-group--turn-block` }, [
      avatar,
      messages,
    ]);
    return { group, messages };
  }

  #stampFooter(group: HTMLElement): HTMLElement {
    const stamp = el("span", { class: "chat-group-timestamp" }, [fmtTime(Date.now())]);
    const footer = el("div", { class: "chat-group-footer" }, [
      el("div", { class: "chat-group-footer__meta" }, [stamp]),
      el("div", { class: "chat-group-footer-actions" }, [
        el("button", { class: "btn btn--icon btn--xs chat-copy-btn", type: "button", title: "Copy" }, ["⧉"]),
      ]),
    ]);
    group.append(footer);
    return stamp;
  }

  #scheduleStreamRender(): void {
    if (this.#raf) return;
    this.#raf = requestAnimationFrame(() => {
      this.#raf = 0;
      if (!this.#streamDirty || !this.#live) return;
      this.#streamDirty = false;
      this.#renderStream(this.#live, false);
      if (this.#autoScroll) this.thread.scrollTop = this.thread.scrollHeight;
    });
  }

  #renderStream(live: Live, final: boolean): void {
    if (!live.text) {
      live.bubble.innerHTML = "";
      live.text = el("div", { class: "chat-text" });
      live.bubble.append(live.text);
    }
    live.text.innerHTML = renderMarkdown(this.#streamText);
    if (!final) {
      live.text.append(el("span", { class: "caret" }));
      live.stamp.classList.add("sc-live");
      live.stamp.textContent = `${fmtTime(live.startedAt)} · ${fmtDuration(Date.now() - live.startedAt)}`;
    }
    // mark code blocks that scroll horizontally so the wrap toggle shows up
    for (const box of live.text.querySelectorAll<HTMLElement>(".code-block-wrapper")) {
      const code = box.querySelector("code");
      if (!code) continue;
      const overflow = code.scrollWidth > code.clientWidth + 2;
      box.classList.toggle("has-horizontal-overflow", overflow);
    }
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
