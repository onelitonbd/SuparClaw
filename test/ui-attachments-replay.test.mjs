// Task 30 — the bug the user hit: after a reload, an attachment became XML.
//
// The gateway stores a message's files as `<media:…>` tags (that is what the
// model reads). The Chat rendered the stored text verbatim, so a reload turned
//
//   [ 📎 report.pdf ]
//
// into `<media:attachment path="media/…" name="report.pdf" …>` inside the
// user's own bubble. These cases render the real Chat in linkedom and read the
// DOM back: a chip, no XML, and clicking it asks to open the file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";

const ROOT = process.cwd();
const TMP = (() => {
  for (const base of [process.env.SUPARCLAW_TEST_TMP, tmpdir(), "/tmp"].filter(Boolean)) {
    try { mkdirSync(base, { recursive: true }); return base; } catch { /* next */ }
  }
  return ROOT;
})();

const dom = parseHTML("<!doctype html><html><body></body></html>");
globalThis.document = dom.document;
globalThis.window = dom.window;
globalThis.HTMLElement = dom.HTMLElement;
globalThis.Event = dom.window.Event;
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);

const outDir = mkdtempSync(join(TMP, "sc-ui-attach-replay-"));
await (await import("esbuild")).build({
  entryPoints: [join(ROOT, "ui/src/chat.ts")],
  bundle: true, format: "esm", outdir: outDir, outExtension: { ".js": ".mjs" }, platform: "neutral",
});
const { Chat } = await import(pathToFileURL(join(outDir, "chat.mjs")).href);

const SHELL = `
<div id="root">
  <div class="scroll" id="thread"><div class="stack" id="stack"></div></div>
  <div class="composer" id="composer">
    <textarea id="input" rows="1"></textarea>
    <button id="send-btn" type="button"></button>
    <button id="stop-btn" type="button" hidden></button>
    <div id="attach-strip"></div>
    <button id="attach-btn" type="button"></button>
    <input id="attach-input" type="file">
  </div>
  <div id="approval"></div>
  <div id="qrow"></div>
  <button id="jump"></button>
  <span id="tok"></span>
</div>`;

function mount() {
  const root = parseHTML(`<html><body>${SHELL}</body></html>`);
  const host = root.document.getElementById("root");
  const opened = [];
  const chat = new Chat(host, {
    send() {},
    abort() {},
    approve() {},
    cancelQueued() {},
    questionAnswer() {},
    regenerate() {},
    rewind() {},
    fork() {},
    openMedia: (path, name) => opened.push({ path, name }),
  });
  return { chat, doc: root.document, opened };
}

const text = (n) => (n?.textContent ?? "").replace(/\s+/g, " ").trim();

const STORED = [
  { role: "user", id: 1, ts: 1_700_000_000_000, content: 'what is this?\n<media:attachment path="media/20261026120000-ab12-1-report.pdf" name="report.pdf" mime="application/pdf" size="524288">' },
  { role: "assistant", id: 2, ts: 1_700_000_001_000, content: "It is a quarterly report." },
];

test("a replayed message shows a file chip, never the raw tag", () => {
  const { chat, doc } = mount();
  chat.replaceThread(STORED);
  const bubble = doc.querySelector("#stack .msg--user .bubble");
  assert.equal(text(bubble), "what is this?", "the prose is exactly what was typed");
  assert.ok(!/media:/.test(text(doc.querySelector(".msg--user"))), "no XML anywhere in the message");

  const chip = doc.querySelector("#stack .msg--user .msg__att-file");
  assert.ok(chip, "the file still shows");
  assert.equal(chip.getAttribute("data-path"), "media/20261026120000-ab12-1-report.pdf");
  assert.equal(text(chip), "📎 report.pdf · 512 KB");
  assert.equal(chip.tagName, "BUTTON", "it is clickable");
  assert.match(chip.getAttribute("aria-label") ?? "", /Open attachment report\.pdf/);
});

test("clicking the chip asks to open that exact file", () => {
  const { chat, doc, opened } = mount();
  chat.replaceThread(STORED);
  doc.querySelector("#stack .msg--user .msg__att-file").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  assert.deepEqual(opened, [{ path: "media/20261026120000-ab12-1-report.pdf", name: "report.pdf" }]);
});

test("a file-only message is a chip with no empty bubble", () => {
  const { chat, doc } = mount();
  chat.replaceThread([
    { role: "user", id: 3, ts: 1_700_000_000_000, content: '<media:photo path="media/telegram/42/abc-0-photo.jpg" name="photo.jpg" mime="image/jpeg">' },
    { role: "assistant", id: 4, ts: 1_700_000_001_000, content: "Nice photo." },
  ]);
  const msg = doc.querySelector("#stack .msg--user");
  assert.equal(doc.querySelector("#stack .msg--user .bubble"), null, "no empty bubble is drawn");
  assert.equal(text(msg.querySelector(".msg__att-file")), "📎 photo.jpg");
});

test("an omitted file says so instead of pretending to be there", () => {
  const { chat, doc } = mount();
  chat.replaceThread([
    { role: "user", id: 5, ts: 1_700_000_000_000, content: 'see attached\n<media:document omitted="larger than 20 MB">' },
  ]);
  const note = doc.querySelector("#stack .msg--user .msg__att-file");
  assert.match(text(note), /larger than 20 MB/);
  assert.equal(note.tagName, "SPAN", "nothing to open");
  assert.match(note.className, /msg__att-file--gone/);
});

test("copying a message gives back the prose, not the tags", () => {
  const { chat, doc } = mount();
  chat.replaceThread(STORED);
  const bubble = doc.querySelector("#stack .msg--user .bubble");
  assert.equal(bubble.dataset.md, "what is this?", "Copy uses the stored md, which has no tag");
});

test("the live path still renders staged images as thumbnails", () => {
  const { chat, doc } = mount();
  chat.user("look", [
    { name: "shot.png", mime: "image/png", size: 12, dataUrl: "data:image/png;base64,AAA" },
    { name: "notes.txt", mime: "text/plain", size: 4, dataUrl: "data:text/plain;base64,QQ==" },
  ]);
  assert.ok(doc.querySelector("#stack .msg--user .msg__att-img"), "image preview kept");
  assert.equal(text(doc.querySelector("#stack .msg--user .msg__att-file")), "📎 notes.txt");
});
