import {Identity} from '@semaphore-protocol/identity';
import {Group} from '@semaphore-protocol/group';
import {generateProof,verifyProof} from '@semaphore-protocol/proof';
import {randomBytes} from 'node:crypto';
import {writeFileSync} from 'node:fs';
const result={started:new Date().toISOString(),runtime:process.version,runs:[],downloads:[],note:'One real signer plus random field commitments for non-signing leaves; measures tree/proof scaling, not identity enrollment throughput.'};
const native=fetch;globalThis.fetch=async(url,opts)=>{const t=performance.now();const r=await native(url,{...opts,signal:AbortSignal.timeout(120000)});result.downloads.push({url:String(url),status:r.status,contentLength:r.headers.get('content-length'),ms:performance.now()-t});return r;};
const save=()=>writeFileSync(new URL('result.json',import.meta.url),JSON.stringify(result,null,2));
try{
 const id=new Identity(randomBytes(32)),field=21888242871839275222246405745257275088548364400416034343698204186575808495617n;
 for(const depth of [8,12,16]){const row={depth,members:2**depth};result.runs.push(row);let t=performance.now();const commitments=[id.commitment,...Array.from({length:row.members-1},()=>BigInt('0x'+randomBytes(32).toString('hex'))%field)];const group=new Group(commitments);row.groupBuildMs=performance.now()-t;row.actualDepth=group.depth;save();
 t=performance.now();const proof=await generateProof(id,group,123456789n,987654321n,depth);row.coldProofMs=performance.now()-t;t=performance.now();row.verified=await verifyProof(proof);row.verifyMs=performance.now()-t;row.proofJsonBytes=Buffer.byteLength(JSON.stringify(proof));
 t=performance.now();const warm=await generateProof(id,group,123456789n,987654321n,depth);row.cachedProofMs=performance.now()-t;row.cachedVerified=await verifyProof(warm);row.rssBytes=process.memoryUsage().rss;row.maxRssKB=process.resourceUsage().maxRSS;save();console.log(JSON.stringify(row));}
 result.verdict=result.runs.every(r=>r.verified&&r.cachedVerified)?'GO':'RISKY';
}catch(e){result.error=e.stack;result.verdict='RISKY';}
save();console.log(JSON.stringify(result,null,2));process.exit(result.error?1:0);
