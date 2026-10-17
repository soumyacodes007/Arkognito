import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const result={started:new Date().toISOString(),checks:[],sampleSource:'https://raw.githubusercontent.com/zkemail/zk-email-verify/main/packages/helpers/tests/test-data/multi-dkim-sig.eml'};
const fetchNative=globalThis.fetch;
globalThis.fetch=(url,opts)=>fetchNative(url,{...opts,signal:AbortSignal.timeout(60000)});
try{
 const sample=await fetch(result.sampleSource);if(!sample.ok)throw Error(`Public sample HTTP ${sample.status}`);
 const email=await sample.text();result.sampleBytes=Buffer.byteLength(email);result.sampleSha256=createHash('sha256').update(email).digest('hex');
 // Public upstream test fixture only. Neither the email nor extracted personal fields go to Arkiv or the reports.
 const headers=email.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g,' ');
 result.signingDomains=[...headers.matchAll(/^DKIM-Signature:.*?\bd=([^;\s]+)/gmi)].map(m=>m[1]);
 const {verifyDKIMSignature}=await import('@zk-email/helpers/dist/dkim/index.js');
 for(const domain of result.signingDomains){let t=performance.now();try{const verified=await verifyDKIMSignature(email,domain,false,true,false);result.checks.push({domain,verified:true,dkimMs:performance.now()-t,algorithm:verified.algo,modulusLength:verified.modulusLength,selector:verified.selector});}catch(e){result.checks.push({domain,verified:false,dkimMs:performance.now()-t,error:e.message});}}
 try{
  const {initZkEmailSdk}=await import('@zk-email/sdk');const sdk=initZkEmailSdk();
  const t=performance.now();const blueprints=await sdk.listBlueprints({limit:5});result.registryMs=performance.now()-t;
  result.registryBlueprints=blueprints.map(b=>({slug:b.props?.slug,id:b.props?.id,status:b.props?.status}));
  // Inspect returned blueprints instead of publishing a new account-bound circuit or sending this email remotely.
  result.blueprintCount=blueprints.length;
 }catch(e){result.registryError=e.stack;}
 result.verdict='RISKY';result.proofTimeMs=null;result.blocker='DKIM verification and registry availability do not establish a matching employment-domain blueprint; no employment proof generated.';
}catch(e){result.verdict='RISKY';result.error=e.stack;}
writeFileSync(new URL('result.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));process.exit(0);
