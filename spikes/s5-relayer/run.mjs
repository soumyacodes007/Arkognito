import {proofRelayer} from './server.mjs';
import {createPublicClient,createWalletClient,ExpirationTime,jsonToPayload} from '@arkiv-network/sdk';
import {tiramisu} from '@arkiv-network/sdk/chains';
import {u64} from '@arkiv-network/sdk/attr';
import {http} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {readFileSync,writeFileSync} from 'node:fs';

const f=JSON.parse(readFileSync(new URL('../s4-verify-read/fixture.json',import.meta.url)));
const result={started:new Date().toISOString(),mode:'Real HTTP and Semaphore cryptography, synthetic in-memory group; separate live Arkiv write attempt',cases:[]};
const store={getHead:async()=>20n,getGroupAt:async()=>({chainId:7738577,depth:3,readonly:true}),getMembersAt:async()=>structuredClone(f.members),listPosts:async()=>[]};
const body={entity:{owner:f.content.owner,content:f.content},proof:f.proof};
async function withServer(write,run){const {server}=proofRelayer({group:f.groupId,store,write});await new Promise(r=>server.listen(0,'127.0.0.1',r));const post=async b=>{const start=performance.now();const response=await fetch(`http://127.0.0.1:${server.address().port}/posts`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b),signal:AbortSignal.timeout(30000)});return{status:response.status,body:await response.json(),elapsedMs:performance.now()-start};};try{await run(post);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}}
try{
 const written=[];
 await withServer(async candidate=>{written.push(candidate);return{entityKey:'synthetic-in-memory-key',owner:candidate.owner};},async post=>{
  let r=await post({...body,entity:{...body.entity,content:{...f.content,text:'Changed by relayer'}}});result.cases.push({name:'message tamper',pass:r.status===400,...r});
  r=await post({...body,entity:{...body.entity,owner:'0x2234567890123456789012345678901234567890'}});result.cases.push({name:'owner redirect',pass:r.status===400,...r});
  const responses=await Promise.all([post(body),post(body)]);result.cases.push({name:'concurrent double submit',pass:responses.map(r=>r.status).sort().join()==='201,409',responses});
 });result.inMemoryWrites=written.length;
 const key=readFileSync(new URL('../.env',import.meta.url),'utf8').match(/^SPIKE_PRIVATE_KEY=(0x[0-9a-f]{64})$/m)?.[1];const account=privateKeyToAccount(key);
 const rpc=tiramisu.rpcUrls.default.http[0];const transport=()=>http(rpc,{timeout:10000,retryCount:0});
 const reader=createPublicClient({chain:tiramisu,cacheTime:0,transport:transport()});const wallet=createWalletClient({chain:tiramisu,account,transport:transport()});
 result.chainId=await reader.getChainId();if(result.chainId!==7738577)throw Error('Wrong chain');result.balanceWei=(await reader.getBalance({address:account.address})).toString();
 if(result.balanceWei!=='0')result.liveAttempt={status:null,skipped:true,detail:'This harness uses a synthetic in-memory group. Use live.mjs for funded chain-backed membership; no diagnostic write sent.'};
 else await withServer(async candidate=>{
  const predicted=await reader.predictEntityKeys({owner:account.address,count:1});
  const receipt=await wallet.executeBatch({creates:[{salt:predicted[0].salt,payload:jsonToPayload({content:candidate.content,proof:candidate.proof}),contentType:'application/json',attributes:{project:f.groupId,type:'post',nullifier:f.proof.nullifier,root:f.proof.merkleTreeRoot,rootblock:u64(BigInt(f.content.rootBlock)),scope:f.scope},expires:ExpirationTime.fromDays(1),flags:{readonly:true}}],ownershipChanges:[{entityKey:predicted[0].key,newOwner:candidate.owner}]});
  const onchain=await reader.getEntity(receipt.createdEntities[0]);if(onchain.owner.toLowerCase()!==candidate.owner.toLowerCase())throw Error('Ownership read-back mismatch');return{entityKey:onchain.key,txHash:receipt.txHash,owner:onchain.owner};
 },async post=>{result.liveAttempt=await post(body);});
 result.localChecksPassed=result.cases.every(c=>c.pass)&&written.length===1;
 result.verdict=result.localChecksPassed&&result.liveAttempt.status===201?'GO':'RISKY';result.blocker=result.liveAttempt.status!==201?'Live create/transfer failed; HTTP admission used a synthetic group adapter, so no chain-backed relayer claim is established':undefined;
}catch(e){result.verdict='RISKY';result.error=e.stack;}
writeFileSync(new URL('result.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));process.exit(result.error?1:0);
