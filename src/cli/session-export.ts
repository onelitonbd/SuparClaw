/**
 * P3 (row Missing!#20) — chat transcript export, ported from their
 * `openclaw transcripts` materialization model (docs/openclaw/cli/
 * transcripts.md): exports are USER-FACING ARTIFACTS, never a second runtime
 * store — capture/runtime never reads them back.
 *
 *   ~/.suparclaw/transcripts/YYYY-MM-DD/<session-slug>/
 *     metadata.json     session facts (their metadata.json slot)
 *     transcript.jsonl  public utterance projection: {id,role,content,createdAt,runId}
 *     summary.md        human-readable render of the whole session
 *
 *   - date directory comes from the session START time (their rule)
 *   - selectors: exact key/id wins; `YYYY-MM-DD/<key>` qualifies by start
 *     date; a unique key prefix resolves otherwise; ambiguity is an error,
 *     never a silent pick (their multiple-match contract)
 *   - over-255-byte names shorten to a prefix + sha256 of the full key
 *     (their filesystem-safe rule); the stored session is untouched
 *   - archived sessions export exactly like live ones (P3 #19 keeps them
 *     addressable)
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionRow, Store } from "../state/db.js";

export interface ExportArtifacts {
  dir: string;
  metadata: string;
  transcript: string;
  summary: string;
}

export interface ExportResult {
  ok: boolean;
  error?: string;
  selector?: string;
  key?: string;
  artifacts?: ExportArtifacts;
  messageCount?: number;
}

// Filesystem-safe slug; >255-byte names collapse to prefix + sha256 (their rule).
export function exportSlug(key: string): string {
  const safe = key.replace(/[^A-Za-z0-9._ -]+/g, "-").replace(/^-+|-+$/g, "") || "session";
  const bytes = Buffer.byteLength(safe, "utf8");
  if (bytes <= 255) return safe;
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  const head = safe.slice(0, 230);
  return `${head}-${hash}`;
}

export function sessionStartDate(row: SessionRow): string {
  return new Date(row.created_at).toISOString().slice(0, 10);
}

/**
 * Their selector resolution: exact key/id first; `YYYY-MM-DD/<key>` matches
 * key AND start date; a unique prefix on key as a convenience; several
 * matches = ambiguity error (no silent choice).
 */
export function resolveSessionSelector(store: Store, selector: string): { row?: SessionRow; error?: string } {
  const input = selector.trim();
  if (!input) return { error: "empty selector" };
  const exact = store.getSessionByKey(input) ?? store.getSession(input);
  if (exact) return { row: exact };
  const dated = /^(\d{4}-\d{2}-\d{2})\/(.+)$/.exec(input);
  if (dated) {
    const row = store.getSessionByKey(dated[2]!);
    if (row && sessionStartDate(row) === dated[1]) return { row };
    if (row) return { error: `session "${dated[2]}" starts ${sessionStartDate(row)}, not ${dated[1]}` };
    return { error: `no session ${dated[2]}` };
  }
  const matches = store
    .listAllSessionsForMaintenance()
    .filter((s) => s.key.startsWith(input));
  if (matches.length === 1) return { row: matches[0] };
  if (matches.length > 1) {
    return {
      error: `ambiguous selector "${input}" — ${matches.length} sessions match ` +
        `(${matches.slice(0, 3).map((m) => `${sessionStartDate(m)}/${exportSlug(m.key)}`).join(", ")}${matches.length > 3 ? ", …" : ""}); ` +
        `use the full key or YYYY-MM-DD/<key>`,
    };
  }
  return { error: `no session matches "${input}"` };
}

function slug(role: string): string {
  return role === "user" ? "👤 User" : role === "assistant" ? "🤖 Assistant" : `⚙ ${role}`;
}

/** Export one session as the three materialized artifacts. */
export function exportSessionTranscript(store: Store, row: SessionRow, transcriptsRoot: string): ExportResult {
  const slugName = exportSlug(row.key);
  const date = sessionStartDate(row);
  const dir = join(transcriptsRoot, date, slugName);
  mkdirSync(dir, { recursive: true });

  const messages = store.recentMessages(row.id, 1_000_000);
  const runs = store.runsForSession(row.id);
  const summaryRow = store.getSummary(row.id);

  const metadata = {
    id: row.id,
    key: row.key,
    selector: `${date}/${slugName}`,
    agentId: row.agent_id,
    title: row.name ?? null,
    createdAt: new Date(row.created_at).toISOString(),
    lastMessageAt: new Date(row.last_msg_at).toISOString(),
    archived: (row.archived ?? 0) !== 0,
    archiveReason: row.archive_reason ?? null,
    messageCount: messages.length,
    runCount: runs.length,
    models: [...new Set(runs.map((r) => r.model).filter((m): m is string => Boolean(m)))],
    exportedAt: new Date().toISOString(),
    formatVersion: 1,
  };

  const jsonl = messages
    .map((m) =>
      JSON.stringify({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: new Date(m.created_at).toISOString(),
        ...(m.run_id ? { runId: m.run_id } : {}),
      }),
    )
    .join("\n") + "\n";

  const md: string[] = [
    `# Transcript — ${row.name ? `${row.name} (${row.key})` : row.key}`,
    "",
    `* session: \`${row.key}\``,
    `* started: ${metadata.createdAt}`,
    `* last message: ${metadata.lastMessageAt}`,
    `* messages: ${messages.length} · runs: ${runs.length}` +
      (metadata.models.length ? ` · models: ${(metadata.models as string[]).join(", ")}` : ""),
  ];
  if ((row.archived ?? 0) !== 0) {
    md.push(`* archived: yes (${row.archive_reason ?? "unknown"}, ${new Date(row.archived_at ?? 0).toISOString()})`);
  }
  md.push("", "---", "");
  if (summaryRow) {
    md.push("> **Compacted context summary** (at export time):", ">", ...summaryRow.summary.split("\n").map((l) => `> ${l}`), "", "---", "");
  }
  for (const m of messages) {
    const at = new Date(m.created_at).toISOString().slice(0, 19).replace("T", " ");
    md.push(`### ${slug(m.role)} — ${at}`, "", m.content, "", "---", "");
  }

  const artifacts: ExportArtifacts = {
    dir,
    metadata: join(dir, "metadata.json"),
    transcript: join(dir, "transcript.jsonl"),
    summary: join(dir, "summary.md"),
  };
  writeFileSync(artifacts.metadata, JSON.stringify(metadata, null, 2) + "\n");
  writeFileSync(artifacts.transcript, jsonl);
  writeFileSync(artifacts.summary, md.join("\n") + "\n");
  return {
    ok: true,
    selector: metadata.selector,
    key: row.key,
    artifacts,
    messageCount: messages.length,
  };
}

export interface ExportArgs {
  selector: string;
  json: boolean;
  /** Print one artifact path like their `path` subcommand; null = all. */
  only: "dir" | "metadata" | "transcript" | "summary" | null;
  /** Print markdown to stdout instead of materializing (still materializes, like their show). */
  show: boolean;
  error?: string;
}

export function parseExportArgs(args: string[]): ExportArgs {
  const out: ExportArgs = { selector: "", json: false, only: null, show: false };
  for (const a of args) {
    if (a === "--json") out.json = true;
    else if (a === "--dir") out.only = "dir";
    else if (a === "--metadata") out.only = "metadata";
    else if (a === "--transcript") out.only = "transcript";
    else if (a === "--summary" || a === "--show") out.only = "summary";
    else if (!a.startsWith("--") && !out.selector) out.selector = a;
    else return { ...out, error: `unknown or duplicate argument: ${a}` };
  }
  if (!out.selector) return { ...out, error: "usage: sc sessions export <key|id|YYYY-MM-DD/key> [--dir|--metadata|--transcript|--summary] [--json]" };
  return out;
}

export function cmdSessionsExport(
  args: string[],
  deps: { store: Store; transcriptsRoot: string },
): number {
  const parsed = parseExportArgs(args);
  if (parsed.error) {
    console.error(parsed.error);
    return 2;
  }
  const { row, error } = resolveSessionSelector(deps.store, parsed.selector);
  if (error || !row) {
    console.error(error ?? "session not found");
    return 1;
  }
  const result = exportSessionTranscript(deps.store, row, deps.transcriptsRoot);
  if (!result.ok) {
    console.error(result.error ?? "export failed");
    return 1;
  }
  const a = result.artifacts!;
  if (parsed.json) {
    console.log(JSON.stringify({ ok: true, selector: result.selector, key: result.key, messageCount: result.messageCount, artifacts: a }, null, 2));
  } else if (parsed.only) {
    console.log(a[parsed.only]);
  } else {
    console.log(`exported ${result.messageCount} messages → ${result.selector}`);
    console.log(a.dir);
    console.log("--- summary.md ---");
    console.log(readFileSync(a.summary, "utf8").trimEnd());
  }
  return 0;
}
