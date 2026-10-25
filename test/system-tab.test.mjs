// P4 (Missing!#41–#44) — System tab (doctor/audit/update), backup UI,
// secrets UI, provider auth-buttons.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("#41 doctor: runDoctorChecks is structured; insideGateway skips the port probe", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-doctor-"));
  process.env.SUPARCLAW_HOME = dir;
  mkdirSync(join(dir, "state"), { recursive: true });
  mkdirSync(join(dir, "workspace"), { recursive: true });
  const { runDoctorChecks } = await import("../dist/lib.js");
  const checks = await runDoctorChecks({ insideGateway: true });
  assert.ok(Array.isArray(checks) && checks.length > 0);
  for (const c of checks) {
    assert.ok(typeof c.name === "string" && ["ok", "warn", "fail"].includes(c.status));
  }
  assert.equal(checks.some((c) => c.name.startsWith("port ")), false); // daemon-side: no free-port probe
  assert.ok(checks.some((c) => c.name === "gateway" && c.status === "ok"));
  // CLI stays the printer over the same checks
  const src = readFileSync(new URL("../src/cli/doctor.ts", import.meta.url), "utf8");
  assert.match(src, /const checks = await runDoctorChecks\(\);/);
});

test("#41-#43 System RPCs: doctor, security audit, update check + sha-guarded apply, secrets.audit, backup CRUD", () => {
  const src = readFileSync(new URL("../src/gateway/server.ts", import.meta.url), "utf8");
  for (const m of ["system.doctor", "system.securityAudit", "system.update.check", "system.update.apply", "secrets.audit", "backup.create", "backup.list", "backup.verify", "backup.restore"]) {
    assert.ok(src.includes(`"${m}"`), `missing advertised RPC ${m}`);
    assert.ok(src.includes(`case "${m}"`), `missing handler ${m}`);
  }
  // doctor reuses the CLI probes, inside gateway
  assert.match(src, /runDoctorChecks\(\{ insideGateway: true \}\)/);
  // security audit passes the real file mode
  assert.match(src, /statSync\(service\.configSvc\.path\)\.mode & 0o777/);
  assert.match(src, /auditConfig\(\{ config: service\.config, configMode \}\)/);
  // update apply: up-to-date short-circuit + confirmed-sha guard against stale checks
  assert.match(src, /upToDate: true, sha: status\.currentSha/);
  assert.match(src, /ship guard: confirmed sha/);
  assert.match(src, /!String\(status\.remoteSha\)\.startsWith\(want\)/);
  // secrets audit reads the raw file, not the redacted config (their rule)
  assert.match(src, /auditSecretsFile\(service\.configSvc\.path\)/);
  // backup: default dir under the state dir, verify-by-default, restore is restoreBackup
  assert.match(src, /joinPath\(stateDir\(\), "backups"\)/);
  assert.match(src, /createBackup\(\{/);
  assert.match(src, /includeWorkspace: params\["includeWorkspace"\] !== false/);
  assert.match(src, /verify: params\["verify"\] !== false/);
  assert.match(src, /restoreBackup\(archive/);
  assert.match(src, /restart the gateway/);
});

test("#41 UI System tab runs doctor / security audit / update flow end-to-end", () => {
  const src = readFileSync(new URL("../ui/src/settings.ts", import.meta.url), "utf8");
  assert.match(src, /\| "runtime" \| "system";/);
  assert.match(src, /\{ id: "system", label: "System", group: "Advanced", description:/);
  assert.match(src, /this\.#tab === "system"\) await this\.#renderSystem\(config\)/);
  // doctor
  assert.match(src, /id: "doctor-run"/);
  assert.match(src, /gateway\.request\("system\.doctor"/);
  assert.match(src, /fix: \$\{c\.fix\}/);
  // security audit
  assert.match(src, /id: "security-audit-run"/);
  assert.match(src, /gateway\.request\("system\.securityAudit"/);
  // update: check → verify count→behind enables apply; typed sha confirm
  assert.match(src, /id: "update-check"/);
  assert.match(src, /id: "update-apply"/);
  assert.match(src, /applyBtn\.disabled = !checkedBehind/);
  assert.match(src, /Type \$\{target\} to confirm/);
  assert.match(src, /gateway\.request\("system\.update\.apply", \{ sha: values\["sha"\]/);
  assert.match(src, /danger: true/);
  // diag marks for all three severities
  assert.match(src, /diag-mark--ok/);
  assert.match(src, /diag-mark--warn/);
  assert.match(src, /diag-mark--fail/);
});

test("#42 UI backup: archives with sizes, create with CLI-flag parity, verify + confirmed restore", () => {
  const src = readFileSync(new URL("../ui/src/settings.ts", import.meta.url), "utf8");
  assert.match(src, /gateway\.request\("backup\.list"\)/);
  assert.match(src, /MiB · /); // sizes rendered
  assert.match(src, /gateway\.request\("backup\.create"/);
  assert.match(src, /includeWorkspace: wsCb\.checked/);
  assert.match(src, /onlyConfig: cfgOnlyCb\.checked/);
  assert.match(src, /archives never overwritten/);
  assert.match(src, /gateway\.request\("backup\.verify", \{ archive/);
  assert.match(src, /verification reported problems/);
  assert.match(src, /gateway\.request\("backup\.restore", \{ archive/);
  assert.match(src, /The current state is replaced/); // destructive gate
});

test("#43 UI secrets panel: findings + providers + recipe help", () => {
  const src = readFileSync(new URL("../ui/src/settings.ts", import.meta.url), "utf8");
  assert.match(src, /id: "secrets-audit-run"/);
  assert.match(src, /gateway\.request\("secrets\.audit"/);
  assert.match(src, /No plaintext credentials or unresolved refs/);
  assert.match(src, /Configured providers/);
  assert.match(src, /Redacted|redacted/);
  assert.match(src, /SecretRef/);
  assert.match(src, /sc secrets refs/); // their recipe help pointer
});

test("#44 provider buttons: connection test, credential probe, device-code sign-in modal", () => {
  const src = readFileSync(new URL("../ui/src/settings.ts", import.meta.url), "utf8");
  assert.match(src, /#providerAuthButtons\(name: string\)/);
  assert.match(src, /\.\.\.this\.#providerAuthButtons\(name\), edit, remove/);
  // connection test
  assert.match(src, /id: `prov-test-\$\{name\}`/);
  assert.match(src, /gateway\.request\("providers\.test", \{ name \}\)/);
  assert.match(src, /connection ok/);
  // probe
  assert.match(src, /id: `prov-probe-\$\{name\}`/);
  assert.match(src, /gateway\.request\("models\.auth\.probe", \{ provider: name \}\)/);
  // device code: begin → code box + verification link → poll loop → done
  assert.match(src, /id: `prov-signin-\$\{name\}`/);
  assert.match(src, /#deviceCodeFlow\(name: string\)/);
  assert.match(src, /gateway\.request\("models\.auth\.beginDeviceCode", \{ provider: name \}\)/);
  assert.match(src, /class: "device-code mono"/);
  assert.match(src, /target: "_blank"/);
  assert.match(src, /gateway\.request\("models\.auth\.pollDeviceCode", \{ flow, setDefault: true \}\)/);
  assert.match(src, /setTimeout\(r, 2500\)/);
  assert.match(src, /modal-overlay"\)!\.hidden.*cancelled/s); // cancel stops polling
});
