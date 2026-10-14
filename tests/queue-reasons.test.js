import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pendingJobReason,executionCall} from '../execution.mjs';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
import {feedbackKey,jobFeedbackText} from '../dist/job-progress.js';
import {workbenchCards} from '../dist/workbench-ui.js';

const machine=MACHINES[0].id,otherMachine=MACHINES[1].id;
const now=Date.parse('2026-10-09T12:00:00Z');
const target=()=>({id:'pending',userId:'member',machine,state:'PENDING',cards:1,
  createdAt:'2026-10-09T11:00:00Z',schedulerPriority:2,queueReason:null,
  spec:{id:'pending',argv:['python','train.py']}});
function fixture(){
  const job=target(),user={id:'member',role:'member',enabled:true,limits:{[machine]:4},total:4};
  const host={id:machine,reachable:true,gpus:[],gpuq:{connected:true,jobs:[]}};
  const service={store:{jobs:[job],get:id=>{assert.equal(id,user.id);return user;}},
    gpuq:{stale:false,checkedAt:new Date(now).toISOString(),hosts:[host]},maintenanceFor:()=>null,
    bridge:()=>assert.fail('reason projection must not call a node'),save:()=>assert.fail('reason projection must not write')};
  return {service,job,user,host,reason:()=>pendingJobReason(service,job,now)};
}
const allCards=()=>Array.from({length:MACHINES[0].cards},(_,i)=>i);
function fill(f){f.host.gpuq.jobs=[{id:'native-running',state:'RUNNING',assigned_gpu_indices:allCards()}];}

test('full GPU leases explain low utilization and count only earlier same-machine queue records',()=>{
  const f=fixture();fill(f);
  f.service.store.jobs.push(
    {...target(),id:'earlier',nodeJobId:'native-earlier',createdAt:'2026-10-09T10:00:00Z'},
    {...target(),id:'later',createdAt:'2026-10-09T11:10:00Z'},
    {...target(),id:'higher-rank',createdAt:'2026-10-09T11:10:00Z',schedulerPriority:4},
    {...target(),id:'lower-rank',createdAt:'2026-10-09T10:00:00Z',schedulerPriority:1},
    {...target(),id:'other-machine',machine:otherMachine,createdAt:'2026-10-09T10:00:00Z'},
    {...target(),id:'canceled',cancelRequested:true,createdAt:'2026-10-09T10:00:00Z'},
  );
  f.host.gpuq.jobs.push(
    {id:'native-earlier',state:'PENDING',priority:2,created_at:now/1000-7200},
    {id:'native-only',state:'PENDING',priority:2,created_at:now/1000-7200},
  );
  assert.equal(f.reason(),`显卡已满（${MACHINES[0].cards}/${MACHINES[0].cards} 张被占用，前面还有 3 个排队）`);
});

test('GPU count is distinct cards, never sum of shared jobs or utilization percent',()=>{
  const f=fixture();f.host.gpuq.jobs=allCards().map((_,i)=>({id:'sharing-'+i,state:'RUNNING',assigned_gpu_indices:[0]}));
  f.host.gpus=allCards().map(index=>({index,utilization:100,memoryUsedMiB:1024,processesAvailable:false}));
  assert.equal(f.reason(),'等待调度器分配，原因未上报');
  f.host.gpus=allCards().map(index=>({index,utilization:0,processesAvailable:true,processes:[{pid:10+index}]}));
  assert.match(f.reason(),/^显卡已满/);
});

test('expired, disconnected and incomplete GPU observations cannot claim full occupancy',()=>{
  for(const change of [f=>{f.service.gpuq.stale=true;},f=>{f.service.gpuq.checkedAt=new Date(now-181000).toISOString();},f=>{f.host.reachable=false;},f=>{f.host.gpuq.connected=false;},f=>{f.host.gpuq.jobs[0].assigned_gpu_indices=[0,1];}]){
    const f=fixture();fill(f);change(f);assert.equal(f.reason(),'等待调度器分配，原因未上报');
  }
});

test('shared tasks can use occupied cards; an unreported sharing-person cap is never invented',()=>{
  const f=fixture();fill(f);f.job.placement={shared:true,gpuIndices:[0],vramMiB:512};
  assert.equal(f.reason(),'等待调度器分配，原因未上报');
  f.job.queueReason='GPU 0 当前共享人数已达上限';assert.equal(f.reason(),f.job.queueReason);
  f.job.queueReason=null;f.job.nodeJobId='native-shared';
  f.host.gpuq.jobs.push({id:'native-shared',state:'PENDING',state_reason:'GPU 0 当前共享人数已达上限'});
  assert.equal(f.reason(),'GPU 0 当前共享人数已达上限');
});

test('derived priority is GPU fullness, maintenance, then personal quota; legacy preparation is not a new gate',()=>{
  const f=fixture();fill(f);f.job.dataPreparation={datasets:[{state:'PREPARING'}]};f.service.maintenanceFor=()=>({reason:'维护'});
  f.service.store.jobs.push({...target(),id:'quota-holder',state:'RUNNING',cards:4});
  assert.match(f.reason(),/^显卡已满/);
  f.host.gpuq.jobs=[];assert.equal(f.reason(),'机器维护中');
  delete f.job.dataPreparation;assert.equal(f.reason(),'机器维护中');
  f.service.maintenanceFor=()=>null;assert.equal(f.reason(),'配额已满（本人在该机已用 4/4 张）');
});

test('preparation and exact selected/global maintenance are displayed without another machine leaking into it',()=>{
  const f=fixture();f.job.state='PREPARING_DATA';f.job.queueReason='等待数据就绪（自动重查中）';assert.equal(f.reason(),f.job.queueReason);
  f.job.state='PENDING';f.job.queueReason=null;f.service.maintenanceFor=id=>id===otherMachine?{reason:'other'}:null;
  assert.equal(f.reason(),'等待调度器分配，原因未上报');
  f.service.maintenanceFor=()=>({scope:'all'});assert.equal(f.reason(),'机器维护中');
});

test('quota respects admin exemption, excludes the job itself and does not expose another member',()=>{
  const f=fixture();f.user.limits[machine]=1;
  assert.equal(f.reason(),'等待调度器分配，原因未上报');
  f.service.store.jobs.push({...target(),id:'other-owner',userId:'secret-member',state:'RUNNING',cards:8});
  assert.equal(f.reason(),'等待调度器分配，原因未上报');
  f.service.store.jobs.push({...target(),id:'own-running',state:'RUNNING',cards:1});
  assert.equal(f.reason(),'配额已满（本人在该机已用 1/1 张）');
  f.user.role='admin';assert.equal(f.reason(),'等待调度器分配，原因未上报');
});

test('node reasons, running/terminal history and canceling jobs remain unchanged',()=>{
  const f=fixture();fill(f);f.job.queueReason='节点确认的存储等待';assert.equal(f.reason(),f.job.queueReason);
  for(const state of ['RUNNING','STARTING','SUCCEEDED','FAILED','CANCELED','UNKNOWN']){
    f.job.state=state;f.job.queueReason=null;assert.equal(f.reason(),null);
  }
  f.job.state='PENDING';f.job.cancelRequested=true;assert.equal(f.reason(),null);
});

test('reason is a read-only projection and never changes lifecycle, key, policy or reservations',()=>{
  const f=fixture();fill(f);const before=JSON.stringify({job:f.job,jobs:f.service.store.jobs,gpuq:f.service.gpuq});
  assert.match(f.reason(),/^显卡已满/);assert.equal(JSON.stringify({job:f.job,jobs:f.service.store.jobs,gpuq:f.service.gpuq}),before);
});

test('jobs and watch API projections agree without persisting the inferred queue reason',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'queue-reasons-')),status=join(dir,'status'),bootstrap=join(dir,'bootstrap');
  const password='Queue-Reason-Local-Fixture-Only!';
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:[{id:machine,reachable:true,gpus:[],gpuq:{connected:true,jobs:[{id:'running',state:'RUNNING',assigned_gpu_indices:allCards()}]}}]}));
  const calls=[];
  const service=await PortalService.open(join(dir,'db'),bootstrap,status,async(...args)=>{
    calls.push(args);return {state:'PENDING',nodeJobId:'native-pending',queueReason:null,assignedIndices:[]};
  });
  clearInterval(service.executionTimer);t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'queue-member',password})).result;
  await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:2,limits:{[machine]:2}});
  const login=await service.login(member.username,password),job={...target(),userId:member.id,nodeJobId:'native-pending'};
  service.store.jobs.push(job);
  const principal={userId:member.id,username:member.username,role:'member'};
  const list=service.state(principal).jobs.find(row=>row.id===job.id);
  const watch=await executionCall(service,principal,'jobs.watch',{jobId:job.id});
  assert.match(list.queueReason,/显卡已满/);assert.equal(watch.queueReason,list.queueReason);
  assert.equal(job.queueReason,null);assert.equal(job.state,'PENDING');assert.deepEqual(job.spec.argv,['python','train.py']);
  assert.equal(calls.length,1);assert.equal(calls[0][1],'watch');
});

test('web rows and focal card show escaped reasons directly; CLI watch notices reason-only changes',()=>{
  const reason='显卡已满（8/8 张被占用，前面还有 2 个排队）',job={...target(),queueReason:reason,name:'pending'};
  const other={...job,id:'another',name:'another',queueReason:'<script>unsafe</script>'};
  const html=workbenchCards([job,other],{focusId:job.id});
  assert.match(html,/<span class="queue-reason">显卡已满/);assert.match(html,/<span class="queue-reason">&lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.doesNotMatch(html,/<script>/);assert.match(jobFeedbackText(job),new RegExp('排队原因：'+reason.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.notEqual(feedbackKey(job),feedbackKey({...job,queueReason:'等待调度器分配，原因未上报'}));
});
