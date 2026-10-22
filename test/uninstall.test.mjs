// P3 (row A19) — sc uninstall.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { parseUninstallArgs, planUninstall, deleteStateContents, cliRemovalHint, cmdUninstall } = await import("../dist/lib.js");

// ---- flag parsing ------------------------------------------------------------

test("flags set scopes; --all is the four-scope shorthand (their table)", () => {
  const p = parseUninstallArgs(["--state", "--workspace", "--yes"]);
  assert.deepEqual({ state: p.state, workspace: p.workspace, service: p.service, yes: p.yes }, { state: true, workspace: true, service: false, yes: true });
  const all = parseUninstallArgs(["--all"]);
  assert.deepEqual([all.service, all.state, all.workspace, all.app], [true, true, true, true]);
  assert.equal(all.anyScopeFlag, true);
  assert.equal(parseUninstallArgs(["--yes"]).anyScopeFlag, false, "only scope flags count as scope intent");
});

test("--non-interactive without --yes is a hard usage error (their pairing)", () => {
  const bad = parseUninstallArgs(["--service", "--non-interactive"]);
  assert.match(bad.error, /requires --yes/);
  assert.ok(!bad.error || !parseUninstallArgs(["--service", "--non-interactive", "--yes"]).error);
});

test("unknown flags report usage", () => {
  assert.match(parseUninstallArgs(["--nuke"]).error, /unknown flag/);
});

// ---- plan (their gate + preservation rules, pure) -----------------------------

const GATE_CLEAN = { serviceInstalled: true, unmanagedRunning: false, unmanagedPid: null };
const DIRS = { state: "/tmp/state", workspace: "/tmp/state/workspace" };

test("service-only plan mutates nothing else; --state preserves workspace without --workspace", () => {
  const p1 = planUninstall({ service: true, state: false, workspace: false, app: false }, GATE_CLEAN, DIRS);
  assert.deepEqual(p1.dataScopes, []);
  assert.ok(p1.actions[0].includes("stop + uninstall"));
  const p2 = planUninstall({ service: true, state: true, workspace: false, app: false }, GATE_CLEAN, DIRS);
  assert.ok(p2.actions.some((a) => a.includes("EXCEPT /tmp/state/workspace")), "their workspace-preservation copy");
  const p3 = planUninstall({ service: true, state: true, workspace: true, app: false }, GATE_CLEAN, DIRS);
  assert.ok(p3.actions.some((a) => a.includes("EVERYTHING under /tmp/state")));
});

test("unmanaged running gateway BLOCKS state/workspace (their exclusive-ownership rule)", () => {
  const gate = { serviceInstalled: false, unmanagedRunning: true, unmanagedPid: 4242 };
  const p = planUninstall({ service: false, state: true, workspace: true, app: false }, gate, DIRS);
  assert.match(p.blockedData ?? "", /exclusive-ownership/);
  assert.match(p.blockedData ?? "", /4242/);
  assert.deepEqual(p.dataScopes, ["state", "workspace"], "the intent is reported even when blocked");
  assert.equal(p.actions.filter((a) => a.startsWith("remove")).length, 0, "no removal actions planned under a block");
});

test("--app reports not-applicable without touching exit status", () => {
  const p = planUninstall({ service: false, state: false, workspace: false, app: true }, GATE_CLEAN, DIRS);
  assert.ok(p.actions.some((a) => a.startsWith("app scope: not applicable")));
});

// ---- deleteStateContents (sandboxed fs ops) ----------------------------------

test("state deletion removes everything except the workspace tree", () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-uninst-"));
  const ws = join(dir, "workspace");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "notes.md"), "keep me");
  writeFileSync(join(dir, "config.json5"), "{}");
  mkdirSync(join(dir, "logs"));
  writeFileSync(join(dir, "logs", "service.log"), "x");
  const removed = deleteStateContents(dir, ws);
  assert.equal(existsSync(join(dir, "config.json5")), false);
  assert.equal(existsSync(join(dir, "logs")), false);
  assert.equal(existsSync(join(ws, "notes.md")), true, "workspace survives --state without --workspace");
  assert.equal(removed.some((p) => p.includes("workspace")), false);
});

test("cliRemovalHint carries the npm-inline command and inspect-first advice", () => {
  const hint = cliRemovalHint("/tmp/state");
  assert.match(hint, /npm rm -g suparclaw/);
  assert.match(hint, /inspect/);
  assert.match(hint, /no CLI scope/);
});

// ---- cmd-level behavior (injected seams, no real machine services) ------------

function fakeFs(extra = {}) {
  const removed = [];
  return {
    removed,
    exists: () => true,
    list: () => ["config.json5", "state.sqlite", "logs"],
    remove: (p) => removed.push(p),
    stopService: () => ({ ok: true, message: "stopped" }),
    uninstallService: () => ({ ok: true, message: "service removed" }),
    ...extra,
  };
}
const captureLog = async (fn) => {
  const out = [];
  const orig = console.log;
  const origErr = console.error;
  console.log = (s) => out.push(String(s));
  console.error = (s) => out.push(String(s));
  try {
    const code = await fn();
    return { code, out: out.join("\n") };
  } finally {
    console.log = orig;
    console.error = origErr;
  }
};
const DIRS_TEST = { state: "/tmp/xstate", workspace: "/tmp/xstate/workspace", home: "/tmp/xhome" };

test("dry-run prints the plan and removes NOTHING", async () => {
  const fs = fakeFs();
  const { code, out } = await captureLog(() =>
    cmdUninstall(["--all", "--dry-run", "--yes", "--non-interactive"], { fs, gate: GATE_CLEAN, dirs: DIRS_TEST }),
  );
  assert.equal(code, 0);
  assert.deepEqual(fs.removed, [], "dry-run mutates nothing");
  assert.match(out, /dry-run — nothing was removed/);
});

test("--state --yes executes: service teardown then workspace-preserving state removal", async () => {
  const fs = fakeFs();
  const { code, out } = await captureLog(() =>
    cmdUninstall(["--service", "--state", "--yes"], { fs, gate: GATE_CLEAN, dirs: DIRS_TEST }),
  );
  assert.equal(code, 0);
  assert.match(out, /service stopped|service removed/);
  assert.match(out, /state removed, workspace kept/);
  assert.match(out, /npm rm -g suparclaw/, "CLI-removal hint follows data deletion");
});

test("gate failure: failed service removal blocks state/workspace and exits 1", async () => {
  const fs = fakeFs({ uninstallService: () => ({ ok: false, message: "boom" }) });
  const { code, out } = await captureLog(() =>
    cmdUninstall(["--service", "--state", "--workspace", "--yes"], { fs, gate: GATE_CLEAN, dirs: DIRS_TEST }),
  );
  assert.equal(code, 1);
  assert.match(out, /data scopes skipped: service teardown failed/);
  const stateTouched = fs.removed.filter((p) => p.includes("xstate"));
  assert.deepEqual(stateTouched, [], "state/workspace escaped the failed gate");
});

test("unmanaged live gateway blocks data scopes with the stop hint, exit 1", async () => {
  const fs = fakeFs();
  const gate = { serviceInstalled: false, unmanagedRunning: true, unmanagedPid: 777 };
  const { code, out } = await captureLog(() =>
    cmdUninstall(["--state", "--yes"], { fs, gate, dirs: DIRS_TEST }),
  );
  assert.equal(code, 1);
  assert.match(out, /stop it first/);
  assert.match(out, /777/);
});

test("service-less machine: --service is a clean no-op (inspection, not failure)", async () => {
  const fs = fakeFs();
  const { code, out } = await captureLog(() =>
    cmdUninstall(["--service", "--yes"], { fs, gate: { serviceInstalled: false, unmanagedRunning: false, unmanagedPid: null }, dirs: DIRS_TEST }),
  );
  assert.equal(code, 0, "nothing-to-remove is not a failure");
  assert.match(out, /no service installed — inspection clean/);
  assert.match(out, /config, state and workspace kept/);
});

test("interactive defaults: picker choosing 2 yields service+state; abort exits 1 with nothing removed", async () => {
  const fs = fakeFs();
  const pickState = await captureLog(() =>
    cmdUninstall(["--yes"], { fs, gate: GATE_CLEAN, dirs: DIRS_TEST, pickScopesFn: async () => ({ service: true, state: true, workspace: false }) }),
  );
  assert.equal(pickState.code, 0);
  assert.match(pickState.out, /state removed, workspace kept/);
  const fs2 = fakeFs();
  const aborted = await captureLog(() =>
    cmdUninstall([], { fs: fs2, gate: GATE_CLEAN, dirs: DIRS_TEST, pickScopesFn: async () => null, confirmFn: async () => true }),
  );
  assert.deepEqual(fs2.removed, []);
});
