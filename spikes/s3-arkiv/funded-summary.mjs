// Final independent readback; no key loading, signing, or writes.
import {createPublicClient} from '@arkiv-network/sdk';
import {tiramisu} from '@arkiv-network/sdk/chains';
import {formatEther,http} from 'viem';
import {readFileSync,writeFileSync} from 'node:fs';
import {arkivStore,readPosts} from '../s4-verify-read/read-posts.mjs';
const json=path=>JSON.parse(readFileSync(new URL(path,import.meta.url)));
const s3=json('result.json'),s4=json('../s4-verify-read/live-result.json'),s5=json('../s5-relayer/live-result.json'),f=json('live.json');
const result={started:new Date().toISOString(),runtime:process.version,address:f.admin,checks:{},receipts:[]};
try{
 const reader=createPublicClient({chain:tiramisu,cacheTime:0,transport:http(tiramisu.rpcUrls.default.http[0],{timeout:15000,retryCount:0})});
 result.chainId=await reader.getChainId();if(result.chainId!==7738577)throw Error('Wrong chain');
 let total=0n;for(const hash of [s3.groupTx,s3.extraMemberTx,s3.postTx,s4.txHash,s5.valid.body.txHash]){const r=await reader.getTransactionReceipt({hash});if(r.status!=='success'||r.from.toLowerCase()!==f.admin.toLowerCase())throw Error(`Bad receipt ${hash}`);const cost=r.gasUsed*r.effectiveGasPrice;total+=cost;result.receipts.push({hash,block:r.blockNumber.toString(),gasUsed:r.gasUsed.toString(),costWei:cost.toString(),status:r.status});}
 const entity=await reader.getEntity(s5.valid.body.entityKey);
 result.checks.relayerOwnerReadback=entity.owner.toLowerCase()===f.relayContent.owner.toLowerCase();
 result.checks.relayerReadonly=entity.creationFlags.readonly;
 const store=arkivStore(reader,{project:f.project,admin:f.admin,groupKey:f.groupKey,trustedRelayers:[f.admin]});const t=performance.now();const posts=await readPosts(f.project,f.content.scope,store);result.finalReadMs=performance.now()-t;
 result.accepted=posts.accepted.map(p=>p.key);result.rejected=posts.rejected;result.snapshot=posts.snapshot;
 result.checks.twoIndependentValidPosts=posts.accepted.length===2&&posts.accepted.some(p=>p.key===f.postKey)&&posts.accepted.some(p=>p.key===s5.valid.body.entityKey)&&posts.rejected.length===4;
 result.checks.allLiveSpikesPassed=[s3,s4,s5].every(s=>s.verdict==='GO');
 result.balanceWei=(await reader.getBalance({address:f.admin})).toString();result.balanceGlm=formatEther(BigInt(result.balanceWei));
 result.gasCostWei=total.toString();result.gasCostGlm=formatEther(total);result.checks.balanceMatchesConfirmedGas=BigInt(s3.balanceWei)-BigInt(result.balanceWei)===total;
 result.verdict=Object.values(result.checks).every(Boolean)?'GO':'RISKY';
}catch(e){result.verdict='RISKY';result.error=e.stack;}
writeFileSync(new URL('funded-summary.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));process.exit(result.verdict==='GO'?0:1);
