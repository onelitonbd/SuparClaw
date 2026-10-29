// Task 30 — the tag syntax, in one place.
//
// The gateway writes a message's files into the prompt as `<media:…>` tags. The
// model reads that; a human must not. These cases pin the split, and the safety
// rule that matters most: a tag can never point outside `media/`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SUPARCLAW_HOME = mkdtempSync(join(tmpdir(), "sc-mediarefs-"));
const { parseMediaRefs, stripMediaRefs, isSafeMediaPath, fmtBytes } = await import("../dist/lib.js");

test("a web attachment splits into prose + a file ref", () => {
  const stored =
    'what is this?\n<media:attachment path="media/20261026120000-ab12-1-report.pdf" name="report.pdf" mime="application/pdf" size="524288">';
  const { text, refs } = parseMediaRefs(stored);
  assert.equal(text, "what is this?", "the tag is gone from the prose");
  assert.equal(refs.length, 1);
  assert.deepEqual(refs[0], {
    kind: "attachment",
    path: "media/20261026120000-ab12-1-report.pdf",
    name: "report.pdf",
    mime: "application/pdf",
    size: 524288,
  });
  assert.equal(stripMediaRefs(stored), "what is this?");
});

test("a message that was only a file has no prose and keeps its chip", () => {
  const { text, refs } = parseMediaRefs('<media:attachment path="media/a.png" name="a.png" mime="image/png">');
  assert.equal(text, "");
  assert.equal(refs.length, 1, "the file still shows");
});

test("several files in one message, in order, web and Telegram tags alike", () => {
  const stored = [
    "look at these",
    '<media:attachment path="media/x-1-a.png" name="a.png" mime="image/png" size="1024">',
    '<media:photo path="media/telegram/42/abc-0-photo.jpg" name="photo.jpg" mime="image/jpeg">',
    '<media:document path="media/telegram/42/abc-1-invoice.pdf" name="invoice.pdf" mime="application/pdf">',
  ].join("\n");
  const { text, refs } = parseMediaRefs(stored);
  assert.equal(text, "look at these");
  assert.deepEqual(
    refs.map((r) => [r.kind, r.name]),
    [
      ["attachment", "a.png"],
      ["photo", "photo.jpg"],
      ["document", "invoice.pdf"],
    ],
  );
});

test("an omitted file says why instead of pretending it is there", () => {
  const { text, refs } = parseMediaRefs('<media:document omitted="larger than 20 MB">');
  assert.equal(text, "");
  assert.equal(refs.length, 1);
  assert.equal(refs[0].path, "");
  assert.equal(refs[0].omitted, "larger than 20 MB");
});

test("a sticker keeps its emoji and has nothing to open", () => {
  const { refs } = parseMediaRefs("nice\n<media:sticker 🦀>");
  assert.equal(refs.length, 1);
  assert.equal(refs[0].kind, "sticker");
  assert.equal(refs[0].path, "");
  assert.match(refs[0].label ?? "", /🦀/);
});

test("a tag pointing outside the media tree is left as text, never made clickable", () => {
  for (const bad of [
    '<media:attachment path="/etc/passwd" name="passwd">',
    '<media:attachment path="media/../../.ssh/id_rsa" name="id_rsa">',
    '<media:attachment path="config.json5" name="config.json5">',
    '<media:attachment path="media/a\\b.png" name="x">',
  ]) {
    const { text, refs } = parseMediaRefs(bad);
    assert.equal(refs.length, 0, `refused: ${bad}`);
    assert.equal(text, bad, "and the text is untouched (we do not eat what we do not understand)");
  }
  assert.equal(isSafeMediaPath("media/a/b.png"), true);
  assert.equal(isSafeMediaPath("media/./a.png"), false);
  assert.equal(isSafeMediaPath("media//a.png"), false);
});

test("ordinary text is returned byte-for-byte", () => {
  const plain = "just a message\nwith <angle brackets> and media talk";
  const { text, refs } = parseMediaRefs(plain);
  assert.equal(text, plain);
  assert.deepEqual(refs, []);
});

test("sizes read like sizes", () => {
  assert.equal(fmtBytes(900), "900 B");
  assert.equal(fmtBytes(2048), "2 KB");
  assert.equal(fmtBytes(3.4 * 1048576), "3.4 MB");
  assert.equal(fmtBytes(0), "");
});
