// Task 20 — the agent owns automations. Before these tools existed the agent's
// only honest answer to "remind me at 8am" was "I cannot schedule that", and
// the task went into a daily journal note. These cases pin the four tools, the
// validation contract they share with `sc cron` / `cron.upsert`, the delivery
// default that keeps a reminder out of an unread transcript, and the re-arm
// hook that makes a job created in chat fire without a restart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { Store, buildRegistry, emptyConfig } = await import("../dist/lib.js");

const TMP = mkdtempSync(join(tmpdir(), "sc-cron-tools-"));
const noop = { info() {}, warn() {}, error() {}, debug() {}, child() { return noop; } };

function harness(extraCtx = {}) {
  const dir = mkdtempSync(join(TMP, "case-"));
  const ws = join(dir, "ws");
  mkdirSync(ws, { recursive: true });
  const store = Store.open(join(dir, "state.sqlite"));
  const config = emptyConfig();
  const registry = buildRegistry(config);
  const tool = (name) => {
    const spec = registry.find((t) => t.name === name);
    assert.ok(spec, `${name} is registered`);
    return spec;
  };
  const ctx = {
    workspace: ws,
    stateDir: dir,
    skills: [],
    store,
    config,
    log: noop,
    sessionKey: "main:test",
    ...extraCtx,
  };
  return { dir, ws, store, config, registry, tool, ctx };
}

const JOB = {
  name: "Math Questions for Toha",
  schedule: "0 8 * * *",
  prompt: "Ask Toha and Adib two math questions, then send the vabsomprosaron material to Toha.",
  tz: "Asia/Dhaka",
};

test("registry: the four cron tools ship by default", () => {
  const { registry } = harness();
  const names = registry.map((t) => t.name);
  for (const name of ["cron_list", "cron_add", "cron_update", "cron_remove"]) {
    assert.ok(names.includes(name), `${name} is registered`);
  }
  // parameterless list must survive toolsToSchema's empty-properties quirk
  assert.ok(Array.isArray(registry.find((t) => t.name === "cron_list").parameters.required ?? []));
});

test("cron_add: writes the same row the CLI writes, and reports the next run", async () => {
  const { store, tool, ctx } = harness();
  const out = await tool("cron_add").run(JOB, ctx);
  assert.match(out, /^created cron job math-questions-for-toha/);
  assert.match(out, /schedule: 0 8 \* \* \* \(Asia\/Dhaka\) · next \d{4}-\d{2}-\d{2}T02:00:00\.000Z · enabled/);
  assert.match(out, /every run starts fresh/, "the reply teaches the fresh-session rule");

  const row = store.getJob("math-questions-for-toha");
  assert.equal(row.session_key, "cron:math-questions-for-toha");
  assert.equal(row.name, JOB.name);
  assert.equal(row.schedule, "0 8 * * *");
  assert.equal(row.tz, "Asia/Dhaka");
  assert.equal(row.enabled, 1);
  assert.equal(row.delivery_suppress_empty, 1);
  assert.match(row.prompt, /vabsomprosaron/);
  // 8am in Dhaka is 02:00Z all year round (no DST), so the zone is really applied
  assert.match(out, /next \d{4}-\d{2}-\d{2}T02:00:00\.000Z/);
});

test("cron_add: an ISO datetime is a one-shot, interpreted in tz", async () => {
  const { store, tool, ctx } = harness();
  const day = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const out = await tool("cron_add").run(
    { name: "one shot", schedule: `${day}T08:00:00`, prompt: "send it", tz: "Asia/Dhaka" },
    ctx,
  );
  assert.match(out, /^created cron job one-shot/);
  assert.ok(out.includes(`next ${day}T02:00:00.000Z`), `expected ${day}T02:00:00.000Z in:\n${out}`);
  assert.equal(store.getJob("one-shot").schedule, `${day}T08:00:00`);
});

test("cron_add: every bad argument is an error string and nothing is persisted", async () => {
  const { store, tool, ctx } = harness();
  const add = tool("cron_add");
  const cases = [
    [{ ...JOB, schedule: "nonsense" }, /invalid schedule or timezone/],
    [{ ...JOB, tz: "Mars/Olympus" }, /invalid schedule or timezone/],
    [{ ...JOB, name: "!!!" }, /needs at least one letter or number/],
    [{ ...JOB, delivery: "webhook" }, /webhook needs to=/],
    [{ ...JOB, delivery: "pigeon" }, /delivery must be none \| announce \| webhook/],
    [{ name: "no prompt", schedule: "0 8 * * *" }, /name, schedule and prompt are required/],
  ];
  for (const [args, expected] of cases) {
    const out = await add.run(args, ctx);
    assert.match(out, /^error: /, `expected an error for ${JSON.stringify(args)}`);
    assert.match(out, expected);
  }
  assert.equal(store.listJobs().length, 0, "a rejected add never writes a row");
});

test("cron_add: an existing id is protected, not silently overwritten", async () => {
  const { store, tool, ctx } = harness();
  await tool("cron_add").run(JOB, ctx);
  const dup = await tool("cron_add").run({ ...JOB, prompt: "completely different" }, ctx);
  assert.match(dup, /^error: a job with id "math-questions-for-toha" already exists — call cron_update/);
  assert.match(store.getJob("math-questions-for-toha").prompt, /vabsomprosaron/);
});

test("cron_add: delivery defaults to the chat that asked, unless a global default or none is set", async () => {
  // a Telegram DM answers to its own chat id
  const tg = harness({ sessionKey: "telegram:123456789" });
  await tg.tool("cron_add").run(JOB, tg.ctx);
  assert.equal(tg.store.getJob("math-questions-for-toha").delivery_mode, "announce");
  assert.equal(tg.store.getJob("math-questions-for-toha").delivery_to, "telegram:123456789");

  // a topic keeps the chat, not the thread
  const topic = harness({ sessionKey: "telegram:42:topic:7" });
  await topic.tool("cron_add").run(JOB, topic.ctx);
  assert.equal(topic.store.getJob("math-questions-for-toha").delivery_to, "telegram:42");

  // anything else lands in its own session transcript
  const web = harness();
  await web.tool("cron_add").run(JOB, web.ctx);
  assert.equal(web.store.getJob("math-questions-for-toha").delivery_to, "session:main:test");

  // an operator-configured global delivery target is inherited, not overridden
  const global = harness();
  global.config.cron.delivery = { mode: "webhook", to: "https://example.test/hook", suppressEmpty: true };
  await global.tool("cron_add").run(JOB, global.ctx);
  assert.equal(global.store.getJob("math-questions-for-toha").delivery_mode, null);

  // an explicit silent run stays silent
  const silent = harness();
  await silent.tool("cron_add").run({ ...JOB, delivery: "none" }, silent.ctx);
  const row = silent.store.getJob("math-questions-for-toha");
  assert.equal(row.delivery_mode, "none");
  assert.equal(row.delivery_to, null);
});

test("cron_list: ids first, then schedule/next/delivery/last run; empty is a sentence", async () => {
  const { store, tool, ctx } = harness();
  assert.match(await tool("cron_list").run({}, ctx), /^no scheduled jobs yet — create one with cron_add$/);

  await tool("cron_add").run(JOB, ctx);
  store.recordJobRun("math-questions-for-toha", "done", "sent");
  const out = await tool("cron_list").run({}, ctx);
  assert.match(out, /^1 scheduled job\n/);
  assert.match(out, /math-questions-for-toha — Math Questions for Toha/);
  assert.match(out, /schedule: 0 8 \* \* \* \(Asia\/Dhaka\) · next \d{4}-\d{2}-\d{2}T02:00:00\.000Z · enabled/);
  assert.match(out, /delivery: announce → session:main:test · session cron:math-questions-for-toha/);
  assert.match(out, /last run: \d{4}-\d{2}-\d{2}T[\d:.]+Z · done/);
  assert.match(out, /prompt: Ask Toha and Adib two math questions/);
});

test("cron_update: rename keeps id+session, retime is re-validated, tz clears with \"\"", async () => {
  const { store, tool, ctx } = harness();
  await tool("cron_add").run(JOB, ctx);
  const id = "math-questions-for-toha";

  const renamed = await tool("cron_update").run({ id, name: "Morning Math" }, ctx);
  assert.match(renamed, /^updated math-questions-for-toha — name → Morning Math/);
  assert.equal(store.getJob(id).name, "Morning Math");
  assert.equal(store.getJob(id).session_key, `cron:${id}`, "a rename never orphans the transcript");

  const retimed = await tool("cron_update").run({ id, schedule: "30 6 * * *" }, ctx);
  assert.match(retimed, /schedule: 30 6 \* \* \* \(Asia\/Dhaka\)/);
  assert.equal(store.getJob(id).schedule, "30 6 * * *");

  const cleared = await tool("cron_update").run({ id, tz: "" }, ctx);
  assert.match(cleared, /tz → cron\.timezone/);
  assert.equal(store.getJob(id).tz, "");

  const paused = await tool("cron_update").run({ id, enabled: false }, ctx);
  assert.match(paused, /paused/);
  assert.equal(store.getJob(id).enabled, 0);
  await tool("cron_update").run({ id, enabled: true }, ctx);
  assert.equal(store.getJob(id).enabled, 1);
});

test("cron_update: unknown ids and bad schedules are errors that leave the row alone", async () => {
  const { store, tool, ctx } = harness();
  await tool("cron_add").run(JOB, ctx);
  const id = "math-questions-for-toha";

  assert.match(await tool("cron_update").run({ id: "nope", name: "x" }, ctx), /^error: no job with id "nope"/);
  assert.match(await tool("cron_update").run({ id }, ctx), /^updated math-questions-for-toha — nothing changed/);

  const bad = await tool("cron_update").run({ id, schedule: "every morning" }, ctx);
  assert.match(bad, /^error: invalid schedule or timezone/);
  assert.equal(store.getJob(id).schedule, "0 8 * * *", "a rejected retime never lands");
  assert.equal(store.getJob(id).name, JOB.name);
});

test("cron_remove: deletes the schedule, keeps the history, says so twice", async () => {
  const { store, tool, ctx } = harness();
  await tool("cron_add").run(JOB, ctx);
  const id = "math-questions-for-toha";
  store.recordJobRun(id, "done", "sent");

  const out = await tool("cron_remove").run({ id }, ctx);
  assert.match(out, /^removed "Math Questions for Toha" \(math-questions-for-toha\)/);
  assert.match(out, /previous runs stay in the transcript of cron:math-questions-for-toha/);
  assert.equal(store.getJob(id), undefined);

  const again = await tool("cron_remove").run({ id }, ctx);
  assert.match(again, /^error: no job with id "math-questions-for-toha"/);
});

test("cronChanged: fires once per real mutation, never for a rejected one", async () => {
  const { tool, ctx } = harness();
  let armed = 0;
  const hooked = { ...ctx, cronChanged: async () => { armed += 1; } };

  await tool("cron_add").run(JOB, hooked);
  assert.equal(armed, 1, "a created job re-arms the scheduler");

  await tool("cron_add").run({ ...JOB, schedule: "nope" }, hooked);
  assert.equal(armed, 1, "a rejected add does not touch the scheduler");

  await tool("cron_update").run({ id: "math-questions-for-toha", enabled: false }, hooked);
  assert.equal(armed, 2);

  await tool("cron_update").run({ id: "missing", name: "x" }, hooked);
  assert.equal(armed, 2);

  await tool("cron_remove").run({ id: "math-questions-for-toha" }, hooked);
  assert.equal(armed, 3);
});

test("cron_add: warns instead of pretending when cron is disabled in config", async () => {
  const { tool, ctx } = harness();
  ctx.config.cron.enabled = false;
  const out = await tool("cron_add").run(JOB, ctx);
  assert.match(out, /^created cron job /);
  assert.match(out, /warning: cron is disabled in config \(cron\.enabled=false\)/);
});

// ---- Task 22: the agent knows its surfaces ---------------------------------
// The reminder worked and the *explanation* was a lie ("I don't have direct
// Telegram API access from this device"). cron_add now resolves targets against
// the live channel facts, so "telegram" is a real chat id and an impossible
// target is an error instead of a promise.

const TG_ONLINE = {
  telegram: { enabled: true, hasToken: true, running: true, username: "suparbot", error: "" },
  telegramChats: ["123456789"],
};
const TG_OFFLINE = {
  telegram: { enabled: true, hasToken: true, running: false, username: "", error: "401 Unauthorized" },
  telegramChats: ["123456789"],
};

test("cron_add: a web-chat reminder still comes back here, and the reply names the Telegram route", async () => {
  const { store, tool, ctx } = harness({ surfaces: TG_ONLINE });
  const out = await tool("cron_add").run(JOB, ctx);
  const row = store.getJob("math-questions-for-toha");
  assert.equal(row.delivery_to, "session:main:test", "the surface that asked is unchanged");
  assert.match(
    out,
    /Telegram is online as @suparbot — pass to=telegram to send it to chat 123456789 instead/,
    "no invented limitation: the real target and the exact argument",
  );
});

test('cron_add: to="telegram" delivers to the operator chat from the web chat', async () => {
  const { store, tool, ctx } = harness({ surfaces: TG_ONLINE });
  const out = await tool("cron_add").run({ ...JOB, to: "telegram" }, ctx);
  assert.match(out, /^created cron job /);
  const row = store.getJob("math-questions-for-toha");
  assert.equal(row.delivery_mode, "announce");
  assert.equal(row.delivery_to, "telegram:123456789");
  assert.match(out, /delivery: announce → telegram:123456789 via @suparbot on Telegram/);
});

test("cron_add: an impossible Telegram target is an error and writes nothing", async () => {
  const offline = harness({ surfaces: TG_OFFLINE });
  const offOut = await offline.tool("cron_add").run({ ...JOB, to: "telegram" }, offline.ctx);
  assert.match(offOut, /^error: Telegram is configured but not running \(401 Unauthorized\)/);
  assert.equal(offline.store.listJobs().length, 0);

  const unconfigured = harness();
  const noneOut = await unconfigured.tool("cron_add").run({ ...JOB, to: "telegram" }, unconfigured.ctx);
  assert.match(noneOut, /^error: Telegram is not configured/);
  assert.equal(unconfigured.store.listJobs().length, 0);
});

test("cron_update: retargets a running job to Telegram, and lists it with the live state", async () => {
  const { store, tool, ctx } = harness({ surfaces: TG_ONLINE });
  await tool("cron_add").run(JOB, ctx);
  const id = "math-questions-for-toha";

  const moved = await tool("cron_update").run({ id, to: "telegram" }, ctx);
  assert.match(moved, /to → telegram:123456789/);
  assert.equal(store.getJob(id).delivery_to, "telegram:123456789");

  const listed = await tool("cron_list").run({}, ctx);
  assert.match(listed, /delivery: announce → telegram:123456789 via @suparbot on Telegram/);

  // and the same move is refused when the channel cannot deliver
  const offline = harness({ surfaces: TG_OFFLINE });
  await offline.tool("cron_add").run(JOB, offline.ctx);
  const refused = await offline.tool("cron_update").run({ id, to: "telegram" }, offline.ctx);
  assert.match(refused, /^error: Telegram is configured but not running/);
  assert.equal(offline.store.getJob(id).delivery_to, "session:main:test", "the old target survives a refused move");
});
