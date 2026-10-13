import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
import {usage} from '../execution.mjs';

const password='Priority-Only-Test-Password-2026!';
const CAPABILITIES=['priority-policy-v1','preempt-idle-only-v1','priority-rank-v1'];
const policy=priority=>({priority:{idle:0,normal:2,high:4}[priority],yield_policy:priority==='idle'?'now':'never',restart_policy:'never',dispatch_mode:'queue'});
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-priority-api-')),database=join(dir,'database'),bootstrap=join(dir,'bootstrap'),status=join(dir,'status');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  let capabilities=CAPABILITIES,stale=false;
  async function snapshot(){await writeFile(status,JSON.stringify({version:1,checkedAt:new Date(Date.now()-(stale?240000:0)).toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,gpus:Array.from({length:m.cards},(_,index)=>({index,memoryTotalMiB:32768})),gpuq:{connected:true,observeOnly:false,capabilities,schedulableIndices:[0,1],jobs:[]}}))}));}
  await snapshot();
  const calls=[],remote=new Map(),handlers=new Map();
  const result=(id,priority='normal',extra={})=>({nodeJobId:'node-'+id,state:'PENDING',assignedIndices:[],priority,schedulerPriority:policy(priority).priority,schedulerPolicy:policy(priority),priorityMutable:true,schedulerState:'QUEUED',queueReason:'waiting-for-free-gpus',...extra});
  const bridge=async(machine,operation,args)=>{
    calls.push({machine,operation,args:structuredClone(args)});
    if(operation==='projects.workspace')return {project:args.project,state:'AVAILABLE',workspace:{protocol:1,persistent:true}};
    if(handlers.has(operation))return handlers.get(operation)(machine,args);
    const id=args.job.id;
    if(!remote.has(id))remote.set(id,result(id,args.job.priority||'normal'));
    if(operation==='priority'){
      assert.equal(args.rankOnly,true);
      const rank={idle:0,normal:2,high:4,P0:0,P1:1,P2:2,P3:3,P4:4}[args.priority];
      remote.set(id,{...remote.get(id),priority:args.priority,schedulerPriority:rank,schedulerPolicy:{...remote.get(id).schedulerPolicy,priority:rank}});
    }
    return structuredClone(remote.get(id));
  };
  let s=await PortalService.open(database,bootstrap,status,bridge);clearInterval(s.executionTimer);
  let admin=await s.login('admin',password);
  const member=(await s.invoke(admin.token,'users.create',{username:'priority-member',password})).result;
  let user=await s.login(member.username,password);
  await s.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:4,limits:{'gpu-1':4}});
  const settle=async()=>{await new Promise(resolve=>setImmediate(resolve));while(s.reconciling)await new Promise(resolve=>setTimeout(resolve,5));};
  t.after(async()=>{await settle();s.close();await rm(dir,{recursive:true,force:true});});
  const submit=(more={},token=user.token)=>s.invoke(token,'jobs.submit',{machine:'gpu-1',project:'training',cards:1,argv:['python','train.py'],key:randomUUID(),...more});
  return {get s(){return s},get admin(){return admin},get user(){return user},member,calls,remote,handlers,result,settle,submit,
    snapshot:async(options={})=>{if(Object.hasOwn(options,'capabilities'))capabilities=options.capabilities;if(Object.hasOwn(options,'stale'))stale=options.stale;await snapshot();await s.refreshGPUQ();},
    reopen:async()=>{await settle();s.close();s=await PortalService.open(database,undefined,status,bridge);clearInterval(s.executionTimer);admin=await s.login('admin',password);user=await s.login(member.username,password);}
  };
}

test('rank edits preserve yield and restart and expose intermediate P1/P3',async t=>{
  const f=await fixture(t),id=(await f.submit({priority:'idle'})).result.id;await f.settle();
  for(const priority of ['P1','P3','high','normal']){
    const updated=(await f.s.invoke(f.admin.token,'jobs.priority',{jobId:id,priority})).result;
    assert.equal(updated.yieldPolicy,'now');
    assert.equal(updated.restartPolicy,'never');
    assert.equal(updated.dispatchMode,'queue');
  }
  assert.equal(f.s.store.jobs[0].spec.priority,'idle');
});
test('old capability cannot invoke the policy-changing fallback',async t=>{
  const f=await fixture(t),id=(await f.submit({priority:'idle'})).result.id;await f.settle();
  await f.snapshot({capabilities:['priority-policy-v1','preempt-idle-only-v1']});
  await assert.rejects(f.s.invoke(f.admin.token,'jobs.priority',{jobId:id,priority:'high'}),e=>e.status===503);
  assert.equal(f.calls.filter(c=>c.operation==='priority').length,0);
});
test('explicit scheduling jobs expose admin rank edits and preserve immutable save/resume policy',async t=>{
  const f=await fixture(t),scheduling={rank:'P1',yieldPolicy:'save',restartPolicy:'on-preempt',checkpointable:true};
  await f.snapshot({capabilities:[...CAPABILITIES,'console-yield-v1']});
  const id=(await f.submit({scheduling})).result.id;await f.settle();
  const remotePolicy={priority:1,yield_policy:'save',restart_policy:'on-preempt',dispatch_mode:'queue'};
  f.remote.set(id,f.result(id,'P1',{schedulerPriority:1,schedulerPolicy:remotePolicy}));
  await f.s.reconcile();
  const job=f.s.store.jobs[0],spec=structuredClone(job.spec),digest=job.digest;
  assert.equal((await f.s.invoke(f.admin.token,'state')).state.jobs[0].canSetPriority,true);
  assert.equal((await f.s.invoke(f.user.token,'state')).state.jobs[0].canSetPriority,false);
  await assert.rejects(f.s.invoke(f.user.token,'jobs.priority',{jobId:id,priority:'P3'}),e=>e.status===403);
  for(const rank of ['P3','P0']){
    const result=(await f.s.invoke(f.admin.token,'jobs.priority',{jobId:id,priority:rank})).result;
    assert.equal(result.schedulerPriority,Number(rank[1]));assert.equal(result.yieldPolicy,'save');
    assert.equal(result.restartPolicy,'on-preempt');assert.equal(result.dispatchMode,'queue');
  }
  assert.deepEqual(job.spec,spec);assert.equal(job.digest,digest);assert.equal(usage(f.s.store.jobs,f.member.id),1);
});
test('members can submit idle/normal but cannot submit high or alter anyone’s priority',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.submit({priority:'high'}),error=>error.status===403);
  for(const priority of ['idle','normal'])assert.equal((await f.submit({priority})).result.priority,priority);
  await f.settle();const job=f.s.store.jobs[0];
  await assert.rejects(f.s.invoke(f.user.token,'jobs.priority',{jobId:job.id,priority:'high'}),error=>error.status===403);
  assert.equal(f.calls.some(c=>c.operation==='priority'),false);
  assert.equal((await f.submit({priority:'high'},f.admin.token)).result.priority,'high');
});

test('explicit priority is part of the workspace digest; omitted-priority keys remain unchanged after restart',async t=>{
  const f=await fixture(t),key=randomUUID();
  const both=await Promise.all([f.submit({priority:'idle',key}),f.submit({priority:'idle',key})]);
  assert.equal(both[0].result.id,both[1].result.id);assert.equal(f.s.store.jobs.length,1);
  await assert.rejects(f.submit({priority:'normal',key}),error=>error.status===409);
  const legacyKey=randomUUID(),old=(await f.submit({key:legacyKey})).result;
  const stored=f.s.store.jobs.find(j=>j.id===old.id);
  assert.equal(stored.digest,createHash('sha256').update(JSON.stringify(['gpu-1',1,0,['python','train.py'],'train',{project:'training',workspace:true}])).digest('hex'));
  await f.reopen();assert.equal((await f.submit({key:legacyKey})).result.id,old.id);
  await assert.rejects(f.submit({key:legacyKey,priority:'normal'}),error=>error.status===409);
  assert.equal(f.s.store.jobs.length,2);
});

test('malformed priority, stale snapshots and missing/malformed capabilities reject before reservation',async t=>{
  const f=await fixture(t);
  for(const priority of [null,0,true,{},[],['idle'],'P0','urgent',''])await assert.rejects(f.submit({priority}),error=>error.status===400,JSON.stringify(priority));
  for(const capabilities of [[],['priority-policy-v1'],['preempt-idle-only-v1'],null,{},'priority-policy-v1 preempt-idle-only-v1']){
    await f.snapshot({capabilities});
    for(const priority of ['idle','normal','high'])await assert.rejects(f.submit({priority},f.admin.token),error=>error.status===503,JSON.stringify(capabilities));
    const state=(await f.s.invoke(f.admin.token,'state')).state;assert.equal(state.execution.priorityCapabilities['gpu-1'],false);
  }
  await f.snapshot({capabilities:CAPABILITIES,stale:true});
  await assert.rejects(f.submit({priority:'idle'}),error=>error.status===503);
  await f.settle();assert.equal(f.s.store.jobs.length,0);assert.ok(f.calls.every(c=>c.operation==='projects.workspace'));assert.equal(usage(f.s.store.jobs,f.member.id),0);
});

test('legacy capability absence preserves old submission wire spec without inventing safe priority policy',async t=>{
  const f=await fixture(t);await f.snapshot({capabilities:[]});
  const submitted=(await f.submit()).result;assert.equal(submitted.priority,null);
  const spec=f.s.store.jobs.find(j=>j.id===submitted.id).spec;
  assert.equal(Object.hasOwn(spec,'priority'),false);assert.equal(Object.hasOwn(spec,'preemptIdleOnly'),false);
  await f.settle();
  await assert.rejects(f.s.invoke(f.admin.token,'jobs.priority',{jobId:submitted.id,priority:'high'}),error=>error.status===409);
  assert.equal(f.calls.some(c=>c.operation==='priority'),false);
});

test('only verified queued policies may change; expectedPriority serializes competing updates',async t=>{
  const f=await fixture(t);const id=(await f.submit({priority:'idle'})).result.id;await f.settle();
  const job=f.s.store.jobs.find(j=>j.id===id),spec=structuredClone(job.spec),digest=job.digest;
  for(const change of [{state:'RUNNING'},{state:'STARTING'},{state:'PREEMPTING'},{state:'UNKNOWN'},{state:'SUCCEEDED'},{cancelRequested:true},{priorityMutable:false},{schedulerPolicy:null}]){
    const before=structuredClone(job);Object.assign(job,change);
    await assert.rejects(f.s.invoke(f.admin.token,'jobs.priority',{jobId:id,priority:'high'}),error=>error.status===409);
    Object.keys(job).forEach(k=>delete job[k]);Object.assign(job,before);
  }
  const attempts=await Promise.allSettled([
    f.s.invoke(f.admin.token,'jobs.priority',{jobId:id,priority:'high',expectedPriority:'idle'}),
    f.s.invoke(f.admin.token,'jobs.priority',{jobId:id,priority:'normal',expectedPriority:'idle'}),
  ]);
  assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);assert.equal(attempts.find(r=>r.status==='rejected').reason.status,409);
  const call=f.calls.find(c=>c.operation==='priority');assert.equal(call.machine,'gpu-1');assert.deepEqual(call.args.expected,policy('idle'));
  assert.equal(f.calls.filter(c=>c.operation==='priority').length,1);assert.equal(job.priority,'high');assert.deepEqual(job.spec,spec);assert.equal(job.digest,digest);
  const response=attempts.find(r=>r.status==='fulfilled').value.result;assert.equal(Object.hasOwn(response,'schedulerPolicy'),false);assert.equal(Object.hasOwn(response,'spec'),false);
});

test('priority RPC uncertainty preserves quota and immutable spec, does not resend priority, and reconciles actual node state',async t=>{
  const f=await fixture(t),key=randomUUID();const id=(await f.submit({priority:'idle',key})).result.id;await f.settle();
  const job=f.s.store.jobs[0],spec=structuredClone(job.spec),digest=job.digest;
  f.handlers.set('priority',(_machine,args)=>{f.remote.set(id,f.result(id,args.priority));throw Error('priority reply timeout');});
  f.handlers.set('sync',()=>{throw Error('offline');});
  await assert.rejects(f.s.invoke(f.admin.token,'jobs.priority',{jobId:id,priority:'high',expectedPriority:'idle'}),/reply timeout/);
  assert.equal(job.priorityMutable,false);assert.deepEqual(job.spec,spec);assert.equal(job.digest,digest);assert.equal(usage(f.s.store.jobs,f.member.id),1);
  await f.settle();assert.equal(f.calls.filter(c=>c.operation==='priority').length,1);assert.equal(f.s.store.jobs.length,1);
  const retried=(await f.submit({priority:'idle',key})).result;assert.equal(retried.id,id);assert.equal(f.s.store.jobs.length,1);
  f.handlers.delete('sync');await f.s.reconcile();assert.equal(job.priority,'high');assert.deepEqual(job.spec,spec);assert.equal(usage(f.s.store.jobs,f.member.id),1);
  assert.equal(f.calls.filter(c=>c.operation==='priority').length,1);assert.ok(f.calls.filter(c=>c.operation==='sync').every(c=>c.args.job.id===id&&c.args.job.priority==='idle'));
  await f.reopen();assert.deepEqual(f.s.store.jobs[0].spec,spec);assert.equal(f.s.store.jobs[0].priority,'high');assert.equal(usage(f.s.store.jobs,f.member.id),1);
});

test('priority mutations fail closed for stale capabilities, invalid fields, and unavailable audit persistence',async t=>{
  const f=await fixture(t);const id=(await f.submit({priority:'idle'})).result.id;await f.settle();
  for(const args of [{jobId:id,priority:null},{jobId:id,priority:'high',userId:'builtin-admin'},{jobId:id,priority:'high',machine:'gpu-2'},{jobId:id,priority:'high',expectedPriority:'normal'}])await assert.rejects(f.s.invoke(f.admin.token,'jobs.priority',args));
  await f.snapshot({capabilities:[]});await assert.rejects(f.s.invoke(f.admin.token,'jobs.priority',{jobId:id,priority:'high'}),error=>error.status===503);
  await f.snapshot({capabilities:CAPABILITIES,stale:true});await assert.rejects(f.s.invoke(f.admin.token,'jobs.priority',{jobId:id,priority:'high'}),error=>error.status===503);
  await f.snapshot({stale:false});
  const audit=f.s.audit;f.s.audit=()=>{throw Error('audit disk full');};
  try{await assert.rejects(f.s.invoke(f.admin.token,'jobs.priority',{jobId:id,priority:'high'}),/audit disk full/);}finally{f.s.audit=audit;}
  assert.equal(f.calls.filter(c=>c.operation==='priority').length,0);assert.equal(usage(f.s.store.jobs,f.member.id),1);assert.equal(f.s.store.jobs[0].spec.priority,'idle');
});

test('a late old sync response cannot overwrite the newer confirmed priority',async t=>{
  const f=await fixture(t);const id=(await f.submit({priority:'idle'})).result.id;await f.settle();
  let release;const delayed=new Promise(resolve=>release=resolve);
  f.handlers.set('sync',()=>delayed);
  const reconciling=f.s.reconcile();
  await f.s.invoke(f.admin.token,'jobs.priority',{jobId:id,priority:'high',expectedPriority:'idle'});
  release(f.result(id,'idle'));await reconciling;
  assert.equal(f.s.store.jobs[0].priority,'high');assert.equal(f.s.store.jobs[0].policyRevision,2);
  f.handlers.delete('sync');
});

for(const syncFailure of [false,true])test(`reconcile started during a priority RPC cannot apply its stale ${syncFailure?'error':'policy'} after confirmation`,async t=>{
  const f=await fixture(t);const id=(await f.submit({priority:'idle'})).result.id;await f.settle();
  let releasePriority,announcePriority,announceSync;
  const priorityStarted=new Promise(resolve=>announcePriority=resolve),syncStarted=new Promise(resolve=>announceSync=resolve);
  const priorityGate=new Promise(resolve=>releasePriority=resolve);
  f.handlers.set('priority',async()=>{announcePriority();await priorityGate;f.remote.set(id,f.result(id,'high'));return f.result(id,'high');});
  f.handlers.set('sync',()=>{announceSync();if(syncFailure)throw Error('stale sync failure');return f.result(id,'idle');});
  const mutation=f.s.invoke(f.admin.token,'jobs.priority',{jobId:id,priority:'high',expectedPriority:'idle'});
  await priorityStarted;const reconciling=f.s.reconcile();await syncStarted;
  releasePriority();assert.equal((await mutation).result.priority,'high');await reconciling;
  const job=f.s.store.jobs[0];assert.equal(job.priority,'high');assert.equal(job.error,null);assert.equal(job.policyRevision,2);assert.equal(usage(f.s.store.jobs,f.member.id),1);
  f.handlers.delete('sync');
});

test('priority RPC failure fences a sync begun during the request and retains uncertain policy plus quota',async t=>{
  const f=await fixture(t);const id=(await f.submit({priority:'idle'})).result.id;await f.settle();
  let releasePriority,announcePriority,announceSync;
  const priorityStarted=new Promise(resolve=>announcePriority=resolve),syncStarted=new Promise(resolve=>announceSync=resolve);
  const priorityGate=new Promise(resolve=>releasePriority=resolve);
  f.handlers.set('priority',async()=>{announcePriority();await priorityGate;throw Error('priority response lost');});
  f.handlers.set('sync',()=>{announceSync();return f.result(id,'idle');});
  const mutation=f.s.invoke(f.admin.token,'jobs.priority',{jobId:id,priority:'high',expectedPriority:'idle'});
  const rejected=assert.rejects(mutation,/priority response lost/);
  await priorityStarted;const reconciling=f.s.reconcile();await syncStarted;
  releasePriority();await rejected;await reconciling;
  const job=f.s.store.jobs[0];assert.equal(job.priorityMutable,false);assert.match(job.error,/待核验/);assert.equal(job.policyRevision,2);assert.equal(usage(f.s.store.jobs,f.member.id),1);
  // Prevent the scheduled fresh reconcile from replacing the evidence before
  // cleanup. This is independent of the stale result tested above.
  f.handlers.set('sync',()=>{throw Error('still offline');});
});

test('preempted cancellation stays terminal CANCELED while public state exposes queue details and safe controls',async t=>{
  const f=await fixture(t);const id=(await f.submit({priority:'idle'})).result.id;await f.settle();
  const admin=(await f.s.invoke(f.admin.token,'state')).state,user=(await f.s.invoke(f.user.token,'state')).state;
  assert.equal(admin.execution.priorityCapabilities['gpu-1'],true);assert.equal(admin.jobs[0].canSetPriority,true);assert.equal(user.jobs[0].canSetPriority,false);
  assert.equal(admin.jobs[0].schedulerState,'QUEUED');assert.equal(admin.jobs[0].queueReason,'waiting-for-free-gpus');assert.ok(admin.jobs[0].schedulerCheckedAt);
  for(const field of ['spec','digest','schedulerPolicy'])assert.equal(Object.hasOwn(admin.jobs[0],field),false);
  f.remote.set(id,f.result(id,'idle',{state:'CANCELED',schedulerState:'CANCELED',preempted:true,priorityMutable:false,queueReason:null}));
  await f.s.reconcile();const ended=(await f.s.invoke(f.admin.token,'state')).state.jobs[0];
  assert.equal(ended.state,'CANCELED');assert.equal(ended.preempted,true);assert.equal(ended.canSetPriority,false);assert.equal(usage(f.s.store.jobs,f.member.id),0);
  const count=f.calls.length;await f.s.reconcile();assert.equal(f.calls.length,count);
});
