// P2 #8 — ask_user tool support (their tools/ask-user.md).
//
// Contract: up to 3 questions per call, 2–4 options each, "Other" is always
// offered implicitly (free-text answer), "Skip" always available — in the
// MAIN session only, and answers ride EVERY supported surface: inline
// keyboards on telegram, an option card on the web UI, and plain numbered
// text replies everywhere. No time limit on the user's answer (house rule),
// so the tool waits until answered or skipped.

export interface AskUserQuestion {
  id: string; // stable id (q1..q3 when absent)
  question: string;
  options: string[]; // 2–4
  multi: boolean; // multiple selections allowed
}

export interface AskUserResult {
  answers: Record<string, string[]>;
  /** true when the user explicitly skipped the whole question set. */
  skipped: boolean;
}

export const ASK_LIMITS = { maxQuestions: 3, minOptions: 2, maxOptions: 4 } as const;

/** Validate + normalize the model's tool args; error string when malformed. */
export function normalizeAskUserArgs(args: Record<string, unknown>): { questions: AskUserQuestion[]; error?: string } {
  const raw = args["questions"];
  if (!Array.isArray(raw) || raw.length === 0) return { questions: [], error: "questions must be a non-empty array" };
  if (raw.length > ASK_LIMITS.maxQuestions) return { questions: [], error: `at most ${ASK_LIMITS.maxQuestions} questions per call` };
  const questions: AskUserQuestion[] = [];
  for (let i = 0; i < raw.length; i++) {
    const q = raw[i] as Record<string, unknown>;
    const text = String(q?.["question"] ?? "").trim();
    if (!text) return { questions: [], error: `question ${i + 1}: missing text` };
    const optionsRaw = q?.["options"];
    if (!Array.isArray(optionsRaw)) return { questions: [], error: `question ${i + 1}: options must be an array` };
    const options = optionsRaw.map((o) => String(o).trim()).filter(Boolean);
    if (options.length < ASK_LIMITS.minOptions || options.length > ASK_LIMITS.maxOptions) {
      return { questions: [], error: `question ${i + 1}: ${ASK_LIMITS.minOptions}–${ASK_LIMITS.maxOptions} options required (Other/Skip are added for you)` };
    }
    const id = String(q?.["id"] ?? `q${i + 1}`).replace(/\W+/g, "-").toLowerCase() || `q${i + 1}`;
    questions.push({ id, question: text, options, multi: q?.["multi"] === true });
  }
  const ids = new Set(questions.map((q) => q.id));
  if (ids.size !== questions.length) return { questions: [], error: "question ids must be unique" };
  return { questions };
}

/**
 * Interpret a free-form text reply against a question (their doc's exact
 * list: numbers, labels, or anything else = a custom/"Other" answer).
 * Returns:
 *   {kind:"answer", value:string[]} — resolved selections (custom included)
 *   {kind:"skip"} — the user declined this question
 *   null — doesn't look like an answer (leave the pipeline alone)
 */
export function matchTextReply(
  q: AskUserQuestion,
  text: string,
): { kind: "answer"; value: string[]; custom?: boolean } | { kind: "skip" } | null {
  const t = text.trim();
  if (!t) return null;
  if (/^(skip|next|pass)$/i.test(t)) return { kind: "skip" };

  // Numeric: "2" or multi "1,3" / "1 and 3".
  const nums = /^(\d+)(?:\s*[, +]\s*(\d+))*$/.test(t)
    ? t.split(/[,\s+]+/).filter(Boolean).map(Number)
    : null;
  if (nums && nums.length > 0 && nums.every((n) => n >= 1 && n <= q.options.length)) {
    if (!q.multi && nums.length > 1) return null;
    return { kind: "answer", value: [...new Set(nums)].map((n) => q.options[n - 1]!) };
  }

  // Label / "other …" free text.
  const lowered = t.toLowerCase();
  const exact = q.options.filter((o) => o.toLowerCase() === lowered);
  if (exact.length === 1) return { kind: "answer", value: exact };
  const pref = q.options.filter((o) => o.toLowerCase().startsWith(lowered));
  if (pref.length === 1 && lowered.length >= 3) return { kind: "answer", value: pref };
  if (lowered === "other" || lowered.startsWith("other:") || lowered.startsWith("other ")) {
    const rest = t.replace(/^other[: ]?\s*/i, "");
    return rest ? { kind: "answer", value: [rest], custom: true } : { kind: "answer", value: [], custom: true };
  }
  // Multi via comma-separated labels.
  if (q.multi && t.includes(",")) {
    const parts = t.split(",").map((p) => p.trim()).filter(Boolean);
    const resolved: string[] = [];
    for (const p of parts) {
      const m = q.options.filter((o) => o.toLowerCase() === p.toLowerCase());
      if (m.length !== 1) return { kind: "answer", value: [t], custom: true }; // any bad part → whole thing is custom
      resolved.push(m[0]!);
    }
    if (resolved.length >= 2) return { kind: "answer", value: resolved };
  }
  // Ordinary chatter is NOT an answer: the strict interception rule keeps
  // normal conversation flowing while a question waits; custom answers ride
  // the explicit "Other" path (button/keyword) instead.
  return null;
}

/** Human rendering of a question with numbered options + Other/Skip (telegram/TUI text surfaces). */
export function renderQuestionText(q: AskUserQuestion, idx: number, total: number): string {
  const head = total > 1 ? `Question ${idx}/${total}` : "Question";
  const lines = [`❓ ${head}: ${q.question}`];
  q.options.forEach((o, i) => lines.push(`  ${i + 1} — ${o}`));
  lines.push("  Other — reply with your own words");
  lines.push("  Skip — reply \"skip\" to leave this unanswered");
  if (q.multi) lines.push("(pick multiple: \"1,3\" or \"label, label\")");
  return lines.join("\n");
}
