// Settings → Gateway: how the daemon listens, who may connect, and which surfaces
// it serves.
//
// What was wrong: four cards, one of them untitled (port, bind, token, auth mode
// with nothing saying what they belonged to); two native <select>s; a <div>
// dressed as an input to show a masked token; `modal__field` (the dialog idiom)
// used inside cards; three checkboxes with no accessible name; a port field that
// silently saved the old value for "abc"/"0"/"70000"; a save button that said
// "restart gateway" and only called location.reload(); three "their …" asides;
// and comma-separated host/origin lists that accepted entries the gateway would
// silently never match.

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
const gatewayRegion = settingsSrc.slice(
  settingsSrc.indexOf("#renderGateway(gw: any"),
  settingsSrc.indexOf("/* ---------------- automations"),
);

const CONFIG = {
  gateway: {
    port: 18790,
    bind: "loopback",
    auth: { mode: "token", token: "__redacted__:••••wxyz", loopbackBypass: true },
    allowedHosts: ["gw.example.com"],
    allowedOrigins: [],
    controlUi: { enabled: true, basePath: "" },
    http: { endpoints: { chatCompletions: { enabled: false } } },
  },
  agents: { defaults: {} },
};

const outDir = mkdtempSync(join(TMP, "sc-ui-gateway-"));
writeFileSync(join(outDir, "rpc-stub.mjs"), `
export const gateway = {
  state: "online",
  async request(method, params) {
    (globalThis.__GW_CALLS ||= []).push({ method, params });
    if (method === "config.get") {
      return { config: JSON.parse(JSON.stringify(globalThis.__CFG ?? ${JSON.stringify(CONFIG)})), path: globalThis.__CFG_PATH ?? "/home/u/.suparclaw/openclaw.json5" };
    }
    if (method === "config.set") {
      if (globalThis.__GW_FAIL_SET) throw new Error(globalThis.__GW_FAIL_SET);
      return { ok: true };
    }
    if (method === "service.status") {
      return { ok: true, running: true, pid: 42, uptimeMs: 120000, version: "0.1.0", restartSupported: true, manager: "single", mode: "single" };
    }
    if (method === "models.list") return { models: [], configured: [], details: {}, auth: [] };
    if (method === "tools.list") return { tools: [] };
    if (method === "skills.list") return { skills: [] };
    if (method === "models.plugins") return { plugins: [] };
    return { ok: true };
  },
};
`);

const { build } = await import("esbuild");
await build({
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
const loc = { hash: "#/settings/gateway", reload() { globalThis.__RELOADED = (globalThis.__RELOADED ?? 0) + 1; } };
globalThis.location = loc;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const focused = [];
page.HTMLElement.prototype.focus = function () { focused.push(this); };

const { Settings } = await import(pathToFileURL(join(outDir, "settings.mjs")).href);
const root = document.getElementById("settings-body");
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { await tick(); await tick(); await tick(); };
const byId = (id) => document.getElementById(id);
const $ = (sel) => root.querySelector(sel);
const $$ = (sel) => [...root.querySelectorAll(sel)];
const text = (n) => (n?.textContent ?? "").replace(/\s+/g, " ").trim();
const fire = (node, type) => node.dispatchEvent(new page.window.Event(type, { bubbles: true }));
const click = async (id) => { fire(byId(id), "click"); await settle(); };
const type = async (id, value) => { const n = byId(id); n.value = value; fire(n, "input"); await settle(); };
const toggle = async (id, on) => { const n = byId(id); n.checked = on; fire(n, "change"); await settle(); };
const tag = () => text($(".settings__tag"));
const statusNote = () => text($(".setcard__status-note"));
const footNote = () => text($(".setfoot .setfoot__note"));
const footErr = () => $(".setfoot .hint--err");
const shownText = () => [...document.querySelectorAll("#toasts .toast")].map(text).join(" | ");
const opts = (id) => [...byId(id).querySelectorAll("option")];
const selValue = (id) => (opts(id).find((o) => o.selected) ?? opts(id)[0])?.value ?? "";
const pick = async (id, label) => {
  fire(byId(`${id}-btn`), "click");
  await settle();
  const menu = $(`#${id}-menu:not([hidden])`);
  const opt = [...(menu?.querySelectorAll(".dd__opt") ?? [])]
    .find((o) => text(o).replace("✓", "").trim().startsWith(label));
  assert.ok(opt, `the ${id} menu offers "${label}"`);
  fire(opt, "click");
  await settle();
};
const menuLabels = (id) => {
  fire(byId(`${id}-btn`), "click");
  const menu = $(`#${id}-menu:not([hidden])`);
  const labels = [...(menu?.querySelectorAll(".dd__opt") ?? [])].map((o) => text(o).replace("✓", "").trim());
  fire(byId(`${id}-btn`), "click");
  return labels;
};
const calls = (method) => (globalThis.__GW_CALLS ?? []).filter((c) => c.method === method);
const setValue = (path) => calls("config.set").filter((c) => c.params.path === path).at(-1)?.params.value;
const setPaths = () => calls("config.set").map((c) => c.params.path);

const open = async ({ cfg, failSet, path } = {}) => {
  globalThis.__GW_CALLS = [];
  globalThis.__CFG = JSON.parse(JSON.stringify(cfg ?? CONFIG));
  globalThis.__CFG_PATH = path ?? "/home/u/.suparclaw/openclaw.json5";
  globalThis.__GW_FAIL_SET = failSet ?? "";
  globalThis.__RELOADED = 0;
  focused.length = 0;
  document.querySelectorAll("#toasts .toast").forEach((t) => t.remove());
  root.innerHTML = "";
  loc.hash = "#/settings/gateway";
  const settings = new Settings(root, () => {});
  settings.setHash("#/settings/gateway");
  await settings.render();
  await settle();
  return settings;
};

test("the page is one card on the shared shell", async () => {
  await open();
  assert.equal($$(".settings__stack > .card").length, 1, "one card, five sections");
  assert.equal(text($(".setcard__head h3")), "Gateway");
  assert.match(text($(".setcard__head .hint")), /how the daemon listens/i);
  assert.ok($(".setcard__status"), "a status line");
  const heads = $$(".setsec").map((s) => text(s.querySelector(".cap")));
  assert.deepEqual(heads, ["Listener", "Authentication", "Network trust", "Control UI", "HTTP API"]);
  const counts = $$(".setsec").map((s) => text(s.querySelector(".setsec__count")));
  assert.deepEqual(counts, ["2 settings", "3 settings", "2 settings", "2 settings", "1 setting"]);
  assert.equal(text($(".setfoot button:last-child")), "Save gateway");
  assert.equal($$("select:not(.dd__store)").length, 0, "no native dropdown anywhere");
  assert.equal($$(".card .modal__field").length, 0, "cards use setfield, not the dialog idiom");
  assert.equal($$(".settings__stack > .settings__actions").length, 0, "the commit lives in the footer");
});

test("every control is named", async () => {
  await open();
  const controls = $$(".card input, .card select").filter((n) => !n.classList.contains("dd__store"));
  assert.ok(controls.length >= 8);
  for (const c of controls) {
    const labelled = c.id && $(`label[for="${c.id}"]`);
    assert.ok(labelled || c.getAttribute("aria-label"), `#${c.id || "(none)"} has a name`);
  }
});

test("the status strip describes exposure, and follows the draft", async () => {
  await open();
  assert.equal(tag(), "local only");
  assert.equal(statusNote(), "127.0.0.1:18790 — this machine only; every client sends the token.");
  assert.ok(!$(".settings__tag").className.includes("is-warn"), "a loopback token listener is not a warning");

  // Choosing lan is the moment the exposure changes, so the strip must say so
  // before anything is saved.
  await pick("gw-bind", "lan");
  assert.equal(tag(), "network");
  assert.equal(statusNote(), "0.0.0.0:18790 — reachable from your network; clients still send the token.");
  assert.ok($(".settings__tag").className.includes("is-warn"));
  assert.equal(calls("config.set").length, 0, "still a draft");

  await pick("gw-mode", "none");
  assert.match(statusNote(), /reachable from your network, and auth is off\./);

  await pick("gw-bind", "loopback");
  assert.equal(tag(), "local only");
  assert.match(statusNote(), /this machine only, but auth is off\./);
  assert.ok($(".settings__tag").className.includes("is-warn"), "auth off is a warning even on loopback");
});

test("the address under Port follows the number being typed", async () => {
  await open();
  await type("gw-port", "9000");
  assert.equal(text($("#gw-port").closest(".setline").querySelector(".setcard__echo")), "ws://localhost:9000");
  assert.match(statusNote(), /127\.0\.0\.1:9000/);
  // Half-typed junk must not turn the line into `127.0.0.1:ab`.
  await type("gw-port", "ab");
  assert.equal(text($("#gw-port").closest(".setline").querySelector(".setcard__echo")), "ws://localhost:18790");
});

test("a save writes every leaf, and only a moved listener waits for a restart", async () => {
  await open();
  await type("gw-port", "19000");
  assert.match(footNote(), /Unsaved changes/);
  assert.equal(calls("config.set").length, 0, "nothing is written before the commit");

  await click("gateway-save");
  assert.deepEqual(setPaths().sort(), [
    "gateway.allowedHosts",
    "gateway.allowedOrigins",
    "gateway.auth.loopbackBypass",
    "gateway.auth.mode",
    "gateway.bind",
    "gateway.controlUi.basePath",
    "gateway.controlUi.enabled",
    "gateway.http.endpoints.chatCompletions.enabled",
    "gateway.port",
  ]);
  assert.equal(setValue("gateway.port"), 19000);
  assert.equal(setValue("gateway.bind"), "loopback");
  assert.match(footNote(), /still serves the old address until it restarts/);
  assert.match(shownText(), /the listener changes when the daemon restarts/);
  assert.equal(globalThis.__RELOADED, 0, "the page is never reloaded behind the user's back");

  // A change that does not move the socket is live at once.
  globalThis.__GW_CALLS = [];
  await open();
  await toggle("gw-openai", true);
  await click("gateway-save");
  assert.equal(setValue("gateway.http.endpoints.chatCompletions.enabled"), true);
  assert.equal(footNote(), "Every change is written to the config file at once; port and bind wait for a restart.");
  assert.match(shownText(), /gateway saved/);
});

test("a refused save says so in the footer and leaves the draft alone", async () => {
  await open({ failSet: "config is read-only" });
  await click("gateway-save");
  assert.equal(footErr().hasAttribute("hidden"), false);
  assert.match(text(footErr()), /not saved — config is read-only/);
  assert.equal(globalThis.__RELOADED, 0, "a failure must not reload the page and hide itself");
});

test("the port is refused, not silently replaced", async () => {
  for (const bad of ["abc", "0", "70000", "80.5", ""]) {
    await open();
    await type("gw-port", bad);
    await click("gateway-save");
    assert.equal(calls("config.set").length, 0, `"${bad}" is not written`);
    assert.equal(byId("gw-port").getAttribute("aria-invalid"), "true");
    assert.ok(focused.includes(byId("gw-port")), "the field takes focus");
    assert.match(text($("#gw-port").closest(".setfield").querySelector(".hint--err")), /whole number from 1 to 65535/);
    assert.match(text(footErr()), /Not saved — the port is not a number from 1 to 65535\./);
  }
});

test("the base path has to start at the root, and one trailing slash is normalised", async () => {
  await open();
  await type("gw-basepath", "ui");
  await click("gateway-save");
  assert.equal(calls("config.set").length, 0);
  assert.equal(byId("gw-basepath").getAttribute("aria-invalid"), "true");
  assert.match(text(footErr()), /the base path has to start with a slash/);

  await type("gw-basepath", "/ui/");
  await click("gateway-save");
  assert.equal(setValue("gateway.controlUi.basePath"), "/ui", "the slash the server strips is not written");
});

test("hosts and origins refuse what the gateway would silently ignore", async () => {
  await open();
  await type("gw-hosts", "gw.example.com, a://b");
  await click("gateway-save");
  assert.equal(calls("config.set").length, 0);
  assert.match(text(footErr()), /"a:\/\/b" is not a host name/);
  assert.equal(byId("gw-hosts").getAttribute("aria-invalid"), "true");

  await open();
  await type("gw-origins", "ui.example.com");
  await click("gateway-save");
  assert.equal(calls("config.set").length, 0);
  assert.match(text(footErr()), /"ui\.example\.com" is not an origin; put https:\/\/ in front\./);

  await open();
  await type("gw-hosts", "gw.example.com, api.example.com");
  await type("gw-origins", "https://ui.example.com");
  await click("gateway-save");
  assert.deepEqual(setValue("gateway.allowedHosts"), ["gw.example.com", "api.example.com"]);
  assert.deepEqual(setValue("gateway.allowedOrigins"), ["https://ui.example.com"]);
  assert.equal(text($("#gw-hosts").closest(".setfield").querySelector(".setcard__echo")), "2 extra hosts");
});

test("the token stays write-only and its echo says which one is stored", async () => {
  await open();
  assert.equal(text($("#gw-token-new").closest(".setfield").querySelector(".setcard__echo")), "stored — ends in wxyz");
  assert.equal(byId("gw-token-new").value, "", "the stored token is never put in the field");

  await click("gateway-save");
  assert.ok(!setPaths().includes("gateway.auth.token"), "blank keeps the stored token");

  globalThis.__GW_CALLS = [];
  await type("gw-token-new", "new-token-abcd");
  await click("gateway-save");
  assert.equal(setValue("gateway.auth.token"), "new-token-abcd");
  assert.equal(byId("gw-token-new").value, "", "the field is cleared once it is stored");
  assert.equal(text($("#gw-token-new").closest(".setfield").querySelector(".setcard__echo")), "stored — ends in abcd");
});

test("controls that cannot act are disabled, and come back", async () => {
  await open();
  assert.equal(byId("gw-bypass").disabled, false);
  assert.equal(byId("gw-basepath").disabled, false);

  await pick("gw-mode", "none");
  assert.equal(byId("gw-bypass").disabled, true, "there is no token to skip");
  assert.equal(byId("gw-token-new").disabled, false, "the HTTP endpoint still needs a token");
  assert.equal($("#gw-mode").closest(".setfield").nextElementSibling.hasAttribute("hidden"), false, "and the consequence is written out");

  await pick("gw-mode", "token");
  assert.equal(byId("gw-bypass").disabled, false);

  await toggle("gw-cui", false);
  assert.equal(byId("gw-basepath").disabled, true, "nowhere to mount it");
  assert.ok($("#gw-basepath").closest(".setfield").className.includes("is-off"));
  await toggle("gw-cui", true);
  assert.equal(byId("gw-basepath").disabled, false);
});

test("the HTTP endpoint knows it needs a token", async () => {
  await open();
  await toggle("gw-openai", true);
  assert.equal($(".gw-card .hint.is-warn:last-of-type") !== null, true);
  const warn = $$(".gw-card .hint.is-warn").find((n) => /503 until a token is set/.test(text(n)));
  assert.ok(warn, "the warning exists");
  assert.ok(warn.hasAttribute("hidden"), "hidden while a token is stored");

  await open({ cfg: { ...CONFIG, gateway: { ...CONFIG.gateway, auth: { ...CONFIG.gateway.auth, token: "" } } } });
  assert.equal($$(".gw-card .hint.is-warn").some((n) => /503 until a token/.test(text(n)) && !n.hasAttribute("hidden")), false, "only once the endpoint is on");
  await toggle("gw-openai", true);
  const shown = $$(".gw-card .hint.is-warn").find((n) => /503 until a token/.test(text(n)));
  assert.ok(!shown.hasAttribute("hidden"), "switching it on with no token warns immediately");
});

test("the config path is a fact row, not a line of stray text", async () => {
  await open();
  const row = [...$$(".gw-card > .row")].find((r) => text(r).startsWith("Config file"));
  assert.ok(row, "the file is a labelled row");
  assert.match(text(row), /\/home\/u\/\.suparclaw\/openclaw\.json5/);
  assert.match(text(row), /Every change here is written to this file\./);

  await open({ path: "" });
  assert.ok(![...$$(".gw-card > .row")].some((r) => text(r).startsWith("Config file")), "no empty row when the path is unknown");
});

test("the restart lives on Runtime, and the page points there", async () => {
  await open();
  await click("gw-open-runtime");
  assert.equal(loc.hash, "#/settings/runtime");
});

test("no internal references, no native dialogs, no inline styles", () => {
  assert.ok(gatewayRegion.length > 4000, "the region was found");
  assert.ok(!/their\s/i.test(gatewayRegion), "no \"their …\" copy");
  assert.ok(!/location\.reload/.test(gatewayRegion), "a save never reloads the page");
  assert.ok(!/window\.confirm/.test(gatewayRegion), "no native confirm");
  assert.ok(!/style:\s*["']/.test(gatewayRegion), "no inline styles");
  assert.ok(!/modal__field/.test(gatewayRegion), "cards do not borrow the dialog's field class");
  for (const id of ["gw-port", "gw-bind", "gw-mode", "gw-token-new", "gw-bypass", "gw-hosts", "gw-origins", "gw-cui", "gw-basepath", "gw-openai", "gateway-save"]) {
    assert.ok(gatewayRegion.includes(`id: "${id}"`), `#${id} survives the redesign`);
  }
});
