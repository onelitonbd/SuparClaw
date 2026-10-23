import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);
import{a as $,e as b,h as x}from"./chunk-XE5AR5NX.js";import{existsSync as B,statSync as S}from"node:fs";import{basename as f,isAbsolute as T,join as P,resolve as A}from"node:path";async function k(i,e){let n=i.trim();if(!n)return{error:"empty path"};if(/^https?:\/\//i.test(n)){let o=w(e,null),d=await fetch(n,{signal:AbortSignal.timeout(3e4)});if(!d.ok)return{error:`fetch failed: HTTP ${d.status}`};let l=Buffer.from(await d.arrayBuffer());if(l.length>o)return{error:`${f(n)} is ${l.length} bytes (cap ${o})`};let{mkdtempSync:c,writeFileSync:u}=await import("node:fs"),{tmpdir:s}=await import("node:os"),t=c(P(s(),"sc-pdf-url-"));return n=P(t,f(n.split("?")[0])||"document.pdf"),u(n,l),{input:i,resolved:n}}let p=T(n)?n:A(e.workspace,n);return B(p)?{input:i,resolved:p}:{error:`no such file: ${i}`}}function w(i,e){return e&&e>0?e*1048576:i.config.tools.media.pdf.maxBytes>0?i.config.tools.media.pdf.maxBytes:10485760}async function z(i,e,n=x,p=e.log){let o=i,d=[...o.pdf?[o.pdf]:[],...Array.isArray(o.pdfs)?o.pdfs.map(String):[]],l=[...new Set(d.map(t=>t.trim()).filter(Boolean))];if(l.length===0)return"Provide pdf or pdfs (up to 10).";if(l.length>10)return`Too many PDFs (${l.length}) \u2014 cap is 10.`;let c=w(e,typeof o.maxBytesMb=="number"?o.maxBytesMb:null),u=(e.config.tools.media.models??[]).filter(t=>Array.isArray(t.capabilities)&&t.capabilities.includes("pdf")).map(t=>({...t,capabilities:t.capabilities.filter(a=>a==="image"||a==="audio"||a==="pdf")})),s=[];for(let t of l){let a=await k(t,e);if("error"in a){s.push(`### ${f(t)}
error: ${a.error}`);continue}let h=S(a.resolved).size;if(h>c){s.push(`### ${f(t)}
error: ${h} bytes exceeds the ${c}-byte cap (raise maxBytesMb or tools.media.pdf.maxBytes)`);continue}let m="",y=null;try{let r=await $(a.resolved,{maxChars:e.config.tools.media.pdf.maxChars||4e3});m=r.text,r.truncated&&r.text&&(m+=`

[excerpt \u2014 document truncated at the char budget]`)}catch(r){y=r.message}if(!m){for(let r of u)if(r.type==="cli")try{let g=(await n(r.command,b(r,{kind:"pdf",path:a.resolved},{maxChars:e.config.tools.media.pdf.maxChars||4e3,prompt:String(o.prompt??"Analyze this PDF document."),outputDir:"/tmp",index:0}),(Number(r.timeoutSeconds??0)>0?r.timeoutSeconds:e.config.tools.media.pdf.timeoutSeconds||60)*1e3)).trim();if(g){m=g;break}}catch(g){p.warn(`pdf cli entry ${r.command} failed: ${g.message}`)}}if(!m){s.push(`### ${f(t)}
error: no extractable text${y?` (${y})`:""}${u.length===0?" \u2014 configure a tools.media.models CLI entry (e.g. pdftotext) as the fallback lane":""}`);continue}let C=String(o.prompt??"Analyze this PDF document.");if(e.llmText)try{let r=await e.llmText([{role:"user",content:`${C}

--- begin PDF "${f(t)}" ---
${m}
--- end "${f(t)}" ---`}],{model:typeof o.model=="string"&&o.model.trim()?o.model.trim():void 0});s.push(`### ${t}
${r.trim()}`)}catch(r){s.push(`### ${t}
(analysis failed: ${r.message})

${m}`)}else s.push(`### ${t}
${m}`)}return s.join(`

`)}export{z as a};
