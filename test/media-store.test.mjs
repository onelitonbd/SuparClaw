// Task 30 — the attachment tree on disk: size, age, and safe deletion.
//
// Nothing used to look at `<workspace>/media` again after a file was written, so
// it only ever grew. These cases pin what a prune may touch: files inside that
// tree, by age or by reference, never a symlink and never anything outside.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { listMedia, mediaStats, pruneMedia, pruneOrphans, deleteFiles, resolveMediaPath, mediaFileOnDisk } =
  await import("../dist/lib.js");

const DAY = 86_400_000;

function workspace() {
  const ws = mkdtempSync(join(tmpdir(), "sc-media-store-"));
  mkdirSync(join(ws, "media", "telegram", "42"), { recursive: true });
  return ws;
}

/** Write a file and back-date its mtime (so "older than 30 days" is testable). */
function put(ws, rel, bytes, ageDays = 0) {
  const full = join(ws, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, bytes);
  const when = new Date(Date.now() - ageDays * DAY);
  utimesSync(full, when, when);
  return full;
}

test("the tree is walked recursively, oldest first, and symlinks are ignored", () => {
  const ws = workspace();
  put(ws, "media/new.txt", "hi", 1);
  put(ws, "media/telegram/42/old.pdf", "%PDF", 40);
  symlinkSync("/etc/passwd", join(ws, "media", "escape"));

  const files = listMedia(ws);
  assert.deepEqual(files.map((f) => f.path).sort(), ["media/new.txt", "media/telegram/42/old.pdf"]);
  assert.equal(files[0].path, "media/telegram/42/old.pdf", "oldest first");
  assert.equal(files[0].size, 4);
  assert.ok(!files.some((f) => f.path === "media/escape"), "a symlink is not a media file");
});

test("stats say how much space the attachments take", () => {
  const ws = workspace();
  assert.deepEqual(mediaStats(ws), { files: 0, bytes: 0, oldestDays: null, newestDays: null });
  put(ws, "media/a.bin", Buffer.alloc(1024), 10);
  put(ws, "media/b.bin", Buffer.alloc(2048), 2);
  const stats = mediaStats(ws);
  assert.equal(stats.files, 2);
  assert.equal(stats.bytes, 3072);
  assert.equal(stats.oldestDays, 10);
  assert.equal(stats.newestDays, 2);
});

test("prune by age: dry run reports, then the real run removes exactly those", () => {
  const ws = workspace();
  put(ws, "media/keep.txt", "keep", 2);
  put(ws, "media/telegram/42/old.ogg", "x".repeat(10), 45);
  put(ws, "media/older.pdf", "y".repeat(20), 90);

  const dry = pruneMedia(ws, { maxAgeDays: 30, dryRun: true });
  assert.equal(dry.removed.length, 2);
  assert.equal(dry.freedBytes, 30);
  assert.ok(existsSync(join(ws, "media/older.pdf")), "a dry run touches nothing");

  const real = pruneMedia(ws, { maxAgeDays: 30 });
  assert.equal(real.removed.length, 2);
  assert.ok(!existsSync(join(ws, "media/older.pdf")));
  assert.ok(existsSync(join(ws, "media/keep.txt")), "a recent file stays");

  const none = pruneMedia(ws, { maxAgeDays: 0 });
  assert.equal(none.removed.length, 0, "0 means keep forever");
  assert.equal(none.kept, 1);
});

test("prune never leaves the media tree and never follows a symlink", () => {
  const ws = workspace();
  const outside = join(ws, "outside.txt");
  writeFileSync(outside, "do not delete me");
  const old = new Date(Date.now() - 400 * DAY);
  utimesSync(outside, old, old);
  symlinkSync(outside, join(ws, "media", "link.txt"));

  const res = pruneMedia(ws, { maxAgeDays: 30 });
  assert.equal(res.removed.length, 0, "the link is skipped, not followed");
  assert.ok(existsSync(outside), "the target survives");

  // A path that resolves elsewhere is refused by the resolver itself.
  assert.equal(resolveMediaPath(ws, "media/../outside.txt"), null);
  assert.equal(resolveMediaPath(ws, "outside.txt"), null);
  assert.equal(resolveMediaPath(ws, "media/a/../../x"), null);
  assert.equal(resolveMediaPath(ws, "media/a/b.txt"), join(ws, "media", "a", "b.txt"));
});

test("orphans: a file no message references is removable, a referenced one is not", () => {
  const ws = workspace();
  put(ws, "media/used.pdf", "used");
  put(ws, "media/forgotten.pdf", "forgotten");

  const res = pruneOrphans(ws, { isReferenced: (p) => p === "media/used.pdf" });
  assert.deepEqual(res.removed.map((f) => f.path), ["media/forgotten.pdf"]);
  assert.ok(existsSync(join(ws, "media/used.pdf")));
});

test("deleteFiles removes only what it is given, and reports a missing file honestly", () => {
  const ws = workspace();
  put(ws, "media/a.txt", "a");
  put(ws, "media/b.txt", "b");
  const res = deleteFiles(ws, ["media/a.txt", "media/gone.txt", "media/../escape.txt"]);
  assert.equal(res.removed.length, 1);
  assert.equal(res.missing, 1);
  assert.equal(res.kept, 1, "the traversal attempt is refused");
  assert.ok(existsSync(join(ws, "media/b.txt")));
});

test("mediaFileOnDisk refuses a symlink that points out of the tree", () => {
  const ws = workspace();
  put(ws, "media/real.txt", "real");
  writeFileSync(join(ws, "secret.txt"), "secret");
  symlinkSync(join(ws, "secret.txt"), join(ws, "media", "sneaky.txt"));

  assert.equal(mediaFileOnDisk(ws, "media/real.txt"), join(ws, "media", "real.txt"));
  assert.equal(mediaFileOnDisk(ws, "media/sneaky.txt"), null, "follows no link out of the root");
  assert.equal(mediaFileOnDisk(ws, "media/nope.txt"), null);
});
