# Partial #7 — Local models: Ollama autodetect + local services

Gap (sheet): *OpenClaw has "Ollama autodetect + local services"; SuparClaw has "works manually via OpenAI-compatible base URL".*

## Their system (vendored docs/providers/ollama* + live research)

- Ollama = **implicit discovery**: `/api/tags` on `127.0.0.1:11434` feeds the catalog when a credential OR an ambient local provider exists; `/api/show` fills capability hints (context window / num_ctx, vision, tools, **thinking**). Offline server → last good inventory kept; configured-but-missing models get a warning, never a rejection.
- **Native API, not /v1**: their WARNING — `/v1` OpenAI-compat mode breaks tool calling (raw tool JSON leaks into text). Provider entries select transports via `api: "ollama" | "openai-completions"`.
- Local services beyond Ollama all speak OpenAI-compat `/v1`: LM Studio :1234, vLLM :8000, SGLang :30000, llama.cpp llama-server :8080, oMLX :8000/v1. Sensible per-service defaults + zero-key auth (any sentinel token).
- :cloud refs through a signed-in local host + a hosted `ollama-cloud` provider — separate rows.

## What ships (our scale)

1. **`providers.<name>.api`** enum: `openai-completions` (default) | `ollama` (native). PRESETS' Ollama URL switches to the native host (`http://127.0.0.1:11434`, no `/v1`); legacy `/v1` configs keep working unchanged.
2. **Native Ollama transport in LlmClient** (`#streamOnce` branches on `api==="ollama"`): NDJSON `/api/chat`, openai→ollama message shaping, tools passthrough, `think: false|true` from the configured reasoning effort (`off` → false), thinking-stream → our reasoning events, complete tool_calls at done, usage from `prompt_eval_count/eval_count`. Instant-7 retries/fallbacks/auth-feedback untouched.
3. **`src/agent/local-services.ts` — the autodetect registry**: per service {id, label, port, probe, api, baseUrl, models parse}. Loopback-only scans (never LAN). Services: **ollama** (`/api/tags` + best-effort `/api/show` context), **llama.cpp** (:8080 `/health`+`/v1/models`), **LM Studio** (:1234), **vLLM** (:8000), **SGLang** (:30000), each via `/v1/models`; `ollama-cloud` joins the plugin catalog as a cloud row. `scanLocalServices()` is offline-instant on closed ports; `addLocalService(cfg, id)` writes providers.<service> with native api + discovered models (mode: merge with any pinned rows, `ollama/llama3.2` style refs live-resolvable by the catalog as is).
4. **Surfaces**: `sc models local [--json] [--add <id>|all] [--set-default]`; `sc doctor` gains a local-services line (found / none / configured-but-stopped with hint); gateway RPC `models.local.scan` + `models.local.add`; UI Models tab **"Local services"** card: auto-scan badge per service, one-tap **Add** (writes provider + fetched models), per-service discovered model chips with the same check-mark curation flow (models still only configured by choosing).
5. **Notable absence (documented, not papered)**: :cloud ref validation, node-local paired routing, OLLAMA embeddings scope (no embeddings engine here), `models.mode: "replace"`.

## Tests

schema/api enum guard · local scan parsers (tags/show/models JSON on stub ports: ollama ndjson transport end-to-end over a stub /api/chat — token stream, thinking events, one tool_call + args, usage counts, `think:false` for off · scan on closed ports returns offline `unknown` fast · add-local writes api=ollama + models · CLI `models local` json · UI RPC payload shape · all 170 remain green.