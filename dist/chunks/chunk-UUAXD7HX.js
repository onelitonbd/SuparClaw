import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);
import{f as h}from"./chunk-547RLRPI.js";import{e as g}from"./chunk-27QGCXJK.js";import{a as y}from"./chunk-6FMFH3K6.js";import{d as c,f as u}from"./chunk-TBN4I5LM.js";import{a as l,d as k}from"./chunk-YLPL3IHV.js";var f=k(y(),1);import{readFileSync as S,writeFileSync as b,renameSync as x,copyFileSync as v,existsSync as C}from"node:fs";import{watch as F}from"node:fs";import{dirname as $,basename as T}from"node:path";var P=`// SuparClaw config (JSON5: comments allowed)
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
      maxToolIterations: 0,   // 0 = no ceiling on tool rounds per turn
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
      dmPolicy: "pairing"      // first DM needs approval: sc pair <code>
    }
  },
  tools: {
    fs: true,
    memory: true,
    web: { fetch: true, search: true },
    exec: { enabled: true }   // on by default, runs without asking; sc approvals mode ask gates it
  },
  cron: { enabled: true }
}
`;function d(i=g()){if(!C(i))return{config:u(),errors:[],path:i,existed:!1,warnings:[]};let r;try{r=f.default.parse(S(i,"utf8"))}catch(e){return{config:u(),errors:[`${i}: ${e.message}`],path:i,existed:!0,warnings:[]}}let o=h(r),{config:t,errors:n}=c(o.config);return{config:t,errors:n,path:i,existed:!0,warnings:o.warnings}}l(d,"readConfigFile");function w(i,r=g()){C(r)&&v(r,`${r}.bak`);let o=`${r}.tmp`;b(o,f.default.stringify(i,null,2)+`
`,"utf8"),x(o,r)}l(w,"writeConfigFile");var m=class{constructor(r,o=g()){this.log=r;this.path=o;let t=d(o);this.#r=t.config,this.#e=t.errors,this.#n=t.warnings;for(let n of t.errors)this.log.error(`config: ${n}`);for(let n of t.warnings)this.log.warn(`config: ${n}`)}log;static{l(this,"ConfigService")}#r;#e=[];#n=[];#t=null;#o=null;path;get warnings(){return this.#n}get current(){return this.#r}get errors(){return this.#e}replaceAll(r){return this.#r=r,w(r,this.path),{ok:!0,errors:[]}}set(r,o){let t={...this.#r,[r]:o},{config:n,errors:e}=c(t);return e.length>0?{ok:!1,errors:e}:(this.#r=n,w(n,this.path),{ok:!0,errors:[]})}get(r){return r.split(".").reduce((o,t)=>{if(o&&typeof o=="object")return o[t]},this.#r)}setPath(r,o){let t=r.split(".")[0],n=structuredClone(this.#r),e=n,s=r.split(".");for(let a of s.slice(0,-1)){let p=e[a];(!p||typeof p!="object")&&(e[a]={}),e=e[a]}return e[s[s.length-1]]=o,this.set(t,n[t])}unsetPath(r){let o=r.split(".")[0],t=structuredClone(this.#r),n=r.split("."),e=t;for(let s of n.slice(0,-1)){let a=e[s];(!a||typeof a!="object")&&(e[s]={}),e=e[s]}return delete e[n[n.length-1]],this.set(o,t[o])}watchForChanges(r){if(!this.#t)try{let o=$(this.path),t=T(this.path);this.#t=F(o,(n,e)=>{e&&e.toString()!==t||(this.#o&&clearTimeout(this.#o),this.#o=setTimeout(()=>{let s=d(this.path);if(s.errors.length>0){this.#e=s.errors,this.log.error(`config reload rejected: ${s.errors[0]}`);return}this.#r=s.config,this.#e=[],this.#n=s.warnings;for(let a of s.warnings)this.log.warn(`config: ${a}`);this.log.info("config reloaded"),r?.(s.config)},250))})}catch(o){this.log.warn(`config hot-reload unavailable: ${o.message}`)}}stopWatching(){this.#o&&clearTimeout(this.#o),this.#o=null,this.#t?.close(),this.#t=null}stop(){this.#t?.close(),this.#t=null,this.#o&&clearTimeout(this.#o)}};export{P as a,d as b,w as c,m as d};
