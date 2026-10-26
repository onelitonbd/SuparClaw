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
  /** Wait between retries (injected so tests do not sleep). */
  sleep?: (ms: number) => Promise<void>;
  /** Extra attempts for a transient failure (network, 429, 5xx). Default 2. */
  retries?: number;
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

/**
 * Did Telegram fail for a reason that is worth retrying?
 *
 * A turn's answer is the whole point of the turn, and the failures we see in
 * practice are transient: a network blip, a 429 during a burst, a 5xx. Those
 * must not cost the user their answer. A 400 ("can't parse entities", "message
 * is too long") will fail again the same way — retrying it only delays the real
 * fallback (plain text).
 */
export function isTransientTelegramError(err: unknown): boolean {
  const e = err as { message?: string; error_code?: number; error?: { error_code?: number; description?: string }; parameters?: { retry_after?: number } };
  const code = Number(e?.error_code ?? e?.error?.error_code ?? 0);
  if (code === 429 || code >= 500) return true;
  const text = `${e?.message ?? ""} ${e?.error?.description ?? ""}`;
  if (/\b429\b|too many requests|retry after|failed after/i.test(text)) return true;
  if (/\b5\d\d\b/.test(text)) return true;
  if (/network request|fetch failed|socket hang up|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EADDRINUSE|timeout/i.test(text)) return true;
  return false;
}

export function createTurnDelivery(opts: TurnDeliveryOptions) {
  const { api, chatId, mode } = opts;
  const showTools = opts.toolProgress === true;
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  const emit = opts.onEvent ?? (() => {});

  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const tries = 1 + Math.max(0, opts.retries ?? 2);

  let draft: { message_id: number } | null = null;
  let draftDeleted = false;
  let lastEdit = 0;
  let everEdited = false;
  const stages: string[] = [];

  /**
   * Run one Telegram call, retrying only what is worth retrying.
   *
   * Returns null when the call ultimately failed — the caller decides what the
   * user sees. Never throws: a delivery failure must not unwind a turn.
   */
  const attempt = async <T>(label: string, fn: () => Promise<T>): Promise<T | null> => {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (err) {
        const retryable = isTransientTelegramError(err) && i + 1 < tries;
        if (!retryable) {
          log(`telegram: ${label} failed — ${(err as Error).message}`);
          return null;
        }
        const after = Number((err as { parameters?: { retry_after?: number } }).parameters?.retry_after ?? 0);
        const wait = after > 0 ? Math.min(after * 1000, 30_000) : i === 0 ? 400 : 1500;
        log(`telegram: ${label} failed (${(err as Error).message}) — retrying in ${wait}ms`);
        await sleep(wait);
      }
    }
  };

  const stageFor = (tool?: string): string => {
    const stage = tool ? (STAGES[tool] ?? "Working") : "Thinking";
    if (stages.at(-1) !== stage) stages.push(stage);
    return stages.slice(-3).join(" → ");
  };

  const ensureDraft = async (): Promise<void> => {
    if (mode === "off" || draft || draftDeleted) return;
    draft = await attempt("status draft", () => api.sendMessage(chatId, "▌ working…", { link_preview_options: { is_disabled: true } }));
    if (draft) emit({ kind: "draft", text: "▌ working…" });
  };

  const editDraft = async (text: string): Promise<void> => {
    await ensureDraft();
    if (!draft) return;
    const id = draft.message_id;
    lastEdit = now();
    everEdited = true;
    const ok = await attempt("draft edit", () => api.editMessageText(chatId, id, text, { link_preview_options: { is_disabled: true } }));
    if (ok !== null) emit({ kind: "draftEdit", text });
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
      if (markdown.trim() === "") {
        // A turn with nothing to say (a bare HEARTBEAT_OK, a stripped marker):
        // remove the working draft rather than leaving it spinning forever.
        await finish();
        return;
      }
      if (mode === "partial" || mode === "block") {
        await sendIntoDraft(markdown);
        return;
      }
      // progress / off: the answer is a message of its own (their default).
      // ORDER MATTERS: send first, drop the draft second. Deleting first meant a
      // single transient failure left the chat completely empty — no answer and
      // no evidence that anything had happened.
      const { sent, failed } = await sendAnswer(markdown);
      if (failed === null) {
        await finish();
        return;
      }
      if (sent === 0) {
        // Nothing got through: the draft is still on screen, so it becomes the
        // notice instead of being deleted.
        await reportUndelivered(failed);
        return;
      }
      // Part of a long answer arrived. Say so — a silently truncated reply is
      // worse than a short one with a signpost.
      await finish();
      await reportUndelivered(failed, true);
    },
  };

  async function dropDraft(): Promise<void> {
    if (!draft || draftDeleted) return;
    draftDeleted = true;
    const id = draft.message_id;
    const ok = await attempt("draft delete", () => api.deleteMessage(chatId, id));
    if (ok !== null) emit({ kind: "draftDelete", text: "" });
    draft = null;
  }

  /**
   * Deliver the answer. Returns null when every attempt failed.
   *
   * Transport failures are retried; a markup rejection falls back to plain text
   * immediately. The chat is only ever left without the answer if Telegram
   * itself is unreachable, and then `reportUndelivered` says so.
   */
  async function sendAnswer(markdown: string): Promise<{ sent: number; failed: string | null }> {
    let sent = 0;
    let failed: string | null = null;
    for (const chunk of telegramChunks(markdown)) {
      const ok = await attempt("reply", () =>
        api.sendMessage(chatId, chunk, { parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
      );
      if (ok) {
        sent += 1;
        emit({ kind: "answer", text: chunk });
        continue;
      }
      // Telegram refused the markup (a 400, not a transport blip): send the text
      // plainly. An unformatted answer is infinitely better than a lost one.
      log("telegram: HTML reply rejected — falling back to plain text");
      const plain = splitForTelegram(stripHtmlTags(chunk));
      let plainSent = 0;
      for (const piece of plain) {
        const okPlain = await attempt("reply (plain)", () => api.sendMessage(chatId, piece));
        if (okPlain) {
          plainSent += 1;
          emit({ kind: "answerFallback", text: piece });
        } else {
          failed = "Telegram did not accept the message";
        }
      }
      if (plainSent > 0) sent += plainSent;
    }
    return { sent, failed };
  }

  async function sendIntoDraft(markdown: string): Promise<void> {
    const chunks = telegramChunks(markdown);
    await ensureDraft();
    if (!draft) {
      await finish();
      return;
    }
    const id = draft.message_id;
    const first = chunks[0] ?? "(empty)";
    const ok = await attempt("preview edit", () =>
      api.editMessageText(chatId, id, first, { parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
    );
    if (ok !== null) {
      emit({ kind: "answerEdit", text: first });
    } else {
      // The edit failed. Try plain into the same message, then — if even that
      // fails — send the answer as its own message instead of leaving the
      // "working…" draft as the last thing the user sees.
      log("telegram: HTML preview rejected — falling back to plain text");
      const plainFirst = splitForTelegram(stripHtmlTags(first))[0] ?? "(empty)";
      const plainOk = await attempt("preview edit (plain)", () => api.editMessageText(chatId, id, plainFirst));
      if (plainOk === null) {
        draft = null; // stop trying to reuse a message we cannot write to
        await sendAnswer(markdown);
        return;
      }
    }
    for (const chunk of chunks.slice(1)) {
      const sent = await attempt("reply", () => api.sendMessage(chatId, chunk, { parse_mode: "HTML" }));
      if (sent) {
        emit({ kind: "answer", text: chunk });
      } else {
        for (const piece of splitForTelegram(stripHtmlTags(chunk))) {
          await attempt("reply (plain)", () => api.sendMessage(chatId, piece));
        }
      }
    }
  }

  /**
   * The answer could not be delivered at all.
   *
   * Silence is the worst outcome: the reply is in the session, visible in the
   * web UI, and the chat just stops. So the draft — or a new message when there
   * is no draft — says what happened and where the answer is.
   */
  async function reportUndelivered(reason: string, partial = false): Promise<void> {
    const notice = partial
      ? `⚠ Part of this reply could not be delivered (${reason}). The full answer is in the web chat.`
      : `⚠ The answer could not be delivered (${reason}). It is saved in this session — open the web chat to read it.`;
    if (draft && !draftDeleted) {
      const ok = await attempt("failure notice", () => api.editMessageText(chatId, draft!.message_id, notice));
      if (ok !== null) {
        emit({ kind: "draftEdit", text: notice });
        return;
      }
      draftDeleted = true;
    }
    await attempt("failure notice", () => api.sendMessage(chatId, notice));
  }

  /** The answer is on its way (or was never needed): drop the status draft. */
  async function finish(): Promise<void> {
    if (!draft || draftDeleted) return;
    await dropDraft();
  }
}
