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
}

export interface MessageRow {
  id: number;
  session_id: string;
  run_id: string | null;
  role: string;
  content: string;
  created_at: number;
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

  listSessions(limit = 50): SessionRow[] {
    return this.db
      .prepare("SELECT * FROM sessions ORDER BY last_msg_at DESC LIMIT ?")
      .all(limit) as unknown as SessionRow[];
  }

  renameSession(id: string, name: string): void {
    this.db.prepare("UPDATE sessions SET name = ? WHERE id = ?").run(name, id);
  }

  // ---- messages ---------------------------------------------------------
  appendMessage(sessionId: string, role: string, content: string, runId?: string): number {
    const now = Date.now();
    const res = this.db
      .prepare("INSERT INTO messages(session_id, run_id, role, content, created_at) VALUES(?, ?, ?, ?, ?)")
      .run(sessionId, runId ?? null, role, content, now);
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

  // ---- runs -------------------------------------------------------------
  startRun(sessionId: string, runId: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO runs(id, session_id, status, started_at) VALUES(?, ?, ?, ?)")
      .run(runId, sessionId, "running", Date.now());
  }

  finishRun(runId: string, status: "done" | "error" | "aborted", usage?: unknown, error?: string): void {
    this.db
      .prepare("UPDATE runs SET status = ?, ended_at = ?, usage = ?, error = ? WHERE id = ?")
      .run(status, Date.now(), usage ? JSON.stringify(usage) : null, error ?? null, runId);
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
          "UPDATE jobs SET name = ?, schedule = ?, prompt = ?, session_key = ?, enabled = ?, last_run_at = ? WHERE id = ?",
        )
        .run(job.name, job.schedule, job.prompt, job.session_key, job.enabled ? 1 : 0, job.last_run_at ?? existing.last_run_at, job.id);
      return this.getJob(job.id) as JobRow;
    }
    this.db
      .prepare(
        "INSERT INTO jobs(id, name, schedule, prompt, session_key, enabled, last_run_at, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(job.id, job.name, job.schedule, job.prompt, job.session_key, job.enabled ? 1 : 0, job.last_run_at ?? null, Date.now());
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
}