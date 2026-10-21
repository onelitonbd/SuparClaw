import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);
import{DatabaseSync as h}from"node:sqlite";import{mkdirSync as O}from"node:fs";import{dirname as A}from"node:path";function f(E){return E.replace(/[^\p{L}\p{N}_]/gu," ").split(/\s+/).map(s=>s.trim()).filter(s=>s.length>0).slice(0,6)}function I(E){let s=t=>`"${t.replace(/"/g,'""')}"`,e=E.map(s);return e.length>0&&(e[e.length-1]+="*"),e.join(" AND ")}function w(E,s){if(E&&E.length>0){let e=new Set(E);return t=>e.has(t)}return s==="visible"?e=>!e.startsWith("subagent:"):()=>!0}function p(E,s){let e=E.replace(/\s+/g," ").trim(),t=e.toLowerCase(),n=-1;for(let u of s){let o=t.indexOf(u.toLowerCase());o>=0&&(n<0||o<n)&&(n=o)}if(n<0)return e.slice(0,300)+(e.length>300?"\u2026":"");let r=Math.max(0,n-60),l=Math.min(e.length,n+220),a=e.slice(r,l),T="",R=a.toLowerCase(),g=[];for(let u of s){let o=u.toLowerCase(),i=0;for(;(i=R.indexOf(o,i))>=0;)g.push([i,i+o.length]),i+=o.length}g.sort((u,o)=>u[0]-o[0]);let d=0;for(let[u,o]of g)u<d||(T+=a.slice(d,u)+"\xAB"+a.slice(u,o)+"\xBB",d=o);return T+=a.slice(d),(r>0?"\u2026":"")+T+(l<e.length?"\u2026":"")}function k(E,s,e){if(e)return!0;let t=E.toLowerCase();return s.every(n=>t.includes(n.toLowerCase()))}var y=[["CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);",`CREATE TABLE IF NOT EXISTS sessions (
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
     );`],["CREATE VIRTUAL TABLE IF NOT EXISTS fts_messages USING fts5(content, session_id UNINDEXED, message_id UNINDEXED);"]],N=class E{db;fts;constructor(s,e){this.db=s,this.fts=e}static open(s){O(A(s),{recursive:!0});let e=new h(s);e.exec("PRAGMA journal_mode = WAL"),e.exec("PRAGMA synchronous = NORMAL"),e.exec("PRAGMA busy_timeout = 5000"),e.exec("PRAGMA foreign_keys = ON");let t=!0;for(let[r,l]of y.entries())try{for(let a of l)e.exec(a);e.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)").run(String(r+1))}catch(a){if(/fts5|no such module/i.test(a.message)){t=!1;continue}throw a}let n=new Set(e.prepare("PRAGMA table_info(sessions)").all().map(r=>r.name));return n.has("thinking")||e.exec("ALTER TABLE sessions ADD COLUMN thinking TEXT"),n.has("queue_mode")||e.exec("ALTER TABLE sessions ADD COLUMN queue_mode TEXT"),n.has("queue_opts")||e.exec("ALTER TABLE sessions ADD COLUMN queue_opts TEXT"),new E(e,t)}close(){try{this.db.close()}catch{}}getMeta(s){return this.db.prepare("SELECT value FROM meta WHERE key = ?").get(s)?.value}setMeta(s,e){this.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)").run(s,e)}getSessionByKey(s){return this.db.prepare("SELECT * FROM sessions WHERE key = ?").get(s)}getSession(s){return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(s)}ensureSession(s,e="main"){let t=this.getSessionByKey(s);if(t)return t;let n=crypto.randomUUID(),r=Date.now();return this.db.prepare("INSERT INTO sessions(id, key, agent_id, created_at, last_msg_at) VALUES(?, ?, ?, ?, ?)").run(n,s,e,r,r),{id:n,key:s,agent_id:e,name:null,created_at:r,last_msg_at:r,meta:null}}listSessions(s=50){return this.db.prepare("SELECT * FROM sessions ORDER BY last_msg_at DESC LIMIT ?").all(s)}renameSession(s,e){this.db.prepare("UPDATE sessions SET name = ? WHERE id = ?").run(e,s)}setSessionThinking(s,e){let t=this.ensureSession(s);this.db.prepare("UPDATE sessions SET thinking = ? WHERE id = ?").run(e,t.id)}renameSessionKey(s,e){if(!s||!e)return{ok:!1,error:"old and new session keys are required"};if(s===e)return{ok:!0};let t=this.getSessionByKey(s);return t?this.getSessionByKey(e)?{ok:!1,error:`a session named ${e} already exists`}:(this.db.prepare("UPDATE sessions SET key = ? WHERE id = ?").run(e,t.id),{ok:!0}):{ok:!1,error:`no such session: ${s}`}}appendMessage(s,e,t,n){let r=Date.now(),l=this.db.prepare("INSERT INTO messages(session_id, run_id, role, content, created_at) VALUES(?, ?, ?, ?, ?)").run(s,n??null,e,t,r),a=Number(l.lastInsertRowid);return this.db.prepare("UPDATE sessions SET last_msg_at = ? WHERE id = ?").run(r,s),this.fts&&this.db.prepare("INSERT INTO fts_messages(content, session_id, message_id) VALUES(?, ?, ?)").run(t.replace(/\s+/g," ").slice(0,4e3),s,a),a}recentMessages(s,e=60){return this.db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?").all(s,e).reverse()}startRun(s,e){this.db.prepare("INSERT OR REPLACE INTO runs(id, session_id, status, started_at) VALUES(?, ?, ?, ?)").run(e,s,"running",Date.now())}finishRun(s,e,t,n){this.db.prepare("UPDATE runs SET status = ?, ended_at = ?, usage = ?, error = ? WHERE id = ?").run(e,Date.now(),t?JSON.stringify(t):null,n??null,s)}logTool(s,e,t,n){this.db.prepare("INSERT INTO tool_log(run_id, tool, status, ms, at) VALUES(?, ?, ?, ?, ?)").run(s,e,t,n,Date.now())}searchMessages(s,e,t=10){let n=`%${e.replace(/[%_]/g,"")}%`;if(this.fts)try{return this.db.prepare(`SELECT m.* FROM fts_messages f JOIN messages m ON m.id = f.message_id
             WHERE fts_messages MATCH ? AND f.session_id = ? ORDER BY m.id DESC LIMIT ?`).all(e.replace(/[^\w\s]/g," ").trim(),s,t)}catch{}return this.db.prepare("SELECT * FROM messages WHERE session_id = ? AND content LIKE ? ORDER BY id DESC LIMIT ?").all(s,n,t)}searchMessagesAll(s,e=10){let t=`%${s.replace(/[%_]/g,"")}%`;if(this.fts)try{return this.db.prepare(`SELECT m.*, s.key AS session_key FROM fts_messages f
             JOIN messages m ON m.id = f.message_id
             JOIN sessions s ON s.id = m.session_id
             WHERE fts_messages MATCH ? ORDER BY m.id DESC LIMIT ?`).all(s.replace(/[^\w\s]/g," ").trim(),e)}catch{}return this.db.prepare(`SELECT m.*, s.key AS session_key FROM messages m
         JOIN sessions s ON s.id = m.session_id
         WHERE m.content LIKE ? ORDER BY m.id DESC LIMIT ?`).all(t,e)}searchSessions(s,e={}){let t=Math.max(1,Math.min(e.limit??25,25)),n=e.scope??"visible",r=f(s),l={titleHits:[],messageHits:[]};if(r.length===0)return l;let a=w(e.sessionKeys,n),T=this.listSessions(200).filter(i=>{if(!a(i.key))return!1;let _=`${(i.name??"").toLowerCase()} ${i.key.toLowerCase()}`;return r.every((L,S)=>{let c=L.toLowerCase();if(S===r.length-1){let m=(i.name??"").toLowerCase();return m&&m.split(/[\s\-_/:]+/).some(b=>b.startsWith(c))?!0:i.key.toLowerCase().includes(c)}return _.includes(c)})}),R=I(r),g=`%${r.map(i=>i.replace(/[%_]/g,"")).join(" ")}%`,d=[];if(this.fts)try{d=this.db.prepare(`SELECT m.*, s.key AS session_key, s.name AS session_name,
                    snippet(fts_messages, 0, '\xAB', '\xBB', '\u2026', 28) AS snippet
             FROM fts_messages f
             JOIN messages m ON m.id = f.message_id
             JOIN sessions s ON s.id = m.session_id
             WHERE fts_messages MATCH ? AND m.role IN ('user','assistant')
             ORDER BY rank, m.created_at DESC LIMIT ?`).all(R,t*4)}catch{d=[]}d.length===0&&(d=this.db.prepare(`SELECT m.*, s.key AS session_key, s.name AS session_name
           FROM messages m JOIN sessions s ON s.id = m.session_id
           WHERE m.content LIKE ? AND m.role IN ('user','assistant')
           ORDER BY m.id DESC LIMIT ?`).all(g,t*8).map(i=>({...i,snippet:p(i.content,r)})));let u=[],o=new Map;for(let i of d){if(!a(i.session_key)||k(i.content,r,this.fts)===!1)continue;let _=o.get(i.session_key)??0;if(!(_>=3)&&(o.set(i.session_key,_+1),u.push({sessionKey:i.session_key,title:i.session_name,messageId:i.id,role:i.role,createdAt:i.created_at,snippet:i.snippet??p(i.content,r)}),u.length>=t))break}return{titleHits:T.slice(0,t).map(i=>({sessionKey:i.key,title:i.name,lastMsgAt:i.last_msg_at})),messageHits:u}}messagesAround(s,e,t=30){if(!this.db.prepare("SELECT id FROM messages WHERE id = ? AND session_id = ?").get(e,s))return[];let r=Math.max(1,t),l=this.db.prepare("SELECT * FROM messages WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?").all(s,e,Math.ceil((r-1)/2)),a=this.db.prepare("SELECT * FROM messages WHERE session_id = ? AND id >= ? ORDER BY id ASC LIMIT ?").all(s,e,r-l.length);return[...l.reverse(),...a]}listJobs(){return this.db.prepare("SELECT * FROM jobs ORDER BY created_at DESC").all()}getJob(s){return this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(s)}upsertJob(s){let e=this.getJob(s.id);return e?(this.db.prepare("UPDATE jobs SET name = ?, schedule = ?, prompt = ?, session_key = ?, enabled = ?, last_run_at = ? WHERE id = ?").run(s.name,s.schedule,s.prompt,s.session_key,s.enabled?1:0,s.last_run_at??e.last_run_at,s.id),this.getJob(s.id)):(this.db.prepare("INSERT INTO jobs(id, name, schedule, prompt, session_key, enabled, last_run_at, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)").run(s.id,s.name,s.schedule,s.prompt,s.session_key,s.enabled?1:0,s.last_run_at??null,Date.now()),this.getJob(s.id))}deleteJob(s){this.db.prepare("DELETE FROM jobs WHERE id = ?").run(s)}recordJobRun(s,e,t){let n=Date.now();this.db.prepare("INSERT INTO job_runs(job_id, started_at, status, result) VALUES(?, ?, ?, ?)").run(s,n,e,t),this.db.prepare("UPDATE jobs SET last_run_at = ? WHERE id = ?").run(n,s)}lastJobRuns(s=20){return this.db.prepare("SELECT job_id, started_at, status, result FROM job_runs ORDER BY id DESC LIMIT ?").all(s)}setSessionQueue(s,e,t){let n=this.ensureSession(s);this.db.prepare("UPDATE sessions SET queue_mode = ?, queue_opts = ? WHERE id = ?").run(e,t?JSON.stringify(t):null,n.id)}registerSubagent(s){this.db.prepare(`INSERT INTO subagents(child_session_key, parent_session_key, run_id, label, task, task_name, depth, status, delivery, spawned_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(s.child_session_key,s.parent_session_key,s.run_id,s.label,s.task,s.task_name,s.depth,s.status,s.delivery,s.spawned_at)}getSubagent(s){return this.db.prepare("SELECT * FROM subagents WHERE child_session_key = ?").get(s)}finishSubagent(s,e){this.db.prepare("UPDATE subagents SET status = ?, outcome = COALESCE(?, outcome), result_stats = COALESCE(?, result_stats), delivery = COALESCE(?, delivery), ended_at = ? WHERE child_session_key = ?").run(e.status,e.outcome??null,e.resultStats??null,e.delivery??null,Date.now(),s)}markSubagentDelivered(s){this.db.prepare("UPDATE subagents SET delivery = 'delivered' WHERE child_session_key = ?").run(s)}subagentsFor(s,e){let t=e?.limit??50;return e?.activeOnly?this.db.prepare("SELECT * FROM subagents WHERE parent_session_key = ? AND status = 'running' ORDER BY spawned_at ASC LIMIT ?").all(s,t):this.db.prepare("SELECT * FROM subagents WHERE parent_session_key = ? ORDER BY spawned_at DESC LIMIT ?").all(s,t).reverse()}pendingSubagentDeliveries(s){return this.db.prepare("SELECT * FROM subagents WHERE parent_session_key = ? AND status != 'running' AND delivery = 'pending' ORDER BY spawned_at ASC").all(s)}sweepInterruptedSubagents(){let s=this.db.prepare("UPDATE subagents SET status = 'interrupted', ended_at = ? WHERE status = 'running'").run(Date.now());return Number(s.changes)}};export{N as a};
