import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);
import{a as u}from"./chunk-YLPL3IHV.js";import{createHash as nt}from"node:crypto";import{appendFileSync as rt,existsSync as X,readFileSync as Q,readdirSync as st,statSync as ot,writeFileSync as me}from"node:fs";import{basename as it,join as ee}from"node:path";import{existsSync as je,mkdirSync as Be,readFileSync as K,writeFileSync as ce,appendFileSync as Ye}from"node:fs";import{join as C}from"node:path";import{readFileSync as Se,readdirSync as xe,existsSync as ke}from"node:fs";import{join as P}from"node:path";var re=6,se=.35,W=30,De=.7,H=1600,ne=420,ve=.05;function R(t){return(t.normalize("NFC").toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’._/-]*/gu)??[]).map(e=>e.normalize("NFD")).filter(e=>e.length>1||new RegExp("\\p{N}","u").test(e))}u(R,"tokenize");function $e(t){let e=t.split(/\n{2,}/).map(o=>o.trim()).filter(Boolean),r=[];for(let o=0;o<e.length;o++){let i=e[o];if(/^#{1,6}\s+\S/.test(i)&&!/\n/.test(i)&&e[o+1]){e[o+1]=`${i}

${e[o+1]}`;continue}if(i.length>H){let a="";for(let c of i.split(`
`))a&&a.length+c.length+1>H&&(r.push(a),a=""),a=a?`${a}
${c}`:c;a&&r.push(a)}else r.push(i)}for(let o=0;o<r.length-1;o++)/^#{1,6}\s+\S+$/.test(r[o].trim())&&(r[o+1]=`${r[o]}

${r[o+1]}`,r.splice(o,1),o--);let n=[],s="";for(let o of r)s&&s.length+o.length+2>H?(n.push({text:s,importance:E(s)}),s=o):s=s?`${s}

${o}`:o;return s&&n.push({text:s,importance:E(s)}),n}u($e,"chunkMarkdown");function E(t){let e=null;for(let r of t.matchAll(/<!--\s*importance:\s*(\d{1,2})\s*-->/gi)){let n=Math.min(10,Math.max(1,Number(r[1])));e=e===null?n:Math.max(e,n)}return e}u(E,"importanceOf");function M(t){return t.replace(/<!--[\s\S]*?-->/g," ")}u(M,"stripAnnotations");function _(t){let e=/(^|\/)(\d{4})-(\d{2})-(\d{2})(?:-\S+)?\.md$/.exec(t);if(!e)return null;let r=Date.parse(`${e[2]}-${e[3]}-${e[4]}T00:00:00Z`);return Number.isFinite(r)?r:null}u(_,"datedNoteDate");function Re(t,e=W){return!Number.isFinite(t)||t<=0?1:Math.pow(2,-t/e)}u(Re,"decayFactor");function Me(t,e,r){if(e.length===0||t.length===0)return{rel:0,present:0};let n=new Map;for(let c of t)n.set(c,(n.get(c)??0)+1);let s=0,o=0,i=0;for(let c of e){let h=r.get(c)??1;o+=h;let m=n.get(c)??0;m>0&&(i++,s+=h*(m/(m+1.2)))}let a=1+Math.sqrt(t.length/200);return{rel:s/((o||1)*a),present:i}}u(Me,"relevance");function Te(t,e){let r=t.replace(/\.md$/i,"").toLowerCase(),n=r.split("/").pop()??r,s=0;for(let o of e)n===o?s=Math.max(s,.6):r.split(/[/\s_-]+|\./).includes(o)&&(s=Math.max(s,.3));return s}u(Te,"pathBonus");function Ce(t){return t===null?1:1+ve*t}u(Ce,"importanceMultiplier");function Oe(t,e){let r=t.replace(/<!--\s*(importance|trigger):[^>]*-->/gi,"").replace(/\s+/g," ").trim();if(r.length<=ne)return r;let n=r.toLowerCase().normalize("NFD"),s=-1;for(let i of e){let a=n.indexOf(i);a!==-1&&(s===-1||a<s)&&(s=a)}let o=Math.max(0,(s===-1?0:s)-60);return(o>0?"\u2026":"")+r.slice(o,o+ne).trim()+"\u2026"}u(Oe,"makeSnippet");function oe(t,e,r){let n=[...new Set(R(e))].slice(0,32);if(n.length===0||t.length===0)return[];let s=t.map(l=>new Set(l.tokens)),o=new Map(n.map(l=>[l,0]));for(let l of s)for(let g of n)l.has(g)&&o.set(g,(o.get(g)??0)+1);let i=t.map((l,g)=>g).filter(l=>n.every(g=>s[l].has(g))),a=i.length>0,h=(a?i:t.map((l,g)=>g).filter(l=>n.some(g=>s[l].has(g)))).slice(0,50).map(l=>t[l]),m=h.length||1,p=new Map(n.map(l=>[l,Math.log(1+(m-(o.get(l)??0)+.5)/((o.get(l)??0)+.5))])),d=[];for(let l of h){let{rel:g,present:b}=Me(l.tokens,n,p);if(g<=0)continue;let S=a?g:g*(b/n.length);S=Math.min(1,S+Te(l.source,n));let k=S*Ce(l.importance),w=l.dateNum===null?0:Math.max(0,(r.now-l.dateNum)/864e5),x=l.dateNum===null?1:Re(w,r.halfLifeDays);d.push({source:l.source,snippet:Oe(l.text,n),date:l.dateNum===null?null:new Date(l.dateNum).toISOString().slice(0,10),preDecay:k,score:k*x,decay:x,importance:l.importance,tokens:new Set(l.tokens)})}let f=d.filter(l=>l.preDecay>=r.minScore);return f.length===0&&d.length>0&&(f=[d.slice().sort((l,g)=>g.preDecay-l.preDecay)[0]]),ie(f).slice(0,r.maxResults)}u(oe,"rankPool");function ie(t,e=De){let r=t.map(o=>({h:o,mmrScore:o.score,picked:!1})),n=[],s=[];for(;n.length<t.length;){let o=-1,i=-1/0;for(let a=0;a<r.length;a++){let c=r[a];if(c.picked)continue;let h=0;for(let p of s){let d=[...c.h.tokens].filter(l=>p.has(l)).length,f=c.h.tokens.size+p.size-d;f>0&&(h=Math.max(h,d/f))}let m=e*c.h.score-(1-e)*h;m>i&&(i=m,o=a)}if(o===-1)break;r[o].picked=!0,s.push(r[o].h.tokens),n.push(r[o].h)}return n}u(ie,"mmrReorder");function ae(t,e,r={}){let n={maxResults:Math.max(1,r.maxResults??re),minScore:r.minScore??se,halfLifeDays:r.halfLifeDays??W,now:r.now??Date.now()},s=[];for(let o of A(t)){let i;try{i=Se(P(t,o),"utf8")}catch{continue}let a=_(o);for(let c of $e(i))s.push({source:o,dateNum:a,text:c.text,importance:c.importance,tokens:R(M(c.text))})}return oe(s,e,n)}u(ae,"searchMemoryFiles");function bt(t,e,r,n={}){let s={maxResults:Math.max(1,n.maxResults??re),minScore:n.minScore??se,halfLifeDays:n.halfLifeDays??W,now:n.now??Date.now()},o=t.map(a=>({source:`session \xB7 ${a.session_key} \xB7 ${a.role}`,dateNum:a.created_at,text:a.content,importance:E(a.content),tokens:R(M(a.content))})),i=oe(o,e,{...s,maxResults:50});return ie([...r,...i]).slice(0,s.maxResults)}u(bt,"rankTranscriptHits");function A(t){let e=[];for(let s of["MEMORY.md","USER.md"])ke(P(t,s))&&e.push(s);let r=P(t,"memory"),n=u((s,o)=>{let i;try{i=xe(P(r,s),{withFileTypes:!0})}catch{return}for(let a of i){let c=o?`${o}/${a.name}`:a.name;a.isDirectory()?n(c,c):/\.md$/i.test(a.name)&&e.push(`memory/${c}`)}},"walk");return n("",""),e.sort()}u(A,"memoryFiles");import{existsSync as L,readFileSync as Ee,writeFileSync as _e,mkdirSync as Ae}from"node:fs";import{join as D}from"node:path";var Le=[{name:"AGENTS.md",budget:8e3},{name:"SOUL.md",budget:6e3},{name:"USER.md",budget:4e3},{name:"IDENTITY.md",budget:1500},{name:"TOOLS.md",budget:4e3},{name:"MEMORY.md",budget:8e3,mainSessionOnly:!0}],Ne=3e3,Fe=2;function z(t,e){if(!L(t))return null;let r="";try{r=Ee(t,"utf8")}catch{return null}return r.trim().length===0?null:r.length<=e?{body:r.trim(),truncated:!1}:{body:r.slice(0,e).trim()+`

[truncated]`,truncated:!0}}u(z,"readCapped");function Pe(t,e=new Date){let r=D(t,"memory"),n=[];for(let s=0;s<Fe;s++){let i=`memory/${new Date(e.getTime()-s*864e5).toISOString().slice(0,10)}.md`,a=z(D(t,i),Ne);a&&n.push(`## ${i}

${a.body}`)}return n}u(Pe,"dailyNotes");function Dt(t,e={isMainSession:!0}){let r=[],n=[],s=[];for(let a of e.lightContext?[]:Le){if(a.mainSessionOnly&&!e.isMainSession)continue;let c=z(D(t,a.name),a.budget);c&&(r.push(a.name),c.truncated&&n.push(a.name),s.push(`## ${a.name}

${c.body}`))}let o=e.lightContext?null:z(D(t,"BOOTSTRAP.md"),4e3);o&&(r.push("BOOTSTRAP.md"),s.unshift(`## BOOTSTRAP.md (first-run setup \u2014 follow it, then delete the file)

`+o.body));let i=e.lightContext?[]:Pe(t,e.today);return i.length>0&&(r.push("memory/*.md"),s.push(`## Recent daily notes

${i.join(`

`)}`)),{text:s.length>0?`# Project Context

${s.join(`

`)}`:"",included:r,truncated:n}}u(Dt,"loadWorkspaceContext");function N(t=new Date){return t.toISOString().slice(0,10)}u(N,"todayStamp");var Ie={"AGENTS.md":`# AGENTS.md - Workspace Rules

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
`};function vt(t){Ae(D(t,"memory"),{recursive:!0});let e=[],r=!L(D(t,"SOUL.md"))&&!L(D(t,"IDENTITY.md"))&&!L(D(t,"USER.md"));for(let[n,s]of Object.entries(Ie)){if(n==="BOOTSTRAP.md"&&!r)continue;let o=D(t,n);L(o)||(_e(o,s,"utf8"),e.push(n))}return e}u(vt,"writeWorkspaceTemplates");var Et="system:dream",$=30,qe=7*864e5,Ue=.9,He=14,We=.45,ze=2,Ge=.25;var T={relevance:.3,frequency:.24,queryDiversity:.15,recency:.15,consolidation:.1,richness:.06},F=/(api[-_ ]?key|password|passwd|secret|bearer\s+\S|-----BEGIN|[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{8,})/i;function le(t,e,r=$,n=200){let s=[];for(let o of A(t)){let i=_(o);if(i===null)continue;let a=new Date(i).toISOString().slice(0,10);if(a>=e||(Date.now()-i)/864e5>r)continue;let h;try{h=K(C(t,o),"utf8")}catch{continue}for(let m of h.split(`
`)){let p=/^\s*-\s+(.+)$/.exec(m);if(!p)continue;let d=M(p[1]).trim();if(!(d.length<12||d.length>400)&&(s.push({text:d,source:o,day:a,kind:"note",importance:E(m)}),s.length>=n))return s}}return s}u(le,"lightFromFiles");function Ke(t,e=Date.now(),r=150){return t.dreamTranscriptLines(e-qe,r).map(n=>({text:n.content.replace(/\s+/g," ").trim().slice(0,320),source:`session:${n.session_key}`,day:new Date(n.created_at).toISOString().slice(0,10),kind:"session",importance:null})).filter(n=>n.text.length>=24)}u(Ke,"lightFromTranscripts");function Je(t,e){let r=0;for(let s of t)e.has(s)&&r++;let n=t.size+e.size-r;return n===0?0:r/n}u(Je,"jaccard");function j(t,e,r="sweep"){let n={},s=0;for(let o of e){if(F.test(o.text)){n["secret-masked"]=(n["secret-masked"]??0)+1;continue}t.stageDreamCandidate({text:o.text,source:o.source,day:o.day,kind:o.kind,importance:o.importance,stagedVia:r})?s++:n.deduped=(n.deduped??0)+1}return{staged:s,rejected:n}}u(j,"lightStage");function Ve(t,e=8){let r=new Map;for(let n of t){let s=new Set;for(let o of R(M(n.text))){if(o.length<4||s.has(o))continue;s.add(o);let i=r.get(o)??{sources:new Set,rows:0};i.sources.add(n.source),i.rows++,r.set(o,i)}}return[...r.entries()].filter(([,n])=>n.sources.size>=2).map(([n,s])=>({name:n,count:s.sources.size,candidates:s.rows})).sort((n,s)=>s.count-n.count||s.candidates-n.candidates).slice(0,e)}u(Ve,"remThemes");function J(t){let e=[],r=t.map(n=>new Set(R(M(n.text))));for(let n=0;n<t.length;n++){let s=e.find(o=>Je(r[n],o.repTokens)>=Ue);if(s){s.members.push(t[n]),s.days.add(t[n].day),s.sources.add(t[n].source);let o=s.rep,i=t[n];((i.importance??0)>(o.importance??0)||i.importance===o.importance&&i.day>o.day)&&(s.rep=i,s.repTokens=r[n])}else e.push({rep:t[n],repTokens:r[n],members:[t[n]],days:new Set([t[n].day]),sources:new Set([t[n].source])})}return e}u(J,"deepCluster");function V(t,e,r=Date.now()){let n=Math.max(1,...t.map(c=>c.members.length)),s=Math.max(1,...t.map(c=>c.days.size)),o=t.map(c=>{let h=new Set;for(let m of e){let p;try{p=JSON.parse(m.sources)}catch{continue}p.some(d=>c.sources.has(d))&&h.add(m.query)}return h}),i=t.map(c=>e.filter(h=>{try{return JSON.parse(h.sources).some(m=>c.sources.has(m))}catch{return!1}}).length),a=Math.max(1,...o.map(c=>c.size));return t.map((c,h)=>{let m=[...c.days].sort().reverse()[0],p=Math.max(0,(r-Date.parse(`${m}T00:00:00Z`))/864e5),d=[...c.repTokens].filter(S=>S.length>=4),f=d.length/Math.max(1,c.repTokens.size),l=d.length,b={relevance:Math.max(i[h]>0?Math.min(1,.6+.1*Math.log1p(i[h])):0,c.rep.importance!==null?c.rep.importance/10:0,.5),frequency:c.members.length/n,queryDiversity:o[h].size/a,recency:Math.pow(2,-p/He),consolidation:c.days.size/s,richness:f,reinforce:1+Math.min(.1,.02*l),score:0,recalls:i[h],freshDay:m};return b.score=(T.relevance*b.relevance+T.frequency*b.frequency+T.queryDiversity*b.queryDiversity+T.recency*b.recency+T.consolidation*b.consolidation+T.richness*b.richness)*b.reinforce,{...b,cluster:c}})}u(V,"deepSignals");function B(t,e,r,n=Date.now()){let s=J(t);return V(s,e,n).sort((i,a)=>a.score-i.score).map(({cluster:i,...a})=>{if(a.score<We)return{cluster:i,signals:a,verdict:"below-score"};if(i.members.length<ze)return{cluster:i,signals:a,verdict:"few-signals"};if(i.rep.kind==="note")try{if(!K(C(r,i.rep.source),"utf8").includes(i.rep.text.slice(0,80)))return{cluster:i,signals:a,verdict:"stale-source"}}catch{return{cluster:i,signals:a,verdict:"stale-source"}}return{cluster:i,signals:a,verdict:"promote"}})}u(B,"deepDecide");function Ze(t,e){let r=t.map((n,s)=>`${s+1}. [${n.cluster.rep.source} \xB7 ${n.cluster.rep.day}] ${n.cluster.rep.text}`).join(`
`);return["You are the deep-consolidation step of a memory dreaming sweep.","Current MEMORY.md:","```",e.slice(0,6e3),"```","","Gated durable candidates (provenance in brackets):",r,"",'Return ONLY JSON: {"ops":[{"op":"add"|"merge"|"supersede","text":"curated fact","importance":1-10,"trigger":"short cue","source":"path","supersedes":"existing MEMORY.md line fragment (merge/supersede only)"}],"diary":"one-sentence plain-language diary line"}',"Rules: durable facts only (preferences, decisions, stable names, standing instructions, environment facts); never invent; keep MEMORY.md compact; preserve existing annotated entries unless a candidate merges or supersedes them; every op keeps its source for provenance."].join(`
`)}u(Ze,"consolidationPrompt");function Xe(t){let e=/\{[\s\S]*\}/.exec(t);if(!e)return null;let r;try{r=JSON.parse(e[0])}catch{return null}let n=r;if(!Array.isArray(n.ops))return null;let s=[];for(let i of n.ops){let a=i;if(a.op!=="add"&&a.op!=="merge"&&a.op!=="supersede"||typeof a.text!="string"||!a.text.trim()||a.op!=="add"&&typeof a.supersedes!="string")return null;s.push({op:a.op,text:a.text.trim(),importance:typeof a.importance=="number"?Math.min(10,Math.max(1,Math.trunc(a.importance))):void 0,trigger:typeof a.trigger=="string"?a.trigger.slice(0,60):void 0,source:typeof a.source=="string"?a.source.slice(0,200):void 0,supersedes:typeof a.supersedes=="string"?a.supersedes:void 0})}let o=typeof n.diary=="string"&&n.diary.trim()?n.diary.trim().split(`
`)[0]:"";return{ops:s,diary:o}}u(Xe,"parseConsolidation");function I(t){let e=[];return t.trigger&&e.push(`<!-- trigger: ${t.trigger} -->`),t.importance&&e.push(`<!-- importance: ${t.importance} -->`),t.source&&e.push(`<!-- Source: ${t.source} -->`),`- ${t.text}${e.length?" "+e.join(" "):""}`}u(I,"formatEntry");function Qe(t,e){let r=t.split(`
`),n=r.filter(m=>/^\s*-\s+/.test(m)).length,s=0,o=0,i=0,a=0;for(let m of e){if(m.op==="add"){r.push(I(m)),s++;continue}let p=(m.supersedes??"").trim(),d=r.findIndex(f=>p.length>=8&&f.includes(p));if(d===-1){r.push(I(m)),s++;continue}m.op==="supersede"?(r.splice(d,1),i++,a++):(r[d]=I(m),o++,a++)}let h=(n===0?0:a/n)<=Ge;return{next:h?r.join(`
`):t,added:s,merged:o,superseded:i,accepted:h}}u(Qe,"applyConsolidationOps");function Z(t,e,r){if(e.length===0)return{next:t,added:0};let n=["",`## Promoted ${r}`,...e.map(s=>I({text:s.cluster.rep.text,importance:s.cluster.rep.importance??void 0,source:s.cluster.rep.source}))].join(`
`);return{next:t.trimEnd()+`
`+n+`
`,added:e.length}}u(Z,"appendOnlyPromotion");function G(t,e,r,n){let s=C(t,"memory","dreaming",e);Be(s,{recursive:!0}),ce(C(s,`${r}.md`),n,"utf8")}u(G,"writePhaseReport");async function _t(t){let e=t.now??Date.now(),r=N(new Date(e)),{store:n,workspace:s}=t,o=[...le(s,r),...Ke(n,e)],i=j(n,o,"sweep");if(o.length===0){let y={day:r,staged:0,themes:[],promoted:0,merged:0,superseded:0,rejected:{},modelUsed:!1,nothingNew:!0,summary:"nothing new"};return n.recordDreamRun({day:r,light_staged:0,themes:"[]",promoted:0,merged:0,superseded:0,rejected:"{}",verdict:y.summary}),y}G(s,"light",r,`# Light Sleep \u2014 ${r}

staged: ${i.staged}
`+Object.entries(i.rejected).map(([y,O])=>`${y}: ${O}`).join(`
`)+`

## Staged candidates
`+o.filter(y=>!F.test(y.text)).slice(0,40).map(y=>`- [${y.source} \xB7 ${y.day}] ${y.text}`).join(`
`)+`
`);let a=n.dreamCandidates({stagedSinceMs:e-$*864e5}),c=Ve(a);G(s,"rem",r,`# REM Sleep \u2014 ${r}

`+(c.length>0?c.map(y=>`- **${y.name}** \u2014 ${y.count} sources, ${y.candidates} candidates`).join(`
`):"no recurring themes")+`
`);let h=n.dreamRecalls(e-$*864e5),m=B(a,h,s,e),p=m.filter(y=>y.verdict==="promote"),d={...i.rejected};for(let y of m)y.verdict!=="promote"&&(d[y.verdict]=(d[y.verdict]??0)+1);G(s,"deep",r,`# Deep Sleep \u2014 ${r}

## Candidates
`+(m.length>0?m.map(y=>`- ${y.verdict==="promote"?"\u2705":"\u2014"} score ${y.signals.score.toFixed(2)} (freq ${y.signals.frequency.toFixed(2)}, rec ${y.signals.recency.toFixed(2)}, cons ${y.signals.consolidation.toFixed(2)}, div ${y.signals.queryDiversity.toFixed(2)}, rich ${y.signals.richness.toFixed(2)}) \u2014 ${y.cluster.rep.day} \xB7 ${y.cluster.rep.source}
  ${y.cluster.rep.text.slice(0,120)}`).join(`
`):"no candidates")+`

## Rejection counts
`+Object.entries(d).map(([y,O])=>`${y}: ${O}`).join(`
`)+`
`);let{promoted:f,merged:l,superseded:g,modelUsed:b,diaryLine:S}=await tt(t,p,r),k=f===0&&l===0&&g===0,w=c.length>0?c.slice(0,3).map(y=>y.name).join(", "):"",x=`## Deep Sleep - ${r}

`+(S||(k?"nothing new":`promoted ${f}, merged ${l}, superseded ${g}`))+`
`+(w?`themes: ${w}
`:"")+`staged ${i.staged} \xB7 promoted ${f} \xB7 merged ${l} \xB7 superseded ${g}`+(Object.keys(d).length?` \xB7 rejected {${Object.entries(d).map(([y,O])=>`${y}:${O}`).join(", ")}}`:"")+`

`;Ye(C(s,"DREAMS.md"),x,"utf8");let U={day:r,staged:i.staged,themes:c,promoted:f,merged:l,superseded:g,rejected:d,modelUsed:b,nothingNew:k,summary:""};return U.summary=k?"nothing new":`dream sweep: promoted ${f}, merged ${l}, superseded ${g}${b?"":" (append-only fallback)"}`,n.recordDreamRun({day:r,light_staged:i.staged,themes:JSON.stringify(c.map(y=>y.name)),promoted:f,merged:l,superseded:g,rejected:JSON.stringify(d),verdict:U.summary}),U}u(_t,"runSweep");function et(t,e){return new Date(t-e*864e5).toISOString().slice(0,10)}u(et,"dayFromAge");function de(t,e,r=10,n=Date.now()){let s=t.dreamCandidates({stagedSinceMs:n-$*864e5}),o=t.dreamRecalls(n-$*864e5);return B(s,o,e,n).slice(0,Math.max(1,r))}u(de,"promotePreview");function At(t,e,r=200){let n=N(),s=et(Date.now(),$);return le(t,n,Math.min(e,$*4),r).filter(o=>o.day<s).sort((o,i)=>o.day<i.day?-1:1)}u(At,"backfillPreview");function Lt(t){return["Give this conversation a short session title.","Rules: 2-6 words, no quotes, no trailing punctuation, no markdown.","","The conversation starts with:",t].join(`
`)}u(Lt,"titlePrompt");function Nt(t){let e=String(t??"").split(`
`)[0]??"";return e=e.replace(/["'`“”‘’]/g,"").trim(),e=e.replace(/[.!?,;:]+\s*$/,"").trim(),e=e.replace(/\s+/g," "),e.length>60&&(e=e.slice(0,60).replace(/\s\S*$/,"")),e=e.trim(),e.length>=2?e:null}u(Nt,"cleanTitle");async function Ft(t,e){let{Cron:r}=await import("./croner-E72REWUN.js"),n=new r(t,{protect:!0},()=>{e().catch(()=>{})});return{stop:u(()=>n.stop(),"stop"),nextRunAt:u(()=>n.nextRun()?.getTime()??null,"nextRunAt")}}u(Ft,"armDream");async function tt(t,e,r){let{store:n,workspace:s}=t,o=C(s,"MEMORY.md"),i=je(o)?K(o,"utf8"):`# Memory
`;if(e.length===0)return{promoted:0,merged:0,superseded:0,modelUsed:!1,diaryLine:""};n.saveDreamPreimage(i);let a=0,c=0,h=0,m=!1,p="",d=i;if(t.llmComplete)try{let f=await t.llmComplete(Ze(e,i)),l=f?Xe(f):null;if(l){let g=Qe(i,l.ops);g.accepted&&(d=g.next,a=g.added,c=g.merged,h=g.superseded,m=!0,p=l.diary)}}catch{}if(!m){let f=Z(i,e,r);d=f.next,a=f.added}return d!==i&&ce(o,d,"utf8"),n.markDreamCandidatesPromoted(e.flatMap(f=>f.cluster.members.map(l=>l.id))),{promoted:a,merged:c,superseded:h,modelUsed:m,diaryLine:p}}u(tt,"consolidateGated");var pe=864e5;function ue(t,e=!1){let n=new Date(`${t}T00:00:00`).getTime();return e?n+pe:n}u(ue,"dayToMs");function fe(t){let e=new Date(t);return`${e.getFullYear()}-${String(e.getMonth()+1).padStart(2,"0")}-${String(e.getDate()).padStart(2,"0")}`}u(fe,"msToDay");function Y(t,e){return nt("sha256").update(`${t}
${e}`).digest("hex")}u(Y,"ingestHash");function at(t){return t.map(e=>({text:e.content.replace(/\s+/g," ").trim().slice(0,320),source:`session:${e.session_key}`,day:fe(e.created_at),kind:"session",importance:null})).filter(e=>e.text.length>=24)}u(at,"linesFromRows");function ge(t,e,r,n={}){let s=n.limitDays??92,o=n.fromDay?ue(n.fromDay):0,i=n.toDay?ue(n.toDay,!0):Date.now()+pe,a=t.transcriptLinesBetween(o,i),c=at(a),h=new Map;for(let d of c)h.has(d.day)||h.set(d.day,[]),h.get(d.day).push(d);let m=[...h.keys()].sort().slice(0,s),p={mode:r,window:{fromDay:n.fromDay??null,toDay:n.toDay??null,limitDays:s},daysProcessed:0,days:[],staged:0,diaryBlocks:0,hashesTracked:0};for(let d of m){let f=h.get(d),l=f.slice(0,200),g=l.filter(w=>!F.test(w.text)),b=l.length-g.length,S=g.filter(w=>!t.hasIngestHash(Y(w.source,w.text))&&!t.dreamCandidateExists(w.text,w.source)),k={day:d,messages:f.length,newLines:S.length,alreadyIngested:g.length-S.length,secretMasked:b,top:S.slice(0,3).map(w=>w.text.slice(0,120))};if(p.days.push(k),p.daysProcessed++,!(r==="preview"||S.length===0)){if(r==="apply"){let w=j(t,S,"backfill");for(let x of S)t.addIngestHash(Y(x.source,x.text),d,x.source),p.hashesTracked++;p.staged+=w.staged}if(he(e,d,S,r),p.diaryBlocks++,r==="rem")for(let w of S)t.addIngestHash(Y(`rem:${w.source}`,w.text),d,`rem:${w.source}`),p.hashesTracked++}}return r==="preview"&&(p.note="read-only preview \u2014 oldest unprocessed day first (their default)"),p}u(ge,"sessionBackfill");var ct=u((t,e)=>`<!-- sc-backfill:${t}:${e} -->`,"BLOCK_START"),lt="<!-- /sc-backfill -->";function he(t,e,r,n){let s=ee(t,"DREAMS.md"),o=X(s)?Q(s,"utf8"):`# DREAMS
`,i=["",ct(n,e),`## ${e} \u2014 ${n==="apply"?"session backfill":"grounded preview"}`,"",...r.slice(0,12).map(a=>`- [${a.source}] ${a.text.slice(0,200)}`),lt,""].join(`
`);return me(s,o+i),s}u(he,"writeDiaryBlock");function te(t,e){let r=ee(e,"DREAMS.md"),n=0;if(X(r)){let i=Q(r,"utf8"),a=i.replace(/\n?<!-- sc-backfill:[^\n]*-->\n[\s\S]*?<!-- \/sc-backfill -->\n?/g,()=>(n++,`
`));a!==i&&(me(r,a.replace(/\n{3,}/g,`

`)),a.trim()||rt(r,`# DREAMS
`))}let{candidates:s,hashes:o}=t.rollbackDreamBackfillFull();return{candidates:s,hashes:o,diaryBlocks:n,diaryPath:r}}u(te,"rollbackBackfill");function ye(t){if(!X(t))return{files:[],error:`no such path: ${t}`};let e=ot(t).isDirectory()?st(t).filter(n=>n.endsWith(".md")).sort().map(n=>ee(t,n)):[t],r=[];for(let n of e){let s=it(n),o=_(s),i=o!==null?fe(o):"unknown",a=Q(n,"utf8").split(`
`).map(c=>c.replace(/^\s*[-*]\s*/,"").trim()).filter(c=>c.length>=24&&c.length<=400&&!F.test(c)&&!c.startsWith("#")&&!c.startsWith("<!--")).map(c=>({text:c,source:`notes:${s}`,day:i,kind:"note",importance:null}));r.push({path:n,rel:s,day:i,lines:a})}return{files:r}}u(ye,"readRemSources");function be(t,e,r,n={}){let s=0,o=0;for(let i of r)i.lines.length!==0&&(n.previewOnly||(he(e,i.day,i.lines,"rem-backfill"),o++,t.addIngestHash(Y(`rem-backfill:${i.rel}`,i.lines[0].text),i.day,`rem-backfill:${i.rel}`),n.stageShortTerm&&(s+=j(t,i.lines,"backfill").staged)));return{daysProcessed:r.filter(i=>i.lines.length>0).length,staged:s,diaryBlocks:o,files:r.length}}u(be,"remBackfill");import{existsSync as dt,readFileSync as ut,writeFileSync as mt}from"node:fs";import{join as pt}from"node:path";var we=864e5;function q(t,e){let r=t.owner?.()??{running:!1,pid:null};return!r.running||e?null:`refusing: the gateway holds the memory store${r.pid?` (pid ${r.pid})`:""}. stop it first (sc service stop) or pass --yes to assert exclusive offline maintenance.`}u(q,"ownerRefusal");function ft(t){let e=new Map,r=new Set,n=new Set(["--query","--max-results","--min-score","--limit","--min-recall-count","--min-unique-queries","--from","--to","--limit-days","--path"]),s=[];for(let o=0;o<t.length;o++){let i=t[o];if(n.has(i)){if(!t[o+1])return{flags:e,bools:r,positional:s,error:`missing value for ${i}`};e.set(i.slice(2),t[++o])}else i.startsWith("--")?r.add(i.slice(2)):s.push(i)}return{flags:e,bools:r,positional:s}}u(ft,"parseFlags");function v(t){return console.log(JSON.stringify(t,null,2)),0}u(v,"printJson");async function Xt(t,e){let r=t[0]??"status",n=t.slice(1),{flags:s,bools:o,positional:i,error:a}=ft(n);if(a)return console.error(a),2;let c=o.has("json"),h=o.has("yes");switch(r){case"status":{let m=A(e.workspace),p=e.store.dreamCandidates({includePromoted:!1}),d=e.store.dreamCandidates({includePromoted:!1,via:"backfill"}),f=e.dreaming?.()??{enabled:!0,schedule:"0 3 * * *"},l={sources:{memoryFiles:m.length,lexical:!0,note:"lexical search \u2014 no vector index to rebuild (their index/reset are N/A here)"},shortTerm:{staged:p.length,viaBackfill:d.length},dreaming:f};return c?v(l):(console.log(`sources: ${m.length} memory file(s), lexical search (no vector index \u2014 index/reset N/A)`),console.log(`short-term store: ${p.length} staged (${d.length} via backfill)`),console.log(`dreaming: ${f.enabled?`on (${f.schedule})`:"off"}`),0)}case"search":{let m=s.get("query")??i.join(" ").trim();if(!m)return console.error(`usage: sc memory search <query> [--max-results n] [--min-score n] [--json]
also: positional [query] OR --query <text>; --query wins when both are set`),2;let p=Math.max(1,Number(s.get("max-results")??6)),d=Number(s.get("min-score")??0),f=ae(e.workspace,m,{maxResults:p,minScore:d}).slice(0,p);if(f.length>0&&e.store.recordMemoryRecall(m,f.slice(0,6).map(l=>l.source)),c)return v({results:f});for(let l of f)console.log(`${l.score.toFixed(2)}  ${l.source} \u2014 ${l.snippet.replace(/\s+/g," ").slice(0,100)}`);return f.length===0&&console.log("no matches"),0}case"promote":{let m=Math.max(1,Number(s.get("limit")??10)),d=o.has("include-promoted")?B(e.store.dreamCandidates({includePromoted:!0}),e.store.dreamRecalls(Date.now()-30*we),e.workspace).slice(0,m):de(e.store,e.workspace,m);if(c)return v({decisions:d,apply:o.has("apply")});if(d.length===0)return console.log("no promote candidates (gates: score \u2265 0.75, \u2265 3 signals, live source)"),0;for(let[w,x]of d.entries())console.log(`${w+1}. [${x.signals.score.toFixed(2)} \xB7 ${x.cluster.rep.source} \xB7 ${x.cluster.rep.day}] ${x.cluster.rep.text.slice(0,100)}`);if(!o.has("apply"))return console.log("preview only \u2014 pass --apply to append these to MEMORY.md and mark promoted"),0;let f=q(e,h);if(f)return console.error(f),1;let l=pt(e.workspace,"MEMORY.md"),g=dt(l)?ut(l,"utf8"):"",b=N(new Date),{next:S,added:k}=Z(g,d,b);return mt(l,S),e.store.markDreamCandidatesPromoted(d.flatMap(w=>w.cluster.members.map(x=>x.id))),console.log(`promoted ${k} \u2192 MEMORY.md (re-run now previews zero, like their drained apply)`),0}case"promote-explain":{let m=i.join(" ");if(!m)return console.error("usage: sc memory promote-explain <selector> [--include-promoted] [--json]"),2;let p=e.store.dreamCandidates({includePromoted:o.has("include-promoted")}),f=J(p).find(S=>S.rep.text.includes(m)||S.rep.source.includes(m));if(!f)return console.error(`no candidate matches "${m}" (key, path, or snippet substring)`),1;let l=e.store.dreamRecalls(Date.now()-30*we),g=V([f],l);if(c)return v({candidate:f.rep,signals:g[0]??null});let b=g[0];return console.log(`candidate: [${f.rep.source} \xB7 ${f.rep.day}] ${f.rep.text.slice(0,120)}`),b?(console.log(`relevance ${b.relevance.toFixed(2)} \xB7 frequency ${b.frequency.toFixed(2)} \xB7 diversity ${b.queryDiversity.toFixed(2)}
recency ${b.recency.toFixed(2)} \xB7 consolidation ${b.consolidation.toFixed(2)} \xB7 richness ${b.richness.toFixed(2)}
reinforce ${b.reinforce.toFixed(2)} \u2192 score ${b.score.toFixed(3)} (gate \u2265 0.75, recalls ${b.recalls})`),0):(console.log("no signals record"),0)}case"rem-backfill":{if(o.has("rollback")||o.has("rollback-short-term")){let g=q(e,h);if(g)return console.error(g),1;let b=te(e.store,e.workspace);return c?v({rollback:!0,removed:b}):(console.log(`rolled back: ${b.candidates} candidates, ${b.hashes} tracked hashes, ${b.diaryBlocks} diary block(s)
eligibility rewound \u2014 material can be previewed and applied again (their shared rollback)`),0)}let m=s.get("path");if(!m)return console.error(`usage: sc memory rem-backfill --path <file-or-dir> [--stage-short-term] [--json]
       sc memory rem-backfill --rollback [--json]`),2;let p=q(e,h);if(p)return console.error(p),1;let{files:d,error:f}=ye(m);if(f)return console.error(f),1;let l=be(e.store,e.workspace,d,{stageShortTerm:o.has("stage-short-term")});return c?v(l):(console.log(`${l.daysProcessed} day(s) from ${l.files} file(s); ${l.diaryBlocks} reversible DREAMS.md block(s) written`+(gt(o,"stage-short-term")?`; staged ${l.staged}`:" (diary only \u2014 pass --stage-short-term to seed the promotion store)")),0)}case"session-backfill":{let m=o.has("rollback")?"rollback":o.has("apply")?"apply":o.has("rem")?"rem":"preview";if(o.has("rem")&&o.has("apply"))return console.error("--rem and --apply are mutually exclusive (their rule)"),2;if(m!=="preview"){let d=q(e,h);if(d)return console.error(d),1}if(m==="rollback"){let d=te(e.store,e.workspace);return c?v({mode:m,removed:d}):(console.log(`rolled back: ${d.candidates} candidates, ${d.hashes} tracked hashes, ${d.diaryBlocks} diary block(s)
(shared lane: also removes rem-backfill artifacts \u2014 their intentional overlap)`),0)}let p=ge(e.store,e.workspace,m,{fromDay:s.get("from"),toDay:s.get("to"),limitDays:s.has("limit-days")?Number(s.get("limit-days")):92});if(c)return v(p);console.log(`mode=${p.mode} \xB7 ${p.daysProcessed} day(s), window ${p.window.fromDay??"-inf"} \u2192 ${p.window.toDay??"now"} (limit ${p.window.limitDays})`);for(let d of p.days.slice(0,12))console.log(`  ${d.day}: ${d.messages} msg \xB7 ${d.newLines} new \xB7 ${d.alreadyIngested} already ingested \xB7 ${d.secretMasked} secret-masked`);return p.days.length>12&&console.log(`  \u2026 plus ${p.days.length-12} more days`),p.mode==="preview"?console.log("read-only preview \u2014 pass --rem (diary only) or --apply (stage + diary, reversible)"):console.log(`staged ${p.staged}, tracked ${p.hashesTracked} hashes, wrote ${p.diaryBlocks} reversible DREAMS.md block(s)
`+(p.mode==="apply"?"MEMORY.md/USER.md untouched (their rule) \u2014 promotion stays with memory promote / deep sweep":"diary + origins only (their REM shape)")),0}default:return console.error(`unknown memory subcommand: ${r}
subcommands: status, search, promote, promote-explain, rem-backfill, session-backfill`),2}}u(Xt,"memoryCmd");function gt(t,e){return t.has(e)}u(gt,"boolVal");export{Dt as a,N as b,vt as c,ae as d,bt as e,Et as f,j as g,_t as h,de as i,At as j,Lt as k,Nt as l,Ft as m,tt as n,Xt as o};
