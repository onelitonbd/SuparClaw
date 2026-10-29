// Task 56 — "it says it changed the model, but the answers are the default one".
//
// Two ways that sentence can be true, both fixed here:
//
//   1. a pin that no longer resolves was dropped **silently** — the card kept
//      saying "Model: X — this chat" while every turn ran on the default;
//   2. the card named a label, not the wire ref, so there was nothing to check
//      the answer's footer against.
//
// The first test drives the REAL tap (`applyModelTap`, the same function the
// Telegram callback runs) and then a real turn through `Service.send`, so the
// whole path — card → store → loop → provider request — is exercised at once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SUPARCLAW_HOME = mkdtempSync(join(tmpdir(), "sc-switch-"));
const { Service, applyModelTap, modelCard, pinnedCard, execModeOf, emptyConfig } = await import("../dist/lib.js");

function config(svc) {
  const cfg = svc.configSvc.current;
  cfg.providers = {
    kilo: { baseUrl: "https://kilo.test", apiKey: "k", models: ["anthropic/claude-sonnet-4.5", "nvidia/nemotron-3.5-super-vl:free"] },
    google: { baseUrl: "https://google.test", apiKey: "k", models: ["gemini-3.5-flash-lite"] },
  };
  cfg.models = {
    "kilo-free": { ref: "kilo/nvidia/nemotron-3.5-super-vl:free", label: "Nemotron", enabled: true },
    "kilo-sonnet": { ref: "kilo/anthropic/claude-sonnet-4.5", label: "Claude Sonnet", enabled: true },
    "gem-flash": { ref: "google/gemini-3.5-flash-lite", label: "Gemini Flash Lite", enabled: true },
  };
  cfg.agents.defaults.model = "gem-flash";
  return cfg;
}

/** Records every model the run asked for, in order. */
function recorder(svc) {
  const calls = [];
  svc.loop.llm = {
    async *stream(req) {
      calls.push(req.model);
      yield { type: "text", text: "pong" };
      yield { type: "usage", usage: { prompt_tokens: 12, completion_tokens: 3 } };
      yield { type: "done", finishReason: "stop" };
    },
    setConfig() {},
  };
  return calls;
}

test("a tap on the model card changes the model the NEXT answer uses", async (t) => {
  const svc = new Service();
  t.after(() => svc.stop());
  const cfg = config(svc);
  const calls = recorder(svc);
  const key = "telegram:77";
  svc.store.ensureSession(key);

  const card = modelCard({ config: cfg, pin: "", provider: "kilo", page: 0 });
  const row = card.keyboard.flat().find((b) => b.text.includes("Claude Sonnet"));
  assert.ok(row, "the model is on the card");

  let delivered = "";
  const effect = applyModelTap(
    { config: cfg, pin: "", setPin: (m) => svc.store.setSessionModel(key, m), makeDefault: () => ({ ok: true }) },
    row.callback_data,
  );
  assert.equal(effect.kind, "card");

  await svc.send({ sessionKey: key, text: "ping", source: "telegram", reply: async (text) => { delivered = text; } });

  assert.equal(calls[0], "kilo/anthropic/claude-sonnet-4.5", `the answer used the pinned ref (saw ${JSON.stringify(calls)})`);
  assert.notEqual(calls[0], "google/gemini-3.5-flash-lite", "and not the configured default");
  assert.match(delivered, /^pong/, "the answer is delivered (usage footer appended per the chat's mode)");
});

test("the pinned card prints the wire ref the footer will show", () => {
  const cfg = config(new Service());
  const card = pinnedCard({ config: cfg, pin: "kilo-sonnet" });
  assert.match(card.text, /Model: Claude Sonnet — this chat/);
  assert.match(card.text, /ref: kilo\/anthropic\/claude-sonnet-4\.5/, "the exact ref, not just a label");
});

test("a stale pin answers from the default and says which model answered", async (t) => {
  const svc = new Service();
  t.after(() => svc.stop());
  const cfg = config(svc);
  cfg.agents.defaults.usage = "full";
  const calls = recorder(svc);
  const key = "telegram:78";
  svc.store.ensureSession(key);
  svc.store.setSessionModel(key, "model-that-was-deleted");

  const finals = [];
  await svc.send({
    sessionKey: key,
    text: "ping",
    source: "telegram",
    onFinal: (text) => finals.push(text),
    reply: async () => {},
  });

  assert.equal(calls[0], "google/gemini-3.5-flash-lite", "the default answered");
  assert.match(finals[0] ?? "", /Gemini Flash Lite/, "and the reply names the model that answered, not the dead pin");
  assert.doesNotMatch(finals[0] ?? "", /model-that-was-deleted/);
});

test("a stale pin never pretends: the card says it is no longer configured", () => {
  const cfg = config(new Service());
  const card = pinnedCard({ config: cfg, pin: "removed-model" });
  assert.match(card.text, /no longer configured/);
});

test("legacy configs cannot resurrect an approval prompt", () => {
  // Pre-`mode` configs only carry `approvals: true`, which used to mean "ask".
  assert.equal(execModeOf({ approvals: true }), "full", "computed from the schema default");
  assert.equal(execModeOf({ approvals: true, mode: "" }), "full");
  assert.equal(execModeOf({ approvals: false }), "full");
  assert.equal(execModeOf({ mode: "deny" }), "deny", "an explicit mode is still honoured");
  const fresh = emptyConfig();
  assert.equal(execModeOf(fresh.tools.exec), "full", "a fresh install asks for nothing");
});

test("the daemon can say which build it is, and the stamp is stable", async (t) => {
  // Task 56: two identical builds must read identically, or the stamp is noise.
  // The real assertion is the shape — `version+7 hex`, sourced from src/ only.
  const a = new Service();
  const b = new Service();
  t.after(() => {
    a.stop();
    b.stop();
  });
  const stamp = a.health().build;
  assert.match(stamp, /^\d+\.\d+\.\d+\+[0-9a-f]{7}$/, `got "${stamp}"`);
  assert.equal(b.health().build, stamp, "same source, same stamp");
});
