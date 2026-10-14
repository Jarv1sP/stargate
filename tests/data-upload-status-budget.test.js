import test from 'node:test';
import assert from 'node:assert/strict';
import {apiPost} from '../client-http.mjs';
const operations=['data.upload.status'];
test('each upload observation shares one ten-second total deadline',async t=>{
 const budgets=[],controllers=[];t.mock.method(AbortSignal,'timeout',ms=>{budgets.push(ms);const c=new AbortController();controllers.push(c);return c.signal;});
 for(const operation of operations){
  budgets.length=0;controllers.length=0;let count=0,started;const ready=new Promise(resolve=>started=resolve),delays=[],bodies=[];
  const body={operation,args:{machine:'fixture',uploadId:'11111111-1111-4111-8111-111111111111'}};
  const pending=apiPost('https://portal.invalid','call',body,{sleep:async ms=>delays.push(ms),fetchImpl:async(_url,options)=>{
   bodies.push(options.body);count++;started();return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
  }});
  const denied=assert.rejects(pending,e=>e.code==='READ_UNAVAILABLE');await ready;assert.deepEqual(budgets,[10000]);controllers[0].abort();await denied;
  assert.equal(count,1);assert.deepEqual(delays,[]);assert.deepEqual(bodies,[JSON.stringify({...body,client:{name:'gpuctl',protocol:2}})]);assert.deepEqual(budgets,[10000]);
 }
});
test('upload total deadline remains fixed across retries and interrupts later attempts',async t=>{
 const controllers=[],budgets=[];t.mock.method(AbortSignal,'timeout',ms=>{budgets.push(ms);const c=new AbortController();controllers.push(c);return c.signal;});
 let started,count=0;const ready=new Promise(resolve=>started=resolve);
 const pending=apiPost('https://portal.invalid','call',{operation:'data.upload.status',args:{uploadId:'original'}},{sleep:async()=>{},fetchImpl:async(_url,options)=>{
  if(++count===1)return new Response('',{status:503});started();return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
 }});
 const denied=assert.rejects(pending,e=>e.code==='READ_UNAVAILABLE');await ready;controllers[0].abort();await denied;
 assert.equal(count,2);assert.equal(budgets.filter(ms=>ms===10000).length,1);
});
test('a slow upload read waits for its original server lane after 429 without changing identity',async t=>{
 const controllers=[];t.mock.method(AbortSignal,'timeout',()=>{const c=new AbortController();controllers.push(c);return c.signal;});
 let started,count=0;const ready=new Promise(resolve=>started=resolve),delays=[],bodies=[];
 const body={operation:'data.upload.status',args:{machine:'fixture',uploadId:'11111111-1111-4111-8111-111111111111'}};
 const pending=apiPost('https://portal.invalid','call',body,{sleep:async ms=>delays.push(ms),fetchImpl:async(_url,options)=>{
  bodies.push(options.body);count++;
  if(count===1){started();throw TypeError('transient transport interruption');}
  if(count===2)return new Response('{"error":"Original observation is still active"}',{status:429});
  return new Response('{"result":{"state":"UPLOADING"}}');
 }});
 await ready;assert.equal((await pending).result.state,'UPLOADING');assert.equal(count,3);assert.deepEqual(delays,[200,600]);assert.ok(bodies.every(value=>value===JSON.stringify({...body,client:{name:'gpuctl',protocol:2}})));
 for(const operation of ['data.upload.begin','files.direct-ticket']){
  let attempts=0;await assert.rejects(apiPost('https://portal.invalid','call',{operation},{sleep:async()=>assert.fail('unexpected busy replay'),fetchImpl:async()=>{attempts++;return new Response('{"error":"busy"}',{status:429});}}),error=>error.status===429);assert.equal(attempts,1);
 }
});
