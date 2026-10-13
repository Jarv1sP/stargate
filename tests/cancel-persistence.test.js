// Original main, fixed machines only. Real temporary SQLite; no notes/fleet APIs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
import {usage} from '../execution.mjs';
const password='Main-Cancel-Persistence-Fixture-2026!';
async function fixture(t,pending=false){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-main-cancel-')),database=join(dir,'db'),bootstrap=join(dir,'bootstrap'),status=join(dir,'status'),calls=[];await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,gpus:Array.from({length:m.cards},(_,index)=>({index,memoryTotalMiB:32768})),gpuq:{connected:true,observeOnly:false,jobs:[]}}))}));
  let drain=false,s,admin;
  const bridge=async(machine,operation,args)=>{
    if(operation==='projects.workspace'){
      assert.deepEqual(args,{project:'training',userId:'builtin-admin'});
      return {project:args.project,state:'AVAILABLE',workspace:{protocol:1,persistent:true}};
    }
    assert.ok(['sync','cancel'].includes(operation),'workspace tasks do not prepare data or publish releases');
    calls.push({machine,operation,args:structuredClone(args)});return {nodeJobId:'Jmain',state:operation==='cancel'?(drain?'CANCELED':'UNKNOWN'):'PENDING',assignedIndices:[]};
  };
  const open=async bootstrapPath=>{s=await PortalService.open(database,bootstrapPath,status,bridge);clearInterval(s.executionTimer);s.reconciling=true;admin=await s.login('admin',password);};await open(bootstrap);
  const id=(await s.invoke(admin.token,'jobs.submit',{machine:'gpu-1',project:'training',cards:1,argv:['true'],key:randomUUID()})).result.id;
  const step=async()=>{s.reconciling=false;try{await s.reconcile();}finally{s.reconciling=true;}};if(pending)await step();
  t.after(async()=>{s.close();await rm(dir,{recursive:true,force:true});});return {get s(){return s},get admin(){return admin},id,calls,job:()=>s.store.jobs.find(j=>j.id===id),cancel:()=>s.invoke(admin.token,'jobs.cancel',{jobId:id}),step,reopen:async()=>{s.close();await open();},drained:()=>{drain=true;}};
}
for(const pending of [false,true])for(const failure of ['save','audit'])test(`${pending?'pending':'not dispatched'} cancellation ${failure} failure rolls back intent, audit and memory; reopen preserves state/quota`,async t=>{
  const f=await fixture(t,pending),job=f.job(),before=structuredClone(job),bytes=f.s.db.prepare('SELECT data FROM portal_state WHERE id=1').get().data,callCount=f.calls.length;
  f.s.db.exec(failure==='save'?`CREATE TRIGGER fail_cancel BEFORE UPDATE ON portal_state WHEN instr(NEW.data,'"cancelRequested":true')>0 BEGIN SELECT RAISE(ABORT,'cancel save failure'); END`:`CREATE TRIGGER fail_cancel BEFORE INSERT ON audit WHEN NEW.operation='jobs.cancel' BEGIN SELECT RAISE(ABORT,'cancel audit failure'); END`);
  await assert.rejects(f.cancel(),new RegExp('cancel '+failure+' failure'));assert.equal(f.job(),job);assert.deepEqual(job,before);assert.equal(f.s.db.prepare('SELECT data FROM portal_state WHERE id=1').get().data,bytes);assert.equal(f.s.db.prepare("SELECT count(*) n FROM audit WHERE operation='jobs.cancel'").get().n,0);assert.equal(f.calls.length,callCount);assert.equal(usage(f.s.store.jobs,'builtin-admin'),1);assert.equal(usage(f.s.store.jobs,'builtin-admin','gpu-1'),1);
  const view=f.s.state(f.admin.principal).jobs.find(j=>j.id===f.id);assert.equal(view.state,before.state);assert.equal(view.cancelRequested,false);
  f.s.db.exec('DROP TRIGGER fail_cancel');await f.reopen();assert.equal(f.job().state,before.state);assert.equal(f.job().cancelRequested,false);assert.equal(usage(f.s.store.jobs,'builtin-admin'),1);await f.step();assert.equal(f.calls.slice(callCount).every(c=>c.operation==='sync'),true,'failed cancel must not be retried by lifecycle reconciliation');
});
test('committed cancel intent survives reopen and retains quota until the selected node confirms stop',async t=>{
  const f=await fixture(t,true),spec=structuredClone(f.job().spec),digest=f.job().digest;const reply=(await f.cancel()).result;assert.equal(reply.cancelRequested,true);assert.equal(reply.state,'PENDING');assert.equal(usage(f.s.store.jobs,'builtin-admin'),1);await f.reopen();assert.equal(f.job().cancelRequested,true);await f.step();assert.equal(f.job().state,'UNKNOWN');assert.equal(usage(f.s.store.jobs,'builtin-admin'),1);assert.deepEqual(f.job().spec,spec);assert.equal(f.job().digest,digest);f.drained();await f.step();assert.equal(f.job().state,'CANCELED');assert.equal(usage(f.s.store.jobs,'builtin-admin'),0);assert.equal(f.calls.filter(c=>c.operation==='cancel').every(c=>c.machine==='gpu-1'&&c.args.job.id===f.id),true);
});
test('already-terminal cancel returns durable state without writing another intent/audit or scheduling control',async t=>{
  const f=await fixture(t,true);f.drained();await f.cancel();await f.step();const before=structuredClone(f.job()),bytes=f.s.db.prepare('SELECT data FROM portal_state WHERE id=1').get().data,calls=f.calls.length,audit=f.s.db.prepare("SELECT count(*) n FROM audit WHERE operation='jobs.cancel'").get().n;assert.equal((await f.cancel()).result.state,'CANCELED');assert.deepEqual(f.job(),before);assert.equal(f.s.db.prepare('SELECT data FROM portal_state WHERE id=1').get().data,bytes);assert.equal(f.calls.length,calls);assert.equal(f.s.db.prepare("SELECT count(*) n FROM audit WHERE operation='jobs.cancel'").get().n,audit);
});
