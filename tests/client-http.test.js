import test from 'node:test';
import assert from 'node:assert/strict';
import {apiPost,commandPost} from '../client-http.mjs';
import {DemoClient} from '../dist/client.js';
const url='https://portal.example';
test('all reads in one CLI command share sixty seconds including request and backoff time',async t=>{
 let elapsed=0,calls=0;const budgets=[];
 t.mock.method(AbortSignal,'timeout',ms=>{budgets.push(ms);return new AbortController().signal;});
 const post=commandPost(url,{now:()=>elapsed,sleep:async ms=>{elapsed+=ms;},fetchImpl:async()=>{
  calls++;
  if(calls===1){elapsed+=45000;return new Response('{"state":{}}');}
  return new Response('',{status:503});
 }});
 await post('call',{operation:'state'});
 await assert.rejects(post('call',{operation:'community.announcements.pending'}),e=>e.code==='READ_UNAVAILABLE'&&/暂时无法读取/.test(e.message));
 assert.equal(elapsed,60000);assert.deepEqual(budgets,[60000,15000]);
 const before=calls;
 await assert.rejects(post('call',{operation:'jobs.watch'}),e=>e.code==='READ_UNAVAILABLE');
 assert.equal(calls,before,'an exhausted command must not open another request');
});
test('a hanging response body is aborted at the remaining command deadline',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let elapsed=0;
 // AbortSignal.timeout uses its own timer; connect it to the simulated clock.
 t.mock.method(AbortSignal,'timeout',ms=>{const c=new AbortController();setTimeout(()=>c.abort(new DOMException('timed out','TimeoutError')),ms);return c.signal;});
 const post=commandPost(url,{now:()=>elapsed,fetchImpl:async(url,{signal})=>({status:200,ok:true,json:()=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))})});
 const pending=post('call',{operation:'state'}),rejected=assert.rejects(pending,e=>e.code==='READ_UNAVAILABLE'&&/暂时无法读取/.test(e.message));
 await new Promise(setImmediate);elapsed=60000;t.mock.timers.tick(60000);await rejected;
});
test('slow reads and interactive waits never shorten a write below its original forty seconds',async t=>{
 let elapsed=0;const budgets=[],sent=[];
 t.mock.method(AbortSignal,'timeout',ms=>{budgets.push(ms);return new AbortController().signal;});
 const post=commandPost(url,{now:()=>elapsed,fetchImpl:async(url,options)=>{
  const body=JSON.parse(options.body);sent.push(body);
  if(body.operation==='state')elapsed=59999;
  return new Response('{"result":{}}');
 }});
 await post('call',{operation:'state'});
 for(const operation of ['jobs.submit','projects.retire.purge','users.create','users.reset']){
  elapsed+=120000;
  await post('call',{operation,args:{key:'11111111-1111-4111-8111-111111111111'}});
 }
 assert.deepEqual(budgets,[60000,40000,40000,40000,40000]);assert.equal(sent.length,5);
 await assert.rejects(post('call',{operation:'state'}),e=>e.code==='READ_UNAVAILABLE');
 assert.equal(sent.length,5);
});
test('long transfers and attached sessions retain their existing per-request budget',async t=>{
 let elapsed=0;const budgets=[];
 t.mock.method(AbortSignal,'timeout',ms=>{budgets.push(ms);return new AbortController().signal;});
 const post=commandPost(url,{continuous:true,now:()=>elapsed,fetchImpl:async()=>new Response('{"result":{}}')});
 await post('call',{operation:'data.upload.status'});elapsed=120000;
 await post('call',{operation:'data.upload.status'});
 assert.deepEqual(budgets,[60000,60000]);
});
function fixture(responses){const calls=[];return {calls,options:{sleep:async()=>{},fetchImpl:async(...args)=>{calls.push(args);const item=responses.shift();if(item instanceof Error)throw item;return item;}}};}
test('read-only 502 during deployment retries and returns the actual status result',async()=>{
 const f=fixture([new Response('<html>Bad Gateway</html>',{status:502}),new Response(JSON.stringify({result:{state:'READY'}}))]);
 const result=await apiPost(url,'call',{operation:'datasets.list',args:{dataset:'existing'}},f.options);
 assert.equal(result.result.state,'READY');assert.equal(f.calls.length,2);assert.equal(f.calls[0][1].redirect,'error');
});
test('read-only retries are bounded and preserve HTTP status, never mention a static preview',async()=>{
 const f=fixture(Array.from({length:8},()=>new Response('',{status:502}))),delays=[];let elapsed=0;
 f.options.now=()=>elapsed;f.options.sleep=async ms=>{delays.push(ms);elapsed+=ms;};
 await assert.rejects(apiPost(url,'call',{operation:'state'},f.options),e=>e.status===502&&/HTTP 502/.test(e.message)&&!e.message.includes('preview'));
 assert.equal(f.calls.length,7);assert.deepEqual(delays,[1000,2000,4000,8000,16000,16000,13000]);
 assert.equal(delays.reduce((a,b)=>a+b,0),60000);
});
test('read-only state recovers after 45 seconds inside one minute without changing the request',async t=>{
 const budgets=[];t.mock.method(AbortSignal,'timeout',ms=>{budgets.push(ms);return new AbortController().signal;});
 let elapsed=0;const calls=[],delays=[],body={operation:'state',args:{}};
 const result=await apiPost(url,'call',body,{
  now:()=>elapsed,
  sleep:async ms=>{delays.push(ms);elapsed+=ms;},
  fetchImpl:async(target,options)=>{calls.push({target,body:JSON.parse(options.body)});return elapsed<45000?new Response('',{status:503}):new Response('{"state":{"ready":true}}');}
 });
 assert.deepEqual(result,{state:{ready:true}});assert.deepEqual(budgets,[60000]);assert.equal(calls.length,7);assert.equal(elapsed,47000);
 assert.ok(calls.every(call=>JSON.stringify(call.body)===JSON.stringify({...body,client:{name:'gpuctl',protocol:2}})));
 assert.deepEqual(delays,[1000,2000,4000,8000,16000,16000]);
});
test('state retries two 503 responses then succeeds on the third original request',async()=>{
 const f=fixture([new Response('',{status:503}),new Response('',{status:503}),new Response('{"state":{"ready":true}}')]),delays=[];
 const result=await apiPost(url,'call',{operation:'state',args:{}},{...f.options,sleep:async ms=>delays.push(ms)});
 assert.equal(result.state.ready,true);assert.equal(f.calls.length,3);assert.deepEqual(delays,[1000,2000]);assert.equal(f.calls[0][1].body,f.calls[2][1].body);
});
test('READ_UNAVAILABLE response codes retry reads while permission and missing-path responses remain final',async()=>{
 for(const status of [400,500]){
  const f=fixture([new Response('{"error":"read unavailable","code":"READ_UNAVAILABLE"}',{status}),new Response('{"state":{}}')]);
  await apiPost(url,'call',{operation:'state'},f.options);assert.equal(f.calls.length,2);
 }
 for(const status of [401,403,404]){
  const f=fixture([new Response('{"error":"read unavailable","code":"READ_UNAVAILABLE"}',{status})]);
  await assert.rejects(apiPost(url,'call',{operation:'state'},f.options),error=>error.status===status);assert.equal(f.calls.length,1);
 }
});
test('caller cancellation aborts the backoff and never makes another request',async()=>{
 const controller=new AbortController();let count=0;
 await assert.rejects(apiPost(url,'call',{operation:'state'},{signal:controller.signal,
  fetchImpl:async()=>{count++;return new Response('',{status:502});},
  sleep:async(ms,signal)=>{controller.abort(new Error('user stopped'));signal.throwIfAborted();}
 }),/user stopped/);
 assert.equal(count,1);
});
test('a cancellation during a resolving backoff also preserves the caller reason',async()=>{
 const controller=new AbortController(),original=Error('user stopped after wait');let calls=0;
 await assert.rejects(apiPost(url,'call',{operation:'state'},{signal:controller.signal,
  fetchImpl:async()=>{calls++;return new Response('',{status:503});},sleep:async()=>{controller.abort(original);}
 }),failure=>failure===original);assert.equal(calls,1);
});
test('project upload status retry keeps the exact identity and does not send file bytes',async()=>{
 const body={operation:'data.upload.status',args:{machine:'node-a',project:'code',path:'bundle.tar',totalSize:12,uploadId:'11111111-1111-4111-8111-111111111111'}};
 const f=fixture([new Response('',{status:502}),new Response('{"result":{"state":"UPLOADING","offset":8}}')]);
 const result=await apiPost(url,'call',body,f.options);
 assert.equal(result.result.offset,8);assert.equal(f.calls.length,2);
 assert.deepEqual(JSON.parse(f.calls[0][1].body),{...body,client:{name:'gpuctl',protocol:2}});assert.deepEqual(JSON.parse(f.calls[1][1].body),{...body,client:{name:'gpuctl',protocol:2}});
});
test('unregister and job submission are never replayed on ambiguous gateway failure',async()=>{
 for(const operation of ['datasets.delete','jobs.submit','data.upload.finish','data.upload.chunk','data.upload.cancel','projects.create','storage.refresh','terminal.exchange','login']){
  const f=fixture([new Response('',{status:502})]);
  await assert.rejects(apiPost(url,'call',{operation},f.options),/操作结果尚未确认/);assert.equal(f.calls.length,1);
 }
});
test('upload status and directory listing retry reads without changing the request',async()=>{
 for(const operation of ['data.upload.status','files.list','storage.snapshot']){
  const body={operation,args:{machine:'node-a',project:'code',key:'11111111-1111-4111-8111-111111111111'}};
  const f=fixture([new Response('',{status:502}),new Response('{"result":{}}')]);
  await apiPost(url,'call',body,f.options);assert.equal(f.calls.length,2);
  assert.ok(f.calls.every(call=>JSON.stringify(JSON.parse(call[1].body))===JSON.stringify({...body,client:{name:'gpuctl',protocol:2}})));
 }
});
test('file read gateway retries retain account request, offset and size offset',async()=>{
 const body={operation:'files.get',args:{machine:'node-a',project:'paper',area:'output',runId:'11111111-1111-4111-8111-111111111111',path:'result.bin',offset:1048576}};
 const f=fixture([new Response('',{status:503}),new Response('{"result":{"eof":true}}')]);
 assert.equal((await apiPost(url,'call',body,f.options)).result.eof,true);
 assert.equal(f.calls.length,2);assert.ok(f.calls.every(call=>JSON.stringify(JSON.parse(call[1].body))===JSON.stringify({...body,client:{name:'gpuctl',protocol:2}})));
});
test('malformed successful JSON and 404 are reported accurately without leaking HTML',async()=>{
 for(const status of [200,404]){
  const f=fixture([new Response('<html>private-token-do-not-print</html>',{status})]);
  await assert.rejects(apiPost(url,'call',{operation:'datasets.list'},f.options),e=>e.message.includes('HTTP '+status)&&!e.message.includes('private-token'));
  assert.equal(f.calls.length,1);
 }
});
test('401 JSON error does not retry or lose useful details',async()=>{
 const f=fixture([new Response(JSON.stringify({error:'会话失效'}),{status:401})]);
 await assert.rejects(apiPost(url,'call',{operation:'state'},f.options),/HTTP 401.*会话失效/);assert.equal(f.calls.length,1);
});
test('local permission and path failures are not mistaken for transient fetch failures',async()=>{
 for(const code of ['EACCES','EPERM','ENOENT','ENOTDIR']){
  const failure=Object.assign(Error('local path denied'),{code});let calls=0;
  await assert.rejects(apiPost(url,'call',{operation:'files.get'},{fetchImpl:async()=>{calls++;throw failure;},sleep:()=>assert.fail('permanent error retry')}),error=>error===failure);assert.equal(calls,1);
 }
});
test('connection and response body failures retry reads but not mutations',async()=>{
 for(const fail of [new TypeError('fetch failed'),{status:200,ok:true,json:async()=>{throw new TypeError('terminated');}}]){
  const f=fixture([fail,new Response('{"state":{}}')]);
  await apiPost(url,'call',{operation:'state'},f.options);assert.equal(f.calls.length,2);
  for(const operation of ['datasets.delete','jobs.reconcile-resources']){
   const mutation=fixture([fail]);await assert.rejects(apiPost(url,'call',{operation},mutation.options),/操作结果尚未确认/);assert.equal(mutation.calls.length,1);
  }
 }
});
