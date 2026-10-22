/**
 * P3 (row Missing!#21) — `sc memory` management CLI (their `openclaw memory`
 * port at our scale): status / search / promote / promote-explain /
 * rem-backfill / session-backfill. We have no vector index (lexical search),
 * so index/reset are reported N/A rather than silently aliased; `forget`
 * (provenance erasure) stays out of scope of this row's backfill contract.
 *
 * Ownership (their rules, same as sessions cleanup): a reachable gateway
 * runs memory work for search; destructive local runs (apply/rem/rollback)
 * refuse while a live gateway owns the state unless the caller asserts with
 * --yes (their stop-the-gateway guidance, applied at CLI scope).
 */
import type { Store } from "../state/db.js";
import {
  readRemSources,
  remBackfill,
  rollbackBackfill,
  sessionBackfill,
  type SessionBackfillReport,
} from "../agent/backfill.js";
import { promotePreview, deepCluster, deepDecide, deepSignals, appendOnlyPromotion } from "../agent/dream.js";
import { searchMemoryFiles, memoryFiles } from "../agent/memory-search.js";
import { todayStamp } from "../agent/workspace.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface MemoryDeps {
  store: Store;
  workspace: string;
  /** live owner for the destructive-local refusal */
  owner?: () => { running: boolean; pid: number | null };
  /** dreaming config state for `status` */
  dreaming?: () => { enabled: boolean; schedule: string };
}

const DAY = 86_400_000;

function ownerRefusal(deps: MemoryDeps, yes: boolean): string | null {
  const owner = deps.owner?.() ?? { running: false, pid: null };
  if (!owner.running || yes) return null;
  return (
    `refusing: the gateway holds the memory store${owner.pid ? ` (pid ${owner.pid})` : ""}. ` +
    `stop it first (sc service stop) or pass --yes to assert exclusive offline maintenance.`
  );
}

function parseFlags(args: string[]): { flags: Map<string, string>; bools: Set<string>; positional: string[]; error?: string } {
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  const VALUE_FLAGS = new Set(["--query", "--max-results", "--min-score", "--limit", "--min-recall-count", "--min-unique-queries", "--from", "--to", "--limit-days", "--path"]);
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (VALUE_FLAGS.has(a)) {
      if (!args[i + 1]) return { flags, bools, positional, error: `missing value for ${a}` };
      flags.set(a.slice(2), args[++i]!);
    } else if (a.startsWith("--")) {
      bools.add(a.slice(2));
    } else positional.push(a);
  }
  return { flags, bools, positional };
}

function printJson(x: unknown): number {
  console.log(JSON.stringify(x, null, 2));
  return 0;
}

function backfillJson(r: SessionBackfillReport): Record<string, unknown> {
  return r as unknown as Record<string, unknown>;
}

export async function memoryCmd(argv: string[], deps: MemoryDeps): Promise<number> {
  const sub = argv[0] ?? "status";
  const rest = argv.slice(1);
  const { flags, bools, positional, error } = parseFlags(rest);
  if (error) {
    console.error(error);
    return 2;
  }
  const json = bools.has("json");
  const yes = bools.has("yes");

  switch (sub) {
    // ---------------------------------------------------------------- status
    case "status": {
      const files = memoryFiles(deps.workspace);
      const staged = deps.store.dreamCandidates({ includePromoted: false });
      const viaBackfill = deps.store.dreamCandidates({ includePromoted: false, via: "backfill" });
      const dreaming = deps.dreaming?.() ?? { enabled: true, schedule: "0 3 * * *" };
      const info = {
        sources: { memoryFiles: files.length, lexical: true, note: "lexical search — no vector index to rebuild (their index/reset are N/A here)" },
        shortTerm: { staged: staged.length, viaBackfill: viaBackfill.length },
        dreaming,
      };
      if (json) return printJson(info);
      console.log(`sources: ${files.length} memory file(s), lexical search (no vector index — index/reset N/A)`);
      console.log(`short-term store: ${staged.length} staged (${viaBackfill.length} via backfill)`);
      console.log(`dreaming: ${dreaming.enabled ? `on (${dreaming.schedule})` : "off"}`);
      return 0;
    }

    // ---------------------------------------------------------------- search
    case "search": {
      const query = flags.get("query") ?? positional.join(" ").trim();
      if (!query) {
        console.error("usage: sc memory search <query> [--max-results n] [--min-score n] [--json]\nalso: positional [query] OR --query <text>; --query wins when both are set");
        return 2;
      }
      const maxResults = Math.max(1, Number(flags.get("max-results") ?? 6));
      const minScore = Number(flags.get("min-score") ?? 0);
      const hits = searchMemoryFiles(deps.workspace, query, { maxResults, minScore }).slice(0, maxResults);
      // Recall recording (their: searches feed the dreaming deep signals).
      if (hits.length > 0) deps.store.recordMemoryRecall(query, hits.slice(0, 6).map((h) => h.source));
      if (json) return printJson({ results: hits });
      for (const h of hits) console.log(`${h.score.toFixed(2)}  ${h.source} — ${h.snippet.replace(/\s+/g, " ").slice(0, 100)}`);
      if (hits.length === 0) console.log("no matches");
      return 0;
    }

    // --------------------------------------------------------------- promote
    case "promote": {
      const limit = Math.max(1, Number(flags.get("limit") ?? 10));
      const includePromoted = bools.has("include-promoted");
      // --include-promoted (their flag): rank already-promoted rows too —
      // deepDecide over the full window instead of the unpromoted-only path.
      const decisions = includePromoted
        ? deepDecide(
            deps.store.dreamCandidates({ includePromoted: true }),
            deps.store.dreamRecalls(Date.now() - 30 * DAY),
            deps.workspace,
          ).slice(0, limit)
        : promotePreview(deps.store, deps.workspace, limit);
      if (json) return printJson({ decisions, apply: bools.has("apply") });
      if (decisions.length === 0) {
        console.log("no promote candidates (gates: score ≥ 0.75, ≥ 3 signals, live source)");
        return 0;
      }
      for (const [i, d] of decisions.entries()) {
        console.log(`${i + 1}. [${d.signals.score.toFixed(2)} · ${d.cluster.rep.source} · ${d.cluster.rep.day}] ${d.cluster.rep.text.slice(0, 100)}`);
      }
      if (!bools.has("apply")) {
        console.log("preview only — pass --apply to append these to MEMORY.md and mark promoted");
        return 0;
      }
      const refusal = ownerRefusal(deps, yes);
      if (refusal) {
        console.error(refusal);
        return 1;
      }
      const memPath = join(deps.workspace, "MEMORY.md");
      const memory = existsSync(memPath) ? readFileSync(memPath, "utf8") : "";
      const day = todayStamp(new Date());
      const { next, added } = appendOnlyPromotion(memory, decisions, day);
      writeFileSync(memPath, next);
      deps.store.markDreamCandidatesPromoted(decisions.flatMap((d) => d.cluster.members.map((m) => m.id)));
      console.log(`promoted ${added} → MEMORY.md (re-run now previews zero, like their drained apply)`);
      return 0;
    }

    // -------------------------------------------------------- promote-explain
    case "promote-explain": {
      const selector = positional.join(" ");
      if (!selector) {
        console.error("usage: sc memory promote-explain <selector> [--include-promoted] [--json]");
        return 2;
      }
      const rows = deps.store.dreamCandidates({ includePromoted: bools.has("include-promoted") });
      const clusters = deepCluster(rows);
      const match = clusters.find((c) => c.rep.text.includes(selector) || c.rep.source.includes(selector));
      if (!match) {
        console.error(`no candidate matches "${selector}" (key, path, or snippet substring)`);
        return 1;
      }
      const recalls = deps.store.dreamRecalls(Date.now() - 30 * DAY);
      const scored = deepSignals([match], recalls);
      if (json) return printJson({ candidate: match.rep, signals: scored[0] ?? null });
      const s = scored[0];
      console.log(`candidate: [${match.rep.source} · ${match.rep.day}] ${match.rep.text.slice(0, 120)}`);
      if (!s) {
        console.log("no signals record");
        return 0;
      }
      console.log(
        `relevance ${s.relevance.toFixed(2)} · frequency ${s.frequency.toFixed(2)} · diversity ${s.queryDiversity.toFixed(2)}\n` +
        `recency ${s.recency.toFixed(2)} · consolidation ${s.consolidation.toFixed(2)} · richness ${s.richness.toFixed(2)}\n` +
        `reinforce ${s.reinforce.toFixed(2)} → score ${s.score.toFixed(3)} (gate ≥ 0.75, recalls ${s.recalls})`,
      );
      return 0;
    }

    // ------------------------------------------------------------ rem-backfill
    case "rem-backfill": {
      if (bools.has("rollback") || bools.has("rollback-short-term")) {
        const refusal = ownerRefusal(deps, yes);
        if (refusal) {
          console.error(refusal);
          return 1;
        }
        const removed = rollbackBackfill(deps.store, deps.workspace);
        if (json) return printJson({ rollback: true, removed });
        console.log(
          `rolled back: ${removed.candidates} candidates, ${removed.hashes} tracked hashes, ${removed.diaryBlocks} diary block(s)\n` +
          `eligibility rewound — material can be previewed and applied again (their shared rollback)`,
        );
        return 0;
      }
      const path = flags.get("path");
      if (!path) {
        console.error("usage: sc memory rem-backfill --path <file-or-dir> [--stage-short-term] [--json]\n       sc memory rem-backfill --rollback [--json]");
        return 2;
      }
      const refusal = ownerRefusal(deps, yes);
      if (refusal) {
        console.error(refusal);
        return 1;
      }
      const { files: sources, error: srcErr } = readRemSources(path);
      if (srcErr) {
        console.error(srcErr);
        return 1;
      }
      const result = remBackfill(deps.store, deps.workspace, sources, { stageShortTerm: bools.has("stage-short-term") });
      if (json) return printJson(result);
      console.log(
        `${result.daysProcessed} day(s) from ${result.files} file(s); ${result.diaryBlocks} reversible DREAMS.md block(s) written` +
        (boolVal(bools, "stage-short-term") ? `; staged ${result.staged}` : " (diary only — pass --stage-short-term to seed the promotion store)"),
      );
      return 0;
    }

    // -------------------------------------------------------- session-backfill
    case "session-backfill": {
      const mode = bools.has("rollback") ? "rollback" : bools.has("apply") ? "apply" : bools.has("rem") ? "rem" : "preview";
      if (bools.has("rem") && bools.has("apply")) {
        console.error("--rem and --apply are mutually exclusive (their rule)");
        return 2;
      }
      if (mode !== "preview") {
        const refusal = ownerRefusal(deps, yes);
        if (refusal) {
          console.error(refusal);
          return 1;
        }
      }
      if (mode === "rollback") {
        const removed = rollbackBackfill(deps.store, deps.workspace);
        if (json) return printJson({ mode, removed });
        console.log(
          `rolled back: ${removed.candidates} candidates, ${removed.hashes} tracked hashes, ${removed.diaryBlocks} diary block(s)\n` +
          `(shared lane: also removes rem-backfill artifacts — their intentional overlap)`,
        );
        return 0;
      }
      const report = sessionBackfill(deps.store, deps.workspace, mode as "preview" | "rem" | "apply", {
        fromDay: flags.get("from"),
        toDay: flags.get("to"),
        limitDays: flags.has("limit-days") ? Number(flags.get("limit-days")) : 92,
      });
      if (json) return printJson(backfillJson(report));
      console.log(
        `mode=${report.mode} · ${report.daysProcessed} day(s), window ${report.window.fromDay ?? "-inf"} → ${report.window.toDay ?? "now"} (limit ${report.window.limitDays})`,
      );
      for (const d of report.days.slice(0, 12)) {
        console.log(`  ${d.day}: ${d.messages} msg · ${d.newLines} new · ${d.alreadyIngested} already ingested · ${d.secretMasked} secret-masked`);
      }
      if (report.days.length > 12) console.log(`  … plus ${report.days.length - 12} more days`);
      if (report.mode === "preview") {
        console.log("read-only preview — pass --rem (diary only) or --apply (stage + diary, reversible)");
      } else {
        console.log(
          `staged ${report.staged}, tracked ${report.hashesTracked} hashes, wrote ${report.diaryBlocks} reversible DREAMS.md block(s)\n` +
          (report.mode === "apply" ? "MEMORY.md/USER.md untouched (their rule) — promotion stays with memory promote / deep sweep" : "diary + origins only (their REM shape)"),
        );
      }
      return 0;
    }

    default:
      console.error(`unknown memory subcommand: ${sub}\nsubcommands: status, search, promote, promote-explain, rem-backfill, session-backfill`);
      return 2;
  }
}

function boolVal(bools: Set<string>, key: string): boolean {
  return bools.has(key);
}
