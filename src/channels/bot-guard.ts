// P2 #17 — bot-to-bot loop protection.
//
// Upstream contract (docs/openclaw/channels/bot-loop-protection.md): channels
// admit bot-authored messages only under an allowBots flag (Telegram defaults
// to refusing them); an admitted bot pair is then bounded by a sliding-window
// budget — A→B and B→A count as the same pair — and the pair is suppressed
// for a cooldown once it exceeds the budget. Human messages, single-bot
// deployments and self-message filtering are never affected.
import type { BotLoopProtectionConfig } from "../config/schema.js";

interface PairState {
  /** Event timestamps within the current sliding window. */
  events: number[];
  /** Suppression horizon (epoch ms), 0 when the pair is not cooling down. */
  cooldownUntil: number;
}

export class BotLoopGuard {
  #pairs = new Map<string, PairState>();

  /**
   * Record one bot-authored event for a (sender, receiver, conversation)
   * triple. Returns the verdict for THIS event: admit it or suppress it.
   * Events observed during a cooldown are suppressed without extending it.
   */
  admit(senderBotId: string, receiverBotId: string, conversationId: string, cfg: BotLoopProtectionConfig, now = Date.now()): boolean {
    if (!cfg.enabled) return true;
    const pairKey = `${[senderBotId, receiverBotId].sort().join("↔")}|${conversationId}`;
    let state = this.#pairs.get(pairKey);
    if (!state) {
      state = { events: [], cooldownUntil: 0 };
      this.#pairs.set(pairKey, state);
    }
    if (state.cooldownUntil > now) return false;
    const windowMs = cfg.windowSeconds * 1000;
    state.events = state.events.filter((t) => now - t < windowMs);
    if (state.events.length >= cfg.maxEventsPerWindow) {
      state.cooldownUntil = now + cfg.cooldownSeconds * 1000;
      state.events = [];
      return false;
    }
    state.events.push(now);
    return true;
  }

  /** Live cooldown remaining (seconds) for a pair — for status/diagnostics. */
  cooldownRemaining(senderBotId: string, receiverBotId: string, conversationId: string, now = Date.now()): number {
    const key = `${[senderBotId, receiverBotId].sort().join("↔")}|${conversationId}`;
    const s = this.#pairs.get(key);
    return s && s.cooldownUntil > now ? Math.ceil((s.cooldownUntil - now) / 1000) : 0;
  }

  /** Housekeeping for long-running daemons (pairs fade with their windows). */
  prune(now = Date.now()): void {
    for (const [key, state] of this.#pairs) {
      if (state.cooldownUntil > now) continue;
      const fresh = state.events.filter((t) => now - t < 24 * 3600 * 1000);
      if (fresh.length === 0) this.#pairs.delete(key);
      else state.events = fresh;
    }
  }
}
