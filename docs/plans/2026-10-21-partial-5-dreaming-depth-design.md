# Partial #5 — Dreaming engine depth (OpenClaw parity)

## Gap

Their sweep is three cooperative phases per run (vendored
`docs/openclaw/concepts/dreaming.md`, authoritative):

```text
light (stage, no durable write) → REM (theme reflection, no durable write)
→ deep (weighted scoring + gates + consolidation → only MEMORY.md writer)
```

with provenance (source refs, untrusted exclusion, rejection counts by
category, MEMORY.md preimage before rewrite) and backfill lanes
(`memory promote` preview/apply, `rem-backfill`, `session-backfill`,
`--rollback`). Ours is one free-form prompt where the model alone decides
everything — no phases, no scoring, no gates, no provenance, no backfill.

Tracker follow-up: *"split into review/consolidate passes only if quality
suffers"* → quality suffers today (ungated raw dumps into one prompt), so the
split ships: rule-based review in code, model only consolidates.

## Shipped shape — one sweep, internal phases (their own note: "internal
implementation phases, not separate user-configured modes")

- **Light**: stage candidates from daily notes (skip today) + interactive
  session transcripts (user/assistant text; subagent/cron/system lanes and
  tool/reasoning/error rows out — their ingestion eligibility). Line-level
  candidates carry provenance `(text, source path#Ln|session:<key>, day,
  kind)`. Secrets guard masks token/password/private-key/env-shaped lines into
  a masked bucket (never staged). Jaccard **0.9** dedupe (their threshold).
  Candidates land in the recall store (`dream_candidates`).
- **REM**: rule-based theme reflection: concept-token clusters (shared terms
  across distinct days/sources) with counts; reinforcement = membership count.
  Written as `## REM Sleep` report.
- **Deep**: their six weighted signals, adapted to our corpus — relevance .30
  (recall-log avg if present, else write-time importance/10, else .50
  neutral), frequency .24 (staged signal count), query diversity .15
  (distinct recall-log queries; **memory_search now logs recalls**),
  recency .15 (14-day half-life), consolidation .10 (distinct days),
  richness .06 (concept-tag density) + bounded light/REM reinforcement boost.
  Gates (fixed, documented calibration): **score ≥ 0.45 ∧ signals ≥ 2**;
  maxAge 30d. Dropping their uniqueQueries gate is deliberate: it assumes a
  mature recall store; diversity stays a score signal per their own table.
  Rehydrate file-backed candidates before writing (stale/deleted skips —
  their rule).
- **Consolidation**: gated candidates + current MEMORY.md go to a *tool-free*
  completion (the loop's stream path, like auto-title) returning **ops**
  `add|merge|supersede` with text/importance/trigger/source — the writer
  applies ops, preserves ≥75% of prior entries (their
  `maxPriorEntryLossFraction: 0.25`), keeps annotated entries byte-for-byte
  unless touched. Model unavailable or invalid output → **append-only
  fallback** (their fallback path). Before any write, the MEMORY.md preimage
  is stored (`dream_preimages`) — their rewrite-preimage rule.
- **Diary**: one dated entry per sweep in DREAMS.md combining light/REM/deep
  highlights incl. "nothing new" sweeps; phase reports in
  `memory/dreaming/<phase>/YYYY-MM-DD.md` (their default storage mode);
  deep report carries per-candidate signals + rejection **counts by
  category**, never rejected snippets (their rule).
- **Backfills (CLI)**: `sc dream promote [--limit N] [--apply]` (their
  `memory promote` preview/apply), `sc dream backfill [--days N] [--apply]
  [--rollback]` (their rem-backfill + rollback; stages via
  `staged_via='backfill'` so rollback removes only those artifacts).
- **Memory tab**: staged / promoted-today / rejected-by-category counts +
  last-sweep verdict next to the existing controls.

## Boundaries

- No new config surface: fixed defaults like their internal phase policy.
  Schedule default aligns to theirs (`0 3 * * *`).
- No model in the rule path; all phases deterministic without one.
- Sweep session transcript: no chat messages recorded (their "fresh contexts
  without retaining conversation sessions").
- No timeouts (standing rule 9); sweep work is local and bounded.

## Tests

`test/dream.test.mjs`: staging (sources, today-skip, lane exclusion, secrets
mask, 0.9 dedupe), themes, six-signal math + gates + reinforcement boost,
fallback append, ops apply incl. loss-fraction guard + annotation
preservation, rehydrate skip, preimage, rejection counts, diary one-entry,
promote preview/apply, backfill stage/rollback, CLI runs, status counts.
