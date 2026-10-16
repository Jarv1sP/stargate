import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {createPortalServer} from '../portal-server.mjs';

const password='Synthetic-API-Rate-2026!',client={name:'gpuctl',protocol:2};
async function fixture(t){
 const now=Date.now();t.mock.method(Date,'now',()=>now); // Keep all requests in the same rate window.
 const dir=await mkdtemp(join(tmpdir(),'portal-rate-')),bootstrap=join(dir,'bootstrap');
 await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});
 const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
 const origin='http://127.0.0.1:'+port,calls=[];
 const {server,service}=await createPortalServer({database:join(dir,'portal.sqlite'),bootstrap,origin,secure:false,bridge:async(...args)=>{calls.push(args);return {};}});
 clearInterval(service.executionTimer);await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
 const post=async(path,data,headers={})=>{const response=await fetch(origin+'/api/'+path,{method:'POST',headers:{'content-type':'application/json','x-real-ip':'192.0.2.50',...headers},body:JSON.stringify({client,...data})});return {status:response.status,data:await response.json(),headers:response.headers};};
 return {origin,calls,post};
}

test('1500 authenticated cookie and bearer queries from one IP succeed without throttling',async t=>{
 const f=await fixture(t),login=await f.post('login',{username:'admin',password});assert.equal(login.status,200);
 const browser=await f.post('login',{username:'admin',password,client:'browser'},{Origin:f.origin});assert.equal(browser.status,200);
 const bearer={Authorization:'Bearer '+login.data.token},cookie={Cookie:browser.headers.get('set-cookie').split(';',1)[0],Origin:f.origin};
 for(let index=0;index<1500;index++){
  const reply=await f.post('call',index%2?{operation:'state',args:{view:'summary'}}:{operation:'storage.snapshot'},index%2?cookie:bearer);
  assert.equal(reply.status,200,'query '+(index+1)+': '+JSON.stringify(reply.data));
 }
 assert.equal(f.calls.length,0,'local queries do not access a node');
 assert.equal((await f.post('call',{operation:'state'})).status,401,'anonymous calls still require login');
 assert.equal((await f.post('call',{operation:'state'},{Authorization:'Bearer '+'a'.repeat(64)})).status,401,'an invalid session is never admitted');
 assert.equal((await f.post('call',{operation:'state'}, {Cookie:cookie.Cookie})).status,403,'cookie writes still need the browser origin');
 assert.equal((await f.post('call',{operation:'state',padding:'x'.repeat(1500000)},bearer)).status,413,'authenticated calls retain the body limit');
});

test('login and registration retain their existing IP limits even with a valid session',async t=>{
 const f=await fixture(t),login=await f.post('login',{username:'admin',password});assert.equal(login.status,200);
 const bearer={Authorization:'Bearer '+login.data.token};
 for(let index=1;index<20;index++)assert.equal((await f.post('login',{username:'admin',password},bearer)).status,200);
 const limited=await f.post('login',{username:'admin',password},bearer);assert.equal(limited.status,429);assert.equal(limited.headers.get('retry-after'),'60');
 for(let index=0;index<5;index++)assert.equal((await f.post('register',{username:'not-created',password},bearer)).status,403);
 assert.equal((await f.post('register',{username:'not-created',password},bearer)).status,429);
 assert.equal((await f.post('call',{operation:'storage.snapshot'},bearer)).status,200,'auth limits do not block the logged-in business session');
});
