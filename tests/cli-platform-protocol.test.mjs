import test from 'node:test';
import assert from 'node:assert/strict';
import {apiPost} from '../client-http.mjs';
import {projectDirectoryValue,projectDirectorySelection,taskTable} from '../dist/execution-ui.js';

test('new CLI sends the single protocol-2 platform marker',async()=>{
 const body={operation:'projects.list',args:{machine:'fixture-node',ownerId:'peer'}},requests=[];
 const value=await apiPost('https://portal.example','call',body,{token:'synthetic-token',fetchImpl:async(url,init)=>{
  requests.push(JSON.parse(init.body));assert.equal(init.headers.Authorization,'Bearer synthetic-token');
  return new Response(JSON.stringify({ok:true,result:{projects:[]}}));
 }});
 assert.deepEqual(requests,[{...body,client:{name:'gpuctl',protocol:2}}]);assert.deepEqual(value.result.projects,[]);
 assert.equal(body.client,undefined);
});
test('an upgrade reply prints the provided installer message without another request',async()=>{
 let requests=0;const message='客户端过旧，请升级：curl -fsS https://portal.example/install.sh | sh';
 await assert.rejects(apiPost('https://portal.example','call',{operation:'state',args:{}},{fetchImpl:async()=>{
  requests++;return new Response(JSON.stringify({error:message,code:'CLIENT_UPGRADE_REQUIRED'}),{status:426});
 },sleep:()=>assert.fail('upgrade responses are not retried')}),error=>error.message===message&&error.status===426);
 assert.equal(requests,1);
});
test('same-machine same-slug projects remain separately addressable by ownerId',()=>{
 const entries=['self','peer'].map(ownerId=>({machine:'fixture-node',info:{project:'vision',ownerId,ownerName:ownerId}}));
 const values=entries.map(entry=>projectDirectoryValue(entry,entries,'fixture-node'));
 assert.notEqual(values[0],values[1]);
 for(let i=0;i<2;i++)assert.equal(projectDirectorySelection(values[i],entries,'fixture-node').info.ownerId,entries[i].info.ownerId);
});
test('a logged-in team member sees peer datasets and peer task output actions',()=>{
 const html=taskTable([{id:'peer-job',name:'peer task',userId:'peer',project:'vision',state:'RUNNING'}],{userId:'self'});
 assert.match(html,/data-job-output="peer-job"/);assert.match(html,/data-job-cancel="peer-job"/);
});

test('peer output deletion retries the original key and permits a later fresh delete',async()=>{
 const {deleteJobOutputs}=await import('../dist/job-results-ui.js');
 const calls=[],job={id:'11111111-1111-4111-8111-111111111111',userId:'peer'},store={production:true,principal:{userId:'self'},call:async(op,args)=>{calls.push({op,args});if(calls.length===1)throw Error('reply lost');return {state:'TRASHED'};}};
 await assert.rejects(deleteJobOutputs(store,job),/reply lost/);
 await deleteJobOutputs(store,job);assert.equal(calls[0].args.key,calls[1].args.key);assert.equal(calls[1].args.jobId,job.id);
 await deleteJobOutputs(store,job);assert.notEqual(calls[1].args.key,calls[2].args.key);
});
test('shared component policies ignore new metadata fields while retaining resource bounds',async()=>{
 const {schedulingPolicy}=await import('../dist/scheduling-policy.js');
 const {elasticAllocation,gpuPlacement}=await import('../dist/gpu-allocation.js');
 assert.deepEqual(schedulingPolicy({rank:'P4',futureField:true}),{rank:'P4',yieldPolicy:'never',restartPolicy:'never',checkpointable:false});
 assert.equal(elasticAllocation({minCards:1,globalBatch:8,microBatch:1,futureField:true},2).allowed.length,2);
 assert.deepEqual(gpuPlacement({gpuIndices:[0],futureField:true},1),{gpuIndices:[0],shared:false});
 assert.throws(()=>gpuPlacement({gpuIndices:[0,0]},2),/显卡编号/);
});
