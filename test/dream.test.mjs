// Partial #5 — dreaming depth: phased sweep (light staging, REM themes,
// deep six-signal scoring + gates), consolidation ops + append-only fallback,
// provenance (preimage, reports, rejection counts), and the backfill lanes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

process.env.SUPARCLAW_HOME = mkdtempSync(join(tmpdir(), "sc-dream-"));
const {
  Store,
  runSweep,
  lightFromFiles,
  lightFromTranscripts,
  lightStage,
  remThemes,
  deepDecide,
  parseConsolidation,
  applyConsolidationOps,
  appendOnlyPromotion,
  promotePreview,
  backfillPreview,
} = await import("../dist/lib.js");

const SC = join(process.cwd(), "dist", "sc.js");
const DAY = 86_400_000;
const NOW = Date.parse("2026-10-21T06:00:00Z");
const TODAY = "2026-10-21";

const openStore = () => Store.open(join(mkdtempSync(join(tmpdir(), "sc-ds-")), "state.sqlite"));
const wsDir = () => {
  const ws = mkdtempSync(join(tmpdir(), "sc-dws-"));
  mkdirSync(join(ws, "memory"), { recursive: true });
  return ws;
};
// Two-day-old + one-day-old notes with a repeated durable fact (a 2-signal
// cluster that passes gates), plus noise to prove filtering.
function seedNotes(ws) {
  writeFileSync(
    join(ws, "memory", "2026-10-19.md"),
    [
      "- gateway deployment runs on the homeserver box <!-- importance: 9 -->",
      "- milk the cat at six",
      "- x",
    ].join("\n"),
  );
  writeFileSync(
    join(ws, "memory", "2026-10-20.md"),
    "- gateway deployment runs on the homeserver box\n",
  );
  writeFileSync(join(ws, "memory", `${TODAY}.md`), "- gateway deployment surprise should NOT be staged today\n");
  writeFileSync(join(ws, "MEMORY.md"), "# Memory\n");
}

test("light: notes staging — dated only, today skipped, today's note out, shape bounds, annotations kept", () => {
  const ws = wsDir();
  writeFileSync(join(ws, "memory", "2026-10-19.md"), "- fallback zone configured today <!-- importance: 7 -->\n- hi\n");
  writeFileSync(join(ws, "memory", `${TODAY}.md`), "- this same-day line must not stage\n");
  writeFileSync(join(ws, "USER.md"), "- curated file — never raw material\n");
  const lines = lightFromFiles(ws, TODAY);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].source, "memory/2026-10-19.md");
  assert.equal(lines[0].importance, 7);
  assert.equal(lines[0].text, "fallback zone configured today");
});

test("light: transcript lanes — owner interactive only, plain roles, bounded", () => {
  const store = openStore();
  const put = (key, role, content) => {
    const s = store.ensureSession(key);
    store.appendMessage(s.id, role, content);
  };
  put("agent:main:main", "user", "the kanchenjunga trek plan needs two porters after all");
  put("agent:main:main", "assistant", "noted — kanchenjunga trek logistics updated in the plan");
  put("subagent:agent:main:main:x", "user", "lane chatter that must never become memory material");
  put("system:dream", "assistant", "dream pipeline chatter must not recurse into memory");
  put("agent:main:main", "tool", "tool rows are excluded per their ingestion eligibility");
  const lines = lightFromTranscripts(store, NOW);
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.source === "session:agent:main:main"));
  assert.ok(lines.every((l) => l.kind === "session"));
  store.close();
});

test("light: secret-shaped lines are masked+counted, exact dupes count as deduped", () => {
  const store = openStore();
  const mk = (text, source, day, kind = "note") => ({ text, source, day, kind, importance: null });
  const res = lightStage(
    store,
    [
      mk("gateway host sits behind the office gateway", "memory/2026-10-19.md", "2026-10-19"),
      mk("remember api_key = sk-abc123verysecretvalue", "memory/2026-10-19.md", "2026-10-19"),
      mk("gateway host sits behind the office gateway", "memory/2026-10-19.md", "2026-10-19"),
    ],
    "sweep",
  );
  assert.equal(res.staged, 1);
  assert.equal(res.rejected["secret-masked"], 1);
  assert.equal(res.rejected["deduped"], 1);
  store.close();
});

test("REM: concept tokens shared across sources become themes", () => {
  const store = openStore();
  const day = (n) => `2026-10-${n}`;
  for (const [text, source, d] of [
    ["kanchenjunga trek packing list reviewed", "memory/2026-10-19.md", day(19)],
    ["kanchenjunga trek route confirmed with agency", "memory/2026-10-20.md", day(20)],
    ["kanchenjunga trek guide permits collected", "session:agent:main:main", day(20)],
  ]) store.stageDreamCandidate({ text, source, day: d, kind: "note", importance: null, stagedVia: "sweep" });
  const themes = remThemes(store.dreamCandidates({}));
  assert.ok(themes.length > 0);
  assert.equal(themes[0].name, "kanchenjunga");
  assert.equal(themes[0].count, 3);
  store.close();
});

test("deep gates + clustering: repeated fact promotes, singleton decays below score", () => {
  const ws = wsDir();
  seedNotes(ws);
  const store = openStore();
  lightStage(store, lightFromFiles(ws, TODAY), "sweep");
  const decisions = deepDecide(store.dreamCandidates({}), [], ws, NOW);
  const byVerdict = Object.fromEntries(decisions.map((d) => [d.cluster.rep.text.slice(0, 20), d.verdict]));
  assert.ok(decisions.some((d) => d.verdict === "promote" && d.cluster.rep.text.includes("gateway deployment")), "2-signal cluster passes");
  const strong = decisions.find((d) => d.verdict === "promote");
  assert.equal(strong.cluster.members.length, 2, "identical lines across days form one cluster");
  assert.equal(strong.cluster.days.size, 2);
  const weak = decisions.find((d) => d.cluster.rep.text.includes("milk the cat"));
  assert.equal(weak.verdict, "few-signals", "a lone line cannot promote even with a fine score");
  assert.ok(strong.signals.score > 0.45, "gated cluster clears the score gate");
  store.close();
});

test("deep rehydration: promote-eligible snippet gone from its live file is stale-source", () => {
  const ws = wsDir();
  seedNotes(ws);
  const store = openStore();
  lightStage(store, lightFromFiles(ws, TODAY), "sweep");
  writeFileSync(
    join(ws, "memory", "2026-10-19.md"),
    "- gateway hosting moved off the homeserver entirely\n- milk the cat at six\n",
  );
  const decisions = deepDecide(store.dreamCandidates({}), [], ws, NOW);
  const d = decisions.find((x) => x.cluster.rep.source === "memory/2026-10-19.md" && x.signals.score >= 0.45 && x.cluster.members.length >= 2);
  assert.ok(d, "fixture yielded a would-promote candidate from 10-19");
  assert.equal(d.verdict, "stale-source");
  store.close();
});

test("consolidation JSON: strict parse, junk rejected, merge requires supersedes", () => {
  const good = parseConsolidation('noise {"ops":[{"op":"add","text":"gateway host at home","importance":8,"trigger":"gateway host","source":"memory/x.md"}],"diary":"Promoted the home gateway fact."} tail');
  assert.ok(good);
  assert.equal(good.ops[0].importance, 8);
  assert.equal(good.diary, "Promoted the home gateway fact.");
  assert.equal(parseConsolidation("not json at all"), null);
  const empty = parseConsolidation('{"ops":[]}');
  assert.ok(empty && empty.ops.length === 0, "empty ops list is a valid response");
  assert.equal(parseConsolidation('{"ops":[{"op":"merge","text":"x"}]}'), null);
  assert.equal(parseConsolidation('{"diary":"no ops key"}'), null);
});

test("consolidation apply: ops edit MEMORY.md, dangling merge becomes add, loss cap rejects rewrites", () => {
  const mem = ["# Memory", "- old fact alpha", "- old fact beta", "- old fact gamma", "- old fact delta"].join("\n");
  const add = applyConsolidationOps(mem, [{ op: "add", text: "new durable fact", importance: 5, source: "memory/2026-10-19.md" }]);
  assert.ok(add.accepted);
  assert.match(add.next, /- new durable fact <!-- importance: 5 --> <!-- Source: memory\/2026-10-19\.md -->/);
  const mrg = applyConsolidationOps(mem, [{ op: "merge", text: "alpha refined", supersedes: "old fact alpha" }]);
  assert.ok(mrg.accepted);
  assert.ok(mrg.next.includes("- alpha refined") && !mrg.next.includes("old fact alpha"));
  const dang = applyConsolidationOps(mem, [{ op: "merge", text: "standalone refined", supersedes: "no such line exists here" }]);
  assert.ok(dang.accepted && dang.next.includes("- standalone refined"));
  // Wiping 2 of 4 prior entries = 50% loss > 25% cap → whole rewrite rejected.
  const heavy = applyConsolidationOps(mem, [
    { op: "supersede", text: "gone", supersedes: "old fact alpha" },
    { op: "supersede", text: "gone", supersedes: "old fact beta" },
  ]);
  assert.equal(heavy.accepted, false);
  assert.equal(heavy.next, mem);
});

test("append-only fallback: gated candidates under a dated heading with provenance", () => {
  const ws = wsDir();
  seedNotes(ws);
  const store = openStore();
  lightStage(store, lightFromFiles(ws, TODAY), "sweep");
  const gated = deepDecide(store.dreamCandidates({}), [], ws, NOW).filter((d) => d.verdict === "promote");
  const out = appendOnlyPromotion("# Memory\n", gated, TODAY);
  assert.match(out.next, /## Promoted 2026-10-21/);
  assert.match(out.next, /gateway deployment runs on the homeserver (box|machine)/);
  assert.match(out.next, /<!-- Source: memory\/2026-10-(19|20)\.md -->/);
  assert.equal(out.added, 1);
  store.close();
});

test("runSweep end-to-end (fallback path): files, diary, reports, preimage, marking, verdict", () => {
  const ws = wsDir();
  seedNotes(ws);
  const store = openStore();
  const run = async () => runSweep({ store, workspace: ws, now: NOW });
  return run().then((verdict) => {
    assert.equal(verdict.promoted, 1);
    assert.equal(verdict.modelUsed, false);
    assert.match(verdict.summary, /append-only fallback/);
    const mem = readFileSync(join(ws, "MEMORY.md"), "utf8");
    assert.match(mem, /gateway deployment runs on the homeserver/);
    const diary = readFileSync(join(ws, "DREAMS.md"), "utf8");
    assert.match(diary, /## Deep Sleep - 2026-10-21/);
    for (const phase of ["light", "rem", "deep"]) {
      assert.ok(existsSync(join(ws, "memory", "dreaming", phase, `${TODAY}.md`)), `${phase} report`);
    }
    const deep = readFileSync(join(ws, "memory", "dreaming", "deep", `${TODAY}.md`), "utf8");
    assert.match(deep, /Rejection counts/);
    assert.match(deep, /few-signals: 1/);
    assert.ok(store.latestDreamPreimage(), "preimage stored before rewrite");
    // Only gated clusters are marked; the under-gated singleton persists in
    // the recall store (their rule: candidates stay until promoted or aged out).
    assert.equal(store.dreamCandidates({}).length, 1);
    assert.ok(store.dreamCandidates({})[0].text.includes("milk the cat"));
    const run0 = store.lastDreamRun();
    assert.match(run0.verdict, /promoted 1/);
    store.close();
  });
});

test("runSweep with model ops: merge applied, model diary line used, acceptance honored", () => {
  const ws = wsDir();
  seedNotes(ws);
  writeFileSync(join(ws, "MEMORY.md"), "# Memory\n\n- gateway deployment target is still unknown\n- alphas only\n- betas only\n- gammas only\n\n");
  const store = openStore();
  const llmComplete = async () =>
    JSON.stringify({
      ops: [
        {
          op: "merge",
          text: "gateway deployment runs on the homeserver",
          importance: 8,
          trigger: "gateway deployment",
          source: "memory/2026-10-20.md",
          supersedes: "gateway deployment target is still unknown",
        },
      ],
      diary: "The homeserver became the known gateway host.",
    });
  return runSweep({ store, workspace: ws, now: NOW, llmComplete }).then((verdict) => {
    assert.equal(verdict.modelUsed, true);
    assert.equal(verdict.merged, 1);
    assert.equal(verdict.promoted, 0);
    const mem = readFileSync(join(ws, "MEMORY.md"), "utf8");
    assert.match(mem, /- gateway deployment runs on the homeserver <!-- trigger: gateway deployment --> <!-- importance: 8 -->/);
    assert.ok(!mem.includes("still unknown"));
    const diary = readFileSync(join(ws, "DREAMS.md"), "utf8");
    assert.match(diary, /The homeserver became the known gateway host\./);
    store.close();
  });
});

test("recall log lifts relevance and query diversity signals", () => {
  const ws = wsDir();
  // No write-time importance here — recall-derived relevance must be visible.
  writeFileSync(
    join(ws, "memory", "2026-10-19.md"),
    "- gateway deployment runs on the homeserver box\n",
  );
  writeFileSync(
    join(ws, "memory", "2026-10-20.md"),
    "- gateway deployment runs on the homeserver box\n",
  );
  const store = openStore();
  lightStage(store, lightFromFiles(ws, TODAY), "sweep");
  const before = deepDecide(store.dreamCandidates({}), [], ws, NOW);
  const strong0 = before.find((d) => d.cluster.rep.text.includes("gateway deployment"));
  store.recordMemoryRecall("gateway deployment", ["memory/2026-10-20.md"]);
  store.recordMemoryRecall("homeserver plan", ["memory/2026-10-19.md", "memory/2026-10-20.md"]);
  const recalls = store.dreamRecalls(0);
  const after = deepDecide(store.dreamCandidates({}), recalls, ws, NOW);
  const strong1 = after.find((d) => d.cluster.rep.text.includes("gateway deployment"));
  assert.ok(strong1.signals.relevance > strong0.signals.relevance, "recall events raise relevance");
  assert.ok(strong1.signals.queryDiversity > 0, "distinct queries surface as diversity");
  store.close();
});

test("promote preview respects limit; backfill stages history and rollback removes only backfill rows", () => {
  const ws = wsDir();
  writeFileSync(join(ws, "memory", "2026-08-15.md"), "- ancient alpine router config backup plan<br>\n- ancient alpine router config restore run\n- ancient zebra habitat survey noted\n");
  const store = openStore();
  // live-window line: NOT a backfill target
  store.stageDreamCandidate({ text: "recent sweeping note over thirty chars long", source: "memory/2026-10-20.md", day: "2026-10-20", kind: "note", importance: null, stagedVia: "sweep" });
  const lines = backfillPreview(ws, 90);
  assert.ok(lines.length >= 3, "old note replayed");
  assert.ok(lines.every((l) => l.day === "2026-08-15"), "only beyond-window entries");
  const staged = lightStage(store, lines, "backfill").staged;
  assert.ok(staged >= 3);
  const preview = promotePreview(store, ws, 1);
  assert.equal(preview.length, 1, "limit");
  const removed = store.rollbackDreamBackfill();
  assert.equal(removed, staged);
  assert.equal(store.dreamCandidates({}).length, 1, "sweep-staged row survives rollback");
  store.close();
});

test("CLI: sc dream backfill preview → apply → rollback against a seeded home", () => {
  const home = mkdtempSync(join(tmpdir(), "sc-dcli-"));
  mkdirSync(join(home, ".suparclaw", "workspace", "memory"), { recursive: true });
  writeFileSync(
    join(home, ".suparclaw", "workspace", "memory", "2026-08-10.md"),
    "- backfilled glacier route documented properly and completely\n",
  );
  const run = (args) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [SC, "dream", ...args], {
        env: { ...process.env, SUPARCLAW_HOME: home },
      });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      p.on("exit", (code) => resolve({ code, out }));
    });
  return (async () => {
    const preview = await run(["backfill", "--days", "90"]);
    assert.equal(preview.code, 0);
    assert.match(preview.out, /glacier route/);
    assert.match(preview.out, /--apply/);
    const applied = await run(["backfill", "--days", "90", "--apply"]);
    assert.match(applied.out, /staged 1 candidate/);
    const promote = await run(["promote"]);
    assert.equal(promote.code, 0);
    assert.match(promote.out, /glacier route/);
    const rollback = await run(["backfill", "--rollback"]);
    assert.match(rollback.out, /removed 1 backfill-staged/);
  })();
});

test("A naive-duration sanity: sweep without any material writes 'nothing new', creates nothing", () => {
  const ws = wsDir(); // empty workspace — their empty-sweep rule
  const store = openStore();
  return runSweep({ store, workspace: ws, now: NOW }).then((v) => {
    assert.equal(v.nothingNew, true);
    assert.equal(v.promoted, 0);
    // Their rule: plugin state records completion; no memory/dreaming files.
    assert.ok(!existsSync(join(ws, "MEMORY.md")), "no memory file created by an empty sweep");
    assert.ok(!existsSync(join(ws, "DREAMS.md")), "no diary file created by an empty sweep");
    assert.equal(store.lastDreamRun().verdict, "nothing new", "completion left a visible trace in the store");
    store.close();
  });
});
