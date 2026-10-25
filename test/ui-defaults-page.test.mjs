// Settings → Defaults page: the redesigned surface (their Agents Defaults).
//
// This is a RENDER test, not a source-grep test — it boots ui/src/settings.ts
// in linkedom with a stubbed gateway and clicks the real controls, because the
// whole point of the redesign is what happens when you use it:
//   • no native <select> anywhere (a hidden one is only the value store),
//   • every menu is a custom listbox, search appears past eight choices,
//   • the persona field is a textarea,
//   • fallbacks are chips in priority order + one "add" menu,
//   • Save writes the documented config leaves.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";

const ROOT = process.cwd();

const TEST_TMP = (() => {
  for (const base of [process.env.SUPARCLAW_TEST_TMP, tmpdir(), "/tmp"].filter(Boolean)) {
    try { mkdirSync(base, { recursive: true }); return base; } catch { /* next candidate */ }
  }
  return ROOT;
})();

/** Enough models that the spec's "more than eight choices include search" kicks in. */
const MODELS = [
  { id: "google/gemini-3.1-flash-lite", label: "Google/gemini-3.1-flash-lite", ref: "google", enabled: true },
  { id: "google/gemini-3.1-pro", label: "Google/gemini-3.1-pro", ref: "google", enabled: true },
  { id: "openrouter/anthropic/claude-sonnet-4.5", label: "OpenRouter/anthropic/claude-sonnet-4.5", ref: "openrouter", enabled: true },
  { id: "openrouter/meta-llama/llama-3.3-70b", label: "OpenRouter/meta-llama/llama-3.3-70b-instruct", ref: "openrouter", enabled: true },
  { id: "kilo/minimax/minimax-m3.1-flash:free", label: "Kilo/minimax/minimax-m3.1-flash:free", ref: "kilo", enabled: true },
  { id: "kilo/qwen/qwen3-coder:free", label: "Kilo/qwen/qwen3-coder:free", ref: "kilo", enabled: true },
  { id: "mistral/mistral-large-latest", label: "Mistral/mistral-large-latest", ref: "mistral", enabled: true },
  { id: "mistral/codestral-latest", label: "Mistral/codestral-latest", ref: "mistral", enabled: true },
  { id: "xai/grok-4", label: "Xai/grok-4", ref: "xai", enabled: true },
  { id: "deepseek/deepseek-chat", label: "Deepseek/deepseek-chat", ref: "deepseek", enabled: true },
  { id: "openai/gpt-4o-mini", label: "Openai/gpt-4o-mini", ref: "openai", enabled: true },
  { id: "ollama/llama3.2", label: "Ollama/llama3.2", ref: "ollama", enabled: false }, // unchecked → not offered
];

const FALLBACKS = ["openrouter/meta-llama/llama-3.3-70b", "kilo/minimax/minimax-m3.1-flash:free"];

const CONFIG = {
  path: "/root/.suparclaw/config.json",
  config: {
    agents: {
      identity: { name: "SuparClaw", emoji: "🦀", theme: "a warm, sharp companion" },
      defaults: {
        model: "google/gemini-3.1-flash-lite",
        fallbacks: [...FALLBACKS],
        maxToolIterations: 12,
        contextBudgetChars: 60000,
        queueMode: "followup",
        maxConcurrent: 0,
        reasoningEffort: "inherit",
        reasoningView: "on",
        usage: "tokens",
        subagents: { maxConcurrent: 8, model: "", maxDepth: 1, thinking: "", delegationMode: "inherit" },
      },
    },
  },
};

const outDir = mkdtempSync(join(TEST_TMP, "sc-ui-defaults-"));

// gateway is the only import that talks to the outside world — stub it with a
// fixture-backed recorder so the test can assert the config.set leaves.
const rpcStub = join(outDir, "rpc-stub.mjs");
writeFileSync(rpcStub, `
export const gateway = {
  state: "online",
  async request(method, params) {
    (globalThis.__GW_CALLS ||= []).push({ method, params });
    if (method === "config.get") return ${JSON.stringify(CONFIG)};
    if (method === "models.list") return {
      models: ${JSON.stringify(MODELS.map((m) => m.id))},
      configured: ${JSON.stringify(MODELS)},
      details: {}, auth: [],
    };
    if (method === "config.set") return {};
    return { tools: [], skills: [], plugins: [] };
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
  plugins: [{
    name: "stub-rpc",
    setup(build0) {
      build0.onResolve({ filter: /(^|\/)rpc\.js$/ }, () => ({ path: rpcStub }));
    },
  }],
});

const page = parseHTML(`<!doctype html><html><body>
  <nav id="settings-nav"></nav>
  <input id="settings-search" />
  <aside id="settings-sidebar"></aside>
  <button id="settings-menu"></button>
  <div id="settings-scrim" hidden></div>
  <span id="settings-title"></span>
  <p id="settings-description"></p>
  <main id="settings-body"></main>
</body></html>`);
globalThis.document = page.document;
globalThis.window = page.window;
globalThis.HTMLElement = page.HTMLElement;
globalThis.Event = page.window.Event;
globalThis.location = { hash: "#/settings/defaults" };

const { Settings } = await import(pathToFileURL(join(outDir, "settings.mjs")).href);
const { friendlyModelName } = await import(pathToFileURL(join(outDir, "model-name.mjs")).href);

const root = document.getElementById("settings-body");
const settings = new Settings(root, () => {});
settings.setHash("#/settings/defaults");
await settings.render();

const $ = (sel) => root.querySelector(sel);
const $$ = (sel) => [...root.querySelectorAll(sel)];
const byId = (id) => document.getElementById(id);
const opens = () => $$(".dd__menu").filter((m) => !m.hasAttribute("hidden"));
/** linkedom has no MouseEvent/KeyboardEvent — a plain Event still fires
 *  onclick / document listeners, and props like `key` ride along. */
const fire = (node, type, props = {}) => {
  const ev = new page.window.Event(type, { bubbles: true });
  Object.assign(ev, props);
  node.dispatchEvent(ev);
  return ev;
};
const tap = (node) => fire(node, "click");
const press = (node, key) => fire(node, "keydown", { key });

test("Settings navigation has section context, decorative icons, and one active page", () => {
  const buttons = [...document.querySelectorAll("#settings-nav .settings__nav-item")];
  assert.equal(buttons.length, 14, "all existing destinations remain visible");
  assert.equal(byId("settings-title").textContent, "Defaults");
  assert.equal(byId("settings-description").textContent, "Set the model and agent behavior used for new conversations.");

  const active = buttons.filter((button) => button.getAttribute("aria-current") === "page");
  assert.equal(active.length, 1, "exactly one destination is announced as current");
  assert.equal(active[0].querySelector(".settings__nav-label").textContent, "Defaults");
  for (const button of buttons) {
    const svg = button.querySelector(".settings__nav-icon svg");
    assert.ok(svg, `${button.textContent.trim()} has an icon`);
    assert.equal(svg.getAttribute("aria-hidden"), "true", "navigation labels provide the accessible names");
  }
});

test("Settings search announces no matches and Escape restores the navigation", () => {
  const search = byId("settings-search");
  search.value = "no-such-settings-section-xyz";
  fire(search, "input");

  assert.equal(document.querySelectorAll("#settings-nav .settings__nav-item").length, 0);
  const empty = document.querySelector("#settings-nav .settings__empty");
  assert.ok(empty, "the empty state is visible");
  assert.equal(empty.getAttribute("role"), "status", "screen readers receive the result update");
  assert.equal(empty.textContent, "No sections match “no-such-settings-section-xyz”.");

  press(search, "Escape");
  assert.equal(search.value, "", "Escape clears the search field");
  assert.equal(document.querySelectorAll("#settings-nav .settings__nav-item").length, 14);
});

test("Defaults page renders: no visible native <select>, every value store hidden", () => {
  const selects = $$("select");
  assert.equal(selects.length, 8, `expected the eight value stores, saw ${selects.length}`);
  for (const sel of selects) {
    assert.ok(sel.hasAttribute("hidden"), `select#${sel.id} must be hidden (it is only the value store)`);
    assert.ok(sel.querySelector("option"), `select#${sel.id} must still carry its options`);
  }
  assert.ok($$(".dd__btn").length >= 8, "one custom trigger per dropdown");
});

test("field ids survive the redesign (contracts other tests and scripts rely on)", () => {
  for (const id of ["defaults-model", "ad-queue", "ad-reasoning", "ad-rview", "ad-usage",
    "ad-sub-think", "ad-sub-deleg", "ad-iterations", "ad-budget", "ad-concurrent",
    "identity-name", "identity-emoji", "identity-theme", "identity-save", "agent-defaults-save"]) {
    assert.ok(byId(id), `#${id} is missing`);
  }
  assert.equal(byId("defaults-model").tagName, "SELECT");
  assert.equal(byId("defaults-model-btn").tagName, "BUTTON");
});

test("the persona field is a textarea, name and emoji stay inputs", () => {
  assert.equal(byId("identity-theme").tagName, "TEXTAREA");
  assert.equal(byId("identity-theme").value, "a warm, sharp companion");
  assert.equal(byId("identity-name").tagName, "INPUT");
  assert.equal(byId("identity-emoji").tagName, "INPUT");
});

test("model menu carries search (11 choices > eight); short menus stay compact", () => {
  assert.ok($("#defaults-model-menu .dd__search"), "a long model menu must offer search");
  assert.equal($("#ad-queue-menu .dd__search"), null, "a two-choice menu must stay compact");
  tap(byId("ad-queue-btn"));
  assert.equal($$("#ad-queue-menu .dd__opt").length, 2, "steer + followup");
  assert.equal($$("#ad-queue-menu .dd__opt").map((o) => o.querySelector(".dd__opt-label").textContent).join(","), "steer,followup");
  press(document, "Escape");
});

test("opening a menu shows every enabled model, ranked by search", async () => {
  const trigger = byId("defaults-model-btn");
  tap(trigger);
  assert.equal(opens().length, 1, "exactly one menu open at a time");
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  assert.equal($$("#defaults-model-menu .dd__opt").length, 11, "disabled models are not offered");
  assert.ok($$("#defaults-model-menu .dd__group").length >= 4, "same-named models stay apart under provider headers");

  const search = $("#defaults-model-menu .dd__search");
  search.value = "grok";
  fire(  search, "input");
  assert.equal($$("#defaults-model-menu .dd__opt").length, 1, "search narrows to grok");
  assert.equal($$("#defaults-model-menu .dd__opt")[0].querySelector(".dd__opt-label").textContent, "Grok 4");

  search.value = "no-such-model";
  fire(  search, "input");
  assert.ok($("#defaults-model-menu .dd__empty"), "an empty result says so");

  // dismissing the menu leaves the selection alone (their rule)
  const store = byId("defaults-model");
  assert.equal(store.value, "google/gemini-3.1-flash-lite");
  press(document, "Escape");
  assert.equal(byId("defaults-model-menu").hasAttribute("hidden"), true, "Escape closes");
  assert.equal(store.value, "google/gemini-3.1-flash-lite", "Escape changed nothing");
});

test("choosing an option writes the hidden store and updates the visible label", () => {
  tap(byId("defaults-model-btn"));
  const rows = $$("#defaults-model-menu .dd__opt");
  const pick = rows.find((r) => r.getAttribute("title") === "mistral/mistral-large-latest");
  assert.ok(pick, "the raw ref stays on the row for hover");
  tap(pick);

  assert.equal(byId("defaults-model").value, "mistral/mistral-large-latest");
  assert.equal(byId("defaults-model-btn").querySelector(".dd__val").textContent, "Mistral Large Latest");
  assert.equal(byId("defaults-model-menu").hasAttribute("hidden"), true, "the menu closes on choice");
  assert.equal(byId("defaults-model").closest(".dd").querySelector(".dd__btn").getAttribute("aria-expanded"), "false");
});

test("fallbacks are chips in priority order, and the add menu skips what is already there", () => {
  assert.equal($$(".fb").length, FALLBACKS.length, "one chip per fallback");
  assert.equal($$(".fb")[0].querySelector(".fb__t").textContent, friendlyModelName(MODELS.find((m) => m.id === FALLBACKS[0]).label, MODELS.find((m) => m.id === FALLBACKS[0]).ref), "the chip shows the friendly name");
  assert.equal($$(".fb")[0].querySelector(".fb__n").textContent, "1", "priority numbers run in order");
  assert.equal($(".setsec__count").textContent, `${FALLBACKS.length} configured`);

  tap(byId("fallback-add-btn"));
  const offered = $$("#fallback-add-menu .dd__opt").map((o) => o.getAttribute("title"));
  assert.equal(offered.length, 11 - FALLBACKS.length, "models already in the chain are not offered");
  assert.ok(!offered.includes(FALLBACKS[0]), "the first fallback must not be offered again");

  tap($$("#fallback-add-menu .dd__opt")[0]);
  assert.equal($$(".fb").length, FALLBACKS.length + 1, "picking one appends a chip");
  assert.equal($$(".fb")[2].querySelector(".fb__n").textContent, "3", "the new chip is last");
  assert.equal(byId("fallback-add").value, "", "the add control resets for the next pick");

  // reorder + remove from the chip itself
  tap($$(".fb")[2].querySelector('[aria-label^="Move earlier"]'));
  assert.equal($$(".fb")[1].querySelector(".fb__n").textContent, "2");
  tap($$(".fb")[1].querySelector('[aria-label^="Remove"]'));
  assert.equal($$(".fb").length, FALLBACKS.length, "remove takes the chip out");
});

test("Save defaults writes every documented leaf with the shown values", async () => {
  globalThis.__GW_CALLS = [];
  tap(byId("ad-reasoning-btn"));
  const high = $$("#ad-reasoning-menu .dd__opt").find((o) => o.textContent.trim() === "high");
  tap(high);
  assert.equal(byId("ad-reasoning").value, "high", "the store carries the picked value");

  tap(byId("agent-defaults-save"));
  await new Promise((r) => setTimeout(r, 0));

  const written = new Map(globalThis.__GW_CALLS.filter((c) => c.method === "config.set").map((c) => [c.params.path, c.params.value]));
  const expected = {
    "agents.defaults.maxToolIterations": 12,
    "agents.defaults.contextBudgetChars": 60000,
    "agents.defaults.queueMode": "followup",
    "agents.defaults.maxConcurrent": 0,
    "agents.defaults.reasoningEffort": "high",
    "agents.defaults.reasoningView": "on",
    "agents.defaults.usage": "tokens",
    "agents.defaults.subagents.maxConcurrent": 8,
    "agents.defaults.subagents.model": "",
    "agents.defaults.subagents.maxDepth": 1,
    "agents.defaults.subagents.thinking": "", // "inherit caller" is its label, its stored value is blank
    "agents.defaults.subagents.delegationMode": "inherit",
  };
  for (const [path, value] of Object.entries(expected)) {
    assert.ok(written.has(path), `never wrote ${path}`);
    assert.deepEqual(written.get(path), value, `wrong value for ${path}`);
  }
});

test("Save identity writes name, emoji and the textarea's prose", async () => {
  globalThis.__GW_CALLS = [];
  byId("identity-theme").value = "terse and technical";
  tap(byId("identity-save"));
  await new Promise((r) => setTimeout(r, 0));

  const written = new Map(globalThis.__GW_CALLS.filter((c) => c.method === "config.set").map((c) => [c.params.path, c.params.value]));
  assert.equal(written.get("agents.identity.name"), "SuparClaw");
  assert.equal(written.get("agents.identity.emoji"), "🦀");
  assert.equal(written.get("agents.identity.theme"), "terse and technical");
});

test("only one menu is open at a time — opening another closes the first", () => {
  tap(byId("ad-usage-btn"));
  assert.equal(opens().length, 1);
  tap(byId("ad-rview-btn"));
  assert.equal(opens().length, 1, "the usage menu closed when the view menu opened");
  assert.equal(byId("ad-rview-menu").hasAttribute("hidden"), false);
});
