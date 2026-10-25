// P4 (Missing!#34) — usage dashboard: daily rollups + session/model aggregates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { buildUsageReport, usageNumbers, runCost } = await import("../dist/lib.js");

test("buildUsageReport rolls runs into totals, days, sessions, models — cost null when unpriced", () => {
  const runs = [
    { session: "main:main", model: "anthropic/claude", started_at: Date.UTC(2026, 9, 20, 10), usage: { prompt_tokens: 1000, completion_tokens: 200 }, pricing: { input: 3, output: 15, cachedIn: 0.3 } },
    { session: "main:main", model: "anthropic/claude", started_at: Date.UTC(2026, 9, 20, 11), usage: { input_tokens: 500, output_tokens: 100 }, pricing: { input: 3, output: 15, cachedIn: 0.3 } },
    { session: "dev:notes", model: "openai/gpt-5", started_at: Date.UTC(2026, 9, 21, 9), usage: { prompt_tokens: 300, completion_tokens: 50 }, pricing: undefined },
  ];
  const r = buildUsageReport(runs);
  assert.equal(r.total.runs, 3);
  assert.equal(r.total.inputTokens, 1800);
  assert.equal(r.total.outputTokens, 350);
  assert.equal(r.total.costUsd, null); // one unpriced run → never a guessed price
  assert.equal(r.total.unknownPriceRuns, 1);

  assert.equal(r.perDay.length, 2);
  assert.equal(r.perDay[0].day, "2026-10-21"); // newest first
  assert.equal(r.perDay[1].runs, 2);
  assert.equal(r.perDay[0].costUsd, null);
  assert.ok(r.perDay[1].costUsd > 0); // both runs priced that day

  // session aggregates sort by total tokens desc
  assert.equal(r.perSession[0].session, "main:main");
  assert.equal(r.perSession[0].runs, 2);
  assert.equal(r.perSession[1].session, "dev:notes");

  // model aggregates sort by runs desc
  assert.equal(r.perModel[0].model, "anthropic/claude");
  assert.equal(r.perModel[1].runs, 1);

  // runs without usage numbers are skipped, not counted as zero-token runs
  const r2 = buildUsageReport([{ session: "s", model: "m", started_at: 1, usage: {}, pricing: undefined }]);
  assert.deepEqual(r2.total.runs, 0);
});

test("gateway wires usage.report: runs table + pricing cards + periods + session filter", () => {
  const src = readFileSync(new URL("../src/gateway/server.ts", import.meta.url), "utf8");
  assert.match(src, /"usage\.report",/);
  assert.match(src, /case "usage\.report":/);
  assert.match(src, /buildUsageReport\(runs\)/); // shared aggregator — same math as `sc usage`
  assert.match(src, /modelProfiles\(service\.config\)/); // pricing cards from config
  assert.match(src, /listRunsWithUsage\(\)/); // runs table audit source (their rule)
  assert.match(src, /includeArchived: true/); // archived sessions stay counted
  assert.match(src, /days \* 86_400_000/); // period filter
  assert.match(src, /getSessionByKey\(sessionKeyFilter\)/); // per-session filter
});

test("ui Usage tab: cards + three aggregate tables + json/csv exports", () => {
  const src = readFileSync(new URL("../ui/src/settings.ts", import.meta.url), "utf8");
  assert.match(src, /\| "channels" \| "usage" \|/);
  assert.match(src, /\{ id: "usage", label: "Usage", group: "Monitoring", description:/);
  assert.match(src, /else if \(this\.#tab === "usage"\) void this\.#renderUsage\(\);/);
  assert.match(src, /gateway\.request\("usage\.report"/);
  assert.match(src, /last 7 days/i);
  assert.match(src, /Daily rollup/);
  assert.match(src, /Per session/);
  assert.match(src, /Per model/);
  assert.match(src, /id: "usage-export-json"/);
  assert.match(src, /id: "usage-export-csv"/);
  assert.match(src, /day,runs,input_tokens,output_tokens,cost_usd/);
  assert.match(src, /never-guess-a-price/); // partial-cost hint, not a total lie
  const css = readFileSync(new URL("../ui/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.usage-cards/);
  assert.match(css, /\.usage-table/);
});
