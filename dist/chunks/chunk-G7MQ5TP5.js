import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);
import{DatabaseSync as h}from"node:sqlite";import{mkdirSync as b}from"node:fs";import{dirname as A}from"node:path";function I(E){return E.replace(/[^\p{L}\p{N}_]/gu," ").split(/\s+/).map(e=>e.trim()).filter(e=>e.length>0).slice(0,6)}function f(E){let e=t=>`"${t.replace(/"/g,'""')}"`,s=E.map(e);return s.length>0&&(s[s.length-1]+="*"),s.join(" AND ")}function D(E,e){if(E&&E.length>0){let s=new Set(E);return t=>s.has(t)}return e==="visible"?s=>!s.startsWith("subagent:"):()=>!0}function c(E,e){let s=E.replace(/\s+/g," ").trim(),t=s.toLowerCase(),n=-1;for(let u of e){let d=t.indexOf(u.toLowerCase());d>=0&&(n<0||d<n)&&(n=d)}if(n<0)return s.slice(0,300)+(s.length>300?"\u2026":"");let i=Math.max(0,n-60),o=Math.min(s.length,n+220),a=s.slice(i,o),g="",l=a.toLowerCase(),_=[];for(let u of e){let d=u.toLowerCase(),r=0;for(;(r=l.indexOf(d,r))>=0;)_.push([r,r+d.length]),r+=d.length}_.sort((u,d)=>u[0]-d[0]);let T=0;for(let[u,d]of _)u<T||(g+=a.slice(T,u)+"\xAB"+a.slice(u,d)+"\xBB",T=d);return g+=a.slice(T),(i>0?"\u2026":"")+g+(o<s.length?"\u2026":"")}function y(E,e,s){if(s)return!0;let t=E.toLowerCase();return e.every(n=>t.includes(n.toLowerCase()))}var U=[["CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);",`CREATE TABLE IF NOT EXISTS sessions (
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
     );`],["CREATE VIRTUAL TABLE IF NOT EXISTS fts_messages USING fts5(content, session_id UNINDEXED, message_id UNINDEXED);"],[`CREATE TABLE IF NOT EXISTS dream_candidates (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       text TEXT NOT NULL,
       source TEXT NOT NULL,
       day TEXT NOT NULL,
       kind TEXT NOT NULL,
       importance INTEGER,
       staged_at INTEGER NOT NULL,
       staged_via TEXT NOT NULL DEFAULT 'sweep',
       promoted_at INTEGER
     );`,"CREATE INDEX IF NOT EXISTS dream_candidates_day_idx ON dream_candidates(day);",`CREATE TABLE IF NOT EXISTS dream_recalls (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       query TEXT NOT NULL,
       sources TEXT NOT NULL,
       created_at INTEGER NOT NULL
     );`,`CREATE TABLE IF NOT EXISTS dream_preimages (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       content TEXT NOT NULL,
       created_at INTEGER NOT NULL
     );`,`CREATE TABLE IF NOT EXISTS dream_runs (
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
     );`],[`CREATE TABLE IF NOT EXISTS auth_profiles (
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
     );`,`CREATE TABLE IF NOT EXISTS auth_profile_order (
       provider TEXT PRIMARY KEY,
       profile_ids TEXT NOT NULL DEFAULT '[]',
       updated_at INTEGER NOT NULL
     );`],[`CREATE TABLE IF NOT EXISTS session_summaries (
       session_id TEXT PRIMARY KEY,
       upto INTEGER NOT NULL DEFAULT 0,
       summary TEXT NOT NULL DEFAULT '',
       chars INTEGER NOT NULL DEFAULT 0,
       count INTEGER NOT NULL DEFAULT 0,
       updated INTEGER NOT NULL DEFAULT 0
     );`]],N=class E{db;fts;constructor(e,s){this.db=e,this.fts=s}static open(e){b(A(e),{recursive:!0});let s=new h(e);s.exec("PRAGMA journal_mode = WAL"),s.exec("PRAGMA synchronous = NORMAL"),s.exec("PRAGMA busy_timeout = 5000"),s.exec("PRAGMA foreign_keys = ON");let t=!0;for(let[a,g]of U.entries())try{for(let l of g)s.exec(l);s.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)").run(String(a+1))}catch(l){if(/fts5|no such module/i.test(l.message)){t=!1;continue}throw l}let n=new Set(s.prepare("PRAGMA table_info(sessions)").all().map(a=>a.name));n.has("thinking")||s.exec("ALTER TABLE sessions ADD COLUMN thinking TEXT"),n.has("queue_mode")||s.exec("ALTER TABLE sessions ADD COLUMN queue_mode TEXT"),n.has("queue_opts")||s.exec("ALTER TABLE sessions ADD COLUMN queue_opts TEXT"),new Set(s.prepare("PRAGMA table_info(runs)").all().map(a=>a.name)).has("model")||s.exec("ALTER TABLE runs ADD COLUMN model TEXT");let o=new Set(s.prepare("PRAGMA table_info(jobs)").all().map(a=>a.name));return o.has("tz")||s.exec("ALTER TABLE jobs ADD COLUMN tz TEXT"),o.has("delivery_mode")||s.exec("ALTER TABLE jobs ADD COLUMN delivery_mode TEXT"),o.has("delivery_to")||s.exec("ALTER TABLE jobs ADD COLUMN delivery_to TEXT"),o.has("delivery_suppress_empty")||s.exec("ALTER TABLE jobs ADD COLUMN delivery_suppress_empty INTEGER NOT NULL DEFAULT 1"),n.has("archived")||s.exec("ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0"),n.has("archived_at")||s.exec("ALTER TABLE sessions ADD COLUMN archived_at INTEGER"),n.has("archive_reason")||s.exec("ALTER TABLE sessions ADD COLUMN archive_reason TEXT"),new E(s,t)}close(){try{this.db.close()}catch{}}getMeta(e){return this.db.prepare("SELECT value FROM meta WHERE key = ?").get(e)?.value}setMeta(e,s){this.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)").run(e,s)}getSessionByKey(e){return this.db.prepare("SELECT * FROM sessions WHERE key = ?").get(e)}getSession(e){return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(e)}ensureSession(e,s="main"){let t=this.getSessionByKey(e);if(t)return t;let n=crypto.randomUUID(),i=Date.now();return this.db.prepare("INSERT INTO sessions(id, key, agent_id, created_at, last_msg_at) VALUES(?, ?, ?, ?, ?)").run(n,e,s,i,i),{id:n,key:e,agent_id:s,name:null,created_at:i,last_msg_at:i,meta:null}}listSessions(e=50,s){let t=s?.includeArchived?"":"WHERE COALESCE(archived, 0) = 0";return this.db.prepare(`SELECT * FROM sessions ${t} ORDER BY last_msg_at DESC LIMIT ?`).all(e)}listAllSessionsForMaintenance(){return this.db.prepare("SELECT * FROM sessions ORDER BY last_msg_at ASC").all()}countUnarchivedSessions(){return this.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE COALESCE(archived, 0) = 0").get().n}archiveSession(e,s,t){this.db.prepare("UPDATE sessions SET archived = 1, archived_at = ?, archive_reason = ? WHERE id = ?").run(t,s,e)}sessionContentBytes(e){return this.db.prepare("SELECT COALESCE(SUM(LENGTH(content)), 0) AS n FROM messages WHERE session_id = ?").get(e).n+512}renameSession(e,s){this.db.prepare("UPDATE sessions SET name = ? WHERE id = ?").run(s,e)}setSessionThinking(e,s){let t=this.ensureSession(e);this.db.prepare("UPDATE sessions SET thinking = ? WHERE id = ?").run(s,t.id)}renameSessionKey(e,s){if(!e||!s)return{ok:!1,error:"old and new session keys are required"};if(e===s)return{ok:!0};let t=this.getSessionByKey(e);return t?this.getSessionByKey(s)?{ok:!1,error:`a session named ${s} already exists`}:(this.db.prepare("UPDATE sessions SET key = ? WHERE id = ?").run(s,t.id),{ok:!0}):{ok:!1,error:`no such session: ${e}`}}appendMessage(e,s,t,n){let i=Date.now(),o=this.db.prepare("INSERT INTO messages(session_id, run_id, role, content, created_at) VALUES(?, ?, ?, ?, ?)").run(e,n??null,s,t,i),a=Number(o.lastInsertRowid);return this.db.prepare("UPDATE sessions SET last_msg_at = ? WHERE id = ?").run(i,e),this.fts&&this.db.prepare("INSERT INTO fts_messages(content, session_id, message_id) VALUES(?, ?, ?)").run(t.replace(/\s+/g," ").slice(0,4e3),e,a),a}recentMessages(e,s=60){return this.db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?").all(e,s).reverse()}messagesAfter(e,s,t=5e3){return this.db.prepare("SELECT * FROM messages WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?").all(e,s,t)}getSummary(e){return this.db.prepare("SELECT * FROM session_summaries WHERE session_id = ?").get(e)??null}setSummary(e,s,t,n){let i=this.getSummary(e),o=(i?.count??0)+(s>(i?.upto??0)?1:0);this.db.prepare(`INSERT INTO session_summaries(session_id, upto, summary, chars, count, updated)
         VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           upto = excluded.upto, summary = excluded.summary,
           chars = session_summaries.chars + CASE WHEN excluded.upto > session_summaries.upto THEN excluded.chars ELSE 0 END,
           count = excluded.count, updated = excluded.updated`).run(e,s,t,n,o,Date.now())}startRun(e,s){this.db.prepare("INSERT OR REPLACE INTO runs(id, session_id, status, started_at) VALUES(?, ?, ?, ?)").run(s,e,"running",Date.now())}finishRun(e,s,t,n,i){this.db.prepare("UPDATE runs SET status = ?, ended_at = ?, usage = ?, error = ?, model = ? WHERE id = ?").run(s,Date.now(),t?JSON.stringify(t):null,n??null,i??null,e)}listRunsWithUsage(e=1e4){return this.db.prepare("SELECT id, session_id, model, usage, started_at, ended_at, status FROM runs WHERE usage IS NOT NULL ORDER BY started_at DESC LIMIT ?").all(e)}logTool(e,s,t,n){this.db.prepare("INSERT INTO tool_log(run_id, tool, status, ms, at) VALUES(?, ?, ?, ?, ?)").run(e,s,t,n,Date.now())}searchMessages(e,s,t=10){let n=`%${s.replace(/[%_]/g,"")}%`;if(this.fts)try{return this.db.prepare(`SELECT m.* FROM fts_messages f JOIN messages m ON m.id = f.message_id
             WHERE fts_messages MATCH ? AND f.session_id = ? ORDER BY m.id DESC LIMIT ?`).all(s.replace(/[^\w\s]/g," ").trim(),e,t)}catch{}return this.db.prepare("SELECT * FROM messages WHERE session_id = ? AND content LIKE ? ORDER BY id DESC LIMIT ?").all(e,n,t)}searchMessagesAll(e,s=10){let t=`%${e.replace(/[%_]/g,"")}%`;if(this.fts)try{return this.db.prepare(`SELECT m.*, s.key AS session_key FROM fts_messages f
             JOIN messages m ON m.id = f.message_id
             JOIN sessions s ON s.id = m.session_id
             WHERE fts_messages MATCH ? ORDER BY m.id DESC LIMIT ?`).all(e.replace(/[^\w\s]/g," ").trim(),s)}catch{}return this.db.prepare(`SELECT m.*, s.key AS session_key FROM messages m
         JOIN sessions s ON s.id = m.session_id
         WHERE m.content LIKE ? ORDER BY m.id DESC LIMIT ?`).all(t,s)}searchSessions(e,s={}){let t=Math.max(1,Math.min(s.limit??25,25)),n=s.scope??"visible",i=I(e),o={titleHits:[],messageHits:[]};if(i.length===0)return o;let a=D(s.sessionKeys,n),g=this.listSessions(200).filter(r=>{if(!a(r.key))return!1;let m=`${(r.name??"").toLowerCase()} ${r.key.toLowerCase()}`;return i.every((L,S)=>{let p=L.toLowerCase();if(S===i.length-1){let R=(r.name??"").toLowerCase();return R&&R.split(/[\s\-_/:]+/).some(O=>O.startsWith(p))?!0:r.key.toLowerCase().includes(p)}return m.includes(p)})}),l=f(i),_=`%${i.map(r=>r.replace(/[%_]/g,"")).join(" ")}%`,T=[];if(this.fts)try{T=this.db.prepare(`SELECT m.*, s.key AS session_key, s.name AS session_name,
                    snippet(fts_messages, 0, '\xAB', '\xBB', '\u2026', 28) AS snippet
             FROM fts_messages f
             JOIN messages m ON m.id = f.message_id
             JOIN sessions s ON s.id = m.session_id
             WHERE fts_messages MATCH ? AND m.role IN ('user','assistant')
             ORDER BY rank, m.created_at DESC LIMIT ?`).all(l,t*4)}catch{T=[]}T.length===0&&(T=this.db.prepare(`SELECT m.*, s.key AS session_key, s.name AS session_name
           FROM messages m JOIN sessions s ON s.id = m.session_id
           WHERE m.content LIKE ? AND m.role IN ('user','assistant')
           ORDER BY m.id DESC LIMIT ?`).all(_,t*8).map(r=>({...r,snippet:c(r.content,i)})));let u=[],d=new Map;for(let r of T){if(!a(r.session_key)||y(r.content,i,this.fts)===!1)continue;let m=d.get(r.session_key)??0;if(!(m>=3)&&(d.set(r.session_key,m+1),u.push({sessionKey:r.session_key,title:r.session_name,messageId:r.id,role:r.role,createdAt:r.created_at,snippet:r.snippet??c(r.content,i)}),u.length>=t))break}return{titleHits:g.slice(0,t).map(r=>({sessionKey:r.key,title:r.name,lastMsgAt:r.last_msg_at})),messageHits:u}}messagesAround(e,s,t=30){if(!this.db.prepare("SELECT id FROM messages WHERE id = ? AND session_id = ?").get(s,e))return[];let i=Math.max(1,t),o=this.db.prepare("SELECT * FROM messages WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?").all(e,s,Math.ceil((i-1)/2)),a=this.db.prepare("SELECT * FROM messages WHERE session_id = ? AND id >= ? ORDER BY id ASC LIMIT ?").all(e,s,i-o.length);return[...o.reverse(),...a]}listJobs(){return this.db.prepare("SELECT * FROM jobs ORDER BY created_at DESC").all()}getJob(e){return this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(e)}upsertJob(e){let s=this.getJob(e.id);return s?(this.db.prepare("UPDATE jobs SET name = ?, schedule = ?, prompt = ?, session_key = ?, enabled = ?, last_run_at = ?, tz = ?, delivery_mode = ?, delivery_to = ?, delivery_suppress_empty = ? WHERE id = ?").run(e.name,e.schedule,e.prompt,e.session_key,e.enabled?1:0,e.last_run_at??s.last_run_at,e.tz??s.tz,e.delivery_mode??s.delivery_mode,e.delivery_to??s.delivery_to,e.delivery_suppress_empty??s.delivery_suppress_empty,e.id),this.getJob(e.id)):(this.db.prepare("INSERT INTO jobs(id, name, schedule, prompt, session_key, enabled, last_run_at, tz, delivery_mode, delivery_to, delivery_suppress_empty, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(e.id,e.name,e.schedule,e.prompt,e.session_key,e.enabled?1:0,e.last_run_at??null,e.tz??null,e.delivery_mode??null,e.delivery_to??null,e.delivery_suppress_empty??1,Date.now()),this.getJob(e.id))}deleteJob(e){this.db.prepare("DELETE FROM jobs WHERE id = ?").run(e)}recordJobRun(e,s,t){let n=Date.now();this.db.prepare("INSERT INTO job_runs(job_id, started_at, status, result) VALUES(?, ?, ?, ?)").run(e,n,s,t),this.db.prepare("UPDATE jobs SET last_run_at = ? WHERE id = ?").run(n,e)}lastJobRuns(e=20){return this.db.prepare("SELECT job_id, started_at, status, result FROM job_runs ORDER BY id DESC LIMIT ?").all(e)}deleteSession(e){let s=this.getSessionByKey(e);if(!s)return{deleted:!1,messages:0};let t=this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?").get(s.id).n;return this.fts&&this.db.prepare("DELETE FROM fts_messages WHERE session_id = ?").run(s.id),this.db.prepare("DELETE FROM tool_log WHERE run_id IN (SELECT id FROM runs WHERE session_id = ?)").run(s.id),this.db.prepare("DELETE FROM runs WHERE session_id = ?").run(s.id),this.db.prepare("DELETE FROM messages WHERE session_id = ?").run(s.id),this.db.prepare("DELETE FROM session_summaries WHERE session_id = ?").run(s.id),this.db.prepare("DELETE FROM subagents WHERE child_session_key = ? OR parent_session_key = ?").run(s.key,s.key),this.db.prepare("DELETE FROM sessions WHERE id = ?").run(s.id),{deleted:!0,messages:t}}setSessionQueue(e,s,t){let n=this.ensureSession(e);this.db.prepare("UPDATE sessions SET queue_mode = ?, queue_opts = ? WHERE id = ?").run(s,t?JSON.stringify(t):null,n.id)}registerSubagent(e){this.db.prepare(`INSERT INTO subagents(child_session_key, parent_session_key, run_id, label, task, task_name, depth, status, delivery, spawned_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(e.child_session_key,e.parent_session_key,e.run_id,e.label,e.task,e.task_name,e.depth,e.status,e.delivery,e.spawned_at)}getSubagent(e){return this.db.prepare("SELECT * FROM subagents WHERE child_session_key = ?").get(e)}finishSubagent(e,s){this.db.prepare("UPDATE subagents SET status = ?, outcome = COALESCE(?, outcome), result_stats = COALESCE(?, result_stats), delivery = COALESCE(?, delivery), ended_at = ? WHERE child_session_key = ?").run(s.status,s.outcome??null,s.resultStats??null,s.delivery??null,Date.now(),e)}markSubagentDelivered(e){this.db.prepare("UPDATE subagents SET delivery = 'delivered' WHERE child_session_key = ?").run(e)}subagentsFor(e,s){let t=s?.limit??50;return s?.activeOnly?this.db.prepare("SELECT * FROM subagents WHERE parent_session_key = ? AND status = 'running' ORDER BY spawned_at ASC LIMIT ?").all(e,t):this.db.prepare("SELECT * FROM subagents WHERE parent_session_key = ? ORDER BY spawned_at DESC LIMIT ?").all(e,t).reverse()}pendingSubagentDeliveries(e){return this.db.prepare("SELECT * FROM subagents WHERE parent_session_key = ? AND status != 'running' AND delivery = 'pending' ORDER BY spawned_at ASC").all(e)}sweepInterruptedSubagents(){let e=this.db.prepare("UPDATE subagents SET status = 'interrupted', ended_at = ? WHERE status = 'running'").run(Date.now());return Number(e.changes)}dreamTranscriptLines(e,s=150){return this.db.prepare(`SELECT m.*, s.key AS session_key FROM messages m
         JOIN sessions s ON s.id = m.session_id
         WHERE m.created_at >= ? AND m.role IN ('user','assistant')
           AND s.key NOT LIKE 'subagent:%' AND s.key NOT LIKE 'system:%' AND s.key NOT LIKE 'cron:%'
         ORDER BY m.created_at DESC LIMIT ?`).all(e,s)}upsertAuthProfile(e){this.db.prepare(`INSERT INTO auth_profiles(id, provider, type, material, expires, label, created_at, last_used_at, last_ok_at, fail_count, cooldown_until)
         VALUES(?,?,?,?,?,?,?,?,0,0,0)
         ON CONFLICT(id) DO UPDATE SET type=excluded.type, material=excluded.material,
           expires=excluded.expires, label=excluded.label, fail_count=0, cooldown_until=0`).run(e.id,e.provider,e.type,e.material,e.expires??0,e.label??"",Date.now(),Date.now())}authProfile(e){return this.db.prepare("SELECT * FROM auth_profiles WHERE id=?").get(e)}authProfiles(e){return e?this.db.prepare("SELECT * FROM auth_profiles WHERE provider=? ORDER BY id").all(e):this.db.prepare("SELECT * FROM auth_profiles ORDER BY provider, id").all()}removeAuthProfile(e){this.db.prepare("DELETE FROM auth_profiles WHERE id=?").run(e);for(let s of this.db.prepare("SELECT provider, profile_ids FROM auth_profile_order").all()){let t=JSON.parse(s.profile_ids);t.includes(e)&&this.setAuthOrder(s.provider,t.filter(n=>n!==e))}return this.db.prepare("SELECT changes() AS c").get().c>0}markAuthUsed(e,s){if(s)this.db.prepare("UPDATE auth_profiles SET last_used_at=?, last_ok_at=?, fail_count=0, cooldown_until=0 WHERE id=?").run(Date.now(),Date.now(),e);else{let t=this.authProfile(e);if(!t)return;let n=t.fail_count+1,i=Date.now()+Math.min(5*6e4*2**(n-1),60*6e4);this.db.prepare("UPDATE auth_profiles SET last_used_at=?, fail_count=?, cooldown_until=? WHERE id=?").run(Date.now(),n,i,e)}}authOrder(e){let s=this.db.prepare("SELECT profile_ids FROM auth_profile_order WHERE provider=?").get(e);return s?JSON.parse(s.profile_ids):[]}setAuthOrder(e,s){s.length===0?this.db.prepare("DELETE FROM auth_profile_order WHERE provider=?").run(e):this.db.prepare("INSERT INTO auth_profile_order(provider, profile_ids, updated_at) VALUES(?,?,?) ON CONFLICT(provider) DO UPDATE SET profile_ids=excluded.profile_ids, updated_at=excluded.updated_at").run(e,JSON.stringify(s),Date.now())}stageDreamCandidate(e){return this.db.prepare("SELECT 1 FROM dream_candidates WHERE text = ? AND source = ? AND promoted_at IS NULL LIMIT 1").get(e.text,e.source)?!1:(this.db.prepare("INSERT INTO dream_candidates (text, source, day, kind, importance, staged_at, staged_via) VALUES (?, ?, ?, ?, ?, ?, ?)").run(e.text,e.source,e.day,e.kind,e.importance,Date.now(),e.stagedVia),!0)}dreamCandidates(e={}){let s=["1=1"],t=[];return e.minDay&&(s.push("day >= ?"),t.push(e.minDay)),e.stagedSinceMs&&(s.push("staged_at >= ?"),t.push(e.stagedSinceMs)),e.includePromoted||s.push("promoted_at IS NULL"),e.via&&(s.push("staged_via = ?"),t.push(e.via)),this.db.prepare(`SELECT * FROM dream_candidates WHERE ${s.join(" AND ")} ORDER BY day DESC, id ASC`).all(...t)}markDreamCandidatesPromoted(e){let s=Date.now(),t=this.db.prepare("UPDATE dream_candidates SET promoted_at = ? WHERE id = ?");for(let n of e)t.run(s,n)}rollbackDreamBackfill(){let e=this.db.prepare("DELETE FROM dream_candidates WHERE staged_via = 'backfill'").run();return Number(e.changes)}recordMemoryRecall(e,s){!e.trim()||s.length===0||this.db.prepare("INSERT INTO dream_recalls (query, sources, created_at) VALUES (?, ?, ?)").run(e,JSON.stringify(s.slice(0,12)),Date.now())}dreamRecalls(e){return this.db.prepare("SELECT query, sources, created_at FROM dream_recalls WHERE created_at >= ? ORDER BY id ASC").all(e)}saveDreamPreimage(e){this.db.prepare("INSERT INTO dream_preimages (content, created_at) VALUES (?, ?)").run(e,Date.now())}latestDreamPreimage(){return this.db.prepare("SELECT content, created_at FROM dream_preimages ORDER BY id DESC LIMIT 1").get()}recordDreamRun(e){this.db.prepare("INSERT INTO dream_runs (day, light_staged, themes, promoted, merged, superseded, rejected, verdict, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(e.day,e.light_staged,e.themes,e.promoted,e.merged,e.superseded,e.rejected,e.verdict,Date.now())}lastDreamRun(){return this.db.prepare("SELECT * FROM dream_runs ORDER BY id DESC LIMIT 1").get()}};export{N as a};
