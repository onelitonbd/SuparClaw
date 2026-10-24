// Chat surface: transcript, streaming, tool cards, approvals, composer.
//
// Markup follows the "SuperClaw Mobile" design reference:
//   .msg.msg--user      > .bubble
//   .msg.msg--assistant > .msg__head (.msg__avatar, .msg__name, .msg__status)
//                       > .msg__tools (.tool > .tool__row + .tool__body)
//                       > .msg__body

import { askOnceOnFirstSend } from "./notifications.js";
import { el, icon, toast } from "./dom.js";
import { renderMarkdown } from "./markdown.js";
import { AgentTrace, formatValue } from "./trace/agent-trace.js";
import type { TraceItem } from "./trace/types.js";

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

export interface StagedAttachment {
  name: string;
  mime: string;
  size: number;
  dataUrl: string;
  /** Browser-side rejection kept visible beside the composer (their rule). */
  error?: string;
}

export interface ChatHandlers {
  send(text: string, attachments?: StagedAttachment[]): void;
  abort(): void;
  approve(callId: string, decision: "once" | "always" | "deny"): void;
  cancelQueued(runId: string): void;
  questionAnswer(id: string, answers: Record<string, string[]>): void;
}

type ToolStatus = "running" | "done" | "error" | "pending" | "skipped";

// WebChat uploads (P3 #28) — mirror the gateway's web-attachments.ts caps so
// rejections happen client-side with the file still staged.
const ATTACH_MAX_FILES = 4;
const ATTACH_MAX_FILE = 8 * 1048576;
const ATTACH_MAX_TOTAL = 12 * 1048576;
const IMAGE_RE = /^image\/(png|jpe?g|webp|gif)$/i;
const FILE_ICON =
  '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';

const CHIPS = [
  "Explain this repository",
  "Find and fix a failing test",
  "Review my last diff",
];

const TOOL_LABELS: Record<string, string> = {
  ask_user: "Asking you",
  cautious: "Checking safety",
  config: "Updating config",
  cron: "Scheduling",
  exec: "Running command",
  fs_edit: "Editing file",
  fs_list: "Listing files",
  fs_read: "Reading file",
  fs_write: "Writing file",
  hooks: "Managing hooks",
  memory_append: "Saving memory",
  memory_search: "Searching memory",
  model: "Switching model",
  pdf: "Reading PDF",
  session_send: "Sending to session",
  sessions_spawn: "Spawning sub-agent",
  sessions_yield: "Yielding to sub-agent",
  skill_list: "Listing skills",
  skill_read: "Reading skill",
  skill_save: "Saving skill",
  skills: "Managing skills",
  store: "Storing data",
  subagents: "Managing sub-agents",
  telegram: "Telegram action",
  time_now: "Checking time",
  tools: "Managing tools",
  wait: "Waiting",
  web_fetch: "Fetching page",
  web_search: "Searching the web",
  workspace: "Workspace action",
};

interface Live {
  startedAt: number;
}

interface LiveBody {
  root: HTMLElement;
  body: HTMLElement;
}

export class Chat {
  readonly stack: HTMLElement;
  #thread: HTMLElement;
  #input: HTMLTextAreaElement;
  #sendBtn: HTMLButtonElement;
  #stopBtn: HTMLButtonElement;
  #composer: HTMLElement;
  #attachStrip: HTMLElement;
  #attachBtn: HTMLButtonElement;
  #attachInput: HTMLInputElement;
  #staged: StagedAttachment[] = [];
  #approval: HTMLElement;
  #qrow: HTMLElement;
  /** Waiting queue items by runId (rendered above the composer). */
  #queueItems = new Map<string, { text: string; at: number }>();
  #jump: HTMLElement;
  #tok: HTMLElement;
  #handlers: ChatHandlers;

  #live: Live | null = null;
  #liveBody: LiveBody | null = null;
  #blockType: "thought" | "body" | null = null;
  #streamText = "";
  #streamDirty = false;
  #raf = 0;
  #autoScroll = true;
  #toolStart = new Map<string, number>();
  #pendingApprovals = new Map<string, { tool: string; args: unknown; exec?: { mode: string; mintable: boolean; reason: string } }>();
  /** ask_user card state (P2 #8): picked[qid] = chosen options/custom text. */
  #pendingQuestion: { id: string; questions: { id: string; question: string; options: string[]; multi: boolean }[]; picked: Record<string, string[]> } | null = null;

  /** One AgentTrace card per assistant turn; only the live one is mutable. */
  #liveTrace: AgentTrace | null = null;
  #liveRunId: string | null = null;
  #liveWrap: HTMLElement | null = null;
  #liveThinkingId: string | null = null;
  /** Last user send, so Retry can resend it as a new message at the bottom. */
  #lastSend: { text: string; attachments: StagedAttachment[] } | null = null;

  constructor(root: HTMLElement, handlers: ChatHandlers) {
    this.#handlers = handlers;
    this.stack = root.querySelector("#stack") as HTMLElement;
    this.#thread = root.querySelector("#thread") as HTMLElement;
    this.#input = root.querySelector("#input") as HTMLTextAreaElement;
    this.#sendBtn = root.querySelector("#send-btn") as HTMLButtonElement;
    this.#stopBtn = root.querySelector("#stop-btn") as HTMLButtonElement;
    this.#composer = root.querySelector("#composer") as HTMLElement;
    this.#approval = root.querySelector("#approval") as HTMLElement;
    this.#qrow = root.querySelector("#qrow") as HTMLElement;
    this.#jump = root.querySelector("#jump") as HTMLElement;
    this.#tok = root.querySelector("#tok") as HTMLElement;

    this.#renderEmpty();

    this.#input.addEventListener("input", () => {
      this.#autosize();
      this.#sendBtn.disabled = this.#input.value.trim().length === 0 && this.#staged.every((a) => a.error !== undefined);
    });
    this.#input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.submit();
      }
    });
    this.#sendBtn.onclick = () => this.submit();
    this.#stopBtn.onclick = () => this.#handlers.abort();

    // Attachments (P3 #28): picker + drag-drop + paste into the composer.
    this.#attachStrip = root.querySelector("#attach-strip") as HTMLElement;
    this.#attachBtn = root.querySelector("#attach-btn") as HTMLButtonElement;
    this.#attachInput = root.querySelector("#attach-input") as HTMLInputElement;
    this.#attachBtn.onclick = () => this.#attachInput.click();
    this.#attachInput.onchange = () => {
      this.#stageFiles(Array.from(this.#attachInput.files ?? []));
      this.#attachInput.value = "";
    };
    this.#composer.addEventListener("dragover", (e) => {
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
        this.#composer.classList.add("composer--drop");
      }
    });
    this.#composer.addEventListener("dragleave", () => this.#composer.classList.remove("composer--drop"));
    this.#composer.addEventListener("drop", (e) => {
      this.#composer.classList.remove("composer--drop");
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length > 0) {
        e.preventDefault();
        this.#stageFiles(files);
      }
    });
    this.#input.addEventListener("paste", (e) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length > 0) {
        e.preventDefault();
        this.#stageFiles(files);
      }
    });

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
    const ready = this.#staged.filter((a) => a.error === undefined);
    if (!text && ready.length === 0) return;
    // Keep the last send so a failed run can be retried as a new message.
    this.#lastSend = { text, attachments: ready };
    this.#input.value = "";
    this.#autosize();
    this.#sendBtn.disabled = true;
    this.#clearStaged();
    this.#handlers.send(text, ready);
    // Their first-chat-send permission prompt — once per browser and origin.
    try { askOnceOnFirstSend(); } catch { /* non-fatal */ }
  }

  /** ---- attachment staging (P3 #28) ---- */

  #stageFiles(files: File[]): void {
    let total = this.#staged.filter((a) => a.error === undefined).reduce((acc, a) => acc + a.size, 0);
    for (const file of files) {
      if (this.#staged.filter((a) => a.error === undefined).length >= ATTACH_MAX_FILES) {
        this.#staged.push({ name: file.name || "file", mime: file.type, size: file.size, dataUrl: "", error: `too many files (max ${ATTACH_MAX_FILES})` });
        continue;
      }
      if (file.size > ATTACH_MAX_FILE) {
        this.#staged.push({ name: file.name, mime: file.type, size: file.size, dataUrl: "", error: `larger than ${Math.floor(ATTACH_MAX_FILE / 1048576)} MB` });
        continue;
      }
      if (total + file.size > ATTACH_MAX_TOTAL) {
        this.#staged.push({ name: file.name, mime: file.type, size: file.size, dataUrl: "", error: `over ${Math.floor(ATTACH_MAX_TOTAL / 1048576)} MB total` });
        continue;
      }
      const entry: StagedAttachment = {
        name: file.name || "pasted-image.png",
        mime: file.type || "application/octet-stream",
        size: file.size,
        dataUrl: "",
      };
      this.#staged.push(entry);
      total += file.size;
      const reader = new FileReader();
      reader.onload = () => {
        entry.dataUrl = typeof reader.result === "string" ? reader.result : "";
        if (!entry.dataUrl) entry.error = "read failed";
        this.#renderStaged();
        this.#sendBtn.disabled = this.#input.value.trim().length === 0 && this.#staged.every((a) => a.error !== undefined);
      };
      reader.onerror = () => {
        entry.error = "read failed";
        this.#renderStaged();
      };
      reader.readAsDataURL(file);
    }
    this.#renderStaged();
    this.#sendBtn.disabled = false;
  }

  #clearStaged(): void {
    this.#staged = [];
    this.#renderStaged();
  }

  #renderStaged(): void {
    this.#attachStrip.innerHTML = "";
    this.#attachStrip.hidden = this.#staged.length === 0;
    for (const a of this.#staged) {
      const isImg = IMAGE_RE.test(a.mime);
      const thumb = isImg && a.dataUrl
        ? el("img", { class: "attach-chip__thumb", src: a.dataUrl, alt: a.name })
        : el("span", { class: "attach-chip__icon" }, [icon(FILE_ICON)]);
      const label = el("span", { class: "attach-chip__name" });
      label.textContent = a.name;
      const meta = el("span", { class: "attach-chip__meta mono" });
      meta.textContent = a.error ?? `${(a.size / 1024).toFixed(0)} KB`;
      const rm = el("button", { class: "attach-chip__rm", type: "button", "aria-label": `Remove ${a.name}` });
      rm.textContent = "×";
      rm.onclick = () => {
        this.#staged = this.#staged.filter((x) => x !== a);
        this.#renderStaged();
        this.#sendBtn.disabled = this.#input.value.trim().length === 0 && this.#staged.every((x) => x.error !== undefined);
      };
      const chip = el("div", { class: `attach-chip${a.error ? " attach-chip--err" : ""}`, title: a.error ?? a.name }, [thumb, label, meta, rm]);
      this.#attachStrip.append(chip);
    }
  }

  /** Archived sessions (P4 #33 — their composer-disabled + Unarchive banner):
   *  the transcript stays readable; writing needs an explicit Unarchive. */
  setArchived(archived: boolean, onUnarchive: () => void): void {
    let banner = this.#composer.querySelector<HTMLElement>("#archived-banner");
    if (archived && !banner) {
      banner = el("div", { class: "archived-banner", id: "archived-banner" }, [
        el("span", {}, ["This session is archived — read-only."]),
        el("button", { class: "btn", type: "button", id: "unarchive-btn" }, ["Unarchive"]),
      ]);
      const un = banner.querySelector<HTMLButtonElement>("#unarchive-btn")!;
      un.onclick = onUnarchive;
      this.#composer.parentElement!.insertBefore(banner, this.#composer);
    } else if (!archived && banner) {
      banner.remove();
    }
    this.#input.disabled = archived;
    this.#attachBtn.disabled = archived;
    this.#sendBtn.disabled = archived || this.#input.value.trim().length === 0;
  }

  setBusy(busy: boolean): void {
    this.#stopBtn.hidden = !busy;
    this.#sendBtn.hidden = busy;
    this.#sendBtn.disabled = busy || (this.#input.value.trim().length === 0 && this.#staged.every((a) => a.error !== undefined));
    if (busy) this.#input.focus();
  }

  setTokenHint(text: string): void {
    this.#tok.textContent = text;
  }

  clear(): void {
    this.stack.innerHTML = "";
    this.#live = null;
    this.#liveBody = null;
    this.#blockType = null;
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
  /** messageId → rendered node, so session-search hits can scroll+highlight
   *  their anchor after a thread reload. Rebuilt on every replaceThread. */
  readonly anchorMap = new Map<number, HTMLElement>();

  replaceThread(rows: { role: string; content: string; id?: number }[]): number {
    const live = this.#live;
    const liveText = this.#streamText;
    this.stack.innerHTML = "";
    this.anchorMap.clear();
    this.#live = null;
    this.#blockType = null;
    this.#liveThinkingId = null;
    this.#liveBody = null;
    this.#streamText = "";
    this.#liveTrace = null;
    this.#liveWrap = null;
    let rendered = 0;

    const markAnchor = (id?: number): void => {
      if (id === undefined) return;
      const node = this.stack.lastElementChild as HTMLElement | null;
      if (node) this.anchorMap.set(id, node);
    };

    // A history turn is a user message plus every assistant-side row that
    // follows it, up to the next user message. Each turn gets its own trace
    // card (thinking → tools → answer), like a completed live run.
    let turnTrace: AgentTrace | null = null;
    let turnWrap: HTMLElement | null = null;
    const flushTurn = (): void => {
      if (turnTrace) {
        turnTrace.push({ type: "run_end", ts: Date.now(), status: "done" });
      }
      turnTrace = null;
      turnWrap = null;
    };

    for (const [index, row] of rows.entries()) {
      try {
        if (row.role === "user") {
          flushTurn();
          this.user(row.content);
          markAnchor(row.id);
          rendered++;
          continue;
        }
        if (!turnTrace) {
          const runId = `hist-${index}`;
          const wrap = el("div", { class: "msg msg--assistant" });
          const traceRoot = el("div", { class: "agent-trace-root" });
          wrap.append(traceRoot);
          this.stack.append(wrap);
          turnWrap = wrap;
          turnTrace = new AgentTrace(traceRoot, { scrollRoot: this.#thread, jump: false });
          turnTrace.push({ type: "run_start", runId, ts: 1000 + index * 100 });
        }
        const t = turnTrace!;
        const wrap = turnWrap!;
        const ts = 1000 + index * 100;
        if (row.role === "assistant" && row.content) {
          const body = el("div", { class: "msg__body" });
          body.innerHTML = renderMarkdown(row.content);
          wrap.append(body);
          markAnchor(row.id);
          rendered++;
        } else if (row.role === "tool" && row.content) {
          const lines = row.content.split("\n");
          const headText = (lines[0] ?? "").replace(/^→\s*/, "");
          const timed = headText.match(/^(.*?)\s*·\s*(\d+)ms$/);
          const name = (timed?.[1] ?? headText).trim() || "tool";
          const duration = timed?.[2] ? Number(timed[2]) : undefined;
          const output = lines.slice(1).join("\n");
          const callId = `hist-tool-${index}`;
          t.push({
            type: "tool_start",
            stepId: callId,
            tool: name,
            label: TOOL_LABELS[name] ?? name.replace(/_/g, " "),
            icon: name,
            input: null,
            ts,
          });
          t.push({
            type: "tool_end",
            stepId: callId,
            output: output || null,
            summary: output ? output.split("\n")[0]!.slice(0, 80) : undefined,
            meta: duration ? `${duration}ms` : undefined,
            ts: ts + (duration ?? 60),
            outcome: output.startsWith("error") ? "error" : undefined,
          });
          markAnchor(row.id);
          rendered++;
        } else if (row.role === "error" && row.content) {
          this.fail(row.content);
          markAnchor(row.id);
          rendered++;
        } else if (row.role === "reasoning" && row.content) {
          const id = `hist-think-${index}`;
          t.push({ type: "thinking_start", stepId: id, ts });
          t.push({ type: "thinking_delta", stepId: id, text: row.content });
          t.push({ type: "thinking_end", stepId: id, ts: ts + 10 });
          markAnchor(row.id);
          rendered++;
        }
      } catch {
        /* one bad message must not take the thread with it */
      }
    }
    flushTurn();
    if (rendered === 0) this.#renderEmpty();
    if (live) {
      this.assistantStart();
      this.delta(liveText);
    }
    return rendered;
  }

  /** ---- transcript writers ---- */

  user(text: string, attachments?: StagedAttachment[]): void {
    this.#clearEmpty();
    const parts: HTMLElement[] = [];
    if (attachments && attachments.length > 0) {
      const strip = el("div", { class: "msg__atts" });
      for (const a of attachments) {
        if (IMAGE_RE.test(a.mime) && a.dataUrl) {
          strip.append(el("img", { class: "msg__att-img", src: a.dataUrl, alt: a.name }));
        } else {
          const chip = el("span", { class: "msg__att-file mono" });
          chip.textContent = `📎 ${a.name}`;
          strip.append(chip);
        }
      }
      parts.push(strip);
    }
    if (text) {
      const bubble = el("div", { class: "bubble" });
      bubble.textContent = text;
      parts.push(bubble);
    }
    if (parts.length === 0) parts.push(el("div", { class: "bubble" }));
    this.stack.append(el("div", { class: "msg msg--user" }, parts));
    this.#scrollToBottom();
  }

  assistantStart(): void {
    this.#clearEmpty();
    if (this.#live) return;
    this.#live = { startedAt: Date.now() };
    this.#blockType = null;
    this.#liveThinkingId = null;
    this.#liveBody = null;
    this.#streamText = "";
    const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.#liveRunId = runId;
    const wrap = el("div", { class: "msg msg--assistant" });
    const traceRoot = el("div", { class: "agent-trace-root" });
    wrap.append(traceRoot);
    this.stack.append(wrap);
    this.#liveWrap = wrap;
    this.#liveTrace = new AgentTrace(traceRoot, {
      scrollRoot: this.#thread,
      jump: false, // the dock owns the single Jump-to-latest button
      onApproval: (decision, step) => this.#resolve(step.id, decision),
      onRetry: () => {
        if (this.#lastSend) void this.#handlers.send(this.#lastSend.text, this.#lastSend.attachments);
      },
    });
    this.#liveTrace.push({ type: "run_start", runId, ts: Date.now() });
    this.#scrollToBottom();
  }

  delta(text: string): void {
    if (!this.#live) this.assistantStart();
    if (this.#blockType !== "body") {
      this.#finalizeCurrentBlock();
      const body = el("div", { class: "msg__body" });
      this.#liveWrap!.append(body);
      this.#liveBody = { root: body, body };
      this.#blockType = "body";
      this.#streamText = "";
    }
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
    this.#finalizeCurrentBlock();
    if (this.#streamText.trim()) {
      const body = el("div", { class: "msg__body" });
      body.innerHTML = renderMarkdown(this.#streamText);
      this.#liveWrap!.append(body);
    }
    const t = this.#liveTrace;
    if (t) t.push({ type: "run_end", ts: Date.now(), status: "done" });
    this.#live = null;
    this.#blockType = null;
    this.#liveBody = null;
    this.#streamText = "";
    this.setBusy(false);
    this.#scrollToBottom();
  }

  /** A run that died: keep the partial text, but never label it "Done". */
  fail(message: string): void {
    const pretty = prettyError(message);
    this.notice(`error: ${pretty}`, "notice--error");
    if (!this.#live) return;
    this.#finalizeCurrentBlock();
    const t = this.#liveTrace;
    if (t) t.push({ type: "run_end", ts: Date.now(), status: "error", message: pretty });
    this.#live = null;
    this.#blockType = null;
    this.#liveBody = null;
    this.#streamText = "";
    this.setBusy(false);
    this.#scrollToBottom();
  }

  assistant(text: string): void {
    this.#clearEmpty();
    const body = el("div", { class: "msg__body" });
    body.innerHTML = renderMarkdown(text);
    this.stack.append(body);
    this.#scrollToBottom();
  }

  notice(text: string, variant?: string): void {
    this.#clearEmpty();
    this.stack.append(el("div", { class: variant ? `notice mono ${variant}` : "notice mono" }, [text]));
    this.#scrollToBottom();
  }

  tool(name: string, status: ToolStatus, detail?: string, ms?: number, key?: string, host?: HTMLElement): void {
    this.#clearEmpty();
    // Finalize whatever block (thought/body) was open so the tool step lands
    // in sequence inside the turn's trace card.
    this.#finalizeCurrentBlock();
    const t = this.#liveTrace;
    if (!t) return;
    const callId = key ?? name;
    const ts = Date.now();
    if (status === "running") {
      // A retry re-emits "running" for the same call id — the reducer keeps
      // one row and refreshes it instead of duplicating the step.
      t.push({
        type: "tool_start",
        stepId: callId,
        tool: String(name),
        label: TOOL_LABELS[name] ?? String(name).replace(/_/g, " "),
        icon: String(name),
        input: null,
        ts,
      });
    } else if (status === "done" || status === "error") {
      // Backend sends running→done/error pairs, but tolerate a lone done/error.
      const existing = t.getState().items.some(
        (i: TraceItem) => i.kind === "tool" && i.calls.some((c: { id: string }) => c.id === callId),
      );
      if (!existing) {
        t.push({
          type: "tool_start",
          stepId: callId,
          tool: String(name),
          label: TOOL_LABELS[name] ?? String(name).replace(/_/g, " "),
          icon: String(name),
          input: null,
          ts: status === "done" && ms ? ts - ms : ts,
        });
      }
      t.push({
        type: "tool_end",
        stepId: callId,
        output: detail ?? null,
        summary: detail ? String(detail).split("\n")[0]!.slice(0, 80) : undefined,
        meta: ms ? `${ms}ms` : undefined,
        ts,
        outcome: status === "error" ? "error" : undefined,
      });
    }
    // "pending" / "skipped" carry no trace transition — the approval card and
    // queue rows own those states. Pending is not a failure.
    this.#scrollToBottom();
  }

  /**
   * Stream a thinking fragment. Each contiguous run of reasoning becomes its own
   * thinking step inside the turn's trace card; a tool call or answer text in
   * between breaks the run (#finalizeCurrentBlock), so the persisted order
   * (reason → tool → response → tool) is preserved both live and after a
   * reload.
   */
  reasoningDelta(text: string): void {
    if (!this.#live) this.assistantStart();
    const t = this.#liveTrace;
    // Each contiguous run of reasoning becomes its own thinking step; a tool
    // call or answer text in between breaks the run (#finalizeCurrentBlock).
    if (!this.#liveThinkingId || this.#blockType !== "thought") {
      if (this.#liveThinkingId && t) {
        t.push({ type: "thinking_end", stepId: this.#liveThinkingId, ts: Date.now() });
      }
      this.#liveThinkingId = `think-${Date.now()}`;
      if (t) t.push({ type: "thinking_start", stepId: this.#liveThinkingId, ts: Date.now() });
    }
    if (t) t.push({ type: "thinking_delta", stepId: this.#liveThinkingId, text });
    this.#blockType = "thought";
  }

  #finalizeCurrentBlock(): void {
    if (this.#blockType === "thought" && this.#liveThinkingId) {
      const t = this.#liveTrace;
      if (t) t.push({ type: "thinking_end", stepId: this.#liveThinkingId, ts: Date.now() });
      this.#liveThinkingId = null;
    }
    if (this.#blockType === "body" && this.#liveBody) {
      this.#liveBody.body.innerHTML = renderMarkdown(this.#streamText);
    }
    this.#blockType = null;
    this.#liveBody = null;
    this.#streamText = "";
  }

  /** ---- message queue row (their "waiting messages above the composer") ---- */

  queued(runId: string, text: string): void {
    this.#queueItems.set(runId, { text, at: Date.now() });
    this.#renderQueue();
  }

  dequeued(runId: string, reason?: string): void {
    if (this.#queueItems.delete(runId)) this.#renderQueue();
    if (reason === "overflow") this.notice("queue full — the oldest queued message was dropped", "notice--error");
  }

  queueReplace(items: { runId: string; text: string; at: number }[]): void {
    this.#queueItems = new Map(items.map((i) => [i.runId, { text: i.text, at: i.at }]));
    this.#renderQueue();
  }

  #renderQueue(): void {
    this.#qrow.innerHTML = "";
    if (this.#queueItems.size === 0) {
      this.#qrow.hidden = true;
      return;
    }
    this.#qrow.hidden = false;
    this.#qrow.append(el("span", { class: "qrow__label" }, [`${this.#queueItems.size} waiting`]));
    for (const [runId, item] of this.#queueItems) {
      const x = el("button", { class: "qrow__x", type: "button", title: "Remove from queue" }, ["×"]);
      x.onclick = () => this.#handlers.cancelQueued(runId);
      this.#qrow.append(el("span", { class: "qrow__item", title: item.text }, [item.text.slice(0, 48), x]));
    }
  }

  /** ---- approvals ---- */

  approval(callId: string, tool: string, args: unknown, exec?: { mode: string; mintable: boolean; reason: string }): void {
    this.#pendingApprovals.set(callId, { tool, args, exec });
    this.#renderApprovals();
  }

  #renderApprovals(): void {
    const first = this.#pendingApprovals.entries().next().value as
      | [string, { tool: string; args: unknown; exec?: { mode: string; mintable: boolean; reason: string } }]
      | undefined;
    if (!first) {
      this.#approval.hidden = true;
      this.#composer.classList.remove("composer--attached");
      return;
    }
    const [callId, pending] = first;
    this.#approval.hidden = false;
    this.#composer.classList.add("composer--attached");
    const t = this.#liveTrace;
    if (t && !t.getState().items.some((i: TraceItem) => i.kind === "approval" && i.id === callId)) {
      const label = TOOL_LABELS[pending.tool] ?? pending.tool;
      t.push({
        type: "approval_request",
        stepId: callId,
        description: `${label}: ${formatValue(pending.args)}`,
        ts: Date.now(),
      });
    }
    (document.getElementById("approval-tool") as HTMLElement).textContent = pending.tool;
    (document.getElementById("approval-args") as HTMLElement).textContent =
      typeof pending.args === "string" ? pending.args : JSON.stringify(pending.args ?? {});
    const why = document.getElementById("approval-why") as HTMLElement;
    if (pending.exec) {
      why.textContent = `${pending.exec.reason} · mode ${pending.exec.mode}`;
      why.hidden = false;
    } else {
      why.hidden = true;
    }
    // Allow-always mints a grant bound to exact argv in this directory — the
    // policy refuses to mint carriers, so don't offer the button there.
    const always = document.getElementById("approval-always") as HTMLButtonElement;
    if (pending.exec && !pending.exec.mintable) {
      always.disabled = true;
      always.title = "Inline-eval/substitution — per-run approval only";
    } else {
      always.disabled = false;
      always.title = "Always allow this exact command in this directory";
    }
    (document.getElementById("approval-deny") as HTMLElement).onclick = () => this.#resolve(callId, "deny");
    always.onclick = () => this.#resolve(callId, "always");
    (document.getElementById("approval-allow") as HTMLElement).onclick = () => this.#resolve(callId, "once");
  }

  #resolve(callId: string, decision: "allow" | "deny" | "once" | "always"): void {
    this.#pendingApprovals.delete(callId);
    this.#renderApprovals();
    // Trace buttons say allow/deny; the dock card says once/always/deny. The
    // gateway only accepts once/always/deny.
    const rpcDecision = decision === "allow" ? "once" : decision;
    this.#handlers.approve(callId, rpcDecision as "once" | "always" | "deny");
    this.notice(decision === "deny" ? "denied" : decision === "always" ? "always allowed (this directory)" : "approved once");
    // Update the trace row without re-invoking opts.onApproval (that would
    // send the approval RPC a second time).
    const t = this.#liveTrace;
    if (t) t.setDecision(callId, decision === "deny" ? "deny" : "allow");
  }

  /** ---- ask_user (P2 #8): option card over the composer ---- */

  question(id: string, questions: { id: string; question: string; options: string[]; multi: boolean }[]): void {
    this.#pendingQuestion = { id, questions, picked: {} };
    this.#renderQuestion();
  }

  #renderQuestion(): void {
    const box = document.getElementById("question") as HTMLElement;
    if (!this.#pendingQuestion) {
      box.hidden = true;
      this.#composer.classList.remove("composer--attached");
      return;
    }
    box.hidden = false;
    this.#composer.classList.add("composer--attached");
    const body = document.getElementById("question-body") as HTMLElement;
    body.innerHTML = "";
    const st = this.#pendingQuestion;
    for (const q of st.questions) {
      body.append(el("div", { class: "approval__why" }, [q.question]));
      const row = el("div", { class: "chips" });
      for (const opt of q.options) {
        const on = (st.picked[q.id] ?? []).includes(opt);
        const chip = el("button", { class: `chip${on ? " chip--on" : ""}`, type: "button" }, [opt]);
        chip.onclick = () => {
          const cur = st.picked[q.id] ?? [];
          if (q.multi) {
            st.picked[q.id] = on ? cur.filter((o) => o !== opt) : [...cur, opt];
          } else {
            st.picked[q.id] = [opt];
          }
          this.#renderQuestion();
        };
        row.append(chip);
      }
      // Other — free-text capture (always present; their doc's rule).
      const other = el("button", { class: "chip", type: "button" }, ["Other…"]);
      other.onclick = () => {
        const text = window.prompt(`${q.question} — your own answer:`);
        if (text && text.trim()) {
          st.picked[q.id] = [text.trim()];
          this.#renderQuestion();
        }
      };
      row.append(other);
      body.append(row);
    }
    (document.getElementById("question-answer") as HTMLElement).onclick = () => this.#resolveQuestion(false);
    (document.getElementById("question-skip") as HTMLElement).onclick = () => this.#resolveQuestion(true);
  }

  #resolveQuestion(skip: boolean): void {
    const st = this.#pendingQuestion;
    if (!st) return;
    const answers: Record<string, string[]> = {};
    for (const q of st.questions) answers[q.id] = skip ? [] : (st.picked[q.id] ?? []);
    this.#pendingQuestion = null;
    this.#renderQuestion();
    this.#handlers.questionAnswer(st.id, answers);
    this.notice(skip ? "question skipped" : "answers sent");
  }

  /** ---- internals ---- */

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
      if (!this.#streamDirty || !this.#liveBody) return;
      this.#streamDirty = false;
      this.#liveBody.body.innerHTML = renderMarkdown(this.#streamText);
      this.#liveBody.body.append(el("span", { class: "caret" }));
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
