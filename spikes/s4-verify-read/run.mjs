import {Identity} from '@semaphore-protocol/identity';
import {Group} from '@semaphore-protocol/group';
import {generateProof} from '@semaphore-protocol/proof';
import {randomBytes} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {readPosts,contentMessage,windowScope} from './read-posts.mjs';
import {fileURLToPath} from 'node:url';

const result={started:new Date().toISOString(),mode:'Real cryptography; in-memory storage adapter (NOT a live Arkiv round trip)',cases:[]};
try{
 const ids=Array.from({length:5},()=>new Identity(randomBytes(32)));const group=new Group(ids.map(i=>i.commitment));
 const groupId='veil-synthetic-reader',scope=windowScope(groupId,new Date().toISOString().slice(0,13));
 const content={version:1,chainId:7738577,group:groupId,scope,rootBlock:'10',owner:'0x1234567890123456789012345678901234567890',text:'Synthetic valid post'};
 const artifacts={wasm:fileURLToPath(new URL('../s1-semaphore-node/artifacts/semaphore-3.wasm',import.meta.url)),zkey:fileURLToPath(new URL('../s1-semaphore-node/artifacts/semaphore-3.zkey',import.meta.url))};
 const proof=await generateProof(ids[0],group,contentMessage(content),scope,3,artifacts);
 const post=(name,content,proof,createdAt)=>({key:name,owner:content.owner,content,proof,createdAt,attributes:{nullifier:proof.nullifier,root:proof.merkleTreeRoot,rootblock:content.rootBlock,scope}});
 const outsider=new Identity(randomBytes(32));const otherGroup=new Group([outsider,...ids.slice(1)].map(i=>i.commitment));
 const outsiderProof=await generateProof(outsider,otherGroup,contentMessage(content),scope,3,artifacts);
 let posts=[post('valid',content,proof,'11'),post('fake-proof',content,{...proof,points:Array(8).fill('0')},'9'),post('double',content,proof,'12'),post('non-member',content,outsiderProof,'11'),post('edited-content',{...content,text:'Edited after proving'},proof,'11')];
 // Make fake proof an earlier valid snapshot candidate, so only proof verification prevents reservation.
 posts[1].createdAt='10';
 const members=ids.map((id,index)=>({index,commitment:id.commitment.toString()}));
 const requestedBlocks=[];
 const store={getHead:async()=>20n,listPosts:async()=>structuredClone(posts),getGroupAt:async(g,b)=>{requestedBlocks.push(b.toString());if(b!==10n)throw Error('Unknown snapshot');return{readonly:true,chainId:7738577,depth:3};},getMembersAt:async()=>structuredClone(members)};
 const t=performance.now();const read=await readPosts(groupId,scope,store);result.readMs=performance.now()-t;result.accepted=read.accepted.map(p=>p.key);result.rejected=read.rejected;result.requestedBlocks=requestedBlocks;
 result.cases.push({name:'one valid, fake proof, duplicate, non-member, edited content',pass:result.accepted.join()==='valid'&&read.rejected.length===4});
 const saved=posts;posts=[post('redirected-owner',content,proof,'11')];posts[0].owner='0x2234567890123456789012345678901234567890';let r=await readPosts(groupId,scope,store);result.cases.push({name:'redirected owner',pass:r.accepted.length===0,reason:r.rejected[0]?.reason});
 posts=[post('future-root',{...content,rootBlock:'30'},proof,'11')];r=await readPosts(groupId,scope,store);result.cases.push({name:'changed rootBlock',pass:r.accepted.length===0,reason:r.rejected[0]?.reason});
 posts=[post('wrong-scope',content,{...proof,scope:'123'},'11')];r=await readPosts(groupId,scope,store);result.cases.push({name:'wrong scope',pass:r.accepted.length===0,reason:r.rejected[0]?.reason});
 posts=[post('b-same-block',content,proof,'11'),post('a-same-block',content,proof,'11')];r=await readPosts(groupId,scope,store);result.cases.push({name:'same block deterministic tie break',pass:r.accepted[0]?.key==='a-same-block'&&r.rejected.length===1});
 posts=saved;result.verdict=result.cases.every(c=>c.pass)?'RISKY':'NO-GO';result.localChecksPassed=result.cases.every(c=>c.pass);result.blocker='Live malicious-post fixtures, Arkiv historical state and pagination depend on funded S3; storage adapter results do not establish RPC behavior.';
 writeFileSync(new URL('fixture.json',import.meta.url),JSON.stringify({groupId,scope,content,proof,members},null,2));
}catch(e){result.verdict='NO-GO';result.error=e.stack;}
writeFileSync(new URL('result.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));process.exit(result.error?1:0);
