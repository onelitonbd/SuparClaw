import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";

// Regression net for the "<svg …>"-as-visible-text bug: icon markup must
// become DOM nodes, while el() must keep treating every string child as TEXT
// (that is what keeps message content from ever becoming HTML). linkedom gives
// real append(string) → text-node semantics without a browser.

const ROOT = process.cwd();

const TEST_TMP = (() => {
  for (const base of [process.env.SUPARCLAW_TEST_TMP, tmpdir(), "/tmp"].filter(Boolean)) {
    try { mkdirSync(base, { recursive: true }); return base; } catch { /* next candidate */ }
  }
  return ROOT;
})();

const domGlobals = parseHTML("<html><body></body></html>");
globalThis.document = domGlobals.document;
globalThis.HTMLElement = domGlobals.HTMLElement;

const outDir = mkdtempSync(join(TEST_TMP, "sc-ui-render-"));
const { build } = await import("esbuild");
await build({
  entryPoints: [
    join(ROOT, "ui/src/dom.ts"),
    join(ROOT, "ui/src/markdown.ts"),
    join(ROOT, "ui/src/chat.ts"),
  ],
  bundle: true,
  format: "esm",
  outdir: outDir,
  outExtension: { ".js": ".mjs" },
  platform: "neutral",
});
const { el, icon } = await import(pathToFileURL(join(outDir, "dom.mjs")).href);
const { renderMarkdown } = await import(pathToFileURL(join(outDir, "markdown.mjs")).href);
const { Chat } = await import(pathToFileURL(join(outDir, "chat.mjs")).href);

const SPARKLE =
  '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/></svg>';

test("el() keeps strings as text — message content can never become HTML", () => {
  const node = el("div", { class: "bubble" }, ["<b>hi</b> <script>alert(1)</script>"]);
  assert.equal(node.textContent, "<b>hi</b> <script>alert(1)</script>", "strings render literally");
  assert.equal(node.querySelector("b"), null, "no element was parsed from the string");
  assert.equal(node.querySelector("script"), null, "no script element was parsed");
});

test("icon() parses trusted SVG into DOM — the avatar shows an icon, not markup", () => {
  const avatar = icon(SPARKLE, "msg__avatar");
  assert.ok(avatar.querySelector("svg"), "svg is a real element inside the avatar");
  assert.equal(avatar.querySelector("path")?.getAttribute("d")?.startsWith("M12 3"), true, "path data survives");
  assert.ok(!String(avatar.textContent).includes("<svg"), "no raw markup in the visible text");
  assert.equal(avatar.className, "msg__avatar", "class lands on the wrapper");
});

test("chat.ts inserts every icon constant through icon(), never as an el() string child", () => {
  const src = readFileSync(join(ROOT, "ui/src/chat.ts"), "utf8");
  // the exact bug pattern: an icon constant passed as a child array entry
  for (const name of ["SPARKLE", "SPINNER", "CHECK", "CROSS", "PAUSE", "CHEVRON"]) {
    const leak = new RegExp(`\\[\\s*${name}\\s*\\]`);
    assert.ok(!leak.test(src), `${name} must not be passed as an el() string child`);
    assert.ok(src.includes(`icon(${name}`) || src.includes(`${name};`) || new RegExp(`innerHTML = ${name}`).test(src),
      `${name} is used via icon() or innerHTML`);
  }
});

test("renderMarkdown escapes raw HTML in model output", () => {
  const html = renderMarkdown('hi <img src=x onerror=alert(1)> **bold**');
  assert.ok(html.includes("&lt;img"), "tags are escaped, not parsed");
  assert.ok(!html.includes("<img"), "no live img element in output");
  assert.ok(html.includes("<strong>bold</strong>"), "markdown still renders");
});

test("renderMarkdown terminates on orphan lines (|x|, stray fences) — was an infinite loop", () => {
  const script = join(outDir, "hang-check.mjs");
  writeFileSync(script, `
    import { renderMarkdown } from ${JSON.stringify(pathToFileURL(join(outDir, "markdown.mjs")).href)};
    const nasty = [
      "| x |",
      "text before\\n| orphan |\\ntext after",
      "text\\n\\\`\\\`\\\`js extra\\nnot a fence",
      "hello\\n\\n| a | b |\\n|---|---|",  // valid table still works
    ];
    for (const src of nasty) renderMarkdown(src);
    console.log("terminated");
  `);
  // pre-fix this hung forever; the timeout is the assertion
  const out = execFileSync(process.execPath, [script], { timeout: 5000, encoding: "utf8" });
  assert.match(out, /terminated/, "every nasty input completes");
  assert.ok(renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |").includes("<table>"), "tables still render");
});

test("replaceThread renders history, keeps a live stream, survives a bad row", async () => {
  const dom2 = parseHTML(readFileSync(join(ROOT, "ui/index.html"), "utf8"));
  globalThis.document = dom2.document;
  globalThis.HTMLElement = dom2.HTMLElement;
  globalThis.CSS = { escape: (s) => s };
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  const chat = new Chat(dom2.document.body, {
    send: () => {},
    abort: () => {},
    approve: () => {},
  });

  // plain history reload — user, assistant, tool pills, and error rows all
  // round-trip (tool calls and errors used to vanish on refresh)
  let n = chat.replaceThread([
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1" },
    { role: "tool", content: "→ fs_read · 6ms\n# IDENTITY.md\nfile body here" },
    { role: "error", content: "HTTP 400 from MultiRouter: bad argument" },
  ]);
  assert.equal(n, 4, "every visible row type renders");
  assert.equal(dom2.document.querySelectorAll("#stack .msg--user").length, 1, "user bubble");
  assert.equal(dom2.document.querySelectorAll("#stack .msg--assistant").length, 2, "assistant bubble + Tools host");
  assert.ok(dom2.document.querySelector("#stack .tool[data-tool='row-2']"), "tool row replays as a card");
  assert.match(
    (dom2.document.querySelector("#stack .tool__dur")?.textContent ?? "") + (dom2.document.querySelector("#stack .tool__body")?.textContent ?? ""),
    /6ms|file body/,
    "tool timing/output survive the reload",
  );
  assert.match(
    dom2.document.querySelector("#stack").textContent ?? "",
    /error: HTTP 400 from MultiRouter/,
    "error row replays as the same notice shown live",
  );

  // a failed tool row replays with the error styling
  n = chat.replaceThread([
    { role: "tool", content: "→ exec · 3ms\nerror: user declined this action" },
  ]);
  assert.equal(n, 1);
  assert.ok(dom2.document.querySelector("#stack .tool__icon--err"), "failed tool row shows the error state");

  // one bad row must not take the thread with it (render isolation)
  n = chat.replaceThread([
    { role: "user", content: "ok" },
    { role: "assistant", content: "fine" },
  ]);
  assert.equal(n, 2);

  // empty history → empty state, not a blank screen
  chat.replaceThread([]);
  assert.ok(dom2.document.querySelector("#stack .empty"), "empty state shown");

  // a run that is still streaming keeps its bubble across a history reload
  chat.replaceThread([{ role: "user", content: "old" }]);
  chat.assistantStart();
  chat.delta("streaming ");
  chat.delta("text");
  chat.replaceThread([{ role: "user", content: "old" }]);
  const msgs = dom2.document.querySelectorAll("#stack .msg");
  assert.equal(msgs.length, 2, "history row + preserved live bubble");
  assert.ok(msgs[1].className.includes("msg--assistant"), "the live bubble is assistant");
  await new Promise((r) => setTimeout(r, 20));
  assert.ok((msgs[1].textContent ?? "").includes("streaming text"), "live text survives the reload");
});

test("loadHistory replaces via replaceThread and never clears before the fetch", () => {
  const src = readFileSync(join(ROOT, "ui/src/main.ts"), "utf8");
  const fn = src.slice(src.indexOf("async function loadHistory"), src.indexOf("function statusTools"));
  assert.ok(fn.includes("chat.replaceThread"), "history reload goes through replaceThread");
  assert.ok(!fn.includes("chat.clear()"), "no clear-before-fetch (the blank-screen failure mode)");
  assert.ok(fn.indexOf("gateway.request") < fn.indexOf("chat.replaceThread"), "fetch first, replace after");
});
