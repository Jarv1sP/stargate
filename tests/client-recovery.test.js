import test from 'node:test';
import assert from 'node:assert/strict';
import {apiPost,recoverOriginalWrite} from '../client-http.mjs';
import {submitJobWithReceipt} from '../client-state.mjs';

const principal={userId:'fixture-owner'},key='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const lost=()=>Object.assign(Error('reply lost'),{status:503});
const request=(operation,options={},args={})=>apiPost('https://fixture.invalid','call',{operation,args},options);
const response=(status,value)=>({status,ok:status>=200&&status<300,json:async()=>value});

for(const operation of ['projects.status','terminal.status','datasets.list','data.upload.status','files.list','state','jobs.watch']){
 test(`${operation}: retries transient reads only and keeps the exact request`,async()=>{
  const sent=[],delays=[];
  const out=await request(operation,{sleep:async ms=>delays.push(ms),fetchImpl:async(url,options)=>{
   sent.push({url:String(url),body:options.body,authorization:options.headers.Authorization});
   if(sent.length===1)throw Object.assign(Error('retired socket'),{code:'ECONNRESET'});
   return response(sent.length===2?503:200,sent.length===2?{error:'节点操作结果未确认，不会自动重试'}:{result:{state:'READY'}});
  }},{machine:'fixture-machine',id});
  assert.equal(out.result.state,'READY');assert.equal(sent.length,3);assert.deepEqual(sent,[sent[0],sent[0],sent[0]]);assert.deepEqual(delays,[1000,2000]);
 });
}
test('exhausted or busy reads say temporarily unavailable, never unconfirmed',async()=>{
 for(const status of [400,429,502,503,504]){
  let calls=0,elapsed=0;
  await assert.rejects(request('projects.status',{now:()=>elapsed,sleep:async ms=>{elapsed+=ms;},fetchImpl:async()=>{calls++;return response(status,{code:'RPC_BUSY',error:'节点操作结果未确认，不会自动重试'});}}),failure=>{
   assert.equal(failure.code,'READ_UNAVAILABLE');assert.match(failure.message,/暂时无法读取，请稍后再查/);assert.doesNotMatch(failure.message,/未确认|不会自动重试/);return true;
  });assert.equal(calls,7);assert.equal(elapsed,60000);
 }
});
test('read retries share one minute; writes retain a single 40s deadline',async t=>{
 const budgets=[];t.mock.method(AbortSignal,'timeout',ms=>{budgets.push(ms);return new AbortController().signal;});
 await request('projects.status',{sleep:async()=>{},fetchImpl:async()=>response(200,{result:{}})});
 assert.deepEqual(budgets,[60000]);budgets.length=0;
 for(const operation of ['jobs.submit','projects.create']){
  let calls=0;await assert.rejects(request(operation,{sleep:async()=>assert.fail('raw write retry'),fetchImpl:async()=>{calls++;return response(503,{error:'busy'});}}));assert.equal(calls,1);
 }
 assert.deepEqual(budgets,[40000,40000]);
});
test('an unconfirmed job-completion observation is data, not a transport failure',async()=>{
 let calls=0;const row={state:'UNCONFIRMED',completed:false};
 const out=await request('jobs.completion',{sleep:async()=>assert.fail('completion observation retry'),fetchImpl:async()=>{calls++;return response(200,{result:row});}});
 assert.deepEqual(out.result,row);assert.equal(calls,1);
});
test('authentication, validation and explicit caller abort never retry',async()=>{
 for(const status of [400,401,403,409]){
  let calls=0;await assert.rejects(request('projects.status',{sleep:async()=>assert.fail('refusal retry'),fetchImpl:async()=>{calls++;return response(status,{error:'explicit refusal'});}}),failure=>failure.status===status);assert.equal(calls,1);
 }
 const controller=new AbortController(),original=Error('caller canceled');controller.abort(original);
 await assert.rejects(request('state',{signal:controller.signal,fetchImpl:async()=>{throw original;}}),failure=>failure===original);
});
test('lost response recovers a late success without repeating the mutation',async()=>{
 let writes=0,reads=0;const receipt={key,state:'READY'};
 const out=await recoverOriginalWrite(async()=>{writes++;throw lost();},{query:async()=>{reads++;return receipt;},classify:value=>({value})});
 assert.equal(out,receipt);assert.equal(writes,1);assert.equal(reads,1);
});
test('a temporary original-receipt query failure retries only that read, never the write',async()=>{
 let writes=0,reads=0;const delays=[],receipt={key,state:'READY'};
 const out=await recoverOriginalWrite(async()=>{writes++;throw lost();},{
  query:async()=>{reads++;if(reads===1)throw Object.assign(Error('read lane busy'),{status:503});return receipt;},
  classify:value=>({value}),sleep:async ms=>delays.push(ms)
 });assert.equal(out,receipt);assert.equal(writes,1);assert.equal(reads,2);assert.deepEqual(delays,[200]);
});
test('an exhausted HTTP read budget is not restarted by receipt recovery',async()=>{
 let writes=0,reads=0;
 await assert.rejects(recoverOriginalWrite(async()=>{writes++;throw lost();},{
  query:async()=>{reads++;throw Object.assign(Error('read exhausted'),{status:503,code:'READ_UNAVAILABLE'});},
  classify:()=>assert.fail('no receipt'),sleep:async()=>assert.fail('nested HTTP retry')
 }));assert.equal(writes,1);assert.equal(reads,1);
});
test('deduplicated writes retry exactly the original key once after proven absence',async()=>{
 let writes=0,reads=0;const ledger=new Map(),fixed={key,payload:'fixed'};
 const out=await recoverOriginalWrite(async()=>{
  writes++;assert.deepEqual(fixed,{key,payload:'fixed'});
  if(writes===1)throw lost();ledger.set(key,{key,state:'READY'});throw lost();
 },{query:async()=>{reads++;return ledger.get(key)||{state:'ABSENT'};},classify:row=>row.state==='ABSENT'?{absent:true}:{value:row},canReplay:true});
 assert.deepEqual(out,ledger.get(key));assert.equal(writes,2);assert.equal(reads,2);assert.equal(ledger.size,1);
});
test('ambiguous observations and non-deduplicated writes never replay',async()=>{
 for(const observed of [{absent:true},undefined]){
  let writes=0,reads=0;await assert.rejects(recoverOriginalWrite(async()=>{writes++;throw lost();},{query:async()=>{reads++;},classify:()=>observed}));assert.equal(writes,1);assert.equal(reads,1);
 }
 let writes=0;await assert.rejects(recoverOriginalWrite(async()=>{writes++;throw lost();},{query:async()=>({state:'UNKNOWN'}),classify:()=>undefined,canReplay:true}));assert.equal(writes,1);
});
test('submit absence in even a complete state never replays an in-flight original request',async()=>{
 let writes=0;await assert.rejects(submitJobWithReceipt(async op=>{
  if(op==='jobs.submit'){writes++;throw lost();}return {principal,state:{jobs:[],jobsTruncated:false}};
 },{key},principal),failure=>failure.message.includes(key));assert.equal(writes,1);
});
