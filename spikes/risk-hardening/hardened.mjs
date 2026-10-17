// Isolated research mitigation controls. Never imports existing Veil packages.
import {createServer} from 'node:http';
import {openSync,closeSync,unlinkSync,readFileSync,appendFileSync,existsSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {validatePost,windowScope} from '../s4-verify-read/read-posts.mjs';

export class VerificationUnavailable extends Error {constructor(message){super(message);this.name='VerificationUnavailable';}}
export function checkedStore(store){return Object.fromEntries(['getHead','getGroupAt','getMembersAt','listPosts'].map(name=>[name,async(...args)=>{try{return await store[name](...args);}catch(e){throw new VerificationUnavailable(`${name}: ${e.message}`);}}]));}
export const valid=async(post,group,scope,store)=>validatePost(post,group,scope,checkedStore(store));
export const admissionId=(group,scope,nullifier)=>`${group}|${scope}|${nullifier}`;

// One shared coordinator on one host. Exclusive file creation serializes claims
// across processes; no stale lock is automatically removed after a crash.
export class Journal {
 constructor(file){this.file=file;this.lock=file+'.lock';mkdirSync(dirname(file),{recursive:true});}
 async locked(fn){let fd;for(let i=0;i<100;i++){try{fd=openSync(this.lock,'wx');break;}catch(e){if(e.code!=='EEXIST')throw new VerificationUnavailable(`Admission lock: ${e.message}`);await new Promise(r=>setTimeout(r,10));}}if(fd===undefined)throw new VerificationUnavailable('Admission coordinator locked; reconcile before resuming');try{return fn();}catch(e){if(e instanceof VerificationUnavailable)throw e;throw new VerificationUnavailable(`Admission persistence: ${e.message}`);}finally{closeSync(fd);unlinkSync(this.lock);}}
 rows(){if(!existsSync(this.file))return[];try{return readFileSync(this.file,'utf8').split('\n').filter(Boolean).map(s=>JSON.parse(s));}catch{throw new VerificationUnavailable('Admission journal corrupt; reconciliation required');}}
 append(row){appendFileSync(this.file,JSON.stringify({...row,at:new Date().toISOString()})+'\n',{flush:true});}
 async claim(id){return this.locked(()=>{const prior=this.rows().findLast(r=>r.id===id);if(prior)return{claimed:false,state:prior.state};this.append({id,state:'pending'});return{claimed:true};});}
 async confirm(id,receipt){return this.locked(()=>{this.append({id,state:'confirmed',receipt});});}
}

export function endpoint({group,store,journal,write,now=()=>new Date()}){
 let tail=Promise.resolve();const safe=checkedStore(store);
 const server=createServer(async(req,res)=>{
  const send=(status,body)=>{if(!res.headersSent&&!res.destroyed){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));}};
  if(req.method!=='POST'||req.url!=='/posts')return send(404,{error:'Not found'});
  let body;try{let bytes=0;const chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>128*1024)return send(413,{error:'Body too large'});chunks.push(chunk);}body=JSON.parse(Buffer.concat(chunks));}catch(e){return send(400,{error:e.message});}
  const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
  if(!object(body)||!object(body.entity)||!object(body.proof)||!object(body.entity.content)||typeof body.entity.owner!=='string')return send(400,{error:'entity, content and proof objects required'});
  const proof=body.proof;
  if(!Number.isInteger(proof.merkleTreeDepth)||proof.merkleTreeDepth<1||proof.merkleTreeDepth>32||!Array.isArray(proof.points)||proof.points.length!==8||!['message','scope','nullifier','merkleTreeRoot'].every(k=>typeof proof[k]==='string'&&/^\d{1,78}$/.test(proof[k]))||!proof.points.every(x=>typeof x==='string'&&/^\d{1,78}$/.test(x)))return send(400,{error:'Invalid proof schema'});
  const run=tail.then(async()=>{
   try{
    const {entity}=body,scope=windowScope(group,now().toISOString().slice(0,13));
    const candidate={key:'pending',owner:entity.owner,content:entity.content,proof,createdAt:(await safe.getHead()).toString(),attributes:{nullifier:proof.nullifier,root:proof.merkleTreeRoot,rootblock:entity.content.rootBlock,scope:proof.scope}};
    await valid(candidate,group,scope,store);
    const existing=await safe.listPosts(group,scope,await safe.getHead());
    for(const previous of existing.filter(p=>p.proof?.nullifier===proof.nullifier)){
     try{await valid(previous,group,scope,store);}catch(e){if(e instanceof VerificationUnavailable)throw e;continue;}
     return send(409,{error:'Valid nullifier already published'});
    }
    const id=admissionId(group,scope,proof.nullifier),claim=await journal.claim(id);
    if(!claim.claimed)return send(claim.state==='confirmed'?409:503,{error:claim.state==='confirmed'?'Nullifier already confirmed':'Pending admission requires reconciliation'});
    let receipt;try{receipt=await write(candidate);await journal.confirm(id,receipt);return send(201,receipt);}catch(e){return send(503,{error:e.message,txHash:e.txHash??receipt?.txHash,entityKey:receipt?.entityKey,detail:'Pending admission retained; no automatic resend'});}
   }catch(e){return send(e instanceof VerificationUnavailable?503:400,{error:e.message});}
  });tail=run.catch(()=>undefined);
  try{await run;}catch(e){send(503,{error:e.message});}
 });return server;
}

// Receipts/log positions must be authenticated by the caller's ingestion layer.
// The input is a complete retained, trusted-creator publication history, not a
// current-state scan. Missing/incomplete history must fail closed.
export async function retainedRead(group,scope,{history,liveKeys,store,complete}){
 if(!complete)throw new VerificationUnavailable('Complete publication history required');
 const positions=new Set();for(const p of history){const o=p.position;if(!o||!/^\d+$/.test(o.block)||!Number.isSafeInteger(o.transactionIndex)||o.transactionIndex<0||!Number.isSafeInteger(o.logIndex)||o.logIndex<0||o.block!==p.createdAt)throw new VerificationUnavailable('Authenticated publication position required');const id=`${o.block}|${o.transactionIndex}|${o.logIndex}`;if(positions.has(id))throw new VerificationUnavailable('Duplicate publication position');positions.add(id);}
 const ordered=[...history].sort((a,b)=>BigInt(a.createdAt)<BigInt(b.createdAt)?-1:BigInt(a.createdAt)>BigInt(b.createdAt)?1:a.position.transactionIndex-b.position.transactionIndex||a.position.logIndex-b.position.logIndex);
 const accepted=[],rejected=[],spent=[],seen=new Set();
 for(const post of ordered){try{await valid(post,group,scope,store);const id=admissionId(group,scope,post.proof.nullifier);if(seen.has(id)){rejected.push({key:post.key,reason:'Duplicate nullifier'});continue;}seen.add(id);spent.push({key:post.key,nullifier:post.proof.nullifier,live:liveKeys.has(post.key)});if(liveKeys.has(post.key))accepted.push(post);}catch(e){if(e instanceof VerificationUnavailable)throw e;rejected.push({key:post.key,reason:e.message});}}
 return{accepted,rejected,spent};
}
