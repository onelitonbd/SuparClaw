// Task 56 — exec must survive a broken environment.
//
// The report was "killed by the sandbox (SIGABRT)" followed by "you run `gh` and
// paste the output". A SIGABRT before the command prints anything is the
// *environment* dying — a login rc that aborts, an `LD_PRELOAD` pointing at a
// library that moved, a wrapper that exists but cannot run — and the old exec
// tried exactly one strategy: `bash -lc`, then report whatever came back.
//
// These tests pin the ladder and, more importantly, the retry rule: only a
// child that printed nothing is retried, and a timeout never is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { execAttempts, fallbackNote, runWithFallback, scrubLoaderEnv, shouldRetryAfter, posixShells } = await import("../dist/lib.js");

const PLANNED = { argv: ["/bin/bash", "-lc", "gh repo list"], env: { PATH: "/usr/bin", HOME: "/w" }, wrappers: [] };
const attempt = (label, argv) => ({ label, argv, env: PLANNED.env });

test("the ladder starts with the planned shell and ends with a clean posix shell", () => {
  const list = execAttempts({ shell: "/bin/bash", command: "gh repo list", planned: PLANNED });
  assert.equal(list[0].argv[0], "/bin/bash");
  assert.deepEqual(list[0].argv.slice(1), ["-lc", "gh repo list"], "the planned invocation is untouched");
  assert.ok(
    list.some((a) => a.argv.includes("-c") && !a.argv.includes("-lc")),
    "a no-login-files rung exists — a broken .bashrc is the classic SIGABRT",
  );
  for (const a of list.slice(1)) {
    assert.equal(a.argv[a.argv.length - 2], "-c");
    assert.equal(a.argv[a.argv.length - 1], "gh repo list", "every rung runs the same command");
  }
});

test("the last rung scrubs loader variables that abort children", () => {
  const env = scrubLoaderEnv({ PATH: "/usr/bin", HOME: "/w", LD_PRELOAD: "/gone/libtermux-exec.so", LD_LIBRARY_PATH: "/gone" });
  assert.equal(env["LD_PRELOAD"], undefined);
  assert.equal(env["LD_LIBRARY_PATH"], undefined);
  assert.equal(env["PATH"], "/usr/bin", "PATH survives — the command needs it");
  assert.equal(env["HOME"], "/w");
});

test("a wrapper failure adds its own rung and duplicate invocations are dropped", () => {
  const wrapped = execAttempts({
    shell: "/bin/bash",
    command: "echo hi",
    planned: { argv: ["prlimit", "--as=1", "--", "/bin/bash", "-lc", "echo hi"], env: {}, wrappers: ["/usr/bin/prlimit"] },
  });
  assert.equal(wrapped[0].label, "the planned shell");
  assert.match(wrapped[1].label, /without prlimit/, "the un-wrapped login shell is rung two");
  const argvJoin = wrapped.map((a) => a.argv.join(" "));
  assert.equal(new Set(argvJoin).size, argvJoin.length, "no rung repeats another");
});

test("posixShells only names shells that exist here", () => {
  for (const sh of posixShells()) assert.ok(sh.startsWith("/"), sh);
});

test("the retry rule: environment failures retry, the command's own do not", () => {
  assert.equal(shouldRetryAfter({ stdout: "", signal: "SIGABRT" }), true, "SIGABRT with nothing printed");
  assert.equal(shouldRetryAfter({ stdout: "partial", signal: "SIGABRT" }), false, "it printed — its failure is its own");
  assert.equal(shouldRetryAfter({ stdout: "", exitCode: 127 }), true, "could not even find the command");
  assert.equal(shouldRetryAfter({ stdout: "", exitCode: 126 }), true, "not executable");
  assert.equal(shouldRetryAfter({ stdout: "", exitCode: 1 }), false, "a real non-zero exit is not an environment problem");
  assert.equal(shouldRetryAfter({ stdout: "", timedOut: true }), false, "a timeout is never retried — that repeats the work");
  assert.equal(shouldRetryAfter({ stdout: "", spawnFailed: true }), true);
  assert.equal(shouldRetryAfter({ stdout: "output" }), false);
});

test("a dead login shell falls through to the next rung and says so", async () => {
  const attempts = [attempt("the planned shell", ["/bin/bash", "-lc", "echo ok"]), attempt("sh -c (clean env)", ["/bin/sh", "-c", "echo ok"])];
  const calls = [];
  const result = await runWithFallback(attempts, async (a) => {
    calls.push(a.label);
    if (a.label === "the planned shell") return { outcome: { stdout: "", signal: "SIGABRT" }, output: "[signal] killed by SIGABRT" };
    return { outcome: { stdout: "ok\n" }, output: "ok" };
  });
  assert.deepEqual(calls, ["the planned shell", "sh -c (clean env)"], "the second rung ran");
  assert.equal(result.output, "ok", "and its answer is what the model gets");
  assert.equal(result.used.label, "sh -c (clean env)");
  assert.equal(result.ran, true);

  const note = fallbackNote(result, attempts[0]);
  assert.match(note, /killed by SIGABRT before printing anything/);
  assert.match(note, /ran with sh -c \(clean env\) instead/);
  assert.match(note, /do not ask the user to run anything/);
});

test("when every rung fails the model is told to say so, not to delegate", async () => {
  const attempts = [attempt("the planned shell", ["/bin/bash", "-lc", "gh repo list"]), attempt("sh -c (clean env)", ["/bin/sh", "-c", "gh repo list"])];
  const result = await runWithFallback(attempts, async (a) => ({
    outcome: a.label === "the planned shell" ? { stdout: "", signal: "SIGABRT" } : { stdout: "", exitCode: 127 },
    output: "[signal] killed",
  }));
  assert.equal(result.ran, false);
  const note = fallbackNote(result, attempts[0]);
  assert.match(note, /every shell failed/);
  assert.match(note, /instead of\s+asking the user to run the command and paste the output/);
  assert.match(note, /If another tool can do the job, use it/);
});

test("a first-try success says nothing extra", async () => {
  const attempts = [attempt("the planned shell", ["/bin/bash", "-lc", "echo ok"])];
  const result = await runWithFallback(attempts, async () => ({ outcome: { stdout: "ok\n" }, output: "ok" }));
  assert.equal(fallbackNote(result, attempts[0]), "", "no noise in the normal case");
});

/** Real `execFile`, so the ladder is proven against a real signal. */
function realRun(argv, env) {
  return new Promise((resolve) => {
    const [bin, ...rest] = argv;
    execFile(bin, rest, { env, timeout: 10_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve({
        outcome: {
          stdout: stdout ?? "",
          signal: typeof err?.signal === "string" ? err.signal : null,
          exitCode: typeof err?.code === "number" ? err.code : err ? null : 0,
          timedOut: Boolean(err?.killed && err?.signal),
        },
        output: (stdout ?? "").trim() || (err ? `[signal] ${err.signal ?? err.code}` : "(no output)"),
      });
    });
  });
}

test("a shell that aborts on login flags is rescued by the next rung (real process)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-execfb-"));
  const fake = join(dir, "fakebash");
  // A login shell that dies before reading the command — the Termux symptom.
  writeFileSync(fake, '#!/bin/sh\ncase "$1" in -l*) kill -ABRT $$ ;; esac\nexec /bin/sh "$@"\n');
  chmodSync(fake, 0o755);

  const attempts = [
    { label: "the planned shell", argv: [fake, "-lc", "echo real-ok"], env: process.env },
    { label: "sh -c (no login files)", argv: [fake, "-c", "echo real-ok"], env: process.env },
  ];
  const result = await runWithFallback(attempts, (a) => realRun(a.argv, a.env));

  assert.equal(result.used.label, "sh -c (no login files)");
  assert.equal(result.output, "real-ok", "the command really ran on the second rung");
  assert.match(result.reasons[0], /SIGABRT/);
});

test("the exec tool itself still runs a plain command with no extra noise", async () => {
  const { buildRegistry, emptyConfig } = await import("../dist/lib.js");
  const spec = buildRegistry(emptyConfig()).find((t) => t.name === "exec");
  const out = await spec.run(
    { command: "echo tool-ok" },
    { workspace: process.cwd(), approved: true, log: { info() {}, warn() {}, error() {} } },
  );
  assert.match(out, /tool-ok/);
  assert.doesNotMatch(out, /\[exec:/, "a first-try success says nothing extra");
});
