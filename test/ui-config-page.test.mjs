// Settings → “All settings”: the schema-driven editor, audited end to end.
//
// The tab is kept because it is the only editor for `session.*`, `auth.order`,
// the record-shaped leaves (`providers`, `models`, `imap.accounts`,
// `hooks.mappings`) and every rare key the dedicated tabs leave out — plus the
// only way to author `${ENV}` refs and multi-line arrays.
//
// What was wrong: 149 rows borrowed the dialog's `.modal__field`; 20 enums were
// native <select>s; labels were the last dotted segment (17 rows called only
// "enabled"); one changed checkbox sent 8 paths because record rows compared a
// parsed object to a JSON string; the filter *skipped* hidden rows on save; a
// rejected save wiped the whole draft; "abc" in a number field went out as null;
// an unlisted enum value rendered as a blank control; Form and Raw kept separate
// drafts and could overwrite each other; and leaving the tab dropped the draft.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
const settingsSrc = readFileSync(join(ROOT, "ui/src/settings.ts"), "utf8");
const configRegion = settingsSrc.slice(
  settingsSrc.indexOf("async #renderConfigEditor("),
  settingsSrc.indexOf("/** Channels tab (P4 #31"),
);

const outDir = mkdtempSync(join(TMP, "sc-ui-config-page-"));
await (await import("esbuild")).build({
  entryPoints: [join(ROOT, "src/config/schema.ts")],
  bundle: true, format: "esm", outfile: join(outDir, "schema.mjs"), platform: "node",
});

writeFileSync(join(outDir, "rpc-stub.mjs"), `
import { CONFIG_SCHEMA, emptyConfig } from "./schema.mjs";
const base = () => {
  const cfg = emptyConfig();
  cfg.gateway.port = 18790;
  cfg.gateway.auth.token = "__redacted__:••••wxyz";
  cfg.providers = { openai: { apiKey: "__redacted__:••••9f2a", baseUrl: "" } };
  cfg.agents.defaults.model = "openai/gpt-5.1";
  cfg.tools.exec.mode = "allowlist";
  cfg.cron.enabled = true;
  return cfg;
};
export const gateway = {
  state: "online",
  async request(method, params) {
    (globalThis.__CF_CALLS ||= []).push({ method, params });
    if (method === "config.schema") {
      if (globalThis.__CF_SCHEMA_ERR) throw new Error(globalThis.__CF_SCHEMA_ERR);
      return { schema: CONFIG_SCHEMA };
    }
    if (method === "config.get") {
      return { config: JSON.parse(JSON.stringify(globalThis.__CF_CFG ?? base())), path: "/home/u/.suparclaw/openclaw.json5" };
    }
    if (method === "config.set") {
      if (globalThis.__CF_SET_ERR && globalThis.__CF_SET_ERR_WHEN?.(params)) throw new Error(globalThis.__CF_SET_ERR);
      return { ok: true };
    }
    if (method === "config.replace") {
      if (globalThis.__CF_REPLACE_ERR) throw new Error(globalThis.__CF_REPLACE_ERR);
      return { ok: true };
    }
    if (method === "models.list") return { models: [], configured: [], details: {}, auth: [] };
    if (method === "tools.list") return { tools: [] };
    if (method === "skills.list") return { skills: [] };
    if (method === "models.plugins") return { plugins: [] };
    return { ok: true };
  },
};
`);

await (await import("esbuild")).build({
  entryPoints: [join(ROOT, "ui/src/settings.ts")],
  bundle: true, format: "esm", outdir: outDir, outExtension: { ".js": ".mjs" }, platform: "neutral",
  plugins: [{ name: "stub", setup(b) { b.onResolve({ filter: /(^|\/)rpc\.js$/ }, () => ({ path: join(outDir, "rpc-stub.mjs") })); } }],
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
const loc = { hash: "#/settings/config", reload() { globalThis.__RELOADED = (globalThis.__RELOADED ?? 0) + 1; } };
globalThis.location = loc;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const { Settings } = await import(pathToFileURL(join(outDir, "settings.mjs")).href);
const root = document.getElementById("settings-body");
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { await tick(); await tick(); await tick(); };
const byId = (id) => root.querySelector(`[id="${id}"]`) ?? document.getElementById(id);
const $ = (sel) => root.querySelector(sel);
const $$ = (sel) => [...root.querySelectorAll(sel)];
const text = (n) => (n?.textContent ?? "").replace(/\s+/g, " ").trim();
const fire = (node, type) => node.dispatchEvent(new page.window.Event(type, { bubbles: true }));
const typeInto = async (id, value) => {
  const node = byId(id);
  node.value = value;
  fire(node, "input");
  await settle();
};
const row = (path) => root.querySelector(`[data-cfg-path="${path}"]`);
const rowError = (path) => text(row(path).querySelector(".hint--err"));
const calls = (method) => (globalThis.__CF_CALLS ?? []).filter((c) => c.method === method);
const sets = () => calls("config.set").map((c) => [c.params.path, c.params.value]);
const shownText = () => [...document.querySelectorAll("#toasts .toast")].map(text).join(" | ");
const save = async () => { fire(byId("cfg-save"), "click"); await settle(); await settle(); };
const footer = () => text($("#cfg-state"));
const bindLabel = () => text(root.querySelector('[data-cfg-path="gateway.bind"] .dd__val'));

const open = async ({ schemaErr, replaceErr, setErr, setWhen, cfg } = {}) => {
  globalThis.__CF_CALLS = [];
  globalThis.__CF_CFG = cfg ?? null;
  globalThis.__CF_SCHEMA_ERR = schemaErr ?? "";
  globalThis.__CF_REPLACE_ERR = replaceErr ?? "";
  globalThis.__CF_SET_ERR = setErr ?? "";
  globalThis.__CF_SET_ERR_WHEN = setWhen ?? null;
  document.querySelectorAll("#toasts .toast").forEach((t) => t.remove());
  root.innerHTML = "";
  loc.hash = "#/settings/config";
  const settings = new Settings(root, () => {});
  settings.setHash("#/settings/config");
  await settings.render();
  await settle();
  return settings;
};

test("every schema leaf is one card row in the shared field language", async () => {
  await open();
  const cards = $$(".cfg-section");
  // 14 since Task 30 added the `media` section (attachment retention).
  assert.equal(cards.length, 14, "one card per top-level schema section");
  assert.deepEqual(cards.map((c) => text(c.querySelector(".setcard__head h3"))), [
    "Gateway", "Agents", "Messages", "Memory", "Session", "Media", "Providers", "Auth", "Models", "Channels", "Tools", "Cron", "IMAP", "Hooks",
  ]);
  for (const card of cards) assert.match(text(card.querySelector(".setcard__head .hint")), /^\d+ settings?$/);
  assert.equal($("#cfg-form").classList.contains("settings__stack"), true, "the cards sit on the shared stack");

  const rows = $$("[data-cfg-path]");
  // 152 since Task 30 added media.retentionDays (151 + Task 29's naming model).
  assert.equal(rows.length, 152, "152 editable leaves");
  assert.equal($$(".modal__field").length, 0, "cards do not borrow the dialog's field class");
  assert.equal($$("select:not(.dd__store)").length, 0, "no native dropdown anywhere");
  for (const r of rows) {
    assert.ok(r.classList.contains("setfield") || r.classList.contains("row"), `${r.dataset.cfgPath} is a field or a row`);
    assert.ok(r.querySelector(`[id="cfg-${r.dataset.cfgPath}"]`), `${r.dataset.cfgPath} has its cfg- id`);
  }
  assert.equal(text($("#cfg-state")), "Everything is saved.");
  assert.equal(byId("cfg-save").disabled, true, "nothing to save on a clean page");
});

test("the three view-only keys are listed, not silently dropped", async () => {
  await open();
  const note = $(".cfg-viewonly");
  assert.equal(text(note.querySelector(".setcard__head h3")), "Not edited here");
  assert.match(text(note.querySelector(".hint")), /3 keys are stored in the file but marked view-only/);
  const listed = note.querySelector("pre").textContent.split("\n");
  assert.deepEqual(listed, ["agents.identity.avatar", "agents.defaults.contextBudgetChars", "agents.defaults.queueMode"]);
  for (const p of listed) assert.equal($(`[data-cfg-path="${p}"]`), null, `${p} has no control`);
});

test("rows show the value the daemon is using, secrets included", async () => {
  await open();
  assert.equal(byId("cfg-gateway.port").value, "18790");
  assert.equal(bindLabel(), "Loopback", "the custom dropdown prints the stored choice");
  assert.equal(row("gateway.bind").querySelector("select").value, "loopback");
  assert.equal(byId("cfg-gateway.auth.token").value, "", "a stored secret never crosses the wire");
  assert.match(byId("cfg-gateway.auth.token").getAttribute("placeholder"), /••••wxyz — stored; leave blank to keep/);
  assert.equal(row("gateway.auth.token").getAttribute("data-cfg-redacted"), "1");
  assert.equal(byId("cfg-agents.defaults.model").value, "openai/gpt-5.1");
});

test("an enum value the schema does not list stays visible instead of blank", async () => {
  const cfg = (await import(pathToFileURL(join(outDir, "schema.mjs")).href)).emptyConfig();
  cfg.gateway.bind = "weird-bind";
  await open({ cfg });
  const store = row("gateway.bind").querySelector("select");
  assert.equal(store.value, "weird-bind");
  assert.match(text(row("gateway.bind")), /weird-bind \(not selected\)/);
});

test("saving one changed row sends one path — untouched records are not rewritten", async () => {
  await open();
  const box = byId("cfg-cron.enabled");
  box.checked = false;
  fire(box, "change");
  await settle();
  assert.equal(footer(), "1 change not saved.");
  await save();
  assert.deepEqual(sets(), [["cron.enabled", false]], "exactly the row that changed");
  assert.match(shownText(), /1 setting saved/);
});

test("the filter is a view: an edit it hides is still saved", async () => {
  await open();
  await typeInto("cfg-gateway.port", "19999");
  await typeInto("cfg-filter", "memory");
  assert.equal(row("gateway.port").hidden, true, "the row is filtered away");
  await save();
  assert.deepEqual(sets(), [["gateway.port", 19999]]);
});

test("filtering hides empty groups and cards, and says when nothing matches", async () => {
  await open();
  await typeInto("cfg-filter", "memory");
  assert.deepEqual($$(".cfg-section").filter((c) => !c.hidden).map((c) => c.dataset.cfgSection), ["memory", "tools"], "MATCH: memory.dreaming.* and tools.memory");
  const visibleGroups = $$(".cfg-group").filter((g) => !g.hidden);
  for (const g of visibleGroups) assert.ok(g.querySelector("[data-cfg-path]:not([hidden])"), "a visible group has a visible row");
  assert.match(text($("#cfg-toolbar-count") ?? $(".cfg-toolbar .setsec__count")), /of 152 shown/);

  await typeInto("cfg-filter", "zzz-no-such-key");
  assert.equal($$(".cfg-section").filter((c) => !c.hidden).length, 0);
  assert.equal($("#cfg-empty").hidden, false);
  assert.equal(text($("#cfg-empty")), "Nothing matches “zzz-no-such-key”.");
});

test("a number that is not a number never leaves the page", async () => {
  await open();
  await typeInto("cfg-gateway.port", "abc");
  await save();
  assert.deepEqual(sets(), [], "nothing was sent");
  assert.equal(rowError("gateway.port"), "Enter a number.");
  assert.equal(byId("cfg-gateway.port").getAttribute("aria-invalid"), "true");
  assert.match(footer(), /fix the highlighted row first/i);

  await typeInto("cfg-gateway.port", "70000");
  await save();
  assert.deepEqual(sets(), []);
  assert.equal(rowError("gateway.port"), "Enter a number between 1 and 65535.");

  await typeInto("cfg-gateway.port", "19999");
  await save();
  assert.deepEqual(sets(), [["gateway.port", 19999]]);
});

test("a record that is not JSON is a row error, not a toast at the end", async () => {
  await open();
  await typeInto("cfg-providers", "{ not json");
  await save();
  assert.deepEqual(sets(), []);
  assert.match(rowError("providers"), /^Not valid JSON — /);
});

test("a rejected save keeps the rest of the draft and can be retried", async () => {
  await open({ setErr: "validation: port out of range", setWhen: (p) => p.path === "gateway.port" && p.value === 19999 });
  await typeInto("cfg-gateway.port", "19999");
  await typeInto("cfg-gateway.controlUi.basePath", "/ui");
  await save();
  assert.deepEqual(sets(), [["gateway.port", 19999]], "it stops at the first refusal");
  assert.equal(byId("cfg-gateway.port").value, "19999", "the draft is still here");
  assert.equal(byId("cfg-gateway.controlUi.basePath").value, "/ui");
  assert.equal(rowError("gateway.port"), "validation: port out of range");
  assert.match(footer(), /0 saved, 2 not saved: gateway\.port — validation: port out of range/);

  await typeInto("cfg-gateway.port", "18791");
  await save();
  const sent = sets();
  assert.deepEqual(sent.at(-2), ["gateway.port", 18791]);
  assert.deepEqual(sent.at(-1), ["gateway.controlUi.basePath", "/ui"]);
});

test("the footer counts the draft, Discard puts it back, and the draft blocks the button when clean", async () => {
  await open();
  assert.equal(byId("cfg-save").disabled, true);
  assert.equal(byId("cfg-discard").disabled, true);
  await typeInto("cfg-gateway.port", "19999");
  const before = byId("cfg-channels.telegram.mediaMaxMb").value;
  await typeInto("cfg-channels.telegram.mediaMaxMb", "55");
  assert.equal(footer(), "2 changes not saved.");
  assert.equal(byId("cfg-save").disabled, false);

  fire(byId("cfg-discard"), "click");
  await settle();
  assert.equal(byId("cfg-gateway.port").value, "18790");
  assert.equal(byId("cfg-channels.telegram.mediaMaxMb").value, before);
  assert.equal(footer(), "Everything is saved.");
  assert.equal(byId("cfg-save").disabled, true);
  assert.deepEqual(sets(), [], "discarding is not a request");
});

test("a section change cannot silently drop the draft", async () => {
  const settings = await open();
  await typeInto("cfg-gateway.port", "19999");
  settings.setHash("#/settings/tools");
  await settings.render();
  await settle();
  assert.ok($("#cfg-form"), "still on All settings");
  assert.equal(loc.hash, "#/settings/config", "the address bar follows the page back");
  assert.match(shownText(), /1 unsaved change — save or discard them first\./);

  fire(byId("cfg-discard"), "click");
  await settle();
  settings.setHash("#/settings/tools");
  await settings.render();
  await settle();
  assert.equal($("#cfg-form"), null, "a clean page switches");
});

test("Raw shows the form's draft, and applying sends that document", async () => {
  await open();
  await typeInto("cfg-gateway.port", "19999");
  fire(byId("cfg-mode-raw"), "click");
  await settle();
  assert.equal($("#cfg-raw").hidden, false);
  assert.equal($("#cfg-form").hidden, true);
  assert.equal($(".cfg-toolbar .inp").hidden, true, "the filter describes the form");
  assert.equal($(".settings__stack > .hint").hidden, true, "so does the page hint");
  const doc = byId("cfg-raw-text").value;
  assert.match(doc, /"port": 19999/, "the unsaved edit is in the document");
  assert.match(doc, /__redacted__:/, "secrets stay sentinels");

  fire(byId("cfg-raw-apply"), "click");
  await settle();
  const rep = calls("config.replace");
  assert.equal(rep.length, 1);
  assert.equal(rep[0].params.text, doc);
  assert.match(shownText(), /config applied/);
});

test("raw edits cannot be lost by switching back, and Reload clears them", async () => {
  await open();
  fire(byId("cfg-mode-raw"), "click");
  await settle();
  await typeInto("cfg-raw-text", "{ gateway: { port: 19000 } }");
  fire(byId("cfg-mode-form"), "click");
  await settle();
  assert.equal($("#cfg-form").hidden, true, "the switch is refused while the text is dirty");
  assert.match(shownText(), /apply or reload it first/);

  fire(byId("cfg-raw-reload"), "click");
  await settle();
  fire(byId("cfg-mode-form"), "click");
  await settle();
  assert.equal($("#cfg-form").hidden, false, "a reloaded document lets the switch through");
});

test("a rejected raw document keeps the page and the text", async () => {
  await open({ replaceErr: "bad_config: gateway.port must be 1..65535" });
  fire(byId("cfg-mode-raw"), "click");
  await settle();
  await typeInto("cfg-raw-text", "{ gateway: { port: 90000 } }");
  fire(byId("cfg-raw-apply"), "click");
  await settle();
  assert.equal($("#cfg-raw").hidden, false, "still in Raw");
  assert.equal(byId("cfg-raw-text").value, "{ gateway: { port: 90000 } }");
  assert.equal(text($(".cfg-banner")), "Settings not applied: bad_config: gateway.port must be 1..65535");
  assert.equal($(".cfg-banner").hidden, false);
});

test("a schema that cannot be read leaves Raw as the way in", async () => {
  await open({ schemaErr: "gateway not ready" });
  assert.equal($$("[data-cfg-path]").length, 0);
  assert.equal(text($(".card .setcard__head h3")), "Schema unavailable");
  assert.match(text($(".card .hint")), /could not be read — gateway not ready\. Raw still edits the file\./);
  assert.equal(byId("cfg-mode-form").disabled, true);
  assert.equal($(".cfg-savebar").hidden, true, "no commit bar with nothing to commit");
  assert.equal($(".settings__stack > .hint").hidden, true, "the form's hint goes with the form");
  fire(byId("cfg-mode-raw"), "click");
  await settle();
  assert.equal($("#cfg-raw").hidden, false);
  assert.match(byId("cfg-raw-text").value, /"gateway"/);
});

test("source guards: no native dialogs, no reloads, no stray copy", () => {
  assert.ok(configRegion.length > 8000, "the region was found");
  assert.ok(!configRegion.includes("window.confirm"), "no native confirm");
  assert.ok(!configRegion.includes("location.reload"), "a save never reloads the page");
  assert.ok(!/\btheir\b/.test(configRegion), "no \"their …\" copy");
  assert.ok(!configRegion.includes("↻"), "no refresh glyph");
  assert.ok(!/style:\s*["']/.test(configRegion), "no inline styles");
  assert.ok(!configRegion.includes("modal__field"), "cards do not borrow the dialog's field class");
  assert.ok(!configRegion.includes("#setMany"), "the page reports per-path failures itself");
});

test("the old page's contracts still hold", () => {
  assert.ok(settingsSrc.includes('{ id: "config", label: "All settings", group: "Advanced" }'));
  assert.ok(settingsSrc.includes('gateway.request("config.schema"'));
  assert.ok(settingsSrc.includes('gateway.request("config.replace", { text: rawArea.value })'));
  assert.ok(configRegion.includes("data-cfg-path"));
  assert.ok(configRegion.includes("data-cfg-kind"));
  assert.ok(configRegion.includes("data-cfg-redacted"));
  assert.ok(configRegion.includes("id: `cfg-${path}`"));
  assert.ok(settingsSrc.includes("JSON.stringify(cur"));
  assert.ok(configRegion.includes("cfg-filter"));
  const css = readFileSync(join(ROOT, "ui/styles.css"), "utf8");
  assert.match(css, /\.cfg-banner/);
  assert.match(css, /\.cfg-group/);
});
