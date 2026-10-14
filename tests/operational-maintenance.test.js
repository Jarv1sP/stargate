import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './maintenance-fixture.mjs';
import {MACHINES} from '../dist/model.js';
const machine=MACHINES[0].id,active=e=>e.status===503&&e.code==='MAINTENANCE_ACTIVE';
const set=(f,scope='all',enabled=true)=>f.call('set',{scope,enabled,...(enabled?{reason:'存储维护'}:{})},f.admin.token);
test('maintenance stays separate from account snapshots and survives a restart until explicitly cleared',async t=>{
 const f=await fixture(t),before=structuredClone(f.service.export());await set(f,machine);await set(f);
 assert.deepEqual(f.service.export(),before);await f.reopen();assert.ok(f.service.maintenanceFor(machine));
 await set(f,'all',false);assert.ok(f.service.maintenanceFor(machine));await set(f,machine,false);assert.equal(f.service.maintenanceFor(machine),null);assert.deepEqual(f.calls,[]);
});
test('only an administrator manages maintenance; unknown request fields and stale revisions are ignored',async t=>{
 const f=await fixture(t);await assert.rejects(f.call('set',{scope:'all',enabled:true,reason:'维护',hostAdmin:true}),e=>e.status===403);
 await f.call('set',{scope:'all',enabled:true,reason:'维护',revision:-100,future:true},f.admin.token);
 assert.equal((await f.call('status')).global.reason,'维护');await f.call('set',{scope:'all',enabled:false,revision:-100},f.admin.token);assert.equal(f.service.maintenanceFor(machine),null);
});
test('all team members see machine maintenance independently of their submit quota',async t=>{
 const f=await fixture(t);await set(f,machine);f.service.store.get(f.owner.id).limits={};
 assert.equal((await f.call('status')).machines[machine].reason,'存储维护');
 await assert.rejects(f.service.invoke(f.member.token,'transfers.create',{machine,from:machine,kind:'copy',reference:{dataset:'test'},key:randomUUID()}),active);assert.deepEqual(f.calls,[]);
});
test('new writes pause before node dispatch while observation, original-key cancellation and terminal polling remain available',async t=>{
 const f=await fixture(t);await set(f);
 for(const operation of ['jobs.submit','jobs.priority','terminal.open','projects.create','data.upload.begin','data.upload.chunk','data.upload.finish','datasets.delete','cloud.import.start','transfers.create'])
  await assert.rejects(f.service.invoke(f.member.token,operation,{machine,key:randomUUID()}),active,operation);
 for(const operation of ['files.list','files.get','data.upload.status','data.upload.cancel','jobs.watch','jobs.cancel','terminal.status','terminal.close','transfers.status','transfers.cancel'])
  assert.doesNotThrow(()=>f.service.assertMaintenanceAllowed(operation,{machine},f.member.principal));
 assert.deepEqual(f.calls,[]);
});
test('audit failure rolls back the maintenance change instead of silently resuming writes',async t=>{
 const f=await fixture(t);await set(f);f.service.db.exec("CREATE TRIGGER reject_maintenance_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;");
 await assert.rejects(set(f,'all',false),/audit unavailable/);assert.ok(f.service.maintenanceFor(machine));
});

test('maintenance ignores internal version labels and unknown machine metadata',async t=>{
 const f=await fixture(t),value=await f.call('status');value.version=100;value.future='ignored';value.machines.futureNode={future:true};f.service.db.prepare('UPDATE operational_maintenance_v2 SET data=? WHERE id=1').run(JSON.stringify(value));assert.deepEqual((await f.call('status')).machines,{});await set(f);assert.ok(f.service.maintenanceFor(machine));
});
