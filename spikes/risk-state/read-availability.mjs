// Failure injection only: no network, signing, or broadcast. Reuse a proof which
// was accepted by the live independent reader in race-result.json.
import {readFileSync,writeFileSync} from 'node:fs';
import {readPosts} from '../s4-verify-read/read-posts.mjs';
const f=JSON.parse(readFileSync(new URL('state/durability-fixture.json',import.meta.url)));
const post={content:f.content,proof:f.proof,key:'synthetic-availability-control',owner:f.content.owner,createdAt:f.content.rootBlock,attributes:{nullifier:f.proof.nullifier,root:f.proof.merkleTreeRoot,rootblock:f.content.rootBlock,scope:f.proof.scope}};
const store={getHead:async()=>BigInt(f.content.rootBlock)+1n,listPosts:async()=>[post],getGroupAt:async()=>{throw Error('Injected historical RPC unavailable');},getMembersAt:async()=>{throw Error('Unreachable in this control');}};
const result={started:new Date().toISOString(),runtime:process.version,mode:'Failure injection; no network or broadcast',verdict:'RISKY'};
try{const read=await readPosts(f.project,f.proof.scope,store);result.threw=false;result.accepted=read.accepted.length;result.rejected=read.rejected;result.finding='Historical-provider failure is returned as a rejected post, so caller can mistake unavailable verification for an invalid proof/empty valid feed.';}catch(e){result.threw=true;result.error=e.message;}
writeFileSync(new URL('read-availability-result.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
