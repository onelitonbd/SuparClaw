// Task 59 — render and drive the Settings → System → Secrets vault controls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";
import { build } from "esbuild";

const ROOT = process.cwd();
const outDir = mkdtempSync(join(tmpdir(), "sc-ui-vault-"));
const rpcStub = join(outDir, "rpc-stub.mjs");
writeFileSync(rpcStub, `
const vault = { initialized: true, unlocked: true, entries: [{ name: "TASK_TOKEN", kind: "secret", description: "token for the task", configured: false, usable: false }] };
export const gateway = {
  state: "online",
  async request(method, params = {}) {
    (globalThis.__VAULT_CALLS ||= []).push({ method, params });
    if (method === "config.get") return { path: "/tmp/config.json5", config: { providers: {}, agents: { defaults: {} }, gateway: {} } };
    if (method === "models.list") return { models: [], configured: [], auth: [], details: {} };
    if (method === "tools.list") return { tools: [] };
    if (method === "skills.list") return { skills: [] };
    if (method === "models.plugins") return { plugins: [] };
    if (method === "backup.list") return { backups: [] };
    if (method === "vault.status") return structuredClone(vault);
    if (method === "vault.set") {
      if (params.value !== "test-ui-secret") throw new Error("unexpected submitted value");
      vault.entries[0].configured = true; vault.entries[0].usable = true;
      return { ok: true, name: params.name, configured: true };
    }
    if (method === "vault.lock") { vault.unlocked = false; vault.entries[0].usable = false; return { ok: true }; }
    if (method === "vault.unlock") { vault.unlocked = true; vault.entries[0].usable = true; return { ok: true }; }
    return { ok: true };
  },
};
`);
await build({
  entryPoints: [join(ROOT, "ui/src/settings.ts"), join(ROOT, "ui/src/model-name.ts")],
  bundle: true,
  format: "esm",
  outdir: outDir,
  outExtension: { ".js": ".mjs" },
  platform: "neutral",
  plugins: [{ name: "stub-rpc", setup(b) { b.onResolve({ filter: /(^|\/)rpc\.js$/ }, () => ({ path: rpcStub })); } }],
});

const page = parseHTML(`<!doctype html><html><body><main id="settings-body"></main></body></html>`);
globalThis.document = page.document;
globalThis.window = page.window;
globalThis.HTMLElement = page.HTMLElement;
globalThis.Event = page.window.Event;
globalThis.location = { hash: "#/settings/system" };
const { Settings } = await import(pathToFileURL(join(outDir, "settings.mjs")).href);

async function flush() { await new Promise((resolve) => setTimeout(resolve, 0)); }

test("vault card renders on mobile-friendly System page and clears values after save", async () => {
  globalThis.__VAULT_CALLS = [];
  const root = document.getElementById("settings-body");
  const settings = new Settings(root, () => {});
  settings.setHash("#/settings/system");
  await settings.render();
  await flush();
  assert.match(root.textContent, /Task & tool vault/);
  assert.match(root.textContent, /unlockedValues are available only through explicit runtime injection/);
  assert.match(root.textContent, /Unrestricted Termux code can intentionally read or exfiltrate injected values/);

  let input = root.querySelector(".vault-entry input");
  assert.ok(input, "configured and missing entries have a value input");
  assert.equal(input.getAttribute("type"), "password", "secret is masked while entering");
  input.value = "test-ui-secret";
  const save = [...root.querySelectorAll(".vault-entry button")].find((button) => button.textContent === "Save value");
  assert.ok(save, "Save value action is rendered");
  await save.onclick();
  await flush();
  assert.equal(input.value, "", "the original control clears immediately after submission");
  assert.equal(root.innerHTML.includes("test-ui-secret"), false, "the saved value never remains in rendered DOM");
  const setCall = globalThis.__VAULT_CALLS.find((call) => call.method === "vault.set");
  assert.equal(setCall.params.value, "test-ui-secret");
  assert.match(root.textContent, /Replace value/);
  assert.match(root.textContent, /Input clears after save/);
  assert.ok(root.querySelector(".vault-entry"), "the named entry remains visible as metadata");
});
