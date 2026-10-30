import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";
import { build } from "esbuild";

const ROOT = process.cwd(); const outDir = mkdtempSync(join(tmpdir(), "sc-ui-workspace-"));
await build({ entryPoints: [join(ROOT, "ui/src/workspace.ts"), join(ROOT, "ui/src/chat.ts")], bundle: true, format: "esm", outdir: outDir, outExtension: { ".js": ".mjs" }, platform: "neutral" });
const { WorkspacePanel } = await import(pathToFileURL(join(outDir, "workspace.mjs")).href);
const { Chat } = await import(pathToFileURL(join(outDir, "chat.mjs")).href);
const tick = () => new Promise((r) => setTimeout(r, 0)); const settle = async () => { await tick(); await tick(); };
const fire = (node, type) => node.dispatchEvent(new globalThis.Event(type, { bubbles: true }));
function dom() {
  const page = parseHTML(`<html><body><div id="root"><div id="thread"><div id="stack"></div></div><div id="composer"><div id="attach-strip"></div><textarea id="input"></textarea><button id="send-btn"></button><button id="stop-btn"></button><button id="attach-btn"></button><input id="attach-input" type="file"><div id="qrow"></div><button id="jump"></button><span id="tok"></span></div><div id="question" hidden><div id="question-body"></div></div></div></body></html>`);
  globalThis.document = page.document; globalThis.window = page.window; globalThis.HTMLElement = page.HTMLElement; globalThis.Event = page.window.Event;
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0); return page;
}
const say = (node) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();
test("@ completion inserts a path-only reference rather than attaching contents", async () => {
  const page = dom();
  const chat = new Chat(page.document.getElementById("root"), { send() {}, abort() {}, cancelQueued() {}, regenerate() {}, rewind() {}, fork() {}, questionAnswer() {}, searchWorkspace: async () => [{ path: "src/worker.ts", name: "worker.ts", size: 26 }] });
  const input = page.document.getElementById("input"); input.setSelectionRange ??= () => {}; input.value = "Read @work";
  Object.defineProperty(input, "selectionStart", { configurable: true, value: input.value.length });
  Object.defineProperty(input, "selectionEnd", { configurable: true, value: input.value.length });
  fire(input, "input"); await settle();
  const menu = page.document.querySelector(".mention-menu"); assert.equal(menu.hidden, false); assert.match(say(menu), /src\/worker\.ts/);
  menu.querySelector(".mention-option").onclick(); assert.equal(input.value, "Read @src/worker.ts "); assert.equal(menu.hidden, true);
});
test("workspace panel renders folders, breadcrumbs, preview, and Use in message", async () => {
  const page = dom(); const mentions = []; const calls = [];
  const transport = { token: "", async request(method, params) {
    calls.push({ method, params });
    if (method === "workspace.list" && params.path === "") return { path: "", entries: [{ name: "src", path: "src", kind: "directory", size: 0, modifiedAt: 10 }, { name: "README.md", path: "README.md", kind: "file", size: 30, modifiedAt: 20 }] };
    if (method === "workspace.list") return { path: "src", entries: [{ name: "worker.ts", path: "src/worker.ts", kind: "file", size: 26, modifiedAt: 30 }] };
    if (method === "workspace.read") return { path: params.path, name: "worker.ts", size: 26, modifiedAt: 30, mime: "text/plain", kind: "text", text: "export const answer = 42;" };
    if (method === "workspace.search") return { results: [] }; throw new Error(`unexpected ${method}`);
  } };
  const panel = new WorkspacePanel(page.document.body, { transport, sessionKey: () => "code:demo", onMention: (path) => mentions.push(path) });
  await panel.open(page.document.createElement("button")); const root = page.document.querySelector(".workspace-overlay");
  assert.equal(root.hidden, false); assert.match(say(root.querySelector(".workspace-list")), /README\.md/);
  [...root.querySelectorAll(".workspace-row")].find((row) => say(row).includes("src")).onclick(); await settle();
  assert.match(say(root.querySelector(".workspace-crumbs")), /Workspace\/src/); assert.match(say(root.querySelector(".workspace-list")), /worker\.ts/);
  [...root.querySelectorAll(".workspace-row")].find((row) => say(row).includes("worker.ts")).onclick(); await settle();
  assert.match(say(root.querySelector(".workspace-preview")), /export const answer/);
  assert.ok(calls.some((c) => c.method === "workspace.read" && c.params.sessionKey === "code:demo"));
  root.querySelector(".workspace-preview__mention").onclick(); assert.deepEqual(mentions, ["src/worker.ts"]); assert.equal(root.hidden, true);
});
test("mobile layout is full-height and switches between listing and preview", () => {
  const css = readFileSync(join(ROOT, "ui/styles.css"), "utf8");
  assert.match(css, /@media \(max-width:720px\)[\s\S]*?\.workspace-panel \{ width:100%/);
  assert.match(css, /\.workspace-overlay--preview \.workspace-list-pane \{ display:none; \}/);
});
