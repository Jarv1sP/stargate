import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
import {seedAccounts} from './fixtures/accounts.mjs';
const DAY=86400000;
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'portal-job-history-')),bootstrap=join(root,'bootstrap');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Synthetic-History-Test-Only!'}));
  const calls=[],service=await PortalService.open(join(root,'db'),bootstrap,undefined,async(machine,operation,args)=>{
    calls.push({machine,operation,args});
    return operation==='files.get'?{data:Buffer.from('kept output').toString('base64'),eof:true}:operation==='logs'?{text:'kept log'}:
      {state:'PENDING',nodeJobId:'J'+args.job.id.replaceAll('-','').slice(-12),assignedIndices:[]};
  });
  clearInterval(service.executionTimer);service.reconciling=true;
  const member={id:'member',username:'member',name:'Member',role:'member',enabled:true,total:1,limits:{[MACHINES[0].id]:1}};
  seedAccounts(service,member);
  const principal={userId:'builtin-admin',username:'admin',role:'admin'},token=service.issueSession(principal);
  const memberToken=service.issueSession({userId:member.id,username:member.username,role:'member'});
  t.after(async()=>{await service.tail;service.close();await rm(root,{recursive:true,force:true});});
  function add({state='SUCCEEDED',age=31,machine=MACHINES[0].id}={}){
    const id=randomUUID(),row={id,key:randomUUID(),userId:'builtin-admin',ownerId:'builtin-admin',machine,project:'fixture',name:'history fixture',cards:1,state,
      nodeJobId:'J'+id.replaceAll('-','').slice(-12),createdAt:new Date(Date.now()-90*DAY).toISOString(),finishedAt:new Date(Date.now()-age*DAY).toISOString(),
      spec:{id,userId:'builtin-admin',username:'admin',project:'fixture',cards:1,argv:['python','train.py']}};
    service.store.jobs.push(row);service.save(row);return row;
  }
  const collect=now=>{service.nextHistoryCollection=0;return service.collectJobHistory(now);};
  return {service,calls,principal,token,memberToken,add,collect};
}
test('history trash follows server grants, permits team restore and never dispatches work',async t=>{
  const f=await fixture(t),own=f.add(),hidden=f.add({machine:MACHINES[1].id});f.collect(Date.now());
  const list=(await f.service.invoke(f.memberToken,'jobs.history.list')).result;
  assert.deepEqual(list.jobs.map(j=>j.id),[own.id]);assert.equal(list.retentionDays,30);assert.equal(list.trashDays,7);
  await assert.rejects(f.service.invoke(f.memberToken,'jobs.history.list',{machine:hidden.machine}),e=>e.status===403);
  await assert.rejects(f.service.invoke(f.memberToken,'jobs.history.restore',{jobId:hidden.id}),e=>e.status===403);
  const result=(await f.service.invoke(f.memberToken,'jobs.history.restore',{jobId:own.id})).result;
  assert.equal(result.restored,true);assert.equal(f.service.job(own.id).state,'SUCCEEDED');
  assert.deepEqual(f.service.job(own.id).spec,own.spec);assert.equal(f.service.store.jobs.length,0);
  await f.service.invoke(f.memberToken,'jobs.history.restore',{jobId:own.id});
  assert.deepEqual(f.calls,[]);
});
test('expired detail cannot duplicate original submissions and output locations remain available',async t=>{
  const f=await fixture(t),row=f.add(),now=Date.now();f.collect(now);f.collect(now+7*DAY);
  assert.equal(f.service.job(row.id),undefined);
  const result=(await f.service.invoke(f.token,'jobs.submit',{machine:row.machine,project:'fixture',cards:1,key:row.key,argv:['must-not-run']})).result;
  assert.equal(result.id,row.id);assert.equal(result.state,'SUCCEEDED');assert.equal(result.historyExpired,true);
  assert.equal(f.service.db.prepare('SELECT count(*) n FROM portal_jobs').get().n,1);assert.deepEqual(f.calls,[]);
  const keyed=(await f.service.invoke(f.token,'state',{jobKey:row.key})).state.jobs;
  assert.equal(keyed[0].id,row.id);assert.equal(keyed[0].historyExpired,true);
  const located=(await f.service.invoke(f.token,'state',{view:'summary',jobId:row.id})).state.jobs[0];
  assert.equal(located.project,'fixture');assert.equal(located.machine,row.machine);
  const file=(await f.service.invoke(f.memberToken,'files.get',{machine:row.machine,project:'fixture',area:'output',runId:row.id,path:'result'})).result;
  assert.equal(Buffer.from(file.data,'base64').toString(),'kept output');
  await assert.rejects(f.service.invoke(f.token,'jobs.logs',{jobId:row.id}),e=>e.status===410&&e.code==='JOB_HISTORY_EXPIRED');
  assert.ok(f.calls.every(call=>call.operation==='files.get'));
});
test('dependency outcomes and native IDs survive detail expiry',async t=>{
  const f=await fixture(t),parent=f.add(),failed=f.add({state:'FAILED'}),now=Date.now();f.collect(now);f.collect(now+7*DAY);
  const child=(await f.service.invoke(f.token,'jobs.submit',{machine:parent.machine,project:'fixture',cards:1,key:randomUUID(),argv:['true'],after:[parent.id]})).result;
  const canceled=(await f.service.invoke(f.token,'jobs.submit',{machine:parent.machine,project:'fixture',cards:1,key:randomUUID(),argv:['true'],after:[failed.id]})).result;
  f.service.reconciling=false;await f.service.reconcile();
  assert.deepEqual(f.calls.find(call=>call.args.job?.id===child.id).args.job.after,[parent.nodeJobId]);
  assert.equal(f.service.job(canceled.id).state,'CANCELED');
  assert.equal(f.calls.some(call=>call.args.job?.id===canceled.id),false);
});
test('running, pending and unknown records survive retention and maintenance pauses collection',async t=>{
  const f=await fixture(t),rows=['RUNNING','PENDING','UNKNOWN'].map(state=>f.add({state,age:100})),old=f.add();
  await f.service.invoke(f.token,'maintenance.set',{scope:'all',enabled:true,reason:'fixture migration'});
  assert.equal(f.collect(Date.now()),undefined);assert.deepEqual(f.service.job(old.id).spec,old.spec);
  await f.service.invoke(f.token,'maintenance.set',{scope:'all',enabled:false});
  f.collect(Date.now());f.collect(Date.now()+8*DAY);
  for(const row of rows)assert.equal(f.service.job(row.id).state,row.state);
  assert.equal(f.service.job(old.id),undefined);
});
