import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const result={started:new Date().toISOString(),runtime:process.version,stages:[],downloads:[]};
const nativeFetch=globalThis.fetch;
globalThis.fetch=async(url,opts)=>{const t=performance.now();const res=await nativeFetch(url,{...opts,signal:AbortSignal.timeout(240000)});result.downloads.push({url:String(url),status:res.status,contentLength:res.headers.get('content-length'),responseMs:performance.now()-t});return res;};
const save=()=>writeFileSync(new URL('result.json',import.meta.url),JSON.stringify(result,null,2));
try{
 const core=await import('@anon-aadhaar/core');
 result.exportedFunctions=Object.keys(core).filter(k=>/init|prove|verify|generateArgs|artifact|testPublicKeyHash/i.test(k));
 const base='https://raw.githubusercontent.com/anon-aadhaar/anon-aadhaar/main/packages/circuits/assets/';
 const dataResponse=await fetch(base+'test.json');if(!dataResponse.ok)throw Error(`test fixture HTTP ${dataResponse.status}`);const data=await dataResponse.json();
 const certResponse=await fetch(base+'testCertificate.pem');if(!certResponse.ok)throw Error(`test certificate HTTP ${certResponse.status}`);const certificate=await certResponse.text();
 const t0=performance.now();const args=await core.generateArgs({qrData:data.testQRData,certificateFile:certificate,nullifierSeed:1234n,fieldsToRevealArray:[],signal:'0x'+createHash('sha256').update('synthetic-veil-join').digest('hex')});result.argsMs=performance.now()-t0;
 result.revealFlags=['revealAgeAbove18','revealGender','revealPinCode','revealState'].map(k=>({field:k,value:args[k].value}));
 await core.init({wasmURL:core.artifactUrls.v2.wasm,zkeyURL:core.artifactUrls.v2.zkey,vkeyURL:core.artifactUrls.v2.vk,artifactsOrigin:core.ArtifactsOrigin.server});
 let t=performance.now();const proof=await core.prove(args,state=>{result.stages.push({state,elapsedMs:performance.now()-t});save();console.log('stage',state);});result.proofMs=performance.now()-t;
 t=performance.now();result.verified=await core.verify(proof,true);result.verifyMs=performance.now()-t;result.proofJsonBytes=Buffer.byteLength(JSON.stringify(proof));
 result.testPubkeyMatches=proof.proof.pubkeyHash===core.testPublicKeyHash;
 result.publicSignalNames=Object.keys(proof.proof).filter(k=>k!=='groth16Proof');
 try{await core.verify(proof,false);result.productionRejected=false;}catch(e){result.productionRejected=true;result.productionError=e.message;}
 result.verdict=result.verified&&result.productionRejected?'GO':'RISKY';
}catch(e){result.verdict='RISKY';result.error=e.stack;}
save();console.log(JSON.stringify(result,null,2));process.exit(result.error?1:0);
