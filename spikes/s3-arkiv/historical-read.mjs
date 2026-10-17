import {createPublicClient} from '@arkiv-network/sdk';
import {tiramisu} from '@arkiv-network/sdk/chains';
import {eq} from '@arkiv-network/sdk/query';
import {http} from 'viem';
import {readFileSync,writeFileSync} from 'node:fs';
const reader=createPublicClient({chain:tiramisu,cacheTime:0,transport:http(tiramisu.rpcUrls.default.http[0],{retryCount:0,timeout:15000})});
const result={started:new Date().toISOString(),reads:[],faucet:{}};
try{
 const old=BigInt(JSON.parse(readFileSync(new URL('preflight.json',import.meta.url))).block),head=await reader.getBlockNumber();result.head=head.toString();
 for(const block of [old,head]){
  const start=performance.now();const page=await reader.select({key:true,attributes:true,createdAt:true,expiresAt:true,creator:true}).where(eq('project','arkognito-7f3k'),eq('type','arkognito.relayer')).createdBy('0x85AA1d55a969E34B2975092C12B9385ED1e3134b').atBlock(block).limit(200).fetch();
  result.reads.push({requestedBlock:block.toString(),returnedBlock:page.blockNumber.toString(),ms:performance.now()-start,entities:page.entities.map(e=>({key:e.key,createdAt:e.createdAt.toString(),expiresAt:e.expiresAt.toString()}))});
 }
 result.snapshotArgumentsAccepted=result.reads.every(r=>r.requestedBlock===r.returnedBlock);
 result.stateChangeObserved=result.reads[0].entities.some(old=>result.reads[1].entities.some(now=>now.key===old.key&&now.expiresAt!==old.expiresAt));
 const faucet=await fetch('https://hub.arkiv.network/api/faucet',{signal:AbortSignal.timeout(15000)});result.faucet={status:faucet.status,body:await faucet.text()};
 result.limit='Queries read existing relayer service metadata only. This does not establish a newly written Semaphore group round trip.';
}catch(e){result.error=e.stack;}
writeFileSync(new URL('historical-result.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
