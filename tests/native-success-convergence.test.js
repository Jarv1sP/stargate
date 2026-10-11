import test from 'node:test';
import assert from 'node:assert/strict';
import {executionCall,usage} from '../execution.mjs';
import {jobCompletion,terminalNativeObservation} from '../job-observation.mjs';

function fixture(){
  const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',owner={id:'demo-user-1',role:'member',enabled:true,total:1,limits:{'gpu-1':1}};
  const key='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',node='J0123456789ab',attempt='A'+'a'.repeat(32);
  const job={id,key,digest:'b'.repeat(64),userId:owner.id,machine:'gpu-1',cards:1,state:'RUNNING',nodeJobId:node,cancelRequested:false,
    spec:{id,userId:owner.id,project:'research',release:'a'.repeat(64),argv:['train']},
    latestAttempt:{id:attempt,ordinal:1,state:'RUNNING',exitCode:null,startedAt:100,finishedAt:null},assignedIndices:[0],actualCards:1,error:'previous read failed'};
  const raw={protocol:'native-observation-v1',status:'CONFIRMED',jobId:id,userId:owner.id,nodeJobId:node,submitKey:id,specVerified:true,
    state:'SUCCEEDED',nativeVersion:4,observedAt:300,latestRetry:null,
    latestAttempt:{id:attempt,ordinal:1,state:'EXITED_SUCCESS',exit_code:0,failure_reason:null,started_at:100,finished_at:200},progress:null};
  const result={nodeJobId:node,state:'SUCCEEDED',schedulerState:'SUCCEEDED',assignedIndices:[],latestAttempt:raw.latestAttempt,nativeObservation:raw};
  const calls=[];let saves=0;
  const service={store:{get:id=>{assert.equal(id,owner.id);return owner;},jobs:[job]},save(){saves++;},bridge:async(...args)=>{calls.push(args);return result;}};
  return {owner,job,raw,result,calls,service,principal:{userId:owner.id,role:'member'},saves:()=>saves};
}

test('same original live attempt succeeds without a manual divergence or retry event',()=>{
  const f=fixture();
  assert.deepEqual(terminalNativeObservation(f.job,f.raw).manualRecovery,{required:false,reason:null});
  assert.equal(jobCompletion(f.job,f.result).completed,true);
  delete f.job.latestAttempt;
  assert.equal(jobCompletion(f.job,f.result).completed,true,'first success observation needs no invented retry');
});

test('completion converges the original RUNNING lifecycle and releases its Portal reservation using one read',async()=>{
  const f=fixture(),identity=structuredClone({id:f.job.id,key:f.job.key,digest:f.job.digest,spec:f.job.spec});
  const value=await executionCall(f.service,f.principal,'jobs.completion',{jobId:f.job.id});
  assert.equal(value.completed,true);assert.equal(value.state,'SUCCEEDED');assert.equal(value.portalHistory.state,'SUCCEEDED');
  assert.equal(f.job.state,'SUCCEEDED');assert.equal(f.job.schedulerState,'SUCCEEDED');assert.equal(f.job.error,null);
  assert.equal(f.job.latestAttempt.exitCode,0);assert.equal(f.job.latestAttempt.ordinal,1);assert.equal(f.saves(),1);
  assert.equal(usage(f.service.store.jobs,f.owner.id),0);assert.ok(f.job.finishedAt);
  assert.deepEqual({id:f.job.id,key:f.job.key,digest:f.job.digest,spec:f.job.spec},identity);
  assert.deepEqual(f.calls,[['gpu-1','watch',{job:f.job.spec,expectedNodeJobId:f.job.nodeJobId}]]);
});

test('no later mutation of another job and no second save for an already converged success',async()=>{
  const f=fixture(),other={...structuredClone(f.job),id:'cccccccc-cccc-cccc-cccc-cccccccccccc'};
  const before=structuredClone(other);f.service.store.jobs.push(other);
  await executionCall(f.service,f.principal,'jobs.completion',{jobId:f.job.id});
  await executionCall(f.service,f.principal,'jobs.completion',{jobId:f.job.id});
  assert.equal(f.saves(),1);assert.deepEqual(other,before);assert.equal(f.calls.length,2);
});

test('unconfirmed cleanup, live allocation and foreign success evidence cannot converge or issue writes',async()=>{
  for(const patch of [{state:'UNKNOWN',error:'Dataset lease cleanup awaits scheduler reconciliation'},
    {assignedIndices:[0]}, {nativeObservation:{...fixture().raw,userId:'demo-user-2'}},
    {nativeObservation:{...fixture().raw,specVerified:false}}]){
    const f=fixture(),before=structuredClone(f.job);Object.assign(f.result,patch);
    const value=await executionCall(f.service,f.principal,'jobs.completion',{jobId:f.job.id});
    assert.equal(value.completed,false);assert.equal(f.saves(),0);assert.deepEqual(f.job,before);
    assert.deepEqual(f.calls.map(c=>c[1]),['watch']);
  }
});

test('cancellation and revoked access during the read prevent a success lifecycle change',async()=>{
  const f=fixture();f.service.bridge=async()=>{f.job.cancelRequested=true;return f.result;};
  assert.equal((await executionCall(f.service,f.principal,'jobs.completion',{jobId:f.job.id})).completed,false);
  assert.equal(f.job.state,'RUNNING');assert.equal(f.saves(),0);
  const g=fixture();g.service.bridge=async()=>{g.owner.limits={};return g.result;};
  await assert.rejects(executionCall(g.service,g.principal,'jobs.completion',{jobId:g.job.id}),e=>e.status===409);
  assert.equal(g.job.state,'RUNNING');assert.equal(g.saves(),0);
});

test('a failed lifecycle save rolls back success instead of emitting a false completion receipt',async()=>{
  const f=fixture(),before=structuredClone(f.job);f.service.save=()=>{throw Error('database unavailable');};
  await assert.rejects(executionCall(f.service,f.principal,'jobs.completion',{jobId:f.job.id}),/database unavailable/);
  assert.deepEqual(f.job,before);assert.deepEqual(f.calls.map(c=>c[1]),['watch']);
});
