// Dreaming: OpenClaw's nightly memory sweep, adapted to SuparClaw's workspace.
// One scheduled pass consolidates the raw daily notes (memory/YYYY-MM-DD.md)
// into the curated MEMORY.md and writes a dated "Deep Sleep" diary entry to
// DREAMS.md. An empty sweep records completion and creates no memory — that is
// the design, not a failure.

export const DREAM_SESSION_KEY = "system:dream";

/** The consolidation prompt — one sweep = light, REM and deep in one pass. */
export function dreamPrompt(today: string): string {
  return [
    "# Dreaming: memory consolidation sweep",
    "",
    `Today is ${today}. You are the nightly dreaming sweep (light review, pattern pass, deep consolidation in one run).`,
    "",
    "Goal: promote durable facts from the raw daily notes into the curated MEMORY.md.",
    "",
    "Steps:",
    "1. List the memory/ directory and read the daily notes (memory/YYYY-MM-DD.md). Skip today's note - it is still being written.",
    "2. Read MEMORY.md. Promote NEW durable facts the user actually said or that were verified: preferences, decisions, stable names, standing instructions, environment facts. Merge near-duplicates, replace stale entries, keep MEMORY.md compact and curated (roughly under 200 lines) - never a raw log.",
    "3. Leave the raw daily notes untouched. Do not invent facts. Skip secrets (tokens, passwords, private keys, raw env values).",
    `4. Append a dated diary entry to DREAMS.md under "## Deep Sleep - ${today}" listing what you promoted, or the single line "nothing new" when everything was already consolidated.`,
    "",
    "Finish with a one-line summary of what changed (or 'nothing new').",
  ].join("\n");
}

/** Auto-titles: tiny call that turns the first user message into a session name. */
export function titlePrompt(sample: string): string {
  return [
    "Give this conversation a short session title.",
    "Rules: 2-6 words, no quotes, no trailing punctuation, no markdown.",
    "",
    "The conversation starts with:",
    sample,
  ].join("\n");
}

/** Normalize a title reply: one line, unquoted, bounded, or null when junk. */
export function cleanTitle(raw: string): string | null {
  let t = String(raw ?? "").split("\n")[0] ?? "";
  t = t.replace(/["'`\u201c\u201d\u2018\u2019]/g, "").trim();
  t = t.replace(/[.!?,;:]+\s*$/, "").trim();
  t = t.replace(/\s+/g, " ");
  if (t.length > 60) t = t.slice(0, 60).replace(/\s\S*$/, "");
  t = t.trim();
  return t.length >= 2 ? t : null;
}

export interface DreamHandle {
  stop(): void;
}

/** Arm the dream schedule on its own croner timer (not the user's cron jobs). */
export async function armDream(schedule: string, fire: () => Promise<unknown>): Promise<DreamHandle> {
  const { Cron } = await import("croner");
  const cron = new Cron(schedule, { protect: true }, () => {
    void fire().catch(() => {});
  });
  return { stop: () => cron.stop() };
}
