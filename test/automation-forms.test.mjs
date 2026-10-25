// P4 (Missing!#36, #37) — automation config forms + queue controls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("config.unset: leaf deletion whith whole-root validation; redact masks hook token + imap passwords", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-unset-"));
  const { ConfigService } = await import("../dist/lib.js");
  const { silentLogger } = await import("../dist/lib.js");
  const log = silentLogger ?? { info() {}, warn() {}, error() {}, debug() {} };
  const svc = new ConfigService(log, join(dir, "config.json5"));
  // seed an imap account + hook mapping
  assert.equal(svc.set("imap", { enabled: true, accounts: { work: { enabled: true, host: "imap.example.com", port: 993, secure: true, user: "bot@x.com", password: "s3cr3tP4ss", passwordEnv: "", mailbox: "INBOX", watch: { mode: "interval", pollSeconds: 60 }, allowedSenders: [], addressTokens: [], senderAuth: { min: "unverified", trustedAuthservIds: [], acceptTrustedAuthservId: false }, deliver: false, to: "", includeBody: true, maxBytes: 20000 } } }).ok, true);
  assert.equal(svc.set("hooks", { enabled: true, token: "hookToken12345", path: "/hooks", allowRequestSessionKey: false, mappings: { gh: { action: "agent", sessionKey: "dev:hooks" } } }).ok, true);

  // redaction: secrets never cross the socket material
  const { redactSecrets } = await import("../dist/lib.js");
  const redacted = redactSecrets(svc.current);
  assert.match(redacted.hooks.token, /^__redacted__:/);
  assert.match(redacted.imap.accounts.work.password, /^__redacted__:/);

  // unset removes the leaf and re-validates
  const r1 = svc.unsetPath("imap.accounts.work");
  assert.equal(r1.ok, true);
  assert.deepEqual(svc.current.imap.accounts, {});
  const r2 = svc.unsetPath("hooks.mappings.gh");
  assert.equal(r2.ok, true);
  assert.deepEqual(svc.current.hooks.mappings, {});
  // other fields survive
  assert.equal(svc.current.hooks.token, "hookToken12345");
});

test("gateway wires config.unset with the same validation + live apply as config.set", () => {
  const src = readFileSync(new URL("../src/gateway/server.ts", import.meta.url), "utf8");
  assert.match(src, /"config\.unset",/);
  assert.match(src, /case "config\.unset":/);
  assert.match(src, /service\.configSvc\.unsetPath\(path\)/);
  assert.match(src, /unset targets a leaf inside a record/); // whole-section guard
  assert.match(src, /bad_config/);
  // live apply
  assert.match(src, /case "config\.unset": \{[\s\S]*?service\.applyConfig\(\);/);
});

test("automations tab: imap form (master toggle, account CRUD, leaf writes), hooks form, dreaming form", () => {
  const src = readFileSync(new URL("../ui/src/settings.ts", import.meta.url), "utf8");
  // IMAP: master toggle + account rows + add/edit dialog + guarded delete
  assert.match(src, /id: "imap-enabled"/);
  assert.match(src, /\["imap\.enabled", masterCb\.checked\]/);
  assert.match(src, /id: `imap-edit-\$\{aname\}`/);
  assert.match(src, /id: `imap-del-\$\{aname\}`/);
  // The delete is the app's own dialog (window.confirm is banned in ui/src/dom.ts),
  // and it states what stops rather than asking a yes/no question.
  assert.match(src, /title: `Delete mailbox \$\{aname\}\?`/);
  assert.match(src, /danger: true,[\s\S]*?config\.unset", \{ path: `imap\.accounts\.\$\{aname\}` \}/);
  assert.ok(!src.includes("window.confirm"), "no native confirm anywhere in settings");
  assert.match(src, /id: "imap-add"/);
  assert.match(src, /#imapAccountDialog\(origName: string \| null/);
  // leaf writes only — the account object never round-trips (no sentinel leaks)
  assert.match(src, /const base = `imap\.accounts\.\$\{aname\}`;/);
  assert.match(src, /`\$\{base\}\.allowedSenders`, senders\]/);
  assert.match(src, /if \(pwF\.input\.value\) pairs\.push\(\[`\$\{base\}\.password`/); // blank keeps
  assert.match(src, /may not contain dots/); // record-key safety
  // hooks form
  assert.match(src, /id: "hooks-enabled"/);
  assert.match(src, /\["hooks\.path", nextPath\]/);
  assert.match(src, /\["hooks\.allowRequestSessionKey", askCb\.checked\]/);
  assert.match(src, /if \(typed\) pairs\.push\(\["hooks\.token", typed\]\)/); // write-only
  assert.match(src, /id: "hook-map-add"/);
  assert.match(src, /#hookMappingDialog\(origName: string \| null/);
  assert.match(src, /config\.unset", \{ path: `hooks\.mappings\.\$\{mname\}` \}/);
  // The dream sweep is edited once, on the Memory tab: Automations only points at it.
  assert.match(src, /id: "auto-open-memory"/);
  assert.ok(!src.includes('id: "dreaming-enabled"'), "one editor for memory.dreaming");
  assert.ok(!src.includes('id: "dreaming-schedule"'));
  assert.equal(src.includes("memory.dreaming.schedule"), false, "the schedule leaf is written by Memory alone");
});

test("queue controls: header switch writes queue.set, depth chip from queue.status, settings block", () => {
  const main = readFileSync(new URL("../ui/src/main.ts", import.meta.url), "utf8");
  assert.match(main, /function syncQueue\(/);
  assert.match(main, /row\?\.queue_mode \?\? "inherit"/);
  assert.match(main, /gateway\.request\("queue\.set", \{ sessionKey, reset: true \}\)/);
  assert.match(main, /gateway\.request\("queue\.set", \{ sessionKey, mode: value \}\)/);
  // mode whitelist on the client too (never hand a bad value to the server)
  assert.match(main, /!\["inherit", "steer", "followup", "collect", "interrupt"\]\.includes\(value\)/);
  assert.match(main, /queue\.status", \{ sessionKey \}/);
  assert.match(main, /chip\.textContent = n > 0 \? String\(n\) : ""/);
  const html = readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
  assert.match(html, /id="queue-select"/);
  assert.match(html, /id="queue-depth"/);
  assert.match(html, /<option value="collect">collect<\/option>/);
  assert.match(html, /<option value="interrupt">interrupt<\/option>/);
  const settings = readFileSync(new URL("../ui/src/settings.ts", import.meta.url), "utf8");
  assert.match(settings, /cards\(|Message queue|class: "in", id: "queue-mode"/);
  assert.match(settings, /id: "queue-mode"/);
  assert.match(settings, /id: "queue-cap"/);
  assert.match(settings, /id: "queue-drop"/);
  assert.match(settings, /id: "queue-debounce"/);
  assert.match(settings, /id: "queue-by-tg"/);
  // A #dropdown keeps its value in a hidden store; reading `.value` off the store
  // is the browser's opinion, so every read goes through the option list.
  assert.match(settings, /\["messages\.queue\.mode", this\.#selValue\(modeDd\.sel\)\]/);
  assert.match(settings, /const tg = this\.#selValue\(tgDd\.sel\);/);
  assert.match(settings, /\["messages\.queue\.byChannel", \{ \.\.\.\(tg \? \{ telegram: tg \} : \{\}\) \}\]/);
});
