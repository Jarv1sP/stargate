import test from 'node:test';
import assert from 'node:assert/strict';
import {apiPost} from '../client-http.mjs';
for(const path of ['call','login','register'])test('CLI '+path+' sends one new-platform marker without mutating the request',async()=>{
 const body=path==='call'?{operation:'state',args:{}}:{username:'fixture',password:'fixture-password'},requests=[];
 await apiPost('https://portal.example',path,body,{fetchImpl:async(url,init)=>{
  requests.push(JSON.parse(init.body));return new Response('{}');
 }});
 assert.deepEqual(requests,[{...body,client:{name:'gpuctl',protocol:2}}]);assert.equal(body.client,undefined);
});
