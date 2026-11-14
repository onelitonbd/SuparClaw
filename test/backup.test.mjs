// P3 (row Missing!#29) — sc backup: local archives, verify, restore.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.SUPARCLAW_HOME = mkdtempSync(join(tmpdir(), "sc-backup-"));
const { createBackup, verifyBackup, restoreBackup, listBackups } = await import("../dist/lib.js");

function makeState(home) {
  const state = join(home, ".suparclaw");
  mkdirSync(join(state, "workspace", "notes"), { recursive: true });
  mkdirSync(join(state, "logs"), { recursive: true });
  writeFileSync(join(state, "config.json5"), "{ agents: { defaults: { model: 'test/model' } } }\n");
  writeFileSync(join(state, "workspace", "notes", "hello.md"), "# hello\n");
  writeFileSync(join(state, "logs", "gateway.log"), "line1\n");
  writeFileSync(join(state, "gateway.pid"), "12345"); // runtime file — must not be archived
  const db = new DatabaseSync(join(state, "state.sqlite"));
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  db.prepare("INSERT INTO t (v) VALUES (?)").run("backup-me");
  db.close();
  return state;
}

test("backup create → verify → restore round trip (config bytes preserved, sqlite snapshot consistent)", async () => {
  const home = mkdtempSync(join(tmpdir(), "sc-backup-rt-"));
  process.env.SUPARCLAW_HOME = home;
  const state = makeState(home);
  const outDir = mkdtempSync(join(tmpdir(), "sc-backup-out-"));

  const res = await createBackup({ outputDir: outDir, verify: true });
  assert.ok(res.archivePath.endsWith("-suparclaw-backup.tar.gz"));
  assert.equal(res.verified, true);
  assert.ok(res.files >= 4); // config + db + workspace note + log

  // filename carries the local UTC offset (their filename rule)
  assert.match(res.archivePath, /\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}[+-]\d{2}-\d{2}-suparclaw-backup\.tar\.gz$/);

  const v = await verifyBackup(res.archivePath);
  assert.equal(v.ok, true, v.errors.join("; "));
  assert.equal(v.sqliteOk, true); // PRAGMA integrity_check over the archived snapshot

  const target = join(mkdtempSync(join(tmpdir(), "sc-backup-dest-")), "restored");
  const r = await restoreBackup(res.archivePath, target);
  assert.ok(r.restored >= 4);
  // config bytes identical (their authored-bytes rule)
  assert.equal(readFileSync(join(target, "config.json5"), "utf8"), readFileSync(join(state, "config.json5"), "utf8"));
  assert.equal(readFileSync(join(target, "workspace", "notes", "hello.md"), "utf8"), "# hello\n");
  // runtime pid + db sidecars excluded
  assert.equal(existsSync(join(target, "gateway.pid")), false);
  assert.equal(existsSync(join(target, "state.sqlite-wal")), false);
  // restored sqlite opens and holds the committed row (their online-snapshot rule)
  const db = new DatabaseSync(join(target, "state.sqlite"), { readOnly: true });
  const row = db.prepare("SELECT v FROM t").get();
  db.close();
  assert.equal(row.v, "backup-me");
});

test("guards — output inside source trees rejected; dry-run writes nothing; list works", async () => {
  const home = mkdtempSync(join(tmpdir(), "sc-backup-guard-"));
  process.env.SUPARCLAW_HOME = home;
  makeState(home);
  const outDir = mkdtempSync(join(tmpdir(), "sc-backup-out2-"));

  const dry = await createBackup({ outputDir: outDir, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.archivePath, null);
  assert.ok(dry.files >= 4);
  assert.equal(listBackups(outDir).length, 0);

  await assert.rejects(() => createBackup({ outputDir: join(home, ".suparclaw") }), /inside the backed-up/);
  await assert.rejects(() => createBackup({ outputDir: join(home, ".suparclaw", "workspace") }), /inside the backed-up/);

  const one = await createBackup({ outputDir: outDir });
  const rows = listBackups(outDir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].file, one.archivePath);
  assert.ok(rows[0].size > 0);
});

test("--only-config exports the active config alone (their root-file export rule)", async () => {
  const home = mkdtempSync(join(tmpdir(), "sc-backup-cfg-"));
  process.env.SUPARCLAW_HOME = home;
  makeState(home);
  const outDir = mkdtempSync(join(tmpdir(), "sc-backup-out3-"));
  const res = await createBackup({ outputDir: outDir, onlyConfig: true });
  const v = await verifyBackup(res.archivePath);
  assert.equal(v.ok, true);
  assert.equal(v.files, 1);
  assert.equal(v.sqliteOk, null);
});

test("verify rejects tampered archives; restore refuses unverified archives", async () => {
  const home = mkdtempSync(join(tmpdir(), "sc-backup-tamper-"));
  process.env.SUPARCLAW_HOME = home;
  makeState(home);
  const outDir = mkdtempSync(join(tmpdir(), "sc-backup-out4-"));
  const res = await createBackup({ outputDir: outDir });
  const blob = readFileSync(res.archivePath);
  const tampered = join(outDir, "tampered-suparclaw-backup.tar.gz");
  const copy = Buffer.from(blob);
  copy[copy.length - 20] = copy[copy.length - 20] ^ 0xff;
  writeFileSync(tampered, copy);
  const v = await verifyBackup(tampered);
  assert.equal(v.ok, false);
  await assert.rejects(
    () => restoreBackup(tampered, join(mkdtempSync(join(tmpdir(), "sc-backup-bd-")), "x")),
    /refusing to restore/,
  );
});

test("restore refuses a non-empty target without force; long names round-trip", async () => {
  const home = mkdtempSync(join(tmpdir(), "sc-backup-long-"));
  process.env.SUPARCLAW_HOME = home;
  const state = makeState(home);
  const deep = join(state, "workspace", "a".repeat(60), "b".repeat(60));
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(deep, "deep-file.txt"), "deep\n");
  const outDir = mkdtempSync(join(tmpdir(), "sc-backup-out5-"));
  const res = await createBackup({ outputDir: outDir, verify: true });
  assert.equal(res.verified, true);
  const target = join(mkdtempSync(join(tmpdir(), "sc-backup-dest5-")), "r");
  await restoreBackup(res.archivePath, target);
  assert.equal(readFileSync(join(target, "workspace", "a".repeat(60), "b".repeat(60), "deep-file.txt"), "utf8"), "deep\n");
  await assert.rejects(() => restoreBackup(res.archivePath, target), /not empty/);
  const again = await restoreBackup(res.archivePath, target, { force: true });
  assert.ok(again.restored > 0);
});

test("cli surface — sc backup wired in dispatcher + help; never-overwrite + sqlite snapshot in impl", () => {
  const src = readFileSync(new URL("../src/cli/index.ts", import.meta.url), "utf8");
  assert.match(src, /case "backup":/);
  assert.match(src, /cmdBackup/);
  assert.match(src, /backup <create\|list\|verify\|restore>/);
  const impl = readFileSync(new URL("../src/backup/backup.ts", import.meta.url), "utf8");
  assert.match(impl, /VACUUM INTO/); // their online snapshot + compaction
  assert.match(impl, /manifest\.json/);
  assert.match(impl, /sha256/);
  assert.match(impl, /already exists/); // existing archives never overwritten
  assert.match(impl, /integrity_check/);
  const tar = readFileSync(new URL("../src/backup/tar.ts", import.meta.url), "utf8");
  assert.match(tar, /unsafe archive member/); // traversal refused at parse time
  assert.match(tar, /unsupported archive member type \(link\)/); // never write links
});
