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
// Task 38 added the third report: "when a tool shows error it also stops working
// there" — one guard verdict ended the whole turn. Now the first verdict is a
// NUDGE (the turn continues with every tool still available) and only a second
// verdict in the same turn parks the batch and ends it with an explanation.
// The always-on guard (three consecutive identical ERRORS) still exists: it is
// the one that stops a tool which is genuinely broken.

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
async function turn({ plan, loopDetectionEnabled, maxToolIterations, config: extra }) {
  const config = emptyConfig();
  config.tools.fs = true;
  if (loopDetectionEnabled !== undefined) config.tools.loopDetection.enabled = loopDetectionEnabled;
  // No bound unless the test asks for one — the product default since Task 38.
  if (maxToolIterations !== undefined) config.agents.defaults.maxToolIterations = maxToolIterations;
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
    guard: events.find((e) => e.type === "tool" && e.name === "tool-loop guard" && !String(e.detail ?? "").startsWith("nudged")),
    nudges: events.filter((e) => e.type === "tool" && e.name === "tool-loop guard" && String(e.detail ?? "").startsWith("nudged")),
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

test("enabled: true warns on a repeat instead of killing the turn (Task 38)", async () => {
  // Four identical successful calls, then the model changes its mind and
  // answers. Before Task 38 the third call ended the turn.
  const { guard, nudges, final, requests } = await turn({
    loopDetectionEnabled: true,
    plan: (n) => (n <= 4 ? { calls: [call("cron_list", {})] } : { text: "Stopped repeating myself." }),
  });
  assert.equal(guard, undefined, "no stop verdict — only a warning");
  assert.equal(nudges.length, 1, "one nudge row, on the round after the fourth repeat");
  assert.match(nudges[0].detail, /^nudged — cron_list (produced the identical result|repeated the identical call)/);
  assert.equal(final.text, "Stopped repeating myself.", "the model got to finish its thought");
  assert.ok(requests.length >= 5, "the turn kept running after the warning");
});

test("the nudge is a note in the transcript, and tools stay on the table", async () => {
  const { requests, nudges } = await turn({
    loopDetectionEnabled: true,
    plan: (n, tools) => (n <= 4 ? { calls: [call("cron_list", {})] } : { text: "ok" }),
  });
  assert.equal(nudges.length, 1);
  const after = requests.at(-1);
  const note = after.messages.filter((m) => m.role === "user").map((m) => String(m.content)).find((c) => c.includes("[tool-loop guard]"));
  assert.ok(note, "the model was told, in words, what repeated");
  assert.match(note, /this is a warning, not a stop/);
  assert.match(note, /Do not repeat that same call/);
  assert.ok(after.tools > 0, "tools were never taken away — that is what ended the work before");
});

test("three identical ERRORS are nudged, then a second offence ends the turn with words", async () => {
  // The same failing call, six times: strike one warns, strike two stops.
  const { guard, nudges, final, requests } = await turn({
    // The wrap-up (no tools offered) returns NOTHING — the case that used to end
    // the chat with "(no response)".
    plan: (n, tools) => (tools > 0 ? { calls: [call("fs_read", { path: "missing.txt" })] } : { text: "" }),
  });
  assert.equal(nudges.length, 1, "the first three identical errors only warn");
  assert.ok(guard, "the always-on guard still stops a tool that fails the same way repeatedly");
  assert.match(guard.detail, /identical error 3 times/);
  assert.equal(requests.length, 7, "three tool rounds, a warning round, three more, then the wrap-up");
  assert.equal(requests.at(-1).tools, 0, "the wrap-up was offered no tools");
  assert.ok(!/no response/i.test(final.text), `never silent, got: ${JSON.stringify(final.text)}`);
  assert.match(final.text, /^I stopped: fs_read returned the identical error 3 times/);
  assert.match(final.text, /tell me how you would like to proceed/);
});

test("one failing tool never ends a turn — the model just carries on", async () => {
  const { guard, nudges, final } = await turn({
    plan: (n) => (n === 1 ? { calls: [call("fs_read", { path: "missing.txt" })] } : { text: "That file is not there; here is what I found instead." }),
  });
  assert.equal(guard, undefined, "a single error is news, not a stop");
  assert.equal(nudges.length, 0, "and not even worth a warning");
  assert.equal(final.text, "That file is not there; here is what I found instead.");
});

test("no ceiling by default: a long tool run finishes on its own terms (Task 38)", async () => {
  // Twenty rounds with genuinely different work; the old default of 12 would
  // have cut this off with "I used all 12 tool rounds".
  const { final, requests } = await turn({
    plan: (n) => (n <= 20 ? { calls: [call("cron_list", {})] } : { text: "Finished after twenty checks." }),
    // Distinct outputs so the loop detector has nothing to say.
    config: (c) => { c.tools.loopDetection.enabled = false; },
  });
  assert.equal(requests.length, 21, "twenty tool rounds and the answer");
  assert.equal(final.text, "Finished after twenty checks.", "no 'I used all N rounds' line");
});

test("a warning on the last allowed round still leaves a turn that explains itself", async () => {
  // Budget of 3: the third round both trips the detector and spends the budget.
  // Before Task 38 this ended with a guard stop; now the nudge lands, the budget
  // is spent, and the turn says so instead of going silent.
  const { nudges, guard, final } = await turn({
    maxToolIterations: 3,
    plan: (n, tools) => (tools > 0 ? { calls: [call("fs_read", { path: "missing.txt" })] } : { text: "" }),
  });
  assert.equal(nudges.length, 1, "the warning fired on the last round");
  assert.equal(guard, undefined, "and nothing was hard-stopped");
  assert.match(final.text, /I used all 3 tool rounds without a final answer/);
  assert.match(final.text, /Say “continue”/);
});

test("calls the guard stopped still get a paired result — nothing is left dangling", async () => {
  // Two strikes inside one round: the repeated successful read trips the
  // rolling layer (strike one, a nudge), then the third identical fs_read error
  // is strike two — and the call after it must be parked with a result of its
  // own, or the next request would be rejected for an unanswered tool_call_id.
  const { requests, rows, guard } = await turn({
    loopDetectionEnabled: true,
    plan: (n, tools) =>
      tools === 0
        ? { text: "ok" }
        : {
            calls: [
              call("cron_list", {}, `r${n}`),
              call("fs_read", { path: "missing.txt" }, `b${n}`),
              call("memory_search", { query: "anything" }, `p${n}`),
            ],
          },
  });
  assert.ok(guard, "the turn was stopped");
  const last = requests.at(-1);
  const calls = last.messages.filter((m) => m.role === "assistant").flatMap((m) => m.tool_calls ?? []);
  const results = last.messages.filter((m) => m.role === "tool");
  const answered = new Set(results.map((m) => m.tool_call_id));
  for (const c of calls) assert.ok(answered.has(c.id), `tool_call ${c.id} (${c.name}) has no result`);
  const parked = results.find((m) => m.name === "memory_search" && String(m.content).includes("not run"));
  assert.ok(parked, "the parked call carries a result of its own");
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
