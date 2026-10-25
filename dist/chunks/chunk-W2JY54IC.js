import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);
import{f as h}from"./chunk-547RLRPI.js";import{e as g}from"./chunk-S3U4FQ4A.js";import{a as k}from"./chunk-6FMFH3K6.js";import{d as c,f}from"./chunk-52SM7GJ6.js";import{a as l,d as y}from"./chunk-YLPL3IHV.js";var u=y(k(),1);import{readFileSync as S,writeFileSync as b,renameSync as x,copyFileSync as v,existsSync as C}from"node:fs";import{watch as F}from"node:fs";import{dirname as T,basename as $}from"node:path";var P=`// SuparClaw config (JSON5: comments allowed)
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
`;function d(i=g()){if(!C(i))return{config:f(),errors:[],path:i,existed:!1,warnings:[]};let r;try{r=u.default.parse(S(i,"utf8"))}catch(t){return{config:f(),errors:[`${i}: ${t.message}`],path:i,existed:!0,warnings:[]}}let o=h(r),{config:e,errors:n}=c(o.config);return{config:e,errors:n,path:i,existed:!0,warnings:o.warnings}}l(d,"readConfigFile");function w(i,r=g()){C(r)&&v(r,`${r}.bak`);let o=`${r}.tmp`;b(o,u.default.stringify(i,null,2)+`
`,"utf8"),x(o,r)}l(w,"writeConfigFile");var m=class{constructor(r,o=g()){this.log=r;this.path=o;let e=d(o);this.#r=e.config,this.#t=e.errors,this.#n=e.warnings;for(let n of e.errors)this.log.error(`config: ${n}`);for(let n of e.warnings)this.log.warn(`config: ${n}`)}log;static{l(this,"ConfigService")}#r;#t=[];#n=[];#e=null;#o=null;path;get warnings(){return this.#n}get current(){return this.#r}get errors(){return this.#t}replaceAll(r){return this.#r=r,w(r,this.path),{ok:!0,errors:[]}}set(r,o){let e={...this.#r,[r]:o},{config:n,errors:t}=c(e);return t.length>0?{ok:!1,errors:t}:(this.#r=n,w(n,this.path),{ok:!0,errors:[]})}get(r){return r.split(".").reduce((o,e)=>{if(o&&typeof o=="object")return o[e]},this.#r)}setPath(r,o){let e=r.split(".")[0],n=structuredClone(this.#r),t=n,s=r.split(".");for(let a of s.slice(0,-1)){let p=t[a];(!p||typeof p!="object")&&(t[a]={}),t=t[a]}return t[s[s.length-1]]=o,this.set(e,n[e])}unsetPath(r){let o=r.split(".")[0],e=structuredClone(this.#r),n=r.split("."),t=e;for(let s of n.slice(0,-1)){let a=t[s];(!a||typeof a!="object")&&(t[s]={}),t=t[s]}return delete t[n[n.length-1]],this.set(o,e[o])}watchForChanges(r){if(!this.#e)try{let o=T(this.path),e=$(this.path);this.#e=F(o,(n,t)=>{t&&t.toString()!==e||(this.#o&&clearTimeout(this.#o),this.#o=setTimeout(()=>{let s=d(this.path);if(s.errors.length>0){this.#t=s.errors,this.log.error(`config reload rejected: ${s.errors[0]}`);return}this.#r=s.config,this.#t=[],this.#n=s.warnings;for(let a of s.warnings)this.log.warn(`config: ${a}`);this.log.info("config reloaded"),r?.(s.config)},250))})}catch(o){this.log.warn(`config hot-reload unavailable: ${o.message}`)}}stopWatching(){this.#o&&clearTimeout(this.#o),this.#o=null,this.#e?.close(),this.#e=null}stop(){this.#e?.close(),this.#e=null,this.#o&&clearTimeout(this.#o)}};export{P as a,d as b,w as c,m as d};
