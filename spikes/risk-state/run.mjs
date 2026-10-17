import {createPublicClient,createWalletClient,ExpirationTime,jsonToPayload} from '@arkiv-network/sdk';
import {tiramisu} from '@arkiv-network/sdk/chains';
import {eq} from '@arkiv-network/sdk/query';
import {u256,u64} from '@arkiv-network/sdk/attr';
import {http,keccak256,parseTransaction,parseEther,formatEther} from 'viem';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
import {Identity} from '@semaphore-protocol/identity';
import {Group} from '@semaphore-protocol/group';
import {generateProof} from '@semaphore-protocol/proof';
import {randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,appendFileSync,mkdirSync} from 'node:fs';
import {proofRelayer} from '../s5-relayer/server.mjs';
import {arkivStore,readPosts,contentMessage,windowScope} from '../s4-verify-read/read-posts.mjs';

const result={started:new Date().toISOString(),runtime:process.version,project:`veil-risk-${Date.now()}`,receipts:[],checks:[],findings:[]};
const save=()=>writeFileSync(new URL('result.json',import.meta.url),JSON.stringify(result,null,2));
const state=new URL('state/',import.meta.url);mkdirSync(state,{recursive:true});
const envUrl=new URL('../.env',import.meta.url);const env=readFileSync(envUrl,'utf8');const admin=privateKeyToAccount(env.match(/^SPIKE_PRIVATE_KEY=(0x[0-9a-f]{64})$/m)[1]);
const rpc=tiramisu.rpcUrls.default.http[0];const reader=createPublicClient({chain:tiramisu,cacheTime:0,transport:http(rpc,{timeout:15000,retryCount:0})});
let admittedCost=0n;
function walletFor(account){const transport=config=>{const base=http(rpc,{timeout:15000,retryCount:0})(config);return{...base,request:async args=>{if(args.method==='eth_sendRawTransaction'){const raw=args.params[0],tx=parseTransaction(raw),cost=tx.gas*(tx.maxFeePerGas??tx.gasPrice)+BigInt(tx.value??0);if(admittedCost+cost>parseEther('0.2'))throw Error('Risk test maximum admitted fee/value budget 0.2 GLM exceeded');admittedCost+=cost;appendFileSync(new URL('submissions.jsonl',state),JSON.stringify({hash:keccak256(raw),raw,sender:account.address,nonce:tx.nonce,maxCostWei:cost.toString()})+'\n',{flush:true});}return base.request(args);}};};return createWalletClient({chain:tiramisu,account,cacheTime:0,transport});}
const wallet=walletFor(admin);
async function receipt(hash,label){const r=await reader.getTransactionReceipt({hash});if(r.status!=='success')throw Error(`${label} receipt ${r.status}: ${hash}`);result.receipts.push({label,hash,block:r.blockNumber.toString(),gasCostWei:(r.gasUsed*r.effectiveGasPrice).toString()});save();return r;}
const create=(type,payload,attrs={},expires=ExpirationTime.fromDays(1))=>({payload:jsonToPayload(payload),contentType:'application/json',attributes:{project:result.project,type,...attrs},expires,flags:{readonly:true}});
async function allMembers(block){const out=[];for await(const e of reader.select({key:true,attributes:true}).where(eq('project',result.project),eq('type','member')).createdBy(admin.address).atBlock(block).limit(200))out.push(e);return out.sort((a,b)=>Number(a.attributes.memberindex.value)-Number(b.attributes.memberindex.value));}
async function withServer(store,write,fn){const {server}=proofRelayer({group:result.project,store,write});await new Promise(r=>server.listen(0,'127.0.0.1',r));const post=async(content,proof)=>{const t=performance.now();const r=await fetch(`http://127.0.0.1:${server.address().port}/posts`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({entity:{owner:content.owner,content},proof}),signal:AbortSignal.timeout(90000)});return{status:r.status,body:await r.json(),ms:performance.now()-t};};try{return await fn(post);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}}
try{
 if(await reader.getChainId()!==7738577)throw Error('Wrong chain');result.startBalanceWei=(await reader.getBalance({address:admin.address})).toString();if(BigInt(result.startBalanceWei)<parseEther('0.2'))throw Error('Insufficient preflight balance');
 const ids=Array.from({length:205},()=>new Identity(randomBytes(32)));const group=new Group(ids.map(i=>i.commitment));
 const creates=[create('group',{chainId:7738577,depth:8,name:'Synthetic 205 member risk group'}),...ids.map((id,index)=>create('member',{synthetic:true},{memberindex:index,commitment:u256(id.commitment)}))];let groupKey,rootBlock;
 for(let i=0;i<creates.length;i+=50){const sent=await wallet.executeBatch({creates:creates.slice(i,i+50)});const r=await receipt(sent.txHash,`members-${i}`);if(i===0)groupKey=sent.createdEntities[0];rootBlock=r.blockNumber;console.log(`created ${Math.min(i+50,creates.length)}/${creates.length}`);}
 result.groupKey=groupKey;result.rootBlock=rootBlock.toString();save();
 const t=performance.now();const page1=await reader.select({key:true,attributes:true}).where(eq('project',result.project),eq('type','member')).createdBy(admin.address).atBlock(rootBlock).limit(200).fetch();
 const late=await wallet.createEntity(create('member',{synthetic:true},{memberindex:205,commitment:u256(123456789n)}));await receipt(late.txHash,'late-member');
 const page2=await page1.next();const rows=[...page1.entities,...page2.entities].sort((a,b)=>Number(a.attributes.memberindex.value)-Number(b.attributes.memberindex.value));
 const current=await allMembers(await reader.getBlockNumber({cacheTime:0}));
 result.pagination={first:page1.entities.length,second:page2.entities.length,hasMore:page2.hasNextPage(),snapshot:rootBlock.toString(),returnedBlocks:[page1.blockNumber.toString(),page2.blockNumber.toString()],currentCount:current.length,ms:performance.now()-t};
 result.checks.push({name:'pagination 200+5 with intervening write',pass:rows.length===205&&page2.entities.length===5&&!page2.hasNextPage()&&page1.blockNumber===page2.blockNumber&&current.length===206});
 result.checks.push({name:'paginated root matches ordered initial commitments',pass:new Group(rows.map(e=>BigInt(e.attributes.commitment.value))).root===group.root});save();
 const scope=windowScope(result.project,new Date().toISOString().slice(0,13));const makeContent=text=>({version:1,chainId:7738577,group:result.project,scope,rootBlock:rootBlock.toString(),owner:admin.address.toLowerCase(),text});
 const c1=makeContent('Synthetic same-block first create'),c2=makeContent('Synthetic same-block second create');
 const p1=await generateProof(ids[0],group,contentMessage(c1),scope,8),p2=await generateProof(ids[0],group,contentMessage(c2),scope,8);
 const post=(content,proof)=>create('post',{content,proof},{scope,root:proof.merkleTreeRoot,nullifier:proof.nullifier,rootblock:u64(rootBlock)});
 let predicted;for(let i=0;i<12;i++){predicted=await reader.predictEntityKeys({owner:admin.address,count:2});if(predicted[0].key>predicted[1].key)break;}
 const tied=await wallet.executeBatch({creates:[{...post(c1,p1),salt:predicted[0].salt},{...post(c2,p2),salt:predicted[1].salt}]});const tieReceipt=await receipt(tied.txHash,'same-block-dupes');
 const store=arkivStore(reader,{project:result.project,admin:admin.address,groupKey,trustedRelayers:[admin.address]});
 const tieRead=await readPosts(result.project,scope,store);const expected=[...tied.createdEntities].sort()[0];
 result.tie={block:tieReceipt.blockNumber.toString(),createOrder:tied.createdEntities,expectedCanonical:expected,accepted:tieRead.accepted.map(p=>p.key),rejected:tieRead.rejected};
 result.checks.push({name:'same-block canonical key order',pass:tieRead.accepted.length===1&&tieRead.accepted[0].key===expected&&tieRead.rejected.some(r=>r.reason==='Duplicate nullifier')});save();
 const restart=await withServer(store,async()=>{throw Error('Unexpected replay write');},post=>post(c1,p1));result.restart=restart;result.checks.push({name:'fresh server rejects confirmed chain replay',pass:restart.status===409});
 // The owner can delete readonly posts. Current-state reads then lose the original first-use evidence.
 const deleted=await wallet.deleteEntity({entityKey:expected});await receipt(deleted.txHash,'delete-canonical');const afterDelete=await readPosts(result.project,scope,store);
 result.deletion={accepted:afterDelete.accepted.map(p=>p.key),priorCanonical:expected,otherCopyPromoted:afterDelete.accepted.length===1&&afterDelete.accepted[0].key!==expected};
 if(result.deletion.otherCopyPromoted)result.findings.push({severity:'design',name:'Earliest-wins depends on retained history',evidence:'Deleting the readonly canonical post promoted its duplicate in current-state reads.'});
 // Poison a fresh member's nullifier with an INVALID proof, then send their valid proof.
 const poisonContent=makeContent('Synthetic valid post after invalid preemption'),poisonProof=await generateProof(ids[1],group,contentMessage(poisonContent),scope,8);
 const poison=await wallet.createEntity(post(poisonContent,{...poisonProof,points:Array(8).fill('0')}));await receipt(poison.txHash,'invalid-preemption');
 let poisonWrites=0;const poisoning=await withServer(store,async()=>{poisonWrites++;return{};},post=>post(poisonContent,poisonProof));result.poisoning={...poisoning,writeCalls:poisonWrites};
 const independently=await readPosts(result.project,scope,store);result.poisoning.invalidProofRejectedByReader=independently.rejected.some(p=>p.key===poison.entityKey&&p.reason==='Invalid Semaphore proof');
 if(poisoning.status===409&&poisonWrites===0)result.findings.push({severity:'high',name:'Research relayer accepts invalid nullifier preemption',evidence:poisoning.body.error});
 // Confirmed write followed by lost HTTP outcome: a new server should reconcile via chain state.
 const lostContent=makeContent('Synthetic committed post with lost response'),lostProof=await generateProof(ids[2],group,contentMessage(lostContent),scope,8);let committed;
 const lost=await withServer(store,async()=>{const sent=await wallet.createEntity(post(lostContent,lostProof));await receipt(sent.txHash,'lost-response-committed');committed=sent;throw Object.assign(Error('Simulated response lost after confirmed chain write'),{txHash:sent.txHash});},post=>post(lostContent,lostProof));
 const afterRestart=await withServer(store,async()=>{throw Error('Unexpected second write');},post=>post(lostContent,lostProof));result.lostResponse={first:lost,restarted:afterRestart,txHash:committed?.txHash};result.checks.push({name:'restart after lost confirmed write response',pass:lost.status===503&&afterRestart.status===409});save();
 // A failed submission that has NOT reached chain leaves only in-memory reservations.
 const uncertainContent=makeContent('Synthetic uncertain admission'),uncertainProof=await generateProof(ids[3],group,contentMessage(uncertainContent),scope,8);let calls=0;
 const noChainWrite=async()=>{calls++;throw Error('Simulated uncertain transport outcome; no actual broadcast in this test');};
 const uncertain1=await withServer(store,noChainWrite,post=>post(uncertainContent,uncertainProof));const uncertain2=await withServer(store,noChainWrite,post=>post(uncertainContent,uncertainProof));result.uncertainRestart={first:uncertain1.status,afterRestart:uncertain2.status,attempts:calls,mode:'failure injection: no transaction submitted'};
 if(calls===2)result.findings.push({severity:'high',name:'Uncertain reservations lost on restart',evidence:'Fresh processes both admitted the same nullifier to the write callback after a simulated uncertain outcome.'});
 const beforeExpiry=await reader.getBlockNumber({cacheTime:0});const exp=await wallet.createEntity(create('expiry_probe',{synthetic:true},{},ExpirationTime.fromBlocks(3)));const er=await receipt(exp.txHash,'short-expiry');const initial=await reader.getEntity(exp.entityKey);
 while(await reader.getBlockNumber({cacheTime:0})<=initial.expiresAt){await new Promise(r=>setTimeout(r,1000));}
 const history=await reader.select({key:true,payload:true}).where(eq('project',result.project),eq('type','expiry_probe')).createdBy(admin.address).atBlock(er.blockNumber).fetch();const live=await reader.select({key:true}).where(eq('project',result.project),eq('type','expiry_probe')).createdBy(admin.address).fetch();result.expiry={entityKey:exp.entityKey,creationBlock:er.blockNumber.toString(),expiresAt:initial.expiresAt.toString(),liveCount:live.entities.length,historicalCount:history.entities.length};result.checks.push({name:'expiry does not erase historical data',pass:live.entities.length===0&&history.entities.some(e=>e.key===exp.entityKey)});
 // Bounded archival probes read public infrastructure metadata only, never app-user payloads.
 result.archive=[];for(const block of [495684n,352358n]){try{const p=await reader.select({key:true,createdAt:true,expiresAt:true}).where(eq('project','arkognito-7f3k')).atBlock(block).limit(2).fetch();result.archive.push({block:block.toString(),returnedBlock:p.blockNumber.toString(),matches:p.entities.length,keys:p.entities.map(e=>e.key)});}catch(e){result.archive.push({block:block.toString(),error:e.message});}}
 result.balanceAfterWei=(await reader.getBalance({address:admin.address})).toString();result.gasCostGlm=formatEther(result.receipts.reduce((a,r)=>a+BigInt(r.gasCostWei),0n));result.verdict=result.findings.length?'RISKY':result.checks.every(c=>c.pass)?'GO':'NO-GO';
}catch(e){result.error=e.stack;result.txHash=e.txHash;result.verdict='RISKY';}
save();console.log(JSON.stringify(result,null,2));process.exit(result.error?1:0);
