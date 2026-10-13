import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {nativeJobRequest,nativeJobSpec,nativeTaskPresentation} from '../native-task-metadata.mjs';
import {schedulerResult} from '../execution.mjs';
const job={id:'UUID',machine:'gpu-1',userId:'demo-user-8',username:'刘鹏亮',submitterName:'刘鹏亮',
  name:'fashion-hm-teachers0-20261003',description:'任务说明',spec:{id:'UUID',userId:'demo-user-8',username:'刘鹏亮',name:'fashion-hm-teachers0-20261003'}};
function service(caps=['console-task-display-v1']){
  return {store:{users:[{id:job.userId,username:job.username,name:'后改姓名'}]},gpuq:{stale:false,hosts:[{id:'gpu-1',reachable:true,gpuq:{connected:true,capabilities:caps}}]}};
}
test('native-only presentation returns bounded labels, never submitter or unknown metadata fields',()=>{
  const display={name:'机械臂｜中文训练',description:'只读展示\n不改变调度',submitter:{name:'张三',username:'alice'}};
  const before=structuredClone(display);
  assert.deepEqual(nativeTaskPresentation(display),{name:display.name,description:display.description});assert.deepEqual(display,before);
  for(const broken of [null,[],{}, {...display,secret:'PRIVATE'},{...display,name:'x'.repeat(65)},
    {...display,description:'\u009b2J'},{...display,submitter:{...display.submitter,username:null}},
    {...display,submitter:{...display.submitter,username:''}},{...display,submitter:{...display.submitter,username:'x'.repeat(25)}},
    {...display,submitter:{...display.submitter,username:'\ud800'}},{...display,submitter:{...display.submitter,username:'a\u202eb'}},
    {...display,submitter:{...display.submitter,name:'x'.repeat(33)}},{...display,submitter:{...display.submitter,userId:'forged'}}])assert.equal(nativeTaskPresentation(broken),null);
});
test('new node envelope carries real names beside, NEVER inside, old immutable execution spec',()=>{
  const request=nativeJobRequest(service(),job);assert.equal(request.job,job.spec);
  assert.deepEqual(request.metadata,{name:job.name,description:'任务说明',submitter:{name:'刘鹏亮',username:'刘鹏亮'}});
  assert.equal(request.job.submitterName,undefined);assert.equal(request.job.description,undefined);
  assert.deepEqual(nativeJobRequest(service(),{...job,submitterName:undefined}).metadata.submitter,{name:'后改姓名',username:'刘鹏亮'});
});
test('historical holds supply the original native spec without changing user intent or presentation',()=>{
  const task=structuredClone(job),logical={dataset:'images',version:'a'.repeat(64)},physical={...logical,dataset:'images-replica'};
  task.spec.datasets=[logical];task.dataPreparationHold={state:'RELEASED',spec:{...structuredClone(task.spec),datasets:[physical]}};
  const before=structuredClone(task),request=nativeJobRequest(service(),task);
  assert.equal(nativeJobSpec(task),task.dataPreparationHold.spec);assert.equal(request.job,task.dataPreparationHold.spec);
  assert.equal(request.metadata.name,task.name);assert.deepEqual(task,before);
  assert.equal(nativeJobSpec(job),job.spec);assert.equal(nativeJobRequest(service(),job).job,job.spec);
});
test('old, native-only, unreachable and stale nodes receive their EXACT legacy request',()=>{
  for(const caps of [[],['job-display-v1']])assert.deepEqual(nativeJobRequest(service(caps),job),{job:job.spec});
  const s=service();s.gpuq.stale=true;assert.deepEqual(nativeJobRequest(s,job),{job:job.spec});
  s.gpuq.stale=false;s.gpuq.hosts[0].reachable=false;assert.deepEqual(nativeJobRequest(s,job,{priority:'P2'}),{job:job.spec,priority:'P2'});
});
test('display failure remains advisory and never manufactures training failure or frees cards',()=>{
  const task={id:'UUID',state:'RUNNING'};schedulerResult(task,{state:'RUNNING',assignedIndices:[0,1],displaySync:{state:'UNAVAILABLE',error:'labels unconfirmed'}});
  assert.equal(task.state,'RUNNING');assert.equal(task.actualCards,2);assert.equal(task.error,null);assert.equal(task.nativeDisplay.state,'UNAVAILABLE');
});
test('preserved native labels update presentation only, and never re-enter the immutable sync envelope',()=>{
  const task=structuredClone(job),spec=structuredClone(task.spec),display={name:'新的中文任务名',description:'节点正规修改',submitter:{name:'刘鹏亮',username:'刘鹏亮'}};
  schedulerResult(task,{nodeJobId:'Jabcdef123456',state:'RUNNING',assignedIndices:[0],displaySync:{state:'PRESERVED',metadata:display}});
  assert.deepEqual(task.nativeTaskDisplay,display);assert.deepEqual(task.spec,spec);assert.equal(task.name,job.name);
  assert.equal(nativeJobRequest(service(),task).metadata.name,job.name);
  const previous=structuredClone(task.nativeTaskDisplay);
  schedulerResult(task,{state:'RUNNING',displaySync:{state:'PRESERVED',metadata:{...display,submitter:{...display.submitter,username:'other'}}}});
  assert.deepEqual(task.nativeTaskDisplay,previous);assert.equal(task.state,'RUNNING');
  schedulerResult(task,{state:'RUNNING',displaySync:{state:'SYNCED'}});
  assert.equal(task.nativeTaskDisplay,undefined);assert.deepEqual(task.spec,spec);assert.equal(task.name,job.name);
});
test('all deployment/runtime paths include metadata helper; no secret source added to browser assets',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../deploy/node-runtime.json',import.meta.url)));assert.ok(manifest.dependencies.includes('task-display.py'));
  assert.match(await readFile(new URL('../deploy/Dockerfile',import.meta.url),'utf8'),/COPY[^\n]*native-task-metadata\.mjs/);
});
