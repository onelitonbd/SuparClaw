// Settings → Tools → Code mode: what the model sees, when, and what it costs.
//
// The card used to be seven controls over one config block: seven separate leaf
// writes, four silent clamps, "quickjs" offered as a peer of node even though this
// build stops every cell that asks for it, "auto (preferred models only)" naming a
// model list nobody could see, direct-only names typed against a catalog the page
// already had, and no statement of the one thing that matters — that when code mode
// engages, the model's direct surface collapses to exec + wait.
//
// This drives the real page and asserts the parts a reader has to be able to trust:
// whether it is running right now and why, one merged write, refusal instead of
// clamping, chips instead of free text, and that turning it on does not read as a
// way around the exec policy above it.

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
    codeMode: {
      enabled: "auto",
      executor: "node",
      timeoutMs: 10000,
      maxCodeChars: 32768,
      maxOutputBytes: 65536,
      maxPendingToolCalls: 16,
      directOnly: ["ghost"],
      someFutureKnob: 3,
    },
  },
};

// What the gateway would answer for a preferred model with a healthy build.
const CM = {
  enabled: "auto",
  engaged: true,
  model: "openai/gpt-5.6",
  preferredMatch: true,
  preferred: ["gpt-5.6", "claude sonnet 5", "kimi k3"],
  preferredMatched: ["gpt-5.6"],
  executor: "node",
  executorBundled: true,
  catalog: ["read", "write", "list", "grep"],
};

const outDir = mkdtempSync(join(TMP, "sc-ui-codemode-"));
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
      let node = next;
      const parts = String(params.path).split(".");
      for (const p of parts.slice(0, -1)) node = (node[p] ||= {});
      if (params.value === null) delete node[parts.at(-1)];
      else node[parts.at(-1)] = params.value;
      globalThis.__CFG = next;
      return { ok: true };
    }
    if (method === "models.list") return { models: [], configured: [], details: {}, auth: [] };
    if (method === "tools.list") {
      return { tools: ${JSON.stringify(CM.catalog)}.map((name) => ({ name, description: name, needsApproval: false }))
        .concat([{ name: "exec", description: "shell", needsApproval: true }]) };
    }
    if (method === "skills.list") return { skills: [] };
    if (method === "models.plugins") return { plugins: [] };
    if (method === "web.search.get") return { providers: [], provider: "", enabled: false };
    if (method === "approvals.get") return { mode: "ask", entries: [] };
    if (method === "codeMode.get") {
      if (globalThis.__GW_FAIL_CM) throw new Error(globalThis.__GW_FAIL_CM);
      return { ...${JSON.stringify(CM)}, ...(globalThis.__CM ?? {}) };
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
globalThis.location = { hash: "#/settings/tools", reload() {} };

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
const noteText = () => $(".code-mode-card .setfoot__note")?.textContent ?? "";
const tag = () => $(".code-mode-card .setcard__status .settings__tag").textContent;
const statusNote = () => $(".code-mode-card .setcard__status-note").textContent;
const type = async (id, value) => {
  const node = byId(id);
  node.value = value;
  fire(node, "input");
  await settle();
};
const choose = async (id) => {
  const radio = byId(id);
  for (const other of $$('[name="cm-mode"]')) other.checked = false;
  radio.checked = true;
  fire(radio, "change");
  await settle();
};

const open = async ({ cfg, cm, failCm, failSet } = {}) => {
  globalThis.__GW_CALLS = [];
  globalThis.__CFG = JSON.parse(JSON.stringify(cfg ?? CONFIG));
  globalThis.__CM = cm ?? null;
  globalThis.__GW_FAIL_CM = failCm ?? "";
  globalThis.__GW_FAIL_SET = failSet ?? "";
  document.querySelectorAll("#toasts .toast").forEach((t) => t.remove());
  root.innerHTML = "";
  focused.length = 0;
  const settings = new Settings(root, () => {});
  settings.setHash("#/settings/tools");
  await settings.render();
  await settle();
};

test.beforeEach(async () => { await open(); });

test("one card, one save, and rendering writes nothing", () => {
  assert.equal($$(".code-mode-card").length, 1, "a single code-mode card");
  assert.equal($$("#codemode-save").length, 1);
  assert.equal(sets().length, 0);
  for (const id of ["cm-timeout", "cm-chars", "cm-out", "cm-pend"]) {
    assert.equal($$(`#${id}`).length, 1, `${id} appears once`);
  }
});

test("the status line says whether it is running, and how many tools it moves", async () => {
  assert.equal(tag(), "engaged now");
  assert.match(statusNote(), /only exec and wait/);
  // "ghost" is stored but is not a real tool, so it moves nothing.
  assert.match(statusNote(), /4 tools become async globals/, "the count comes from the catalog");
  // …and the sentence tracks the draft, so a chip changes it before saving.
  await click("cm-direct-write");
  assert.match(statusNote(), /3 tools become async globals/);
  await click("cm-direct-write");
});

test("auto with a model off the list says it is waiting, and names the model", async () => {
  await open({ cm: { engaged: false, preferredMatch: false, model: "ollama/qwen3:32b", preferredMatched: [] } });
  assert.equal(tag(), "on, waiting for a preferred model");
  assert.match(statusNote(), /ollama\/qwen3:32b is not one of them/);
});

test("a quickjs executor is shown as a switch-off, not a peer of node", async () => {
  const cfg = JSON.parse(JSON.stringify(CONFIG));
  cfg.tools.codeMode.executor = "quickjs";
  await open({ cfg, cm: { engaged: false, executor: "quickjs", executorBundled: false } });
  assert.equal(tag(), "off — executor missing");
  assert.match(statusNote(), /executor_unavailable/);
  const chip = byId("cm-executor-quickjs");
  assert.ok(chip.classList.contains("is-off"));
  assert.equal(chip.getAttribute("aria-pressed"), "true");
  assert.match(chip.getAttribute("title"), /Not bundled/);
});

test("off is a state the ladder can express, and the stored value stays text", async () => {
  await choose("cm-mode-off");
  assert.equal(tag(), "off");
  assert.match(statusNote(), /one at a time/);
  await click("codemode-save");
  assert.equal(sets().at(-1).params.value.enabled, "false", 'the wire value is the string "false"');
  await choose("cm-mode-on");
  await click("codemode-save");
  assert.equal(sets().at(-1).params.value.enabled, "true");
});

test("saving writes the whole block once, merged over what is stored", async () => {
  await choose("cm-mode-on");
  await type("cm-timeout", "30000");
  await type("cm-pend", "4");
  await click("cm-direct-write");
  await click("codemode-save");
  const writes = sets();
  assert.equal(writes.length, 1, "one write, not seven");
  assert.equal(writes[0].params.path, "tools.codeMode");
  const v = writes[0].params.value;
  assert.equal(v.enabled, "true");
  assert.equal(v.timeoutMs, 30000);
  assert.equal(v.maxPendingToolCalls, 4);
  assert.deepEqual([...v.directOnly].sort(), ["ghost", "write"], "chips add and remove individual names");
  assert.equal(v.someFutureKnob, 3, "a key this page does not render survives the save");
  assert.equal(noteText(), "", "a landed save clears the marker");
});

test("every bad number is refused in one message, and the draft is kept", async () => {
  await type("cm-timeout", "50");
  await type("cm-chars", "100");
  await type("cm-out", "10");
  await type("cm-pend", "999");
  await click("codemode-save");
  assert.equal(sets().length, 0, "nothing written");
  const problem = $(".code-mode-card .hint--err");
  assert.equal(problem.hasAttribute("hidden"), false);
  assert.match(problem.textContent, /timeout must be 100–60000/);
  assert.match(problem.textContent, /max code chars must be at least 1024/);
  assert.match(problem.textContent, /max output bytes must be 1024–10485760/);
  assert.match(problem.textContent, /max pending tool calls must be 1–128/);
  for (const id of ["cm-timeout", "cm-chars", "cm-out", "cm-pend"]) {
    assert.equal(byId(id).getAttribute("aria-invalid"), "true", `${id} is marked`);
  }
  assert.ok(focused.includes(byId("cm-timeout")), "focus lands on the first field to fix");
  assert.equal(noteText(), "Unsaved changes");
});

test("blank is invalid too — it used to mean the default, silently", async () => {
  await type("cm-timeout", "");
  await click("codemode-save");
  assert.equal(sets().length, 0);
  assert.match($(".code-mode-card .hint--err").textContent, /not blank/);
});

test("the numbers say what they mean in seconds and bytes", async () => {
  const echoes = () => $$(".code-mode-card .setcard__echo").map((e) => e.textContent);
  assert.deepEqual(echoes(), ["≈ 10 s", "32 KB", "64 KB", "calls"]);
  await type("cm-timeout", "1500");
  await type("cm-out", "2097152");
  assert.deepEqual(echoes(), ["≈ 1.5 s", "32 KB", "2 MB", "calls"]);
});

test("direct-only names are chips from the catalog, and an unknown stored name is labelled", () => {
  for (const name of ["read", "write", "list", "grep"]) {
    assert.ok(byId(`cm-direct-${name}`), `${name} offered`);
  }
  assert.equal(byId("cm-direct-exec"), null, "exec is always visible, so it is not offered");
  const ghost = byId("cm-direct-ghost");
  assert.ok(ghost, "the stored name is still shown");
  assert.ok(ghost.classList.contains("is-off"));
  assert.equal(ghost.getAttribute("aria-pressed"), "true");
  assert.match(ghost.getAttribute("title"), /not in this build's tool catalog/);
  assert.equal(byId("cm-direct-read").getAttribute("aria-pressed"), "false");
});

test("the family list marks the one your model is on", () => {
  const tags = $$(".code-mode-card .setcard__tags .settings__tag");
  assert.deepEqual(tags.map((t) => t.textContent), ["gpt-5.6", "claude sonnet 5", "kimi k3"]);
  assert.deepEqual(tags.map((t) => t.classList.contains("is-ok")), [true, false, false]);
});

test("code mode states that it does not bypass exec policy", () => {
  assert.match($(".code-mode-card").textContent, /still go through exec policy and approvals/);
});

test("a select change marks the draft, and the marker clears on save", async () => {
  assert.equal(noteText(), "");
  await choose("cm-mode-on");
  assert.equal(noteText(), "Unsaved changes");
  await click("codemode-save");
  assert.equal(noteText(), "");
});

test("a rejected save keeps the draft and says why", async () => {
  await open({ failSet: "config is read-only" });
  await choose("cm-mode-on");
  await click("codemode-save");
  const problem = $(".code-mode-card .hint--err");
  assert.equal(problem.hasAttribute("hidden"), false);
  assert.match(problem.textContent, /not saved — config is read-only/);
  assert.equal(byId("codemode-save").disabled, false);
  assert.ok(byId("cm-mode-on").checked, "the draft survived");
});

test("a failing codeMode.get costs the status line, not the section", async () => {
  await open({ failCm: "socket closed" });
  assert.equal(tag(), "unknown");
  assert.match($(".code-mode-card").textContent, /Engagement could not be read — socket closed/);
  // the catalog falls back to the page's own tools.list, minus exec
  assert.ok(byId("cm-direct-read"));
  assert.equal(byId("cm-direct-write").getAttribute("type"), "button");
  await choose("cm-mode-on");
  await click("codemode-save");
  assert.equal(sets().length, 1, "and it still saves");
});
