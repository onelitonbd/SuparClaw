// Task 23 (UI half) — a reloaded answer keeps its usage line, and every answer
// offers Copy (original Markdown) with Regenerate on the newest one only.
//
// Before this: nothing rendered `[data-copy]` at all (the listener was dead code
// reading `innerText`, i.e. the *rendered* text), there was no regenerate path,
// and `replaceThread` drew `content` with no notion of the footer the live event
// carried. These cases render the real Chat into linkedom.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";

const ROOT = process.cwd();
const TEST_TMP = (() => {
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

const outDir = mkdtempSync(join(TEST_TMP, "sc-ui-actions-"));
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
  const calls = { regenerate: 0, send: 0 };
  const chat = new Chat(host, {
    send: () => { calls.send += 1; },
    abort: () => {},
    approve: () => {},
    cancelQueued: () => {},
    questionAnswer: () => {},
    regenerate: () => { calls.regenerate += 1; },
  });
  return { chat, host: root.document, calls };
}

const FOOTER = "↳ 8.8k in · 33 out · kilo/nvidia/nemotron-3.5-super-vl:free · 8.8k total";
const text = (n) => (n?.textContent ?? "").replace(/\s+/g, " ").trim();

test("a replayed answer keeps its usage line and offers Copy", () => {
  const { chat } = mount();
  chat.replaceThread([
    { role: "user", content: "make math questions" },
    { role: "assistant", content: "Two questions for Toha and Adib.", footer: FOOTER },
  ]);
  const usage = chat.stack.querySelector(".msg__usage");
  assert.ok(usage, "the footer element is rendered from history");
  assert.equal(text(usage), FOOTER, "the exact line the live reply showed");
  const acts = chat.stack.querySelectorAll(".msg__actions");
  assert.equal(acts.length, 1, "one action row for the one answer");
  assert.ok(chat.stack.querySelector(".msg__actions [data-copy]"), "Copy is offered");
  assert.equal(text(chat.stack.querySelector(".msg__actions [data-copy]")), "Copy");
});

test("Regenerate is offered on the newest answer only; older answers keep Copy", () => {
  const { chat } = mount();
  chat.replaceThread([
    { role: "user", content: "first" },
    { role: "assistant", content: "first answer", footer: FOOTER },
    { role: "user", content: "second" },
    { role: "assistant", content: "second answer", footer: FOOTER },
  ]);
  const rows = chat.stack.querySelectorAll(".msg__actions");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].querySelector("[data-regen]"), null, "a mid-thread regenerate would delete later turns");
  assert.ok(rows[0].querySelector("[data-copy]"), "Copy still works on older answers");
  assert.ok(rows[1].querySelector("[data-regen]"), "the newest answer can be regenerated");
  assert.equal(text(rows[1].querySelector("[data-regen]")), "Regenerate");
});

test("Copy hands back the original Markdown, not the rendered text", async () => {
  const { chat, host } = mount();
  let copied = null;
  // Node exposes `navigator` as a getter-only global — define over it.
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: async (t) => { copied = t; } } },
    configurable: true,
  });
  chat.replaceThread([
    { role: "user", content: "q" },
    { role: "assistant", content: "**bold** and `code`", footer: FOOTER },
  ]);
  const btn = chat.stack.querySelector("[data-copy]");
  btn.dispatchEvent(new host.defaultView.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(copied, "**bold** and `code`", "markdown survives the copy");
});

test("Regenerate dispatches through the handler, not a second chat.send", () => {
  const { chat, host, calls } = mount();
  chat.replaceThread([
    { role: "user", content: "q" },
    { role: "assistant", content: "a", footer: FOOTER },
  ]);
  chat.stack.querySelector("[data-regen]").dispatchEvent(new host.defaultView.Event("click", { bubbles: true }));
  assert.equal(calls.regenerate, 1, "the view asks for a real regenerate");
  assert.equal(calls.send, 0, "it is not re-sent as a new message");
});

test("a live final with a footer renders the line once and the body without it", () => {
  const { chat } = mount();
  chat.assistantStart();
  chat.delta("The answer.");
  chat.finish("The answer.", FOOTER);
  const bodies = chat.stack.querySelectorAll(".msg__body");
  assert.equal(bodies.length, 1);
  assert.ok(!text(bodies[0]).includes("↳"), "the line lives in its own element");
  assert.equal(text(chat.stack.querySelector(".msg__usage")), FOOTER);
  assert.equal(chat.stack.querySelectorAll(".msg__usage").length, 1, "exactly one line");
});

test("an answer with no usage gets actions but no empty usage element", () => {
  const { chat } = mount();
  chat.replaceThread([{ role: "user", content: "q" }, { role: "assistant", content: "a" }]);
  assert.equal(chat.stack.querySelector(".msg__usage"), null, "no invented line");
  assert.ok(chat.stack.querySelector(".msg__actions [data-copy]"), "Copy still works");
});

test("the stylesheet styles both classes with existing tokens only", () => {
  const css = readFileSync(join(ROOT, "ui/styles.css"), "utf8");
  for (const sel of [".msg__usage", ".msg__actions"]) {
    const hits = css.split(sel).length - 1;
    assert.ok(hits >= 1, `${sel} is styled`);
  }
  const usageBlock = css.slice(css.indexOf(".msg__usage"), css.indexOf(".msg__usage") + 400);
  assert.ok(!/#[0-9a-f]{3,6}/i.test(usageBlock), "no new hex colours");
  assert.ok(!/\d+px/.test(usageBlock) || /var\(--/.test(usageBlock), "spacing comes from tokens");
});

test("Regenerate asks first: the app's own dialog, not a silent delete", () => {
  const src = readFileSync(join(ROOT, "ui/src/main.ts"), "utf8");
  assert.match(src, /title: "Regenerate this answer\?"/);
  assert.match(src, /confirmLabel: "Regenerate"/);
  assert.match(src, /danger: true,[\s\S]{0,400}gateway\.request\("chat\.regenerate"/);
  assert.ok(!src.includes("window.confirm"), "no native dialogs anywhere in the chat shell");
  // and the refusal path is not swallowed
  assert.match(src, /regenerate failed: \$\{\(err as Error\)\.message\}/);
});
