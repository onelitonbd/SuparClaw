// Partial #4 — memory search-ranking: keyword legs (AND then any-term),
// recency decay on dated notes (evergreen exempt), write-time importance,
// eligibility-before-decay semantics, hit preservation, MMR diversity, the
// maxResults alias contract, and the merged memory+transcript pool.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SUPARCLAW_HOME = mkdtempSync(join(tmpdir(), "sc-msearch-"));
const {
  tokenize,
  chunkMarkdown,
  importanceOf,
  datedNoteDate,
  decayFactor,
  importanceMultiplier,
  mmrReorder,
  searchMemoryFiles,
  rankTranscriptHits,
  buildRegistry,
  Store,
  emptyConfig,
} = await import("../dist/lib.js");

const NOW = Date.parse("2026-10-21T06:00:00Z");
const DAY = 86_400_000;

// Short bodies + doubled tf on searchable lines: relevance lands well above
// the eligibility floor so assertions stay structural, never float-brittle.
function fixtureWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "sc-msws-"));
  mkdirSync(join(ws, "memory", "nested"), { recursive: true });
  writeFileSync(
    join(ws, "MEMORY.md"),
    "# Memory\n\nThe alpine router config lives on the gateway host. The alpine router config changed hands.\n",
  );
  writeFileSync(
    join(ws, "memory", "2026-07-25.md"),
    [
      "- mangrove backup checklist reviewed",
      "- mangrove backup checklist verified",
      "- the alpine router config was backed up; alpine router config restored",
      "- zebra sightings report filed",
    ].join("\n"),
  );
  writeFileSync(
    join(ws, "memory", "2026-10-20.md"),
    [
      "- mangrove backup checklist reviewed",
      "- mangrove backup checklist reconfirmed",
      "- deployment plan for the gateway; deployment gateway rollout staged",
    ].join("\n"),
  );
  writeFileSync(
    join(ws, "memory", "2026-10-20-axiom-plain.md"),
    "axiom protocol handshake procedure documented\n",
  );
  writeFileSync(
    join(ws, "memory", "2026-10-20-axiom-tag.md"),
    "axiom protocol handshake procedure documented <!-- importance: 9 -->\n",
  );
  writeFileSync(
    join(ws, "memory", "nested", "2026-08-01-deep.md"),
    "# Dream report\n\nDreaming synthesis mentions the alpine router config. The alpine router config appeared twice.\n",
  );
  return ws;
}

test("tokenize: NFC/NFD equivalence, single-letter words dropped, numbers kept", () => {
  assert.deepEqual(tokenize("Café café"), tokenize("Cafe\u0301 cafe\u0301"));
  assert.deepEqual(tokenize("a b 7 x1"), ["7", "x1"]);
  assert.ok(tokenize("gateway-host").includes("gateway-host"));
});

test("chunkMarkdown: heading-only blocks attach to following content; a final lone heading stays searchable", () => {
  const chunks = chunkMarkdown("## Router setup\n\nBody about the router config.\n\n# Tail heading");
  assert.equal(chunks.length, 1, "small blocks pack into one chunk");
  assert.match(chunks[0].text, /^## Router setup\n\nBody about the router config\./);
  assert.match(chunks[0].text, /# Tail heading$/, "lone heading never dropped — their rule");
  // Oversized: heading still attaches instead of taking a slot on its own.
  const big = chunkMarkdown(`## Topic\n\n${"content line about routers. ".repeat(120)}\n\n## Second\n\n${"more content here. ".repeat(120)}`);
  assert.ok(!big.some((c) => /^#{1,6}\s+\S+$/.test(c.text.trim())), "no heading-only chunk in results");
  assert.ok(big[0].text.startsWith("## Topic"));
});

test("datedNoteDate: dated, slug-dated-at-depth; undated and curated are evergreen (null)", () => {
  assert.equal(datedNoteDate("memory/2026-07-25.md"), Date.parse("2026-07-25T00:00:00Z"));
  assert.equal(datedNoteDate("memory/nested/2026-08-01-deep.md"), Date.parse("2026-08-01T00:00:00Z"));
  assert.equal(datedNoteDate("memory/undated.md"), null);
  assert.equal(datedNoteDate("MEMORY.md"), null);
});

test("importanceOf: parses their annotation, clamps 1-10, max wins, absent is null", () => {
  assert.equal(importanceOf("a note <!-- importance: 9 -->"), 9);
  assert.equal(importanceOf("<!-- importance: 12 --> x"), 10);
  assert.equal(importanceOf("<!-- importance: 2 --> y <!-- importance: 5 -->"), 5);
  assert.equal(importanceOf("plain"), null);
  assert.equal(importanceMultiplier(9), 1.45);
  assert.equal(importanceMultiplier(null), 1);
});

test("decay: dated notes decay with a 30-day half-life; evergreen hits keep decay 1", () => {
  assert.equal(decayFactor(0), 1);
  assert.ok(Math.abs(decayFactor(30) - 0.5) < 1e-9);
  const ws = fixtureWorkspace();
  const hits = searchMemoryFiles(ws, "alpine router config", { now: NOW, maxResults: 10 });
  const evergreen = hits.find((h) => h.source === "MEMORY.md");
  assert.ok(evergreen, "MEMORY.md hit present");
  assert.equal(evergreen.decay, 1);
  assert.equal(evergreen.date, null);
  const stale = hits.find((h) => h.source === "memory/2026-07-25.md");
  assert.ok(stale, "stale dated hit present");
  assert.ok(stale.decay < 0.2, `stale decay (${stale.decay.toFixed(3)}) ≈ 2^(-88/30) ≈ 0.13`);
});

test("ordering vs eligibility: fresh outranks stale on equal text; stale returns with score below minScore but eligible preDecay", () => {
  const ws = fixtureWorkspace();
  const hits = searchMemoryFiles(ws, "mangrove backup checklist", { now: NOW, maxResults: 10 });
  const rows = hits.filter((h) => h.snippet.includes("mangrove"));
  assert.equal(rows.length, 2);
  const fresh = rows.find((h) => h.source === "memory/2026-10-20.md");
  const stale = rows.find((h) => h.source === "memory/2026-07-25.md");
  assert.ok(fresh.preDecay >= 0.35, "preDecay is the eligibility score");
  assert.ok(stale.preDecay >= 0.35);
  assert.ok(stale.score < 0.35, "their doc: a relevant dated note can return below minScore");
  assert.ok(rows.indexOf(fresh) < rows.indexOf(stale), "recency orders, not eligibility");
});

test("importance: annotation boosts the same text on the same date", () => {
  const ws = fixtureWorkspace();
  const hits = searchMemoryFiles(ws, "axiom protocol handshake", { now: NOW, maxResults: 10 });
  const plain = hits.find((h) => h.source === "memory/2026-10-20-axiom-plain.md");
  const tagged = hits.find((h) => h.source === "memory/2026-10-20-axiom-tag.md");
  assert.ok(plain && tagged, "both files hit");
  assert.equal(tagged.importance, 9);
  assert.ok(plain.importance === null);
  // Identical text, identical date → identical relevance/decay: the ONLY
  // difference a reader should see is the importance multiplier.
  assert.ok(Math.abs(tagged.preDecay / plain.preDecay - 1.45) < 1e-6, "multiplier 1 + 0.05 × 9");
  assert.ok(hits.indexOf(tagged) < hits.indexOf(plain), "importance orders too");
});

test("keyword leg: every-term required first, any-term retry only on miss", () => {
  const ws = fixtureWorkspace();
  const andHits = searchMemoryFiles(ws, "deployment gateway", { now: NOW, maxResults: 10 });
  assert.ok(andHits.length > 0 && andHits.every((h) => h.snippet.includes("deployment")), "AND semantics");
  // 'zebra' exists (stale file) but never beside 'gateway' → any-term retry.
  const anyHits = searchMemoryFiles(ws, "zebra gateway", { now: NOW, maxResults: 10 });
  assert.ok(anyHits.length > 0, "any-term retry recovers partial matches");
});

test("hit preservation: minScore above everything keeps the single best keyword hit", () => {
  const ws = fixtureWorkspace();
  const hits = searchMemoryFiles(ws, "mangrove backup", { now: NOW, minScore: 0.999, maxResults: 10 });
  assert.equal(hits.length, 1, "their rule: keyword matches are preserved when all pre-decay scores fall short");
});

test("MMR: λ0.7 Jaccard ordering favors the distinct hit over a near-duplicate", () => {
  const mk = (score, toks, source) => ({ source, snippet: source, date: null, preDecay: score, score, decay: 1, importance: null, tokens: new Set(toks) });
  const A = mk(0.9, "router config backup plan alpine".split(" "), "A");
  const Adup = mk(0.85, "router config backup plan alpine notes".split(" "), "A-dup");
  const B = mk(0.8, "kanchenjunga packing list trek".split(" "), "B");
  const out = mmrReorder([A, Adup, B]);
  assert.deepEqual(out.map((h) => h.source), ["A", "B", "A-dup"]);
  assert.deepEqual(out.map((h) => h.score), [0.9, 0.8, 0.85], "scores untouched — ordering only");
});

test("transcript leg: one global pool (their unioned corpora), aged by activity time", () => {
  const ws = fixtureWorkspace();
  const memHits = searchMemoryFiles(ws, "kanchenjunga packing", { now: NOW, maxResults: 10 });
  const rows = [
    { session_key: "main", role: "assistant", content: "kanchenjunga packing list for the autumn trek", created_at: NOW - 40 * DAY },
  ];
  const hits = rankTranscriptHits(rows, "kanchenjunga packing", memHits, { now: NOW, maxResults: 10 });
  const tr = hits.find((h) => h.source.startsWith("session · main"));
  assert.ok(tr, "transcript hit joins the ranked pool");
  assert.ok(tr.decay < 1, "transcript aged by activity timestamp");
  assert.ok(Math.abs(tr.decay - Math.pow(2, -40 / 30)) < 1e-9);
});

test("tool contract: maxResults aliases by their precedence; invalid selected value errors", () => {
  const ws = fixtureWorkspace();
  const stateDir = mkdtempSync(join(tmpdir(), "sc-msstate-"));
  const store = Store.open(join(stateDir, "state.sqlite"));
  store.ensureSession("agent:main:main");
  const config = emptyConfig();
  const reg = buildRegistry(config);
  const tool = reg.find((t) => t.name === "memory_search");
  const ctx = { workspace: ws, stateDir, skills: [], store };

  return (async () => {
    const one = await tool.run({ query: "alpine", maxResults: 1 }, ctx);
    assert.equal(one.split("\n\n").length, 1);
    const aliased = await tool.run({ query: "alpine", max_results: 2 }, ctx);
    assert.equal(aliased.split("\n\n").length, 2);
    const legacy = await tool.run({ query: "alpine", limit: 2 }, ctx);
    assert.equal(legacy.split("\n\n").length, 2);
    // maxResults wins over limit regardless of order.
    const prec = await tool.run({ query: "alpine", limit: 3, maxResults: 1 }, ctx);
    assert.equal(prec.split("\n\n").length, 1);
    // Invalid selected value → error, never fall through to a valid alias.
    const bad = await tool.run({ query: "alpine", maxResults: 0, limit: 2 }, ctx);
    assert.match(bad, /^error:/);
    const empty = await tool.run({ query: "  " }, ctx);
    assert.match(empty, /^error:/);
    // Output shape: [score · date · source] snippet
    const fmt = await tool.run({ query: "mangrove", maxResults: 5 }, ctx);
    assert.match(fmt, /\[\d\.\d{2} · \d{4}-\d{2}-\d{2} · memory\/2026-10-20\.md\]/);
  })().finally(() => store.close());
});

test("tool: memory_append writes the importance annotation; search reads it", () => {
  const ws = fixtureWorkspace();
  const stateDir = mkdtempSync(join(tmpdir(), "sc-msstate2-"));
  const store = Store.open(join(stateDir, "state.sqlite"));
  store.ensureSession("agent:main:main");
  const reg = buildRegistry(emptyConfig());
  const append = reg.find((t) => t.name === "memory_append");
  const ctx = { workspace: ws, stateDir, skills: [], store };

  return (async () => {
    await append.run({ note: "fallback zone configured", importance: 8 }, ctx);
    const stamp = new Date().toISOString().slice(0, 10);
    const text = readFileSync(join(ws, "memory", `${stamp}.md`), "utf8");
    assert.match(text, /fallback zone configured <!-- importance: 8 -->/);
    const hits = searchMemoryFiles(ws, "fallback zone", { now: NOW, maxResults: 5 });
    assert.equal(hits[0].importance, 8);
  })().finally(() => store.close());
});
