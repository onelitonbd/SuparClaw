// P3 (row Missing!#19) — session pruning / archive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  Store,
  parseDurationMs,
  parseByteSize,
  settingsFromConfig,
  runSessionMaintenance,
  parseCleanupArgs,
  formatCleanupReport,
  cmdSessionsCleanup,
} = await import("../dist/lib.js");

const DAY = 86_400_000;

// ---- units -------------------------------------------------------------------

test("parseDurationMs accepts their spellings; junk is rejected", () => {
  assert.equal(parseDurationMs("30d"), 30 * DAY);
  assert.equal(parseDurationMs("12h"), 12 * 3_600_000);
  assert.equal(parseDurationMs("90m"), 90 * 60_000);
  assert.equal(parseDurationMs("45s"), 45_000);
  assert.equal(parseDurationMs("1500ms"), 1500);
  assert.equal(parseDurationMs("2 weeks"), 14 * DAY);
  assert.equal(parseDurationMs(5000), 5000);
  assert.equal(parseDurationMs(""), null);
  assert.equal(parseDurationMs("0"), null, "\"0\" disables (their false/0 rule)");
  assert.equal(parseDurationMs(false), null);
  assert.equal(parseDurationMs("banana"), null);
});

test("parseByteSize: 1024-based, 10gb default shape, 0 disables", () => {
  assert.equal(parseByteSize("10gb"), 10 * 1024 ** 3);
  assert.equal(parseByteSize("512mb"), 512 * 1024 ** 2);
  assert.equal(parseByteSize("1g"), 1024 ** 3);
  assert.equal(parseByteSize("2048"), 2048);
  assert.equal(parseByteSize("10 GB"), 10 * 1024 ** 3);
  assert.equal(parseByteSize("0"), null);
  assert.equal(parseByteSize(""), null);
});

// ---- settings ------------------------------------------------------------

const DEFAULTS = { mode: "enforce", pruneAfter: "30d", maxEntries: 5000, preserveRecent: "", maxDiskBytes: "10gb", highWaterBytes: "" };

test("defaults mirror their session.maintenance contract", () => {
  const s = settingsFromConfig(DEFAULTS);
  assert.equal(s.mode, "enforce");
  assert.equal(s.pruneAfterMs, 30 * DAY);
  assert.equal(s.maxEntries, 5000);
  assert.equal(s.preserveRecentMs, null);
  assert.equal(s.maxDiskBytes, 10 * 1024 ** 3);
  assert.equal(s.highWaterBytes, Math.floor(10 * 1024 ** 3 * 0.8), "default high-water = 80% of budget");
  assert.deepEqual(s.errors, []);
});

test("bad values surface as errors, never silently", () => {
  const s = settingsFromConfig({ ...DEFAULTS, pruneAfter: "later", maxDiskBytes: "lots" });
  assert.equal(s.pruneAfterMs, 30 * DAY, "falls back to the documented default");
  assert.equal(s.maxDiskBytes, null);
  assert.equal(s.errors.length, 2);
});

// ---- engine ---------------------------------------------------------------

function makeStore(n = 0) {
  const dir = mkdtempSync(join(tmpdir(), "sc-maint-"));
  const file = join(dir, "state.sqlite");
  const store = Store.open(file);
  return { store, file, dir };
}

function seed(store, rows) {
  const now = Date.now();
  return rows.map((r) => {
    const s = store.ensureSession(r.key);
    store.appendMessage(s.id, "user", r.text ?? "hello ".repeat(50));
    store.db.prepare("UPDATE sessions SET last_msg_at = ? WHERE id = ?").run(r.lastMsgAt ?? now - (r.ageDays ?? 0) * DAY, s.id);
    return s;
  });
}
const settings = (over = {}) => settingsFromConfig({ ...DEFAULTS, ...over });

test("pruneAfter archives eligible sessions in place — ids + history survive", () => {
  const { store } = makeStore();
  const [old, fresh] = seed(store, [{ key: "old", ageDays: 40 }, { key: "fresh", ageDays: 2 }]);
  const report = runSessionMaintenance(store, settings({ maxDiskBytes: "999tb" }));
  assert.equal(report.applied, true);
  assert.equal(report.archivedAge, 1);
  assert.equal(report.afterCount, 1);
  const row = store.getSession(old.id);
  assert.equal(row.archived, 1);
  assert.equal(row.archive_reason, "age-retention", "their archiveReason");
  assert.equal(store.getSessionByKey("old").key, "old", "id/key preserved");
  assert.deepEqual(store.listSessions().map((s) => s.key), ["fresh"], "archived rows leave the visible list");
  assert.deepEqual(store.listSessions(50, { includeArchived: true }).length, 2, "history still resolvable");
  // Re-run is idempotent (nothing newly eligible).
  assert.equal(runSessionMaintenance(store, settings({ maxDiskBytes: "999tb" })).archivedAge, 0);
  store.close();
});

test("live runs and preserveRecent shield sessions from age cleanup", () => {
  const { store } = makeStore();
  seed(store, [
    { key: "busy", ageDays: 90 },
    { key: "recent-interactive", ageDays: 40 },
    { key: "stale", ageDays: 60 },
  ]);
  const report = runSessionMaintenance(store, settings({ maxDiskBytes: "999tb", preserveRecent: "45d" }), {
    activeKeys: ["busy"],
  });
  assert.equal(report.archivedAge, 1, "only the unprotected stale row archives");
  assert.equal(store.getSessionByKey("stale").archived, 1);
  assert.equal(store.getSessionByKey("busy").archived ?? 0, 0);
  assert.equal(store.getSessionByKey("recent-interactive").archived ?? 0, 0, "preserveRecent protected it");
  store.close();
});

test("maxEntries caps unarchived rows; protected rows report keep and can leave the store above cap", () => {
  const { store } = makeStore();
  seed(store, [
    { key: "p1", ageDays: 9 }, { key: "s2", ageDays: 8 }, { key: "s3", ageDays: 7 },
    { key: "s4", ageDays: 6 }, { key: "s5", ageDays: 5 },
  ]);
  const report = runSessionMaintenance(store, settings({ pruneAfter: "100d", maxEntries: 2, maxDiskBytes: "999tb" }), {
    activeKeys: ["p1"],
  });
  assert.equal(report.archivedCap, 3, "3-cap evictions: protected p1 shifts which rows go");
  assert.equal(report.kept, 1);
  assert.equal(report.actions.find((a) => a.action === "keep")?.key, "p1");
  assert.equal(report.afterCount, 2, "{p1 protected, s5 newest} remain");
  for (const key of ["s2", "s3", "s4"]) assert.equal(store.getSessionByKey(key).archive_reason, "capacity");
  store.close();
});

test("warn mode reports actions without writing; --enforce applies them", () => {
  const { store } = makeStore();
  seed(store, [{ key: "old", ageDays: 40 }]);
  const warn = runSessionMaintenance(store, settings({ mode: "warn", maxDiskBytes: "999tb" }));
  assert.equal(warn.applied, false);
  assert.equal(warn.archivedAge, 1, "the would-be action is reported");
  assert.equal(store.getSessionByKey("old").archived ?? 0, 0, "warn mode writes nothing");
  const dry = runSessionMaintenance(store, settings(), { dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(store.getSessionByKey("old").archived ?? 0, 0, "dry-run writes nothing");
  const enforced = runSessionMaintenance(store, settings({ mode: "warn", maxDiskBytes: "999tb" }), { enforce: true });
  assert.equal(enforced.applied, true);
  assert.equal(store.getSessionByKey("old").archived, 1);
  store.close();
});

test("disk budget: over-budget evicts oldest archive-cap rows; age-retention stays protected", () => {
  const { store } = makeStore();
  const now = Date.now();
  // 3 rows: oldest capacity-archived, middle age-archived, youngest live.
  const rows = seed(store, [{ key: "cap1", ageDays: 90, text: "x".repeat(4000) }, { key: "age1", ageDays: 80, text: "x".repeat(4000) }, { key: "live", ageDays: 1, text: "x".repeat(4000) }]);
  store.db.prepare("UPDATE sessions SET archived = 1, archived_at = ?, archive_reason = 'capacity' WHERE key = 'cap1'").run(now - 10 * DAY);
  store.db.prepare("UPDATE sessions SET archived = 1, archived_at = ?, archive_reason = 'age-retention' WHERE key = 'age1'").run(now - 9 * DAY);
  let measured = 10_000;
  const diskBytes = () => measured;
  const budgeted = settings({ pruneAfter: "100d", maxEntries: 100, maxDiskBytes: "8kb", highWaterBytes: "6kb" });
  // 10gb → use literal strings: maxDiskBytes "8388608", highWater "6291456"
  const report = runSessionMaintenance(store, budgeted, { diskBytes });
  assert.equal(report.overBudget, true);
  assert.equal(report.deletedCapArchives, 1, "one oldest cap archive evicted");
  assert.equal(report.actions.filter((a) => a.action === "delete-cap-archive")[0]?.key, "cap1");
  assert.equal(store.getSessionByKey("cap1"), undefined, "evicted row + messages gone");
  assert.ok(store.getSessionByKey("age1"), "age-retention archive protected");
  assert.ok(store.getSessionByKey("live"), "live row protected");
  // warn mode: flagged, nothing removed (same simulated 10k > 8kb budget)
  const warnReport = runSessionMaintenance(store, settings({ mode: "warn", pruneAfter: "100d", maxEntries: 100, maxDiskBytes: "8kb", highWaterBytes: "6kb" }), { diskBytes: () => 10_000 });
  assert.equal(warnReport.overBudget, true);
  assert.equal(warnReport.applied, false);
  assert.equal(store.listSessions(50, { includeArchived: true }).length, 2);
  void rows; void now;
  store.close();
});

// ---- CLI surface -----------------------------------------------------------

test("parseCleanupArgs: their flag set + usage errors", () => {
  const a = parseCleanupArgs(["--dry-run", "--enforce", "--active-key", "k1", "--active-key", "k2", "--store", "/tmp/x.sqlite", "--json"]);
  assert.deepEqual([a.dryRun, a.enforce, a.activeKeys, a.store, a.json], [true, true, ["k1", "k2"], "/tmp/x.sqlite", true]);
  assert.match(parseCleanupArgs(["--bogus"]).error, /unknown/);
  assert.match(parseCleanupArgs(["--active-key"]).error, /unknown or incomplete/);
});

test("formatCleanupReport renders the action table + dry-run footer", () => {
  const { store } = makeStore();
  seed(store, [{ key: "old", ageDays: 40 }]);
  const report = runSessionMaintenance(store, settings({ maxDiskBytes: "999tb" }), { dryRun: true });
  const text = formatCleanupReport(report);
  assert.match(text, /archive-age/);
  assert.match(text, /mode=enforce \(not applied\) \u00b7 unarchived 1 \u2192 0/);
  assert.match(text, /dry-run — nothing was applied/);
  store.close();
});

async function captured(fn) {
  const lines = [];
  const origOut = console.log;
  const origErr = console.error;
  console.log = (s) => lines.push(String(s));
  console.error = (s) => lines.push(String(s));
  try {
    const code = await fn();
    return { code, text: lines.join("\n") };
  } finally {
    console.log = origOut;
    console.error = origErr;
  }
}

test("offline destructive cleanup REFUSES while a live gateway owns the state (their ownership rule)", async () => {
  const { store, file } = makeStore();
  seed(store, [{ key: "old", ageDays: 40 }]);
  store.close();
  const openStore = () => Store.open(file);
  // ParityProbe regression: previous run restored AGENT_ROOT and another
  // process spawned cmdSessionsCleanup against our state while owner()
  // reported the real gateway status. children share their owner's PID list,
  // so the refusal pattern must survive exact-pid spoofing if the owner
  // delegation path claimed the same live gateway (their "names the owner"
  // requirement). The probe hands us a planted running flag.
  const { code, text } = await captured(() =>
    cmdSessionsCleanup([], { owner: () => ({ running: true, pid: 4321 }), openStore, defaultDbPath: () => file }),
  );
  assert.equal(code, 1);
  assert.match(text, /refusing destructive local cleanup/);
  assert.match(text, /pid 4321/);
  // …but a dry-run preview must work ANY time, gateway running or not.
  const dry = await captured(() =>
    cmdSessionsCleanup(["--dry-run"], { owner: () => ({ running: true, pid: 4321 }), openStore, defaultDbPath: () => file }),
  );
  assert.equal(dry.code, 0);
  assert.match(dry.text, /dry-run — nothing was applied/);
  // Applied offline (gateway stopped): the archive really lands.
  const applied = await captured(() =>
    cmdSessionsCleanup([], { owner: () => ({ running: false, pid: null }), openStore, defaultDbPath: () => file }),
  );
  assert.equal(applied.code, 0);
  const check = Store.open(file);
  assert.equal(check.getSessionByKey("old").archived, 1);
  check.close();
});

test("a reachable gateway wins: delegation returns its report (busy sessions protected there)", async () => {
  const { code, text } = await captured(() =>
    cmdSessionsCleanup(["--dry-run"], {
      delegate: async () => ({ mode: "enforce", applied: false, dryRun: true, beforeCount: 5, afterCount: 4, archivedAge: 1, archivedCap: 0, kept: 1, deletedCapArchives: 0, freedBytes: 0, diskBytes: null, highWaterBytes: null, overBudget: false, actions: [{ action: "archive-age", key: "stale", ageMs: 40 * DAY }], errors: [] }),
      owner: () => ({ running: true, pid: 1 }),
    }),
  );
  assert.equal(code, 0);
  assert.match(text, /unarchived 5 → 4/);
  assert.match(text, /1 protected/);
});

test("--store is the explicit offline-repair assertion: allowed even with a live owner", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-storefix-"));
  const file = join(dir, "state.sqlite");
  writeFileSync(file, "");
  const s1 = Store.open(file);
  seed(s1, [{ key: "old", ageDays: 40 }]);
  s1.close();
  const openStore = (p) => Store.open(p);
  const { code, text } = await captured(() =>
    cmdSessionsCleanup(["--store", file], { owner: () => ({ running: true, pid: 999 }) }),
  );
  assert.equal(code, 0, "--store bypasses the ownership refusal like its offline path");
  assert.match(text, /archived 1/);
  const check = Store.open(file);
  assert.equal(check.getSessionByKey("old").archived, 1);
  check.close();
  void openStore;
});
