// Settings → Automations: cron jobs, the heartbeat, the IMAP watcher, inbound
// hooks and the message queue.
//
// What was wrong: six cards with a bare h3 and no status or footer, nine
// modal-style fields sitting in cards, four save buttons (two labelled just
// "Save") loose at the end of a card, "+ New" actions next to commit actions,
// live runtime state interleaved with editable records, seven native <select>s,
// "their automation/imap" and "src/automation/imap.ts" in the copy, raw config
// keys as labels, timestamps to the second, `window.confirm` for three deletes,
// silent clamps (`Number(x) || 20`), and a second editor for the dream sweep.

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
const settingsSrc = readFileSync(join(ROOT, "ui/src/settings.ts"), "utf8");
const region = settingsSrc.slice(
  settingsSrc.indexOf("automations (OpenClaw"),
  settingsSrc.indexOf("/* ---------------- alerts"),
);

const CONFIG = {
  agents: { defaults: { model: "openai/gpt-5.6", heartbeat: { every: "30m", lightContext: true, isolatedSession: false, target: "owner" } } },
  gateway: {},
  memory: { dreaming: { enabled: true, schedule: "0 3 * * *" } },
  messages: { queue: { mode: "steer", cap: 20, drop: "summarize", debounceMs: 500, byChannel: {} } },
  imap: {
    enabled: true,
    accounts: {
      work: {
        enabled: true, host: "imap.example.com", port: 993, secure: true, user: "bot@example.com",
        mailbox: "INBOX", watch: { mode: "auto", pollSeconds: 60 }, allowedSenders: ["alice@x.com"],
        senderAuth: { min: "unverified" }, deliver: true, to: "telegram:123", includeBody: true,
      },
    },
  },
  hooks: {
    enabled: true, path: "/hooks", token: "__redacted__:••••abcd", allowRequestSessionKey: false,
    mappings: { github: { action: "agent", message: "{{body}}", sessionKey: "ops" } },
  },
  tools: {},
};

const CRON = {
  jobs: [
    {
      id: "j1", name: "morning-brief", schedule: "0 9 * * 1-5", tz: "Asia/Dhaka", enabled: 1,
      prompt: "Summarise the inbox", delivery_mode: "announce", delivery_to: "telegram:123",
      delivery_suppress_empty: 1, last_run_at: Date.now() - 3600_000,
    },
    {
      id: "j2", name: "weekly-review", schedule: "0 18 * * 0", tz: "", enabled: 0,
      prompt: "Weekly review", delivery_mode: "none", delivery_to: "", delivery_suppress_empty: 1,
    },
  ],
  runs: [{ job_id: "j1", status: "ok", started_at: Date.now() - 3600_000 }],
};

const STATE = {
  cron: { enabled: true, jobs: CRON.jobs },
  heartbeat: { every: "30m", armed: true, target: "owner", lastTargetChat: "telegram:123", lightContext: true, isolatedSession: false },
  imap: { enabled: true, accounts: [{ name: "work", mailbox: "INBOX", cursor: 42, skips: 1, unhealthy: false, lastError: null }] },
};

const outDir = mkdtempSync(join(TMP, "sc-ui-automations-"));
const stub = join(outDir, "rpc-stub.mjs");
writeFileSync(stub, `
export const gateway = {
  state: "online",
  async request(method, params) {
    (globalThis.__GW_CALLS ||= []).push({ method, params });
    const cfg = () => JSON.parse(JSON.stringify(globalThis.__CFG ?? ${JSON.stringify(CONFIG)}));
    if (method === "config.get") return { config: cfg(), path: "/home/u/.suparclaw/openclaw.json5" };
    if (method === "config.set") {
      if (globalThis.__GW_FAIL_SET) throw new Error(globalThis.__GW_FAIL_SET);
      const next = cfg();
      const parts = String(params.path).split(".");
      let node = next;
      for (const p of parts.slice(0, -1)) node = (node[p] ||= {});
      node[parts.at(-1)] = params.value;
      globalThis.__CFG = next;
      return { ok: true };
    }
    if (method === "config.unset") {
      const next = cfg();
      const parts = String(params.path).split(".");
      let node = next;
      for (const p of parts.slice(0, -1)) node = node?.[p];
      if (node) delete node[parts.at(-1)];
      globalThis.__CFG = next;
      return { ok: true };
    }
    if (method === "automations.state") {
      if (globalThis.__GW_FAIL_STATE) throw new Error(globalThis.__GW_FAIL_STATE);
      return JSON.parse(JSON.stringify(globalThis.__STATE ?? ${JSON.stringify(STATE)}));
    }
    if (method === "cron.list") return JSON.parse(JSON.stringify(globalThis.__CRON ?? ${JSON.stringify(CRON)}));
    if (method === "cron.upsert") {
      if (globalThis.__GW_FAIL_CRON) throw new Error(globalThis.__GW_FAIL_CRON);
      const job = { id: params.id ?? "new", name: params.name };
      return { job, next: "2026-10-26T03:00:00.000Z" };
    }
    if (method === "cron.remove") return { ok: true };
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
globalThis.location = { hash: "#/settings/automations", reload() {} };

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
const tap = async (node) => { fire(node, "click"); await settle(); };
const click = async (id) => { await tap(byId(id)); };
const calls = (method) => (globalThis.__GW_CALLS ?? []).filter((c) => c.method === method);
const sets = () => calls("config.set");
const setPaths = () => sets().map((c) => c.params.path);
const setValue = (path) => sets().filter((c) => c.params.path === path).at(-1)?.params.value;
const type = async (id, value) => { const n = byId(id); n.value = value; fire(n, "input"); await settle(); };
const toggle = async (id, on) => { const n = byId(id); n.checked = on; fire(n, "change"); await settle(); };
// The card argument already carries its own dot (".auto-queue"), because the
// selectors below are pasted straight into a query.
const tag = (card) => text($(`${card} .setcard__status .settings__tag`));
const note = (card) => text($(`${card} .setcard__status-note`));
const footNote = (card) => text($(`${card} .setfoot .setfoot__note`));
const footErr = (card) => $(`${card} .setfoot .hint--err`);
const opts = (id) => [...byId(id).querySelectorAll("option")];
const selValue = (id) => (opts(id).find((o) => o.selected) ?? opts(id)[0])?.value ?? "";
const pick = async (id, label, host = root) => {
  fire(byId(`${id}-btn`), "click");
  await settle();
  const menu = host.querySelector(`#${id}-menu:not([hidden])`) ?? $(`#${id}-menu:not([hidden])`);
  const opt = [...(menu?.querySelectorAll(".dd__opt") ?? [])]
    .find((o) => text(o).replace("✓", "").trim().startsWith(label));
  assert.ok(opt, `the ${id} menu offers "${label}"`);
  fire(opt, "click");
  await settle();
};
const menuLabels = (id, host = root) => {
  fire(byId(`${id}-btn`), "click");
  const menu = host.querySelector(`#${id}-menu:not([hidden])`) ?? $(`#${id}-menu:not([hidden])`);
  const labels = [...(menu?.querySelectorAll(".dd__opt") ?? [])].map((o) => text(o).replace("✓", "").trim());
  fire(byId(`${id}-btn`), "click");
  return labels;
};
const dialog = () => document.getElementById("modal-body");
const dialogFoot = () => document.getElementById("modal-foot");
const dialogOpen = () => !document.getElementById("modal-overlay").hasAttribute("hidden");
const confirmBtn = () => [...dialogFoot().querySelectorAll("button")].find((b) => /Save|Create|Add|Delete/.test(text(b)));
const cancelDialog = async () => {
  const cancel = [...dialogFoot().querySelectorAll("button")].find((b) => text(b) === "Cancel");
  await tap(cancel);
};

const open = async ({ cfg, state, cron, failState, failSet, failCron } = {}) => {
  globalThis.__GW_CALLS = [];
  globalThis.__CFG = JSON.parse(JSON.stringify(cfg ?? CONFIG));
  globalThis.__STATE = state ?? null;
  globalThis.__CRON = cron ?? null;
  globalThis.__GW_FAIL_STATE = failState ?? "";
  globalThis.__GW_FAIL_SET = failSet ?? "";
  globalThis.__GW_FAIL_CRON = failCron ?? "";
  document.querySelectorAll("#toasts .toast").forEach((t) => t.remove());
  root.innerHTML = "";
  dialog().innerHTML = "";
  dialogFoot().innerHTML = "";
  document.getElementById("modal-overlay").hidden = true;
  focused.length = 0;
  const settings = new Settings(root, () => {});
  settings.setHash("#/settings/automations");
  await settings.render();
  await settle();
  return settings;
};

test.beforeEach(async () => { await open(); });

test("five cards, each with a heading, one status line and one sentence per hint", () => {
  const heads = $$(".settings__stack > .card h3").map((h) => text(h));
  assert.deepEqual(heads, ["Cron jobs", "Heartbeat", "IMAP mail watcher", "Inbound hooks", "Message queue"]);
  assert.equal($$(".settings__stack > .card").length, 5, "five boxes, not six");
  assert.equal($$(".settings__stack .modal__field").length, 0, "no modal field inside a card");
  assert.equal($$(".settings__stack .modal__foot").length, 0, "no modal footer inside a card");
  for (const card of $$(".settings__stack > .card")) {
    const status = card.querySelector(".setcard__status");
    assert.ok(status, "the card states its own state");
    assert.equal(status.querySelectorAll(".settings__tag").length, 1, "one tag");
    assert.match(text(status.querySelector(".setcard__status-note")), /\S/, "and a sentence");
    const hint = text(card.querySelector(".setcard__head .hint"));
    assert.match(hint, /\S/, "the heading carries a sentence");
    assert.ok(!hint.endsWith(".") || hint.split(" ").length > 5, "and it is a sentence, not a fragment");
  }
});

test("each saving card commits from one footer, and the footer's last word is Save <subject>", () => {
  assert.equal(sets().length, 0, "a render never writes");
  const expected = [
    [".auto-cron", "Save scheduler"],
    [".auto-heartbeat", "Save heartbeat"],
    [".auto-imap", "Save watcher"],
    [".auto-hooks", "Save hook settings"],
    [".auto-queue", "Save queue"],
  ];
  for (const [card, label] of expected) {
    const foot = $(`${card} .setfoot`);
    assert.ok(foot, `${card} has a footer`);
    const kids = [...foot.children];
    assert.equal(kids.at(-1).tagName, "BUTTON", `${card} ends with its save`);
    assert.equal(text(kids.at(-1)), label);
    assert.deepEqual(kids.map((c) => c.id || c.className), ["setfoot__note", "hint hint--err", kids.at(-1).id]);
    assert.ok(foot.querySelector(".hint--err").hasAttribute("hidden"), "no error until there is one");
  }
  const saves = $$(".settings__stack button").filter((b) => /^Save\b/.test(text(b)));
  assert.deepEqual(saves.map((b) => text(b)), expected.map(([, label]) => label), "no loose or duplicate Save");
});

test("every section states what it holds, and a count never repeats the card's tag", () => {
  const secs = $$(".settings__stack .setsec");
  assert.ok(secs.length >= 10);
  for (const sec of secs) {
    assert.match(text(sec.querySelector(".cap")), /\S/, "named section");
    assert.match(text(sec.querySelector(".setsec__count")), /\S/, "with a count");
  }
  assert.equal(text($(".auto-cron .setsec:nth-of-type(2) .setsec__count")), "2 jobs");
  assert.equal(text($(".auto-imap .setsec:nth-of-type(3) .setsec__count")), "1 account");
  assert.equal(text($(".auto-hooks .setsec:nth-of-type(2) .setsec__count")), "1 mapping");
});

test("no native select anywhere: on the page or in any of the three dialogs", async () => {
  assert.equal($$("select:not(.dd__store)").length, 0, "page");
  for (const id of ["queue-mode", "queue-drop", "queue-by-tg", "hb-target"]) {
    const dd = byId(id).closest(".dd");
    assert.ok(dd.querySelector(".dd__btn"), `${id} has a real trigger`);
    assert.equal(dd.querySelector(".dd__menu").getAttribute("role"), "listbox");
    assert.ok(byId(id).hasAttribute("hidden"), "the store is not rendered as a select");
  }
  for (const opener of ["cron-new", "imap-add", "hook-map-add"]) {
    await click(opener);
    assert.ok(dialogOpen(), `${opener} opens a dialog`);
    assert.equal([...dialog().querySelectorAll("select:not(.dd__store)")].length, 0, `${opener}: no native select`);
    await cancelDialog();
  }
});

test("the queue's modes explain themselves where they are chosen", async () => {
  const labels = menuLabels("queue-mode");
  assert.deepEqual(labels, [
    "steer — inject into the live turn",
    "followup — run after the active turn",
    "collect — merge queued messages into one turn",
    "interrupt — stop the turn, run the newest",
  ]);
  assert.equal(selValue("queue-mode"), "steer");
  assert.equal(tag(".auto-queue"), "steer");
  assert.match(note(".auto-queue"), /Holds 20 messages per session\. Past that it folds the oldest into one message\./);
  assert.equal(text($('.auto-queue .setfield .lbl')), "Default mode");
});

test("the queue refuses a cap of 0 or text in place and writes nothing", async () => {
  await type("queue-cap", "0");
  await click("queue-save");
  assert.equal(sets().length, 0, "nothing written");
  assert.equal(byId("queue-cap").getAttribute("aria-invalid"), "true");
  assert.ok(focused.at(-1) === byId("queue-cap"), "focus lands on the field that is wrong");
  assert.match(text(footErr(".auto-queue")), /cap/);
  assert.ok(!footErr(".auto-queue").hasAttribute("hidden"));

  await type("queue-cap", "lots");
  await click("queue-save");
  assert.equal(sets().length, 0);
  assert.equal(byId("queue-cap").getAttribute("aria-invalid"), "true");

  await type("queue-cap", "5");
  assert.ok(footErr(".auto-queue").hasAttribute("hidden"), "the error goes when the field is edited");

  await type("queue-debounce", "-5");
  await click("queue-save");
  assert.equal(sets().length, 0);
  assert.equal(byId("queue-debounce").getAttribute("aria-invalid"), "true");
  assert.match(text(footErr(".auto-queue")), /debounce/);
});

test("a valid queue save writes exactly four leaves and the byChannel map", async () => {
  await pick("queue-mode", "followup");
  await type("queue-cap", "12");
  await type("queue-debounce", "250");
  await pick("queue-drop", "old");
  await click("queue-save");
  assert.deepEqual(setPaths(), [
    "messages.queue.mode",
    "messages.queue.cap",
    "messages.queue.drop",
    "messages.queue.debounceMs",
    "messages.queue.byChannel",
  ]);
  assert.equal(setValue("messages.queue.mode"), "followup");
  assert.equal(setValue("messages.queue.cap"), 12);
  assert.equal(setValue("messages.queue.drop"), "old");
  assert.equal(setValue("messages.queue.debounceMs"), 250);
  assert.deepEqual(setValue("messages.queue.byChannel"), {}, "inherit is the absence of the key");

  await open();
  await pick("queue-by-tg", "collect — merge queued");
  await click("queue-save");
  assert.deepEqual(setValue("messages.queue.byChannel"), { telegram: "collect" });
});

test("the heartbeat refuses a cadence that is not a duration, and keeps 0m as the off switch", async () => {
  await type("hb-every", "soon");
  await click("hb-save");
  assert.equal(sets().length, 0);
  assert.equal(byId("hb-every").getAttribute("aria-invalid"), "true");
  assert.ok(focused.at(-1) === byId("hb-every"), "focus lands on the cadence");
  assert.match(text(footErr(".auto-heartbeat")), /cadence/);

  await type("hb-every", "0m");
  await click("hb-save");
  assert.equal(setValue("agents.defaults.heartbeat.every"), "0m");
  assert.deepEqual(setPaths().slice(0, 4), [
    "agents.defaults.heartbeat.every",
    "agents.defaults.heartbeat.target",
    "agents.defaults.heartbeat.lightContext",
    "agents.defaults.heartbeat.isolatedSession",
  ], "the cadence block commits together");
  assert.equal(setValue("agents.defaults.heartbeat.lightContext"), true);
});

test("the heartbeat's target is editable because the card already prints it", async () => {
  const labels = menuLabels("hb-target");
  assert.equal(labels.length, 3);
  assert.match(labels[0], /^owner/);
  assert.match(labels[1], /^last/);
  assert.match(labels[2], /^none/);
  await pick("hb-target", "none");
  await click("hb-save");
  assert.equal(setValue("agents.defaults.heartbeat.target"), "none");
});

test("the scheduler can be switched off from the card that reports it", async () => {
  assert.equal(tag(".auto-cron"), "on");
  await toggle("cron-enabled", false);
  await click("cron-save");
  assert.deepEqual(setPaths(), ["cron.enabled"]);
  assert.equal(setValue("cron.enabled"), false);
  assert.equal(tag(".auto-cron"), "off");
  assert.match(note(".auto-cron"), /Nothing fires while the scheduler is off/);
});

test("a cron row says when it last ran, and its verbs act on that job alone", async () => {
  const rows = $$(".auto-cron .cron-job");
  assert.equal(rows.length, 2);
  assert.match(text(rows[0].querySelector(".hint")), /0 9 \* \* 1-5, Asia\/Dhaka, last ok 1 h ago/);
  assert.match(text(rows[1].querySelector(".hint")), /not run yet/);
  assert.equal(text(rows[0].querySelector(".settings__tag")), "on");
  assert.equal(text(rows[1].querySelector(".settings__tag")), "paused");
  assert.equal(text(byId("cron-toggle-j1")), "Pause");
  assert.equal(text(byId("cron-toggle-j2")), "Resume");
  assert.equal(byId("cron-toggle-j1").getAttribute("aria-label"), "Pause morning-brief");

  await click("cron-toggle-j1");
  const up = calls("cron.upsert");
  assert.equal(up.length, 1);
  assert.deepEqual(up[0].params, {
    id: "j1", name: "morning-brief", schedule: "0 9 * * 1-5", prompt: "Summarise the inbox", enabled: false,
  }, "the toggle goes through the same validated path as `sc cron add`");

  await open();
  assert.equal(text(byId("cron-new")), "+ New job");
  assert.ok($(".auto-cron .setsec:nth-of-type(2)").contains(byId("cron-new")), "the add sits inside the list it adds to");
});

test("deleting a job, an account or a mapping asks in the app's own dialog and unlinks nothing else", async () => {
  await click("cron-del-j1");
  assert.ok(dialogOpen(), "a dialog, not window.confirm");
  assert.equal(text(byId("modal-title")), "Delete morning-brief?");
  assert.match(text(dialog()), /already recorded stay/);
  assert.equal(text(confirmBtn()), "Delete job");
  await tap(confirmBtn());
  assert.deepEqual(calls("cron.remove").map((c) => c.params), [{ id: "j1" }]);

  await open();
  await click("imap-del-work");
  assert.equal(text(byId("modal-title")), "Delete mailbox work?");
  assert.equal(text(confirmBtn()), "Delete mailbox");
  await tap(confirmBtn());
  assert.deepEqual(calls("config.unset").map((c) => c.params.path), ["imap.accounts.work"]);

  await open();
  await click("hook-map-del-github");
  assert.equal(text(byId("modal-title")), "Delete mapping github?");
  await tap(confirmBtn());
  assert.deepEqual(calls("config.unset").map((c) => c.params.path), ["hooks.mappings.github"]);
});

test("the watcher's runtime health is its own section, and an account is printed once as a record", async () => {
  const live = $(".auto-imap .setsec:nth-of-type(2)");
  assert.equal(text(live.querySelector(".cap")), "Live status");
  assert.match(text(live), /cursor 42/);
  assert.match(text(live), /1 message skipped/);
  const accounts = $(".auto-imap .setsec:nth-of-type(3)");
  assert.equal(text(accounts.querySelector(".cap")), "Accounts");
  assert.match(text(accounts), /imap\.example\.com:993, TLS, bot@example\.com, INBOX/);
  assert.ok(accounts.contains(byId("imap-edit-work")));
  assert.ok(accounts.contains(byId("imap-add")), "the add sits inside the list");

  await toggle("imap-enabled", false);
  await click("imap-save");
  assert.equal(setValue("imap.enabled"), false);
  assert.match(note(".auto-imap"), /Nothing is being read/);
});

test("the hook token is write-only: blank keeps it, typing replaces it", async () => {
  const token = byId("hooks-token-out");
  assert.equal(token.value, "", "the stored secret is never put in the field");
  assert.match(token.getAttribute("placeholder"), /stored/);
  assert.equal(tag(".auto-hooks"), "live");

  await click("hooks-save");
  assert.deepEqual(setPaths(), ["hooks.enabled", "hooks.path", "hooks.allowRequestSessionKey"]);
  assert.equal(setValue("hooks.allowRequestSessionKey"), false);

  await open();
  await type("hooks-token-out", "s3cret");
  await click("hooks-save");
  assert.equal(setValue("hooks.token"), "s3cret");
});

test("hooks that are on without a token say so instead of pretending to be live", async () => {
  await open({ cfg: { ...CONFIG, hooks: { ...CONFIG.hooks, token: "" } } });
  assert.equal(tag(".auto-hooks"), "on, no token");
  assert.match(note(".auto-hooks"), /refused without one/);
});

test("the hook mapping editor offers the two actions and writes only that record", async () => {
  await click("hook-map-add");
  byId("hmap-f-name").value = "deploy";
  await pick("hmap-f-action", "wake", dialog());
  byId("hmap-f-message").value = "{{body}}";
  await tap(confirmBtn());
  const wrote = sets().filter((c) => c.params.path.startsWith("hooks.mappings."));
  assert.deepEqual(wrote.map((c) => c.params.path), ["hooks.mappings.deploy"]);
  assert.deepEqual(wrote[0].params.value, { action: "wake", message: "{{body}}" });
});

test("the cron dialog refuses a bad schedule, a bad zone and a webhook with no target, before the server sees it", async () => {
  await click("cron-new");
  byId("cron-f-name").value = "brief";
  byId("cron-f-prompt").value = "summarise";
  byId("cron-f-schedule").value = "0 9 * *";
  await tap(confirmBtn());
  assert.equal(calls("cron.upsert").length, 0, "nothing sent");
  assert.ok(!dialog().querySelector(".hint--err").hasAttribute("hidden"), "the dialog says what is wrong");
  // The dialog focuses its first field when it opens; a refusal afterwards has
  // to take focus to the field that is wrong, whichever order they land in.
  assert.ok(focused.includes(byId("cron-f-schedule")), "focus reaches the schedule");

  byId("cron-f-schedule").value = "0 9 * * 1-5";
  byId("cron-f-tz").value = "Dhaka";
  await tap(confirmBtn());
  assert.equal(calls("cron.upsert").length, 0);
  assert.match(text(dialog().querySelector(".hint--err")), /Asia\/Dhaka/);
  assert.ok(focused.includes(byId("cron-f-tz")), "focus reaches the timezone");

  byId("cron-f-tz").value = "";
  await pick("cron-f-delivery", "webhook", dialog());
  await tap(confirmBtn());
  assert.equal(calls("cron.upsert").length, 0);
  assert.match(text(dialog().querySelector(".hint--err")), /target URL/);

  byId("cron-f-to").value = "https://example.com/hook";
  await tap(confirmBtn());
  assert.equal(calls("cron.upsert").length, 1);
  const p = calls("cron.upsert")[0].params;
  assert.equal(p.name, "brief");
  assert.equal(p.deliveryMode, "webhook");
  assert.equal(p.deliveryTo, "https://example.com/hook");
  assert.equal(p.suppressEmpty, true);
  assert.equal(p.enabled, true);
  assert.equal("id" in p, false, "a new job gets its id from the server");
});

test("editing a job keeps its id, and the dialog never offers a config path as a choice", async () => {
  await click("cron-edit-j1");
  assert.equal(text(byId("modal-title")), "Edit job: morning-brief");
  assert.equal(byId("cron-f-name").value, "morning-brief");
  assert.equal(byId("cron-f-schedule").value, "0 9 * * 1-5");
  const delivery = menuLabels("cron-f-delivery", dialog());
  assert.ok(delivery.every((l) => !l.includes("cron.")), "no config paths in a label");
  // The placeholder and the "configured default" choice are the same value; the
  // store must not carry both, or a read-out prints the entry twice.
  assert.equal(opts("cron-f-delivery").filter((o) => o.value === "").length, 1, "one empty delivery choice, not two");
  await tap(confirmBtn());
  assert.equal(calls("cron.upsert")[0].params.id, "j1");
});

test("the IMAP account dialog writes leaves only, keeps a blank password and warns about an impossible floor", async () => {
  await click("imap-add");
  byId("imap-f-name").value = "second";
  byId("imap-f-host").value = "imap.example.org";
  byId("imap-f-user").value = "bot@example.org";
  byId("imap-f-poll").value = "60";
  await tap(confirmBtn());
  const paths = setPaths();
  assert.ok(!paths.includes("imap.accounts.second"), "never the whole object");
  assert.ok(paths.every((p) => p.startsWith("imap.accounts.second.")), "leaf writes under the account");
  assert.ok(!paths.includes("imap.accounts.second.password"), "a blank password is not a write");
  assert.deepEqual(setValue("imap.accounts.second.watch"), { mode: "auto", pollSeconds: 60 });
  assert.deepEqual(setValue("imap.accounts.second.allowedSenders"), []);

  await open();
  await click("imap-add");
  const floor = menuLabels("imap-f-authmin", dialog());
  assert.match(floor[2], /asserted — needs a DMARC verifier/);
  assert.match(floor[3], /verified — needs a DMARC verifier/);
  assert.ok(dialog().querySelector(".hint.is-warn").hasAttribute("hidden"), "no warning for a floor that works");
  await pick("imap-f-authmin", "verified", dialog());
  assert.ok(!dialog().querySelector(".hint.is-warn").hasAttribute("hidden"), "the floor that cannot work warns in place");
  assert.match(text(dialog().querySelector(".hint.is-warn")), /refuses to start/);
});

test("the IMAP account dialog refuses a dotted name and a port that is not a port", async () => {
  await click("imap-add");
  byId("imap-f-name").value = "work.two";
  byId("imap-f-host").value = "imap.example.com";
  byId("imap-f-port").value = "993";
  await tap(confirmBtn());
  assert.equal(sets().length, 0, "a dot would nest a config key");
  assert.match(text(dialog().querySelector(".hint--err")), /may not contain dots/);

  byId("imap-f-name").value = "two";
  byId("imap-f-port").value = "99999";
  await tap(confirmBtn());
  assert.equal(sets().length, 0);
  assert.match(text(dialog().querySelector(".hint--err")), /65535/);
  assert.ok(focused.includes(byId("imap-f-port")), "focus reaches the port");
});

test("a failed state read says unknown, and everything below still saves", async () => {
  await open({ failState: "socket closed" });
  // The job list still arrived, so the cron card can tell the truth; the two
  // cards whose only source is the runtime state say so.
  assert.equal(tag(".auto-cron"), "on");
  assert.equal(tag(".auto-heartbeat"), "unknown");
  assert.match(note(".auto-heartbeat"), /socket closed/);
  assert.equal(tag(".auto-imap"), "on", "the switch is config, which was readable");
  assert.match(note(".auto-imap"), /reading without error/);
  await type("queue-cap", "3");
  await click("queue-save");
  assert.equal(setValue("messages.queue.cap"), 3, "settings still save without a runtime state");
});

test("the dream sweep is not edited twice: one pointer to Memory, no second editor", async () => {
  assert.equal($$(".auto-dreaming").length, 0);
  assert.equal(byId("dreaming-enabled"), null);
  assert.equal(byId("dreaming-schedule"), null);
  assert.equal(byId("dreaming-save"), null);
  const pointer = $(".auto-pointer");
  assert.ok(pointer, "the page ends with the pointer");
  assert.match(text(pointer), /dream sweep.*on the Memory tab/);
  await click("auto-open-memory");
  assert.equal(location.hash, "#/settings/memory");
});

test("the page contains no third-party copy, no config paths and no raw keys", async () => {
  const seen = [text(root)];
  for (const opener of ["cron-new", "imap-add", "hook-map-add"]) {
    await click(opener);
    seen.push(text(dialog()), text(dialogFoot()));
    await cancelDialog();
  }
  const copy = seen.join(" \u0000 ");
  assert.ok(!/their\b/i.test(copy), "no reference to another project's rules");
  assert.ok(!/src\/|\.ts\b/.test(copy), "no repo paths");
  assert.ok(!/cron\.delivery|messages\.queue|agents\.defaults|imap\.accounts/.test(copy), "no config paths");
  for (const key of ["lightContext", "isolatedSession", "allowRequestSessionKey", "passwordEnv", "debounceMs", "byChannel", "suppressEmpty"]) {
    assert.ok(!copy.includes(key), `no raw key ${key}`);
  }
  assert.ok(!/\(\d+\)s\b/.test(copy), "no parenthetical plurals");
  assert.ok(!/\d{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d{2}:\d{2}/.test(copy), "no timestamps to the second");
});

test("no colour is chosen from TypeScript and no native confirm is used on this page", () => {
  assert.ok(!/style\s*:/.test(region), "no inline style attribute in the page code");
  assert.ok(!/window\.confirm|confirm\(/.test(region), "deletes go through modal({ danger: true })");
  assert.ok(!/class: "in"/.test(region), "no native select class");
  assert.ok(/modal\(\{/.test(region), "the danger dialogs are the app's own");
  assert.ok(/danger: true/.test(region));
  assert.match(css, /\.settings \.row__value\.is-warn \{ color: var\(--warn\); \}/);
  assert.match(css, /\.settings \.cron-job__act \{/);
  assert.ok(!css.includes(".cron-job__toggle.is-on"), "state lives in a tag now, not in the button's colour");
  assert.match(css, /\.modal__sec \{ margin-top: 18px; \}/, "grouped dialog fields get their own rhythm");
});
