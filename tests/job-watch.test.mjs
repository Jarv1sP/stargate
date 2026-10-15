import test from 'node:test';
import assert from 'node:assert/strict';
import {watchJob} from '../job-watch.mjs';

test('missing watch state remains unknown and repeats only the original job query',async()=>{
 const calls=[],output=[];
 const code=await watchJob(async(operation,args)=>{
  calls.push({operation,args});return {result:calls.length===1?null:{state:'SUCCEEDED',exitCode:0}};
 },'original-job',{interval:1,json:true,write:line=>output.push(JSON.parse(line))});
 assert.equal(code,0);assert.equal(output[0].state,'UNKNOWN');assert.equal(output.at(-1).state,'SUCCEEDED');
 assert.deepEqual(calls,Array(2).fill({operation:'jobs.watch',args:{jobId:'original-job'}}));
});
test('watch reads task metadata and stops when authentication fails',async()=>{
 assert.equal(await watchJob(async()=>({result:{id:'display-reference',state:'SUCCEEDED',exitCode:0}}),'original-job',{write:()=>{}}),0);
 let calls=0;
 await assert.rejects(watchJob(async()=>{calls++;throw Object.assign(Error('请登录'),{status:401});},'original-job',{write:()=>{}}),{status:401});
 assert.equal(calls,1);
});
