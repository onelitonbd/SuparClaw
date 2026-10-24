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
  for (const name of ["SPARKLE"]) {
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

  // plain history reload — user, assistant, tool cards, and error rows all
  // round-trip (tool calls and errors used to vanish on refresh)
  let n = chat.replaceThread([
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1" },
    { role: "tool", content: "→ fs_read · 6ms\n# IDENTITY.md\nfile body here" },
    { role: "error", content: "HTTP 400 from MultiRouter: bad argument" },
  ]);
  assert.equal(n, 4, "every visible row type renders");
  assert.equal(dom2.document.querySelectorAll("#stack .msg--user").length, 1, "user bubble");
  // ONE grouped assistant bubble per turn: trace card (thinking → tools)
  // with the answer body below it.
  assert.equal(dom2.document.querySelectorAll("#stack .msg--assistant").length, 1, "one grouped turn bubble");
  const turn = dom2.document.querySelector("#stack .msg--assistant");
  assert.ok(turn.querySelector(".agent-trace__item--tool[data-id='hist-tool-2']"), "tool row lives inside the turn bubble");
  assert.match(turn.querySelector(".msg__body")?.textContent ?? "", /a1/, "answer body shares the bubble");
  assert.ok(dom2.document.querySelector("#stack .agent-trace__item--tool[data-id='hist-tool-2']"), "tool row replays as a trace step");
  assert.match(
    (turn.querySelector(".agent-trace__meta-inline")?.textContent ?? "") + (turn.querySelector(".agent-trace__duration")?.textContent ?? ""),
    /6ms/,
    "tool timing survive the reload",
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
  assert.ok(dom2.document.querySelector("#stack .agent-trace__circle--error"), "failed tool row shows the error state");

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

test("reload groups a turn into ONE bubble: thinking → tools → answer (the mobile screenshot bug)", async () => {
  const dom3 = parseHTML(readFileSync(join(ROOT, "ui/index.html"), "utf8"));
  globalThis.document = dom3.document;
  globalThis.HTMLElement = dom3.HTMLElement;
  globalThis.CSS = { escape: (s) => s };
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  const chat = new Chat(dom3.document.body, { send: () => {}, abort: () => {}, approve: () => {} });

  // The exact shape from the user's session: one "hey" turn that ran three
  // web_search rounds, thought before each, answered in Bangla at the end.
  const n = chat.replaceThread([
    { role: "user", content: "hey" },
    { role: "reasoning", content: "Plan: check the news first." },
    { role: "tool", content: "→ web_search · 1100ms\nresults 1" },
    { role: "reasoning", content: "More context needed." },
    { role: "tool", content: "→ web_search · 1000ms\nresults 2" },
    { role: "tool", content: "→ web_search · 827ms\nresults 3" },
    { role: "assistant", content: "নিন, খবর এখানে।" },
  ]);
  assert.equal(n, 7, "every row counted");
  assert.equal(dom3.document.querySelectorAll("#stack .msg--user").length, 1);
  assert.equal(dom3.document.querySelectorAll("#stack .msg--assistant").length, 1, "ONE bubble for the whole turn");
  const turn = dom3.document.querySelector("#stack .msg--assistant");
  assert.equal(turn.querySelectorAll(".agent-trace__item--tool").length, 2, "consecutive same-kind calls merge into groups");
  assert.equal(turn.querySelectorAll(".agent-trace__item--thinking").length, 2, "thinking blocks live inside the bubble");
  // three calls total, grouped into two rows (one lone call + one merged pair)
  const groups = [...turn.querySelectorAll(".agent-trace__item--tool")];
  assert.equal(groups[0].querySelectorAll(".agent-trace__subrow").length, 0, "single call group has no sub-rows");
  assert.equal(groups[1].querySelectorAll(".agent-trace__subrow").length, 2, "merged pair group has two sub-rows");
  assert.match(turn.querySelector(".msg__body")?.textContent ?? "", /খবর/, "answer body at the bottom of the same bubble");
  // order: header, trace card (thinking above tools), answer body last
  const kids = [...turn.children].map((c) => c.className);
  assert.ok(kids[0].includes("msg__head"), "head first");
  assert.ok(kids.some((c) => c.includes("agent-trace")), "trace card present");
  const trace = turn.querySelector(".agent-trace-root");
  assert.ok(trace, "trace root inside the bubble");
  const items = [...trace.querySelectorAll(".agent-trace__item")];
  const thoughtIdx = items.findIndex((el) => el.classList.contains("agent-trace__item--thinking"));
  const toolIdx = items.findIndex((el) => el.classList.contains("agent-trace__item--tool"));
  assert.ok(thoughtIdx >= 0 && toolIdx >= 0, "both thinking and tool steps present");
  assert.ok(thoughtIdx < toolIdx, "thinking above tools (live order)");
  assert.ok(kids.at(-1).includes("msg__body"), "body last");
});

test("live: thinking that arrives before the bubble opens moves inside it", async () => {
  const dom4 = parseHTML(readFileSync(join(ROOT, "ui/index.html"), "utf8"));
  globalThis.document = dom4.document;
  globalThis.HTMLElement = dom4.HTMLElement;
  globalThis.CSS = { escape: (s) => s };
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  const chat = new Chat(dom4.document.body, { send: () => {}, abort: () => {}, approve: () => {} });

  chat.reasoningDelta("Early thought."); // no bubble open yet
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(dom4.document.querySelectorAll("#stack .agent-trace__item--thinking").length, 1, "thinking row renders while waiting");
  chat.assistantStart();
  chat.reasoningDelta(" More.");
  chat.tool("web_search", "done", "hits", 100, "c1");
  chat.delta("answer");
  await new Promise((r) => setTimeout(r, 20));
  const turn = dom4.document.querySelector("#stack .msg--assistant");
  const thought = turn.querySelector(".agent-trace__item--thinking");
  assert.ok(thought, "thinking step inside the bubble");
  assert.match(thought.textContent ?? "", /Early thought\. More\./, "fragments keep accumulating in place");
  assert.ok(turn.querySelector(".agent-trace__item--tool"), "tool card in the same bubble");
  assert.ok(turn.querySelector(".msg__body"), "answer body at the bottom of the bubble");
});

test("loadHistory replaces via replaceThread and never clears before the fetch", () => {
  const src = readFileSync(join(ROOT, "ui/src/main.ts"), "utf8");
  const fn = src.slice(src.indexOf("async function loadHistory"), src.indexOf("function statusTools"));
  assert.ok(fn.includes("chat.replaceThread"), "history reload goes through replaceThread");
  assert.ok(!fn.includes("chat.clear()"), "no clear-before-fetch (the blank-screen failure mode)");
  assert.ok(fn.indexOf("gateway.request") < fn.indexOf("chat.replaceThread"), "fetch first, replace after");
});

test("composer carries no session counter (removed by request)", () => {
  const src = readFileSync(join(ROOT, "ui/src/main.ts"), "utf8");
  assert.ok(!src.includes("function health"), "health() session-count writer is gone");
  assert.ok(!/sessions\} session/.test(src), "no 'N sessions' label anywhere");
  assert.ok(src.includes("setTokenHint"), "#tok still shows token hints");
});

test("composer has no thinking-visibility button — preview is always on", () => {
  const html = readFileSync(join(ROOT, "ui/index.html"), "utf8");
  assert.ok(!html.includes("think-view"), "eye toggle removed from the composer");
  const src = readFileSync(join(ROOT, "ui/src/main.ts"), "utf8");
  assert.ok(!src.includes("setThinkingView") && !src.includes("sc.reasoningView"), "no view-toggle wiring left");
});

test("prettyError turns provider JSON walls into the human message", async () => {
  const { prettyError } = await import(pathToFileURL(join(outDir, "chat.mjs")).href);
  const raw =
    'error: HTTP 502 from MultiRouter: {"error":{"message":"All providers failed. Last error: All keys failed. Last upstream 503: {\\"error\\":{\\"message\\":\\"The service returned an error. Please retry later.\\",\\"type\\":\\"api_error\\"}}","type":"upstream_error","code":null,"param":null}}';
  const pretty = prettyError(raw);
  assert.ok(pretty.includes("HTTP 502 from MultiRouter"), "prefix kept");
  assert.ok(pretty.includes("All providers failed"), "human message extracted");
  assert.ok(!pretty.includes('{"error"'), `JSON wall gone: ${pretty}`);
  assert.equal(prettyError("HTTP 400 from X: plain text"), "HTTP 400 from X: plain text", "plain text passes through");

  // Google's own error shape: a pretty-printed JSON ARRAY body (the
  // thought_signature 400 the user hit on mobile).
  const googleBlob = JSON.stringify(
    [{ error: { code: 400, message: "Function call is missing a thought_signature in functionCall parts. Additional data, function call `default_api:fs_read` , position 31.", status: "INVALID_ARGUMENT" } }],
    null,
    2,
  );
  const fromArray = prettyError(`error: HTTP 400 from MultiRouter: ${googleBlob}`);
  assert.ok(fromArray.includes("HTTP 400 from MultiRouter"), "prefix kept on the array blob");
  assert.ok(fromArray.includes("Function call is missing a thought_signature"), "message extracted from [{error:{message}}]");
  assert.ok(fromArray.includes("position 31"), "full message kept");
  assert.ok(!fromArray.includes('"code"'), `array wall gone: ${fromArray.slice(0, 80)}`);

  // Truncated blob (providers cap bodies mid-JSON): the message string in the
  // debris must still surface instead of the raw wall.
  const fromDebris = prettyError(`error: HTTP 400 from MultiRouter: ${googleBlob.slice(0, 120)}`);
  assert.ok(fromDebris.includes("Function call is missing a thought_signature"), `debris yields the message: ${fromDebris.slice(0, 80)}`);
  assert.ok(!fromDebris.includes('"error"'), `debris wall gone: ${fromDebris.slice(0, 80)}`);
});

test("styles keep long errors and tokens inside the thread", () => {
  const css = readFileSync(join(ROOT, "ui/styles.css"), "utf8");
  assert.ok(css.includes("overflow-wrap: anywhere"), "wrap-anywhere present");
  assert.ok(/overflow-x:\s*hidden/.test(css), "thread scroller clips horizontal overflow");
  assert.ok(css.includes(".notice--error"), "errors render as a bounded card");
});
