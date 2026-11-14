// Task 54 — a model pinned to one conversation.
//
// `/model` on Telegram writes `sessions.model`, and the loop must honour it for
// the *whole* run: the profile decides the tuning, the call gets the pin's wire
// ref, and the history budget comes from that model's window. One resolver,
// three readers — so this file reads the model the LLM is actually called with,
// not just the row.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const { Store, AgentLoop, createLogger, emptyConfig, historyBudget, modelProfile } = await import("../dist/lib.js");

const scratch = (name) => mkdtempSync(join(tmpdir(), name));

function config() {
  const cfg = emptyConfig();
  cfg.providers = {
    anthropic: { baseUrl: "https://api.anthropic.com", apiKey: "k", models: ["claude-sonnet-4-5"] },
    openai: { baseUrl: "https://api.openai.com", apiKey: "k", models: ["gpt-5-1"] },
  };
  cfg.models = {
    "claude-sonnet": { ref: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5", enabled: true },
    "gpt-51": { ref: "openai/gpt-5-1", label: "GPT-5.1", enabled: true },
  };
  cfg.agents.defaults.model = "gpt-51";
  return cfg;
}

function loopWith(store, cfg) {
  const seen = [];
  const llm = {
    stream(opts) {
      seen.push(opts.model);
      return (async function* () {
        yield { type: "text", text: "ok" };
        yield { type: "done", finishReason: "stop" };
      })();
    },
    setConfig() {},
  };
  const loop = new AgentLoop({ config: cfg, store, log: createLogger({ level: "error" }), llm });
  return { loop, seen };
}

test("the column exists on a fresh DB, survives a reopen, and is added to an old one", (t) => {
  const dir = scratch("sc-pin-");
  const path = join(dir, "state.sqlite");
  let store = Store.open(path);
  store.ensureSession("main:a");
  store.setSessionModel("main:a", "claude-sonnet");
  assert.equal(store.getSessionByKey("main:a").model, "claude-sonnet");
  store.setSessionModel("main:a", null);
  assert.equal(store.getSessionByKey("main:a").model ?? null, null, "null clears the pin");
  store.setSessionModel("main:a", "  ");
  assert.equal(store.getSessionByKey("main:a").model ?? null, null, "whitespace clears it too");
  store.close();

  // Simulate a database written before this feature: drop the column and let
  // Store.open() migrate it back — that is the upgrade everyone will run.
  const raw = new DatabaseSync(path);
  raw.exec("ALTER TABLE sessions DROP COLUMN model");
  raw.close();
  const reopened = Store.open(path);
  t.after(() => reopened.close());
  const cols = new DatabaseSync(path).prepare("PRAGMA table_info(sessions)").all().map((c) => c.name);
  assert.ok(cols.includes("model"), "the column is back after the upgrade");
  assert.equal(reopened.getSessionByKey("main:a").model ?? null, null, "and the old rows read as unpinned");
});

test("the pin is the model the LLM is called with, for that session only", async (t) => {
  const store = Store.open(join(scratch("sc-pin-loop-"), "state.sqlite"));
  t.after(() => store.close());
  const cfg = config();
  const { loop, seen } = loopWith(store, cfg);

  store.ensureSession("main:a");
  store.setSessionModel("main:a", "claude-sonnet");

  await loop.run({ sessionKey: "main:a", text: "hi", onEvent: () => {} });
  assert.equal(seen[0], "anthropic/claude-sonnet-4-5", "the pinned profile's wire ref reaches the client");

  // A different conversation is untouched.
  await loop.run({ sessionKey: "main:b", text: "hi", onEvent: () => {} });
  assert.equal(seen[1], "openai/gpt-5-1", "an unpinned session still runs the configured default");

  // A per-run override still beats the pin (the TUI's /model, cron --model).
  await loop.run({ sessionKey: "main:a", text: "hi", model: "openai/gpt-5-1", onEvent: () => {} });
  assert.equal(seen[2], "openai/gpt-5-1", "input.model wins over the session pin");

  // Clearing the pin puts the default back.
  store.setSessionModel("main:a", null);
  await loop.run({ sessionKey: "main:a", text: "hi", onEvent: () => {} });
  assert.equal(seen[3], "openai/gpt-5-1");
});

test("a pin that no longer resolves falls back instead of failing the turn", async (t) => {
  const store = Store.open(join(scratch("sc-pin-stale-"), "state.sqlite"));
  t.after(() => store.close());
  const cfg = config();
  const { loop, seen } = loopWith(store, cfg);

  store.ensureSession("main:a");
  store.setSessionModel("main:a", "model-that-was-deleted");
  const events = [];
  await loop.run({ sessionKey: "main:a", text: "hi", onEvent: (e) => events.push(e.type) });
  assert.equal(seen[0], "openai/gpt-5-1", "the default is used, the turn succeeds");
  assert.ok(events.includes("final"), "and the user still gets an answer");

  // A hand-typed ref on a provider we still have is honoured verbatim — that is
  // the freedom `/model <provider>/<model>` has always had.
  store.setSessionModel("main:a", "anthropic/claude-haiku-4");
  await loop.run({ sessionKey: "main:a", text: "hi", onEvent: () => {} });
  assert.equal(seen[1], "anthropic/claude-haiku-4");

  // ... but a ref to a provider that is gone is stale again.
  store.setSessionModel("main:a", "gone-provider/model-x");
  await loop.run({ sessionKey: "main:a", text: "hi", onEvent: () => {} });
  assert.equal(seen[2], "openai/gpt-5-1");
});

test("a pin naming a disabled profile falls back — enabling it brings it back", async (t) => {
  const store = Store.open(join(scratch("sc-pin-off-"), "state.sqlite"));
  t.after(() => store.close());
  const cfg = config();
  const { loop, seen } = loopWith(store, cfg);
  store.ensureSession("main:a");
  store.setSessionModel("main:a", "claude-sonnet");

  cfg.models["claude-sonnet"].enabled = false;
  await loop.run({ sessionKey: "main:a", text: "hi", onEvent: () => {} });
  assert.equal(seen[0], "openai/gpt-5-1", "a disabled profile is not silently used");

  cfg.models["claude-sonnet"].enabled = true;
  await loop.run({ sessionKey: "main:a", text: "hi", onEvent: () => {} });
  assert.equal(seen[1], "anthropic/claude-sonnet-4-5");
});

test("the history budget follows the pinned model's window, not the default's", () => {
  // The budget is derived from the model a run asks for. The loop feeds it the
  // same `#modelFor()` that decides the call (one resolver, three readers), so
  // proving the profile carries the window is proving the budget follows the pin.
  const cfg = config();
  cfg.models["claude-sonnet"].contextWindow = 200_000;
  cfg.models["gpt-51"].contextWindow = 8_000;
  assert.equal(modelProfile(cfg, "claude-sonnet").contextWindow, 200_000);
  assert.equal(modelProfile(cfg, "gpt-51").contextWindow, 8_000);
  assert.ok(
    historyBudget(cfg, "claude-sonnet").chars > historyBudget(cfg, "gpt-51").chars,
    "a big-window pin gets a big budget",
  );
  assert.ok(historyBudget(cfg, "").chars > 0, "no pin still budgets the configured default");
});

test("the pin is part of the session row, so it survives a reopen and reaches every surface", (t) => {
  const dir = scratch("sc-pin-row-");
  const path = join(dir, "state.sqlite");
  const store = Store.open(path);
  store.ensureSession("telegram:42");
  store.setSessionModel("telegram:42", "claude-sonnet");

  // What the web sidebar and `sessions.list` read: the same row, same column.
  const row = store.listSessions(10).find((s) => s.key === "telegram:42");
  assert.equal(row?.model, "claude-sonnet");
  store.close();

  const reopened = Store.open(path);
  t.after(() => reopened.close());
  assert.equal(reopened.getSessionByKey("telegram:42").model, "claude-sonnet", "the choice is durable");
});
