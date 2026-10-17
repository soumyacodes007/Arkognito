import {writeFileSync} from 'node:fs';
import {verifyDKIMSignature} from '@zk-email/helpers/dist/dkim/index.js';
const result={started:new Date().toISOString(),source:'https://raw.githubusercontent.com/zkemail/zk-email-verify/main/packages/helpers/tests/test-data/email-good.eml'};
try{const res=await fetch(result.source,{signal:AbortSignal.timeout(30000)});if(!res.ok)throw Error(`HTTP ${res.status}`);const email=Buffer.from(await res.arrayBuffer());const t=performance.now();const d=await verifyDKIMSignature(email,'icloud.com',true,true,false);result.dkIMms=performance.now()-t;result.verified=true;result.domain=d.signingDomain;result.selector=d.selector;result.modulusLength=d.modulusLength;result.sanitization=d.appliedSanitization;}catch(e){result.verified=false;result.error=e.stack;}
writeFileSync(new URL('control-result.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
