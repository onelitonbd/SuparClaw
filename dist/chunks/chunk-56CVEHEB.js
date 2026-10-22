import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);
import{b as $,f as x,i as b}from"./chunk-SG5FN3AU.js";import{existsSync as S,statSync as T}from"node:fs";import{basename as m,isAbsolute as A,join as P,resolve as C}from"node:path";async function k(s,t){let n=s.trim();if(!n)return{error:"empty path"};if(/^https?:\/\//i.test(n)){let o=w(t,null),f=await fetch(n,{signal:AbortSignal.timeout(3e4)});if(!f.ok)return{error:`fetch failed: HTTP ${f.status}`};let a=Buffer.from(await f.arrayBuffer());if(a.length>o)return{error:`${m(n)} is ${a.length} bytes (cap ${o})`};let{mkdtempSync:c,writeFileSync:u}=await import("node:fs"),{tmpdir:i}=await import("node:os"),e=c(P(i(),"sc-pdf-url-"));return n=P(e,m(n.split("?")[0])||"document.pdf"),u(n,a),{input:s,resolved:n}}let p=A(n)?n:C(t.workspace,n);return S(p)?{input:s,resolved:p}:{error:`no such file: ${s}`}}function w(s,t){return t&&t>0?t*1048576:s.config.tools.media.pdf.maxBytes>0?s.config.tools.media.pdf.maxBytes:10485760}async function z(s,t,n=b,p=t.log){let o=s,f=[...o.pdf?[o.pdf]:[],...Array.isArray(o.pdfs)?o.pdfs.map(String):[]],a=[...new Set(f.map(e=>e.trim()).filter(Boolean))];if(a.length===0)return"Provide pdf or pdfs (up to 10).";if(a.length>10)return`Too many PDFs (${a.length}) \u2014 cap is 10.`;let c=w(t,typeof o.maxBytesMb=="number"?o.maxBytesMb:null),u=(t.config.tools.media.models??[]).filter(e=>Array.isArray(e.capabilities)&&e.capabilities.includes("pdf")),i=[];for(let e of a){let d=await k(e,t);if("error"in d){i.push(`### ${m(e)}
error: ${d.error}`);continue}let h=T(d.resolved).size;if(h>c){i.push(`### ${m(e)}
error: ${h} bytes exceeds the ${c}-byte cap (raise maxBytesMb or tools.media.pdf.maxBytes)`);continue}let l="",y=null;try{let r=await $(d.resolved,{maxChars:t.config.tools.media.pdf.maxChars||4e3});l=r.text,r.truncated&&r.text&&(l+=`

[excerpt \u2014 document truncated at the char budget]`)}catch(r){y=r.message}if(!l){for(let r of u)if(r.type==="cli")try{let g=(await n(r.command,x(r,{kind:"pdf",path:d.resolved},{maxChars:t.config.tools.media.pdf.maxChars||4e3,prompt:String(o.prompt??"Analyze this PDF document."),outputDir:"/tmp",index:0}),(r.timeoutSeconds>0?r.timeoutSeconds:t.config.tools.media.pdf.timeoutSeconds||60)*1e3)).trim();if(g){l=g;break}}catch(g){p.warn(`pdf cli entry ${r.command} failed: ${g.message}`)}}if(!l){i.push(`### ${m(e)}
error: no extractable text${y?` (${y})`:""}${u.length===0?" \u2014 configure a tools.media.models CLI entry (e.g. pdftotext) as the fallback lane":""}`);continue}let B=String(o.prompt??"Analyze this PDF document.");if(t.llmText)try{let r=await t.llmText([{role:"user",content:`${B}

--- begin PDF "${m(e)}" ---
${l}
--- end "${m(e)}" ---`}],{model:typeof o.model=="string"&&o.model.trim()?o.model.trim():void 0});i.push(`### ${e}
${r.trim()}`)}catch(r){i.push(`### ${e}
(analysis failed: ${r.message})

${l}`)}else i.push(`### ${e}
${l}`)}return i.join(`

`)}export{z as a};
