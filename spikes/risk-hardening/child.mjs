import {readFileSync,appendFileSync} from 'node:fs';
import {Group} from '@semaphore-protocol/group';
import {endpoint,Journal} from './hardened.mjs';
const [fixturePath,journalPath,auditPath,mode]=process.argv.slice(2);
const f=JSON.parse(readFileSync(fixturePath));
const store={getHead:async()=>BigInt(f.head),getGroupAt:async()=>({readonly:true,chainId:7738577,depth:3}),getMembersAt:async()=>f.commitments.map((commitment,index)=>({index,commitment})),listPosts:async()=>[]};
const server=endpoint({group:f.group,store,journal:new Journal(journalPath),now:()=>new Date(f.now),write:async p=>{appendFileSync(auditPath,JSON.stringify({pid:process.pid,mode})+'\n',{flush:true});if(mode==='crash')process.exit(77);if(mode==='uncertain')throw Error('Injected uncertain outcome; no broadcast');return {syntheticLocal:true,entityKey:'local-'+p.proof.nullifier};}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));console.log(JSON.stringify({port:server.address().port,pid:process.pid}));
