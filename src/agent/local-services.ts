// Local services — OpenClaw's implicit local-model discovery at our scale.
// A small registry per service (port + probe + wire protocol + config shape),
// LOOPBACK-only probing (never LAN — SSRF-by-detection is a hard no), and a
// merge-add that writes providers.<id> with the discovered models attached.

import type { ConfigService } from "../config/load.js";

export interface LocalServiceInfo {
  id: string;
  label: string;
  /** Default loopback port (their defaults). */
  port: number;
  /** Wire protocol the provider entry declares. */
  api: "openai-completions" | "ollama";
  /** baseUrl written into providers.<id> (native hosts have no /v1!). */
  baseUrl: string;
  /** Loopback probe: liveness AND model inventory in one. */
  probePath: string;
  /** Suggested default model marker when the catalog has entries. */
  hostNote: string;
}

export const LOCAL_SERVICES: LocalServiceInfo[] = [
  {
    id: "ollama",
    label: "Ollama",
    port: 11434,
    api: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    probePath: "/api/tags",
    hostNote: "native /api/chat — the /v1 compat mode breaks tool calling (their warning)",
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    port: 1234,
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1234/v1",
    probePath: "/models",
    hostNote: "OpenAI-compatible /v1",
  },
  {
    id: "vllm",
    label: "vLLM",
    port: 8000,
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:8000/v1",
    probePath: "/models",
    hostNote: "OpenAI-compatible /v1",
  },
  {
    id: "sglang",
    label: "SGLang",
    port: 30000,
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:30000/v1",
    probePath: "/models",
    hostNote: "OpenAI-compatible /v1",
  },
  {
    id: "llamacpp",
    label: "llama.cpp llama-server",
    port: 8080,
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:8080/v1",
    probePath: "/models",
    hostNote: "OpenAI-compatible /v1",
  },
];

export const localServiceById = (id: string): LocalServiceInfo | undefined =>
  LOCAL_SERVICES.find((s) => s.id === id);

export interface LocalScanResult {
  id: string;
  label: string;
  api: LocalServiceInfo["api"];
  baseUrl: string;
  running: boolean;
  models: string[];
  /** context hints per model (ollama /api/show + /v1 models context fields). */
  hints: Record<string, { contextWindow?: number }>;
  note: string;
  error?: string;
}

/** Probe one service. Closed port → offline result within ~1.5s (detection
 * budgets are probe-scoped, their ambient-discovery behavior; never LAN). */
export async function probeLocalService(svc: LocalServiceInfo): Promise<LocalScanResult> {
  const url = svc.api === "ollama" ? svc.baseUrl : svc.baseUrl.replace(/\/v1\/?$/, "");
  const base: LocalScanResult = {
    id: svc.id,
    label: svc.label,
    api: svc.api,
    baseUrl: svc.baseUrl,
    running: false,
    models: [],
    hints: {},
    note: svc.hostNote,
  };
  let res: Response;
  try {
    res = await fetch(`${url}${svc.probePath}`, { signal: AbortSignal.timeout(1_500) });
  } catch (err) {
    return { ...base, error: (err as Error).name === "TimeoutError" ? "no answer on the default port" : "not running" };
  }
  if (!res.ok) return { ...base, error: `probe HTTP ${res.status}` };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ...base, error: "probe returned non-JSON" };
  }

  if (svc.id === "ollama") {
    const models = ((body as { models?: { name?: string }[] }).models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => Boolean(n));
    // Best-effort per-model context: /api/show for every catalog row
    // (their implicit-discovery table: contextWindow + num_ctx parameters).
    const hints: Record<string, { contextWindow?: number }> = {};
    await Promise.all(
      models.slice(0, 12).map(async (name) => {
        try {
          const show = await fetch(`${url}/api/show`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: name }),
            signal: AbortSignal.timeout(1_500),
          });
          if (!show.ok) return;
          const meta = (await show.json()) as {
            model_info?: Record<string, unknown>;
            parameters?: string;
          };
          const ctxKey = Object.keys(meta.model_info ?? {}).find((k) => k.endsWith(".context_length"));
          const direct = ctxKey ? Number(meta.model_info?.[ctxKey]) : 0;
          const numCtx = /num_ctx\s+(\d+)/i.exec(meta.parameters ?? "")?.[1];
          const cw = Number.isFinite(direct) && direct > 0 ? direct : numCtx ? Number(numCtx) : 0;
          if (cw > 0) hints[name] = { contextWindow: cw };
        } catch {
          /* per-model caps are best-effort */
        }
      }),
    );
    return { ...base, running: true, models, hints };
  }

  const data = ((body as { data?: { id?: string; context_length?: number }[] }).data ?? []).filter(Boolean);
  const models: string[] = [];
  const hints: Record<string, { contextWindow?: number }> = {};
  for (const m of data) {
    if (!m.id) continue;
    models.push(m.id);
    if (typeof m.context_length === "number" && m.context_length > 0) hints[m.id] = { contextWindow: m.context_length };
  }
  return { ...base, running: true, models, hints };
}

/** All services in parallel — a catalog read shaped exactly for UIs. */
export async function scanLocalServices(): Promise<LocalScanResult[]> {
  return Promise.all(LOCAL_SERVICES.map((s) => probeLocalService(s)));
}

/**
 * Add (or merge) a probed service into config: providers.<id> gets the
 * service's native baseUrl + api flavor + the discovered catalog merged into
 * any pinned models (their implicit-discovery preserve: configured wins on
 * conflict; new pulls appear beside them, not instead of them).
 */
export function addLocalService(
  cfg: ConfigService,
  id: string,
  scan: LocalScanResult,
): { ok: boolean; message: string; models: string[] } {
  const svc = localServiceById(id);
  if (!svc) return { ok: false, message: `unknown local service "${id}"`, models: [] };
  if (!scan.running) return { ok: false, message: `${svc.label} is not running (${scan.error ?? "no answer"})`, models: [] };
  const existing = ((cfg.current.providers?.[id] as Record<string, unknown> | undefined)?.models ?? []) as string[];
  const merged = [...new Set([...existing, ...scan.models])].slice(0, 200);
  cfg.setPath(`providers.${id}.baseUrl`, svc.baseUrl);
  cfg.setPath(`providers.${id}.api`, svc.api);
  cfg.setPath(`providers.${id}.models`, merged);
  // Local services accept any sentinel credential slot; profile binding
  // (#6) replaces it when the user later signs a profile in.
  if (!(cfg.current.providers[id] as Record<string, unknown> | undefined)?.["apiKey"]) {
    cfg.setPath(`providers.${id}.apiKey`, `${id}-local`);
  }
  return {
    ok: true,
    message: `${svc.label} added — ${merged.length} model(s) (${svc.api === "ollama" ? "native api" : "openai-compatible"})`,
    models: merged,
  };
}
