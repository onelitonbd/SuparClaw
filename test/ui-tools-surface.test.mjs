// Settings → Tools: the surface contract.
//
// The per-card suites check behaviour. This one checks the things that made the
// rendered page look wrong and that no single card could be blamed for:
//
//   · four native <select>s (platform widgets) instead of this app's own menu
//   · label and hint sharing one line ("Never auto-allow inline evalnode -e, …")
//   · a bare span.cap label glued to an inline-flex segment ("Sandboxoff | strict")
//   · stacked fields with no space between them
//   · a number field stretching the card while its unit wrapped away
//   · the inventory's description in a monospace URL class
//
// DOM facts where they can be asserted, CSS rules where the fact is layout.

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
  tools: {
    exec: { enabled: true, approvals: true, mode: "ask", askFallback: "deny", unattended: "deny",
      strictInlineEval: false, safeBins: ["head"], safeBinTrustedDirs: ["/bin"], timeoutMs: 600000,
      sandbox: "off", sandboxProot: false },
    codeMode: { enabled: "auto", executor: "node", timeoutMs: 10000, maxCodeChars: 32768,
      maxOutputBytes: 65536, maxPendingToolCalls: 16, directOnly: [] },
    media: { concurrency: 2, models: [],
      image: { enabled: true, maxChars: 500, maxBytes: 10485760, timeoutSeconds: 60, attachments_all: false },
      audio: { enabled: true, maxBytes: 20971520, timeoutSeconds: 60, echoTranscript: false, echoFormat: "" },
      pdf: { enabled: true, maxBytes: 10485760, maxChars: 4000, timeoutSeconds: 60 } },
    web: { search: { enabled: true, provider: "", maxResults: 5, cacheTtlMinutes: 15,
      brave: { apiKey: "", baseUrl: "" }, perplexity: { apiKey: "", baseUrl: "" },
      tavily: { apiKey: "", baseUrl: "" }, kimi: { apiKey: "", baseUrl: "" },
      searxng: { baseUrl: "" }, duckduckgo: { baseUrl: "" } } },
  },
};

const outDir = mkdtempSync(join(TMP, "sc-ui-surface-"));
const stub = join(outDir, "rpc-stub.mjs");
writeFileSync(stub, `
export const gateway = {
  state: "online",
  async request(method) {
    if (method === "config.get") return { config: ${JSON.stringify(CONFIG)}, path: "/home/u/.suparclaw/openclaw.json5" };
    if (method === "models.list") return { models: [], configured: [], details: {}, auth: [] };
    if (method === "tools.list") return { tools: [
      { name: "fs_read", description: "Read a UTF-8 text file from the workspace. Paths are workspace-relative.", needsApproval: false },
      { name: "exec", description: "Run a shell command.", needsApproval: true },
    ] };
    if (method === "skills.list") return { skills: [] };
    if (method === "models.plugins") return { plugins: [] };
    if (method === "approvals.get") return { mode: "ask", entries: [] };
    if (method === "codeMode.get") return { enabled: "auto", engaged: true, model: "openai/gpt-5.6",
      preferredMatch: true, preferred: ["gpt-5.6"], preferredMatched: ["gpt-5.6"],
      executor: "node", executorBundled: true, catalog: ["fs_read"] };
    if (method === "media.get") return { defaults: {
      image: { maxBytes: 10485760, maxChars: 500, timeoutSeconds: 60 },
      audio: { maxBytes: 20971520, maxChars: null, timeoutSeconds: 60 },
      pdf: { maxBytes: 10485760, maxChars: 4000, timeoutSeconds: 60 } },
      models: [{ index: 0, kind: "provider", label: "openai/gpt-4o-mini", capabilities: ["image"], valid: true }] };
    if (method === "web.search.get") return { enabled: true, provider: "auto", maxResults: 5, cacheTtlMinutes: 15,
      effective: "brave", autoCandidates: ["brave"],
      providers: [{ id: "brave", ready: true, keyFree: false, hasKey: true, configBaseUrl: "" }],
      keyMasks: { brave: "", perplexity: "", tavily: "", kimi: "" } };
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
  <div id="modal-overlay" hidden><div id="modal"></div></div>
</body></html>`);
globalThis.document = page.document;
globalThis.window = page.window;
globalThis.HTMLElement = page.HTMLElement;
globalThis.Event = page.window.Event;
globalThis.location = { hash: "#/settings/tools", reload() {} };

const { Settings } = await import(pathToFileURL(join(outDir, "settings.mjs")).href);
const root = document.getElementById("settings-body");
const settings = new Settings(root, () => {});
settings.setHash("#/settings/tools");
await settings.render();
await new Promise((r) => setTimeout(r, 20));

const $ = (sel) => root.querySelector(sel);
const $$ = (sel) => [...root.querySelectorAll(sel)];
const text = (n) => (n?.textContent ?? "").replace(/\s+/g, " ").trim();

test("every dropdown on the page is this app's menu, not a platform select", () => {
  const selects = $$("select");
  assert.ok(selects.length >= 4, "the four choice fields are still here");
  for (const sel of selects) {
    assert.ok(sel.classList.contains("dd__store"), `#${sel.getAttribute("id")} is a hidden store`);
    assert.equal(sel.hasAttribute("hidden"), true, "the store is not focusable or visible");
    const dd = sel.closest(".dd");
    assert.ok(dd, "the store lives inside a .dd");
    const btn = dd.querySelector(".dd__btn");
    assert.ok(btn, "the .dd has a button");
    assert.equal(btn.getAttribute("aria-haspopup"), "listbox");
    assert.equal(btn.getAttribute("aria-expanded"), "false");
    assert.ok(btn.getAttribute("aria-label"), "the button names itself");
    assert.ok(dd.querySelector(".dd__menu[role='listbox']"), "the menu is a listbox");
  }
});

test("the four former native selects kept their ids and their values", () => {
  for (const id of ["exec-ask-fallback", "exec-unattended", "md-img-model", "md-aud-model"]) {
    assert.ok(document.getElementById(id), `${id} is still the value store`);
    assert.ok(document.getElementById(`${id}-btn`), `${id} has a menu button`);
    assert.ok(document.getElementById(`${id}-menu`), `${id} has a menu`);
  }
  assert.equal($("#exec-ask-fallback-btn .dd__val").textContent, "refuse it — and say so (default)");
  assert.equal($("#md-aud-model-btn .dd__val").textContent, "auto (first that works)");
});

test("no dropdown label is a for-label pointing at the hidden store", () => {
  for (const sel of $$("select.dd__store")) {
    const id = sel.getAttribute("id");
    assert.equal($(`label[for="${id}"]`), null, `#${id} must not be labelled by a for= on a hidden control`);
    const field = sel.closest(".setfield");
    assert.ok(field, "the dropdown sits in a field");
    assert.ok(field.querySelector(":scope > .lbl"), "the field still has a visible label");
  }
});

test("every field starts with a label, never a bare heading span", () => {
  const fields = $$(".setfield");
  assert.ok(fields.length >= 15, "the page has fields");
  for (const field of fields) {
    const first = field.firstElementChild;
    const ok = first?.tagName === "LABEL" || first?.classList?.contains("lbl");
    assert.ok(ok, `field "${text(first) || "(unlabelled)"}" starts with a label`);
    assert.ok(!first?.classList?.contains("cap"), "a field label is never a section heading");
  }
});

test("a row's label sits above its hint, and the CSS makes that true", () => {
  const rows = $$(".row__main");
  assert.ok(rows.length >= 5, "the page has label+hint rows");
  for (const main of rows) {
    const kids = [...main.children];
    assert.equal(kids.length, 2, "a row main is a label and its hint");
    assert.ok(kids[0].classList.contains("row__label"), "the label comes first");
    assert.ok(kids[1].classList.contains("hint"), "the hint comes second");
  }
  // Two inline boxes in a block ran together; the fix is the column.
  assert.match(css, /\.settings \.row__main \{[^}]*display: flex;[^}]*flex-direction: column;/s);
  assert.match(css, /\.settings \.row__main > \.hint \{ margin-top: 0; \}/);
});

test("stacked fields have rhythm, and grids do not double it", () => {
  assert.match(css, /\.settings \.setfield \{[^}]*margin-top: 14px;/s);
  assert.match(css, /\.settings \.setfield:first-child \{ margin-top: 0; \}/);
  // …and the first field under a section head adds nothing to the head's own gap.
  assert.match(css, /\.settings \.setsec__head \+ \.setfield \{ margin-top: 0; \}/);
  assert.match(css, /\.settings \.setgrid > \.setfield \{ margin-top: 0; \}/);
  assert.match(css, /\.settings \.setfield\.is-off \{ opacity: \.55; \}/);
  // Media's echo-format field is the one that relies on that inert style.
  assert.ok($("#md-aud-fmt").closest(".setfield").classList.contains("is-off"));
});

test("a number and its unit share a line, and the field is sized to the digits", () => {
  const lines = $$(".setline");
  assert.ok(lines.length >= 15, "every numeric field uses the value line");
  for (const line of lines) {
    assert.equal(line.children.length, 2, "field + echo");
    assert.ok(line.querySelector(".inp"), "the field");
    assert.ok(line.querySelector(".setcard__echo"), "the echo");
  }
  assert.match(css, /\.settings \.setline > \.inp \{[^}]*width: 11ch;[^}]*text-align: right;/s);
  assert.match(css, /\.settings \.setline > \.setcard__echo \{ white-space: nowrap; \}/);
});

test("text fields in an inline row share the row instead of claiming it", () => {
  assert.match(css, /\.settings \.settings__inline > \.inp \{[^}]*flex: 1 1 220px;[^}]*width: auto;/s);
  // The grant form is the reason: pattern, argv and the button on one line.
  const add = $("#exec-grant-pattern").closest(".settings__inline");
  assert.equal([...add.children].filter((c) => c.tagName === "INPUT").length, 2);
  assert.ok(add.querySelector("button"));
});

test("a commit footer holds only commit material", () => {
  const footers = $$(".setfoot");
  assert.ok(footers.length >= 5, "four saves and the read-only inventory");
  for (const foot of footers) {
    assert.ok(foot.children.length <= 3, `footer has ${foot.children.length} children`);
    const last = foot.lastElementChild;
    const readOnly = last?.classList?.contains("setfoot__note");
    assert.ok(readOnly || last?.classList?.contains("btn"), "the footer ends with the save (or a note, when nothing saves)");
  }
  // The search test acts on the saved config, so it lives with the provider.
  assert.match($(".web-search .setsec").textContent, /Test saved settings/);
  assert.doesNotMatch($(".web-search .setfoot").textContent, /Test saved settings/);
});

test("tool descriptions are prose, not a URL", () => {
  const desc = $(".tools-inventory .tool__desc");
  assert.ok(desc, "the inventory description uses its own class");
  assert.match(desc.textContent, /Read a UTF-8 text file/);
  assert.equal($(".tools-inventory .prov__url"), null, "not the providers card's mono class");
  assert.match(css, /\.settings \.tool__desc \{[^}]*font-size: 12\.5px;/s);
});
