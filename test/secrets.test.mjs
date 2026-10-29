// P3 (row Missing!#30) — secret stores: env refs + SecretRef providers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SUPARCLAW_HOME = mkdtempSync(join(tmpdir(), "sc-secrets-"));
const { resolveSecrets, substituteEnvText, isSecretRef, validateSecretRef, readConfigFile } = await import("../dist/lib.js");

test("substituteEnvText — their env-ref semantics (fallbacks, escape, operators, nested)", () => {
  const env = { SET: "val", EMPTY: "", B: "bee" };
  const w = [];
  assert.equal(substituteEnvText("a ${SET} b", env, w), "a val b");
  assert.equal(substituteEnvText("${MISSING}", env, w), "${MISSING}"); // stays visibly unresolved
  assert.match(w[0], /MISSING is not set/);
  assert.equal(substituteEnvText("${MISSING:-fb}", env), "fb");
  assert.equal(substituteEnvText("${EMPTY:-fb}", env), "fb"); // unset and empty are one state
  assert.equal(substituteEnvText("${EMPTY:-}", env), ""); // empty fallback allowed
  assert.equal(substituteEnvText("$${SET}", env), "${SET}"); // escape wins, nothing read
  assert.equal(substituteEnvText("${lower}", env), "${lower}"); // uppercase only
  assert.equal(substituteEnvText("${A:-${B}}", env), "${A:-bee}"); // outer literal, inner substitutes
  assert.equal(substituteEnvText("${VAR:=x}", env), "${VAR:=x}"); // other operators untouched
  assert.equal(substituteEnvText("pre-${SET}-post", env), "pre-val-post");
});

test("isSecretRef + validateSecretRef — their object shape and patterns", () => {
  assert.equal(isSecretRef({ source: "env", id: "X_KEY" }), true);
  assert.equal(isSecretRef({ source: "env", provider: "default", id: "X_KEY" }), true);
  assert.equal(isSecretRef({ source: "env", id: "X", extra: 1 }), false); // unknown key breaks the shape
  assert.equal(isSecretRef({ source: "vault", id: "x" }), false); // unknown source
  assert.equal(isSecretRef("env:X"), false);

  assert.equal(validateSecretRef({ source: "env", id: "GOOD_NAME_9" }), null);
  assert.match(validateSecretRef({ source: "env", id: "lowercase" }), /env id must match/);
  assert.equal(validateSecretRef({ source: "file", id: "/providers/openai/apiKey" }), null);
  assert.match(validateSecretRef({ source: "file", id: "relative" }), /absolute JSON pointer/);
  assert.equal(validateSecretRef({ source: "exec", id: "aws/secret#json_key" }), null);
  assert.match(validateSecretRef({ source: "exec", id: "a/../b" }), /dot path segments/);
  assert.match(validateSecretRef({ source: "env", provider: "BAD NAME", id: "X" }), /provider name invalid/);
});

test("resolveSecrets — env/file/exec providers resolve at activation; plaintext reported, never printed", () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-secrets-prov-"));
  writeFileSync(join(dir, "secrets.json"), JSON.stringify({ providers: { openai: { apiKey: "sk-file-secret" } } }));
  writeFileSync(join(dir, "single.txt"), "single-secret\n");
  const resolver = join(dir, "resolver.sh");
  writeFileSync(resolver, "#!/bin/sh\ncase \"$1\" in\n  op://Vault/Item/credential) echo \"op-secret\";;\n  *) exit 1;;\nesac\n");
  chmodSync(resolver, 0o755);

  const raw = {
    providers: {
      openrouter: { apiKey: "${SC_TEST_KEY}" },                                  // env substitution
      openai: { apiKey: { source: "file", provider: "filemain", id: "/providers/openai/apiKey" } },
      anthropic: { apiKey: { source: "exec", provider: "onepass", id: "op://Vault/Item/credential" } },
      google: { apiKey: { source: "env", id: "SC_TEST_MISSING" } },              // unresolved
      plainco: { apiKey: "sk-plaintext-residue" },                               // audit finding
      single: { apiKey: { source: "file", provider: "onefile", id: "value" } },  // singleValue mode
    },
    gateway: { port: 18790 },
    secrets: {
      providers: {
        filemain: { source: "file", path: join(dir, "secrets.json"), mode: "json" },
        onefile: { source: "file", path: join(dir, "single.txt"), mode: "singleValue" },
        onepass: { source: "exec", command: resolver, args: [], passEnv: ["SC_TEST_NEVER_SENT"] },
      },
    },
    env: { vars: { SOME_API_KEY: "documented-plaintext-home" } }, // not a finding (their env.vars note)
  };
  const before = JSON.stringify(raw);
  process.env.SC_TEST_KEY = "sk-env-secret";
  const { config, findings } = resolveSecrets(raw);
  delete process.env.SC_TEST_KEY;

  // raw never mutated (authored refs/fallbacks stay authored)
  assert.equal(JSON.stringify(raw), before);

  const c = config;
  assert.equal(c.providers.openrouter.apiKey, "sk-env-secret");
  assert.equal(c.providers.openai.apiKey, "sk-file-secret");
  assert.equal(c.providers.anthropic.apiKey, "op-secret"); // 1Password-shaped exec ref
  assert.equal(c.providers.single.apiKey, "single-secret");
  assert.deepEqual(c.providers.google.apiKey, { source: "env", id: "SC_TEST_MISSING" }); // left in place
  assert.equal(c.gateway.port, 18790);

  assert.ok(findings.some((f) => f.startsWith("unresolved SecretRef at providers.google.apiKey")));
  assert.ok(findings.some((f) => f.startsWith("plaintext credential at providers.plainco.apiKey")));
  assert.ok(!findings.some((f) => f.includes("sk-plaintext-residue")), "findings name paths, never values");
  assert.ok(!findings.some((f) => f.startsWith("plaintext credential at env.vars.")));
});

test("readConfigFile — refs resolve in the loaded config; the on-disk file keeps authored refs", () => {
  const home = mkdtempSync(join(tmpdir(), "sc-secrets-load-"));
  const cfgPath = join(home, "config.json5");
  writeFileSync(cfgPath, "{\n  providers: { openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: '${SC_LOAD_TEST_KEY}', models: ['m'] } },\n}\n");
  process.env.SC_LOAD_TEST_KEY = "sk-resolved";
  const load = readConfigFile(cfgPath);
  delete process.env.SC_LOAD_TEST_KEY;
  assert.deepEqual(load.errors, []);
  assert.equal(load.config.providers["openrouter"].apiKey, "sk-resolved");
  assert.match(readFileSync(cfgPath, "utf8"), /\$\{SC_LOAD_TEST_KEY\}/); // never inlined on disk
});

test("sc secrets audit CLI — exit codes + JSON findings (their CI semantics)", () => {
  const home = mkdtempSync(join(tmpdir(), "sc-secrets-audit-"));
  mkdirSync(join(home, ".suparclaw"), { recursive: true });
  writeFileSync(join(home, ".suparclaw", "config.json5"), "{ providers: { x: { baseUrl: 'http://h/v1', apiKey: 'sk-plain', models: ['m'] }, y: { baseUrl: 'http://h/v1', apiKey: { source: 'env', id: 'SC_AUDIT_MISSING' }, models: ['m'] } } }\n");

  const env = { ...process.env, SUPARCLAW_HOME: home };
  // findings + unresolved → exit 2 with --json (unresolved wins, their rule)
  let code = 0;
  let out = "";
  try {
    out = execFileSync("node", ["dist/sc.js", "secrets", "audit", "--json"], { env, cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    code = e.status;
    out = e.stdout;
  }
  assert.equal(code, 2);
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, false);
  assert.ok(parsed.findings.some((f) => f.startsWith("unresolved SecretRef at providers.y.apiKey")));
  assert.ok(parsed.findings.some((f) => f.startsWith("plaintext credential at providers.x.apiKey")));

  // clean config → 0
  writeFileSync(join(home, ".suparclaw", "config.json5"), "{ providers: { x: { baseUrl: 'http://h/v1', apiKey: '${SC_AUDIT_OK:-fallback-ok}', models: ['m'] } } }\n");
  const out2 = execFileSync("node", ["dist/sc.js", "secrets", "audit", "--check", "--json"], { env, cwd: new URL("..", import.meta.url).pathname, encoding: "utf8" });
  assert.equal(JSON.parse(out2).ok, true);
});

test("wiring — secrets command registered; secrets.ts ports their validation refs", () => {
  const src = readFileSync(new URL("../src/cli/index.ts", import.meta.url), "utf8");
  assert.match(src, /case "secrets":/);
  assert.match(src, /secrets <audit\|refs>/);
  const impl = readFileSync(new URL("../src/config/secrets.ts", import.meta.url), "utf8");
  assert.match(impl, /\^\[a-z\]\[a-z0-9_-\]/); // their provider-name pattern
  assert.match(impl, /\^\[A-Z\]\[A-Z0-9_\]/); // their env id pattern
  assert.match(impl, /singleValue/);
  assert.match(impl, /op:\/\/Vault/); // 1Password recipe documented
});
