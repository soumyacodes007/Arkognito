import {verifyDKIMSignature} from '@zk-email/helpers/dist/dkim/index.js';
import {generateEmailVerifierInputsFromDKIMResult} from '@zk-email/helpers/dist/input-generators.js';
import {groth16,r1cs,wtns,zKey} from 'snarkjs';
import {mkdirSync,writeFileSync,appendFileSync,readFileSync,existsSync,createWriteStream,statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';import {spawn} from 'node:child_process';import {Readable} from 'node:stream';import {pipeline} from 'node:stream/promises';import {randomBytes,createHash} from 'node:crypto';
const result={started:new Date().toISOString(),runtime:process.version,compiler:process.argv.includes('--native')?'official native Circom 2.2.3 (publisher SHA-256 checked)':'circom2 npm 0.2.23 WASM',stages:[],note:'Standalone library circuit, not Registry blueprint. Public upstream sample, local proving only; no email data/proof/public signals sent to Arkiv. Local experimental setup is not a production trusted setup.'};
const dir=new URL('state/',import.meta.url);mkdirSync(dir,{recursive:true});const path=n=>fileURLToPath(new URL(n,dir));const save=()=>writeFileSync(new URL('result.json',import.meta.url),JSON.stringify(result,null,2));const begin=name=>{console.log('stage',name);result.stages.push({name,at:new Date().toISOString()});save();};
const native=fetch;globalThis.fetch=(url,opts)=>native(url,{...opts,signal:opts?.signal??AbortSignal.timeout(180000)});
async function command(args){return await new Promise((resolve,reject)=>{
 const native=process.argv.includes('--native'),timeoutMs=300000;
 writeFileSync(path('compile.log'),'');
 const child=spawn(native?path('circom.exe'):process.execPath,native?args.slice(2):args,{cwd:fileURLToPath(new URL('.',import.meta.url)),windowsHide:true,timeout:timeoutMs,killSignal:'SIGTERM',env:{...process.env,RAYON_NUM_THREADS:'2'}});
 result.compilerRun={pid:child.pid,startedAt:new Date().toISOString(),timeoutMs,rayonThreads:2};save();
 let out='';const capture=b=>{out+=b;appendFileSync(path('compile.log'),b);};child.stdout.on('data',capture);child.stderr.on('data',capture);
 child.on('error',reject);child.on('close',(code,signal)=>{Object.assign(result.compilerRun,{endedAt:new Date().toISOString(),exitCode:code,signal});save();if(code!==0)reject(Error(`Compiler exit ${code}, signal ${signal}: ${out.slice(-3000)}`));else resolve(out);});
 });}
try{
 begin('verify-public-DKIM');const source='https://raw.githubusercontent.com/zkemail/zk-email-verify/main/packages/helpers/tests/test-data/email-good.eml';const res=await fetch(source);const email=Buffer.from(await res.arrayBuffer());const dkim=await verifyDKIMSignature(email,'icloud.com',true,true,false);result.dkimVerified=true;result.domain=dkim.signingDomain;
 // Leave one SHA block of capacity beyond padded data: the circuit's Num2Bits
 // length check cannot represent maxLength itself when maxLength is a power of 2.
 const padded=n=>Math.ceil((n+9)/64)*64+64;const header=Math.max(192,padded(dkim.headers.length));const body=Math.max(192,padded(dkim.body.length));result.maxHeaderBytes=header;result.maxBodyBytes=body;
 const input=generateEmailVerifierInputsFromDKIMResult(dkim,{ignoreBodyHashCheck:false,maxHeadersLength:header,maxBodyLength:body});writeFileSync(path('input.json'),JSON.stringify(input));
 writeFileSync(new URL('main.circom',import.meta.url),`pragma circom 2.1.6;\ninclude "@zk-email/circuits/email-verifier.circom";\ncomponent main = EmailVerifier(${header}, ${body}, 121, 17, 0, 0, 0, 0);\n`);
 begin('compile');let t=performance.now();const compile=await command(['--max-old-space-size=6144','node_modules/circom2/cli.js','main.circom','--r1cs','--wasm','--O1','-l','node_modules','-o','state']);result.compileMs=performance.now()-t;result.compileSummary=compile.trim().split(/\r?\n/).filter(s=>/constraints|inputs|outputs|wires|labels|written/i.test(s)).slice(0,18);save();
 begin('inspect-and-witness');const info=await r1cs.info(path('main.r1cs'));result.constraints=info.nConstraints;result.wires=info.nVars;result.publicInputs=info.nPubInputs;result.outputs=info.nOutputs;
 const wasm=path('main_js/main.wasm');t=performance.now();await wtns.calculate(input,wasm,path('witness.wtns'));result.witnessMs=performance.now()-t;result.witnessValid=await wtns.check(path('main.r1cs'),path('witness.wtns'));save();
 const power=Math.ceil(Math.log2(info.nConstraints+info.nPubInputs+info.nOutputs+1));result.ptauPower=power;
 // Read the official snarkjs README to obtain the artifact URL rather than inventing one.
 const docs=await(await fetch('https://raw.githubusercontent.com/iden3/snarkjs/master/README.md')).text();const urls=[...docs.matchAll(/https:\/\/[^\s)\]|]+powersOfTau[^\s)\]|]+/g)].map(m=>m[0]);const url=urls.find(u=>u.endsWith(`_final_${String(power).padStart(2,'0')}.ptau`));if(!url)throw Error(`Official README has no ptau URL for power ${power}`);result.ptauUrl=url;
 begin('download-ptau');t=performance.now();const ptau=path('powers.ptau');if(!existsSync(ptau)){const r=await fetch(url);if(!r.ok)throw Error(`PTAU HTTP ${r.status} ${r.statusText}`);await pipeline(Readable.fromWeb(r.body),createWriteStream(ptau));}result.ptauDownloadMs=performance.now()-t;result.ptauBytes=statSync(ptau).size;save();
 begin('local-experimental-setup');t=performance.now();await zKey.newZKey(path('main.r1cs'),ptau,path('initial.zkey'));await zKey.contribute(path('initial.zkey'),path('final.zkey'),'Synthetic feasibility contribution',randomBytes(32).toString('hex'));result.setupMs=performance.now()-t;save();
 begin('prove');t=performance.now();const {proof,publicSignals}=await groth16.prove(path('final.zkey'),path('witness.wtns'));result.proofMs=performance.now()-t;result.proofBytes=Buffer.byteLength(JSON.stringify(proof));result.publicSignalCount=publicSignals.length;
 const vk=await zKey.exportVerificationKey(path('final.zkey'));t=performance.now();result.verified=await groth16.verify(vk,publicSignals,proof);result.verifyMs=performance.now()-t;result.verdict=result.verified?'GO for standalone DKIM circuit':'NO-GO';result.limit='No company employment statement extraction, commitment binding, freshness, or nullifier policy in this bare signature/body-hash circuit.';
}catch(e){result.error=e.stack;result.verdict='RISKY';}
save();console.log(JSON.stringify(result,null,2));process.exit(result.error?1:0);
