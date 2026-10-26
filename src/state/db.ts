import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface SessionRow {
  id: string;
  key: string;
  agent_id: string;
  name: string | null;
  created_at: number;
  last_msg_at: number;
  meta: string | null;
  /** Session thinking-level override ("low"…/"max", "off"); null = inherited. */
  thinking?: string | null;
  /** Per-session queue-mode override (steer|followup|collect|interrupt); null = config. */
  queue_mode?: string | null;
  /** JSON {debounceMs?, cap?, drop?} /queue options; null = none. */
  queue_opts?: string | null;
  /** P3 #19: archived in place by maintenance; keeps id + full history readable. */
  archived?: number;
  archived_at?: number | null;
  /** archive-age | archive-cap (their archiveReason age-retention/capacity). */
  archive_reason?: string | null;
  /** Task 35: "chat" (default) or "code" — a code session is bound to a repo. */
  kind?: string | null;
  /** The repository this session works in, `owner/name`. */
  repo?: string | null;
  /** The branch the session's worktree was cut from (e.g. `main`). */
  base?: string | null;
  /** The session's own branch (`sc/<slug>`) — never the base. */
  branch?: string | null;
  /** Absolute worktree path; the workspace for this session's tools. */
  workspace?: string | null;
}

export interface SubagentRow {
  child_session_key: string;
  parent_session_key: string;
  run_id: string;
  label: string;
  task: string;
  task_name: string;
  depth: number;
  status: string;          // running | done | error | aborted | interrupted
  outcome: string | null;  // final assistant text (<= 12k) once finished
  result_stats: string | null;
  delivery: string;        // pending | delivered | not_required
  spawned_at: number;
  ended_at: number | null;
}

export interface SessionSummaryRow {
  session_id: string;
  upto: number;
  summary: string;
  chars: number;
  count: number;
  updated: number;
}

export interface MessageRow {
  id: number;
  session_id: string;
  run_id: string | null;
  role: string;
  content: string;
  created_at: number;
  /**
   * JSON `{ usage: <provider numbers>, model: <profile id>, label: <label> }`
   * on assistant rows (Task 23). The reply footer is rebuilt from this on every
   * history read — it used to be decoration on the live event only, so any
   * refresh dropped the line. Null for rows written before the column existed.
   */
  usage?: string | null;
}

export interface JobRow {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  session_key: string;
  enabled: number;
  last_run_at: number | null;
  created_at: number;
  /** Per-job IANA zone (P2 #14); null = cron.timezone / host. */
  tz: string | null;
  /** Result delivery (P2 #14): none|announce|webhook; null = cron.delivery. */
  delivery_mode: string | null;
  delivery_to: string | null;
  /** 1 = empty/whitespace results are not delivered (their suppressEmpty). */
  delivery_suppress_empty: number;
}

// ---- session search types & query helpers --------------------------------

export interface SessionTitleHit {
  sessionKey: string;
  title: string | null;
  lastMsgAt: number;
}

export interface SessionMessageHit {
  sessionKey: string;
  title: string | null;
  messageId: number;
  role: string;
  createdAt: number;
  snippet: string;
}

export interface SessionSearchResult {
  titleHits: SessionTitleHit[];
  messageHits: SessionMessageHit[];
}

/** Query words are literal text: punctuation never becomes FTS syntax
 *  (their rule). Split on non-word, drop empties, cap at 6 tokens. */
function tokenizeQuery(query: string): string[] {
  return query
    .replace(/[^\p{L}\p{N}_]/gu, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, 6);
}

/** FTS5 MATCH: every word; the LAST word as a prefix (their UI rule). Each
 *  token is double-quoted through an escape so injected quotes stay literal. */
function buildMatch(tokens: string[]): string {
  const esc = (t: string) => `"${t.replace(/"/g, '""')}"`;
  const parts = tokens.map(esc);
  if (parts.length > 0) parts[parts.length - 1] += "*";
  return parts.join(" AND ");
}

/** Visibility + optional sessionKeys restriction for search scopes. */
function keysPredicate(sessionKeys: string[] | undefined, scope: "visible" | "all"): (key: string) => boolean {
  if (sessionKeys && sessionKeys.length > 0) {
    const set = new Set(sessionKeys);
    return (k) => set.has(k);
  }
  return scope === "visible" ? (k) => !k.startsWith("subagent:") : () => true;
}

/** One-line snippet with «» markers around the first matching token. */
function makeSnippet(content: string, tokens: string[]): string {
  const plain = content.replace(/\s+/g, " ").trim();
  const lower = plain.toLowerCase();
  let at = -1;
  for (const t of tokens) {
    const i = lower.indexOf(t.toLowerCase());
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return plain.slice(0, 300) + (plain.length > 300 ? "…" : "");
  const start = Math.max(0, at - 60);
  const end = Math.min(plain.length, at + 220);
  const body = plain.slice(start, end);
  // Mark every token occurrence inside the window (case-insensitive).
  let out = "";
  const window = body.toLowerCase();
  const marks: [number, number][] = [];
  for (const t of tokens) {
    const q = t.toLowerCase();
    let i = 0;
    while ((i = window.indexOf(q, i)) >= 0) {
      marks.push([i, i + q.length]);
      i += q.length;
    }
  }
  marks.sort((a, b) => a[0] - b[0]);
  let pos = 0;
  for (const [a, b] of marks) {
    if (a < pos) continue;
    out += body.slice(pos, a) + "«" + body.slice(a, b) + "»";
    pos = b;
  }
  out += body.slice(pos);
  return (start > 0 ? "…" : "") + out + (end < plain.length ? "…" : "");
}

/** LIKE-fallback safety net: with FTS the MATCH already enforces tokens; on
 *  the LIKE path require every token to appear (last as prefix anywhere). */
function hitsMayContainAllTokens(content: string, tokens: string[], fts: boolean): boolean {
  if (fts) return true;
  const hay = content.toLowerCase();
  return tokens.every((t) => hay.includes(t.toLowerCase()));
}

const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);`,
    `CREATE TABLE IF NOT EXISTS sessions (
       id TEXT PRIMARY KEY,
       key TEXT UNIQUE NOT NULL,
       agent_id TEXT NOT NULL DEFAULT 'main',
       name TEXT,
       created_at INTEGER NOT NULL,
       last_msg_at INTEGER NOT NULL DEFAULT 0,
       meta TEXT
     );`,
    `CREATE TABLE IF NOT EXISTS messages (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       session_id TEXT NOT NULL,
       run_id TEXT,
       role TEXT NOT NULL,
       content TEXT NOT NULL,
       created_at INTEGER NOT NULL
     );`,
    `CREATE INDEX IF NOT EXISTS messages_session_idx ON messages(session_id, id);`,
    `CREATE TABLE IF NOT EXISTS runs (
       id TEXT PRIMARY KEY,
       session_id TEXT NOT NULL,
       status TEXT NOT NULL,
       started_at INTEGER NOT NULL,
       ended_at INTEGER,
       error TEXT,
       usage TEXT
     );`,
    `CREATE TABLE IF NOT EXISTS jobs (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       schedule TEXT NOT NULL,
       prompt TEXT NOT NULL,
       session_key TEXT NOT NULL,
       enabled INTEGER NOT NULL DEFAULT 1,
       last_run_at INTEGER,
       created_at INTEGER NOT NULL
     );`,
    `CREATE TABLE IF NOT EXISTS job_runs (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       job_id TEXT NOT NULL,
       started_at INTEGER NOT NULL,
       status TEXT NOT NULL,
       result TEXT
     );`,
    `CREATE TABLE IF NOT EXISTS subagents (
       child_session_key TEXT PRIMARY KEY,
       parent_session_key TEXT NOT NULL,
       run_id TEXT NOT NULL,
       label TEXT NOT NULL DEFAULT '',
       task TEXT NOT NULL DEFAULT '',
       task_name TEXT NOT NULL DEFAULT '',
       depth INTEGER NOT NULL DEFAULT 1,
       status TEXT NOT NULL DEFAULT 'running',
       outcome TEXT,
       result_stats TEXT,
       delivery TEXT NOT NULL DEFAULT 'pending',
       spawned_at INTEGER NOT NULL,
       ended_at INTEGER
     );`,
    `CREATE INDEX IF NOT EXISTS subagents_parent_idx ON subagents(parent_session_key, spawned_at);`,
    `CREATE TABLE IF NOT EXISTS tool_log (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       run_id TEXT NOT NULL,
       tool TEXT NOT NULL,
       status TEXT NOT NULL,
       ms INTEGER NOT NULL,
       at INTEGER NOT NULL
     );`,
  ],
  [
    // FTS is optional: some SQLite builds omit FTS5, so every caller must fall back to LIKE.
    `CREATE VIRTUAL TABLE IF NOT EXISTS fts_messages USING fts5(content, session_id UNINDEXED, message_id UNINDEXED);`,
  ],
  [
    // Dreaming depth (Partial #5): phased sweep state. Candidates are the
    // short-term recall store; recalls are memory_search hit logs feeding the
    // deep signals; preimages snapshot MEMORY.md before every rewrite.
    `CREATE TABLE IF NOT EXISTS dream_candidates (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       text TEXT NOT NULL,
       source TEXT NOT NULL,
       day TEXT NOT NULL,
       kind TEXT NOT NULL,
       importance INTEGER,
       staged_at INTEGER NOT NULL,
       staged_via TEXT NOT NULL DEFAULT 'sweep',
       promoted_at INTEGER
     );`,
    `CREATE INDEX IF NOT EXISTS dream_candidates_day_idx ON dream_candidates(day);`,
    `CREATE TABLE IF NOT EXISTS dream_recalls (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       query TEXT NOT NULL,
       sources TEXT NOT NULL,
       created_at INTEGER NOT NULL
     );`,
    `CREATE TABLE IF NOT EXISTS dream_preimages (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       content TEXT NOT NULL,
       created_at INTEGER NOT NULL
     );`,
    `CREATE TABLE IF NOT EXISTS dream_runs (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       day TEXT NOT NULL,
       light_staged INTEGER NOT NULL,
       themes TEXT NOT NULL,
       promoted INTEGER NOT NULL,
       merged INTEGER NOT NULL,
       superseded INTEGER NOT NULL,
       rejected TEXT NOT NULL,
       verdict TEXT NOT NULL,
       created_at INTEGER NOT NULL
     );`,
    // Memory session-backfill (P3 #21): tracked ingest hashes — repeated
    // --apply skips already-ingested lines (their skip rule); rollback clears
    // them so material can be previewed/applied again.
    `CREATE TABLE IF NOT EXISTS dream_ingest (
       hash TEXT PRIMARY KEY,
       day TEXT NOT NULL,
       source TEXT NOT NULL,
       staged_at INTEGER NOT NULL
     );`,
  ],
  // Auth profiles (Partial #6): the credential store — OpenClaw's
  // auth_profile_store/state at our single-agent scale. Material stays in
  // here; nothing that surfaces to logs/RPC ever returns it.
  [
    `CREATE TABLE IF NOT EXISTS auth_profiles (
       id TEXT PRIMARY KEY,
       provider TEXT NOT NULL,
       type TEXT NOT NULL CHECK(type IN ('api_key','token','oauth')),
       material TEXT NOT NULL,
       expires INTEGER NOT NULL DEFAULT 0,
       label TEXT NOT NULL DEFAULT '',
       created_at INTEGER NOT NULL,
       last_used_at INTEGER NOT NULL DEFAULT 0,
       last_ok_at INTEGER NOT NULL DEFAULT 0,
       fail_count INTEGER NOT NULL DEFAULT 0,
       cooldown_until INTEGER NOT NULL DEFAULT 0
     );`,
    // Store-side per-provider profile order — wins over auth.order config
    // (their resolveAuthProfileOrder: stored override beats config).
    `CREATE TABLE IF NOT EXISTS auth_profile_order (
       provider TEXT PRIMARY KEY,
       profile_ids TEXT NOT NULL DEFAULT '[]',
       updated_at INTEGER NOT NULL
     );`,
  ],
  [
    // Context compaction (P1 A2): one rolling summary row per session. `upto`
    // is the highest message id the summary covers; rewrites only ever extend
    // it forward (incremental — the tail is never resummarized). `count`
    // feeds /status ("compactions: N") and `chars` the total summarized span.
    `CREATE TABLE IF NOT EXISTS session_summaries (
       session_id TEXT PRIMARY KEY,
       upto INTEGER NOT NULL DEFAULT 0,
       summary TEXT NOT NULL DEFAULT '',
       chars INTEGER NOT NULL DEFAULT 0,
       count INTEGER NOT NULL DEFAULT 0,
       updated INTEGER NOT NULL DEFAULT 0
     );`,
  ],
];

export class Store {
  readonly db: DatabaseSync;
  readonly fts: boolean;

  private constructor(db: DatabaseSync, fts: boolean) {
    this.db = db;
    this.fts = fts;
  }

  static open(path: string): Store {
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");
    let fts = true;
    for (const [i, statements] of MIGRATIONS.entries()) {
      try {
        for (const sql of statements) db.exec(sql);
        db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)").run(String(i + 1));
      } catch (err) {
        if (/fts5|no such module/i.test((err as Error).message)) {
          fts = false;
          continue;
        }
        throw err;
      }
    }
    // Idempotent column additions (pre-thinking DBs upgrade in place).
    const sessionCols = new Set(
      (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name),
    );
    if (!sessionCols.has("thinking")) {
      db.exec("ALTER TABLE sessions ADD COLUMN thinking TEXT");
    }
    if (!sessionCols.has("queue_mode")) {
      db.exec("ALTER TABLE sessions ADD COLUMN queue_mode TEXT");
    }
    if (!sessionCols.has("queue_opts")) {
      db.exec("ALTER TABLE sessions ADD COLUMN queue_opts TEXT");
    }
    // Usage/cost tracking (P2 #15): stamp each run with its wire model so
    // footers and `sc usage` can attribute tokens and price from the runs
    // table alone. PRAGMA-guarded like the session backfills — ALTERs must
    // survive re-opens on an already-migrated DB.
    const runCols = new Set(
      (db.prepare("PRAGMA table_info(runs)").all() as { name: string }[]).map((c) => c.name),
    );
    if (!runCols.has("model")) {
      db.exec("ALTER TABLE runs ADD COLUMN model TEXT");
    }
    // Reply-usage on the transcript row (Task 23): the footer is re-rendered
    // from these numbers after every reload, so they have to outlive the run.
    const msgCols = new Set(
      (db.prepare("PRAGMA table_info(messages)").all() as { name: string }[]).map((c) => c.name),
    );
    if (!msgCols.has("usage")) {
      db.exec("ALTER TABLE messages ADD COLUMN usage TEXT");
    }
    // Cron timezones + delivery (P2 #14): per-job tz / delivery_mode /
    // delivery_to / suppress-empty columns, same PRAGMA-guarded pattern.
    const jobCols = new Set(
      (db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]).map((c) => c.name),
    );
    if (!jobCols.has("tz")) db.exec("ALTER TABLE jobs ADD COLUMN tz TEXT");
    if (!jobCols.has("delivery_mode")) db.exec("ALTER TABLE jobs ADD COLUMN delivery_mode TEXT");
    if (!jobCols.has("delivery_to")) db.exec("ALTER TABLE jobs ADD COLUMN delivery_to TEXT");
    if (!jobCols.has("delivery_suppress_empty")) db.exec("ALTER TABLE jobs ADD COLUMN delivery_suppress_empty INTEGER NOT NULL DEFAULT 1");
    // Session maintenance (P3 #19): archive-in-place rows keep their ids and
    // all history (their pruneAfter/maxEntries semantics) — the columns are
    // PRAGMA-guarded so pre-maintenance DBs upgrade in place.
    if (!sessionCols.has("archived")) db.exec("ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
    if (!sessionCols.has("archived_at")) db.exec("ALTER TABLE sessions ADD COLUMN archived_at INTEGER");
    if (!sessionCols.has("archive_reason")) db.exec("ALTER TABLE sessions ADD COLUMN archive_reason TEXT");
    // GitHub add-on (Task 35): a session can be bound to one repository. The
    // columns are PRAGMA-guarded like the rest, so an older DB upgrades in place.
    if (!sessionCols.has("kind")) db.exec("ALTER TABLE sessions ADD COLUMN kind TEXT");
    if (!sessionCols.has("repo")) db.exec("ALTER TABLE sessions ADD COLUMN repo TEXT");
    if (!sessionCols.has("base")) db.exec("ALTER TABLE sessions ADD COLUMN base TEXT");
    if (!sessionCols.has("branch")) db.exec("ALTER TABLE sessions ADD COLUMN branch TEXT");
    if (!sessionCols.has("workspace")) db.exec("ALTER TABLE sessions ADD COLUMN workspace TEXT");
    return new Store(db, fts);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  // ---- meta -------------------------------------------------------------
  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)").run(key, value);
  }

  // ---- sessions ---------------------------------------------------------
  getSessionByKey(key: string): SessionRow | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE key = ?").get(key) as SessionRow | undefined;
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  }

  ensureSession(key: string, agentId = "main"): SessionRow {
    const existing = this.getSessionByKey(key);
    if (existing) return existing;
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO sessions(id, key, agent_id, created_at, last_msg_at) VALUES(?, ?, ?, ?, ?)",
      )
      .run(id, key, agentId, now, now);
    return { id, key, agent_id: agentId, name: null, created_at: now, last_msg_at: now, meta: null };
  }

  listSessions(limit = 50, opts?: { includeArchived?: boolean }): SessionRow[] {
    // Dashboard parity (their maxEntries note): archived rows keep their ids
    // and history but leave the default list — they no longer "consume" the
    // visible store. Direct key/id lookups still resolve them.
    const where = opts?.includeArchived ? "" : "WHERE COALESCE(archived, 0) = 0";
    return this.db
      .prepare(`SELECT * FROM sessions ${where} ORDER BY last_msg_at DESC LIMIT ?`)
      .all(limit) as unknown as SessionRow[];
  }

  /** Maintenance enumeration (P3 #19): every row, oldest activity first. */
  listAllSessionsForMaintenance(): SessionRow[] {
    return this.db
      .prepare("SELECT * FROM sessions ORDER BY last_msg_at ASC")
      .all() as unknown as SessionRow[];
  }

  countUnarchivedSessions(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM sessions WHERE COALESCE(archived, 0) = 0")
      .get() as { n: number };
    return row.n;
  }

  /**
   * Archive in place (their archiveReason): the id, key, and every message
   * generation survive; only visibility + cap accounting change. passed
   * reason: "archive-age" (their age-retention) | "archive-cap" (capacity).
   */
  archiveSession(id: string, reason: string, at: number): void {
    this.db
      .prepare("UPDATE sessions SET archived = 1, archived_at = ?, archive_reason = ? WHERE id = ?")
      .run(at, reason, id);
  }

  /** Per-session stored-text bytes — the disk-budget walk's evict estimate. */
  sessionContentBytes(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(LENGTH(content)), 0) AS n FROM messages WHERE session_id = ?")
      .get(sessionId) as { n: number };
    return row.n + 512; // row + index overhead
  }

  /** Set (or clear with null) the display title — sc sessions rename (P2 #11). */
  renameSession(id: string, name: string | null): void {
    this.db.prepare("UPDATE sessions SET name = ? WHERE id = ?").run(name, id);
  }

  /**
   * Set (or clear with null) the session's thinking-level override. Creates
   * the session when missing — the picker must work on a fresh session that
   * has not sent its first message yet.
   */
  /**
   * Bind a session to a repository (Task 35). One repo per session: the row is
   * the single source of truth, so every surface (bar, footer, prompt, tools)
   * reads the same facts.
   */
  setSessionRepo(
    key: string,
    binding: { kind: "chat" | "code"; repo?: string | null; base?: string | null; branch?: string | null; workspace?: string | null } | null,
  ): void {
    const row = this.ensureSession(key);
    if (binding === null) {
      this.db.prepare("UPDATE sessions SET kind = NULL, repo = NULL, base = NULL, branch = NULL, workspace = NULL WHERE id = ?").run(row.id);
      return;
    }
    this.db
      .prepare("UPDATE sessions SET kind = ?, repo = ?, base = ?, branch = ?, workspace = ? WHERE id = ?")
      .run(binding.kind, binding.repo ?? null, binding.base ?? null, binding.branch ?? null, binding.workspace ?? null, row.id);
  }

  /** The repo binding for a session, or null for an ordinary chat. */
  getSessionRepo(key: string): { kind: "chat" | "code"; repo: string; base: string; branch: string; workspace: string } | null {
    const row = this.getSessionByKey(key);
    if (!row) return null;
    const r = row as unknown as SessionRow;
    if (!r.repo || !r.workspace) return null;
    return {
      kind: r.kind === "code" ? "code" : "chat",
      repo: r.repo,
      base: r.base ?? "main",
      branch: r.branch ?? "",
      workspace: r.workspace,
    };
  }

  setSessionThinking(key: string, thinking: string | null): void {
    const row = this.ensureSession(key);
    this.db.prepare("UPDATE sessions SET thinking = ? WHERE id = ?").run(thinking, row.id);
  }

  /**
   * Change a session's KEY (what the UI calls "rename"): the messages hang off
   * the session id, so they follow the row. Rejects a missing source or a
   * target key that already exists — silent no-ops here used to strand the UI
   * on an empty session after a rename.
   */
  renameSessionKey(oldKey: string, newKey: string): { ok: boolean; error?: string } {
    if (!oldKey || !newKey) return { ok: false, error: "old and new session keys are required" };
    if (oldKey === newKey) return { ok: true };
    const row = this.getSessionByKey(oldKey);
    if (!row) return { ok: false, error: `no such session: ${oldKey}` };
    if (this.getSessionByKey(newKey)) return { ok: false, error: `a session named ${newKey} already exists` };
    this.db.prepare("UPDATE sessions SET key = ? WHERE id = ?").run(newKey, row.id);
    return { ok: true };
  }

  // ---- messages ---------------------------------------------------------
  appendMessage(
    sessionId: string,
    role: string,
    content: string,
    runId?: string,
    /** JSON usage blob for an assistant row (see MessageRow.usage). */
    usage?: string | null,
  ): number {
    const now = Date.now();
    const res = this.db
      .prepare("INSERT INTO messages(session_id, run_id, role, content, created_at, usage) VALUES(?, ?, ?, ?, ?, ?)")
      .run(sessionId, runId ?? null, role, content, now, usage ?? null);
    const id = Number(res.lastInsertRowid);
    this.db.prepare("UPDATE sessions SET last_msg_at = ? WHERE id = ?").run(now, sessionId);
    if (this.fts) {
      this.db
        .prepare("INSERT INTO fts_messages(content, session_id, message_id) VALUES(?, ?, ?)")
        .run(content.replace(/\s+/g, " ").slice(0, 4000), sessionId, id);
    }
    return id;
  }

  recentMessages(sessionId: string, limit = 60): MessageRow[] {
    return this.db
      .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?")
      .all(sessionId, limit)
      .reverse() as unknown as MessageRow[];
  }

  /** Every message body in a session — the delete-a-chat path reads files out
   *  of these before the rows go (Task 30). */
  messageContents(sessionId: string): string[] {
    return (this.db.prepare("SELECT content FROM messages WHERE session_id = ?").all(sessionId) as { content: string }[]).map(
      (r) => String(r.content ?? ""),
    );
  }

  /**
   * Does any message, in any session, still mention this text? Used to keep an
   * attachment alive when a fork references the same file. LIKE wildcards in
   * the needle are escaped, otherwise `media/a_b.png` would match `media/axb.png`.
   */
  anyMessageMentions(needle: string): boolean {
    if (!needle) return false;
    const escaped = needle.replace(/[\\%_]/g, (m) => `\\${m}`);
    const hit = this.db
      .prepare("SELECT 1 AS hit FROM messages WHERE content LIKE ? ESCAPE '\\' LIMIT 1")
      .get(`%${escaped}%`) as { hit?: number } | undefined;
    return Boolean(hit);
  }

  /** Newest `user` row (regenerate re-runs exactly this prompt). */
  lastUserMessage(sessionId: string): MessageRow | undefined {
    return this.db
      .prepare("SELECT * FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1")
      .get(sessionId) as MessageRow | undefined;
  }

  /**
   * One row by id, scoped to its session — the anchor for a rewind. Scoping is
   * not decorative: an id from another session must not be reachable.
   */
  messageById(sessionId: string, id: number): MessageRow | undefined {
    return this.db
      .prepare("SELECT * FROM messages WHERE session_id = ? AND id = ?")
      .get(sessionId, id) as MessageRow | undefined;
  }

  /** Drop every row after `afterId` — one turn's worth for regenerate. */
  deleteMessagesAfter(sessionId: string, afterId: number): number {
    return this.#deleteRows(sessionId, ">", afterId);
  }

  /** Drop `fromId` itself and everything after it — one prompt for rewind/Edit. */
  deleteMessagesFrom(sessionId: string, fromId: number): number {
    return this.#deleteRows(sessionId, ">=", fromId);
  }

  /** Shared tail of both truncations: rows, their FTS entries, the session clock. */
  #deleteRows(sessionId: string, op: ">" | ">=", bound: number): number {
    const where = `session_id = ? AND id ${op} ?`;
    const ids = this.db
      .prepare(`SELECT id FROM messages WHERE ${where}`)
      .all(sessionId, bound) as { id: number }[];
    if (ids.length === 0) return 0;
    this.db.prepare(`DELETE FROM messages WHERE ${where}`).run(sessionId, bound);
    if (this.fts) {
      const del = this.db.prepare("DELETE FROM fts_messages WHERE message_id = ?");
      for (const row of ids) del.run(row.id);
    }
    // The session's own clock follows what is still there.
    const last = this.db
      .prepare("SELECT created_at FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 1")
      .get(sessionId) as { created_at: number } | undefined;
    if (last) this.db.prepare("UPDATE sessions SET last_msg_at = ? WHERE id = ?").run(last.created_at, sessionId);
    return ids.length;
  }

  /**
   * Fork a conversation (Task 25): a new session holding every row written
   * before `beforeId`, in order. The copy is faithful — created_at, run_id and
   * the usage blob move with the row — so a forked turn keeps its real clock
   * and its /usage line. The parent is only read.
   */
  forkSession(
    parent: SessionRow,
    opts: { key: string; name?: string | null; beforeId: number },
  ): { session: SessionRow; copied: number } {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .prepare("INSERT INTO sessions(id, key, agent_id, name, created_at, last_msg_at) VALUES(?, ?, ?, ?, ?, ?)")
      .run(id, opts.key, parent.agent_id, opts.name ?? null, now, now);

    const rows = this.db
      .prepare("SELECT * FROM messages WHERE session_id = ? AND id < ? ORDER BY id ASC")
      .all(parent.id, opts.beforeId) as unknown as MessageRow[];

    const insert = this.db.prepare(
      "INSERT INTO messages(session_id, run_id, role, content, created_at, usage) VALUES(?, ?, ?, ?, ?, ?)",
    );
    let lastAt = now;
    for (const row of rows) {
      const res = insert.run(id, row.run_id, row.role, row.content, row.created_at, row.usage ?? null);
      lastAt = row.created_at;
      if (this.fts) {
        this.db
          .prepare("INSERT INTO fts_messages(content, session_id, message_id) VALUES(?, ?, ?)")
          .run(row.content.replace(/\s+/g, " ").slice(0, 4000), id, Number(res.lastInsertRowid));
      }
    }
    // The new session's clock is the last thing it actually contains.
    if (rows.length > 0) this.db.prepare("UPDATE sessions SET last_msg_at = ? WHERE id = ?").run(lastAt, id);

    return { session: this.getSession(id)!, copied: rows.length };
  }

  // ---- context compaction (P1 A2) ------------------------------------------

  /** All rows after `afterId` (oldest-first) — compaction spans, not display. */
  messagesAfter(sessionId: string, afterId: number, limit = 5000): MessageRow[] {
    return this.db
      .prepare("SELECT * FROM messages WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?")
      .all(sessionId, afterId, limit) as unknown as MessageRow[];
  }

  getSummary(sessionId: string): SessionSummaryRow | null {
    const row = this.db
      .prepare("SELECT * FROM session_summaries WHERE session_id = ?")
      .get(sessionId) as SessionSummaryRow | undefined;
    return row ?? null;
  }

  /** Record a rewrite covering everything up to message `upto`. Counts only advances. */
  setSummary(sessionId: string, upto: number, summary: string, spanChars: number): void {
    const prev = this.getSummary(sessionId);
    const count = (prev?.count ?? 0) + (upto > (prev?.upto ?? 0) ? 1 : 0);
    this.db
      .prepare(
        `INSERT INTO session_summaries(session_id, upto, summary, chars, count, updated)
         VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           upto = excluded.upto, summary = excluded.summary,
           chars = session_summaries.chars + CASE WHEN excluded.upto > session_summaries.upto THEN excluded.chars ELSE 0 END,
           count = excluded.count, updated = excluded.updated`,
      )
      .run(sessionId, upto, summary, spanChars, count, Date.now());
  }

  // ---- runs -------------------------------------------------------------
  startRun(sessionId: string, runId: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO runs(id, session_id, status, started_at) VALUES(?, ?, ?, ?)")
      .run(runId, sessionId, "running", Date.now());
  }

  finishRun(runId: string, status: "done" | "error" | "aborted", usage?: unknown, error?: string, model?: string): void {
    this.db
      .prepare("UPDATE runs SET status = ?, ended_at = ?, usage = ?, error = ?, model = ? WHERE id = ?")
      .run(status, Date.now(), usage ? JSON.stringify(usage) : null, error ?? null, model ?? null, runId);
  }

  /** All runs of one session oldest-first (transcript export, P3 #20). */
  runsForSession(sessionId: string): { id: string; status: string; model: string | null; started_at: number; ended_at: number | null }[] {
    return this.db
      .prepare("SELECT id, status, model, started_at, ended_at FROM runs WHERE session_id = ? ORDER BY started_at ASC")
      .all(sessionId) as { id: string; status: string; model: string | null; started_at: number; ended_at: number | null }[];
  }

  /** Runs that carried usage accounting, newest first (sc usage aggregation). */
  listRunsWithUsage(limit = 10_000): { id: string; session_id: string; model: string | null; usage: string; started_at: number; ended_at: number | null; status: string }[] {
    return this.db
      .prepare("SELECT id, session_id, model, usage, started_at, ended_at, status FROM runs WHERE usage IS NOT NULL ORDER BY started_at DESC LIMIT ?")
      .all(limit) as { id: string; session_id: string; model: string | null; usage: string; started_at: number; ended_at: number | null; status: string }[];
  }

  // ---- tools ------------------------------------------------------------
  logTool(runId: string, tool: string, status: string, ms: number): void {
    this.db
      .prepare("INSERT INTO tool_log(run_id, tool, status, ms, at) VALUES(?, ?, ?, ?, ?)")
      .run(runId, tool, status, ms, Date.now());
  }

  // ---- search -----------------------------------------------------------
  searchMessages(sessionId: string, query: string, limit = 10): MessageRow[] {
    const like = `%${query.replace(/[%_]/g, "")}%`;
    if (this.fts) {
      try {
        return this.db
          .prepare(
            `SELECT m.* FROM fts_messages f JOIN messages m ON m.id = f.message_id
             WHERE fts_messages MATCH ? AND f.session_id = ? ORDER BY m.id DESC LIMIT ?`,
          )
          .all(query.replace(/[^\w\s]/g, " ").trim(), sessionId, limit) as unknown as MessageRow[];
      } catch {
        /* fall through to LIKE */
      }
    }
    return this.db
      .prepare("SELECT * FROM messages WHERE session_id = ? AND content LIKE ? ORDER BY id DESC LIMIT ?")
      .all(sessionId, like, limit) as unknown as MessageRow[];
  }

  /** Cross-session search — what `memory_search` actually wants: every
   *  transcript, labelled with the session key it came from. */
  searchMessagesAll(
    query: string,
    limit = 10,
  ): (MessageRow & { session_key: string })[] {
    const like = `%${query.replace(/[%_]/g, "")}%`;
    if (this.fts) {
      try {
        return this.db
          .prepare(
            `SELECT m.*, s.key AS session_key FROM fts_messages f
             JOIN messages m ON m.id = f.message_id
             JOIN sessions s ON s.id = m.session_id
             WHERE fts_messages MATCH ? ORDER BY m.id DESC LIMIT ?`,
          )
          .all(query.replace(/[^\w\s]/g, " ").trim(), limit) as unknown as (MessageRow & {
          session_key: string;
        })[];
      } catch {
        /* fall through to LIKE */
      }
    }
    return this.db
      .prepare(
        `SELECT m.*, s.key AS session_key FROM messages m
         JOIN sessions s ON s.id = m.session_id
         WHERE m.content LIKE ? ORDER BY m.id DESC LIMIT ?`,
      )
      .all(like, limit) as unknown as (MessageRow & { session_key: string })[];
  }

  // ---- sessions search ----------------------------------------------------
  /**
   * Session search (Partial #3 — OpenClaw session-search parity). Two hit
   * groups, mirroring their palette: title hits (token match, last token
   * prefix) and transcript hits over user/assistant text only (tool results,
   * reasoning and error rows are excluded). Query words are literal text —
   * punctuation never becomes FTS syntax; the last word is a prefix match.
   * scope "visible" keeps subagent lanes out (their palette rule), "all"
   * includes them.
   */
  searchSessions(
    query: string,
    opts: { limit?: number; sessionKeys?: string[]; scope?: "visible" | "all" } = {},
  ): SessionSearchResult {
    const limit = Math.max(1, Math.min(opts.limit ?? 25, 25));
    const scope = opts.scope ?? "visible";
    const tokens = tokenizeQuery(query);
    const empty: SessionSearchResult = { titleHits: [], messageHits: [] };
    if (tokens.length === 0) return empty;
    const restrict = keysPredicate(opts.sessionKeys, scope);

    // Group 1 — Sessions (titles/identifiers): LIKE per token; literal keys
    // keep substring matching (their identifier rule).
    const titleRows = this.listSessions(200).filter((s) => {
      if (!restrict(s.key)) return false;
      const hay = `${(s.name ?? "").toLowerCase()} ${s.key.toLowerCase()}`;
      return tokens.every((t, i) => {
        const q = t.toLowerCase();
        if (i === tokens.length - 1) {
          // Last word prefixes title word starts; identifiers match anywhere.
          const name = (s.name ?? "").toLowerCase();
          if (name && name.split(/[\s\-_/:]+/).some((w) => w.startsWith(q))) return true;
          return s.key.toLowerCase().includes(q);
        }
        return hay.includes(q);
      });
    });

    // Group 2 — Messages (transcripts): FTS over user/assistant rows only.
    const match = buildMatch(tokens);
    const like = `%${tokens.map((t) => t.replace(/[%_]/g, "")).join(" ")}%`;
    let rows: (MessageRow & { session_key: string; session_name: string | null; snippet: string | null })[] = [];
    if (this.fts) {
      try {
        rows = this.db
          .prepare(
            `SELECT m.*, s.key AS session_key, s.name AS session_name,
                    snippet(fts_messages, 0, '«', '»', '…', 28) AS snippet
             FROM fts_messages f
             JOIN messages m ON m.id = f.message_id
             JOIN sessions s ON s.id = m.session_id
             WHERE fts_messages MATCH ? AND m.role IN ('user','assistant')
             ORDER BY rank, m.created_at DESC LIMIT ?`,
          )
          .all(match, limit * 4) as unknown as typeof rows;
      } catch {
        rows = [];
      }
    }
    if (rows.length === 0) {
      rows = (this.db
        .prepare(
          `SELECT m.*, s.key AS session_key, s.name AS session_name
           FROM messages m JOIN sessions s ON s.id = m.session_id
           WHERE m.content LIKE ? AND m.role IN ('user','assistant')
           ORDER BY m.id DESC LIMIT ?`,
        )
        .all(like, limit * 8) as unknown as typeof rows).map((r) => ({
        ...r,
        snippet: makeSnippet(r.content, tokens),
      }));
    }
    const messageHits: SessionMessageHit[] = [];
    const perSession = new Map<string, number>();
    for (const r of rows) {
      if (!restrict(r.session_key)) continue;
      if (hitsMayContainAllTokens(r.content, tokens, this.fts) === false) continue;
      const n = perSession.get(r.session_key) ?? 0;
      if (n >= 3) continue;
      perSession.set(r.session_key, n + 1);
      messageHits.push({
        sessionKey: r.session_key,
        title: r.session_name,
        messageId: r.id,
        role: r.role,
        createdAt: r.created_at,
        snippet: r.snippet ?? makeSnippet(r.content, tokens),
      });
      if (messageHits.length >= limit) break;
    }
    return {
      titleHits: titleRows.slice(0, limit).map((s) => ({
        sessionKey: s.key,
        title: s.name,
        lastMsgAt: s.last_msg_at,
      })),
      messageHits,
    };
  }

  /** Anchored transcript window: the returned span is bounded by limit
   *  (their rule) with a before-heavier bias for context; a missing or
   *  off-session anchor yields an EMPTY list, never the tail. */
  messagesAround(sessionId: string, messageId: number, limit = 30): MessageRow[] {
    const anchor = this.db
      .prepare("SELECT id FROM messages WHERE id = ? AND session_id = ?")
      .get(messageId, sessionId) as { id: number } | undefined;
    if (!anchor) return [];
    const total = Math.max(1, limit);
    const before = this.db
      .prepare("SELECT * FROM messages WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?")
      .all(sessionId, messageId, Math.ceil((total - 1) / 2)) as unknown as MessageRow[];
    const after = this.db
      .prepare("SELECT * FROM messages WHERE session_id = ? AND id >= ? ORDER BY id ASC LIMIT ?")
      .all(sessionId, messageId, total - before.length) as unknown as MessageRow[];
    return [...before.reverse(), ...after];
  }

  // ---- cron jobs --------------------------------------------------------
  listJobs(): JobRow[] {
    return this.db.prepare("SELECT * FROM jobs ORDER BY created_at DESC").all() as unknown as JobRow[];
  }

  getJob(id: string): JobRow | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
  }

  upsertJob(job: Omit<JobRow, "created_at" | "last_run_at"> & { last_run_at?: number | null }): JobRow {
    const existing = this.getJob(job.id);
    if (existing) {
      this.db
        .prepare(
          "UPDATE jobs SET name = ?, schedule = ?, prompt = ?, session_key = ?, enabled = ?, last_run_at = ?, tz = ?, delivery_mode = ?, delivery_to = ?, delivery_suppress_empty = ? WHERE id = ?",
        )
        .run(job.name, job.schedule, job.prompt, job.session_key, job.enabled ? 1 : 0, job.last_run_at ?? existing.last_run_at, job.tz ?? existing.tz, job.delivery_mode ?? existing.delivery_mode, job.delivery_to ?? existing.delivery_to, job.delivery_suppress_empty ?? existing.delivery_suppress_empty, job.id);
      return this.getJob(job.id) as JobRow;
    }
    this.db
      .prepare(
        "INSERT INTO jobs(id, name, schedule, prompt, session_key, enabled, last_run_at, tz, delivery_mode, delivery_to, delivery_suppress_empty, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(job.id, job.name, job.schedule, job.prompt, job.session_key, job.enabled ? 1 : 0, job.last_run_at ?? null, job.tz ?? null, job.delivery_mode ?? null, job.delivery_to ?? null, job.delivery_suppress_empty ?? 1, Date.now());
    return this.getJob(job.id) as JobRow;
  }

  deleteJob(id: string): void {
    this.db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
  }

  recordJobRun(jobId: string, status: string, result: string): void {
    const now = Date.now();
    this.db.prepare("INSERT INTO job_runs(job_id, started_at, status, result) VALUES(?, ?, ?, ?)").run(jobId, now, status, result);
    this.db.prepare("UPDATE jobs SET last_run_at = ? WHERE id = ?").run(now, jobId);
  }

  lastJobRuns(limit = 20): { job_id: string; started_at: number; status: string; result: string }[] {
    return this.db
      .prepare("SELECT job_id, started_at, status, result FROM job_runs ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as { job_id: string; started_at: number; status: string; result: string }[];
  }

  /**
   * `sc sessions delete` (P2 #11): remove the session and everything that
   * belongs to it — messages + FTS rows, runs, tool_log, the compaction
   * summary, and subagent links pointing at it (their delete semantics).
   */
  /** Manual archive/unarchive (P4 #33, session menu): archived rows keep id
   *  + history (their rule) but leave the default sidebar list; unarchive
   *  clears the flag and reason. */
  setSessionArchived(key: string, archived: boolean): { ok: boolean } {
    const res = this.db
      .prepare(`UPDATE sessions SET archived = ?, archived_at = ?, archive_reason = CASE WHEN ? = 0 THEN NULL ELSE archive_reason END WHERE key = ?`)
      .run(archived ? 1 : 0, archived ? Date.now() : null, archived ? 1 : 0, key);
    return { ok: res.changes > 0 };
  }

  deleteSession(key: string): { deleted: boolean; messages: number } {
    const s = this.getSessionByKey(key);
    if (!s) return { deleted: false, messages: 0 };
    const messages = (this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?").get(s.id) as { n: number }).n;
    if (this.fts) this.db.prepare("DELETE FROM fts_messages WHERE session_id = ?").run(s.id);
    this.db.prepare("DELETE FROM tool_log WHERE run_id IN (SELECT id FROM runs WHERE session_id = ?)").run(s.id);
    this.db.prepare("DELETE FROM runs WHERE session_id = ?").run(s.id);
    this.db.prepare("DELETE FROM messages WHERE session_id = ?").run(s.id);
    this.db.prepare("DELETE FROM session_summaries WHERE session_id = ?").run(s.id);
    this.db.prepare("DELETE FROM subagents WHERE child_session_key = ? OR parent_session_key = ?").run(s.key, s.key);
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(s.id);
    return { deleted: true, messages };
  }

  /** Per-session /queue override (mode + optional drop/debounce/cap options). */
  setSessionQueue(
    key: string,
    mode: string | null,
    opts: { debounceMs?: number; cap?: number; drop?: string } | null,
  ): void {
    const row = this.ensureSession(key);
    this.db
      .prepare("UPDATE sessions SET queue_mode = ?, queue_opts = ? WHERE id = ?")
      .run(mode, opts ? JSON.stringify(opts) : null, row.id);
  }

  registerSubagent(row: SubagentRow): void {
    this.db
      .prepare(
        `INSERT INTO subagents(child_session_key, parent_session_key, run_id, label, task, task_name, depth, status, delivery, spawned_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.child_session_key,
        row.parent_session_key,
        row.run_id,
        row.label,
        row.task,
        row.task_name,
        row.depth,
        row.status,
        row.delivery,
        row.spawned_at,
      );
  }

  getSubagent(childSessionKey: string): SubagentRow | undefined {
    return this.db
      .prepare("SELECT * FROM subagents WHERE child_session_key = ?")
      .get(childSessionKey) as SubagentRow | undefined;
  }

  finishSubagent(
    childSessionKey: string,
    patch: { status: string; outcome?: string | null; resultStats?: string | null; delivery?: string },
  ): void {
    this.db
      .prepare(
        "UPDATE subagents SET status = ?, outcome = COALESCE(?, outcome), result_stats = COALESCE(?, result_stats), delivery = COALESCE(?, delivery), ended_at = ? WHERE child_session_key = ?",
      )
      .run(patch.status, patch.outcome ?? null, patch.resultStats ?? null, patch.delivery ?? null, Date.now(), childSessionKey);
  }

  markSubagentDelivered(childSessionKey: string): void {
    this.db
      .prepare("UPDATE subagents SET delivery = 'delivered' WHERE child_session_key = ?")
      .run(childSessionKey);
  }

  /** Children of a parent session, newest last. activeOnly hides settled rows. */
  subagentsFor(parentSessionKey: string, opts?: { activeOnly?: boolean; limit?: number }): SubagentRow[] {
    const limit = opts?.limit ?? 50;
    if (opts?.activeOnly) {
      return this.db
        .prepare(
          "SELECT * FROM subagents WHERE parent_session_key = ? AND status = 'running' ORDER BY spawned_at ASC LIMIT ?",
        )
        .all(parentSessionKey, limit) as unknown as SubagentRow[];
    }
    const rows = this.db
      .prepare("SELECT * FROM subagents WHERE parent_session_key = ? ORDER BY spawned_at DESC LIMIT ?")
      .all(parentSessionKey, limit) as unknown as SubagentRow[];
    return rows.reverse();
  }

  /** Finished children whose completion the parent has not been told about yet. */
  pendingSubagentDeliveries(parentSessionKey: string): SubagentRow[] {
    return this.db
      .prepare(
        "SELECT * FROM subagents WHERE parent_session_key = ? AND status != 'running' AND delivery = 'pending' ORDER BY spawned_at ASC",
      )
      .all(parentSessionKey) as unknown as SubagentRow[];
  }

  /** Boot recovery: any child still 'running' after a restart is interrupted. */
  sweepInterruptedSubagents(): number {
    const res = this.db
      .prepare("UPDATE subagents SET status = 'interrupted', ended_at = ? WHERE status = 'running'")
      .run(Date.now());
    return Number(res.changes);
  }

  // ---- dreaming (Partial #5) ------------------------------------------------

  /** Recent owner interactive transcript lines for light-phase ingestion —
   *  user/assistant text only; subagent/system/cron lanes excluded. */
  dreamTranscriptLines(sinceMs: number, limit = 150): (MessageRow & { session_key: string })[] {
    return this.db
      .prepare(
        `SELECT m.*, s.key AS session_key FROM messages m
         JOIN sessions s ON s.id = m.session_id
         WHERE m.created_at >= ? AND m.role IN ('user','assistant')
           AND s.key NOT LIKE 'subagent:%' AND s.key NOT LIKE 'system:%' AND s.key NOT LIKE 'cron:%'
         ORDER BY m.created_at DESC LIMIT ?`,
      )
      .all(sinceMs, limit) as unknown as (MessageRow & { session_key: string })[];
  }

  // ══ auth profiles (Partial #6) ════════════════════════════════════════
  /** Insert or replace (their `--force` semantics): reuse keeps last_used stats
   * only when nothing is replaced; a reuse/force reset clears health. */
  upsertAuthProfile(p: {
    id: string;
    provider: string;
    type: "api_key" | "token" | "oauth";
    material: string;
    expires?: number;
    label?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO auth_profiles(id, provider, type, material, expires, label, created_at, last_used_at, last_ok_at, fail_count, cooldown_until)
         VALUES(?,?,?,?,?,?,?,?,0,0,0)
         ON CONFLICT(id) DO UPDATE SET type=excluded.type, material=excluded.material,
           expires=excluded.expires, label=excluded.label, fail_count=0, cooldown_until=0`,
      )
      .run(p.id, p.provider, p.type, p.material, p.expires ?? 0, p.label ?? "", Date.now(), Date.now());
  }

  authProfile(id: string): AuthProfileRow | undefined {
    return this.db.prepare("SELECT * FROM auth_profiles WHERE id=?").get(id) as AuthProfileRow | undefined;
  }

  authProfiles(provider?: string): AuthProfileRow[] {
    return provider
      ? (this.db.prepare("SELECT * FROM auth_profiles WHERE provider=? ORDER BY id").all(provider) as unknown as AuthProfileRow[])
      : (this.db.prepare("SELECT * FROM auth_profiles ORDER BY provider, id").all() as unknown as AuthProfileRow[]);
  }

  removeAuthProfile(id: string): boolean {
    this.db.prepare("DELETE FROM auth_profiles WHERE id=?").run(id);
    // Also drop from any stored provider order (their: removal is not recreated).
    for (const row of this.db.prepare("SELECT provider, profile_ids FROM auth_profile_order").all() as unknown as {
      provider: string;
      profile_ids: string;
    }[]) {
      const ids = JSON.parse(row.profile_ids) as string[];
      if (ids.includes(id)) this.setAuthOrder(row.provider, ids.filter((x) => x !== id));
    }
    return (this.db.prepare("SELECT changes() AS c").get() as { c: number }).c > 0;
  }

  markAuthUsed(id: string, ok: boolean): void {
    if (ok) {
      this.db.prepare("UPDATE auth_profiles SET last_used_at=?, last_ok_at=?, fail_count=0, cooldown_until=0 WHERE id=?").run(Date.now(), Date.now(), id);
    } else {
      // Their cooldown ladder: 5m, 10m, 20m… capped at 60m, per profile only.
      const row = this.authProfile(id);
      if (!row) return;
      const fails = row.fail_count + 1;
      const cooldown = Date.now() + Math.min(5 * 60_000 * 2 ** (fails - 1), 60 * 60_000);
      this.db.prepare("UPDATE auth_profiles SET last_used_at=?, fail_count=?, cooldown_until=? WHERE id=?").run(Date.now(), fails, cooldown, id);
    }
  }

  authOrder(provider: string): string[] {
    const row = this.db.prepare("SELECT profile_ids FROM auth_profile_order WHERE provider=?").get(provider) as
      | { profile_ids: string }
      | undefined;
    return row ? (JSON.parse(row.profile_ids) as string[]) : [];
  }

  setAuthOrder(provider: string, ids: string[]): void {
    if (ids.length === 0) {
      this.db.prepare("DELETE FROM auth_profile_order WHERE provider=?").run(provider);
    } else {
      this.db
        .prepare("INSERT INTO auth_profile_order(provider, profile_ids, updated_at) VALUES(?,?,?) ON CONFLICT(provider) DO UPDATE SET profile_ids=excluded.profile_ids, updated_at=excluded.updated_at")
        .run(provider, JSON.stringify(ids), Date.now());
    }
  }

  /** Light-phase staging. Dedupe against existing identical text+source. */
  stageDreamCandidate(c: { text: string; source: string; day: string; kind: string; importance: number | null; stagedVia: string }): boolean {

    const seen = this.db
      .prepare("SELECT 1 FROM dream_candidates WHERE text = ? AND source = ? AND promoted_at IS NULL LIMIT 1")
      .get(c.text, c.source);
    if (seen) return false;
    this.db
      .prepare("INSERT INTO dream_candidates (text, source, day, kind, importance, staged_at, staged_via) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(c.text, c.source, c.day, c.kind, c.importance, Date.now(), c.stagedVia);
    return true;
  }

  dreamCandidates(opts: { minDay?: string; stagedSinceMs?: number; includePromoted?: boolean; via?: string } = {}): DreamCandidateRow[] {
    const where = ["1=1"];
    const args: unknown[] = [];
    if (opts.minDay) {
      where.push("day >= ?");
      args.push(opts.minDay);
    }
    if (opts.stagedSinceMs) {
      where.push("staged_at >= ?");
      args.push(opts.stagedSinceMs);
    }
    if (!opts.includePromoted) where.push("promoted_at IS NULL");
    if (opts.via) {
      where.push("staged_via = ?");
      args.push(opts.via);
    }
    return this.db
      .prepare(`SELECT * FROM dream_candidates WHERE ${where.join(" AND ")} ORDER BY day DESC, id ASC`)
      .all(...(args as never[])) as unknown as DreamCandidateRow[];
  }

  markDreamCandidatesPromoted(ids: number[]): void {
    const now = Date.now();
    const stmt = this.db.prepare("UPDATE dream_candidates SET promoted_at = ? WHERE id = ?");
    for (const id of ids) stmt.run(now, id);
  }

  /** Backfill rollback: remove only artifacts staged via backfill lanes. */
  rollbackDreamBackfill(): number {
    return this.rollbackDreamBackfillFull().candidates;
  }

  /** P3 #21: shared grounded rollback — candidates AND tracked ingest hashes
   *  (their "rollback removes the tracked hashes … so eligible candidates can
   *  be previewed and applied again"). */
  rollbackDreamBackfillFull(): { candidates: number; hashes: number } {
    const candidates = this.db.prepare("DELETE FROM dream_candidates WHERE staged_via = 'backfill'").run();
    let hashes = 0;
    try {
      hashes = Number(this.db.prepare("DELETE FROM dream_ingest").run().changes);
    } catch {
      /* dream_ingest absent on very old DBs */
    }
    return { candidates: Number(candidates.changes), hashes };
  }

  // ══ memory session-backfill (P3 #21) — tracked ingest hashes ══════════

  /** Same admission as dreamTranscriptLines, over an explicit window. */
  transcriptLinesBetween(fromMs: number, toMs: number, limit = 100_000): (MessageRow & { session_key: string })[] {
    return this.db
      .prepare(
        `SELECT m.*, s.key AS session_key FROM messages m
         JOIN sessions s ON s.id = m.session_id
         WHERE m.created_at >= ? AND m.created_at < ? AND m.role IN ('user','assistant')
           AND s.key NOT LIKE 'subagent:%' AND s.key NOT LIKE 'system:%' AND s.key NOT LIKE 'cron:%'
         ORDER BY m.created_at ASC LIMIT ?`,
      )
      .all(fromMs, toMs, limit) as unknown as (MessageRow & { session_key: string })[];
  }

  hasIngestHash(hash: string): boolean {
    try {
      return !!this.db.prepare("SELECT 1 FROM dream_ingest WHERE hash = ? LIMIT 1").get(hash);
    } catch {
      return false;
    }
  }

  addIngestHash(hash: string, day: string, source: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO dream_ingest(hash, day, source, staged_at) VALUES(?, ?, ?, ?)")
      .run(hash, day, source, Date.now());
  }

  /** Non-mutating duplicate probe mirroring stageDreamCandidate's guard. */
  dreamCandidateExists(text: string, source: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM dream_candidates WHERE text = ? AND source = ? AND promoted_at IS NULL LIMIT 1")
      .get(text, source);
  }

  /** memory_search recall logging — drives the relevance/diversity signals. */
  recordMemoryRecall(query: string, sources: string[]): void {
    if (!query.trim() || sources.length === 0) return;
    this.db
      .prepare("INSERT INTO dream_recalls (query, sources, created_at) VALUES (?, ?, ?)")
      .run(query, JSON.stringify(sources.slice(0, 12)), Date.now());
  }

  /** Recall log rows newer than `sinceMs` (signals only need recent history). */
  dreamRecalls(sinceMs: number): { query: string; sources: string; created_at: number }[] {
    return this.db
      .prepare("SELECT query, sources, created_at FROM dream_recalls WHERE created_at >= ? ORDER BY id ASC")
      .all(sinceMs) as unknown as { query: string; sources: string; created_at: number }[];
  }

  saveDreamPreimage(content: string): void {
    this.db.prepare("INSERT INTO dream_preimages (content, created_at) VALUES (?, ?)").run(content, Date.now());
  }

  latestDreamPreimage(): { content: string; created_at: number } | undefined {
    return this.db
      .prepare("SELECT content, created_at FROM dream_preimages ORDER BY id DESC LIMIT 1")
      .get() as { content: string; created_at: number } | undefined;
  }

  recordDreamRun(run: Omit<DreamRunRow, "id" | "created_at">): void {
    this.db
      .prepare(
        "INSERT INTO dream_runs (day, light_staged, themes, promoted, merged, superseded, rejected, verdict, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(run.day, run.light_staged, run.themes, run.promoted, run.merged, run.superseded, run.rejected, run.verdict, Date.now());
  }

  lastDreamRun(): DreamRunRow | undefined {
    return this.db.prepare("SELECT * FROM dream_runs ORDER BY id DESC LIMIT 1").get() as DreamRunRow | undefined;
  }
}

export interface DreamCandidateRow {
  id: number;
  text: string;
  source: string;
  day: string;
  kind: string;
  importance: number | null;
  staged_at: number;
  staged_via: string;
  promoted_at: number | null;
}

export interface AuthProfileRow {
  id: string;
  provider: string;
  type: "api_key" | "token" | "oauth";
  material: string;
  expires: number;
  label: string;
  created_at: number;
  last_used_at: number;
  last_ok_at: number;
  fail_count: number;
  cooldown_until: number;
}

export interface DreamRunRow {
  id: number;
  day: string;
  light_staged: number;
  themes: string;
  promoted: number;
  merged: number;
  superseded: number;
  rejected: string;
  verdict: string;
  created_at: number;
}