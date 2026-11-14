// Settings → Runtime: the daemon behind this page.
//
// What was wrong: four bare tiles duplicated as rows (Tools/Skills/Models/
// Providers printed twice), a `Status: Running` printed green even when the
// status call threw, a hardcoded `Version 0.1.0`, a `Cron 0 jobs` row reading
// `config.cron.jobs` (a key the schema does not have, so it could never be
// anything but 0), a disabled `Restart gateway` with no reason, an untitled
// daemon card, `.modal__foot` borrowed inside it, an inline `style`, and a log
// reader that printed `svc.logPath` while the lines may have come from the app
// log instead. Every fact below is read from the daemon's payload, and every
// control is exercised: the restart, the refresh and the pointer to Gateway.

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
const runtimeRegion = settingsSrc.slice(
  settingsSrc.indexOf("#renderRuntime(config: any, counts"),
  settingsSrc.indexOf("/* ---------------- memory"),
);

// A supervised daemon: the state the strip is most confident about.
const SVC = {
  ok: true,
  manager: "systemd-user",
  installed: true,
  servicePath: "/home/u/.config/systemd/user/suparclaw.service",
  bootEnabled: true,
  running: true,
  pid: 4242,
  supervisorPid: 4241,
  supervised: true,
  mode: "supervised",
  port: 18790,
  startedAt: 1_700_000_000_000,
  logPath: "/home/u/.suparclaw/logs/service.log",
  restartSupported: true,
  supervisorEnv: { SUPARCLAW_SUPERVISED: "1" },
  version: "9.9.9",
  uptimeMs: 11_000_000,
  sessions: 7,
  busy: ["main:main"],
};

const LOGS = { path: "/home/u/.suparclaw/logs/service.log", lines: ["boot: listening", "turn: done"] };

const outDir = mkdtempSync(join(TMP, "sc-ui-runtime-"));
writeFileSync(join(outDir, "rpc-stub.mjs"), `
export const gateway = {
  state: "online",
  async request(method, params) {
    (globalThis.__RT_CALLS ||= []).push({ method, params });
    if (method === "config.get") return { config: JSON.parse(JSON.stringify(globalThis.__RT_CFG ?? {})), path: "/home/u/.suparclaw/openclaw.json5" };
    if (method === "config.set") return { ok: true };
    if (method === "service.status") {
      if (globalThis.__RT_STATUS_ERR) throw new Error(globalThis.__RT_STATUS_ERR);
      return JSON.parse(JSON.stringify(globalThis.__RT_SVC));
    }
    if (method === "service.logs") {
      if (globalThis.__RT_LOGS_ERR) throw new Error(globalThis.__RT_LOGS_ERR);
      return JSON.parse(JSON.stringify(globalThis.__RT_LOGS));
    }
    if (method === "service.restart") return JSON.parse(JSON.stringify(globalThis.__RT_RESTART ?? { restarting: true, willComeBack: true }));
    if (method === "models.list") return { models: [], configured: [], details: {}, auth: [] };
    if (method === "tools.list") return { tools: [{}, {}, {}] };
    if (method === "skills.list") return { skills: [{}, {}] };
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
const loc = { hash: "#/settings/runtime", reload() { globalThis.__RELOADED = (globalThis.__RELOADED ?? 0) + 1; } };
globalThis.location = loc;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const { Settings } = await import(pathToFileURL(join(outDir, "settings.mjs")).href);
const root = document.getElementById("settings-body");
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { await tick(); await tick(); await tick(); };
const byId = (id) => document.getElementById(id);
const $ = (sel) => root.querySelector(sel);
const $$ = (sel) => [...root.querySelectorAll(sel)];
const text = (n) => (n?.textContent ?? "").replace(/\s+/g, " ").trim();
const pageText = () => text(root);
const fire = (node, type) => node.dispatchEvent(new page.window.Event(type, { bubbles: true }));
const click = async (id) => { fire(byId(id), "click"); await settle(); };
const tag = () => text($(".runtime-process .settings__tag"));
const stripNote = () => text($(".runtime-process .setcard__status-note"));
const logTag = () => text($(".runtime-log .settings__tag"));
const logNote = () => text($(".runtime-log .setcard__status-note"));
const logBody = () => text($(".runtime-log pre"));
const calls = (method) => (globalThis.__RT_CALLS ?? []).filter((c) => c.method === method);
const shownText = () => [...document.querySelectorAll("#toasts .toast")].map(text).join(" | ");
const sectionHeads = () => $$(".runtime-process .setsec .cap").map(text);
const rowValue = (card, label) => {
  const row = [...$$(`.${card} .row`)].find((r) => text(r.querySelector(".row__label")) === label);
  return text(row?.querySelector(".row__value"));
};

const open = async ({ svc, statusErr, logs, logsErr, restart, cfg } = {}) => {
  globalThis.__RT_CALLS = [];
  globalThis.__RT_SVC = JSON.parse(JSON.stringify(svc ?? SVC));
  globalThis.__RT_STATUS_ERR = statusErr ?? "";
  globalThis.__RT_LOGS = JSON.parse(JSON.stringify(logs ?? LOGS));
  globalThis.__RT_LOGS_ERR = logsErr ?? "";
  globalThis.__RT_RESTART = restart ?? { restarting: true, willComeBack: true };
  globalThis.__RT_CFG = cfg ?? { providers: { openai: {}, ollama: {} } };
  globalThis.__RELOADED = 0;
  document.querySelectorAll("#toasts .toast").forEach((t) => t.remove());
  byId("modal-overlay").hidden = true;
  root.innerHTML = "";
  loc.hash = "#/settings/runtime";
  const settings = new Settings(root, () => {});
  settings.setHash("#/settings/runtime");
  await settings.render();
  await settle();
  return settings;
};

test("the page is two cards on the shared shell, and no control is a leftover", async () => {
  await open();
  assert.equal($$(".settings__stack > .card").length, 2, "one card per subject");
  assert.equal(text($(".runtime-process .setcard__head h3")), "Gateway process");
  assert.equal(text($(".runtime-log .setcard__head h3")), "Service log");
  assert.deepEqual(sectionHeads(), ["Process", "Supervision", "Restart", "Loaded"]);
  assert.deepEqual($$(".runtime-process .setsec__count").map(text), ["5 facts", "3 facts", "1 action", "4 facts"]);
  assert.equal(text($(".setfoot button:last-child")), "Refresh");

  assert.equal($$(".tiles, .tile").length, 0, "the tile grid is gone");
  assert.equal($$("select:not(.dd__store)").length, 0, "no native dropdown");
  assert.equal($$("[style]").length, 0, "no inline styles");
  assert.equal($$(".card .modal__field").length, 0, "cards do not borrow the dialog's field");
});

test("every fact is read from the daemon, never typed into the page", async () => {
  await open();
  assert.equal(rowValue("runtime-process", "Version"), "9.9.9");
  assert.equal(rowValue("runtime-process", "Listening on"), "port 18790");
  assert.equal(rowValue("runtime-process", "Sessions"), "7");
  assert.equal(rowValue("runtime-process", "Process ids"), "child 4242 · supervisor 4241");
  assert.match(pageText(), /1 working right now\./);
  assert.ok(!pageText().includes("0.1.0"), "the old hardcoded version is gone");

  await open({ svc: { ...SVC, pid: 0, supervisorPid: 0, port: null, version: "" } });
  assert.equal(rowValue("runtime-process", "Process ids"), "not reported");
  assert.equal(rowValue("runtime-process", "Listening on"), "not reported");
  assert.equal(rowValue("runtime-process", "Version"), "unknown");
});

test("there is no Cron row, and the page never reads config.cron", async () => {
  await open();
  assert.ok(!/Cron/.test(pageText()), "no cron row on a page that cannot count jobs");
  assert.ok(!runtimeRegion.includes("cron"), "the runtime code touches no cron config");
  assert.equal(calls("config.get").length > 0, true, "the config is still read for the provider count");
  assert.equal(rowValue("runtime-process", "Providers"), "2");
});

test("a failed status read says unknown, claims nothing, and leaves the log standing", async () => {
  await open({ statusErr: "gateway not ready" });
  assert.equal(tag(), "unknown");
  assert.ok(!$(".runtime-process .settings__tag").className.includes("is-ok"), "no green tag on a failed read");
  assert.equal(stripNote(), "Could not read the daemon status — gateway not ready.");
  assert.deepEqual(sectionHeads(), ["Loaded"], "no Process, no Supervision, no Restart");
  assert.ok(!/\brunning\b/i.test(pageText()), "the page never prints the word running when it does not know");
  assert.ok(!/\bsupervised\b/i.test(pageText()), "and never prints supervised either");
  assert.equal($$(".runtime-log pre").length, 1, "the log is still rendered");
  assert.match(logBody(), /boot: listening/);
  assert.equal(text($(".setfoot button:last-child")), "Refresh", "the footer still offers a retry");
});

test("the restart is offered only when it would come back, and says why when not", async () => {
  // Started by nothing: a restart would leave the daemon down.
  await open({ svc: { ...SVC, installed: false, supervised: false, mode: "single", restartSupported: false } });
  assert.equal(byId("runtime-restart").disabled, true);
  assert.match(pageText(), /Nothing would start it again: no supervisor and no service\./);
  assert.match(pageText(), /Start it with sc gateway \(which supervises itself\) or install it as a service first\./);
  assert.equal(calls("service.restart").length, 0, "a disabled button cannot stop the daemon");

  // Answering, but the pid record is gone and nothing owns the process: the
  // server's own restartSupported reads false, and the page says so in words.
  await open({ svc: { ...SVC, running: false, pid: 0, supervisorPid: 0, supervised: false, installed: false, mode: "stopped", restartSupported: false } });
  assert.equal(tag(), "answering");
  assert.equal(byId("runtime-restart").disabled, true);
  assert.match(pageText(), /its pid record is gone and nothing is installed as a service, so a restart would not come back\. Restart it on the device\./);
  assert.equal(calls("service.restart").length, 0);

  // A service manager owns the daemon even when the pid record is gone, so that
  // restart really does come back — a supervisor that lost its record cannot.
  await open({ svc: { ...SVC, running: false, pid: 0, supervisorPid: 0, supervised: false, mode: "service", restartSupported: true } });
  assert.equal(tag(), "answering");
  assert.equal(byId("runtime-restart").disabled, false, "the service manager will start it again");
  assert.match(pageText(), /The pid record is gone, but the systemd \(user\) service starts the daemon again/);

  await open();
  assert.equal(byId("runtime-restart").disabled, false);
  assert.match(pageText(), /The supervisor starts the daemon again within a second or two\./);
});

test("confirming the dialog restarts once and reports the server's answer", async () => {
  await open();
  await click("runtime-restart");
  assert.equal(byId("modal-overlay").hidden, false, "the dialog opens");
  assert.equal(text(byId("modal-title")), "Restart the gateway?");
  assert.match(text(byId("modal-body")), /Open chats reconnect by themselves/);
  assert.equal(calls("service.restart").length, 0, "opening the dialog restarts nothing");

  fire(byId("modal-foot").querySelectorAll("button")[1], "click");
  await settle();
  assert.equal(calls("service.restart").length, 1, "one request, not two");
  assert.match(shownText(), /restarting — this page reconnects by itself/);
  assert.equal(byId("runtime-restart").disabled, true);
  assert.equal(text(byId("runtime-restart")), "Restarting…");

  // The server can still answer that it will not come back; the page repeats it
  // rather than promising a return it cannot guarantee.
  await open({ restart: { restarting: true, willComeBack: false } });
  await click("runtime-restart");
  fire(byId("modal-foot").querySelectorAll("button")[1], "click");
  await settle();
  assert.match(shownText(), /stopping — nothing will start it again/);
});

test("the log note is the path the lines came from, not the one the service prefers", async () => {
  await open({ logs: { path: "/home/u/.suparclaw/logs/suparclaw.log", lines: ["a", "b"] } });
  assert.equal(logNote(), "/home/u/.suparclaw/logs/suparclaw.log");
  assert.ok(logNote() !== SVC.logPath, "svc.logPath never stands in for the file that was read");
  assert.equal(logTag(), "2 lines");
  assert.equal(calls("service.logs").at(-1).params.lines, 30);

  await open({ logs: { path: "/x.log", lines: ["only one"] } });
  assert.equal(logTag(), "1 line");
  await open({ logs: { path: "/x.log", lines: [] } });
  assert.equal(logTag(), "empty");
  assert.equal(logBody(), "(the log is empty)");
});

test("a failed log read is named, and the facts above it still render", async () => {
  await open({ logsErr: "permission denied" });
  assert.equal(logTag(), "unavailable");
  assert.equal(logNote(), "The log file could not be read.");
  assert.equal(logBody(), "Could not read the log — permission denied");
  assert.equal(rowValue("runtime-process", "Version"), "9.9.9", "the status card is unaffected");
});

test("the session count is a live number, and says where it stops", async () => {
  await open({ svc: { ...SVC, sessions: 200, busy: [] } });
  const row = [...$$(".runtime-process .row")].find((r) => text(r.querySelector(".row__label")) === "Sessions");
  assert.match(text(row), /The count stops at 200\./);
  assert.match(text(row), /None are working right now\./);
  await open({ svc: { ...SVC, sessions: 3, busy: [] } });
  const row2 = [...$$(".runtime-process .row")].find((r) => text(r.querySelector(".row__label")) === "Sessions");
  assert.ok(!text(row2).includes("The count stops at 200."), "no cap note under the cap");
});

test("service-manager keys are printed as words, and unknown keys as themselves", async () => {
  await open({ svc: { ...SVC, manager: "termux-services", installed: true } });
  assert.equal(rowValue("runtime-process", "Service manager"), "Termux services (runit) — installed");
  await open({ svc: { ...SVC, manager: "launchd" } });
  assert.equal(rowValue("runtime-process", "Service manager"), "launchd (macOS) — installed");
  await open({ svc: { ...SVC, manager: "weird-thing", installed: false } });
  assert.equal(rowValue("runtime-process", "Service manager"), "weird-thing — not installed");
  await open({ svc: { ...SVC, manager: null, installed: false } });
  assert.equal(rowValue("runtime-process", "Service manager"), "none installed");
  assert.match(pageText(), /Install it on the device — this page cannot: sc service install/);
});

test("Refresh re-reads both, and the pointer opens Gateway", async () => {
  const settings = await open();
  const before = { status: calls("service.status").length, logs: calls("service.logs").length };
  await click("runtime-refresh");
  assert.equal(calls("service.status").length, before.status + 1);
  assert.equal(calls("service.logs").length, before.logs + 1);
  assert.equal($$(".settings__stack > .card").length, 2, "the page is rebuilt, not appended to");

  await click("runtime-open-gateway");
  assert.equal(loc.hash, "#/settings/gateway", "the pointer moves the tab");
  assert.equal(typeof settings.setHash, "function", "the hash is the app's tab state");
});

test("the page writes nothing, reloads nothing, and keeps its ids", () => {
  assert.ok(runtimeRegion.length > 5000, "the region was found");
  assert.ok(!runtimeRegion.includes("config.set"), "nothing on this page is saved");
  assert.ok(!runtimeRegion.includes("location.reload"), "a refresh is a re-read, not a page reload");
  assert.ok(!runtimeRegion.includes("window.confirm"), "no native confirm");
  assert.ok(!/\btheir\b/.test(runtimeRegion), "no \"their …\" copy");
  assert.ok(!runtimeRegion.includes("↻"), "no refresh glyph");
  assert.ok(!runtimeRegion.includes("config.cron"), "the schema-less cron key is gone");
  for (const id of ["runtime-restart", "runtime-refresh", "runtime-open-gateway"]) {
    assert.ok(runtimeRegion.includes(`id: "${id}"`), `#${id} is the page's own control`);
  }
  assert.ok(!runtimeRegion.includes("#serviceCard") && !runtimeRegion.includes("tile("), "the old card and tiles are gone");
});
