// Task 52 — the terminal feature as the daemon actually wires it: the Service
// owns the shells, the `terminal` tool drives them through the normal approval
// path, the events reach every subscriber (that is what the web panel watches),
// and shutting the daemon down reaps the processes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SUPARCLAW_HOME = mkdtempSync(join(tmpdir(), "sc-term-svc-"));
const { Service, buildRegistry, emptyConfig } = await import("../dist/lib.js");

const ROOT = process.cwd();

async function until(fn, ms = 4000) {
  const started = Date.now();
  while (!fn()) {
    if (Date.now() - started > ms) throw new Error("timed out waiting for the condition");
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** A ToolContext shaped like the loop's, approved, with the service's manager. */
function ctxFor(service, extra = {}) {
  return {
    workspace: service.config.agents.defaults.workspace || process.cwd(),
    stateDir: service.store.getMeta("state_dir"),
    skills: [],
    store: service.store,
    log: service.log,
    config: service.config,
    approved: true,
    sessionKey: "main:main",
    terminals: service.terminals,
    ...extra,
  };
}

test("the service owns the terminals and the tool drives them end to end", async () => {
  const service = new Service();
  try {
    const tool = service.loop.tools.find((t) => t.name === "terminal");
    assert.ok(tool, "the terminal tool is registered");
    assert.equal(tool.needsApproval, true, "terminals go through the same approval gate as exec");

    const ctx = ctxFor(service);
    const created = await tool.run({ action: "run", command: "pwd; cd /tmp; export SC_SVC=ok" }, ctx);
    assert.match(created, /^t1/, "the first run opens this session's terminal");
    assert.match(created, /\[exit 0 in \d+ ms · cwd \/tmp\]/);

    // The whole promise of the feature: the next call is the same shell.
    const second = await tool.run({ action: "run", command: "pwd; echo $SC_SVC" }, ctx);
    assert.match(second, /\/tmp\nok/, "cwd and exports survived between tool calls");

    // A second terminal runs independently, and list shows both.
    const made = await tool.run({ action: "create", name: "dev server" }, ctx);
    assert.match(made, /created t2 \(dev server\)/);
    const listed = await tool.run({ action: "list" }, ctx);
    assert.match(listed, /t1 · idle · cwd \/tmp/);
    assert.match(listed, /t2 \(dev server\) · idle/);

    const isolated = await tool.run({ action: "run", terminal: "t2", command: "pwd" }, ctx);
    assert.doesNotMatch(isolated, /\/tmp/, "the second shell kept its own cwd");

    const tail = await tool.run({ action: "read", terminal: "t1", lines: 5 }, ctx);
    assert.match(tail, /t1 · idle · cwd \/tmp/);
    assert.match(tail, /ok/);

    const killed = await tool.run({ action: "kill", terminal: "t2" }, ctx);
    assert.match(killed, /closed t2/);
    assert.equal(service.terminals.size, 1);
  } finally {
    await service.stop();
  }
  assert.equal(service.terminals.size, 0, "stop() reaps every shell");
});

test("every terminal event reaches service subscribers — that is the panel's feed", async () => {
  const service = new Service();
  const seen = [];
  const off = service.subscribe((e) => seen.push(e));
  try {
    const tool = service.loop.tools.find((t) => t.name === "terminal");
    await tool.run({ action: "run", command: "echo panel-visible" }, ctxFor(service));
    await until(() => seen.some((e) => e.type === "terminal" && e.kind === "output" && /panel-visible/.test(e.text)));
    const created = seen.find((e) => e.type === "terminal" && e.kind === "created");
    assert.ok(created, "a `created` event announces the new shell");
    assert.equal(created.terminal.id, created.id);
    const out = seen.find((e) => e.type === "terminal" && e.kind === "output");
    assert.equal(typeof out.seq, "number");
    assert.equal(out.cwd, service.terminals.list()[0].cwd);
    off();
  } finally {
    await service.stop();
  }
});

test("the tool runs even when nothing approved it — there is no approval step (Task 55)", async () => {
  // The old contract was the bug the operator hit on Telegram: `approved:false`
  // produced "terminals need approval — ask the user to approve, then retry",
  // and a model reading that asks the human to type the commands by hand.
  const service = new Service();
  try {
    const tool = service.loop.tools.find((t) => t.name === "terminal");
    const out = await tool.run({ action: "run", command: "echo went-ahead" }, ctxFor(service, { approved: false }));
    assert.match(out, /went-ahead/, "the shell runs; the verdict is the policy's, not a person's");
    assert.equal(service.terminals.size, 1, "exactly one shell, opened on demand");
  } finally {
    await service.stop();
  }
});

test("the config knobs are real: enabled/max/scrollbackKb/waitMs", async () => {
  // Defaults the daemon boots with.
  const service = new Service();
  try {
    assert.equal(service.config.tools.terminals.enabled, true);
    assert.equal(service.config.tools.terminals.max, 8);
    assert.equal(service.config.tools.terminals.scrollbackKb, 200);
    assert.equal(service.config.tools.terminals.waitMs, 60_000);
    assert.equal(service.terminals.max, 8);
    assert.equal(service.terminals.defaultWaitMs, 60_000);

    // A config write reaches the live manager without killing open shells.
    const term = service.terminals.create({ cwd: "/tmp" });
    const set = service.configSvc.setPath("tools.terminals.waitMs", 5000);
    assert.equal(set.ok, true, "the value is accepted by the schema");
    service.applyConfig();
    assert.equal(service.terminals.defaultWaitMs, 5000, "the change is live");
    assert.equal(service.terminals.size, 1, "and the open shell survived it");
    assert.equal((await term.run("echo still-here")).output.trim(), "still-here");
  } finally {
    await service.stop();
  }

  // Off ⇒ no tool at all (the agent cannot reach a shell through this surface).
  const off = emptyConfig();
  off.tools.terminals.enabled = false;
  assert.equal(buildRegistry(off).some((t) => t.name === "terminal"), false, "disabled means not registered");
  const on = emptyConfig();
  assert.equal(buildRegistry(on).some((t) => t.name === "terminal"), true);
});

test("a plain object manager would satisfy the tool's calls (the contract is structural)", () => {
  // The tool takes `ctx.terminals` as TerminalCtl — the Service passes the real
  // manager, but the shape is deliberate: nothing in tools.ts spawns processes.
  const src = readFileSync(join(ROOT, "src/agent/tools.ts"), "utf8");
  assert.match(src, /export interface TerminalCtl/);
  assert.doesNotMatch(src, /from "\.\/terminals\.js";\n/, "no value import of the spawning module");
  assert.match(src, /import\("\.\/terminals\.js"\)/, "types and defaults are loaded lazily");
});
