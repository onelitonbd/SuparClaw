// Task 23 — the reply footer must survive a reload, and Regenerate must be real.
//
// What was wrong: the usage line (`↳ 8.8k in · 33 out · <model> · 8.8k total`) was
// "SURFACE-ONLY decoration" appended to the final event's text. The transcript row
// stayed clean, `chat.history` returned only id/role/content/createdAt, and the UI
// replayed `content` — so any refresh (and certainly a restart) dropped the line.
//
// These cases are the failure written down first: the row must carry the numbers,
// history must rebuild the line from them, and regenerate must truncate the last
// turn before re-running it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { AgentLoop, Store, createLogger, emptyConfig, historyPayload, usageFooter, truncateLastTurn } =
  await import("../dist/lib.js");

const TMP = mkdtempSync(join(tmpdir(), "sc-usage-replay-"));
let seq = 0;
const NOOP = { info() {}, warn() {}, error() {}, debug() {} };

const LABEL = "kilo/nvidia/nemotron-3.5-super-vl:free";

/** A store + config with one priced-free profile, matching the user's footer. */
function rig() {
  const dir = mkdtempSync(join(TMP, `r-${seq++}-`));
  const ws = join(dir, "ws");
  mkdirSync(ws, { recursive: true });
  const store = Store.open(join(dir, "state.sqlite"));
  const config = emptyConfig();
  config.models["kilo-free"] = { ref: LABEL, label: LABEL, enabled: true };
  config.agents.defaults.model = "kilo-free";
  return { dir, store, config };
}

/** One turn through the real loop, with a provider that reports 8.8k in / 33 out. */
async function runTurn({ store, config }, text) {
  const fake = {
    async *stream() {
      yield { type: "text", text: "Two questions for Toha and Adib." };
      yield { type: "usage", usage: { prompt_tokens: 8800, completion_tokens: 33 } };
      yield { type: "done", finishReason: "stop" };
    },
    setConfig() {},
  };
  const loop = new AgentLoop({ config, store, log: createLogger({ level: "error" }), llm: fake, tools: [] });
  const events = [];
  await loop.run({ sessionKey: "main:main", text, onEvent: (e) => events.push(e) });
  return events;
}

test("the assistant row carries the numbers and the model it was written with", async () => {
  const r = rig();
  await runTurn(r, "make math questions");
  const session = r.store.getSessionByKey("main:main");
  const rows = r.store.recentMessages(session.id, 10);
  const assistant = rows.find((m) => m.role === "assistant");
  assert.ok(assistant, "the answer row exists");
  assert.ok(assistant.usage, "the row carries usage — this is what a reload reads");
  const stored = JSON.parse(assistant.usage);
  assert.equal(stored.usage.prompt_tokens, 8800);
  assert.equal(stored.usage.completion_tokens, 33);
  assert.equal(stored.model, "kilo-free", "profile id, so a rename or a price card still resolves");
  assert.equal(stored.label, LABEL);
  assert.equal(assistant.content, "Two questions for Toha and Adib.", "the transcript text stays clean");
  assert.ok(!assistant.content.includes("↳"), "no footer baked into the stored markdown");
  r.store.close();
});

test("history rebuilds the exact footer the live reply showed — same string, after a fresh open", async () => {
  const r = rig();
  await runTurn(r, "make math questions");
  const session = r.store.getSessionByKey("main:main");

  const payload = historyPayload(r.store.recentMessages(session.id, 10), {
    mode: "full",
    profile: (id) => (id === "kilo-free" ? { label: LABEL, pricing: undefined } : { label: id }),
  });
  const assistant = payload.find((m) => m.role === "assistant");
  assert.equal(assistant.footer, `↳ 8.8k in · 33 out · ${LABEL} · 8.8k total`);
  assert.equal(assistant.footer, usageFooter("full", { prompt_tokens: 8800, completion_tokens: 33 }, LABEL));
  assert.deepEqual(assistant.usage, { prompt_tokens: 8800, completion_tokens: 33 }, "raw numbers travel too");

  // Restart-equivalent: a new handle on the same file, no in-memory state at all.
  const reopened = Store.open(join(r.dir, "state.sqlite"));
  const again = historyPayload(reopened.recentMessages(session.id, 10), {
    mode: "full",
    profile: () => ({ label: LABEL }),
  });
  assert.equal(again.find((m) => m.role === "assistant").footer, assistant.footer);
  reopened.close();
  r.store.close();
});

test("the footer follows /usage: off hides it, tokens shortens it, cost never invents a price", async () => {
  const r = rig();
  await runTurn(r, "make math questions");
  const session = r.store.getSessionByKey("main:main");
  const rows = () => r.store.recentMessages(session.id, 10);
  const footerFor = (mode) => historyPayload(rows(), { mode, profile: () => ({ label: LABEL }) }).find((m) => m.role === "assistant").footer;

  assert.equal(footerFor("off"), undefined, "off means no line, even though the numbers are stored");
  assert.equal(footerFor("tokens"), "↳ 8.8k in · 33 out");
  assert.equal(
    footerFor("cost"),
    "↳ 8.8k in · 33 out · cost n/a (no pricing for " + LABEL + ")",
    "a missing price card is said, never guessed",
  );
  r.store.close();
});

test("a restored model profile starts pricing old rows (resolution happens at read time)", async () => {
  const r = rig();
  await runTurn(r, "make math questions");
  const session = r.store.getSessionByKey("main:main");
  const priced = historyPayload(r.store.recentMessages(session.id, 10), {
    mode: "cost",
    profile: () => ({ label: LABEL, pricing: { input: 2, output: 10, cachedIn: 0 } }),
  }).find((m) => m.role === "assistant");
  // (8800 × $2 + 33 × $10) / 1e6 = $0.0179 → fmtCost keeps two decimals above a cent.
  assert.match(priced.footer, /^↳ \$0\.02 — 8\.8k in · 33 out · /, `expected a computed cost, got: ${priced.footer}`);
  r.store.close();
});

test("history rows without usage (old transcripts) stay exactly as they are", async () => {
  const r = rig();
  const session = r.store.ensureSession("main:main");
  r.store.appendMessage(session.id, "user", "old question");
  r.store.appendMessage(session.id, "assistant", "old answer");
  const payload = historyPayload(r.store.recentMessages(session.id, 10), { mode: "full", profile: () => ({ label: "x" }) });
  assert.equal(payload[1].footer, undefined, "nothing invented for a row that never had numbers");
  assert.equal(payload[1].content, "old answer");
  r.store.close();
});

test("truncateLastTurn drops the last turn's rows and keeps the prompt", async () => {
  const r = rig();
  await runTurn(r, "first question");
  await runTurn(r, "second question");
  const session = r.store.getSessionByKey("main:main");
  const before = r.store.recentMessages(session.id, 50);
  assert.equal(before.filter((m) => m.role === "user").length, 2);

  const plan = truncateLastTurn(r.store, session.id);
  assert.equal(plan.ok, true);
  assert.equal(plan.text, "second question", "the prompt that produced the answer is what gets re-run");

  const after = r.store.recentMessages(session.id, 50);
  assert.deepEqual(after.map((m) => m.role), ["user", "assistant", "user"], "the old answer is gone, the prompt stays");
  assert.equal(after[2].content, "second question");
  r.store.close();
});

test("truncateLastTurn refuses an empty session instead of throwing", () => {
  const r = rig();
  const session = r.store.ensureSession("main:empty");
  const plan = truncateLastTurn(r.store, session.id);
  assert.equal(plan.ok, false);
  assert.match(plan.error, /nothing to regenerate/);
  r.store.close();
});

test("wiring: the gateway advertises both and history goes through the shared mapper", () => {
  const src = readFileSync(new URL("../src/gateway/server.ts", import.meta.url), "utf8");
  assert.match(src, /"chat\.regenerate",/, "advertised to clients");
  assert.match(src, /messages: historyPayload\(rows, \{/, "history replays through the mapper");
  assert.match(src, /mode: service\.usageModeFor\(sessionKey\)/, "with the session's current /usage mode");
  assert.match(src, /case "chat\.regenerate":/, "and the handler exists");
  assert.match(src, /errFrame\(id, "regenerate_refused"/, "refusals are typed");
});
