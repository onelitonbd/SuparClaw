// P2 #16 — tool-use loop detection (per-turn).
//
// Upstream contract (docs/openclaw/tools/loop-detection.md): the agent loop
// tracks tool calls per turn and stops the model from burning the session on
// a repeated call that clearly makes no progress. Their layered behaviour:
//
//   1. AN identical call that errors out 3 times in a row ALWAYS breaks the
//      turn, even when the detector is disabled — the always-on safety net
//      (their "always" rule for consecutive identical errors).
//   2. With loopDetection.enabled (default FALSE, like upstream) a rolling detector watches
//      the last 10 calls; ANY call — success or error — seen 3 times in that
//      window breaks the turn. Validation failures (unknown tool, bad args)
//      count too (their nuance: never-reached calls still loop).
//   3. Exec-style identity evasion: a polling loop that varies its args
//      (e.g. env changes each time) evades (tool,args) identity, so the
//      rolling detector ALSO matches on (tool, output-signature) — the
//      identical RESULT gives the loop away (their upstream issue fix).
//      Task 38: only FAILED results count at three. Three successful commands
//      that happen to print the same short thing (`ls`, a clean `git status`,
//      a grep with no hits) are ordinary work, not a loop; successes need four
//      before this layer calls it one — and even then the turn is only nudged,
//      not stopped (see `loopGuardNudge`).
//   4. Post-compaction guard: after a context-overflow compaction retry the
//      model loses its look-back, so the identical-error budget tightens to
//      the SAME call twice (their "post-compaction repetition limits") until
//      any call succeeds. Only armed while the detector is enabled.

export interface ToolLoopBreak {
  reason: string;
  tool: string;
  count: number;
}

interface RecentCall {
  /** Full identity: tool + args + output signature. */
  sig: string;
  /** Identity for the evasion-safe layer: tool + output signature only. */
  outSig: string;
  failed: boolean;
}

const ROLLING_WINDOW = 10;
const ROLLING_LIMIT = 3;
/** Successful repeats are cheaper to misread, so they need one more hit. */
const ROLLING_LIMIT_OK = 4;
const STREAK_LIMIT = 3;
const STREAK_LIMIT_POST_COMPACT = 2;

export class ToolLoopDetector {
  #recent: RecentCall[] = [];
  #streak = 0;
  #streakSig = "";
  #postCompact = false;

  constructor(private readonly enabled: boolean) {}

  /**
   * Arm the post-compaction guard (after an overflow compact+retry).
   *
   * A no-op when the detector is disabled: upstream's `enabled: false` turns
   * off the post-compaction guard too (loop-detection.md:79), so switching this
   * setting off means exactly one guard is left — the identical-error one.
   */
  armPostCompaction(): void {
    if (!this.enabled) return;
    this.#postCompact = true;
  }

  /** How many consecutive attempts the current failing call has survived. */
  get streakCount(): number {
    return this.#streak;
  }

  /**
   * Record one tool outcome. `argsRaw` is the model's raw JSON args (never
   * parsed here — validation failures must count as their own signature).
   * Returns a break verdict exactly ONCE per offender: after a break the
   * loop ends, so subsequent records shouldn't re-break (the final pass).
   */
  record(tool: string, argsRaw: string, output: string): ToolLoopBreak | null {
    const outputSig = output.slice(0, 200);
    const sig = `${tool}:${argsRaw}:${outputSig}`;
    const failed = output.startsWith("error");

    // Layer 1+4: consecutive identical ERRORS — always on.
    if (failed) {
      if (sig === this.#streakSig) this.#streak += 1;
      else {
        this.#streakSig = sig;
        this.#streak = 1;
      }
      const limit = this.#postCompact ? STREAK_LIMIT_POST_COMPACT : STREAK_LIMIT;
      if (this.#streak >= limit) {
        const label = this.#postCompact ? "post-compaction guard" : "identical error streak";
        this.#streak = 0; // one break per offender
        this.#streakSig = "";
        return {
          tool,
          count: limit,
          reason: `${tool} returned the identical error ${limit} times in a row (${label})`,
        };
      }
    } else {
      this.#streak = 0;
      this.#streakSig = "";
      if (this.#postCompact) this.#postCompact = false; // progress disarms the tight budget
    }

    // Layer 2+3: rolling window — enabled-gated.
    if (!this.enabled) return null;
    const entry: RecentCall = { sig, outSig: `${tool}:${outputSig}`, failed };
    this.#recent.push(entry);
    if (this.#recent.length > ROLLING_WINDOW) this.#recent.shift();

    const sameIdentity = this.#recent.filter((r) => r.sig === sig).length;
    if (sameIdentity >= ROLLING_LIMIT) {
      this.#recent = this.#recent.filter((r) => r.sig !== sig);
      return {
        tool,
        count: sameIdentity,
        reason: `${tool} repeated the identical call ${sameIdentity} times in the last ${ROLLING_WINDOW} calls`,
      };
    }
    // Evasion-safe layer: identical RESULT from same tool with varying args
    // (their exec-identity fix). A failure repeated is a loop at three; a
    // success repeated needs four — and success is only ever a *nudge* (the
    // loop does not stop on it), because `ls`, `git status` and an empty grep
    // legitimately print the same thing three times in a row.
    const sameOutcome = this.#recent.filter((r) => r.outSig === entry.outSig).length;
    const outcomeLimit = entry.failed ? ROLLING_LIMIT : ROLLING_LIMIT_OK;
    if (sameOutcome >= outcomeLimit) {
      this.#recent = this.#recent.filter((r) => r.outSig !== entry.outSig);
      return {
        tool,
        count: sameOutcome,
        reason: `${tool} produced the identical result ${sameOutcome} times in the last ${ROLLING_WINDOW} calls (repeating without progress)`,
      };
    }
    return null;
  }
}

/**
 * First-strike note (Task 38). The turn keeps going: the model is told what
 * repeated and asked to do something different, with every tool still on the
 * table. Ending a whole turn on the first suspicion of a loop is what made a
 * single stuck command look like a dead session.
 */
export function loopGuardNudge(brk: ToolLoopBreak): string {
  return (
    `[tool-loop guard] ${brk.reason}. Nothing was cancelled — this is a warning, not a stop. ` +
    `Do not repeat that same call. Change the approach (different arguments, a different tool, ` +
    `or read what you already have) and keep going. If you are deliberately polling something ` +
    `that is still changing, say so in one line and vary the check. ` +
    `A second repetition ends this turn, so make the next call count.`
  );
}

/** Final-strike message injected as a user note so the model must answer plainly. */
export function loopGuardPrompt(brk: ToolLoopBreak): string {
  return (
    `[tool-loop guard] ${brk.reason}. The attempt was stopped — DO NOT retry the same call. ` +
    `Reply to the user explaining what you were trying to do, that it kept failing the same way, ` +
    `and what input or change would let you proceed.`
  );
}
