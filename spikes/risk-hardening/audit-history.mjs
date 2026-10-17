// Independent read-only audit of the completed live fixture; no signer loaded.
import {createPublicClient} from '@arkiv-network/sdk';import {tiramisu} from '@arkiv-network/sdk/chains';import {ENTITY_EVENTS_ABI,decodeCreationFlags} from '@arkiv-network/sdk/entity';import {http,decodeEventLog} from 'viem';import {readFileSync,writeFileSync} from 'node:fs';
import {rpcOptions} from '../risk-state/rpc-options.mjs';import {arkivStore,windowScope} from '../s4-verify-read/read-posts.mjs';import {retainedRead} from './hardened.mjs';
const f=JSON.parse(readFileSync(new URL('live-result.json',import.meta.url))),result={started:new Date().toISOString(),runtime:process.version,mode:'Independent read-only receipt/history verification',checks:[]};
const save=()=>writeFileSync(new URL('history-audit.json',import.meta.url),JSON.stringify(result,null,2));
const reader=createPublicClient({chain:tiramisu,cacheTime:0,transport:http(tiramisu.rpcUrls.default.http[0],rpcOptions())}),creators=[...new Set(f.receipts.map(r=>r.sender.toLowerCase()))],scope=windowScope(f.project,f.started.slice(0,13)),system='0x4400000000000000000000000000000000000044';
const store=arkivStore(reader,{project:f.project,admin:f.receipts[0].sender,groupKey:f.groupKey,trustedRelayers:creators});
try{
 if(f.verdict!=='GO for isolated mitigation controls on Tiramisu')throw Error('Live run has not completed successfully');if(await reader.getChainId()!==7738577)throw Error('Wrong chain');
 const head=await reader.getBlockNumber({cacheTime:0});result.snapshot=head.toString();const logs=await reader.getLogs({address:system,event:ENTITY_EVENTS_ABI.find(e=>e.name==='EntityCreated'),args:{owner:creators},fromBlock:BigInt(f.rootBlock),toBlock:head}),byBlock=new Map(),receiptCache=new Map(),history=[];
 for(const log of logs){const b=log.blockNumber.toString();if(!byBlock.has(b))byBlock.set(b,await store.listPosts(f.project,scope,log.blockNumber));const post=byBlock.get(b).find(p=>p.key===log.args.entityKey);if(!post)continue;
  if(!receiptCache.has(log.transactionHash))receiptCache.set(log.transactionHash,await reader.getTransactionReceipt({hash:log.transactionHash}));const receipt=receiptCache.get(log.transactionHash),actual=receipt.logs.find(l=>l.logIndex===log.logIndex&&l.blockHash===log.blockHash&&l.address.toLowerCase()===system&&l.data===log.data&&l.topics.join()===log.topics.join());
  if(receipt.status!=='success'||receipt.to?.toLowerCase()!==system||receipt.blockNumber!==log.blockNumber||!actual||receipt.from.toLowerCase()!==log.args.owner.toLowerCase())throw Error('Native publication receipt mismatch');
  const decoded=decodeEventLog({abi:ENTITY_EVENTS_ABI,topics:actual.topics,data:actual.data});if(decoded.eventName!=='EntityCreated'||decoded.args.entityKey!==post.key||!decodeCreationFlags(Number(decoded.args.creationFlags)).readonly)throw Error('Publication is not authenticated readonly creation');
  history.push({...post,position:{block:b,transactionIndex:Number(log.transactionIndex),logIndex:Number(log.logIndex)}});
 }
 const live=await store.listPosts(f.project,scope,head),read=await retainedRead(f.project,scope,{history,liveKeys:new Set(live.map(p=>p.key)),store,complete:true});result.posts=history.length;result.accepted=read.accepted.map(p=>p.key);result.spent=read.spent;result.rejected=read.rejected;result.positions=history.map(p=>({key:p.key,position:p.position}));
 result.checks.push({name:'all six readonly post publications recovered',pass:history.length===6},{name:'two live canonical posts, three spent identities',pass:read.accepted.length===2&&read.spent.length===3},{name:'deleted winner still consumes nullifier',pass:read.spent.filter(s=>!s.live).length===1},{name:'fake and both duplicates rejected',pass:read.rejected.length===3&&read.rejected.filter(r=>r.reason==='Duplicate nullifier').length===2});
 const chronological=f.checks.find(c=>c.name==='live transaction/log positions select first create').details.createOrder[0];result.checks.push({name:'independent receipt order agrees with first batch create',pass:read.accepted.some(p=>p.key===chronological)});
 result.verdict=result.checks.every(c=>c.pass)?'GO':'RISKY';
}catch(e){result.verdict='RISKY';result.error=e.stack;}
save();console.log(JSON.stringify(result,null,2));process.exit(result.error||result.verdict!=='GO'?1:0);
