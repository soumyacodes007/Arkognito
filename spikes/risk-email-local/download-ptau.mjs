// Bounded artifact availability experiment, using the current official snarkjs
// README URL/hash. No circuit inputs or personal data leave this machine.
import {createWriteStream,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';import {Readable,Transform} from 'node:stream';import {pipeline} from 'node:stream/promises';
const result={started:new Date().toISOString(),runtime:process.version,power:21};
const state=new URL('state/',import.meta.url);mkdirSync(state,{recursive:true});
try{
 const docs=await(await fetch('https://raw.githubusercontent.com/iden3/snarkjs/master/README.md',{signal:AbortSignal.timeout(15000)})).text();
 const row=docs.split('\n').find(s=>s.includes('_final_21.ptau'));const url=row?.match(/https:\/\/[^\s)\]|]+_final_21\.ptau/)?.[0],expected=row?.match(/\b[0-9a-f]{128}\b/)?.[0];
 if(!url||!expected)throw Error('Official README missing power-21 URL or BLAKE2b-512 checksum');
 result.url=url;result.expectedBlake2b512=expected;let bytes=0;const hash=createHash('blake2b512'),t=performance.now(),signal=AbortSignal.timeout(480000);
 const res=await fetch(url,{signal});if(!res.ok)throw Error(`PTAU download HTTP ${res.status} ${res.statusText}`);result.contentLength=res.headers.get('content-length');
 const meter=new Transform({transform(chunk,encoding,callback){bytes+=chunk.length;if(bytes>3_000_000_000)return callback(Error('Artifact exceeds 3 GB bounded download'));hash.update(chunk);callback(null,chunk);}});
 await pipeline(Readable.fromWeb(res.body),meter,createWriteStream(new URL('powers.ptau.part',state)),{signal});
 result.bytes=bytes;result.downloadAndHashMs=performance.now()-t;result.actualBlake2b512=hash.digest('hex');result.checksumMatches=result.actualBlake2b512===expected;
 if(!result.checksumMatches)throw Error('PTAU checksum mismatch');
 renameSync(new URL('powers.ptau.part',state),new URL('powers.ptau',state));result.verdict='GO for artifact retrieval';
}catch(e){result.error=e.stack;result.verdict='RISKY';}
writeFileSync(new URL('artifact-download-result.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));process.exit(result.error?1:0);
