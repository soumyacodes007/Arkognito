// Read-only reconciliation of the already-submitted funded S3. Never resends writes.
import {createPublicClient} from '@arkiv-network/sdk';
import {tiramisu} from '@arkiv-network/sdk/chains';
import {http} from 'viem';
import {readFileSync,writeFileSync} from 'node:fs';
import {arkivStore,readPosts} from '../s4-verify-read/read-posts.mjs';
const result=JSON.parse(readFileSync(new URL('result.json',import.meta.url)));
const f=JSON.parse(readFileSync(new URL('live.json',import.meta.url)));
const reader=createPublicClient({chain:tiramisu,cacheTime:0,transport:http(tiramisu.rpcUrls.default.http[0],{timeout:15000,retryCount:0})});
try{
 if(await reader.getChainId()!==7738577)throw Error('Wrong chain');
 result.receipts=[];let gasCost=0n;
 for(const hash of [result.groupTx,result.extraMemberTx,result.postTx]){const r=await reader.getTransactionReceipt({hash});if(r.status!=='success')throw Error(`Receipt ${hash}: ${r.status}`);const cost=r.gasUsed*r.effectiveGasPrice;gasCost+=cost;result.receipts.push({hash,status:r.status,block:r.blockNumber.toString(),gasUsed:r.gasUsed.toString(),gasCostWei:cost.toString()});}
 const entity=await reader.getEntity(result.groupKey);const rules=JSON.parse(new TextDecoder().decode(entity.payload));
 result.checks.groupUnchangedAfterRejectedPatch=entity.creationFlags.readonly&&rules.name==='Synthetic five-member group'&&rules.chainId===7738577&&rules.depth===3&&rules.admin===result.admin;
 result.checks.readonlyUpdateBlocked=/read.?only/i.test(result.readonlyUpdateError)&&result.checks.groupUnchangedAfterRejectedPatch;
 const store=arkivStore(reader,{project:f.project,admin:f.admin,groupKey:f.groupKey,trustedRelayers:[f.admin]});
 const read=await readPosts(f.project,f.content.scope,store);result.checks.livePostAccepted=read.accepted.length===1&&read.accepted[0].key===f.postKey&&read.rejected.length===0;
 result.confirmedGasCostWei=gasCost.toString();result.balanceAfterWei=(await reader.getBalance({address:result.admin})).toString();
 result.runtime=process.version;result.reconciledAt=new Date().toISOString();
 result.harnessCorrection='Initial readonly error regex required a separator; the SDK says readonly. Reclassified using the recorded rejection and unchanged readonly group readback, without resending writes.';
 result.verdict=Object.values(result.checks).every(Boolean)?'GO':'RISKY';
}catch(e){result.reconcileError=e.stack;result.verdict='RISKY';}
writeFileSync(new URL('result.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));process.exit(result.verdict==='GO'?0:1);
