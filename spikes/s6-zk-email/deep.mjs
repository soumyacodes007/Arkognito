import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {DkimVerifier} from '@zk-email/helpers/dist/lib/mailauth/dkim-verifier.js';
import {writeToStream} from '@zk-email/helpers/dist/lib/mailauth/tools.js';
const result={started:new Date().toISOString(),runtime:process.version,requests:[],registry:[],archiveChecks:[]};
const native=globalThis.fetch;
globalThis.fetch=async(url,opts)=>{const start=performance.now();const r=await native(url,{...opts,signal:AbortSignal.timeout(45000)});result.requests.push({url:String(url),status:r.status,ms:performance.now()-start});return r;};
const save=()=>writeFileSync(new URL('deep-result.json',import.meta.url),JSON.stringify(result,null,2));
try{
 const {initZkEmailSdk}=await import('@zk-email/sdk');const sdk=initZkEmailSdk();
 const attempts=[['list',()=>sdk.listBlueprints({limit:3})],['documented-slug',()=>sdk.getBlueprint('Bisht13/SuccinctZKResidencyInvite@v2')],['official-dev-example',()=>initZkEmailSdk({baseUrl:'https://dev-conductor.zk.email'}).getBlueprintById('9c4f651d-a925-45dc-b2b5-7cd51b401d0b')]];
 for(const [name,fn] of attempts){const start=performance.now();try{const x=await fn();result.registry.push({name,ok:true,ms:performance.now()-start,blueprints:(Array.isArray(x)?x:[x]).map(b=>({id:b.props?.id,slug:b.props?.slug,senderDomain:b.props?.senderDomain,clientStatus:b.props?.clientStatus,framework:b.props?.clientZkFramework}))});}catch(e){result.registry.push({name,ok:false,error:e.message,ms:performance.now()-start});}save();}
 const source='https://raw.githubusercontent.com/zkemail/zk-email-verify/main/packages/helpers/tests/test-data/multi-dkim-sig.eml';
 const response=await fetch(source);const email=Buffer.from(await response.arrayBuffer());result.sampleSha256=createHash('sha256').update(email).digest('hex');
 const headers=email.toString().split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g,' ');
 const signatures=[...headers.matchAll(/^DKIM-Signature:(.*)$/gmi)].map(m=>({domain:m[1].match(/\bd=([^;\s]+)/)?.[1],selector:m[1].match(/\bs=([^;\s]+)/)?.[1]}));
 for(const {domain,selector} of signatures){
  const out={domain,selector,trials:[]};result.archiveChecks.push(out);
  try{
   const response=await fetch(`https://archive.prove.email/api/key?domain=${encodeURIComponent(domain)}`);if(!response.ok)throw Error(`Archive HTTP ${response.status}`);
   const all=await response.json();if(!Array.isArray(all))throw Error('Archive returned non-array');const records=all.filter(r=>r.selector===selector).slice(0,16);out.matchingKeys=records.length;
   for(const [i,record] of records.entries()){
    const t=performance.now();
    const v=new DkimVerifier({skipBodyHash:false,resolver:async(name,type)=>{if(type!=='TXT'||name!==`${selector}._domainkey.${domain}`)throw Error('No matching archived key for this signature');return [record.value];}});
    await writeToStream(v,email);const check=v.results.find(r=>r.signingDomain===domain&&r.selector===selector);
    out.trials.push({keyIndex:i,result:check?.status?.result,comment:check?.status?.comment,ms:performance.now()-t});if(check?.status?.result==='pass'){out.verified=true;out.keyIndex=i;break;}
   }
  }catch(e){out.error=e.message;}
  save();
 }
 result.verdict='RISKY';result.proofTimeMs=null;result.blocker='No compiled accessible matching blueprint and no ZK Email proof generated; archived-key DKIM checks are signature checks only.';
}catch(e){result.error=e.stack;result.verdict='RISKY';}
save();console.log(JSON.stringify(result,null,2));process.exit(0);
