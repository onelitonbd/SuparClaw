// "exec returns exit 1 with no output on EVERY command."
//
// The previous fix made failures explain themselves. This file is about the
// other half of that report: the commands were genuinely failing, for two
// reasons that live in our own sandbox — and neither was visible anywhere.
//
//   1. strict mode rebuilt PATH from three hard-coded directories. On any
//      install whose tools live elsewhere (Homebrew on macOS, nvm, asdf, nix,
//      guix, snap) every command that is not a coreutils binary dies with
//      "command not found" — for every command, forever.
//   2. prlimit and proot were picked by `existsSync`. A binary that exists but
//      cannot run (not executable, missing loader) made the wrapper fail to
//      spawn, so the command never started. Again: every command, forever.
//
// Both are fixed here, and `sc doctor` now runs a real command so the next
// report of this kind comes with a cause attached.

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
  sandboxEnv,
  planSandbox,
  emptyConfig,
  buildRegistry,
  runPlan,
  findShell,
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

test("the sandbox keeps the PATH the install actually uses", () => {
  const beforePath = process.env["PATH"];
  const home = homedir();
  process.env["PATH"] = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", `${home}/.local/bin`].join(":");
  try {
    const env = sandboxEnv(WS, ["/bin", "/usr/bin"]);
    const dirs = env["PATH"].split(":");
    assert.ok(dirs.includes("/opt/homebrew/bin"), "Homebrew tools must stay reachable — this was the bug");
    assert.ok(dirs.includes("/usr/local/bin"));
    assert.ok(!dirs.includes(`${home}/.local/bin`), "user-home binaries stay out of the child (that is the scrub)");
    // trusted dirs still come first: the policy resolves safe bins from them
    assert.deepEqual(dirs.slice(0, 2), ["/bin", "/usr/bin"]);
    assert.equal(env["HOME"], WS, "HOME is still the workspace");
  } finally {
    process.env["PATH"] = beforePath;
  }
});

test("the sandbox PATH is deduped and still has Termux's $PREFIX/bin", async () => {
  const prefix = fakePrefix({ bash: 0o755 });
  await withPrefix(prefix, () => {
    // $PREFIX/bin also appears in the parent PATH here — it must appear once
    process.env["PATH"] = `${prefix}/bin:/usr/bin:/bin`;
    const dirs = sandboxEnv(WS, ["/bin", "/usr/bin"])["PATH"].split(":");
    assert.equal(dirs.filter((d) => d === `${prefix}/bin`).length, 1);
    assert.ok(dirs.includes("/bin"));
  });
});

/* -------------------------------------------------------------- wrappers --- */

test("a sandbox wrapper that cannot start does not kill the command", async () => {
  const prefix = fakePrefix({ prlimit: 0o644 }); // exists, not executable
  const cfg = emptyConfig();
  cfg.tools.exec.enabled = true;
  cfg.tools.exec.sandbox = "strict";
  const exec = buildRegistry(cfg).find((t) => t.name === "exec");
  const out = await withPrefix(prefix, () => exec.run({ command: "echo alive" }, { workspace: WS, approved: true }));

  assert.match(out, /alive/, "the command still ran — every command used to fail here");
  assert.match(out, /could not be started \(EACCES\)/);
  assert.match(out, /WITHOUT the jail/, "and it says the sandbox was not applied");
  assert.ok(out.includes(`${prefix}/bin/prlimit`), "naming the wrapper that broke");
});

test("the fallback runs the command exactly ONCE", async () => {
  // The retry must fire on a broken *wrapper*, never on a failing command:
  // running a command twice would be a far worse bug than a bad message.
  const prefix = fakePrefix({ prlimit: 0o644 });
  const counter = join(HOME, "count.txt");
  writeFileSync(counter, "");
  const cfg = emptyConfig();
  cfg.tools.exec.enabled = true;
  cfg.tools.exec.sandbox = "strict";
  const exec = buildRegistry(cfg).find((t) => t.name === "exec");
  await withPrefix(prefix, () =>
    exec.run({ command: `echo x >> ${counter}` }, { workspace: WS, approved: true }),
  );
  assert.equal(readFileSync(counter, "utf8"), "x\n", "one line — one execution");
});

test("a FAILING command is not retried and does not claim a fallback", async () => {
  const cfg = emptyConfig();
  cfg.tools.exec.enabled = true;
  cfg.tools.exec.sandbox = "strict";
  const exec = buildRegistry(cfg).find((t) => t.name === "exec");
  const out = await exec.run({ command: "exit 9" }, { workspace: WS, approved: true });
  assert.match(out, /\[exit 9\]/);
  assert.doesNotMatch(out, /WITHOUT the jail/, "a normal failure is not a sandbox fallback");
});

test("planSandbox names its wrappers and keeps the unwrapped argv", () => {
  const plan = planSandbox([findShell(), "-lc", "echo hi"], WS, {
    sandbox: "strict",
    sandboxProot: false,
    safeBinTrustedDirs: ["/bin"],
  });
  assert.deepEqual(plan.plainArgv, [findShell(), "-lc", "echo hi"], "the fallback needs the plain shell");
  for (const w of plan.wrappers) assert.ok(plan.argv.includes(w), `${w} is declared but not in argv`);

  const off = planSandbox([findShell(), "-lc", "echo hi"], WS, { sandbox: "off", sandboxProot: false, safeBinTrustedDirs: [] });
  assert.deepEqual(off.wrappers, [], "off mode adds no wrappers");
  assert.deepEqual(off.plainArgv, off.argv);
});

/* ---------------------------------------------------------------- doctor --- */

test("`sc doctor` runs a real command, not just the policy", async () => {
  const cfg = emptyConfig();
  cfg.tools.exec.enabled = true;
  const live = await execSelfTest(cfg.tools.exec);
  assert.equal(live.name, "exec run");
  assert.equal(live.status, "ok", `a healthy tree must pass: ${live.detail}`);
  assert.match(live.detail, /round-trip in \d+ ms/);
  assert.match(live.detail, /sandbox: off|sandbox: strict/);
});

test("`sc doctor` names the wrapper when the sandbox degraded", async () => {
  const prefix = fakePrefix({ prlimit: 0o644 });
  const cfg = emptyConfig();
  cfg.tools.exec.enabled = true;
  cfg.tools.exec.sandbox = "strict";
  const live = await withPrefix(prefix, () => execSelfTest(cfg.tools.exec));
  assert.equal(live.status, "warn", "commands still run — that is a warning, not a failure");
  assert.match(live.detail, /cannot be started \(EACCES\)/);
  assert.match(live.fix ?? "", /chmod \+x/);
});

test("`sc doctor` fails, and says why, when the shell itself cannot be started", async () => {
  // No wrapper to blame here: the binary the whole tool depends on is the one
  // that will not start. findShell() prefers $PREFIX/bin/bash, so a present but
  // unexecutable one is exactly the "every command fails" shape without a jail.
  const prefix = fakePrefix({ bash: 0o644 });
  const live = await withPrefix(prefix, () =>
    execSelfTest({ sandbox: "off", sandboxProot: false, safeBinTrustedDirs: [], timeoutMs: 5000 }),
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
