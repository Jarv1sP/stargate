import test from 'node:test';
import assert from 'node:assert/strict';
import {schedulerResult,publicJob} from '../execution.mjs';
import {gpuMetricsText} from '../cli.mjs';

test('node samples survive Portal feedback and jobs details with real zero and unknown kept separate',t=>{
  t.mock.method(Date,'now',()=>100000);
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
  const job={state:'RUNNING',spec:{argv:['python','train.py']},gpuMetrics:{sampledAt:100,gpus:[{index:0,utilization:37,memoryUsedMiB:64,memoryPeakMiB:128}]}};
  const gpu=publicJob(job).gpuMetrics.gpus[0];
  assert.deepEqual(gpu,{index:0,utilization:null,memoryUsedMiB:null,memoryPeakMiB:128});
  assert.equal(job.gpuMetrics.gpus[0].memoryUsedMiB,64);
});
