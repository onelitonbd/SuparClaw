// ask_user web card: progressively show one question, collect answers locally,
// then submit the complete map expected by chat.questionAnswer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";
import { build } from "esbuild";

const ROOT = process.cwd();
const outDir = mkdtempSync(join(tmpdir(), "sc-ui-ask-user-"));
await build({
  entryPoints: [join(ROOT, "ui/src/chat.ts")],
  bundle: true,
  format: "esm",
  outdir: outDir,
  outExtension: { ".js": ".mjs" },
  platform: "neutral",
});
const { Chat } = await import(pathToFileURL(join(outDir, "chat.mjs")).href);

const SHELL = `<div id="root">
  <div id="thread"><div id="stack"></div></div>
  <div id="composer">
    <textarea id="input"></textarea>
    <button id="send-btn" type="button"></button>
    <button id="stop-btn" type="button"></button>
    <div id="attach-strip"></div>
    <button id="attach-btn" type="button"></button>
    <input id="attach-input" type="file">
  </div>
  <div id="approval"></div>
  <div id="question" hidden>
    <div class="approval__head"><span id="question-progress"></span></div>
    <div id="question-body"></div>
    <div class="approval__row question__actions">
      <button id="question-skip"></button>
      <button id="question-skip-one"></button>
      <button id="question-answer" disabled></button>
    </div>
  </div>
  <div id="qrow"></div><button id="jump"></button><span id="tok"></span>
</div>`;

function mount() {
  const dom = parseHTML(`<html><body>${SHELL}</body></html>`);
  globalThis.document = dom.document;
  globalThis.window = dom.window;
  globalThis.HTMLElement = dom.HTMLElement;
  globalThis.Event = dom.window.Event;
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  const calls = [];
  const chat = new Chat(dom.document.getElementById("root"), {
    send() {}, abort() {}, approve() {}, cancelQueued() {}, regenerate() {}, rewind() {}, fork() {},
    questionAnswer: (id, answers) => calls.push({ id, answers }),
  });
  return { dom, chat, calls, doc: dom.document };
}

const visibleQuestion = (doc) => doc.querySelector("#question-body .question__text")?.textContent;
const nextButton = (doc) => doc.getElementById("question-answer");
const click = (node) => node.onclick?.();

test("renders one question at a time, advances, skips one, then submits the full answer map", () => {
  const { chat, calls, doc } = mount();
  chat.question("set-1", [
    { id: "q1", question: "Choose an environment", options: ["staging", "production"], multi: false },
    { id: "q2", question: "Choose features", options: ["read", "write", "admin"], multi: true },
    { id: "q3", question: "Anything else?", options: ["yes", "no"], multi: false },
  ]);

  assert.equal(doc.getElementById("question").hidden, false);
  assert.equal(visibleQuestion(doc), "Choose an environment");
  assert.equal(doc.querySelectorAll("#question-body .question__text").length, 1);
  assert.equal(doc.getElementById("question-progress").textContent, "Question 1 of 3");
  assert.equal(nextButton(doc).disabled, true, "cannot advance without answering");

  const firstOption = [...doc.querySelectorAll("#question-body .question__choices .chip")].find((chip) => chip.textContent === "production");
  click(firstOption);
  assert.equal(nextButton(doc).disabled, false);
  assert.equal(nextButton(doc).textContent, "Next question");
  click(nextButton(doc));
  assert.equal(visibleQuestion(doc), "Choose features");
  assert.equal(doc.getElementById("question-progress").textContent, "Question 2 of 3");

  for (const label of ["read", "write"]) {
    click([...doc.querySelectorAll("#question-body .question__choices .chip")].find((chip) => chip.textContent === label));
  }
  assert.equal(doc.querySelectorAll("#question-body .chip--on").length, 2, "multi-select keeps both selections");
  click(nextButton(doc));
  assert.equal(visibleQuestion(doc), "Anything else?");
  assert.equal(nextButton(doc).textContent, "Submit answers");

  click(doc.getElementById("question-skip-one"));
  assert.equal(doc.getElementById("question").hidden, true);
  assert.deepEqual(calls, [{
    id: "set-1",
    answers: { q1: ["production"], q2: ["read", "write"], q3: [] },
  }]);
});

test("Other opens an inline answer field (not a browser prompt) and saves the custom answer", () => {
  const { chat, calls, doc } = mount();
  chat.question("set-other", [{ id: "q1", question: "What label?", options: ["alpha", "beta"], multi: false }]);
  click([...doc.querySelectorAll("#question-body .chip")].find((chip) => chip.textContent === "Other…"));
  const input = doc.getElementById("question-other-input");
  assert.ok(input, "Other reveals an inline input");
  input.value = "custom label";
  click([...doc.querySelectorAll("#question-body button")].find((button) => button.textContent === "Use this answer"));
  assert.equal(doc.getElementById("question-other-input"), null);
  assert.match(doc.querySelector(".question__custom").textContent, /custom label/);
  click(nextButton(doc));
  assert.deepEqual(calls[0], { id: "set-other", answers: { q1: ["custom label"] } });
});

test("Skip all sends empty answers for every question", () => {
  const { chat, calls, doc } = mount();
  chat.question("set-skip", [
    { id: "one", question: "First?", options: ["a", "b"], multi: false },
    { id: "two", question: "Second?", options: ["c", "d"], multi: false },
  ]);
  click(doc.getElementById("question-skip"));
  assert.deepEqual(calls[0], { id: "set-skip", answers: { one: [], two: [] } });
});

test("mobile styles wrap the sequential action row and Other input", () => {
  const css = readFileSync(join(ROOT, "ui/styles.css"), "utf8");
  assert.match(css, /\.question__actions \{ flex-wrap: wrap; \}/);
  assert.match(css, /@media \(max-width: 520px\)[\s\S]*\.question__other \{ align-items: stretch; flex-direction: column; \}/);
});
