// Context budgeting: the window is the model's fact, not a number the user types.
//
// These are the rules the run loop uses to decide how much history rides along,
// and they are the reason Settings → Defaults no longer has a "context budget"
// field: the Models tab owns the window, this module turns it into characters.
import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyConfig,
  CHARS_PER_TOKEN,
  WINDOW_SHARE,
  MAX_HISTORY_CHARS,
  MIN_HISTORY_CHARS,
  FALLBACK_HISTORY_CHARS,
  modelContextWindow,
  historyBudget,
  fallbackTuning,
} from "../dist/lib.js";

/** A config with curated profiles, the way the Models tab writes them. */
function cfg({ model = "", fallbacks = [], models = {}, budget } = {}) {
  const base = emptyConfig();
  base.agents.defaults.model = model;
  base.agents.defaults.fallbacks = fallbacks;
  base.models = models;
  if (budget !== undefined) base.agents.defaults.contextBudgetChars = budget;
  return base;
}

const profile = (ref, contextWindow, extra = {}) => ({ ref, label: "", enabled: true, contextWindow, maxTokens: 0, ...extra });

test("a declared window becomes ~70% of it in characters, capped at 400k", () => {
  const c = cfg({ model: "big", models: { big: profile("openai/gpt-5", 1_000_000) } });
  const b = historyBudget(c);
  assert.equal(b.source, "model");
  assert.equal(b.windowTokens, 1_000_000);
  assert.equal(b.chars, MAX_HISTORY_CHARS, "1M tokens × 4 × .7 = 2.8M, clipped to the ceiling");

  const mid = cfg({ model: "mid", models: { mid: profile("x/mid", 128_000) } });
  assert.equal(historyBudget(mid).chars, Math.round(128_000 * CHARS_PER_TOKEN * WINDOW_SHARE));
});

test("the budget can never exceed the model's window — the old floor is gone", () => {
  // The bug this replaces: a stored 400,000-character budget used to win over a
  // 32k-token window, guaranteeing overflow. The window is now a ceiling.
  const c = cfg({ model: "small", budget: 400_000, models: { small: profile("x/small", 32_000) } });
  const b = historyBudget(c);
  assert.equal(b.source, "model");
  assert.equal(b.chars, Math.round(32_000 * CHARS_PER_TOKEN * WINDOW_SHARE));
  assert.ok(b.chars < 400_000);
});

test("a tiny declared window cannot starve the prompt", () => {
  const c = cfg({ model: "tiny", models: { tiny: profile("x/tiny", 1000) } });
  assert.equal(historyBudget(c).chars, MIN_HISTORY_CHARS);
});

test("the run's own model wins over the configured default", () => {
  const c = cfg({
    model: "small",
    models: { small: profile("x/small", 32_000), big: profile("x/big", 1_000_000) },
  });
  assert.equal(modelContextWindow(c), 32_000, "no run model → the default");
  assert.equal(modelContextWindow(c, "big"), 1_000_000, "the run asked for big");
  assert.equal(modelContextWindow(c, "x/big"), 1_000_000, "a bare wire ref resolves too");
  assert.equal(historyBudget(c, "big").windowTokens, 1_000_000);
});

test("an untuned run model falls back to the default's window, then the chain", () => {
  const c = cfg({
    model: "mid",
    fallbacks: ["x/backup"],
    models: { mid: profile("x/mid", 128_000), backup: profile("x/backup", 64_000) },
  });
  assert.equal(modelContextWindow(c, "x/untuned"), 128_000, "unknown run model → the default");
  const noDefault = cfg({ model: "", fallbacks: ["x/backup"], models: { backup: profile("x/backup", 64_000) } });
  assert.equal(modelContextWindow(noDefault), 64_000, "no default → the first fallback with a window");
});

test("with no window at all, the legacy character budget still works — then the default", () => {
  const legacy = cfg({ model: "x/unknown", budget: 45_000 });
  assert.deepEqual(historyBudget(legacy), { chars: 45_000, windowTokens: 0, source: "config" });
  // emptyConfig ships 200000, so "no stored budget" has to be stated explicitly.
  const bare = cfg({ model: "x/unknown", budget: 0 });
  assert.deepEqual(historyBudget(bare), { chars: FALLBACK_HISTORY_CHARS, windowTokens: 0, source: "default" });
  assert.equal(FALLBACK_HISTORY_CHARS, 200_000, "the shipped default");
});

test("emptyConfig (no profiles) budgets exactly as before", () => {
  // test/compaction.test.mjs seeds ~190k chars against emptyConfig and expects a
  // sweep; that only holds if the resolver still yields 200k here.
  const c = emptyConfig();
  const b = historyBudget(c);
  assert.equal(b.source, "config");
  assert.equal(b.chars, c.agents.defaults.contextBudgetChars);
  assert.equal(b.chars, 200_000);
});

test("fallbackTuning carries each model's own sampling, cap and effort", () => {
  const c = cfg({
    model: "primary",
    fallbacks: ["backup", "x/plain"],
    models: {
      primary: profile("x/primary", 128_000, { temperature: 0.2, maxTokens: 4000, reasoningEffort: "high" }),
      backup: profile("x/backup", 32_000, { temperature: 0.9, maxTokens: 0, reasoningEffort: "inherit" }),
    },
  });
  const t = fallbackTuning(c, ["primary", "backup", "x/plain"]);
  assert.deepEqual(t["x/primary"], { temperature: 0.2, maxTokens: 4000, reasoning: "high" });
  assert.deepEqual(t["x/backup"], { temperature: 0.9, maxTokens: 0 }, "0 means provider default; inherit is not passed");
  assert.equal(t["x/plain"], undefined, "an untuned model inherits the run's values");
});

test("fallbackTuning finds a profile stored under a different local id", () => {
  const c = cfg({ models: { "my-nickname": profile("x/real-ref", 128_000, { maxTokens: 1234 }) } });
  assert.deepEqual(fallbackTuning(c, ["x/real-ref"])["x/real-ref"], { maxTokens: 1234 });
});

test("the constants the UI formats are the ones the runtime uses", () => {
  // ui/src/settings.ts cannot import server code; it repeats these three and says
  // so. If one moves, the caption starts lying about the budget it is describing.
  assert.equal(CHARS_PER_TOKEN, 4);
  assert.equal(WINDOW_SHARE, 0.7);
  assert.equal(MAX_HISTORY_CHARS, 400_000);
});
