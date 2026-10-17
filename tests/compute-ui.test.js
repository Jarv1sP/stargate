import test from 'node:test';
import assert from 'node:assert/strict';
import {resourceCards} from '../dist/resources-ui.js';

const machine={id:'fixture-node-a',cards:2,model:'Example GPU'};
const gpu=(index,overrides={})=>({index,utilization:75,memoryUsedMiB:4096,memoryTotalMiB:8192,temperatureC:42,processesAvailable:true,processes:[],...overrides});
function render({gpus=[gpu(0),gpu(1)],disks=[],host={},metricMode='memory',...options}={}){
  return resourceCards({machines:[machine],production:true,userId:'member-a',jobs:[{id:'mine',userId:'member-a'}],metricMode,
    snapshot:{stale:false,hosts:[{id:machine.id,reachable:true,checkedAt:'2026-10-15T18:00:00Z',gpuq:{connected:true},tasks:[],gpus,disks,...host}]},...options});
}

const progressJob=()=>({id:'peer-job',name:'训练 <demo>',userId:'member-b',state:'RUNNING',latestAttempt:{ordinal:1,startedAt:1000},
  progress:{reported:true,stale:false,error:null,snapshot:{phase:'train',stepsCompleted:30,stepsTotal:100,
    epochsCompleted:null,epochsTotal:null,etaSeconds:1500,updatedAt:1600,severity:'info',message:null}}});
const progressTable=(job,options={})=>render({jobs:[job],gpus:[gpu(0,{processes:[{pid:101,memoryUsedMiB:1024,
  task:{source:'portal',id:job.id,name:job.name}}]}),gpu(1)],...options});

test('GPU process progress shows another member task and reported or estimated remaining time',()=>{
  for(const admin of [false,true]){
    const job=progressJob(),html=progressTable(job,{admin});
    assert.match(html,/<progress max="100" value="30" aria-label="训练 &lt;demo&gt; 的训练进度">30%<\/progress>/);
    assert.match(html,/30% · 预计剩余 25 分钟/);assert.doesNotMatch(html.match(/<div class="resource-process-progress">.*?<\/div>/)[0],/估算/);
    job.progress.snapshot.etaSeconds=null;
    assert.match(progressTable(job,{admin}),/30% · 预计剩余 24 分钟（按已用时间估算）/);
    job.latestAttempt.ordinal=2;
    assert.match(progressTable(job,{admin}),/30% · 剩余时间未知/);
    job.latestAttempt.ordinal=1;job.progress.snapshot.stepsCompleted=0;
    assert.match(progressTable(job,{admin}),/0% · 剩余时间未知/);
  }
});

test('GPU process progress leaves unreported and invalid training unknown',()=>{
  for(const progress of [null,{reported:false},{reported:true,error:'invalid progress snapshot'},
    {reported:true,snapshot:{phase:'train',stepsTotal:null,epochsTotal:null}}]){
    const job=progressJob();job.progress=progress;const html=progressTable(job);
    assert.match(html,/<small class="muted">进度未上报<\/small>/);assert.doesNotMatch(html,/<progress/);
  }
});

test('GPU process stale and expired snapshots show the original explanation without ETA',()=>{
  for(const observationStale of [false,true]){
    const job=progressJob();job.progress.stale=true;job.progress.observationStale=observationStale;
    const before=structuredClone(job),html=progressTable(job);
    assert.match(html,observationStale?/进度快照已过期（节点核验未更新）/:/进度停滞（训练上报超时）/);
    assert.doesNotMatch(html,/预计剩余|<progress/);assert.deepEqual(job,before);
  }
});

test('GPU processes without a live portal task do not gain training progress',()=>{
  for(const task of [undefined,{source:'portal',id:'missing'},{source:'native',id:'peer-job'}]){
    const html=render({jobs:[progressJob()],gpus:[gpu(0,{processes:[{pid:102,task}]}),gpu(1)]});
    assert.doesNotMatch(html,/resource-process-progress|<progress|进度未上报/);
  }
  for(const state of ['SUCCEEDED','FAILED','CANCELED']){
    const html=progressTable({...progressJob(),state});assert.doesNotMatch(html,/resource-process-progress|<progress|进度未上报/);
  }
});
test('metric switch uses separate measured values and never turns unavailable readings into idle',()=>{
  const memory=render(),util=render({metricMode:'utilization'});
  assert.match(memory,/data-resource-level="50"/);assert.match(util,/data-resource-level="75"/);
  const unknown=render({gpus:[gpu(0,{utilization:null}),gpu(1)],metricMode:'utilization'});
  assert.match(unknown,/resource-tower-bar unknown/);
  assert.match(render({host:{samplingStale:true}}),/resource-tower-bar unknown/);
  assert.equal((render({gpus:[gpu(0)]}).match(/resource-tower-bar unknown/g)||[]).length,1,'a missing GPU stays striped while the collected GPU remains visible');
  assert.match(render({gpus:[gpu(0,{processesAvailable:false}),gpu(1)]}),/resource-tower-bar unknown/);
});
test('mixed ownership only paints the memory supported by my process evidence white',()=>{
  const mixed=gpu(0,{processes:[{pid:1,memoryUsedMiB:1024,task:{id:'mine',name:'my task'}},{pid:2,memoryUsedMiB:2048,task:{id:'peer',name:'peer task'}}]});
  assert.match(render({gpus:[mixed,gpu(1)]}),/class="resource-fill-own"[^>]*width="25"/);
  assert.match(render({gpus:[mixed,gpu(1)],metricMode:'utilization'}),/class="resource-fill-own"[^>]*width="0"/);
  assert.match(render({gpus:[gpu(0,{processes:[{task:{id:'mine',name:'my task'}}]}),gpu(1)]}),/class="resource-fill-own"[^>]*width="100"/);
});
test('disks follow observed inventory, merge known filesystems and keep missing samples unknown',()=>{
  const disk={mountPoint:'/fixture/ssd',totalBytes:1024**4,usedBytes:256*1024**3,availableBytes:768*1024**3};
  const single=render({disks:[disk]});assert.equal((single.match(/class="resource-disk /g)||[]).length,1);assert.match(single,/SSD · 工作区与数据集共用/);assert.doesNotMatch(single,/数据集 HDD/);
  assert.equal((render({disks:[disk,{...disk,mountPoint:'/fixture/hdd'}]}).match(/class="resource-disk /g)||[]).length,2);
  assert.equal((render({disks:[{...disk,filesystem:'shared'},{...disk,mountPoint:'/fixture/datasets',filesystem:'shared'}]}).match(/class="resource-disk /g)||[]).length,1);
  const unknown=render({disks:[{mountPoint:'/fixture/ssd',totalBytes:null,usedBytes:null,availableBytes:null}]});assert.match(unknown,/resource-disk unknown/);assert.match(unknown,/可用 未知/);assert.doesNotMatch(unknown,/可用 0/);
  assert.match(render(),/数据盘读数未知/);
  assert.match(render({disks:[{...disk,availableBytes:63*1024**3}]}),/空间不足，低于 64 GiB/);
  assert.doesNotMatch(render({disks:[{...disk,availableBytes:64*1024**3}]}),/空间不足/);
});
test('all cards stay inspectable with no personal quota and selected drawer contains only that card processes',()=>{
  const html=render({gpus:[gpu(0,{processes:[{pid:123,memoryUsedMiB:1024,task:{id:'peer',name:'peer task'}}]}),gpu(1)],selectedGPU:1});
  assert.equal((html.match(/class="resource-tower /g)||[]).length,2);assert.match(html,/data-resource-card="1"/);assert.match(html,/data-resource-gpu="1"/);assert.match(html,/class="resource-gpuline"/);
  assert.doesNotMatch(html.slice(html.indexOf('<section class="resource-detail"')),/peer task/);
  assert.match(render({admin:true,management:true,selectedGPU:0,gpus:[gpu(0,{processes:[{pid:123,name:'python',owner:'fixture-user'}]}),gpu(1)]}),/系统用户/);
  assert.doesNotMatch(render({selectedGPU:0,gpus:[gpu(0,{processes:[{pid:123,name:'python',owner:'fixture-user'}]}),gpu(1)]}),/fixture-user/);
});

test('zero capacity and incomplete disk samples stay unknown without low-space warnings',()=>{
  for(const disk of [{totalBytes:0,usedBytes:0,availableBytes:0},{totalBytes:null,usedBytes:0,availableBytes:0},{totalBytes:1024**4,usedBytes:null,availableBytes:0}]){
    const html=render({disks:[{mountPoint:'/fixture/ssd',...disk}]});
    assert.match(html,/resource-disk unknown/);assert.match(html,/可用 未知/);assert.doesNotMatch(html,/空间不足|可用 0/);
  }
  assert.match(render({disks:[{mountPoint:'/fixture/ssd',totalBytes:1024**4,usedBytes:1024**4,availableBytes:0}]}),/空间不足/,'a genuinely full measured disk still warns');
});
test('compute queue shows only waiting jobs as one row each, with honest empty and missing states',()=>{
  const html=render({host:{tasks:[{id:'q',name:'等待训练',state:'QUEUED',priority:2,gpuCount:2},{id:'r',name:'已运行训练',state:'RUNNING',priority:1,gpuCount:1}]}});
  assert.match(html,/data-resource-queue-row/);assert.match(html,/1\. 等待训练/);assert.match(html,/P2 · 2 张/);assert.doesNotMatch(html,/已运行训练|任务队列与近期记录|本次没有返回任务记录/);
  assert.match(render(),/没有排队，提交即开始。/);
  assert.match(render({host:{samplingStale:true}}),/队列读数未知/);
  assert.doesNotMatch(render({host:{samplingStale:true}}),/提交即开始/);
  assert.match(render({maintenance:{global:{reason:'维护',since:'2026-10-15T18:00:00Z'}}}),/维护中，不接新任务/);
});
test('fleet summary totals free, busy and queued independently and preserves unknown observations',async()=>{
  const {resourceTotals,resourceServerView}=await import('../dist/resources-ui.js');
  const snapshot={stale:false,hosts:[{id:machine.id,reachable:true,gpus:[gpu(0,{processes:[{pid:1}]}),gpu(1)],tasks:[{state:'QUEUED'},{state:'PENDING'},{state:'RUNNING'}]}]};
  const view=resourceServerView(machine,{production:true,snapshot});assert.deepEqual(resourceTotals([view]),{free:1,busy:1,queued:2});
  const partial=resourceServerView(machine,{production:true,snapshot:{...snapshot,hosts:[{...snapshot.hosts[0],gpus:[gpu(0)]}]}});
  assert.deepEqual(resourceTotals([partial]),{free:null,busy:null,queued:null});
  assert.deepEqual(resourceTotals([view,partial]),{free:1,busy:1,queued:2},'an unread server is not counted');
  assert.deepEqual(resourceTotals([resourceServerView(machine)]),{free:null,busy:null,queued:null});
  assert.deepEqual(resourceTotals([]),{free:null,busy:null,queued:null});
});
