import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);
import{a as l}from"./chunk-RUGDGSX3.js";import{a as R,b as S,c as k,d as h,e as m,f as w}from"./chunk-ADPWOZIS.js";import{e as E}from"./chunk-TETLWCCO.js";import{a as N}from"./chunk-5W2H57UO.js";import{c as A}from"./chunk-EEEC4TXW.js";var y=A(N(),1);import{existsSync as b,readFileSync as x}from"node:fs";var v=`usage: sc secrets <subcommand> [options]

subcommands:
  audit [--check] [--json]   scan the active config for plaintext credentials
                             at credential paths, unresolved \${ENV} refs and
                             broken SecretRefs/providers (paths only, never values)
  refs                       print the SecretRef contract + a 1Password recipe

Exit codes (their CI semantics): audit --check \u2192 1 on findings;
unresolved refs are findings and always reported first.

SecretRefs in config.json5 (plaintext still works \u2014 refs are additive):

  {
    providers: {
      openrouter: {
        apiKey: "\${OPENROUTER_API_KEY}"            // env substitution
        // or: apiKey: { source: "env", id: "OPENROUTER_API_KEY" }
        // or: apiKey: { source: "file", provider: "main", id: "/openrouter/apiKey" }
        // or: apiKey: { source: "exec", provider: "op", id: "op://Vault/OpenRouter/credential" }
      }
    },
    secrets: {
      providers: {
        main: { source: "file", path: "~/.suparclaw/secrets.json", mode: "json" },
        op:   { source: "exec", command: "/usr/local/bin/op", args: ["read"] }  // 1Password CLI
      }
    }
  }
`;function I(f){if(!b(f))return{ok:!0,findings:[],warnings:[],note:`no config at ${f}`};let d;try{d=y.default.parse(x(f,"utf8"))}catch(n){return{ok:!1,findings:[],warnings:[],error:`config parse failed: ${n.message}`}}let{findings:u,warnings:g}=w(d),s=[],t=(n,i)=>{if(h(n)){let r=m(n);r&&s.push(`invalid SecretRef at ${i}: ${r}`)}else if(Array.isArray(n))n.forEach((r,o)=>t(r,`${i}[${o}]`));else if(n&&typeof n=="object")for(let[r,o]of Object.entries(n))t(o,i?`${i}.${r}`:r)};t(d,"");let p=[...u,...s.filter(n=>!u.includes(n))];return{ok:p.length===0,findings:p,warnings:g}}async function J(f){let d=f[0],u=f.slice(1),g=u.includes("--json");switch(d){case"refs":case"help":case"--help":case void 0:return console.log(v),console.log(`SecretRef validation (their patterns):
  provider  ${R}
  env id    ${S}
  file id   absolute JSON pointer, e.g. /providers/openai/apiKey
  exec id   ${k}  (no "." or ".." segments)`),d===void 0?2:0;case"audit":{let s=E();if(!b(s)){let e={ok:!0,findings:[],note:`no config at ${s}`};return console.log(g?JSON.stringify(e,null,2):l.info(`no config at ${s} \u2014 nothing to audit`)),0}let t;try{t=y.default.parse(x(s,"utf8"))}catch(e){let c=`config parse failed: ${e.message}`;return g?console.log(JSON.stringify({ok:!1,error:c})):console.error(l.error(`\u2716 ${c}`)),2}let{findings:p,warnings:n}=w(t),i=[],r=(e,c)=>{if(h(e)){let a=m(e);a&&i.push(`invalid SecretRef at ${c}: ${a}`)}else if(Array.isArray(e))e.forEach((a,$)=>r(a,`${c}[${$}]`));else if(e&&typeof e=="object")for(let[a,$]of Object.entries(e))r($,c?`${c}.${a}`:a)};r(t,"");let o=[...p,...i.filter(e=>!p.includes(e))],O=o.filter(e=>e.startsWith("unresolved"));if(g)console.log(JSON.stringify({ok:o.length===0,findings:o,warnings:n},null,2));else if(o.length===0)console.log(`${l.success("\u2714")} no plaintext credentials or unresolved refs in ${s}`);else{console.log(l.warn(`\u25B2 ${o.length} finding(s) in ${s}:`));for(let e of o)console.log(`  - ${e}`);for(let e of n)console.log(l.muted(`  \xB7 ${e}`));console.log(l.muted("  fix: replace the value with ${ENV_VAR} or a SecretRef (see: sc secrets refs)"))}return O.length>0?2:u.includes("--check")&&o.length>0?1:0}default:return console.log(v),2}}export{I as a,J as b};
