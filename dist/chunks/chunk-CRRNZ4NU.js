import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);
import{e as a}from"./chunk-TETLWCCO.js";import{a as w}from"./chunk-5W2H57UO.js";import{d as c,f as u}from"./chunk-BOJTPSQQ.js";import{c as m}from"./chunk-EEEC4TXW.js";var f=m(w(),1);import{readFileSync as C,writeFileSync as y,renameSync as k,copyFileSync as S,existsSync as h}from"node:fs";import{watch as b}from"node:fs";import{dirname as x,basename as v}from"node:path";var L=`// SuparClaw config (JSON5: comments allowed)
{
  gateway: {
    port: 18790,
    bind: "loopback",        // "loopback" = this phone only; "lan" = also reachable on wifi
    auth: { mode: "token", token: "" },   // empty token is auto-generated on first run
    controlUi: { enabled: true },
    // allowedHosts: ["ui.example.com"],   // extra Host headers (reverse proxies)
    // allowedOrigins: ["https://ui.example.com"],  // cross-origin web UIs
  },
  agents: {
    defaults: {
      id: "main",
      model: "",              // e.g. "openai/gpt-4o-mini" or "local/qwen2.5"
      maxToolIterations: 12,
      queueMode: "followup"   // "steer" injects mid-turn, "followup" waits
    }
  },
  providers: {
    // openai: { baseUrl: "https://api.openai.com/v1", apiKey: "sk-...", models: ["gpt-4o-mini"] },
    // local:   { baseUrl: "http://127.0.0.1:8080/v1", apiKey: "none" }
  },
  channels: {
    telegram: {
      enabled: false,
      token: "",
      dmPolicy: "pairing",     // first DM needs approval: sc pair <code>
      streaming: "progress"    // status draft + final answer (Telegram-friendly)
    }
  },
  tools: {
    fs: true,
    memory: true,
    web: { fetch: true, search: true },
    exec: { enabled: false, approvals: true }   // opt-in; needs approval per call
  },
  cron: { enabled: true }
}
`;function p(i=a()){if(!h(i))return{config:u(),errors:[],path:i,existed:!1};let r;try{r=f.default.parse(C(i,"utf8"))}catch(n){return{config:u(),errors:[`${i}: ${n.message}`],path:i,existed:!0}}let{config:e,errors:o}=c(r);return{config:e,errors:o,path:i,existed:!0}}function F(i,r=a()){h(r)&&S(r,`${r}.bak`);let e=`${r}.tmp`;y(e,f.default.stringify(i,null,2)+`
`,"utf8"),k(e,r)}var d=class{constructor(r,e=a()){this.log=r;this.path=e;let o=p(e);this.#r=o.config,this.#t=o.errors;for(let n of o.errors)this.log.error(`config: ${n}`)}log;#r;#t=[];#o=null;#e=null;path;get current(){return this.#r}get errors(){return this.#t}set(r,e){let o={...this.#r,[r]:e},{config:n,errors:t}=c(o);return t.length>0?{ok:!1,errors:t}:(this.#r=n,F(n,this.path),{ok:!0,errors:[]})}get(r){return r.split(".").reduce((e,o)=>{if(e&&typeof e=="object")return e[o]},this.#r)}setPath(r,e){let o=r.split(".")[0],n=structuredClone(this.#r),t=n,s=r.split(".");for(let l of s.slice(0,-1)){let g=t[l];(!g||typeof g!="object")&&(t[l]={}),t=t[l]}return t[s[s.length-1]]=e,this.set(o,n[o])}watchForChanges(r){if(!this.#o)try{let e=x(this.path),o=v(this.path);this.#o=b(e,(n,t)=>{t&&t.toString()!==o||(this.#e&&clearTimeout(this.#e),this.#e=setTimeout(()=>{let s=p(this.path);if(s.errors.length>0){this.#t=s.errors,this.log.error(`config reload rejected: ${s.errors[0]}`);return}this.#r=s.config,this.#t=[],this.log.info("config reloaded"),r?.(s.config)},250))})}catch(e){this.log.warn(`config hot-reload unavailable: ${e.message}`)}}stopWatching(){this.#e&&clearTimeout(this.#e),this.#e=null,this.#o?.close(),this.#o=null}stop(){this.#o?.close(),this.#o=null,this.#e&&clearTimeout(this.#e)}};export{L as a,p as b,F as c,d};
