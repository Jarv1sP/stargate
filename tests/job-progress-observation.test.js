import test from 'node:test';
import assert from 'node:assert/strict';
import {publicJob,schedulerResult,usage} from '../execution.mjs';
import {normalizeProgress,progressText} from '../dist/job-progress.js';
import {trainingReadout,workbenchCards} from '../dist/workbench-ui.js';

const now=Date.parse('2026-10-09T15:50:00Z');
const raw={reported:true,stale:false,heartbeat_age_seconds:1,progress_age_seconds:2,
  snapshot:{sequence:1,phase:'train',epochs_completed:null,epochs_total:null,steps_completed:0,steps_total:2000,
    metrics:{},eta_seconds:null,severity:'info',message:null,updated_at:now/1000-300}};
const fixture=()=>({id:'11111111-1111-4111-8111-111111111111',userId:'fixture-owner',machine:'gpu-1',cards:1,state:'RUNNING',
  spec:{argv:['true']},schedulerCheckedAt:new Date(now-300000).toISOString(),checkedAt:new Date(now-300000).toISOString(),
  progress:normalizeProgress(raw)});

test('old cached progress is explicitly stale without changing its report, durable job or reservation',t=>{
  t.mock.method(Date,'now',()=>now);const job=fixture(),before=structuredClone(job),view=publicJob(job);
  assert.equal(view.state,'RUNNING');assert.equal(view.progress.stale,true);assert.equal(view.progress.observationStale,true);
  assert.equal(view.progressObservation.checkedAt,job.schedulerCheckedAt);assert.equal(view.progressObservation.ageSeconds,300);
  assert.equal(view.progress.progressAgeSeconds,302);assert.equal(view.progress.heartbeatAgeSeconds,301);
  assert.equal(view.progress.snapshot.updatedAt,raw.snapshot.updated_at);assert.equal(view.progress.snapshot.stepsCompleted,0);
  assert.match(progressText(view.progress),/快照.*过期/);assert.doesNotMatch(progressText(view.progress),/训练上报超时/);
  const readout=trainingReadout(view);assert.equal(readout.fresh,false);assert.equal(readout.percent,null);
  assert.match(readout.description,/快照.*过期/);assert.doesNotMatch(workbenchCards([view]),/<progress/);
  assert.deepEqual(job,before);assert.equal(usage([job],job.userId),1);
});

test('failed later control query cannot refresh the old progress observation',t=>{
  t.mock.method(Date,'now',()=>now);const job=fixture();job.checkedAt=new Date(now).toISOString();job.error='node unavailable';
  const view=publicJob(job);assert.equal(view.progress.stale,true);assert.equal(view.progressObservation.ageSeconds,300);
});

test('new authoritative observation clears cache expiry while preserving native stale reports',t=>{
  t.mock.method(Date,'now',()=>now);const job=fixture();schedulerResult(job,{state:'RUNNING',progress:raw});
  assert.equal(job.progressCheckedAt,job.schedulerCheckedAt);
  const at=Date.parse(job.progressCheckedAt);t.mock.method(Date,'now',()=>at+5000);
  const view=publicJob(job);assert.equal(view.progress.observationStale,false);assert.equal(view.progress.stale,false);
  assert.equal(view.progressObservation.ageSeconds,5);assert.equal(view.progress.progressAgeSeconds,7);
  job.progress.stale=true;assert.equal(publicJob(job).progress.stale,true);assert.match(progressText(publicJob(job).progress),/训练上报超时/);
});

test('unknown or implausible clocks are unconfirmed; small future skew does not fabricate age',t=>{
  t.mock.method(Date,'now',()=>now);
  for(const value of [undefined,'invalid',new Date(now+31000).toISOString()]){
    const job=fixture();job.schedulerCheckedAt=value;const view=publicJob(job);
    assert.equal(view.progress.observationStale,true);assert.equal(view.progressObservation.ageSeconds,null);
  }
  const job=fixture();job.schedulerCheckedAt=new Date(now+5000).toISOString();
  assert.equal(publicJob(job).progressObservation.ageSeconds,0);assert.equal(publicJob(job).progress.stale,false);
});

test('additional scalar metrics do not hide the training progress snapshot',()=>{
 const metrics=Object.fromEntries(Array.from({length:40},(_,index)=>['model/block/'+index,index/10]));
 metrics['validation metric with a longer display name than the old arbitrary field cap']=0.7;
 metrics.futureAnnotation={notAScalar:true};
 const value=normalizeProgress({...raw,extraField:true,snapshot:{...raw.snapshot,metrics,extraField:true}});
 assert.equal(value.reported,true);assert.equal(value.snapshot.stepsCompleted,0);assert.equal(value.snapshot.stepsTotal,2000);
 assert.equal(Object.keys(value.snapshot.metrics).length,41);assert.equal(value.snapshot.metrics['validation metric with a longer display name than the old arbitrary field cap'],0.7);
 assert.equal('futureAnnotation' in value.snapshot.metrics,false);assert.match(progressText(value),/0\/2000/);
});
