// Context budgeting: how much conversation history one run may carry.
//
// The number is no longer a global setting the user types in characters. It is
// derived from the model's declared context window (`models.<id>.contextWindow`,
// set per model in Settings → Models → Tune), because that is the only number
// that means anything: a window is a hard fact about the model, while "200000
// characters" is neither knowable nor enforceable against it.
//
// Rules, in order:
//   1. the window of the model THIS run asked for (profile id or wire ref),
//   2. else the configured default model's window,
//   3. else the first fallback with a window,
//   4. else the legacy `agents.defaults.contextBudgetChars`, else 200,000.
//
// The old code took `max(configuredBudget, window × 0.7)`, which let a stored
// character count *exceed* the model's window — a guaranteed overflow, retry storm
// and compaction sweep on any small-context model. A window is now a ceiling.

import { modelProfile, type SuparClawConfig } from "../config/schema.js";

/** Characters per token. The whole loop is char-based; this is the bridge. */
export const CHARS_PER_TOKEN = 4;
/** Share of the window we are willing to fill with history. The rest is the
 *  system prompt, the tool schemas, the reply, and room for the provider's own
 *  tokenizer disagreeing with our 4:1 estimate. */
export const WINDOW_SHARE = 0.7;
/** Hard ceiling in characters — a 400k-char prompt is already enormous, and the
 *  request bodies get slow to build long before this. */
export const MAX_HISTORY_CHARS = 400_000;
/** Floor, so a tiny declared window cannot starve the prompt of its own turn. */
export const MIN_HISTORY_CHARS = 8_000;
/** Used when no window is known and no legacy budget is stored. */
export const FALLBACK_HISTORY_CHARS = 200_000;

export interface HistoryBudget {
  /** Characters of conversation history this run may carry. */
  chars: number;
  /** The window it was derived from, in tokens (0 = unknown). */
  windowTokens: number;
  /** Where the number came from — the UI names the mechanism from this. */
  source: "model" | "config" | "default";
}

const windowOf = (config: SuparClawConfig, ref: string): number => {
  if (!ref) return 0;
  const n = Number(modelProfile(config, ref).contextWindow ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
};

/**
 * The context window that governs this run, in tokens (0 = unknown). Resolved
 * against the model the run asked for first: a session may legitimately run a
 * different model than the configured default, and using the default's window
 * there is how the budget ends up wrong for the model actually being called.
 */
export function modelContextWindow(config: SuparClawConfig, modelRef = ""): number {
  const requested = windowOf(config, String(modelRef ?? "").trim());
  if (requested > 0) return requested;
  const def = String(config.agents?.defaults?.model ?? "").trim();
  const fromDefault = windowOf(config, def);
  if (fromDefault > 0) return fromDefault;
  for (const fb of config.agents?.defaults?.fallbacks ?? []) {
    const fromFallback = windowOf(config, String(fb ?? "").trim());
    if (fromFallback > 0) return fromFallback;
  }
  return 0;
}

/** Characters of history for a run on `modelRef`. See the file header for rules. */
export function historyBudget(config: SuparClawConfig, modelRef = ""): HistoryBudget {
  const windowTokens = modelContextWindow(config, modelRef);
  if (windowTokens > 0) {
    const fromWindow = Math.round(windowTokens * CHARS_PER_TOKEN * WINDOW_SHARE);
    return {
      chars: Math.max(MIN_HISTORY_CHARS, Math.min(fromWindow, MAX_HISTORY_CHARS)),
      windowTokens,
      source: "model",
    };
  }
  const legacy = Number(config.agents?.defaults?.contextBudgetChars ?? 0);
  if (Number.isFinite(legacy) && legacy > 0) {
    return { chars: Math.trunc(legacy), windowTokens: 0, source: "config" };
  }
  return { chars: FALLBACK_HISTORY_CHARS, windowTokens: 0, source: "default" };
}

export interface ModelTuning {
  temperature?: number;
  /** 0 = the provider's default, i.e. omit max_tokens (do NOT inherit another
   *  model's cap — a large cap sent to a small model is a hard 400). */
  maxTokens?: number;
  /** Only when the profile names a real level; "inherit" leaves the run's
   *  resolved level alone. */
  reasoning?: string;
}

/**
 * Per-model tuning for every ref in a fallback chain, keyed by the wire ref the
 * LLM will actually request. Without this, a fallback attempt inherits the
 * primary model's temperature / max_tokens / reasoning, which is exactly the
 * "per-model configuration is not being used" bug.
 */
export function fallbackTuning(config: SuparClawConfig, refs: readonly string[]): Record<string, ModelTuning> {
  const out: Record<string, ModelTuning> = {};
  const models = config.models ?? {};
  for (const raw of refs) {
    const ref = String(raw ?? "").trim();
    if (!ref) continue;
    // Find the stored profile that serves this wire ref: by resolved id first, then
    // by ref (a ref can be stored under a different local id). No entry = nobody
    // tuned this model, so the run-wide values stay the honest default.
    const resolved = modelProfile(config, ref);
    const byId = resolved.id && models[resolved.id] ? resolved.id : undefined;
    const key = byId ?? Object.keys(models).find((k) => models[k]?.ref === ref);
    const entry = key ? models[key] : undefined;
    if (!entry) continue;
    const tuning: ModelTuning = { maxTokens: entry.maxTokens ?? 0 };
    if (typeof entry.temperature === "number" && Number.isFinite(entry.temperature)) {
      tuning.temperature = entry.temperature;
    }
    const effort = entry.reasoningEffort ?? "inherit";
    if (effort !== "inherit") tuning.reasoning = effort;
    // Key by the wire ref the LLM will request, not by the id that was passed in:
    // the loop hands this map straight to stream() and looks up by chain entry.
    out[resolved.ref || ref] = tuning;
  }
  return out;
}
