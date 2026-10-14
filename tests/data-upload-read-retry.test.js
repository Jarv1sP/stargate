import test from 'node:test';
import assert from 'node:assert/strict';
import {apiPost} from '../client-http.mjs';
const origin='https://portal.example',id='11111111-1111-4111-8111-111111111111';
const operations=['data.upload.status'];

test('upload reads recover network interruptions with the same original identity and at most two backoffs',async()=>{
  for(const operation of operations){
    const body={operation,args:{machine:'gpu-1',uploadId:id,key:id}},calls=[],delays=[];
    const result=await apiPost(origin,'call',body,{token:'opaque-fixture-token',sleep:async ms=>{delays.push(ms);},fetchImpl:async(target,options)=>{
      calls.push({target:String(target),body:options.body,authorization:options.headers.Authorization});
      if(calls.length<=2)throw new TypeError('fetch failed');return new Response('{"result":{"uploadId":"'+id+'","state":"UPLOADING"}}');
    }});
    assert.equal(result.result.uploadId,id);assert.equal(calls.length,3);assert.deepEqual(delays,[200,600]);
    assert.ok(calls.every(c=>c.body===JSON.stringify({...body,client:{name:'gpuctl',protocol:2}})&&c.authorization==='Bearer opaque-fixture-token'&&c.target===origin+'/api/call'));
  }
});

test('persistent network failure stops after two retries and does not allocate or change a UUID',async()=>{
  for(const operation of operations){let count=0;const delays=[];
    await assert.rejects(apiPost(origin,'call',{operation,args:{uploadId:id}},{sleep:async ms=>delays.push(ms),fetchImpl:async()=>{count++;throw Error('private-detail-not-for-output');}}),error=>error.code==='READ_UNAVAILABLE'&&!error.message.includes('private-detail'));
    assert.equal(count,3);assert.equal(delays.length,2);
  }
});

test('authoritative absent admission and authorization/identity failures are never retried',async()=>{
  for(const [status,code] of [[404,'DATASET_ADMISSION_ABSENT'],[400,'MISMATCH'],[401,'UNAUTHORIZED'],[403,'FORBIDDEN'],[409,'MISMATCH']]){
    let count=0;
    await assert.rejects(apiPost(origin,'call',{operation:'data.upload.status',args:{key:id}},{token:'authenticated-fixture',sleep:async()=>assert.fail('unsafe retry'),fetchImpl:async()=>{count++;return new Response(JSON.stringify({error:'original identity rejected',code}),{status});}}),error=>error.status===status);
    assert.equal(count,1);
  }
});

test('upload mutations including ticket issuance are not replayed and caller cancellation stops retries',async()=>{
  for(const operation of ['data.upload.begin','data.upload.chunk','data.upload.finish','data.upload.cancel','files.direct-ticket']){
    let count=0;await assert.rejects(apiPost(origin,'call',{operation,args:{uploadId:id}},{sleep:async()=>assert.fail('mutation replay'),fetchImpl:async()=>{count++;throw Error('network stopped');}}),/操作结果尚未确认/);assert.equal(count,1);
  }
  const controller=new AbortController();let count=0;
  await assert.rejects(apiPost(origin,'call',{operation:'data.upload.status',args:{uploadId:id}},{signal:controller.signal,
    fetchImpl:async()=>{count++;throw Error('network stopped');},sleep:async(_ms,signal)=>{controller.abort(Error('user stopped'));signal.throwIfAborted();}}),/user stopped/);
  assert.equal(count,1);
});

test('dataset upload status retries only a bounded explicit metadata-lock busy with the same UUID',async()=>{
  const body={operation:'data.upload.status',args:{machine:'gpu-1',uploadId:id}},calls=[],waits=[];
  const result=await apiPost(origin,'call',body,{sleep:async ms=>waits.push(ms),fetchImpl:async(_url,options)=>{
    calls.push(options.body);
    return calls.length<3?new Response(JSON.stringify({error:'[Errno 11] Resource temporarily unavailable'}),{status:400}):new Response(JSON.stringify({result:{uploadId:id,state:'UPLOADING'}}));
  }});
  assert.equal(result.result.uploadId,id);assert.deepEqual(waits,[200,600]);assert.equal(calls.length,3);
  assert.ok(calls.every(value=>value===JSON.stringify({...body,client:{name:'gpuctl',protocol:2}})));
  let count=0;await assert.rejects(apiPost(origin,'call',body,{sleep:async()=>{},fetchImpl:async()=>{count++;return new Response(JSON.stringify({error:'[Errno 11] Resource temporarily unavailable'}),{status:400});}}),error=>error.status===400);
  assert.equal(count,3,'a persistent lock never causes an unlimited loop');
});

test('metadata-lock wording cannot replay a mutation or retry a different status error',async()=>{
  for(const [operation,message] of [['data.upload.begin','[Errno 11] Resource temporarily unavailable'],['data.upload.finish','[Errno 11] Resource temporarily unavailable'],['files.direct-ticket','[Errno 11] Resource temporarily unavailable'],['data.upload.status','original manifest mismatch']]){
    let count=0;await assert.rejects(apiPost(origin,'call',{operation,args:{uploadId:id}},{sleep:async()=>assert.fail('must not retry'),fetchImpl:async()=>{count++;return new Response(JSON.stringify({error:message}),{status:400});}}),error=>error.status===400);assert.equal(count,1);
  }
});
