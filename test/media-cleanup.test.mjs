// Task 30 — "delete the chat" now means "delete its uploads".
//
// The dangerous half is the exception: a fork copies message rows verbatim, so
// two sessions reference the same file. Deleting one must not pull the file out
// from under the other. These cases use a real Service + Store and real bytes on
// disk, because the reference check is SQL and the deletion is a filesystem call.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SUPARCLAW_HOME = mkdtempSync(join(tmpdir(), "sc-media-cleanup-"));
const { Service, deleteSessionWithMedia, pathsInSession, workspaceDir } = await import("../dist/lib.js");

const tag = (path, name) => `<media:attachment path="${path}" name="${name}" mime="application/pdf">`;

/** Save a real file through the same path the gateway uses. */
async function attach(svc, name, body) {
  const { saved } = await svc.saveWebAttachments([{ name, mime: "application/pdf", buf: Buffer.from(body) }]);
  return saved[0];
}

const disk = (rel) => join(workspaceDir(), rel);

test("deleting a chat deletes the files only it referenced", async () => {
  const svc = new Service();
  const a = svc.store.ensureSession("main:with-files");
  const b = svc.store.ensureSession("main:other");

  const one = await attach(svc, "invoice.pdf", "%PDF-1 invoice");
  const two = await attach(svc, "notes.pdf", "%PDF-1 notes");
  svc.store.appendMessage(a.id, "user", `summarize this\n${tag(one.path, "invoice.pdf")}`);
  svc.store.appendMessage(a.id, "assistant", "It is an invoice.");
  svc.store.appendMessage(a.id, "user", `and this\n${tag(two.path, "notes.pdf")}`);
  svc.store.appendMessage(a.id, "assistant", "Notes.");
  svc.store.appendMessage(b.id, "user", "unrelated chat");

  assert.deepEqual(pathsInSession(svc.store, a.id).sort(), [one.path, two.path].sort());
  assert.equal(pathsInSession(svc.store, b.id).length, 0);

  const res = deleteSessionWithMedia(svc.store, workspaceDir(), "main:with-files");
  assert.equal(res.deleted, true);
  assert.equal(res.messages, 4);
  assert.equal(res.files, 2, "both attachments went with the chat");
  assert.equal(res.shared, 0);
  assert.ok(res.freedBytes > 0);
  assert.ok(!existsSync(disk(one.path)), "file one is gone");
  assert.ok(!existsSync(disk(two.path)), "file two is gone");
  assert.equal(svc.store.getSessionByKey("main:with-files"), undefined, "and the rows are gone");
  await svc.stop();
});

test("a fork keeps the files alive — deleting the original leaves them for the fork", async () => {
  const svc = new Service();
  // Exactly what chat.fork does: the same stored text, tags and all.
  const original = svc.store.ensureSession("main:original");
  const file = await attach(svc, "plan.pdf", "%PDF-1 plan");
  const stored = `read this\n${tag(file.path, "plan.pdf")}`;
  svc.store.appendMessage(original.id, "user", stored);
  svc.store.appendMessage(original.id, "assistant", "Read it.");

  const forked = svc.store.ensureSession("main:fork");
  svc.store.appendMessage(forked.id, "user", stored);
  svc.store.appendMessage(forked.id, "assistant", "Read it.");

  const res = deleteSessionWithMedia(svc.store, workspaceDir(), "main:original");
  assert.equal(res.files, 0, "nothing deleted while a fork still points at it");
  assert.equal(res.shared, 1);
  assert.ok(existsSync(disk(file.path)), "the fork can still open its file");

  const second = deleteSessionWithMedia(svc.store, workspaceDir(), "main:fork");
  assert.equal(second.files, 1, "the last reference goes");
  assert.ok(!existsSync(disk(file.path)));
  await svc.stop();
});

test("an unknown session deletes nothing and says so", async () => {
  const svc = new Service();
  const res = deleteSessionWithMedia(svc.store, workspaceDir(), "main:never-existed");
  assert.deepEqual(res, { deleted: false, messages: 0, files: 0, freedBytes: 0, shared: 0 });
  await svc.stop();
});

test("a message that merely MENTIONS a path does not keep a file alive", async () => {
  // The reference check is a LIKE over exact tagged paths, so prose that happens
  // to contain `media/…` text is not enough to block a deletion — but the path
  // we ask about is the exact one, so a lookalike never matches.
  const svc = new Service();
  const s = svc.store.ensureSession("main:lookalike");
  const real = await attach(svc, "a_b.pdf", "%PDF-1");
  svc.store.appendMessage(s.id, "user", tag(real.path, "a_b.pdf"));
  const other = svc.store.ensureSession("main:talk");
  // A different file whose name differs only by the wildcard character.
  const lookalike = real.path.replace("a_b", "axb");
  svc.store.appendMessage(other.id, "user", `nothing to see ${lookalike}`);

  const res = deleteSessionWithMedia(svc.store, workspaceDir(), "main:lookalike");
  assert.equal(res.files, 1, "the lookalike text did not protect the real file");
  await svc.stop();
});
