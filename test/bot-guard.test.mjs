// P2 #17 — bot-to-bot loop protection (sliding-window pair guard).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { BotLoopGuard, emptyConfig } = await import("../dist/lib.js");

const CFG = { enabled: true, maxEventsPerWindow: 3, windowSeconds: 60, cooldownSeconds: 90 };

test("admission under the budget passes; exceeding it suppresses for the cooldown", () => {
  const g = new BotLoopGuard();
  const t0 = 1_000_000;
  assert.equal(g.admit("botA", "us", "chat1", CFG, t0), true);
  assert.equal(g.admit("botA", "us", "chat1", CFG, t0 + 1000), true);
  assert.equal(g.admit("botA", "us", "chat1", CFG, t0 + 2000), true);
  // 4th event in the same window ⇒ burst ⇒ suppressed + cooldown armed.
  assert.equal(g.admit("botA", "us", "chat1", CFG, t0 + 3000), false);
  assert.equal(g.admit("botA", "us", "chat1", CFG, t0 + 5000), false, "still inside cooldown");
  assert.ok(g.cooldownRemaining("botA", "us", "chat1", t0 + 5000) > 0);
});

test("cooldown expires and the pair resumes; window slides", () => {
  const g = new BotLoopGuard();
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) g.admit("botA", "us", "c", CFG, t0 + i * 1000);
  g.admit("botA", "us", "c", CFG, t0 + 3000); // burst
  assert.equal(g.admit("botA", "us", "c", CFG, t0 + 3000 + 95_000), true, "after cooldownSeconds the pair is fresh");
  // Sliding window: spaced events under the budget never burst.
  const t1 = t0 + 500_000;
  assert.equal(g.admit("botB", "us", "c", CFG, t1), true);
  assert.equal(g.admit("botB", "us", "c", CFG, t1 + 31_000), true);
  assert.equal(g.admit("botB", "us", "c", CFG, t1 + 61_000), true); // 30s spacing ⇒ all inside budget over time
  assert.equal(g.admit("botB", "us", "c", CFG, t1 + 91_000), true, "slower exchanges continue (their rule)");
});

test("A→B and B→A count as the SAME pair; conversations stay separate", () => {
  const g = new BotLoopGuard();
  const t0 = 1_000_000;
  g.admit("botA", "us", "c", CFG, t0);
  g.admit("us", "botA", "c", CFG, t0 + 500); // reversed direction, same pair
  g.admit("botA", "us", "c", CFG, t0 + 900);
  assert.equal(g.admit("us", "botA", "c", CFG, t0 + 1200), false, "reversed direction bursts the shared budget");
  assert.equal(g.admit("botA", "us", "other-chat", CFG, t0 + 1200), true, "other conversations unaffected");
});

test("enabled:false admits everything; pruning forgets stale pairs", () => {
  const g = new BotLoopGuard();
  const off = { ...CFG, enabled: false };
  for (let i = 0; i < 10; i++) assert.equal(g.admit("botA", "us", "c", off, 1000 + i), true, "guard off ⇒ no accounting");
  const t0 = 2_000_000;
  g.admit("botA", "us", "c", CFG, t0);
  g.prune(t0 + 25 * 3600 * 1000);
  assert.equal(g.cooldownRemaining("botA", "us", "c", t0 + 26 * 3600 * 1000), 0);
});

test("schema defaults: telegram.allowBots false; defaults guard 20/60/60 with telegram override layer", () => {
  const cfg = emptyConfig();
  assert.equal(cfg.channels.telegram.allowBots, false, "bot-authored messages refused by default");
  const shared = cfg.channels.defaults.botLoopProtection;
  assert.deepEqual(shared, { enabled: true, maxEventsPerWindow: 20, windowSeconds: 60, cooldownSeconds: 60 });
  assert.deepEqual(cfg.channels.telegram.botLoopProtection, shared, "telegram override layer ships the same built-in defaults");
});
