import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);
import{a as l}from"./chunk-BARRNHX4.js";import{a as S,b as k,c as v,d as m,e as w,f as y}from"./chunk-547RLRPI.js";import{e as R}from"./chunk-27QGCXJK.js";import{a as _}from"./chunk-6FMFH3K6.js";import{a as $,d as N}from"./chunk-YLPL3IHV.js";var E=N(_(),1);import{existsSync as x,readFileSync as O}from"node:fs";var b=`usage: sc secrets <subcommand> [options]

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
`;function J(f){if(!x(f))return{ok:!0,findings:[],warnings:[],note:`no config at ${f}`};let d;try{d=E.default.parse(O(f,"utf8"))}catch(n){return{ok:!1,findings:[],warnings:[],error:`config parse failed: ${n.message}`}}let{findings:u,warnings:g}=y(d),s=[],t=$((n,i)=>{if(m(n)){let r=w(n);r&&s.push(`invalid SecretRef at ${i}: ${r}`)}else if(Array.isArray(n))n.forEach((r,o)=>t(r,`${i}[${o}]`));else if(n&&typeof n=="object")for(let[r,o]of Object.entries(n))t(o,i?`${i}.${r}`:r)},"walk");t(d,"");let p=[...u,...s.filter(n=>!u.includes(n))];return{ok:p.length===0,findings:p,warnings:g}}$(J,"auditSecretsFile");async function V(f){let d=f[0],u=f.slice(1),g=u.includes("--json");switch(d){case"refs":case"help":case"--help":case void 0:return console.log(b),console.log(`SecretRef validation (their patterns):
  provider  ${S}
  env id    ${k}
  file id   absolute JSON pointer, e.g. /providers/openai/apiKey
  exec id   ${v}  (no "." or ".." segments)`),d===void 0?2:0;case"audit":{let s=R();if(!x(s)){let e={ok:!0,findings:[],note:`no config at ${s}`};return console.log(g?JSON.stringify(e,null,2):l.info(`no config at ${s} \u2014 nothing to audit`)),0}let t;try{t=E.default.parse(O(s,"utf8"))}catch(e){let c=`config parse failed: ${e.message}`;return g?console.log(JSON.stringify({ok:!1,error:c})):console.error(l.error(`\u2716 ${c}`)),2}let{findings:p,warnings:n}=y(t),i=[],r=$((e,c)=>{if(m(e)){let a=w(e);a&&i.push(`invalid SecretRef at ${c}: ${a}`)}else if(Array.isArray(e))e.forEach((a,h)=>r(a,`${c}[${h}]`));else if(e&&typeof e=="object")for(let[a,h]of Object.entries(e))r(h,c?`${c}.${a}`:a)},"walk");r(t,"");let o=[...p,...i.filter(e=>!p.includes(e))],A=o.filter(e=>e.startsWith("unresolved"));if(g)console.log(JSON.stringify({ok:o.length===0,findings:o,warnings:n},null,2));else if(o.length===0)console.log(`${l.success("\u2714")} no plaintext credentials or unresolved refs in ${s}`);else{console.log(l.warn(`\u25B2 ${o.length} finding(s) in ${s}:`));for(let e of o)console.log(`  - ${e}`);for(let e of n)console.log(l.muted(`  \xB7 ${e}`));console.log(l.muted("  fix: replace the value with ${ENV_VAR} or a SecretRef (see: sc secrets refs)"))}return A.length>0?2:u.includes("--check")&&o.length>0?1:0}default:return console.log(b),2}}$(V,"cmdSecrets");export{J as a,V as b};
