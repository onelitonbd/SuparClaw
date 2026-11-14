// P1 A2 — context compaction (rolling transcript summarization).
//
// Upstream contract researched in docs/openclaw/concepts/compaction.md:
// near-limit auto-compaction + recovery retry on provider overflow errors,
// the summary is produced by ONE tool-free model request and stored durably,
// the recent tail always stays verbatim in the prompt, rewrites are
// incremental (extend the covered span, never resummarize the tail), counts
// surface in /status, and /compact [instructions] forces a sweep with a
// focus hint. Out at our scale: quality-audit corrective passes, split-turn
// budgets, CJK tallies, provider-native checkpoints, the memory-flush hook
// (daily dreaming covers that).
import type { MessageRow } from "../state/db.js";

/** Tail kept verbatim after compaction — ~35 entry pairs like theirs. */
export const KEEP_TAIL_ROWS = 70;
/** Summarizer input clamp (their ≤160k-char budget shrunk to our spans). */
export const SUMMARIZER_INPUT_CAP = 80 * 1024;
/** Hard bound on the stored summary (their bounded-summary idea). */
export const SUMMARY_TARGET_CHARS = 6000;
/** Auto-sweep arm point: older transcript past this share of the budget compacts. */
export const AUTO_TRIGGER = 0.7;

export interface CompactPlan {
  /** Message rows the next sweep should summarize (oldest-first, user/assistant only). */
  span: MessageRow[];
  /** Row count of the verbatim tail preserved after the summary. */
  tailRows: number;
  spanChars: number;
}

/**
 * Decide what to compact. Rows are the session's transcript after the summary
 * frontier (id > upto), oldest-first. Only user/assistant rows carry content
 * into the prompt; tool/reasoning rows ride along via the span boundary id.
 */
export function planCompactSpan(rows: MessageRow[], keepTail = KEEP_TAIL_ROWS): CompactPlan | null {
  const eligible = rows.filter((r) => r.role === "user" || r.role === "assistant");
  if (eligible.length <= keepTail) return null;
  const span = eligible.slice(0, eligible.length - keepTail);
  const spanChars = span.reduce((n, r) => n + r.content.length, 0);
  if (spanChars === 0) return null;
  return { span, tailRows: keepTail, spanChars };
}

/** Newest-first clamp to the summarizer input budget (fragments their "gaps marked" rule). */
export function clampSpanInput(span: MessageRow[]): { rows: MessageRow[]; clipped: number } {
  const picked: MessageRow[] = [];
  let used = 0;
  for (let i = span.length - 1; i >= 0; i -= 1) {
    const r = span[i]!;
    const next = used + r.content.length;
    if (picked.length > 0 && next > SUMMARIZER_INPUT_CAP) break;
    picked.unshift(r);
    used = next;
  }
  return { rows: picked, clipped: span.length - picked.length };
}

/** The single tool-free summarizer request (their prompt shape at our scale). */
export function summarizerPrompt(input: { previous: string; spanText: string; clipped: number; focus?: string }): string {
  return [
    "You update the rolling summary of a long-running chat transcript so the conversation can continue without the earlier messages.",
    "",
    input.previous
      ? `## Summary so far\n${input.previous}`
      : "(No previous summary — this is the first compaction of this session.)",
    "",
    "## New transcript to fold in (oldest first)",
    ...[input.clipped > 0 ? `[...${input.clipped} earlier message(s) not shown — already covered by the summary so far]` : []],
    input.spanText,
    "",
    "## Task",
    `Rewrite the summary to cover everything above, in under ${SUMMARY_TARGET_CHARS} characters.`,
    "Keep: decisions made, facts learned, plans, file paths, commands, IDs, numbers, names, open questions and user preferences.",
    "Drop: greetings, filler, intermediate failed attempts that were superseded, verbatim dumps.",
    input.focus ? `\nExtra focus for this compaction (keep these aspects in detail): ${input.focus}` : "",
    "Reply with ONLY the new summary text.",
  ]
    .filter((l) => l !== undefined)
    .join("\n");
}

/** Render span rows as transcript lines for the summarizer. */
export function renderSpan(rows: MessageRow[]): string {
  return rows.map((r) => `${r.role === "user" ? "User" : "Assistant"}: ${r.content}`).join("\n\n");
}

/**
 * Provider-side context overflow detection — their error shapes
 * (OpenAI context_length_exceeded, Anthropic/Gemini phrasing, proxies).
 * Runs on the exhausted error AFTER the retry/fallback chain already tried.
 */
export function isContextOverflowError(err: unknown): boolean {
  const e = err as { message?: string; status?: number; code?: string } | null;
  if (!e || typeof e.message !== "string") return false;
  const m = `${e.code ?? ""} ${e.message}`.toLowerCase();
  if (!/context|token|length|window|too (long|large|many)/.test(m)) return false;
  if (e.status !== undefined && e.status !== 400 && e.status !== 413) return false;
  return (
    m.includes("context_length_exceeded") ||
    m.includes("maximum context length") ||
    m.includes("context window") ||
    m.includes("context length") ||
    m.includes("prompt is too long") ||
    m.includes("prompt too long") ||
    m.includes("input is too long") ||
    m.includes("too many tokens") ||
    m.includes("exceeds the maximum") ||
    m.includes("reduce your prompt") ||
    m.includes("request entity too large") ||
    m.includes("token limit")
  );
}
