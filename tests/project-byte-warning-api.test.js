import test from 'node:test';
import assert from 'node:assert/strict';
import {executionCall} from '../execution.mjs';
import {MACHINES} from '../dist/model.js';
const machine=MACHINES[0].id,key='11111111-1111-4111-8111-111111111111',principal={userId:'demo-user-42',role:'member'},calls=[];
const user={id:principal.userId,enabled:true,limits:{}};
const service={store:{get:()=>user},bridge:async(machine,operation,args)=>{calls.push({machine,operation,args});return {key,state:'UPLOADING',offset:args.offset??0};}};
test('current workspace uploads accept 4/100 GiB byte sizes without content digests or a read-quota gate',async()=>{
 for(const totalSize of [4*1024**3+1,100*1024**3+1]){
  await executionCall(service,principal,'data.upload.begin',{machine,key,area:'code',project:'test',path:'weights.bin',totalSize,sha256:'ignored'});
  assert.equal(calls.at(-1).args.totalSize,totalSize);assert.equal(calls.at(-1).args.sha256,undefined);
 }
});
test('the original upload key keeps exact large offsets and size/offset limits remain',async()=>{
 await executionCall(service,principal,'data.upload.chunk',{machine,key,offset:100*1024**3+1,data:'YQ=='});assert.equal(calls.at(-1).args.offset,100*1024**3+1);
 const count=calls.length;for(const offset of [-1,1.5,Number.MAX_SAFE_INTEGER+1])await assert.rejects(executionCall(service,principal,'data.upload.chunk',{machine,key,offset,data:'YQ=='}),e=>e.status===400);assert.equal(calls.length,count);
});
