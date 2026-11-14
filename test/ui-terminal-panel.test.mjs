// Task 52 — the terminal panel, rendered for real.
//
// linkedom gives us a DOM and the component takes its socket by injection, so
// this drives the exact code the browser runs: build the chrome, open it, feed
// it daemon events, type a command, switch tabs, kill one. No screenshots — the
// assertions are on the text and structure a person would read on screen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";

const ROOT = process.cwd();

const TEST_TMP = (() => {
  for (const base of [process.env.SUPARCLAW_TEST_TMP, tmpdir(), "/tmp"].filter(Boolean)) {
    try {
      mkdirSync(base, { recursive: true });
      return base;
    } catch {
      /* next candidate */
    }
  }
  return ROOT;
})();

const domGlobals = parseHTML("<html><body></body></html>");
globalThis.document = domGlobals.document;
globalThis.HTMLElement = domGlobals.HTMLElement;

const outDir = mkdtempSync(join(TEST_TMP, "sc-ui-term-"));
const { build } = await import("esbuild");
await build({
  entryPoints: [join(ROOT, "ui/src/terminal.ts")],
  bundle: true,
  format: "esm",
  outdir: outDir,
  outExtension: { ".js": ".mjs" },
  platform: "neutral",
});
const { TerminalPanel, terminalSummary, escapeHtml } = await import(pathToFileURL(join(outDir, "terminal.mjs")).href);

const info = (id, extra = {}) => ({
  id,
  name: id,
  cwd: "/home/me/project",
  shell: "/bin/bash",
  status: "idle",
  lastExit: 0,
  busy: false,
  owner: "main:main",
  createdAt: 1,
  bytes: 12,
  seq: 1,
  command: null,
  pid: 100,
  ...extra,
});

/** A panel with a scripted transport; `calls` records every frame it sent. */
function mount(handlers = {}) {
  const root = document.createElement("section");
  root.id = "terminal-panel";
  root.hidden = true;
  document.body.append(root);
  const calls = [];
  const transport = {
    request: async (method, params) => {
      calls.push({ method, params });
      const h = handlers[method];
      if (typeof h === "function") return h(params, calls);
      if (h !== undefined) return h;
      throw new Error(`unscripted ${method}`);
    },
  };
  const toasts = [];
  const panel = new TerminalPanel(root, {
    transport,
    sessionKey: () => "main:main",
    toast: (text, tone) => toasts.push({ text, tone }),
  });
  const $ = (id) => root.querySelector(`#${id}`);
  return { root, panel, calls, toasts, $ };
}

const text = (node) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();

test("the panel is built once, hidden, and carries every control the operator needs", () => {
  const { root, $ } = mount();
  assert.equal(root.hidden, true, "closed until the rail button opens it");
  for (const id of ["term-new", "term-interrupt", "term-clear", "term-close", "term-out", "term-input", "term-send"]) {
    assert.ok($(id), `#${id} exists`);
  }
  assert.ok($("term-out").tagName === "PRE", "output is a <pre>, so newlines are newlines");
  assert.equal($("term-tabs").getAttribute("role"), "tablist");
  assert.match(root.innerHTML, /Terminals/);
});

test("no terminals is a state with a way out, not an empty box", async () => {
  const { panel, $ } = mount({ "terminals.list": { terminals: [] } });
  await panel.open();
  assert.equal($("term-form").hidden, true, "nothing to type into yet");
  assert.equal($("term-out").hidden, true);
  assert.equal($("term-empty").hidden, false);
  assert.match(text($("term-empty")), /No terminal is open yet/);
  assert.ok($("term-empty-new"), "the empty state offers to open one");
  assert.match($("term-meta").textContent, /no terminals open/);
  assert.equal(panel.isOpen, true);
  panel.close();
  assert.equal(panel.isOpen, false);
});

test("opening loads the real scrollback and shows where the shell is", async () => {
  const { panel, $, calls, root } = mount({
    "terminals.list": { terminals: [info("t1", { name: "build" })] },
    "terminals.read": { text: "line one\nline two\n", seq: 7 },
  });
  await panel.open();
  assert.deepEqual(calls[0], { method: "terminals.list", params: { sessionKey: "main:main" } });
  assert.equal(calls[1].method, "terminals.read");
  assert.equal($("term-out").textContent, "line one\nline two\n");
  assert.match(text($("term-meta")), /t1/);
  assert.match(text($("term-meta")), /idle/);
  assert.match(text($("term-meta")), /\/home\/me\/project/);
  const tabs = [...root.querySelectorAll('[role="tab"]')];
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].getAttribute("aria-selected"), "true");
  assert.match(text(tabs[0]), /t1 · build/);
  assert.equal($("term-form").hidden, false);
  panel.close();
});

test("live output streams into the view — and stays text", async () => {
  const { panel, $, root } = mount({
    "terminals.list": { terminals: [info("t1")] },
    "terminals.read": { text: "", seq: 0 },
  });
  await panel.open();
  panel.handleEvent({ kind: "output", id: "t1", text: "building…\n" });
  panel.handleEvent({ kind: "output", id: "t1", text: "<img src=x onerror=alert(1)>\n" });
  assert.match($("term-out").textContent, /building…/);
  // The dangerous string is visible AS TEXT and did not become an element.
  assert.match($("term-out").textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(root.querySelector("img"), null, "output can never inject markup");
  panel.close();
});

test("a state event moves the header, the dot and the running command", async () => {
  const { panel, $ } = mount({ "terminals.list": { terminals: [info("t1")] }, "terminals.read": { text: "", seq: 0 } });
  const statuses = [];
  panel.onStatus = (s) => statuses.push(s);
  await panel.open();
  statuses.length = 0;
  panel.handleEvent({ kind: "state", id: "t1", terminal: info("t1", { busy: true, status: "running", command: "npm run dev" }) });
  assert.match(text($("term-meta")), /running/);
  assert.match(text($("term-meta")), /npm run dev/);
  assert.deepEqual(statuses.at(-1), { open: 1, busy: 1 }, "the rail dot is told something is running");
  panel.handleEvent({ kind: "state", id: "t1", terminal: info("t1") });
  assert.deepEqual(statuses.at(-1), { open: 1, busy: 0 });
  panel.close();
});

test("typing sends the command and echoes it like a shell would", async () => {
  const { panel, $, calls } = mount({
    "terminals.list": { terminals: [info("t1")] },
    "terminals.read": { text: "ready\n", seq: 1 },
    "terminals.send": { started: true },
  });
  await panel.open();
  $("term-input").value = "ls -la";
  await panel.send();
  const sent = calls.find((c) => c.method === "terminals.send");
  assert.deepEqual(sent.params, { terminal: "t1", command: "ls -la" });
  assert.equal($("term-input").value, "", "the prompt clears");
  assert.match($("term-out").textContent, /\$ ls -la\n/, "the typed line is echoed (a pipe has no echo of its own)");
  // A busy terminal answers with an error frame; the panel says so in place.
  panel.close();
});

test("a rejected send is reported in the output, not swallowed", async () => {
  const { panel, $, toasts } = mount({
    "terminals.list": { terminals: [info("t1", { busy: true })] },
    "terminals.read": { text: "", seq: 0 },
    "terminals.send": () => {
      throw new Error('"sleep 30" is still running — interrupt it first');
    },
  });
  await panel.open();
  $("term-input").value = "echo hi";
  await panel.send();
  assert.match($("term-out").textContent, /\[panel\] .*still running/);
  assert.equal(toasts.at(-1).tone, "err");
  panel.close();
});

test("switching tabs shows that terminal's own scrollback", async () => {
  const { panel, $, calls } = mount({
    "terminals.list": { terminals: [info("t1"), info("t2", { name: "dev" })] },
    "terminals.read": (params) =>
      params.terminal === "t1" ? { text: "one\n", seq: 2 } : { text: "two\n", seq: 3 },
  });
  await panel.open();
  assert.equal($("term-out").textContent, "one\n");
  assert.equal(panel.activeId, "t1");

  // Output that arrives while t2 has never been opened is buffered; the first
  // view loads history in front of it instead of dropping either.
  panel.handleEvent({ kind: "output", id: "t2", text: "live-while-away\n" });
  await panel.select("t2");
  assert.equal(panel.activeId, "t2");
  assert.match($("term-out").textContent, /two/);
  assert.match($("term-out").textContent, /live-while-away/);
  assert.ok(calls.filter((c) => c.method === "terminals.read").length >= 2);
  panel.close();
});

test("the first view never prints a line twice when output raced the scrollback read", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { panel, $ } = mount({
    "terminals.list": { terminals: [info("t1")] },
    "terminals.read": async () => {
      await gate; // hold the read open while events arrive
      return { text: "old-1\nold-2\n", seq: 10 };
    },
  });
  const opening = panel.open();
  await new Promise((r) => setTimeout(r, 0));
  panel.handleEvent({ kind: "output", id: "t1", text: "already-in-ring\n", seq: 8 });
  panel.handleEvent({ kind: "output", id: "t1", text: "brand-new\n", seq: 12 });
  release();
  await opening;
  const out = $("term-out").textContent;
  assert.equal(out, "old-1\nold-2\nbrand-new\n", "seq 8 is inside the read; seq 12 is not");
  panel.close();
});

test("interrupt, clear and a removed terminal all behave", async () => {
  const { panel, $, calls } = mount({
    "terminals.list": { terminals: [info("t1")] },
    "terminals.read": { text: "some output\n", seq: 4 },
    "terminals.interrupt": { killed: 1, restarted: false },
    "terminals.clear": { ok: true },
  });
  await panel.open();
  await panel.interrupt();
  assert.ok(calls.some((c) => c.method === "terminals.interrupt" && c.params.terminal === "t1"));
  await panel.clear();
  assert.equal($("term-out").textContent, "", "clearing empties the view");

  panel.handleEvent({ kind: "output", id: "t1", text: "x\n" });
  panel.handleEvent({ kind: "removed", id: "t1" });
  assert.equal(panel.activeId, null);
  assert.equal($("term-empty").hidden, false, "no terminal left ⇒ the empty state returns");
  panel.close();
});

test("a dead shell says it is dead instead of pretending to take input", async () => {
  const { panel, $ } = mount({
    "terminals.list": { terminals: [info("t1", { status: "exited", lastExit: 7 })] },
    "terminals.read": { text: "bye\n", seq: 3 },
  });
  await panel.open();
  assert.match(text($("term-meta")), /shell exited/);
  assert.match($("term-input").placeholder, /restart it/);
  panel.close();
});

test("terminalSummary reads like a sentence for the rail tooltip", () => {
  assert.equal(terminalSummary(null), "no terminals");
  assert.equal(terminalSummary({ open: 0, busy: 0 }), "no terminals");
  assert.equal(terminalSummary({ open: 1, busy: 0 }), "1 terminal");
  assert.equal(terminalSummary({ open: 2, busy: 1 }), "2 terminals · 1 running");
});

test("escapeHtml is the only place a terminal string becomes markup", () => {
  assert.equal(escapeHtml('<b a="1">&\''), "&lt;b a=&quot;1&quot;&gt;&amp;&#39;");
});

test("the page ships the button, the panel and the layout rules", () => {
  const html = readFileSync(join(ROOT, "ui/index.html"), "utf8");
  assert.match(html, /id="terminal-btn"/, "the rail has the button");
  assert.match(html, /class="ibtn[^"]*" id="terminal-btn"/, "it is an icon button like its neighbours");
  assert.doesNotMatch(html, /class="ibtn ibtn--live" id="terminal-btn"/, "no permanent green dot before anything runs");
  assert.match(html, /id="terminal-panel"/, "the panel node exists up front");
  assert.match(html, /<section class="term" id="terminal-panel"[^>]*hidden/, "and starts hidden");

  const css = readFileSync(join(ROOT, "ui/styles.css"), "utf8");
  assert.match(css, /\.term\s*\{[^}]*inset: 0/s, "phone: the panel owns the screen");
  assert.match(css, /\.term\[hidden\]\s*\{\s*display: none;?\s*\}/, "hidden still wins over display:flex");
  const desk = css.slice(css.indexOf("@media (min-width: 900px)"), css.indexOf("@media (min-width: 900px)") + 320);
  assert.match(desk, /\.term\s*\{/, "desktop docks it");
  assert.match(desk, /right: 0/, "to the right edge");
  assert.match(desk, /top: var\(--rail-h\)/, "below the rail");
  assert.match(css, /\.term__out[^{]*\{[^}]*font-family|\.term__out\s*\{[^}]*var\(--mono\)/s, "output is monospace");

  const main = readFileSync(join(ROOT, "ui/src/main.ts"), "utf8");
  assert.match(main, /new TerminalPanel\(\$\("terminal-panel"\)/, "main.ts mounts the panel");
  assert.match(main, /event === "terminal"/, "gateway terminal events are routed to it");
  assert.match(main, /\$\("terminal-btn"\)\.onclick/, "the rail button opens it");
});
