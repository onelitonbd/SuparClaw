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

const { AgentLoop, Store, Subagents, buildRegistry, emptyConfig } = await import("../dist/lib.js");

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
  // A bounded rig on purpose. The product default is 0 = no ceiling (Task 38),
  // but these tests script a model that keeps calling the same tool forever —
  // the rig wants a terminator so a regression shows up as a failed assertion,
  // not a hung suite.
  cfg.agents.defaults.maxToolIterations = 12;
  Object.assign(cfg.agents.defaults.subagents, patch.subagents ?? {});
  const store = Store.open(join(HOME, `s-${dbSeq++}.db`));
  const rounds = [];
  const reasoningSeen = [];
  const gates = new Map();
  const llm = {
    async *stream(opts) {
      const lastUser = [...opts.messages].reverse().find((m) => m.role === "user")?.content ?? "";
      rounds.push(lastUser.slice(0, 120));
      reasoningSeen.push(opts.reasoning);
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
  const probes = [];
  const tools = [
    {
      name: "probe_context",
      description: "records what the loop told this run about itself",
      parameters: { type: "object", properties: {} },
      async run(_args, ctx) {
        probes.push({ model: ctx.model, thinking: ctx.thinking });
        return "probed";
      },
    },
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
  return { cfg, store, loop, subs, gates, childEvents, rounds, reasoningSeen, probes };
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

// "Blank inherits the caller's model" and "Overrides what the caller chose" are
// what the Run limits card promises. Both used to be false: with nothing
// configured the child fell back to the global default instead of the caller's
// model, and nothing carried the caller's thinking level at all.
test("a child inherits the caller's model and thinking when nothing names one", async () => {
  const { subs, reasoningSeen } = makeRig();
  const res = await subs.spawn("inherit:main", {
    task: "carry on without a model of my own",
    callerModel: "claude/caller-profile",
    callerThinking: "high",
  });
  assert.equal(res.accepted, true, JSON.stringify(res));
  assert.equal(res.resolvedModel, "claude/caller-profile", "resolvedModel reports what the child will run on");
  await waitFor(() => reasoningSeen.includes("high"), `child streamed with the caller's thinking level: ${JSON.stringify(reasoningSeen)}`);
  await waitFor(
    () => subs.deps.store.getSubagent(res.childSessionKey)?.status !== "running",
    "child finished",
  );
});

test("the configured subagents.model / .thinking beat the caller, and a spawn argument beats both", async () => {
  const { subs, reasoningSeen } = makeRig({ subagents: { model: "cfg/cheap-model", thinking: "low" } });

  const cfgWins = await subs.spawn("precedence:main", {
    task: "task one",
    callerModel: "claude/caller-profile",
    callerThinking: "high",
  });
  assert.equal(cfgWins.resolvedModel, "cfg/cheap-model", "the configured default wins over the caller");
  await waitFor(() => reasoningSeen.includes("low"), `child used the configured level: ${JSON.stringify(reasoningSeen)}`);

  const argWins = await subs.spawn("precedence:main", {
    task: "task two",
    model: "explicit/special-model",
    thinking: "xhigh",
    callerModel: "claude/caller-profile",
    callerThinking: "high",
    context: "fork",
  });
  assert.equal(argWins.resolvedModel, "explicit/special-model", "the spawn argument wins over everything");
  await waitFor(() => reasoningSeen.includes("xhigh"), `child used the requested level: ${JSON.stringify(reasoningSeen)}`);
});

// The inheritance above only works if the loop hands the run's own model and
// thinking level to the tool context — that wiring is what these two assert.
test("the loop tells a run which model and thinking level it is on", async () => {
  const { loop, probes } = makeRig({
    plan: (_opts, lastUser) =>
      lastUser === "what are you?" ? { calls: [{ id: "p1", name: "probe_context", args: "{}" }] } : null,
  });
  await loop.run({
    sessionKey: "probe:main",
    text: "what are you?",
    model: "claude/caller-profile",
    reasoning: "high",
    onEvent: () => {},
  });
  await waitFor(() => probes.length > 0, "probe ran");
  assert.deepEqual(probes[0], { model: "claude/caller-profile", thinking: "high" });
});

test("the spawn tool passes the caller's model and thinking into spawn()", async () => {
  const tool = buildRegistry(emptyConfig()).find((t) => t.name === "sessions_spawn");
  assert.ok(tool, "sessions_spawn is always in the registry");
  const seen = [];
  const ctx = {
    sessionKey: "caller:main",
    model: "claude/caller-profile",
    thinking: "medium",
    subagents: {
      async spawn(parentKey, opts) {
        seen.push([parentKey, opts]);
        return { accepted: true, childSessionKey: "subagent:caller:main:00000000", runId: "r1", taskName: "t", context: "isolated" };
      },
    },
  };
  await tool.run({ task: "do the thing" }, ctx);

  assert.equal(seen.length, 1);
  const [parentKey, opts] = seen[0];
  assert.equal(parentKey, "caller:main");
  assert.equal(opts.callerModel, "claude/caller-profile");
  assert.equal(opts.callerThinking, "medium");
  // Still only a fallback: the tool does not force its own model on the child.
  assert.equal(opts.model, undefined);
  assert.equal(opts.thinking, undefined);
});
