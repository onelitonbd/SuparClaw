// Settings → Tools → Web search: which provider answers, what it needs, and how
// much it returns.
//
// The card wrote config on every click (five different paths, no draft), showed
// credentials only for the already-selected provider — so storing a Brave key meant
// first switching the agent to Brave — could not touch maxResults or the cache TTL,
// and collapsed to a single sentence when web.search.get failed.

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

const MASK = "__redacted__:••••1234";

const CONFIG = {
  agents: { defaults: {} },
  gateway: {},
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "brave",
        maxResults: 5,
        cacheTtlMinutes: 15,
        brave: { apiKey: MASK, baseUrl: "https://api.search.brave.com" },
        perplexity: { apiKey: "__redacted__:••••9999", baseUrl: "https://api.perplexity.ai" },
        tavily: { apiKey: "", baseUrl: "https://api.tavily.com" },
        kimi: { apiKey: "", baseUrl: "" },
        duckduckgo: { baseUrl: "" },
        searxng: { baseUrl: "" },
      },
    },
  },
};

const GET = {
  enabled: true,
  provider: "brave",
  maxResults: 5,
  cacheTtlMinutes: 15,
  effective: "brave",
  autoCandidates: ["brave", "perplexity"],
  providers: [
    { id: "brave", ready: true, keyFree: false, hasKey: true, configBaseUrl: "https://api.search.brave.com" },
    { id: "perplexity", ready: true, keyFree: false, hasKey: true, configBaseUrl: "https://api.perplexity.ai" },
    { id: "tavily", ready: false, keyFree: false, hasKey: false, configBaseUrl: "https://api.tavily.com" },
    { id: "kimi", ready: true, keyFree: false, hasKey: true, configBaseUrl: "(moonshot llm host)" },
    { id: "searxng", ready: false, keyFree: true, hasKey: true, configBaseUrl: "" },
    { id: "duckduckgo", ready: true, keyFree: true, hasKey: true, configBaseUrl: "" },
  ],
  keyMasks: { brave: MASK, perplexity: "__redacted__:••••9999", tavily: "", kimi: "" },
};

const outDir = mkdtempSync(join(TMP, "sc-ui-websearch-"));
const stub = join(outDir, "rpc-stub.mjs");
writeFileSync(stub, `
export const gateway = {
  state: "online",
  async request(method, params) {
    (globalThis.__GW_CALLS ||= []).push({ method, params });
    const cfg = () => JSON.parse(JSON.stringify(globalThis.__CFG ?? ${JSON.stringify(CONFIG)}));
    if (method === "config.get") return { config: cfg(), path: "/home/u/.suparclaw/openclaw.json5" };
    if (method === "config.set") {
      if (globalThis.__GW_FAIL_SET) throw new Error(globalThis.__GW_FAIL_SET);
      const next = cfg();
      let node = next;
      const parts = String(params.path).split(".");
      for (const p of parts.slice(0, -1)) node = (node[p] ||= {});
      if (params.value === null) delete node[parts.at(-1)];
      else node[parts.at(-1)] = params.value;
      globalThis.__CFG = next;
      return { ok: true };
    }
    if (method === "models.list") return { models: [], configured: [], details: {}, auth: [] };
    if (method === "tools.list") return { tools: [] };
    if (method === "skills.list") return { skills: [] };
    if (method === "models.plugins") return { plugins: [] };
    if (method === "codeMode.get") return { enabled: "auto", engaged: false, catalog: [], preferred: [] };
    if (method === "media.get") return { defaults: {}, models: [] };
    if (method === "web.search.get") {
      if (globalThis.__GW_FAIL_WS) throw new Error(globalThis.__GW_FAIL_WS);
      return { ...${JSON.stringify(GET)}, ...(globalThis.__WS ?? {}) };
    }
    if (method === "web.search.test") {
      if (globalThis.__GW_FAIL_TEST) throw new Error(globalThis.__GW_FAIL_TEST);
      return { ok: true, provider: params?.provider ?? "brave", count: 2, tookMs: 42, firstTitles: ["A", "B"] };
    }
    return { ok: true };
  },
};
`);

const { build } = await import("esbuild");
await build({
  entryPoints: [join(ROOT, "ui/src/settings.ts")],
  bundle: true, format: "esm", outdir: outDir, outExtension: { ".js": ".mjs" }, platform: "neutral",
  plugins: [{ name: "stub", setup(b) { b.onResolve({ filter: /(^|\/)rpc\.js$/ }, () => ({ path: stub })); } }],
});

const page = parseHTML(`<!doctype html><html><body>
  <div class="settings__main"><div id="settings-body"></div></div>
  <nav id="settings-nav"></nav><input id="settings-search" /><aside id="settings-sidebar"></aside>
  <button id="settings-menu"></button><div id="settings-scrim" hidden></div>
  <span id="settings-title"></span><p id="settings-desc"></p><div id="settings-readout"></div>
  <div id="toasts"></div>
  <div id="modal-overlay" hidden><div id="modal"><h2 id="modal-title"></h2><div id="modal-body"></div><div id="modal-foot"></div></div></div>
</body></html>`);
globalThis.document = page.document;
globalThis.window = page.window;
globalThis.HTMLElement = page.HTMLElement;
globalThis.Event = page.window.Event;
globalThis.location = { hash: "#/settings/tools", reload() {} };

const focused = [];
page.HTMLElement.prototype.focus = function () { focused.push(this); };

const { Settings } = await import(pathToFileURL(join(outDir, "settings.mjs")).href);
const root = document.getElementById("settings-body");

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { await tick(); await tick(); await tick(); };
const byId = (id) => document.getElementById(id);
const $ = (sel) => root.querySelector(sel);
const $$ = (sel) => [...root.querySelectorAll(sel)];
const fire = (node, type) => node.dispatchEvent(new page.window.Event(type, { bubbles: true }));
const tap = async (node) => { fire(node, "click"); await settle(); };
const click = async (id) => { await tap(byId(id)); };
const calls = (method) => (globalThis.__GW_CALLS ?? []).filter((c) => c.method === method);
const sets = () => calls("config.set");
const noteText = () => $(".web-search .setfoot__note")?.textContent ?? "";
const tag = () => $(".web-search .setcard__status .settings__tag").textContent;
const statusNote = () => $(".web-search .setcard__status-note").textContent;
const type = async (id, value) => {
  const node = byId(id);
  node.value = value;
  fire(node, "input");
  await settle();
};
const echoOf = (label) => {
  const field = $$(".web-search .setfield").find((f) => f.querySelector(".lbl")?.textContent === label);
  return field?.querySelector(".setcard__echo")?.textContent ?? "";
};
const stateOf = (id) => byId(id).closest(".setfield")?.querySelector(".settings__tag")?.textContent ?? "";

const open = async ({ cfg, ws, failWs, failSet, failTest } = {}) => {
  globalThis.__GW_CALLS = [];
  globalThis.__CFG = JSON.parse(JSON.stringify(cfg ?? CONFIG));
  globalThis.__WS = ws ?? null;
  globalThis.__GW_FAIL_WS = failWs ?? "";
  globalThis.__GW_FAIL_SET = failSet ?? "";
  globalThis.__GW_FAIL_TEST = failTest ?? "";
  document.querySelectorAll("#toasts .toast").forEach((t) => t.remove());
  root.innerHTML = "";
  focused.length = 0;
  const settings = new Settings(root, () => {});
  settings.setHash("#/settings/tools");
  await settings.render();
  await settle();
};

test.beforeEach(async () => { await open(); });

test("one card, one save, and rendering writes nothing", () => {
  assert.equal($$(".web-search").length, 1);
  assert.equal($$("#websearch-save").length, 1);
  assert.equal(sets().length, 0);
});

test("every provider's credentials are visible at once", () => {
  for (const id of ["brave", "perplexity", "tavily", "kimi"]) {
    assert.ok(byId(`ws-key-${id}`), `${id} key field is rendered`);
  }
  assert.ok(byId("ws-url-searxng"));
  assert.ok(byId("ws-url-duckduckgo"));
  assert.equal(byId("ws-key-brave").getAttribute("type"), "password");
  assert.equal(byId("ws-key-brave").value, "", "a stored key is never a value in the field");
});

test("key state distinguishes stored, environment and missing", () => {
  assert.equal(stateOf("ws-key-brave"), "stored · ••••1234");
  assert.equal(stateOf("ws-key-tavily"), "no key");
  assert.equal(stateOf("ws-key-kimi"), "from the environment");
  assert.match(byId("ws-key-kimi").closest(".setfield").textContent, /Read from the environment/);
});

test("an explicit provider says it never falls back, and a not-ready one says what that costs", async () => {
  assert.equal(tag(), "on · brave");
  assert.match(statusNote(), /no fallback/);
  await click("ws-provider-tavily");
  assert.equal(tag(), "on · tavily");
  assert.match(statusNote(), /every search fails until its key is set/);
  assert.match($(".web-search .setcard__status .settings__tag").getAttribute("class"), /is-warn/);
  assert.equal(sets().length, 0, "choosing stages, it does not write");
  assert.ok(byId("ws-provider-tavily").classList.contains("is-off"));
});

test("auto stages the empty string, never the word auto", async () => {
  await click("ws-provider-auto");
  assert.match(statusNote(), /auto uses the first ready provider in this order: brave → perplexity/);
  await click("websearch-save");
  assert.equal(sets().at(-1).params.value.provider, "", "auto is the empty provider id");
});

test("saving writes the whole block once and keeps what it does not touch", async () => {
  await type("ws-key-brave", "sk-brand-new-9876");
  await type("ws-url-searxng", "https://searx.example.com");
  await type("ws-max", "3");
  await type("ws-cache", "0");
  await click("websearch-save");
  const writes = sets();
  assert.equal(writes.length, 1, "one write, not five");
  assert.equal(writes[0].params.path, "tools.web.search");
  const v = writes[0].params.value;
  assert.equal(v.maxResults, 3);
  assert.equal(v.cacheTtlMinutes, 0);
  assert.equal(v.brave.apiKey, "sk-brand-new-9876", "a typed key replaces");
  assert.equal(v.perplexity.apiKey, "__redacted__:••••9999", "an untouched key stays the sentinel, so the store keeps it");
  assert.equal(v.tavily.apiKey, "", "an empty slot stays empty");
  assert.equal(v.searxng.baseUrl, "https://searx.example.com");
  assert.equal(v.brave.baseUrl, "https://api.search.brave.com", "keys the card does not show survive");
  assert.equal(noteText(), "", "a landed save clears the marker");
});

test("the two limits are validated, and 0 for the cache means bypass", async () => {
  assert.equal(echoOf("Results per search"), "5 results");
  assert.equal(echoOf("Cache TTL (minutes)"), "15 min");
  await type("ws-cache", "0");
  assert.equal(echoOf("Cache TTL (minutes)"), "cache bypassed");
  await type("ws-max", "0");
  await type("ws-cache", "1441");
  await click("websearch-save");
  assert.equal(sets().length, 0, "nothing written");
  const problem = $(".web-search .hint--err");
  assert.equal(problem.hasAttribute("hidden"), false);
  assert.match(problem.textContent, /results per search must be a whole number 1–10/);
  assert.match(problem.textContent, /cache TTL must be a whole number 0–1440/);
  assert.equal(byId("ws-max").getAttribute("aria-invalid"), "true");
  assert.ok(focused.includes(byId("ws-max")));
});

test("the test button acts against the saved config and writes nothing", async () => {
  await click("ws-provider-tavily");
  await click("ws-test");
  const call = calls("web.search.test").at(-1);
  assert.equal(call.params.provider, "brave", "the saved provider, not the unsaved draft");
  assert.equal(sets().length, 0);
  assert.match(byId("ws-test-out").textContent, /✓ brave · 2 result\(s\) in 42ms/);
  // It belongs beside the provider it exercises, not in the commit band.
  assert.match($(".web-search .setsec").textContent, /Test saved settings/);
  assert.doesNotMatch($(".web-search .setfoot").textContent, /Test saved settings/);
  assert.equal($$(".web-search .setfoot > *").length, 3, "note, error line, save");
});

test("a failing test says so instead of going blank", async () => {
  await open({ failTest: "network down" });
  await click("ws-test");
  assert.match(byId("ws-test-out").textContent, /✗ network down/);
});

test("the provider choice marks the draft, and the marker clears on save", async () => {
  assert.equal(noteText(), "");
  await click("ws-provider-perplexity");
  assert.equal(noteText(), "Unsaved changes");
  await click("websearch-save");
  assert.equal(noteText(), "");
});

test("a failing web.search.get costs the provider list, not the section", async () => {
  await open({ failWs: "socket closed" });
  assert.match($(".web-search").textContent, /Provider list could not be read — socket closed/);
  assert.ok(byId("ws-enabled"), "the tool switch is still there");
  assert.ok(byId("ws-max"), "and the limits");
  assert.match($(".web-search").textContent, /nothing to configure here right now/);
  await type("ws-max", "4");
  await click("websearch-save");
  assert.equal(sets().length, 1, "and it still saves");
  assert.equal(sets().at(-1).params.value.maxResults, 4);
  assert.equal(sets().at(-1).params.value.brave.apiKey, MASK, "untouched credentials are written back as stored");
});

test("turning the tool off is a draft edit with a consequence", async () => {
  const cb = byId("ws-enabled");
  cb.checked = false;
  fire(cb, "change");
  await settle();
  assert.equal(tag(), "off");
  assert.match(statusNote(), /not offered to the agent at all/);
  await click("websearch-save");
  assert.equal(sets().at(-1).params.value.enabled, false);
});

test("a rejected save keeps the draft and says why", async () => {
  await open({ failSet: "config is read-only" });
  await type("ws-max", "8");
  await click("websearch-save");
  const problem = $(".web-search .hint--err");
  assert.equal(problem.hasAttribute("hidden"), false);
  assert.match(problem.textContent, /not saved — config is read-only/);
  assert.equal(byId("ws-max").value, "8");
  assert.equal(byId("websearch-save").disabled, false);
});
