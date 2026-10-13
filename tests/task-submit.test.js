import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {MACHINES} from '../dist/model.js';
import {submitTask,SUBMISSION_CHECK_MESSAGE} from '../tasks/submit.mjs';
import {priorityCapable,usage} from '../execution.mjs';

const machine=MACHINES[0].id;
const request=extra=>({machine,project:'vision',cards:1,argv:['python','train.py','--data','/data/hdd/imagenet'],key:randomUUID(),...extra});

function fixture(t){
  const user={id:'demo-user-1',username:'alice',enabled:true,role:'member',total:2,limits:{[machine]:2}};
  const principal={userId:user.id,username:user.username,role:user.role};
  const store={jobs:[],get:()=>structuredClone(user)},calls=[],db=new DatabaseSync(':memory:');
  db.exec('CREATE TABLE jobs (id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
  const inventory={stale:false,hosts:[{id:machine,reachable:true,
    gpus:Array.from({length:MACHINES[0].cards},(_,index)=>({index,memoryTotalMiB:32768})),
    gpuq:{connected:true,health:'ok',observeOnly:false,schedulableIndices:[],jobs:[],
      capabilities:['priority-policy-v1','preempt-idle-only-v1','console-yield-v1','preempt-opt-in-only-v1','console-placement-v1','console-sharing-v1']}}]};
  const dependencies={store,db,priorityCapable,usage,
    save(){for(const job of store.jobs)db.prepare('INSERT OR REPLACE INTO jobs VALUES(?,?)').run(job.id,JSON.stringify(job));},
    audit(...entry){calls.push({operation:'audit',entry});},
    async bridge(target,operation,args){calls.push({operation,target,args});
      if(operation==='projects.workspace')return {project:args.project,state:'AVAILABLE',workspace:{persistent:true}};
      if(operation==='projects.list')return {projects:[{project:'vision',environmentMode:'oci'}]};
      throw Error('Unexpected node operation: '+operation);
    },
    async refreshGPUQ(){return inventory;},
    maintenanceFor:()=>false,isClosing:()=>false,
    async reconcile(){calls.push({operation:'reconcile'});},
  };
  const settle=()=>new Promise(resolve=>setImmediate(resolve));
  t.after(async()=>{await settle();db.close();});
  return {user,principal,store,db,calls,dependencies,inventory,settle,
    submit:args=>submitTask(principal,structuredClone(user),args,dependencies)};
}

for(const extra of [{},{placement:{gpuIndices:[0],shared:true,vramMiB:1024}},
  {scheduling:{rank:'P2',mode:'preempt-save'}},{scheduling:{rank:'P2',mode:'preempt-now'}}]){
  test(`busy nodes still accept ${extra.scheduling?.mode??(extra.placement?'shared':'queued')} jobs for GPUQ`,async t=>{
    const f=fixture(t),job=await f.submit(request(extra));
    assert.equal(job.state,'SUBMITTING');assert.equal(job.dispatchPending,true);
    assert.equal(job.spec.workspace,true);assert.equal(Object.hasOwn(job.spec,'release'),false);
    assert.deepEqual(f.calls.map(call=>call.operation),['projects.workspace','audit']);
    assert.equal(JSON.parse(f.db.prepare('SELECT payload FROM jobs').get().payload).id,job.id);
    await f.settle();assert.equal(f.calls.at(-1).operation,'reconcile');
  });
}

test('same-key recovery is local and immutable even when the node is offline',async t=>{
  const f=fixture(t),args=request(),job=await f.submit(args);await f.settle();
  f.calls.length=0;
  f.dependencies.bridge=async()=>{throw Error('node offline');};
  f.dependencies.refreshGPUQ=async()=>{throw Error('inventory offline');};
  assert.equal(await f.submit(args),job);
  assert.equal(f.store.jobs.length,1);assert.equal(f.calls.length,0);
  await assert.rejects(f.submit({...args,argv:['different']}),error=>error.status===409&&error.code==='SUBMISSION_REJECTED');
  assert.equal(f.calls.length,0);
});

test('a confirmed non-dispatch retry observes its original ID rather than immediately resending',async t=>{
  const f=fixture(t),args=request(),job=await f.submit(args);await f.settle();
  Object.assign(job,{state:'FAILED',notSubmitted:true,failureCode:'SUBMISSION_NOT_DISPATCHED',finishedAt:'past'});
  const spec=structuredClone(job.spec);f.calls.length=0;
  const result=await f.submit(args);await f.settle();
  assert.equal(result.id,job.id);assert.deepEqual(result.spec,spec);assert.equal(result.state,'SUBMITTING');
  assert.equal(result.dispatchPending,false);assert.equal(result.error,SUBMISSION_CHECK_MESSAGE);
  assert.equal(result.submissionReconciliation.state,'CHECKING');
  assert.deepEqual(f.calls.map(call=>call.operation),['audit']);
});

test('authorization changes during workspace observation prevent a durable reservation',async t=>{
  const f=fixture(t),bridge=f.dependencies.bridge;
  f.dependencies.bridge=async(...args)=>{const result=await bridge(...args);f.user.limits={};return result;};
  await assert.rejects(f.submit(request()),error=>error.code==='SUBMISSION_REJECTED'&&error.status===409);
  assert.equal(f.store.jobs.length,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM jobs').get().n,0);
  await f.settle();assert.deepEqual(f.calls.map(call=>call.operation),['projects.workspace']);
});

test('failed persistence rolls back the task and never wakes dispatch',async t=>{
  const f=fixture(t);f.dependencies.audit=()=>{throw Error('audit write failed');};
  await assert.rejects(f.submit(request()),/audit write failed/);
  assert.equal(f.store.jobs.length,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM jobs').get().n,0);
  await f.settle();assert.deepEqual(f.calls.map(call=>call.operation),['projects.workspace']);
});

test('auto placement requires an existing workspace but not a free GPU',async t=>{
  const f=fixture(t);
  const job=await f.submit(request({machine:'auto',machineSelection:{mode:'auto',candidates:[machine]}}));
  assert.equal(job.machine,machine);assert.equal(job.selectionSummary.gpuPoolAvailable,false);
  assert.deepEqual(f.calls.map(call=>call.operation),['projects.list','projects.workspace','audit']);
  const absent=fixture(t);absent.dependencies.bridge=async()=>({projects:[]});
  await assert.rejects(absent.submit(request({machine:'auto'})),error=>error.code==='SUBMISSION_REJECTED'&&/没有这个项目工作区/.test(error.message));
  assert.equal(absent.store.jobs.length,0);
});

test('canceled or uncertain same-key jobs never create a new task or replay cancellation',async t=>{
  for(const state of ['CANCELED','UNKNOWN']){
    const f=fixture(t),args=request(),job=await f.submit(args);await f.settle();
    Object.assign(job,{state,cancelRequested:state==='CANCELED',nodeJobId:'J0123456789ab'});
    const original=structuredClone(job);f.calls.length=0;
    assert.deepEqual(await f.submit(args),original);await f.settle();
    assert.equal(f.store.jobs.length,1);assert.deepEqual(f.calls,[]);
  }
});

test('workspace reply must match the requested project and confirm persistence',async t=>{
  for(const reply of [{project:'other',state:'AVAILABLE',workspace:{persistent:true}},
    {project:'vision',state:'AVAILABLE',workspace:{persistent:false}}]){
    const f=fixture(t);f.dependencies.bridge=async()=>reply;
    await assert.rejects(f.submit(request()),error=>error.status===409&&error.code==='SUBMISSION_REJECTED');
    assert.equal(f.store.jobs.length,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM jobs').get().n,0);
  }
});
