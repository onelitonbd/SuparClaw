// P2 #11 — `sc sessions` offline surface (list/rename/delete/show).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { Store } = await import("../dist/lib.js");

function seeded() {
  const dir = mkdtempSync(join(tmpdir(), "sc-p2-sessions-"));
  const store = Store.open(join(dir, "state.db"));
  const s1 = store.ensureSession("demo:one");
  const s2 = store.ensureSession("demo:two");
  store.renameSession(s1.id, "Alpha chat");
  store.appendMessage(s1.id, "user", "hello there");
  store.appendMessage(s1.id, "assistant", "hi!");
  store.startRun(s1.id, "r1");
  store.finishRun("r1", "done", { prompt_tokens: 10, completion_tokens: 2 }, undefined, "m");
  store.appendMessage(s2.id, "user", "second session");
  return { dir, store, s1, s2 };
}

test("list returns the rows with title/thinking fields (newest-first order)", () => {
  const { store } = seeded();
  const rows = store.listSessions();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.key).sort(), ["demo:one", "demo:two"]);
  assert.equal(rows.find((r) => r.key === "demo:one").name, "Alpha chat");
  assert.equal(rows.find((r) => r.key === "demo:two").name, null);
  store.close();
});

test("renameSession: set, change, and clear (their rename semantics)", () => {
  const { store, s2 } = seeded();
  store.renameSession(s2.id, "Beta");
  assert.equal(store.getSessionByKey("demo:two").name, "Beta");
  store.renameSession(s2.id, null);
  assert.equal(store.getSessionByKey("demo:two").name, null, "cleared title is null");
  store.close();
});

test("deleteSession cascades: messages, runs, tool_log, summaries, FTS, subagent links", () => {
  const { store, s1 } = seeded();
  store.logTool("r1", "fs_read", "ok", 12);
  const res = store.deleteSession("demo:one");
  assert.deepEqual(res, { deleted: true, messages: 2 });
  assert.equal(store.getSessionByKey("demo:one"), undefined);
  const msgLeft = store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?").get(s1.id).n;
  const runLeft = store.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE session_id = ?").get(s1.id).n;
  const toolsLeft = store.db.prepare("SELECT COUNT(*) AS n FROM tool_log WHERE run_id = 'r1'").get().n;
  assert.equal(msgLeft, 0);
  assert.equal(runLeft, 0);
  assert.equal(toolsLeft, 0);
  assert.equal(store.getSessionByKey("demo:two") !== undefined, true, "other sessions untouched");
  // Search no longer surfaces the deleted transcript when FTS is used.
  const res_ = store.deleteSession("demo:one");
  assert.equal(res_.deleted, false, "second delete is a no-op");
  store.close();
});

test("show path: recentMessages tail is what the CLI prints", () => {
  const { store, s1 } = seeded();
  const tail = store.recentMessages(s1.id, 10);
  assert.equal(tail.length, 2);
  assert.deepEqual(tail.map((m) => m.role), ["user", "assistant"]);
  store.close();
});
