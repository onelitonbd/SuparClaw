// Settings → Tools: the five cards as one page.
//
// Each card has its own suite (exec, code mode, media, web search). This one asserts
// what only the assembled page can be wrong about: the order and headings, one save
// label pattern, no duplicate ids, one count grammar per section head, no count that
// restates the card's own status line, and an inventory that is shaped like the
// cards above it and says what it is.

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

const CONFIG = {
  agents: { defaults: { model: "openai/gpt-5.6" } },
  gateway: {},
  tools: {
    exec: { enabled: true, timeoutMs: 600000 },
    codeMode: { enabled: "auto", executor: "node", timeoutMs: 10000, maxCodeChars: 32768,
      maxOutputBytes: 65536, maxPendingToolCalls: 16, directOnly: [] },
    media: { concurrency: 2, models: [],
      image: { enabled: true, maxChars: 500, maxBytes: 10485760, timeoutSeconds: 60, attachments_all: false },
      audio: { enabled: true, maxBytes: 20971520, timeoutSeconds: 60, echoTranscript: false, echoFormat: "" },
      pdf: { enabled: true, maxBytes: 10485760, maxChars: 4000, timeoutSeconds: 60 } },
    web: { search: { enabled: true, provider: "", maxResults: 5, cacheTtlMinutes: 15,
      brave: { apiKey: "", baseUrl: "" }, perplexity: { apiKey: "", baseUrl: "" },
      tavily: { apiKey: "", baseUrl: "" }, kimi: { apiKey: "", baseUrl: "" },
      searxng: { baseUrl: "" }, duckduckgo: { baseUrl: "" } } },
  },
};

const NAMES = ["fs_read", "fs_write", "exec", "pdf", "web_search", "memory_append"];
const TOOLS = NAMES.map((name) => ({ name, description: `${name} does a thing` }));

const outDir = mkdtempSync(join(TMP, "sc-ui-tools-page-"));
const stub = join(outDir, "rpc-stub.mjs");
writeFileSync(stub, `
export const gateway = {
  state: "online",
  async request(method) {
    if (method === "config.get") return { config: ${JSON.stringify(CONFIG)}, path: "/home/u/.suparclaw/openclaw.json5" };
    if (method === "models.list") return { models: [], configured: [], details: {}, auth: [] };
    if (method === "tools.list") return { tools: ${JSON.stringify(TOOLS)} };
    if (method === "skills.list") return { skills: [] };
    if (method === "models.plugins") return { plugins: [] };
    if (method === "codeMode.get") return { enabled: "auto", engaged: true, model: "openai/gpt-5.6",
      preferredMatch: true, preferred: ["gpt-5.6"], preferredMatched: ["gpt-5.6"],
      executor: "node", executorBundled: true, catalog: ["fs_read", "fs_write", "pdf", "web_search", "memory_append"] };
    if (method === "media.get") return { defaults: {
      image: { maxBytes: 10485760, maxChars: 500, timeoutSeconds: 60 },
      audio: { maxBytes: 20971520, maxChars: null, timeoutSeconds: 60 },
      pdf: { maxBytes: 10485760, maxChars: 4000, timeoutSeconds: 60 } }, models: [] };
    if (method === "web.search.get") return { enabled: true, provider: "auto", maxResults: 5, cacheTtlMinutes: 15,
      effective: "brave", autoCandidates: ["brave"],
      providers: [{ id: "brave", ready: true, keyFree: false, hasKey: true, configBaseUrl: "" },
        { id: "searxng", ready: false, keyFree: true, hasKey: true, configBaseUrl: "" }],
      keyMasks: { brave: "", perplexity: "", tavily: "", kimi: "" } };
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
  <div id="modal-overlay" hidden><div id="modal"></div></div>
</body></html>`);
globalThis.document = page.document;
globalThis.window = page.window;
globalThis.HTMLElement = page.HTMLElement;
globalThis.Event = page.window.Event;
globalThis.location = { hash: "#/settings/tools", reload() {} };

const { Settings } = await import(pathToFileURL(join(outDir, "settings.mjs")).href);
const root = document.getElementById("settings-body");
const settings = new Settings(root, () => {});
settings.setHash("#/settings/tools");
await settings.render();
await new Promise((r) => setTimeout(r, 20));

const text = (n) => (n?.textContent ?? "").replace(/\s+/g, " ").trim();
const $ = (sel) => root.querySelector(sel);
const $$ = (sel) => [...root.querySelectorAll(sel)];
const cards = $$(".card");
const saveButtons = $$("button").filter((b) => /^Save /.test(text(b)));
const cardOf = (node) => node.closest(".card");

test("five cards, in reading order, one heading each", () => {
  assert.equal(cards.length, 5);
  assert.deepEqual($$(".card > .setcard__head h3, .card > h3").map(text), [
    "Exec", "Code mode", "Media understanding", "Web search", "Built-in tools",
  ]);
});

test("every save button reads Save <subject> and sits in its card's footer", () => {
  assert.deepEqual(saveButtons.map(text), [
    "Save exec settings", "Save code mode", "Save media", "Save web search",
  ]);
  for (const btn of saveButtons) {
    assert.ok(btn.closest(".setfoot"), `${text(btn)} is in a .setfoot`);
    assert.ok(cardOf(btn), `${text(btn)} belongs to a card`);
  }
});

test("no duplicate ids anywhere on the page", () => {
  const ids = $$("[id]").map((n) => n.getAttribute("id"));
  const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  assert.deepEqual(dupes, [], `duplicate ids: ${dupes.join(", ")}`);
});

test("every section head carries a count", () => {
  const heads = $$(".setsec__head");
  assert.ok(heads.length >= 10, "the page has section heads");
  for (const head of heads) {
    const count = head.querySelector(".setsec__count");
    assert.ok(count, `head "${text(head.querySelector(".cap"))}" has a count`);
    assert.notEqual(text(count), "", `head "${text(head.querySelector(".cap"))}" count is not empty`);
  }
});

test("no section count restates its own card's status line", () => {
  for (const card of cards) {
    const tagEl = card.querySelector(".setcard__status .settings__tag");
    if (!tagEl) continue;
    const tagText = text(tagEl);
    for (const count of card.querySelectorAll(".setsec__count")) {
      assert.notEqual(text(count), tagText, `"${tagText}" is not repeated as a section count in "${text(card.querySelector("h3"))}"`);
    }
  }
});

test("the inventory is shaped like the other cards and says what it is", () => {
  const inv = $(".tools-inventory");
  assert.ok(inv, "the inventory card is present");
  assert.ok(inv.querySelector(".setcard__head h3"), "it has the shared head");
  assert.equal(text(inv.querySelector(".setcard__head h3")), "Built-in tools");
  assert.match(text(inv.querySelector(".setcard__status .settings__tag")), /^6 registered$/);
  assert.ok(![...inv.querySelectorAll("button")].some((b) => /^Save /.test(text(b))), "read-only: no save button");
  assert.match(text(inv.querySelector(".setfoot__note")), /Read-only inventory/);
  assert.ok(!/approval|allowlist|mode deny/i.test(text(inv)), "inventory has no retired policy warnings");
});

test("the inventory explains why a tool it does not list is missing, and its link to code mode", () => {
  const inv = $(".tools-inventory");
  assert.match(text(inv), /Only registered tools are listed/);
  assert.match(text(inv), /fs and memory switches on the Config tab/);
  assert.match(text(inv), /same catalog, minus exec and wait/);
});

test("the page description covers what the two new cards do", () => {
  const desc = text(document.getElementById("settings-desc"));
  assert.match(desc, /run, read and fetch/);
});
