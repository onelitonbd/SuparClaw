// One Telegram turn's outbound surface (Task 32).
//
// The chat is not a transcript. What the user asked for: "I don't need to see
// what tool it is using, what it is thinking — I just need the final answer."
// Upstream (messaging.md) splits a turn into two lanes, and so do we:
//
//   status draft  — one editable message, quiet by default: the stages the turn
//                   is going through, never tool names, never reasoning, never
//                   a half-written answer in "progress" mode;
//   final answer  — its own message, rendered from Markdown to Telegram HTML.
//
// Modes (their four):
//   progress (default) — quiet draft + answer as its own message
//   partial / block    — the answer streams into the draft (the old behaviour)
//   off                — no draft, no chatter; the answer, approvals and media
//                        still arrive
//
// Deliberately absent: reasoning. There is no listener for it anywhere in this
// module, so thinking cannot leak into the chat by accident.

import { splitForTelegram, stripHtmlTags, telegramChunks } from "./telegram-format.js";

export type StreamingMode = "off" | "partial" | "block" | "progress";

/** The slice of grammy's bot API this module needs (faked in tests). */
export interface DeliveryApi {
  sendMessage(chatId: number, text: string, extra?: Record<string, unknown>): Promise<{ message_id: number }>;
  editMessageText(chatId: number, messageId: number, text: string, extra?: Record<string, unknown>): Promise<unknown>;
  deleteMessage(chatId: number, messageId: number): Promise<unknown>;
}

export interface TurnDeliveryOptions {
  api: DeliveryApi;
  chatId: number;
  mode: StreamingMode;
  /** channels.telegram.toolProgress — put raw tool names back in the draft. */
  toolProgress?: boolean;
  /** Observation hook (tests, and a place for a future "sent" metric). */
  onEvent?: (event: { kind: "draft" | "draftEdit" | "draftDelete" | "answer" | "answerEdit" | "answerFallback"; text: string }) => void;
  now?: () => number;
  log?: (message: string) => void;
}

/** Human stage names — what the turn is DOING, not which tool it called. */
const STAGES: Record<string, string> = {
  fs_read: "Reading files",
  fs_list: "Looking around",
  fs_write: "Writing files",
  fs_edit: "Editing files",
  fs_delete: "Cleaning up",
  exec: "Running a command",
  web_fetch: "Fetching a page",
  web_search: "Searching the web",
  memory_search: "Checking memory",
  memory_write: "Saving to memory",
  cron_list: "Checking schedules",
  cron_add: "Setting a schedule",
  image_generate: "Generating an image",
  ask_user: "Waiting for you",
};

const DELTA_THROTTLE_MS = 2000;
const TOOL_THROTTLE_MS = 1200;

export function createTurnDelivery(opts: TurnDeliveryOptions) {
  const { api, chatId, mode } = opts;
  const showTools = opts.toolProgress === true;
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  const emit = opts.onEvent ?? (() => {});

  let draft: { message_id: number } | null = null;
  let draftDeleted = false;
  let lastEdit = 0;
  let everEdited = false;
  const stages: string[] = [];

  const stageFor = (tool?: string): string => {
    const stage = tool ? (STAGES[tool] ?? "Working") : "Thinking";
    if (stages.at(-1) !== stage) stages.push(stage);
    return stages.slice(-3).join(" → ");
  };

  const ensureDraft = async (): Promise<void> => {
    if (mode === "off" || draft || draftDeleted) return;
    draft = await api.sendMessage(chatId, "▌ working…", { link_preview_options: { is_disabled: true } }).catch(() => null);
    if (draft) emit({ kind: "draft", text: "▌ working…" });
  };

  const editDraft = async (text: string): Promise<void> => {
    await ensureDraft();
    if (!draft) return;
    const id = draft.message_id;
    lastEdit = now();
    everEdited = true;
    const ok = await api.editMessageText(chatId, id, text, { link_preview_options: { is_disabled: true } }).then(() => true).catch(() => false);
    if (ok) emit({ kind: "draftEdit", text });
  };

  return {
    /** A streamed answer fragment. Never rendered in progress mode. */
    async onDelta(_delta: string): Promise<void> {
      if (mode === "off") return;
      if (everEdited && now() - lastEdit < DELTA_THROTTLE_MS) return;
      await editDraft(`▌ ${stageFor()}`);
    },

    /** A tool started. The quiet draft shows the stage; the answer never sees it. */
    async onTool(name: string): Promise<void> {
      if (mode === "off") return;
      const stage = stageFor(name);
      if (!showTools && everEdited && now() - lastEdit < TOOL_THROTTLE_MS) return;
      await editDraft(showTools ? `▌ ${stage}\n· ${name}` : `▌ ${stage}`);
    },

    /** The turn's answer — Markdown in, rendered Telegram HTML out. */
    async reply(markdown: string): Promise<void> {
      if (markdown.trim() === "") return;
      if (mode === "partial" || mode === "block") {
        await sendIntoDraft(markdown);
        return;
      }
      // progress / off: the answer is a message of its own (their default). The
      // draft goes first so the chat does not keep a stale "working…" above it.
      await dropDraft();
      await sendAnswer(markdown);
    },
  };

  async function dropDraft(): Promise<void> {
    if (!draft || draftDeleted) return;
    draftDeleted = true;
    const id = draft.message_id;
    const ok = await api.deleteMessage(chatId, id).then(() => true).catch(() => false);
    if (ok) emit({ kind: "draftDelete", text: "" });
    draft = null;
  }

  async function sendAnswer(markdown: string): Promise<void> {
    for (const chunk of telegramChunks(markdown)) {
      const ok = await api
        .sendMessage(chatId, chunk, { parse_mode: "HTML", link_preview_options: { is_disabled: true } })
        .then(() => true)
        .catch(() => false);
      if (ok) {
        emit({ kind: "answer", text: chunk });
        continue;
      }
      // Telegram rejected the markup: deliver the text plainly. A dropped answer
      // is far worse than a plain one.
      log("telegram: HTML reply rejected — falling back to plain text");
      for (const plain of splitForTelegram(stripHtmlTags(chunk))) {
        await api.sendMessage(chatId, plain).then(() => emit({ kind: "answerFallback", text: plain })).catch(() => {});
      }
    }
  }

  async function sendIntoDraft(markdown: string): Promise<void> {
    const chunks = telegramChunks(markdown);
    await ensureDraft();
    if (!draft) {
      await sendAnswer(markdown);
      return;
    }
    const id = draft.message_id;
    const first = chunks[0] ?? "(empty)";
    const ok = await api
      .editMessageText(chatId, id, first, { parse_mode: "HTML", link_preview_options: { is_disabled: true } })
      .then(() => true)
      .catch(() => false);
    if (ok) {
      emit({ kind: "answerEdit", text: first });
    } else {
      log("telegram: HTML preview rejected — falling back to plain text");
      await api.editMessageText(chatId, id, splitForTelegram(stripHtmlTags(first))[0] ?? "(empty)").catch(() => {});
    }
    for (const chunk of chunks.slice(1)) {
      const sent = await api.sendMessage(chatId, chunk, { parse_mode: "HTML" }).then(() => true).catch(() => false);
      if (sent) emit({ kind: "answer", text: chunk });
      else await api.sendMessage(chatId, stripHtmlTags(chunk)).catch(() => {});
    }
  }
}
