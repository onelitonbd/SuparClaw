// Dreaming depth (Partial #5 — OpenClaw dreaming parity): one sweep, three
// cooperative internal phases — light stages, REM reflects, deep scores,
// gates and consolidates into MEMORY.md with full provenance. Their internal
// note applies verbatim: phases are implementation structure, not user modes.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Store, DreamCandidateRow } from "../state/db.js";
import { tokenize, importanceOf, stripAnnotations, memoryFiles, datedNoteDate } from "./memory-search.js";
import { todayStamp } from "./workspace.js";

export const DREAM_SESSION_KEY = "system:dream";

// Fixed policy (mirrors their internal phase settings — no new config keys).
const MAX_AGE_DAYS = 30; // their deep-phase maxAgeDays
const TRANSCRIPT_LOOKBACK_MS = 7 * 86_400_000;
const JACCARD_DEDUPE = 0.9; // their light-phase threshold
const RECENCY_HALF_LIFE_DAYS = 14; // their deep ranking half-life
const GATE_SCORE = 0.45; // their minScore gate, calibrated for our corpus
const GATE_SIGNALS = 2; // their minRecallCount gate, calibrated (see design doc)
const PRIOR_LOSS_FRACTION = 0.25; // their phases.deep.maxPriorEntryLossFraction
const MEMORY_LINE_BUDGET = 200; // "roughly under 200 lines" — curated, not a log

const WEIGHTS = { relevance: 0.3, frequency: 0.24, queryDiversity: 0.15, recency: 0.15, consolidation: 0.1, richness: 0.06 } as const;

// ---------------------------------------------------------------------------
// Light phase — sort and stage recent short-term material (no durable writes)
// ---------------------------------------------------------------------------

export interface RawLine {
  text: string;
  source: string; // "memory/2026-10-18.md" | "session:demo:main"
  day: string; // YYYY-MM-DD
  kind: "note" | "session";
  importance: number | null;
}

/** Lines that look like secrets stay out of the durable path (their taint gate). */
const SECRET_SHAPE = /(api[-_ ]?key|password|passwd|secret|bearer\s+\S|-----BEGIN|[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{8,})/i;

/** Candidate lines from workspace memory notes (skip today's — still being written). */
export function lightFromFiles(workspace: string, today: string, maxAgeDays = MAX_AGE_DAYS, cap = 200): RawLine[] {
  const out: RawLine[] = [];
  for (const rel of memoryFiles(workspace)) {
    const date = datedNoteDate(rel);
    if (date === null) continue; // evergreen files are curated memory, not raw material
    const day = new Date(date).toISOString().slice(0, 10);
    if (day >= today) continue; // today's note is still being written
    const ageDays = (Date.now() - date) / 86_400_000;
    if (ageDays > maxAgeDays) continue;
    let body: string;
    try {
      body = readFileSync(join(workspace, rel), "utf8");
    } catch {
      continue;
    }
    for (const line of body.split("\n")) {
      const m = /^\s*-\s+(.+)$/.exec(line);
      if (!m) continue;
      const text = stripAnnotations(m[1]!).trim();
      if (text.length < 12 || text.length > 400) continue;
      out.push({ text, source: rel, day, kind: "note", importance: importanceOf(line) });
      if (out.length >= cap) return out;
    }
  }
  return out;
}

/** Transcript lines: owner interactive lanes only, user/assistant text
 *  (their ingestion eligibility: no subagent/system/cron lanes, no tool rows). */
export function lightFromTranscripts(store: Store, now = Date.now(), cap = 150): RawLine[] {
  return store
    .dreamTranscriptLines(now - TRANSCRIPT_LOOKBACK_MS, cap)
    .map((row) => ({
      text: row.content.replace(/\s+/g, " ").trim().slice(0, 320),
      source: `session:${row.session_key}`,
      day: new Date(row.created_at).toISOString().slice(0, 10),
      kind: "session" as const,
      importance: null,
    }))
    .filter((l) => l.text.length >= 24);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Stage raw lines into the recall store. Exact duplicates drop; secret-shaped
 * lines are masked and counted, never staged. Returns the audit counts a deep
 * report can echo (their counts-only rule).
 */
export function lightStage(store: Store, lines: RawLine[], stagedVia: "sweep" | "backfill" = "sweep"): { staged: number; rejected: Record<string, number> } {
  const rejected: Record<string, number> = {};
  let staged = 0;
  for (const l of lines) {
    if (SECRET_SHAPE.test(l.text)) {
      rejected["secret-masked"] = (rejected["secret-masked"] ?? 0) + 1;
      continue;
    }
    const ok = store.stageDreamCandidate({
      text: l.text,
      source: l.source,
      day: l.day,
      kind: l.kind,
      importance: l.importance,
      stagedVia,
    });
    if (ok) staged++;
    else rejected["deduped"] = (rejected["deduped"] ?? 0) + 1;
  }
  return { staged, rejected };
}

// ---------------------------------------------------------------------------
// REM phase — theme reflection over staged material (no durable writes)
// ---------------------------------------------------------------------------

export interface DreamTheme {
  name: string;
  count: number; // distinct sources the concept spans
  candidates: number; // candidate rows touching the concept
}

/** Concept tokens shared across distinct days/sources, strongest first. */
export function remThemes(rows: DreamCandidateRow[], top = 8): DreamTheme[] {
  const byToken = new Map<string, { sources: Set<string>; rows: number }>();
  for (const r of rows) {
    const seen = new Set<string>();
    for (const t of tokenize(stripAnnotations(r.text))) {
      if (t.length < 4 || seen.has(t)) continue;
      seen.add(t);
      const e = byToken.get(t) ?? { sources: new Set<string>(), rows: 0 };
      e.sources.add(r.source);
      e.rows++;
      byToken.set(t, e);
    }
  }
  return [...byToken.entries()]
    .filter(([, v]) => v.sources.size >= 2)
    .map(([name, v]) => ({ name, count: v.sources.size, candidates: v.rows }))
    .sort((a, b) => b.count - a.count || b.candidates - a.candidates)
    .slice(0, top);
}

// ---------------------------------------------------------------------------
// Deep phase — six weighted signals, gates, rehydration, consolidation
// ---------------------------------------------------------------------------

export interface Cluster {
  rep: DreamCandidateRow; // representative (newest / importance-annotated preferred)
  repTokens: Set<string>;
  members: DreamCandidateRow[];
  days: Set<string>;
  sources: Set<string>;
}

/** Group rows by their 0.9-Jaccard key — one promotion candidate per cluster. */
export function deepCluster(rows: DreamCandidateRow[]): Cluster[] {
  const clusters: Cluster[] = [];
  const tokenSets = rows.map((r) => new Set(tokenize(stripAnnotations(r.text))));
  for (let i = 0; i < rows.length; i++) {
    const found = clusters.find((c) => jaccard(tokenSets[i]!, c.repTokens) >= JACCARD_DEDUPE);
    if (found) {
      found.members.push(rows[i]!);
      found.days.add(rows[i]!.day);
      found.sources.add(rows[i]!.source);
      // Prefer an importance-annotated or newer representative.
      const cur = found.rep;
      const cand = rows[i]!;
      if ((cand.importance ?? 0) > (cur.importance ?? 0) || (cand.importance === cur.importance && cand.day > cur.day)) {
        found.rep = cand;
        found.repTokens = tokenSets[i]!;
      }
    } else {
      clusters.push({ rep: rows[i]!, repTokens: tokenSets[i]!, members: [rows[i]!], days: new Set([rows[i]!.day]), sources: new Set([rows[i]!.source]) });
    }
  }
  return clusters;
}

export interface ClusterSignals {
  relevance: number;
  frequency: number;
  queryDiversity: number;
  recency: number;
  consolidation: number;
  richness: number;
  reinforce: number;
  score: number;
  recalls: number; // recall-log events touching the cluster's sources
  freshDay: string;
}

/** Score every cluster with their weighted signals. `queries` = recent recall log. */
export function deepSignals(clusters: Cluster[], recalls: { query: string; sources: string }[], now = Date.now()): (ClusterSignals & { cluster: Cluster })[] {
  const maxSignals = Math.max(1, ...clusters.map((c) => c.members.length));
  const maxDays = Math.max(1, ...clusters.map((c) => c.days.size));
  const diversityCounts = clusters.map((c) => {
    const qs = new Set<string>();
    for (const r of recalls) {
      let srcs: string[];
      try {
        srcs = JSON.parse(r.sources) as string[];
      } catch {
        continue;
      }
      if (srcs.some((s) => c.sources.has(s))) qs.add(r.query);
    }
    return qs;
  });
  const recallCounts = clusters.map((c) =>
    recalls.filter((r) => {
      try {
        return (JSON.parse(r.sources) as string[]).some((s) => c.sources.has(s));
      } catch {
        return false;
      }
    }).length,
  );
  const maxDiversity = Math.max(1, ...diversityCounts.map((s) => s.size));
  return clusters.map((c, i) => {
    const freshDay = [...c.days].sort().reverse()[0]!;
    const ageDays = Math.max(0, (now - Date.parse(`${freshDay}T00:00:00Z`)) / 86_400_000);
    const repTokens = [...c.repTokens].filter((t) => t.length >= 4);
    const richRaw = repTokens.length / Math.max(1, c.repTokens.size);
    const themeHits = repTokens.length;
    // Relevance = the stronger of recall-derived quality and write-time
    // importance (0.5 neutral floor — never below either real signal).
    const relevance = Math.max(
      recallCounts[i]! > 0 ? Math.min(1, 0.6 + 0.1 * Math.log1p(recallCounts[i]!)) : 0,
      c.rep.importance !== null ? c.rep.importance / 10 : 0,
      0.5,
    );
    const signals = {
      relevance,
      frequency: c.members.length / maxSignals,
      queryDiversity: diversityCounts[i]!.size / maxDiversity,
      recency: Math.pow(2, -ageDays / RECENCY_HALF_LIFE_DAYS),
      consolidation: c.days.size / maxDays,
      richness: richRaw,
      reinforce: 1 + Math.min(0.1, 0.02 * themeHits),
      score: 0,
      recalls: recallCounts[i]!,
      freshDay,
    };
    signals.score =
      (WEIGHTS.relevance * signals.relevance +
        WEIGHTS.frequency * signals.frequency +
        WEIGHTS.queryDiversity * signals.queryDiversity +
        WEIGHTS.recency * signals.recency +
        WEIGHTS.consolidation * signals.consolidation +
        WEIGHTS.richness * signals.richness) *
      signals.reinforce;
    return { ...signals, cluster: c };
  });
}

export interface DeepDecision {
  cluster: Cluster;
  signals: ClusterSignals;
  verdict: "promote" | "below-score" | "few-signals" | "stale-source";
}

/** Gates + live-file rehydration. Counts by category come from these verdicts. */
export function deepDecide(rows: DreamCandidateRow[], recalls: { query: string; sources: string }[], workspace: string, now = Date.now()): DeepDecision[] {
  const clusters = deepCluster(rows);
  const scored = deepSignals(clusters, recalls, now);
  return scored
    .sort((a, b) => b.score - a.score)
    .map(({ cluster, ...signals }): DeepDecision => {
      if (signals.score < GATE_SCORE) return { cluster, signals, verdict: "below-score" };
      if (cluster.members.length < GATE_SIGNALS) return { cluster, signals, verdict: "few-signals" };
      if (cluster.rep.kind === "note") {
        // Rehydrate: the snippet must still exist in its live daily file.
        try {
          const body = readFileSync(join(workspace, cluster.rep.source), "utf8");
          if (!body.includes(cluster.rep.text.slice(0, 80))) return { cluster, signals, verdict: "stale-source" };
        } catch {
          return { cluster, signals, verdict: "stale-source" };
        }
      }
      return { cluster, signals, verdict: "promote" };
    });
}

// ---------------------------------------------------------------------------
// Consolidation — model ops with guard rails; append-only fallback
// ---------------------------------------------------------------------------

export interface ConsolidationOp {
  op: "add" | "merge" | "supersede";
  text: string;
  importance?: number;
  trigger?: string;
  source?: string;
  supersedes?: string;
}

export function consolidationPrompt(candidates: DeepDecision[], memory: string): string {
  const list = candidates
    .map((d, i) => `${i + 1}. [${d.cluster.rep.source} · ${d.cluster.rep.day}] ${d.cluster.rep.text}`)
    .join("\n");
  return [
    "You are the deep-consolidation step of a memory dreaming sweep.",
    "Current MEMORY.md:",
    "```",
    memory.slice(0, 6000),
    "```",
    "",
    "Gated durable candidates (provenance in brackets):",
    list,
    "",
    'Return ONLY JSON: {"ops":[{"op":"add"|"merge"|"supersede","text":"curated fact","importance":1-10,"trigger":"short cue","source":"path","supersedes":"existing MEMORY.md line fragment (merge/supersede only)"}],"diary":"one-sentence plain-language diary line"}',
    "Rules: durable facts only (preferences, decisions, stable names, standing instructions, environment facts); never invent; keep MEMORY.md compact; preserve existing annotated entries unless a candidate merges or supersedes them; every op keeps its source for provenance.",
  ].join("\n");
}

/** Parse+validate the model's JSON ops. Null on any shape problem (their structured-response gate). */
export function parseConsolidation(raw: string): { ops: ConsolidationOp[]; diary: string } | null {
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[0]);
  } catch {
    return null;
  }
  const p = parsed as { ops?: unknown; diary?: unknown };
  if (!Array.isArray(p.ops)) return null;
  const ops: ConsolidationOp[] = [];
  for (const o of p.ops) {
    const op = o as Record<string, unknown>;
    if (op["op"] !== "add" && op["op"] !== "merge" && op["op"] !== "supersede") return null;
    if (typeof op["text"] !== "string" || !op["text"].trim()) return null;
    if (op["op"] !== "add" && typeof op["supersedes"] !== "string") return null;
    ops.push({
      op: op["op"],
      text: op["text"].trim(),
      importance: typeof op["importance"] === "number" ? Math.min(10, Math.max(1, Math.trunc(op["importance"]))) : undefined,
      trigger: typeof op["trigger"] === "string" ? op["trigger"].slice(0, 60) : undefined,
      source: typeof op["source"] === "string" ? op["source"].slice(0, 200) : undefined,
      supersedes: typeof op["supersedes"] === "string" ? op["supersedes"] : undefined,
    });
  }
  const diary = typeof p.diary === "string" && p.diary.trim() ? p.diary.trim().split("\n")[0]! : "";
  return { ops, diary };
}

function formatEntry(op: { text: string; importance?: number; trigger?: string; source?: string }): string {
  const tags: string[] = [];
  if (op.trigger) tags.push(`<!-- trigger: ${op.trigger} -->`);
  if (op.importance) tags.push(`<!-- importance: ${op.importance} -->`);
  if (op.source) tags.push(`<!-- Source: ${op.source} -->`);
  return `- ${op.text}${tags.length ? " " + tags.join(" ") : ""}`;
}

/** Apply validated ops to MEMORY.md. Enforces their prior-entry loss cap. */
export function applyConsolidationOps(memory: string, ops: ConsolidationOp[]): { next: string; added: number; merged: number; superseded: number; accepted: boolean } {
  const lines = memory.split("\n");
  const priorEntries = lines.filter((l) => /^\s*-\s+/.test(l)).length;
  let added = 0;
  let merged = 0;
  let superseded = 0;
  let changed = 0;
  for (const op of ops) {
    if (op.op === "add") {
      lines.push(formatEntry(op));
      added++;
      continue;
    }
    const needle = (op.supersedes ?? "").trim();
    const idx = lines.findIndex((l) => needle.length >= 8 && l.includes(needle));
    if (idx === -1) {
      // Ops reference real content only; a dangling merge/supersede is an add.
      lines.push(formatEntry(op));
      added++;
      continue;
    }
    if (op.op === "supersede") {
      lines.splice(idx, 1);
      superseded++;
      changed++;
    } else {
      lines[idx] = formatEntry(op);
      merged++;
      changed++;
    }
  }
  const loss = priorEntries === 0 ? 0 : changed / priorEntries;
  const accepted = loss <= PRIOR_LOSS_FRACTION;
  return { next: accepted ? lines.join("\n") : memory, added, merged, superseded, accepted };
}

/** Their fallback: gated candidates appended verbatim under a dated heading. */
export function appendOnlyPromotion(memory: string, candidates: DeepDecision[], day: string): { next: string; added: number } {

  if (candidates.length === 0) return { next: memory, added: 0 };
  const block = [
    "",
    `## Promoted ${day}`,
    ...candidates.map((d) =>
      formatEntry({
        text: d.cluster.rep.text,
        importance: d.cluster.rep.importance ?? undefined,
        source: d.cluster.rep.source,
      }),
    ),
  ].join("\n");
  return { next: memory.trimEnd() + "\n" + block + "\n", added: candidates.length };
}

// ---------------------------------------------------------------------------
// Reports, diary, sweep orchestration
// ---------------------------------------------------------------------------

export interface SweepDeps {
  store: Store;
  workspace: string;
  /** Tool-free completion (consolidation + diary). Undefined → fallback path. */
  llmComplete?: (prompt: string) => Promise<string>;
  now?: number;
}

export interface SweepVerdict {
  day: string;
  staged: number;
  themes: DreamTheme[];
  promoted: number;
  merged: number;
  superseded: number;
  rejected: Record<string, number>;
  modelUsed: boolean;
  nothingNew: boolean;
  summary: string;
}

function writePhaseReport(workspace: string, phase: string, day: string, body: string): void {
  const dir = join(workspace, "memory", "dreaming", phase);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${day}.md`), body, "utf8");
}

/** The full sweep: light → REM → deep, one diary entry, all provenance artifacts. */
export async function runSweep(deps: SweepDeps): Promise<SweepVerdict> {
  const now = deps.now ?? Date.now();
  const day = todayStamp(new Date(now));
  const { store, workspace } = deps;

  // — light —
  const lines = [...lightFromFiles(workspace, day), ...lightFromTranscripts(store, now)];
  const light = lightStage(store, lines, "sweep");
  if (lines.length === 0) {
    // Their empty-sweep rule: completion is recorded in plugin state WITHOUT
    // creating memory or dreaming files (no first-run pollution).
    const verdict: SweepVerdict = {
      day, staged: 0, themes: [], promoted: 0, merged: 0, superseded: 0,
      rejected: {}, modelUsed: false, nothingNew: true, summary: "nothing new",
    };
    store.recordDreamRun({ day, light_staged: 0, themes: "[]", promoted: 0, merged: 0, superseded: 0, rejected: "{}", verdict: verdict.summary });
    return verdict;
  }
  writePhaseReport(
    workspace,
    "light",
    day,
    `# Light Sleep — ${day}\n\nstaged: ${light.staged}\n` +
      Object.entries(light.rejected).map(([k, v]) => `${k}: ${v}`).join("\n") +
      `\n\n## Staged candidates\n` +
      lines
        .filter((l) => !SECRET_SHAPE.test(l.text))
        .slice(0, 40)
        .map((l) => `- [${l.source} · ${l.day}] ${l.text}`)
        .join("\n") +
      "\n",
  );

  // — REM — (window by WHEN rows entered the store, like theirs — backfilled
  // history participates; source age only feeds the recency score)
  const stagedRows = store.dreamCandidates({ stagedSinceMs: now - MAX_AGE_DAYS * 86_400_000 });
  const themes = remThemes(stagedRows);
  writePhaseReport(
    workspace,
    "rem",
    day,
    `# REM Sleep — ${day}\n\n` +
      (themes.length > 0
        ? themes.map((t) => `- **${t.name}** — ${t.count} sources, ${t.candidates} candidates`).join("\n")
        : "no recurring themes") +
      "\n",
  );

  // — deep —
  const recalls = store.dreamRecalls(now - MAX_AGE_DAYS * 86_400_000);
  const decisions = deepDecide(stagedRows, recalls, workspace, now);
  const gated = decisions.filter((d) => d.verdict === "promote");
  const rejected: Record<string, number> = { ...light.rejected };
  for (const d of decisions) {
    if (d.verdict !== "promote") rejected[d.verdict] = (rejected[d.verdict] ?? 0) + 1;
  }
  writePhaseReport(
    workspace,
    "deep",
    day,
    `# Deep Sleep — ${day}\n\n## Candidates\n` +
      (decisions.length > 0
        ? decisions
            .map(
              (d) =>
                `- ${d.verdict === "promote" ? "✅" : "—"} score ${d.signals.score.toFixed(2)} (freq ${d.signals.frequency.toFixed(2)}, rec ${d.signals.recency.toFixed(2)}, cons ${d.signals.consolidation.toFixed(2)}, div ${d.signals.queryDiversity.toFixed(2)}, rich ${d.signals.richness.toFixed(2)}) — ${d.cluster.rep.day} · ${d.cluster.rep.source}\n  ${d.cluster.rep.text.slice(0, 120)}`,
            )
            .join("\n")
        : "no candidates") +
      `\n\n## Rejection counts\n` +
      Object.entries(rejected).map(([k, v]) => `${k}: ${v}`).join("\n") +
      "\n",
  );

  // — consolidation (deep's durable write) —
  const { promoted, merged, superseded, modelUsed, diaryLine } = await consolidateGated(deps, gated, day);

  // — diary (one entry per sweep, even "nothing new") —
  const nothingNew = promoted === 0 && merged === 0 && superseded === 0;
  const themeLine = themes.length > 0 ? themes.slice(0, 3).map((t) => t.name).join(", ") : "";
  const diaryBody =
    `## Deep Sleep - ${day}\n\n` +
    (diaryLine ||
      (nothingNew ? "nothing new" : `promoted ${promoted}, merged ${merged}, superseded ${superseded}`)) +
    "\n" +
    (themeLine ? `themes: ${themeLine}\n` : "") +
    `staged ${light.staged} · promoted ${promoted} · merged ${merged} · superseded ${superseded}` +
    (Object.keys(rejected).length ? ` · rejected {${Object.entries(rejected).map(([k, v]) => `${k}:${v}`).join(", ")}}` : "") +
    "\n\n";
  appendFileSync(join(workspace, "DREAMS.md"), diaryBody, "utf8");

  const verdict: SweepVerdict = { day, staged: light.staged, themes, promoted, merged, superseded, rejected, modelUsed, nothingNew, summary: "" };
  verdict.summary = nothingNew
    ? "nothing new"
    : `dream sweep: promoted ${promoted}, merged ${merged}, superseded ${superseded}${modelUsed ? "" : " (append-only fallback)"}`;
  store.recordDreamRun({
    day,
    light_staged: light.staged,
    themes: JSON.stringify(themes.map((t) => t.name)),
    promoted,
    merged,
    superseded,
    rejected: JSON.stringify(rejected),
    verdict: verdict.summary,
  });
  return verdict;
}

function dayFromAge(now: number, days: number): string {
  return new Date(now - days * 86_400_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Backfill lanes (their memory promote / rem-backfill, our `sc dream` surface)
// ---------------------------------------------------------------------------

/** `sc dream promote` — deep-phase preview over the staged store, no writes. */
export function promotePreview(store: Store, workspace: string, limit = 10, now = Date.now()): DeepDecision[] {
  const rows = store.dreamCandidates({ stagedSinceMs: now - MAX_AGE_DAYS * 86_400_000 });
  const recalls = store.dreamRecalls(now - MAX_AGE_DAYS * 86_400_000);
  return deepDecide(rows, recalls, workspace, now).slice(0, Math.max(1, limit));
}

/** `sc dream backfill --days N` — replay historical notes into the store
 *  (oldest unprocessed first, their ordering). Without --apply the caller only
 *  previews: this function returns the would-stage list without touching state. */
export function backfillPreview(workspace: string, days: number, cap = 200): RawLine[] {
  const today = todayStamp();
  const min = dayFromAge(Date.now(), MAX_AGE_DAYS);
  return lightFromFiles(workspace, today, Math.min(days, MAX_AGE_DAYS * 4), cap)
    .filter((l) => l.day < min) // older than the live sweep window — true backfill
    .sort((a, b) => (a.day < b.day ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Auto-titles (unchanged) + scheduling (unchanged interface)
// ---------------------------------------------------------------------------

/** Auto-titles: tiny call that turns the first user message into a session name. */
export function titlePrompt(sample: string): string {
  return [
    "Give this conversation a short session title.",
    "Rules: 2-6 words, no quotes, no trailing punctuation, no markdown.",
    "",
    "The conversation starts with:",
    sample,
  ].join("\n");
}

/** Normalize a title reply: one line, unquoted, bounded, or null when junk. */
export function cleanTitle(raw: string): string | null {
  let t = String(raw ?? "").split("\n")[0] ?? "";
  t = t.replace(/["'`“”‘’]/g, "").trim();
  t = t.replace(/[.!?,;:]+\s*$/, "").trim();
  t = t.replace(/\s+/g, " ");
  if (t.length > 60) t = t.slice(0, 60).replace(/\s\S*$/, "");
  t = t.trim();
  return t.length >= 2 ? t : null;
}

export interface DreamHandle {
  stop(): void;
  /** Epoch ms of the next scheduled fire, or null when the job is stopped. */
  nextRunAt(): number | null;
}

/** Arm the dream schedule on its own croner timer (not the user's cron jobs). */
export async function armDream(schedule: string, fire: () => Promise<unknown>): Promise<DreamHandle> {
  const { Cron } = await import("croner");
  const cron = new Cron(schedule, { protect: true }, () => {
    void fire().catch(() => {});
  });
  return {
    stop: () => cron.stop(),
    nextRunAt: () => cron.nextRun()?.getTime() ?? null,
  };
}

/**
 * Deep's durable write, shared by the sweep and `sc dream promote --apply`:
 * preimage → model ops (guarded) or append-only fallback → promoted marking.
 * Writes MEMORY.md only when it actually changes.
 */
export async function consolidateGated(
  deps: Pick<SweepDeps, "store" | "workspace" | "llmComplete">,
  gated: DeepDecision[],
  day: string,
): Promise<{ promoted: number; merged: number; superseded: number; modelUsed: boolean; diaryLine: string }> {
  const { store, workspace } = deps;
  const memPath = join(workspace, "MEMORY.md");
  const memory = existsSync(memPath) ? readFileSync(memPath, "utf8") : "# Memory\n";
  if (gated.length === 0) return { promoted: 0, merged: 0, superseded: 0, modelUsed: false, diaryLine: "" };
  store.saveDreamPreimage(memory);
  let promoted = 0;
  let merged = 0;
  let superseded = 0;
  let modelUsed = false;
  let diaryLine = "";
  let next = memory;
  if (deps.llmComplete) {
    try {
      const raw = await deps.llmComplete(consolidationPrompt(gated, memory));
      const parsed = raw ? parseConsolidation(raw) : null;
      if (parsed) {
        const applied = applyConsolidationOps(memory, parsed.ops);
        if (applied.accepted) {
          next = applied.next;
          promoted = applied.added;
          merged = applied.merged;
          superseded = applied.superseded;
          modelUsed = true;
          diaryLine = parsed.diary;
        }
      }
    } catch {
      /* model unavailable → append-only fallback (their rule) */
    }
  }
  if (!modelUsed) {
    const fb = appendOnlyPromotion(memory, gated, day);
    next = fb.next;
    promoted = fb.added;
  }
  if (next !== memory) writeFileSync(memPath, next, "utf8");
  store.markDreamCandidatesPromoted(gated.flatMap((d) => d.cluster.members.map((m) => m.id)));
  return { promoted, merged, superseded, modelUsed, diaryLine };
}

