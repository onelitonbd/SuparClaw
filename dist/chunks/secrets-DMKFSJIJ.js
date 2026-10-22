import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);
import{a as r}from"./chunk-RUGDGSX3.js";import{a as $,b as v,c as E,d as R,e as y,f as S}from"./chunk-ADPWOZIS.js";import{e as h}from"./chunk-TETLWCCO.js";import{a as x}from"./chunk-5W2H57UO.js";import{c as b}from"./chunk-EEEC4TXW.js";var k=b(x(),1);import{existsSync as N,readFileSync as _}from"node:fs";var w=`usage: sc secrets <subcommand> [options]

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
`;async function I(f){let d=f[0],u=f.slice(1),i=u.includes("--json");switch(d){case"refs":case"help":case"--help":case void 0:return console.log(w),console.log(`SecretRef validation (their patterns):
  provider  ${$}
  env id    ${v}
  file id   absolute JSON pointer, e.g. /providers/openai/apiKey
  exec id   ${E}  (no "." or ".." segments)`),d===void 0?2:0;case"audit":{let t=h();if(!N(t)){let e={ok:!0,findings:[],note:`no config at ${t}`};return console.log(i?JSON.stringify(e,null,2):r.info(`no config at ${t} \u2014 nothing to audit`)),0}let c;try{c=k.default.parse(_(t,"utf8"))}catch(e){let s=`config parse failed: ${e.message}`;return i?console.log(JSON.stringify({ok:!1,error:s})):console.error(r.error(`\u2716 ${s}`)),2}let{findings:p,warnings:g}=S(c),m=[],a=(e,s)=>{if(R(e)){let n=y(e);n&&m.push(`invalid SecretRef at ${s}: ${n}`)}else if(Array.isArray(e))e.forEach((n,l)=>a(n,`${s}[${l}]`));else if(e&&typeof e=="object")for(let[n,l]of Object.entries(e))a(l,s?`${s}.${n}`:n)};a(c,"");let o=[...p,...m.filter(e=>!p.includes(e))],O=o.filter(e=>e.startsWith("unresolved"));if(i)console.log(JSON.stringify({ok:o.length===0,findings:o,warnings:g},null,2));else if(o.length===0)console.log(`${r.success("\u2714")} no plaintext credentials or unresolved refs in ${t}`);else{console.log(r.warn(`\u25B2 ${o.length} finding(s) in ${t}:`));for(let e of o)console.log(`  - ${e}`);for(let e of g)console.log(r.muted(`  \xB7 ${e}`));console.log(r.muted("  fix: replace the value with ${ENV_VAR} or a SecretRef (see: sc secrets refs)"))}return O.length>0?2:u.includes("--check")&&o.length>0?1:0}default:return console.log(w),2}}export{I as cmdSecrets};
