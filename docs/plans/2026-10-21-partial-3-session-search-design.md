# Partial #3 — Session search (design)

Gap row (Partial #3, Sessions): theirs = "dedicated session search page",
ours = "memory_search tool only". Follow-up: **search box in session list UI
+ `sc sessions search`** (priority P2).

Research (rule 2 + skills loaded per docs/skills/README.md):
- `docs/openclaw/concepts/session-search.md`: user+assistant text only, tool
  results / reasoning / images excluded; literal words (punctuation is never
  query syntax); ≤25 hits, 300-char excerpts, 32 KiB budget; hits carry
  sessionKey + sessionId + messageId; reopen via anchored `sessions_history`
  (limit bounds surroundings; off-path/missing anchor → empty, never the
  newest tail); same-transaction indexing; delete removes entries transaction-
  ally; Control UI groups results under Sessions (title match) / Messages
  (transcript match), last query word is a prefix match, preceding words are
  full-word; ungrouped spawned/subagent runs stay out of the palette.
- Upstream internet check (Sept–Oct 2026): gateway RPC name is literally
  `sessions.search`; `openclaw sessions search <query>` CLI prints ranked hits
  with session key, role, ISO time, score, one-line snippet; `--session`
  (repeatable), `--limit` (1–25), `--json`; non-zero exit on transport failure.
- Their `sessions_search` *agent tool* is a separate surface. Our agents
  already have `memory_search` (tool result: cross-session transcripts, FTS).
  **Decision:** this task implements the follow-up (UI box + CLI + RPC). No
  new agent tool — noted here so the trade-off is reviewable.

## Shape (ours)

1. **Store** (`src/state/db.ts`)
   - `searchSessions(query, { limit=25, sessionKeys?, scope="visible"|"all" })`
     FTS5 over `content` with role `IN ('user','assistant')`, joined to
     sessions for `key`/`title`/`name`; snippet via
     `snippet(fts_messages,0,'«','»','…',28)`, ranked bm25 + recency; LIKE
     fallback (existing pattern) with the same JS post-filter so behavior is
     identical without FTS5. Query build: tokenize on non-word, drop empty,
     last token becomes `word*` prefix, tokens AND-joined — punctuation is
     never FTS syntax (their rule).
     `scope:"visible"` (default) excludes `subagent:*` lanes; `"all"` includes
     them (their palette rule + a CLI escape hatch).
   - Title hits: all query tokens must appear in `name||title` (case-
     insensitive), last token prefix — mirrors "per session communi".
   - `messagesAround(sessionId, messageId, limit)`: anchored window
     (`ceil(limit/2)` before + anchor + `floor(limit/2)` after); missing or
     off-session anchor → `[]` (their empty-history rule).

2. **Gateway RPC** (`src/gateway/server.ts`)
   - New method `sessions.search` → `{ titleHits, messageHits }` (bounded).
   - `chat.history` gains optional `messageId` anchor → returns the window +
     includes `id` on each message (CLI/UI anchoring). Without anchor the
     payload is exactly today's shape.

3. **Control UI** (`ui/index.html`, `ui/src/main.ts`, `ui/src/chat.ts`,
   `ui/styles.css`)
   - Search input in the sessions drawer head (`#sessions-search`), live
     results as compact `.list/.row` rows in two groups: **Sessions** (title
     hits: name + last-active meta) and **Messages** (title, role+time meta,
     snippet with `<mark>` highlights).
   - Click a hit → switch to that session, load anchored history, scroll the
     anchor row into view with a brief highlight pulse. `chat.replaceThread`
     keeps `data-mid` on each row.
   - 150 ms debounce, min 2 characters, Esc restores the plain list, stale
     responses are dropped by a request counter. Any RPC failure leaves the
     visible list untouched (same rule as loadHistory).

4. **CLI** (`src/cli/index.ts`)
   - `sc sessions search <query...> [--session key (repeatable)] [--limit n]
     [--all] [--json]` — talks to a live gateway (`sessions.search`); if none
     is reachable, falls back to opening the Store directly (our `sc status`
     offline pattern). Exit non-zero only when both paths fail. Output: one
     line per hit — `ISO date  role/title  sessionKey  snippet` (home-dir
     sanitized), title hits marked `title`.
   - `sc help` lists the command.

## Boundaries
- No agent-facing tool added; no TUI surface; no new config keys; no
  timeouts/deadlines anywhere (constraint 9); result bounds only (25 / 300).
- Index lifecycle parity is already satisfied: `appendMessage` writes FTS in
  the same transaction; deletes cascade per existing schema behavior.

## Tests
- `test/session-search.test.mjs`: FTS + LIKE paths (tokenize, last-word
  prefix, role filter, subagent scoping, per-hit snippet, caps, title hits),
  anchored history window + off-path → empty, CLI offline search exit codes.
- `test/ui-render.test.mjs`: drawer search ids exist and every id the bundle
  looks up is present.
- Full suite + typecheck + build before commit; live demo verified over WS
  (search "haiku" across the seeded demo sessions).
