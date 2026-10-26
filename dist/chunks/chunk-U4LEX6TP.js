import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);
import{a as m}from"./chunk-YLPL3IHV.js";import{DatabaseSync as O}from"node:sqlite";import{mkdirSync as A}from"node:fs";import{dirname as I}from"node:path";function f(u){return u.replace(/[^\p{L}\p{N}_]/gu," ").split(/\s+/).map(e=>e.trim()).filter(e=>e.length>0).slice(0,6)}m(f,"tokenizeQuery");function D(u){let e=m(t=>`"${t.replace(/"/g,'""')}"`,"esc"),s=u.map(e);return s.length>0&&(s[s.length-1]+="*"),s.join(" AND ")}m(D,"buildMatch");function y(u,e){if(u&&u.length>0){let s=new Set(u);return t=>s.has(t)}return e==="visible"?s=>!s.startsWith("subagent:"):()=>!0}m(y,"keysPredicate");function N(u,e){let s=u.replace(/\s+/g," ").trim(),t=s.toLowerCase(),n=-1;for(let l of e){let E=t.indexOf(l.toLowerCase());E>=0&&(n<0||E<n)&&(n=E)}if(n<0)return s.slice(0,300)+(s.length>300?"\u2026":"");let r=Math.max(0,n-60),d=Math.min(s.length,n+220),o=s.slice(r,d),a="",_=o.toLowerCase(),T=[];for(let l of e){let E=l.toLowerCase(),i=0;for(;(i=_.indexOf(E,i))>=0;)T.push([i,i+E.length]),i+=E.length}T.sort((l,E)=>l[0]-E[0]);let g=0;for(let[l,E]of T)l<g||(a+=o.slice(g,l)+"\xAB"+o.slice(l,E)+"\xBB",g=E);return a+=o.slice(g),(r>0?"\u2026":"")+a+(d<s.length?"\u2026":"")}m(N,"makeSnippet");function M(u,e,s){if(s)return!0;let t=u.toLowerCase();return e.every(n=>t.includes(n.toLowerCase()))}m(M,"hitsMayContainAllTokens");var w=[["CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);",`CREATE TABLE IF NOT EXISTS sessions (
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
     );`,`CREATE TABLE IF NOT EXISTS dream_ingest (
       hash TEXT PRIMARY KEY,
       day TEXT NOT NULL,
       source TEXT NOT NULL,
       staged_at INTEGER NOT NULL
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
     );`]],L=class u{static{m(this,"Store")}db;fts;constructor(e,s){this.db=e,this.fts=s}static open(e){A(I(e),{recursive:!0});let s=new O(e);s.exec("PRAGMA journal_mode = WAL"),s.exec("PRAGMA synchronous = NORMAL"),s.exec("PRAGMA busy_timeout = 5000"),s.exec("PRAGMA foreign_keys = ON");let t=!0;for(let[a,_]of w.entries())try{for(let T of _)s.exec(T);s.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)").run(String(a+1))}catch(T){if(/fts5|no such module/i.test(T.message)){t=!1;continue}throw T}let n=new Set(s.prepare("PRAGMA table_info(sessions)").all().map(a=>a.name));n.has("thinking")||s.exec("ALTER TABLE sessions ADD COLUMN thinking TEXT"),n.has("queue_mode")||s.exec("ALTER TABLE sessions ADD COLUMN queue_mode TEXT"),n.has("queue_opts")||s.exec("ALTER TABLE sessions ADD COLUMN queue_opts TEXT"),new Set(s.prepare("PRAGMA table_info(runs)").all().map(a=>a.name)).has("model")||s.exec("ALTER TABLE runs ADD COLUMN model TEXT"),new Set(s.prepare("PRAGMA table_info(messages)").all().map(a=>a.name)).has("usage")||s.exec("ALTER TABLE messages ADD COLUMN usage TEXT");let o=new Set(s.prepare("PRAGMA table_info(jobs)").all().map(a=>a.name));return o.has("tz")||s.exec("ALTER TABLE jobs ADD COLUMN tz TEXT"),o.has("delivery_mode")||s.exec("ALTER TABLE jobs ADD COLUMN delivery_mode TEXT"),o.has("delivery_to")||s.exec("ALTER TABLE jobs ADD COLUMN delivery_to TEXT"),o.has("delivery_suppress_empty")||s.exec("ALTER TABLE jobs ADD COLUMN delivery_suppress_empty INTEGER NOT NULL DEFAULT 1"),n.has("archived")||s.exec("ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0"),n.has("archived_at")||s.exec("ALTER TABLE sessions ADD COLUMN archived_at INTEGER"),n.has("archive_reason")||s.exec("ALTER TABLE sessions ADD COLUMN archive_reason TEXT"),new u(s,t)}close(){try{this.db.close()}catch{}}getMeta(e){return this.db.prepare("SELECT value FROM meta WHERE key = ?").get(e)?.value}setMeta(e,s){this.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)").run(e,s)}getSessionByKey(e){return this.db.prepare("SELECT * FROM sessions WHERE key = ?").get(e)}getSession(e){return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(e)}ensureSession(e,s="main"){let t=this.getSessionByKey(e);if(t)return t;let n=crypto.randomUUID(),r=Date.now();return this.db.prepare("INSERT INTO sessions(id, key, agent_id, created_at, last_msg_at) VALUES(?, ?, ?, ?, ?)").run(n,e,s,r,r),{id:n,key:e,agent_id:s,name:null,created_at:r,last_msg_at:r,meta:null}}listSessions(e=50,s){let t=s?.includeArchived?"":"WHERE COALESCE(archived, 0) = 0";return this.db.prepare(`SELECT * FROM sessions ${t} ORDER BY last_msg_at DESC LIMIT ?`).all(e)}listAllSessionsForMaintenance(){return this.db.prepare("SELECT * FROM sessions ORDER BY last_msg_at ASC").all()}countUnarchivedSessions(){return this.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE COALESCE(archived, 0) = 0").get().n}archiveSession(e,s,t){this.db.prepare("UPDATE sessions SET archived = 1, archived_at = ?, archive_reason = ? WHERE id = ?").run(t,s,e)}sessionContentBytes(e){return this.db.prepare("SELECT COALESCE(SUM(LENGTH(content)), 0) AS n FROM messages WHERE session_id = ?").get(e).n+512}renameSession(e,s){this.db.prepare("UPDATE sessions SET name = ? WHERE id = ?").run(s,e)}setSessionThinking(e,s){let t=this.ensureSession(e);this.db.prepare("UPDATE sessions SET thinking = ? WHERE id = ?").run(s,t.id)}renameSessionKey(e,s){if(!e||!s)return{ok:!1,error:"old and new session keys are required"};if(e===s)return{ok:!0};let t=this.getSessionByKey(e);return t?this.getSessionByKey(s)?{ok:!1,error:`a session named ${s} already exists`}:(this.db.prepare("UPDATE sessions SET key = ? WHERE id = ?").run(s,t.id),{ok:!0}):{ok:!1,error:`no such session: ${e}`}}appendMessage(e,s,t,n,r){let d=Date.now(),o=this.db.prepare("INSERT INTO messages(session_id, run_id, role, content, created_at, usage) VALUES(?, ?, ?, ?, ?, ?)").run(e,n??null,s,t,d,r??null),a=Number(o.lastInsertRowid);return this.db.prepare("UPDATE sessions SET last_msg_at = ? WHERE id = ?").run(d,e),this.fts&&this.db.prepare("INSERT INTO fts_messages(content, session_id, message_id) VALUES(?, ?, ?)").run(t.replace(/\s+/g," ").slice(0,4e3),e,a),a}recentMessages(e,s=60){return this.db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?").all(e,s).reverse()}messageContents(e){return this.db.prepare("SELECT content FROM messages WHERE session_id = ?").all(e).map(s=>String(s.content??""))}anyMessageMentions(e){if(!e)return!1;let s=e.replace(/[\\%_]/g,n=>`\\${n}`);return!!this.db.prepare("SELECT 1 AS hit FROM messages WHERE content LIKE ? ESCAPE '\\' LIMIT 1").get(`%${s}%`)}lastUserMessage(e){return this.db.prepare("SELECT * FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1").get(e)}messageById(e,s){return this.db.prepare("SELECT * FROM messages WHERE session_id = ? AND id = ?").get(e,s)}deleteMessagesAfter(e,s){return this.#e(e,">",s)}deleteMessagesFrom(e,s){return this.#e(e,">=",s)}#e(e,s,t){let n=`session_id = ? AND id ${s} ?`,r=this.db.prepare(`SELECT id FROM messages WHERE ${n}`).all(e,t);if(r.length===0)return 0;if(this.db.prepare(`DELETE FROM messages WHERE ${n}`).run(e,t),this.fts){let o=this.db.prepare("DELETE FROM fts_messages WHERE message_id = ?");for(let a of r)o.run(a.id)}let d=this.db.prepare("SELECT created_at FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 1").get(e);return d&&this.db.prepare("UPDATE sessions SET last_msg_at = ? WHERE id = ?").run(d.created_at,e),r.length}forkSession(e,s){let t=crypto.randomUUID(),n=Date.now();this.db.prepare("INSERT INTO sessions(id, key, agent_id, name, created_at, last_msg_at) VALUES(?, ?, ?, ?, ?, ?)").run(t,s.key,e.agent_id,s.name??null,n,n);let r=this.db.prepare("SELECT * FROM messages WHERE session_id = ? AND id < ? ORDER BY id ASC").all(e.id,s.beforeId),d=this.db.prepare("INSERT INTO messages(session_id, run_id, role, content, created_at, usage) VALUES(?, ?, ?, ?, ?, ?)"),o=n;for(let a of r){let _=d.run(t,a.run_id,a.role,a.content,a.created_at,a.usage??null);o=a.created_at,this.fts&&this.db.prepare("INSERT INTO fts_messages(content, session_id, message_id) VALUES(?, ?, ?)").run(a.content.replace(/\s+/g," ").slice(0,4e3),t,Number(_.lastInsertRowid))}return r.length>0&&this.db.prepare("UPDATE sessions SET last_msg_at = ? WHERE id = ?").run(o,t),{session:this.getSession(t),copied:r.length}}messagesAfter(e,s,t=5e3){return this.db.prepare("SELECT * FROM messages WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?").all(e,s,t)}getSummary(e){return this.db.prepare("SELECT * FROM session_summaries WHERE session_id = ?").get(e)??null}setSummary(e,s,t,n){let r=this.getSummary(e),d=(r?.count??0)+(s>(r?.upto??0)?1:0);this.db.prepare(`INSERT INTO session_summaries(session_id, upto, summary, chars, count, updated)
         VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           upto = excluded.upto, summary = excluded.summary,
           chars = session_summaries.chars + CASE WHEN excluded.upto > session_summaries.upto THEN excluded.chars ELSE 0 END,
           count = excluded.count, updated = excluded.updated`).run(e,s,t,n,d,Date.now())}startRun(e,s){this.db.prepare("INSERT OR REPLACE INTO runs(id, session_id, status, started_at) VALUES(?, ?, ?, ?)").run(s,e,"running",Date.now())}finishRun(e,s,t,n,r){this.db.prepare("UPDATE runs SET status = ?, ended_at = ?, usage = ?, error = ?, model = ? WHERE id = ?").run(s,Date.now(),t?JSON.stringify(t):null,n??null,r??null,e)}runsForSession(e){return this.db.prepare("SELECT id, status, model, started_at, ended_at FROM runs WHERE session_id = ? ORDER BY started_at ASC").all(e)}listRunsWithUsage(e=1e4){return this.db.prepare("SELECT id, session_id, model, usage, started_at, ended_at, status FROM runs WHERE usage IS NOT NULL ORDER BY started_at DESC LIMIT ?").all(e)}logTool(e,s,t,n){this.db.prepare("INSERT INTO tool_log(run_id, tool, status, ms, at) VALUES(?, ?, ?, ?, ?)").run(e,s,t,n,Date.now())}searchMessages(e,s,t=10){let n=`%${s.replace(/[%_]/g,"")}%`;if(this.fts)try{return this.db.prepare(`SELECT m.* FROM fts_messages f JOIN messages m ON m.id = f.message_id
             WHERE fts_messages MATCH ? AND f.session_id = ? ORDER BY m.id DESC LIMIT ?`).all(s.replace(/[^\w\s]/g," ").trim(),e,t)}catch{}return this.db.prepare("SELECT * FROM messages WHERE session_id = ? AND content LIKE ? ORDER BY id DESC LIMIT ?").all(e,n,t)}searchMessagesAll(e,s=10){let t=`%${e.replace(/[%_]/g,"")}%`;if(this.fts)try{return this.db.prepare(`SELECT m.*, s.key AS session_key FROM fts_messages f
             JOIN messages m ON m.id = f.message_id
             JOIN sessions s ON s.id = m.session_id
             WHERE fts_messages MATCH ? ORDER BY m.id DESC LIMIT ?`).all(e.replace(/[^\w\s]/g," ").trim(),s)}catch{}return this.db.prepare(`SELECT m.*, s.key AS session_key FROM messages m
         JOIN sessions s ON s.id = m.session_id
         WHERE m.content LIKE ? ORDER BY m.id DESC LIMIT ?`).all(t,s)}searchSessions(e,s={}){let t=Math.max(1,Math.min(s.limit??25,25)),n=s.scope??"visible",r=f(e),d={titleHits:[],messageHits:[]};if(r.length===0)return d;let o=y(s.sessionKeys,n),a=this.listSessions(200).filter(i=>{if(!o(i.key))return!1;let p=`${(i.name??"").toLowerCase()} ${i.key.toLowerCase()}`;return r.every((h,b)=>{let R=h.toLowerCase();if(b===r.length-1){let c=(i.name??"").toLowerCase();return c&&c.split(/[\s\-_/:]+/).some(S=>S.startsWith(R))?!0:i.key.toLowerCase().includes(R)}return p.includes(R)})}),_=D(r),T=`%${r.map(i=>i.replace(/[%_]/g,"")).join(" ")}%`,g=[];if(this.fts)try{g=this.db.prepare(`SELECT m.*, s.key AS session_key, s.name AS session_name,
                    snippet(fts_messages, 0, '\xAB', '\xBB', '\u2026', 28) AS snippet
             FROM fts_messages f
             JOIN messages m ON m.id = f.message_id
             JOIN sessions s ON s.id = m.session_id
             WHERE fts_messages MATCH ? AND m.role IN ('user','assistant')
             ORDER BY rank, m.created_at DESC LIMIT ?`).all(_,t*4)}catch{g=[]}g.length===0&&(g=this.db.prepare(`SELECT m.*, s.key AS session_key, s.name AS session_name
           FROM messages m JOIN sessions s ON s.id = m.session_id
           WHERE m.content LIKE ? AND m.role IN ('user','assistant')
           ORDER BY m.id DESC LIMIT ?`).all(T,t*8).map(i=>({...i,snippet:N(i.content,r)})));let l=[],E=new Map;for(let i of g){if(!o(i.session_key)||M(i.content,r,this.fts)===!1)continue;let p=E.get(i.session_key)??0;if(!(p>=3)&&(E.set(i.session_key,p+1),l.push({sessionKey:i.session_key,title:i.session_name,messageId:i.id,role:i.role,createdAt:i.created_at,snippet:i.snippet??N(i.content,r)}),l.length>=t))break}return{titleHits:a.slice(0,t).map(i=>({sessionKey:i.key,title:i.name,lastMsgAt:i.last_msg_at})),messageHits:l}}messagesAround(e,s,t=30){if(!this.db.prepare("SELECT id FROM messages WHERE id = ? AND session_id = ?").get(s,e))return[];let r=Math.max(1,t),d=this.db.prepare("SELECT * FROM messages WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?").all(e,s,Math.ceil((r-1)/2)),o=this.db.prepare("SELECT * FROM messages WHERE session_id = ? AND id >= ? ORDER BY id ASC LIMIT ?").all(e,s,r-d.length);return[...d.reverse(),...o]}listJobs(){return this.db.prepare("SELECT * FROM jobs ORDER BY created_at DESC").all()}getJob(e){return this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(e)}upsertJob(e){let s=this.getJob(e.id);return s?(this.db.prepare("UPDATE jobs SET name = ?, schedule = ?, prompt = ?, session_key = ?, enabled = ?, last_run_at = ?, tz = ?, delivery_mode = ?, delivery_to = ?, delivery_suppress_empty = ? WHERE id = ?").run(e.name,e.schedule,e.prompt,e.session_key,e.enabled?1:0,e.last_run_at??s.last_run_at,e.tz??s.tz,e.delivery_mode??s.delivery_mode,e.delivery_to??s.delivery_to,e.delivery_suppress_empty??s.delivery_suppress_empty,e.id),this.getJob(e.id)):(this.db.prepare("INSERT INTO jobs(id, name, schedule, prompt, session_key, enabled, last_run_at, tz, delivery_mode, delivery_to, delivery_suppress_empty, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(e.id,e.name,e.schedule,e.prompt,e.session_key,e.enabled?1:0,e.last_run_at??null,e.tz??null,e.delivery_mode??null,e.delivery_to??null,e.delivery_suppress_empty??1,Date.now()),this.getJob(e.id))}deleteJob(e){this.db.prepare("DELETE FROM jobs WHERE id = ?").run(e)}recordJobRun(e,s,t){let n=Date.now();this.db.prepare("INSERT INTO job_runs(job_id, started_at, status, result) VALUES(?, ?, ?, ?)").run(e,n,s,t),this.db.prepare("UPDATE jobs SET last_run_at = ? WHERE id = ?").run(n,e)}lastJobRuns(e=20){return this.db.prepare("SELECT job_id, started_at, status, result FROM job_runs ORDER BY id DESC LIMIT ?").all(e)}setSessionArchived(e,s){return{ok:this.db.prepare("UPDATE sessions SET archived = ?, archived_at = ?, archive_reason = CASE WHEN ? = 0 THEN NULL ELSE archive_reason END WHERE key = ?").run(s?1:0,s?Date.now():null,s?1:0,e).changes>0}}deleteSession(e){let s=this.getSessionByKey(e);if(!s)return{deleted:!1,messages:0};let t=this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?").get(s.id).n;return this.fts&&this.db.prepare("DELETE FROM fts_messages WHERE session_id = ?").run(s.id),this.db.prepare("DELETE FROM tool_log WHERE run_id IN (SELECT id FROM runs WHERE session_id = ?)").run(s.id),this.db.prepare("DELETE FROM runs WHERE session_id = ?").run(s.id),this.db.prepare("DELETE FROM messages WHERE session_id = ?").run(s.id),this.db.prepare("DELETE FROM session_summaries WHERE session_id = ?").run(s.id),this.db.prepare("DELETE FROM subagents WHERE child_session_key = ? OR parent_session_key = ?").run(s.key,s.key),this.db.prepare("DELETE FROM sessions WHERE id = ?").run(s.id),{deleted:!0,messages:t}}setSessionQueue(e,s,t){let n=this.ensureSession(e);this.db.prepare("UPDATE sessions SET queue_mode = ?, queue_opts = ? WHERE id = ?").run(s,t?JSON.stringify(t):null,n.id)}registerSubagent(e){this.db.prepare(`INSERT INTO subagents(child_session_key, parent_session_key, run_id, label, task, task_name, depth, status, delivery, spawned_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(e.child_session_key,e.parent_session_key,e.run_id,e.label,e.task,e.task_name,e.depth,e.status,e.delivery,e.spawned_at)}getSubagent(e){return this.db.prepare("SELECT * FROM subagents WHERE child_session_key = ?").get(e)}finishSubagent(e,s){this.db.prepare("UPDATE subagents SET status = ?, outcome = COALESCE(?, outcome), result_stats = COALESCE(?, result_stats), delivery = COALESCE(?, delivery), ended_at = ? WHERE child_session_key = ?").run(s.status,s.outcome??null,s.resultStats??null,s.delivery??null,Date.now(),e)}markSubagentDelivered(e){this.db.prepare("UPDATE subagents SET delivery = 'delivered' WHERE child_session_key = ?").run(e)}subagentsFor(e,s){let t=s?.limit??50;return s?.activeOnly?this.db.prepare("SELECT * FROM subagents WHERE parent_session_key = ? AND status = 'running' ORDER BY spawned_at ASC LIMIT ?").all(e,t):this.db.prepare("SELECT * FROM subagents WHERE parent_session_key = ? ORDER BY spawned_at DESC LIMIT ?").all(e,t).reverse()}pendingSubagentDeliveries(e){return this.db.prepare("SELECT * FROM subagents WHERE parent_session_key = ? AND status != 'running' AND delivery = 'pending' ORDER BY spawned_at ASC").all(e)}sweepInterruptedSubagents(){let e=this.db.prepare("UPDATE subagents SET status = 'interrupted', ended_at = ? WHERE status = 'running'").run(Date.now());return Number(e.changes)}dreamTranscriptLines(e,s=150){return this.db.prepare(`SELECT m.*, s.key AS session_key FROM messages m
         JOIN sessions s ON s.id = m.session_id
         WHERE m.created_at >= ? AND m.role IN ('user','assistant')
           AND s.key NOT LIKE 'subagent:%' AND s.key NOT LIKE 'system:%' AND s.key NOT LIKE 'cron:%'
         ORDER BY m.created_at DESC LIMIT ?`).all(e,s)}upsertAuthProfile(e){this.db.prepare(`INSERT INTO auth_profiles(id, provider, type, material, expires, label, created_at, last_used_at, last_ok_at, fail_count, cooldown_until)
         VALUES(?,?,?,?,?,?,?,?,0,0,0)
         ON CONFLICT(id) DO UPDATE SET type=excluded.type, material=excluded.material,
           expires=excluded.expires, label=excluded.label, fail_count=0, cooldown_until=0`).run(e.id,e.provider,e.type,e.material,e.expires??0,e.label??"",Date.now(),Date.now())}authProfile(e){return this.db.prepare("SELECT * FROM auth_profiles WHERE id=?").get(e)}authProfiles(e){return e?this.db.prepare("SELECT * FROM auth_profiles WHERE provider=? ORDER BY id").all(e):this.db.prepare("SELECT * FROM auth_profiles ORDER BY provider, id").all()}removeAuthProfile(e){this.db.prepare("DELETE FROM auth_profiles WHERE id=?").run(e);for(let s of this.db.prepare("SELECT provider, profile_ids FROM auth_profile_order").all()){let t=JSON.parse(s.profile_ids);t.includes(e)&&this.setAuthOrder(s.provider,t.filter(n=>n!==e))}return this.db.prepare("SELECT changes() AS c").get().c>0}markAuthUsed(e,s){if(s)this.db.prepare("UPDATE auth_profiles SET last_used_at=?, last_ok_at=?, fail_count=0, cooldown_until=0 WHERE id=?").run(Date.now(),Date.now(),e);else{let t=this.authProfile(e);if(!t)return;let n=t.fail_count+1,r=Date.now()+Math.min(5*6e4*2**(n-1),60*6e4);this.db.prepare("UPDATE auth_profiles SET last_used_at=?, fail_count=?, cooldown_until=? WHERE id=?").run(Date.now(),n,r,e)}}authOrder(e){let s=this.db.prepare("SELECT profile_ids FROM auth_profile_order WHERE provider=?").get(e);return s?JSON.parse(s.profile_ids):[]}setAuthOrder(e,s){s.length===0?this.db.prepare("DELETE FROM auth_profile_order WHERE provider=?").run(e):this.db.prepare("INSERT INTO auth_profile_order(provider, profile_ids, updated_at) VALUES(?,?,?) ON CONFLICT(provider) DO UPDATE SET profile_ids=excluded.profile_ids, updated_at=excluded.updated_at").run(e,JSON.stringify(s),Date.now())}stageDreamCandidate(e){return this.db.prepare("SELECT 1 FROM dream_candidates WHERE text = ? AND source = ? AND promoted_at IS NULL LIMIT 1").get(e.text,e.source)?!1:(this.db.prepare("INSERT INTO dream_candidates (text, source, day, kind, importance, staged_at, staged_via) VALUES (?, ?, ?, ?, ?, ?, ?)").run(e.text,e.source,e.day,e.kind,e.importance,Date.now(),e.stagedVia),!0)}dreamCandidates(e={}){let s=["1=1"],t=[];return e.minDay&&(s.push("day >= ?"),t.push(e.minDay)),e.stagedSinceMs&&(s.push("staged_at >= ?"),t.push(e.stagedSinceMs)),e.includePromoted||s.push("promoted_at IS NULL"),e.via&&(s.push("staged_via = ?"),t.push(e.via)),this.db.prepare(`SELECT * FROM dream_candidates WHERE ${s.join(" AND ")} ORDER BY day DESC, id ASC`).all(...t)}markDreamCandidatesPromoted(e){let s=Date.now(),t=this.db.prepare("UPDATE dream_candidates SET promoted_at = ? WHERE id = ?");for(let n of e)t.run(s,n)}rollbackDreamBackfill(){return this.rollbackDreamBackfillFull().candidates}rollbackDreamBackfillFull(){let e=this.db.prepare("DELETE FROM dream_candidates WHERE staged_via = 'backfill'").run(),s=0;try{s=Number(this.db.prepare("DELETE FROM dream_ingest").run().changes)}catch{}return{candidates:Number(e.changes),hashes:s}}transcriptLinesBetween(e,s,t=1e5){return this.db.prepare(`SELECT m.*, s.key AS session_key FROM messages m
         JOIN sessions s ON s.id = m.session_id
         WHERE m.created_at >= ? AND m.created_at < ? AND m.role IN ('user','assistant')
           AND s.key NOT LIKE 'subagent:%' AND s.key NOT LIKE 'system:%' AND s.key NOT LIKE 'cron:%'
         ORDER BY m.created_at ASC LIMIT ?`).all(e,s,t)}hasIngestHash(e){try{return!!this.db.prepare("SELECT 1 FROM dream_ingest WHERE hash = ? LIMIT 1").get(e)}catch{return!1}}addIngestHash(e,s,t){this.db.prepare("INSERT OR IGNORE INTO dream_ingest(hash, day, source, staged_at) VALUES(?, ?, ?, ?)").run(e,s,t,Date.now())}dreamCandidateExists(e,s){return!!this.db.prepare("SELECT 1 FROM dream_candidates WHERE text = ? AND source = ? AND promoted_at IS NULL LIMIT 1").get(e,s)}recordMemoryRecall(e,s){!e.trim()||s.length===0||this.db.prepare("INSERT INTO dream_recalls (query, sources, created_at) VALUES (?, ?, ?)").run(e,JSON.stringify(s.slice(0,12)),Date.now())}dreamRecalls(e){return this.db.prepare("SELECT query, sources, created_at FROM dream_recalls WHERE created_at >= ? ORDER BY id ASC").all(e)}saveDreamPreimage(e){this.db.prepare("INSERT INTO dream_preimages (content, created_at) VALUES (?, ?)").run(e,Date.now())}latestDreamPreimage(){return this.db.prepare("SELECT content, created_at FROM dream_preimages ORDER BY id DESC LIMIT 1").get()}recordDreamRun(e){this.db.prepare("INSERT INTO dream_runs (day, light_staged, themes, promoted, merged, superseded, rejected, verdict, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(e.day,e.light_staged,e.themes,e.promoted,e.merged,e.superseded,e.rejected,e.verdict,Date.now())}lastDreamRun(){return this.db.prepare("SELECT * FROM dream_runs ORDER BY id DESC LIMIT 1").get()}};export{L as a};
