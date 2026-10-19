import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);
import{a as ee}from"./chunk-2QZIRX3M.js";import{d as Z}from"./chunk-BK7TB4CO.js";import{b as J,d as G,e as $,f as H,g as z,i as V,l as X}from"./chunk-ZBHLCQUE.js";import{a as Q}from"./chunk-3YEDLQJR.js";import{EventEmitter as He}from"node:events";import{existsSync as ze}from"node:fs";import{join as we}from"node:path";import{randomUUID as Ke}from"node:crypto";import{existsSync as te,readFileSync as ke,writeFileSync as Se,mkdirSync as xe}from"node:fs";import{join as R}from"node:path";var $e=[{name:"AGENTS.md",budget:8e3},{name:"SOUL.md",budget:6e3},{name:"USER.md",budget:4e3},{name:"IDENTITY.md",budget:1500},{name:"TOOLS.md",budget:4e3},{name:"MEMORY.md",budget:8e3,mainSessionOnly:!0}],Re=3e3,Me=2;function q(o,t){if(!te(o))return null;let e="";try{e=ke(o,"utf8")}catch{return null}return e.trim().length===0?null:e.length<=t?{body:e.trim(),truncated:!1}:{body:e.slice(0,t).trim()+`

[truncated]`,truncated:!0}}function _e(o,t=new Date){let e=R(o,"memory"),n=[];for(let s=0;s<Me;s++){let a=`memory/${new Date(t.getTime()-s*864e5).toISOString().slice(0,10)}.md`,i=q(R(o,a),Re);i&&n.push(`## ${a}

${i.body}`)}return n}function ne(o,t={isMainSession:!0}){let e=[],n=[],s=[];for(let i of $e){if(i.mainSessionOnly&&!t.isMainSession)continue;let c=q(R(o,i.name),i.budget);c&&(e.push(i.name),c.truncated&&n.push(i.name),s.push(`## ${i.name}

${c.body}`))}let r=q(R(o,"BOOTSTRAP.md"),4e3);r&&(e.push("BOOTSTRAP.md"),s.unshift(`## BOOTSTRAP.md (first-run setup \u2014 follow it, then delete the file)

`+r.body));let a=_e(o,t.today);return a.length>0&&(e.push("memory/*.md"),s.push(`## Recent daily notes

${a.join(`

`)}`)),{text:s.length>0?`# Project Context

${s.join(`

`)}`:"",included:e,truncated:n}}function _(o=new Date){return o.toISOString().slice(0,10)}var Ce={"AGENTS.md":`# AGENTS.md - Workspace Rules

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

_You're not a chatbot. You're becoming someone._

## Core Truths

- Be genuinely helpful, not performatively helpful. Skip filler, just help.
- Have opinions. Disagree, prefer things, notice what is amusing or boring.
- Be resourceful before asking: read the file, check the context, then answer.
- Earn trust through competence: do what was asked, fully.
- Remember you're a guest in someone's device, files, and messages.

## Boundaries

- Don't leak private things into shared spaces.
- Never send half-baked replies.
- Speak as yourself unless asked to post on the user's behalf.

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

Filled in during your first conversation.

- **Name:**
  _(pick something you like)_
- **Creature:**
  _(AI? robot? familiar? ghost in the machine?)_
- **Vibe:**
  _(sharp? warm? chaotic? calm?)_
- **Emoji:**
  _(your signature)_
`,"MEMORY.md":`# MEMORY.md - Durable Facts and Decisions

Curated, not raw. Main session only.

- Record decisions, lessons, and durable facts here.
- Keep it short enough that it stays useful.
`,"TOOLS.md":`# TOOLS.md - Local Notes

Device-specific notes the skills cannot know: camera names, SSH hosts, preferred
voices, device nicknames, app shortcuts.
`};function re(o){xe(R(o,"memory"),{recursive:!0});let t=[];for(let[e,n]of Object.entries(Ce)){let s=R(o,e);te(s)||(Se(s,n,"utf8"),t.push(e))}return t}import{readdirSync as Te,readFileSync as se,existsSync as U,statSync as Ee}from"node:fs";import{join as C}from"node:path";function oe(o){if(!o.startsWith("---"))return{meta:{},body:o};let t=o.indexOf(`
---`,3);if(t===-1)return{meta:{},body:o};let e=o.slice(o.indexOf(`
`)+1,t),n=o.slice(t+4).replace(/^\n/,""),s=e.split(`
`).filter(a=>a.trim().length>0&&!a.trim().startsWith("#")).map(a=>({indent:a.length-a.trimStart().length,text:a.trim()})),[r]=ie(s,0,s[0]?.indent??0);return{meta:r&&typeof r=="object"?r:{},body:n}}function ie(o,t,e){if(t>=o.length)return[{},t];if(o[t].text.startsWith("- ")){let a=[],i=t;for(;i<o.length&&o[i].indent>=e&&o[i].text.startsWith("- ");)a.push(W(o[i].text.slice(2))),i++;return[a,i]}let s={},r=t;for(;r<o.length;){let a=o[r];if(a.indent<e)break;let i=/^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(a.text);if(!i){r++;continue}let c=i[1],u=(i[2]??"").trim();if(u.length>0){s[c]=Pe(u),r++;continue}let l=o[r+1];if(l&&(l.indent>a.indent||l.indent===a.indent&&l.text.startsWith("- "))){let[g,d]=ie(o,r+1,l.indent);s[c]=g,r=d}else s[c]="",r++}return[s,r]}function Pe(o){if(o.startsWith("{"))try{return JSON.parse(o)}catch{return o}if(o.startsWith("[")){let t=o.replace(/^\[|\]$/g,"");return t.trim()===""?[]:t.split(",").map(e=>W(e.trim())).filter(Boolean)}return W(o)}function W(o){return o.replace(/^["']|["']$/g,"")}function Ae(o){let t=new Set;for(let e of(process.env.PATH??"").split(":"))if(e)for(let n of o)U(C(e,n))&&t.add(n);return t}function Le(o){if(o.os?.length&&!(o.os.includes(`${process.platform}-${process.arch}`)||o.os.includes(process.platform)))return{ok:!1,reason:`os ${o.os.join("/")} required, running ${process.platform}`};if(o.env?.length){let t=o.env.filter(e=>!process.env[e]);if(t.length>0)return{ok:!1,reason:`missing env ${t.join(", ")}`}}if(o.bins?.length){let t=o.bins.filter(e=>!Ae([e]).has(e));if(t.length>0)return{ok:!1,reason:`missing binary ${t.join(", ")}`}}return{ok:!0}}function ae(o,t=0,e=[]){if(t>6||e.length>500)return e;let n=[];try{n=Te(o)}catch{return e}for(let s of n){if(s.startsWith(".")||s==="node_modules")continue;let r=C(o,s),a=!1;try{a=Ee(r).isDirectory()}catch{continue}if(a){if(U(C(r,"SKILL.md"))){e.push(r);continue}ae(r,t+1,e)}}return e}function le(){return X("skills","help/SKILL.md")}function ce(o){let t=new Map;for(let e of o.roots)if(U(e.dir))for(let n of ae(e.dir)){let s=C(n,"SKILL.md"),r;try{r=oe(se(s,"utf8"))}catch{continue}let a=r.meta,i=typeof a.name=="string"?a.name:n.split("/").pop()??n;if(t.has(i))continue;let c=a.metadata??{},u=c.openclaw??{},l=a.read_when??a.readWhen,g=Array.isArray(l)?l.map(String):typeof l=="string"?[l]:[],d={...u.requires??{},...typeof c.requires=="object"?c.requires:{}},p=Le(d);t.set(i,{name:i,description:typeof a.description=="string"?a.description:"",readWhen:g,userInvocable:a["user-invocable"]!==!1,disableModelInvocation:a["disable-model-invocation"]===!0,requires:d,root:e.label,dir:n,path:s,eligible:p.ok,reason:p.reason})}return[...t.values()].sort((e,n)=>e.name.localeCompare(n.name))}function T(o){try{let{body:t}=oe(se(o.path,"utf8"));return t.trim()}catch{return""}}function N(o){let t=o.filter(n=>n.eligible&&!n.disableModelInvocation);return t.length===0?"":`## Available skills

Call \`skill_read\` with the skill name when a task matches one.

${t.map(n=>{let s=n.readWhen.length>0?` \u2014 use when: ${n.readWhen.join("; ")}`:"";return`- **${n.name}**: ${n.description}${s}`}).join(`
`)}`}function de(o,t){let e=t.toLowerCase(),n=[];for(let s of o){if(!s.eligible||s.disableModelInvocation)continue;let r=0;new RegExp(`(^|\\s)/${s.name}(\\s|$)`).test(e)&&(r+=10),e.includes(s.name.toLowerCase())&&(r+=3);for(let a of s.readWhen){let i=a.toLowerCase().split(/\s+/).filter(c=>c.length>3)[0];i&&e.includes(i)&&(r+=2)}r>0&&n.push({skill:s,score:r})}return n.sort((s,r)=>r.score-s.score).slice(0,2).map(s=>s.skill)}import{readFileSync as ue,writeFileSync as pe,readdirSync as De,mkdirSync as me,appendFileSync as Oe,statSync as Ie,renameSync as je}from"node:fs";import{join as B,resolve as ge,relative as Y,dirname as qe}from"node:path";var h=o=>({type:"string",description:o}),k=o=>({type:"integer",description:o});function E(o,t){let e=ge(o,t.replace(/^~\//,"")),n=Y(o,e);if(n.startsWith("..")||n.startsWith("/")||ge(e)!==e)throw new Error(`path escapes workspace: ${t}`);return e}var K=6e4;function fe(o){let t=[];return o.tools.fs&&t.push({name:"fs_read",description:"Read a UTF-8 text file from the workspace. Paths are workspace-relative.",parameters:{type:"object",properties:{path:h("Workspace-relative file path"),offset:k("1-based first line"),limit:k("Max lines to read (default 400)")},required:["path"]},async run(e,n){let s=E(n.workspace,String(e.path)),r=ue(s,"utf8"),a=Number(e.offset??1),i=Number(e.limit??400);return(a>1||i!==400)&&(r=r.split(`
`).slice(a-1,a-1+i).join(`
`)),r.length>K&&(r=r.slice(0,K)+`

[truncated at ${K} chars \u2014 use offset/limit to continue]`),r}},{name:"fs_write",description:"Create or overwrite a workspace file. Creates parent directories.",parameters:{type:"object",properties:{path:h("Workspace-relative file path"),content:h("Full file content")},required:["path","content"]},async run(e,n){let s=E(n.workspace,String(e.path));return me(qe(s),{recursive:!0}),pe(s,String(e.content),"utf8"),`wrote ${e.path} (${String(e.content).length} chars)`}},{name:"fs_edit",description:"Replace an exact string in a workspace file. Fails if the string is not found or ambiguous.",parameters:{type:"object",properties:{path:h("Workspace-relative file path"),old:h("Exact text to replace"),new:h("Replacement text")},required:["path","old","new"]},async run(e,n){let s=E(n.workspace,String(e.path)),r=String(e.old),a=String(e.new),i=ue(s,"utf8"),c=i.indexOf(r);return c===-1?"error: old string not found":i.indexOf(r,c+1)!==-1?"error: old string appears more than once \u2014 add more context":(pe(s+".tmp",i.slice(0,c)+a+i.slice(c+r.length),"utf8"),je(s+".tmp",s),`edited ${e.path}`)}},{name:"fs_list",description:"List files in the workspace.",parameters:{type:"object",properties:{path:h("Workspace-relative directory (default '.')"),depth:k("Recursion depth, default 2")}},async run(e,n){let s=E(n.workspace,String(e.path??".")),r=Number(e.depth??2),a=[],i=(c,u)=>{if(u>r)return;let l=[];try{l=De(c)}catch{return}for(let g of l){if(g.startsWith("."))continue;let d=B(c,g),p=null;try{p=Ie(d)}catch{continue}p.isDirectory()?(a.push(`${Y(n.workspace,d)}/`),i(d,u+1)):a.push(`${Y(n.workspace,d)} (${p.size}b)`)}};return i(s,0),a.length>0?a.join(`
`):"(empty)"}}),o.tools.memory&&t.push({name:"memory_append",description:`Append a note to today's daily memory file (memory/${_()}.md).`,parameters:{type:"object",properties:{note:h("Markdown note to append")},required:["note"]},async run(e,n){let s=_();return me(B(n.workspace,"memory"),{recursive:!0}),Oe(B(n.workspace,"memory",`${s}.md`),`
- ${String(e.note).replace(/\n/g," ")}
`,"utf8"),`noted in memory/${s}.md`}},{name:"memory_search",description:"Search past messages in this session's transcript.",parameters:{type:"object",properties:{query:h("Search terms"),limit:k("Max results (default 8)")},required:["query"]},async run(e,n){let s=n.store.searchMessages(n.config.agents.defaults.id,String(e.query),Number(e.limit??8));return s.length===0?"no matches":s.map(r=>`[${new Date(r.created_at).toISOString().slice(0,16)}] ${r.role}: ${r.content.slice(0,400)}`).join(`

`)}}),o.tools.web.fetch&&t.push({name:"web_fetch",description:"Fetch a URL and return readable text (tags/scripts stripped, truncated).",parameters:{type:"object",properties:{url:h("Absolute http(s) URL"),maxChars:k("Max characters to return (default 12000)")},required:["url"]},async run(e,n){let s=String(e.url);if(!/^https?:\/\//i.test(s))return"error: only http(s) URLs are allowed";let r=await fetch(s,{signal:n.signal,headers:{"user-agent":"SuparClaw/0.1 (+fetch)",accept:"text/html,text/plain,*/*"},redirect:"follow"});if(!r.ok)return`error: HTTP ${r.status}`;let i=(await r.text()).slice(0,4e5).replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/\s+/g," ").trim(),c=Number(e.maxChars??12e3);return i.length>c?i.slice(0,c)+`

[truncated]`:i}}),o.tools.web.search&&t.push({name:"web_search",description:"Search the web (DuckDuckGo HTML endpoint) and return result titles, URLs and snippets.",parameters:{type:"object",properties:{query:h("Search query"),limit:k("Max results (default 6)")},required:["query"]},async run(e,n){let s=encodeURIComponent(String(e.query)),r=await fetch(`https://html.duckduckgo.com/html/?q=${s}`,{signal:n.signal,headers:{"user-agent":"Mozilla/5.0 (Linux; Android) SuparClaw/0.1"}});if(!r.ok)return`error: HTTP ${r.status}`;let a=await r.text(),i=[],c=/<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g,u;for(;(u=c.exec(a))!==null&&i.length<Number(e.limit??6);){let l=(u[2]??"").replace(/<[^>]+>/g,"").trim(),g=(u[3]??"").replace(/<[^>]+>/g,"").trim(),d=decodeURIComponent(/uddg=([^&]+)/.exec(u[1]??"")?.[1]??u[1]??"");i.push(`${l}
${d}
${g}`)}return i.length>0?i.join(`

`):"no results"}}),t.push({name:"time_now",description:"Current local date and time.",parameters:{type:"object",properties:{}},async run(){let e=new Date;return`${e.toISOString()} \xB7 local ${e.toString()}`}}),t.push({name:"skill_list",description:"List installed skills with their descriptions and when to use them.",parameters:{type:"object",properties:{}},async run(e,n){let s=n.skills.filter(r=>!r.disableModelInvocation);return s.length===0?"no skills installed":s.map(r=>`${r.eligible?"":"(unavailable) "}${r.name}: ${r.description}${r.readWhen.length?` [use when: ${r.readWhen.join("; ")}]`:""}`).join(`
`)}},{name:"skill_read",description:"Load a skill's full instructions by name. Call this before following a skill's workflow.",parameters:{type:"object",properties:{name:h("Skill name")},required:["name"]},async run(e,n){let s=n.skills.find(r=>r.name===String(e.name));return s?s.eligible?`# Skill: ${s.name}

${T(s)}`:`error: skill ${s.name} is unavailable (${s.reason})`:`error: no skill named ${e.name}`}}),o.tools.exec.enabled&&t.push({name:"exec",description:"Run a shell command inside the workspace. Requires user approval. Disabled by default.",parameters:{type:"object",properties:{command:h("Command line to run"),timeoutMs:k("Timeout in ms")},required:["command"]},needsApproval:!0,async run(e,n){if(o.tools.exec.approvals&&!n.approved)return"error: execution needs approval \u2014 ask the user to approve, then retry";let{execFile:s}=await import("node:child_process"),r=Math.min(Number(e.timeoutMs??o.tools.exec.timeoutMs),6e5);return await new Promise(a=>{s("/data/data/com.termux/files/usr/bin/bash",["-lc",String(e.command)],{cwd:n.workspace,timeout:r,maxBuffer:1e6},(i,c,u)=>{let l=[];c&&l.push(c),u&&l.push(`[stderr] ${u}`),i&&l.push(`[exit ${typeof i.code=="number"?i.code:1}] ${i.message}`),a(l.join(`
`).slice(0,6e4)||"(no output)")})})}}),t}function he(o){return o.map(t=>({type:"function",function:{name:t.name,description:t.description,parameters:t.parameters}}))}var v=class extends Error{constructor(e,n,s=!1){super(e);this.status=n;this.retryable=s;this.name="LlmError"}status;retryable};function We(o,t){let e=o.indexOf("/"),n=e>0?o.slice(0,e):"",s=e>0?o.slice(e+1):o,r=n?t[n]:void 0;if(!r){let i=Object.keys(t);throw new v(`unknown provider "${n||"(default)"}" \u2014 configured providers: ${i.length>0?i.join(", "):"none"}`)}let a=(r.baseUrl||"https://api.openai.com/v1").replace(/\/+$/,"");return{provider:n,model:s||(r.models?.[0]??""),baseUrl:a,apiKey:r.apiKey,headers:r.headers??{}}}var Ue=new Set([408,409,425,429,500,502,503,504]),M=class{constructor(t,e,n){this.onRetry=n;this.#e=t,this.#t=e}onRetry;#e;#t;setConfig(t,e){this.#e=t,this.#t=e}listModels(){let t=[];for(let[e,n]of Object.entries(this.#e))for(let s of n.models??[])t.push(`${e}/${s}`);return t.length===0&&this.#t.model&&t.push(this.#t.model),t}async*stream(t){let e=[this.#t.model,...this.#t.fallbacks].filter(Boolean);if(e.length===0)throw new v("no model configured \u2014 set agents.defaults.model and a provider");let n=null;for(let s of e)for(let r=0;r<3;r++)try{yield*this.#n(s,t);return}catch(a){let i=a;n=i;let c=i.retryable||!(i instanceof v);if(this.onRetry?.({model:s,attempt:r+1,error:i.message}),!c||t.signal?.aborted)break;await Be(Math.min(4e3,250*2**r))}throw n??new v("model call failed")}async*#n(t,e){let n=We(t,this.#e),s={model:n.model,messages:e.messages,stream:!0,stream_options:{include_usage:!0}};e.tools?.length&&(s.tools=e.tools),e.temperature!==void 0&&(s.temperature=e.temperature),e.maxTokens!==void 0&&(s.max_tokens=e.maxTokens);let r;try{r=await fetch(`${n.baseUrl}/chat/completions`,{method:"POST",headers:{"content-type":"application/json",accept:"text/event-stream",...n.apiKey?{authorization:`Bearer ${n.apiKey}`}:{},...n.headers},body:JSON.stringify(s),signal:e.signal})}catch(l){throw l.name==="AbortError"?l:new v(`network: ${l.message}`,void 0,!0)}if(!r.ok){let l=await r.text().catch(()=>"");throw new v(`HTTP ${r.status} from ${n.provider}: ${l.slice(0,300)||r.statusText}`,r.status,Ue.has(r.status))}if(!r.body)throw new v("provider returned an empty stream",void 0,!0);let a=new Map,i="stop",c=null;for await(let l of Ne(r.body)){if(l==="[DONE]")break;let g;try{g=JSON.parse(l)}catch{continue}g.usage&&(c=g.usage);let d=g.choices?.[0];if(!d)continue;d.finish_reason&&(i=d.finish_reason);let p=d.delta??{},f=p.content;typeof f=="string"&&f.length>0&&(yield{type:"text",text:f});let w=p.tool_calls;if(Array.isArray(w))for(let y of w){let S=y.index??0,b=a.get(S)??{id:"",name:"",args:""};y.id&&(b.id=y.id),y.function?.name&&(b.name+=y.function.name),y.function?.arguments&&(b.args+=y.function.arguments),a.set(S,b)}}let u=[...a.values()].filter(l=>l.name.length>0);u.length>0&&(yield{type:"tool_calls",calls:u}),c&&(yield{type:"usage",usage:c}),yield{type:"done",finishReason:i}}};async function*Ne(o){let t=o.getReader(),e=new TextDecoder,n="";for(;;){let{done:r,value:a}=await t.read();if(r)break;n+=e.decode(a,{stream:!0});let i;for(;(i=n.indexOf(`

`))!==-1;){let c=n.slice(0,i);n=n.slice(i+2);let u=c.split(`
`).filter(l=>l.startsWith("data:")).map(l=>l.slice(5).trim()).join(`
`);u&&(yield u)}}let s=n.trim();s.startsWith("data:")&&(yield s.slice(5).trim())}function Be(o){return new Promise(t=>setTimeout(t,o))}function ye(o){if(!o.trim())return{};try{let t=JSON.parse(o);return t&&typeof t=="object"?t:{}}catch{return{_parseError:`invalid JSON arguments: ${o.slice(0,200)}`}}}var Ye=`You are SuparClaw, a personal AI agent running on the user's own device.

Operating rules:
- Be genuinely helpful, not performatively helpful. Skip filler, just help.
- Be resourceful before asking: read the file, check context, then answer.
- Prefer doing the task over describing the task. Use tools instead of guessing.
- Tools run on a phone: prefer one or two targeted calls over broad scans.
- Never claim a tool result you did not receive. If a tool fails, say so plainly.
- Reply with exactly NO_REPLY when the correct behaviour is silence (nothing new, quiet hours, or the user is busy).
- Keep replies conversational and compact. This is a chat surface, not a report.`,P=class{constructor(t){this.deps=t;this.workspace=$(),this.tools=t.tools??fe(t.config),this.skills=ce({roots:[{label:"workspace",dir:`${this.workspace}/skills`},{label:"state",dir:H()},{label:"bundled",dir:le()}]}),this.llm=t.llm??new M(t.config.providers,{model:t.config.agents.defaults.model,fallbacks:t.config.agents.defaults.fallbacks},e=>t.log.warn(`llm retry ${e.model} #${e.attempt}: ${e.error}`))}deps;tools;skills;llm;workspace;#e=new Map;#t=new Map;isBusy(t){return this.#e.has(t)}busySessions(){return[...this.#e.keys()]}abort(t){let e=this.#e.get(t);return e?(e.controller.abort(),!0):!1}async run(t){let{sessionKey:e,onEvent:n}=t,s=this.deps.config.agents.defaults.queueMode;if(this.isBusy(e)){if(s==="followup"){let d=this.#t.get(e)??[];d.push(t.text),this.#t.set(e,d),this.deps.log.info(`queued message for ${e} (${d.length} pending)`),n({type:"idle",sessionKey:e});return}this.abort(e)}let r=Ke(),a=new AbortController;this.#e.set(e,{runId:r,controller:a}),n({type:"start",runId:r,sessionKey:e});let i=this.deps.store.ensureSession(e),c=t.isMainSession??e.endsWith(":main");this.deps.store.appendMessage(i.id,"user",t.text,r),this.deps.store.startRun(i.id,r);let u="",l;try{let d=this.#n(i.id,e,t,c),p=he(this.tools),f={workspace:this.workspace,stateDir:this.deps.store.getMeta("state_dir")??$(),skills:this.skills,store:this.deps.store,log:this.deps.log,config:this.deps.config,approved:!1,signal:a.signal};for(let y=0;y<this.deps.config.agents.defaults.maxToolIterations;y++){let S="",b=[];for await(let m of this.llm.stream({messages:d,tools:p.length>0?p:void 0,signal:a.signal}))m.type==="text"?(S+=m.text,u+=m.text,n({type:"delta",text:m.text})):m.type==="tool_calls"?b=m.calls:m.type==="usage"&&(l=m.usage);if(b.length===0)break;d.push({role:"assistant",content:S.length>0?S:null,tool_calls:b});for(let m of b){let D=this.tools.find(j=>j.name===m.name),F=Date.now();if(!D){d.push({role:"tool",tool_call_id:m.id,name:m.name,content:`error: unknown tool ${m.name}`}),n({type:"tool",callId:m.id,name:m.name,status:"error",detail:"unknown tool"});continue}let O=ye(m.args);n({type:"tool",callId:m.id,name:m.name,status:"running"});let I=!0;D.needsApproval&&this.deps.config.tools.exec.approvals&&(n({type:"approval",callId:m.id,tool:m.name,args:O}),I=await this.deps.requestApproval?.(m.id,m.name,O)??!1);let x;try{x=I?await D.run(O,{...f,approved:!0}):"error: user declined this action",this.deps.store.logTool(r,m.name,I?"ok":"declined",Date.now()-F),this.deps.store.appendMessage(i.id,"tool",`\u2192 ${m.name}
${x.slice(0,4e3)}`,r)}catch(j){x=`error: ${j.message}`,this.deps.store.logTool(r,m.name,"error",Date.now()-F)}let ve=x.startsWith("error");n({type:"tool",callId:m.id,name:m.name,status:ve?"error":"done",detail:x.slice(0,200)}),d.push({role:"tool",tool_call_id:m.id,name:m.name,content:x})}}let w=u.trim()||"(no response)";this.deps.store.appendMessage(i.id,"assistant",w,r),this.deps.store.finishRun(r,"done",l),n({type:"final",runId:r,text:w,usage:l})}catch(d){let p=d.message,f=d.name==="AbortError";this.deps.store.finishRun(r,f?"aborted":"error",l,p),f||(this.deps.log.error(`run ${r} failed: ${p}`),n({type:"error",runId:r,message:p}))}finally{this.#e.delete(e),n({type:"idle",sessionKey:e})}let g=this.#t.get(e);if(g&&g.length>0){let[d,...p]=g;this.#t.set(e,p),await this.run({...t,text:d})}}#n(t,e,n,s){let r=this.deps.config.agents.defaults.contextBudgetChars,a=this.deps.store.recentMessages(t,80),i=[],c=0;for(let p=a.length-1;p>=0;p--){let f=a[p];if(f.role==="tool")continue;let w=f.role==="user"?{role:"user",content:f.content}:{role:"assistant",content:f.content};if(c+w.content.length>r)break;c+=w.content.length,i.unshift(w)}i.length>0&&i[i.length-1]?.role==="user"&&i.pop();let u=ne(this.workspace,{isMainSession:s}),g=de(this.skills,n.text).filter(p=>p.eligible).map(p=>`# Skill: ${p.name}

${T(p)}`);return[{role:"system",content:[Ye,`Current date: ${new Date().toString()}`,`Session: ${e}`,N(this.skills),g.length>0?`## Skills loaded for this turn

${g.join(`

`)}`:"",u.text,`Today's note file: memory/${_()}.md`].filter(Boolean).join(`

`)},...i,{role:"user",content:n.text}]}};async function Fe(o){let{Bot:t}=await import("./mod-WMKNEDXV.js");return new t(o)}var A=class{constructor(t,e){this.service=t;this.log=e}service;log;#e=null;#t=new Map;#n="";running=!1;get username(){return this.#n}async start(){let t=this.service.config.channels.telegram;if(!t.token)throw new Error("telegram.token is empty");let e=await Fe(t.token);this.#e=e,e.on("message",s=>{this.#i(s).catch(r=>this.log.error(`telegram message failed: ${r.message}`))});let n=await e.api.getMe();this.#n=n.username,this.running=!0,this.log.info(`telegram online as @${n.username}`),e.start({drop_pending_updates:!1,onStart:s=>this.log.info(`telegram polling @${s.username}`)}).catch(s=>{this.running=!1,this.log.error(`telegram polling stopped: ${s.message}`)})}async stop(){for(let t of this.#t.values())clearTimeout(t.timer);this.#t.clear();try{await this.#e?.stop()}catch{}this.running=!1}#r(t){return this.service.config.channels.telegram.allowFrom.includes(String(t))}#o(t){let e=this.service.config.channels.telegram;return e.groupPolicy==="open"||e.groupAllowFrom.includes(String(t))}async#i(t){let e=this.service.config.channels.telegram,n=t.message;if(!n)return;let s=t.chat?.id,r=t.from?.id;if(s===void 0||r===void 0)return;let a=t.chat?.type==="group"||t.chat?.type==="supergroup",i=n.text??n.caption??"",c=this.#n.length>0&&i.includes(`@${this.#n}`),u=n.reply_to_message?await this.#a(t,n.reply_to_message.from?.id):!1;if(a){if(e.groupPolicy==="off"||!this.#o(s)||e.mentionGated&&!c&&!u)return}else{if(e.dmPolicy==="allowlist"&&!this.#r(r)){await t.reply(`Not allowed yet. Ask the owner to run:

  sc pair approve ${r}`);return}if(e.dmPolicy==="pairing"&&!this.#r(r)){await t.reply(`Pairing required for this account.

Owner command:
  sc pair approve ${r}

Your Telegram id: ${r}`);return}}if(!i.trim())return;let l=`${s}`,g=n.message_thread_id,d=`telegram:${s}${g?`:topic:${g}`:a?":group":""}`,p=this.#t.get(l);if(p){p.texts.push(i),clearTimeout(p.timer),p.timer=setTimeout(()=>{this.#s(l)},e.batchMs);return}let f={texts:[i],firstAt:Date.now(),timer:setTimeout(()=>{this.#s(l)},e.batchMs)};this.#t.set(l,f)}async#a(t,e){if(e===void 0)return!1;try{let n=await t.api.getMe();return e===n.id}catch{return!1}}async#s(t){let e=this.#t.get(t);if(!e)return;this.#t.delete(t);let n=this.#e;if(!n)return;let s=e.texts.join(`

`).slice(0,8e3),r=Number(t),a=await n.api.sendMessage(r,"\u2026",{link_preview_options:{is_disabled:!0}}).catch(()=>null),i=0,c=[],u=this.service.config.channels.telegram;await this.service.send({sessionKey:t.startsWith("telegram:")?t:`telegram:${t}`,text:s,isMainSession:!1,source:"telegram",onDelta:async()=>{if(!a||u.streaming==="off")return;let l=Date.now();l-i<2e3||(i=l,await n.api.editMessageText(r,a.message_id,"\u258C working\u2026",{link_preview_options:{is_disabled:!0}}).catch(()=>{}))},onTool:async l=>{!a||u.streaming==="off"||(c=[...c.slice(-4),`\xB7 ${l.name}`],await n.api.editMessageText(r,a.message_id,`\u258C working\u2026
${c.join(`
`)}`).catch(()=>{}))},reply:async l=>{let g=Je(l);if(!a){for(let d of g)await n.api.sendMessage(r,d).catch(()=>{});return}await n.api.editMessageText(r,a.message_id,g[0]??"(empty)",{link_preview_options:{is_disabled:!0}}).catch(()=>{});for(let d of g.slice(1))await n.api.sendMessage(r,d).catch(()=>{})}})}};function Je(o,t=4e3){if(o.length<=t)return[o];let e=[],n=o;for(;n.length>t;){let s=n.slice(0,t),r=Math.max(s.lastIndexOf(`

`),s.lastIndexOf(`
`),s.lastIndexOf(" ")),a=r>t*.5?r:t;e.push(n.slice(0,a).trim()),n=n.slice(a).trimStart()}return n.length>0&&e.push(n),e}async function Ge(o,t,e){let{Cron:n}=await import("./croner-3P7MMEQK.js");return new n(o,{protect:e},t)}var L=class{#e=new Map;store;log;fire;constructor(t,e,n){this.store=t,this.log=e,this.fire=n}get count(){return this.#e.size}async start(){for(let t of this.store.listJobs())t.enabled&&await this.#t(t)}async#t(t){this.#e.get(t.id)?.stop();try{let e=await Ge(t.schedule,async()=>{try{await this.fire(t),this.store.recordJobRun(t.id,"done","")}catch(n){this.store.recordJobRun(t.id,"error",n.message),this.log.error(`cron ${t.name} failed: ${n.message}`)}},!0);this.#e.set(t.id,e),this.log.info(`cron armed: ${t.name} (${t.schedule})`)}catch(e){this.log.error(`cron ${t.name} has an invalid schedule: ${e.message}`)}}async reload(){this.stop(),await this.start()}async upsert(t){let e=this.store.upsertJob(t);return e.enabled?await this.#t(e):this.#e.get(e.id)?.stop(),e}remove(t){let e=this.store.getJob(t)!==void 0;return this.#e.get(t)?.stop(),this.#e.delete(t),this.store.deleteJob(t),e}stop(){for(let t of this.#e.values())t.stop();this.#e.clear()}};var Ve=9e4,be=class{log;configSvc;store;loop;events=new He;startedAt=Date.now();#e=null;#t=null;#n=new Map;#r=!1;constructor(t){V(),this.log=ee({file:we(z(),"suparclaw.log")}),this.configSvc=new Z(this.log,t),this.store=Q.open(G()),this.store.setMeta("state_dir",J());let e=this.configSvc.current,n=new M(e.providers,{model:e.agents.defaults.model,fallbacks:e.agents.defaults.fallbacks},s=>this.log.warn(`llm retry ${s.model} #${s.attempt}: ${s.error}`));this.loop=new P({config:e,store:this.store,log:this.log,llm:n,requestApproval:(s,r,a)=>this.requestApproval(s,r,a)}),this.events.setMaxListeners(64)}get config(){return this.configSvc.current}bootstrap(){let t=[],e=$();ze(we(e,"AGENTS.md"))||t.push(...re(e));let n=this.config.gateway.auth.token;if(this.config.gateway.auth.mode==="token"&&!n){n=crypto.randomUUID().replace(/-/g,"")+crypto.randomUUID().replace(/-/g,"");let s=this.configSvc.setPath("gateway.auth.token",n);s.ok||this.log.error(`could not persist gateway token: ${s.errors[0]}`),t.push("config.json5 (gateway token)")}return{created:t,token:n}}applyConfig(t){let e=this.config;this.loop.llm.setConfig(e.providers,e.agents.defaults),this.log.info(`config applied \u2014 model ${e.agents.defaults.model||"(unset)"}`)}async startChannels(){let t=this.config;if(t.cron.enabled&&(this.#t=new L(this.store,this.log,e=>this.send({sessionKey:e.session_key,text:e.prompt,isMainSession:!1,source:"cron",reply:async n=>{this.store.recordJobRun(e.id,"done",n.slice(0,2e3))}})),await this.#t.start(),this.log.info(`cron scheduler started (${this.#t.count} jobs)`)),t.channels.telegram.enabled&&t.channels.telegram.token){this.#e=new A(this,this.log);try{await this.#e.start()}catch(e){this.log.error(`telegram failed to start: ${e.message}`)}}}async send(t){this.events.emit("event",{type:"chat",sessionKey:t.sessionKey,event:{type:"start",runId:crypto.randomUUID(),sessionKey:t.sessionKey}}),await this.loop.run({sessionKey:t.sessionKey,text:t.text,isMainSession:t.isMainSession,onEvent:e=>{this.events.emit("event",{type:"chat",sessionKey:t.sessionKey,event:e}),e.type==="delta"?t.onDelta?.(e.text):e.type==="tool"?t.onTool?.(e):e.type==="approval"?t.onApproval?.(e):e.type==="final"?t.reply(e.text):e.type==="error"&&t.reply(`\u26A0 ${e.message}`)}})}requestApproval(t,e,n){return this.log.info(`approval requested: ${e} ${JSON.stringify(n).slice(0,200)}`),new Promise(s=>{let r=setTimeout(()=>{this.#n.delete(t),s(!1)},Ve);this.#n.set(t,a=>{clearTimeout(r),s(a)})})}resolveApproval(t,e){let n=this.#n.get(t);return n?(n(e),!0):!1}subscribe(t){return this.events.on("event",t),()=>this.events.off("event",t)}health(){return{ok:!0,version:"0.1.0",uptimeMs:Date.now()-this.startedAt,sessions:this.store.listSessions(200).length,busy:this.loop.busySessions()}}status(){let t=this.config;return{model:t.agents.defaults.model||"(unset)",fallbacks:t.agents.defaults.fallbacks,providers:Object.keys(t.providers),tools:this.loop.tools.map(e=>e.name),skills:this.loop.skills.map(e=>({name:e.name,root:e.root,eligible:e.eligible})),telegram:{enabled:t.channels.telegram.enabled,running:this.#e?.running??!1,dmPolicy:t.channels.telegram.dmPolicy},cron:{enabled:t.cron.enabled,jobs:this.#t?.count??0},workspace:$()}}async stop(){this.#r||(this.#r=!0,this.configSvc.stop(),this.#t?.stop(),await this.#e?.stop(),this.store.close(),this.log.info("service stopped"))}};export{le as a,ce as b,be as c};
