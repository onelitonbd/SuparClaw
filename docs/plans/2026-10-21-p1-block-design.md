# P1 block — compaction, webhooks, Telegram media, OpenAI endpoint

Sheet rows `Missing!A2, A4, A5, A6` (all P1). Researched against vendored
`docs/openclaw/` (compaction.md, gateway/openai-http-api.md,
automation/cron-jobs/webhooks.md, channels/telegram/media.md) + live web
(2026-10-21 — contracts unchanged). Ships as four commits, one tick each.

## A4 — Inbound HTTP webhooks (`POST /hooks/:name`)

Upstream: `hooks{enabled,token,path}`, token via Bearer/x-openclaw-token,
POST-only JSON, `/hooks/wake` (trusted notify → main session),
`/hooks/agent` (isolated/persistent agent turn), mapped `/hooks/<name>`
via config mappings + payload templates. Responses: `{"ok":true,...}`,
401 wrong token, 404 disabled, 405 non-POST, 413 oversize.

Our scale (single agent, zero deps):
- Config top-level `hooks:{enabled:false, token:"", path:"/hooks",
  allowRequestSessionKey:false, mappings: Record<name,{action:"wake"|"agent",
  text,message,sessionKey}>}`.
- `src/gateway/webhooks.ts.handleHooksRequest(service,req,res)` — claimed
  before static UI. Query-string token rejected (their rule). Empty
  configured token while enabled ⇒ startup log warn + 503 per request.
- wake → `service.send(main:main, "[hook wake] <text>", source:"webhook")`,
  queueMode followup; `mode:"next-heartbeat"` accepted with a `note`
  (no heartbeat engine — delivered now).
- agent → default session `hook:agent:<stamp>-<rand>`; caller-supplied
  sessionKey only with `allowRequestSessionKey` and never in reserved
  namespaces (`subagent:|cron:|acp:|system:`). Response carries sessionKey.
- Template rendering `{{json}}` `{{name}}` `{{field}}` (top-level scalars),
  clamped at 32KB.
- Delivery modes (announce/channel routing) OUT — output lands in the
  session transcript + event stream. Reply-side webhooks are P2 row-14.

## A6 — OpenAI-compatible HTTP endpoint

Upstream: `gateway.http.endpoints.chatCompletions.enabled` (default off),
POST `/v1/chat/completions`, GET `/v1/models{,/id}`, agent-first model
contract, token auth = gateway token, stateless per request unless `user`
(→ stable session) or `x-openclaw-session-key`.

Our scale:
- Config `gateway.http.endpoints.chatCompletions:{enabled:false}`.
- `src/gateway/openai-http.ts`: POST chat/completions gathers the last
  user text (or input string), runs `service.send` on a sessionKey =
  header (reserved namespaces rejected) else `user` ⇒ `http:openai:<sha>`
  else fresh `http:openai-<rand>`; `x-openclaw-model` overrides run model.
- Non-stream: full JSON chat.completion w/ usage when available.
  `stream:true` ⇒ SSE `chat.completion.chunk` deltas + `[DONE]`.
- `/v1/models` lists `["openclaw","openclaw/default"]` detail; we are
  single-agent — documented.
- `/v1/embeddings`/`/v1/responses`/scopes/trusted-proxy ⇒ 501, OUT.

## A2 — Context compaction (summarizing)

Upstream: auto-compact near context limit + on overflow errors, one summary
model request, summary stored in transcript, recent kept verbatim, tool-call
pair boundaries respected, memory flush first, `/compact`, `/status` count.

Our scale (char-budget loop we already own):
- New `src/agent/compaction.ts` + `session_summaries(session_id, upto,
  summary, chars, updated)` table (incremental — summary rewrites extend
  their `upto`, never resummarize the tail).
- Loop context build (before char truncation): when transcript tail exceeds
  `agents.defaults.contextBudgetChars`, produce/refresh a background
  summarization (tool-free completion like dream/auto-title) of
  messages[old .. mid]; context = `[summary entry visualization] + tail
  (last ~35 entry pairs)`.
- Summary text is bounded (≤ ~6000 chars), stores provenance (upto msg id).
- `/compact [instructions]` command via the shared router (forces a sweep
  now, optional focus text folded into the prompt; reply = stats).
- `/status` prints `compactions: N`.
- Overflow error recovery: provider overflow classification in llm retry
  → force immediate compaction + single retry within the turn.
- OUT: quality-audit corrective passes, split-turn budgets, CJK tallies,
  provider-native checkpoint replay, memory-flush hook (we have daily
  dreaming instead).

## A5 — Telegram media inbound

Upstream: photo albums→vision, voice transcripts framed as untrusted,
stickers→placeholder, mediaMaxMb, getFile download pipeline.

Our scale:
- `channels/telegram.ts` inbound: photo (largest size), document (≤maxMB,
  any mime), voice — `getFile` → download to `<workspace>/media/
  telegram/<chatId>/<ts>-<id><ext>` (sanitized, `mediaMaxMb` cap default 20).
- Photos become OpenAI `image_url` content parts (base64 data URI)
  attached to the injected user turn; the loop's model payload learns
  content-part arrays (passthrough when present). Provider error ⇒ retry
  this turn once with the text-only fallback note (`[image omitted -
  provider text-only]`). Config `channels.telegram.vision:true` to opt out.
- Voice/doc/other: text placeholder `<media:voice path="…">` saved to
  media/ so the agent can `fs_read` it on request; no STT (that's P3 #22).
- Album images handled individually (no media_group correlation) — noted.

## Verification

- `test/webhooks.test.mjs` (~9): disabled 404, no-token 503, bad bearer
  401, query-token rejected, method 405, wake queued + main session row,
  agent custom sk + reserved-ns reject, mapped template render, oversize.
- `test/openai-http.test.mjs` (~9): disabled 404, auth 401, completion
  JSON shape, stream SSE framing, models list/detail, user→stable key,
  reserved sk reject, embeddings 501, model override header.
- `test/compaction.test.mjs` (~10): incremental store, boundary pairing,
  budget math, compact cmd, status count, overflow retry harness
  (stubbed llm), instructions fold, transcript untouched.
- `test/telegram-media.test.mjs` (~8): getFile stub, photo parts,
  vision fallback retry, voice/doc placeholders, size cap, sanitize,
  disabled flag, captions.
- Each feature: bump suite, clean-checkout verify, tick its A-row.
