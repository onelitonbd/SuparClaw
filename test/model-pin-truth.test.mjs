// Task 55 — the model you picked is the model that answers.
//
// The complaint this file pins down: Telegram said "Model: X — this chat", then
// answered from the default. Two separate lies had to line up for that:
//
//   1. the run still carried the configured fallback chain, so a pinned model
//      that failed was silently replaced by the default, and
//   2. the reply footer was derived from `payload.model` (undefined for a chat),
//      i.e. from the configured default — so even a successful pinned call was
//      reported as the default.
//
// A choice is now strict: no fallbacks, and the footer reports the model that
// actually answered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SUPARCLAW_HOME = mkdtempSync(join(tmpdir(), "sc-pin-home-"));
const { Service, Store, AgentLoop, createLogger, emptyConfig } = await import("../dist/lib.js");

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
  cfg.agents.defaults.fallbacks = ["claude-sonnet"];
  return cfg;
}

/** Records every call; optionally fails the calls that name `failFor`. */
function loopWith(store, cfg, opts = {}) {
  const calls = [];
  const llm = {
    stream(request) {
      calls.push({ model: request.model, fallbacks: [...(request.fallbacks ?? [])] });
      if (opts.failFor && request.model === opts.failFor) {
        return (async function* () {
          throw new Error("401 invalid x-api-key (test)");
        })();
      }
      return (async function* () {
        yield { type: "text", text: "ok" };
        yield { type: "usage", usage: { input: 10, output: 2 } };
        yield { type: "done", finishReason: "stop" };
      })();
    },
    setConfig() {},
  };
  const loop = new AgentLoop({ config: cfg, store, log: createLogger({ level: "error" }), llm });
  return { loop, calls };
}

async function run(loop, opts = {}) {
  const events = [];
  await loop.run({ sessionKey: "telegram:7", text: "hi", onEvent: (e) => events.push(e), ...opts });
  return events;
}

test("a pinned model rides no fallback chain, and the footer names it", async (t) => {
  const store = Store.open(join(scratch("sc-pin-truth-"), "state.sqlite"));
  t.after(() => store.close());
  const cfg = config();
  const { loop, calls } = loopWith(store, cfg);

  store.ensureSession("telegram:7");
  store.setSessionModel("telegram:7", "claude-sonnet");

  const events = await run(loop);
  assert.equal(calls[0].model, "anthropic/claude-sonnet-4-5", "the pinned wire ref is the one called");
  assert.deepEqual(calls[0].fallbacks, [], "a choice is strict — substitution behind the pin is the bug");

  const final = events.find((e) => e.type === "final");
  assert.equal(final.model, "anthropic/claude-sonnet-4-5", "the final event carries the model that answered");
});

test("the default still has its fallbacks — only a choice is strict", async (t) => {
  const store = Store.open(join(scratch("sc-pin-default-"), "state.sqlite"));
  t.after(() => store.close());
  const cfg = config();
  const { loop, calls } = loopWith(store, cfg);

  await run(loop);
  assert.equal(calls[0].model, "openai/gpt-5-1", "unpinned runs the configured default");
  assert.deepEqual(calls[0].fallbacks, ["anthropic/claude-sonnet-4-5"], "and keeps the configured chain");

  const events = await run(loop, { model: "anthropic/claude-sonnet-4-5" });
  assert.deepEqual(calls[1].fallbacks, [], "a per-run pick (TUI /model, cron --model) is strict too");
  assert.equal(events.find((e) => e.type === "final").model, "anthropic/claude-sonnet-4-5");
});

test("a pinned model that fails says so, instead of answering from the default", async (t) => {
  const store = Store.open(join(scratch("sc-pin-fail-"), "state.sqlite"));
  t.after(() => store.close());
  const cfg = config();
  const { loop, calls } = loopWith(store, cfg, { failFor: "anthropic/claude-sonnet-4-5" });

  store.ensureSession("telegram:7");
  store.setSessionModel("telegram:7", "claude-sonnet");

  const events = await run(loop);
  assert.equal(calls.length, 1, "the chain is not consulted for a chosen model");
  const error = events.find((e) => e.type === "error");
  assert.ok(error, "the turn fails visibly instead of answering as somebody else");
  assert.match(error.message, /401 invalid x-api-key/);
  assert.match(error.message, /picked for this session/, "and it says why no fallback rescued it");
  assert.match(error.message, /\/model default/, "and the one command that undoes the pin");
});

test("a pin whose model was deleted falls back to the default, and stays visible", async (t) => {
  const store = Store.open(join(scratch("sc-pin-stale-"), "state.sqlite"));
  t.after(() => store.close());
  const cfg = config();
  const { loop, calls } = loopWith(store, cfg);

  store.ensureSession("telegram:7");
  store.setSessionModel("telegram:7", "model-that-was-removed");

  const events = await run(loop);
  assert.equal(calls[0].model, "openai/gpt-5-1", "a stale pin cannot brick the chat");
  assert.deepEqual(calls[0].fallbacks, ["anthropic/claude-sonnet-4-5"], "and the default keeps its chain");
  assert.equal(events.find((e) => e.type === "final").model, "openai/gpt-5-1", "the footer tells the truth about who answered");
});

test("the line the operator reads names the model that answered, not the default", async (t) => {
  // The reported symptom, end to end: a chat pinned to Claude, a default of
  // GPT-5.1, and the footer on the delivered message. Before Task 55 this read
  // "… · GPT-5.1" no matter what answered.
  const svc = new Service();
  t.after(() => svc.stop());
  const cfg = svc.configSvc.current;
  cfg.providers = {
    anthropic: { baseUrl: "https://api.anthropic.com", apiKey: "k", models: ["claude-sonnet-4-5"] },
    openai: { baseUrl: "https://api.openai.com", apiKey: "k", models: ["gpt-5-1"] },
  };
  cfg.models = {
    "claude-sonnet": { ref: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5", enabled: true },
    "gpt-51": { ref: "openai/gpt-5-1", label: "GPT-5.1", enabled: true },
  };
  cfg.agents.defaults.model = "gpt-51";
  cfg.agents.defaults.usage = "full";

  const calls = [];
  svc.loop.llm = {
    async *stream(req) {
      calls.push(req.model);
      yield { type: "text", text: "pong" };
      yield { type: "usage", usage: { prompt_tokens: 12480, completion_tokens: 263 } };
      yield { type: "done", finishReason: "stop" };
    },
    setConfig() {},
  };

  svc.store.ensureSession("telegram:9");
  svc.store.setSessionModel("telegram:9", "claude-sonnet");

  let delivered = "";
  await svc.send({ sessionKey: "telegram:9", text: "ping", source: "telegram", reply: async (text) => { delivered = text; } });

  assert.equal(calls[0], "anthropic/claude-sonnet-4-5", "the pinned ref is what went on the wire");
  assert.match(delivered, /Claude Sonnet 4\.5/, `the footer names the answered model: ${delivered}`);
  assert.doesNotMatch(delivered, /GPT-5\.1/, "and never the configured default");
  assert.match(delivered, /12\.5k in · 263 out/, "with the real numbers beside it");
});
