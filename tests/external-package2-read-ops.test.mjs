import test from 'node:test';
import assert from 'node:assert/strict';
import {apiPost} from '../client-http.mjs';
test('external direct-storage reads keep the existing short retry budget and fixed request',async()=>{
 for(const [operation,args] of [['datasets.list',{machine:'fixture-node'}],['transfers.status',{id:'11111111-1111-4111-8111-111111111111'}],['data.upload.status',{machine:'fixture-node',key:'11111111-1111-4111-8111-111111111111'}]]){
  const calls=[],body={operation,args};
  const result=await apiPost('https://portal.example.test','call',body,{sleep:async()=>{},fetchImpl:async(url,options)=>{
   calls.push({url:String(url),body:options.body,signal:options.signal});
   return {status:calls.length===1?503:200,ok:calls.length!==1,json:async()=>calls.length===1?{error:'temporarily busy'}:{result:{state:'READY'}}};
  }});
  assert.equal(result.result.state,'READY');assert.equal(calls.length,2);assert.equal(calls[0].body,JSON.stringify({...body,client:{name:"gpuctl",protocol:2}}));assert.deepEqual(calls[1],calls[0]);
 }
 let writes=0;await assert.rejects(apiPost('https://portal.example.test','call',{operation:'data.upload.chunk',args:{}},{sleep:async()=>assert.fail('mutation must not retry'),fetchImpl:async()=>{writes++;return {status:503,ok:false,json:async()=>({error:'temporary'})};}}));assert.equal(writes,1);
});
