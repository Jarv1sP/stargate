import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
import {gpuCardUsage} from '../dist/gpu-allocation.js';
import {seedAccounts} from './fixtures/accounts.mjs';

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'terminal-quota-')),bootstrap=join(root,'bootstrap'),database=join(root,'db');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Synthetic-Draining-Quota-Only!'}));
  const machine=MACHINES[0].id,id=randomUUID(),calls=[];
  let result={nodeJobId:'J0123456789ab',state:'CANCELED',assignedIndices:[],
    latestAttempt:{id:'A-finished',ordinal:1,state:'CANCELED',started_at:10,finished_at:20,exit_code:0}};
  const service=await PortalService.open(database,bootstrap,undefined,async(host,operation,args)=>{
    calls.push({host,operation,args});return args.job.id===id?result:{state:'PENDING',nodeJobId:'J111111111111',assignedIndices:[]};
  });clearInterval(service.executionTimer);service.reconciling=true;
  const user={id:'quota-member',username:'quota-member',name:'Quota',enabled:true,role:'member',total:1,limits:{[machine]:1}};
  seedAccounts(service,user);const token=service.issueSession({userId:user.id,username:user.username,role:user.role});
  const job={id,key:randomUUID(),userId:user.id,ownerId:user.id,machine,project:'fixture',name:'finished',state:'CANCELED',
    cancelRequested:true,cards:1,nodeJobId:'J0123456789ab',assignedIndices:[0],createdAt:new Date().toISOString(),finishedAt:new Date().toISOString(),
    latestAttempt:{id:'A-finished',ordinal:1,state:'DRAINING',startedAt:10,finishedAt:null},
    spec:{id,userId:user.id,project:'fixture',cards:1,argv:['true']}};
  service.store.jobs.push(job);service.save(job);
  t.after(async()=>{await service.tail;service.close();await rm(root,{recursive:true,force:true});});
  return {service,job,user,token,machine,calls,database,result:value=>result=value,
    call:operation=>service.invoke(token,operation,{jobId:id}),
    quota:()=>gpuCardUsage(service.store.jobs,user.id),
    reconcile:async()=>{service.reconciling=false;await service.reconcile();}};
}

for(const operation of ['jobs.watch','jobs.completion','jobs.reconcile-resources'])test(operation+' releases confirmed draining quota without changing historical outcome',async t=>{
  const f=await fixture(t),history=structuredClone(f.job);assert.equal(f.quota(),1);
  await f.call(operation);assert.equal(f.quota(),0);assert.equal(f.service.store.jobs.length,0);
  const saved=f.service.job(f.job.id);assert.deepEqual(saved,{...history,resourcesReleased:true});
  assert.equal(f.service.jobRows.loadLive().length,0,'release survives a reload');
  assert.equal(f.calls.length,1);assert.ok(['watch','jobs.reconcile-resources'].includes(f.calls[0].operation));
});

test('background observation releases quota and dispatches waiting work without resubmitting or canceling the ended task',async t=>{
  const f=await fixture(t),next=(await f.service.invoke(f.token,'jobs.submit',{machine:f.machine,project:'fixture',cards:1,key:randomUUID(),argv:['true']})).result;
  await f.reconcile();await f.reconcile();
  assert.equal(f.service.job(next.id).state,'PENDING');
  assert.equal(f.service.job(f.job.id).resourcesReleased,true);
  assert.deepEqual(f.calls.filter(c=>c.args.job.id===f.job.id).map(c=>c.operation),['watch']);
  assert.ok(f.calls.some(c=>c.args.job.id===next.id&&c.operation==='sync'));
});

test('unknown, still-draining, unfinished and running node reports do not release resources',async t=>{
  const f=await fixture(t);
  for(const result of [{state:'UNKNOWN'},
    {state:'CANCELED',latestAttempt:{state:'DRAINING',finished_at:20}},
    {state:'CANCELED',latestAttempt:{state:'CANCELED',finished_at:null}},
    {state:'RUNNING',latestAttempt:{state:'CANCELED',finished_at:20}}]){
    f.result(result);await f.call('jobs.watch');assert.equal(f.quota(),1);assert.equal(f.job.resourcesReleased,undefined);
  }
});

test('failed release persistence retains quota and the live record',async t=>{
  const f=await fixture(t);
  f.service.db.exec("CREATE TRIGGER fail_release BEFORE UPDATE ON portal_jobs BEGIN SELECT RAISE(ABORT,'fixture write failed'); END");
  await assert.rejects(f.call('jobs.reconcile-resources'),/fixture write failed/);
  assert.equal(f.quota(),1);assert.equal(f.job.resourcesReleased,undefined);
  assert.equal(f.service.jobRows.loadLive().length,1);
});

test('maintenance and shutdown do not mutate terminal resource records',async t=>{
  const f=await fixture(t);f.service.maintenanceFor=()=>true;await f.reconcile();assert.deepEqual(f.calls,[]);
  f.service.closing=true;await f.reconcile();assert.equal(f.quota(),1);assert.deepEqual(f.calls,[]);
});
