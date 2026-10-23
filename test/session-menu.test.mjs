// P4 (Missing!#33) — session management menu: delete/archive/export/prune.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SUPARCLAW_HOME = mkdtempSync(join(tmpdir(), "sc-sessmenu-"));
const { Service } = await import("../dist/lib.js");

test("store: archive/unarchive keeps id+history, leaves default list; delete removes with message count", async () => {
  const service = new Service();
  const store = service.store;
  const key = "menu:test1";
  const sess = store.ensureSession(key);
  store.appendMessage(sess.id, "user", "hello");

  // archive → default list drops it, direct lookup still resolves (their rule)
  assert.equal(store.setSessionArchived(key, true).ok, true);
  assert.equal(store.listSessions(10).some((r) => r.key === key), false);
  const row = store.getSessionByKey(key);
  assert.equal(Number(row.archived), 1);
  assert.ok(row.archived_at > 0);
  assert.equal(store.listSessions(10, { includeArchived: true }).some((r) => r.key === key), true);

  // unarchive restores visibility + clears the flag
  assert.equal(store.setSessionArchived(key, false).ok, true);
  assert.equal(store.listSessions(10).some((r) => r.key === key), true);
  assert.equal(Number(store.getSessionByKey(key).archived), 0);

  // delete reports the message count
  const del = store.deleteSession(key);
  assert.equal(del.deleted, true);
  assert.equal(del.messages, 1);

  // unknown key archive is a no-op, not a crash
  assert.equal(store.setSessionArchived("menu:nope", true).ok, false);
  await service.stop();
});

test("gateway wires sessions.delete + sessions.export + archived patch + includeArchived list", () => {
  const src = readFileSync(new URL("../src/gateway/server.ts", import.meta.url), "utf8");
  assert.match(src, /"sessions\.delete",/);
  assert.match(src, /"sessions\.export",/);
  assert.match(src, /case "sessions\.delete":/);
  assert.match(src, /service\.store\.deleteSession\(key\)/);
  assert.match(src, /okFrame\(id, \{ deleted: res\.deleted, messages: res\.messages/);
  assert.match(src, /case "sessions\.export":/);
  assert.match(src, /exportSessionTranscript\(service\.store, row/); // same artifacts as the CLI (#20)
  assert.match(src, /content: summary/); // browser downloads directly
  assert.match(src, /setSessionArchived\(key, params\["archived"\]\)/);
  assert.match(src, /archived: Number\(row\?\.archived \?\? 0\) === 1/);
  assert.match(src, /includeArchived: params\["includeArchived"\] === true/);
});

test("ui: session row menu (rename/export/archive/delete), archived grouping, banner, prune two-step", () => {
  const main = readFileSync(new URL("../ui/src/main.ts", import.meta.url), "utf8");
  assert.match(main, /includeArchived: true/);
  assert.match(main, /openSessionMenu\(s,/);
  assert.match(main, /item\("Rename…", /);
  assert.match(main, /item\("Export transcript \(\.md\)", /);
  assert.match(main, /item\(archived \? "Unarchive" : "Archive", /);
  assert.match(main, /item\("Delete…", /);
  assert.match(main, /menu__item--danger/); // their destructive-action styling
  assert.match(main, /window\.confirm\(`Delete session/); // confirmation required
  // export downloads in the browser AND points at the CLI artifact dir
  assert.match(main, /new Blob\(\[res\.content\]/);
  assert.match(main, /also saved under \$\{res\.dir\}/);
  // archived grouping + composer lock + unarchive action
  assert.match(main, /sessions__group/);
  assert.match(main, /chat\.setArchived\(Number\(curRow\?\.archived/);
  assert.match(main, /setSessionArchived\(sessionKey, false\)/);
  // prune: dry-run report → confirm with counts → enforce
  assert.match(main, /sessions\.cleanup", \{ dryRun: true \}/);
  assert.match(main, /sessions\.cleanup", \{ enforce: true \}/);
  assert.match(main, /window\.confirm\(/);

  const chat = readFileSync(new URL("../ui/src/chat.ts", import.meta.url), "utf8");
  assert.match(chat, /setArchived\(archived: boolean/);
  assert.match(chat, /archived-banner/);
  assert.match(chat, /unarchive-btn/);
  assert.match(chat, /this\.#input\.disabled = archived/);

  const html = readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
  assert.match(html, /id="sessions-prune"/);

  const css = readFileSync(new URL("../ui/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.menu__item/);
  assert.match(css, /\.archived-banner/);
  assert.match(css, /\.session--archived/);
});
