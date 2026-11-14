/**
 * P3 (row Missing!#21) — memory backfill core, ported from their
 * `memory session-backfill` / `memory rem-backfill` contract
 * (docs/openclaw/cli/memory.md):
 *
 *  - windows: --from/--to days in local time, --limit-days (92) oldest-first
 *  - admission: owner-interactive lanes only (user/assistant; no subagent/
 *    system/cron keys, no tool rows — same shape as the live sweep); foreign
 *    --archive-files stay untrusted: preview/diary only, never staged
 *  - preview is the default and mutates nothing
 *  - --rem: reversible per-day diary blocks in DREAMS.md + origin records
 *    (dream_ingest lane-recorded) — no staging, no corpus, no cursor advance
 *  - --apply: stage into the short-term store (lightStage "backfill" lane),
 *    track ingest hashes so repeated applies skip, and write reversible
 *    diary blocks; NEVER touches MEMORY.md/USER.md (their rule)
 *  - --rollback (shared for both commands): remove backfill candidates, the
 *    tracked hashes, and the marked diary blocks
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Store } from "../state/db.js";
import { lightStage, type RawLine, SECRET_SHAPE } from "./dream.js";
import { datedNoteDate } from "./memory-search.js";

const DAY = 86_400_000;

export interface BackfillWindow {
  fromDay?: string; // YYYY-MM-DD local
  toDay?: string;
  limitDays?: number; // default 92 (their --limit-days)
}

function dayToMs(day: string, end = false): number {
  const d = new Date(`${day}T00:00:00`);
  const t = d.getTime();
  return end ? t + DAY : t;
}

function msToDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function ingestHash(source: string, text: string): string {
  return createHash("sha256").update(`${source}\n${text}`).digest("hex");
}

/** Message rows → staging-shaped lines (same transforms as lightFromTranscripts). */
export function linesFromRows(rows: { content: string; session_key: string; created_at: number }[]): RawLine[] {
  return rows
    .map((row) => ({
      text: row.content.replace(/\s+/g, " ").trim().slice(0, 320),
      source: `session:${row.session_key}`,
      day: msToDay(row.created_at),
      kind: "session" as const,
      importance: null,
    }))
    .filter((l) => l.text.length >= 24);
}

export interface BackfillDayReport {
  day: string;
  messages: number;
  newLines: number;
  alreadyIngested: number;
  secretMasked: number;
  top: string[];
}

export interface SessionBackfillReport {
  mode: "preview" | "rem" | "apply" | "rollback";
  window: { fromDay: string | null; toDay: string | null; limitDays: number };
  daysProcessed: number;
  days: BackfillDayReport[];
  staged: number;
  diaryBlocks: number;
  hashesTracked: number;
  /** rollback */
  removed?: { candidates: number; hashes: number; diaryBlocks: number };
  note?: string;
}

/**
 * Preview/rem/apply over the session store. Oldest unprocessed day first,
 * `limitDays` distinct days max (their --limit-days 92).
 */
export function sessionBackfill(
  store: Store,
  workspace: string,
  mode: "preview" | "rem" | "apply",
  window: BackfillWindow = {},
): SessionBackfillReport {
  const limitDays = window.limitDays ?? 92;
  const fromMs = window.fromDay ? dayToMs(window.fromDay) : 0;
  const toMs = window.toDay ? dayToMs(window.toDay, true) : Date.now() + DAY;
  const rows = store.transcriptLinesBetween(fromMs, toMs);
  const lines = linesFromRows(rows);

  // Group per day, oldest-first, limiting DISTINCT days (their day budget).
  const byDay = new Map<string, RawLine[]>();
  for (const l of lines) {
    if (!byDay.has(l.day)) byDay.set(l.day, []);
    byDay.get(l.day)!.push(l);
  }
  const days = [...byDay.keys()].sort().slice(0, limitDays);

  const report: SessionBackfillReport = {
    mode,
    window: { fromDay: window.fromDay ?? null, toDay: window.toDay ?? null, limitDays },
    daysProcessed: 0,
    days: [],
    staged: 0,
    diaryBlocks: 0,
    hashesTracked: 0,
  };

  for (const day of days) {
    const dayLines = byDay.get(day)!;
    // Batch: reuse the live lane's per-day discipline (200/day cap).
    const batch = dayLines.slice(0, 200);
    const fresh = batch.filter((l) => !SECRET_SHAPE.test(l.text));
    const secretMasked = batch.length - fresh.length;
    const untracked = fresh.filter(
      (l) => !store.hasIngestHash(ingestHash(l.source, l.text)) && !store.dreamCandidateExists(l.text, l.source),
    );
    const dayReport: BackfillDayReport = {
      day,
      messages: dayLines.length,
      newLines: untracked.length,
      alreadyIngested: fresh.length - untracked.length,
      secretMasked,
      top: untracked.slice(0, 3).map((l) => l.text.slice(0, 120)),
    };
    report.days.push(dayReport);
    report.daysProcessed++;
    if (mode === "preview" || untracked.length === 0) continue;

    // Origin records BEFORE publishing text (their write order).
    if (mode === "apply") {
      const staged = lightStage(store, untracked, "backfill");
      for (const l of untracked) {
        store.addIngestHash(ingestHash(l.source, l.text), day, l.source);
        report.hashesTracked++;
      }
      report.staged += staged.staged;
    }
    writeDiaryBlock(workspace, day, untracked, mode);
    report.diaryBlocks++;
    if (mode === "rem") {
      // REM keeps origin bookkeeping without staging (their shape).
      for (const l of untracked) {
        store.addIngestHash(ingestHash(`rem:${l.source}`, l.text), day, `rem:${l.source}`);
        report.hashesTracked++;
      }
    }
  }
  if (mode === "preview") report.note = "read-only preview — oldest unprocessed day first (their default)";
  return report;
}

const BLOCK_START = (lane: string, day: string) => `<!-- sc-backfill:${lane}:${day} -->`;
const BLOCK_END = "<!-- /sc-backfill -->";

/** Reversible diary block (their DREAMS.md diary entries with markers). */
export function writeDiaryBlock(workspace: string, day: string, lines: RawLine[], lane: "rem" | "apply" | "rem-backfill"): string {
  const path = join(workspace, "DREAMS.md");
  const head = existsSync(path) ? readFileSync(path, "utf8") : "# DREAMS\n";
  const block = [
    "",
    BLOCK_START(lane, day),
    `## ${day} — ${lane === "apply" ? "session backfill" : "grounded preview"}`,
    "",
    ...lines.slice(0, 12).map((l) => `- [${l.source}] ${l.text.slice(0, 200)}`),
    BLOCK_END,
    "",
  ].join("\n");
  writeFileSync(path, head + block);
  return path;
}

/** Shared rollback: marked diary blocks + candidates + tracked hashes. */
export function rollbackBackfill(store: Store, workspace: string): SessionBackfillReport["removed"] & { diaryPath: string } {
  const path = join(workspace, "DREAMS.md");
  let diaryBlocks = 0;
  if (existsSync(path)) {
    const body = readFileSync(path, "utf8");
    const next = body.replace(/\n?<!-- sc-backfill:[^\n]*-->\n[\s\S]*?<!-- \/sc-backfill -->\n?/g, () => {
      diaryBlocks++;
      return "\n";
    });
    if (next !== body) {
      writeFileSync(path, next.replace(/\n{3,}/g, "\n\n"));
      if (!next.trim()) appendFileSync(path, "# DREAMS\n");
    }
  }
  const { candidates, hashes } = store.rollbackDreamBackfillFull();
  return { candidates, hashes, diaryBlocks, diaryPath: path };
}

// ─── rem-backfill --path (historical daily files, never staged as trusted) ──

export interface RemSourceFile {
  path: string;
  rel: string;
  day: string;
  lines: RawLine[];
}

/** Read historical memory dailies from a file or directory (their --path). */
export function readRemSources(path: string): { files: RemSourceFile[]; error?: string } {
  if (!existsSync(path)) return { files: [], error: `no such path: ${path}` };
  const files: string[] = statSync(path).isDirectory()
    ? readdirSync(path).filter((f) => f.endsWith(".md")).sort().map((f) => join(path, f))
    : [path];
  const out: RemSourceFile[] = [];
  for (const f of files) {
    const rel = basename(f);
    const dayMs = datedNoteDate(rel);
    const day = dayMs !== null ? msToDay(dayMs) : "unknown";
    const lines = readFileSync(f, "utf8")
      .split("\n")
      .map((l) => l.replace(/^\s*[-*]\s*/, "").trim())
      .filter((l) => l.length >= 24 && l.length <= 400 && !SECRET_SHAPE.test(l) && !l.startsWith("#") && !l.startsWith("<!--"))
      .map((text) => ({ text, source: `notes:${rel}`, day, kind: "note" as const, importance: null }));
    out.push({ path: f, rel, day, lines });
  }
  return { files: out };
}

/**
 * rem-backfill: grounded previews of historical memory into DREAMS.md.
 * Untrusted-source rule: --archive/daily files preview + diary only; staging
 * needs --stage-short-term exactly like their flag.
 */
export function remBackfill(
  store: Store,
  workspace: string,
  sources: RemSourceFile[],
  opts: { stageShortTerm?: boolean; previewOnly?: boolean } = {},
): { daysProcessed: number; staged: number; diaryBlocks: number; files: number } {
  let staged = 0;
  let diaryBlocks = 0;
  for (const s of sources) {
    if (s.lines.length === 0) continue;
    if (!opts.previewOnly) {
      writeDiaryBlock(workspace, s.day, s.lines, "rem-backfill");
      diaryBlocks++;
      store.addIngestHash(ingestHash(`rem-backfill:${s.rel}`, s.lines[0]!.text), s.day, `rem-backfill:${s.rel}`);
      if (opts.stageShortTerm) staged += lightStage(store, s.lines, "backfill").staged;
    }
  }
  return { daysProcessed: sources.filter((s) => s.lines.length > 0).length, staged, diaryBlocks, files: sources.length };
}
