import {Identity} from '@semaphore-protocol/identity';
import {Group} from '@semaphore-protocol/group';
import {generateProof,verifyProof} from '@semaphore-protocol/proof';
window.benchmark=async()=>{const row={members:4096,depth:12,crossOriginIsolated};const id=new Identity(crypto.getRandomValues(new Uint8Array(32)));let t=performance.now();const g=new Group([id.commitment,...Array.from({length:4095},(_,i)=>BigInt(i+1))]);row.buildMs=performance.now()-t;t=performance.now();const proof=await generateProof(id,g,123456789n,987654321n,12);row.proofMs=performance.now()-t;t=performance.now();row.verified=await verifyProof(proof);row.verifyMs=performance.now()-t;row.jsonBytes=new TextEncoder().encode(JSON.stringify(proof)).length;return row;};
