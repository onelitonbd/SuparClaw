// Task 57 — "sandbox লাগবেই না, ai ke direct termux use korte dao".
//
// The sandbox was not a small extra: `strict` rebuilt the whole invocation
// (env scrub + prlimit caps + a proot jail). On a phone each of those is a way
// to fail before the command exists, and the SIGABRT they produced was
// reported — accurately, from the daemon's seat — as the operator's problem.
//
// The guarantee here is structural, not a default: there is no code path left
// that can wrap a command, so no config can bring the jail back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "sc-exec-direct-"));
process.env.SUPARCLAW_HOME = HOME;
const WS = join(HOME, "ws");
mkdirSync(WS, { recursive: true });

const { emptyConfig, buildRegistry, parseConfig } = await import("../dist/lib.js");

test("the sandbox module and its exports are gone", () => {
  assert.equal(existsSync(join(process.cwd(), "src/agent/exec-sandbox.ts")), false, "no planner to call");
  // `dist/lib.js` must not keep exporting the removed API either: an export is
  // a promise, and this one would be false.
  return import("../dist/lib.js").then((lib) => {
    assert.equal(lib.planSandbox, undefined);
    assert.equal(lib.sandboxEnv, undefined);
    assert.equal(lib.findPrlimit, undefined);
  });
});

test("legacy exec policy and sandbox keys are discarded during config migration", () => {
  const { config, errors } = parseConfig({ tools: { exec: { enabled: true, timeoutMs: 60000, mode: "deny", approvals: true, safeBins: ["echo"], sandbox: "strict", sandboxProot: true } } });
  assert.deepEqual(errors, []);
  assert.deepEqual(Object.keys(config.tools.exec).sort(), ["enabled", "timeoutMs"]);
});

test("exec runs in the session workspace", async () => {
  const cfg = emptyConfig();
  cfg.tools.exec.enabled = true;
  const exec = buildRegistry(cfg).find((t) => t.name === "exec");
  const out = await exec.run({ command: "pwd" }, { workspace: WS });
  assert.ok(out.includes(WS), `expected the workspace in "${out.slice(0, 200)}"`);
});

test("a login file that aborts the shell does not take the command with it", { skip: !existsSync("/bin/sh") }, async () => {
  // This is the phone case that started it all: `.profile`/`LD_PRELOAD` dies
  // during startup, the command never runs, and the old code reported it as the
  // command's failure. The ladder retries with `-c` (no profile) instead.
  const fakeHome = mkdtempSync(join(tmpdir(), "sc-home-"));
  writeFileSync(join(fakeHome, ".bash_profile"), "# abort during startup, like a broken Termux rc\nkill -ABRT $$\n");
  const before = process.env["HOME"];
  process.env["HOME"] = fakeHome;
  try {
    const cfg = emptyConfig();
    cfg.tools.exec.enabled = true;
    const exec = buildRegistry(cfg).find((t) => t.name === "exec");
    const out = await exec.run({ command: "echo survived" }, { workspace: WS });
    assert.match(out, /survived/, `the command must run on a later rung: ${out.slice(0, 300)}`);
  } finally {
    if (before === undefined) delete process.env["HOME"];
    else process.env["HOME"] = before;
  }
});
