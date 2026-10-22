// P3 (row Missing!#21) — memory session-backfill / rem-backfill / rollback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { Store, sessionBackfill, rollbackBackfill, readRemSources, remBackfill, memoryCmd } = await import("../dist/lib.js");

const DAY = 86_400_000;

function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "sc-mem-"));
  const store = Store.open(join(dir, "state.sqlite"));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const now = Date.now();
  const seedSession = (key, daysAgo, texts) => {
    const s = store.ensureSession(key);
    for (const [i, t] of texts.entries()) {
      const at = now - daysAgo * DAY + i * 1000;
      store.db.prepare("INSERT INTO messages(session_id, role, content, created_at) VALUES(?, 'user', ?, ?)").run(s.id, t, at);
    }
    store.db.prepare("UPDATE sessions SET last_msg_at = ? WHERE id = ?").run(now - daysAgo * DAY, s.id);
    return s;
  };
  return { store, workspace, dir, now, seedSession };
}

test("preview is read-only: grouped oldest-first, lanes excluded, secrets masked", () => {
  const { store, workspace, now, seedSession } = setup();
  seedSession("main", 3, ["We decided the release cadence stays weekly for now."]);
  seedSession("main", 1, ["And staging must stay green before every single deploy."]);
  seedSession("cron:daily", 4, ["cron lane text here is never ingested ever."]);
  seedSession("subagent:x", 4, ["subagent lane is also out of scope fully."]);
  seedSession("main", 2, ["api_key sk-1234567890abcdef1234567890abcdef"]);
  const report = sessionBackfill(store, workspace, "preview", {});
  assert.equal(report.mode, "preview");
  const days = report.days.map((d) => d.day);
  assert.deepEqual(days, [...days].sort(), "oldest unprocessed day first");
  assert.ok(!report.days.some((d) => d.newLines > 0 && d.day === localDay(now - 4 * DAY)), "cron/subagent lanes never surface");
  assert.equal(report.days.find((d) => d.day === localDay(now - 2 * DAY))?.secretMasked, 1, "secret-shaped counted, never staged");
  assert.equal(report.staged, 0);
  assert.equal(report.hashesTracked, 0);
  assert.equal(existsSync(join(workspace, "DREAMS.md")), false, "preview writes no diary");
  store.close();
});

test("--limit-days caps DISTINCT days like their day budget", () => {
  const { store, workspace, seedSession } = setup();
  for (const d of [5, 4, 3, 2, 1]) seedSession("main", d, [`note for day ${d} with enough length to pass admission.`]);
  const one = sessionBackfill(store, workspace, "preview", { limitDays: 1 });
  assert.equal(one.daysProcessed, 1);
  store.close();
});

test("--apply stages, tracks hashes, writes a reversible diary — re-run finds nothing new (their drained-apply rule)", () => {
  const { store, workspace, now, seedSession } = setup();
  seedSession("main", 2, ["First durable fact about the payment rollout plan."]);
  const first = sessionBackfill(store, workspace, "apply", {});
  assert.equal(first.staged, 1);
  assert.equal(first.hashesTracked, 1);
  assert.equal(first.diaryBlocks, 1);
  const diary = readFileSync(join(workspace, "DREAMS.md"), "utf8");
  assert.match(diary, /<!-- sc-backfill:apply:/);
  assert.match(diary, /payment rollout plan/);
  // Origin rows land BEFORE text and let a second apply skip everything.
  const second = sessionBackfill(store, workspace, "apply", {});
  assert.equal(second.staged, 0);
  assert.equal(second.days.every((d) => d.newLines === 0), true, "tracked hashes skip re-ingestion");
  // MEMORY.md never touched by backfill (their rule).
  assert.equal(existsSync(join(workspace, "MEMORY.md")), false);
  store.close();
});

test("rem mode: diary + origin records only — no candidates staged (their REM shape)", () => {
  const { store, workspace, seedSession } = setup();
  seedSession("main", 2, ["Another fact for rem preview style checking today."]);
  const report = sessionBackfill(store, workspace, "rem", {});
  assert.equal(report.staged, 0);
  assert.equal(report.diaryBlocks, 1);
  assert.ok(report.hashesTracked > 0, "REM retains origin bookkeeping");
  assert.equal(store.dreamCandidates({ via: "backfill" }).length, 0);
  store.close();
});

test("shared rollback removes candidates, tracked hashes, and diary blocks — material is re-appliable", () => {
  const { store, workspace, seedSession } = setup();
  seedSession("main", 2, ["Rollback everything later fact about the migration window."]);
  sessionBackfill(store, workspace, "apply", {});
  assert.equal(store.dreamCandidates({ via: "backfill" }).length, 1);
  const removed = rollbackBackfill(store, workspace);
  assert.deepEqual(removed, { candidates: 1, hashes: 1, diaryBlocks: 1, diaryPath: join(workspace, "DREAMS.md") });
  const diary = readFileSync(join(workspace, "DREAMS.md"), "utf8");
  assert.equal(/sc-backfill/.test(diary), false, "marked blocks stripped");
  const again = sessionBackfill(store, workspace, "apply", {});
  assert.equal(again.staged, 1, "hashes rewound → eligible again (their rule)");
  rollbackBackfill(store, workspace);
  store.close();
});

test("--from/--to window clamps which days are processed", () => {
  const { store, workspace, now, seedSession } = setup();
  seedSession("main", 10, ["Older fact far outside the requested window frame."]);
  seedSession("main", 2, ["Recent fact sitting inside the requested window."]);
  const report = sessionBackfill(store, workspace, "preview", { fromDay: localDay(now - 5 * DAY) });
  assert.deepEqual(report.days.map((d) => d.day), [localDay(now - 2 * DAY + 0)]);
  const until = sessionBackfill(store, workspace, "preview", { toDay: localDay(now - 5 * DAY) });
  assert.deepEqual(until.days.map((d) => d.day), [localDay(now - 10 * DAY)]);
  store.close();
});

test("rem-backfill --path: historical dailies → diary; staging only with --stage-short-term", () => {
  const { store, workspace } = setup();
  const notesDir = join(workspace, "memory");
  mkdirSync(notesDir, { recursive: true });
  writeFileSync(join(notesDir, "2026-09-01.md"), "# notes\n- We onboarded the Beta tenant with a custom SSO mapping rule.\n");
  writeFileSync(join(notesDir, "2026-09-02.md"), "# notes\n- api_key sk-aaaabbbbccccddddeeeeffff00001111 keep masked.\n");
  const { files } = readRemSources(notesDir);
  assert.equal(files.length, 2);
  assert.equal(files[0].day, "2026-09-01");
  assert.equal(files[1].lines.length, 0, "secret-shaped lines never surface");
  const dry = remBackfill(store, workspace, files, {});
  assert.equal(dry.diaryBlocks, 1);
  assert.equal(dry.staged, 0);
  assert.equal(store.dreamCandidates({ via: "backfill" }).length, 0);
  const staged = remBackfill(store, workspace, files, { stageShortTerm: true });
  assert.equal(staged.staged, 1);
  // Shared rollback strips rem-backfill artifacts too (their overlap rule).
  const removed = rollbackBackfill(store, workspace);
  assert.ok(removed.diaryBlocks >= 2);
  assert.equal(store.dreamCandidates({ via: "backfill" }).length, 0);
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

test("memoryCmd: status/search surface + owner refusal for destructive runs (their ownership rule)", async () => {
  const { store, workspace, seedSession } = setup();
  writeFileSync(join(workspace, "MEMORY.md"), "- The golden rule of the workspace memory file.\n");
  seedSession("main", 2, ["A CLI-checkable durable fact for the reporters line."]);
  const live = () => ({ running: true, pid: 777 });

  const apply = await captured(() => memoryCmd(["session-backfill", "--apply"], { store, workspace, owner: live }));
  assert.equal(apply.code, 1);
  assert.match(apply.text, /refusing: the gateway holds the memory store \(pid 777\)/);

  const asserted = await captured(() => memoryCmd(["session-backfill", "--apply", "--yes"], { store, workspace, owner: live }));
  assert.equal(asserted.code, 0, "--yes asserts exclusive offline maintenance");
  assert.match(asserted.text, /staged 1, tracked 1 hashes/);

  const preview = await captured(() => memoryCmd(["session-backfill"], { store, workspace, owner: live }));
  assert.equal(preview.code, 0, "previews stay available while the gateway runs");
  assert.match(preview.text, /read-only preview/);

  const search = await captured(() => memoryCmd(["search", "golden", "--json"], { store, workspace, owner: live }));
  assert.equal(search.code, 0);
  const parsed = JSON.parse(search.text);
  assert.ok(parsed.results.length >= 1);
  assert.match(parsed.results[0].snippet, /golden rule/);

  const both = await captured(() => memoryCmd(["session-backfill", "--rem", "--apply"], { store, workspace })); 
  assert.equal(both.code, 2);
  assert.match(both.text, /mutually exclusive/);

  const rollback = await captured(() => memoryCmd(["session-backfill", "--rollback"], { store, workspace, owner: live }));
  assert.equal(rollback.code, 1, "rollback is destructive → same refusal");
  store.close();
});
