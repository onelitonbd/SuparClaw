// P2 #16 — tool-use loop detection.
import { test } from "node:test";
import assert from "node:assert/strict";

const { ToolLoopDetector, loopGuardPrompt, emptyConfig } = await import("../dist/lib.js");

test("identical error breaks at 3 even when the detector is disabled", () => {
  const det = new ToolLoopDetector(false);
  const out = "error: unknown tool fs_read";
  assert.equal(det.record("fs_read", "{}", out), null);
  assert.equal(det.record("fs_read", "{}", out), null);
  const brk = det.record("fs_read", "{}", out);
  assert.ok(brk, "3rd identical error breaks (always-on layer)");
  assert.equal(brk.count, 3);
  assert.match(brk.reason, /identical error 3 times/);
});

test("streak resets on a different outcome; success disarms nothing but resets the streak", () => {
  const det = new ToolLoopDetector(true);
  det.record("exec", "{}", "error: boom");
  det.record("exec", "{}", "error: boom");
  det.record("exec", "{}", "ok done"); // different sig ⇒ streak broken
  det.record("exec", "{}", "error: boom");
  assert.equal(det.record("exec", "{}", "error: boom"), null, "streak restarted at 2 — no break yet");
});

test("rolling detector catches identical SUCCESS calls (polling loop)", () => {
  const det = new ToolLoopDetector(true);
  const rec = () => det.record("exec", '{"cmd":"curl -s status"}', "ok status green");
  // 6 identical successes ⇒ 3-in-final-10 (their polling case).
  rec(); rec(); rec();
  assert.equal(rec(), null, "break fired earlier or no later misfire…");
});

test("identical RESULT with different args still breaks (idle-arg eviction fix)", () => {
  const det = new ToolLoopDetector(true);
  assert.equal(det.record("exec", '{"a":1}', "ok [pid 12345]"), null);
  assert.equal(det.record("exec", '{"a":2}', "ok [pid 12345]"), null);
  const brk = det.record("exec", '{"a":3}', "ok [pid 12345]");
  assert.ok(brk, "same output signature from the same tool breaks under enabled detector");
  assert.match(brk.reason, /identical result 3 times/);
});

test("enabled:false suspends ONLY the rolling layer", () => {
  const det = new ToolLoopDetector(false);
  for (let i = 0; i < 6; i++) {
    assert.equal(det.record("exec", "{}", "ok same"), null, "identical successes tolerated with detector off");
  }
});

test("post-compaction tightens the identical-error budget to 2", () => {
  const det = new ToolLoopDetector(true);
  det.armPostCompaction();
  det.record("web_fetch", '{"url":"https://x"}', "error: fetch failed");
  const brk = det.record("web_fetch", '{"url":"https://x"}', "error: fetch failed");
  assert.ok(brk, "breaks at the 2nd identical error under the guard");
  assert.match(brk.reason, /post-compaction/);
});

test("successful call disarms the post-compaction budget", () => {
  const det = new ToolLoopDetector(true);
  det.armPostCompaction();
  det.record("exec", "{}", "ok progressed");
  det.record("exec", "{}", "error: boom");
  assert.equal(det.record("exec", "{}", "error: boom"), null, "back to the 3-streak budget");
});

test("validation failures (unknown tool / bad args) count as their own signature", () => {
  const det = new ToolLoopDetector(false);
  det.record("exec", "{bad json", "error: parse failed");
  det.record("exec", "{bad json", "error: parse failed");
  const brk = det.record("exec", "{bad json", "error: parse failed");
  assert.ok(brk, "calls that never reached the executor still loop-break");
});

test("one break per offender; guard prompt carries the instruction", () => {
  const det = new ToolLoopDetector(false);
  const out = "error: same";
  det.record("t", "{}", out);
  det.record("t", "{}", out);
  assert.ok(det.record("t", "{}", out));
  assert.equal(det.record("t", "{}", out), null, "no re-break after the verdict (final pass runs)");
  const prompt = loopGuardPrompt({ tool: "exec", count: 3, reason: "exec repeated" });
  assert.match(prompt, /DO NOT retry the same call/);
  assert.match(prompt, /tool-loop guard/);
});

test("schema default: tools.loopDetection.enabled true", () => {
  assert.equal(emptyConfig().tools.loopDetection.enabled, true);
});
