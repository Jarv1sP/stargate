import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {createRolloutServer} from '../portal-rollout.mjs';

const listen=async server=>{server.listen(0,'127.0.0.1');await once(server,'listening');return 'http://127.0.0.1:'+server.address().port;};
const close=server=>new Promise(resolve=>server.close(resolve));
const post=(url,body)=>fetch(url,{method:'POST',body}).then(async res=>({status:res.status,body:await res.text()}));

test('healthy candidate proxies old service, drains it, and dispatches held writes once only after activation',async()=>{
  const oldBodies=[],newBodies=[];
  const make=(bodies,label)=>http.createServer(async(req,res)=>{let body='';for await(const b of req)body+=b;bodies.push(body);res.end(label);});
  const old=make(oldBodies,'old'),next=make(newBodies,'new');
  const oldURL=await listen(old),nextURL=await listen(next);let activated=0;
  const r=createRolloutServer({upstream:oldURL,startActive:()=>{activated++;return nextURL;}}),url=await listen(r.server);
  try{
    assert.deepEqual(await post(url,'old-key'),{status:200,body:'old'});
    r.hold();
    const held=post(url,'same-key-never-replayed');
    for(let i=0;r.state().pending===0&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(r.state().pending,1);assert.deepEqual(newBodies,[]);assert.deepEqual(oldBodies,['old-key']);
    assert.equal((await fetch(url+'/healthz')).status,200);
    await close(old);await r.activate();await r.activate();
    assert.deepEqual(await held,{status:200,body:'new'});assert.equal(activated,1);
    assert.deepEqual(newBodies,['same-key-never-replayed']);assert.equal(r.state().pending,0);
  }finally{await r.close();if(old.listening)await close(old);await close(next);}
});

test('in-flight old write must finish before activation; no application request is replayed',async()=>{
  let finish,started;
  const arrived=new Promise(resolve=>started=resolve),hold=new Promise(resolve=>finish=resolve);let calls=0,activated=0;
  const old=http.createServer(async(req,res)=>{calls++;req.resume();started();await hold;res.end('confirmed');});
  const oldURL=await listen(old),r=createRolloutServer({upstream:oldURL,startActive:()=>{activated++;return oldURL;}}),url=await listen(r.server);
  try{
    const request=post(url,'original-key');await arrived;r.hold();
    await assert.rejects(r.activate(),/not drained/);assert.equal(activated,0);
    finish();assert.equal((await request).body,'confirmed');
    await new Promise(resolve=>setImmediate(resolve));assert.equal(r.state().forwarding,0);
    await r.activate();assert.equal(calls,1);assert.equal(activated,1);
  }finally{finish();await r.close();await close(old);}
});

test('ambiguous upstream failure is returned once, never sent to a replacement',async()=>{
  let calls=0,activated=0;
  const old=http.createServer(req=>{calls++;req.socket.destroy();});
  const oldURL=await listen(old),r=createRolloutServer({upstream:oldURL,startActive:()=>{activated++;return oldURL;}}),url=await listen(r.server);
  try{const result=await post(url,'do-not-replay');assert.equal(result.status,503);assert.equal(calls,1);assert.equal(activated,0);assert.equal(r.state().forwarding,0);}
  finally{await r.close();await close(old);}
});

test('holding queue is bounded and abandoned requests never dispatch after activation',async()=>{
  let calls=0;
  const old=http.createServer((req,res)=>{calls++;req.resume();res.end('ok');}),oldURL=await listen(old);
  const r=createRolloutServer({upstream:oldURL,startActive:()=>oldURL,maxPending:1,queueTimeout:5000}),url=await listen(r.server);
  try{
    r.hold();const controller=new AbortController();const pending=fetch(url,{method:'POST',body:'abandoned',signal:controller.signal}).catch(()=>null);
    for(let i=0;r.state().pending===0&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal((await post(url,'over-limit')).status,503);assert.equal(calls,0);
    controller.abort();await pending;
    for(let i=0;r.state().pending!==0&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,5));
    await r.activate();assert.equal(calls,0);
  }finally{await r.close();await close(old);}
});

test('a disconnected client does not make its unfinished submitted writer look drained',async()=>{
  let arrived,finish;
  const started=new Promise(resolve=>arrived=resolve),work=new Promise(resolve=>finish=resolve);
  const old=http.createServer(async(req,res)=>{for await(const chunk of req){}arrived();await work;res.end('committed');});
  const oldURL=await listen(old),r=createRolloutServer({upstream:oldURL,startActive:()=>oldURL}),url=await listen(r.server);
  try{
    const controller=new AbortController(),request=fetch(url,{method:'POST',body:'original-key',signal:controller.signal}).catch(()=>null);
    await started;controller.abort();await request;await new Promise(resolve=>setTimeout(resolve,30));r.hold();
    assert.equal(r.state().forwarding,1);await assert.rejects(r.activate(),/not drained/);
    finish();for(let i=0;r.state().forwarding&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(r.state().forwarding,0);await r.activate();
  }finally{finish();await r.close();await close(old);}
});

test('a short drain race resumes held reads and writes on the original owner exactly once',async()=>{
  const bodies=[],old=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;bodies.push(body);res.end('old');});
  const oldURL=await listen(old),r=createRolloutServer({upstream:oldURL,startActive:()=>{throw Error('must not activate');}}),url=await listen(r.server);
  try{
    r.hold();const held=post(url,'same-key');
    for(let i=0;r.state().pending===0&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,5));
    r.resume();assert.deepEqual(await held,{status:200,body:'old'});assert.deepEqual(bodies,['same-key']);
    assert.equal(r.state().phase,'proxy');assert.equal(r.state().pending,0);
  }finally{await r.close();await close(old);}
});
