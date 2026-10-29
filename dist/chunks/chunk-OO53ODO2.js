import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);
import{a as u}from"./chunk-YLPL3IHV.js";import{existsSync as y,readFileSync as _,writeFileSync as $,mkdirSync as U}from"node:fs";import{join as h}from"node:path";var F=[{name:"AGENTS.md",budget:8e3},{name:"SOUL.md",budget:6e3},{name:"USER.md",budget:4e3},{name:"IDENTITY.md",budget:1500},{name:"TOOLS.md",budget:4e3},{name:"MEMORY.md",budget:8e3,mainSessionOnly:!0}],P=3e3,B=2;function x(n,o){if(!y(n))return null;let t="";try{t=_(n,"utf8")}catch{return null}return t.trim().length===0?null:t.length<=o?{body:t.trim(),truncated:!1}:{body:t.slice(0,o).trim()+`

[truncated]`,truncated:!0}}u(x,"readCapped");function H(n,o=new Date){let t=h(n,"memory"),s=[];for(let r=0;r<B;r++){let c=`memory/${new Date(o.getTime()-r*864e5).toISOString().slice(0,10)}.md`,i=x(h(n,c),P);i&&s.push(`## ${c}

${i.body}`)}return s}u(H,"dailyNotes");function se(n,o={isMainSession:!0}){let t=[],s=[],r=[];for(let i of o.lightContext?[]:F){if(i.mainSessionOnly&&!o.isMainSession)continue;let l=x(h(n,i.name),i.budget);l&&(t.push(i.name),l.truncated&&s.push(i.name),r.push(`## ${i.name}

${l.body}`))}let e=o.lightContext?null:x(h(n,"BOOTSTRAP.md"),4e3);e&&(t.push("BOOTSTRAP.md"),r.unshift(`## BOOTSTRAP.md (first-run setup \u2014 follow it, then delete the file)

`+e.body));let c=o.lightContext?[]:H(n,o.today);return c.length>0&&(t.push("memory/*.md"),r.push(`## Recent daily notes

${c.join(`

`)}`)),{text:r.length>0?`# Project Context

${r.join(`

`)}`:"",included:t,truncated:s}}u(se,"loadWorkspaceContext");function ie(n=new Date){return n.toISOString().slice(0,10)}u(ie,"todayStamp");var W={"AGENTS.md":`# AGENTS.md - Workspace Rules

Keep workspace conventions here. Personality belongs in SOUL.md.

## First Run

If \`BOOTSTRAP.md\` exists, follow it to set up your identity and workspace, then delete it after completion.

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
`,"BOOTSTRAP.md":`# BOOTSTRAP.md - Birth Sequence

_You just woke up. Keep this first conversation short and make it yours._

There is no memory yet; it is normal that \`memory/\` does not exist until you create it.

**The user's request always comes first.** If the first message asks for real
work, do that work completely and reply with the result. Do not open with
introductions, do not ask what to call you, and do not wait for answers the
task does not need; save the birth sequence for after the work is delivered or
for a quiet moment. This file is a ritual, not a gate.

Complete these beats. Do not turn them into a questionnaire or a long biography.

## 1. Ask What to Call You

Introduce yourself as the user's new assistant, then ask what they would like
to call you. Do not choose, invent, or suggest a name for yourself. Wait for
their answer before moving on.

## 2. Choose Your Vibe

Give one short soul/vibe line that feels true to you. The user can veto or
adjust it once. Pick a signature emoji too.

Keep the agreed name, vibe, and emoji in the conversation until the identity
is settled. Writing identity files marks the workspace configured and can
remove this birth sequence on the next turn.

## 3. Save Your Identity

After the name and vibe are settled, persist the identity twice \u2014 both places
matter:

1. Write \`IDENTITY.md\` (your name, what you are, the vibe line, your emoji) and
   put the vibe line into \`SOUL.md\`. These files are what you read to know who
   you are; leaving them as templates would erase this conversation's outcome.
2. Run the existing config command so channels and the UI show the same identity:

\`\`\`bash
sc config set agents.identity.name "<name>"
sc config set agents.identity.emoji "<emoji>"
sc config set agents.identity.theme "<vibe>"
\`\`\`

Use safe quoting for the values. Verify the command succeeds before saying the
identity is saved.

## Done

When the identity is saved, delete this file. Then say one line:

> Ask me anything; I am here on your device.

Once the file is removed, SuparClaw treats the birth sequence as complete and
will not recreate \`BOOTSTRAP.md\`. If you leave the file behind, SuparClaw
removes it for you once the workspace looks configured. A workspace counts as
configured when \`SOUL.md\`, \`IDENTITY.md\`, or \`USER.md\` has diverged from
its starter template, or a \`memory/\` folder exists.
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
`};function ae(n){U(h(n,"memory"),{recursive:!0});let o=[],t=!y(h(n,"SOUL.md"))&&!y(h(n,"IDENTITY.md"))&&!y(h(n,"USER.md"));for(let[s,r]of Object.entries(W)){if(s==="BOOTSTRAP.md"&&!t)continue;let e=h(n,s);y(e)||($(e,r,"utf8"),o.push(s))}return o}u(ae,"writeWorkspaceTemplates");import{readFileSync as j,readdirSync as q,existsSync as z}from"node:fs";import{join as S}from"node:path";var C=6,N=.35,M=30,K=.7,k=1600,O=420,G=.05;function T(n){return(n.normalize("NFC").toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’._/-]*/gu)??[]).map(o=>o.normalize("NFD")).filter(o=>o.length>1||new RegExp("\\p{N}","u").test(o))}u(T,"tokenize");function V(n){let o=n.split(/\n{2,}/).map(e=>e.trim()).filter(Boolean),t=[];for(let e=0;e<o.length;e++){let c=o[e];if(/^#{1,6}\s+\S/.test(c)&&!/\n/.test(c)&&o[e+1]){o[e+1]=`${c}

${o[e+1]}`;continue}if(c.length>k){let i="";for(let l of c.split(`
`))i&&i.length+l.length+1>k&&(t.push(i),i=""),i=i?`${i}
${l}`:l;i&&t.push(i)}else t.push(c)}for(let e=0;e<t.length-1;e++)/^#{1,6}\s+\S+$/.test(t[e].trim())&&(t[e+1]=`${t[e]}

${t[e+1]}`,t.splice(e,1),e--);let s=[],r="";for(let e of t)r&&r.length+e.length+2>k?(s.push({text:r,importance:v(r)}),r=e):r=r?`${r}

${e}`:e;return r&&s.push({text:r,importance:v(r)}),s}u(V,"chunkMarkdown");function v(n){let o=null;for(let t of n.matchAll(/<!--\s*importance:\s*(\d{1,2})\s*-->/gi)){let s=Math.min(10,Math.max(1,Number(t[1])));o=o===null?s:Math.max(o,s)}return o}u(v,"importanceOf");function I(n){return n.replace(/<!--[\s\S]*?-->/g," ")}u(I,"stripAnnotations");function X(n){let o=/(^|\/)(\d{4})-(\d{2})-(\d{2})(?:-\S+)?\.md$/.exec(n);if(!o)return null;let t=Date.parse(`${o[2]}-${o[3]}-${o[4]}T00:00:00Z`);return Number.isFinite(t)?t:null}u(X,"datedNoteDate");function Z(n,o=M){return!Number.isFinite(n)||n<=0?1:Math.pow(2,-n/o)}u(Z,"decayFactor");function J(n,o,t){if(o.length===0||n.length===0)return{rel:0,present:0};let s=new Map;for(let l of n)s.set(l,(s.get(l)??0)+1);let r=0,e=0,c=0;for(let l of o){let d=t.get(l)??1;e+=d;let f=s.get(l)??0;f>0&&(c++,r+=d*(f/(f+1.2)))}let i=1+Math.sqrt(n.length/200);return{rel:r/((e||1)*i),present:c}}u(J,"relevance");function Q(n,o){let t=n.replace(/\.md$/i,"").toLowerCase(),s=t.split("/").pop()??t,r=0;for(let e of o)s===e?r=Math.max(r,.6):t.split(/[/\s_-]+|\./).includes(e)&&(r=Math.max(r,.3));return r}u(Q,"pathBonus");function ee(n){return n===null?1:1+G*n}u(ee,"importanceMultiplier");function te(n,o){let t=n.replace(/<!--\s*(importance|trigger):[^>]*-->/gi,"").replace(/\s+/g," ").trim();if(t.length<=O)return t;let s=t.toLowerCase().normalize("NFD"),r=-1;for(let c of o){let i=s.indexOf(c);i!==-1&&(r===-1||i<r)&&(r=i)}let e=Math.max(0,(r===-1?0:r)-60);return(e>0?"\u2026":"")+t.slice(e,e+O).trim()+"\u2026"}u(te,"makeSnippet");function A(n,o,t){let s=[...new Set(T(o))].slice(0,32);if(s.length===0||n.length===0)return[];let r=n.map(a=>new Set(a.tokens)),e=new Map(s.map(a=>[a,0]));for(let a of r)for(let m of s)a.has(m)&&e.set(m,(e.get(m)??0)+1);let c=n.map((a,m)=>m).filter(a=>s.every(m=>r[a].has(m))),i=c.length>0,d=(i?c:n.map((a,m)=>m).filter(a=>s.some(m=>r[a].has(m)))).slice(0,50).map(a=>n[a]),f=d.length||1,b=new Map(s.map(a=>[a,Math.log(1+(f-(e.get(a)??0)+.5)/((e.get(a)??0)+.5))])),p=[];for(let a of d){let{rel:m,present:L}=J(a.tokens,s,b);if(m<=0)continue;let w=i?m:m*(L/s.length);w=Math.min(1,w+Q(a.source,s));let D=w*ee(a.importance),Y=a.dateNum===null?0:Math.max(0,(t.now-a.dateNum)/864e5),R=a.dateNum===null?1:Z(Y,t.halfLifeDays);p.push({source:a.source,snippet:te(a.text,s),date:a.dateNum===null?null:new Date(a.dateNum).toISOString().slice(0,10),preDecay:D,score:D*R,decay:R,importance:a.importance,tokens:new Set(a.tokens)})}let g=p.filter(a=>a.preDecay>=t.minScore);return g.length===0&&p.length>0&&(g=[p.slice().sort((a,m)=>m.preDecay-a.preDecay)[0]]),E(g).slice(0,t.maxResults)}u(A,"rankPool");function E(n,o=K){let t=n.map(e=>({h:e,mmrScore:e.score,picked:!1})),s=[],r=[];for(;s.length<n.length;){let e=-1,c=-1/0;for(let i=0;i<t.length;i++){let l=t[i];if(l.picked)continue;let d=0;for(let b of r){let p=[...l.h.tokens].filter(a=>b.has(a)).length,g=l.h.tokens.size+b.size-p;g>0&&(d=Math.max(d,p/g))}let f=o*l.h.score-(1-o)*d;f>c&&(c=f,e=i)}if(e===-1)break;t[e].picked=!0,r.push(t[e].h.tokens),s.push(t[e].h)}return s}u(E,"mmrReorder");function de(n,o,t={}){let s={maxResults:Math.max(1,t.maxResults??C),minScore:t.minScore??N,halfLifeDays:t.halfLifeDays??M,now:t.now??Date.now()},r=[];for(let e of ne(n)){let c;try{c=j(S(n,e),"utf8")}catch{continue}let i=X(e);for(let l of V(c))r.push({source:e,dateNum:i,text:l.text,importance:l.importance,tokens:T(I(l.text))})}return A(r,o,s)}u(de,"searchMemoryFiles");function he(n,o,t,s={}){let r={maxResults:Math.max(1,s.maxResults??C),minScore:s.minScore??N,halfLifeDays:s.halfLifeDays??M,now:s.now??Date.now()},e=n.map(i=>({source:`session \xB7 ${i.session_key} \xB7 ${i.role}`,dateNum:i.created_at,text:i.content,importance:v(i.content),tokens:T(I(i.content))})),c=A(e,o,{...r,maxResults:50});return E([...t,...c]).slice(0,r.maxResults)}u(he,"rankTranscriptHits");function ne(n){let o=[];for(let r of["MEMORY.md","USER.md"])z(S(n,r))&&o.push(r);let t=S(n,"memory"),s=u((r,e)=>{let c;try{c=q(S(t,r),{withFileTypes:!0})}catch{return}for(let i of c){let l=e?`${e}/${i.name}`:i.name;i.isDirectory()?s(l,l):/\.md$/i.test(i.name)&&o.push(`memory/${l}`)}},"walk");return s("",""),o.sort()}u(ne,"memoryFiles");export{se as a,ie as b,ae as c,T as d,v as e,I as f,X as g,de as h,he as i,ne as j};
