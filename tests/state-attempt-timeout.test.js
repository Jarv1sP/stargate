import test from 'node:test';
import assert from 'node:assert/strict';
import {apiPost} from '../client-http.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const url='https://portal.example';
function deadlines(t){
 const budgets=[],controllers=[];
 t.mock.method(AbortSignal,'timeout',ms=>{budgets.push(ms);const c=new AbortController();controllers.push(c);return c.signal;});
 return {budgets,controllers};
}
test('a stuck state read exhausts one ten-second deadline without starting a fresh budget',async t=>{
 const d=deadlines(t),started=deferred(),calls=[],delays=[],body={operation:'state',args:{}};
 const pending=apiPost(url,'call',body,{sleep:async ms=>delays.push(ms),fetchImpl:async(target,options)=>{
  calls.push({target,body:options.body,signal:options.signal});started.resolve();
  return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
 }});
 const denied=assert.rejects(pending,e=>e.code==='READ_UNAVAILABLE');await started.promise;
 assert.deepEqual(d.budgets,[10000]);d.controllers[0].abort(new DOMException('Read expired','TimeoutError'));await denied;
 assert.equal(calls.length,1);assert.deepEqual(delays,[]);assert.equal(calls[0].body,JSON.stringify({...body,client:{name:"gpuctl",protocol:2}}));assert.deepEqual(d.budgets,[10000]);
});
test('caller cancellation during a stuck state request never triggers another attempt',async t=>{
 deadlines(t);const controller=new AbortController(),started=deferred();let calls=0,sleeps=0;
 const pending=apiPost(url,'call',{operation:'state',args:{}},{signal:controller.signal,sleep:async()=>{sleeps++;},fetchImpl:async(target,options)=>{
  calls++;started.resolve();return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
 }});
 const reason=Error('caller cancelled'),denied=assert.rejects(pending,e=>e===reason);await started.promise;controller.abort(reason);await denied;
 assert.equal(calls,1);assert.equal(sleeps,0);
});
test('state total deadline is not reset when a later attempt stalls',async t=>{
 const d=deadlines(t),second=deferred();let calls=0,sleeps=0;
 const pending=apiPost(url,'call',{operation:'state'},{sleep:async()=>{sleeps++;},fetchImpl:async(target,options)=>{
  if(++calls===1)return new Response('',{status:503});
  second.resolve();return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
 }});
 const denied=assert.rejects(pending,e=>e.code==='READ_UNAVAILABLE');await second.promise;d.controllers[0].abort(new DOMException('Total timeout','TimeoutError'));await denied;
 assert.equal(calls,2);assert.equal(sleeps,1);assert.equal(d.budgets.filter(x=>x===10000).length,1);
});
test('other reads and mutations retain their original timeout and mutation is sent once',async t=>{
 const d=deadlines(t);let writes=0;
 await apiPost(url,'call',{operation:'data.upload.status'},{fetchImpl:async()=>new Response('{"result":{"state":"READY"}}')});
 await assert.rejects(apiPost(url,'call',{operation:'jobs.submit',args:{key:'original-key'}},{fetchImpl:async()=>{writes++;return new Response('',{status:503});}}),/操作结果尚未确认/);
 assert.deepEqual(d.budgets,[10000,40000]);assert.equal(writes,1);
});
test('real state authorization refusals are not retried',async t=>{
 deadlines(t);
 for(const status of [401,403]){
  let calls=0,sleeps=0;
  await assert.rejects(apiPost(url,'call',{operation:'state'},{sleep:async()=>{sleeps++;},fetchImpl:async()=>{calls++;return new Response('{"error":"Authorization denied"}',{status});}}),e=>e.status===status);
  assert.equal(calls,1);assert.equal(sleeps,0);
 }
});
