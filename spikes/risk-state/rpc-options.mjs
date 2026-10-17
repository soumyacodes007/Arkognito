import {existsSync,readFileSync} from 'node:fs';
// Only the existing server-side RPC access key is read; never import/use existing wallet keys.
const env=new URL('../../.env',import.meta.url);let accessKey=existsSync(env)?readFileSync(env,'utf8').match(/^ARKIV_ACCESS_KEY=(.*)$/m)?.[1]?.trim():undefined;
if(accessKey&&((accessKey.startsWith('"')&&accessKey.endsWith('"'))||(accessKey.startsWith("'")&&accessKey.endsWith("'"))))accessKey=accessKey.slice(1,-1);
export const accessKeyConfigured=!!accessKey;
export function rpcOptions(){return{retryCount:0,timeout:15000,fetchOptions:{redirect:'error',...(accessKey?{headers:{'X-API-KEY':accessKey}}:{})}};}
