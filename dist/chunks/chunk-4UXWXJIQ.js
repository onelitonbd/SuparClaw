import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);
import{a as b,e as x,h as P}from"./chunk-VA5GZC6U.js";import{a as y}from"./chunk-YLPL3IHV.js";import{existsSync as S,statSync as T}from"node:fs";import{basename as f,isAbsolute as A,join as w,resolve as k}from"node:path";async function v(i,e){let n=i.trim();if(!n)return{error:"empty path"};if(/^https?:\/\//i.test(n)){let o=C(e,null),d=await fetch(n,{signal:AbortSignal.timeout(3e4)});if(!d.ok)return{error:`fetch failed: HTTP ${d.status}`};let l=Buffer.from(await d.arrayBuffer());if(l.length>o)return{error:`${f(n)} is ${l.length} bytes (cap ${o})`};let{mkdtempSync:c,writeFileSync:u}=await import("node:fs"),{tmpdir:s}=await import("node:os"),t=c(w(s(),"sc-pdf-url-"));return n=w(t,f(n.split("?")[0])||"document.pdf"),u(n,l),{input:i,resolved:n}}let p=A(n)?n:k(e.workspace,n);return S(p)?{input:i,resolved:p}:{error:`no such file: ${i}`}}y(v,"resolveOne");function C(i,e){return e&&e>0?e*1048576:i.config.tools.media.pdf.maxBytes>0?i.config.tools.media.pdf.maxBytes:10485760}y(C,"maxBytesOf");async function D(i,e,n=P,p=e.log){let o=i,d=[...o.pdf?[o.pdf]:[],...Array.isArray(o.pdfs)?o.pdfs.map(String):[]],l=[...new Set(d.map(t=>t.trim()).filter(Boolean))];if(l.length===0)return"Provide pdf or pdfs (up to 10).";if(l.length>10)return`Too many PDFs (${l.length}) \u2014 cap is 10.`;let c=C(e,typeof o.maxBytesMb=="number"?o.maxBytesMb:null),u=(e.config.tools.media.models??[]).filter(t=>Array.isArray(t.capabilities)&&t.capabilities.includes("pdf")).map(t=>({...t,capabilities:t.capabilities.filter(a=>a==="image"||a==="audio"||a==="pdf")})),s=[];for(let t of l){let a=await v(t,e);if("error"in a){s.push(`### ${f(t)}
error: ${a.error}`);continue}let $=T(a.resolved).size;if($>c){s.push(`### ${f(t)}
error: ${$} bytes exceeds the ${c}-byte cap (raise maxBytesMb or tools.media.pdf.maxBytes)`);continue}let m="",h=null;try{let r=await b(a.resolved,{maxChars:e.config.tools.media.pdf.maxChars||4e3});m=r.text,r.truncated&&r.text&&(m+=`

[excerpt \u2014 document truncated at the char budget]`)}catch(r){h=r.message}if(!m){for(let r of u)if(r.type==="cli")try{let g=(await n(r.command,x(r,{kind:"pdf",path:a.resolved},{maxChars:e.config.tools.media.pdf.maxChars||4e3,prompt:String(o.prompt??"Analyze this PDF document."),outputDir:"/tmp",index:0}),(Number(r.timeoutSeconds??0)>0?r.timeoutSeconds:e.config.tools.media.pdf.timeoutSeconds||60)*1e3)).trim();if(g){m=g;break}}catch(g){p.warn(`pdf cli entry ${r.command} failed: ${g.message}`)}}if(!m){s.push(`### ${f(t)}
error: no extractable text${h?` (${h})`:""}${u.length===0?" \u2014 configure a tools.media.models CLI entry (e.g. pdftotext) as the fallback lane":""}`);continue}let B=String(o.prompt??"Analyze this PDF document.");if(e.llmText)try{let r=await e.llmText([{role:"user",content:`${B}

--- begin PDF "${f(t)}" ---
${m}
--- end "${f(t)}" ---`}],{model:typeof o.model=="string"&&o.model.trim()?o.model.trim():void 0});s.push(`### ${t}
${r.trim()}`)}catch(r){s.push(`### ${t}
(analysis failed: ${r.message})

${m}`)}else s.push(`### ${t}
${m}`)}return s.join(`

`)}y(D,"analyzePdfs");export{D as a};
