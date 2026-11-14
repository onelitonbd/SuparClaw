// Task 23 — Regenerate is a server round-trip: the turn is dropped, then the
// prompt that produced it is re-run. Refusing while a run is active is the
// guard that stops two clients truncating a live turn.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SUPARCLAW_HOME = mkdtempSync(join(tmpdir(), "sc-regen-"));
const { Service } = await import("../dist/lib.js");

const waitFor = async (fn, ms = 3000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

test("regenerate drops the last answer and re-runs the same prompt", async () => {
  const svc = new Service();
  const key = "main:regen";
  const store = svc.store;
  const session = store.ensureSession(key);
  // A finished turn as the transcript really records it.
  store.appendMessage(session.id, "user", "make math questions");
  store.appendMessage(session.id, "assistant", "two questions for Toha and Adib", "run-1", JSON.stringify({
    usage: { prompt_tokens: 8800, completion_tokens: 33 },
    model: "kilo-free",
    label: "kilo/nvidia/nemotron-3.5-super-vl:free",
  }));
  store.appendMessage(session.id, "tool", "→ cron_add · 12ms\ncreated cron job math-for-toha", "run-1");

  const result = svc.regenerate(key);
  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
  assert.equal(result.text, "make math questions");

  // Immediately: the old answer and its tool row are gone, the prompt stays.
  const after = store.recentMessages(session.id, 50);
  assert.equal(after.filter((m) => m.role === "assistant").length, 0, "the old answer is gone");
  assert.equal(after.filter((m) => m.role === "tool").length, 0, "its tool rows went with it");

  // Then the re-run lands as a new turn with the same prompt.
  const started = await waitFor(() => store.recentMessages(session.id, 50).filter((m) => m.role === "user").length >= 2);
  assert.ok(started, "the prompt was re-sent as a new turn");
  const users = store.recentMessages(session.id, 50).filter((m) => m.role === "user");
  assert.equal(users.at(-1).content, "make math questions", "same text, not a paraphrase");
  await waitFor(() => !svc.loop.isBusy(key));
  await svc.stop();
});

test("regenerate refuses while a run is active, and touches nothing", async () => {
  const svc = new Service();
  const key = "main:busy";
  const session = svc.store.ensureSession(key);
  svc.store.appendMessage(session.id, "user", "q");
  svc.store.appendMessage(session.id, "assistant", "a", "run-1");
  const before = svc.store.recentMessages(session.id, 10).map((m) => m.content);

  const real = svc.loop.isBusy.bind(svc.loop);
  svc.loop.isBusy = () => true;
  try {
    const result = svc.regenerate(key);
    assert.equal(result.ok, false);
    assert.match(result.error, /a run is active/);
  } finally {
    svc.loop.isBusy = real;
  }
  assert.deepEqual(svc.store.recentMessages(session.id, 10).map((m) => m.content), before, "nothing was deleted");
  await svc.stop();
});

test("regenerate on a session with no prompt is an error, not a crash", async () => {
  const svc = new Service();
  svc.store.ensureSession("main:empty-regen");
  const result = svc.regenerate("main:empty-regen");
  assert.equal(result.ok, false);
  assert.match(result.error, /nothing to regenerate/);

  const missing = svc.regenerate("main:does-not-exist");
  assert.equal(missing.ok, false);
  assert.match(missing.error, /no such session/, "a read path must never create the session");
  await svc.stop();
});
