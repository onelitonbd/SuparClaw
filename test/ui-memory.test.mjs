// Settings → Memory: the page where the nightly sweep is armed and its results
// are read.
//
// What was wrong: no card had a heading (one had no title at all, two used a
// 13px row label), the Save button floated in a modal-style footer, two card
// fields used the modal idiom, sentences were rendered right-aligned in
// monospace, three counts were crammed into one string, a raw rejection object
// (`{deduped:1}`) was printed as text, the cron hint named 0 4 while the field
// and the engine use 0 3, a blank schedule was silently replaced with the
// default, and the diary was five cards — one of them holding only a title.

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
const css = readFileSync(join(ROOT, "ui/styles.css"), "utf8");

const CONFIG = {
  agents: { defaults: { model: "openai/gpt-5.6" } },
  gateway: {},
  memory: { dreaming: { enabled: true, schedule: "0 3 * * *" } },
  tools: {},
};

const STATUS = {
  enabled: true,
  schedule: "0 3 * * *",
  scheduleError: null,
  nextRunAt: Date.now() + 2 * 3600_000,
  lastDreamAt: Date.now() - 3600_000,
  lastVerdict: "dream sweep: promoted 3, merged 1, superseded 0",
  lastRejected: { deduped: 1, "below-score": 2 },
  counts: { memoryLines: 42, dailyNotes: 7, diaryEntries: 2, staged: 2, promotedToday: 3 },
};

// Append-ordered, as the engine writes it: the newest entry is last in the file.
const DIARY = {
  dreamsPath: "/home/u/.suparclaw/DREAMS.md",
  memoryPath: "/home/u/.suparclaw/MEMORY.md",
  dreams:
    "## Deep Sleep - 2026-10-23\n- rejected 1 duplicate\n- nothing else\n\n" +
    "## Deep Sleep - 2026-10-24\n- promoted 3 facts into MEMORY.md\n- staged 2 for review\n",
  memory: "# MEMORY\n\n- the user runs Termux on a Pixel 8\n- prefers terse replies\n",
};

const outDir = mkdtempSync(join(TMP, "sc-ui-memory-"));
const stub = join(outDir, "rpc-stub.mjs");
writeFileSync(stub, `
export const gateway = {
  state: "online",
  async request(method, params) {
    (globalThis.__GW_CALLS ||= []).push({ method, params });
    const cfg = () => JSON.parse(JSON.stringify(globalThis.__CFG ?? ${JSON.stringify(CONFIG)}));
    if (method === "config.get") {
      if (globalThis.__GW_FAIL_ALL) throw new Error("socket closed");
      return { config: cfg(), path: "/home/u/.suparclaw/openclaw.json5" };
    }
    if (method === "config.set") {
      if (globalThis.__GW_FAIL_SET) throw new Error(globalThis.__GW_FAIL_SET);
      const next = cfg();
      let node = next;
      const parts = String(params.path).split(".");
      for (const p of parts.slice(0, -1)) node = (node[p] ||= {});
      node[parts.at(-1)] = params.value;
      globalThis.__CFG = next;
      return { ok: true };
    }
    if (method === "dream.status") {
      if (globalThis.__GW_FAIL_ALL) throw new Error("socket closed");
      return { ...${JSON.stringify(STATUS)}, ...(globalThis.__ST ?? {}) };
    }
    if (method === "dream.diary") {
      if (globalThis.__GW_FAIL_ALL) throw new Error("socket closed");
      return { ...${JSON.stringify(DIARY)}, ...(globalThis.__DIARY ?? {}) };
    }
    if (method === "dream.run") {
      if (globalThis.__GW_FAIL_RUN) throw new Error(globalThis.__GW_FAIL_RUN);
      return { ok: true, text: "deep sleep: promoted 2\\nnothing else" };
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
globalThis.location = { hash: "#/settings/memory", reload() {} };

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
const text = (n) => (n?.textContent ?? "").replace(/\s+/g, " ").trim();
const tag = () => text($(".memory-dream .setcard__status .settings__tag"));
const statusNote = () => text($(".memory-dream .setcard__status-note"));
const noteText = () => text($(".memory-dream .setfoot__note"));
const type = async (id, value) => {
  const node = byId(id);
  node.value = value;
  fire(node, "input");
  await settle();
};
const toggle = async (id, on) => {
  const node = byId(id);
  node.checked = on;
  fire(node, "change");
  await settle();
};
const fieldOf = (id) => byId(id).closest(".setfield");
const rowOf = (id) => byId(id).closest(".row");

const open = async ({ cfg, status, diary, failAll, failSet, failRun } = {}) => {
  globalThis.__GW_CALLS = [];
  globalThis.__CFG = JSON.parse(JSON.stringify(cfg ?? CONFIG));
  globalThis.__ST = status ?? null;
  globalThis.__DIARY = diary ?? null;
  globalThis.__GW_FAIL_ALL = failAll ? "socket closed" : "";
  globalThis.__GW_FAIL_SET = failSet ?? "";
  globalThis.__GW_FAIL_RUN = failRun ?? "";
  document.querySelectorAll("#toasts .toast").forEach((t) => t.remove());
  root.innerHTML = "";
  focused.length = 0;
  const settings = new Settings(root, () => {});
  settings.setHash("#/settings/memory");
  await settings.render();
  await settle();
};

test.beforeEach(async () => { await open(); });

test("three cards, each with a real heading, in the order the page tells its story", () => {
  const heads = $$(".settings__stack > .card h3").map((h) => text(h));
  assert.deepEqual(heads, ["Dreaming", "Dream diary", "Curated memory"]);
  assert.equal($$(".settings__stack > .card").length, 3, "three boxes, not six");
  assert.equal($$("#settings-body .modal__field").length, 0, "no modal fields in a card");
  assert.equal($$("#settings-body .modal__foot").length, 0, "no modal footer in a card");
});

test("every card states its own state once, as a dot and words", () => {
  for (const card of $$(".settings__stack > .card")) {
    const status = card.querySelector(".setcard__status");
    assert.ok(status, "the card has a status line");
    assert.equal(status.querySelectorAll(".settings__tag").length, 1, "one tag");
    assert.match(text(status.querySelector(".setcard__status-note")), /\S/, "and a sentence");
  }
  assert.equal(tag(), "on");
  assert.match(statusNote(), /^Next sweep in \d+ h — .*\d/);
  assert.equal(text($(".memory-diary .settings__tag")), "2 entries");
  assert.equal(text($(".memory-curated .settings__tag")), "42 lines");
  assert.match(text($(".memory-diary .setcard__status-note")), /DREAMS\.md/);
  assert.match(text($(".memory-curated .setcard__status-note")), /MEMORY\.md/);
});

test("saving is one labelled button in a commit footer, and rendering writes nothing", async () => {
  assert.equal(sets().length, 0, "a render never writes");
  const save = byId("mem-dream-save");
  assert.equal(text(save), "Save dreaming");
  const foot = $(".memory-dream .setfoot");
  assert.ok(foot.contains(save));
  assert.deepEqual([...foot.children].map((c) => c.id || c.className), ["setfoot__note", "hint hint--err", "mem-dream-save"]);
  assert.ok(foot.querySelector(".hint--err").hasAttribute("hidden"), "no error until there is one");
});

test("every section head carries a count, and no count restates the card's tag", () => {
  const heads = $$(".memory-dream .setsec__head");
  assert.ok(heads.length >= 3);
  const counts = heads.map((h) => text(h.querySelector(".setsec__count")));
  assert.deepEqual(counts, ["2 settings", "3 places", "1 action"]);
  const tagText = tag();
  for (const c of counts) assert.notEqual(c, tagText, "a count is a quantity, not the state");
  for (const h of heads) assert.match(text(h.querySelector(".cap")), /\S/);
});

test("the boolean is a row with the switch on the right, like every other boolean", () => {
  const row = rowOf("mem-dream-enabled");
  assert.ok(row, "the switch sits in a row");
  assert.ok(row.querySelector(".row__main .row__label"), "the label is the row's main text");
  assert.equal(row.lastElementChild.id, "mem-dream-enabled", "the control trails the row");
  assert.equal(row.querySelector(".row__label").getAttribute("for"), "mem-dream-enabled");
  assert.match(text(row.querySelector(".hint")), /nothing runs on its own/);
});

test("the schedule is a labelled field, and its hint names the default the app really uses", () => {
  assert.equal($('label[for="mem-dream-schedule"]').textContent, "Schedule (cron)");
  const hint = text(fieldOf("mem-dream-schedule").querySelector(".hint"));
  assert.match(hint, /0 3 \* \* \*/);
  assert.doesNotMatch(hint, /0 4 \* \* \*/, "the page used to claim 0 4 while the engine runs 0 3");
  assert.match(hint, /never appears in Automations/);
  // The same two leaves are editable on the Automations tab: say so rather than
  // letting the reader wonder which page wins.
  assert.match(text(fieldOf("mem-dream-schedule")), /also appear on the Automations tab/);
  assert.match(text(fieldOf("mem-dream-schedule")), /one setting with two editors/);
  assert.equal(byId("mem-dream-schedule").value, "0 3 * * *");
});

test("a fact is a short value with its explanation in the hint, never a sentence on the right", () => {
  const rows = $$(".memory-dream .row");
  const values = rows.map((r) => text(r.querySelector(".row__value"))).filter(Boolean);
  assert.deepEqual(values, ["1 h ago", "42 lines", "7 files", "2 entries"]);
  for (const r of rows) {
    const v = r.querySelector(".row__value");
    if (!v) continue;
    assert.ok(text(v).length <= 12, `"${text(v)}" is a value, not a paragraph`);
    assert.ok(r.querySelector(".row__main .hint"), "the sentence lives in the row's hint");
  }
  // The last sweep's story is the hint: what it did, what is staged, what it refused.
  const lastHint = text(rows[0].querySelector(".hint"));
  assert.match(lastHint, /dream sweep: promoted 3/);
  assert.match(lastHint, /2 staged/);
  assert.match(lastHint, /rejected 1 already in memory, 2 below the score gate/);
});

test("a rejection category is words, and the raw object never reaches the page", () => {
  const all = text($(".memory-dream"));
  assert.doesNotMatch(all, /[{}]/, "no raw object in the UI");
  assert.doesNotMatch(all, /deduped|below-score/);
  assert.match(all, /already in memory/);
  assert.match(all, /below the score gate/);
});

test("the diary is one card with flat entries inside it, newest first", () => {
  assert.equal($$(".card .card").length, 0, "no card inside a card");
  const entries = $$(".memory-diary .diary__entry");
  assert.equal(entries.length, 2);
  const dates = entries.map((e) => text(e.querySelector(".row__label")));
  assert.deepEqual(dates, ["Deep Sleep — 2026-10-24", "Deep Sleep — 2026-10-23"]);
  assert.equal(text(entries[0].querySelector(".row__value")), "2 lines");
  assert.match(text(entries[0].querySelector(".diary__body")), /promoted 3 facts/);
  // It is a disclosure: closed until asked, native semantics.
  assert.equal(entries[0].hasAttribute("open"), false);
  assert.equal(entries[0].tagName, "DETAILS");
  assert.equal($(".memory-diary .setfoot"), null);
});

test("curated memory shows the file, and an empty file explains itself", async () => {
  const pre = $(".memory-curated > .diary__body");
  assert.match(text(pre), /Termux on a Pixel 8/);
  await open({ diary: { ...DIARY, memory: "  \n" } });
  assert.match(text($(".memory-curated > .diary__body")), /empty — the sweep promotes durable facts here/);
  assert.equal(text($(".memory-curated .settings__tag")), "42 lines", "the count comes from status, not the text");
});

test("saving writes the whole block once, and only the two leaves change", async () => {
  await toggle("mem-dream-enabled", false);
  await type("mem-dream-schedule", "30 2 * * *");
  assert.equal(noteText(), "Unsaved changes");
  await click("mem-dream-save");
  assert.equal(sets().length, 1, "one write, not one per field");
  assert.equal(sets()[0].params.path, "memory.dreaming");
  assert.deepEqual(sets()[0].params.value, { enabled: false, schedule: "30 2 * * *" });
  assert.equal(noteText(), "");
});

test("an unknown key under memory.dreaming survives the save", async () => {
  await open({ cfg: { ...CONFIG, memory: { dreaming: { enabled: true, schedule: "0 3 * * *", timezone: "Asia/Dhaka" } } } });
  await type("mem-dream-schedule", "0 5 * * *");
  await click("mem-dream-save");
  assert.deepEqual(sets()[0].params.value, { enabled: true, schedule: "0 5 * * *", timezone: "Asia/Dhaka" });
});

test("a blank or malformed schedule is refused in place, and nothing is written", async () => {
  await type("mem-dream-schedule", "");
  await click("mem-dream-save");
  assert.equal(sets().length, 0, "a blank schedule is not silently replaced with the default");
  const err = byId("mem-dream-sched-err");
  assert.equal(err.hasAttribute("hidden"), false);
  assert.match(text(err), /A schedule is required — 0 3 \* \* \* runs the sweep at 03:00/);
  assert.equal(byId("mem-dream-schedule").getAttribute("aria-invalid"), "true");
  assert.equal(focused.at(-1), byId("mem-dream-schedule"), "focus goes to the field");
  assert.equal($(".memory-dream .setfoot .hint--err").hasAttribute("hidden"), false);

  await type("mem-dream-schedule", "0 3 * *");
  await click("mem-dream-save");
  assert.equal(sets().length, 0, "four fields is not a schedule");
  assert.match(text(byId("mem-dream-sched-err")), /Not a cron schedule — 5 fields/);

  // Editing clears the refusal instead of leaving a stale sentence behind.
  await type("mem-dream-schedule", "0 3 * * *");
  assert.equal(byId("mem-dream-sched-err").hasAttribute("hidden"), true);
  assert.equal(byId("mem-dream-schedule").hasAttribute("aria-invalid"), false);
});

test("a cron nickname is accepted, because croner accepts one", async () => {
  await type("mem-dream-schedule", "@daily");
  await click("mem-dream-save");
  assert.equal(sets().length, 1);
  assert.equal(sets()[0].params.value.schedule, "@daily");
});

test("Dream now runs a sweep outside the commit band and reports its own progress", async () => {
  const run = byId("mem-dream-run");
  assert.equal(text(run), "Dream now");
  assert.equal($(".memory-dream .setfoot").contains(run), false, "it is not commit material");
  assert.match(text(run.closest(".setsec")), /runs even when the schedule is off/);
  await click("mem-dream-run");
  assert.equal(calls("dream.run").length, 1);
  // Re-rendered afterwards: the button is back to its resting label.
  assert.equal(text(byId("mem-dream-run")), "Dream now");
});

test("a failed sweep says so next to the button and re-enables it", async () => {
  await open({ failRun: "executor missing" });
  await click("mem-dream-run");
  const note = byId("mem-dream-run").closest(".setsec").querySelector(".hint[aria-live]");
  assert.match(text(note), /sweep failed — executor missing/);
  assert.equal(byId("mem-dream-run").disabled, false);
});

test("an invalid stored schedule is a warning on the card, not a red pill", async () => {
  await open({ status: { scheduleError: 'invalid cron schedule "0 4" (want 5 fields, e.g. 0 3 * * *)' } });
  assert.equal(tag(), "invalid schedule");
  assert.match($(".memory-dream .settings__tag").getAttribute("class"), /is-warn/);
  assert.match(statusNote(), /invalid cron schedule/);
});

test("with the gateway down the page still renders and still explains itself", async () => {
  await open({ failAll: true });
  assert.equal(tag(), "unknown");
  assert.match(statusNote(), /Could not read the sweep state/);
  assert.equal(byId("mem-dream-save").disabled, false, "saving is still offered");
  assert.match(text($(".memory-diary .diary-list")), /Could not read the diary/);
  assert.match(text($(".memory-curated")), /Could not read MEMORY\.md/);
});

test("flipping the switch updates the card's state line immediately", async () => {
  await toggle("mem-dream-enabled", false);
  assert.equal(tag(), "off");
  assert.match(statusNote(), /No sweep is scheduled/);
  await toggle("mem-dream-enabled", true);
  assert.equal(tag(), "on");
});

test("the CSS keeps entries flat, aligns their bodies, and leaves the Service log alone", () => {
  assert.match(css, /\.settings \.diary__entry > summary::before \{[^}]*width: var\(--diary-mark\);/s);
  assert.match(css, /\.settings \.diary__entry > \.diary__body \{ padding: 0 0 12px calc\(var\(--diary-mark\) \+ 10px\); \}/);
  assert.match(css, /\.settings \.card:not\(\.diary\) > \.diary__body \{[^}]*padding: 0;/s);
  // The Service page's own log block is a .card.diary and must keep its band.
  assert.match(css, /\.settings \.card\.diary > summary \{\s*padding: 13px var\(--card-pad\);\s*\}/);
});
