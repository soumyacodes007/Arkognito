import { Identity } from '@semaphore-protocol/identity';
import { Group } from '@semaphore-protocol/group';
import { generateProof, verifyProof } from '@semaphore-protocol/proof';
import { randomBytes, createHash } from 'node:crypto';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const result = { started: new Date().toISOString(), runtime: process.version, downloads: [], cases: {} };
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => { const t = performance.now(); const r = await nativeFetch(url, { ...opts, signal: AbortSignal.timeout(180000) }); result.downloads.push({url:String(url), status:r.status, headerBytes:r.headers.get('content-length'), responseMs:performance.now()-t}); return r; };
const save = () => writeFileSync(new URL('result.json', import.meta.url), JSON.stringify(result, null, 2));
try {
  const secret = randomBytes(32);
  const identity = new Identity(secret);
  result.deterministic = identity.commitment === new Identity(secret).commitment;
  const members = [identity, ...Array.from({length:4},()=>new Identity(randomBytes(32)))];
  const group = new Group(members.map(i=>i.commitment));
  const content = { text:'Synthetic feasibility post', owner:'synthetic-recipient', group:'synthetic-five', scope:'2026-10-17' };
  const message = BigInt('0x'+createHash('sha256').update(JSON.stringify(content)).digest('hex')).toString();
  const scope = 20261017n;
  let t = performance.now();
  const proof = await generateProof(identity, group, message, scope, 3);
  result.proofMs = performance.now()-t;
  t = performance.now(); result.verified = await verifyProof(proof); result.verifyMs = performance.now()-t;
  result.proofJsonBytes = Buffer.byteLength(JSON.stringify(proof)); result.groupSize=members.length; result.depth=3;
  const artifacts = {};
  mkdirSync(new URL('artifacts/', import.meta.url),{recursive:true});
  for (const ext of ['wasm','zkey']) {
    const url=`https://snark-artifacts.pse.dev/semaphore/4.13.0/semaphore-3.${ext}`;
    const t0=performance.now(); const response=await fetch(url); if(!response.ok)throw Error(`${url}: HTTP ${response.status}`);
    const bytes=Buffer.from(await response.arrayBuffer()); const path=new URL(`artifacts/semaphore-3.${ext}`, import.meta.url);
    writeFileSync(path,bytes); artifacts[ext]={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),downloadMs:performance.now()-t0};
  }
  result.artifacts=artifacts;
  // Actually serve the files from our own HTTP origin, download them, and supply the bytes.
  const server=createServer((req,res)=>{const ext=req.url?.endsWith('.wasm')?'wasm':'zkey';res.end(readFileSync(new URL(`artifacts/semaphore-3.${ext}`,import.meta.url)));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try {
    const origin=`http://127.0.0.1:${server.address().port}`;
    const wasm=new Uint8Array(await (await fetch(`${origin}/semaphore-3.wasm`)).arrayBuffer());
    const zkey=new Uint8Array(await (await fetch(`${origin}/semaphore-3.zkey`)).arrayBuffer());
    t=performance.now(); const hosted=await generateProof(identity,group,message,scope,3,{wasm,zkey});
    result.selfHostedProofMs=performance.now()-t; result.selfHostedVerified=await verifyProof(hosted);
  } finally { server.closeAllConnections(); await new Promise(r=>server.close(r)); }
  for (const [name,p] of Object.entries({fake:{...proof,points:Array(8).fill('0')},changedMessage:{...proof,message:'1'},changedScope:{...proof,scope:'1'}})) {
    try { result.cases[name]={accepted:await verifyProof(p)}; } catch(e){result.cases[name]={accepted:false,error:e.message};}
  }
  try { await generateProof(new Identity(randomBytes(32)),group,message,scope,3); result.cases.nonMember={accepted:true}; }
  catch(e){result.cases.nonMember={accepted:false,error:e.message};}
  // No identity secret is persisted; this fixture contains random commitments and a public proof only.
  writeFileSync(new URL('fixture.json', import.meta.url),JSON.stringify({content,proof,commitments:members.map(i=>i.commitment.toString())},null,2));
  result.verdict=result.verified&&result.selfHostedVerified&&result.deterministic?'GO':'NO-GO';
} catch(e){result.verdict='RISKY';result.error=e.stack;}
save(); console.log(JSON.stringify(result,null,2)); process.exit(result.error?1:0);
