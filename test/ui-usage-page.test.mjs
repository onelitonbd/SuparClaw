// Settings → Usage: the page as a reader meets it.
//
// The tab used to be raw <select>s beside three tables that all said
// "Day / key", with "In"/"Out" for headers, no statement of which period the
// numbers covered, and three separate "No …" lines when there was nothing to
// show. This drives the real page and asserts the parts someone has to be able
// to read: the app's own dropdowns, what each column is, what the totals cover,
// and what happens when there is nothing.

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

const REPORT = {
  total: { runs: 42, inputTokens: 1_284_000, outputTokens: 96_400, cachedInput: 512_000, costUsd: null, unknownPriceRuns: 6 },
  perDay: [
    { day: "2026-10-24", runs: 18, inputTokens: 640_000, outputTokens: 48_000, costUsd: 2.4, unknownPriceRuns: 0 },
    { day: "2026-10-23", runs: 14, inputTokens: 412_000, outputTokens: 31_400, costUsd: 1.51, unknownPriceRuns: 0 },
    { day: "2026-10-22", runs: 10, inputTokens: 232_000, outputTokens: 17_000, costUsd: null, unknownPriceRuns: 3 },
  ],
  perSession: [
    { session: "agent:main:telegram:62112345", runs: 30, inputTokens: 1_040_000, outputTokens: 78_000, costUsd: 3.9, unknownPriceRuns: 0 },
    { session: "agent:main:control-ui:ab12cd34", runs: 12, inputTokens: 244_000, outputTokens: 18_400, costUsd: null, unknownPriceRuns: 3 },
  ],
  perModel: [
    { model: "anthropic/claude-sonnet-4.5", runs: 24, inputTokens: 880_000, outputTokens: 61_000, costUsd: 4.31, unknownPriceRuns: 0 },
    { model: "openai/gpt-5", runs: 12, inputTokens: 320_000, outputTokens: 27_400, costUsd: 0.5, unknownPriceRuns: 0 },
    { model: "local/qwen3-8b", runs: 6, inputTokens: 84_000, outputTokens: 8_000, costUsd: null, unknownPriceRuns: 6 },
  ],
};

const EMPTY = {
  total: { runs: 0, inputTokens: 0, outputTokens: 0, cachedInput: 0, costUsd: 0, unknownPriceRuns: 0 },
  perDay: [], perSession: [], perModel: [],
};

const SESSIONS = ["agent:main:telegram:62112345", "agent:main:control-ui:ab12cd34"];

const outDir = mkdtempSync(join(TMP, "sc-ui-usage-"));
const stub = join(outDir, "rpc-stub.mjs");
writeFileSync(stub, `
export const gateway = {
  state: "online",
  async request(method, params) {
    (globalThis.__GW_CALLS ||= []).push({ method, params });
    const report = globalThis.__GW_EMPTY ? ${JSON.stringify(EMPTY)} : ${JSON.stringify(REPORT)};
    if (method === "usage.report" && globalThis.__GW_FAIL_REPORT) throw new Error(globalThis.__GW_FAIL_REPORT);
    if (method === "usage.report") {
      return { report, days: params?.days ?? 0, sessionKey: params?.sessionKey ?? null, sessions: ${JSON.stringify(SESSIONS)} };
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
globalThis.location = { hash: "#/settings/usage", reload() {} };

// linkedom does not track document.activeElement, so watch focus() itself:
// the assertion is that focus lands on the rebuilt control after a re-render.
const focused = [];
page.HTMLElement.prototype.focus = function () { focused.push(this); };

const { Settings } = await import(pathToFileURL(join(outDir, "settings.mjs")).href);
const root = document.getElementById("settings-body");
// One instance per test: the app builds a fresh Settings on each route change,
// and the period/session selection is remembered on the instance.
let settings = new Settings(root, () => {});

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { await tick(); await tick(); await tick(); };
const byId = (id) => document.getElementById(id);
const $ = (sel) => root.querySelector(sel);
const $$ = (sel) => [...root.querySelectorAll(sel)];
const fire = (node, type) => node.dispatchEvent(new page.window.Event(type, { bubbles: true }));
const calls = (method) => (globalThis.__GW_CALLS ?? []).filter((c) => c.method === method);
const toasts = () => [...document.querySelectorAll("#toasts .toast")].map((t) => t.textContent ?? "");
const headers = (table) => [...table.querySelectorAll("thead th")].map((th) => th.textContent ?? "");
const rowsOf = (table) => [...table.querySelectorAll("tbody tr")].map((tr) => [...tr.children].map((td) => td.textContent ?? ""));
const pick = (btnId, label) => {
  fire(byId(btnId), "click");
  const opt = $$(".dd__opt").find((o) => (o.textContent ?? "").trim().startsWith(label));
  assert.ok(opt, `menu for ${btnId} offers "${label}"`);
  fire(opt, "click");
};
const open = async (empty = false) => {
  globalThis.__GW_CALLS = [];
  globalThis.__GW_EMPTY = empty;
  globalThis.__GW_FAIL_REPORT = "";
  document.querySelectorAll("#toasts .toast").forEach((t) => t.remove());
  root.innerHTML = "";
  focused.length = 0;
  settings = new Settings(root, () => {});
  settings.setHash("#/settings/usage");
  await settings.render();
  await settle();
};

test.beforeEach(async () => { await open(false); });

test("the controls are this app's dropdowns, with names and a store", () => {
  assert.equal($$(".dd").length, 2, "two menus, not two native selects");
  assert.equal($$("select.in").length, 0, "no raw themed selects left on the page");
  assert.equal(byId("usage-period-btn").getAttribute("aria-haspopup"), "listbox");
  assert.equal(byId("usage-period-btn").getAttribute("aria-expanded"), "false");
  assert.equal(byId("usage-period-btn").getAttribute("aria-label"), "Period: Last 30 days");
  assert.equal(byId("usage-session-btn").getAttribute("aria-label"), "Session: All sessions");
  assert.equal(byId("usage-period").value, "30");
  assert.equal(byId("usage-session").value, "");
  // The session list is long and the keys are long: it gets a search field.
  fire(byId("usage-session-btn"), "click");
  assert.equal(byId("usage-session-btn").getAttribute("aria-expanded"), "true");
  assert.ok($(".dd__menu:not([hidden]) .dd__search"), "the session menu can be searched");
  assert.ok(!$("#usage-period-menu:not([hidden]) .dd__search"), "four periods need no search box");
});

test("the session menu shows the part that tells two chats apart, and keeps the full key", () => {
  fire(byId("usage-session-btn"), "click");
  const opts = $$(".dd__opt");
  assert.deepEqual(opts.map((o) => (o.textContent ?? "").trim().split("✓")[0].trim()), ["telegram:62112345", "control-ui:ab12cd34"]);
  assert.deepEqual(opts.map((o) => o.getAttribute("title")), SESSIONS);
});

test("picking a period asks for that window, and the page says so", async () => {
  const before = calls("usage.report").length;
  pick("usage-period-btn", "Last 7 days");
  await settle();
  const last = calls("usage.report").at(-1);
  assert.equal(calls("usage.report").length, before + 1, "one fresh report");
  assert.equal(last.params.days, 7);
  assert.equal($(".usage-scope").textContent, "Last 7 days · all sessions");
  assert.equal(byId("usage-period-btn").getAttribute("aria-label"), "Period: Last 7 days");
  // The re-render rebuilt the control; focus has to come back to it, not vanish.
  assert.ok(focused.includes(byId("usage-period-btn")), "focus returns to the rebuilt menu button");
});

test("picking a session filters the report and names it beside the totals", async () => {
  pick("usage-session-btn", "telegram:62112345");
  await settle();
  assert.equal(calls("usage.report").at(-1).params.sessionKey, "agent:main:telegram:62112345");
  assert.equal($(".usage-scope").textContent, "Last 30 days · session agent:main:telegram:62112345");
});

test("each table says what its first column is, and what the numbers mean", () => {
  const daily = $(".usage-table--daily");
  const sessions = $(".usage-table--sessions");
  const models = $(".usage-table--models");
  assert.ok(daily && sessions && models, "three aggregate tables");
  assert.deepEqual(headers(daily), ["Day", "Runs", "Input tokens", "Output tokens", "Cost"]);
  assert.deepEqual(headers(sessions), ["Session", "Runs", "Input tokens", "Output tokens", "Cost"]);
  assert.deepEqual(headers(models), ["Model", "Runs", "Input tokens", "Output tokens", "Cost"]);
  for (const th of $$(".usage-table thead th")) {
    assert.equal(th.getAttribute("scope"), "col", "headers are real column headers");
  }
  assert.deepEqual(rowsOf(daily)[0], ["2026-10-24", "18", "640.0k", "48.0k", "$2.40"]);
  assert.deepEqual(rowsOf(models)[2], ["local/qwen3-8b", "6", "84.0k", "8.0k", "n/a"]);
  // An absent price is explained rather than left as a bare "n/a".
  assert.match($(".usage-table--models tbody tr:last-child td:last-child").getAttribute("title"), /no pricing card/);
});

test("the section headings count what is below them and say how it is ordered", () => {
  const heads = $$(".setsec__head").map((h) => (h.textContent ?? "").trim());
  assert.deepEqual(heads, [
    "Daily rollup3 days · newest first",
    "Per session2 sessions · by tokens",
    "Per model3 models · by runs",
  ]);
});

test("the totals say what they cover, and unpriced runs are explained", () => {
  assert.equal($(".usage-scope").textContent, "Last 30 days · all sessions");
  const cards = $$(".usage-card").map((c) => [
    c.querySelector(".usage-card__value").textContent,
    c.querySelector(".cap").textContent,
  ]);
  assert.deepEqual(cards, [["1.28M", "Input tokens"], ["96.4k", "Output tokens"], ["42", "Runs"], ["n/a", "Cost"]]);
  assert.match($(".usage-card:last-child").getAttribute("title"), /no pricing card/);
  const hints = $$(".hint").map((h) => h.textContent ?? "");
  assert.ok(hints.some((h) => /512\.0k of the input tokens were served from cache/.test(h)), "cache is accounted for");
  assert.ok(hints.some((h) => /6 runs of 42 used a model with no pricing card/.test(h)), "the n/a is explained");
  // The rounded face value keeps the exact count in its tooltip.
  assert.match($$(".usage-card")[0].getAttribute("title"), /1,284,000 input tokens/);
});

test("nothing recorded is one message with a way out, not three empty tables", async () => {
  await open(true);
  assert.equal($$(".usage-table").length, 0, "no empty tables");
  assert.equal($$(".usage-empty").length, 1);
  assert.equal($(".usage-empty__title").textContent, "No runs in the last 30 days");
  assert.equal($$(".usage-card")[3].querySelector(".usage-card__value").textContent, "$0.00", "zero is $0.00");
  assert.ok(byId("usage-export-json").disabled, "nothing to export");
  assert.ok(byId("usage-export-csv").disabled);
  assert.match(byId("usage-export-json").getAttribute("title"), /Nothing to export/);

  fire(byId("usage-all-time"), "click");
  await settle();
  assert.equal(calls("usage.report").at(-1).params.days, 0, "the button widened the window");
  assert.equal($(".usage-scope").textContent, "All time · all sessions");
  assert.equal(byId("usage-all-time"), null, "and it is gone once it would do nothing");
  assert.equal($(".usage-empty__title").textContent, "No usage recorded yet");
});

test("an empty session says so, and offers to clear the filter", async () => {
  globalThis.__GW_EMPTY = true;
  pick("usage-session-btn", "control-ui:ab12cd34");
  await settle();
  assert.equal($(".usage-empty__title").textContent, "No runs for this session in this period");
  fire(byId("usage-clear-session"), "click");
  await settle();
  assert.equal(calls("usage.report").at(-1).params.sessionKey, undefined, "the filter is cleared");
});

test("Refresh fetches the same window again and leaves the selection alone", async () => {
  const before = calls("usage.report").at(-1);
  fire(byId("usage-refresh"), "click");
  await settle();
  const after = calls("usage.report").at(-1);
  assert.equal(calls("usage.report").length, 2);
  assert.deepEqual(after.params, before.params);
  assert.equal(byId("usage-period").value, "30");
});

test("exports carry the report that is on screen", async () => {
  const blobs = [];
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (b) => { blobs.push(b); return "blob:test"; };
  URL.revokeObjectURL = () => {};
  try {
    fire(byId("usage-export-csv"), "click");
    await settle();
    assert.equal(blobs.length, 1);
    const csv = await blobs[0].text();
    assert.match(csv.split("\n")[0], /^day,runs,input_tokens,output_tokens,cost_usd$/);
    assert.match(csv, /2026-10-24,18,640000,48000,2\.400000/);
    assert.match(toasts().at(-1), /usage exported \(usage-daily-30d\.csv\)/);

    fire(byId("usage-export-json"), "click");
    await settle();
    const json = JSON.parse(await blobs[1].text());
    assert.equal(json.perDay.length, 3);
    assert.equal(json.total.runs, 42);
  } finally {
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
  }
});

test("a failed report is a card with the reason and a retry that works", async () => {
  globalThis.__GW_FAIL_REPORT = "gateway offline";
  globalThis.__GW_CALLS = [];
  await settings.render();
  await settle();
  assert.match($(".usage-empty__title").textContent, /could not be loaded/);
  assert.match($(".usage-empty").textContent, /gateway offline/, "the real reason, not a shrug");
  assert.equal($$(".usage-table").length, 0);

  globalThis.__GW_FAIL_REPORT = "";
  fire(byId("usage-retry"), "click");
  await settle();
  assert.equal($$(".usage-table").length, 3, "the retry loads the report");
  assert.equal($(".usage-empty"), null);
});
