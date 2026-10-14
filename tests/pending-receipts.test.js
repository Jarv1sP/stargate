import test from 'node:test';
import assert from 'node:assert/strict';
import {jobCompletion} from '../job-observation.mjs';
import {pendingJobReason} from '../execution.mjs';
import {MACHINES} from '../dist/model.js';
import {completionHTML,nativeObservationHTML} from '../dist/job-diagnostics-ui.js';

const id='11111111-1111-4111-8111-111111111111',key='22222222-2222-4222-8222-222222222222';
const job=()=>({id,key,digest:'a'.repeat(64),userId:'owner',machine:MACHINES[0].id,
  state:'SUBMITTING',dispatchPending:true,cards:1,spec:{id,userId:'owner',argv:['true']}});

test('a missing node response stays unknown and retains the original job key',()=>{
 for(const state of ['SUBMITTING','PENDING','FAILED','SUCCEEDED','CANCELED','UNKNOWN']){const value={...job(),state},before=structuredClone(value),result=jobCompletion(value);assert.equal(result.state,'UNKNOWN');assert.equal(result.completed,false);assert.equal(result.nativeObservation.status,'UNKNOWN');assert.equal(result.submission.key,key);assert.deepEqual(value,before);assert.match(nativeObservationHTML(result.nativeObservation),/未知/);}
});
test('current node state is shown directly without stored identity or receipt comparisons',()=>{
 for(const state of ['PENDING','RUNNING','SUCCEEDED','FAILED','CANCELED']){const value=job(),result=jobCompletion(value,{state,nodeJobId:'J0123456789ab',extraField:'ignored'});assert.equal(result.state,state);assert.equal(result.completed,['SUCCEEDED','FAILED','CANCELED'].includes(state));assert.equal(result.nativeObservation.state,state);assert.equal(result.submission.key,key);}
});
function queueFixture(){
  const machine=MACHINES[0],now=Date.parse('2026-10-10T12:00:00Z');
  const pending={...job(),state:'PENDING',createdAt:new Date(now).toISOString(),schedulerPriority:2};
  const draining=Array.from({length:machine.cards-2},(_,i)=>({id:'canceled-'+i,machine:machine.id,
    state:'UNKNOWN',cancelRequested:true,assignedIndices:[i],schedulerCheckedAt:new Date(now).toISOString(),
    latestAttempt:{id:'attempt-'+i,state:'DRAINING',finishedAt:null}}));
  const service={store:{jobs:[pending,...draining],get:()=>({id:'owner',role:'admin',enabled:true,limits:{[machine.id]:8}})},
    gpuq:{checkedAt:new Date(now).toISOString(),stale:false,hosts:[{id:machine.id,reachable:true,gpus:[],
      gpuq:{connected:true,jobs:[{id:'running',state:'RUNNING',assigned_gpu_indices:[machine.cards-2,machine.cards-1]}]}}]}};
  return {service,pending,draining,machine,now};
}

test('fresh DRAINING allocations explain full cards even when CUDA process lists are empty',()=>{
  const f=queueFixture(),before=structuredClone(f.service.gpuq),jobs=structuredClone(f.service.store.jobs);
  const reason=pendingJobReason(f.service,f.pending,f.now);
  assert.match(reason,/显卡已满/);assert.match(reason,/等待任务收尾/);
  assert.ok(reason.includes(`${f.draining.length} 张`));
  assert.deepEqual(f.service.gpuq,before);assert.deepEqual(f.service.store.jobs,jobs);
});

test('released, expired and other-machine attempt reports cannot claim DRAINING occupancy',()=>{
  for(const patch of [{assignedIndices:[]},{schedulerCheckedAt:'2026-10-10T11:00:00Z'},
    {machine:MACHINES[1].id},{latestAttempt:{state:'CANCELED',finishedAt:100}}]){
    const f=queueFixture();for(const value of f.draining)Object.assign(value,patch);
    assert.equal(pendingJobReason(f.service,f.pending,f.now),'等待调度器分配，原因未上报');
  }
});
