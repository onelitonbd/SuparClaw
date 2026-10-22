import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);
import{f as p}from"./chunk-ADPWOZIS.js";import{e as l}from"./chunk-TETLWCCO.js";import{a as C}from"./chunk-5W2H57UO.js";import{d as g,f as c}from"./chunk-TZ2K5QTO.js";import{c as m}from"./chunk-EEEC4TXW.js";var f=m(C(),1);import{readFileSync as y,writeFileSync as k,renameSync as S,copyFileSync as b,existsSync as w}from"node:fs";import{watch as x}from"node:fs";import{dirname as v,basename as F}from"node:path";var O=`// SuparClaw config (JSON5: comments allowed)
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
`;function h(s=l()){if(!w(s))return{config:c(),errors:[],path:s,existed:!1,warnings:[]};let e;try{e=f.default.parse(y(s,"utf8"))}catch(t){return{config:c(),errors:[`${s}: ${t.message}`],path:s,existed:!0,warnings:[]}}let r=p(e),{config:o,errors:n}=g(r.config);return{config:o,errors:n,path:s,existed:!0,warnings:r.warnings}}function T(s,e=l()){w(e)&&b(e,`${e}.bak`);let r=`${e}.tmp`;k(r,f.default.stringify(s,null,2)+`
`,"utf8"),S(r,e)}var d=class{constructor(e,r=l()){this.log=e;this.path=r;let o=h(r);this.#e=o.config,this.#t=o.errors,this.#n=o.warnings;for(let n of o.errors)this.log.error(`config: ${n}`);for(let n of o.warnings)this.log.warn(`config: ${n}`)}log;#e;#t=[];#n=[];#o=null;#r=null;path;get warnings(){return this.#n}get current(){return this.#e}get errors(){return this.#t}set(e,r){let o={...this.#e,[e]:r},{config:n,errors:t}=g(o);return t.length>0?{ok:!1,errors:t}:(this.#e=n,T(n,this.path),{ok:!0,errors:[]})}get(e){return e.split(".").reduce((r,o)=>{if(r&&typeof r=="object")return r[o]},this.#e)}setPath(e,r){let o=e.split(".")[0],n=structuredClone(this.#e),t=n,i=e.split(".");for(let a of i.slice(0,-1)){let u=t[a];(!u||typeof u!="object")&&(t[a]={}),t=t[a]}return t[i[i.length-1]]=r,this.set(o,n[o])}watchForChanges(e){if(!this.#o)try{let r=v(this.path),o=F(this.path);this.#o=x(r,(n,t)=>{t&&t.toString()!==o||(this.#r&&clearTimeout(this.#r),this.#r=setTimeout(()=>{let i=h(this.path);if(i.errors.length>0){this.#t=i.errors,this.log.error(`config reload rejected: ${i.errors[0]}`);return}this.#e=i.config,this.#t=[],this.#n=i.warnings;for(let a of i.warnings)this.log.warn(`config: ${a}`);this.log.info("config reloaded"),e?.(i.config)},250))})}catch(r){this.log.warn(`config hot-reload unavailable: ${r.message}`)}}stopWatching(){this.#r&&clearTimeout(this.#r),this.#r=null,this.#o?.close(),this.#o=null}stop(){this.#o?.close(),this.#o=null,this.#r&&clearTimeout(this.#r)}};export{O as a,h as b,T as c,d};
