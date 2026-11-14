// Execution failure labeling and technical timeout bounds for direct shell runs.
import { test } from "node:test";
import assert from "node:assert/strict";

const { explainExecError, isToolFailure, resolveExecTimeout, emptyConfig, buildRegistry } = await import("../dist/lib.js");

const cwd = process.cwd();
const ctx = { cwd, timeoutMs: 1000, cmdline: "git fetch", hadOutput: false };

test("exec tool labels failed commands, timeouts, and successful output", async () => {
  const config = emptyConfig();
  const exec = buildRegistry(config).find((tool) => tool.name === "exec");
  assert.ok(exec);

  const success = await exec.run({ command: "printf plain" }, { config, workspace: cwd });
  assert.equal(success, "plain");
  assert.equal(isToolFailure(success), false);

  const failure = await exec.run({ command: "exit 9" }, { config, workspace: cwd });
  assert.match(failure, /\[exit 9\]/);
  assert.match(failure, /exit 9/);
  assert.equal(isToolFailure(failure), true);

  const timed = await exec.run({ command: "sleep 5", timeoutMs: 100 }, { config, workspace: cwd });
  assert.match(timed, /\[timeout\]/);
  assert.match(timed, /100 ms/);
  assert.equal(isToolFailure(timed), true);
});

test("timeout resolution applies the configured cap and safe floor", () => {
  assert.deepEqual(resolveExecTimeout(9_999_999, 1_800_000), {
    ms: 1_800_000,
    note: "[timeout: 9999999 ms requested — capped at 1800000 ms]",
  });
  assert.equal(resolveExecTimeout(0, 600_000).ms, 600_000);
  assert.equal(resolveExecTimeout(undefined, 600_000).note, null);
  assert.equal(resolveExecTimeout(1, 600_000).ms, 100);
  assert.equal(resolveExecTimeout(Number.NaN, 600_000).ms, 600_000);
  assert.equal(resolveExecTimeout(undefined, undefined).ms, 1_800_000);
  assert.equal(resolveExecTimeout(5000, Number.NaN).ms, 5000);
});

test("Node process failures are converted to useful, command-specific text", () => {
  assert.match(explainExecError({ code: "ENOENT", path: "/usr/bin/git" }, ctx), /not found.*PATH/);
  assert.match(explainExecError({ code: "EACCES", path: "/usr/bin/git" }, ctx), /permission denied/);
  assert.match(explainExecError({ code: "ENOEXEC" }, ctx), /not an executable program/);
  assert.match(explainExecError({ killed: true, signal: "SIGTERM", code: null }, ctx), /timeout.*1000 ms/);
  assert.match(explainExecError({ signal: "SIGKILL", code: null }, ctx), /killed by SIGKILL/);
  assert.match(explainExecError({ code: 2 }, ctx), /\[exit 2\] git fetch/);
  assert.equal(explainExecError(null, ctx), null, "success is not a failure");
});

test("the loop recognizes only real failure markers", () => {
  assert.equal(isToolFailure("error: action failed"), true);
  assert.equal(isToolFailure("hi\n[exit 1] /bin/false"), true);
  assert.equal(isToolFailure("[cannot run] x — not found"), true);
  assert.equal(isToolFailure("[timeout] sleep 5 — killed after 250 ms"), true);
  assert.equal(isToolFailure("hello\n[exit 0] never happens"), false);
  assert.equal(isToolFailure("plain output"), false);
  assert.equal(isToolFailure("a line mentions [exit 1] inside text"), false);
});
