// "exec returns exit 1 with no output on every command."
//
// That report is reproducible here, four ways, and every one of them produced
// the same useless string: `[exit 1]`. The cause is always the same shape —
// Node hands a failure back with an empty stdout, an empty stderr and either a
// string code (spawn failed), a null code (killed) or a plain number (exited
// non-zero), and the old code printed `[exit N]` and threw the error away.
//
// These tests pin the *reason*, not just "something changed": a missing binary,
// a missing working directory, a timeout and a quiet exit must each say which
// one they are, in words, with the command that ran.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "sc-exec-fail-"));
process.env.SUPARCLAW_HOME = HOME;
mkdirSync(join(HOME, ".suparclaw"), { recursive: true });

const {
  runDirectChain,
  explainExecError,
  isToolFailure,
  resolveExecTimeout,
  emptyConfig,
  buildRegistry,
  AgentLoop,
  Store,
  createLogger,
} = await import("../dist/lib.js");

const ROOT = new URL("..", import.meta.url).pathname;
const seg = (argv, resolved = argv[0]) => [{ argv, argv0: argv[0], resolvedPath: resolved, matched: "manual" }];
const run = (segments, opts = {}) => runDirectChain(segments, [], { cwd: ROOT, timeoutMs: 10_000, ...opts });

/* ---------------------------------------------------------------- direct --- */

test("a binary that is not there is named — not reported as exit 1", async () => {
  const out = (await run(seg(["/nope/definitely-not-here", "x"]))).output;
  assert.notEqual(out.trim(), "[exit 1]", "the bare exit code is the bug");
  assert.match(out, /\[cannot run\]/);
  assert.match(out, /not found/, "says what is wrong");
  assert.match(out, /\/nope\/definitely-not-here/, "names the binary");
  assert.ok(isToolFailure(out), "and the transcript can tell it failed");
});

test("a missing workspace is reported as a missing workspace, not a missing shell", async () => {
  const gone = join(tmpdir(), `sc-gone-${Date.now()}`);
  const out = (await run(seg(["/bin/echo", "hi"]), { cwd: gone })).output;
  // Node's error here is ENOENT on /bin/echo — the old text blamed the binary.
  assert.match(out, /working directory/);
  assert.ok(out.includes(gone), "quotes the directory that is gone");
  assert.doesNotMatch(out, /was not found/, "never blames the program for a missing cwd");
  assert.ok(isToolFailure(out));
});

test("a timeout says it timed out, and how long it waited", async () => {
  const out = (await run(seg(["/bin/sh", "-c", "sleep 5"]), { timeoutMs: 250 })).output;
  assert.match(out, /\[timeout\]/);
  assert.match(out, /250 ms/);
  assert.doesNotMatch(out, /\[exit 1\]/);
  assert.ok(isToolFailure(out));
});

test("a quiet non-zero exit carries the command and says it printed nothing", async () => {
  const out = (await run(seg(["/bin/sh", "-c", "exit 3"]))).output;
  assert.match(out, /\[exit 3\]/);
  assert.match(out, /printed nothing/);
  assert.ok(out.includes("/bin/sh -c exit 3"), "the command is in the message");
  assert.ok(isToolFailure(out));
});

test("a failing command that did print keeps its output and the exit code", async () => {
  const out = (await run(seg(["/bin/sh", "-c", "echo boom; exit 2"]))).output;
  assert.match(out, /boom/);
  assert.match(out, /\[exit 2\]/);
  assert.doesNotMatch(out, /printed nothing/);
});

test("a file that is not executable says permission denied", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-noexec-"));
  const file = join(dir, "not-a-program");
  writeFileSync(file, "hello\n");
  chmodSync(file, 0o644);
  const out = (await run(seg([file]))).output;
  assert.match(out, /\[cannot run\]/);
  assert.match(out, /not executable|permission denied/i);
  assert.ok(out.includes(file));
});

test("an empty command never claims to have exited 1", async () => {
  const out = (await runDirectChain([], [], { cwd: ROOT, timeoutMs: 5000 })).output;
  assert.match(out, /^error:/, "an empty command is our error, not the child's");
  assert.match(out, /empty/);
  assert.doesNotMatch(out, /\[exit 1\]/);
});

test("a successful command is untouched — no decoration, no tags", async () => {
  const out = (await run(seg(["/bin/echo", "plain"]))).output;
  assert.equal(out, "plain\n");
  assert.equal(isToolFailure(out), false);
});

test("&& stops after a failure, || and ; still behave (Task 43 semantics kept)", async () => {
  const a = await runDirectChain(
    [...seg(["/bin/false"]), ...seg(["/bin/echo", "after"])],
    ["&&"],
    { cwd: ROOT, timeoutMs: 5000 },
  );
  assert.doesNotMatch(a.output, /after/, "&& must not run the next segment after a failure");

  const b = await runDirectChain(
    [...seg(["/bin/false"]), ...seg(["/bin/echo", "fallback"])],
    ["||"],
    { cwd: ROOT, timeoutMs: 5000 },
  );
  assert.match(b.output, /fallback/, "|| runs the fallback");

  const c = await runDirectChain(
    [...seg(["/bin/false"]), ...seg(["/bin/echo", "anyway"])],
    [";"],
    { cwd: ROOT, timeoutMs: 5000 },
  );
  assert.match(c.output, /anyway/, "; always continues");
});

/* ---------------------------------------------------------------- shell ---- */

function execTool() {
  const cfg = emptyConfig();
  cfg.tools.exec.enabled = true;
  return buildRegistry(cfg).find((t) => t.name === "exec");
}

test("the shell route explains a missing workspace the same way", async () => {
  const gone = join(tmpdir(), `sc-gone-${Date.now()}`);
  const out = await execTool().run({ command: "echo hi" }, { workspace: gone, approved: true });
  assert.match(out, /working directory/);
  assert.ok(out.includes(gone));
  assert.doesNotMatch(out, /spawn .* ENOENT/, "the raw node message is not an answer");
  assert.ok(isToolFailure(out));
});

test("the shell route explains a timeout instead of 'Command failed'", async () => {
  const out = await execTool().run({ command: "sleep 5", timeoutMs: 250 }, { workspace: ROOT, approved: true });
  assert.match(out, /\[timeout\]/);
  assert.match(out, /250 ms/);
  assert.match(out, /sleep 5/, "names the command");
});

test("the shell route still returns plain output on success", async () => {
  const out = await execTool().run({ command: "echo shell-ok" }, { workspace: ROOT, approved: true });
  assert.equal(out, "shell-ok\n");
});

test("an empty command is refused before anything is spawned", async () => {
  const out = await execTool().run({ command: "   " }, { workspace: ROOT, approved: true });
  assert.match(out, /^error:/);
  assert.match(out, /empty/);
});

/* --------------------------------------------------------------- timeout --- */

test("a junk timeoutMs cannot break the call — it falls back to the config cap", async () => {
  // Number("soon") is NaN; execFile used to throw ERR_OUT_OF_RANGE on it, so
  // every exec call failed while the model kept sending that argument.
  for (const junk of ["soon", "5s", {}, [], true]) {
    const out = await execTool().run({ command: "echo still-works", timeoutMs: junk }, { workspace: ROOT, approved: true });
    assert.match(out, /still-works/, `timeoutMs=${JSON.stringify(junk)} broke exec`);
    assert.match(out, /\[timeout: .* not a positive number/, "and it says the value was ignored");
  }
});

test("timeoutMs is clamped to the 30-minute cap and never runs unbounded", () => {
  const cap = resolveExecTimeout(9_999_999, 1_800_000);
  assert.equal(cap.ms, 1_800_000);
  assert.match(cap.note ?? "", /capped at 1800000/);

  const zero = resolveExecTimeout(0, 600_000);
  assert.equal(zero.ms, 600_000, "0 is not 'kill immediately', and not 'run forever' either");
  assert.match(zero.note ?? "", /not a positive number/, "and the caller is told 0 was ignored");
  assert.equal(resolveExecTimeout(undefined, 600_000).note, null, "omitting it is normal — no note");

  const tiny = resolveExecTimeout(1, 600_000);
  assert.equal(tiny.ms, 100, "a 1 ms timeout would kill every command before it starts");
  assert.match(tiny.note ?? "", /floor/);

  const nan = resolveExecTimeout(Number.NaN, 600_000);
  assert.equal(nan.ms, 600_000);

  // the configured value itself cannot reintroduce NaN
  assert.equal(resolveExecTimeout(undefined, undefined).ms, 1_800_000);
  assert.equal(resolveExecTimeout(5000, Number.NaN).ms, 5000);
});

/* ----------------------------------------------------------------- class --- */

test("explainExecError maps each Node failure to words a model can act on", () => {
  const ctx = { cwd: ROOT, timeoutMs: 1000, cmdline: "git fetch", hadOutput: false };
  assert.match(explainExecError({ code: "ENOENT", path: "/usr/bin/git" }, ctx), /not found.*PATH/);
  assert.match(explainExecError({ code: "EACCES", path: "/usr/bin/git" }, ctx), /permission denied/);
  assert.match(explainExecError({ code: "ENOEXEC" }, ctx), /not an executable program/);
  assert.match(explainExecError({ killed: true, signal: "SIGTERM", code: null }, ctx), /timeout.*1000 ms/);
  assert.match(explainExecError({ signal: "SIGKILL", code: null }, ctx), /killed by SIGKILL/);
  assert.match(explainExecError({ code: 2 }, ctx), /\[exit 2\] git fetch/);
  assert.equal(explainExecError(null, ctx), null, "success is not a failure");
});

test("the red pill is decided in one place", () => {
  assert.equal(isToolFailure("error: user declined this action"), true);
  assert.equal(isToolFailure("hi\n[exit 1] /bin/false"), true);
  assert.equal(isToolFailure("[cannot run] x — not found"), true);
  assert.equal(isToolFailure("[timeout] sleep 5 — killed after 250 ms"), true);
  assert.equal(isToolFailure("hello\n[exit 0] never happens"), false, "exit 0 is never a failure tag");
  assert.equal(isToolFailure("plain output"), false);
  assert.equal(isToolFailure("a line that mentions [exit 1] inside text"), false, "only a whole tag counts");
});

/* ------------------------------------------------------- through the loop --- */

test("a failed command reaches the transcript as a red step that says why", async () => {
  // The end-to-end shape of the report: the model runs a command, it fails, and
  // what the operator sees must be a failed step with a reason — not a green
  // pill and not an empty string.
  // a real workspace: without one every exec correctly reports a stale cwd,
  // which is a different (also covered) failure path
  mkdirSync(join(HOME, ".suparclaw", "workspace"), { recursive: true });
  const store = Store.open(join(HOME, ".suparclaw", "exec-fail.sqlite"));
  let n = 0;
  const llm = {
    async *stream() {
      n += 1;
      if (n === 1) {
        yield { type: "tool_calls", calls: [{ id: "e1", name: "exec", args: JSON.stringify({ command: "exit 7" }) }] };
      } else {
        yield { type: "text", text: "The command failed, here is why." };
      }
      yield { type: "usage", usage: { total_tokens: 3 } };
    },
  };
  const events = [];
  const loop = new AgentLoop({ config: emptyConfig(), store, log: createLogger({ level: "error" }), llm });
  await loop.run({ sessionKey: "main:exec-fail", text: "go", onEvent: (e) => events.push(e) });

  const finished = events.find((e) => e.type === "tool" && e.name === "exec" && e.status !== "running");
  assert.equal(finished?.status, "error", "the step must be marked failed — this drives the red icon");
  assert.match(String(finished.detail), /\[exit 7\]/, "the pill's detail names the exit code");
  assert.match(String(finished.detail), /printed nothing/, "and says the command was silent");

  const session = store.getSessionByKey("main:exec-fail");
  const row = store.recentMessages(session.id, 20).find((r) => r.role === "tool" && String(r.content).includes("exit 7"));
  assert.ok(row, "the failure is persisted, so a reload still shows it");
  assert.match(String(row.content), /\[exit 7\] exit 7/);

  const final = events.find((e) => e.type === "final");
  assert.equal(final?.text, "The command failed, here is why.", "the turn still ends with an answer (Task 38)");
  store.close();
});
