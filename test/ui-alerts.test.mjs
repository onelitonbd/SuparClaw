// Settings → Alerts: what this browser may announce, and when it stays quiet.
//
// What was wrong: one bare card with no head, no status line, no sections and no
// footer; four "(their …)" parentheticals; `granted`/`denied`/`default` printed as
// a coloured value; three checkboxes with no accessible name; hints orphaned
// outside their rows; a literal " – " between two unlabelled, unvalidated boxes
// (so "10pm" saved and then did nothing); nothing saying the prefs are per browser;
// no way to ask for permission; and a "Send test" that claimed success after the
// browser refused it.

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
const alertsRegion = settingsSrc.slice(
  settingsSrc.indexOf("/* ---------------- alerts"),
  settingsSrc.indexOf("/* ---------------- runtime"),
);

const outDir = mkdtempSync(join(TMP, "sc-ui-alerts-"));
writeFileSync(join(outDir, "rpc-stub.mjs"), `
export const gateway = {
  state: "online",
  async request(method) {
    if (method === "config.get") return { config: {}, path: "/home/u/.suparclaw/openclaw.json5" };
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
  entryPoints: [join(ROOT, "ui/src/settings.ts"), join(ROOT, "ui/src/notifications.ts")],
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
globalThis.location = { hash: "#/settings/alerts", reload() {} };

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => {
    if (globalThis.__REFUSE_WRITE) throw new Error("QuotaExceededError");
    store.set(k, String(v));
  },
  removeItem: (k) => store.delete(k),
};

// The browser facts the page reads: the permission, the prompt's answer, and
// whether the tab is hidden. All three are variables here, not stubs of the page.
const browser = {
  permission: "default",
  answer: null,      // what requestPermission resolves to; null = the current permission
  hidden: true,
};
const shown = [];
function FakeNotification(title, opts) {
  shown.push({ title, ...opts });
}
Object.defineProperty(FakeNotification, "permission", { get: () => browser.permission });
FakeNotification.requestPermission = async () => {
  const answer = browser.answer ?? browser.permission;
  browser.permission = answer;
  return answer;
};

const focused = [];
page.HTMLElement.prototype.focus = function () { focused.push(this); };
Object.defineProperty(page.document, "hidden", { get: () => browser.hidden, configurable: true });

const { Settings } = await import(pathToFileURL(join(outDir, "settings.mjs")).href);
const notif = await import(pathToFileURL(join(outDir, "notifications.mjs")).href);

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
const quietErr = () => $("#alerts-quiet-err");
const shownText = () => [...document.querySelectorAll("#toasts .toast")].map(text).join(" | ");
const stored = () => {
  const raw = localStorage.getItem("sc.alerts");
  return raw ? JSON.parse(raw) : null;
};
const cardText = () => text($(".card"));

const open = async ({ prefs = null, permission = "default", hidden = true, answer = null, notification = true } = {}) => {
  store.clear();
  shown.length = 0;
  focused.length = 0;
  globalThis.__REFUSE_WRITE = false;
  browser.permission = permission;
  browser.hidden = hidden;
  browser.answer = answer;
  if (prefs) store.set("sc.alerts", JSON.stringify(prefs));
  if (notification) {
    globalThis.Notification = FakeNotification;
    page.window.Notification = FakeNotification;
  } else {
    delete globalThis.Notification;
    delete page.window.Notification;
  }
  document.querySelectorAll("#toasts .toast").forEach((t) => t.remove());
  root.innerHTML = "";
  const settings = new Settings(root, () => {});
  settings.setHash("#/settings/alerts");
  await settings.render();
  await settle();
  return settings;
};

const ON = { enabled: true, reply: false, quietFrom: "", quietTo: "" };

test("the page is one card on the shared shell", async () => {
  await open({ prefs: ON, permission: "granted" });
  assert.equal($$(".settings__stack > .card").length, 1, "one card, not a pile of rows");
  assert.equal(text($(".setcard__head h3")), "Browser alerts", "a title band");
  assert.match(text($(".setcard__head .hint")), /only while the tab is in the background/, "the hidden-only rule is stated once");
  assert.ok($(".setcard__status"), "a live status line");
  assert.ok(text($(".setcard__status-note")).length > 10, "the status line carries a sentence");
  const heads = $$(".setsec").map((s) => text(s.querySelector(".cap")));
  assert.deepEqual(heads, ["What gets announced", "Quiet hours", "Send a test"], "three named sections");
  for (const sec of $$(".setsec")) assert.match(text(sec.querySelector(".setsec__count")), /\d/, "every section says how much it holds");
  const save = $(".setfoot button:last-child");
  assert.equal(save?.id, "alerts-save", "the card ends in its commit");
  assert.equal(text(save), "Save alerts", "and the commit is named");
  assert.equal($$("select").length, 0, "no native dropdown anywhere (this page needs none)");
});

test("the state words are English, not the permission API", async () => {
  const cases = [
    [{ prefs: null, permission: "default" }, "off", /Nothing is sent/],
    [{ prefs: { ...ON, enabled: false }, permission: "default" }, "off", /Nothing is sent/],
    [{ prefs: { ...ON, reply: true }, permission: "granted" }, "on", /Finished replies are announced/],

    [{ prefs: ON, permission: "granted" }, "on", /Nothing is selected below, so no alert will appear\./],
    [{ prefs: ON, permission: "default" }, "not asked", /until this browser is asked/],
    [{ prefs: ON, permission: "denied" }, "blocked", /blocks notifications for this site/],
  ];
  for (const [opts, wantTag, wantNote] of cases) {
    await open(opts);
    assert.equal(tag(), wantTag, `tag for ${JSON.stringify(opts.permission)} + ${JSON.stringify(opts.prefs)}`);
    assert.match(statusNote(), wantNote);
    const all = cardText();
    for (const api of ["granted", "denied", "default", "Notification.permission"]) {
      assert.ok(!all.includes(api), `the page never prints the API's own word "${api}"`);
    }
  }
});

test("the ask button exists only while the browser has not been asked", async () => {
  await open({ prefs: ON, permission: "granted" });
  // Identity, not deepEqual: a DOM node in an assertion message makes Node's
  // formatter build a giant regex and blow the stack (see ui-automations).
  assert.ok(byId("alerts-ask") === null, "nothing to ask for once granted");
  assert.match(cardText(), /allowed/, "the granted fact is stated");

  await open({ prefs: ON, permission: "denied" });
  assert.ok(byId("alerts-ask") === null, "a denied browser cannot be re-asked from the page");
  assert.match(cardText(), /Site settings → Notifications is the only way back\./);
  assert.equal(byId("alerts-test").disabled, true, "and the test button says so by being unavailable");

  await open({ prefs: ON, permission: "default", answer: "granted" });
  assert.ok(byId("alerts-ask"), "the one state with an action has one");
  await click("alerts-ask");
  assert.ok(byId("alerts-ask") === null, "after answering, the row becomes a fact");
  assert.match(cardText(), /allowed/);
  assert.equal(tag(), "on", "and the status line can now say on");
  assert.match(shownText(), /now allows alerts/);
});

test("a switch is a draft until the footer commits it", async () => {
  await open({ prefs: null, permission: "granted" });
  assert.equal(tag(), "off");
  assert.equal(byId("alerts-quiet-from").disabled, true);

  await toggle("alerts-enabled", true);
  assert.equal(byId("alerts-quiet-to").disabled, false);
  assert.match(footNote(), /Unsaved changes/);
  assert.equal(stored(), null, "nothing is written before the commit");

  await click("alerts-save");
  assert.deepEqual(stored(), { enabled: true, reply: false, quietFrom: "", quietTo: "" });
  assert.match(shownText(), /alerts saved/);
  assert.ok(!/Unsaved changes/.test(footNote()), "the band is clean after the commit");
  assert.match(footNote(), /Saved in this browser only/, "and it says where the values went");
  assert.equal(tag(), "on");
});

test("a refused write is reported in the footer, not swallowed", async () => {
  await open({ prefs: null, permission: "granted" });
  globalThis.__REFUSE_WRITE = true;
  await toggle("alerts-enabled", true);
  await click("alerts-save");
  assert.equal(footErr().hasAttribute("hidden"), false, "the footer carries the failure");
  assert.match(text(footErr()), /not saved — this browser refused the write/);
  assert.equal(stored(), null);
});

test("quiet hours are validated, never silently clamped", async () => {
  await open({ prefs: { ...ON, quietFrom: "22:00", quietTo: "08:00" }, permission: "granted" });

  await type("alerts-quiet-from", "10pm");
  await click("alerts-save");
  assert.equal(byId("alerts-quiet-from").getAttribute("aria-invalid"), "true");
  assert.ok(focused.includes(byId("alerts-quiet-from")), "the offending field takes focus");
  assert.equal(quietErr().hasAttribute("hidden"), false);
  assert.match(text(quietErr()), /not a 24-hour time/);
  assert.equal(stored().quietFrom, "22:00", "nothing was written");

  await type("alerts-quiet-from", "22:00");
  await type("alerts-quiet-to", "");
  await click("alerts-save");
  assert.match(text(quietErr()), /Set both times/);
  assert.equal(stored().quietTo, "08:00");

  await type("alerts-quiet-to", "22:00");
  await click("alerts-save");
  assert.match(text(quietErr()), /would silence every alert/);
  assert.equal(byId("alerts-quiet-from").getAttribute("aria-invalid"), "true");
  assert.equal(byId("alerts-quiet-to").getAttribute("aria-invalid"), "true");

  await type("alerts-quiet-from", "8:00");
  await type("alerts-quiet-to", "07:30");
  await click("alerts-save");
  assert.equal(stored().quietFrom, "08:00", "a single-digit hour is normalised, not refused");
  assert.equal(stored().quietTo, "07:30");
  assert.equal(byId("alerts-quiet-from").value, "08:00", "and the field shows what was saved");

  await type("alerts-quiet-from", "");
  await type("alerts-quiet-to", "");
  await click("alerts-save");
  assert.equal(stored().quietFrom, "", "both empty is the documented off switch");
  assert.equal(stored().quietTo, "");
});

test("a stored window the page cannot use is surfaced, not ignored", async () => {
  await open({ prefs: { ...ON, quietFrom: "10pm", quietTo: "" }, permission: "granted" });
  assert.equal(quietErr().hasAttribute("hidden"), false);
  assert.match(text(quietErr()), /being ignored/);

  await open({ prefs: { ...ON, quietFrom: "22:00", quietTo: "22:00" }, permission: "granted" });
  assert.match(text(quietErr()), /silences every alert/);
});

test("send test reports what actually happened", async () => {
  await open({ prefs: ON, permission: "granted" });
  const testNote = () => text($("#alerts-test").closest(".setsec")?.querySelector('[aria-live="polite"]'));
  await click("alerts-test");
  assert.equal(shown.length, 1, "one notification was really constructed");
  assert.equal(shown[0].title, "Test notification");
  assert.match(testNote(), /Sent/);

  // Granted, but the platform refuses to construct a notification (a common
  // desktop quirk): the page must not claim a test was sent.
  shown.length = 0;
  await open({ prefs: ON, permission: "granted" });
  const permitted = FakeNotification;
  globalThis.Notification = function Refusing() { throw new Error("not allowed by the platform"); };
  Object.defineProperty(globalThis.Notification, "permission", { value: "granted" });
  page.window.Notification = globalThis.Notification;
  await click("alerts-test");
  assert.equal(shown.length, 0, "nothing was displayed");
  assert.match(testNote(), /Nothing appeared/);
  globalThis.Notification = permitted;
  page.window.Notification = permitted;

  // A first ask that the user refuses changes the card's fact: it re-renders as
  // blocked, and the toast carries the outcome the note would have carried.
  await open({ prefs: ON, permission: "default", answer: "denied" });
  await click("alerts-test");
  assert.equal(shown.length, 0, "nothing was displayed");
  assert.equal(tag(), "blocked", "the browser's answer is now the headline");
  assert.equal(byId("alerts-test").disabled, true, "and the test button is unavailable");
  assert.match(shownText(), /did not show it/);
});

test("a browser with no Notification support gets a card, not controls", async () => {
  await open({ notification: false });
  assert.equal($$("input").length, 0, "no switches that could only write dead prefs");
  assert.equal($$("button").length, 0, "and nothing to click");
  assert.equal(tag(), "unsupported");
  assert.match(statusNote(), /cannot show notifications/);
  assert.ok($(".setcard__head"), "the card still explains itself");
});

test("no internal references, no native dialogs, no inline colours", () => {
  assert.ok(alertsRegion.length > 2000, "the region was found");
  assert.ok(!/their\s/i.test(alertsRegion), "no \"their …\" copy in the page");
  assert.ok(!/src\/[a-z]+\//i.test(alertsRegion), "no repo paths in the copy");
  assert.ok(!/window\.confirm/.test(alertsRegion), "deletes and prompts use the modal, never window.confirm");
  assert.ok(!/style:\s*["']/.test(alertsRegion), "no inline styles — the design system owns the look");
  assert.match(alertsRegion, /id: "alerts-save"/, "the commit button is addressable");
});

test("alerts fire only when enabled, granted and hidden", () => {
  // The unsupported test above removed the constructor; this test is about the
  // module, so put the browser back.
  globalThis.Notification = FakeNotification;
  page.window.Notification = FakeNotification;
  const run = (prefs) => {
    store.clear();
    if (prefs) store.set("sc.alerts", JSON.stringify(prefs));
    shown.length = 0;
    notif.onGatewayEvent("chat", { event: { type: "final" } });
  };
  browser.permission = "granted";
  browser.hidden = true;

  run({ ...ON, enabled: false });
  assert.equal(shown.length, 0, "an off switch silences everything");

  run(ON);
  assert.equal(shown.length, 0, "reply alerts are opt-in");

  run({ ...ON, reply: true });
  assert.equal(shown.length, 1, "hidden + granted + reply selected → one banner");
  assert.equal(shown[0].title, "Reply ready");

  browser.hidden = false;
  run(ON);
  assert.equal(shown.length, 0, "a visible tab gets no banner");
  browser.hidden = true;

  browser.permission = "default";
  run(ON);
  assert.equal(shown.length, 0, "a background event never raises the permission prompt");

  browser.permission = "granted";
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  run({ ...ON, quietFrom: `${pad(now.getHours())}:00`, quietTo: `${pad((now.getHours() + 2) % 24)}:00` });
  assert.equal(shown.length, 0, "quiet hours suppress the banner");

  run({ ...ON, reply: true });
  assert.equal(shown.length, 1, "a reply is announced when it is selected");
});

test("the alert bodies stay generic", () => {
  const notes = readFileSync(join(ROOT, "ui/src/notifications.ts"), "utf8");
  assert.ok(!/body:\s*ev\.text/.test(notes), "never the message text");
  assert.ok(!/ev\.(prompt|args)/.test(notes), "never the prompt or tool arguments");
  assert.match(notes, /Reply ready/);
});
