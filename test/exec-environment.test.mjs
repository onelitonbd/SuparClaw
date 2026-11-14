// "exec returns exit 1 with no output on EVERY command." — and, later, the
// device itself: "sandbox লাগবেই না, direct Termux use korte dao".
//
// The sandbox used to rebuild the invocation (env scrub, prlimit caps, a proot
// jail). Each layer was a way for a phone to fail before the command existed,
// and none of them was a boundary — the daemon already runs as the operator.
// Task 57 deleted it, so this file now pins the opposite: the tool runs the
// operator's own shell in the operator's own environment, and `sc doctor`
// proves it with a real round-trip.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, chmodSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "sc-exec-env-"));
process.env.SUPARCLAW_HOME = HOME;
const WS = join(HOME, ".suparclaw", "workspace");
mkdirSync(WS, { recursive: true });
mkdirSync(join(HOME, ".suparclaw"), { recursive: true });

const {
  emptyConfig,
  buildRegistry,
  findShell,
  runPlan,
  execSelfTest,
  runDoctorChecks,
} = await import("../dist/lib.js");

const ROOT = new URL("..", import.meta.url).pathname;

/** A throwaway $PREFIX whose bin/ contains only the files we name. */
function fakePrefix(files) {
  const dir = mkdtempSync(join(tmpdir(), "sc-prefix-"));
  mkdirSync(join(dir, "bin"), { recursive: true });
  for (const [name, mode] of Object.entries(files)) {
    const p = join(dir, "bin", name);
    writeFileSync(p, "#!/bin/sh\nexit 0\n");
    chmodSync(p, mode);
  }
  return dir;
}

/** withPrefix runs fn with $PREFIX pointed at a throwaway tree, then restores. */
async function withPrefix(dir, fn) {
  const before = process.env["PREFIX"];
  const beforePath = process.env["PATH"];
  process.env["PREFIX"] = dir;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env["PREFIX"];
    else process.env["PREFIX"] = before;
    process.env["PATH"] = beforePath;
  }
}

/* ------------------------------------------------------------------ PATH --- */

/* ------------------------------------------------------------- no jail --- */

test("direct exec does not invoke wrapper binaries", async () => {
  // Fake wrapper binaries would mark the filesystem if the exec path invoked them.
  const prefix = fakePrefix({ prlimit: 0o755, proot: 0o755 });
  const marker = join(HOME, "wrapper-ran.txt");
  for (const name of ["prlimit", "proot"]) {
    writeFileSync(join(prefix, "bin", name), `#!/bin/sh\necho ${name} >> ${marker}\nexit 97\n`);
    chmodSync(join(prefix, "bin", name), 0o755);
  }
  const cfg = emptyConfig();
  cfg.tools.exec.enabled = true;
  const exec = buildRegistry(cfg).find((t) => t.name === "exec");
  const out = await withPrefix(prefix, () => exec.run({ command: "echo alive" }, { workspace: WS }));

  assert.match(out, /alive/, "the command ran");
  assert.ok(!existsSync(marker), "no prlimit or proot wrapper ran");
  assert.doesNotMatch(out, /sandbox|jail|prlimit|proot/i, "the result contains no retired wrapper or policy copy");
});

test("the child is the operator's own environment, not a scrubbed copy", async () => {
  // HOME=workspace + `env -i` was how `gh`, `pkg` and a user's `.bashrc` stopped
  // existing. Direct Termux means the same HOME and the same PATH the daemon has.
  process.env["SC_DIRECT_TEST"] = "42";
  try {
    const cfg = emptyConfig();
    cfg.tools.exec.enabled = true;
    const exec = buildRegistry(cfg).find((t) => t.name === "exec");
    const out = await exec.run({ command: 'printf "%s|%s" "$SC_DIRECT_TEST" "$HOME"' }, { workspace: WS });
    assert.match(out, /^42\|/, "an inherited variable arrives");
    assert.ok(out.includes(process.env["HOME"]), "HOME is the operator's, not the workspace");
  } finally {
    delete process.env["SC_DIRECT_TEST"];
  }
});

/* -------------------------------------------------------------- wrappers --- */

test("a command that writes is still run exactly ONCE", async () => {
  // Retrying is for a dead *environment*, never for a command — running a
  // side effect twice would be a far worse bug than a bad message.
  const counter = join(HOME, "count.txt");
  writeFileSync(counter, "");
  const cfg = emptyConfig();
  cfg.tools.exec.enabled = true;
  const exec = buildRegistry(cfg).find((t) => t.name === "exec");
  await exec.run({ command: `echo x >> ${counter}` }, { workspace: WS });
  assert.equal(readFileSync(counter, "utf8"), "x\n", "one line — one execution");
});

test("a FAILING command is not retried and does not claim a fallback", async () => {
  const cfg = emptyConfig();
  cfg.tools.exec.enabled = true;
  const exec = buildRegistry(cfg).find((t) => t.name === "exec");
  const out = await exec.run({ command: "exit 9" }, { workspace: WS });
  assert.match(out, /\[exit 9\]/);
  assert.doesNotMatch(out, /WITHOUT the jail|\[exec:/, "a normal failure is not dressed up as an environment rescue");
});

/* ---------------------------------------------------------------- doctor --- */

test("`sc doctor` runs a real command, not just the policy", async () => {
  const cfg = emptyConfig();
  cfg.tools.exec.enabled = true;
  const live = await execSelfTest(cfg.tools.exec);
  assert.equal(live.name, "exec run");
  assert.equal(live.status, "ok", `a healthy tree must pass: ${live.detail}`);
  assert.match(live.detail, /round-trip in \d+ ms/);
  assert.match(live.detail, /round-trip in \d+ ms.*shell \//);
});

test("`sc doctor` fails, and says why, when the shell itself cannot be started", async () => {
  // No wrapper to blame here: the binary the whole tool depends on is the one
  // that will not start. findShell() prefers $PREFIX/bin/bash, so a present but
  // unexecutable one is exactly the "every command fails" shape without a jail.
  const prefix = fakePrefix({ bash: 0o644 });
  const live = await withPrefix(prefix, () =>
    execSelfTest({ timeoutMs: 5000 }),
  );
  assert.equal(live.status, "fail");
  assert.match(live.detail, /cannot be started \(EACCES\)/);
  assert.match(live.detail, /every command fails/);
  assert.ok(live.fix);
});

test("the doctor check list carries the live exec result", async () => {
  const checks = await runDoctorChecks({ insideGateway: true });
  const live = checks.find((c) => c.name === "exec run");
  assert.ok(live, "runDoctorChecks must include the live exec probe");
  assert.ok(["ok", "warn", "fail"].includes(live.status));
  assert.match(live.detail, /round-trip|started|could not/);
});

/* -------------------------------------------------------- runPlan contract --- */

test("runPlan reports the failing binary only for spawn failures", async () => {
  const fake = (err) => (_bin, _args, _opts, cb) => cb(err, "", "");
  const missing = await runPlan(fake({ code: "ENOENT", path: "/no/such/bin", message: "spawn x ENOENT" }), ["/no/such/bin"], {}, {
    cwd: ROOT,
    timeoutMs: 1000,
    cmdline: "x",
  });
  assert.equal(missing.failedPath, "/no/such/bin");
  assert.equal(missing.failedCode, "ENOENT");
  assert.match(missing.output, /not found/);

  const exited = await runPlan(fake({ code: 3, message: "Command failed" }), ["/bin/x"], {}, {
    cwd: ROOT,
    timeoutMs: 1000,
    cmdline: "x",
  });
  assert.equal(exited.failedPath, undefined, "a command that ran and failed is not a spawn failure");
  assert.match(exited.output, /\[exit 3\]/);
});
