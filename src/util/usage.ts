// P2 #15 — usage & cost tracking helpers.
//
// Upstream contract (docs/openclaw/concepts/usage-tracking.md): every reply
// can carry a /usage footer in one of four modes — off, tokens, full, cost —
// persisted per session; cost needs a per-model price card, and without one
// it degrades to plain tokens (never invents a price). The stored runs table
// is the audit source for reporting (`sc usage`).
import type { ModelPricing, UsageMode } from "../config/schema.js";

export interface UsageNumbers {
  inputTokens: number;
  outputTokens: number;
  cachedInput: number;
  total: number;
}

/** Provider usage dicts use slightly different keys; resolve the trio. */
export function usageNumbers(usage: Record<string, number> | undefined): UsageNumbers | null {
  if (!usage || typeof usage !== "object") return null;
  const input = usage["prompt_tokens"] ?? usage["input_tokens"] ?? usage["promptTokens"] ?? 0;
  const output = usage["completion_tokens"] ?? usage["output_tokens"] ?? usage["completionTokens"] ?? 0;
  const cached = usage["cached_tokens"] ?? usage["cached_input_tokens"] ?? 0;
  if (input <= 0 && output <= 0 && cached <= 0) return null;
  return { inputTokens: input, outputTokens: output, cachedInput: cached, total: input + output };
}

/** USD cost for one run; null when the model has no price card. */
export function runCost(u: UsageNumbers, pricing: ModelPricing | undefined): number | null {
  if (!pricing) return null;
  if (!(pricing.input > 0 || pricing.output > 0 || pricing.cachedIn > 0)) return null;
  const fresh = Math.max(0, u.inputTokens - u.cachedInput);
  return (fresh * pricing.input + u.cachedInput * pricing.cachedIn + u.outputTokens * pricing.output) / 1_000_000;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) {
    const k = n / 1_000;
    // One decimal while it still shows a real digit (12.3k), whole beyond.
    return n % 1000 === 0 || k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(n);
}

export function fmtCost(usd: number): string {
  return usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

/**
 * Reply footer by mode (their shapes):
 *   tokens: "↳ 1.2k in · 340 out"
 *   full:   tokens + model + cache when present
 *   cost:   full + $x.yyyy (or the no-pricing fallback — never a guessed price)
 * Empty string when the mode is off or the provider sent no usage.
 */
export function usageFooter(mode: UsageMode, usage: Record<string, number> | undefined, modelLabel: string, pricing?: ModelPricing): string {
  if (mode === "off") return "";
  const u = usageNumbers(usage);
  if (!u) return "";
  const cost = mode === "cost" ? runCost(u, pricing) : null;
  if (mode === "cost" && cost !== null) {
    return `↳ ${fmtCost(cost)} — ${fmtTokens(u.inputTokens)} in · ${fmtTokens(u.outputTokens)} out${u.cachedInput > 0 ? ` (${fmtTokens(u.cachedInput)} cached)` : ""} · ${modelLabel}`;
  }
  if (mode === "cost" && cost === null) {
    return `↳ ${fmtTokens(u.inputTokens)} in · ${fmtTokens(u.outputTokens)} out · cost n/a (no pricing for ${modelLabel})`;
  }
  if (mode === "full") {
    return `↳ ${fmtTokens(u.inputTokens)} in · ${fmtTokens(u.outputTokens)} out${u.cachedInput > 0 ? ` (${fmtTokens(u.cachedInput)} cached)` : ""} · ${modelLabel} · ${fmtTokens(u.total)} total`;
  }
  return `↳ ${fmtTokens(u.inputTokens)} in · ${fmtTokens(u.outputTokens)} out`;
}

/**
 * P4 (Missing!#34) — usage dashboard report. One pure aggregator feeding the
 * Gateway `usage.report` RPC (UI) — the CLI keeps its own text render but the
 * token math + null-cost contract is shared through this same module (never a
 * guessed price: costUsd goes null when any contributing run lacks a card).
 */
export interface UsageRunInput {
  session: string;
  model: string;
  started_at: number;
  usage: Record<string, number>;
  pricing: ModelPricing | undefined;
}

export interface UsageReport {
  total: RangeUsageSummary;
  perDay: { day: string; runs: number; inputTokens: number; outputTokens: number; costUsd: number | null; unknownPriceRuns: number }[];
  perSession: { session: string; runs: number; inputTokens: number; outputTokens: number; costUsd: number | null; unknownPriceRuns: number }[];
  perModel: { model: string; runs: number; inputTokens: number; outputTokens: number; costUsd: number | null; unknownPriceRuns: number }[];
}

interface UsageBucket {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  unknownPriceRuns: number;
}

export function buildUsageReport(runs: UsageRunInput[]): UsageReport {
  const total = { runs: 0, inputTokens: 0, outputTokens: 0, cachedInput: 0, costUsd: 0 as number | null, unknownPriceRuns: 0 };
  const perDay = new Map<string, UsageBucket>();
  const perSession = new Map<string, UsageBucket>();
  const perModel = new Map<string, UsageBucket>();
  const blankBucket = (): UsageBucket => ({ runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, unknownPriceRuns: 0 });

  for (const r of runs) {
    const u = usageNumbers(r.usage);
    if (!u) continue;
    const c = runCost(u, r.pricing);
    const addTo = (b: UsageBucket) => {
      b.runs += 1;
      b.inputTokens += u.inputTokens;
      b.outputTokens += u.outputTokens;
      if (c === null) { b.unknownPriceRuns += 1; b.costUsd = null; }
      else if (b.costUsd !== null) b.costUsd += c;
    };
    addTo(total);
    total.cachedInput += u.cachedInput;
    const day = new Date(r.started_at).toISOString().slice(0, 10);
    addTo(perDay.get(day) ?? (perDay.set(day, blankBucket()), perDay.get(day)!));
    addTo(perSession.get(r.session) ?? (perSession.set(r.session, blankBucket()), perSession.get(r.session)!));
    addTo(perModel.get(r.model) ?? (perModel.set(r.model, blankBucket()), perModel.get(r.model)!));
  }

  return {
    total: total as RangeUsageSummary,
    perDay: [...perDay.entries()].map(([day, b]) => ({ day, ...b })).sort((a, b) => b.day.localeCompare(a.day)),
    perSession: [...perSession.entries()].map(([session, b]) => ({ session, ...b })).sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)),
    perModel: [...perModel.entries()].map(([model, b]) => ({ model, ...b })).sort((a, b) => b.runs - a.runs),
  };
}

export interface RangeUsageSummary {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cachedInput: number;
  /** null ⇒ at least one contributing run had an unknown price. */
  costUsd: number | null;
  unknownPriceRuns: number;
}

/** Aggregate runs for `sc usage` — per-session or overall, cost or tokens. */
export function summarizeUsage(
  runs: { usage: Record<string, number> | undefined; pricing?: ModelPricing }[],
): RangeUsageSummary {
  const s: RangeUsageSummary = { runs: 0, inputTokens: 0, outputTokens: 0, cachedInput: 0, costUsd: 0, unknownPriceRuns: 0 };
  for (const r of runs) {
    const u = usageNumbers(r.usage);
    if (!u) continue;
    s.runs += 1;
    s.inputTokens += u.inputTokens;
    s.outputTokens += u.outputTokens;
    s.cachedInput += u.cachedInput;
    const c = runCost(u, r.pricing);
    if (c === null) {
      s.unknownPriceRuns += 1;
      s.costUsd = null;
    } else if (s.costUsd !== null) {
      s.costUsd += c;
    }
  }
  return s;
}
