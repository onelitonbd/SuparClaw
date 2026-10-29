// Settings → Tools → Media understanding: what handles an attachment, and what
// a limit of 0 actually means.
//
// The card used to be fourteen controls over three sub-objects, written in three
// separate config.set calls, every number clamped (`Math.max(0, Number(v) || default)`),
// `preferredModel` free text that could match nothing, a checkbox labelled "Send ALL
// attachments" that really means "up to 10 images", and an echo-format field that is
// only read when the echo is on. It also never said where extracted text comes from.
//
// This drives the real page and asserts the parts someone has to be able to trust.

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

const MODELS = [
  { type: "provider", provider: "openai", model: "gpt-4o-mini", capabilities: ["image"] },
  { type: "cli", command: "whisper-cli", args: ["-f", "{{AttachmentPath}}"], capabilities: ["audio"] },
  { type: "cli", command: "broken", args: [], capabilities: ["pdf"] },
];

const CONFIG = {
  agents: { defaults: {} },
  gateway: {},
  tools: {
    media: {
      concurrency: 2,
      models: MODELS,
      image: {
        enabled: true,
        preferredModel: "",
        prompt: "Describe the image for a blind reader.",
        maxChars: 500,
        maxBytes: 10485760,
        timeoutSeconds: 60,
        attachments_all: false,
      },
      audio: {
        enabled: true,
        preferredModel: "hand/written",
        maxBytes: 20971520,
        timeoutSeconds: 45,
        language: "en",
        echoTranscript: false,
        echoFormat: "",
      },
      pdf: { enabled: true, maxBytes: 10485760, maxChars: 4000, timeoutSeconds: 30 },
    },
  },
};

const DEFAULTS = {
  image: { maxBytes: 10485760, maxChars: 500, timeoutSeconds: 60 },
  audio: { maxBytes: 20971520, maxChars: null, timeoutSeconds: 60 },
  pdf: { maxBytes: 10485760, maxChars: 4000, timeoutSeconds: 60 },
};

const RT = {
  defaults: DEFAULTS,
  models: [
    { index: 0, kind: "provider", label: "openai/gpt-4o-mini", capabilities: ["image"], valid: true },
    { index: 1, kind: "cli", label: "cli:whisper-cli", capabilities: ["audio"], valid: true },
    { index: 2, kind: "cli", label: "cli:broken", capabilities: ["pdf"], valid: false },
  ],
};

const outDir = mkdtempSync(join(TMP, "sc-ui-media-"));
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
    if (method === "tools.list") return { tools: [] };
    if (method === "skills.list") return { skills: [] };
    if (method === "models.plugins") return { plugins: [] };
    if (method === "codeMode.get") return { enabled: "auto", engaged: false, catalog: [], preferred: [] };
    if (method === "web.search.get") return { providers: [], provider: "", enabled: false };
    if (method === "media.get") {
      if (globalThis.__GW_FAIL_MEDIA) throw new Error(globalThis.__GW_FAIL_MEDIA);
      return globalThis.__RT ?? ${JSON.stringify(RT)};
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
const noteText = () => $(".media-card .setfoot__note")?.textContent ?? "";
const tag = () => $(".media-card .setcard__status .settings__tag").textContent;
const statusNote = () => $(".media-card .setcard__status-note").textContent;
const opts = (id) => [...byId(id).querySelectorAll("option")];
const selValue = (id) => (opts(id).find((o) => o.selected) ?? opts(id)[0])?.value ?? "";
const pick = async (id, label) => {
  fire(byId(`${id}-btn`), "click");
  await settle();
  const opt = $$(".dd__menu:not([hidden]) .dd__opt").find((o) => (o.textContent ?? "").replace("✓", "").trim().startsWith(label));
  assert.ok(opt, `menu for ${id} offers "${label}"`);
  fire(opt, "click");
  await settle();
};
const menuLabels = (id) => {
  fire(byId(`${id}-btn`), "click");
  const labels = $$(".dd__menu:not([hidden]) .dd__opt").map((o) => (o.textContent ?? "").replace("✓", "").trim());
  fire(byId(`${id}-btn`), "click");
  return labels;
};
const type = async (id, value) => {
  const node = byId(id);
  node.value = value;
  fire(node, "input");
  await settle();
};
const echoOf = (label) => {
  const field = $$(".media-card .setfield").find((f) => f.querySelector(".lbl")?.textContent === label);
  return field?.querySelector(".setcard__echo")?.textContent ?? "";
};
const toggle = async (id, on) => {
  const cb = byId(id);
  cb.checked = on;
  fire(cb, "change");
  await settle();
};

const open = async ({ cfg, rt, failMedia, failSet } = {}) => {
  globalThis.__GW_CALLS = [];
  globalThis.__CFG = JSON.parse(JSON.stringify(cfg ?? CONFIG));
  globalThis.__RT = rt ?? null;
  globalThis.__GW_FAIL_MEDIA = failMedia ?? "";
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
  assert.equal($$(".media-card").length, 1);
  assert.equal($$("#media-save").length, 1);
  assert.equal(sets().length, 0);
});

test("saving writes the whole media block once, and keeps what it does not render", async () => {
  await type("md-img-chars", "800");
  await type("md-conc", "3");
  await click("media-save");
  const writes = sets();
  assert.equal(writes.length, 1, "one write, not three");
  assert.equal(writes[0].params.path, "tools.media");
  const v = writes[0].params.value;
  assert.equal(v.concurrency, 3);
  assert.equal(v.image.maxChars, 800);
  assert.equal(v.image.prompt, "Describe the image for a blind reader.", "the prompt this page does not edit is preserved");
  assert.equal(v.audio.echoFormat, "", "blank stays blank so the shipped default can reach it");
  assert.equal(v.pdf.timeoutSeconds, 30);
  assert.equal(v.models.length, 3, "the media ladder is not touched by a capability save");
  assert.equal(noteText(), "", "a landed save clears the marker");
});

test("0 means the runtime default, and the echo says which", async () => {
  assert.equal(echoOf("Max description chars"), "500 chars");
  await type("md-img-chars", "0");
  assert.equal(echoOf("Max description chars"), "default (500 chars)");
  await type("md-img-bytes", "0");
  assert.equal(echoOf("Max image bytes"), "default (10 MB)");
  await click("media-save");
  const v = sets().at(-1).params.value;
  assert.equal(v.image.maxChars, 0, "0 is written as 0, never materialised into 500");
  assert.equal(v.image.maxBytes, 0);
});

test("bad numbers are refused together, and the draft is kept", async () => {
  await type("md-img-chars", "");
  await type("md-img-bytes", "-5");
  await type("md-img-timeout", "12.5");
  await type("md-conc", "0");
  await click("media-save");
  assert.equal(sets().length, 0, "nothing written");
  const problem = $(".media-card .hint--err");
  assert.equal(problem.hasAttribute("hidden"), false);
  assert.match(problem.textContent, /image max chars needs a number/);
  assert.match(problem.textContent, /image max bytes must be a whole number from 0/);
  assert.match(problem.textContent, /image timeout must be a whole number from 0/);
  assert.match(problem.textContent, /attachments at once must be a whole number from 1/);
  for (const id of ["md-img-chars", "md-img-bytes", "md-img-timeout", "md-conc"]) {
    assert.equal(byId(id).getAttribute("aria-invalid"), "true", `${id} is marked`);
  }
  // The first field to fix is the first one in the page's own reading order.
  assert.ok(focused.includes(byId("md-conc")), "focus lands on the first field to fix");
  assert.equal(noteText(), "Unsaved changes");
});

test("attachments mode is a segment, not an 'ALL' checkbox, and it maps to attachments_all", async () => {
  assert.equal(byId("md-img-first").getAttribute("aria-pressed"), "true");
  assert.equal(byId("md-img-all").getAttribute("aria-pressed"), "false");
  assert.match(byId("md-img-all").getAttribute("title"), /capped at 10/);
  await click("md-img-all");
  assert.equal(byId("md-img-all").getAttribute("aria-pressed"), "true");
  await click("media-save");
  assert.equal(sets().at(-1).params.value.image.attachments_all, true);
});

test("the echo format is inert until the echo is on, and then it must carry {transcript}", async () => {
  assert.equal(byId("md-aud-fmt").disabled, true, "disabled while the echo is off");
  assert.ok(byId("md-aud-fmt").closest(".setfield").classList.contains("is-off"));
  // Off: a nonsense format must not block the save, because the runtime never reads it.
  await type("md-aud-fmt", "no placeholder here");
  await click("media-save");
  assert.equal(sets().length, 1, "saved while the echo is off");

  await toggle("md-aud-echo", true);
  assert.equal(byId("md-aud-fmt").disabled, false);
  await type("md-aud-fmt", "no placeholder here");
  await click("media-save");
  const problem = $(".media-card .hint--err");
  assert.equal(problem.hasAttribute("hidden"), false);
  assert.match(problem.textContent, /the echo format needs \{transcript\}/);
  assert.equal(byId("md-aud-fmt").getAttribute("aria-invalid"), "true");
});

test("a preferred model is picked from this app's menu, and a stored value outside the ladder is kept", () => {
  // The menu is the truth: it is what the reader opens.
  assert.deepEqual(menuLabels("md-img-model"), ["auto (first that works)", "openai/gpt-4o-mini"]);
  assert.deepEqual(menuLabels("md-aud-model"), [
    "auto (first that works)", "cli:whisper-cli", "hand/written — not in the ladder",
  ]);
  assert.equal(selValue("md-aud-model"), "hand/written", "the stored value is still what is selected");
  assert.match($("#md-aud-model-btn .dd__val").textContent, /hand\/written/);
});

test("the model menus are the app's dropdowns, not platform selects", () => {
  for (const id of ["md-img-model", "md-aud-model"]) {
    assert.ok(byId(id).classList.contains("dd__store"), `${id} is a hidden store`);
    assert.equal(byId(`${id}-btn`).getAttribute("aria-haspopup"), "listbox");
    assert.equal(byId(`${id}-btn`).getAttribute("aria-expanded"), "false");
    assert.match(byId(`${id}-btn`).getAttribute("aria-label"), /^Preferred (image|audio) model: /);
  }
});

test("picking auto writes an empty preference, not a word", async () => {
  await pick("md-img-model", "openai/gpt-4o-mini");
  await click("media-save");
  assert.equal(sets().at(-1).params.value.image.preferredModel, "openai/gpt-4o-mini");
  await pick("md-img-model", "auto");
  await click("media-save");
  assert.equal(sets().at(-1).params.value.image.preferredModel, "");
});

test("each capability says what handles it, and a broken ladder entry is called out", () => {
  const text = $(".media-card").textContent;
  assert.match(text, /Handled by: tries openai\/gpt-4o-mini/);
  assert.match(text, /Handled by: tries cli:whisper-cli/);
  assert.match(text, /tries cli:broken — incomplete entries are skipped/);
});

test("with no media models the auto lanes are stated instead of implied", async () => {
  await open({ rt: { defaults: DEFAULTS, models: [] } });
  const text = $(".media-card").textContent;
  assert.match(text, /the model that answers also describes the image/);
  assert.match(text, /a provider key first \(groq, openai, xai, deepgram, google, elevenlabs, mistral\)/);
  assert.match(text, /PDF text is extracted locally/);
});

test("the status line counts capabilities and follows the draft", async () => {
  assert.equal(tag(), "3 of 3 on");
  assert.match(statusNote(), /turned into text before the model sees them/);
  await toggle("md-img-on", false);
  assert.equal(tag(), "2 of 3 on");
  assert.match(statusNote(), /Not processed: images/);
  assert.equal($$(".media-card .setsec__count")[1].textContent, "off", "the group count follows too");
  await toggle("md-aud-on", false);
  await toggle("md-pdf-on", false);
  assert.equal(tag(), "0 of 3 on");
  assert.match(statusNote(), /reaches the model as a file path only/);
  assert.match($(".media-card .setcard__status .settings__tag").getAttribute("class"), /is-warn/);
});

test("capability toggles are written as booleans", async () => {
  await toggle("md-pdf-on", false);
  await click("media-save");
  const v = sets().at(-1).params.value;
  assert.equal(v.pdf.enabled, false);
  assert.equal(v.image.enabled, true);
});

test("a select or toggle marks the draft, and the marker clears on save", async () => {
  assert.equal(noteText(), "");
  await pick("md-aud-model", "cli:whisper-cli");
  assert.equal(noteText(), "Unsaved changes");
  await click("media-save");
  assert.equal(noteText(), "");
});

test("a rejected save keeps the draft and says why", async () => {
  await open({ failSet: "config is read-only" });
  await type("md-img-chars", "900");
  await click("media-save");
  const problem = $(".media-card .hint--err");
  assert.equal(problem.hasAttribute("hidden"), false);
  assert.match(problem.textContent, /not saved — config is read-only/);
  assert.equal(byId("md-img-chars").value, "900", "the draft survived");
  assert.equal(byId("media-save").disabled, false);
});

test("a failing media.get costs the defaults, not the section", async () => {
  await open({ failMedia: "socket closed" });
  assert.match($(".media-card").textContent, /Defaults and the media ladder could not be read/);
  assert.equal(echoOf("Max description chars"), "500 chars", "the stored value still reads");
  await type("md-img-chars", "0");
  assert.equal(echoOf("Max description chars"), "default", "no invented number");
  assert.equal(byId("md-img-model").tagName, "SELECT", "still a select of the ladder that exists");
  await click("media-save");
  assert.equal(sets().length, 1, "and it still saves");
});
