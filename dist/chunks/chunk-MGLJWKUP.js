import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);
import{DatabaseSync as u}from"node:sqlite";import{mkdirSync as T}from"node:fs";import{dirname as d}from"node:path";var g=[["CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);",`CREATE TABLE IF NOT EXISTS sessions (
       id TEXT PRIMARY KEY,
       key TEXT UNIQUE NOT NULL,
       agent_id TEXT NOT NULL DEFAULT 'main',
       name TEXT,
       created_at INTEGER NOT NULL,
       last_msg_at INTEGER NOT NULL DEFAULT 0,
       meta TEXT
     );`,`CREATE TABLE IF NOT EXISTS messages (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       session_id TEXT NOT NULL,
       run_id TEXT,
       role TEXT NOT NULL,
       content TEXT NOT NULL,
       created_at INTEGER NOT NULL
     );`,"CREATE INDEX IF NOT EXISTS messages_session_idx ON messages(session_id, id);",`CREATE TABLE IF NOT EXISTS runs (
       id TEXT PRIMARY KEY,
       session_id TEXT NOT NULL,
       status TEXT NOT NULL,
       started_at INTEGER NOT NULL,
       ended_at INTEGER,
       error TEXT,
       usage TEXT
     );`,`CREATE TABLE IF NOT EXISTS jobs (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       schedule TEXT NOT NULL,
       prompt TEXT NOT NULL,
       session_key TEXT NOT NULL,
       enabled INTEGER NOT NULL DEFAULT 1,
       last_run_at INTEGER,
       created_at INTEGER NOT NULL
     );`,`CREATE TABLE IF NOT EXISTS job_runs (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       job_id TEXT NOT NULL,
       started_at INTEGER NOT NULL,
       status TEXT NOT NULL,
       result TEXT
     );`,`CREATE TABLE IF NOT EXISTS subagents (
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
     );`,"CREATE INDEX IF NOT EXISTS subagents_parent_idx ON subagents(parent_session_key, spawned_at);",`CREATE TABLE IF NOT EXISTS tool_log (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       run_id TEXT NOT NULL,
       tool TEXT NOT NULL,
       status TEXT NOT NULL,
       ms INTEGER NOT NULL,
       at INTEGER NOT NULL
     );`],["CREATE VIRTUAL TABLE IF NOT EXISTS fts_messages USING fts5(content, session_id UNINDEXED, message_id UNINDEXED);"]],E=class o{db;fts;constructor(s,e){this.db=s,this.fts=e}static open(s){T(d(s),{recursive:!0});let e=new u(s);e.exec("PRAGMA journal_mode = WAL"),e.exec("PRAGMA synchronous = NORMAL"),e.exec("PRAGMA busy_timeout = 5000"),e.exec("PRAGMA foreign_keys = ON");let n=!0;for(let[r,a]of g.entries())try{for(let i of a)e.exec(i);e.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)").run(String(r+1))}catch(i){if(/fts5|no such module/i.test(i.message)){n=!1;continue}throw i}let t=new Set(e.prepare("PRAGMA table_info(sessions)").all().map(r=>r.name));return t.has("thinking")||e.exec("ALTER TABLE sessions ADD COLUMN thinking TEXT"),t.has("queue_mode")||e.exec("ALTER TABLE sessions ADD COLUMN queue_mode TEXT"),t.has("queue_opts")||e.exec("ALTER TABLE sessions ADD COLUMN queue_opts TEXT"),new o(e,n)}close(){try{this.db.close()}catch{}}getMeta(s){return this.db.prepare("SELECT value FROM meta WHERE key = ?").get(s)?.value}setMeta(s,e){this.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)").run(s,e)}getSessionByKey(s){return this.db.prepare("SELECT * FROM sessions WHERE key = ?").get(s)}getSession(s){return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(s)}ensureSession(s,e="main"){let n=this.getSessionByKey(s);if(n)return n;let t=crypto.randomUUID(),r=Date.now();return this.db.prepare("INSERT INTO sessions(id, key, agent_id, created_at, last_msg_at) VALUES(?, ?, ?, ?, ?)").run(t,s,e,r,r),{id:t,key:s,agent_id:e,name:null,created_at:r,last_msg_at:r,meta:null}}listSessions(s=50){return this.db.prepare("SELECT * FROM sessions ORDER BY last_msg_at DESC LIMIT ?").all(s)}renameSession(s,e){this.db.prepare("UPDATE sessions SET name = ? WHERE id = ?").run(e,s)}setSessionThinking(s,e){let n=this.ensureSession(s);this.db.prepare("UPDATE sessions SET thinking = ? WHERE id = ?").run(e,n.id)}renameSessionKey(s,e){if(!s||!e)return{ok:!1,error:"old and new session keys are required"};if(s===e)return{ok:!0};let n=this.getSessionByKey(s);return n?this.getSessionByKey(e)?{ok:!1,error:`a session named ${e} already exists`}:(this.db.prepare("UPDATE sessions SET key = ? WHERE id = ?").run(e,n.id),{ok:!0}):{ok:!1,error:`no such session: ${s}`}}appendMessage(s,e,n,t){let r=Date.now(),a=this.db.prepare("INSERT INTO messages(session_id, run_id, role, content, created_at) VALUES(?, ?, ?, ?, ?)").run(s,t??null,e,n,r),i=Number(a.lastInsertRowid);return this.db.prepare("UPDATE sessions SET last_msg_at = ? WHERE id = ?").run(r,s),this.fts&&this.db.prepare("INSERT INTO fts_messages(content, session_id, message_id) VALUES(?, ?, ?)").run(n.replace(/\s+/g," ").slice(0,4e3),s,i),i}recentMessages(s,e=60){return this.db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?").all(s,e).reverse()}startRun(s,e){this.db.prepare("INSERT OR REPLACE INTO runs(id, session_id, status, started_at) VALUES(?, ?, ?, ?)").run(e,s,"running",Date.now())}finishRun(s,e,n,t){this.db.prepare("UPDATE runs SET status = ?, ended_at = ?, usage = ?, error = ? WHERE id = ?").run(e,Date.now(),n?JSON.stringify(n):null,t??null,s)}logTool(s,e,n,t){this.db.prepare("INSERT INTO tool_log(run_id, tool, status, ms, at) VALUES(?, ?, ?, ?, ?)").run(s,e,n,t,Date.now())}searchMessages(s,e,n=10){let t=`%${e.replace(/[%_]/g,"")}%`;if(this.fts)try{return this.db.prepare(`SELECT m.* FROM fts_messages f JOIN messages m ON m.id = f.message_id
             WHERE fts_messages MATCH ? AND f.session_id = ? ORDER BY m.id DESC LIMIT ?`).all(e.replace(/[^\w\s]/g," ").trim(),s,n)}catch{}return this.db.prepare("SELECT * FROM messages WHERE session_id = ? AND content LIKE ? ORDER BY id DESC LIMIT ?").all(s,t,n)}searchMessagesAll(s,e=10){let n=`%${s.replace(/[%_]/g,"")}%`;if(this.fts)try{return this.db.prepare(`SELECT m.*, s.key AS session_key FROM fts_messages f
             JOIN messages m ON m.id = f.message_id
             JOIN sessions s ON s.id = m.session_id
             WHERE fts_messages MATCH ? ORDER BY m.id DESC LIMIT ?`).all(s.replace(/[^\w\s]/g," ").trim(),e)}catch{}return this.db.prepare(`SELECT m.*, s.key AS session_key FROM messages m
         JOIN sessions s ON s.id = m.session_id
         WHERE m.content LIKE ? ORDER BY m.id DESC LIMIT ?`).all(n,e)}listJobs(){return this.db.prepare("SELECT * FROM jobs ORDER BY created_at DESC").all()}getJob(s){return this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(s)}upsertJob(s){let e=this.getJob(s.id);return e?(this.db.prepare("UPDATE jobs SET name = ?, schedule = ?, prompt = ?, session_key = ?, enabled = ?, last_run_at = ? WHERE id = ?").run(s.name,s.schedule,s.prompt,s.session_key,s.enabled?1:0,s.last_run_at??e.last_run_at,s.id),this.getJob(s.id)):(this.db.prepare("INSERT INTO jobs(id, name, schedule, prompt, session_key, enabled, last_run_at, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)").run(s.id,s.name,s.schedule,s.prompt,s.session_key,s.enabled?1:0,s.last_run_at??null,Date.now()),this.getJob(s.id))}deleteJob(s){this.db.prepare("DELETE FROM jobs WHERE id = ?").run(s)}recordJobRun(s,e,n){let t=Date.now();this.db.prepare("INSERT INTO job_runs(job_id, started_at, status, result) VALUES(?, ?, ?, ?)").run(s,t,e,n),this.db.prepare("UPDATE jobs SET last_run_at = ? WHERE id = ?").run(t,s)}lastJobRuns(s=20){return this.db.prepare("SELECT job_id, started_at, status, result FROM job_runs ORDER BY id DESC LIMIT ?").all(s)}setSessionQueue(s,e,n){let t=this.ensureSession(s);this.db.prepare("UPDATE sessions SET queue_mode = ?, queue_opts = ? WHERE id = ?").run(e,n?JSON.stringify(n):null,t.id)}registerSubagent(s){this.db.prepare(`INSERT INTO subagents(child_session_key, parent_session_key, run_id, label, task, task_name, depth, status, delivery, spawned_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(s.child_session_key,s.parent_session_key,s.run_id,s.label,s.task,s.task_name,s.depth,s.status,s.delivery,s.spawned_at)}getSubagent(s){return this.db.prepare("SELECT * FROM subagents WHERE child_session_key = ?").get(s)}finishSubagent(s,e){this.db.prepare("UPDATE subagents SET status = ?, outcome = COALESCE(?, outcome), result_stats = COALESCE(?, result_stats), delivery = COALESCE(?, delivery), ended_at = ? WHERE child_session_key = ?").run(e.status,e.outcome??null,e.resultStats??null,e.delivery??null,Date.now(),s)}markSubagentDelivered(s){this.db.prepare("UPDATE subagents SET delivery = 'delivered' WHERE child_session_key = ?").run(s)}subagentsFor(s,e){let n=e?.limit??50;return e?.activeOnly?this.db.prepare("SELECT * FROM subagents WHERE parent_session_key = ? AND status = 'running' ORDER BY spawned_at ASC LIMIT ?").all(s,n):this.db.prepare("SELECT * FROM subagents WHERE parent_session_key = ? ORDER BY spawned_at DESC LIMIT ?").all(s,n).reverse()}pendingSubagentDeliveries(s){return this.db.prepare("SELECT * FROM subagents WHERE parent_session_key = ? AND status != 'running' AND delivery = 'pending' ORDER BY spawned_at ASC").all(s)}sweepInterruptedSubagents(){let s=this.db.prepare("UPDATE subagents SET status = 'interrupted', ended_at = ? WHERE status = 'running'").run(Date.now());return Number(s.changes)}};export{E as a};
