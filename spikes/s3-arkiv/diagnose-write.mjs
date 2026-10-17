import {createWalletClient,ExpirationTime,jsonToPayload} from '@arkiv-network/sdk';
import {tiramisu} from '@arkiv-network/sdk/chains';
import {http} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {readFileSync,writeFileSync} from 'node:fs';
const key=readFileSync(new URL('../.env',import.meta.url),'utf8').match(/^SPIKE_PRIVATE_KEY=(0x[0-9a-f]{64})$/m)?.[1];
const account=privateKeyToAccount(key),result={started:new Date().toISOString(),methods:[],rpcErrors:[],causes:[]};
// Guarded diagnosis only: this account cannot sign or submit any transaction.
const blockedAccount={...account,signTransaction:async()=>{throw Error('DIAGNOSTIC_SIGN_BARRIER');}};
const transport=config=>{const base=http(tiramisu.rpcUrls.default.http[0],{retryCount:0,timeout:10000})(config);return{...base,request:async args=>{result.methods.push(args.method);if(/sendRawTransaction|sendTransaction|sendCalls/.test(args.method))throw Error('DIAGNOSTIC_SEND_BARRIER');try{return await base.request(args);}catch(e){result.rpcErrors.push({method:args.method,name:e.name,shortMessage:e.shortMessage,details:e.details,code:e.code});throw e;}}};};
try{const wallet=createWalletClient({chain:tiramisu,account:blockedAccount,cacheTime:0,transport});await wallet.createEntity({payload:jsonToPayload({synthetic:true}),contentType:'application/json',attributes:{project:'veil-zk-diagnostic'},expires:ExpirationTime.fromDays(1)});result.unexpectedSuccess=true;}catch(e){let c=e;for(let i=0;c&&i<8;i++,c=c.cause)result.causes.push({name:c.name,shortMessage:c.shortMessage,details:c.details,message:i===0?c.message:undefined});}
writeFileSync(new URL('write-diagnostic.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
