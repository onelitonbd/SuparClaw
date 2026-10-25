// Settings → System: five surfaces that decide whether this install is well.
//
// What was wrong: a doctor run that rendered as "SyntaxError: '' is not a valid
// selector" in a real browser (a `querySelector("")` left inside the success
// path), two `void …` dead bindings, raw checkboxes with no consequence
// sentences, no busy state on any of the four check buttons, no timestamps,
// three hand-copied pass/fail row renderers with three different summary
// vocabularies, a provider sniff that printed `binding: __redacted__:••••9f2a…`
// and called a stored key a binding, a swallowed `backup.list` failure, and
// five `div.card > h3` boxes that did not use the shared card language.
//
// Every capability below is driven, not asserted from the source: all nine
// RPCs, all nine ids, and every failure path the user can hit.

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
const start = settingsSrc.indexOf("async #renderSystem(config: any)");
const end = settingsSrc.indexOf("/** Runtime tab: the daemon behind this page");
assert.ok(start !== -1 && end !== -1 && start < end, "the System region was found");
const systemRegion = settingsSrc.slice(start, end);

const DOC = {
  fails: 1,
  warns: 1,
  checks: [
    { name: "node", status: "ok", detail: "v22.22.3" },
    { name: "sqlite (node:sqlite)", status: "ok", detail: "sqlite 3.49.1, NUL round-trip ok" },
    { name: "platform", status: "warn", detail: "Termux (proot)", fix: "termux-chroot for native tools" },
    { name: "config", status: "fail", detail: "openclaw.json5 is not valid JSON5", fix: "fix the file, then sc doctor" },
  ],
};
const AUDIT = {
  fails: 1,
  warns: 1,
  findings: [
    { name: "config file mode", status: "fail", detail: "0644 — readable by other users", fix: "chmod 600 openclaw.json5" },
    { name: "gateway auth", status: "warn", detail: "loopback bypass is on", fix: "turn it off on a shared machine" },
    { name: "provider keys", status: "ok", detail: "no plaintext keys in the file" },
  ],
};
const SECRETS = { ok: false, findings: ["providers.openai.apiKey — literal key"], warnings: ["env:FOO — unresolved reference"] };
const UPDATE_NEW = {
  ok: true, upToDate: false, behind: true, slug: "onelitonbd/SuparClaw", ref: "main",
  currentSha: "b4bf788aaa111", remoteSha: "c9d1e2fbbb222", remoteDate: "2026-10-24T10:00:00Z",
};
const UPDATE_SAME = { ...UPDATE_NEW, upToDate: true, behind: false, remoteSha: "b4bf788bbb333" };
const BACKUPS = {
  dir: "/home/u/.suparclaw/backups",
  backups: [
    { file: "suparclaw-2026-10-23T10-00-00.tar.gz", size: 2431000, mtime: "2026-10-23T10:00:00.000Z" },
    { file: "suparclaw-2026-10-22T09-12-00.tar.gz", size: 2390000, mtime: "2026-10-22T09:12:00.000Z" },
  ],
};
const CREATED = {
  archivePath: "/home/u/.suparclaw/backups/suparclaw-2026-10-25T11-00-00.tar.gz",
  files: 42, bytes: 2530000, verified: true, warnings: [],
};
const RESTORE = { restored: 12, restart: "restart the gateway (sc service restart) to load the restored state" };

const outDir = mkdtempSync(join(TMP, "sc-ui-system-"));
writeFileSync(join(outDir, "rpc-stub.mjs"), `
export const gateway = {
  state: "online",
  async request(method, params) {
    (globalThis.__SC_CALLS ||= []).push({ method, params });
    if (method === "config.get") {
      return { config: JSON.parse(JSON.stringify(globalThis.__SC_CFG)), path: "/home/u/.suparclaw/openclaw.json5" };
    }
    const held = () => globalThis.__SC_HOLD
      ? new Promise((r) => { globalThis.__SC_RELEASE = () => { globalThis.__SC_HOLD = false; r(); }; })
      : null;
    if (method === "system.doctor") { const h = held(); if (h) await h; if (globalThis.__SC_DOC_ERR) throw new Error(globalThis.__SC_DOC_ERR); return JSON.parse(JSON.stringify(globalThis.__SC_DOC)); }
    if (method === "system.securityAudit") { if (globalThis.__SC_AUD_ERR) throw new Error(globalThis.__SC_AUD_ERR); return JSON.parse(JSON.stringify(globalThis.__SC_AUD)); }
    if (method === "secrets.audit") { if (globalThis.__SC_SEC_ERR) throw new Error(globalThis.__SC_SEC_ERR); return JSON.parse(JSON.stringify(globalThis.__SC_SEC)); }
    if (method === "system.update.check") { if (globalThis.__SC_UPD_ERR) throw new Error(globalThis.__SC_UPD_ERR); return JSON.parse(JSON.stringify(globalThis.__SC_UPD)); }
    if (method === "system.update.apply") return JSON.parse(JSON.stringify(globalThis.__SC_APPLY));
    if (method === "backup.list") { if (globalThis.__SC_BL_ERR) throw new Error(globalThis.__SC_BL_ERR); return JSON.parse(JSON.stringify(globalThis.__SC_BL)); }
    if (method === "backup.create") return JSON.parse(JSON.stringify(globalThis.__SC_BC));
    if (method === "backup.verify") return JSON.parse(JSON.stringify({ ok: true, files: 42 }));
    if (method === "backup.restore") return JSON.parse(JSON.stringify(globalThis.__SC_BR));
    return { ok: true };
  },
};
`);
await (await import("esbuild")).build({
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
const loc = { hash: "#/settings/system", reload() { globalThis.__RELOADED = (globalThis.__RELOADED ?? 0) + 1; } };
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
const click = async (node) => { fire(node, "click"); await settle(); };
const calls = (method) => (globalThis.__SC_CALLS ?? []).filter((c) => c.method === method);
const shownText = () => [...document.querySelectorAll("#toasts .toast")].map(text).join(" | ");
const strip = (card) => text($(`.${card} .setcard__status`));
const tag = (card) => text($(`.${card} .settings__tag`));
const tagTone = (card) => $(`.${card} .settings__tag`)?.className ?? "";
const cardNote = (card) => text($(`.${card} .setcard__status-note`));
const footNote = (card) => text($(`.${card} .setfoot__note`));
const heads = () => $$(".settings__stack > .card h3").map(text);
const valueOf = (label) => {
  const row = $$(".row").find((r) => text(r.querySelector(".row__label")) === label);
  return text(row?.querySelector(".row__value"));
};

const CFG = {
  providers: {
    openai: { apiKey: "__redacted__:••••9f2a" },
    ollama: { apiKey: "" },
    local: { apiKey: "profiles:work" },
  },
};

const open = async (opts = {}) => {
  globalThis.__SC_CALLS = [];
  globalThis.__SC_CFG = JSON.parse(JSON.stringify(opts.cfg ?? CFG));
  globalThis.__SC_DOC = JSON.parse(JSON.stringify(opts.doc ?? DOC));
  globalThis.__SC_DOC_ERR = opts.docErr ?? "";
  globalThis.__SC_AUD = JSON.parse(JSON.stringify(opts.aud ?? AUDIT));
  globalThis.__SC_AUD_ERR = opts.audErr ?? "";
  globalThis.__SC_SEC = JSON.parse(JSON.stringify(opts.sec ?? SECRETS));
  globalThis.__SC_SEC_ERR = opts.secErr ?? "";
  globalThis.__SC_UPD = JSON.parse(JSON.stringify(opts.upd ?? UPDATE_NEW));
  globalThis.__SC_UPD_ERR = opts.updErr ?? "";
  globalThis.__SC_APPLY = JSON.parse(JSON.stringify(opts.apply ?? { ok: true, sha: "c9d1e2fbbb222", ref: "main", at: "2026-10-24" }));
  globalThis.__SC_BL = JSON.parse(JSON.stringify(opts.bl ?? BACKUPS));
  globalThis.__SC_BL_ERR = opts.blErr ?? "";
  globalThis.__SC_BC = JSON.parse(JSON.stringify(opts.bc ?? CREATED));
  globalThis.__SC_BR = JSON.parse(JSON.stringify(opts.br ?? RESTORE));
  globalThis.__SC_HOLD = false;
  globalThis.__RELOADED = 0;
  document.querySelectorAll("#toasts .toast").forEach((t) => t.remove());
  byId("modal-overlay").hidden = true;
  root.innerHTML = "";
  loc.hash = "#/settings/system";
  const settings = new Settings(root, () => {});
  settings.setHash("#/settings/system");
  await settings.render();
  await settle();
  return settings;
};

test("five cards on the shared shell, one footer action each, no leftovers", async () => {
  await open();
  assert.deepEqual(heads(), ["System checks", "Security audit", "Software update", "Backup & restore", "Secrets"]);
  for (const card of $$(".settings__stack > .card")) {
    assert.equal(card.querySelectorAll(".setcard__head h3").length, 1, "one title per card");
    assert.ok(text(card.querySelector(".setcard__head .hint")).length > 20, "every card says what it covers");
  }
  assert.equal($$(".settings__stack > .card > .setfoot").length, 5, "every card ends on its commit bar");
  for (const f of $$(".setfoot")) assert.equal(f.querySelectorAll("button").length, 1, "one action per footer");
  assert.equal($$(".settings__stack > .card > .setcard__head + .setcard__status").length, 5, "every card opens on the same state line");
  assert.equal($$(".tiles, .tile").length, 0);
  assert.equal($$("select").length, 0, "no native dropdown");
  assert.equal($$("[style]").length, 0, "no inline styles");
  assert.equal($$(".card .modal__field").length, 0, "cards never borrow the dialog's field");
  assert.equal($$("[data-archive]").length, 2, "the archive rows are still addressable");
});

test("doctor: nothing claimed before the run, one row per probe after, fix on the failing row", async () => {
  await open();
  assert.equal(tag("sys-doctor"), "not run");
  assert.equal($$(".sys-doctor .diag-row").length, 0, "no rows before a run");
  assert.equal(byId("doctor-run").disabled, false);

  await click(byId("doctor-run"));
  const rows = $$(".sys-doctor .diag-row");
  assert.equal(rows.length, 4, "one row per check");
  assert.deepEqual(rows.map((r) => text(r.querySelector(".diag-mark"))), ["✔", "✔", "▲", "✖"]);
  assert.deepEqual(rows.map((r) => r.querySelector(".diag-mark").className.includes("diag-mark--fail")), [false, false, false, true]);
  assert.match(text(rows[3]), /openclaw\.json5 is not valid JSON5/);
  assert.match(text(rows[3]), /fix: fix the file, then sc doctor/, "the payload's fix is printed");
  assert.equal(tag("sys-doctor"), "1 failing");
  assert.match(tagTone("sys-doctor"), /is-err/);
  assert.match(cardNote("sys-doctor"), /1 probe of 4 failed/);
  assert.match(footNote("sys-doctor"), /^Run at /);
  assert.equal(byId("doctor-run").disabled, false, "the button comes back");
});

test("doctor survives a browser that rejects an empty selector", async () => {
  await open();
  const proto = page.Element.prototype;
  const real = proto.querySelector;
  proto.querySelector = function (sel) {
    if (sel === "") throw new Error("SyntaxError: '' is not a valid selector");
    return real.call(this, sel);
  };
  try {
    await click(byId("doctor-run"));
  } finally {
    proto.querySelector = real;
  }
  assert.equal($$(".sys-doctor .diag-row").length, 4, "the success path still renders");
  assert.equal(tag("sys-doctor"), "1 failing");
  assert.ok(!pageText().includes("SyntaxError"), "no selector error leaks into the page");
});

test("security audit: findings, the all-clear state, and a failed run that names itself", async () => {
  await open();
  assert.equal(tag("sys-audit"), "not audited");
  await click(byId("security-audit-run"));
  assert.equal($$(".sys-audit .diag-row").length, 3);
  assert.equal(tag("sys-audit"), "1 critical");
  assert.match(tagTone("sys-audit"), /is-err/);
  assert.match(cardNote("sys-audit"), /1 check of 3 fail/);
  assert.match(pageText(), /sc security audit/, "the CLI pointer survives");

  await open({ aud: { fails: 0, warns: 0, findings: [{ name: "provider keys", status: "ok", detail: "none in the file" }] } });
  await click(byId("security-audit-run"));
  assert.equal(tag("sys-audit"), "all clear");
  assert.match(tagTone("sys-audit"), /is-ok/);

  await open({ audErr: "audit module unavailable" });
  await click(byId("security-audit-run"));
  assert.equal(tag("sys-audit"), "unknown");
  assert.match(cardNote("sys-audit"), /audit module unavailable/);
  assert.equal(byId("security-audit-run").disabled, false);
});

test("update: nothing to apply until a check, then one typed-confirm request", async () => {
  await open();
  assert.equal(byId("update-apply").disabled, true);
  assert.match(pageText(), /Run a check first/);

  await click(byId("update-check"));
  assert.equal(tag("sys-update"), "update available");
  assert.match(tagTone("sys-update"), /is-warn/);
  assert.equal(valueOf("Installed commit"), "b4bf788");
  assert.equal(valueOf("Remote commit"), "c9d1e2f");
  assert.equal(valueOf("Branch"), "main");
  assert.equal(valueOf("Repository"), "onelitonbd/SuparClaw");
  assert.equal(byId("update-apply").disabled, false);
  assert.match(footNote("sys-update"), /^Checked at /);

  await click(byId("update-apply"));
  assert.equal(byId("modal-overlay").hidden, false, "the dialog opens");
  assert.equal(calls("system.update.apply").length, 0, "opening it applies nothing");
  assert.match(text(byId("modal-body")), /Type c9d1e2fbbb22 to confirm/);
  byId("f-sha").value = "c9d1e2fbbb22";
  await click(byId("modal-foot").querySelectorAll("button")[1]);
  assert.equal(calls("system.update.apply").length, 1, "one request");
  assert.equal(calls("system.update.apply")[0].params.sha, "c9d1e2fbbb22");
  assert.equal(tag("sys-update"), "updated");
  assert.match(cardNote("sys-update"), /Restart the service to run the new build/);
  assert.equal(byId("update-apply").disabled, true, "nothing left to apply");

  await open({ upd: UPDATE_SAME });
  await click(byId("update-check"));
  assert.equal(tag("sys-update"), "up to date");
  assert.match(tagTone("sys-update"), /is-ok/);
  assert.equal(byId("update-apply").disabled, true);
  assert.match(text($(".sys-update")), /Nothing to apply/);

  await open({ updErr: "github unreachable" });
  await click(byId("update-check"));
  assert.equal(tag("sys-update"), "check failed");
  assert.match(cardNote("sys-update"), /github unreachable/);
});

test("backup: rows with names, both switches in the request, verify, and a gated restore", async () => {
  await open();
  const rows = $$("[data-archive]");
  assert.equal(rows.length, 2);
  assert.match(text(rows[0]), /2\.32 MiB · /, "size and time are shown");
  for (const row of rows) {
    const [v, r] = row.querySelectorAll("button");
    assert.equal((v.getAttribute("title") ?? "").length > 8, true, "verify has an accessible name");
    assert.equal((r.getAttribute("title") ?? "").length > 8, true, "restore has an accessible name");
  }
  assert.match(tag("sys-backup"), /2 archives/);

  await click(byId("backup-create"));
  let params = calls("backup.create")[0].params;
  assert.equal(params.includeWorkspace, true, "workspace included by default");
  assert.equal(params.verify, true, "verified by default");
  assert.equal(tag("sys-backup"), "created");
  assert.match(cardNote("sys-backup"), /suparclaw-2026-10-25T11-00-00\.tar\.gz is in \/home\/u\/\.suparclaw\/backups/);
  assert.match(shownText(), /backup written: .*verified/);

  byId("backup-workspace").checked = false;
  await click(byId("backup-create"));
  params = calls("backup.create")[1].params;
  assert.equal(params.includeWorkspace, false, "the switch reaches the request");
  byId("backup-config-only").checked = true;
  await click(byId("backup-create"));
  assert.equal(calls("backup.create")[2].params.onlyConfig, true);

  await click(rows[0].querySelectorAll("button")[0]);
  assert.equal(calls("backup.verify")[0].params.archive, "/home/u/.suparclaw/backups/suparclaw-2026-10-23T10-00-00.tar.gz");
  assert.match(shownText(), /verified: suparclaw-2026-10-23T10-00-00\.tar\.gz \(42 entries\)/);

  await click(rows[1].querySelectorAll("button")[1]);
  assert.equal(byId("modal-overlay").hidden, false);
  assert.match(text(byId("modal-title")), /Restore suparclaw-2026-10-22T09-12-00\.tar\.gz/);
  assert.match(text(byId("modal-body")), /The current state is replaced/);
  assert.equal(calls("backup.restore").length, 0, "the dialog restores nothing");
  await click(byId("modal-foot").querySelectorAll("button")[1]);
  assert.equal(calls("backup.restore").length, 1);
  assert.match(shownText(), /restart the gateway \(sc service restart\) to load the restored state/);
  assert.equal(tag("sys-backup"), "restored");

  await open({ blErr: "EACCES: readdir failed" });
  assert.equal(tag("sys-backup"), "unavailable");
  assert.match(tagTone("sys-backup"), /is-err/);
  assert.match(cardNote("sys-backup"), /EACCES/);
  assert.equal(footNote("sys-backup"), "Not read.", "no stale claim next to the error");
});

test("secrets: a redacted key is a key, a binding is a binding, a literal is flagged", async () => {
  await open();
  assert.equal(valueOf("openai"), "stored key, redacted");
  assert.equal(valueOf("ollama"), "no key");
  assert.equal(valueOf("local"), "profile binding");
  assert.match(pageText(), /profiles:work names a stored auth profile/);
  assert.ok(!pageText().includes("binding: __redacted__"), "the old mislabel is gone");

  await open({ cfg: { providers: { local: { apiKey: "sk-liveabcdefgh" } } } });
  assert.equal(valueOf("local"), "literal key");
});

test("secrets audit: clean, findings, unreadable config, and a dead socket", async () => {
  await open({ sec: { ok: true, findings: [], warnings: [] } });
  await click(byId("secrets-audit-run"));
  assert.equal(tag("sys-secrets"), "clean");
  assert.match(tagTone("sys-secrets"), /is-ok/);
  assert.match(text($(".sys-secrets")), /No plaintext credentials or unresolved refs/);

  await open();
  await click(byId("secrets-audit-run"));
  assert.equal(tag("sys-secrets"), "1 finding");
  assert.match(tagTone("sys-secrets"), /is-err/);
  const rows = $$(".sys-secrets .diag-row");
  assert.equal(rows.length, 2, "one failing finding and one warning");
  assert.equal(rows[0].querySelector(".diag-mark").className.includes("diag-mark--fail"), true);
  assert.equal(rows[1].querySelector(".diag-mark").className.includes("diag-mark--warn"), true);

  await open({ sec: { ok: false, findings: [], warnings: [], error: "config parse failed: line 3" } });
  await click(byId("secrets-audit-run"));
  assert.equal(tag("sys-secrets"), "unreadable");
  assert.match(pageText(), /config parse failed: line 3/);

  await open({ secErr: "gateway closed the socket" });
  await click(byId("secrets-audit-run"));
  assert.equal(tag("sys-secrets"), "unknown");
  assert.match(cardNote("sys-secrets"), /gateway closed the socket/);
  assert.equal(byId("secrets-audit-run").disabled, false);
});

test("a slow probe disables its button and comes back labelled", async () => {
  await open();
  globalThis.__SC_HOLD = true;
  fire(byId("doctor-run"), "click");
  await tick();
  assert.equal(byId("doctor-run").disabled, true, "no second run while the first is in flight");
  assert.equal(text(byId("doctor-run")), "Running…");
  globalThis.__SC_RELEASE();
  await settle();
  assert.equal(byId("doctor-run").disabled, false);
  assert.equal(text(byId("doctor-run")), "Run doctor");
  assert.equal($$(".sys-doctor .diag-row").length, 4);
});

test("the tab writes nothing, and keeps every id and RPC the CLI parity promises", () => {
  assert.ok(systemRegion.length > 5000, "the region was found");
  for (const bad of ["config.set", "location.reload", "window.confirm", "↻", "querySelector(\"\")", "void full", "P3 #29", "channels tab hint"]) {
    assert.ok(!systemRegion.includes(bad), `System tab must not contain ${bad}`);
  }
  for (const id of ["doctor-run", "security-audit-run", "update-check", "update-apply", "backup-create", "backup-workspace", "backup-config-only", "secrets-audit-run"]) {
    assert.ok(systemRegion.includes(`id: "${id}"`), `#${id} is the page's own control`);
  }
  for (const rpc of ["system.doctor", "system.securityAudit", "system.update.check", "system.update.apply", "backup.list", "backup.create", "backup.verify", "backup.restore", "secrets.audit"]) {
    assert.ok(systemRegion.includes(`gateway.request("${rpc}"`), `the page calls ${rpc}`);
  }
  assert.ok(systemRegion.includes("data-archive"), "archive rows stay addressable");
  assert.ok(systemRegion.includes("fix: ${c.fix}"), "the fix is still the payload's own field");
  assert.equal(/danger:\s*true/.test(systemRegion), true, "update and restore stay behind a danger confirm");
});
