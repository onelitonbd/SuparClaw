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
}

export const PRESETS: Preset[] = [
  { name: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", needsKey: true },
  { name: "openrouter", label: "OpenRouter (many models, one key)", baseUrl: "https://openrouter.ai/api/v1", needsKey: true },
  { name: "groq", label: "Groq (fast, cheap)", baseUrl: "https://api.groq.com/openai/v1", needsKey: true },
  { name: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", needsKey: true },
  { name: "ollama", label: "Ollama (on this device)", baseUrl: "http://127.0.0.1:11434/v1", needsKey: false },
  { name: "lmstudio", label: "LM Studio (on this device)", baseUrl: "http://127.0.0.1:1234/v1", needsKey: false },
  { name: "custom", label: "Custom OpenAI-compatible URL", baseUrl: "", needsKey: true },
];

export const presetByName = (name: string): Preset | undefined =>
  PRESETS.find((p) => p.name === name.toLowerCase());

/** Ask a provider for its model list. Never throws — failures come back as .error. */
export async function fetchModels(baseUrl: string, apiKey: string): Promise<{ models: string[]; error?: string }> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  try {
    const res = await fetch(url, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return { models: [], error: `HTTP ${res.status}` };
    const body = (await res.json()) as { data?: { id?: string }[] };
    const models = (body.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
    return { models };
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
const cache = new Map<string, { at: number }>();

const ttlMs = (): number => {
  const raw = Number(process.env["SUPARCLAW_MODELS_TTL_MS"] ?? "");
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_TTL_MS;
};

export interface ModelsResult {
  /** "<provider>/<model>" refs: configured rows plus any discovered ones. */
  models: string[];
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
): Promise<{ models: string[]; error?: string }> {
  const p = cfg.current.providers?.[name] as ProviderRecord | undefined;
  if (!p) return { models: [], error: `no such provider: ${name}` };
  const key = `${name}@${p.baseUrl}`;
  const saved = (p.models ?? []).filter(Boolean);
  const found = await fetchModels(p.baseUrl ?? "", p.apiKey ?? "");
  if (found.error || found.models.length === 0) {
    return { models: saved, error: found.error ?? "empty listing" };
  }
  cache.set(key, { at: Date.now() });
  const merged = [...new Set([...saved, ...found.models])].slice(0, 200);
  if (merged.length !== saved.length || merged.some((m, i) => m !== saved[i])) {
    cfg.setPath(`providers.${name}.models`, merged);
  }
  return { models: merged };
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
  for (const [name, p] of Object.entries(cfg.current.providers ?? {})) {
    for (const m of (p as ProviderRecord).models ?? []) out.push(`${name}/${m}`);
  }
  if (out.length === 0) {
    const model = cfg.current.agents?.defaults?.model;
    if (model) out.push(model);
  }
  const result: ModelsResult = { models: out };
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

export interface AddResult {
  ok: boolean;
  message: string;
}

/** Write a provider. When no models are given, discover them from the endpoint. */
export async function addProvider(
  cfg: ConfigService,
  name: string,
  opts: { baseUrl?: string; apiKey?: string; models?: string[] } = {},
): Promise<AddResult> {
  const clean = name.trim().toLowerCase();
  if (!clean) return { ok: false, message: "provider name is required" };
  if (!/^[\w.-]+$/.test(clean)) {
    return { ok: false, message: "provider name may only contain letters, digits, . - _" };
  }

  const preset = presetByName(clean);
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
  });
  if (!saved.ok) return { ok: false, message: saved.errors.join("; ") || "could not save" };

  const parts = [`provider "${clean}" saved`];
  if (discovered) parts.push(`discovered ${models.length} models`);
  else if (models.length > 0) parts.push(`${models.length} models`);
  else if (discoverError) parts.push(`no models found (${discoverError}) — add some with: --models <a,b,c>`);
  else parts.push("no models found — add some with: --models <a,b,c>");
  parts.push(`default: /model ${clean}/${models[0] ?? "<model>"}`);
  return { ok: true, message: parts.join("\n") };
}

export function removeProvider(cfg: ConfigService, name: string): AddResult {
  const clean = name.trim().toLowerCase();
  const providers = { ...(cfg.current.providers ?? {}) };
  if (!providers[clean]) {
    return { ok: false, message: `no such provider: ${clean}` };
  }
  delete providers[clean];
  const saved = cfg.setPath("providers", providers);
  if (!saved.ok) return { ok: false, message: saved.errors.join("; ") };
  const stillDefault = cfg.current.agents?.defaults?.model ?? "";
  const note = stillDefault.startsWith(`${clean}/`) ? `\nwarning: default model "${stillDefault}" now points at a removed provider` : "";
  return { ok: true, message: `removed "${clean}"${note}` };
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
  const clean = name.trim().toLowerCase();
  const p = config.providers?.[clean] as ProviderRecord | undefined;
  if (!p) return { ok: false, message: `no such provider: ${clean}` };
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
