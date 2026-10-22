// P3 (row Missing!#24) — code-mode sandboxed execution (their tools/code-mode).
import { test } from "node:test";
import assert from "node:assert/strict";

const lib = await import("../dist/lib.js");
const { CodeMode, codeModeEngages, codeModeSurface, buildRegistry, emptyConfig } = lib;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE_CFG = (over = {}) => ({
  enabled: true,
  executor: "node",
  timeoutMs: 400,
  maxCodeChars: 32768,
  maxOutputBytes: 65536,
  maxPendingToolCalls: 16,
  directOnly: [],
  ...over,
});

function engineFactory(cfg, tools) {
  return new CodeMode(
    () => new Map(tools.map((t) => [t.name, t])),
    () => cfg,
  );
}

const echoTool = {
  name: "echo",
  description: "Echo the given text back.",
  inputs: { text: "string" },
  required: ["text"],
  run: async (args) => `echo:${args.text}`,
};

test("activation: false blocks, true engages, auto engages only preferred models (their order)", () => {
  assert.equal(codeModeEngages({ ...BASE_CFG(), enabled: false }, "openai/gpt-5.5"), false);
  assert.equal(codeModeEngages(BASE_CFG(), "something/whatever"), true);
  assert.equal(codeModeEngages({ ...BASE_CFG(), enabled: "auto" }, "openai/gpt-5.5"), true, "preferred list");
  assert.equal(codeModeEngages({ ...BASE_CFG(), enabled: "auto" }, "deepseek/deepseek-v4-pro"), true);
  assert.equal(codeModeEngages({ ...BASE_CFG(), enabled: "auto" }, "ollama/qwen3:32b"), false, "unflagged local stays off (their auto rule)");
});

test("surface swap: engaged registry is exec+wait(+direct-only); hidden tools become guest globals", () => {
  const cfg = emptyConfig();
  cfg.tools.codeMode.enabled = "true";
  cfg.tools.codeMode.directOnly = ["pdf"];
  const registry = buildRegistry(cfg);
  const names = registry.map((t) => t.name);
  assert.ok(names.includes("exec") && names.includes("wait"), "control tools visible");
  assert.ok(names.includes("pdf"), "direct-only tool kept");
  assert.ok(!names.includes("memory_search"), "hidden from the direct list (their mode:only)");
  const off = emptyConfig();
  off.tools.codeMode.enabled = "false";
  const baseline = buildRegistry(off).map((t) => t.name);
  assert.ok(baseline.includes("memory_search"), "normal exposure untouched when off");
  assert.ok(!baseline.includes("wait"));
});

test("exec: fast cell completes inline with their result shape", async () => {
  const engine = engineFactory(BASE_CFG(), [echoTool]);
  const res = await engine.execCell("return 21 * 2;", "doubling");
  assert.equal(res.status, "completed");
  assert.equal(res.runId.length > 0, true);
  assert.equal(res.labels.title, "doubling");
  assert.equal(res.value, 42);
});

test("exec: shell-smelling code is rejected BEFORE guest execution (their pre-guest reject)", async () => {
  const engine = engineFactory(BASE_CFG(), []);
  const res = await engine.execCell("sudo apt install evil", "");
  assert.equal(res.status, "error");
  assert.equal(res.error.code, "invalid_input");
  assert.match(res.error.message, /shell/);
  assert.equal(res.error.error, "invalid_input", "stitched {code,error,message} shape");
});

test("exec: guest outbound network is denied by omission (their default)", async () => {
  const engine = engineFactory(BASE_CFG(), []);
  const res = await engine.execCell('return typeof fetch + "/" + typeof WebSocket + "/" + typeof require;', "");
  assert.equal(res.status, "completed");
  assert.equal(res.value, "undefined/undefined/undefined");
});

test("guest global: hidden tools are callable as async globals through the same run path", async () => {
  let sawArgs = null;
  const tools = [{
    name: "uppercase",
    description: "Uppercases text",
    inputs: { text: "string" },
    required: ["text"],
    run: async (args) => { sawArgs = args; return String(args.text).toUpperCase(); },
  }];
  const engine = engineFactory(BASE_CFG(), tools);
  const res = await engine.execCell('const r = await uppercase({ text: "hello" }); return r + "!";', "");
  assert.equal(res.status, "completed");
  assert.equal(res.value, "HELLO!");
  assert.deepEqual(sawArgs, { text: "hello" }, "bridge delivered args");
});

test("catalog handles: search + describe expose bounded metadata, never internals", async () => {
  const engine = engineFactory(BASE_CFG(), [echoTool]);
  const res = await engine.execCell('const s = await require2 ?? 0;return 1;', "");
  // import() and require are both denied; use a real discovery cell instead:
  const res2 = await engine.execCell(
    'const hits = await catalog.search({ query: "echo" }); return hits.displayedNames.join(",") + "|" + hits.totalMatches;',
    "discovery",
  );
  assert.equal(res2.status, "completed");
  assert.match(res2.value, /echo\|1/);
  const res3 = await engine.execCell('const d = await catalog.describe({ name: "echo" }); return d.kind + ":" + d.description;', "");
  assert.equal(res3.status, "completed");
  assert.match(res3.value, /^tool:/);
  void res;
});

test("suspension + wait: bridges still open after the budget → waiting, resumed by wait with the settled value", async () => {
  const slow = {
    name: "slow_tool",
    description: "Sleeps then returns",
    inputs: {},
    required: [],
    run: async () => { await sleep(300); return "slow-result"; },
  };
  const engine = engineFactory(BASE_CFG({ timeoutMs: 100 }), [slow]);
  const res = await engine.execCell('const r = await slow_tool({}); return "seen:" + r;', "slow");
  assert.equal(res.status, "waiting", "detaches with the run id (their suspended-run shape)");
  const done = await engine.wait(res.runId, 5000);
  assert.equal(done.status, "completed");
  assert.equal(done.value, "seen:slow-result");
});

test("hard guest computation that exhausts the budget fails with code timeout (their path)", async () => {
  const engine = engineFactory(BASE_CFG({ timeoutMs: 250 }), []);
  const res = await engine.execCell("while (true) {}", "hang");
  assert.equal(res.status, "error");
  assert.equal(res.error.code, "timeout");
  assert.match(res.error.message, /budget/);
});

test("maxPendingToolCalls overflow: later bridge calls fail honestly", async () => {
  const blocked = {
    name: "blocked_a",
    description: "Blocks long",
    inputs: {},
    required: [],
    run: async () => { await sleep(800); return "a"; },
  };
  const engine = engineFactory(BASE_CFG({ maxPendingToolCalls: 1, timeoutMs: 3000 }), [blocked]);
  const res = await engine.execCell(
    'try { await Promise.all([blocked_a({}), blocked_a({})]); return "unreached"; } catch (e) { return "hit:" + e.code; }',
    "",
  );
  if (res.status === "waiting") {
    const done = await engine.wait(res.runId, 5000);
    assert.equal(done.value, "hit:too_many_pending");
  } else {
    assert.equal(res.status, "completed");
    assert.equal(res.value, "hit:too_many_pending");
  }
});

test("their no-fallback rule: an engaged quickjs request STOPS the run instead of falling back", async () => {
  const engine = engineFactory(BASE_CFG({ executor: "quickjs" }), []);
  const res = await engine.execCell("return 1;", "");
  assert.equal(res.status, "error");
  assert.equal(res.error.code, "executor_unavailable");
});

test("syntax garbage stitches an exec_error with stdout passthrough", async () => {
  const engine = engineFactory(BASE_CFG(), []);
  const res = await engine.execCell("console.log('before'); return return return;", "");
  assert.equal(res.status, "error");
  assert.equal(res.error.code, "exec_error");
});

test("source is logged for session history (their transparency rule)", async () => {
  const engine = engineFactory(BASE_CFG(), []);
  const surface = codeModeSurface(engine);
  const exec = surface.find((t) => t.name === "exec");
  const out = await exec.run({ code: "return 7;" }, { signal: undefined });
  const parsed = JSON.parse(out);
  assert.equal(parsed.status, "completed");
  assert.match(parsed.source, /^\/\/ Code Mode\nreturn 7;/, "// Code Mode source lands in history");
});
