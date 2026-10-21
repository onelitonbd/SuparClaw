# Partial #9 — Web search backends (design)

Date: 2026-10-21 · Sheet row: `Partial!A10` · Base: `046bd04`

## Gap

OpenClaw: `web_search` is a **provider-managed** tool — ~16 backends (Brave,
Perplexity, Tavily, Kimi, Exa, Firecrawl, Gemini, Grok, DuckDuckGo, SearXNG,
MiniMax, Ollama, Parallel, Codex/DeepSeek hosted), auto-detected by credential
priority, with a closed normalized result shape, a 15-min query cache, and
explicit/fallback selection semantics.

Us: one hard-coded DuckDuckGo HTML scrape behind `tools.web.search: bool`.

## Constraints

- Zero-dep, phone-first (no Puppeteer): all backends are plain HTTP+JSON except
  DuckDuckGo's documented-experimental HTML scrape (kept only as explicit opt-in).
- Rule 9: **no timeouts** — fetches ride the run's abort signal only.
- No `plugins.entries.*` (that's upstream's plugin system); provider credentials
  and options live under `tools.web.search.<provider>.*` at our scale.
- Sandbox egress note (test reality): unit tests run against local stub servers;
  provider endpoints in tests never leave localhost.

## Config surface (`tools.web.search`)

```json5
{
  tools: {
    web: {
      fetch: true,                    // unchanged
      search: {                       // upgraded from bool (bool stays accepted)
        enabled: true,                // default true (previously: tools.web.search bool)
        provider: "",                 // "" = auto-detect
        maxResults: 5,                // 1..10
        cacheTtlMinutes: 15,          // 0 = bypass cache entirely
        duckduckgo: { baseUrl: "https://html.duckduckgo.com" },     // key-free, opt-in only
        searxng:    { baseUrl: "" },                                 // self-hosted, opt-in (needs baseUrl)
        brave:      { apiKey: "", baseUrl: "https://api.search.brave.com" },
        perplexity: { apiKey: "", baseUrl: "https://api.perplexity.ai" },
        tavily:     { apiKey: "", baseUrl: "https://api.tavily.com" },
        kimi:       { apiKey: "", baseUrl: "" },                    // "" = follow models.providers.moonshot.baseUrl
      },
    },
  },
}
```

Backward compat: legacy `tools.web.search: true|false` maps to
`{ enabled: bool, provider: "" }` (`false` = search tool absent, as before).

## Backends (6, all `search(args, ctx) => ProviderResult`)

| id | kind | auth | endpoint | auto-detect order |
|----|------|------|----------|-------------------|
| `brave` | results | `apiKey` or `BRAVE_API_KEY` | `GET <base>/res/v1/web/search?q=&count=` + `X-Subscription-Token` | 10 |
| `perplexity` | results | apiKey / `PERPLEXITY_API_KEY` | `GET <base>/search?q=&max_results=` (native Search API) | 50 |
| `tavily` | results | apiKey / `TAVILY_API_KEY` | `POST <base>/search` `{query, max_results}` | 70 |
| `kimi` | results | apiKey / `KIMI_API_KEY` / `MOONSHOT_API_KEY` | `POST <resolvedBase>/tools/search` `{text_query, limit}` (region resolved: explicit baseUrl → LLM provider moonshot baseUrl → ai host) | 40 |
| `searxng` | results | none | `GET <base>/search?q=&format=json` | 200 (requires configured baseUrl) |
| `duckduckgo` | results | none | `GET <base>/html/?q=` (HTML scrape) | **never auto** (explicit only) |

Auto-detect = first ready provider ascending order; explicit provider never
falls back (their rule); a failed auto pick falls through to the next.
Key-free backends never win auto-detect, matching upstream.

## Normalized output (closed shape, model-facing)

```ts
type WebSearchResultItem = { title: string; url: string; snippet?: string; published?: string; siteName?: string };
type WebSearchOutput =
  | { kind: "results"; provider: string; query: string; count: number; tookMs?: number; results: WebSearchResultItem[]; cached?: true }
  | { kind: "error"; provider: string; error: "provider_error" | "not_configured"; message: string }
```
Model-facing text rendering: `results` → `title\nurl\nsnippet` blocks (same
layout the DuckDuckGo path returns today, so prompts stay stable); `error` →
`error: ...` string the tool-loop already understands. `externalContent`
wrapping (upstream) is OUT — documented below.

## WebSearchOutput.__proto__... (n/a) — caching

In-memory LRU keyed `provider:query:countHash`, 64 entries, TTL from
`cacheTtlMinutes`; `0` bypasses read+write; per (`Service`) lifecycle.
`cached?: true` marks a hit in the structured output; text keeps its layout.

## Tool + loop changes

- `web_search` tool: params `{query, count?, provider?}` (per-call provider
  override for experts), registry lookup, cache read/write, text render.
- Registration requires `tools.web.search.enabled !== false`, same as today.
- Nothing else in the loop changes; `tools.list`/`tools web` describe the active provider.

## CLI + surfaces

- `sc search <query> [--provider id] [--count n] [--json]` — one-shot probe,
  same resolution as the tool (auto-detect or explicit), exits 1 on error.
- `sc doctor` gains a **web search** check: enabled state, active provider
  (or `"none ready"` with the first missing-credential hint), cache TTL.
- Settings → Tools card **"Web search"**: provider pills (Auto + 6), key
  field for API-backed ones, SearXNG/DuckDuckGo baseUrl fields, cache TTL,
  and a **Test** button (`web.search.test` RPC) with latency + first titles.
- WS RPC: `web.search.get` (effective config sans secrets), `web.search.test`.

## Tests (`test/web-search.test.mjs`)

- Result-shape contract per backend (stub servers): normalization, empty
  result sets, HTTP/status error mapping, auth-header/region resolution.
- Auto-detect order + never-pick-keyfree + explicit-never-falls-back.
- Cache: hit/miss/TTL=0 bypass/corevariant count keys.
- Legacy bool mapping; provider param override; unsupported provider error.
- CLI: probe happy path + not-configured exit code.

## Trust & safety

- API keys: env-first, same redaction posture as LLM keys (`config redact`).
- DuckDuckGo scrape kept behind explicit opt-in only (upstream matches).
- Public endpoints must be `https://`; `http://` accepted only for loopback/
  RFC-1918 host parts (their rule, narrowed to parseable host).
- Model-facing text is untrusted web content by construction; we do **not**
  add an `externalContent` marker upstream has (their model wraps it). OUT —
  our prompt-side hygiene for fetched content is a separate task.
- SSRF: no `web_fetch` fallback chain in this task; providers posts GET/POST
  only to their configured
bases.

## Explicit OUT (documented)

Freshness/date/country filters on API backends beyond `count` (Brave/perplexity
support them upstream; ours only forwards `count`), native OpenAI/Codex hosted
search, x_search, DeepSeek/Exa/Grok/Gemini/Firecrawl/Ollama/Parallel providers,
SecretRef, Tool-Search/Code-Mode catalogue interplay, `web_fetch` plugin
fallbacks, Minimax/China-Kimi region toggle (Kimi inherits from
`models.providers.moonshot.baseUrl` automatically — documented).
