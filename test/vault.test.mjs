// Task 59 — metadata-only task/tool vault, encrypted at rest, explicit runtime use.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const freshHome = () => {
  const home = mkdtempSync(join(tmpdir(), "sc-vault-"));
  process.env.SUPARCLAW_HOME = home;
  return home;
};
freshHome();
const lib = await import("../dist/lib.js");
const { VaultManager, vaultPath, validVaultName, emptyConfig, buildRegistry, saveSelfTool, selfToolSpecs } = lib;

const PASS = "correct horse battery staple";
const SECRET = "vault-runtime-secret-59";

test("vault encrypts values, exposes metadata only, locks on restart and redacts exact echoes", async () => {
  freshHome();
  assert.equal(validVaultName("SERVICE_API_KEY"), true);
  assert.equal(validVaultName("HOME"), false);
  assert.equal(validVaultName("NODE_OPTIONS"), false);
  assert.equal(validVaultName("bad-name"), false);

  const vault = new VaultManager();
  assert.deepEqual(vault.status().entries, []);
  assert.equal((await vault.initialize("short")).ok, false);
  assert.equal((await vault.initialize(PASS)).ok, true);
  const defined = vault.define({ name: "SERVICE_API_KEY", kind: "secret", description: "API key for the integration" });
  assert.equal(defined.ok, true);
  assert.equal((await vault.setValue("SERVICE_API_KEY", SECRET)).ok, true);

  const status = vault.status();
  assert.equal(status.unlocked, true);
  assert.equal(status.entries[0].configured, true);
  assert.equal(status.entries[0].usable, true);
  assert.equal(JSON.stringify(status).includes(SECRET), false);
  assert.deepEqual(vault.resolveForUse(["SERVICE_API_KEY"]), { ok: true, env: { SERVICE_API_KEY: SECRET } });
  assert.equal(vault.redact(`value=${SECRET}`), "value=[redacted:SERVICE_API_KEY]");

  const onDisk = readFileSync(vaultPath(), "utf8");
  assert.equal(onDisk.includes(SECRET), false, "value is ciphertext, not plaintext JSON");
  assert.equal(statSync(vaultPath()).mode & 0o777, 0o600);

  vault.lock();
  assert.equal(vault.resolveForUse(["SERVICE_API_KEY"]).ok, false);
  const afterRestart = new VaultManager();
  assert.equal(afterRestart.status().unlocked, false);
  assert.equal(afterRestart.status().entries[0].configured, true);
  assert.equal((await afterRestart.unlock("wrong passphrase" )).ok, false);
  assert.equal(afterRestart.status().unlocked, false);
  assert.equal((await afterRestart.unlock(PASS)).ok, true);
  assert.equal(afterRestart.redact(SECRET), "[redacted:SERVICE_API_KEY]");
  assert.equal(afterRestart.remove("SERVICE_API_KEY", "wrong confirmation").ok, false);
  assert.equal(afterRestart.remove("SERVICE_API_KEY", "SERVICE_API_KEY").ok, true);
  assert.equal(afterRestart.status().entries.length, 0);
  assert.equal(afterRestart.reset("RESET VAULT").ok, true);

  writeFileSync(vaultPath(), JSON.stringify({ version: 1, salt: "bad", entries: [], sealed: { iv: "", tag: "", data: "" } }));
  const corrupt = new VaultManager();
  assert.equal(corrupt.status().initialized, false);
  assert.match(corrupt.status().error, /vault file could not be read/);
  assert.equal(corrupt.reset("RESET VAULT").ok, true, "the UI can remove a malformed vault and recover");
});

test("exec injects only explicitly named entries and redacts returned exact values", async () => {
  freshHome();
  const vault = new VaultManager();
  assert.equal((await vault.initialize(PASS)).ok, true);
  assert.equal(vault.define({ name: "TASK_TOKEN", kind: "secret", description: "token for task test" }).ok, true);
  assert.equal((await vault.setValue("TASK_TOKEN", SECRET)).ok, true);
  const config = emptyConfig();
  const exec = buildRegistry(config).find((tool) => tool.name === "exec");
  assert.ok(exec);
  const ctx = { config, workspace: process.cwd(), vault };
  const command = `node -e 'process.stdout.write(process.env.TASK_TOKEN || "not-injected")'`;

  const absent = await exec.run({ command }, ctx);
  assert.equal(absent, "not-injected");
  const injected = await exec.run({ command, vaultEnv: ["TASK_TOKEN"] }, ctx);
  assert.match(injected, /\[redacted:TASK_TOKEN\]/);
  assert.equal(injected.includes(SECRET), false);
  const stderr = await exec.run({
    command: `node -e 'process.stderr.write(process.env.TASK_TOKEN || "not-injected")'`,
    vaultEnv: ["TASK_TOKEN"],
  }, ctx);
  assert.match(stderr, /\[redacted:TASK_TOKEN\]/);
  assert.equal(stderr.includes(SECRET), false, "stderr is redacted too");
  const missing = await exec.run({ command, vaultEnv: ["DOES_NOT_EXIST"] }, ctx);
  assert.match(missing, /DOES_NOT_EXIST/);
  assert.equal(missing.includes(SECRET), false);
});

test("declared self-tool entries are injected in its worker and output is redacted", async () => {
  freshHome();
  const vault = new VaultManager();
  assert.equal((await vault.initialize(PASS)).ok, true);
  assert.equal(vault.define({ name: "WORKER_TOKEN", kind: "secret", description: "worker token" }).ok, true);
  assert.equal((await vault.setValue("WORKER_TOKEN", SECRET)).ok, true);
  const config = emptyConfig();
  const code = `export default {
    name: "vault_reader",
    description: "Reads one explicitly declared task value.",
    parameters: { type: "object", properties: {} },
    vault: ["WORKER_TOKEN"],
    async run() { return process.env.WORKER_TOKEN ?? "not-injected"; },
  };`;
  const saved = await saveSelfTool({ name: "vault_reader", code, config, mode: "create" });
  assert.equal(saved.ok, true, saved.error);
  const spec = selfToolSpecs(config).find((tool) => tool.name === "vault_reader");
  assert.ok(spec);
  assert.match(spec.description, /WORKER_TOKEN/);
  const output = await spec.run({}, { config, workspace: process.cwd(), vault });
  assert.match(output, /\[redacted:WORKER_TOKEN\]/);
  assert.equal(output.includes(SECRET), false);

  const failingCode = `export default {
    name: "vault_failure",
    description: "Checks that thrown errors and console logs are redacted.",
    parameters: { type: "object", properties: {} },
    vault: ["WORKER_TOKEN"],
    async run() { console.error(process.env.WORKER_TOKEN); throw new Error(process.env.WORKER_TOKEN); },
  };`;
  const failedSave = await saveSelfTool({ name: "vault_failure", code: failingCode, config, mode: "create" });
  assert.equal(failedSave.ok, true, failedSave.error);
  const failingSpec = selfToolSpecs(config).find((tool) => tool.name === "vault_failure");
  assert.ok(failingSpec);
  const failure = await failingSpec.run({}, { config, workspace: process.cwd(), vault });
  assert.match(failure, /\[redacted:WORKER_TOKEN\]/);
  assert.equal(failure.includes(SECRET), false, "thrown messages and captured logs are redacted");
});
