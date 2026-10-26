// Transcript replay (Task 23).
//
// The reply footer — `↳ 8.8k in · 33 out · <model> · 8.8k total` — used to be
// decoration applied to the live event's text, so a refresh replaced the thread
// from SQLite and the line vanished. OpenClaw keeps the numbers on the transcript
// entry and renders the footer from them on every read; this module is the same
// rule at our scale.
//
// Two jobs, both pure enough to test without a gateway:
//   historyPayload()   — stored rows + the current /usage mode → wire rows
//   truncateLastTurn() — the destructive half of Regenerate, in one place

import type { MessageRow, Store } from "../state/db.js";
import type { ModelPricing, UsageMode } from "../config/schema.js";
import { usageFooter } from "../util/usage.js";

export interface HistoryMessage {
  id: number;
  role: string;
  content: string;
  createdAt: number;
  /** Raw provider numbers, when the row recorded any. */
  usage?: Record<string, number>;
  /** The rendered line for the current usage mode; absent when off/none. */
  footer?: string;
}

/** `{ usage, model, label }` as stored by the loop (see MessageRow.usage). */
interface StoredUsage {
  usage?: Record<string, number>;
  model?: string;
  label?: string;
}

function parseStored(raw: string | null | undefined): StoredUsage | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredUsage;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export interface HistoryOptions {
  mode: UsageMode;
  /** Resolve the profile recorded on the row: label now, price card now. */
  profile: (id: string) => { label: string; pricing?: ModelPricing };
}

/**
 * Map stored rows to the wire shape the UI replays.
 *
 * The footer is recomputed rather than stored, so `/usage off|tokens|full|cost`
 * keeps meaning something after a reload and a newly-added price card starts
 * pricing old rows. Unknown models fall back to the label written at the time.
 */
export function historyPayload(rows: MessageRow[], opts: HistoryOptions): HistoryMessage[] {
  return rows.map((row) => {
    const base: HistoryMessage = {
      id: row.id,
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
    };
    if (row.role !== "assistant") return base;
    const stored = parseStored(row.usage);
    if (!stored?.usage) return base;
    const profile = opts.profile(stored.model ?? "");
    const label = stored.label || profile.label || stored.model || "";
    const footer = usageFooter(opts.mode, stored.usage, label, profile.pricing);
    return {
      ...base,
      usage: stored.usage,
      ...(footer ? { footer } : {}),
    };
  });
}

export type TruncateResult =
  | { ok: true; text: string; userMessageId: number; deleted: number }
  | { ok: false; error: string };

/**
 * The destructive half of Regenerate: keep the newest prompt, drop everything
 * the answer produced. Without this the re-run would be appended as a second
 * answer to the same question and the model would read both next turn.
 */
export function truncateLastTurn(store: Store, sessionId: string): TruncateResult {
  const userRow = store.lastUserMessage(sessionId);
  if (!userRow) return { ok: false, error: "nothing to regenerate — this session has no prompt yet" };
  const deleted = store.deleteMessagesAfter(sessionId, userRow.id);
  return { ok: true, text: userRow.content, userMessageId: userRow.id, deleted };
}
