// The loop guard must not eat the turn.
//
// The user's report: "we have a tool guard … it tops the request … the AI don't
// get any of this result so it just stop responding there".
//
// Two separate defects, both reproduced here against a real AgentLoop:
//   1. the rolling detector was ON BY DEFAULT and counts identical RESULTS, so
//      three successful `cron_list` calls ended a working turn (upstream's
//      default is off — docs/openclaw/tools/loop-detection.md);
//   2. when the guard did fire, the run could end with the assistant silent —
//      "(no response)" — because the tool-free wrap-up came back empty, or
//      because the guard fired on the last allowed round and no wrap-up
//      happened at all.
//
// The always-on guard (three consecutive identical ERRORS) stays: that is the
// one that stops a tool which is genuinely broken.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SUPARCLAW_HOME = mkdtempSync(join(tmpdir(), "sc-loop-guard-"));
mkdirSync(join(process.env.SUPARCLAW_HOME, ".suparclaw"), { recursive: true });
const { AgentLoop, Store, emptyConfig, createLogger } = await import("../dist/lib.js");

let dbSeq = 0;

/**
 * Run one turn against a scripted model.
 *
 * `plan(n, tools)` returns what call `n` emits: `{ calls }` for tool calls or
 * `{ text }` for an answer. `tools` is how many tools the request offered —
 * the wrap-up round is the one with none.
 */
async function turn({ plan, loopDetectionEnabled, maxToolIterations = 12, config: extra }) {
  const config = emptyConfig();
  config.tools.fs = true;
  if (loopDetectionEnabled !== undefined) config.tools.loopDetection.enabled = loopDetectionEnabled;
  if (maxToolIterations !== 12) config.agents.defaults.maxToolIterations = maxToolIterations;
  if (extra) extra(config);

  dbSeq += 1;
  const store = Store.open(join(process.env.SUPARCLAW_HOME, ".suparclaw", `guard-${dbSeq}.sqlite`));
  const requests = [];
  let n = 0;
  const llm = {
    async *stream(opts) {
      n += 1;
      const tools = (opts.tools ?? []).length;
      requests.push({ tools, messages: opts.messages });
      const step = plan(n, tools);
      if (step.calls) yield { type: "tool_calls", calls: step.calls };
      if (step.text !== undefined) yield { type: "text", text: step.text };
      yield { type: "usage", usage: { total_tokens: 3 } };
    },
  };
  const loop = new AgentLoop({ config, store, log: createLogger({ level: "error" }), llm });
  const events = [];
  await loop.run({ sessionKey: `main:guard-${dbSeq}`, text: "go", onEvent: (e) => events.push(e) });
  const session = store.getSessionByKey(`main:guard-${dbSeq}`);
  const rows = store.recentMessages(session.id, 50);
  store.close();
  return {
    requests,
    events,
    rows,
    guard: events.find((e) => e.type === "tool" && e.name === "tool-loop guard"),
    final: events.find((e) => e.type === "final"),
  };
}

const call = (name, args = {}, id = `c${Math.random().toString(36).slice(2, 7)}`) => ({ id, name, args: JSON.stringify(args) });

test("by default, repeated SUCCESSFUL calls do not break a working turn", async () => {
  // Exactly the repro: three identical cron_list reads while composing an answer.
  const { guard, final, rows } = await turn({
    plan: (n) => (n <= 3 ? { calls: [call("cron_list", {})] } : { text: "Done — here is the plan." }),
  });
  assert.equal(guard, undefined, "the rolling detector is off unless it is asked for");
  assert.equal(final.text, "Done — here is the plan.", "the model got to finish its thought");
  assert.equal(rows.filter((r) => r.role === "tool").length, 3, "all three calls ran");
  assert.ok(rows.every((r) => !String(r.content).includes("error")), "and none of them failed");
});

test("enabled: true still breaks that same sequence — the strict mode is opt-in, not gone", async () => {
  const { guard, final } = await turn({
    loopDetectionEnabled: true,
    plan: (n, tools) => (n <= 3 && tools > 0 ? { calls: [call("cron_list", {})] } : { text: "Stopped repeating myself." }),
  });
  assert.ok(guard, "the opt-in detector fired");
  assert.match(guard.detail, /identical call 3 times/);
  assert.equal(final.text, "Stopped repeating myself.", "and the model still got to answer");
});

test("three identical ERRORS still break by default — and the turn ends with words", async () => {
  const { guard, final, requests } = await turn({
    // The wrap-up (no tools offered) returns NOTHING — the case that used to end
    // the chat with "(no response)".
    plan: (n, tools) => (tools > 0 ? { calls: [call("fs_read", { path: "missing.txt" })] } : { text: "" }),
  });
  assert.ok(guard, "the always-on guard fired: a tool that fails the same way 3× is broken");
  assert.match(guard.detail, /identical error 3 times/);
  assert.equal(requests.length, 4, "three tool rounds + the tool-free wrap-up");
  assert.equal(requests.at(-1).tools, 0, "the wrap-up was offered no tools");
  assert.ok(!/no response/i.test(final.text), `never silent, got: ${JSON.stringify(final.text)}`);
  assert.match(final.text, /^I stopped: fs_read returned the identical error 3 times/);
  assert.match(final.text, /tell me how you would like to proceed/);
});

test("a guard on the LAST allowed round still explains itself (the spare wrap-up turn)", async () => {
  // Budget of 3: the third round is the last one, and it is also the one that
  // trips the guard. Before the fix the loop simply ended here.
  const { guard, final, requests } = await turn({
    maxToolIterations: 3,
    plan: (n, tools) => (tools > 0 ? { calls: [call("fs_read", { path: "missing.txt" })] } : { text: "" }),
  });
  assert.ok(guard, "guard fired on the last round");
  assert.equal(requests.length, 4, "one extra round was granted for the explanation");
  assert.equal(requests.at(-1).tools, 0, "tools stay off on it");
  assert.match(final.text, /I stopped: fs_read returned the identical error 3 times/);
});

test("calls the guard stopped still get a paired result — nothing is left dangling", async () => {
  const first = call("fs_read", { path: "missing.txt" }, "boom");
  const second = call("cron_list", {}, "parked");
  const { requests, rows } = await turn({
    plan: (n, tools) => {
      if (tools === 0) return { text: "ok" };
      // Rounds 1-2: only the failing read. Round 3: the failing read AGAIN plus a
      // second call — the guard fires on the first, so the second must be parked
      // with a result of its own or the next request would be rejected for an
      // unanswered tool_call_id.
      return { calls: n < 3 ? [{ ...first, id: `b${n}` }] : [{ ...first, id: `b${n}` }, { ...second, id: `p${n}` }] };
    },
  });
  const last = requests.at(-1);
  const calls = last.messages.filter((m) => m.role === "assistant").flatMap((m) => m.tool_calls ?? []);
  const results = last.messages.filter((m) => m.role === "tool");
  const answered = new Set(results.map((m) => m.tool_call_id));
  for (const c of calls) assert.ok(answered.has(c.id), `tool_call ${c.id} (${c.name}) has no result`);
  const parked = results.find((m) => m.name === "cron_list");
  assert.ok(parked, "the parked call carries a result");
  assert.match(parked.content, /not run: the tool-loop guard/);
  assert.match(parked.content, /do not retry it blindly/i);
  assert.equal(rows.filter((r) => r.role === "tool").length, results.length, "every result is in the transcript too");
});

test("a spent tool budget says so instead of going silent", async () => {
  const { guard, final } = await turn({
    maxToolIterations: 2,
    // Successful, varied-enough calls: no guard, just no more rounds.
    plan: (n, tools) => (tools > 0 ? { calls: [call("cron_list", {})] } : { text: "" }),
  });
  assert.equal(guard, undefined, "nothing failed, so no guard");
  assert.match(final.text, /I used all 2 tool rounds without a final answer/);
  assert.match(final.text, /Say “continue”/);
});

test("a normal answer is never replaced by the fallback", async () => {
  const { final } = await turn({ plan: () => ({ text: "All good." }) });
  assert.equal(final.text, "All good.");
});
