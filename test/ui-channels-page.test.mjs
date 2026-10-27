// Settings → Channels: the form against the gateway it talks to.
//
// The page had a save path that posted one `config.set` per control, so a single
// bad number — `Number("") || 0` for `typing.intervalSeconds` — was rejected
// halfway and every control behind it was silently never written, while the form
// still displayed the typed values. This drives the real page in linkedom and
// asserts what actually crosses the socket: one write, validated first.

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

const TELEGRAM = {
  enabled: true,
  token: "__redacted__:••••1234",
  proxy: "",
  dmPolicy: "pairing",
  allowFrom: ["42"],
  groupPolicy: "allowlist",
  groupAllowFrom: [],
  mentionGated: true,
  allowBots: false,
  mediaMaxMb: 20,
  vision: true,
  streaming: "progress",
  batchMs: 300,
  typing: { mode: "instant", intervalSeconds: 6 },
  botLoopProtection: { enabled: true, maxEventsPerWindow: 20, windowSeconds: 60, cooldownSeconds: 60 },
};

const BASE = {
  config: {
    path: "/root/.suparclaw/config.json",
    config: {
      gateway: {},
      agents: { defaults: { model: "mock/m1" } },
      providers: { mock: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "", models: ["m1"] } },
      channels: { telegram: TELEGRAM, defaults: { botLoopProtection: { enabled: true, maxEventsPerWindow: 20, windowSeconds: 60, cooldownSeconds: 60 } } },
    },
  },
  models: { models: ["mock/m1"], configured: [], details: {}, auth: [] },
  plugins: { plugins: [] },
  scan: { services: [] },
  status: { telegram: { enabled: true, hasToken: true, running: true, username: "mybot", error: "" } },
  connect: { ok: true, username: "mybot" },
};

const outDir = mkdtempSync(join(TMP, "sc-ui-channels-"));
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
    if (method === "channels.status") return d.status;
    if (method === "channels.telegram.connect") return d.connect;
    if (method === "config.set" && globalThis.__GW_FAIL_SET) throw new Error(globalThis.__GW_FAIL_SET);
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
globalThis.location = { hash: "#/settings/channels", reload() {} };

const { Settings } = await import(pathToFileURL(join(outDir, "settings.mjs")).href);

const root = document.getElementById("settings-body");
const settings = new Settings(root, () => {});
settings.setHash("#/settings/channels");

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { await tick(); await tick(); await tick(); };
const $ = (sel) => root.querySelector(sel);
const $$ = (sel) => [...root.querySelectorAll(sel)];
const fire = (node, type) => node.dispatchEvent(new page.window.Event(type, { bubbles: true }));
const calls = (method) => (globalThis.__GW_CALLS ?? []).filter((c) => c.method === method);
const sets = () => calls("config.set");
const toasts = () => [...document.querySelectorAll("#toasts .toast")].map((t) => t.textContent ?? "");
const control = (key) => root.querySelector(`[data-ch-key="${key}"]`);
const inputOf = (key) => control(key)?.querySelector("input, textarea, select");
const saveBtn = () => $$("button").find((b) => /Save channel settings/.test(b.textContent));
const statusText = () => document.getElementById("tg-status")?.textContent?.trim() ?? "";
const problem = () => $(".hint--err");

const render = async (data) => {
  globalThis.__GW_DATA = data ?? null;
  globalThis.__GW_CALLS = [];
  globalThis.__GW_FAIL_SET = "";
  document.querySelectorAll("#toasts .toast").forEach((t) => t.remove());
  await settings.render();
  await settle();
};
const save = async () => { fire(saveBtn(), "click"); await settle(); };

test.beforeEach(async () => { await render(); });

test("every control the backend reads is on the page, with live status and Connect", () => {
  const keys = $$("[data-ch-key]").map((n) => n.dataset.chKey);
  assert.deepEqual(keys, [
    "channels.telegram.enabled",
    "channels.telegram.proxy",
    "channels.telegram.dmPolicy",
    "channels.telegram.allowFrom",
    "channels.telegram.groupPolicy",
    "channels.telegram.groupAllowFrom",
    "channels.telegram.mentionGated",
    "channels.telegram.allowBots",
    "channels.telegram.batchMs",
    "channels.telegram.typing.mode",
    "channels.telegram.typing.intervalSeconds",
    "channels.telegram.mediaMaxMb",
    "channels.telegram.vision",
    "channels.telegram.botLoopProtection.enabled",
    "channels.telegram.botLoopProtection.maxEventsPerWindow",
    "channels.telegram.botLoopProtection.windowSeconds",
    "channels.telegram.botLoopProtection.cooldownSeconds",
  ]);
  assert.equal(statusText(), "✔Connected as @mybot");
  assert.ok(document.getElementById("tg-connect"), "the connect action is there");
  assert.equal(inputOf("channels.telegram.typing.intervalSeconds").value, "6", "values come from the config");
  // Task 53: there is no "what to show while a turn runs" control, because there
  // is no status message any more — the chat posts answers only.
  assert.equal(document.querySelector('[data-ch-key="channels.telegram.streaming"]'), null);
  assert.equal(document.querySelector('[data-ch-key="channels.telegram.toolProgress"]'), null);
});

test("Save writes the whole block in one frame, not one frame per control", async () => {
  await save();
  const frames = sets();
  assert.equal(frames.length, 1, "one write for sixteen controls");
  assert.equal(frames[0].params.path, "channels.telegram");
  const block = frames[0].params.value;
  assert.equal(block.enabled, true);
  assert.equal(block.batchMs, 300);
  assert.equal(block.typing.mode, "instant");
  assert.equal(block.typing.intervalSeconds, 6);
  assert.deepEqual(block.botLoopProtection, { enabled: true, maxEventsPerWindow: 20, windowSeconds: 60, cooldownSeconds: 60 });
  assert.equal(block.token, "__redacted__:••••1234", "an untouched token rides along as the sentinel and is resolved server-side");
  assert.ok(
    toasts().some((t) => /channel settings saved — telegram reconnects now/.test(t)),
    `the save is reported: ${toasts().join(" | ")}`,
  );
  assert.equal(calls("channels.telegram.connect").length, 1, "a saved, enabled channel is reconnected right away");
});

test("the token: typed is sent, blank keeps the stored one", async () => {
  document.getElementById("ch-token").value = "123456:ABCdefGHIjklMNOpqr";
  await save();
  assert.equal(sets().at(-1).params.value.token, "123456:ABCdefGHIjklMNOpqr");
  assert.equal(document.getElementById("ch-token").value, "", "the field is cleared after saving");
  assert.match($(".hint")?.textContent ?? "", /./);

  globalThis.__GW_CALLS = [];
  document.getElementById("ch-token").value = "";
  await save();
  assert.equal(sets().at(-1).params.value.token, "__redacted__:••••1234", "blank never wipes the credential");
});

test("a blank or out-of-range number sends nothing and marks the field", async () => {
  const interval = inputOf("channels.telegram.typing.intervalSeconds");
  interval.value = "";
  await save();
  assert.equal(sets().length, 0, "nothing was written");
  assert.equal(interval.getAttribute("aria-invalid"), "true");
  assert.match(problem().textContent, /typing refresh \(seconds\) is outside the allowed range/);
  assert.equal(problem().hasAttribute("hidden"), false);

  interval.value = "31"; // max 30
  await save();
  assert.equal(sets().length, 0, "an out-of-range value is refused too");
  assert.equal(interval.getAttribute("aria-invalid"), "true");

  interval.value = "12";
  await save();
  assert.equal(sets().length, 1);
  assert.equal(sets()[0].params.value.typing.intervalSeconds, 12);
  assert.equal(interval.hasAttribute("aria-invalid"), false, "the mark clears once it is valid");
  assert.equal(problem().hasAttribute("hidden"), true);
});

test("zero is legal exactly where the schema allows it", async () => {
  inputOf("channels.telegram.batchMs").value = "0";
  await save();
  assert.equal(sets().at(-1).params.value.batchMs, 0, "0 disables batching, it is not 'blank'");

  globalThis.__GW_CALLS = [];
  inputOf("channels.telegram.mediaMaxMb").value = "0"; // min 1
  await save();
  assert.equal(sets().length, 0);
});

test("checkboxes, selects and allowlists land as the right types", async () => {
  const mention = control("channels.telegram.mentionGated").querySelector("input");
  mention.checked = false;
  const groupSel = control("channels.telegram.groupPolicy").querySelector("select");
  for (const opt of groupSel.querySelectorAll("option")) {
    if (opt.value === "open") opt.setAttribute("selected", "");
    else opt.removeAttribute("selected");
  }
  control("channels.telegram.allowFrom").querySelector("textarea").value = " 1 \n\n2\n3";
  inputOf("channels.telegram.typing.intervalSeconds").value = "9";
  await save();
  const block = sets().at(-1).params.value;
  assert.equal(block.mentionGated, false);
  assert.equal(block.groupPolicy, "open");
  assert.deepEqual(block.allowFrom, ["1", "2", "3"], "lines are trimmed and blanks dropped");
  assert.equal(block.typing.intervalSeconds, 9);
});

test("a rejected save claims nothing", async () => {
  globalThis.__GW_FAIL_SET = "bad_config: channels.telegram.token: invalid";
  await save();
  assert.equal(sets().length, 1, "the request was made");
  assert.match(toasts().at(-1) ?? "", /^not saved — bad_config/);
  assert.ok(!toasts().some((t) => /^channel settings saved/.test(t)), "no success is claimed");
  assert.equal(problem().hasAttribute("hidden"), false, "and it still says so after the toast is gone");
  assert.match(problem().textContent, /^not saved — bad_config/);
  assert.equal(saveBtn().disabled, false, "the button is usable again");
  assert.equal(saveBtn().textContent, "Save channel settings");
});

test("turning the channel off says so, and does not reconnect", async () => {
  const enable = control("channels.telegram.enabled").querySelector("input");
  enable.checked = false;
  await save();
  assert.equal(sets().at(-1).params.value.enabled, false);
  assert.match(toasts().at(-1) ?? "", /telegram is off/);
  assert.equal(calls("channels.telegram.connect").length, 0);
});

test("Connect now reports the outcome honestly", async () => {
  fire(document.getElementById("tg-connect"), "click");
  await settle();
  assert.equal(calls("channels.telegram.connect").length, 1);
  assert.match(toasts().at(-1) ?? "", /telegram connected as @mybot/);

  await render({ ...BASE, connect: { ok: true } });
  fire(document.getElementById("tg-connect"), "click");
  await settle();
  assert.equal(toasts().at(-1), "telegram connected", "no phantom @? handle");

  await render({ ...BASE, connect: { ok: false, error: "Unauthorized" } });
  fire(document.getElementById("tg-connect"), "click");
  await settle();
  assert.match(toasts().at(-1) ?? "", /telegram connect failed: Unauthorized/);
});

test("a second click while the first is in flight is dropped, not doubled", async () => {
  const btn = saveBtn();
  fire(btn, "click");
  fire(btn, "click");
  await settle();
  assert.equal(sets().length, 1, "double-clicking Save cannot post twice");
});

test("the page's own config copy is not edited when a save is refused", async () => {
  const enable = control("channels.telegram.enabled").querySelector("input");
  enable.checked = false;
  inputOf("channels.telegram.mediaMaxMb").value = "999";
  await save();
  assert.equal(sets().length, 0);
  // Re-render from the gateway's config: unchecking must not have leaked in.
  await render();
  assert.equal(control("channels.telegram.enabled").querySelector("input").checked, true);
  assert.equal(inputOf("channels.telegram.mediaMaxMb").value, "20");
});

test("the status row is a dot plus what actually happened", async () => {
  await render({ ...BASE, status: { telegram: { enabled: false, hasToken: false, running: false, username: "", error: "" } } });
  assert.match(statusText(), /disabled — tick Enable and save below/);

  await render({ ...BASE, status: { telegram: { enabled: true, hasToken: true, running: false, username: "", error: "Unauthorized" } } });
  assert.match(statusText(), /Offline — Unauthorized/, "the real reason, not just 'offline'");

  await render({ ...BASE, status: { telegram: { enabled: true, hasToken: true, running: false, username: "", error: "" } } });
  assert.match(statusText(), /Offline \(not connected\)/);
});
