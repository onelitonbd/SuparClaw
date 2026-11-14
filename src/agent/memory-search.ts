/**
 * Memory search-ranking engine (Partial #4 — OpenClaw memory-search parity).
 *
 * Their builtin engine applies fixed ranking rules:
 *
 *     relevance × recency decay × importance multiplier  →  MMR diversity
 *
 * with eligibility (minScore) judged on the PRE-decay score and ordering on
 * the final decayed score. Recency decay is an exponential 30-day half-life
 * applied to dated `YYYY-MM-DD*.md` notes only; MEMORY.md, USER.md and
 * undated files are evergreen. Importance (1–10) is written once at write
 * time via `<!-- importance: N -->`; missing importance is neutral.
 * MMR (fixed λ = 0.7, Jaccard over snippet tokens) reorders the scored
 * candidate set without touching scores or eligibility.
 *
 * No embedding providers exist in SuparClaw, so this module implements the
 * keyword leg only (their "FTS-only" shape) while keeping the full fixed
 * ranking stack. Everything here is pure: no store, no ctx, no I/O beyond
 * reading the workspace files it is pointed at.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface MemoryHit {
  /** Display source: relative path (memory/2026-10-18.md) or "session · key · role". */
  source: string;
  /** Best-matching chunk text, whitespace-collapsed, bounded. */
  snippet: string;
  /** ISO date of the source (note date / transcript activity) or null. */
  date: string | null;
  /** Eligibility score: relevance × importance (BEFORE recency decay). */
  preDecay: number;
  /** Final ordering score: preDecay × decay. May sit below minScore. */
  score: number;
  /** Decay factor actually applied (1 = evergreen / today). */
  decay: number;
  /** Parsed importance 1–10 or null (neutral). */
  importance: number | null;
  /** Snippet tokens — MMR input only. */
  tokens: Set<string>;
}

export interface MemorySearchOptions {
  maxResults?: number;
  /** Eligibility floor on the PRE-decay score. Default 0.35 (their default). */
  minScore?: number;
  /** Half-life in days for dated notes. Fixed 30 like theirs. */
  halfLifeDays?: number;
  now?: number;
}

export const DEFAULT_MAX_RESULTS = 6;
export const DEFAULT_MIN_SCORE = 0.35;
export const DEFAULT_HALF_LIFE_DAYS = 30;
const MMR_LAMBDA = 0.7;
const CHUNK_CHARS = 1600; // ~400 tokens, their DEFAULT_CHUNK_TOKENS
const SNIPPET_CHARS = 420; // their engines bound snippets (700 chars PG side)
const IMPORTANCE_MULT = 0.05; // 1 → 1.05×, 10 → 1.5× — bounded, monotone, neutral when null

// ---- tokens / chunks -------------------------------------------------------

/** Unicode word tokens, NFC-normalised so NFC/NFD spellings both match. */
export function tokenize(text: string): string[] {
  return (text.normalize("NFC").toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’._/-]*/gu) ?? [])
    .map((t) => t.normalize("NFD"))
    .filter((t) => t.length > 1 || /\p{N}/u.test(t));
}

interface Chunk {
  text: string;
  importance: number | null;
}

/**
 * Split a note into ~400-token chunks with one-block overlap. A heading-only
 * block attaches to the following content chunk (their rule: short headings
 * must not take search-result slots on their own).
 */
export function chunkMarkdown(body: string): Chunk[] {
  const blocks = body.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const units: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (/^#{1,6}\s+\S/.test(b) && !/\n/.test(b) && blocks[i + 1]) {
      // heading-only block: glue onto the next content block
      blocks[i + 1] = `${b}\n\n${blocks[i + 1]}`;
      continue;
    }
    // split oversized blocks on line boundaries
    if (b.length > CHUNK_CHARS) {
      let cur = "";
      for (const line of b.split("\n")) {
        if (cur && cur.length + line.length + 1 > CHUNK_CHARS) {
          units.push(cur);
          cur = "";
        }
        cur = cur ? `${cur}\n${line}` : line;
      }
      if (cur) units.push(cur);
    } else {
      units.push(b);
    }
  }
  // Sweep: oversized splitting can strand a heading line; glue any heading-only
  // unit onto the following one. A trailing lone heading keeps its own
  // searchable chunk (their rule: it must not be dropped).
  for (let i = 0; i < units.length - 1; i++) {
    if (/^#{1,6}\s+\S+$/.test(units[i]!.trim())) {
      units[i + 1] = `${units[i]}\n\n${units[i + 1]}`;
      units.splice(i, 1);
      i--;
    }
  }
  const chunks: Chunk[] = [];
  let cur = "";
  for (const u of units) {
    if (cur && cur.length + u.length + 2 > CHUNK_CHARS) {
      chunks.push({ text: cur, importance: importanceOf(cur) });
      cur = u;
    } else {
      cur = cur ? `${cur}\n\n${u}` : u;
    }
  }
  if (cur) chunks.push({ text: cur, importance: importanceOf(cur) });
  return chunks;
}

/** `<!-- importance: N -->` annotation (their write-time format). Max wins. */
export function importanceOf(text: string): number | null {
  let best: number | null = null;
  for (const m of text.matchAll(/<!--\s*importance:\s*(\d{1,2})\s*-->/gi)) {
    const n = Math.min(10, Math.max(1, Number(m[1])));
    best = best === null ? n : Math.max(best, n);
  }
  return best;
}

/** `<!-- … -->` annotations are metadata, not content: never tokenized, never shown. */
export function stripAnnotations(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, " ");
}

/** Dated daily note (`YYYY-MM-DD.md`, `YYYY-MM-DD-slug.md`, any depth) → ms. */
export function datedNoteDate(relPath: string): number | null {
  const m = /(^|\/)(\d{4})-(\d{2})-(\d{2})(?:-\S+)?\.md$/.exec(relPath);
  if (!m) return null;
  const t = Date.parse(`${m[2]}-${m[3]}-${m[4]}T00:00:00Z`);
  return Number.isFinite(t) ? t : null;
}

export function decayFactor(ageDays: number, halfLifeDays = DEFAULT_HALF_LIFE_DAYS): number {
  if (!Number.isFinite(ageDays) || ageDays <= 0) return 1;
  return Math.pow(2, -ageDays / halfLifeDays);
}

// ---- scoring ---------------------------------------------------------------

/**
 * BM25-lite relevance, bounded into (0, ~1]: per-term saturated tf weighted
 * by corpus idf, normalised by the full query's idf (AND queries score full
 * coverage; any-term fallbacks score partial coverage down naturally) and by
 * chunk length. `dfByTerm[N]`-style inputs come from the candidate pool.
 */
function relevance(
  chunkTokens: string[],
  queryTerms: string[],
  idf: Map<string, number>,
): { rel: number; present: number } {
  if (queryTerms.length === 0 || chunkTokens.length === 0) return { rel: 0, present: 0 };
  const tf = new Map<string, number>();
  for (const t of chunkTokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  let num = 0;
  let den = 0;
  let present = 0;
  for (const t of queryTerms) {
    const w = idf.get(t) ?? 1;
    den += w;
    const f = tf.get(t) ?? 0;
    if (f > 0) {
      present++;
      num += w * (f / (f + 1.2));
    }
  }
  const len = 1 + Math.sqrt(chunkTokens.length / 200);
  return { rel: num / ((den || 1) * len), present };
}

/** Basename/stem or full-path token match boosts path-hits ahead of bodies. */
function pathBonus(relPath: string, terms: string[]): number {
  const stem = relPath.replace(/\.md$/i, "").toLowerCase();
  const base = stem.split("/").pop() ?? stem;
  let bonus = 0;
  for (const t of terms) {
    if (base === t) {
      bonus = Math.max(bonus, 0.6);
    } else if (stem.split(/[/\s_-]+|\./).includes(t)) {
      bonus = Math.max(bonus, 0.3);
    }
  }
  return bonus;
}

export function importanceMultiplier(importance: number | null): number {
  return importance === null ? 1 : 1 + IMPORTANCE_MULT * importance;
}

function makeSnippet(text: string, terms: string[]): string {
  const flat = text.replace(/<!--\s*(importance|trigger):[^>]*-->/gi, "").replace(/\s+/g, " ").trim();
  if (flat.length <= SNIPPET_CHARS) return flat;
  const low = flat.toLowerCase().normalize("NFD");
  let at = -1;
  for (const t of terms) {
    const i = low.indexOf(t);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  const start = Math.max(0, (at === -1 ? 0 : at) - 60);
  return (start > 0 ? "…" : "") + flat.slice(start, start + SNIPPET_CHARS).trim() + "…";
}

interface Candidate {
  source: string;
  dateNum: number | null; // null = evergreen
  text: string;
  importance: number | null;
  tokens: string[];
}

/** Score → eligibility → decay → MMR. Shared by memory files and transcripts. */
function rankPool(cands: Candidate[], query: string, opts: Required<Pick<MemorySearchOptions, "minScore" | "halfLifeDays" | "maxResults">> & { now: number }): MemoryHit[] {
  const terms = [...new Set(tokenize(query))].slice(0, 32);
  if (terms.length === 0 || cands.length === 0) return [];

  const tokenSets = cands.map((c) => new Set(c.tokens));
  const df = new Map<string, number>(terms.map((t) => [t, 0]));
  for (const set of tokenSets) {
    for (const t of terms) if (set.has(t)) df.set(t, (df.get(t) ?? 0) + 1);
  }

  // Their keyword rule: every query term first, any-term retry only on miss.
  const andIdx = cands.map((_, i) => i).filter((i) => terms.every((t) => tokenSets[i]!.has(t)));
  const andMode = andIdx.length > 0;
  const poolIdx = (andMode ? andIdx : cands.map((_, i) => i).filter((i) => terms.some((t) => tokenSets[i]!.has(t))))
    .slice(0, 50); // MMR is O(k²); far above any maxResults
  const pool = poolIdx.map((i) => cands[i]!);

  const N = pool.length || 1;
  const idf = new Map(terms.map((t) => [t, Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5))]));

  const scored: MemoryHit[] = [];
  for (const c of pool) {
    const { rel, present } = relevance(c.tokens, terms, idf);
    if (rel <= 0) continue;
    let relevanceScore = andMode ? rel : rel * (present / terms.length);
    relevanceScore = Math.min(1, relevanceScore + pathBonus(c.source, terms));
    const preDecay = relevanceScore * importanceMultiplier(c.importance);
    const ageDays = c.dateNum === null ? 0 : Math.max(0, (opts.now - c.dateNum) / 86_400_000);
    const decay = c.dateNum === null ? 1 : decayFactor(ageDays, opts.halfLifeDays);
    scored.push({
      source: c.source,
      snippet: makeSnippet(c.text, terms),
      date: c.dateNum === null ? null : new Date(c.dateNum).toISOString().slice(0, 10),
      preDecay,
      score: preDecay * decay,
      decay,
      importance: c.importance,
      tokens: new Set(c.tokens),
    });
  }

  // Eligibility: PRE-decay (their minScore semantics — ordering changes, not
  // qualification). Keyword-hit preservation: if eligibility empties the list
  // but real matches exist, the best one survives (their documented rule).
  let eligible = scored.filter((h) => h.preDecay >= opts.minScore);
  if (eligible.length === 0 && scored.length > 0) {
    eligible = [scored.slice().sort((a, b) => b.preDecay - a.preDecay)[0]!];
  }
  return mmrReorder(eligible).slice(0, opts.maxResults);
}

/** MMR: reorder by λ·score − (1−λ)·maxJaccard(selected). Scores untouched. */
export function mmrReorder(hits: MemoryHit[], lambda = MMR_LAMBDA): MemoryHit[] {
  const pool = hits.map((h) => ({ h, mmrScore: h.score, picked: false }));
  const out: MemoryHit[] = [];
  const selTokens: Set<string>[] = [];
  while (out.length < hits.length) {
    let best = -1;
    let bestMmr = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const p = pool[i]!;
      if (p.picked) continue;
      let maxSim = 0;
      for (const s of selTokens) {
        const inter = [...p.h.tokens].filter((t) => s.has(t)).length;
        const union = p.h.tokens.size + s.size - inter;
        if (union > 0) maxSim = Math.max(maxSim, inter / union);
      }
      const mmr = lambda * p.h.score - (1 - lambda) * maxSim;
      if (mmr > bestMmr) {
        bestMmr = mmr;
        best = i;
      }
    }
    if (best === -1) break;
    pool[best]!.picked = true;
    selTokens.push(pool[best]!.h.tokens);
    out.push(pool[best]!.h);
  }
  return out;
}

// ---- corpus entries --------------------------------------------------------

/** Ranked hits over workspace memory files (MEMORY.md, USER.md, memory/**.md). */
export function searchMemoryFiles(workspace: string, query: string, opts: MemorySearchOptions = {}): MemoryHit[] {
  const settings = {
    maxResults: Math.max(1, opts.maxResults ?? DEFAULT_MAX_RESULTS),
    minScore: opts.minScore ?? DEFAULT_MIN_SCORE,
    halfLifeDays: opts.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS,
    now: opts.now ?? Date.now(),
  };
  const cands: Candidate[] = [];
  for (const rel of memoryFiles(workspace)) {
    let text: string;
    try {
      text = readFileSync(join(workspace, rel), "utf8");
    } catch {
      continue;
    }
    const dateNum = datedNoteDate(rel);
    for (const ch of chunkMarkdown(text)) {
      cands.push({ source: rel, dateNum, text: ch.text, importance: ch.importance, tokens: tokenize(stripAnnotations(ch.text)) });
    }
  }
  return rankPool(cands, query, settings);
}

export interface TranscriptRow {
  session_key: string;
  role: string;
  content: string;
  created_at: number;
}

/** Transcript hits ranked by the same fixed stack (aged by activity time). */
export function rankTranscriptHits(rows: TranscriptRow[], query: string, pool: MemoryHit[], opts: MemorySearchOptions = {}): MemoryHit[] {
  const settings = {
    maxResults: Math.max(1, opts.maxResults ?? DEFAULT_MAX_RESULTS),
    minScore: opts.minScore ?? DEFAULT_MIN_SCORE,
    halfLifeDays: opts.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS,
    now: opts.now ?? Date.now(),
  };
  // Merge: re-rank ONE pool so memory and transcript hits compete globally
  // (their engine unions corpora before ranking) — reuse the memory ranking
  // by appending transcript candidates then re-running MMR over the union.
  const cands: Candidate[] = rows.map((r) => ({
    source: `session · ${r.session_key} · ${r.role}`,
    dateNum: r.created_at,
    text: r.content,
    importance: importanceOf(r.content),
    tokens: tokenize(stripAnnotations(r.content)),
  }));
  const tHits = rankPool(cands, query, { ...settings, maxResults: 50 });
  return mmrReorder([...pool, ...tHits]).slice(0, settings.maxResults);
}

/** MEMORY.md + USER.md + every .md under memory/ (recursive, sorted — ranking decides order). */
export function memoryFiles(workspace: string): string[] {
  const out: string[] = [];
  for (const root of ["MEMORY.md", "USER.md"]) {
    if (existsSync(join(workspace, root))) out.push(root);
  }
  const mem = join(workspace, "memory");
  const walk = (dir: string, rel: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(join(mem, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r, r);
      else if (/\.md$/i.test(e.name)) out.push(`memory/${r}`);
    }
  };
  walk("", "");
  return out.sort();
}

export const __defaults = {
  DEFAULT_MAX_RESULTS,
  DEFAULT_MIN_SCORE,
  DEFAULT_HALF_LIFE_DAYS,
  MMR_LAMBDA,
  CHUNK_CHARS,
  SNIPPET_CHARS,
};
