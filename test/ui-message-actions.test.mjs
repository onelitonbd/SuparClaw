// Task 24 (UI half) — OpenClaw's message actions, as icons.
//
// OpenClaw's chat puts a quiet, icon-only action row on every saved prompt and
// every answer: Copy hands back the original Markdown, the latest answer can be
// regenerated, and a prompt can be rewound into the composer for editing. The
// words live in a tooltip and in the accessible name — never in the button.
//
// These cases render the real Chat into linkedom and read the DOM back.

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
  const calls = { regenerate: 0, rewind: [], fork: [], send: 0 };
  const chat = new Chat(host, {
    send: () => { calls.send += 1; },
    abort: () => {},
    approve: () => {},
    cancelQueued: () => {},
    questionAnswer: () => {},
    regenerate: () => { calls.regenerate += 1; },
    rewind: (id) => { calls.rewind.push(id); },
    fork: (id) => { calls.fork.push(id); },
  });
  return { chat, host: root.document, calls };
}

function clipboardSpy() {
  let copied = null;
  // Node exposes `navigator` as a getter-only global — define over it.
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: async (t) => { copied = t; } } },
    configurable: true,
  });
  return () => copied;
}

const FOOTER = "↳ 8.8k in · 33 out · kilo/nvidia/nemotron-3.5-super-vl:free · 8.8k total";
const text = (n) => (n?.textContent ?? "").replace(/\s+/g, " ").trim();
const click = (node, host) => node.dispatchEvent(new host.defaultView.Event("click", { bubbles: true }));

test("an answer's actions are icons, not words — the label lives in the tooltip and aria", () => {
  const { chat } = mount();
  chat.replaceThread([
    { role: "user", content: "make math questions" },
    { role: "assistant", content: "Two questions for Toha and Adib.", footer: FOOTER },
  ]);
  const usage = chat.stack.querySelector(".msg__usage");
  assert.ok(usage, "the footer element is rendered from history");
  assert.equal(text(usage), FOOTER, "the exact line the live reply showed");

  const buttons = chat.stack.querySelectorAll(".msg__actions .msg__act");
  assert.ok(buttons.length >= 1, "the answer has actions");
  for (const b of buttons) {
    assert.equal(text(b), "", `no word inside the button (got "${text(b)}")`);
    assert.equal(b.querySelectorAll("svg").length, 1, "exactly one glyph");
    assert.equal(b.querySelectorAll("svg path, svg rect").length > 0, true, "the glyph has geometry");
    assert.equal(b.querySelector("svg").getAttribute("aria-hidden"), "true", "decorative for AT");
    assert.ok((b.getAttribute("aria-label") ?? "").length > 0, "an accessible name exists");
    assert.equal(b.getAttribute("data-tip"), b.getAttribute("aria-label"), "tooltip = accessible name");
  }
  const copy = chat.stack.querySelector(".msg__actions [data-copy]");
  assert.equal(copy.getAttribute("aria-label"), "Copy");
  const regen = chat.stack.querySelector(".msg__actions [data-regen]");
  assert.equal(regen.getAttribute("aria-label"), "Regenerate");
  assert.equal(regen.querySelectorAll("svg").length, 1);
});

test("Regenerate is offered on the newest answer only; older answers keep Copy", () => {
  const { chat } = mount();
  chat.replaceThread([
    { role: "user", content: "first" },
    { role: "assistant", content: "first answer", footer: FOOTER },
    { role: "user", content: "second" },
    { role: "assistant", content: "second answer", footer: FOOTER },
  ]);
  const rows = chat.stack.querySelectorAll(".msg--assistant .msg__actions");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].querySelector("[data-regen]"), null, "a mid-thread regenerate would delete later turns");
  assert.ok(rows[0].querySelector("[data-copy]"), "Copy still works on older answers");
  assert.ok(rows[1].querySelector("[data-regen]"), "the newest answer can be regenerated");
});

test("a saved prompt gets its own actions: Copy, Edit and Fork", () => {
  const { chat } = mount();
  chat.replaceThread([
    { role: "user", content: "make math questions", id: 11 },
    { role: "assistant", content: "Two questions.", footer: FOOTER, id: 12 },
  ]);
  const userRow = chat.stack.querySelector(".msg--user .msg__actions");
  assert.ok(userRow, "OpenClaw puts actions on prompts too");
  assert.equal(userRow.querySelectorAll(".msg__act").length, 3);
  assert.ok(userRow.querySelector("[data-copy]"), "Copy");
  const edit = userRow.querySelector("[data-rewind]");
  assert.ok(edit, "Edit");
  assert.equal(edit.getAttribute("aria-label"), "Edit prompt");
  const fork = userRow.querySelector("[data-fork]");
  assert.ok(fork, "Fork");
  assert.equal(fork.getAttribute("aria-label"), "Fork from here");
  assert.equal(fork.getAttribute("data-tip"), "Fork from here", "the tooltip carries the words");
  for (const btn of [edit, fork]) {
    assert.equal(text(btn), "", "icon only");
    assert.equal(btn.querySelectorAll("svg").length, 1);
  }
  assert.notEqual(edit.innerHTML, fork.innerHTML, "Edit and Fork are different glyphs");
});

test("Edit hands the message id to the handler (a rewind, not a re-send)", () => {
  const { chat, host, calls } = mount();
  chat.replaceThread([
    { role: "user", content: "first", id: 21 },
    { role: "assistant", content: "one", footer: FOOTER, id: 22 },
    { role: "user", content: "second", id: 23 },
    { role: "assistant", content: "two", footer: FOOTER, id: 24 },
  ]);
  const edits = chat.stack.querySelectorAll("[data-rewind]");
  assert.equal(edits.length, 2, "every persisted prompt can be edited, not just the newest");
  click(edits[1], host);
  assert.deepEqual(calls.rewind, [23], "the clicked row's id");
  assert.equal(calls.send, 0, "editing is not a send");

  click(chat.stack.querySelectorAll("[data-fork]")[0], host);
  assert.deepEqual(calls.fork, [21], "fork also names the row it starts from");
  assert.equal(calls.send, 0, "forking is not a send");
});

test("a live prompt has no Edit yet — only persisted messages carry one", () => {
  const { chat } = mount();
  chat.user("typed just now");
  const row = chat.stack.querySelector(".msg--user .msg__actions");
  assert.ok(row, "you can copy what you just sent");
  assert.ok(row.querySelector("[data-copy]"));
  assert.equal(row.querySelector("[data-rewind]"), null, "no id yet, so nothing to rewind to");
  assert.equal(row.querySelector("[data-fork]"), null, "nor to fork from");
});

test("Copy hands back the original Markdown, not the rendered text", async () => {
  const { chat, host } = mount();
  const copied = clipboardSpy();
  chat.replaceThread([
    { role: "user", content: "q" },
    { role: "assistant", content: "**bold** and `code`", footer: FOOTER },
  ]);
  click(chat.stack.querySelector(".msg--assistant [data-copy]"), host);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(copied(), "**bold** and `code`", "markdown survives the copy");
});

test("Copy on a prompt returns exactly what was typed, newlines intact", async () => {
  const { chat, host } = mount();
  const copied = clipboardSpy();
  chat.replaceThread([
    { role: "user", content: "line one\nline two", id: 31 },
    { role: "assistant", content: "ok", footer: FOOTER, id: 32 },
  ]);
  click(chat.stack.querySelector(".msg--user [data-copy]"), host);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(copied(), "line one\nline two");
});

test("a successful copy flips the glyph to a check, then back", async () => {
  const { chat, host } = mount();
  clipboardSpy();
  chat.replaceThread([
    { role: "user", content: "q" },
    { role: "assistant", content: "a", footer: FOOTER },
  ]);
  const btn = chat.stack.querySelector(".msg--assistant [data-copy]");
  const before = btn.innerHTML;
  click(btn, host);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(btn.dataset.copied, "1", "the control acknowledges the click");
  assert.ok(btn.classList.contains("msg__act--ok"), "styled as done");
  assert.notEqual(btn.innerHTML, before, "the glyph changed");
  assert.equal(btn.getAttribute("aria-label"), "Copied");
});

test("Regenerate dispatches through the handler, not a second chat.send", () => {
  const { chat, host, calls } = mount();
  chat.replaceThread([
    { role: "user", content: "q" },
    { role: "assistant", content: "a", footer: FOOTER },
  ]);
  click(chat.stack.querySelector("[data-regen]"), host);
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
  const acts = chat.stack.querySelector(".msg__actions");
  assert.ok(acts.querySelector("[data-copy]") && acts.querySelector("[data-regen]"));
});

test("an answer with no usage gets actions but no empty usage element", () => {
  const { chat } = mount();
  chat.replaceThread([{ role: "user", content: "q" }, { role: "assistant", content: "a" }]);
  assert.equal(chat.stack.querySelector(".msg__usage"), null, "no invented line");
  assert.ok(chat.stack.querySelector(".msg__actions [data-copy]"), "Copy still works");
});

test("setDraft puts a rewound prompt back in the composer without sending", () => {
  const { chat, calls } = mount();
  chat.setDraft("line one\nline two");
  const input = chat.stack.ownerDocument.getElementById("input");
  assert.equal(input.value, "line one\nline two");
  assert.equal(calls.send, 0);
  assert.equal(input.disabled, false, "ready to edit");
});

test("the stylesheet draws square icon buttons and a token-only tooltip", () => {
  const css = readFileSync(join(ROOT, "ui/styles.css"), "utf8");
  for (const sel of [".msg__usage", ".msg__actions", ".msg__act"]) {
    assert.ok(css.split(sel).length - 1 >= 1, `${sel} is styled`);
  }
  const act = css.slice(css.indexOf(".msg__act {"), css.indexOf(".msg__act {") + 600);
  assert.match(act, /width:\s*28px/, "a square target, not a text pill");
  assert.match(act, /height:\s*28px/);
  assert.match(act, /justify-content:\s*center/);
  assert.match(act, /padding:\s*0/, "no text padding left over");

  const tip = css.slice(css.indexOf("[data-tip]::after"), css.indexOf("[data-tip]::after") + 700);
  assert.match(tip, /content:\s*attr\(data-tip\)/, "the tooltip is the label");
  assert.match(tip, /opacity:\s*0/);
  assert.ok(/\.msg__act\[data-tip\]:hover::after/.test(css), "shows on hover");
  assert.ok(/\.msg__act\[data-tip\]:focus-visible::after/.test(css), "and on keyboard focus");
  assert.ok(!/#[0-9a-f]{3,6}\b/i.test(act), "no new hex colours");
  assert.ok(/var\(--/.test(act), "tokens only");

  // The prompt is a column now, so its actions sit under the bubble.
  const userBlock = css.slice(css.indexOf(".msg--user {"), css.indexOf(".msg--user {") + 300);
  assert.match(userBlock, /flex-direction:\s*column/);
  assert.match(userBlock, /align-items:\s*flex-end/);
});

test("Edit asks first: the app's own dialog, then rewind, reload, and the draft", () => {
  const src = readFileSync(join(ROOT, "ui/src/main.ts"), "utf8");
  assert.match(src, /title: "Edit this prompt\?"/);
  assert.match(src, /confirmLabel: "Edit prompt"/);
  assert.match(src, /gateway\.request\("chat\.rewind"/);
  assert.ok(!src.includes("window.confirm"), "no native dialogs anywhere in the chat shell");
  assert.match(src, /chat\.setDraft\(/, "the text comes back to the composer");
  assert.match(src, /rewind failed: \$\{\(err as Error\)\.message\}/, "refusals stay visible");
});

test("Fork wires to the gateway, switches session, and seeds the composer", () => {
  const src = readFileSync(join(ROOT, "ui/src/main.ts"), "utf8");
  assert.match(src, /gateway\.request\("chat\.fork"/);
  assert.match(src, /switchSession\(res\.sessionKey\)/, "the fork opens");
  assert.match(src, /chat\.setDraft\(/, "with the prompt ready to edit");
  assert.match(src, /fork failed: \$\{\(err as Error\)\.message\}/, "failures stay visible");
  // Non-destructive, so no modal gate — unlike Edit and Regenerate.
  const at = src.indexOf("fork:");
  const block = src.slice(at, at + 900);
  assert.ok(!/modal\(/.test(block), "forking adds a session; it does not need a confirmation");
});
