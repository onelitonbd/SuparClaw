// Session naming — the name a chat gives itself.
//
// The trigger lives in `Service.#maybeAutoTitle` (every surface goes through
// `send()`, so every channel gets this for free). This module holds the two
// decisions that are worth testing on their own:
//
//   namingSample   what the model actually reads
//   namingDecision whether to name now, refine, or leave it alone
//
// The rule the user asked for: understand the first TWO exchanges. A chat that
// stops after one reply must not stay nameless, so the first exchange names it
// and the second refines it once. A rename by hand always wins — the caller
// stores the exact title it wrote, and anything else in `name` is the human's.

/** Exchanges a name is drawn from. */
export const NAMING_TURNS = 2;

/** One message as the transcript hands it over (role + text is all we use). */
export interface NamingMessage {
  role: string;
  content: string;
}

export interface SampleOptions {
  /** How many exchanges to include (default NAMING_TURNS). */
  turns?: number;
  /** Per-message trim, so one pasted wall of text cannot dominate. */
  maxCharsPerMessage?: number;
  /** Whole-sample cap. */
  maxChars?: number;
}

/** A slash command is a request to the runtime, never a topic for a title. */
const isCommand = (text: string): boolean => text.trimStart().startsWith("/");

/**
 * The transcript excerpt a title is generated from: whole exchanges
 * (`User:` / `Assistant:`), commands and their replies skipped, each side
 * trimmed, the whole thing bounded.
 */
export function namingSample(messages: NamingMessage[], opts: SampleOptions = {}): string {
  const turns = Math.max(1, opts.turns ?? NAMING_TURNS);
  const perMessage = Math.max(40, opts.maxCharsPerMessage ?? 600);
  const maxChars = Math.max(200, opts.maxChars ?? 2000);

  const blocks: string[] = [];
  let exchanges = 0;
  let pendingUser: string | null = null;
  for (const msg of messages) {
    const text = String(msg.content ?? "").trim();
    if (!text) continue;
    if (msg.role === "user") {
      // A command (and the exchange it triggers) is not conversation.
      pendingUser = isCommand(text) ? null : text;
      continue;
    }
    if (msg.role !== "assistant" || pendingUser === null) continue;
    const trim = (s: string): string => (s.length > perMessage ? `${s.slice(0, perMessage - 1).trimEnd()}…` : s);
    blocks.push(`User: ${trim(pendingUser)}`, `Assistant: ${trim(text)}`);
    pendingUser = null;
    exchanges += 1;
    if (exchanges >= turns) break;
  }
  if (blocks.length === 0) return "";

  const joined = blocks.join("\n");
  if (joined.length <= maxChars) return joined;
  // Cut on a message boundary so the excerpt never ends mid-sentence mid-tag.
  const lines: string[] = [];
  let total = 0;
  for (const line of blocks) {
    if (total + line.length + 1 > maxChars) break;
    lines.push(line);
    total += line.length + 1;
  }
  return lines.length > 0 ? lines.join("\n") : `${joined.slice(0, maxChars - 1).trimEnd()}…`;
}

export interface NamingDecisionInput {
  /** The row's current name (null/empty when unnamed). */
  name: string | null | undefined;
  /** The exact title this code wrote last time, if any. */
  autoTitle: string | null | undefined;
  /** Exchanges the current name was built from (0 when never named by us). */
  used: number;
  /** Exchanges present in the transcript now. */
  exchanges: number;
  turns?: number;
}

export type NamingDecision =
  | { generate: false; reason: "empty" | "named-by-human" | "complete" }
  | { generate: true; target: number; refine: boolean };

/**
 * Whether to spend a model call on a name right now.
 *
 * - nothing said yet → nothing to name
 * - the row has a name we did not write → a human named it; never touch it
 * - fewer exchanges than the cap → (re)name, using everything available
 * - cap reached and already used → done, stop calling the model
 */
export function namingDecision(input: NamingDecisionInput): NamingDecision {
  const turns = Math.max(1, input.turns ?? NAMING_TURNS);
  const exchanges = Math.max(0, Math.floor(input.exchanges));
  if (exchanges === 0) return { generate: false, reason: "empty" };

  const name = String(input.name ?? "").trim();
  const auto = String(input.autoTitle ?? "").trim();
  if (name && name !== auto) return { generate: false, reason: "named-by-human" };

  const target = Math.min(exchanges, turns);
  const used = Math.max(0, Math.floor(input.used));
  if (name && used >= target) return { generate: false, reason: "complete" };
  return { generate: true, target, refine: Boolean(name) };
}
