// Partial #9 — provider-managed web_search backends (their tools/web, our scale:
// 6 backends, plain HTTP, zero-dep; DuckDuckGo stays an explicit opt-in).
//
// Registry with fixed auto-detect order (upstream's orders, reduced).
// A backend reports `ready(cfg)` based ONLY on credentials/config presence —
// liveness is proven by calling it, matching upstream's "configured ≠ working".
import type { SuparClawConfig } from "../config/schema.js";

export interface WebSearchArgs {
  query: string;
  count?: number;
  signal?: AbortSignal;
}

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet?: string;
  published?: string;
  siteName?: string;
}

export type WebSearchOutput =
  | {
      kind: "results";
      provider: string;
      query: string;
      count: number;
      tookMs?: number;
      results: WebSearchResultItem[];
      cached?: true;
    }
  | { kind: "error"; provider: string; error: "provider_error" | "not_configured"; message: string };

interface WebSearchBackend {
  id: string;
  /** ascending; key-free providers carry >200 and are never auto-picked */
  order: number;
  keyFree: boolean;
  ready(cfg: SuparClawConfig): boolean;
  call(args: { query: string; count: number; signal?: AbortSignal }, cfg: SuparClawConfig): Promise<WebSearchResultItem[]>;
}

const asResults = (out: unknown[]): WebSearchResultItem[] =>
  out.filter((r): r is WebSearchResultItem => !!r && typeof r === "object" && typeof (r as { url?: unknown }).url === "string");

const httpError = async (res: Response): Promise<never> => {
  // Bodies from upstream APIs can carry anything; diagnostics keep status only.
  throw new Error(`HTTP ${res.status}`);
};

const json = async (res: Response): Promise<unknown> => {
  if (!res.ok) await httpError(res);
  return res.json() as Promise<unknown>;
};

// ---------- backends ----------

const brave: WebSearchBackend = {
  id: "brave",
  order: 10,
  keyFree: false,
  ready: (cfg) => Boolean(cfg.tools.web.search.brave.apiKey || process.env["BRAVE_API_KEY"]),
  async call({ query, count, signal }, cfg) {
    const key = cfg.tools.web.search.brave.apiKey || process.env["BRAVE_API_KEY"] || "";
    const base = cfg.tools.web.search.brave.baseUrl.replace(/\/+$/, "");
    const url = `${base}/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.max(1, Math.min(count, 20))}`;
    const data = (await json(await fetch(url, { signal, headers: { accept: "application/json", "x-subscription-token": key } }))) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string; age?: string; meta_url?: { hostname?: string } }> };
    };
    return asResults(
      (data.web?.results ?? []).map((r) => ({
        title: String(r.title ?? ""),
        url: String(r.url ?? ""),
        snippet: r.description,
        published: r.age,
        siteName: r.meta_url?.hostname,
      })),
    );
  },
};

const perplexity: WebSearchBackend = {
  id: "perplexity",
  order: 50,
  keyFree: false,
  ready: (cfg) => Boolean(cfg.tools.web.search.perplexity.apiKey || process.env["PERPLEXITY_API_KEY"]),
  async call({ query, count, signal }, cfg) {
    const key = cfg.tools.web.search.perplexity.apiKey || process.env["PERPLEXITY_API_KEY"] || "";
    const base = cfg.tools.web.search.perplexity.baseUrl.replace(/\/+$/, "");
    const url = `${base}/search?q=${encodeURIComponent(query)}&max_results=${Math.max(1, Math.min(count, 10))}`;
    const data = (await json(await fetch(url, { signal, headers: { accept: "application/json", authorization: `Bearer ${key}` } }))) as {
      results?: Array<{ title?: string; url?: string; snippet?: string; published_date?: string; source?: string }>;
    };
    return asResults(
      (data.results ?? []).map((r) => ({
        title: String(r.title ?? ""),
        url: String(r.url ?? ""),
        snippet: r.snippet,
        published: r.published_date,
        siteName: r.source,
      })),
    );
  },
};

const tavily: WebSearchBackend = {
  id: "tavily",
  order: 70,
  keyFree: false,
  ready: (cfg) => Boolean(cfg.tools.web.search.tavily.apiKey || process.env["TAVILY_API_KEY"]),
  async call({ query, count, signal }, cfg) {
    const key = cfg.tools.web.search.tavily.apiKey || process.env["TAVILY_API_KEY"] || "";
    const base = cfg.tools.web.search.tavily.baseUrl.replace(/\/+$/, "");
    const data = (await json(
      await fetch(`${base}/search`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ query, max_results: Math.max(1, Math.min(count, 10)) }),
      }),
    )) as { results?: Array<{ title?: string; url?: string; content?: string; published_date?: string }> };
    return asResults(
      (data.results ?? []).map((r) => ({
        title: String(r.title ?? ""),
        url: String(r.url ?? ""),
        snippet: r.content,
        published: r.published_date,
      })),
    );
  },
};

/** Kimi region: explicit web-search baseUrl wins; otherwise inherit the LLM moonshot host (keeps .cn keys off the .ai host). */
export function kimiBaseUrl(cfg: SuparClawConfig): string {
  const explicit = cfg.tools.web.search.kimi.baseUrl.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const llm = cfg.providers?.["moonshot"]?.baseUrl?.replace(/\/+$/, "");
  return llm || "https://api.moonshot.ai/v1";
}

const kimi: WebSearchBackend = {
  id: "kimi",
  order: 40,
  keyFree: false,
  ready: (cfg) => Boolean(cfg.tools.web.search.kimi.apiKey || process.env["KIMI_API_KEY"] || process.env["MOONSHOT_API_KEY"]),
  async call({ query, count, signal }, cfg) {
    const key = cfg.tools.web.search.kimi.apiKey || process.env["KIMI_API_KEY"] || process.env["MOONSHOT_API_KEY"] || "";
    const data = (await json(
      await fetch(`${kimiBaseUrl(cfg)}/tools/search`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ text_query: query, limit: Math.max(1, Math.min(count, 10)) }),
      }),
    )) as { search_result?: Array<{ title?: string; url?: string; snippet?: string; site_name?: string; date?: string }>; results?: Array<{ title?: string; url?: string; snippet?: string; siteName?: string; date?: string }> };
    const rows = data.search_result ?? data.results ?? [];
    return asResults(
      rows.map((r) => ({
        title: String(r.title ?? ""),
        url: String(r.url ?? ""),
        snippet: (r as { snippet?: string }).snippet,
        siteName: (r as { site_name?: string }).site_name ?? (r as { siteName?: string }).siteName,
        published: r.date,
      })),
    );
  },
};

const searxng: WebSearchBackend = {
  id: "searxng",
  order: 200,
  keyFree: true,
  ready: (cfg) => Boolean(cfg.tools.web.search.searxng.baseUrl.trim()),
  async call({ query, count, signal }, cfg) {
    const base = cfg.tools.web.search.searxng.baseUrl.trim().replace(/\/+$/, "");
    const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`;
    const data = (await json(await fetch(url, { signal, headers: { accept: "application/json" } }))) as {
      results?: Array<{ title?: string; url?: string; content?: string; publishedDate?: string; engine?: string }>;
    };
    return asResults(
      (data.results ?? [])
        .slice(0, Math.max(1, Math.min(count, 10)))
        .map((r) => ({
          title: String(r.title ?? ""),
          url: String(r.url ?? ""),
          snippet: r.content,
          published: r.publishedDate,
        })),
    );
  },
};

const duckduckgo: WebSearchBackend = {
  id: "duckduckgo",
  order: 900, // key-free & experimental: never auto-selected
  keyFree: true,
  ready: () => true,
  async call({ query, count, signal }, cfg) {
    const base = cfg.tools.web.search.duckduckgo.baseUrl.trim().replace(/\/+$/, "");
    const res = await fetch(`${base}/html/?q=${encodeURIComponent(query)}`, {
      signal,
      headers: { "user-agent": "Mozilla/5.0 (Linux; Android) SuparClaw/0.1" },
    });
    if (!res.ok) await httpError(res);
    const html = await res.text();
    const results: WebSearchResultItem[] = [];
    const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null && results.length < Math.max(1, Math.min(count, 10))) {
      results.push({
        title: (m[2] ?? "").replace(/<[^>]+>/g, "").trim(),
        url: decodeURIComponent(/uddg=([^&]+)/.exec(m[1] ?? "")?.[1] ?? m[1] ?? ""),
        snippet: (m[3] ?? "").replace(/<[^>]+>/g, "").trim(),
      });
    }
    return results;
  },
};

export const WEB_SEARCH_BACKENDS: readonly WebSearchBackend[] = [brave, kimi, perplexity, tavily, searxng, duckduckgo];

export const backendById = (id: string): WebSearchBackend | undefined => WEB_SEARCH_BACKENDS.find((b) => b.id === id);

/** Effective provider: explicit wins (never falls back); else first ready non-key-free backend by order. seraxng is key-free but configured-endpoint based: its explicit baseUrl means a ready key-free candidate upstream WOULD pick (order 200). DuckDuckGo never auto. */
export function resolveProvider(cfg: SuparClawConfig, explicit?: string): { provider?: WebSearchBackend; candidates: WebSearchBackend[]; configuredEmpty: boolean } {
  const chosen = (explicit ?? cfg.tools.web.search.provider).trim();
  if (chosen) {
    const found = backendById(chosen);
    return { provider: found, candidates: found ? [found] : [] , configuredEmpty: !found };
  }
  const candidates = WEB_SEARCH_BACKENDS.filter((b) => !b.keyFree || b.id === "searxng")
    .filter((b) => b.ready(cfg))
    .sort((a, b) => a.order - b.order);
  return { provider: candidates[0], candidates, configuredEmpty: candidates.length === 0 };
}

// ---------- cache (in-memory LRU; 0 TTL = bypass) ----------

interface CacheEntry { at: number; out: WebSearchOutput }
const MAX_CACHE = 64;

export class WebSearchCache {
  #map = new Map<string, CacheEntry>();
  #ttlMinutes: number;

  constructor(ttlMinutes: number) {
    this.#ttlMinutes = ttlMinutes;
  }

  get(key: string): WebSearchOutput | null {
    if (this.#ttlMinutes <= 0) return null;
    const hit = this.#map.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > this.#ttlMinutes * 60_000) {
      this.#map.delete(key);
      return null;
    }
    // LRU touch
    this.#map.delete(key);
    this.#map.set(key, hit);
    const out = hit.out;
    if (out.kind === "error") return out;
    return { ...out, cached: true };
  }

  set(key: string, out: WebSearchOutput): void {
    if (this.#ttlMinutes <= 0) return;
    if (this.#map.has(key)) this.#map.delete(key);
    this.#map.set(key, { at: Date.now(), out });
    while (this.#map.size > MAX_CACHE) {
      const oldest = this.#map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#map.delete(oldest);
    }
  }
}

// ---------- facade ----------

/** One ready provider call chain: explicit ⇒ single attempt (no fallback); auto ⇒ walk candidates until success, first error surfaces if all fail. */
export async function webSearch(
  cfg: SuparClawConfig,
  args: WebSearchArgs & { provider?: string; cache?: WebSearchCache },
): Promise<WebSearchOutput> {
  if (!cfg.tools.web.search.enabled) {
    return { kind: "error", provider: "disabled", error: "not_configured", message: "web search is disabled (tools.web.search.enabled=false)" };
  }
  const { provider, candidates, configuredEmpty } = resolveProvider(cfg, args.provider);
  const explicit = Boolean((args.provider ?? cfg.tools.web.search.provider).trim());
  if (!provider) {
    return {
      kind: "error",
      provider: explicit ? (args.provider ?? cfg.tools.web.search.provider).trim() : "auto",
      error: "not_configured",
      message: explicit
        ? `unknown web-search provider "${(args.provider ?? cfg.tools.web.search.provider).trim()}"`
        : configuredEmpty
          ? "no web-search provider ready — set an API key (BRAVE_API_KEY, TAVILY_API_KEY, …) or a SearXNG baseUrl"
          : "no web-search provider configured",
    };
  }
  const count = Math.max(1, Math.min(args.count ?? cfg.tools.web.search.maxResults ?? 5, 10));
  const candidatesNow = explicit ? [provider] : candidates;
  if (candidatesNow.length === 0) {
    return { kind: "error", provider: provider.id, error: "not_configured", message: `provider "${provider.id}" is not ready (missing credentials/config)` };
  }

  let firstError = "";
  for (const b of candidatesNow) {
    const key = `${b.id}:${queryKey(args.query)}:${count}`;
    const cached = args.cache?.get(key);
    if (cached) return cached;
    const start = Date.now();
    try {
      const results = await b.call({ query: args.query, count, signal: args.signal }, cfg);
      // empty result list is a successful search, upstream parity
      const out: WebSearchOutput = { kind: "results", provider: b.id, query: args.query, count: results.length, tookMs: Date.now() - start, results };
      args.cache?.set(key, out);
      return out;
    } catch (err) {
      firstError = firstError || `${b.id}: ${(err as Error).message}`;
      if (explicit) break;
      // auto: fall through to the next ready provider
    }
  }
  return { kind: "error", provider: candidatesNow[0]!.id, error: "provider_error", message: `web search failed — ${firstError}` };
}

const queryKey = (q: string): string => q.trim().toLowerCase().replace(/\s+/g, " ");

/** Model-facing text: same title/url/snippet block layout the DDG path returns today. */
export function renderSearchText(out: WebSearchOutput): string {
  if (out.kind === "error") return `error: ${out.message}`;
  if (out.results.length === 0) return "no results";
  return out.results.map((r) => `${r.title}\n${r.url}\n${r.snippet ?? ""}`.trimEnd()).join("\n\n");
}
