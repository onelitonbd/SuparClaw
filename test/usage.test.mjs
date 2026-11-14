// P2 #15 — usage & cost tracking.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { Store, usageNumbers, runCost, fmtTokens, fmtCost, usageFooter, summarizeUsage, emptyConfig } = await import("../dist/lib.js");

const U = { prompt_tokens: 12_000, completion_tokens: 340 };
const PRICE = { input: 2, cachedIn: 0.5, output: 10 };

test("runs carry the wire model; listRunsWithUsage honors details", () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-usage-"));
  const store = Store.open(join(dir, "state.db"));
  const sess = store.ensureSession("usage-test");
  store.startRun(sess.id, "r1");
  store.finishRun("r1", "done", U, undefined, "gemini/gemini-2.5-flash");
  const rows = store.listRunsWithUsage();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, "gemini/gemini-2.5-flash");
  assert.deepEqual(JSON.parse(rows[0].usage), U);
  store.close();
});

test("token normalization resolves provider key variants", () => {
  assert.deepEqual(usageNumbers(U), { inputTokens: 12_000, outputTokens: 340, cachedInput: 0, total: 12_340 });
  assert.deepEqual(usageNumbers({ input_tokens: 10, output_tokens: 5, cached_input_tokens: 4 }), { inputTokens: 10, outputTokens: 5, cachedInput: 4, total: 15 });
  assert.equal(usageNumbers(undefined), null);
  assert.equal(usageNumbers({}), null, "an all-zero usage dict is no usage");
});

test("cost = fresh*input + cached*cachedIn + output*output per 1M; missing card ⇒ null", () => {
  const u = { inputTokens: 1_004_000, outputTokens: 2000, cachedInput: 4000, total: 0 };
  const usd = runCost(u, PRICE);
  assert.ok(usd !== null && Math.abs(usd - (1_000_000 * 2 + 4000 * 0.5 + 2000 * 10) / 1e6) < 1e-9);
  assert.equal(runCost(u, undefined), null);
  assert.equal(runCost(u, { input: 0, cachedIn: 0, output: 0 }), null, "all-zero pricing means unknown, not free");
});

test("footer shapes: off / tokens / full / cost / no-pricing fallback", () => {
  assert.equal(usageFooter("off", U, "flash", PRICE), "");
  assert.equal(usageFooter("tokens", U, "flash", PRICE), "↳ 12k in · 340 out");
  assert.equal(usageFooter("full", U, "flash", PRICE), "↳ 12k in · 340 out · flash · 12.3k total");
  const withCache = { prompt_tokens: 12_000, completion_tokens: 340, cached_tokens: 2_000 };
  assert.match(usageFooter("full", withCache, "flash", PRICE), /2k cached/);
  assert.equal(usageFooter("cost", U, "flash", PRICE), `↳ ${fmtCost((12_000 * 2 + 340 * 10) / 1e6)} — 12k in · 340 out · flash`);
  assert.match(usageFooter("cost", U, "flash", undefined), /cost n\/a \(no pricing for flash\)/, "no guessing a price");
  assert.equal(usageFooter("tokens", undefined, "flash"), "", "provider sent no usage ⇒ no footer");
});

test("summarizeUsage aggregates and flag partial-cost runs", () => {
  const priced = [{ usage: U, pricing: PRICE }];
  const sum = summarizeUsage(priced);
  assert.equal(sum.runs, 1);
  assert.equal(sum.inputTokens, 12_000);
  assert.ok(sum.costUsd !== null && sum.costUsd > 0);
  const mixed = summarizeUsage([...priced, { usage: U, pricing: undefined }]);
  assert.equal(mixed.costUsd, null);
  assert.equal(mixed.unknownPriceRuns, 1);
});

test("schema defaults: agents.defaults.usage tokens; models.*.pricing zeros", () => {
  const cfg = emptyConfig();
  assert.equal(cfg.agents.defaults.usage, "tokens");
  // pricing lands once a model is configured; empty config has no models.
  cfg.models["gemini-flash"] = {
    ref: "gemini/gemini-2.5-flash", label: "Flash", enabled: true, contextWindow: 0, maxTokens: 0,
    reasoningEffort: "inherit", pricing: { input: 0.3, cachedIn: 0.075, output: 2.5 },
  };
  assert.equal(cfg.models["gemini-flash"].pricing.output, 2.5);
});

test("fmt helpers", () => {
  assert.equal(fmtTokens(534), "534");
  assert.equal(fmtTokens(61_340), "61.3k");
  assert.equal(fmtTokens(12_000), "12k");
  assert.equal(fmtTokens(123_400), "123k");
  assert.equal(fmtCost(0.0314), "$0.03");
  assert.equal(fmtCost(0.0014166), "$0.0014");
});
