// Task 25 — Fork from here (OpenClaw's `sessions.fork`).
//
// "Fork creates a new session from the active-path prefix before the message,
//  opens it, and seeds its composer with the same text."
//
// So: everything before the clicked prompt is copied into a brand-new session,
// the original is untouched, and the prompt comes back for an edit. The copy is
// faithful — timestamps and usage included — otherwise a forked conversation
// would lose its real clocks and its /usage lines.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SUPARCLAW_HOME = mkdtempSync(join(tmpdir(), "sc-fork-"));
const { Service, historyPayload } = await import("../dist/lib.js");

const USAGE = JSON.stringify({
  usage: { prompt_tokens: 8800, completion_tokens: 33 },
  model: "kilo-free",
  label: "kilo/nvidia/nemotron-3.5-super-vl:free",
});

/** Two turns; each = prompt, answer (with usage), one tool row. */
function seed(svc, key) {
  const session = svc.store.ensureSession(key);
  const add = (role, content, usage) =>
    svc.store.appendMessage(session.id, role, content, "run-1", usage ?? null);
  add("user", "first question");
  add("assistant", "first answer", USAGE);
  add("tool", "→ cron_add · 12ms\ncreated cron job math-for-toha");
  add("user", "second question");
  add("assistant", "second answer", USAGE);
  add("tool", "→ cron_list · 8ms\n2 jobs");
  return session;
}

test("fork copies the prefix before the prompt and returns its text", async () => {
  const svc = new Service();
  const key = "main:fork";
  const parent = seed(svc, key);
  const parentRows = svc.store.recentMessages(parent.id, 50);
  const prompt = parentRows.filter((m) => m.role === "user")[1];

  const result = svc.fork(key, prompt.id);
  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
  assert.equal(result.text, "second question", "the composer gets the clicked prompt");
  assert.equal(result.copied, 3, "the whole first turn came along");
  assert.notEqual(result.sessionKey, key, "a new session, not the original");

  const forked = svc.store.getSessionByKey(result.sessionKey);
  assert.ok(forked, "the fork exists in the store");
  assert.match(forked.name ?? "", /\(fork\)/, "the sidebar can tell it apart");
  assert.equal(forked.archived ?? 0, 0, "a fresh fork is never archived");

  const rows = svc.store.recentMessages(forked.id, 50);
  assert.deepEqual(rows.map((m) => m.role), ["user", "assistant", "tool"], "only the prefix");
  assert.deepEqual(rows.map((m) => m.content), parentRows.slice(0, 3).map((m) => m.content));
  assert.ok(!rows.some((m) => m.content.includes("second")), "nothing at or after the prompt");

  // The original is untouched — same rows, same ids, same count.
  const parentAfter = svc.store.recentMessages(parent.id, 50);
  assert.deepEqual(parentAfter.map((m) => m.id), parentRows.map((m) => m.id), "parent ids unchanged");
  assert.equal(parentAfter.length, parentRows.length, "parent length unchanged");
  await svc.stop();
});

test("the copy is faithful: timestamps and usage survive, so does the footer", async () => {
  const svc = new Service();
  const key = "main:fork-faithful";
  const parent = seed(svc, key);
  const parentRows = svc.store.recentMessages(parent.id, 50);
  const prompt = parentRows.filter((m) => m.role === "user")[1];

  const result = svc.fork(key, prompt.id);
  assert.equal(result.ok, true);
  const forked = svc.store.getSessionByKey(result.sessionKey);
  const rows = svc.store.recentMessages(forked.id, 50);

  const parentAnswer = parentRows[1];
  const forkedAnswer = rows[1];
  assert.equal(forkedAnswer.usage, parentAnswer.usage, "the stored numbers move with the row");
  assert.equal(forkedAnswer.created_at, parentAnswer.created_at, "a fork does not rewrite the clock");
  assert.notEqual(forkedAnswer.id, parentAnswer.id, "new row ids, new transcript");

  // Task 23's rule still holds inside a fork: the footer is rebuilt from the row.
  const payload = historyPayload(rows, {
    mode: "full",
    profile: () => ({ label: "kilo/nvidia/nemotron-3.5-super-vl:free" }),
  });
  assert.match(payload[1].footer ?? "", /^↳ 8\.8k in · 33 out · kilo\/nvidia\//, "the line survives the fork");
  await svc.stop();
});

test("search works inside the fork and does not leak the prompt", async () => {
  const svc = new Service();
  const key = "main:fork-search";
  const parent = seed(svc, key);
  const prompt = svc.store.recentMessages(parent.id, 50).filter((m) => m.role === "user")[1];

  const result = svc.fork(key, prompt.id);
  const forked = svc.store.getSessionByKey(result.sessionKey);
  assert.ok(svc.store.searchMessages(forked.id, "first answer").length > 0, "copied rows are searchable");
  assert.equal(svc.store.searchMessages(forked.id, "second question").length, 0, "the prompt stayed behind");
  await svc.stop();
});

test("forking at the first prompt is an empty session with the text", async () => {
  const svc = new Service();
  const key = "main:fork-first";
  const parent = seed(svc, key);
  const first = svc.store.recentMessages(parent.id, 50)[0];

  const result = svc.fork(key, first.id);
  assert.equal(result.ok, true);
  assert.equal(result.copied, 0, "there is no prefix before the first message");
  assert.equal(result.text, "first question");
  const forked = svc.store.getSessionByKey(result.sessionKey);
  assert.equal(svc.store.recentMessages(forked.id, 50).length, 0, "opens as a fresh conversation");
  await svc.stop();
});

test("two forks get two keys", async () => {
  const svc = new Service();
  const key = "main:fork-twice";
  const parent = seed(svc, key);
  const prompt = svc.store.recentMessages(parent.id, 50).filter((m) => m.role === "user")[1];
  const a = svc.fork(key, prompt.id);
  const b = svc.fork(key, prompt.id);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.notEqual(a.sessionKey, b.sessionKey, "collision-safe keys");
  assert.ok(svc.store.getSessionByKey(a.sessionKey) && svc.store.getSessionByKey(b.sessionKey));
  await svc.stop();
});

test("fork refuses while busy and creates nothing", async () => {
  const svc = new Service();
  const key = "main:fork-busy";
  const parent = seed(svc, key);
  const prompt = svc.store.recentMessages(parent.id, 50).filter((m) => m.role === "user")[1];
  const before = svc.store.countUnarchivedSessions();

  const real = svc.loop.isBusy.bind(svc.loop);
  svc.loop.isBusy = () => true;
  try {
    const result = svc.fork(key, prompt.id);
    assert.equal(result.ok, false);
    assert.match(result.error, /a run is active/);
  } finally {
    svc.loop.isBusy = real;
  }
  assert.equal(svc.store.countUnarchivedSessions(), before, "no ghost session in the sidebar");
  await svc.stop();
});

test("fork refuses a non-user row, a foreign id and an unknown session", async () => {
  const svc = new Service();
  const key = "main:fork-guards";
  const parent = seed(svc, key);
  const rows = svc.store.recentMessages(parent.id, 50);
  const before = svc.store.countUnarchivedSessions();

  const assistant = svc.fork(key, rows.find((m) => m.role === "assistant").id);
  assert.equal(assistant.ok, false);
  assert.match(assistant.error, /must point at a user message/);

  const missing = svc.fork(key, 999_999);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /no such message in this session/);

  const other = svc.store.ensureSession("main:fork-other");
  const foreignId = svc.store.appendMessage(other.id, "user", "someone else's prompt");
  const crossed = svc.fork(key, foreignId);
  assert.equal(crossed.ok, false);
  assert.match(crossed.error, /no such message in this session/);

  const unknown = svc.fork("main:fork-never-existed", rows[0].id);
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /no such session/);

  // Only the explicitly created `other` session was added — no fork rows.
  assert.equal(svc.store.countUnarchivedSessions(), before + 1);
  await svc.stop();
});

test("wiring: the gateway advertises chat.fork and types its refusals", () => {
  const src = readFileSync(new URL("../src/gateway/server.ts", import.meta.url), "utf8");
  assert.match(src, /"chat\.fork",/, "advertised to clients");
  assert.match(src, /case "chat\.fork":/, "and the handler exists");
  assert.match(src, /errFrame\(id, "fork_refused"/, "refusals are typed");
  assert.match(src, /errFrame\(id, "bad_request"/, "a malformed id is a bad request");
});
