import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Queue infrastructure (Partial #2): modes steer/followup/collect/interrupt,
// boundary steering with synthetic skipped results, caps, drop policies, and
// runId-scoped cancellation — deterministic against a fake LLM + real store.

const HOME = mkdtempSync(join(tmpdir(), "sc-queue-"));
process.env.SUPARCLAW_HOME = HOME;
mkdirSync(join(HOME, ".suparclaw"), { recursive: true });

const { AgentLoop, Store, emptyConfig } = await import("../dist/lib.js");

const waitFor = async (pred, what, tries = 240, gap = 250) => {
  for (let i = 0; i < tries; i += 1) {
    const v = await pred();
    if (v) return v;
    await new Promise((r) => setTimeout(r, gap));
  }
  throw new Error(`timed out waiting for ${what}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stubLog = { info() {}, warn() {}, error() {}, debug() {} };

let dbSeq = 0;
function makeLoop(patch = {}) {
  const cfg = emptyConfig();
  cfg.messages.queue = { mode: "steer", cap: 20, drop: "summarize", debounceMs: 5, byChannel: {} };
  cfg.agents.defaults.maxConcurrent = 64;
  Object.assign(cfg.messages.queue, patch.queue ?? {});
  const store = Store.open(join(HOME, `q-${dbSeq++}.db`));
  const script = {
    rounds: 0,
    lastMessages: null,
    /** list of {text?, calls?} consumed in order; final rounds default to echo */
    plan: patch.plan ?? null,
    lastSeen: () => script.lastMessages,
  };
  const llm = {
    async *stream(opts) {
      script.rounds += 1;
      script.lastMessages = opts.messages;
      const step = script.plan?.[script.rounds - 1];
      if (step?.text) yield { type: "text", text: step.text };
      if (step?.calls) yield { type: "tool_calls", calls: step.calls };
      if (!step) {
        const lastUser = [...opts.messages].reverse().find((m) => m.role === "user");
        yield { type: "text", text: `reply:${lastUser?.content ?? ""}` };
      }
      yield { type: "usage", usage: { total_tokens: 7 } };
    },
  };
  const gates = new Map(); // name -> {promise, resolve, rejected}
  const executed = [];
  const tools = [
    {
      name: "wait_tool",
      description: "blocks until the test opens its gate (or is aborted)",
      parameters: { type: "object", properties: { gate: { type: "string" } } },
      async run(args, ctx) {
        const name = String(args.gate ?? "g");
        if (!gates.has(name)) {
          let res;
          const promise = new Promise((r) => (res = r));
          gates.set(name, { promise, resolve: res });
        }
        const g = gates.get(name);
        executed.push(`wait_tool:${name}`);
        await new Promise((resolve, reject) => {
          g.promise.then(resolve);
          ctx.signal?.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          }, { once: true });
        });
        return `gate ${name} done`;
      },
    },
    {
      name: "noop_tool",
      description: "returns immediately",
      parameters: { type: "object", properties: {} },
      async run() {
        executed.push("noop_tool");
        return "noop ok";
      },
    },
  ];
  const loop = new AgentLoop({ config: cfg, store, log: stubLog, llm, tools });
  return { cfg, store, script, llm, loop, gates, executed };
}

const sink = (into) => {
  const events = [];
  into.push(events);
  return { events, onEvent: (e) => events.push(e) };
};

test("steer injects mid-tool and skips the unstarted sequential tail", async () => {
  const { loop, gates, executed } = makeLoop({
    plan: [
      { calls: [{ id: "c1", name: "wait_tool", args: '{"gate":"h"}' }, { id: "c2", name: "noop_tool", args: "{}" }] },
      { text: "final-reply" },
    ],
  });
  const events = [];
  const onEvent = (e) => events.push(e);
  const run1 = loop.run({ sessionKey: "main:main", text: "start", runId: "r1", onEvent });
  await waitFor(() => gates.has("h"), "first tool to start"); // call 1 launched unchecked
  // Steer arrives while the tool is still running: after the active call it
  // must be drained and call 2 skipped with a synthetic paired result.
  const s = sink([]);
  void loop.run({ sessionKey: "main:main", text: "steer me in", runId: "s1", onEvent: s.onEvent });
  gates.get("h").resolve();
  await run1;
  assert.ok(executed.includes("wait_tool:h"), `tool 1 ran: ${executed}`);
  assert.ok(!executed.includes("noop_tool"), `tool 2 skipped: ${executed}`);
  assert.ok(events.some((e) => e.type === "steered" && e.text === "steer me in"), `steered event in ${JSON.stringify(events.filter((e) => e.type === "steered"))}`);
  assert.ok(events.some((e) => e.type === "tool" && e.status === "skipped" && e.detail === "Skipped to process an incoming message."));
  assert.equal(events.find((e) => e.type === "final")?.text, "final-reply");
  loop.abort("main:main");
});

test("followup mode runs queued messages in FIFO order", async () => {
  const { loop, gates } = makeLoop({ queue: { mode: "followup" }, plan: [{ calls: [{ id: "c1", name: "wait_tool", args: '{"gate":"w"}' }] }] });
  const finals = [];
  const mk = (text) => (e) => { if (e.type === "final") finals.push(`${text}→${e.text}`); };
  const p1 = loop.run({ sessionKey: "main:main", text: "A", queueMode: "followup", onEvent: mk("A") });
  await waitFor(() => gates.has("w"), "busy");
  void loop.run({ sessionKey: "main:main", text: "B", queueMode: "followup", onEvent: mk("B") });
  void loop.run({ sessionKey: "main:main", text: "C", queueMode: "followup", onEvent: mk("C") });
  gates.get("w").resolve();
  await p1;
  await waitFor(() => finals.length === 3 && loop.busySessions().length === 0, "all three finals");
  assert.deepEqual(finals, ["A→reply:A", "B→reply:B", "C→reply:C"]);
});


test("collect merges compatible queued inputs into one turn", async () => {
  const { loop, gates, script } = makeLoop({ queue: { mode: "collect", debounceMs: 5 }, plan: [{ calls: [{ id: "c1", name: "wait_tool", args: '{"gate":"c"}' }] }] });
  const events = [];
  const onEvent = (e) => events.push(e);
  const p1 = loop.run({ sessionKey: "main:main", text: "root", queueMode: "followup", onEvent });
  await waitFor(() => gates.has("c"), "busy");
  void loop.run({ sessionKey: "main:main", text: "one", queueMode: "collect", onEvent });
  await sleep(10); // first arms the quiet window; second joins it
  void loop.run({ sessionKey: "main:main", text: "two", queueMode: "collect", onEvent });
  gates.get("c").resolve();
  await p1;
  await waitFor(() => events.filter((e) => e.type === "final").length === 2, "root final + collect batch final");
  assert.ok(events.some((e) => e.type === "collect" && Array.isArray(e.runIds) && e.runIds.length === 2), `collect event: ${JSON.stringify(events.filter((e) => e.type === "collect"))}`);
  // Exactly one extra turn consumed both texts (numbered merge).
  const mergeTurn = script.rounds;
  assert.ok(mergeTurn <= 3, `coalesced into one model turn (rounds=${mergeTurn})`);
  const merged = JSON.stringify(script.lastSeen?.() ?? script.lastMessages);
  assert.ok(merged.includes("(1) one") && merged.includes("(2) two"), merged.slice(0, 300));
});

test("interrupt aborts the active run and the newest message wins", async () => {
  const { loop, gates, executed } = makeLoop({ plan: [{ calls: [{ id: "c1", name: "wait_tool", args: '{"gate":"i"}' }] }] });
  const finals = [];
  const onEvent = (e) => { if (e.type === "final" || e.type === "error") finals.push(e.type + ":" + (e.text ?? e.message)); };
  const p1 = loop.run({ sessionKey: "main:main", text: "old slow work", onEvent }).catch(() => {});
  await waitFor(() => gates.has("i") && executed.includes("wait_tool:i"), "active run in tool");
  const p2 = loop.run({ sessionKey: "main:main", text: "NEWEST", queueMode: "interrupt", onEvent });
  await waitFor(() => gates.get("i") && true, "gate exists"); gates.get("i").resolve();
  await Promise.all([p1, p2]);
  await waitFor(() => finals.some((f) => f === "final:reply:NEWEST"), `newest won: ${finals}`);
});

test("cap with drop:new rejects the newest overflow immediately", async () => {
  const { loop, gates } = makeLoop({ queue: { mode: "followup", cap: 1, drop: "new" }, plan: [{ calls: [{ id: "c1", name: "wait_tool", args: '{"gate":"n"}' }] }] });
  const p1 = loop.run({ sessionKey: "main:main", text: "main", onEvent: () => {} });
  await waitFor(() => gates.has("n"), "busy");
  const ev1 = [];
  void loop.run({ sessionKey: "main:main", text: "q1", queueMode: "followup", onEvent: (e) => ev1.push(e), runId: "q1id" });
  const ev2 = [];
  void loop.run({ sessionKey: "main:main", text: "q2-overflow", queueMode: "followup", onEvent: (e) => ev2.push(e), runId: "q2id" });
  await sleep(20);
  assert.ok(ev2.some((e) => e.type === "dequeued" && e.reason === "overflow"), `q2 rejected: ${JSON.stringify(ev2)}`);
  assert.equal(loop.queueStatus("main:main").queued.length, 1);
  gates.get("n").resolve();
  await p1;
  await waitFor(() => loop.busySessions().length === 0, "drained");
});

test("abort with runId cancels only that queued input", async () => {
  const { loop, gates } = makeLoop({ queue: { mode: "followup" }, plan: [{ calls: [{ id: "c1", name: "wait_tool", args: '{"gate":"a"}' }] }] });
  const finals = [];
  const p1 = loop.run({ sessionKey: "main:main", text: "main", onEvent: (e) => { if (e.type === "final") finals.push(e.text); } });
  await waitFor(() => gates.has("a"), "busy");
  const ev = [];
  void loop.run({ sessionKey: "main:main", text: "cancel me", queueMode: "followup", onEvent: (e) => ev.push(e), runId: "victim" });
  await sleep(20);
  assert.equal(loop.queueStatus("main:main").queued.length, 1);
  assert.equal(loop.abort("main:main", "victim"), true, "removed from queue");
  assert.ok(ev.some((e) => e.type === "dequeued" && e.reason === "cancelled"));
  assert.equal(loop.queueStatus("main:main").queued.length, 0);
  gates.get("a").resolve();
  await p1;
  await waitFor(() => loop.busySessions().length === 0, "drained");
});

test("a steer that misses every boundary becomes a followup turn", async () => {
  const { loop } = makeLoop({ plan: [{ text: "fast answer" }] });
  const events = [];
  await loop.run({ sessionKey: "main:main", text: "quick", onEvent: (e) => events.push(e) });
  // Session idle now: a later steer input just runs as a normal turn.
  const s = [];
  void loop.run({ sessionKey: "main:main", text: "late steer", queueMode: "steer", onEvent: (e) => s.push(e) });
  await waitFor(() => s.some((e) => e.type === "final"), "late steer answered");
  assert.ok(s.some((e) => e.type === "final" && e.text === "reply:late steer"));
});
