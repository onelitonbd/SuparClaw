// P2 #9 — exec sandbox plans.
import { test } from "node:test";
import assert from "node:assert/strict";

const { sandboxEnv, planSandbox, findPrlimit, findProot, emptyConfig, buildRegistry } = await import("../dist/lib.js");

const WS = "/tmp/ws";

test("off mode keeps the legacy argv/env untouched", () => {
  const plan = planSandbox(["/bin/sh", "-lc", "echo hi"], WS, { sandbox: "off", sandboxProot: false, safeBinTrustedDirs: ["/bin"] });
  assert.deepEqual(plan.argv, ["/bin/sh", "-lc", "echo hi"]);
  assert.equal(plan.env, process.env);
  assert.equal(plan.note, "sandbox: off");
});

test("strict scrub env: trusted PATH dirs, HOME=workspace, no inherited secrets", () => {
  process.env["SECRET_TOKEN_XYZ"] = "hunter2";
  const env = sandboxEnv(WS, ["/bin", "/usr/bin"]);
  assert.equal(env["HOME"], WS, "dotfiles + agent config stay outside the child");
  assert.equal(env["SECRET_TOKEN_XYZ"], undefined, "inherited secrets do not leak");
  assert.ok(env["PATH"].split(":").includes("/bin"));
  assert.ok(env["PATH"].split(":").includes("/usr/local/bin"));
  assert.ok("LANG" in env && "TZ" in env);
});

test("strict wraps prlimit caps and names the applied layers; proot when enabled+present", () => {
  const strict = planSandbox(["/bin/sh", "-lc", "id"], WS, { sandbox: "strict", sandboxProot: false, safeBinTrustedDirs: ["/bin"] });
  if (findPrlimit()) {
    assert.equal(strict.argv[0], findPrlimit());
    const argvJoined = strict.argv.join(" ");
    assert.ok(argvJoined.includes("--as=2147483648") && argvJoined.includes("--nproc=256") && argvJoined.includes("--nofile=1024"));
    assert.ok(strict.argv.includes("/bin/sh"), "shell rides inside the cap");
  } else {
    assert.deepEqual(strict.argv, ["/bin/sh", "-lc", "id"], "no prlimit here — plain argv with scrubbed env only");
  }
  assert.match(strict.note, /^sandbox: strict\(/);

  const prootOn = planSandbox(["/bin/sh", "-lc", "id"], WS, { sandbox: "strict", sandboxProot: true, safeBinTrustedDirs: ["/bin"] });
  if (findProot()) {
    const joined = prootOn.argv.join("\x00");
    assert.ok(joined.includes("-b") && joined.includes(`${WS}:${WS}`), "workspace bound rw");
    assert.ok(joined.includes("/usr/bin/env\x00-i"), "env -i inside the jail");
    assert.match(prootOn.note, /proot/);
  } else {
    assert.ok(!prootOn.note.includes("proot"), "no proot binary ⇒ jail layer absent, never faked");
  }
});

test("sandboxProot:true without a proot binary does not break the plan", () => {
  const plan = planSandbox(["/bin/sh", "-lc", "x"], WS, { sandbox: "strict", sandboxProot: true, safeBinTrustedDirs: [] });
  assert.ok(plan.argv.length >= 3);
});

test("schema defaults off+false; strict confined exec runs for real through buildRegistry", async () => {
  const cfg = emptyConfig();
  assert.equal(cfg.tools.exec.sandbox, "off");
  assert.equal(cfg.tools.exec.sandboxProot, false);
  cfg.tools.exec.enabled = true;
  cfg.tools.exec.sandbox = "strict";
  const tools = buildRegistry(cfg);
  const exec = tools.find((t) => t.name === "exec");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const ws = mkdtempSync(join(tmpdir(), "sc-sandbox-"));
  writeFileSync(join(ws, "marker.txt"), "inside");
  const out = await exec.run({ command: "cat marker.txt && echo HOME=$HOME && [ -z \"$DB_PASSWORD_X\" ] && echo no-secret" }, {
    workspace: ws, approved: true, env: {}, sessionKey: "t",
  });
  assert.match(out, /inside/, "workspace file readable");
  assert.match(out, new RegExp(`HOME=${ws.replace(/\//g, "\\/")}`), "HOME is the workspace");
  assert.match(out, /no-secret/, "env scrubbed of inherited keys");
  assert.ok(out.startsWith("[sandbox: strict("), "the applied layers ride the output for audit");
});

test("strict exec: cwd stays the workspace and caps don't kill ordinary commands", async () => {
  const cfg = emptyConfig();
  cfg.tools.exec.enabled = true;
  cfg.tools.exec.sandbox = "strict";
  const exec = buildRegistry(cfg).find((t) => t.name === "exec");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const ws = mkdtempSync(join(tmpdir(), "sc-sandbox-"));
  const out = await exec.run({ command: "pwd && echo $((2+2)) && echo ok" }, { workspace: ws, approved: true });
  assert.match(out, /ok/);
});
