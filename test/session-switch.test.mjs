// Task 54b — a chat can look at any of its own sessions.
//
// The switch is a *pointer* in `meta`, not a copy and not a rename: the session
// key is the identity the DB, the web UI and the loop all use, so moving a chat
// to an older conversation must not move its history. That pointer has to
// survive a restart and must never outlive the session it names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { Store, isSessionOfChat, resolveActiveSession } = await import("../dist/lib.js");

const fresh = (name) => join(mkdtempSync(join(tmpdir(), name)), "state.sqlite");

test("the active-session pointer round-trips through a restart", () => {
  const path = fresh("sc-switch-");
  let store = Store.open(path);
  store.setMeta("telegram:active:42", "telegram:42:m3x9");
  store.setMeta("telegram:sess:42", "m3x9");
  store.db.close();

  store = Store.open(path);
  assert.equal(store.getMeta("telegram:active:42"), "telegram:42:m3x9");
  assert.equal(store.getMeta("telegram:sess:42"), "m3x9", "the rotation tag is still there underneath");
  store.db.close();
});

test("a pointer whose session is gone resolves back to the rotation tag", () => {
  const store = Store.open(fresh("sc-switch-gone-"));
  store.setMeta("telegram:active:42", "telegram:42:pruned");
  const active = store.getMeta("telegram:active:42");
  assert.ok(active, "the pointer is written");
  assert.equal(store.getSessionByKey("telegram:42:pruned") ?? null, null, "but its session no longer exists");
  // The resolver the channel uses: exists(key) is getSessionByKey, so a pruned
  // session cannot take the chat's next message with it.
  assert.equal(
    resolveActiveSession(42, { active, tag: "m3x9", exists: (k) => Boolean(store.getSessionByKey(k)) }),
    "telegram:42:m3x9",
  );
  store.db.close();
});

test("switching to an older session keeps that session's own model pin", () => {
  const store = Store.open(fresh("sc-switch-pin-"));
  store.ensureSession("telegram:42:a");
  store.ensureSession("telegram:42:b");
  store.setSessionModel("telegram:42:a", "claude-opus");
  store.setSessionModel("telegram:42:b", "gpt-51");

  // What `/sessions` does on a tap: write the pointer, then read the target.
  store.setMeta("telegram:active:42", "telegram:42:a");
  const entered = store.getSessionByKey(store.getMeta("telegram:active:42") ?? "");
  assert.equal(entered?.model, "claude-opus", "the card must report the model of the session you entered");

  store.setMeta("telegram:active:42", "telegram:42:b");
  assert.equal(store.getSessionByKey(store.getMeta("telegram:active:42") ?? "")?.model, "gpt-51");
  store.db.close();
});

test("/think writes the same column for both surfaces, and default clears it", () => {
  const store = Store.open(fresh("sc-switch-think-"));
  store.ensureSession("telegram:42");
  store.setSessionThinking("telegram:42", "high");
  assert.equal(store.getSessionByKey("telegram:42")?.thinking, "high");
  store.setSessionThinking("telegram:42", null);
  assert.equal(store.getSessionByKey("telegram:42")?.thinking ?? null, null, "null is the inherited default, not 'off'");
  store.db.close();
});

test("a chat's sessions are its own — the list the card draws", () => {
  const store = Store.open(fresh("sc-switch-list-"));
  for (const key of ["telegram:42", "telegram:42:a", "telegram:42:b", "telegram:420", "web:main"]) {
    store.ensureSession(key);
  }
  const all = store.listSessions(50).map((row) => row.key);
  const mine = all.filter((key) => isSessionOfChat(key, 42));
  assert.deepEqual(mine.sort(), ["telegram:42", "telegram:42:a", "telegram:42:b"], "425 and web sessions never appear in this chat's picker");
  store.db.close();
});
