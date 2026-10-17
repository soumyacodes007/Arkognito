import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {writeFileSync} from 'node:fs';
const result={started:new Date().toISOString()};let browser;
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>PRF test</title>Synthetic virtual authenticator');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
try{
 try{browser=await chromium.launch({headless:true});}catch(e){result.bundledError=e.message;browser=await chromium.launch({headless:true,channel:'chrome'});}
 result.browserVersion=browser.version();
 const page=await browser.newPage();await page.goto(`http://localhost:${server.address().port}`);
 const cdp=await page.context().newCDPSession(page);await cdp.send('WebAuthn.enable');
 await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',ctap2Version:'ctap2_1',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,hasPrf:true,automaticPresenceSimulation:true}});
 result.prf=await page.evaluate(async()=>{
  const rand=n=>crypto.getRandomValues(new Uint8Array(n));const salt=rand(32);let start=performance.now();
  const credential=await navigator.credentials.create({publicKey:{challenge:rand(32),rp:{name:'Synthetic PRF spike'},user:{id:rand(16),name:'synthetic',displayName:'Synthetic'},pubKeyCredParams:[{type:'public-key',alg:-7}],authenticatorSelection:{residentKey:'required',userVerification:'required'},extensions:{prf:{eval:{first:salt}}}}});
  const createMs=performance.now()-start;const creation=credential.getClientExtensionResults();
  const get=async first=>{const c=await navigator.credentials.get({publicKey:{challenge:rand(32),allowCredentials:[{type:'public-key',id:credential.rawId}],userVerification:'required',extensions:{prf:{eval:{first}}}}});return c.getClientExtensionResults().prf;};
  start=performance.now();const a=await get(salt);const getMs=performance.now()-start;const b=await get(salt);const c=await get(rand(32));
  const equal=(x,y)=>!!x&&!!y&&new Uint8Array(x).every((v,i)=>v===new Uint8Array(y)[i]);
  return {createMs,getMs,enabled:creation.prf?.enabled,createHasResult:!!creation.prf?.results?.first,resultBytes:a?.results?.first?.byteLength??0,stable:equal(a?.results?.first,b?.results?.first),differentSaltDifferent:!equal(a?.results?.first,c?.results?.first)};
 });result.verdict=result.prf.resultBytes===32&&result.prf.stable&&result.prf.differentSaltDifferent?'GO':'RISKY';
}catch(e){result.error=e.stack;result.verdict='RISKY';}
finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));writeFileSync(new URL('result.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
