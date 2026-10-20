import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
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
  entryPoints: [join(ROOT, "ui/src/dom.ts"), join(ROOT, "ui/src/markdown.ts")],
  bundle: true,
  format: "esm",
  outdir: outDir,
  outExtension: { ".js": ".mjs" },
  platform: "neutral",
});
const { el, icon } = await import(pathToFileURL(join(outDir, "dom.mjs")).href);
const { renderMarkdown } = await import(pathToFileURL(join(outDir, "markdown.mjs")).href);

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
