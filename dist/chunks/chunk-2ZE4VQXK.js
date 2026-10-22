import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);
import{createHash as tt}from"node:crypto";import{appendFileSync as nt,existsSync as V,readFileSync as Z,readdirSync as rt,statSync as st,writeFileSync as ue}from"node:fs";import{basename as ot,join as X}from"node:path";import{existsSync as je,mkdirSync as Be,readFileSync as W,writeFileSync as ae,appendFileSync as Ie}from"node:fs";import{join as C}from"node:path";import{readFileSync as xe,readdirSync as Se,existsSync as we}from"node:fs";import{join as F}from"node:path";var te=6,ne=.35,H=30,ke=.7,q=1600,ee=420,De=.05;function $(t){return(t.normalize("NFC").toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’._/-]*/gu)??[]).map(e=>e.normalize("NFD")).filter(e=>e.length>1||new RegExp("\\p{N}","u").test(e))}function $e(t){let e=t.split(/\n{2,}/).map(o=>o.trim()).filter(Boolean),r=[];for(let o=0;o<e.length;o++){let i=e[o];if(/^#{1,6}\s+\S/.test(i)&&!/\n/.test(i)&&e[o+1]){e[o+1]=`${i}

${e[o+1]}`;continue}if(i.length>q){let a="";for(let c of i.split(`
`))a&&a.length+c.length+1>q&&(r.push(a),a=""),a=a?`${a}
${c}`:c;a&&r.push(a)}else r.push(i)}for(let o=0;o<r.length-1;o++)/^#{1,6}\s+\S+$/.test(r[o].trim())&&(r[o+1]=`${r[o]}

${r[o+1]}`,r.splice(o,1),o--);let n=[],s="";for(let o of r)s&&s.length+o.length+2>q?(n.push({text:s,importance:O(s)}),s=o):s=s?`${s}

${o}`:o;return s&&n.push({text:s,importance:O(s)}),n}function O(t){let e=null;for(let r of t.matchAll(/<!--\s*importance:\s*(\d{1,2})\s*-->/gi)){let n=Math.min(10,Math.max(1,Number(r[1])));e=e===null?n:Math.max(e,n)}return e}function M(t){return t.replace(/<!--[\s\S]*?-->/g," ")}function T(t){let e=/(^|\/)(\d{4})-(\d{2})-(\d{2})(?:-\S+)?\.md$/.exec(t);if(!e)return null;let r=Date.parse(`${e[2]}-${e[3]}-${e[4]}T00:00:00Z`);return Number.isFinite(r)?r:null}function Me(t,e=H){return!Number.isFinite(t)||t<=0?1:Math.pow(2,-t/e)}function Re(t,e,r){if(e.length===0||t.length===0)return{rel:0,present:0};let n=new Map;for(let c of t)n.set(c,(n.get(c)??0)+1);let s=0,o=0,i=0;for(let c of e){let g=r.get(c)??1;o+=g;let u=n.get(c)??0;u>0&&(i++,s+=g*(u/(u+1.2)))}let a=1+Math.sqrt(t.length/200);return{rel:s/((o||1)*a),present:i}}function ve(t,e){let r=t.replace(/\.md$/i,"").toLowerCase(),n=r.split("/").pop()??r,s=0;for(let o of e)n===o?s=Math.max(s,.6):r.split(/[/\s_-]+|\./).includes(o)&&(s=Math.max(s,.3));return s}function Ce(t){return t===null?1:1+De*t}function Ee(t,e){let r=t.replace(/<!--\s*(importance|trigger):[^>]*-->/gi,"").replace(/\s+/g," ").trim();if(r.length<=ee)return r;let n=r.toLowerCase().normalize("NFD"),s=-1;for(let i of e){let a=n.indexOf(i);a!==-1&&(s===-1||a<s)&&(s=a)}let o=Math.max(0,(s===-1?0:s)-60);return(o>0?"\u2026":"")+r.slice(o,o+ee).trim()+"\u2026"}function re(t,e,r){let n=[...new Set($(e))].slice(0,32);if(n.length===0||t.length===0)return[];let s=t.map(l=>new Set(l.tokens)),o=new Map(n.map(l=>[l,0]));for(let l of s)for(let f of n)l.has(f)&&o.set(f,(o.get(f)??0)+1);let i=t.map((l,f)=>f).filter(l=>n.every(f=>s[l].has(f))),a=i.length>0,g=(a?i:t.map((l,f)=>f).filter(l=>n.some(f=>s[l].has(f)))).slice(0,50).map(l=>t[l]),u=g.length||1,m=new Map(n.map(l=>[l,Math.log(1+(u-(o.get(l)??0)+.5)/((o.get(l)??0)+.5))])),d=[];for(let l of g){let{rel:f,present:y}=Re(l.tokens,n,m);if(f<=0)continue;let x=a?f:f*(y/n.length);x=Math.min(1,x+ve(l.source,n));let w=x*Ce(l.importance),b=l.dateNum===null?0:Math.max(0,(r.now-l.dateNum)/864e5),S=l.dateNum===null?1:Me(b,r.halfLifeDays);d.push({source:l.source,snippet:Ee(l.text,n),date:l.dateNum===null?null:new Date(l.dateNum).toISOString().slice(0,10),preDecay:w,score:w*S,decay:S,importance:l.importance,tokens:new Set(l.tokens)})}let p=d.filter(l=>l.preDecay>=r.minScore);return p.length===0&&d.length>0&&(p=[d.slice().sort((l,f)=>f.preDecay-l.preDecay)[0]]),se(p).slice(0,r.maxResults)}function se(t,e=ke){let r=t.map(o=>({h:o,mmrScore:o.score,picked:!1})),n=[],s=[];for(;n.length<t.length;){let o=-1,i=-1/0;for(let a=0;a<r.length;a++){let c=r[a];if(c.picked)continue;let g=0;for(let m of s){let d=[...c.h.tokens].filter(l=>m.has(l)).length,p=c.h.tokens.size+m.size-d;p>0&&(g=Math.max(g,d/p))}let u=e*c.h.score-(1-e)*g;u>i&&(i=u,o=a)}if(o===-1)break;r[o].picked=!0,s.push(r[o].h.tokens),n.push(r[o].h)}return n}function oe(t,e,r={}){let n={maxResults:Math.max(1,r.maxResults??te),minScore:r.minScore??ne,halfLifeDays:r.halfLifeDays??H,now:r.now??Date.now()},s=[];for(let o of _(t)){let i;try{i=xe(F(t,o),"utf8")}catch{continue}let a=T(o);for(let c of $e(i))s.push({source:o,dateNum:a,text:c.text,importance:c.importance,tokens:$(M(c.text))})}return re(s,e,n)}function yt(t,e,r,n={}){let s={maxResults:Math.max(1,n.maxResults??te),minScore:n.minScore??ne,halfLifeDays:n.halfLifeDays??H,now:n.now??Date.now()},o=t.map(a=>({source:`session \xB7 ${a.session_key} \xB7 ${a.role}`,dateNum:a.created_at,text:a.content,importance:O(a.content),tokens:$(M(a.content))})),i=re(o,e,{...s,maxResults:50});return se([...r,...i]).slice(0,s.maxResults)}function _(t){let e=[];for(let s of["MEMORY.md","USER.md"])we(F(t,s))&&e.push(s);let r=F(t,"memory"),n=(s,o)=>{let i;try{i=Se(F(r,s),{withFileTypes:!0})}catch{return}for(let a of i){let c=o?`${o}/${a.name}`:a.name;a.isDirectory()?n(c,c):/\.md$/i.test(a.name)&&e.push(`memory/${c}`)}};return n("",""),e.sort()}import{existsSync as ie,readFileSync as Oe,writeFileSync as Te,mkdirSync as _e}from"node:fs";import{join as R}from"node:path";var Ae=[{name:"AGENTS.md",budget:8e3},{name:"SOUL.md",budget:6e3},{name:"USER.md",budget:4e3},{name:"IDENTITY.md",budget:1500},{name:"TOOLS.md",budget:4e3},{name:"MEMORY.md",budget:8e3,mainSessionOnly:!0}],Le=3e3,Fe=2;function U(t,e){if(!ie(t))return null;let r="";try{r=Oe(t,"utf8")}catch{return null}return r.trim().length===0?null:r.length<=e?{body:r.trim(),truncated:!1}:{body:r.slice(0,e).trim()+`

[truncated]`,truncated:!0}}function Ne(t,e=new Date){let r=R(t,"memory"),n=[];for(let s=0;s<Fe;s++){let i=`memory/${new Date(e.getTime()-s*864e5).toISOString().slice(0,10)}.md`,a=U(R(t,i),Le);a&&n.push(`## ${i}

${a.body}`)}return n}function wt(t,e={isMainSession:!0}){let r=[],n=[],s=[];for(let a of e.lightContext?[]:Ae){if(a.mainSessionOnly&&!e.isMainSession)continue;let c=U(R(t,a.name),a.budget);c&&(r.push(a.name),c.truncated&&n.push(a.name),s.push(`## ${a.name}

${c.body}`))}let o=e.lightContext?null:U(R(t,"BOOTSTRAP.md"),4e3);o&&(r.push("BOOTSTRAP.md"),s.unshift(`## BOOTSTRAP.md (first-run setup \u2014 follow it, then delete the file)

`+o.body));let i=e.lightContext?[]:Ne(t,e.today);return i.length>0&&(r.push("memory/*.md"),s.push(`## Recent daily notes

${i.join(`

`)}`)),{text:s.length>0?`# Project Context

${s.join(`

`)}`:"",included:r,truncated:n}}function A(t=new Date){return t.toISOString().slice(0,10)}var Pe={"AGENTS.md":`# AGENTS.md - Workspace Rules

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
`};function kt(t){_e(R(t,"memory"),{recursive:!0});let e=[];for(let[r,n]of Object.entries(Pe)){let s=R(t,r);ie(s)||(Te(s,n,"utf8"),e.push(r))}return e}var Ct="system:dream",D=30,Ye=7*864e5,qe=.9,He=14,Ue=.45,ze=2,We=.25;var v={relevance:.3,frequency:.24,queryDiversity:.15,recency:.15,consolidation:.1,richness:.06},L=/(api[-_ ]?key|password|passwd|secret|bearer\s+\S|-----BEGIN|[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{8,})/i;function ce(t,e,r=D,n=200){let s=[];for(let o of _(t)){let i=T(o);if(i===null)continue;let a=new Date(i).toISOString().slice(0,10);if(a>=e||(Date.now()-i)/864e5>r)continue;let g;try{g=W(C(t,o),"utf8")}catch{continue}for(let u of g.split(`
`)){let m=/^\s*-\s+(.+)$/.exec(u);if(!m)continue;let d=M(m[1]).trim();if(!(d.length<12||d.length>400)&&(s.push({text:d,source:o,day:a,kind:"note",importance:O(u)}),s.length>=n))return s}}return s}function Ge(t,e=Date.now(),r=150){return t.dreamTranscriptLines(e-Ye,r).map(n=>({text:n.content.replace(/\s+/g," ").trim().slice(0,320),source:`session:${n.session_key}`,day:new Date(n.created_at).toISOString().slice(0,10),kind:"session",importance:null})).filter(n=>n.text.length>=24)}function Je(t,e){let r=0;for(let s of t)e.has(s)&&r++;let n=t.size+e.size-r;return n===0?0:r/n}function P(t,e,r="sweep"){let n={},s=0;for(let o of e){if(L.test(o.text)){n["secret-masked"]=(n["secret-masked"]??0)+1;continue}t.stageDreamCandidate({text:o.text,source:o.source,day:o.day,kind:o.kind,importance:o.importance,stagedVia:r})?s++:n.deduped=(n.deduped??0)+1}return{staged:s,rejected:n}}function Ke(t,e=8){let r=new Map;for(let n of t){let s=new Set;for(let o of $(M(n.text))){if(o.length<4||s.has(o))continue;s.add(o);let i=r.get(o)??{sources:new Set,rows:0};i.sources.add(n.source),i.rows++,r.set(o,i)}}return[...r.entries()].filter(([,n])=>n.sources.size>=2).map(([n,s])=>({name:n,count:s.sources.size,candidates:s.rows})).sort((n,s)=>s.count-n.count||s.candidates-n.candidates).slice(0,e)}function G(t){let e=[],r=t.map(n=>new Set($(M(n.text))));for(let n=0;n<t.length;n++){let s=e.find(o=>Je(r[n],o.repTokens)>=qe);if(s){s.members.push(t[n]),s.days.add(t[n].day),s.sources.add(t[n].source);let o=s.rep,i=t[n];((i.importance??0)>(o.importance??0)||i.importance===o.importance&&i.day>o.day)&&(s.rep=i,s.repTokens=r[n])}else e.push({rep:t[n],repTokens:r[n],members:[t[n]],days:new Set([t[n].day]),sources:new Set([t[n].source])})}return e}function J(t,e,r=Date.now()){let n=Math.max(1,...t.map(c=>c.members.length)),s=Math.max(1,...t.map(c=>c.days.size)),o=t.map(c=>{let g=new Set;for(let u of e){let m;try{m=JSON.parse(u.sources)}catch{continue}m.some(d=>c.sources.has(d))&&g.add(u.query)}return g}),i=t.map(c=>e.filter(g=>{try{return JSON.parse(g.sources).some(u=>c.sources.has(u))}catch{return!1}}).length),a=Math.max(1,...o.map(c=>c.size));return t.map((c,g)=>{let u=[...c.days].sort().reverse()[0],m=Math.max(0,(r-Date.parse(`${u}T00:00:00Z`))/864e5),d=[...c.repTokens].filter(x=>x.length>=4),p=d.length/Math.max(1,c.repTokens.size),l=d.length,y={relevance:Math.max(i[g]>0?Math.min(1,.6+.1*Math.log1p(i[g])):0,c.rep.importance!==null?c.rep.importance/10:0,.5),frequency:c.members.length/n,queryDiversity:o[g].size/a,recency:Math.pow(2,-m/He),consolidation:c.days.size/s,richness:p,reinforce:1+Math.min(.1,.02*l),score:0,recalls:i[g],freshDay:u};return y.score=(v.relevance*y.relevance+v.frequency*y.frequency+v.queryDiversity*y.queryDiversity+v.recency*y.recency+v.consolidation*y.consolidation+v.richness*y.richness)*y.reinforce,{...y,cluster:c}})}function j(t,e,r,n=Date.now()){let s=G(t);return J(s,e,n).sort((i,a)=>a.score-i.score).map(({cluster:i,...a})=>{if(a.score<Ue)return{cluster:i,signals:a,verdict:"below-score"};if(i.members.length<ze)return{cluster:i,signals:a,verdict:"few-signals"};if(i.rep.kind==="note")try{if(!W(C(r,i.rep.source),"utf8").includes(i.rep.text.slice(0,80)))return{cluster:i,signals:a,verdict:"stale-source"}}catch{return{cluster:i,signals:a,verdict:"stale-source"}}return{cluster:i,signals:a,verdict:"promote"}})}function Ve(t,e){let r=t.map((n,s)=>`${s+1}. [${n.cluster.rep.source} \xB7 ${n.cluster.rep.day}] ${n.cluster.rep.text}`).join(`
`);return["You are the deep-consolidation step of a memory dreaming sweep.","Current MEMORY.md:","```",e.slice(0,6e3),"```","","Gated durable candidates (provenance in brackets):",r,"",'Return ONLY JSON: {"ops":[{"op":"add"|"merge"|"supersede","text":"curated fact","importance":1-10,"trigger":"short cue","source":"path","supersedes":"existing MEMORY.md line fragment (merge/supersede only)"}],"diary":"one-sentence plain-language diary line"}',"Rules: durable facts only (preferences, decisions, stable names, standing instructions, environment facts); never invent; keep MEMORY.md compact; preserve existing annotated entries unless a candidate merges or supersedes them; every op keeps its source for provenance."].join(`
`)}function Ze(t){let e=/\{[\s\S]*\}/.exec(t);if(!e)return null;let r;try{r=JSON.parse(e[0])}catch{return null}let n=r;if(!Array.isArray(n.ops))return null;let s=[];for(let i of n.ops){let a=i;if(a.op!=="add"&&a.op!=="merge"&&a.op!=="supersede"||typeof a.text!="string"||!a.text.trim()||a.op!=="add"&&typeof a.supersedes!="string")return null;s.push({op:a.op,text:a.text.trim(),importance:typeof a.importance=="number"?Math.min(10,Math.max(1,Math.trunc(a.importance))):void 0,trigger:typeof a.trigger=="string"?a.trigger.slice(0,60):void 0,source:typeof a.source=="string"?a.source.slice(0,200):void 0,supersedes:typeof a.supersedes=="string"?a.supersedes:void 0})}let o=typeof n.diary=="string"&&n.diary.trim()?n.diary.trim().split(`
`)[0]:"";return{ops:s,diary:o}}function N(t){let e=[];return t.trigger&&e.push(`<!-- trigger: ${t.trigger} -->`),t.importance&&e.push(`<!-- importance: ${t.importance} -->`),t.source&&e.push(`<!-- Source: ${t.source} -->`),`- ${t.text}${e.length?" "+e.join(" "):""}`}function Xe(t,e){let r=t.split(`
`),n=r.filter(u=>/^\s*-\s+/.test(u)).length,s=0,o=0,i=0,a=0;for(let u of e){if(u.op==="add"){r.push(N(u)),s++;continue}let m=(u.supersedes??"").trim(),d=r.findIndex(p=>m.length>=8&&p.includes(m));if(d===-1){r.push(N(u)),s++;continue}u.op==="supersede"?(r.splice(d,1),i++,a++):(r[d]=N(u),o++,a++)}let g=(n===0?0:a/n)<=We;return{next:g?r.join(`
`):t,added:s,merged:o,superseded:i,accepted:g}}function K(t,e,r){if(e.length===0)return{next:t,added:0};let n=["",`## Promoted ${r}`,...e.map(s=>N({text:s.cluster.rep.text,importance:s.cluster.rep.importance??void 0,source:s.cluster.rep.source}))].join(`
`);return{next:t.trimEnd()+`
`+n+`
`,added:e.length}}function z(t,e,r,n){let s=C(t,"memory","dreaming",e);Be(s,{recursive:!0}),ae(C(s,`${r}.md`),n,"utf8")}async function Et(t){let e=t.now??Date.now(),r=A(new Date(e)),{store:n,workspace:s}=t,o=[...ce(s,r),...Ge(n,e)],i=P(n,o,"sweep");if(o.length===0){let h={day:r,staged:0,themes:[],promoted:0,merged:0,superseded:0,rejected:{},modelUsed:!1,nothingNew:!0,summary:"nothing new"};return n.recordDreamRun({day:r,light_staged:0,themes:"[]",promoted:0,merged:0,superseded:0,rejected:"{}",verdict:h.summary}),h}z(s,"light",r,`# Light Sleep \u2014 ${r}

staged: ${i.staged}
`+Object.entries(i.rejected).map(([h,E])=>`${h}: ${E}`).join(`
`)+`

## Staged candidates
`+o.filter(h=>!L.test(h.text)).slice(0,40).map(h=>`- [${h.source} \xB7 ${h.day}] ${h.text}`).join(`
`)+`
`);let a=n.dreamCandidates({stagedSinceMs:e-D*864e5}),c=Ke(a);z(s,"rem",r,`# REM Sleep \u2014 ${r}

`+(c.length>0?c.map(h=>`- **${h.name}** \u2014 ${h.count} sources, ${h.candidates} candidates`).join(`
`):"no recurring themes")+`
`);let g=n.dreamRecalls(e-D*864e5),u=j(a,g,s,e),m=u.filter(h=>h.verdict==="promote"),d={...i.rejected};for(let h of u)h.verdict!=="promote"&&(d[h.verdict]=(d[h.verdict]??0)+1);z(s,"deep",r,`# Deep Sleep \u2014 ${r}

## Candidates
`+(u.length>0?u.map(h=>`- ${h.verdict==="promote"?"\u2705":"\u2014"} score ${h.signals.score.toFixed(2)} (freq ${h.signals.frequency.toFixed(2)}, rec ${h.signals.recency.toFixed(2)}, cons ${h.signals.consolidation.toFixed(2)}, div ${h.signals.queryDiversity.toFixed(2)}, rich ${h.signals.richness.toFixed(2)}) \u2014 ${h.cluster.rep.day} \xB7 ${h.cluster.rep.source}
  ${h.cluster.rep.text.slice(0,120)}`).join(`
`):"no candidates")+`

## Rejection counts
`+Object.entries(d).map(([h,E])=>`${h}: ${E}`).join(`
`)+`
`);let{promoted:p,merged:l,superseded:f,modelUsed:y,diaryLine:x}=await et(t,m,r),w=p===0&&l===0&&f===0,b=c.length>0?c.slice(0,3).map(h=>h.name).join(", "):"",S=`## Deep Sleep - ${r}

`+(x||(w?"nothing new":`promoted ${p}, merged ${l}, superseded ${f}`))+`
`+(b?`themes: ${b}
`:"")+`staged ${i.staged} \xB7 promoted ${p} \xB7 merged ${l} \xB7 superseded ${f}`+(Object.keys(d).length?` \xB7 rejected {${Object.entries(d).map(([h,E])=>`${h}:${E}`).join(", ")}}`:"")+`

`;Ie(C(s,"DREAMS.md"),S,"utf8");let Y={day:r,staged:i.staged,themes:c,promoted:p,merged:l,superseded:f,rejected:d,modelUsed:y,nothingNew:w,summary:""};return Y.summary=w?"nothing new":`dream sweep: promoted ${p}, merged ${l}, superseded ${f}${y?"":" (append-only fallback)"}`,n.recordDreamRun({day:r,light_staged:i.staged,themes:JSON.stringify(c.map(h=>h.name)),promoted:p,merged:l,superseded:f,rejected:JSON.stringify(d),verdict:Y.summary}),Y}function Qe(t,e){return new Date(t-e*864e5).toISOString().slice(0,10)}function le(t,e,r=10,n=Date.now()){let s=t.dreamCandidates({stagedSinceMs:n-D*864e5}),o=t.dreamRecalls(n-D*864e5);return j(s,o,e,n).slice(0,Math.max(1,r))}function Ot(t,e,r=200){let n=A(),s=Qe(Date.now(),D);return ce(t,n,Math.min(e,D*4),r).filter(o=>o.day<s).sort((o,i)=>o.day<i.day?-1:1)}function Tt(t){return["Give this conversation a short session title.","Rules: 2-6 words, no quotes, no trailing punctuation, no markdown.","","The conversation starts with:",t].join(`
`)}function _t(t){let e=String(t??"").split(`
`)[0]??"";return e=e.replace(/["'`“”‘’]/g,"").trim(),e=e.replace(/[.!?,;:]+\s*$/,"").trim(),e=e.replace(/\s+/g," "),e.length>60&&(e=e.slice(0,60).replace(/\s\S*$/,"")),e=e.trim(),e.length>=2?e:null}async function At(t,e){let{Cron:r}=await import("./croner-3P7MMEQK.js"),n=new r(t,{protect:!0},()=>{e().catch(()=>{})});return{stop:()=>n.stop(),nextRunAt:()=>n.nextRun()?.getTime()??null}}async function et(t,e,r){let{store:n,workspace:s}=t,o=C(s,"MEMORY.md"),i=je(o)?W(o,"utf8"):`# Memory
`;if(e.length===0)return{promoted:0,merged:0,superseded:0,modelUsed:!1,diaryLine:""};n.saveDreamPreimage(i);let a=0,c=0,g=0,u=!1,m="",d=i;if(t.llmComplete)try{let p=await t.llmComplete(Ve(e,i)),l=p?Ze(p):null;if(l){let f=Xe(i,l.ops);f.accepted&&(d=f.next,a=f.added,c=f.merged,g=f.superseded,u=!0,m=l.diary)}}catch{}if(!u){let p=K(i,e,r);d=p.next,a=p.added}return d!==i&&ae(o,d,"utf8"),n.markDreamCandidatesPromoted(e.flatMap(p=>p.cluster.members.map(l=>l.id))),{promoted:a,merged:c,superseded:g,modelUsed:u,diaryLine:m}}var me=864e5;function de(t,e=!1){let n=new Date(`${t}T00:00:00`).getTime();return e?n+me:n}function pe(t){let e=new Date(t);return`${e.getFullYear()}-${String(e.getMonth()+1).padStart(2,"0")}-${String(e.getDate()).padStart(2,"0")}`}function B(t,e){return tt("sha256").update(`${t}
${e}`).digest("hex")}function it(t){return t.map(e=>({text:e.content.replace(/\s+/g," ").trim().slice(0,320),source:`session:${e.session_key}`,day:pe(e.created_at),kind:"session",importance:null})).filter(e=>e.text.length>=24)}function fe(t,e,r,n={}){let s=n.limitDays??92,o=n.fromDay?de(n.fromDay):0,i=n.toDay?de(n.toDay,!0):Date.now()+me,a=t.transcriptLinesBetween(o,i),c=it(a),g=new Map;for(let d of c)g.has(d.day)||g.set(d.day,[]),g.get(d.day).push(d);let u=[...g.keys()].sort().slice(0,s),m={mode:r,window:{fromDay:n.fromDay??null,toDay:n.toDay??null,limitDays:s},daysProcessed:0,days:[],staged:0,diaryBlocks:0,hashesTracked:0};for(let d of u){let p=g.get(d),l=p.slice(0,200),f=l.filter(b=>!L.test(b.text)),y=l.length-f.length,x=f.filter(b=>!t.hasIngestHash(B(b.source,b.text))&&!t.dreamCandidateExists(b.text,b.source)),w={day:d,messages:p.length,newLines:x.length,alreadyIngested:f.length-x.length,secretMasked:y,top:x.slice(0,3).map(b=>b.text.slice(0,120))};if(m.days.push(w),m.daysProcessed++,!(r==="preview"||x.length===0)){if(r==="apply"){let b=P(t,x,"backfill");for(let S of x)t.addIngestHash(B(S.source,S.text),d,S.source),m.hashesTracked++;m.staged+=b.staged}if(ge(e,d,x,r),m.diaryBlocks++,r==="rem")for(let b of x)t.addIngestHash(B(`rem:${b.source}`,b.text),d,`rem:${b.source}`),m.hashesTracked++}}return r==="preview"&&(m.note="read-only preview \u2014 oldest unprocessed day first (their default)"),m}var at=(t,e)=>`<!-- sc-backfill:${t}:${e} -->`,ct="<!-- /sc-backfill -->";function ge(t,e,r,n){let s=X(t,"DREAMS.md"),o=V(s)?Z(s,"utf8"):`# DREAMS
`,i=["",at(n,e),`## ${e} \u2014 ${n==="apply"?"session backfill":"grounded preview"}`,"",...r.slice(0,12).map(a=>`- [${a.source}] ${a.text.slice(0,200)}`),ct,""].join(`
`);return ue(s,o+i),s}function Q(t,e){let r=X(e,"DREAMS.md"),n=0;if(V(r)){let i=Z(r,"utf8"),a=i.replace(/\n?<!-- sc-backfill:[^\n]*-->\n[\s\S]*?<!-- \/sc-backfill -->\n?/g,()=>(n++,`
`));a!==i&&(ue(r,a.replace(/\n{3,}/g,`

`)),a.trim()||nt(r,`# DREAMS
`))}let{candidates:s,hashes:o}=t.rollbackDreamBackfillFull();return{candidates:s,hashes:o,diaryBlocks:n,diaryPath:r}}function he(t){if(!V(t))return{files:[],error:`no such path: ${t}`};let e=st(t).isDirectory()?rt(t).filter(n=>n.endsWith(".md")).sort().map(n=>X(t,n)):[t],r=[];for(let n of e){let s=ot(n),o=T(s),i=o!==null?pe(o):"unknown",a=Z(n,"utf8").split(`
`).map(c=>c.replace(/^\s*[-*]\s*/,"").trim()).filter(c=>c.length>=24&&c.length<=400&&!L.test(c)&&!c.startsWith("#")&&!c.startsWith("<!--")).map(c=>({text:c,source:`notes:${s}`,day:i,kind:"note",importance:null}));r.push({path:n,rel:s,day:i,lines:a})}return{files:r}}function ye(t,e,r,n={}){let s=0,o=0;for(let i of r)i.lines.length!==0&&(n.previewOnly||(ge(e,i.day,i.lines,"rem-backfill"),o++,t.addIngestHash(B(`rem-backfill:${i.rel}`,i.lines[0].text),i.day,`rem-backfill:${i.rel}`),n.stageShortTerm&&(s+=P(t,i.lines,"backfill").staged)));return{daysProcessed:r.filter(i=>i.lines.length>0).length,staged:s,diaryBlocks:o,files:r.length}}import{existsSync as lt,readFileSync as dt,writeFileSync as ut}from"node:fs";import{join as mt}from"node:path";var be=864e5;function I(t,e){let r=t.owner?.()??{running:!1,pid:null};return!r.running||e?null:`refusing: the gateway holds the memory store${r.pid?` (pid ${r.pid})`:""}. stop it first (sc service stop) or pass --yes to assert exclusive offline maintenance.`}function pt(t){let e=new Map,r=new Set,n=new Set(["--query","--max-results","--min-score","--limit","--min-recall-count","--min-unique-queries","--from","--to","--limit-days","--path"]),s=[];for(let o=0;o<t.length;o++){let i=t[o];if(n.has(i)){if(!t[o+1])return{flags:e,bools:r,positional:s,error:`missing value for ${i}`};e.set(i.slice(2),t[++o])}else i.startsWith("--")?r.add(i.slice(2)):s.push(i)}return{flags:e,bools:r,positional:s}}function k(t){return console.log(JSON.stringify(t,null,2)),0}async function Gt(t,e){let r=t[0]??"status",n=t.slice(1),{flags:s,bools:o,positional:i,error:a}=pt(n);if(a)return console.error(a),2;let c=o.has("json"),g=o.has("yes");switch(r){case"status":{let u=_(e.workspace),m=e.store.dreamCandidates({includePromoted:!1}),d=e.store.dreamCandidates({includePromoted:!1,via:"backfill"}),p=e.dreaming?.()??{enabled:!0,schedule:"0 3 * * *"},l={sources:{memoryFiles:u.length,lexical:!0,note:"lexical search \u2014 no vector index to rebuild (their index/reset are N/A here)"},shortTerm:{staged:m.length,viaBackfill:d.length},dreaming:p};return c?k(l):(console.log(`sources: ${u.length} memory file(s), lexical search (no vector index \u2014 index/reset N/A)`),console.log(`short-term store: ${m.length} staged (${d.length} via backfill)`),console.log(`dreaming: ${p.enabled?`on (${p.schedule})`:"off"}`),0)}case"search":{let u=s.get("query")??i.join(" ").trim();if(!u)return console.error(`usage: sc memory search <query> [--max-results n] [--min-score n] [--json]
also: positional [query] OR --query <text>; --query wins when both are set`),2;let m=Math.max(1,Number(s.get("max-results")??6)),d=Number(s.get("min-score")??0),p=oe(e.workspace,u,{maxResults:m,minScore:d}).slice(0,m);if(p.length>0&&e.store.recordMemoryRecall(u,p.slice(0,6).map(l=>l.source)),c)return k({results:p});for(let l of p)console.log(`${l.score.toFixed(2)}  ${l.source} \u2014 ${l.snippet.replace(/\s+/g," ").slice(0,100)}`);return p.length===0&&console.log("no matches"),0}case"promote":{let u=Math.max(1,Number(s.get("limit")??10)),d=o.has("include-promoted")?j(e.store.dreamCandidates({includePromoted:!0}),e.store.dreamRecalls(Date.now()-30*be),e.workspace).slice(0,u):le(e.store,e.workspace,u);if(c)return k({decisions:d,apply:o.has("apply")});if(d.length===0)return console.log("no promote candidates (gates: score \u2265 0.75, \u2265 3 signals, live source)"),0;for(let[b,S]of d.entries())console.log(`${b+1}. [${S.signals.score.toFixed(2)} \xB7 ${S.cluster.rep.source} \xB7 ${S.cluster.rep.day}] ${S.cluster.rep.text.slice(0,100)}`);if(!o.has("apply"))return console.log("preview only \u2014 pass --apply to append these to MEMORY.md and mark promoted"),0;let p=I(e,g);if(p)return console.error(p),1;let l=mt(e.workspace,"MEMORY.md"),f=lt(l)?dt(l,"utf8"):"",y=A(new Date),{next:x,added:w}=K(f,d,y);return ut(l,x),e.store.markDreamCandidatesPromoted(d.flatMap(b=>b.cluster.members.map(S=>S.id))),console.log(`promoted ${w} \u2192 MEMORY.md (re-run now previews zero, like their drained apply)`),0}case"promote-explain":{let u=i.join(" ");if(!u)return console.error("usage: sc memory promote-explain <selector> [--include-promoted] [--json]"),2;let m=e.store.dreamCandidates({includePromoted:o.has("include-promoted")}),p=G(m).find(x=>x.rep.text.includes(u)||x.rep.source.includes(u));if(!p)return console.error(`no candidate matches "${u}" (key, path, or snippet substring)`),1;let l=e.store.dreamRecalls(Date.now()-30*be),f=J([p],l);if(c)return k({candidate:p.rep,signals:f[0]??null});let y=f[0];return console.log(`candidate: [${p.rep.source} \xB7 ${p.rep.day}] ${p.rep.text.slice(0,120)}`),y?(console.log(`relevance ${y.relevance.toFixed(2)} \xB7 frequency ${y.frequency.toFixed(2)} \xB7 diversity ${y.queryDiversity.toFixed(2)}
recency ${y.recency.toFixed(2)} \xB7 consolidation ${y.consolidation.toFixed(2)} \xB7 richness ${y.richness.toFixed(2)}
reinforce ${y.reinforce.toFixed(2)} \u2192 score ${y.score.toFixed(3)} (gate \u2265 0.75, recalls ${y.recalls})`),0):(console.log("no signals record"),0)}case"rem-backfill":{if(o.has("rollback")||o.has("rollback-short-term")){let f=I(e,g);if(f)return console.error(f),1;let y=Q(e.store,e.workspace);return c?k({rollback:!0,removed:y}):(console.log(`rolled back: ${y.candidates} candidates, ${y.hashes} tracked hashes, ${y.diaryBlocks} diary block(s)
eligibility rewound \u2014 material can be previewed and applied again (their shared rollback)`),0)}let u=s.get("path");if(!u)return console.error(`usage: sc memory rem-backfill --path <file-or-dir> [--stage-short-term] [--json]
       sc memory rem-backfill --rollback [--json]`),2;let m=I(e,g);if(m)return console.error(m),1;let{files:d,error:p}=he(u);if(p)return console.error(p),1;let l=ye(e.store,e.workspace,d,{stageShortTerm:o.has("stage-short-term")});return c?k(l):(console.log(`${l.daysProcessed} day(s) from ${l.files} file(s); ${l.diaryBlocks} reversible DREAMS.md block(s) written`+(ft(o,"stage-short-term")?`; staged ${l.staged}`:" (diary only \u2014 pass --stage-short-term to seed the promotion store)")),0)}case"session-backfill":{let u=o.has("rollback")?"rollback":o.has("apply")?"apply":o.has("rem")?"rem":"preview";if(o.has("rem")&&o.has("apply"))return console.error("--rem and --apply are mutually exclusive (their rule)"),2;if(u!=="preview"){let d=I(e,g);if(d)return console.error(d),1}if(u==="rollback"){let d=Q(e.store,e.workspace);return c?k({mode:u,removed:d}):(console.log(`rolled back: ${d.candidates} candidates, ${d.hashes} tracked hashes, ${d.diaryBlocks} diary block(s)
(shared lane: also removes rem-backfill artifacts \u2014 their intentional overlap)`),0)}let m=fe(e.store,e.workspace,u,{fromDay:s.get("from"),toDay:s.get("to"),limitDays:s.has("limit-days")?Number(s.get("limit-days")):92});if(c)return k(m);console.log(`mode=${m.mode} \xB7 ${m.daysProcessed} day(s), window ${m.window.fromDay??"-inf"} \u2192 ${m.window.toDay??"now"} (limit ${m.window.limitDays})`);for(let d of m.days.slice(0,12))console.log(`  ${d.day}: ${d.messages} msg \xB7 ${d.newLines} new \xB7 ${d.alreadyIngested} already ingested \xB7 ${d.secretMasked} secret-masked`);return m.days.length>12&&console.log(`  \u2026 plus ${m.days.length-12} more days`),m.mode==="preview"?console.log("read-only preview \u2014 pass --rem (diary only) or --apply (stage + diary, reversible)"):console.log(`staged ${m.staged}, tracked ${m.hashesTracked} hashes, wrote ${m.diaryBlocks} reversible DREAMS.md block(s)
`+(m.mode==="apply"?"MEMORY.md/USER.md untouched (their rule) \u2014 promotion stays with memory promote / deep sweep":"diary + origins only (their REM shape)")),0}default:return console.error(`unknown memory subcommand: ${r}
subcommands: status, search, promote, promote-explain, rem-backfill, session-backfill`),2}}function ft(t,e){return t.has(e)}export{wt as a,A as b,kt as c,oe as d,yt as e,Ct as f,P as g,Et as h,le as i,Ot as j,Tt as k,_t as l,At as m,et as n,Gt as o};
