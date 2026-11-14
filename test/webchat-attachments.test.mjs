// P3 (row Missing!#28) — WebChat attachments: upload files into chat.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SUPARCLAW_HOME = mkdtempSync(join(tmpdir(), "sc-webattach-"));
const { parseWebAttachments, sanitizeAttachName, isImageMime, WEB_ATTACH_LIMITS, Service } = await import("../dist/lib.js");

const tinyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString("base64");

test("parseWebAttachments — decodes base64 + data URIs, defaults mime, sanitizes names", () => {
  const { ok, rejected } = parseWebAttachments([
    { name: "../evil/path/photo.png", mime: "image/png", data: `data:image/png;base64,${tinyPng}` },
    { name: "notes.txt", mime: "text/plain", data: Buffer.from("hello world").toString("base64") },
    { name: "no-mime.bin", data: tinyPng },
  ]);
  assert.deepEqual(rejected, []);
  assert.equal(ok.length, 3);
  assert.equal(ok[0].name, "photo.png"); // directory segments stripped
  assert.equal(ok[0].buf.length, 12);
  assert.equal(ok[1].buf.toString(), "hello world");
  assert.equal(ok[2].mime, "application/octet-stream");

  // non-array + bad base64 rejected with reasons, never thrown
  assert.equal(parseWebAttachments("nope").rejected[0].reason, "attachments must be an array");
  const bad = parseWebAttachments([{ name: "x.png", mime: "image/png", data: "%%%not-base64%%%" }]);
  assert.equal(bad.ok.length, 0);
  assert.match(bad.rejected[0].reason, /unreadable/);
});

test("parseWebAttachments — caps: file count, per-file size, total size (mirrors UI composer caps)", () => {
  // count
  const many = parseWebAttachments(
    Array.from({ length: WEB_ATTACH_LIMITS.maxFiles + 1 }, (_, i) => ({ name: `f${i}.bin`, mime: "application/octet-stream", data: tinyPng })),
  );
  assert.equal(many.ok.length, WEB_ATTACH_LIMITS.maxFiles);
  assert.match(many.rejected[0].reason, /too many files/);

  // per-file
  const big = Buffer.alloc(WEB_ATTACH_LIMITS.maxFileBytes + 1, 1).toString("base64");
  const tooBig = parseWebAttachments([{ name: "big.bin", mime: "application/octet-stream", data: big }]);
  assert.equal(tooBig.ok.length, 0);
  assert.match(tooBig.rejected[0].reason, /larger than \d+ MB/);

  // total: two files each under the per-file cap but over the total cap
  const half = Math.floor(WEB_ATTACH_LIMITS.maxTotalBytes / 2) + 1048576;
  const chunk = Buffer.alloc(half, 2).toString("base64");
  const overTotal = parseWebAttachments([
    { name: "a.bin", mime: "application/octet-stream", data: chunk },
    { name: "b.bin", mime: "application/octet-stream", data: chunk },
  ]);
  assert.equal(overTotal.ok.length, 1);
  assert.match(overTotal.rejected[0].reason, /total/);
});

test("saveWebAttachments — persists under workspace/media, data URIs only for vision-safe images", async () => {
  process.env.SUPARCLAW_HOME = mkdtempSync(join(tmpdir(), "sc-webattach2-"));
  const service = new Service();
  const { saved } = await service.saveWebAttachments([
    { name: "shot.PNG", mime: "image/png", buf: Buffer.from(tinyPng, "base64") },
    { name: "report.pdf", mime: "application/pdf", buf: Buffer.from("%PDF-1.7 fake") },
  ]);
  assert.equal(saved.length, 2);
  for (const item of saved) {
    assert.ok(item.path.startsWith("media/"), `path inside workspace media: ${item.path}`);
    assert.ok(!item.path.includes(".."), "no traversal");
    assert.ok(existsSync(join(process.env.SUPARCLAW_HOME, ".suparclaw", "workspace", item.path)));
    assert.equal(statSync(join(process.env.SUPARCLAW_HOME, ".suparclaw", "workspace", item.path)).size, item.size);
  }
  assert.match(saved[0].dataUri, /^data:image\/png;base64,/);
  assert.equal(saved[1].dataUri, undefined); // pdf is text-only, fs_read/pdf-tool reads the path
  // same-name saves never clobber (unique stamp-index prefix)
  const again = await service.saveWebAttachments([{ name: "shot.PNG", mime: "image/png", buf: Buffer.from(tinyPng, "base64") }]);
  assert.notEqual(again.saved[0].path, saved[0].path);
  await service.stop();
});

test("gateway wiring — chat.send accepts attachments, bypasses text-required, raises ws payload cap", () => {
  const src = readFileSync(new URL("../src/gateway/server.ts", import.meta.url), "utf8");
  assert.match(src, /parseWebAttachments\(params\["attachments"\]\)/);
  assert.match(src, /service\.saveWebAttachments\(parsed\.ok\)/);
  assert.match(src, /<media:attachment path="/);
  assert.match(src, /if \(!text\.trim\(\) && imageParts\.length === 0\)/);
  assert.match(src, /maxPayload: 25_000_000/);
  assert.match(src, /attachments: imageParts\.length > 0 \? imageParts : undefined/);
  // rejected files surface to the client, never silently dropped (their rule)
  assert.match(src, /sessionKey, warnings \}/);
});

test("ui wiring — composer attach button + drop/paste staging + caps mirror gateway", () => {
  const html = readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
  assert.match(html, /id="attach-btn"/);
  assert.match(html, /id="attach-input" type="file" multiple/);
  assert.match(html, /id="attach-strip"/);

  const chat = readFileSync(new URL("../ui/src/chat.ts", import.meta.url), "utf8");
  assert.match(chat, /ATTACH_MAX_FILES = 4/);
  assert.match(chat, /ATTACH_MAX_TOTAL = 12 \* 1048576/);
  assert.match(chat, /readAsDataURL/);
  assert.match(chat, /addEventListener\("drop"/);
  assert.match(chat, /addEventListener\("paste"/);
  assert.match(chat, /#handlers\.send\(text, ready\)/);
  // rejected chips stay visible until removed (their "failures remain beside the composer")
  assert.match(chat, /attach-chip--err/);

  const main = readFileSync(new URL("../ui/src/main.ts", import.meta.url), "utf8");
  assert.match(main, /payload\["attachments"\]/);
  assert.match(main, /warnings/);
});
