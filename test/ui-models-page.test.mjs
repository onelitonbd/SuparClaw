// Settings → Models: a render test, not a source grep.
//
// The tab is booted in linkedom against a stubbed gateway and driven through the
// real controls, because the redesign is about what the page says and does:
//   • one summary line that agrees with the rows under it,
//   • one panel of hairline rows instead of a card per provider,
//   • a status that is a dot + a word, not a sentence,
//   • every control reachable by keyboard (no onclick on a container),
//   • the ways to add a provider (device + plugins) in one panel,
//   • a real empty state — the old one was built into a node never appended.

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

const refs = (provider, n) => Array.from({ length: n }, (_, i) => `${provider}/model-${i + 1}`);
const configuredRef = (ref, enabled = true) => ({ id: ref, ref, label: "", contextWindow: 0, enabled });

const BASE = {
  config: {
    path: "/root/.suparclaw/config.json",
    config: {
      gateway: {},
      agents: { defaults: { model: "openrouter/model-1" } },
      providers: {
        openai: { baseUrl: "https://api.openai.com/v1", apiKey: "" },
        openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKey: "sc_live01" },
        ollama: { baseUrl: "http://localhost:11434/v1", apiKey: "sc_gone42" },
      },
    },
  },
  models: {
    models: [...refs("openrouter", 41), ...refs("ollama", 9)],
    configured: [
      ...refs("openrouter", 12).map((r) => configuredRef(r)),
      ...refs("openai", 6).map((r) => configuredRef(r)),
      ...refs("ollama", 2).map((r) => configuredRef(r)),
      configuredRef("openrouter/model-13", false), // switched off — must not count
    ],
    details: {},
    auth: [
      { id: "sc_live01", provider: "openrouter", label: "main", ok: true, expires: true, expiresIn: "7d", failCount: 0 },
      { id: "sc_slow02", provider: "openrouter", label: "backup", ok: false, reason: "cooldown", expires: false, failCount: 2 },
    ],
  },
  plugins: {
    plugins: [
      { id: "gemini", label: "Google Gemini", authMethods: ["api-key"] },
      { id: "openrouter", label: "OpenRouter", authMethods: ["api-key"] },
    ],
  },
  scan: {
    services: [
      { id: "lmstudio", running: false, models: [], api: "openai" },
      // not one of the providers above, so it is offered as "Add" rather than
      // "re-scan" — ollama is already configured and must read differently.
      { id: "vllm", running: true, models: ["qwen2.5-coder", "llama3"], api: "openai", hints: { llama3: { contextWindow: 8192 } } },
      { id: "ollama", running: true, models: ["llama3"], api: "ollama" },
    ],
  },
};

const outDir = mkdtempSync(join(TMP, "sc-ui-models-"));
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
    if (method === "models.local.scan") {
      if (d.scan === "throw") throw new Error("models.local.scan is not supported");
      return d.scan;
    }
    if (method === "models.local.add") return { ok: true, message: "added " + params.service };
    if (method === "models.auth.order") return { ok: true };
    if (method === "tools.list") return { tools: [] };
    if (method === "skills.list") return { skills: [] };
    return { ok: true };
  },
};
`);

const { build } = await import("esbuild");
await build({
  entryPoints: [join(ROOT, "ui/src/settings.ts"), join(ROOT, "ui/src/model-name.ts")],
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
const render = async (data) => {
  globalThis.__GW_DATA = data ?? null;
  globalThis.__GW_CALLS = [];
  await settings.render();
  await tick(); // let the async local-service scan land
};
const $ = (sel) => root.querySelector(sel);
const $$ = (sel) => [...root.querySelectorAll(sel)];
const row = (name) => root.querySelector(`.models__row[data-provider="${name}"]`);
const stateText = (name) => row(name)?.querySelector(".models__state")?.textContent?.trim() ?? "";
const dotClass = (name) => row(name)?.querySelector(".models__dot")?.getAttribute("class") ?? "";
const summary = () => document.getElementById("models-summary")?.textContent?.trim() ?? "";
const fire = (node, type, props = {}) => {
  const ev = new page.window.Event(type, { bubbles: true });
  Object.assign(ev, props);
  node.dispatchEvent(ev);
  return ev;
};
const calls = (method) => (globalThis.__GW_CALLS ?? []).filter((c) => c.method === method);

// Each test starts from the fixture, so a failure in one cannot cascade into
// the next one's DOM.
test.beforeEach(async () => {
  await render();
});

test("the summary states the totals the rows add up to", () => {
  assert.equal(
    summary(),
    "20 models in the system across 3 providers. 1 provider needs a key. 1 provider has a missing auth profile.",
  );
  // 12 + 6 + 2 enabled rows; the switched-off row and the 41 advertised models
  // are not part of "in the system".
  const counted = $$(".models__row").reduce((n, r) => {
    const t = r.querySelector(".models__count")?.textContent ?? "";
    return n + Number(t.split(" ")[0] ?? 0);
  }, 0);
  assert.equal(counted, 20, "the rows and the summary agree");
});

test("one panel of rows, alphabetical, each with a monogram", () => {
  assert.equal($$(".models__row").length, 3);
  assert.deepEqual($$(".models__row").map((r) => r.getAttribute("data-provider")), ["ollama", "openai", "openrouter"]);
  assert.deepEqual($$(".models__mark").map((m) => m.textContent), ["OA", "OI", "OR"]);
  assert.equal($$(".prov-card").length, 0, "no card per provider any more");
  assert.equal($$(".models__mark")[0].getAttribute("aria-hidden"), "true", "the monogram is decoration");
});

test("state is a dot plus a word, and it names what is wrong", () => {
  assert.equal(stateText("openrouter"), "sc_live01 · 7d");
  assert.match(dotClass("openrouter"), /models__dot--ok/);

  assert.equal(stateText("openai"), "no key yet");
  assert.match(dotClass("openai"), /models__dot--idle/);

  // a saved binding pointing at a profile that no longer exists is a failure
  assert.equal(stateText("ollama"), "profile missing");
  assert.match(dotClass("ollama"), /models__dot--err/);
});

test("counts come from the config, and never read '0 of 0'", async () => {
  assert.equal(row("openrouter").querySelector(".models__count").textContent, "12 of 41");
  assert.equal(row("openai").querySelector(".models__count").textContent, "6 in the system", "no catalog: no denominator");
  assert.equal(row("ollama").querySelector(".models__count").textContent, "2 of 9");
  assert.ok(!/0 of 0/.test(root.textContent), "the bug this replaces");

  // Stale catalog: the gateway could not refresh. Enabled rows are still the truth.
  await render({ ...BASE, models: { ...BASE.models, models: [], warning: "saved rows shown — could not refresh from the provider" } });
  assert.equal(row("openrouter").querySelector(".models__count").textContent, "12 in the system");
  assert.match(summary(), /^20 models in the system across 3 providers\./, "the totals survive a stale catalog");
  assert.match($(".models__warn")?.textContent ?? "", /could not refresh/, "the reason is on this tab now");
});

test("Open goes to the provider's models and comes back", async () => {
  fire(row("openrouter").querySelector(".models__name"), "click");
  await tick();
  assert.ok(document.getElementById("model-search"), "the provider page rendered");
  assert.ok(root.textContent.includes("Checked models are in the system"));

  const back = $$("button").find((b) => b.textContent.includes("← Providers"));
  fire(back, "click");
  await tick();
  assert.equal($$(".models__row").length, 3, "back to the tab");
});

test("Connect and Auth… are separate, labelled buttons", () => {
  const openai = row("openai");
  const connect = openai.querySelector('[aria-label="Connect openai"]');
  assert.ok(connect, "unbound provider offers Connect");
  assert.equal(openai.querySelector('[aria-label="Auth openai"]'), null);

  const openrouter = row("openrouter");
  assert.ok(openrouter.querySelector('[aria-label="Auth openrouter"]'), "bound provider offers Auth…");
  assert.ok(openrouter.querySelector('[aria-label="Open openrouter"]'), "the row action is labelled with its provider");
});

test("Connect opens the auth dialog for that provider", () => {
  fire(row("openai").querySelector('[aria-label="Connect openai"]'), "click");
  assert.equal(document.getElementById("modal-title").textContent, "Connect openai");
  assert.ok(document.getElementById("auth-key"), "the paste-key field is there");
  assert.equal(document.getElementById("modal-overlay").hasAttribute("hidden"), false);
});

test("auth chips are buttons, and clicking one reorders the profiles", async () => {
  const chips = $$('.models__row[data-provider="openrouter"] .models__chips button');
  assert.equal(chips.length, 2, "every profile is shown, none hidden behind a cap");
  assert.ok(chips[1].textContent.includes("sc_slow02"));

  fire(chips[1], "click");
  await tick();
  const order = calls("models.auth.order").at(-1);
  assert.deepEqual(order?.params, { provider: "openrouter", ids: ["sc_slow02", "sc_live01"] });
});

test("an install with no providers says so, and offers the way out", async () => {
  await render({ ...BASE, config: { ...BASE.config, config: { ...BASE.config.config, providers: {} } } });
  assert.equal(summary(), "No models in the system yet.");
  const go = document.getElementById("models-empty-providers");
  assert.ok(go, "the empty state is in the document (it used to be built and dropped)");
  assert.ok(root.contains(go));
});

test("the add panel lists device services and plugins, and their actions work", async () => {
  assert.ok(root.textContent.includes("On this device"));
  assert.ok(root.textContent.includes("Provider plugins"));

  // running services first, then stopped ones, each group by id
  // only the "On this device" group — the plugins group below has rows too
  const deviceRows = [...$$(".models__group")[0].querySelectorAll(".ledger__row")];
  const vllm = deviceRows.find((r) => r.textContent.includes("vllm"));
  assert.ok(vllm, "the running service is listed");
  assert.match(vllm.textContent, /running · 2 models · openai-compat/);
  assert.match(vllm.textContent, /llama3 \(ctx 8k\)/, "the model list rides under its service");
  assert.match(deviceRows.at(-1).textContent, /lmstudio/, "a stopped service sorts last");
  assert.match(deviceRows.at(-1).textContent, /not running/);
  // already configured ⇒ re-scan, not Add
  assert.ok(root.querySelector('[aria-label="Re-scan ollama"]'), "a configured service is not offered as new");

  fire(root.querySelector('[aria-label="Add vllm"]'), "click");
  await tick();
  assert.deepEqual(calls("models.local.add").at(-1)?.params, { service: "vllm" });
  assert.ok(root.querySelector('[aria-label="Add lmstudio"]').disabled, "a stopped service cannot be added");

  // A plugin row connects through the same dialog as a provider.
  const gemini = $$(".ledger__pattern").find((n) => n.textContent === "gemini");
  fire(gemini.parentElement.parentElement.querySelector("button"), "click");
  assert.equal(document.getElementById("modal-title").textContent, "Connect gemini");
  // Already-configured providers are not offered again as a plugin.
  assert.ok(!$$(".ledger__pattern").some((n) => n.textContent === "openrouter"));
});

test("a gateway without local discovery says so instead of scanning forever", async () => {
  await render({ ...BASE, scan: "throw" });
  assert.match(root.textContent, /not available in this gateway/);
  assert.ok(!root.textContent.includes("Scanning this device"), "the placeholder is replaced, not left up");
});

test("nothing on the tab relies on inline styles", () => {
  assert.deepEqual($$("[style]").map((n) => n.tagName), []);
});
