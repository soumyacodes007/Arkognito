// Run only after a funded S3 succeeds.
import {readFileSync,writeFileSync} from 'node:fs';
import {createPublicClient,createWalletClient,ExpirationTime,jsonToPayload} from '@arkiv-network/sdk';
import {tiramisu} from '@arkiv-network/sdk/chains';
import {u64} from '@arkiv-network/sdk/attr';
import {http} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {arkivStore,readPosts} from './read-posts.mjs';
const result={started:new Date().toISOString(),mode:'live',runtime:process.version};
try{
 const f=JSON.parse(readFileSync(new URL('../s3-arkiv/live.json',import.meta.url)));
 const key=readFileSync(new URL('../.env',import.meta.url),'utf8').match(/^SPIKE_PRIVATE_KEY=(0x[0-9a-f]{64})$/m)[1];const account=privateKeyToAccount(key);
 const transport=()=>http(tiramisu.rpcUrls.default.http[0],{timeout:15000,retryCount:0});const reader=createPublicClient({chain:tiramisu,cacheTime:0,transport:transport()});const wallet=createWalletClient({chain:tiramisu,account,transport:transport()});
 if(await reader.getChainId()!==7738577)throw Error('Wrong chain');
 const items=[{label:'fake',content:f.content,proof:{...f.proof,points:Array(8).fill('0')}},{label:'duplicate',content:f.content,proof:f.proof},{label:'non-member',content:f.content,proof:f.outsiderProof},{label:'edited',content:{...f.content,text:'Edited content'},proof:f.proof}];
 const t=performance.now();const predicted=await reader.predictEntityKeys({owner:account.address,count:items.length});
 const sent=await wallet.executeBatch({creates:items.map((p,i)=>({salt:predicted[i].salt,payload:jsonToPayload({content:p.content,proof:p.proof}),contentType:'application/json',attributes:{project:f.project,type:'post',nullifier:p.proof.nullifier,root:p.proof.merkleTreeRoot,rootblock:u64(BigInt(p.content.rootBlock)),scope:p.proof.scope},expires:ExpirationTime.fromDays(1),flags:{readonly:true}})),ownershipChanges:items.map((p,i)=>({entityKey:predicted[i].key,newOwner:p.content.owner}))});
 result.txHash=sent.txHash;
 result.writeMs=performance.now()-t;result.fixtureKeys=Object.fromEntries(items.map((p,i)=>[p.label,sent.createdEntities[i]]));
 const receipt=await reader.getTransactionReceipt({hash:sent.txHash});if(receipt.status!=='success')throw Error('Bad fixture receipt');result.block=receipt.blockNumber.toString();result.gasCostWei=(receipt.gasUsed*receipt.effectiveGasPrice).toString();
 const readStart=performance.now();
 const store=arkivStore(reader,{project:f.project,admin:f.admin,groupKey:f.groupKey,trustedRelayers:[f.admin]});const read=await readPosts(f.project,f.content.scope,store);
 result.readMs=performance.now()-readStart;result.accepted=read.accepted.map(p=>p.key);result.rejected=read.rejected;result.pass=result.accepted.length===1&&result.accepted[0]===f.postKey&&read.rejected.length===4;result.verdict=result.pass?'GO':'NO-GO';
}catch(e){result.error=e.stack;result.verdict='RISKY';}
writeFileSync(new URL('live-result.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));process.exit(result.error?1:0);
