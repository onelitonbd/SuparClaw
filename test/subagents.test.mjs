import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sub-agent delegation: spawn → registry → completion announce (wake turn),
// depth cap, per-session budgets, sessions_yield batch wake, boot recovery.

const HOME = mkdtempSync(join(tmpdir(), "sc-subs-"));
process.env.SUPARCLAW_HOME = HOME;
mkdirSync(join(HOME, ".suparclaw"), { recursive: true });

const { AgentLoop, Store, Subagents, emptyConfig } = await import("../dist/lib.js");

const waitFor = async (pred, what, tries = 240, gap = 250) => {
  for (let i = 0; i < tries; i += 1) {
    const v = await pred();
    if (v) return v;
    await new Promise((r) => setTimeout(r, gap));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const stubLog = { info() {}, warn() {}, error() {}, debug() {} };
let dbSeq = 0;

function makeRig(patch = {}) {
  const cfg = emptyConfig();
  cfg.messages.queue = { mode: "steer", cap: 20, drop: "summarize", debounceMs: 5, byChannel: {} };
  cfg.agents.defaults.maxConcurrent = 64;
  Object.assign(cfg.agents.defaults.subagents, patch.subagents ?? {});
  const store = Store.open(join(HOME, `s-${dbSeq++}.db`));
  const rounds = [];
  const gates = new Map();
  const llm = {
    async *stream(opts) {
      const lastUser = [...opts.messages].reverse().find((m) => m.role === "user")?.content ?? "";
      rounds.push(lastUser.slice(0, 120));
      const toolCalls = patch.plan?.(opts, lastUser) ?? null;
      if (toolCalls?.calls?.length) {
        yield { type: "tool_calls", calls: toolCalls.calls };
      } else {
        yield { type: "text", text: `ANSWER:${lastUser.slice(0, 200)}` };
      }
      yield { type: "usage", usage: { total_tokens: 3 } };
    },
  };
  const childEvents = [];
  const tools = [
    {
      name: "sessions_yield",
      description: "test yield",
      parameters: { type: "object", properties: {} },
      async run(args, ctx) {
        const active = ctx.subagents?.activeChildren(ctx.sessionKey) ?? [];
        if (active.length === 0) return "nothing_pending";
        ctx.yieldArmed = true;
        return `yielded: ${active.length} children`;
      },
    },
    {
      name: "hold_gate",
      description: "blocks child until released",
      parameters: { type: "object", properties: { gate: { type: "string" } } },
      async run(args, ctx) {
        const name = String(args.gate ?? "g");
        if (!gates.has(name)) {
          let res; const promise = new Promise((r) => (res = r));
          gates.set(name, { promise, resolve: res });
        }
        await new Promise((resolve, reject) => {
          gates.get(name).promise.then(resolve);
          ctx.signal?.addEventListener("abort", () => { const e = new Error("aborted"); e.name = "AbortError"; reject(e); }, { once: true });
        });
        return "gate ok";
      },
    },
  ];
  const loop = new AgentLoop({
    config: cfg, store, log: stubLog, llm, tools,
    onRunFinished: (...a) => subs.onRunFinished(...a),
  });
  const subs = new Subagents({
    store, log: stubLog, loop,
    config: () => loop.deps.config,
    emitChild: (key, ev) => childEvents.push([key, ev]),
  });
  loop.setSubagents(subs);
  return { cfg, store, loop, subs, gates, childEvents, rounds };
}

test("spawn runs the child and announces the completion back to the parent", async () => {
  const { store, subs } = makeRig();
  const res = await subs.spawn("main:main", { task: "review the diff", label: "review" });
  assert.equal(res.accepted, true, JSON.stringify(res));
  assert.match(res.childSessionKey, /^subagent:main:main:[0-9a-f]{8}$/);

  const row = await waitFor(() => store.getSubagent(res.childSessionKey)?.status !== "running" ? store.getSubagent(res.childSessionKey) : null, "child finished");
  assert.equal(row.status, "done", JSON.stringify(row));
  assert.ok(row.outcome?.includes("review the diff"), `outcome carries the reply: ${row.outcome}`);
  assert.ok(row.result_stats?.includes("ok"));

  // Completion announced: parent session got a wake turn containing the result.
  const parent = store.getSessionByKey("main:main");
  await waitFor(() => {
    const m = store.recentMessages(parent.id, 20);
    return m.some((r) => r.role === "user" && r.content.includes('Sub-agent "review" completed') && r.content.includes("review the diff"));
  }, "announcement reached the parent transcript");
  assert.equal(store.getSubagent(res.childSessionKey).delivery, "delivered");
});

test("context fork seeds the child transcript from the parent", async () => {
  const { store, subs } = makeRig();
  store.ensureSession("main:main");
  const parent = store.getSessionByKey("main:main");
  store.appendMessage(parent.id, "user", "important prior context xyz", undefined);
  store.appendMessage(parent.id, "assistant", "acknowledged xyz", undefined);
  const res = await subs.spawn("main:main", { task: "continue it", context: "fork" });
  assert.equal(res.accepted, true);
  const child = store.getSessionByKey(res.childSessionKey);
  const msgs = store.recentMessages(child.id, 10);
  assert.ok(msgs.some((m) => m.content.includes("important prior context xyz")), "fork copied history");
});

test("nesting cap rejects a child spawning its own child", async () => {
  const { subs } = makeRig({ subagents: { maxDepth: 1 } });
  const parent = await subs.spawn("root:main", { task: "level one" });
  assert.equal(parent.accepted, true);
  const nested = await subs.spawn(parent.childSessionKey, { task: "level two" });
  assert.equal(nested.accepted, false);
  assert.match(nested.error, /nesting cap/i);
});

test("per-spawning-session budget rejects overflow", async () => {
  const { subs, gates } = makeRig({
    subagents: { maxConcurrent: 1 },
    plan: (_opts, lastUser) =>
      lastUser === "slow one" ? { calls: [{ id: "h1", name: "hold_gate", args: '{"gate":"hold"}' }] } : null,
  });
  const a = await subs.spawn("cap:main", { task: "slow one" });
  assert.equal(a.accepted, true);
  await waitFor(() => gates.has("hold"), "first child holding its gate");
  const b = await subs.spawn("cap:main", { task: "also slow" });
  assert.equal(b.accepted, false, `budget: ${JSON.stringify(b)}`);
  assert.match(b.error, /budget full/i);
  gates.get("hold").resolve();
});

test("sessions_yield ends the turn and completions wake the parent once", async () => {
  const { loop, subs, gates, childEvents } = makeRig({
    plan: (_opts, lastUser) => {
      if (lastUser === "quick check") return { calls: [{ id: "k1", name: "hold_gate", args: '{"gate":"kid"}' }] };
      if (lastUser === "wait for your child") return { calls: [{ id: "y1", name: "sessions_yield", args: "{}" }] };
      return null;
    },
  });
  // Spawn first so the child is actively holding its gate when the parent yields.
  const spawnRes = await subs.spawn("waiter:main", { task: "quick check", label: "quick" });
  assert.equal(spawnRes.accepted, true);
  await waitFor(() => gates.has("kid"), "child running on its gate");

  const parentFinals = [];
  const runParent = loop.run({
    sessionKey: "waiter:main",
    text: "wait for your child",
    onEvent: (e) => { if (e.type === "final") parentFinals.push(e.text); },
  });
  // Parent ends its turn with the waiting acknowledgment (not a real answer).
  await waitFor(() => parentFinals.length === 1, "yielded turn ended");
  assert.match(parentFinals[0], /^Waiting for the sub-agent/);

  // Child completes → its result wakes the parent with the completion batch.
  // The wake turn's own events arrive via the session event hub (emitChild),
  // exactly like a real announced turn in the Service.
  gates.get("kid").resolve();
  await runParent;
  await waitFor(() => childEvents.some(([k, e]) => k === "waiter:main" && e.type === "final"), "wake turn answered");
  const wake = childEvents.find(([k, e]) => k === "waiter:main" && e.type === "final");
  assert.ok(wake[1].text.includes('Sub-agent "quick" completed'), `wake content: ${String(wake[1].text).slice(0, 300)}`);
});

test("boot recovery marks running children interrupted", async () => {
  const { store } = makeRig();
  store.registerSubagent({
    child_session_key: "subagent:main:main:deadbeef",
    parent_session_key: "main:main",
    run_id: "sub-dead", label: "lost", task: "vanished mid-run", task_name: "lost",
    depth: 1, status: "running", outcome: null, result_stats: null,
    delivery: "pending", spawned_at: Date.now(), ended_at: null,
  });
  const swept = store.sweepInterruptedSubagents();
  assert.equal(swept, 1);
  const row = store.getSubagent("subagent:main:main:deadbeef");
  assert.equal(row.status, "interrupted");
});

test("session_send steers into a busy session and refuses an idle steer", async () => {
  const { loop, subs } = makeRig();
  const idle = await subs.send("idle:main", "hello", "steer");
  assert.equal(idle.ok, false, `refused: ${JSON.stringify(idle)}`);
  assert.match(idle.error, /no active run/);
  const follow = await subs.send("idle:main", "hello", "followup");
  assert.equal(follow.ok, true);
  await waitFor(() => loop.busySessions().length === 0, "settled");
});
