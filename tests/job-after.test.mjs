import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {usage} from '../execution.mjs';

async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'job-after-')),password='Local-After-Password-2026!';
  const bootstrap=join(dir,'bootstrap');await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const calls=[],states=new Map();let delayed;
  const service=await PortalService.open(join(dir,'db'),bootstrap,undefined,async(machine,operation,args)=>{
    calls.push({machine,operation,args:structuredClone(args)});
    if(delayed&&args.job.id===delayed.id)await delayed.promise;
    if(operation==='diagnostics')return {state:'UNAVAILABLE',schedulerState:'PENDING'};
    return {state:states.get(args.job.id)||'PENDING',nodeJobId:'J'+args.job.id.replaceAll('-','').slice(0,12),assignedIndices:[]};
  });
  clearInterval(service.executionTimer);
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'alice',password})).result;
  await service.invoke(admin.token,'policy.save',{userId:member.id,limits:{'gpu-1':8,'gpu-2':8},total:8});
  const user=await service.login('alice',password);
  const settle=async()=>{await new Promise(resolve=>setImmediate(resolve));while(service.reconciling)await new Promise(resolve=>setTimeout(resolve,5));};
  t.after(async()=>{delayed?.resolve();await settle();service.close();await rm(dir,{recursive:true,force:true});});
  return {service,user,member,calls,states,settle,
    submit:async(extra={})=>(await service.invoke(user.token,'jobs.submit',{machine:'gpu-1',project:'demo',name:'train',cards:1,argv:['python','train.py'],key:randomUUID(),...extra})).result,
    delay(id){let resolve;const promise=new Promise(r=>resolve=r);delayed={id,resolve,promise};return resolve;}};
}

test('AUTO dependencies choose their node and bypass cross-node project copying',async t=>{
  const f=await fixture(t),parent=await f.submit({name:'mother'});await f.settle();
  const child=await f.submit({machine:'auto',machineSelection:{mode:'auto',candidates:['gpu-2']},sourceMachine:'gpu-2',after:[parent.id]});
  await f.settle();assert.equal(child.machine,'gpu-1');assert.deepEqual(child.after,[{id:parent.id,name:'mother'}]);
  const sent=f.calls.find(call=>call.args.job.id===child.id);
  assert.equal(sent.machine,'gpu-1');assert.deepEqual(sent.args.job.after,[f.service.store.jobs[0].nodeJobId]);assert.equal(sent.args.job.projectCopy,undefined);
  assert.match((await f.service.invoke(f.user.token,'state')).state.jobs.find(job=>job.id===child.id).queueReason,/等待依赖：mother/);
  const diagnostics=(await f.service.invoke(f.user.token,'jobs.diagnostics',{jobId:child.id})).result;
  assert.deepEqual(diagnostics.after,child.after);assert.match(diagnostics.queueReason,/等待依赖：mother/);
});

test('explicit machine mismatch and dependencies spanning nodes are rejected before dispatch',async t=>{
  const f=await fixture(t),a=await f.submit(),b=await f.submit({machine:'gpu-2'});await f.settle();const count=f.service.store.jobs.length;
  await assert.rejects(f.submit({machine:'gpu-2',after:[a.id]}),/指定服务器与依赖作业所在服务器不一致/);
  await assert.rejects(f.submit({machine:'auto',after:[a.id,b.id]}),/依赖作业必须都在同一台服务器/);
  assert.equal(f.service.store.jobs.length,count);
});

test('A B C can be submitted together; dispatch waits only for native IDs, not success',async t=>{
  const f=await fixture(t),parent=await f.submit({name:'A'}),release=f.delay(parent.id);
  const child=await f.submit({after:[parent.id],name:'B'}),grandchild=await f.submit({after:[child.id],name:'C'});
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(f.calls.some(call=>call.args.job.id===child.id),false);
  release();await f.settle();await f.service.reconcile();await f.settle();
  for(const job of [parent,child,grandchild])assert.equal(f.service.store.jobs.find(row=>row.id===job.id).state,'PENDING');
  assert.deepEqual(f.calls.find(call=>call.args.job.id===grandchild.id).args.job.after,[f.service.store.jobs.find(row=>row.id===child.id).nodeJobId]);
});

test('a parent rejected before receiving a node ID cancels its child and releases its reservation',async t=>{
  const f=await fixture(t);f.service.reconciling=true;
  const parent=await f.submit(),child=await f.submit({after:[parent.id]});
  const row=f.service.store.jobs.find(job=>job.id===parent.id);row.state='FAILED';row.notSubmitted=true;
  f.service.reconciling=false;await f.service.reconcile();
  const canceled=f.service.store.jobs.find(job=>job.id===child.id);
  assert.equal(canceled.state,'CANCELED');assert.match(canceled.error,/依赖作业 train.*未运行/);assert.equal(usage(f.service.store.jobs,f.member.id),0);
  assert.equal(f.calls.length,0);
  const shown=(await f.service.invoke(f.user.token,'state')).state.jobs.find(job=>job.id===child.id);
  assert.deepEqual(shown.after,[{id:parent.id,name:'train'}]);assert.match(shown.reason,/依赖作业 train.*未运行/);
});

test('dependency chains, branches and joins can all queue without reserving personal cards',async t=>{
  const f=await fixture(t),a=await f.submit({cards:8}),b=await f.submit({cards:8,after:[a.id]}),c=await f.submit({cards:8,after:[b.id]});
  const left=await f.submit({cards:4,after:[a.id]}),right=await f.submit({cards:4,after:[a.id]}),joined=await f.submit({cards:8,after:[left.id,right.id]});
  await f.submit({machine:'gpu-2'});await f.settle();
  assert.equal(f.service.store.jobs.length,7);assert.equal(f.service.store.jobs.every(job=>job.state==='PENDING'),true);
  assert.equal(usage(f.service.store.jobs,f.member.id),0);assert.equal(usage(f.service.store.jobs,f.member.id,'gpu-1'),0);
  assert.deepEqual(f.calls.find(call=>call.args.job.id===joined.id).args.job.after,[left,right].map(job=>f.service.store.jobs.find(row=>row.id===job.id).nodeJobId));
  assert.deepEqual(c.after,[{id:b.id,name:'train'}]);
});
