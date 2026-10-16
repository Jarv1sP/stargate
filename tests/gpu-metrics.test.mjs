import test from 'node:test';
import assert from 'node:assert/strict';
import {installExecution,schedulerResult,publicJob} from '../execution.mjs';
import {gpuMetricsText} from '../cli.mjs';
import {MACHINES} from '../dist/model.js';

test('node samples survive Portal feedback and jobs details with real zero and unknown kept separate',t=>{
  t.mock.timers.enable({apis:['Date'],now:100000});
  const gpuMetrics={attemptId:'Afixture',sampledAt:100,gpus:[
    {index:0,uuid:'GPU-fixture-0',utilization:0,memoryUsedMiB:0,memoryPeakMiB:512},
    {index:1,uuid:'GPU-fixture-1',utilization:null,memoryUsedMiB:null,memoryPeakMiB:null}]};
  const job={id:'test',userId:'team',spec:{argv:['python','train.py']}};
  schedulerResult(job,{state:'RUNNING',assignedIndices:[0,1],gpuMetrics});
  assert.deepEqual(publicJob(job).gpuMetrics,gpuMetrics);
  assert.equal(gpuMetricsText(job.gpuMetrics),'GPU 0：利用率 0% · 显存 0 MiB · 本次峰值 512 MiB\n  GPU 1：利用率 未知 · 显存 未知 · 本次峰值 未知');
  schedulerResult(job,{state:'UNKNOWN',assignedIndices:null});
  assert.equal(gpuMetricsText(job.gpuMetrics),'GPU 采样：未知');
});

test('an unreachable node cannot leave old samples looking current in jobs details',t=>{
  t.mock.method(Date,'now',()=>200000);
  const job={state:'RUNNING',checkedAt:new Date(200000).toISOString(),schedulerCheckedAt:new Date(100000).toISOString(),spec:{argv:['python','train.py']},gpuMetrics:{sampledAt:1000,gpus:[{index:0,utilization:37,memoryUsedMiB:64,memoryPeakMiB:128}]}};
  const gpu=publicJob(job).gpuMetrics.gpus[0];
  assert.deepEqual(gpu,{index:0,utilization:null,memoryUsedMiB:null,memoryPeakMiB:128});
  assert.equal(job.gpuMetrics.gpus[0].memoryUsedMiB,64);
});

test('fresh node feedback uses the Portal receive time despite node clock skew',t=>{
  t.mock.timers.enable({apis:['Date'],now:200000});
  for(const sampledAt of [1,1000]){
    const gpuMetrics={sampledAt,gpus:[{index:0,utilization:37,memoryUsedMiB:64,memoryPeakMiB:128}]};
    const job={state:'RUNNING',spec:{argv:['python','train.py']}};
    schedulerResult(job,{state:'RUNNING',gpuMetrics});
    assert.deepEqual(publicJob(job).gpuMetrics,gpuMetrics);
    job.schedulerCheckedAt=new Date(175000).toISOString();
    assert.deepEqual(publicJob(job).gpuMetrics,gpuMetrics);
  }
});

test('failed node checks refresh checkedAt without making old GPU samples current',async t=>{
  t.mock.timers.enable({apis:['Date'],now:200000});
  const gpuMetrics={sampledAt:1000,gpus:[{index:0,utilization:37,memoryUsedMiB:64,memoryPeakMiB:128}]};
  const job={id:'metrics',machine:MACHINES[0].id,userId:'team',spec:{argv:['python','train.py']}};
  schedulerResult(job,{state:'RUNNING',gpuMetrics});
  const schedulerCheckedAt=job.schedulerCheckedAt;
  const bridge=t.mock.fn(async()=>{throw Error('node unavailable');});
  const service={store:{jobs:[job]},enqueue:async action=>action(),save(){}};
  installExecution(service,bridge);clearInterval(service.executionTimer);
  for(const elapsed of [15000,31000]){
    t.mock.timers.setTime(200000+elapsed);
    await service.reconcile();
    assert.equal(job.state,'RUNNING');assert.equal(job.error,'node unavailable');
    assert.equal(job.checkedAt,new Date().toISOString());
    assert.equal(job.schedulerCheckedAt,schedulerCheckedAt);
    const gpu=publicJob(job).gpuMetrics.gpus[0];
    assert.equal(gpu.utilization,elapsed>30000?null:37);
    assert.equal(gpu.memoryUsedMiB,elapsed>30000?null:64);
    assert.equal(gpu.memoryPeakMiB,128);
  }
  assert.equal(bridge.mock.callCount(),2);
  assert.deepEqual(job.gpuMetrics,gpuMetrics);
});
