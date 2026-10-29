// P3 #24 — typing indicator lifecycle (their agents.defaults.typingMode
// semantics; pure and dependency-free so lib/tests can import it without the
// channel stack). Bound to sendChatAction by the telegram channel.
export interface TypingHandle {
  onTool: () => void;
  onText: (text: string) => void;
  stop: () => void;
  /** exposed for tests/observability. */
  readonly started: boolean;
}

/**
 * P3 #24 — typing lifecycle (their agents.defaults.typingMode contract):
 *
 * - never → no indicator, ever.
 * - instant → DMs and explicit mentions start immediately once the turn is
 *   accepted; group chats without a mention start on the first user-visible
 *   activity (their rule).
 * - thinking → first reasoning-ish signal; reasoning deltas aren't surfaced
 *   to channels here, so tool execution stands in for "harness execution".
 * - message → first non-silent text delta (their NO_REPLY silent-token rule)
 *   or tool execution.
 *
 * Refresh rides a keepalive every `intervalSeconds` (their 6s default), with
 * a 2-minute TTL so a lost stop never pins the indicator forever (their TTL).
 */
export function createTyping(
  opts: { mode: "instant" | "thinking" | "message" | "never"; intervalSeconds: number; isGroup: boolean; mentioned: boolean },
  fire: () => Promise<void>,
): TypingHandle {
  if (opts.mode === "never") {
    return { onTool: () => {}, onText: () => {}, stop: () => {}, started: false };
  }
  let interval: NodeJS.Timeout | null = null;
  let ttl: NodeJS.Timeout | null = null;
  let started = false;
  let stopped = false; // latched: late deltas must not re-arm a finished turn
  const stop = () => {
    if (!started) { stopped = true; return; }
    started = false;
    stopped = true;
    if (interval) clearInterval(interval);
    if (ttl) clearTimeout(ttl);
    interval = null;
    ttl = null;
  };
  const start = () => {
    if (started || stopped) return;
    started = true;
    void fire();
    interval = setInterval(() => void fire(), Math.max(1, opts.intervalSeconds) * 1000);
    interval.unref?.();
    ttl = setTimeout(() => stop(), 120_000);
    ttl.unref?.();
  };
  const immediate = opts.mode === "instant" && (!opts.isGroup || opts.mentioned);
  if (immediate) start();
  const handle: TypingHandle = {
    onTool: () => {
      if (!started) start(); // user-visible activity (their harness-execution trigger)
    },
    onText: (text: string) => {
      if (started) return;
      if (opts.mode === "instant" || opts.mode === "message") {
        const t = text.trim();
        if (t && t !== "NO_REPLY") start(); // non-silent deltas only
      }
    },
    stop,
    get started() {
      return started;
    },
  };
  return handle;
}
