import test from 'node:test';
import assert from 'node:assert/strict';
import {runCloudFiles} from '../client-cloud-files.mjs';
test('cloud file import uses its real opaque ID and listed size in the directory target',async()=>{
 const calls=[],key='11111111-1111-4111-8111-111111111111';
 const result=await runCloudFiles({machine:'fixture-node',positionals:['data','cloud','download','real-cloud-file_42','file.bin'],options:{dataset:'images',key},stderr:{write(){}},call:async(op,args)=>{calls.push({op,args});return {result:op==='cloud.files.list'?{files:[{id:'real-cloud-file_42',name:'file.bin',size:37,extra:'ignored'}]}:{operationId:key,state:'PENDING'}};}});
 assert.equal(result.operationId,key);assert.deepEqual(calls.map(row=>row.op),['cloud.files.list','cloud.files.download']);assert.deepEqual(calls[1].args,{machine:'fixture-node',key,fileId:'real-cloud-file_42',size:37,path:'file.bin',area:'dataset',dataset:'images'});
});
test('a temporarily missing cloud listing reports retry without starting an unknown-size import',async()=>{
 const calls=[];await assert.rejects(runCloudFiles({machine:'fixture-node',positionals:['data','cloud','download','cloud-id','file.bin'],options:{dataset:'images'},stderr:{write(){}},call:async(op,args)=>{calls.push(op);return {result:{files:null,state:'UNKNOWN'}};}}),/稍后.*重试/);assert.deepEqual(calls,['cloud.files.list']);
});

test('cloud browsing returns real IDs, paths and sizes without aliases',async()=>{
 const listing={files:[{id:'cloud-real-id',path:'/team/data.bin',size:42}]};const calls=[];const value=await runCloudFiles({machine:'fixture-node',positionals:['data','cloud','list'],options:{},call:async(op,args)=>{calls.push({op,args});return {result:listing};}});assert.deepEqual(value.files,listing.files);assert.deepEqual(calls,[{op:'cloud.files.list',args:{machine:'fixture-node'}}]);
});
test('server-to-cloud upload keeps the existing operation and original UUID in a dataset or workspace',async()=>{
 for(const target of [{dataset:'images'},{project:'demo'}]){const calls=[],key='11111111-1111-4111-8111-111111111111';const result=await runCloudFiles({machine:'fixture-node',positionals:['data','cloud','upload','nested/file.bin'],options:{...target,key},stderr:{write(){}},call:async(op,args)=>{calls.push({op,args});return {result:{operationId:key,state:'READY',fileId:'cloud-real-id',path:'/team/file.bin',size:42}};}});assert.deepEqual(calls,[{op:'cloud.files.upload',args:{machine:'fixture-node',key,path:'nested/file.bin',area:target.dataset?'dataset':'code',...target}}]);assert.equal(result.fileId,'cloud-real-id');assert.equal(result.size,42);}
});
