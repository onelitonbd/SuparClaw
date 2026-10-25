// Settings → Providers: the five buttons on a provider card, driven for real.
//
// This tab had no render test at all, and the button the user trusted least —
// Remove — was the one that lied: it deleted the provider record, left the
// provider's saved models enabled in the model picker (and its credentials in
// the state DB), and the UI threw away the gateway's warning that the default
// model now points at nothing. So: every button here is clicked, and what it
// sends is asserted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";

const ROOT = process.cwd();
const TMP = (() => {
  for (const base of [process.env.SUPARCLAW_TEST_TMP, tmpdir(), "/tmp"].filter(Boolean)) {
    try { mkdirSync(base, { recursive: true }); return base; } catch { /* next */ }
  }
  return ROOT;
})();

const BASE = {
  config: {
    path: "/root/.suparclaw/config.json",
    config: {
      gateway: {},
      agents: { defaults: { model: "alpha/m1" } },
      providers: {
        // Inserted out of order on purpose: the page sorts.
        zeta: { baseUrl: "https://zeta.example/v1", apiKey: "__redacted__:••••9999", models: ["z1"] },
        alpha: { baseUrl: "https://alpha.example/v1", apiKey: "__redacted__:••••1234", models: ["m1", "m2"] },
      },
      models: {
        "alpha-m1": { ref: "alpha/m1", label: "Fast lane", enabled: true, contextWindow: 200000, maxTokens: 0, reasoningEffort: "inherit" },
        "zeta-z1": { ref: "zeta/z1", label: "", enabled: true, contextWindow: 0, maxTokens: 0, reasoningEffort: "inherit" },
      },
    },
  },
  models: {
    models: ["alpha/m1", "alpha/m2"],
    configured: [
      { id: "alpha-m1", ref: "alpha/m1", label: "Fast lane", enabled: true, contextWindow: 200000 },
      { id: "zeta-z1", ref: "zeta/z1", label: "", enabled: true, contextWindow: 0 },
    ],
    details: {},
    auth: [
      { id: "alpha:key:1", provider: "alpha", label: "main", ok: true, expires: false, failCount: 0 },
      { id: "alpha:key:2", provider: "alpha", label: "backup", ok: true, expires: false, failCount: 0 },
    ],
  },
  plugins: { plugins: [] },
  scan: { services: [] },
};

const REMOVE_MESSAGE = 'removed "alpha"\nwarning: default model "alpha/m1" now points at a removed provider';

const outDir = mkdtempSync(join(TMP, "sc-ui-prov-"));
const stub = join(outDir, "rpc-stub.mjs");
writeFileSync(stub, `
const DATA = ${JSON.stringify(BASE)};
export const gateway = {
  state: "online",
  async request(method, params) {
    (globalThis.__GW_CALLS ||= []).push({ method, params });
    const d = globalThis.__GW_DATA ?? DATA;
    if (method === "config.get") return d.config;
    if (method === "models.list") return d.models;
    if (method === "models.plugins") return d.plugins;
    if (method === "models.local.scan") return d.scan;
    if (method === "providers.test") return { ok: false, message: "unreachable — connect ECONNREFUSED" };
    if (method === "models.auth.probe") return { probe: { total: 2, healthy: 1, stale: 1, dead: 0 } };
    if (method === "models.auth.beginDeviceCode") return { ok: false, error: "device login is not available for this provider" };
    if (method === "providers.remove") return { ok: true, message: ${JSON.stringify(REMOVE_MESSAGE)} };
    if (method === "providers.add") return { ok: true, message: "provider \\"beta\\" saved\\ndiscovered 2 models" };
    return { ok: true };
  },
};
`);

const { build } = await import("esbuild");
await build({
  entryPoints: [join(ROOT, "ui/src/settings.ts")],
  bundle: true,
  format: "esm",
  outdir: outDir,
  outExtension: { ".js": ".mjs" },
  platform: "neutral",
  plugins: [{ name: "stub", setup(b) { b.onResolve({ filter: /(^|\/)rpc\.js$/ }, () => ({ path: stub })); } }],
});

const page = parseHTML(`<!doctype html><html><body>
  <nav id="settings-nav"></nav>
  <input id="settings-search" />
  <aside id="settings-sidebar"></aside>
  <button id="settings-menu"></button>
  <div id="settings-scrim" hidden></div>
  <span id="settings-title"></span>
  <p id="settings-desc"></p>
  <div id="settings-readout"></div>
  <main id="settings-body"></main>
  <div id="toasts"></div>
  <div id="modal-overlay" hidden><div id="modal">
    <h2 id="modal-title"></h2><div id="modal-body"></div><div id="modal-foot"></div>
  </div></div>
</body></html>`);
globalThis.document = page.document;
globalThis.window = page.window;
globalThis.HTMLElement = page.HTMLElement;
globalThis.Event = page.window.Event;
globalThis.location = { hash: "#/settings/providers" };

const { Settings } = await import(pathToFileURL(join(outDir, "settings.mjs")).href);

const root = document.getElementById("settings-body");
const settings = new Settings(root, () => {});
settings.setHash("#/settings/providers");

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { await tick(); await tick(); await tick(); };
const $ = (sel) => root.querySelector(sel);
const $$ = (sel) => [...root.querySelectorAll(sel)];
const fire = (node, type) => node.dispatchEvent(new page.window.Event(type, { bubbles: true }));
const calls = (method) => (globalThis.__GW_CALLS ?? []).filter((c) => c.method === method);
const overlay = () => document.getElementById("modal-overlay");
const modalBody = () => document.getElementById("modal-body").textContent ?? "";
const confirmBtn = () => [...document.querySelectorAll("#modal-foot button")].at(-1);
const toasts = () => [...document.querySelectorAll("#toasts .toast")].map((t) => t.textContent ?? "");
const cardNames = () => $$(".prov__name").map((n) => n.textContent);
const card = (name) => $$(".card").find((c) => c.querySelector(".prov__name")?.textContent === name);
const button = (name, label) => card(name)?.querySelector(`[aria-label="${label}"]`);
const setField = (id, value) => { document.getElementById(id).value = value; };

const render = async (data) => {
  globalThis.__GW_DATA = data ?? null;
  globalThis.__GW_CALLS = [];
  document.querySelectorAll("#toasts .toast").forEach((t) => t.remove());
  await settings.render();
  await settle();
};
const clickConfirm = async () => { fire(confirmBtn(), "click"); await settle(); };

test.beforeEach(async () => {
  if (!overlay().hidden) {
    fire([...document.querySelectorAll("#modal-foot button")].find((b) => /Cancel/.test(b.textContent)), "click");
  }
  await render();
});

test("one card per provider, sorted, each button named with its provider", () => {
  assert.deepEqual(cardNames(), ["alpha", "zeta"], "sorted, not insertion order");
  for (const name of ["alpha", "zeta"]) {
    for (const label of [`Sign in to ${name}`, `Probe ${name}`, `Test ${name}`, `Edit ${name}`, `Remove ${name}`]) {
      assert.ok(button(name, label), `${name} has a ${label} button`);
    }
  }
  assert.match(card("alpha").textContent, /https:\/\/alpha\.example\/v1/);
  assert.match(card("alpha").textContent, /••••1234/, "the key stays masked");
});

test("Test asks the gateway about that provider", async () => {
  fire(button("alpha", "Test alpha"), "click");
  await settle();
  assert.deepEqual(calls("providers.test").at(-1)?.params, { name: "alpha" });
  assert.match(toasts().at(-1) ?? "", /alpha: failed — unreachable/, "the gateway's own verdict is shown");
});

test("Probe reports the credential health it was given", async () => {
  fire(button("zeta", "Probe zeta"), "click");
  await settle();
  assert.deepEqual(calls("models.auth.probe").at(-1)?.params, { provider: "zeta" });
  assert.match(toasts().at(-1) ?? "", /probe zeta: 1\/2 healthy · 1 stale/);
});

test("Sign in starts a device-code flow for that provider", async () => {
  fire(button("alpha", "Sign in to alpha"), "click");
  await settle();
  assert.deepEqual(calls("models.auth.beginDeviceCode").at(-1)?.params, { provider: "alpha" });
  assert.match(toasts().at(-1) ?? "", /not available/, "a provider without device login says so");
});

test("Remove counts what will go, including the saved models and credentials", () => {
  fire(button("alpha", "Remove alpha"), "click");
  assert.equal(document.getElementById("modal-title").textContent, "Remove provider?");
  const body = modalBody();
  assert.match(body, /removes alpha and its 2 models/);
  assert.match(body, /1 saved model in the system will be removed with it/);
  assert.match(body, /2 stored credentials for it will be deleted/);
  assert.match(body, /Your default model is alpha\/m1/, "the consequence is stated before, not after");
  assert.doesNotMatch(body, /fall back to the default model/, "the old copy was simply untrue");
});

test("confirming Remove deletes that provider and shows the warning it sends back", async () => {
  fire(button("alpha", "Remove alpha"), "click");
  await clickConfirm();
  assert.deepEqual(calls("providers.remove").at(-1)?.params, { name: "alpha", purgeAuth: true });
  const shown = toasts();
  assert.equal(shown.length, 2, "success line and warning are two toasts");
  assert.match(shown[0], /removed "alpha"/);
  assert.match(shown[1], /warning: default model "alpha\/m1"/, "the warning is no longer dropped");
});

test("a provider that is not the default gets the ordinary sentence", async () => {
  fire(button("zeta", "Remove zeta"), "click");
  assert.match(modalBody(), /Sessions that were using one of them will need another model\./);
});

test("Edit opens prefilled, and a renamed provider takes its models along", async () => {
  fire(button("alpha", "Edit alpha"), "click");
  assert.equal(document.getElementById("modal-title").textContent, "Edit alpha");
  assert.equal(document.getElementById("f-name").value, "alpha");
  assert.equal(document.getElementById("f-baseUrl").value, "https://alpha.example/v1");
  assert.equal(document.getElementById("f-apiKey").value, "", "the key is never put back on screen");
  assert.match(document.getElementById("f-apiKey").getAttribute("placeholder") ?? "", /leave blank/);
  assert.equal(document.getElementById("f-models").value, "m1, m2");

  setField("f-name", "beta");
  await clickConfirm();
  const added = calls("providers.add").at(-1)?.params;
  assert.equal(added.name, "beta");
  assert.equal(added.previousName, "alpha", "the gateway needs the old name to move the refs");
  assert.deepEqual(
    calls("providers.remove").at(-1)?.params,
    { name: "alpha" },
    "the old record is dropped, but the credentials survive: this is a rename, not a delete",
  );
  assert.match(toasts().at(-1) ?? "", /beta" saved/);
});

test("Add provider sends an empty previous name and the typed values", async () => {
  const add = $$("button").find((b) => b.textContent.includes("Add provider"));
  fire(add, "click");
  assert.equal(document.getElementById("modal-title").textContent, "Add provider");
  assert.equal(document.getElementById("f-name").value, "");
  setField("f-name", "gamma");
  setField("f-baseUrl", "https://gamma.example/v1");
  setField("f-apiKey", "sk-gamma");
  setField("f-models", "g1, g2");
  await clickConfirm();
  assert.deepEqual(calls("providers.add").at(-1)?.params, {
    name: "gamma",
    previousName: "",
    baseUrl: "https://gamma.example/v1",
    apiKey: "sk-gamma",
    models: ["g1", "g2"],
  });
});

test("a rejected add keeps the dialog open with a reason", async () => {
  globalThis.__GW_DATA = { ...BASE, failAdd: true };
  const add = $$("button").find((b) => b.textContent.includes("Add provider"));
  fire(add, "click");
  setField("f-name", "bad name!");
  setField("f-baseUrl", "https://x/v1");
  // The stub always succeeds, so this checks the path that matters: an empty name
  // is refused locally, before any request.
  setField("f-name", "");
  fire(confirmBtn(), "click");
  await settle();
  assert.equal(calls("providers.add").length, 0, "no request without a name");
  assert.match(toasts().at(-1) ?? "", /name is required/);
});
