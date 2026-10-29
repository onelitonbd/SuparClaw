// P1 A2 — context compaction: store, span planning, prompt, overflow recovery, loop wiring.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_TMP = tmpdir();
const lib = await import("../dist/lib.js");
const { AgentLoop, Store, createLogger, emptyConfig, planCompactSpan, clampSpanInput, summarizerPrompt, renderSpan, isContextOverflowError } = lib;

const mkStore = (t, name) => {
  const home = mkdtempSync(join(TEST_TMP, name));
  process.env.SUPARCLAW_HOME = home;
  const store = Store.open(join(home, "state.sqlite"));
  t.after(() => store.close());
  return { home, store };
};

const rows = (n, chars = 10) => Array.from({ length: n }, (_, i) => ({
  id: i + 1,
  session_id: "s",
  run_id: null,
  role: i % 2 ? "assistant" : "user",
  content: "x".repeat(chars),
  created_at: i,
}));

test("store: session_summaries migration, set/get, count advances only when upto extends", (t) => {
  const { store } = mkStore(t, "sc-comp-store-");
  assert.equal(store.getSummary("s1"), null);
  store.setSummary("s1", 40, "summary one", 5000);
  let s = store.getSummary("s1");
  assert.equal(s.upto, 40);
  assert.equal(s.count, 1);
  assert.equal(s.chars, 5000);
  store.setSummary("s1", 40, "summary one rewrite", 5000); // same upto — no count bump
  s = store.getSummary("s1");
  assert.equal(s.count, 1, "rewriting the same frontier is not a new compaction");
  store.setSummary("s1", 66, "extended", 4200); // frontier advances
  s = store.getSummary("s1");
  assert.equal(s.upto, 66);
  assert.equal(s.count, 2);
  assert.equal(s.chars, 9200, "chars accumulate across sweeps");
});

test("planCompactSpan: short transcripts stay untouched; long ones split span/tail", () => {
  assert.equal(planCompactSpan(rows(70)), null, "exactly the tail never compacts");
  assert.equal(planCompactSpan(rows(45)), null, "short transcripts stay untouched");
  const plan = planCompactSpan(rows(100));
  assert.ok(plan);
  assert.equal(plan.span.length, 30, "100 rows − 70 tail");
  assert.equal(plan.tailRows, 70);
  assert.equal(plan.spanChars, 300);
  // Tool/reasoning rows never enter the summarizer input.
  const mixed = rows(100);
  mixed[5] = { ...mixed[5], role: "tool", content: "TOOL-ONLY" };
  const p2 = planCompactSpan(mixed);
  assert.ok(!renderSpan(p2.span).includes("TOOL-ONLY"));
});

test("clampSpanInput keeps the NEWEST rows within the summarizer cap", () => {
  const big = rows(200, 10_000); // 2M chars total ≫ 80KB cap
  const { rows: picked, clipped } = clampSpanInput(big);
  assert.equal(picked.length, 8, "8×10k chars = 80k ≤ the 81920 cap");
  assert.equal(clipped, 192);
  assert.equal(picked[0].id, 193, "clamped span is contiguous with the kept tail");
  assert.equal(picked[picked.length - 1].id, 200, "newest row survives");
});

test("summarizerPrompt folds previous summary + focus + only-summary instruction", () => {
  const p = summarizerPrompt({ previous: "decided: use sqlite", spanText: "User: hi", clipped: 3, focus: "paths" });
  assert.match(p, /decided: use sqlite/);
  assert.match(p, /3 earlier message\(s\)/);
  assert.match(p, /keep these aspects in detail.*: paths/);
  assert.match(p, /ONLY the new summary text/);
});

test("isContextOverflowError matches provider shapes, rejects other 4xx", () => {
  for (const m of [
    "400 context_length_exceeded: maximum context length is 8192 tokens",
    "This model's maximum context length has been exceeded",
    "prompt is too long: 200000 tokens > 128000 maximum",
    "Request failed 400: input is too long for this model",
    "413 request entity too large",
    "gemini: too many tokens in request",
  ]) {
    assert.ok(isContextOverflowError(new Error(m)), m);
  }
  assert.ok(!isContextOverflowError(new Error("401 invalid api key")));
  assert.ok(!isContextOverflowError(new Error("429 rate limit retry-after 30s")));
  assert.ok(!isContextOverflowError(new Error("500 internal server error")));
});

const SUMMARY_MARK = "You update the rolling summary";

function seedLongTranscript(store, sessionKey, pairs, chars = 2100) {
  const sess = store.ensureSession(sessionKey);
  for (let i = 0; i < pairs; i++) {
    store.appendMessage(sess.id, "user", `u-${i} ${"u".repeat(chars)}`);
    store.appendMessage(sess.id, "assistant", `a-${i} ${"a".repeat(chars)}`);
  }
  return sess;
}

test("auto-compaction: over-budget history triggers a sweep; summary rides the system prompt", async (t) => {
  const { store } = mkStore(t, "sc-comp-auto-");
  const seen = [];
  const fake = {
    async *stream(opts) {
      seen.push(opts.messages);
      if (String(opts.messages[0].content).startsWith(SUMMARY_MARK)) {
        yield { type: "text", text: "SUMMARY-OF-OLDER-TURNS: prefs=tea, plan=ship-compaction" };
        yield { type: "done", finishReason: "stop" };
        return;
      }
      yield { type: "text", text: "the reply" };
      yield { type: "done", finishReason: "stop" };
    },
    setConfig() {},
  };
  const config = emptyConfig();
  const loop = new AgentLoop({ config, store, log: createLogger({ level: "error" }), llm: fake, tools: [] });
  seedLongTranscript(store, "main:c1", 45); // 90 rows × ~2.1k chars ≈ 190k chars
  let final = "";
  await loop.run({ sessionKey: "main:c1", text: "next question", onEvent: (e) => { if (e.type === "final") final = e.text; } });
  assert.equal(final, "the reply");
  assert.ok(seen.length >= 2, "summarizer ran, then the real turn");
  assert.ok(String(seen[0][0].content).startsWith(SUMMARY_MARK), "first call is the tool-free summarizer");
  const system = seen[1].find((m) => m.role === "system");
  assert.match(system.content, /Earlier conversation \(compacted\)/);
  assert.match(system.content, /SUMMARY-OF-OLDER-TURNS/);
  const s = store.getSummary(store.getSessionByKey("main:c1").id);
  assert.equal(s.count, 1);
  assert.ok(s.upto > 0);
  // Transcript-visible marker row (their "summary stored in transcript").
  const all = store.messagesAfter(store.getSessionByKey("main:c1").id, 0, 9999);
  assert.ok(all.some((r) => r.role === "system" && r.content.includes("[context compacted")));
});

test("compactSession: short transcript reports nothing to do; uptime sweep is incremental", async (t) => {
  const { store } = mkStore(t, "sc-comp-manual-");
  const calls = [];
  const fake = {
    async *stream(opts) {
      calls.push(String(opts.messages[0].content));
      yield { type: "text", text: "S" + calls.length };
      yield { type: "done", finishReason: "stop" };
    },
    setConfig() {},
  };
  const loop = new AgentLoop({ config: emptyConfig(), store, log: createLogger({ level: "error" }), llm: fake, tools: [] });
  seedLongTranscript(store, "main:c2", 5);
  const none = await loop.compactSession("main:c2", {});
  assert.equal(none.compacted, false);
  assert.match(none.message, /nothing to compact/);

  seedLongTranscript(store, "main:c3", 45);
  const one = await loop.compactSession("main:c3", { focus: "user preferences" });
  assert.match(one.message, /compacted \d+ message\(s\)/);
  const s1 = store.getSummary(store.getSessionByKey("main:c3").id);
  // Incremental: a second sweep after 20 more turns keeps extending from `upto`.
  seedLongTranscript(store, "main:c3", 10);
  const two = await loop.compactSession("main:c3", {});
  const s2 = store.getSummary(store.getSessionByKey("main:c3").id);
  assert.equal(two.compacted, true);
  assert.ok(s2.upto > s1.upto, `upto advances ${s1.upto} → ${s2.upto}`);
  assert.equal(s2.count, 2);
  // Never resummarize the already folded span — the previous SUMMARY is the
  // baseline while raw old messages stay out of the input (frontier = id).
  assert.ok(calls[1].includes("S1"), "previous summary text seeds the rewrite");
  assert.ok(!calls[1].includes("u-0 "), "oldest raw messages are not re-sent");
});

test("provider overflow mid-turn: compact + single retry recovers the run", async (t) => {
  const { store } = mkStore(t, "sc-comp-over-");
  let overflows = 0;
  const fake = {
    async *stream(opts) {
      if (String(opts.messages[0].content).startsWith(SUMMARY_MARK)) {
        yield { type: "text", text: "post-overflow summary" };
        yield { type: "done", finishReason: "stop" };
        return;
      }
      if (!String(opts.messages[0].content).includes("Earlier conversation")) {
        overflows++;
        throw Object.assign(new Error("400 context_length_exceeded: maximum context length is 8192 tokens"), { status: 400 });
      }
      yield { type: "text", text: "recovered answer" };
      yield { type: "done", finishReason: "stop" };
    },
    setConfig() {},
  };
  const loop = new AgentLoop({ config: emptyConfig(), store, log: createLogger({ level: "error" }), llm: fake, tools: [] });
  seedLongTranscript(store, "main:c4", 37); // 74+1 rows: below the auto-trigger, compactable on demand
  let final = "";
  await loop.run({ sessionKey: "main:c4", text: "try again", onEvent: (e) => { if (e.type === "final") final = e.text; } });
  assert.equal(overflows, 1);
  assert.equal(final, "recovered answer", "the compacted retry reached the user");
  const s = store.getSummary(store.getSessionByKey("main:c4").id);
  assert.ok(s.count >= 1);
});

test("partial output is never stitched: overflow after deltas just fails", async (t) => {
  const { store } = mkStore(t, "sc-comp-stitch-");
  let calls = 0;
  const fake = {
    async *stream() {
      calls++;
      yield { type: "text", text: "half an answer…" };
      throw Object.assign(new Error("400 context_length_exceeded"), { status: 400 });
    },
    setConfig() {},
  };
  const loop = new AgentLoop({ config: emptyConfig(), store, log: createLogger({ level: "error" }), llm: fake, tools: [] });
  seedLongTranscript(store, "main:c5", 5); // nothing to auto-sweep; the flood is provider-side
  let sawError = false;
  await loop.run({ sessionKey: "main:c5", text: "q", onEvent: (e) => { if (e.type === "error") sawError = true; } });
  assert.equal(calls, 1, "no compacted retry after content streamed");
  assert.ok(sawError, "the failure surfaces as a run error");
});
