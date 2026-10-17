import {Identity} from '@semaphore-protocol/identity';
import {Group} from '@semaphore-protocol/group';
import {generateProof,verifyProof} from '@semaphore-protocol/proof';
window.runSpike=async(hosted=false)=>{
 const result={hosted, userAgent:navigator.userAgent, crossOriginIsolated};
 try {
  const secret=crypto.getRandomValues(new Uint8Array(32));
  const id=new Identity(secret); result.deterministic=id.commitment===new Identity(secret).commitment;
  const g=new Group([id,...Array.from({length:4},()=>new Identity())].map(x=>x.commitment));
  const start=performance.now();
  const proof=await generateProof(id,g,123456789n,20261017n,3,hosted?{wasm:'/artifacts/semaphore-3.wasm',zkey:'/artifacts/semaphore-3.zkey'}:undefined);
  result.proofMs=performance.now()-start;
  const verifyStart=performance.now();result.verified=await verifyProof(proof);result.verifyMs=performance.now()-verifyStart;
  result.proofJsonBytes=new TextEncoder().encode(JSON.stringify(proof)).length;
  result.verdict=result.verified?'GO':'NO-GO';
 }catch(e){result.error=e.stack;result.verdict='RISKY';}
 document.querySelector('#out').textContent=JSON.stringify(result);return result;
};
