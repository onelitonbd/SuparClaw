// Task 53 — a turn's answer can arrive in several pieces, and the loop has to
// say so at the right moment.
//
// "if the ai gives multiple responses for a single quary i want them come
// instantly all one by one when it tells."
//
// The boundary is exact: a round that produced text AND asked for tools means
// the model finished a message and went to work. The loop emits `say` there —
// before the tools run — with the round's raw text, so the concatenation of
// every `say` is a byte-exact prefix of the final answer. That property is what
// lets Telegram post the pieces and then send only the tail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { AgentLoop, Store, createLogger, emptyConfig, buildRegistry, remainderAfter } = await import("../dist/lib.js");

process.env.SUPARCLAW_HOME = mkdtempSync(join(tmpdir(), "sc-say-"));

function mkStore(t, name) {
  const home = mkdtempSync(join(tmpdir(), name));
  const store = Store.open(join(home, "state.sqlite"));
  t.after(() => store.close());
  return store;
}

/** A model that writes a block, calls a tool, writes another block, then stops. */
function scriptedLlm(rounds) {
  let round = 0;
  return {
    async *stream() {
      const r = rounds[Math.min(round, rounds.length - 1)];
      round += 1;
      for (const part of r) {
        if (part.text !== undefined) yield { type: "text", text: part.text };
        if (part.calls) yield { type: "tool_calls", calls: part.calls };
      }
      yield { type: "done", finishReason: "stop" };
    },
    setConfig() {},
  };
}

function loopWith(store, llm, tools) {
  return new AgentLoop({
    config: emptyConfig(),
    store,
    log: createLogger({ level: "error" }),
    llm,
    tools,
  });
}

test("a block written before a tool call is emitted before the tool runs", async (t) => {
  const store = mkStore(t, "sc-say-1-");
  const events = [];
  const order = [];
  const tools = [
    {
      name: "probe",
      description: "test tool",
      parameters: { type: "object", properties: {} },
      async run() {
        order.push("tool");
        return "tool output";
      },
    },
  ];
  const llm = scriptedLlm([
    [{ text: "Let me check the config.\n" }, { calls: [{ id: "c1", name: "probe", args: "{}" }] }],
    [{ text: "Found it — port 18790 is taken.\n" }],
  ]);
  const loop = loopWith(store, llm, tools);
  await loop.run({
    sessionKey: "main:say1",
    text: "why is it failing",
    onEvent: (e) => {
      events.push(e);
      if (e.type === "say") order.push("say");
    },
  });

  const says = events.filter((e) => e.type === "say");
  assert.equal(says.length, 1, "one finished block before the tool ran");
  assert.equal(says[0].text, "Let me check the config.\n", "the RAW text, so offsets stay exact");
  assert.deepEqual(order, ["say", "tool"], "the block is announced before the work it describes");

  const final = events.find((e) => e.type === "final");
  assert.equal(final.text, "Let me check the config.\nFound it — port 18790 is taken.", "final still holds the whole answer");
  assert.ok(final.text.startsWith(says[0].text.replace(/\s+$/, "")), "every say is a prefix of the final");
});

test("say texts concatenate to a byte-exact prefix of final.text", async (t) => {
  const store = mkStore(t, "sc-say-2-");
  const events = [];
  const tools = ["a", "b"].map((name) => ({
    name,
    description: "test tool",
    parameters: { type: "object", properties: {} },
    async run() {
      return "ok";
    },
  }));
  const llm = scriptedLlm([
    [{ text: "first\n\n" }, { calls: [{ id: "c1", name: "a", args: "{}" }] }],
    [{ text: "  second, with leading spaces " }, { calls: [{ id: "c2", name: "b", args: "{}" }] }],
    [{ text: "\nthird and last" }],
  ]);
  const loop = loopWith(store, llm, tools);
  await loop.run({ sessionKey: "main:say2", text: "go", onEvent: (e) => events.push(e) });

  const says = events.filter((e) => e.type === "say").map((e) => e.text);
  const final = events.find((e) => e.type === "final").text;
  assert.equal(says.length, 2, "the last round is the final, not a say");
  assert.ok(final.startsWith(says.join("")), "every say, in order, is a byte-exact prefix of the final");
  assert.equal(final.slice(says.join("").length), "\nthird and last", "so the tail is exactly the last round");
});

test("a turn that never calls a tool emits no say at all", async (t) => {
  const store = mkStore(t, "sc-say-3-");
  const events = [];
  const llm = scriptedLlm([[{ text: "Just an answer." }]]);
  const loop = loopWith(store, llm, []);
  await loop.run({ sessionKey: "main:say3", text: "hi", onEvent: (e) => events.push(e) });
  assert.equal(events.filter((e) => e.type === "say").length, 0);
  assert.equal(events.find((e) => e.type === "final").text, "Just an answer.");
});

test("a whitespace-only block is emitted (offsets) even though nothing readable is said", async (t) => {
  const store = mkStore(t, "sc-say-4-");
  const events = [];
  const tools = [
    {
      name: "probe",
      description: "test tool",
      parameters: { type: "object", properties: {} },
      async run() {
        return "ok";
      },
    },
  ];
  const llm = scriptedLlm([
    [{ text: "\n" }, { calls: [{ id: "c1", name: "probe", args: "{}" }] }],
    [{ text: "real answer" }],
  ]);
  const loop = loopWith(store, llm, tools);
  await loop.run({ sessionKey: "main:say4", text: "go", onEvent: (e) => events.push(e) });
  const says = events.filter((e) => e.type === "say").map((e) => e.text);
  assert.deepEqual(says, ["\n"], "emitted so the ledger stays aligned");
  const final = events.find((e) => e.type === "final").text;
  // Nothing readable was said, so Telegram posts nothing and the whole answer is
  // still owed — the blank block must not eat the final.
  assert.equal(remainderAfter(final, says.join("")), "real answer");
});

test("the say event is additive: the transcript row is unchanged", async (t) => {
  const store = mkStore(t, "sc-say-5-");
  const tools = [
    {
      name: "probe",
      description: "test tool",
      parameters: { type: "object", properties: {} },
      async run() {
        return "ok";
      },
    },
  ];
  const llm = scriptedLlm([
    [{ text: "before. " }, { calls: [{ id: "c1", name: "probe", args: "{}" }] }],
    [{ text: "after." }],
  ]);
  const loop = loopWith(store, llm, tools);
  await loop.run({ sessionKey: "main:say5", text: "go", onEvent: () => {} });
  const session = store.getSessionByKey("main:say5");
  const rows = store.messagesAfter(session.id, 0, 99).filter((r) => r.role === "assistant");
  assert.equal(rows.length, 1, "one assistant row, as before");
  assert.equal(rows[0].content, "before. after.", "and it holds the whole answer");
});

test("the registry still exposes a terminal tool and no say surface", () => {
  const names = buildRegistry(emptyConfig()).map((t) => t.name);
  assert.ok(names.includes("exec"));
  assert.ok(!names.includes("say"), "`say` is an event, not a tool");
});
