import {createServer} from 'node:http';
import {validatePost,windowScope} from '../s4-verify-read/read-posts.mjs';

export function proofRelayer({group,store,write,now=()=>new Date()}){
 const reserved=new Set();let tail=Promise.resolve();
 const server=createServer(async(req,res)=>{
  const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
  if(req.method!=='POST'||req.url!=='/posts')return send(404,{error:'Not found'});
  let body;try{let bytes=0;const chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>128*1024)return send(413,{error:'Body too large'});chunks.push(chunk);}body=JSON.parse(Buffer.concat(chunks));}catch(e){return send(400,{error:e.message});}
  // One entire admission + write sequence at a time for the relayer's sole signing wallet.
  const run=tail.then(async()=>{
   const {entity,proof}=body;const scope=windowScope(group,now().toISOString().slice(0,13));
   try{
    if(!entity||!proof)throw Error('entity and proof required');
    const content=entity.content;
    const candidate={key:'pending',owner:entity.owner,createdAt:(await store.getHead()).toString(),content,proof,attributes:{nullifier:proof.nullifier,root:proof.merkleTreeRoot,rootblock:content.rootBlock,scope:proof.scope}};
    await validatePost(candidate,group,scope,store);
    const id=`${group}|${scope}|${proof.nullifier}`;
    if(reserved.has(id))return send(409,{error:'Nullifier already reserved'});
    const existing=await store.listPosts(group,scope,await store.getHead());
    if(existing.some(p=>p.proof?.nullifier===proof.nullifier))return send(409,{error:'Nullifier already written (candidate must be checked by readers)'});
    reserved.add(id);
    try{const receipt=await write(candidate);return send(201,receipt);}catch(e){return send(503,{error:e.message,txHash:e.txHash,detail:'Write outcome requires reconciliation; reservation retained, no automatic resend'});}
   }catch(e){return send(400,{error:e.message});}
  });tail=run.catch(()=>undefined);await run;
 });
 return {server,reserved};
}
