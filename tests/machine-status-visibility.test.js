import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {visibleGPUQStatus} from '../gpuq-status.mjs';
import {installJobNotifications} from '../job-notifications.mjs';
import {MACHINES} from '../dist/model.js';
import {resourceCards,resourceServerView,resourceTotals} from '../dist/resources-ui.js';

const [restricted,allowed]=MACHINES;
const principal={userId:'viewer',username:'viewer',role:'member',enabled:true};
const snapshot=()=>({checkedAt:new Date().toISOString(),stale:false,hosts:MACHINES.map(machine=>({
  id:machine.id,reachable:true,checkedAt:new Date().toISOString(),privateHostField:'private-host-detail',
  gpus:Array.from({length:machine.cards},(_,index)=>({index,uuid:'private-gpu-uuid',model:machine.model,
    memoryTotalMiB:32768,memoryUsedMiB:1024,utilization:9,temperatureC:71,processesAvailable:true,
    processes:index?[ ]:[{pid:12345,name:'private-program',owner:'private-owner',memoryUsedMiB:1024,scheduling:{jobId:'J0123456789ab',priority:4}}]})),
  disks:[{mountPoint:'/private-volume',totalBytes:123456}],gpuq:{connected:true,health:'ok',observeOnly:false,
    jobs:[{id:'J0123456789ab',name:'private-task',owner:'private-owner',state:'RUNNING',assigned_gpu_indices:[0]}]}
}))});

test('server grants project anonymous busy GPUs without changing the shared real sample',()=>{
  const raw=snapshot(),before=structuredClone(raw),limits={[allowed.id]:1};
  const result=visibleGPUQStatus(raw,{...principal,limits},{jobs:[],users:[]});
  const hidden=result.hosts.find(host=>host.id===restricted.id),real=result.hosts.find(host=>host.id===allowed.id);
  assert.equal(hidden.displayMasked,true);assert.equal(hidden.gpus.length,restricted.cards);
  assert.doesNotMatch(JSON.stringify(hidden),/private-|12345|J0123456789ab/);
  for(const gpu of hidden.gpus){
    const percent=gpu.memoryUsedMiB/gpu.memoryTotalMiB*100;
    assert.ok(percent>=19.99&&percent<=90.01);assert.equal(gpu.processes.length,1);
    assert.equal(gpu.processes[0].task.name,'匿名任务');assert.equal(gpu.processes[0].task.submitter.name,'匿名用户');
  }
  assert.equal(real.gpus[0].memoryUsedMiB,1024);assert.equal(real.gpus[0].processes[0].owner,'private-owner');
  assert.deepEqual(raw,before);
  for(const viewer of [{...principal,role:'admin'},principal]){
    const grants=Object.fromEntries(MACHINES.map(machine=>[machine.id,1]));
    const full=visibleGPUQStatus(raw,{...viewer,limits:viewer.role==='admin'?{}:grants},{jobs:[],users:[]});
    assert.ok(full.hosts.every(host=>host.displayMasked!==true&&host.gpus[0].memoryUsedMiB===1024));
  }
  const readings=new Set(Array.from({length:12},()=>visibleGPUQStatus(raw,principal).hosts[0].gpus[0].memoryUsedMiB));
  assert.ok(readings.size>1,'anonymous memory changes across refreshes');
});

test('anonymous GPUs render busy even with missing or stale real observations',()=>{
  for(const raw of [snapshot(),{checkedAt:null,stale:true,hosts:[]}]){
    const masked=visibleGPUQStatus(raw,principal);
    const view=resourceServerView(restricted,{production:true,snapshot:masked});
    assert.equal(view.busy,restricted.cards);assert.equal(resourceTotals([view]).free,0);
    const html=resourceCards({machines:[restricted],production:true,snapshot:masked});
    assert.equal((html.match(/resource-tower-bar used/g)||[]).length,restricted.cards);
    assert.match(html,/匿名任务/);assert.match(html,/匿名用户/);
    assert.doesNotMatch(html,/空闲|提交即开始|private-/);
  }
});

async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'machine-visibility-')),bootstrap=join(dir,'bootstrap');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Visibility-Fixture-Only-2026!'}));
  const calls=[],service=await PortalService.open(join(dir,'db'),bootstrap,undefined,async(machine,operation)=>{
    calls.push({machine,operation});return {text:'private-log',nodeJobId:'J0123456789ab',state:'RUNNING'};
  });
  clearInterval(service.executionTimer);
  const member=await service.accounts.create({name:'Viewer',username:'viewer',password:'Visibility-Member-Only-2026!'});
  service.refreshAccounts();const user=service.store.users.find(row=>row.id===member.id);
  user.limits={[allowed.id]:1};user.total=1;
  const identity={...principal,userId:member.id},token=service.issueSession(identity);
  service.gpuq=snapshot();service.refreshGPUQ=async()=>{};
  service.store.jobs=MACHINES.slice(0,2).map((machine,index)=>({id:'job-'+index,key:'key-'+index,userId:'builtin-admin',
    machine:machine.id,cards:1,name:'private-task-'+index,state:'RUNNING',nodeJobId:'J0123456789ab',
    spec:{id:'job-'+index,userId:'builtin-admin',project:'fixture',argv:['private-command']}}));
  t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});
  return {service,token,identity,user,calls};
}

test('state and direct task queries enforce the same server visibility',async t=>{
  const f=await fixture(t),state=(await f.service.invoke(f.token,'state')).state;
  assert.deepEqual(state.jobs.map(job=>job.id),['job-1']);assert.equal(state.jobsTotal,1);
  assert.deepEqual((await f.service.invoke(f.token,'state',{jobKey:'key-0'})).state.jobs,[]);
  for(const [operation,args] of [
    ['state',{jobId:'job-0'}],...['jobs.watch','jobs.logs','jobs.completion','jobs.diagnostics'].map(operation=>[operation,{jobId:'job-0'}]),
    ['tasks.display.get',{machine:restricted.id,nodeJobId:'J0123456789ab'}],['storage.snapshot',{machine:restricted.id}],
    ['files.direct-ticket',{machine:restricted.id,area:'output',runId:'job-0',action:'get',path:'stdout.log'}],
    ['files.direct-ticket',{machine:restricted.id,area:'code',project:'fixture',runId:'job-0',action:'get',path:'stdout.log'}],
    ['files.direct-ticket',{machine:allowed.id,area:'code',project:'fixture',runId:'job-0',action:'get',path:'stdout.log'}],
    ['files.get',{area:'output',runId:'job-0',path:'stdout.log'}],['jobs.cancel',{jobId:'job-0'}],
    ['files.get',{machine:restricted.id,area:'code',project:'fixture',runId:'job-0',path:'stdout.log'}],
    ['jobs.submit',{machine:allowed.id,key:'key-0',cards:1,project:'fixture',argv:['true']}],
    ['terminal.status',{machine:restricted.id,id:'11111111-1111-4111-8111-111111111111'}]
  ])await assert.rejects(f.service.invoke(f.token,operation,args),error=>error.status===403,operation);
  assert.equal(f.calls.length,0,'denied reads never contact the node');
  const hash=value=>createHash('sha256').update(value).digest('hex'),ticket='fixture-output-ticket';
  f.service.fileTickets.set(hash(ticket),{expiresAt:Date.now()/1000+60,sessionHash:hash(f.token),
    args:{machine:allowed.id,area:'code',runId:'job-0'}});
  assert.throws(()=>f.service.checkFileTicket({ticket}),error=>error.status===403,'existing output tickets cannot bypass the job grant');
  f.service.db.prepare('UPDATE operational_maintenance_v2 SET data=? WHERE id=1').run(JSON.stringify({version:1,revision:1,global:null,
    machines:{[restricted.id]:{reason:'private-maintenance',since:new Date().toISOString()}}}));
  assert.deepEqual((await f.service.invoke(f.token,'maintenance.status')).result.machines,{});
  assert.deepEqual((await f.service.invoke(f.token,'storage.snapshot')).result.machines.map(row=>row.machine),[allowed.id]);
  assert.equal((await f.service.invoke(f.token,'jobs.logs',{jobId:'job-1'})).result.text,'private-log');
  f.user.limits[restricted.id]=1;
  assert.equal(f.service.state(f.identity).gpuq.hosts[0].displayMasked,undefined);
  delete f.user.limits[restricted.id];
  assert.equal(f.service.state(f.identity).gpuq.hosts[0].displayMasked,true);
});

test('revoking a server grant during an in-flight task read suppresses the response',async t=>{
  const f=await fixture(t);let release,started;
  const ready=new Promise(resolve=>started=resolve),held=new Promise(resolve=>release=resolve);
  f.service.bridge=async()=>{started();await held;return {text:'private-log'};};
  const pending=f.service.invoke(f.token,'jobs.logs',{jobId:'job-1'});
  const rejected=assert.rejects(pending,error=>error.status===403);
  await ready;delete f.user.limits[allowed.id];release();await rejected;
});

test('hidden tasks cannot be subscribed to and revoked grants discard queued task notifications',async t=>{
  const f=await fixture(t),sent=[];
  clearInterval(f.service.notificationTimer);
  installJobNotifications(f.service,{chatByUserId:{[f.user.id]:'fixture-chat'},send:async(...args)=>sent.push(args)},{timer:false});
  await assert.rejects(f.service.invoke(f.token,'notifications.job',{jobId:'job-0',enabled:true}),error=>error.status===403);
  await f.service.invoke(f.token,'notifications.job',{jobId:'job-1',enabled:true});
  f.service.store.jobs[1].state='SUCCEEDED';f.service.captureJobNotifications();
  assert.equal(f.service.db.prepare('SELECT count(*) n FROM job_notification_outbox_v2').get().n,1);
  delete f.user.limits[allowed.id];await f.service.flushJobNotifications();
  assert.deepEqual(sent,[]);
  assert.equal(f.service.db.prepare("SELECT count(*) n FROM job_notification_outbox_v2 WHERE state='QUEUED'").get().n,0);
});
