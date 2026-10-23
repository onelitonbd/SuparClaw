import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);
import{f as p}from"./chunk-ADPWOZIS.js";import{e as l}from"./chunk-TETLWCCO.js";import{a as y}from"./chunk-5W2H57UO.js";import{d as g,f as c}from"./chunk-TZ2K5QTO.js";import{c as C}from"./chunk-EEEC4TXW.js";var f=C(y(),1);import{readFileSync as k,writeFileSync as S,renameSync as b,copyFileSync as x,existsSync as m}from"node:fs";import{watch as v}from"node:fs";import{dirname as F,basename as T}from"node:path";var O=`// SuparClaw config (JSON5: comments allowed)
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
`;function h(s=l()){if(!m(s))return{config:c(),errors:[],path:s,existed:!1,warnings:[]};let r;try{r=f.default.parse(k(s,"utf8"))}catch(t){return{config:c(),errors:[`${s}: ${t.message}`],path:s,existed:!0,warnings:[]}}let e=p(r),{config:o,errors:n}=g(e.config);return{config:o,errors:n,path:s,existed:!0,warnings:e.warnings}}function d(s,r=l()){m(r)&&x(r,`${r}.bak`);let e=`${r}.tmp`;S(e,f.default.stringify(s,null,2)+`
`,"utf8"),b(e,r)}var w=class{constructor(r,e=l()){this.log=r;this.path=e;let o=h(e);this.#r=o.config,this.#t=o.errors,this.#n=o.warnings;for(let n of o.errors)this.log.error(`config: ${n}`);for(let n of o.warnings)this.log.warn(`config: ${n}`)}log;#r;#t=[];#n=[];#o=null;#e=null;path;get warnings(){return this.#n}get current(){return this.#r}get errors(){return this.#t}replaceAll(r){return this.#r=r,d(r,this.path),{ok:!0,errors:[]}}set(r,e){let o={...this.#r,[r]:e},{config:n,errors:t}=g(o);return t.length>0?{ok:!1,errors:t}:(this.#r=n,d(n,this.path),{ok:!0,errors:[]})}get(r){return r.split(".").reduce((e,o)=>{if(e&&typeof e=="object")return e[o]},this.#r)}setPath(r,e){let o=r.split(".")[0],n=structuredClone(this.#r),t=n,i=r.split(".");for(let a of i.slice(0,-1)){let u=t[a];(!u||typeof u!="object")&&(t[a]={}),t=t[a]}return t[i[i.length-1]]=e,this.set(o,n[o])}watchForChanges(r){if(!this.#o)try{let e=F(this.path),o=T(this.path);this.#o=v(e,(n,t)=>{t&&t.toString()!==o||(this.#e&&clearTimeout(this.#e),this.#e=setTimeout(()=>{let i=h(this.path);if(i.errors.length>0){this.#t=i.errors,this.log.error(`config reload rejected: ${i.errors[0]}`);return}this.#r=i.config,this.#t=[],this.#n=i.warnings;for(let a of i.warnings)this.log.warn(`config: ${a}`);this.log.info("config reloaded"),r?.(i.config)},250))})}catch(e){this.log.warn(`config hot-reload unavailable: ${e.message}`)}}stopWatching(){this.#e&&clearTimeout(this.#e),this.#e=null,this.#o?.close(),this.#o=null}stop(){this.#o?.close(),this.#o=null,this.#e&&clearTimeout(this.#e)}};export{O as a,h as b,d as c,w as d};
