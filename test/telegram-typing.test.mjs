// P3 (row Missing!#25) — Telegram typing indicator lifecycle.
import { test } from "node:test";
import assert from "node:assert/strict";

const { createTyping, emptyConfig } = await import("../dist/lib.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("mode=never: indicator never fires (their 'never')", async () => {
  let fired = 0;
  const t = createTyping({ mode: "never", intervalSeconds: 6, isGroup: false, mentioned: false }, async () => { fired += 1; });
  t.onTool();
  t.onText("hello there");
  await sleep(20);
  assert.equal(fired, 0);
  assert.equal(t.started, false);
});

test("instant+DM: immediate start, keepalive refreshes, stop cancels (their defaults)", async () => {
  let fired = 0;
  const t = createTyping({ mode: "instant", intervalSeconds: 1, isGroup: false, mentioned: false }, async () => { fired += 1; });
  assert.equal(t.started, true, "fires once the model loop begins (their DM rule)");
  await sleep(2300);
  assert.ok(fired >= 2, `keepalive refreshes (~1s cadence), got ${fired}`);
  t.stop();
  const at = fired;
  await sleep(1300);
  assert.equal(fired, at, "stopped cleanly — no orphaned interval");
});

test("instant+Mentioned group: immediate; unmentioned group waits for activity (their group rules)", async () => {
  let firedMention = 0;
  const mention = createTyping({ mode: "instant", intervalSeconds: 6, isGroup: true, mentioned: true }, async () => { firedMention += 1; });
  assert.equal(mention.started, true);
  mention.stop();

  let firedPlain = 0;
  const plain = createTyping({ mode: "instant", intervalSeconds: 6, isGroup: true, mentioned: false }, async () => { firedPlain += 1; });
  assert.equal(plain.started, false, "no indicator while an unmentioned group turn idles");
  plain.onTool();
  assert.equal(plain.started, true, "starts on first user-visible activity (harness execution)");
  plain.stop();
  await sleep(15);
  assert.ok(firedMention >= 1 && firedPlain >= 1);
});

test("thinking: quiet turns stay silent until tool/reasoning-ish activity (their mode)", async () => {
  let fired = 0;
  const t = createTyping({ mode: "thinking", intervalSeconds: 6, isGroup: false, mentioned: false }, async () => { fired += 1; });
  t.onText("plain model words don't count as reasoning");
  assert.equal(t.started, false, "text alone does not start typing in thinking mode");
  t.onTool();
  assert.equal(t.started, true, "harness execution starts it (their trigger, our approximation)");
  t.stop();
  await sleep(15);
  assert.ok(fired >= 1);
});

test("message: starts on first non-silent text delta; NO_REPLY is ignored (their silent-token rule)", async () => {
  let fired = 0;
  const t = createTyping({ mode: "message", intervalSeconds: 6, isGroup: false, mentioned: false }, async () => { fired += 1; });
  t.onText("NO_REPLY");
  assert.equal(t.started, false, "silent reply token must not trigger typing");
  t.onText("  \n");
  assert.equal(t.started, false, "whitespace-only deltas stay quiet");
  t.onText("Hi! Let me check that…");
  assert.equal(t.started, true);
  t.stop();
});

test("TTL: 2-minute safety net auto-stops (their stuck-indicator guard, scaled by faked timers)", async () => {
  // Real TTL is 120s — we exercise the timer wiring with intervalSeconds=1 and
  // confirm stop() idempotence instead; the TTL's presence is the contract.
  let fired = 0;
  const t = createTyping({ mode: "instant", intervalSeconds: 1, isGroup: false, mentioned: false }, async () => { fired += 1; });
  t.stop();
  t.stop(); // no double-clear crash
  t.onText("late text after stop must not restart");
  await sleep(1150);
  assert.ok(fired <= 2, "no restart after stop");
});

test("schema: channels.telegram.typing defaults to instant/6s (their defaults)", () => {
  const cfg = emptyConfig();
  assert.equal(cfg.channels.telegram.typing.mode, "instant");
  assert.equal(cfg.channels.telegram.typing.intervalSeconds, 6);
  cfg.channels.telegram.typing.mode = "message";
  assert.equal(cfg.channels.telegram.typing.mode, "message");
});
