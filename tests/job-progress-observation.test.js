import test from 'node:test';
import assert from 'node:assert/strict';
import {publicJob,schedulerResult} from '../execution.mjs';
import {gpuCardUsage as usage} from '../dist/gpu-allocation.js';
import {normalizeProgress,progressText,progressPercent,remainingTime,remainingText} from '../dist/job-progress.js';
import {trainingReadout,workbenchCards} from '../dist/workbench-ui.js';

const now=Date.parse('2026-10-09T15:50:00Z');
const raw={reported:true,stale:false,heartbeat_age_seconds:1,progress_age_seconds:2,
  snapshot:{sequence:1,phase:'train',epochs_completed:null,epochs_total:null,steps_completed:0,steps_total:2000,
    metrics:{},eta_seconds:null,severity:'info',message:null,updated_at:now/1000-300}};
const fixture=()=>({id:'11111111-1111-4111-8111-111111111111',userId:'fixture-owner',machine:'gpu-1',cards:1,state:'RUNNING',
  spec:{argv:['true']},schedulerCheckedAt:new Date(now-300000).toISOString(),checkedAt:new Date(now-300000).toISOString(),
  progress:normalizeProgress(raw)});

const remainingJob=()=>({state:'RUNNING',latestAttempt:{ordinal:1,startedAt:1000},
  progress:normalizeProgress({...raw,snapshot:{...raw.snapshot,steps_completed:30,steps_total:100,updated_at:1600}})});

test('remaining time prefers SDK ETA, including resumed attempts and zero seconds',()=>{
  const job=remainingJob();job.latestAttempt.ordinal=2;job.progress.snapshot.etaSeconds=1500;
  assert.deepEqual(remainingTime(job),{seconds:1500,source:'reported'});
  assert.equal(remainingText(remainingTime(job)),'预计剩余 25 分钟');
  job.progress.snapshot.etaSeconds=0;
  assert.deepEqual(remainingTime(job),{seconds:0,source:'reported'});
  assert.equal(remainingText(remainingTime(job)),'预计不到 1 分钟');
});

test('remaining time estimates from node elapsed time using the same steps or epochs as percent',()=>{
  const job=remainingJob();job.progress.snapshot.epochsCompleted=1;job.progress.snapshot.epochsTotal=2;
  assert.equal(progressPercent(job.progress),30);
  assert.deepEqual(remainingTime(job),{seconds:1400,source:'estimated'});
  assert.equal(remainingText(remainingTime(job)),'预计剩余 24 分钟（按已用时间估算）');
  job.progress.snapshot.stepsCompleted=null;job.progress.snapshot.stepsTotal=null;
  assert.equal(progressPercent(job.progress),50);
  assert.deepEqual(remainingTime(job),{seconds:600,source:'estimated'});
});

test('remaining time stays unknown for resumed, missing, stale, invalid or terminal progress',()=>{
  const changes=[
    job=>{job.latestAttempt.ordinal=2;},job=>{job.latestAttempt=null;},
    job=>{job.progress.snapshot.stepsCompleted=0;},job=>{job.progress.snapshot.stepsCompleted=100;},
    job=>{job.progress.snapshot.stepsTotal=null;},job=>{job.progress.snapshot.updatedAt=1000;},
    job=>{job.progress.snapshot.updatedAt=900;},job=>{job.progress.snapshot.updatedAt=NaN;},
    job=>{job.latestAttempt.startedAt=null;},job=>{job.latestAttempt.startedAt=Infinity;},
    job=>{job.progress=null;},job=>{job.progress.snapshot=null;},job=>{job.progress.reported=false;},
    job=>{job.progress.error='invalid progress snapshot';job.progress.snapshot.etaSeconds=1500;},
    job=>{job.progress.stale=true;job.progress.snapshot.etaSeconds=1500;},
    ...['SUCCEEDED','FAILED','CANCELED'].map(state=>job=>{job.state=state;job.progress.snapshot.etaSeconds=1500;})
  ];
  for(const change of changes){const job=remainingJob();change(job);assert.equal(remainingTime(job),null);assert.equal(remainingText(remainingTime(job)),'剩余时间未知');}
});

test('remaining time text rounds minutes up and carries full hours',()=>{
  for(const [seconds,text] of [[59,'预计不到 1 分钟'],[60,'预计剩余 1 分钟'],[61,'预计剩余 2 分钟'],
    [3599,'预计剩余 60 分钟'],[3600,'预计剩余 1 小时'],[3700,'预计剩余 1 小时 2 分钟'],
    [7199,'预计剩余 2 小时'],[10800,'预计剩余 3 小时']])assert.equal(remainingText({seconds,source:'reported'}),text);
});

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
