import test from 'node:test';
import assert from 'node:assert/strict';
import {executionCall,schedulerResult,usage} from '../execution.mjs';
import {jobCompletion} from '../job-observation.mjs';
import {MACHINES} from '../dist/model.js';
const machine=MACHINES[0].id,id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',nodeJobId='J0123456789ab';
function fixture(state='FAILED'){
 const user={id:'alice',enabled:true,limits:{},total:0},job={id,key:id,userId:'other-member',machine,nodeJobId,state,cards:1,spec:{id,project:'test'},assignedIndices:[],latestAttempt:null};
 const result={nodeJobId,state:'SUCCEEDED',assignedIndices:[],latestAttempt:{id:'Afinished',ordinal:2,state:'EXITED_SUCCESS',exit_code:0,started_at:10,finished_at:15}},calls=[];
 const service={store:{get:()=>user,jobs:[job]},save(){calls.push(['save']);},audit(){},bridge:async(...args)=>{calls.push(args);return result;}};
 return {user,job,result,calls,service,principal:{userId:user.id,role:'member'}};
}
for(const state of ['SUCCEEDED','FAILED','CANCELED'])test('completion reads actual native '+state+' without proof/identity preflight or changing terminal history',async()=>{
 const f=fixture(),before=structuredClone(f.job);f.result.state=state;const value=await executionCall(f.service,f.principal,'jobs.completion',{jobId:id,ignored:true});
 assert.equal(value.completed,true);assert.equal(value.state,state);assert.equal(value.nativeObservation.status,'CONFIRMED');assert.equal(value.completedAttempt.ordinal,2);assert.equal(value.submission.key,id);assert.deepEqual(f.job,before);assert.equal(usage([f.job],f.job.userId),0);assert.deepEqual(f.calls,[[machine,'watch',{job:f.job.spec}]]);
});
for(const state of ['PENDING','RUNNING','UNKNOWN'])test('native '+state+' is not fabricated as complete and keeps unfinished job quota',()=>{
 const f=fixture('RUNNING');f.result.state=state;assert.equal(jobCompletion(f.job,f.result).completed,false);assert.equal(usage([f.job],f.job.userId),1);
});
test('a known native ID and real terminal observation converge unfinished Portal state once',async()=>{
 const f=fixture('SUBMITTING');delete f.job.nodeJobId;const value=await executionCall(f.service,f.principal,'jobs.completion',{jobId:id});assert.equal(value.completed,true);assert.equal(f.job.state,'SUCCEEDED');assert.equal(f.job.nodeJobId,nodeJobId);assert.equal(f.calls.filter(row=>row[0]==='save').length,1);
});
test('resource cleanup calls only the existing node operation with server-derived actor',async()=>{
 const f=fixture();f.service.bridge=async(host,operation,args)=>{assert.equal(host,machine);assert.equal(operation,'jobs.reconcile-resources');assert.deepEqual(args,{job:f.job.spec,actor:{userId:f.user.id,isAdmin:false}});return {resourcesReleased:true};};assert.equal((await executionCall(f.service,f.principal,'jobs.reconcile-resources',{jobId:id,actor:{isAdmin:true}})).resourcesReleased,true);
});
test('unknown allocation stays unknown, rather than zero cards; confirmed state is not gated by repeated attempt/lease proofs',()=>{
 const f=fixture('RUNNING');schedulerResult(f.job,{state:'UNKNOWN'});assert.equal(f.job.actualCards,null);assert.equal(f.job.assignedIndices,null);assert.equal(usage([f.job],f.job.userId),1);
 assert.equal(jobCompletion(f.job,{state:'SUCCEEDED',nodeJobId}).completed,true);
});
test('login revocation and an absent job reject before a node request',async()=>{
 const f=fixture();f.user.enabled=false;await assert.rejects(executionCall(f.service,f.principal,'jobs.completion',{jobId:id}),e=>e.status===403);f.user.enabled=true;await assert.rejects(executionCall(f.service,f.principal,'jobs.completion',{jobId:'absent'}),e=>e.status===404);assert.deepEqual(f.calls,[]);
});
