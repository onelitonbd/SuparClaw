// One Telegram turn's outbound surface (Task 52 → rewritten in Task 53).
//
// The chat is not a transcript, and it is not a progress bar either. The
// operator's rule, twice now, in their own words:
//
//   "I don't need to see what tool it is using, what it is thinking — I just
//    need the final answer."
//   "we dont need them on telegram the tool uses and working and thinking …
//    we just need the responses. if the ai gives multiple responses for a
//    single quary i want them come instantly all one by one when it tells."
//
// So there is no status message any more. Task 32's editable draft ("▌ working…"
// → "▌ Reading files") is gone, along with the `streaming` and `toolProgress`
// config keys that only existed to shape it. What is left is one rule:
//
//   every finished block of the model's words is its own message, posted the
//   moment the model finishes it.
//
// `say()` is that message. `reply()` is the tail of the answer that no `say`
// covered — usually the last block, sometimes the whole answer (a turn with no
// tool calls at all). It works by offset, never by guesswork:
//
//   ledger = concatenation of the raw blocks `say` was given, plus a flag that
//            is set if any of them could not be delivered.
//
// The loop emits `say` with the round's untrimmed text, so the ledger is a
// byte-exact prefix of the final answer. If it is not (a synthetic final, an
// aborted turn), or a block was lost, the final is sent whole: a duplicated
// line is annoying, a lost answer is a bug.
//
// Everything outbound is serialised on one promise chain. `Service.send`
// dispatches channel callbacks without awaiting them, so without this a block
// posted "immediately" could still be in flight when the final computes its
// remainder — and the user would read the same paragraph twice.

import { splitForTelegram, stripHtmlTags, telegramChunks } from "./telegram-format.js";

/** The slice of grammy's bot API this module needs (faked in tests). */
export interface DeliveryApi {
  sendMessage(chatId: number, text: string, extra?: Record<string, unknown>): Promise<{ message_id: number }>;
  deleteMessage?(chatId: number, messageId: number): Promise<unknown>;
}

export interface TurnDeliveryOptions {
  api: DeliveryApi;
  chatId: number;
  /** Wait between retries (injected so tests do not sleep). */
  sleep?: (ms: number) => Promise<void>;
  /** Extra attempts for a transient failure (network, 429, 5xx). Default 2. */
  retries?: number;
  /** Observation hook (tests, and a place for a future "sent" metric). */
  onEvent?: (event: { kind: "say" | "answer" | "answerFallback" | "notify" | "undelivered"; text: string }) => void;
  log?: (message: string) => void;
}

/**
 * Did Telegram fail for a reason worth retrying?
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

/**
 * The part of `final` that has not been said yet.
 *
 * Exact when the ledger is a true prefix (the normal path); the whole string
 * when it is not — a synthetic final, a turn that was aborted mid-sentence, a
 * block whose send failed. Never returns a tail it cannot justify.
 */
export function remainderAfter(final: string, said: string, gap = false): string {
  const text = final.trim();
  if (gap) return text;
  if (said.length === 0) return text;
  const spoken = said.trim();
  if (spoken.length === 0) return text;
  if (!final.startsWith(spoken)) return text;
  return final.slice(spoken.length).trim();
}

export function createTurnDelivery(opts: TurnDeliveryOptions) {
  const { api, chatId } = opts;
  const log = opts.log ?? (() => {});
  const emit = opts.onEvent ?? (() => {});
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const tries = 1 + Math.max(0, opts.retries ?? 2);

  /** Raw text already posted as its own message, in order. */
  let said = "";
  /** A block we could not deliver — the final must be sent whole. */
  let gap = false;
  /** Everything outbound runs here, one after another. */
  let chain: Promise<void> = Promise.resolve();

  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  /**
   * Run one Telegram call, retrying only what is worth retrying.
   * Returns null when the call ultimately failed; never throws.
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

  /**
   * Send one formatted piece. HTML first; a rejected markup falls back to plain
   * text, because an unformatted answer is infinitely better than a lost one.
   * Returns the number of messages Telegram accepted.
   */
  async function post(label: string, markdown: string, chunks: string[]): Promise<{ sent: number; failed: string | null }> {
    let sent = 0;
    let failed: string | null = null;
    for (const chunk of chunks) {
      const ok = await attempt(label, () =>
        api.sendMessage(chatId, chunk, { parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
      );
      if (ok) {
        sent += 1;
        emit({ kind: "answer", text: chunk });
        continue;
      }
      log("telegram: HTML send rejected — falling back to plain text");
      for (const piece of splitForTelegram(stripHtmlTags(chunk))) {
        const plainOk = await attempt(`${label} (plain)`, () => api.sendMessage(chatId, piece));
        if (plainOk) {
          sent += 1;
          emit({ kind: "answerFallback", text: piece });
        } else {
          failed = "Telegram did not accept the message";
        }
      }
    }
    if (chunks.length === 0 && markdown.trim().length > 0) failed = "the message could not be split";
    return { sent, failed };
  }

  return {
    /**
     * A finished block of the model's words. Posted as its own message, now.
     *
     * A whitespace-only block posts nothing but still advances the ledger: the
     * loop emits it so the offsets stay exact, not so the user reads a blank
     * bubble.
     */
    say(text: string): Promise<void> {
      return serialize(async () => {
        if (typeof text !== "string" || text.length === 0) return;
        const body = text.trim();
        if (body.length === 0) {
          said += text;
          return;
        }
        const { sent, failed } = await post("answer part", body, telegramChunks(body));
        if (sent > 0) {
          said += text;
          emit({ kind: "say", text: body });
        }
        if (failed) gap = true;
      });
    },

    /**
     * The tail of the answer. Usually the last block; the whole answer when the
     * turn ran no tools, or when a `say` never made it.
     */
    reply(markdown: string): Promise<void> {
      return serialize(async () => {
        const rest = remainderAfter(markdown ?? "", said, gap);
        if (rest.length === 0) {
          // Nothing left to add (every block already landed, or the turn had
          // nothing to say). Never post an empty message.
          said = "";
          gap = false;
          return;
        }
        const { sent, failed } = await post("reply", rest, telegramChunks(rest));
        said = "";
        gap = false;
        if (sent === 0 && failed) {
          await reportUndelivered(failed);
          return;
        }
        if (failed) await reportUndelivered(failed, sent > 0);
      });
    },

    /**
     * A line that is not the answer: the code-session signpost, a notice.
     * Posted verbatim, wrapped in the same HTML pipeline, and it never touches
     * the answer ledger.
     */
    notify(markdown: string): Promise<void> {
      return serialize(async () => {
        const body = (markdown ?? "").trim();
        if (body.length === 0) return;
        const { sent, failed } = await post("notice", body, telegramChunks(body));
        if (sent > 0) emit({ kind: "notify", text: body });
        if (failed) log(`telegram: notice not delivered — ${failed}`);
      });
    },

    /** Resolves once everything queued has been attempted (tests, shutdown). */
    settled(): Promise<void> {
      return chain;
    },
  };

  /**
   * The answer could not be delivered at all.
   *
   * Silence is the worst outcome: the reply is in the session, visible in the
   * web UI, and the chat just stops. So a new message says what happened and
   * where the answer is.
   */
  async function reportUndelivered(reason: string, partial = false): Promise<void> {
    const notice = partial
      ? `⚠ Part of this reply could not be delivered (${reason}). The full answer is in the web chat.`
      : `⚠ The answer could not be delivered (${reason}). It is saved in this session — open the web chat to read it.`;
    const ok = await attempt("failure notice", () => api.sendMessage(chatId, notice));
    if (ok) emit({ kind: "undelivered", text: notice });
  }
}
