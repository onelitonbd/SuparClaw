// "Show thinking blocks" (agents.defaults.reasoningView) must actually hide
// something. It used to be shipped to the client in `status` and read by nobody,
// so the switch in Settings → Run limits → Reasoning & replies was decorative.
//
// The rule is draw-versus-store: the rows stay in the transcript either way, and
// "off" only decides whether the chat draws them — that is what the hint says.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_TMP = (() => {
  for (const base of [process.env.SUPARCLAW_TEST_TMP, tmpdir(), "/tmp"].filter(Boolean)) {
    try { mkdirSync(base, { recursive: true }); return base; } catch { /* next */ }
  }
  return ROOT;
})();

const outDir = mkdtempSync(join(TEST_TMP, "sc-ui-reasoning-"));
const rpcStub = join(outDir, "rpc-stub.mjs");
writeFileSync(rpcStub, `
export const gateway = {
  state: "online",
  async request() { return {}; },
};
`);

const { build } = await import("esbuild");
await build({
  entryPoints: [join(ROOT, "ui/src/chat.ts")],
  bundle: true,
  format: "esm",
  outdir: outDir,
  outExtension: { ".js": ".mjs" },
  platform: "neutral",
  plugins: [{ name: "stub-rpc", setup(b) { b.onResolve({ filter: /(^|\/)rpc\.js$/ }, () => ({ path: rpcStub })); } }],
});

// One page must exist before the module is imported, then each test swaps in its
// own: a Chat builds its stack and wires the composer, so two cannot share a doc.
globalThis.document = parseHTML("<!doctype html><html><body></body></html>").document;
globalThis.window = globalThis.document.defaultView;
globalThis.HTMLElement = globalThis.window.HTMLElement;
globalThis.Event = globalThis.window.Event;
globalThis.location = { hash: "" };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const { Chat } = await import(pathToFileURL(join(outDir, "chat.mjs")).href);

const FIXTURE = `<!doctype html><html><body>
  <div id="app">
    <div id="stack"><div id="thread"></div></div>
    <button id="jump" hidden></button>
    <div id="qrow" hidden></div>
    <div id="approval" hidden></div>
    <span id="tok"></span>
    <div id="attach-strip" hidden></div>
    <input id="attach-input" type="file" hidden />
    <button id="attach-btn" type="button"></button>
    <div id="composer">
      <textarea id="input"></textarea>
      <button id="send-btn" type="button"></button>
      <button id="stop-btn" type="button"></button>
    </div>
  </div>
</body></html>`;

/** A chat needs its own document: it builds its own stack and wires the
 *  composer, so two instances cannot share one page. */
function freshChat(reasoningOn = true) {
  const page = parseHTML(FIXTURE);
  globalThis.document = page.document;
  globalThis.window = page.window;
  globalThis.HTMLElement = page.HTMLElement;
  globalThis.Event = page.window.Event;
  globalThis.location = { hash: "" };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const chat = new Chat(page.document.body, { onSend() {}, onStop() {}, onRetry() {} });
  chat.setReasoningVisible(reasoningOn);
  return { chat, doc: page.document };
}

const thinkingSteps = (doc) => doc.querySelectorAll(".agent-trace__item--thinking").length;
const headerSteps = (doc) => doc.querySelectorAll(".agent-trace__steps > *").length;

test("live thinking is drawn by default and skipped when the setting is off", () => {
  const on = freshChat(true);
  on.chat.assistantStart();
  on.chat.reasoningDelta("weighing options");
  on.chat.delta("an answer");
  assert.ok(thinkingSteps(on.doc) >= 1, "a thinking step is drawn when the setting is on");

  const off = freshChat(false);
  off.chat.assistantStart();
  off.chat.reasoningDelta("weighing options");
  off.chat.delta("an answer");

  // Not just invisible: nothing is added, so the collapsed "N steps" header
  // cannot count a thought it is not showing.
  assert.equal(thinkingSteps(off.doc), 0, "no thinking step is drawn when off");
  assert.ok(
    headerSteps(off.doc) < headerSteps(on.doc),
    `the step count drops with the setting off (${headerSteps(off.doc)} vs ${headerSteps(on.doc)})`,
  );
  assert.ok(
    headerSteps(off.doc) >= 0 && off.doc.querySelectorAll(".agent-trace__item--thinking").length === 0,
    "the turn renders without inventing a thought",
  );
});

test("a persisted reasoning row is skipped when off, and the turn around it still renders", () => {
  const rows = [
    { id: 1, role: "user", content: "what changed?" },
    { id: 2, role: "reasoning", content: "STORE-ONLY-THOUGHT" },
    { id: 3, role: "assistant", content: "the answer" },
  ];

  const on = freshChat(true);
  on.chat.replaceThread(rows);
  assert.match(on.doc.body.textContent, /STORE-ONLY-THOUGHT/, "the stored thought shows when the setting is on");

  const off = freshChat(false);
  off.chat.replaceThread(rows);
  const text = off.doc.body.textContent;
  // Off is "do not draw", not "drop": the row stays in the transcript.
  assert.ok(!text.includes("STORE-ONLY-THOUGHT"), "the stored thought is hidden when off");
  assert.match(text, /what changed\?/, "the question still renders");
  assert.match(text, /the answer/, "the reply still renders");
});

test("the setter is a plain switch, safe before anything is rendered", () => {
  const { chat } = freshChat(true);
  assert.doesNotThrow(() => chat.setReasoningVisible(false));
  assert.doesNotThrow(() => chat.setReasoningVisible(true));
});
