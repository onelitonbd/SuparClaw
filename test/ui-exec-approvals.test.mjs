// Settings → Tools → Exec & approvals: the section as an operator meets it.
//
// The section used to be two cards over one `tools.exec` block: eleven controls
// each writing its own leaf on change (eleven half-saves), the exec on/off
// switch living in one card while the policy that depends on it lived in the
// other, safe bins as free text where only six names do anything, a timeout box
// that silently clamped, and no grant ever shown a command or used twice.
//
// This drives the real page and asserts the parts that have to hold: one draft,
// one write, the mode ladder, refusal instead of clamping, and a grant list you
// can actually read and revoke. Task 55/57 removed the last two things that
// claimed a permission step existed: the legacy approvals switch and the
// sandbox controls. Both are asserted *absent* here, so neither can come back
// as a UI-only promise.

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

// A stored block with a knob this page does not render: saving must not drop it.
const CONFIG = {
  agents: { defaults: {} },
  gateway: {},
  tools: {
    exec: {
      enabled: true,
      approvals: true,
      mode: "ask",
      askFallback: "deny",
      unattended: "deny",
      strictInlineEval: false,
      safeBins: ["head", "cut", "rm"],
      safeBinTrustedDirs: ["/bin", "/usr/bin"],
      // Task 38: the shipped default is the 30-minute command cap.
      timeoutMs: 1800000,
      sandbox: "off",
      sandboxProot: false,
      someFutureKnob: 7,
    },
  },
};

const APPROVALS = {
  mode: "ask",
  entries: [
    {
      id: "g1",
      source: "allow-always",
      pattern: "/home/u/bin/render.sh",
      argvHash: "abc123",
      cwd: "/home/u/proj",
      lastUsedAt: Date.now() - 5 * 60_000,
      command: "render.sh --fast --out dist",
    },
    { id: "m1", pattern: "rg", argPattern: "^safe", addedAt: 1, lastUsedAt: 0, lastResolvedPath: "/usr/bin/rg" },
  ],
};

const outDir = mkdtempSync(join(TMP, "sc-ui-exec-"));
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
    if (method === "web.search.get") return { providers: [], provider: "", enabled: false };
    if (method === "approvals.get") {
      if (globalThis.__GW_FAIL_APPROVALS) throw new Error(globalThis.__GW_FAIL_APPROVALS);
      return JSON.parse(JSON.stringify(globalThis.__APPROVALS ?? ${JSON.stringify(APPROVALS)}));
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

// linkedom has no layout and no document.activeElement; watch focus() instead.
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
const calls = (method) => (globalThis.__GW_CALLS ?? []).filter((c) => c.method === method);
const sets = () => calls("config.set");
const noteText = () => $(".setfoot__note")?.textContent ?? "";
const opts = (sel) => [...sel.querySelectorAll("option")];
// linkedom does not implement HTMLSelectElement.value; both the page and these
// tests go through the options so the same code path is measured.
const selValue = (id) => (opts(byId(id)).find((o) => o.selected) ?? opts(byId(id))[0])?.value ?? "";
// The page's own menu: open the button, click the row whose label starts with
// the text. #dropdown keeps one menu open at a time, so the search is global.
const pick = async (id, label) => {
  fire(byId(`${id}-btn`), "click");
  await settle();
  const opt = $$(".dd__menu:not([hidden]) .dd__opt").find((o) => (o.textContent ?? "").trim().startsWith(label));
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

const open = async ({ cfg, approvals, failApprovals, failSet } = {}) => {
  globalThis.__GW_CALLS = [];
  globalThis.__CFG = JSON.parse(JSON.stringify(cfg ?? CONFIG));
  globalThis.__APPROVALS = JSON.parse(JSON.stringify(approvals ?? APPROVALS));
  globalThis.__GW_FAIL_APPROVALS = failApprovals ?? "";
  globalThis.__GW_FAIL_SET = failSet ?? "";
  document.querySelectorAll("#toasts .toast").forEach((t) => t.remove());
  root.innerHTML = "";
  focused.length = 0;
  const settings = new Settings(root, () => {});
  settings.setHash("#/settings/tools");
  await settings.render();
  await settle();
};

const tap = async (node) => { fire(node, "click"); await settle(); };
const click = async (id) => { await tap(byId(id)); };
// linkedom has no activation behaviour on form controls: model the browser's
// part (the radio group takes the check) and then fire the event it would fire.
const choose = async (id) => {
  const radio = byId(id);
  for (const other of $$('[name="exec-mode"]')) other.checked = false;
  radio.checked = true;
  fire(radio, "change");
  await settle();
};
const type = async (id, value) => {
  const node = byId(id);
  node.value = value;
  fire(node, "input");
  await settle();
};

test.beforeEach(async () => { await open(); });

test("one section, one save: the old two-card split is gone", () => {
  assert.equal($$(".exec-card").length, 1, "a single exec card");
  assert.equal($$("#exec-policy-save").length, 1, "one save button");
  // Every control that writes policy is on the same draft, so none of them
  // writes config on its own.
  const ids = ["exec-enabled", "exec-ask-fallback", "exec-unattended",
    "exec-timeout", "exec-strict-inline"];
  for (const id of ids) assert.equal($$(`#${id}`).length, 1, `${id} appears exactly once`);
  assert.equal(sets().length, 0, "rendering writes nothing");
});

test("the mode ladder is four labelled radios, one of them checked", () => {
  const group = $(".setcard__modes");
  assert.equal(group.getAttribute("role"), "radiogroup");
  assert.equal(group.getAttribute("aria-label"), "Exec mode");
  const ids = ["deny", "allowlist", "ask", "full"];
  for (const m of ids) assert.equal(byId(`exec-mode-${m}`).getAttribute("type"), "radio", `${m} is a radio`);
  assert.ok(byId("exec-mode-ask").checked, "the stored mode is ask");
  // Each option says what it does — the consequence, not the enum name.
  assert.match($("#exec-mode-full-desc").textContent, /Runs anything without asking/);
  assert.match($("#exec-mode-full").closest(".setcard__mode").textContent, /full/);
});

test("picking a mode is a draft edit: the status line answers before the save", async () => {
  await choose("exec-mode-full");
  assert.ok(byId("exec-mode-full").checked);
  assert.equal($(".setcard__status .settings__tag").textContent, "mode full");
  assert.match($(".setcard__status-note").textContent, /Runs anything without asking/);
  assert.equal(noteText(), "Unsaved changes");
  assert.equal(sets().length, 0, "nothing written yet");
  assert.ok($('[data-mode="full"]').classList.contains("is-on"), "the chosen row is marked");
});

test("nothing on the card offers a permission step", async () => {
  // The switch said "on = ask, off = full" — but nothing waits for a human any
  // more (Task 55), and `execModeOf` ignores the key (Task 56). A control that
  // cannot do what its label says is the same bug as a wrong answer.
  assert.equal($$("#exec-approvals").length, 0, "the legacy switch is gone");
  assert.equal($$(".exec__legacy").length, 0);
  assert.equal($$('[data-mode="legacy"]').length, 0, "no pseudo-mode");
  // …and the save still writes the key, as false, so an old config migrates.
  await click("exec-policy-save");
  assert.equal(sets().at(-1).params.value.approvals, false);
});

test("saving writes the whole block once, merged over what is stored", async () => {
  await choose("exec-mode-allowlist");
  await type("exec-timeout", "120000");
  await type("exec-trusted-dirs", "/bin, /opt/tools/bin");
  await click("exec-bin-tail");
  await click("exec-policy-save");
  const writes = sets();
  assert.equal(writes.length, 1, "one write, not eleven");
  assert.equal(writes[0].params.path, "tools.exec");
  const v = writes[0].params.value;
  assert.equal(v.mode, "allowlist");
  assert.equal(v.timeoutMs, 120000);
  assert.deepEqual(v.safeBinTrustedDirs, ["/bin", "/opt/tools/bin"]);
  assert.deepEqual([...v.safeBins].sort(), ["cut", "head", "rm", "tail"], "chips add and remove individual bins");
  assert.equal(v.someFutureKnob, 7, "a key this page does not render survives the save");
  assert.equal(v.enabled, true);
  assert.equal(noteText(), "", "a landed save clears the marker");
});

test("a timeout outside 1000–1800000 is refused, never clamped", async () => {
  await type("exec-timeout", "50");
  await click("exec-policy-save");
  assert.equal(sets().length, 0, "nothing written");
  assert.equal(byId("exec-timeout").getAttribute("aria-invalid"), "true");
  const problem = $(".setfoot .hint--err");
  assert.equal(problem.hasAttribute("hidden"), false);
  assert.match(problem.textContent, /between 1000 and 1800000/);
  assert.ok(focused.includes(byId("exec-timeout")), "focus lands on the field to fix");
  assert.equal(noteText(), "Unsaved changes", "the draft is still there");
});

test("the timeout says what it means in minutes, and the echo tracks typing", async () => {
  assert.equal($(".setcard__echo").textContent, "≈ 30 min", "the default is the 30-minute cap");
  // The range the field will actually accept is on screen, next to the box.
  assert.match(byId("exec-timeout").closest(".setfield")?.textContent ?? "", /1000–1800000 \(30 min, the default\)/, "the range is on screen next to the box");
  await type("exec-timeout", "90000");
  assert.equal($(".setcard__echo").textContent, "≈ 1.5 min");
});

test("the card states direct Termux instead of offering a sandbox", async () => {
  // Task 57: `proot` needs ptrace and aborts on a stock phone, and `env -i`
  // hides $PREFIX/bin — the jail was the outage, not the boundary. The controls
  // are gone; the keys are still written as off/false so an old config migrates
  // on the next save.
  assert.equal($$("#exec-proot").length, 0);
  assert.equal($$("#exec-direct-note").length, 1);
  assert.match($("#exec-direct-note").textContent, /directly in Termux/);
  await click("exec-policy-save");
  const v = sets().at(-1).params.value;
  assert.equal(v.sandbox, "off");
  assert.equal(v.sandboxProot, false);
});

test("safe bins are chips for the six that have a profile, and the extras are labelled inert", () => {
  const chips = $$(".seg--wrap .seg__btn");
  const labels = chips.map((c) => c.textContent);
  for (const bin of ["cut", "uniq", "head", "tail", "tr", "wc"]) assert.ok(labels.includes(bin), `${bin} offered`);
  assert.equal(chips.filter((c) => !c.classList.contains("is-off")).length, 6, "six supported chips");
  // "rm" is stored but has no stdin-only profile: shown, marked, not silently gone.
  const rm = byId("exec-bin-rm");
  assert.ok(rm.classList.contains("is-off"));
  assert.equal(rm.getAttribute("aria-pressed"), "true");
  assert.match(rm.getAttribute("title"), /has no stdin-only profile/);
  assert.equal(byId("exec-bin-head").getAttribute("aria-pressed"), "true");
  assert.equal(byId("exec-bin-wc").getAttribute("aria-pressed"), "false");
});

test("a grant shows the command it allowed, when it was last used, and revokes in two steps", async () => {
  const rows = $$(".ledger .ledger__row");
  assert.equal(rows.length, 2, "both ledger entries are listed");
  assert.match(rows[0].textContent, /\/home\/u\/bin\/render\.sh/, "the minted path");
  assert.match(rows[0].textContent, /\$ render\.sh --fast --out dist/, "the command as it ran");
  assert.match(rows[0].textContent, /in ~\/proj/, "the directory, home-shortened");
  assert.match(rows[0].textContent, /used 5m ago/);
  assert.match(rows[1].textContent, /argv \/\^safe\//, "a manual argv regex reads as a regex");
  assert.match(rows[1].textContent, /never used/, "an unused grant says so rather than showing a blank");

  const revoke = rows[0].querySelector(".btn.danger");
  await tap(revoke);
  assert.equal(calls("approvals.entry.revoke").length, 0, "one click only arms");
  assert.equal(revoke.textContent, "Confirm revoke");
  await tap(revoke);
  assert.equal(calls("approvals.entry.revoke").length, 1);
  assert.equal(calls("approvals.entry.revoke")[0].params.id, "g1");
});

test("searching grants is not a policy edit", async () => {
  await type("exec-grant-search", "render");
  assert.equal($$(".ledger .ledger__row").length, 1, "filtered");
  assert.equal(noteText(), "", "the policy draft is untouched");
  await type("exec-grant-search", "zzz");
  assert.match($(".ledger").textContent, /No grants match the search/);
});

test("adding a grant validates locally, then re-reads the ledger", async () => {
  await click("exec-grant-add");
  assert.equal(calls("approvals.entry.add").length, 0, "an empty pattern never reaches the gateway");
  assert.match($(".exec__add .hint--err").textContent, /pattern is required/);
  assert.equal(byId("exec-grant-add").disabled, false, "the button comes back");

  await type("exec-grant-pattern", "deno");
  await click("exec-grant-add");
  assert.equal(calls("approvals.entry.add").length, 1);
  assert.equal(calls("approvals.entry.add")[0].params.pattern, "deno");
  assert.equal(calls("approvals.entry.add")[0].params.argPattern, undefined, "an empty argv box is not sent");
});

test("a failing approvals RPC costs the grants list, not the policy", async () => {
  await open({ failApprovals: "socket closed" });
  assert.ok(byId("exec-policy-save"), "the policy is still there");
  assert.ok(byId("exec-timeout"));
  assert.match($(".exec-grants").textContent, /Grants could not be read — socket closed/);
  assert.equal($$(".ledger .ledger__row").length, 0);
  await choose("exec-mode-deny");
  await click("exec-policy-save");
  assert.equal(sets().length, 1, "and it still saves");
});

test("a rejected save keeps the draft and says why", async () => {
  await open({ failSet: "config is read-only" });
  await choose("exec-mode-full");
  await click("exec-policy-save");
  const problem = $(".setfoot .hint--err");
  assert.equal(problem.hasAttribute("hidden"), false);
  assert.match(problem.textContent, /not saved — config is read-only/);
  assert.equal(byId("exec-policy-save").disabled, false, "the button is usable again");
  assert.equal(noteText(), "Unsaved changes");
  assert.ok(byId("exec-mode-full").checked, "the draft survived");
});

test("presets fill the draft and do not save", async () => {
  await click("exec-preset-yolo");
  assert.ok(byId("exec-mode-full").checked);
  assert.equal(selValue("exec-ask-fallback"), "full");
  assert.equal(selValue("exec-unattended"), "all");
  assert.equal(sets().length, 0, "a preset is a starting point, not a write");
  assert.equal(noteText(), "Unsaved changes");

  await click("exec-preset-deny");
  assert.ok(byId("exec-mode-deny").checked);
  assert.equal($(".setcard__status .settings__tag").textContent, "mode deny");
  assert.equal(selValue("exec-unattended"), "all", "a preset only touches what it names");
  await pick("exec-unattended", "refuse it");
});

test("switching exec off says nothing below it applies", async () => {
  byId("exec-enabled").checked = false;
  fire(byId("exec-enabled"), "change");
  await settle();
  assert.equal($(".setcard__status .settings__tag").textContent, "exec off");
  assert.match($(".setcard__status-note").textContent, /no shell tool/);
  assert.match($(".exec__enabled .hint").textContent, /nothing below has any effect/);
  await click("exec-policy-save");
  assert.equal(sets().at(-1).params.value.enabled, false);
});
