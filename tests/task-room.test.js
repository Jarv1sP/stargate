import test from 'node:test';
import assert from 'node:assert/strict';
import {filterTaskJobs,taskDashboardHTML} from '../dist/task-room-ui.js';
import {workbenchCards} from '../dist/workbench-ui.js';

const jobs=[
  {id:'mine',userId:'alice',ownerId:'bob',machine:'node-a',project:'vision',name:'First Run',state:'RUNNING',cards:1},
  {id:'peer',userId:'bob',ownerId:'bob',machine:'node-a',project:'vision',name:'Peer Run',state:'QUEUED',cards:2},
  {id:'same-slug',userId:'bob',ownerId:'bob',machine:'node-b',project:'vision',name:'Other machine',state:'SUCCEEDED'},
  {id:'same-server',userId:'carol',ownerId:'carol',machine:'node-a',project:'vision',name:'Other container',state:'FAILED'},
];
test('task scopes are views over team jobs and distinguish same-name shared containers',()=>{
  assert.deepEqual(filterTaskJobs(jobs,{scope:'mine',userId:'alice'}).map(j=>j.id),['mine']);
  assert.deepEqual(filterTaskJobs(jobs,{scope:'project',machine:'node-a',project:'vision',ownerId:'bob'}).map(j=>j.id),['mine','peer']);
  assert.deepEqual(filterTaskJobs(jobs,{scope:'project'}),[]);
  assert.equal(filterTaskJobs(jobs,{scope:'all'}).length,4);
  assert.deepEqual(filterTaskJobs(jobs,{scope:'all',search:' PEER '}).map(j=>j.id),['peer']);
  assert.deepEqual(filterTaskJobs(jobs,{scope:'all',state:'FAILED'}).map(j=>j.id),['same-server']);
});
test('task list exposes ended and active tasks together and escapes user content',()=>{
  const html=workbenchCards([...jobs,{...jobs[0],id:'unsafe',name:'<script>unsafe</script>',queueReason:'<img src=x>',state:'QUEUED'}]);
  for(const {id} of jobs)assert.match(html,new RegExp('data-workbench-job="'+id+'"'));
  assert.doesNotMatch(html,/wb-ended|<script>|<img/);
  assert.match(html,/&lt;script&gt;unsafe/);
  assert.match(workbenchCards([]),/data-empty-illustration="falcon9"/);
});
const machines=[{id:'node-a',cards:2}];
const snapshot={stale:false,hosts:[{id:'node-a',reachable:true,gpus:[{index:0,utilization:80,memoryUsedMiB:2048,memoryTotalMiB:8192}]}]};
const running={...jobs[0],assignedIndices:[0],latestAttempt:{startedAt:100}};
test('dashboard uses assigned fresh GPU readings and real attempt time',()=>{
  const html=taskDashboardHTML(running,{snapshot,machines,now:165});
  assert.match(html,/data-task-metric="gpu">80%/);
  assert.match(html,/data-task-metric="vram">2.0 \/ 8.0 GiB/);
  assert.match(html,/data-task-elapsed>01:05/);
  assert.equal((html.match(/<ol class="tl wb-trajectory"[^>]*>(.*?)<\/ol>/s)[1].match(/<li /g)||[]).length,5);
  assert.doesNotMatch(html,/data-task-completion/);
});
test('missing, expired and ended GPU observations remain unknown; only confirmed success marks completion',()=>{
  for(const job of [{...running,assignedIndices:[]},{...running,state:'SUCCEEDED',latestAttempt:{startedAt:100,finishedAt:160}},{...running,state:'FAILED'}]){
    const html=taskDashboardHTML(job,{snapshot,machines,now:165});
    assert.match(html,/data-task-metric="gpu">未知/);
    assert.match(html,/data-task-metric="vram">未知/);
    assert.equal(html.includes('data-task-completion'),job.state==='SUCCEEDED');
  }
  const stale=taskDashboardHTML(running,{snapshot:{...snapshot,stale:true},machines});
  assert.match(stale,/data-task-metric="gpu">未知/);
  const expired=taskDashboardHTML(running,{snapshot:{...snapshot,hosts:[{...snapshot.hosts[0],samplingStale:true}]},machines});
  assert.match(expired,/data-task-metric="gpu">未知/);
  assert.match(taskDashboardHTML({...running,latestAttempt:{}},{snapshot,machines}),/data-task-elapsed>未知/);
});
test('GPU utilization and memory can be known independently and fresh zero is a real reading',()=>{
  const render=gpu=>taskDashboardHTML(running,{snapshot:{...snapshot,hosts:[{...snapshot.hosts[0],gpus:[{index:0,...gpu}]}]},machines});
  const missingMemory=render({utilization:0});
  assert.match(missingMemory,/data-task-metric="gpu">0%/);assert.match(missingMemory,/data-task-metric="vram">未知/);
  const missingUtilization=render({memoryUsedMiB:0,memoryTotalMiB:8192});
  assert.match(missingUtilization,/data-task-metric="gpu">未知/);assert.match(missingUtilization,/data-task-metric="vram">0.0 \/ 8.0 GiB/);
});
