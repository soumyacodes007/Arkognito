// Read only binary header metadata; do not load a million constraints or spawn workers.
import {openSync,readSync,closeSync,writeFileSync} from 'node:fs';
const file=openSync(new URL('state/main.r1cs',import.meta.url),'r');
const take=(n,pos)=>{const b=Buffer.alloc(n);if(readSync(file,b,0,n,pos)!==n)throw Error('Incomplete R1CS file');return b;};
const prefix=take(12,0);if(prefix.toString('ascii',0,4)!=='r1cs'||prefix.readUInt32LE(4)!==1)throw Error('Unsupported R1CS format');
let pos=12,result={at:new Date().toISOString()};
for(let i=0;i<prefix.readUInt32LE(8);i++){const s=take(12,pos),type=s.readUInt32LE(0),size=Number(s.readBigUInt64LE(4));if(type===1){const h=take(size,pos+12),n8=h.readUInt32LE(0);Object.assign(result,{wires:h.readUInt32LE(n8+4),outputs:h.readUInt32LE(n8+8),publicInputs:h.readUInt32LE(n8+12),privateInputs:h.readUInt32LE(n8+16),constraints:h.readUInt32LE(n8+28)});}pos+=12+size;}
closeSync(file);result.ptauPower=Math.ceil(Math.log2(result.constraints+result.outputs+result.publicInputs+1));writeFileSync(new URL('r1cs-header-result.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
