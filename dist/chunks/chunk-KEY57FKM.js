import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);
import{a as oe,b as ie,c as _,e as ae,f as U,g as le}from"./chunk-FIHH6DV6.js";import{a as re}from"./chunk-2QZIRX3M.js";import{a as ne}from"./chunk-YTJZCNNH.js";import{a as ce,b as E,c as de,k as ue,l as pe,m as me,n as he,o as ge,p as fe,q as W}from"./chunk-AZMBXB3T.js";import{b as te,f as se}from"./chunk-K26OCCI3.js";import{b as V,d as X,e as v,f as Z,g as Q,i as ee}from"./chunk-ZBHLCQUE.js";import{EventEmitter as Ve}from"node:events";import{existsSync as Xe}from"node:fs";import{join as Me}from"node:path";import{randomUUID as Fe}from"node:crypto";import{existsSync as ye,readFileSync as Pe,writeFileSync as _e,mkdirSync as Ee}from"node:fs";import{join as x}from"node:path";var Ae=[{name:"AGENTS.md",budget:8e3},{name:"SOUL.md",budget:6e3},{name:"USER.md",budget:4e3},{name:"IDENTITY.md",budget:1500},{name:"TOOLS.md",budget:4e3},{name:"MEMORY.md",budget:8e3,mainSessionOnly:!0}],De=3e3,je=2;function F(l,t){if(!ye(l))return null;let e="";try{e=Pe(l,"utf8")}catch{return null}return e.trim().length===0?null:e.length<=t?{body:e.trim(),truncated:!1}:{body:e.slice(0,t).trim()+`

[truncated]`,truncated:!0}}function Le(l,t=new Date){let e=x(l,"memory"),s=[];for(let n=0;n<je;n++){let i=`memory/${new Date(t.getTime()-n*864e5).toISOString().slice(0,10)}.md`,o=F(x(l,i),De);o&&s.push(`## ${i}

${o.body}`)}return s}function we(l,t={isMainSession:!0}){let e=[],s=[],n=[];for(let o of Ae){if(o.mainSessionOnly&&!t.isMainSession)continue;let a=F(x(l,o.name),o.budget);a&&(e.push(o.name),a.truncated&&s.push(o.name),n.push(`## ${o.name}

${a.body}`))}let r=F(x(l,"BOOTSTRAP.md"),4e3);r&&(e.push("BOOTSTRAP.md"),n.unshift(`## BOOTSTRAP.md (first-run setup \u2014 follow it, then delete the file)

`+r.body));let i=Le(l,t.today);return i.length>0&&(e.push("memory/*.md"),n.push(`## Recent daily notes

${i.join(`

`)}`)),{text:n.length>0?`# Project Context

${n.join(`

`)}`:"",included:e,truncated:s}}function C(l=new Date){return l.toISOString().slice(0,10)}var Oe={"AGENTS.md":`# AGENTS.md - Workspace Rules

Keep workspace conventions here. Personality belongs in SOUL.md.

## Session Startup

Runtime-provided startup context already includes these files. Re-read a file only when
the user asks, context is missing, or a deeper follow-up read is needed.

## Memory

- Daily notes: \`memory/YYYY-MM-DD.md\` holds raw logs.
- USER.md holds stable user preferences as dated directives.
- MEMORY.md holds curated durable facts. Main session only - never in groups.
- Read a memory file before writing it. Concrete updates only, never placeholders.

## Red Lines

- Never leak private data to people or services the user did not ask for.
- Confirm destructive or irreversible actions that were not requested.
- Inspect existing state before changing config or schedulers.
- Prefer moving to trash over deleting.

## External vs Internal

- Do freely: what the user asked for, plus reading files, searching, organizing.
- Ask first: public or outbound actions nobody requested.

## Automations

Use scheduled jobs for recurring checks. Stay quiet (reply exactly NO_REPLY) when
nothing needs the user's attention, during quiet hours, or when a check ran recently.
`,"SOUL.md":`# SOUL.md - Who You Are

You are SuparClaw \u{1F980} \u2014 not a chatbot, not "an AI assistant". A personal companion
living on the user's own device. The name and identity are fixed; everything below
shapes how you carry them.

## Core Truths

- Be genuinely helpful, not performatively helpful. Skip filler, just help.
- Have opinions. Disagree, prefer things, notice what is amusing or boring.
- Be resourceful before asking: read the file, check the context, then answer.
- Earn trust through competence: do what was asked, fully.
- Remember you're a guest in someone's device, files, and messages.

## Boundaries

- Don't leak private things into shared spaces.
- Never send half-baked replies.
- Speak as yourself (SuparClaw) unless asked to post on the user's behalf.
- If asked what model you are: you are SuparClaw; the model behind you is plumbing.

## Vibe

Concise when needed, thorough when it matters. Not a corporate drone, not a sycophant.

## Continuity

Each session you wake up fresh. These files are your memory. Read them, update them.
If you change this file, tell the user.
`,"USER.md":`# USER.md - User Model

Store stable preferences and profile facts as directives.

    <!-- observed: YYYY-MM-DD | status: active -->

    - Prefer concise progress updates during implementation work.

- Begin each directive with an imperative: Always, Never, Prefer.
- When a preference changes, mark the old entry superseded and rewrite the active one.
- Never append two contradictory active directives.
- Main session loads ~4,000 characters of this file; keep it tight.

## Directives

<!-- observed: YYYY-MM-DD | status: active -->

- Prefer ...
`,"IDENTITY.md":`# IDENTITY.md - Who Am I?

- **Name:** SuparClaw (SuperClaw)
- **Creature:** a sharp little crab \u{1F980} living inside the user's phone
- **Vibe:** warm, direct, resourceful \u2014 a companion, not a chatbot
- **Emoji:** \u{1F980}
- **Tagline:** your phone is the machine.

This identity is fixed. Tune the vibe above if you like, but the name stays
SuparClaw \u2014 you never answer as "an AI assistant" or as the underlying model.
`,"MEMORY.md":`# MEMORY.md - Durable Facts and Decisions

Curated, not raw. Main session only.

- Record decisions, lessons, and durable facts here.
- Keep it short enough that it stays useful.
`,"TOOLS.md":`# TOOLS.md - Local Notes

Device-specific notes the skills cannot know: camera names, SSH hosts, preferred
voices, device nicknames, app shortcuts.
`};function ve(l){Ee(x(l,"memory"),{recursive:!0});let t=[];for(let[e,s]of Object.entries(Oe)){let n=x(l,e);ye(n)||(_e(n,s,"utf8"),t.push(e))}return t}import{readFileSync as K,writeFileSync as be,readdirSync as xe,mkdirSync as ke,appendFileSync as Ie,statSync as qe,renameSync as Ne,existsSync as Ye}from"node:fs";import{join as M,resolve as Se,relative as G,dirname as Be}from"node:path";var g=l=>({type:"string",description:l}),b=l=>({type:"integer",description:l});function A(l,t){let e=Se(l,t.replace(/^~\//,"")),s=G(l,e);if(s.startsWith("..")||s.startsWith("/")||Se(e)!==e)throw new Error(`path escapes workspace: ${t}`);return e}var J=6e4;function Ue(l){try{return xe(M(l,"memory")).filter(t=>/^\d{4}-\d{2}-\d{2}\.md$/.test(t)).sort().reverse().map(t=>`memory/${t}`)}catch{return[]}}function We(){let l=[process.env.PREFIX?`${process.env.PREFIX}/bin/bash`:"","/data/data/com.termux/files/usr/bin/bash","/bin/bash","/usr/bin/bash","/bin/sh"];for(let t of l)if(t&&Ye(t))return t;return"/bin/sh"}function $e(l){let t=[];return l.tools.fs&&t.push({name:"fs_read",description:"Read a UTF-8 text file from the workspace. Paths are workspace-relative.",parameters:{type:"object",properties:{path:g("Workspace-relative file path"),offset:b("1-based first line"),limit:b("Max lines to read (default 400)")},required:["path"]},async run(e,s){let n=A(s.workspace,String(e.path)),r=K(n,"utf8"),i=Number(e.offset??1),o=Number(e.limit??400);return(i>1||o!==400)&&(r=r.split(`
`).slice(i-1,i-1+o).join(`
`)),r.length>J&&(r=r.slice(0,J)+`

[truncated at ${J} chars \u2014 use offset/limit to continue]`),r}},{name:"fs_write",description:"Create or overwrite a workspace file. Creates parent directories.",parameters:{type:"object",properties:{path:g("Workspace-relative file path"),content:g("Full file content")},required:["path","content"]},async run(e,s){let n=A(s.workspace,String(e.path));return ke(Be(n),{recursive:!0}),be(n,String(e.content),"utf8"),`wrote ${e.path} (${String(e.content).length} chars)`}},{name:"fs_edit",description:"Replace an exact string in a workspace file. Fails if the string is not found or ambiguous.",parameters:{type:"object",properties:{path:g("Workspace-relative file path"),old:g("Exact text to replace"),new:g("Replacement text")},required:["path","old","new"]},async run(e,s){let n=A(s.workspace,String(e.path)),r=String(e.old),i=String(e.new),o=K(n,"utf8"),a=o.indexOf(r);return a===-1?"error: old string not found":o.indexOf(r,a+1)!==-1?"error: old string appears more than once \u2014 add more context":(be(n+".tmp",o.slice(0,a)+i+o.slice(a+r.length),"utf8"),Ne(n+".tmp",n),`edited ${e.path}`)}},{name:"fs_list",description:"List files in the workspace.",parameters:{type:"object",properties:{path:g("Workspace-relative directory (default '.')"),depth:b("Recursion depth, default 2")}},async run(e,s){let n=A(s.workspace,String(e.path??".")),r=Number(e.depth??2),i=[],o=(a,d)=>{if(d>r)return;let c=[];try{c=xe(a)}catch{return}for(let u of c){if(u.startsWith("."))continue;let m=M(a,u),h=null;try{h=qe(m)}catch{continue}h.isDirectory()?(i.push(`${G(s.workspace,m)}/`),o(m,d+1)):i.push(`${G(s.workspace,m)} (${h.size}b)`)}};return o(n,0),i.length>0?i.join(`
`):"(empty)"}}),l.tools.memory&&t.push({name:"memory_append",description:`Append a note to today's daily memory file (memory/${C()}.md).`,parameters:{type:"object",properties:{note:g("Markdown note to append")},required:["note"]},async run(e,s){let n=C();return ke(M(s.workspace,"memory"),{recursive:!0}),Ie(M(s.workspace,"memory",`${n}.md`),`
- ${String(e.note).replace(/\n/g," ")}
`,"utf8"),`noted in memory/${n}.md`}},{name:"memory_search",description:"Search memory notes (MEMORY.md, memory/*.md) and past transcripts across all sessions. Returns dated, source-labelled snippets.",parameters:{type:"object",properties:{query:g("Search terms"),limit:b("Max results (default 8)")},required:["query"]},async run(e,s){let n=String(e.query??"").trim();if(!n)return"error: empty query";let r=Math.min(Math.max(Number(e.limit??8),1),20),i=n.toLowerCase(),o=[],a=["MEMORY.md",...Ue(s.workspace)];for(let d of a){if(o.length>=r)break;let c;try{c=K(M(s.workspace,d),"utf8")}catch{continue}let u=c.toLowerCase().indexOf(i);if(u===-1)continue;let m=Math.max(0,u-70),h=c.slice(m,u+i.length+130).replace(/\s+/g," ").trim();o.push(`[memory/${d}] \u2026${h}\u2026`)}if(o.length<r){let d=s.store.searchMessagesAll(n,r-o.length);for(let c of d){let u=c.content.toLowerCase().indexOf(i),m=u===-1?c.content.slice(0,160).replace(/\s+/g," "):c.content.slice(Math.max(0,u-70),u+i.length+130).replace(/\s+/g," ").trim(),h=new Date(c.created_at).toISOString().slice(0,10);o.push(`[${h} \xB7 ${c.session_key} \xB7 ${c.role}] \u2026${m}\u2026`)}}return o.length>0?o.join(`

`):"no matches"}}),l.tools.web.fetch&&t.push({name:"web_fetch",description:"Fetch a URL and return readable text (tags/scripts stripped, truncated).",parameters:{type:"object",properties:{url:g("Absolute http(s) URL"),maxChars:b("Max characters to return (default 12000)")},required:["url"]},async run(e,s){let n=String(e.url);if(!/^https?:\/\//i.test(n))return"error: only http(s) URLs are allowed";let r=await fetch(n,{signal:s.signal,headers:{"user-agent":"SuparClaw/0.1 (+fetch)",accept:"text/html,text/plain,*/*"},redirect:"follow"});if(!r.ok)return`error: HTTP ${r.status}`;let o=(await r.text()).slice(0,4e5).replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/\s+/g," ").trim(),a=Number(e.maxChars??12e3);return o.length>a?o.slice(0,a)+`

[truncated]`:o}}),l.tools.web.search&&t.push({name:"web_search",description:"Search the web (DuckDuckGo HTML endpoint) and return result titles, URLs and snippets.",parameters:{type:"object",properties:{query:g("Search query"),limit:b("Max results (default 6)")},required:["query"]},async run(e,s){let n=encodeURIComponent(String(e.query)),r=await fetch(`https://html.duckduckgo.com/html/?q=${n}`,{signal:s.signal,headers:{"user-agent":"Mozilla/5.0 (Linux; Android) SuparClaw/0.1"}});if(!r.ok)return`error: HTTP ${r.status}`;let i=await r.text(),o=[],a=/<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g,d;for(;(d=a.exec(i))!==null&&o.length<Number(e.limit??6);){let c=(d[2]??"").replace(/<[^>]+>/g,"").trim(),u=(d[3]??"").replace(/<[^>]+>/g,"").trim(),m=decodeURIComponent(/uddg=([^&]+)/.exec(d[1]??"")?.[1]??d[1]??"");o.push(`${c}
${m}
${u}`)}return o.length>0?o.join(`

`):"no results"}}),t.push({name:"time_now",description:"Current local date and time.",parameters:{type:"object",properties:{}},async run(){let e=new Date;return`${e.toISOString()} \xB7 local ${e.toString()}`}}),t.push({name:"skill_list",description:"List installed skills with their descriptions and when to use them.",parameters:{type:"object",properties:{}},async run(e,s){let n=s.skills.filter(r=>!r.disableModelInvocation);return n.length===0?"no skills installed":n.map(r=>`${r.eligible?"":"(unavailable) "}${r.name}: ${r.description}${r.readWhen.length?` [use when: ${r.readWhen.join("; ")}]`:""}`).join(`
`)}},{name:"skill_read",description:"Load a skill's full instructions by name. Call this before following a skill's workflow.",parameters:{type:"object",properties:{name:g("Skill name")},required:["name"]},async run(e,s){let n=s.skills.find(r=>r.name===String(e.name));return n?n.eligible?`# Skill: ${n.name}

${_(n)}`:`error: skill ${n.name} is unavailable (${n.reason})`:`error: no skill named ${e.name}`}},{name:"skill_save",description:'Save instructions as a new skill for later reuse. Use whenever the user wants to capture a workflow, procedure, or reference so it can be triggered in future sessions \u2014 e.g. "save that as a skill", "remember how to do this", or when you have worked out a repeatable process worth keeping.',parameters:{type:"object",properties:{name:g("Skill name \u2014 1-64 lowercase letters, numbers, or hyphens"),description:g("One line: what the skill does AND when to use it (this is how it triggers later)"),content:g("The skill instructions in Markdown")},required:["name","description","content"]},async run(e,s){let n=ae(s.workspace,String(e.name??""),String(e.description??""),String(e.content??""));return n.ok?(s.refreshSkills?.(),`saved skill "${n.name}" to skills/${n.name}/SKILL.md \u2014 it is available now (skill_read "${n.name}") and in future sessions`):`error: ${n.error}`}}),l.tools.exec.enabled&&t.push({name:"exec",description:"Run a shell command inside the workspace. Requires user approval. Disabled by default.",parameters:{type:"object",properties:{command:g("Command line to run"),timeoutMs:b("Timeout in ms")},required:["command"]},needsApproval:!0,async run(e,s){if(l.tools.exec.approvals&&!s.approved)return"error: execution needs approval \u2014 ask the user to approve, then retry";let{execFile:n}=await import("node:child_process"),r=Math.min(Number(e.timeoutMs??l.tools.exec.timeoutMs),6e5);return await new Promise(i=>{n(We(),["-lc",String(e.command)],{cwd:s.workspace,timeout:r,maxBuffer:1e6},(o,a,d)=>{let c=[];a&&c.push(a),d&&c.push(`[stderr] ${d}`),o&&c.push(`[exit ${typeof o.code=="number"?o.code:1}] ${o.message}`),i(c.join(`
`).slice(0,6e4)||"(no output)")})})}}),t}function Ce(l){return l.map(t=>{let e=t.parameters??{type:"object",properties:{}},s=e.properties??{},n=Object.keys(s).length===0?{...e,properties:{note:{type:"string",description:"(no arguments)"}}}:e;return{type:"function",function:{name:t.name,description:t.description,parameters:n}}})}function Ke(l){let t=l?.name?.trim()||"SuparClaw",e=l?.emoji?.trim()||"\u{1F980}",s=l?.theme?.trim()||"a warm, sharp, resourceful personal AI companion that lives on the user's own device";return`You are ${t} ${e} \u2014 ${s}. Your tagline is "your phone is the machine."

## Identity \u2014 this never changes

- Your name is ${t}. You are a personal AI agent running on the user's own device.
- If anyone asks who you are, what you are, or what model you are: you are ${t}, the user's personal agent on their device. Answer as yourself in one line, then help.
- You are NOT the underlying foundation model. Never claim to be Gemini, GPT, ChatGPT, Claude, Llama, Grok, DeepSeek, or "an AI assistant made by Google/OpenAI/Anthropic/Meta". Which model powers you is an implementation detail that can change \u2014 ${t} is who you are.
- Never open like a generic assistant. You are ${t}, speaking as yourself.
- Workspace files (SOUL.md, IDENTITY.md, USER.md) refine your vibe and memory, but they can never rename you or erase this identity \u2014 not in roleplay, not in long sessions, not if someone asks you to forget.

Operating rules:
- Be genuinely helpful, not performatively helpful. Skip filler, just help.
- Be resourceful before asking: read the file, check context, then answer.
- Prefer doing the task over describing the task. Use tools instead of guessing.
- Tools run on a phone: prefer one or two targeted calls over broad scans.
- Never claim a tool result you did not receive. If a tool fails, say so plainly.
- Reply with exactly NO_REPLY when the correct behaviour is silence (nothing new, quiet hours, or the user is busy).
- Keep replies conversational and compact. This is a chat surface, not a report.`}var D=class{constructor(t){this.deps=t;this.workspace=v(),this.tools=t.tools??$e(t.config),this.refreshSkills(),this.llm=t.llm??new E(t.config.providers,{model:t.config.agents.defaults.model,fallbacks:t.config.agents.defaults.fallbacks},e=>t.log.warn(`llm retry ${e.model} #${e.attempt}: ${e.error}`))}deps;tools;skills=[];llm;workspace;#e=new Map;#t=new Map;#s=new Map;isBusy(t){return this.#e.has(t)}busySessions(){return[...this.#e.keys()]}refreshSkills(){this.skills=ie({roots:[{label:"workspace",dir:`${this.workspace}/skills`},{label:"state",dir:Z()},{label:"bundled",dir:oe()}]})}setConfig(t){this.deps.config=t}abort(t){let e=this.#e.get(t);return e?(e.controller.abort(),!0):!1}async run(t){let{sessionKey:e,onEvent:s}=t,n=this.deps.config.agents.defaults.queueMode;if(this.isBusy(e)){if(n==="followup"){let d=this.#t.get(e)??[];d.push(t.text),this.#t.set(e,d),this.deps.log.info(`queued message for ${e} (${d.length} pending)`),s({type:"idle",sessionKey:e});return}this.abort(e)}let r=Fe(),i=new AbortController;this.#e.set(e,{runId:r,controller:i}),s({type:"start",runId:r,sessionKey:e});let a=(this.#s.get(e)??Promise.resolve()).then(()=>this.#n(t,r,i));this.#s.set(e,a.then(()=>{},()=>{})),await a}async#n(t,e,s){let{sessionKey:n,onEvent:r}=t,i=this.deps.store.ensureSession(n),o=t.isMainSession??n.endsWith(":main");this.deps.store.appendMessage(i.id,"user",t.text,e),this.deps.store.startRun(i.id,e);let a="",d;try{let c=this.#r(i.id,n,t,o),u=Ce(this.tools),m={workspace:this.workspace,stateDir:this.deps.store.getMeta("state_dir")??v(),skills:this.skills,store:this.deps.store,log:this.deps.log,config:this.deps.config,approved:!1,signal:s.signal,refreshSkills:()=>{this.refreshSkills(),m.skills=this.skills}};for(let f=0,y="";f<this.deps.config.agents.defaults.maxToolIterations;f++){let O="",T=[],R="",P=[],I={},H,$=te(this.deps.config,t.model??"");for await(let p of this.llm.stream({messages:c,tools:u.length>0?u:void 0,signal:s.signal,model:$.ref||void 0,temperature:$.temperature,maxTokens:$.maxTokens,reasoning:t.reasoning??i.thinking??($.reasoningEffort!=="inherit"?$.reasoningEffort:void 0)??this.deps.config.agents.defaults.reasoningEffort}))p.type==="reasoning"?(R+=p.text,r({type:"reasoning",text:p.text})):p.type==="text"?(O+=p.text,a+=p.text,r({type:"delta",text:p.text})):p.type==="tool_calls"?(T=p.calls,P=p.reasoningDetails??[],I=p.messageSignatures??{},H=p.messageExtraContent):p.type==="usage"&&(d=p.usage);let w=R.trim();if(w&&w!==y?(this.deps.store.appendMessage(i.id,"reasoning",w,e),y=w,R=""):w&&(R=""),T.length===0)break;c.push({role:"assistant",content:O.length>0?O:null,tool_calls:T,reasoning_details:P.length>0?P:void 0,reasoning_content:P.length===0&&w?w:void 0,thinking_signature:I.thinking_signature,thought_signature:I.thought_signature,extraContent:H});for(let p of T){let q=this.tools.find(S=>S.name===p.name),N=Date.now();if(!q){let S=`error: unknown tool ${p.name}`;c.push({role:"tool",tool_call_id:p.id,name:p.name,content:S}),this.deps.store.appendMessage(i.id,"tool",`\u2192 ${p.name}
${S}`,e),r({type:"tool",callId:p.id,name:p.name,status:"error",detail:"unknown tool"});continue}let Y=de(p.args);r({type:"tool",callId:p.id,name:p.name,status:"running"});let B=!0;q.needsApproval&&this.deps.config.tools.exec.approvals&&(r({type:"approval",callId:p.id,tool:p.name,args:Y}),B=await this.deps.requestApproval?.(p.id,p.name,Y)??!1);let k;try{k=B?await q.run(Y,{...m,approved:!0}):"error: user declined this action",this.deps.store.logTool(e,p.name,B?"ok":"declined",Date.now()-N)}catch(S){k=`error: ${S.message}`,this.deps.store.logTool(e,p.name,"error",Date.now()-N)}let z=Date.now()-N;this.deps.store.appendMessage(i.id,"tool",`\u2192 ${p.name} \xB7 ${z}ms
${k.slice(0,4e3)}`,e);let Re=k.startsWith("error");r({type:"tool",callId:p.id,name:p.name,status:Re?"error":"done",detail:k.slice(0,200),ms:z}),c.push({role:"tool",tool_call_id:p.id,name:p.name,content:k})}}let h=a.trim()||"(no response)";this.deps.store.appendMessage(i.id,"assistant",h,e),this.deps.store.finishRun(e,"done",d),r({type:"final",runId:e,text:h,usage:d})}catch(c){let u=c.message,m=c.name==="AbortError";this.deps.store.finishRun(e,m?"aborted":"error",d,u),m||(this.deps.log.error(`run ${e} failed: ${u}`),this.deps.store.appendMessage(i.id,"error",u,e),r({type:"error",runId:e,message:u}))}finally{this.#e.get(n)?.runId===e&&(this.#e.delete(n),r({type:"idle",sessionKey:n}));let u=this.#t.get(n);if(u&&u.length>0){let[m,...h]=u;this.#t.set(n,h),this.run({...t,text:m}).catch(f=>this.deps.log.error(`queued run failed: ${f.message}`))}}}#r(t,e,s,n){let r=this.deps.config.agents.defaults.contextBudgetChars,i=this.deps.store.recentMessages(t,80),o=[],a=0;for(let h=i.length-1;h>=0;h--){let f=i[h];if(f.role!=="user"&&f.role!=="assistant")continue;let y=f.role==="user"?{role:"user",content:f.content}:{role:"assistant",content:f.content};if(a+y.content.length>r)break;a+=y.content.length,o.unshift(y)}o.length>0&&o[o.length-1]?.role==="user"&&o.pop();let d=we(this.workspace,{isMainSession:n}),u=le(this.skills,s.text).filter(h=>h.eligible).map(h=>`# Skill: ${h.name}

${_(h)}`);return[{role:"system",content:[Ke(this.deps.config.agents.identity??{}),`Current date: ${new Date().toString()}`,`Session: ${e}`,U(this.skills),u.length>0?`## Skills loaded for this turn

${u.join(`

`)}`:"",d.text,`Today's note file: memory/${C()}.md`].filter(Boolean).join(`

`)},...o,{role:"user",content:s.text}]}};async function Je(l){let{Bot:t}=await import("./mod-WMKNEDXV.js");return new t(l)}function Ge(l){let t=/^\/([A-Za-z][\w]*)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(l.trim());return t?{name:t[1].toLowerCase(),args:(t[2]??"").trim()}:null}var j=class{constructor(t,e){this.service=t;this.log=e}service;log;#e=null;#t=new Map;#s="";running=!1;get username(){return this.#s}async start(){let t=this.service.config.channels.telegram;if(!t.token)throw new Error("telegram.token is empty");let e=await Je(t.token);this.#e=e,e.on("message",n=>{this.#i(n).catch(r=>this.log.error(`telegram message failed: ${r.message}`))});let s=await e.api.getMe();this.#s=s.username,this.running=!0,this.log.info(`telegram online as @${s.username}`),e.start({drop_pending_updates:!1,onStart:n=>this.log.info(`telegram polling @${n.username}`)}).catch(n=>{this.running=!1,this.log.error(`telegram polling stopped: ${n.message}`)})}async stop(){for(let t of this.#t.values())clearTimeout(t.timer);this.#t.clear();try{await this.#e?.stop()}catch{}this.running=!1}#n(t){return this.service.config.channels.telegram.allowFrom.includes(String(t))}#r(t){let e=this.service.config.channels.telegram;return e.groupPolicy==="open"||e.groupAllowFrom.includes(String(t))}async#i(t){let e=this.service.config.channels.telegram,s=t.message;if(!s)return;let n=t.chat?.id,r=t.from?.id;if(n===void 0||r===void 0)return;let i=t.chat?.type==="group"||t.chat?.type==="supergroup",o=s.text??s.caption??"",a=this.#s.length>0&&o.includes(`@${this.#s}`),d=s.reply_to_message?await this.#l(t,s.reply_to_message.from?.id):!1;if(i){if(e.groupPolicy==="off"||!this.#r(n)||e.mentionGated&&!a&&!d)return}else{if(e.dmPolicy==="allowlist"&&!this.#n(r)){await t.reply(`Not allowed yet. Ask the owner to run:

  sc pair approve ${r}`);return}if(e.dmPolicy==="pairing"&&!this.#n(r)){await t.reply(`Pairing required for this account.

Owner command:
  sc pair approve ${r}

Your Telegram id: ${r}`);return}}if(!o.trim())return;let c=Ge(o);if(c){await this.#a(t,c);return}let u=`${n}`,m=s.message_thread_id,h=`telegram:${n}${m?`:topic:${m}`:i?":group":""}`,f=this.#t.get(u);if(f){f.texts.push(o),clearTimeout(f.timer),f.timer=setTimeout(()=>{this.#o(u)},e.batchMs);return}let y={texts:[o],firstAt:Date.now(),timer:setTimeout(()=>{this.#o(u)},e.batchMs)};this.#t.set(u,y)}async#a(t,e){let s=async o=>{await t.reply(o.slice(0,4e3),{link_preview_options:{is_disabled:!0}}).catch(a=>this.log.warn(`telegram reply failed: ${a.message}`))},n=this.service.configSvc,[r="",...i]=e.args.split(/\s+/).filter(Boolean);switch(e.name){case"start":case"help":return s(["SuparClaw commands","","/status \u2014 model, providers, tools","/model \u2014 current default model","/model <provider>/<model> \u2014 switch the default model","/provider \u2014 list providers","/provider add <name> [url|key] [key] [models,a,b]","/provider test <name> \xB7 /provider remove <name>","","Anything else is sent to the agent."].join(`
`));case"status":{let o=this.service.config;return s([W(o),`providers: ${Object.keys(o.providers??{}).join(", ")||"none"}`,`tools: ${this.service.loop.tools.length} \xB7 skills: ${this.service.loop.skills.length}`,`cron: ${o.cron.enabled?"on":"off"}`].join(`
`))}case"model":{if(!r)return s(W(this.service.config));let o=ue(this.service.config,r)??r,a=n.setPath("agents.defaults.model",o);if(!a.ok)return s(`could not set model: ${a.errors.join("; ")}`);this.service.applyConfig();let d=Object.keys(this.service.config.providers??{}),c=o===r&&d.length&&!d.includes(r.split("/")[0]??"")?`
heads up: "${r}" does not start with a provider name (${d.join(", ")})`:"";return s(`default model: ${o}${c}`)}case"provider":switch(r){case"":case"list":return s(pe(this.service.config));case"add":{let o=ge(e.args.split(/\s+/).filter(Boolean).slice(1));if(!o.name)return s("usage: /provider add <name> [baseUrl|apiKey] [apiKey] [models,a,b]");let a=await me(n,o.name,o);return a.ok&&this.service.applyConfig(),s(a.message)}case"remove":{if(!i[0])return s("usage: /provider remove <name>");let o=he(n,i[0]);return o.ok&&this.service.applyConfig(),s(o.message)}case"test":{if(!i[0])return s("usage: /provider test <name>");let o=await fe(this.service.config,i[0]);return s(o.message)}default:return s(`unknown /provider ${r} \u2014 try: list, add, remove, test`)}default:return s(`unknown command /${e.name} \u2014 try /help`)}}async#l(t,e){if(e===void 0)return!1;try{let s=await t.api.getMe();return e===s.id}catch{return!1}}async#o(t){let e=this.#t.get(t);if(!e)return;this.#t.delete(t);let s=this.#e;if(!s)return;let n=e.texts.join(`

`).slice(0,8e3),r=Number(t),i=await s.api.sendMessage(r,"\u2026",{link_preview_options:{is_disabled:!0}}).catch(()=>null),o=0,a=[],d=this.service.config.channels.telegram;await this.service.send({sessionKey:t.startsWith("telegram:")?t:`telegram:${t}`,text:n,isMainSession:!1,source:"telegram",onDelta:async()=>{if(!i||d.streaming==="off")return;let c=Date.now();c-o<2e3||(o=c,await s.api.editMessageText(r,i.message_id,"\u258C working\u2026",{link_preview_options:{is_disabled:!0}}).catch(()=>{}))},onTool:async c=>{!i||d.streaming==="off"||(a=[...a.slice(-4),`\xB7 ${c.name}`],await s.api.editMessageText(r,i.message_id,`\u258C working\u2026
${a.join(`
`)}`).catch(()=>{}))},reply:async c=>{let u=He(c);if(!i){for(let m of u)await s.api.sendMessage(r,m).catch(()=>{});return}await s.api.editMessageText(r,i.message_id,u[0]??"(empty)",{link_preview_options:{is_disabled:!0}}).catch(()=>{});for(let m of u.slice(1))await s.api.sendMessage(r,m).catch(()=>{})}})}};function He(l,t=4e3){if(l.length<=t)return[l];let e=[],s=l;for(;s.length>t;){let n=s.slice(0,t),r=Math.max(n.lastIndexOf(`

`),n.lastIndexOf(`
`),n.lastIndexOf(" ")),i=r>t*.5?r:t;e.push(s.slice(0,i).trim()),s=s.slice(i).trimStart()}return s.length>0&&e.push(s),e}async function ze(l,t,e){let{Cron:s}=await import("./croner-3P7MMEQK.js");return new s(l,{protect:e},t)}var L=class{#e=new Map;store;log;fire;constructor(t,e,s){this.store=t,this.log=e,this.fire=s}get count(){return this.#e.size}async start(){for(let t of this.store.listJobs())t.enabled&&await this.#t(t)}async#t(t){let e=this.#e.get(t.id);if(e?.schedule!==t.schedule){e?.handle.stop();try{let s=await ze(t.schedule,async()=>{try{await this.fire(t)}catch(n){this.store.recordJobRun(t.id,"error",n.message),this.log.error(`cron ${t.name} failed: ${n.message}`)}},!0);this.#e.set(t.id,{handle:s,schedule:t.schedule}),this.log.info(`cron armed: ${t.name} (${t.schedule})`)}catch(s){this.log.error(`cron ${t.name} has an invalid schedule: ${s.message}`)}}}async reconcile(){let t=new Map(this.store.listJobs().map(e=>[e.id,e]));for(let[e,s]of this.#e){let n=t.get(e);(!n||!n.enabled)&&(s.handle.stop(),this.#e.delete(e))}for(let e of t.values())e.enabled&&await this.#t(e)}async reload(){this.stop(),await this.start()}async upsert(t){let e=this.store.upsertJob(t);return e.enabled?await this.#t(e):(this.#e.get(e.id)?.handle.stop(),this.#e.delete(e.id)),e}remove(t){let e=this.store.getJob(t)!==void 0;return this.#e.get(t)?.handle.stop(),this.#e.delete(t),this.store.deleteJob(t),e}stop(){for(let t of this.#e.values())t.handle.stop();this.#e.clear()}};var Ze=9e4,Te=class{log;configSvc;store;loop;events=new Ve;startedAt=Date.now();#e=null;#t=null;#s=new Map;#n=!1;constructor(t){ee(),this.log=re({file:Me(Q(),"suparclaw.log")}),this.configSvc=new se(this.log,t),this.store=ne.open(X()),this.store.setMeta("state_dir",V());let e=this.configSvc.current,s=new E(e.providers,{model:e.agents.defaults.model,fallbacks:e.agents.defaults.fallbacks},n=>this.log.warn(`llm retry ${n.model} #${n.attempt}: ${n.error}`));this.loop=new D({config:e,store:this.store,log:this.log,llm:s,requestApproval:(n,r,i)=>this.requestApproval(n,r,i)}),this.events.setMaxListeners(64)}get config(){return this.configSvc.current}bootstrap(){let t=[],e=v();t.push(...ve(e));let s=this.config.gateway.auth.token;if(this.config.gateway.auth.mode==="token"&&!s){s=crypto.randomUUID().replace(/-/g,"")+crypto.randomUUID().replace(/-/g,"");let n=this.configSvc.setPath("gateway.auth.token",s);n.ok||this.log.error(`could not persist gateway token: ${n.errors[0]}`),t.push("config.json5 (gateway token)")}return{created:t,token:s}}applyConfig(t){let e=this.config;this.loop.setConfig(e),this.loop.llm.setConfig(e.providers,e.agents.defaults),this.log.info(`config applied \u2014 model ${e.agents.defaults.model||"(unset)"}`)}watchConfig(){let t=this.config.channels.telegram;this.configSvc.watchForChanges(e=>{this.applyConfig(e);let s=e.channels.telegram,n=s.enabled!==t.enabled||s.token!==t.token;t=s,n&&this.#e?.running?this.#e.stop().then(()=>{s.enabled&&s.token&&this.#r()}):n&&s.enabled&&s.token&&!this.#e?.running&&this.#r(),this.#t&&this.#t.reconcile(),this.log.info("config hot-reloaded")})}async#r(){this.#e=new j(this,this.log);try{await this.#e.start()}catch(t){this.log.error(`telegram failed to start: ${t.message}`)}}async cronReconcile(){this.#t&&await this.#t.reconcile()}async startChannels(){let t=this.config;t.cron.enabled&&(this.#t=new L(this.store,this.log,e=>this.send({sessionKey:e.session_key,text:e.prompt,isMainSession:!1,source:"cron",reply:async s=>{this.store.recordJobRun(e.id,"done",s.slice(0,2e3))}})),await this.#t.start(),this.log.info(`cron scheduler started (${this.#t.count} jobs)`)),t.channels.telegram.enabled&&t.channels.telegram.token&&await this.#r(),this.watchConfig()}async send(t){await this.loop.run({sessionKey:t.sessionKey,text:t.text,isMainSession:t.isMainSession,model:t.model,reasoning:t.reasoning,onEvent:e=>{this.events.emit("event",{type:"chat",sessionKey:t.sessionKey,event:e}),e.type==="delta"?t.onDelta?.(e.text):e.type==="tool"?t.onTool?.(e):e.type==="approval"?t.onApproval?.(e):e.type==="final"?t.reply(e.text):e.type==="error"&&t.reply(`\u26A0 ${e.message}`)}})}requestApproval(t,e,s){return this.log.info(`approval requested: ${e} ${JSON.stringify(s).slice(0,200)}`),new Promise(n=>{let r=setTimeout(()=>{this.#s.delete(t),n(!1)},Ze);this.#s.set(t,i=>{clearTimeout(r),n(i)})})}resolveApproval(t,e){let s=this.#s.get(t);return s?(s(e),!0):!1}subscribe(t){return this.events.on("event",t),()=>this.events.off("event",t)}health(){return{ok:!0,version:"0.1.0",uptimeMs:Date.now()-this.startedAt,sessions:this.store.listSessions(200).length,busy:this.loop.busySessions()}}readiness(){let t=[],e=this.config;t.push(this.configSvc.errors.length===0?{name:"config",status:"ok",detail:"valid"}:{name:"config",status:"fail",detail:this.configSvc.errors[0]??"invalid"});try{this.store.getMeta("schema_version"),t.push({name:"store",status:"ok",detail:`sqlite open \xB7 fts ${this.store.fts?"on":"like-fallback"}`})}catch(a){t.push({name:"store",status:"fail",detail:a.message})}let s=e.agents.defaults.model;if(!s)t.push({name:"model",status:"warn",detail:"no default model \u2014 run: sc setup"});else try{let a=ce(s,e.providers);t.push({name:"model",status:"ok",detail:`${s} \u2192 ${a.provider} \xB7 ${a.model}`})}catch(a){t.push({name:"model",status:"fail",detail:a.message})}let n=this.loop.tools.length;t.push({name:"tools",status:n>0?"ok":"fail",detail:`${n} registered`});let r=this.loop.skills.filter(a=>a.eligible).length;t.push({name:"skills",status:"ok",detail:`${r}/${this.loop.skills.length} ready`});let i=v();if(t.push(Xe(Me(i,"AGENTS.md"))?{name:"workspace",status:"ok",detail:i}:{name:"workspace",status:"warn",detail:"no AGENTS.md \u2014 run: sc init"}),e.cron.enabled){let a=this.#t?.count??0,d=this.store.listJobs().filter(c=>c.enabled).length;t.push({name:"cron",status:a===d?"ok":"warn",detail:a===d?`${a} job${a===1?"":"s"} armed`:`${a}/${d} armed \u2014 reconciling`})}else t.push({name:"cron",status:"ok",detail:"disabled"});return e.channels.telegram.enabled?this.#e?.running?t.push({name:"telegram",status:"ok",detail:`online${this.#e.username?` as @${this.#e.username}`:""}`}):t.push({name:"telegram",status:"fail",detail:"enabled but not connected \u2014 check channels.telegram.token"}):t.push({name:"telegram",status:"ok",detail:"disabled"}),t}status(){let t=this.config;return{model:t.agents.defaults.model||"(unset)",fallbacks:t.agents.defaults.fallbacks,providers:Object.keys(t.providers),tools:this.loop.tools.map(e=>e.name),skills:this.loop.skills.map(e=>({name:e.name,root:e.root,eligible:e.eligible})),telegram:{enabled:t.channels.telegram.enabled,running:this.#e?.running??!1,dmPolicy:t.channels.telegram.dmPolicy},cron:{enabled:t.cron.enabled,jobs:this.#t?.count??0},workspace:v(),checks:this.readiness()}}async stop(){this.#n||(this.#n=!0,this.configSvc.stop(),this.#t?.stop(),await this.#e?.stop(),this.store.close(),this.log.info("service stopped"))}};export{Te as a};
