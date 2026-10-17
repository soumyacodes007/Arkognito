import {createServer} from 'vite';
import {chromium} from 'playwright';
import {mkdirSync,copyFileSync,writeFileSync} from 'node:fs';
const results={started:new Date().toISOString(),runs:[],requests:[],console:[]};
let server,browser;
try{
 mkdirSync(new URL('public/artifacts/',import.meta.url),{recursive:true});
 for(const ext of ['wasm','zkey'])copyFileSync(new URL(`../s1-semaphore-node/artifacts/semaphore-3.${ext}`,import.meta.url),new URL(`public/artifacts/semaphore-3.${ext}`,import.meta.url));
 server=await createServer({root:new URL('.',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'),server:{host:'127.0.0.1',port:0}});await server.listen();
 try{browser=await chromium.launch({headless:true});}catch(e){results.bundledChromiumError=e.message;browser=await chromium.launch({channel:'chrome',headless:true});}
 results.browserVersion=browser.version();
 const page=await browser.newPage();
 page.on('response',r=>{if(/wasm|zkey/.test(r.url()))results.requests.push({url:r.url(),status:r.status()});});
 page.on('console',m=>{if(m.type()==='error'||m.type()==='warning')results.console.push(m.text());});
 await page.goto(server.resolvedUrls.local[0]);await page.waitForFunction(()=>typeof window.runSpike==='function');
 for(const hosted of [false,true])results.runs.push(await page.evaluate(async hosted=>window.runSpike(hosted),hosted));
 results.verdict=results.runs.every(x=>x.verified)?'GO':'RISKY';
}catch(e){results.verdict='RISKY';results.error=e.stack;}
finally{await browser?.close();await server?.close();writeFileSync(new URL('result.json',import.meta.url),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));}
