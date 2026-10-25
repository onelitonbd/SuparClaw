import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);
import{a as c}from"./chunk-YLPL3IHV.js";import{Worker as y}from"node:worker_threads";import{randomUUID as v}from"node:crypto";var P={enabled:"auto",executor:"node",timeoutMs:1e4,maxCodeChars:32768,maxOutputBytes:65536,maxPendingToolCalls:16,directOnly:[]},h=[{re:/^openai\/gpt-5\.[56]/,label:"gpt-5.6"},{re:/gpt-5\.[56]/,label:"gpt-5.6"},{re:/^anthropic\/claude-(fable|opus)-5/,label:"claude fable / opus 5"},{re:/claude-opus-5/,label:"claude opus 5"},{re:/claude-sonnet-5/,label:"claude sonnet 5"},{re:/claude-mythos-5/,label:"claude mythos 5"},{re:/deepseek-v4-(pro|flash)/,label:"deepseek v4 pro / flash"},{re:/gemini-(4-argon|3-flash-preview|3\.1-pro-preview|3\.1-flash-lite|3\.5-flash|3\.6-flash|3\.7-flash|3\.8-flash)/,label:"gemini 3.x flash / 3.1 pro / 4-argon"},{re:/^kimi\/k3/,label:"kimi k3"},{re:/^(moonshot\/)?kimi-k3/,label:"kimi k3"},{re:/^minimax\/MiniMax-M3/,label:"MiniMax M3"},{re:/^zai\/glm-5\.[123]/,label:"glm-5.1 \u2013 5.3"},{re:/^xiaomi\/mimo-v2\.6/,label:"mimo v2.6"}],T=["node","quickjs"],k=["node"];function C(l){return k.includes(l)}c(C,"codeModeExecutorBundled");function E(l){let t=(l??"").toLowerCase();return h.some(n=>n.re.test(t))}c(E,"isPreferredCodeModeModel");function D(){return[...new Set(h.map(l=>l.label))]}c(D,"codeModePreferredFamilies");function j(l){let t=(l??"").toLowerCase();return[...new Set(h.filter(n=>n.re.test(t)).map(n=>n.label))]}c(j,"codeModeMatchedFamilies");function O(l,t){return l.enabled===!1?!1:l.enabled===!0?!0:E(t)}c(O,"codeModeEngages");function f(l){return{code:"invalid_input",error:"invalid_input",message:l}}c(f,"invalidInput");var M=[/^\s*#!\/(usr\/)?bin\/(?:ba|z|fi)?sh\b/,/^\s*(?:sudo\s+)?(?:apt|brew|curl|wget|ssh|scp|git\s+clone|docker|kubectl)\b/m,/\n\s*(?:rm -rf|chmod \d|chown )/];function _(l){return M.some(t=>t.test(l))}c(_,"looksLikeShell");var S=String.raw`
const { workerData, parentPort } = require("node:worker_threads");
const vm = require("node:vm");

const { code, tools } = workerData;
const pending = new Map();

function bridge(name, args, extra) {
  const callId = "c" + ++bridge.n;
  const p = new Promise((resolve, reject) => pending.set(callId, { resolve, reject }));
  parentPort.postMessage({ type: "call", callId, name, args: args ?? {}, extra: extra ?? {} });
  return p;
}
bridge.n = 0;

parentPort.on("message", (m) => {
  if (m.type === "resolve") {
    const t = pending.get(m.callId);
    if (t) { pending.delete(m.callId); t.resolve(m.value); }
  } else if (m.type === "reject") {
    const t = pending.get(m.callId);
    if (t) { pending.delete(m.callId); t.reject(Object.assign(new Error(m.error?.message ?? "tool error"), m.error)); }
  }
});

const ctx = {};
for (const name of tools) {
  // dotted names (catalog.search/catalog.describe) nest into objects
  const parts = name.split(".");
  let o = ctx;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (typeof o[k] !== "object" || o[k] === null) o[k] = {};
    o = o[k];
  }
  o[parts[parts.length - 1]] = (args, extra) => bridge(name, args, extra);
}
ctx.console = {
  log: (...a) => parentPort.postMessage({ type: "stdout", text: a.map(String).join(" ") + "\n" }),
  warn: (...a) => parentPort.postMessage({ type: "stdout", text: a.map(String).join(" ") + "\n" }),
  error: (...a) => parentPort.postMessage({ type: "stdout", text: a.map(String).join(" ") + "\n" }),
};
ctx.globalThis = ctx;
const sandbox = vm.createContext(ctx, {
  importModuleDynamically: () => {
    const e = new Error("dynamic import() is not available in guest code (invalid_input)");
    e.name = "EvalError";
    throw e;
  },
});

(async () => {
  let script;
  try {
    script = new vm.Script("(async () => {\n" + code + "\n})()", { filename: "exec-cell.js" });
  } catch (err) {
    parentPort.postMessage({ type: "done", ok: false, error: String(err && err.message || err), name: err && err.name });
    return; // keeps the worker alive until parent terminates
  }
  try {
    const value = await script.runInContext(sandbox, { timeout: 60_000 });
    parentPort.postMessage({ type: "done", ok: true, value: value === undefined ? null : value });
  } catch (err) {
    parentPort.postMessage({ type: "done", ok: false, error: String(err && err.message || err), name: err && err.name });
  }
})();
`,x=class{constructor(t,n){this.getTools=t;this.cfg=n}getTools;cfg;static{c(this,"CodeMode")}live=new Map;catalogSearch(t){let n=t.trim().toLowerCase(),o=[...this.getTools().values()].filter(r=>!n||r.name.toLowerCase().includes(n)||r.description.toLowerCase().includes(n));return{results:o.slice(0,20).map(r=>({id:`handle:${r.name}`,kind:"tool",description:r.description.slice(0,120),inputs:r.inputs,describe:`catalog.describe(${JSON.stringify(r.name)})`})),shown:Math.min(20,o.length),totalMatches:o.length,exactNameMatches:0,displayedNames:o.slice(0,20).map(r=>r.name)}}catalogDescribe(t){let n=this.getTools().get(t);return n?{kind:"tool",description:n.description,inputs:n.inputs,required:n.required,details:[]}:{error:"not_found",name:t}}async execCell(t,n,s){let o=this.cfg(),r=v(),i=n?{title:n}:{};if(!C(o.executor))return{runId:r,status:"error",labels:i,error:{code:"executor_unavailable",error:"executor_unavailable",message:`${o.executor} executor is not bundled in this build (their no-fallback rule: the run stops instead of broad tool exposure)`}};if(!t.trim())return{runId:r,status:"error",labels:i,error:f("empty code \u2014 exec evaluates JavaScript; `command` is their alias for code, not a shell string")};if(t.length>o.maxCodeChars)return{runId:r,status:"error",labels:i,error:f(`code is ${t.length} chars; cap is ${o.maxCodeChars} (their oversized-cell path)`)};if(_(t))return{runId:r,status:"error",labels:i,error:f("this looks like a shell command \u2014 the guest surface is JavaScript; call a tool global instead (their pre-guest reject)")};let b=this.getTools(),w=[...b.keys(),"catalog.search","catalog.describe"],d=new y(S,{eval:!0,workerData:{code:t,tools:w}}),e={runId:r,labels:i,worker:d,stdout:"",final:null,onFinal:[],bridgeInflight:0,earlyDetach:!1,timer:null,ended:!1};this.live.set(r,e);let m=c(a=>{if(!e.ended){e.ended=!0,e.timer&&clearTimeout(e.timer),this.live.delete(r),d.terminate().catch(()=>{}),e.final=a;for(let g of e.onFinal)g(a);e.onFinal.length=0}},"completed");d.on("message",a=>{if(!e.ended){if(a.type==="stdout"){e.stdout.length<o.maxOutputBytes&&(e.stdout=(e.stdout+String(a.text??"")).slice(0,o.maxOutputBytes));return}if(a.type==="call"){let g=null;if(a.name==="catalog"){d.postMessage({type:"reject",callId:a.callId,error:{code:"invalid_input",error:"invalid_input",message:"catalog is catalog.search(...) / catalog.describe(...) \u2014 their catalog has no bare call"}});return}if(a.name==="catalog.search"||a.name==="_codemode_search")g=c(()=>Promise.resolve(this.catalogSearch(String(a.args?.query??""))),"run");else if(a.name==="catalog.describe")g=c(()=>Promise.resolve(this.catalogDescribe(String(a.args?.name??""))),"run");else{let u=b.get(a.name??"");u&&(g=c(()=>u.run(a.args,a.extra),"run"))}if(!g){d.postMessage({type:"reject",callId:a.callId,error:{code:"not_found",error:"not_found",message:`unknown guest global ${a.name} \u2014 use catalog.search(...) (their discovery rule)`}});return}if(e.bridgeInflight>=o.maxPendingToolCalls){d.postMessage({type:"reject",callId:a.callId,error:{code:"too_many_pending",error:"too_many_pending",message:`${o.maxPendingToolCalls} tool calls already pending (their maxPendingToolCalls cap)`}});return}e.bridgeInflight+=1,g().then(u=>{e.ended||d.postMessage({type:"resolve",callId:a.callId,value:u})}).catch(u=>{e.ended||d.postMessage({type:"reject",callId:a.callId,error:{code:u.code??"tool_error",error:u.code??"tool_error",message:u.message}})}).finally(()=>{e.bridgeInflight-=1,e.bridgeInflight===0&&e.settledValue!==void 0&&!e.ended&&m({runId:r,status:"completed",labels:i,value:e.settledValue,output:e.stdout||void 0,streamError:null})});return}if(a.type==="done"){if(a.ok){if(e.settledValue=a.value??null,e.bridgeInflight>0){e.earlyDetach=!0;return}m({runId:r,status:"completed",labels:i,value:e.settledValue??{valueFromCompletion:!0},output:e.stdout||void 0,streamError:null})}else m({runId:r,status:"error",labels:i,error:{code:a.error==="EvalError"?"invalid_input":"exec_error",error:a.error==="EvalError"?"invalid_input":"exec_error",message:String(a.error??"cell failed"),stdout:e.stdout||void 0}});return}}}),d.on("error",a=>{m({runId:r,status:"error",labels:i,error:{code:"exec_error",error:"exec_error",message:a.message,stdout:e.stdout||void 0}})}),d.on("exit",a=>{e.ended||(e.settledValue!==void 0||e.earlyDetach?m({runId:r,status:"completed",labels:i,value:e.settledValue??{valueFromCompletion:!0},output:e.stdout||void 0,streamError:null}):m({runId:r,status:"error",labels:i,error:{code:"exec_error",error:"exec_error",message:`worker exited without a result (code ${a})`,stdout:e.stdout||void 0}}))}),s&&s.addEventListener("abort",()=>{this.end(r,{runId:r,status:"cancelled",labels:i,error:{code:"cancelled",error:"cancelled",message:"aborted by the parent turn (their cancellation path)",stdout:e.stdout||void 0}})},{once:!0});let p=await this.awaitBudget(e,o.timeoutMs);return p==="tick"?e.earlyDetach?(e.earlyDetach=!1,{runId:r,status:"waiting",labels:i,streamedRange:void 0,streamError:null}):e.bridgeInflight>0?{runId:r,status:"waiting",labels:i,streamedRange:void 0,streamError:null}:this.end(r,{runId:r,status:"error",labels:i,error:{code:"timeout",error:"timeout",message:`guest computation exhausted the ${o.timeoutMs}ms call budget (their timeout path)`,stdout:e.stdout||void 0}}):p==="early"?(e.earlyDetach=!1,{runId:r,status:"waiting",labels:i,streamedRange:void 0,streamError:null}):p}awaitBudget(t,n){return new Promise(s=>{let o=setTimeout(()=>s("tick"),n),r=c(()=>{if(t.final){clearTimeout(o),s(t.final);return}if(t.earlyDetach){clearTimeout(o),s("early");return}setImmediate(r)},"watch");t.onFinal.push(i=>{clearTimeout(o),s(i)}),r()})}async wait(t,n){let s=this.cfg(),o=this.live.get(t);if(!o)return{runId:t,status:"error",labels:{},error:{code:"path_limited",error:"path_limited",message:`no live code-mode cell for runId=${t}`}};if(o.final)return o.final;let r=Math.min(Math.max(n??s.timeoutMs,100),6e4),i=await this.awaitBudget(o,r);return i==="tick"||i==="early"?this.live.has(t)?{runId:t,status:"waiting",labels:o.labels,streamedRange:void 0,streamError:null}:{runId:t,status:"error",labels:{},error:{code:"path_limited",error:"path_limited",message:`cell ${t} ended without a final result`}}:i}async cancel(t,n){let s=n??{code:"cancelled",message:"cancelled"},o={runId:t,status:"cancelled",labels:{},error:{code:s.code,error:s.code,message:s.message}};return this.end(t,o)}async end(t,n){let s=this.live.get(t);if(!s||s.ended)return n;s.ended=!0,s.timer&&clearTimeout(s.timer),this.live.delete(t),await s.worker.terminate().catch(()=>{}),s.final=n;for(let o of s.onFinal)o(n);return s.onFinal.length=0,n}};function L(l){let t=c((n,s)=>JSON.stringify(s!==void 0?{...n,source:`// Code Mode
${s.slice(0,4e3)}`}:n,null,2),"render");return[{name:"exec",description:"Evaluate JavaScript in the code-mode executor (their exec). Tools are exposed as async globals in the guest; use catalog.search(...) to find them. `command` is an alias for `code`, and is still JavaScript \u2014 not a shell string.",parameters:{type:"object",properties:{title:{type:"string",description:"Human label for the cell (their titles field)"},code:{type:"string",description:"JavaScript source"},command:{type:"string",description:"alias for code (their command alias)"}},required:[]},async run(n,s){let o=n,r=String(o.code??o.command??""),i=await l.execCell(r,String(o.title??""),s.signal);return t(i,r)}},{name:"wait",description:"Resume a waiting code-mode cell by runId (their wait). Call this only when the exec result has status 'waiting'. Resumes with a fresh call budget.",parameters:{type:"object",properties:{runId:{type:"string",description:"runId from a waiting exec result"},timeoutMs:{type:"integer",description:"wall-clock budget for this wait call (100\u201360000; default = tools.codeMode.timeoutMs)"}},required:["runId"]},async run(n){let s=n,o=await l.wait(String(s.runId??""),s.timeoutMs);return t(o)}}]}c(L,"codeModeSurface");export{P as a,T as b,k as c,C as d,E as e,D as f,j as g,O as h,x as i,L as j};
