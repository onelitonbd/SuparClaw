// P3 (row Missing!#20) — transcript export (their openclaw transcripts port).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  Store,
  exportSlug,
  resolveSessionSelector,
  exportSessionTranscript,
  parseExportArgs,
  cmdSessionsExport,
} = await import("../dist/lib.js");

const DAY = 86_400_000;

function seedStore() {
  const dir = mkdtempSync(join(tmpdir(), "sc-export-"));
  const store = Store.open(join(dir, "state.sqlite"));
  const now = Date.now();
  const mk = (key, ageDays, text) => {
    const s = store.ensureSession(key);
    store.appendMessage(s.id, "user", text ?? `ask about ${key}`);
    store.appendMessage(s.id, "assistant", `answer for ${key}`);
    store.db.prepare("UPDATE sessions SET created_at = ?, last_msg_at = ? WHERE id = ?")
      .run(now - (ageDays + 1) * DAY, now - ageDays * DAY, s.id);
    return s;
  };
  const a = mk("alpha", 40);
  const b = mk("beta", 2);
  store.startRun(a.id, "run-1");
  store.finishRun("run-1", "done", { input: 10, output: 20 }, undefined, "gpt-test");
  store.setSummary(a.id, 1, "A compacted-era summary of alpha.", 120);
  return { store, dir, a, b };
}

test("exportSlug: filesystem-safe; oversized names get the sha-256 suffix (their rule)", () => {
  assert.equal(exportSlug("daily run"), "daily run");
  assert.equal(exportSlug("notes: room/one"), "notes- room-one");
  const huge = `meeting-${"x".repeat(400)}`;
  const slug = exportSlug(huge);
  assert.ok(slug.length <= 255);
  assert.match(slug, /-[0-9a-f]{16}$/, "prefix + sha256 of the FULL key");
  assert.equal(exportSlug(huge), slug, "deterministic");
});

test("selectors: exact key, dated qualification, unique prefix, ambiguity refused", () => {
  const { store } = seedStore();
  assert.equal(resolveSessionSelector(store, "alpha").row?.key, "alpha");
  const dated = `${new Date(store.getSessionByKey("alpha").created_at).toISOString().slice(0, 10)}/alpha`;
  assert.equal(resolveSessionSelector(store, dated).row?.key, "alpha", "their YYYY-MM-DD/<key> form");
  assert.match(resolveSessionSelector(store, "1970-01-01/alpha").error ?? "", /starts .+ not 1970-01-01/);
  assert.equal(resolveSessionSelector(store, "bet").row?.key, "beta", "unique prefix convenience");
  // Ambiguity: two keys sharing a prefix NEITHER of which matches exactly
  // (exact matches win first — their selector priority).
  store.ensureSession("note one");
  store.ensureSession("note two");
  const amb = resolveSessionSelector(store, "note");
  assert.match(amb.error ?? "", /ambiguous selector/, "several matches = error, never silent");
  assert.match(amb.error, /YYYY-MM-DD/);
  store.close();
});

test("export materializes metadata.json + transcript.jsonl + summary.md under the date dir", () => {
  const { store, dir, a } = seedStore();
  const root = join(dir, "transcripts");
  const result = exportSessionTranscript(store, store.getSession(a.id), root);
  assert.equal(result.ok, true);
  const date = new Date(store.getSession(a.id).created_at).toISOString().slice(0, 10);
  assert.equal(result.selector, `${date}/alpha`);
  const files = readdirSync(result.artifacts.dir).sort();
  assert.deepEqual(files, ["metadata.json", "summary.md", "transcript.jsonl"]);
  const meta = JSON.parse(readFileSync(result.artifacts.metadata, "utf8"));
  assert.equal(meta.key, "alpha");
  assert.equal(meta.messageCount, 2);
  assert.equal(meta.runCount, 1);
  assert.deepEqual(meta.models, ["gpt-test"]);
  const jsonl = readFileSync(result.artifacts.transcript, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(jsonl.length, 2);
  assert.equal(jsonl[0].role, "user");
  assert.ok(jsonl[0].content.includes("ask about alpha"));
  const md = readFileSync(result.artifacts.summary, "utf8");
  assert.match(md, /# Transcript — alpha/);
  assert.match(md, /👤 User/);
  assert.match(md, /🤖 Assistant/);
  assert.match(md, /Compacted context summary/);
  assert.match(md, /A compacted-era summary of alpha\./);
  store.close();
});

test("archived sessions export exactly like live ones (they stay addressable)", () => {
  const { store, dir, a } = seedStore();
  store.archiveSession(a.id, "age-retention", Date.now());
  const result = exportSessionTranscript(store, store.getSession(a.id), join(dir, "transcripts"));
  assert.equal(result.ok, true);
  const md = readFileSync(result.artifacts.summary, "utf8");
  assert.match(md, /archived: yes \(age-retention/);
  const meta = JSON.parse(readFileSync(result.artifacts.metadata, "utf8"));
  assert.equal(meta.archived, true);
  store.close();
});

test("parseExportArgs + cmd exit codes; --dir prints only the directory (their path semantics)", async () => {
  assert.match(parseExportArgs([]).error, /usage: sc sessions export/);
  assert.match(parseExportArgs(["a", "b"]).error, /duplicate/);
  assert.deepEqual(parseExportArgs(["alpha", "--dir"]).only, "dir");

  const { store, dir } = seedStore();
  const lines = [];
  const orig = console.log;
  console.log = (s) => lines.push(String(s));
  let code = cmdSessionsExport(["alpha", "--dir"], { store, transcriptsRoot: join(dir, "t") });
  console.log = orig;
  assert.equal(code, 0);
  assert.equal(lines.length, 1);
  assert.ok(existsSync(lines[0]), "the printed dir exists (materialized)");
  assert.equal(lines[0].endsWith(join("alpha")), true);

  // unknown selector → 1
  const errs = [];
  const origErr = console.error;
  console.error = (s) => errs.push(String(s));
  code = cmdSessionsExport(["ghost"], { store, transcriptsRoot: join(dir, "t") });
  console.error = origErr;
  assert.equal(code, 1);
  assert.match(errs.join("\n"), /no session matches/);
  store.close();
});
