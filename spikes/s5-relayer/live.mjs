// Requires a funded, successful S3.
import {proofRelayer} from './server.mjs';
import {arkivStore} from '../s4-verify-read/read-posts.mjs';
import {readFileSync,writeFileSync} from 'node:fs';
import {createPublicClient,createWalletClient,ExpirationTime,jsonToPayload} from '@arkiv-network/sdk';
import {tiramisu} from '@arkiv-network/sdk/chains';
import {u64} from '@arkiv-network/sdk/attr';
import {http} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
const result={started:new Date().toISOString(),mode:'live',runtime:process.version};let server;
try{
 const f=JSON.parse(readFileSync(new URL('../s3-arkiv/live.json',import.meta.url)));
 const key=readFileSync(new URL('../.env',import.meta.url),'utf8').match(/^SPIKE_PRIVATE_KEY=(0x[0-9a-f]{64})$/m)[1];const account=privateKeyToAccount(key);
 const transport=()=>http(tiramisu.rpcUrls.default.http[0],{timeout:15000,retryCount:0});const reader=createPublicClient({chain:tiramisu,cacheTime:0,transport:transport()});const wallet=createWalletClient({chain:tiramisu,account,transport:transport()});
 if(await reader.getChainId()!==7738577)throw Error('Wrong chain');
 const store=arkivStore(reader,{project:f.project,admin:f.admin,groupKey:f.groupKey,trustedRelayers:[f.admin]});
 ({server}=proofRelayer({group:f.project,store,write:async p=>{
  const [predicted]=await reader.predictEntityKeys({owner:account.address,count:1});const sent=await wallet.executeBatch({creates:[{salt:predicted.salt,payload:jsonToPayload({content:p.content,proof:p.proof}),contentType:'application/json',attributes:{project:f.project,type:'post',nullifier:p.proof.nullifier,root:p.proof.merkleTreeRoot,rootblock:u64(BigInt(p.content.rootBlock)),scope:p.proof.scope},expires:ExpirationTime.fromDays(1),flags:{readonly:true}}],ownershipChanges:[{entityKey:predicted.key,newOwner:p.owner}]});const entity=await reader.getEntity(sent.createdEntities[0]);if(entity.owner.toLowerCase()!==p.owner.toLowerCase())throw Error('Owner read-back mismatch');return {txHash:sent.txHash,entityKey:entity.key,owner:entity.owner};
 }}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const post=async content=>{const t=performance.now();const r=await fetch(`http://127.0.0.1:${server.address().port}/posts`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({entity:{owner:content.owner,content},proof:f.relayProof}),signal:AbortSignal.timeout(60000)});return {status:r.status,body:await r.json(),elapsedMs:performance.now()-t};};
 result.tamper=await post({...f.relayContent,text:'Changed by relay'});result.valid=await post(f.relayContent);result.replay=await post(f.relayContent);result.pass=result.tamper.status===400&&result.valid.status===201&&result.replay.status===409;result.verdict=result.pass?'GO':'NO-GO';
}catch(e){result.error=e.stack;result.verdict='RISKY';}
finally{server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));}
writeFileSync(new URL('live-result.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));process.exit(result.error?1:0);
