import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
const revision=metadata=>createHash('sha256').update(JSON.stringify({description:metadata.description,name:metadata.name,submitter:{name:metadata.submitter.name,username:metadata.submitter.username}})).digest('hex');
const deferred=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve};};
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-display-edit-')),bootstrap=join(dir,'bootstrap'),status=join(dir,'status'),password='Display-Edit-Fixture-Only-2026!';
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const nodeJobId='J123456789abc',id=randomUUID(),calls=[];
  let metadata={name:'原显示',description:'原说明',submitter:{name:'alice',username:'alice'}},hook;
  const row={id:nodeJobId,name:'portal-'+id.slice(0,8),owner:'alice',state:'RUNNING',display_metadata:metadata};
  const snapshot=()=>({version:1,checkedAt:new Date(Date.now()-1000).toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,gpus:[],gpuq:{connected:true,capabilities:['console-task-display-edit-v1'],jobs:m.id==='gpu-1'?[row]:[]}}))});
  await writeFile(status,JSON.stringify(snapshot()));
  const service=await PortalService.open(join(dir,'db'),bootstrap,status,async(machine,op,args)=>{
    calls.push({machine,op,args:structuredClone(args)});if(hook)await hook(machine,op,args);
    assert.equal(machine,'gpu-1');assert.ok(['tasks.display.get','tasks.display.set'].includes(op));
    if(op==='tasks.display.set'){
      if(args.revision!==revision(metadata))throw Object.assign(Error('native CAS conflict'),{status:409});
      metadata={...metadata,name:args.name,description:args.description};
    }
    return {protocol:'task-display-edit-v1',nodeJobId,available:true,name:metadata.name,description:metadata.description,revision:revision(metadata),metadata,
      binding:{submitKey:id,owner:'alice',name:row.name}};
  });
  clearInterval(service.executionTimer);clearInterval(service.maintenanceTimer);clearInterval(service.transferTimer);clearInterval(service.storageArchiveTimer);
  t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});
  const admin=await service.login('admin',password),user=(await service.invoke(admin.token,'users.create',{username:'alice',password})).result;
  await service.invoke(admin.token,'policy.save',{userId:user.id,policyVersion:0,total:1,limits:{'gpu-1':1}});
  const member=await service.login('alice',password),job={id,userId:user.id,username:'alice',name:'immutable raw label',description:'immutable raw description',machine:'gpu-1',cards:1,state:'RUNNING',nodeJobId,
    spec:{id,userId:user.id,username:'alice',name:'immutable raw label',cards:1,argv:['python','train.py'],minVramGiB:0}};
  service.store.jobs.push(job);service.save();
  return {service,admin,member,user,job,row,calls,id,nodeJobId,status,snapshot,context:{machine:'gpu-1',nodeJobId},get metadata(){return metadata;},set hook(value){hook=value;}};
}
test('normal member get/set preserve immutable job and share one queue/job projection',async t=>{
  const f=await fixture(t),original=structuredClone(f.job),before=(await f.service.invoke(f.member.token,'tasks.display.get',f.context)).result;
  assert.equal(before.available,true);assert.equal(before.name,'原显示');assert.equal(Object.hasOwn(before,'binding'),false);
  const result=(await f.service.invoke(f.member.token,'tasks.display.set',{...f.context,name:'中文｜实验',description:'训练说明',revision:before.revision})).result;
  assert.equal(result.name,'中文｜实验');assert.deepEqual(f.job,original);
  assert.deepEqual(f.calls[1].args,{userId:f.user.id,hostAdmin:false,nodeJobId:f.nodeJobId,job:f.job.spec,name:'中文｜实验',description:'训练说明',revision:before.revision});
  const state=f.service.state(f.member.principal);assert.equal(state.jobs[0].name,result.name);assert.equal(state.jobs[0].description,result.description);
  assert.equal(state.gpuq.hosts[0].tasks[0].name,result.name);assert.equal(state.gpuq.hosts[0].tasks[0].description,result.description);
  for(const hidden of ['binding','submitKey','immutable raw label'])assert.ok(!JSON.stringify(result).includes(hidden));
});
test('historical display changes use the physical native binding while original user intent stays unchanged',async t=>{
  const f=await fixture(t),logical={dataset:'images',version:'a'.repeat(64)},physical={...logical,dataset:'images-replica'};
  f.job.spec.datasets=[logical];f.job.dataPreparationHold={state:'HELD',spec:{...structuredClone(f.job.spec),datasets:[physical]}};
  const original=structuredClone(f.job),before=(await f.service.invoke(f.member.token,'tasks.display.get',f.context)).result;
  await f.service.invoke(f.member.token,'tasks.display.set',{...f.context,name:'旧训练新显示',description:'仅修改显示',revision:before.revision});
  assert.equal(f.calls.length,2);assert.ok(f.calls.every(call=>JSON.stringify(call.args.job)===JSON.stringify(original.dataPreparationHold.spec)));
  assert.deepEqual(f.job,original);assert.equal(f.service.state(f.member.principal).jobs[0].name,'旧训练新显示');
});
test('historical native binding changes during a display read reject its late result',async t=>{
  const f=await fixture(t),entered=deferred(),release=deferred();
  f.job.dataPreparationHold={state:'HELD',spec:structuredClone(f.job.spec)};
  f.hook=async()=>{entered.resolve();await release.promise;};
  const reading=f.service.invoke(f.member.token,'tasks.display.get',f.context);await entered.promise;
  const rejected=assert.rejects(reading,e=>e.status===409);
  f.job.dataPreparationHold.spec={...f.job.dataPreparationHold.spec,datasets:[{dataset:'changed',version:'a'.repeat(64)}]};
  release.resolve();await rejected;assert.equal(f.calls.length,1);assert.equal(f.service.taskDisplayViews.size,0);
});
test('cross-account, zero authorization, forged fields and ambiguous identities never dispatch',async t=>{
  const f=await fixture(t);f.job.userId='demo-user-999';f.job.spec.userId='demo-user-999';
  await assert.rejects(f.service.invoke(f.member.token,'tasks.display.get',f.context),e=>e.status===403);assert.equal(f.calls.length,0);
  for(const fields of [{owner:'alice'},{userId:f.user.id},{argv:['other']},{spec:f.job.spec},{submitter:{username:'alice'}}])await assert.rejects(f.service.invoke(f.admin.token,'tasks.display.get',{...f.context,...fields}),e=>e.status===400);
  await assert.rejects(f.service.invoke(f.member.token,'tasks.display.get',{machine:'gpu-2',nodeJobId:f.nodeJobId}),e=>e.status===403);
  f.service.store.jobs.push({...f.job,id:randomUUID()});await assert.rejects(f.service.invoke(f.admin.token,'tasks.display.get',f.context),e=>e.status===409);assert.equal(f.calls.length,0);
});
test('native-only tasks require admin but never associate owner from display metadata',async t=>{
  const f=await fixture(t);f.service.store.jobs=[];
  await assert.rejects(f.service.invoke(f.member.token,'tasks.display.get',f.context),e=>e.status===403);
  const result=(await f.service.invoke(f.admin.token,'tasks.display.get',f.context)).result;assert.equal(result.name,'原显示');assert.equal(f.calls.length,1);assert.equal(Object.hasOwn(f.calls[0].args,'job'),false);assert.equal(f.calls[0].args.hostAdmin,true);
  assert.equal(f.service.store.jobs.length,0);assert.equal(f.service.state(f.admin.principal).gpuq.hosts[0].tasks[0].submitter.username,'alice');
});
test('old or stale node capability never dispatches mutation',async t=>{
  const f=await fixture(t);
  for(const capabilities of [[],['console-task-display-v1'],'console-task-display-edit-v1']){
    f.service.gpuq.hosts[0].gpuq.capabilities=capabilities;
    assert.equal((await f.service.invoke(f.member.token,'tasks.display.get',f.context)).result.available,false);
    await assert.rejects(f.service.invoke(f.member.token,'tasks.display.set',{...f.context,name:'名称',description:'',revision:'a'.repeat(64)}),e=>e.status===503);
  }
  f.service.gpuq.stale=true;assert.equal((await f.service.invoke(f.admin.token,'tasks.display.get',f.context)).result.available,false);assert.equal(f.calls.length,0);
});
test('two stale clients conflict and lost reply is read on the exact original id without replay',async t=>{
  const f=await fixture(t),before=(await f.service.invoke(f.member.token,'tasks.display.get',f.context)).result;
  await f.service.invoke(f.member.token,'tasks.display.set',{...f.context,name:'第一客户端',description:'',revision:before.revision});
  await assert.rejects(f.service.invoke(f.member.token,'tasks.display.set',{...f.context,name:'第二客户端',description:'',revision:before.revision}),e=>e.status===409);
  const current=(await f.service.invoke(f.member.token,'tasks.display.get',f.context)).result;
  let lost=true;f.hook=(machine,op)=>{if(op==='tasks.display.set'&&lost){lost=false;throw Object.assign(Error('lost ACK'),{status:504});}};
  const count=f.calls.length;await assert.rejects(f.service.invoke(f.member.token,'tasks.display.set',{...f.context,name:'结果待确认',description:'',revision:current.revision}),e=>e.status===504);
  const checked=(await f.service.invoke(f.member.token,'tasks.display.get',f.context)).result;
  assert.equal(checked.nodeJobId,f.nodeJobId);assert.equal(f.calls.slice(count).filter(c=>c.op==='tasks.display.set').length,1);
});
test('role/grant changes while waiting reject results and queued writes before dispatch',async t=>{
  const f=await fixture(t),entered=deferred(),release=deferred();f.hook=async()=>{entered.resolve();await release.promise;};
  const first=f.service.invoke(f.member.token,'tasks.display.get',f.context);await entered.promise;
  const second=f.service.invoke(f.member.token,'tasks.display.set',{...f.context,name:'不得派发',description:'',revision:'a'.repeat(64)});
  const firstRejected=assert.rejects(first,e=>e.status===403),secondRejected=assert.rejects(second,e=>e.status===401);
  f.service.store.users.find(u=>u.id===f.user.id).enabled=false;release.resolve();await firstRejected;await secondRejected;
  assert.equal(f.calls.length,1);assert.equal(f.service.taskDisplayViews.size,0);
});
test('new collector replaces bounded presentation while stale collector cannot authorize edits',async t=>{
  const f=await fixture(t),before=(await f.service.invoke(f.member.token,'tasks.display.get',f.context)).result;
  await f.service.invoke(f.member.token,'tasks.display.set',{...f.context,name:'临时新显示',description:'',revision:before.revision});
  assert.equal(f.service.state(f.member.principal).jobs[0].name,'临时新显示');
  f.row.display_metadata={...f.metadata,name:'后续原生显示'};f.service.gpuq.hosts[0].gpuq.jobs=[f.row];f.service.gpuq.checkedAt=new Date(Date.now()+1).toISOString();
  const state=f.service.state(f.member.principal);assert.equal(state.gpuq.hosts[0].tasks[0].name,'后续原生显示');assert.equal(f.service.taskDisplayViews.size,0);
});
