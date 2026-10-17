import {readFileSync,writeFileSync} from 'node:fs';
const result={started:new Date().toISOString(),sources:[],checks:[]};
const sources=[['installed snarkjs 0.7.6 README',readFileSync(new URL('node_modules/snarkjs/README.md',import.meta.url),'utf8')]];
try{const r=await fetch('https://raw.githubusercontent.com/iden3/snarkjs/master/README.md',{signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error(`README HTTP ${r.status}`);sources.push(['current official snarkjs README',await r.text()]);}catch(e){result.sourceError=e.message;}
const urls=new Set();
for(const [name,body] of sources){const found=[...body.matchAll(/https:\/\/[^\s)\]|]+powersOfTau[^\s)\]|]+/g)].map(m=>m[0]).filter(u=>u.endsWith('_final_21.ptau'));result.sources.push({name,urls:found});for(const url of found)urls.add(url);}
for(const url of urls){const out={url};try{const r=await fetch(url,{headers:{range:'bytes=0-31'},signal:AbortSignal.timeout(15000)});Object.assign(out,{status:r.status,contentLength:r.headers.get('content-length'),contentRange:r.headers.get('content-range')});if(!r.ok)out.error=await r.text();else await r.body.cancel();}catch(e){out.error=e.message;}result.checks.push(out);}
writeFileSync(new URL('artifact-check-result.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
