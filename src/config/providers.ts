// Provider operations shared by every surface: CLI, TUI, Telegram and (via
// config.set) the web UI. One implementation, so adding a provider behaves the
// same wherever you do it.

import { ConfigService } from "./load.js";
import type { SuparClawConfig } from "./schema.js";
import { resolveModel, type ProviderConfig } from "../agent/llm.js";

export interface Preset {
  name: string;
  label: string;
  baseUrl: string;
  needsKey: boolean;
  note?: string;
  /** Native wire protocol when not OpenAI-compatible (Ollama). */
  api?: "openai-completions" | "ollama";
}

export const PRESETS: Preset[] = [
  { name: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", needsKey: true },
  { name: "openrouter", label: "OpenRouter (many models, one key)", baseUrl: "https://openrouter.ai/api/v1", needsKey: true },
  { name: "groq", label: "Groq (fast, cheap)", baseUrl: "https://api.groq.com/openai/v1", needsKey: true },
  { name: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", needsKey: true },
  // Ollama: native API host (their warning — the /v1 compat URL breaks tool
  // calls). Sent over the wire with api:"ollama"; previous /v1 entries keep
  // working untouched.
  { name: "ollama", label: "Ollama (on this device)", baseUrl: "http://127.0.0.1:11434", needsKey: false, api: "ollama" },
  { name: "lmstudio", label: "LM Studio (on this device)", baseUrl: "http://127.0.0.1:1234/v1", needsKey: false },
  { name: "custom", label: "Custom OpenAI-compatible URL", baseUrl: "", needsKey: true },
];

export const presetByName = (name: string): Preset | undefined =>
  PRESETS.find((p) => p.name === name.toLowerCase());

/** Ask a provider for its model list. Never throws — failures come back as .error. */
export interface ModelHint {
  /** Native context window in tokens when the provider's /models says so. */
  contextWindow?: number;
}

export async function fetchModels(
  baseUrl: string,
  apiKey: string,
): Promise<{ models: string[]; hints?: Record<string, ModelHint>; error?: string }> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  try {
    const res = await fetch(url, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return { models: [], error: `HTTP ${res.status}` };
    const body = (await res.json()) as {
      data?: { id?: string; context_length?: number; context_window?: number; max_context_length?: number; max_input_tokens?: number }[];
    };
    const models: string[] = [];
    const hints: Record<string, ModelHint> = {};
    for (const m of body.data ?? []) {
      if (!m.id) continue;
      models.push(m.id);
      // OpenRouter publishes context_length; other stacks use near-neighbours.
      const ctx = m.context_length ?? m.context_window ?? m.max_context_length ?? m.max_input_tokens;
      if (typeof ctx === "number" && Number.isFinite(ctx) && ctx > 0) hints[m.id] = { contextWindow: ctx };
    }
    return { models, hints };
  } catch (err) {
    return { models: [], error: (err as Error).message };
  }
}

// ── live model fetching ─────────────────────────────────────────────────────
// OpenClaw's inventory contract at our scale: reads never wait on the network,
// saved rows are served immediately, stale providers refresh in the background
// (or synchronously with {refresh:true}), and a failed refresh keeps the saved
// rows and reports the failure as a warning.

const DEFAULT_TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; hints?: Record<string, ModelHint> }>();

const ttlMs = (): number => {
  const raw = Number(process.env["SUPARCLAW_MODELS_TTL_MS"] ?? "");
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_TTL_MS;
};

export interface ModelsResult {
  /** "<provider>/<model>" refs: configured rows plus any discovered ones. */
  models: string[];
  /** Per-ref auto-detected hints (context window) from the live /models. */
  details?: Record<string, ModelHint>;
  /** Providers whose live fetch failed — saved rows are still served. */
  warning?: string;
  /** A background fetch is in flight; call again soon for fresh rows. */
  refreshing?: boolean;
}

/**
 * Merge a provider's live /models listing into its configured rows and persist
 * (append-only: configured rows keep their position and metadata; cap 200).
 * Returns the merged list even when the fetch fails (then = saved rows).
 */
export async function refreshProviderModels(
  cfg: ConfigService,
  name: string,
): Promise<{ models: string[]; hints?: Record<string, ModelHint>; error?: string }> {
  const p = cfg.current.providers?.[name] as (ProviderRecord & { api?: string }) | undefined;
  if (!p) return { models: [], error: `no such provider: ${name}` };
  const key = `${name}@${p.baseUrl}`;
  const saved = (p.models ?? []).filter(Boolean);
  const found =
    p.api === "ollama"
      ? await (async () => {
          try {
            const res = await fetch(`${String(p.baseUrl ?? "").replace(/\/+$/, "")}/api/tags`, {
              headers: p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {},
              signal: AbortSignal.timeout(12_000),
            });
            if (!res.ok) return { models: [] as string[], hints: undefined, error: `HTTP ${res.status}` };
            const body = (await res.json()) as { models?: { name?: string }[] };
            return { models: (body.models ?? []).map((m) => m.name).filter((n): n is string => Boolean(n)), hints: undefined, error: undefined };
          } catch (err) {
            return { models: [] as string[], hints: undefined, error: (err as Error).message };
          }
        })()
      : await fetchModels(p.baseUrl ?? "", p.apiKey ?? "");
  if (found.error || found.models.length === 0) {
    return { models: saved, hints: cache.get(key)?.hints, error: found.error ?? "empty listing" };
  }
  cache.set(key, { at: Date.now(), hints: found.hints });
  const merged = [...new Set([...saved, ...found.models])].slice(0, 200);
  if (merged.length !== saved.length || merged.some((m, i) => m !== saved[i])) {
    cfg.setPath(`providers.${name}.models`, merged);
  }
  return { models: merged, hints: found.hints };
}

/**
 * Model inventory for pickers (UI, TUI, Telegram, `sc models`).
 *
 * refresh: true  → fetch every provider now (OpenClaw's explicit Refresh)
 * refresh: false → serve saved rows; TTL-stale providers refresh in background
 */
export async function discoverModels(cfg: ConfigService, opts: { refresh?: boolean } = {}): Promise<ModelsResult> {
  const providers = cfg.current.providers ?? {};
  const names = Object.keys(providers);
  const warnings: string[] = [];
  let refreshing = false;

  const stale = names.filter((name) => {
    const p = providers[name] as ProviderRecord;
    const at = cache.get(`${name}@${p.baseUrl}`)?.at ?? 0;
    return Date.now() - at > ttlMs();
  });

  if (opts.refresh) {
    const results = await Promise.all(names.map(async (name) => ({ name, ...(await refreshProviderModels(cfg, name)) })));
    for (const r of results) {
      if (r.error) warnings.push(`${r.name}: ${r.error}`);
    }
  } else {
    for (const name of stale) {
      refreshing = true;
      void refreshProviderModels(cfg, name).then((r) => {
        if (r.error) cache.delete(`${name}@${(providers[name] as ProviderRecord).baseUrl}`);
      });
    }
  }

  const out: string[] = [];
  const details: Record<string, ModelHint> = {};
  for (const [name, p] of Object.entries(cfg.current.providers ?? {})) {
    const hints = cache.get(`${name}@${(p as ProviderRecord).baseUrl}`)?.hints ?? {};
    for (const m of (p as ProviderRecord).models ?? []) {
      out.push(`${name}/${m}`);
      const hint = hints[m];
      if (hint) details[`${name}/${m}`] = hint;
    }
  }
  if (out.length === 0) {
    const model = cfg.current.agents?.defaults?.model;
    if (model) out.push(model);
  }
  const result: ModelsResult = { models: out };
  if (Object.keys(details).length > 0) result.details = details;
  if (warnings.length > 0) result.warning = `saved rows shown — ${warnings.join("; ")}`;
  if (refreshing) result.refreshing = true;
  return result;
}

/**
 * Can this model reference be resolved against the configured providers?
 * Returns an error message, or null when the ref is acceptable. Mirrors
 * OpenClaw's `config set` strictness, with its escape hatch: when no provider
 * exists yet, ownership cannot be verified and the ref is allowed.
 */
export function validateModelRef(config: SuparClawConfig, ref: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const providers = config.providers ?? {};
  if (Object.keys(providers).length === 0) return null; // cannot verify yet
  try {
    resolveModel(trimmed, providers as Record<string, ProviderConfig>);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

export function maskKey(key: string | undefined): string {
  if (!key) return "(none)";
  return key.length <= 10 ? "••••" : `${key.slice(0, 6)}…${key.slice(-4)}`;
}

/**
 * Normalise a model reference to "<provider>/<model>".
 *
 * Model ids often contain slashes ("kilo/nvidia/nemotron-3-super"), so a bare
 * id like "kilo/nvidia/nemotron-3-super" must not be split on its first
 * slash — that would read "kilo" as a provider name. Instead we look the id up
 * in the providers that are configured.
 *
 * Returns the canonical reference, or null when nothing matches.
 */
export function canonicalModelRef(config: SuparClawConfig, ref: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const providers = config.providers ?? {};
  const names = Object.keys(providers);
  if (names.length === 0) return null;

  // already canonical?
  const slash = trimmed.indexOf("/");
  if (slash > 0 && providers[trimmed.slice(0, slash)]) return trimmed;

  // a bare id exactly one provider offers
  const owners = names.filter((name) => (providers[name]?.models ?? []).includes(trimmed));
  if (owners.length === 1) return `${owners[0]}/${trimmed}`;
  if (owners.length > 1) return null;

  // one provider configured: the whole ref is that provider's model id
  if (names.length === 1) return `${names[0]}/${trimmed}`;
  return null;
}

export type ProviderRecord = { baseUrl: string; apiKey: string; models?: string[]; headers?: Record<string, string> };

/** Human-readable block for a surface without tables (TUI, Telegram). */
export function formatProviders(config: SuparClawConfig): string {
  const providers = config.providers ?? {};
  const names = Object.keys(providers);
  const header = `providers (default model: ${config.agents?.defaults?.model || "(unset)"})`;
  if (names.length === 0) {
    return `${header}\n  none yet — add one with:\n    /provider add openrouter <api-key>\n    or run: sc setup`;
  }
  const lines = names.map((name) => {
    const p = providers[name] as ProviderRecord;
    const models = (p.models ?? []).join(", ") || "(none listed)";
    return `  ${name}\n    ${p.baseUrl}\n    key ${maskKey(p.apiKey)} · models ${models}`;
  });
  return [header, ...lines].join("\n");
}

/** Resolve a provider name from user input to the key actually stored in the
 *  config. Everything that *reads* a ref already matches the provider part
 *  case-insensitively (resolveModel, canonicalModelRef), so a config can hold a
 *  key like "MultiRouter" and work — but every *write* path used to lowercase
 *  the name and look that up literally, which made such a provider impossible
 *  to test, edit or delete ("no such provider: multirouter") and made Edit fork
 *  a lowercase twin with the models on the wrong record. */
export function providerKey(
  providers: Record<string, unknown> | undefined,
  name: string,
): string | null {
  const wanted = name.trim();
  if (!wanted) return null;
  const all = providers ?? {};
  if (Object.prototype.hasOwnProperty.call(all, wanted)) return wanted;
  const lower = wanted.toLowerCase();
  return Object.keys(all).find((key) => key.toLowerCase() === lower) ?? null;
}

export interface AddResult {
  ok: boolean;
  message: string;
}

/** Write a provider. When no models are given, discover them from the endpoint.
 *  `renameFrom` moves everything that pointed at the old name to the new one. */
export async function addProvider(
  cfg: ConfigService,
  name: string,
  opts: { baseUrl?: string; apiKey?: string; models?: string[]; renameFrom?: string } = {},
): Promise<AddResult> {
  // An existing key keeps its own casing ("MultiRouter" stays "MultiRouter");
  // a genuinely new name is normalised to lowercase, as before.
  const existingKey = providerKey(cfg.current.providers, name);
  const clean = existingKey ?? name.trim().toLowerCase();
  const lower = clean.toLowerCase();
  if (!clean) return { ok: false, message: "provider name is required" };
  if (!/^[\w.-]+$/.test(clean)) {
    return { ok: false, message: "provider name may only contain letters, digits, . - _" };
  }

  const preset = presetByName(lower);
  const baseUrl = (opts.baseUrl ?? preset?.baseUrl ?? "").trim();
  if (!baseUrl) return { ok: false, message: "a base url is required (…/v1)" };

  let models = (opts.models ?? []).map((m) => m.trim()).filter(Boolean);
  let discovered = false;
  let discoverError: string | undefined;
  if (models.length === 0) {
    const found = await fetchModels(baseUrl, (opts.apiKey ?? "").trim());
    discoverError = found.error;
    if (found.models.length > 0) {
      models = found.models.slice(0, 200);
      discovered = true;
    }
  }

  const saved = cfg.setPath(`providers.${clean}`, {
    baseUrl,
    apiKey: (opts.apiKey ?? "").trim(),
    models,
    ...(preset?.api ? { api: preset.api } : {}),
  });
  if (!saved.ok) return { ok: false, message: saved.errors.join("; ") || "could not save" };

  const parts = [`provider "${clean}" saved`];
  if (discovered) parts.push(`discovered ${models.length} models`);
  else if (models.length > 0) parts.push(`${models.length} models`);
  else if (discoverError) parts.push(`no models found (${discoverError}) — add some with: --models <a,b,c>`);
  else parts.push("no models found — add some with: --models <a,b,c>");
  parts.push(`default: /model ${clean}/${models[0] ?? "<model>"}`);
  if (opts.renameFrom) {
    const moved = remapProviderRefs(cfg, opts.renameFrom, clean);
    const what = [
      moved.models ? `${moved.models} saved model${moved.models === 1 ? "" : "s"}` : "",
      moved.fallbacks ? `${moved.fallbacks} fallback${moved.fallbacks === 1 ? "" : "s"}` : "",
      moved.defaultModel ? "the default model" : "",
    ].filter(Boolean);
    parts.push(`renamed from "${opts.renameFrom.trim()}"${what.length ? ` — moved ${what.join(", ")}` : ""}`);
  }
  return { ok: true, message: parts.join("\n") };
}

/** Rewrite every reference to a provider whose name just changed: the curated
 *  model profiles, the default model, the fallbacks and the auth order. A rename
 *  is only worth anything if what pointed at the old name follows — otherwise it
 *  strands every saved model on a provider that is about to be removed. */
export function remapProviderRefs(
  cfg: ConfigService,
  from: string,
  to: string,
): { models: number; defaultModel: boolean; fallbacks: number } {
  const src = from.trim().toLowerCase();
  const dst = to.trim().toLowerCase();
  const moved = { models: 0, defaultModel: false, fallbacks: 0 };
  if (!src || !dst || src === dst) return moved;
  // Only an explicit "<provider>/…" ref is unambiguously ours; a bare model id
  // may belong to any provider and is left alone.
  const swap = (ref: unknown): string | null =>
    typeof ref === "string" && ref.toLowerCase().startsWith(`${src}/`) ? `${dst}/${ref.slice(src.length + 1)}` : null;

  const profiles = { ...(cfg.current.models ?? {}) } as Record<string, Record<string, unknown>>;
  for (const [id, entry] of Object.entries(profiles)) {
    const ref = swap(entry?.["ref"]);
    if (ref) {
      profiles[id] = { ...entry, ref };
      moved.models++;
    }
  }
  if (moved.models) cfg.setPath("models", profiles);

  const def = swap(cfg.current.agents?.defaults?.model);
  if (def) {
    cfg.setPath("agents.defaults.model", def);
    moved.defaultModel = true;
  }

  const fallbacks = Array.isArray(cfg.current.agents?.defaults?.fallbacks) ? [...cfg.current.agents.defaults.fallbacks] : [];
  const mapped = fallbacks.map((f) => swap(f) ?? f);
  moved.fallbacks = fallbacks.filter((f, i) => mapped[i] !== f).length;
  if (moved.fallbacks) cfg.setPath("agents.defaults.fallbacks", mapped);

  const order = (cfg.current.auth?.order ?? {}) as Record<string, string[]>;
  if (order[src]) {
    const next: Record<string, string[]> = { ...order };
    next[dst] = [...(next[dst] ?? []), ...(next[src] as string[])];
    delete next[src];
    cfg.setPath("auth.order", next);
  }
  return moved;
}

export function removeProvider(cfg: ConfigService, name: string): AddResult {
  // Resolve to the key actually stored — a config may hold "MultiRouter", and
  // looking up only the lowercased form is what answered "no such provider"
  // for a provider that is right there on the page.
  const key = providerKey(cfg.current.providers, name);
  const providers = { ...(cfg.current.providers ?? {}) };
  if (!key) {
    return { ok: false, message: `no such provider: ${name.trim()}` };
  }
  delete providers[key];
  const clean = key;
  const saved = cfg.setPath("providers", providers);
  if (!saved.ok) return { ok: false, message: saved.errors.join("; ") };

  // A curated model profile cannot outlive its provider: the picker would keep
  // offering a model with no endpoint and /model would still accept it, failing
  // later, far from the button that caused it. Same for a fallback entry.
  const profiles = { ...(cfg.current.models ?? {}) } as Record<string, Record<string, unknown>>;
  const owns = (ref: unknown): boolean =>
    typeof ref === "string" && ref.toLowerCase().startsWith(`${clean.toLowerCase()}/`);
  let droppedProfiles = 0;
  for (const [id, entry] of Object.entries(profiles)) {
    if (owns(entry?.["ref"])) {
      delete profiles[id];
      droppedProfiles++;
    }
  }
  if (droppedProfiles) cfg.setPath("models", profiles);

  const fallbacks = Array.isArray(cfg.current.agents?.defaults?.fallbacks) ? cfg.current.agents.defaults.fallbacks : [];
  const kept = fallbacks.filter((f) => !owns(f));
  const droppedFallbacks = fallbacks.length - kept.length;
  if (droppedFallbacks) cfg.setPath("agents.defaults.fallbacks", kept);

  // The auth order is config too, and it is keyed by provider name.
  // The auth order is keyed by provider name too, and may hold either casing.
  const order = (cfg.current.auth?.order ?? {}) as Record<string, string[]>;
  const orderKey = Object.keys(order).find((k) => k.toLowerCase() === clean.toLowerCase());
  if (orderKey) {
    const next: Record<string, string[]> = { ...order };
    delete next[orderKey];
    cfg.setPath("auth.order", next);
  }

  const stillDefault = cfg.current.agents?.defaults?.model ?? "";
  const note = owns(stillDefault) ? `\nwarning: default model "${stillDefault}" now points at a removed provider` : "";
  const extra = [
    droppedProfiles ? `${droppedProfiles} saved model${droppedProfiles === 1 ? "" : "s"}` : "",
    droppedFallbacks ? `${droppedFallbacks} fallback${droppedFallbacks === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return {
    ok: true,
    message: `removed "${clean}"${extra.length ? ` — and ${extra.join(" and ")}` : ""}${note}`,
  };
}

/**
 * Parse `add <name> [baseUrl|apiKey] [apiKey] [models]` for surfaces where a
 * preset can stand in for the url: `/provider add openrouter sk-or-…` works,
 * and so does `/provider add openrouter https://…/v1 sk-or-… m1,m2`.
 */
export function parseProviderAddArgs(rest: string[]): {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  models?: string[];
} {
  const [name, second, third, fourth] = rest;
  const isUrl = (v?: string): boolean => Boolean(v && /^https?:\/\//.test(v));
  if (isUrl(second)) {
    return { name, baseUrl: second, apiKey: third, models: fourth?.split(",") };
  }
  return { name, apiKey: second, models: third?.split(",") };
}

/** Hit /models and report. Used by `sc provider test`, /provider test. */
export async function testProvider(config: SuparClawConfig, name: string): Promise<AddResult> {
  const key = providerKey(config.providers, name);
  if (!key) return { ok: false, message: `no such provider: ${name.trim()}` };
  const clean = key;
  const p = config.providers?.[key] as ProviderRecord | undefined;
  if (!p) return { ok: false, message: `no such provider: ${key}` };
  const found = await fetchModels(p.baseUrl ?? "", p.apiKey ?? "");
  if (found.error) {
    return { ok: false, message: `${clean}: unreachable — ${found.error}\n  url: ${p.baseUrl}` };
  }
  const head = `${clean}: ok — ${found.models.length} models`;
  const sample = found.models.slice(0, 8).map((m) => `  ${m}`);
  const more = found.models.length > 8 ? `  … and ${found.models.length - 8} more` : "";
  return { ok: true, message: [head, ...sample, more].filter(Boolean).join("\n") };
}

/** Does this surface need a model set before it can answer? Shared hint text. */
export function defaultModelLine(config: SuparClawConfig): string {
  const model = config.agents?.defaults?.model;
  return model ? `model: ${model}` : "model: (unset) — add a provider first: /provider or sc setup";
}
