// Settings → Models → (provider) → Tune / Configure: a behaviour test.
//
// The popup promises four things, and each one has been wrong here at some
// point: it opens on the values that are stored, what you type is what is
// saved, blanking a field really blanks it, and tuning a model never changes
// whether it is in the system. So this drives the real popup in linkedom
// against a stubbed gateway and asserts the exact `models.save` payload.

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
      agents: { defaults: { model: "openrouter/model-1" } },
      providers: { openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKey: "sc_live01" } },
    },
  },
  models: {
    models: ["openrouter/model-1", "openrouter/model-2", "openrouter/model-3"],
    configured: [
      {
        id: "openrouter-model-1",
        ref: "openrouter/model-1",
        label: "Fast lane",
        contextWindow: 200000,
        maxTokens: 640,
        temperature: 0.2,
        reasoningEffort: "high",
        enabled: true,
      },
      // In the config, deliberately switched off: "Tune" must not switch it back on.
      { id: "openrouter-model-2", ref: "openrouter/model-2", label: "", contextWindow: 0, maxTokens: 0, reasoningEffort: "inherit", enabled: false },
    ],
    // Never added: only the provider knows its window.
    details: { "openrouter/model-3": { contextWindow: 128000 } },
    auth: [{ id: "sc_live01", provider: "openrouter", label: "main", ok: true, expires: true, expiresIn: "7d", failCount: 0 }],
  },
  plugins: { plugins: [{ id: "openrouter", label: "OpenRouter", authMethods: ["api-key"] }] },
  scan: { services: [] },
};

const outDir = mkdtempSync(join(TMP, "sc-ui-tune-"));
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
    if (method === "models.save") {
      // Optional latency, so the double-submit guard can be observed.
      if (d.hold) await new Promise((r) => setTimeout(r, 20));
      return { ok: true, id: params.id ?? "new", models: [] };
    }
    if (method === "models.remove") return { ok: true, models: [] };
    if (method === "tools.list") return { tools: [] };
    if (method === "skills.list") return { skills: [] };
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
globalThis.location = { hash: "#/settings/models" };

const { Settings } = await import(pathToFileURL(join(outDir, "settings.mjs")).href);

const root = document.getElementById("settings-body");
const settings = new Settings(root, () => {});
settings.setHash("#/settings/models");

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { await tick(); await tick(); await tick(); };
const $ = (sel) => root.querySelector(sel);
const $$ = (sel) => [...root.querySelectorAll(sel)];
const fire = (node, type) => node.dispatchEvent(new page.window.Event(type, { bubbles: true }));
const calls = (method) => (globalThis.__GW_CALLS ?? []).filter((c) => c.method === method);
const overlay = () => document.getElementById("modal-overlay");
const saveBtn = () => document.querySelector("#modal-foot .btn.pri");
const field = (name) => document.getElementById(`f-${name}`);
const rowOf = (ref) => $$(".pickrow").find((r) => r.querySelector(".pickrow__name")?.getAttribute("title") === ref);
const tuneOf = (ref) => rowOf(ref).querySelector(".pickrow > .btn");
const lastToast = () => document.querySelector("#toasts .toast:last-child")?.textContent ?? "";

/** Settings → Models → OpenRouter, from wherever the previous test left it. */
const openProvider = async (data) => {
  globalThis.__GW_DATA = data ?? null;
  globalThis.__GW_CALLS = [];
  await settings.render();
  await settle();
  const back = [...root.querySelectorAll("button")].find((b) => b.textContent.includes("← Providers"));
  if (back) {
    fire(back, "click");
    await settle();
  }
  const row = root.querySelector('.models__row[data-provider="openrouter"] .models__name');
  assert.ok(row, "the models tab lists the provider");
  fire(row, "click");
  await settle();
};

/** Open the popup for a model and (optionally) type into its fields. */
const tune = async (ref, values = {}) => {
  fire(tuneOf(ref), "click");
  for (const [name, value] of Object.entries(values)) field(name).value = value;
};
const save = async () => { fire(saveBtn(), "click"); await settle(); };

test.beforeEach(async () => { await openProvider(); });

test("a saved label is what the row shows, and the title stays the exact ref", () => {
  const named = rowOf("openrouter/model-1").querySelector(".pickrow__name");
  assert.equal(named.textContent, "Fast lane");
  assert.equal(named.getAttribute("title"), "openrouter/model-1", "the id is still one hover away");
  assert.ok(!/mono/.test(named.getAttribute("class") ?? ""), "a name is set in text, a ref in mono");

  const plain = rowOf("openrouter/model-2").querySelector(".pickrow__name");
  assert.equal(plain.textContent, "model-2", "no label → the short ref");
  assert.match(plain.getAttribute("class") ?? "", /mono/);
});

test("the popup opens on the values that are stored", () => {
  fire(tuneOf("openrouter/model-1"), "click");
  assert.equal(document.getElementById("modal-title").textContent, "openrouter/model-1");
  assert.equal(overlay().hidden, false);
  assert.equal(field("label").value, "Fast lane");
  assert.equal(field("contextWindow").value, "200000");
  assert.equal(field("maxTokens").value, "640");
  assert.equal(field("temperature").value, "0.2");
  assert.equal(document.getElementById("f-effort").value, "high");
  assert.equal(saveBtn().textContent, "Save", "an existing model is not re-announced as new");
});

test("the button reads Configure on a model that is not in the system", () => {
  assert.equal(tuneOf("openrouter/model-1").textContent, "Tune");
  assert.equal(tuneOf("openrouter/model-3").textContent, "Configure");
  fire(tuneOf("openrouter/model-3"), "click");
  assert.equal(saveBtn().textContent, "Save & select");
  assert.equal(field("contextWindow").value, "128000", "a new row starts from the provider's figure");
  assert.equal(field("temperature").value, "");
});

test("saving sends exactly what was typed, and keeps a switched-off model off", async () => {
  await tune("openrouter/model-2", { label: "Cheap lane", contextWindow: "64000", temperature: "0.5" });
  await save();
  const saved = calls("models.save").at(-1)?.params;
  assert.deepEqual(saved, {
    id: "openrouter-model-2",
    ref: "openrouter/model-2",
    label: "Cheap lane",
    contextWindow: 64000,
    maxTokens: 0,
    temperature: 0.5,
    reasoningEffort: "inherit",
    enabled: false,
  });
  assert.equal(overlay().hidden, true, "the popup closes on success");
  assert.match(lastToast(), /still switched off/, "it does not pretend to have selected it");
});

test("clearing the temperature sends an explicit null, not nothing", async () => {
  await tune("openrouter/model-1", { temperature: "" });
  await save();
  const saved = calls("models.save").at(-1)?.params;
  assert.equal(saved.temperature, null, "absent would mean 'keep 0.2' on the gateway");
  assert.equal(saved.contextWindow, 200000, "untouched fields keep their stored value");
  assert.equal(saved.reasoningEffort, "high");
  assert.equal(saved.enabled, true);
});

test("a typo is refused, not quietly turned into 0", async () => {
  await tune("openrouter/model-1", { contextWindow: "200k", maxTokens: "-1" });
  await save();
  assert.equal(calls("models.save").length, 0, "nothing was sent");
  assert.equal(overlay().hidden, false, "the popup stays open with the typo in it");
  assert.equal(field("contextWindow").getAttribute("aria-invalid"), "true");
  assert.equal(field("maxTokens").getAttribute("aria-invalid"), "true");
  const note = document.querySelector("#modal-body .hint--err");
  assert.match(note.textContent, /context window and max output tokens/);
  assert.equal(note.hasAttribute("hidden"), false);

  // and fixing it saves — the warning is not sticky
  field("contextWindow").value = "200000";
  field("maxTokens").value = "0";
  await save();
  assert.equal(field("contextWindow").hasAttribute("aria-invalid"), false);
  assert.equal(calls("models.save").at(-1)?.params.contextWindow, 200000);
  assert.equal(overlay().hidden, true);
});

test("a negative temperature is a typo too", async () => {
  await tune("openrouter/model-1", { temperature: "-0.5" });
  await save();
  assert.equal(calls("models.save").length, 0);
  assert.match(document.querySelector("#modal-body .hint--err").textContent, /temperature/);
});

test("two clicks on Save are one request", async () => {
  globalThis.__GW_DATA = { ...BASE, hold: true };
  fire(tuneOf("openrouter/model-1"), "click");
  fire(saveBtn(), "click");
  fire(saveBtn(), "click");
  assert.equal(saveBtn().textContent, "Saving…", "the button says what is happening");
  await new Promise((r) => setTimeout(r, 60));
  await settle();
  assert.equal(calls("models.save").length, 1);
});

test("Remove from system removes the row's own profile and closes", async () => {
  fire(tuneOf("openrouter/model-1"), "click");
  const remove = [...document.querySelectorAll("#modal-body button")].find((b) => /Remove from system/.test(b.textContent));
  assert.ok(remove, "an existing model offers the removal");
  fire(remove, "click");
  await settle();
  assert.deepEqual(calls("models.remove").at(-1)?.params, { id: "openrouter-model-1" });
  assert.equal(overlay().hidden, true);
  assert.match(lastToast(), /openrouter\/model-1 removed/);
});

test("a model that is not in the system offers no removal", async () => {
  fire(tuneOf("openrouter/model-3"), "click");
  assert.equal([...document.querySelectorAll("#modal-body button")].some((b) => /Remove from system/.test(b.textContent)), false);
});

test("the row switch is the accept switch, and it keeps the stored tuning", async () => {
  const box = rowOf("openrouter/model-1").querySelector(".model-check");
  assert.equal(box.checked, true);
  box.checked = false;
  fire(box, "change");
  await settle();
  const saved = calls("models.save").at(-1)?.params;
  assert.equal(saved.enabled, false);
  assert.equal(saved.id, "openrouter-model-1", "same profile, so it is never forked");
  assert.equal(saved.contextWindow, 200000);
  assert.equal(saved.maxTokens, 640);
  assert.equal(saved.temperature, 0.2, "switching off must not drop the temperature");
  assert.equal(saved.reasoningEffort, "high");
  assert.match(lastToast(), /model-1 removed from the system/);
});

test("switching an unknown model on adds it with the provider's window", async () => {
  const box = rowOf("openrouter/model-3").querySelector(".model-check");
  assert.equal(box.checked, false);
  box.checked = true;
  fire(box, "change");
  await settle();
  const saved = calls("models.save").at(-1)?.params;
  assert.equal(saved.enabled, true);
  assert.equal(saved.ref, "openrouter/model-3");
  assert.equal(saved.contextWindow, 128000);
  assert.match(lastToast(), /model-3 is in the system/);
});
