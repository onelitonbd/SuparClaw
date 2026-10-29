# Partial #4 — Memory search-ranking (OpenClaw parity)

## Gap

Their `memory_search` runs the builtin engine's fixed ranking stack
(`docs/openclaw/concepts/memory-search.md`):

```text
hybrid relevance × recency decay × importance multiplier  →  MMR diversity
```

Ours is a substring `indexOf` scan: first file with the literal needle wins,
ordered `MEMORY.md` then daily notes newest-first, score-less, decay-less,
with a plain FTS transcript tail. Zero of the four ranking behaviors exist.

## Contract (vendored doc, authoritative over mirrors)

1. **Keyword leg**: require every query term first; only when nothing matches
   retry once with any-term. Filename/path matches rank ahead (basename/stem).
2. **Fixed rank stack**: `relevance × recency decay × importance`.
   - Recency decay: exponential, **30-day half-life**, dated
     `YYYY-MM-DD.md` / `YYYY-MM-DD-<slug>.md` only (any depth);
     `MEMORY.md`, `USER.md` and undated files are evergreen.
     Transcript hits age from their activity timestamp.
   - Importance: 1–10 written once at write time
     (`<!-- importance: N -->` annotation, their documented format);
     missing = neutral.
3. **Eligibility vs ordering** (`minScore`): threshold applies to the
   pre-decay score (with importance), ordering to the final decayed score.
   A relevant dated note can return with a final `score` below `minScore`.
   If everything misses `minScore` but keyword matches exist, the search
   preserves matches (top keyword hit survives).
4. **MMR**: fixed λ = 0.7, Jaccard over snippet tokens; reorders the scored
   candidate set only — no score changes, no eligibility changes, O(k²).
5. **Tool args**: `maxResults` (default 6) with aliases `max_results` →
   `limit`, precedence in that order; only the selected value is validated —
   an invalid higher-priority value is an error, never a silent fall-through.

We have no embedding providers, so vector legs and their provider config do
not exist in SuparClaw (that is Partial follow-up territory, not this gap).
Everything else ships as **fixed rules** — no new config, mirroring the
current builtin engine ("No configuration is required").

## Shape

- NEW `src/agent/memory-search.ts` — pure engine, zero store/ctx imports:
  - `tokenize` (NFC, unicode words), `chunkMarkdown` (~400-token chunks,
    one-block overlap, heading-only blocks merge into the following content
    chunk — their chunking rule),
  - `datedNoteDate` (filename date parse; null = evergreen),
  - `importanceOf` (annotation scan, max wins, clamped 1–10),
  - BM25-lite relevance: `Σ idf·(tf/(tf+1.2))` over present terms,
    normalised by full query idf and chunk length (`1 + √(tokens/200)`),
    bounded into (0, 1]; `basenames/stem` path bonus,
  - `searchMemoryFiles(workspace, query, …)` + `rankTranscriptHits(rows, …)`
    producing one candidate pool (their engine unions corpora into a single
    global ranking),
  - eligibility (`preDecay = relevance × (1 + 0.05·importance) ≥ minScore`,
    default 0.35; top-hit preservation), final score `preDecay × decay`,
    `mmrReorder`.
- `src/agent/tools.ts`: `memory_search` rebuilt on the engine — one ranked
  pool (memory chunks + session transcripts), their arg/alias contract,
  scored dated labelled snippets (`[0.83 · 2026-10-18 · memory/….md]`).
  `memory_save` gains optional `importance` (1–10) writing the annotation.
- `src/lib.ts`: export the module for tests.

## Boundaries

- No embedding/vector layer, no providers, no config tree (fixed defaults).
- No trigger-recall lane (belongs to Partial #5 dreaming depth).
- Transcript recall stays in `memory_search` (existing behavior preserved,
  now uniformly ranked). `sessions_search` remains the exact-transcript tool.
- No timeouts anywhere (standing rule 9); all work is local and bounded.

## Tests

`test/memory-search.test.mjs`: tokenization/chunking (heading attach), dated
vs evergreen decay (60-day note ranks below fresh with equal relevance but
stays eligible), importance boost + annotation parse, eligibility pre-decay
(final score below minScore allowed), top-hit preservation, MMR diversity,
arg-alias precedence + invalid rejection, transcript-leg ranking, end-to-end
tool behavior via workspace fixtures.
