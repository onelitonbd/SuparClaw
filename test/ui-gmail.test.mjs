// Render and drive Settings → Integrations → Gmail with a DOM and Gateway stub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";
import { build } from "esbuild";

const outDir = mkdtempSync(join(tmpdir(), "sc-ui-gmail-"));
const rpcStub = join(outDir, "rpc-stub.mjs");
writeFileSync(rpcStub, `
let status = { configured: true, enabled: true, connected: false, usable: false, account: "", scopes: [], connectedAt: "", connecting: false, vaultInitialized: true, vaultUnlocked: true };
export const gateway = {
  state: "online",
  async request(method, params = {}) {
    (globalThis.__GMAIL_CALLS ||= []).push({ method, params });
    if (method === "config.get") return { path: "/tmp/config.json5", config: { providers: {}, agents: { defaults: {} }, gateway: {}, addons: { gmail: { enabled: true, clientId: "desktop-client-id" } } } };
    if (method === "models.list") return { models: [], configured: [], auth: [], details: {} };
    if (method === "tools.list") return { tools: [] };
    if (method === "skills.list") return { skills: [] };
    if (method === "models.plugins") return { plugins: [] };
    if (method === "gmail.status") {
      if (status.connecting && globalThis.__GMAIL_COMPLETE === true) status = { ...status, connected: true, usable: true, connecting: false, account: "owner@example.com", scopes: ["https://www.googleapis.com/auth/gmail.modify"] };
      return structuredClone(status);
    }
    if (method === "gmail.connect") {
      status.connecting = true;
      return { flow: "flow-1", authUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=test&state=safe" };
    }
    if (method === "config.set") return { ok: true };
    if (method === "gmail.cancelConnect") return { cancelled: true };
    if (method === "gmail.disconnect") return { disconnected: true };
    return { ok: true };
  },
};
export function toast(message, tone) { (globalThis.__GMAIL_TOASTS ||= []).push({ message, tone }); }
`);
await build({
  entryPoints: [join(process.cwd(), "ui/src/settings.ts"), join(process.cwd(), "ui/src/model-name.ts")],
  bundle: true,
  format: "esm",
  outdir: outDir,
  outExtension: { ".js": ".mjs" },
  platform: "neutral",
  plugins: [{ name: "stub-rpc", setup(builder) { builder.onResolve({ filter: /(^|\/)rpc\.js$/ }, () => ({ path: rpcStub })); } }],
});

const page = parseHTML(`<!doctype html><html><body><main id="settings-body"></main></body></html>`);
globalThis.document = page.document;
globalThis.window = page.window;
globalThis.HTMLElement = page.HTMLElement;
globalThis.Event = page.window.Event;
globalThis.location = { hash: "#/settings/gmail" };
const popupCalls = [];
const popup = { opener: {}, location: { href: "about:blank" }, close() { this.closed = true; } };
globalThis.window.open = (...args) => { popupCalls.push(args); return popup; };
const { Settings } = await import(pathToFileURL(join(outDir, "settings.mjs")).href);
const flush = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test("Gmail settings render connected-vault guidance and wire save/connect/popup controls", async () => {
  globalThis.__GMAIL_CALLS = [];
  globalThis.__GMAIL_TOASTS = [];
  globalThis.__GMAIL_COMPLETE = false;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => originalSetTimeout(fn, ms === 2500 ? 0 : ms, ...args);
  try {
    const root = document.getElementById("settings-body");
    const settings = new Settings(root, () => {});
    settings.setHash("#/settings/gmail");
    await settings.render();
    assert.match(root.textContent, /Full Gmail tools/);
    assert.match(root.textContent, /refresh token is stored in the encrypted vault/);
    assert.match(root.textContent, /Production-but-unverified is for your own account only/);
    assert.match(root.textContent, /Not connected/);
    let connect = root.querySelector("#gm-connect");
    const save = root.querySelector("#gm-save");
    assert.ok(connect && save);
    assert.equal(connect.disabled, false, "connect is enabled only when config and unlocked vault are ready");

    await save.onclick();
    const saved = globalThis.__GMAIL_CALLS.filter((call) => call.method === "config.set");
    assert.deepEqual(saved.map((call) => [call.params.path, call.params.value]), [
      ["addons.gmail.clientId", "desktop-client-id"],
      ["addons.gmail.enabled", true],
    ]);
    await flush(10);
    connect = root.querySelector("#gm-connect");

    connect.onclick();
    assert.equal(popupCalls.length, 1, "popup opens synchronously during the user gesture");
    assert.equal(popup.opener, null, "the popup opener is cleared immediately");
    await flush(20);
    assert.equal(popup.location.href.startsWith("https://accounts.google.com/"), true);
    assert.equal(root.querySelector("#gm-auth-link").hidden, false, "fallback auth link is shown while OAuth is pending");
    assert.equal(root.querySelector("#gm-cancel").hidden, false, "cancel becomes available while the OAuth flow is pending");
    assert.ok(globalThis.__GMAIL_CALLS.some((call) => call.method === "gmail.connect"));
    globalThis.__GMAIL_COMPLETE = true;
    await flush(20);
    assert.match(root.textContent, /owner@example\.com/);
    assert.equal(root.querySelector("#gm-cancel").hidden, true);
    assert.equal(popup.closed, true, "OAuth popup closes after verified connection");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});
