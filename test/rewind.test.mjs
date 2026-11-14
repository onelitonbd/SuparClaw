// Task 24 — Edit is OpenClaw's Rewind: the clicked prompt and everything after
// it are removed, and its text goes back to the composer. Server-side because
// only the store can undo a turn, and a refusal must delete nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SUPARCLAW_HOME = mkdtempSync(join(tmpdir(), "sc-rewind-"));
const { Service } = await import("../dist/lib.js");

/** A two-turn session, each turn = prompt + answer + one tool row. */
function seed(svc, key) {
  const session = svc.store.ensureSession(key);
  const add = (role, content) => svc.store.appendMessage(session.id, role, content, "run-1");
  add("user", "first question");
  add("assistant", "first answer");
  add("tool", "→ cron_add · 12ms\ncreated cron job math-for-toha");
  add("user", "second question");
  add("assistant", "second answer");
  add("tool", "→ cron_list · 8ms\n2 jobs");
  return session;
}

test("rewind drops the prompt and its turn, and returns the prompt text", async () => {
  const svc = new Service();
  const key = "main:rewind";
  const session = seed(svc, key);
  const rows = svc.store.recentMessages(session.id, 50);
  const secondPrompt = rows.filter((m) => m.role === "user").at(-1);

  const result = svc.rewind(key, secondPrompt.id);
  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
  assert.equal(result.text, "second question", "the composer gets exactly what was typed");

  const after = svc.store.recentMessages(session.id, 50);
  assert.deepEqual(after.map((m) => m.role), ["user", "assistant", "tool"], "only the first turn survives");
  assert.ok(!after.some((m) => m.content.includes("second")), "no orphan answer, no orphan tool row");
  assert.equal(svc.store.messageById(session.id, secondPrompt.id), undefined, "the prompt row itself is gone");
  await svc.stop();
});

test("rewind of an older prompt drops everything after it", async () => {
  const svc = new Service();
  const key = "main:rewind-older";
  const session = seed(svc, key);
  const firstPrompt = svc.store.recentMessages(session.id, 50).find((m) => m.role === "user");

  const result = svc.rewind(key, firstPrompt.id);
  assert.equal(result.ok, true);
  assert.equal(result.text, "first question");
  assert.equal(svc.store.recentMessages(session.id, 50).length, 0, "the whole conversation from that point is gone");
  await svc.stop();
});

test("rewind refuses while a run is active and deletes nothing", async () => {
  const svc = new Service();
  const key = "main:rewind-busy";
  const session = seed(svc, key);
  const before = svc.store.recentMessages(session.id, 50).map((m) => m.content);
  const real = svc.loop.isBusy.bind(svc.loop);
  svc.loop.isBusy = () => true;
  try {
    const result = svc.rewind(key, svc.store.recentMessages(session.id, 50)[0].id);
    assert.equal(result.ok, false);
    assert.match(result.error, /a run is active/);
  } finally {
    svc.loop.isBusy = real;
  }
  assert.deepEqual(svc.store.recentMessages(session.id, 50).map((m) => m.content), before, "untouched");
  await svc.stop();
});

test("rewind refuses a non-user row, a foreign id and an unknown session", async () => {
  const svc = new Service();
  const key = "main:rewind-guards";
  const session = seed(svc, key);
  const rows = svc.store.recentMessages(session.id, 50);

  const assistant = svc.rewind(key, rows.find((m) => m.role === "assistant").id);
  assert.equal(assistant.ok, false);
  assert.match(assistant.error, /must point at a user message/);

  const missing = svc.rewind(key, 999_999);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /no such message in this session/);

  // A row that belongs to a different session must not be reachable.
  const other = svc.store.ensureSession("main:other");
  const foreignId = svc.store.appendMessage(other.id, "user", "someone else's prompt");
  const crossed = svc.rewind(key, foreignId);
  assert.equal(crossed.ok, false);
  assert.match(crossed.error, /no such message in this session/);

  const unknown = svc.rewind("main:never-existed", rows[0].id);
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /no such session/);
  assert.equal(svc.store.getSessionByKey("main:never-existed"), undefined, "a read path must not create it");

  // Every refusal above left the seeded session intact.
  assert.equal(svc.store.recentMessages(session.id, 50).length, rows.length);
  await svc.stop();
});

test("rewind keeps the session clock honest and drops the FTS rows", async () => {
  const svc = new Service();
  const key = "main:rewind-fts";
  const session = seed(svc, key);
  const hitBefore = svc.store.searchMessages(session.id, "second question");
  assert.ok(hitBefore.length > 0, "the prompt was searchable before the rewind");

  const prompt = svc.store.recentMessages(session.id, 50).filter((m) => m.role === "user").at(-1);
  svc.rewind(key, prompt.id);

  assert.equal(svc.store.searchMessages(session.id, "second question").length, 0, "no ghost in search");
  const fresh = svc.store.getSessionByKey(key);
  const last = svc.store.recentMessages(session.id, 1).at(-1);
  assert.equal(fresh.last_msg_at, last.created_at, "recency follows what is still there");
  await svc.stop();
});

test("wiring: the gateway advertises chat.rewind and types its refusals", () => {
  const src = readFileSync(new URL("../src/gateway/server.ts", import.meta.url), "utf8");
  assert.match(src, /"chat\.rewind",/, "advertised to clients");
  assert.match(src, /case "chat\.rewind":/, "and the handler exists");
  assert.match(src, /errFrame\(id, "rewind_refused"/, "refusals are typed");
  assert.match(src, /errFrame\(id, "bad_request"/, "a malformed id is a bad request");
});
