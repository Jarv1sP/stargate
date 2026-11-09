import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
import {readStorage} from '../portal-storage.mjs';

const minute=60000,machine=MACHINES[0].id;
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'storage-snapshot-')),database=join(root,'portal'),bootstrap=join(root,'bootstrap'),calls=[];
 await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Storage-Cache-Local-Fixture!'}));
 let read=async(_machine,operation)=>operation==='projects.quota'?{volumes:[{kind:'shared',fs:'11',usedBytes:3,availableBytes:9,totalBytes:12}]}:operation==='datasets.list'?{datasets:[{dataset:'images',size:null,complete:false,uploadedBy:'peer'}],complete:true}:operation==='projects.list'?{projects:[{project:'vision',ownerId:'peer',size:3,complete:false}],complete:true,checkedAt:'2026-11-07T00:00:00.000Z'}:{state:'COMPLETE',project:'vision'};
 const bridge=async(...args)=>{calls.push(structuredClone(args));return read(...args);};
 let service;
 const open=async()=>{service=await PortalService.open(database,bootstrap,undefined,bridge);clearInterval(service.executionTimer);return service;};
 await open();
 const token=()=>service.issueSession({userId:'builtin-admin',username:'admin',role:'admin'});
 t.after(async()=>{await service.storageWork;service.close();await rm(root,{recursive:true,force:true});});
 return {get service(){return service;},calls,token,read:value=>read=value,reopen:async beforeOpen=>{await service.storageWork;service.close();await beforeOpen?.(database);await open();},snapshot:async id=>(await service.invoke(token(),'storage.snapshot',id?{machine:id}:{})).result};
}

test('storage.snapshot is local, accepts extra fields, and an empty cache stays unknown',async t=>{
 const f=await fixture(t),reply=(await f.service.invoke(f.token(),'storage.snapshot',{extra:'ignored'})).result;
 assert.equal(reply.machines.length,MACHINES.length);assert.equal(f.calls.length,0);
 for(const row of reply.machines){assert.equal(row.checkedAt,null);assert.equal(row.refreshing,false);assert.equal(row.quota.checkedAt,null);assert.equal(row.datasets.complete,false);assert.equal(row.projects.complete,false);}
 await assert.rejects(f.service.invoke('not-logged-in','storage.snapshot',{}),{status:401});assert.equal(f.calls.length,0);
});

test('refresh scans only the requested server once and reuses its cache for one minute',async t=>{
 const f=await fixture(t),selected=MACHINES[1].id;let now=Date.now();t.mock.method(Date,'now',()=>now);
 const reply=(await f.service.invoke(f.token(),'storage.refresh',{machine:selected,extra:'ignored'})).result;assert.equal(reply.machines[0].refreshing,true);
 await f.service.storageWork;
 assert.deepEqual(f.calls.map(row=>[row[0],row[1]]),[[selected,'projects.quota'],[selected,'datasets.list'],[selected,'projects.list']]);assert.equal(f.calls[2][2].includeUsage,true);
 const saved=(await f.snapshot(selected)).machines[0];assert.equal(saved.quota.volumes[0].kind,'shared');assert.equal(saved.datasets.datasets[0].size,null);assert.equal(saved.projects.projects[0].complete,false);
 for(const part of ['quota','datasets','projects'])assert.ok(saved[part].checkedAt);assert.ok(saved.checkedAt);
 now+=minute-1;const cached=(await f.service.invoke(f.token(),'storage.refresh',{machine:selected})).result;assert.equal(cached.machines[0].refreshing,false);assert.equal(f.calls.length,3);
 now++;await f.service.invoke(f.token(),'storage.refresh',{machine:selected});await f.service.storageWork;assert.equal(f.calls.length,6);
});

test('queued and concurrent refresh requests scan one server at a time without duplicates',async t=>{
 const f=await fixture(t),held=deferred();let active=0,max=0;
 f.read(async(host,operation)=>{active++;max=Math.max(max,active);if(host===machine&&operation==='datasets.list')await held.promise;active--;return operation==='projects.quota'?{volumes:[]}:operation==='datasets.list'?{datasets:[]}:{projects:[]};});
 await f.service.invoke(f.token(),'storage.refresh',{machine});
 await f.service.invoke(f.token(),'storage.refresh',{machine});
 await f.service.invoke(f.token(),'storage.refresh',{machine:MACHINES[1].id});
 assert.equal((await f.snapshot(MACHINES[1].id)).machines[0].refreshing,true);
  const tick=f.service.refreshStorage(true);
  held.resolve();await tick;assert.equal(max,1);assert.equal(f.calls.length,6);
 assert.deepEqual(f.calls.map(row=>row[0]),[machine,machine,machine,...Array(3).fill(MACHINES[1].id)]);
});

test('periodic refresh reads disks, datasets and projects together every five minutes, staggered by server',async t=>{
 let now=Date.now();t.mock.method(Date,'now',()=>now);const f=await fixture(t),start=now;
 await f.service.refreshStorage(true);assert.deepEqual(f.calls.map(row=>[row[0],row[1]]),[[machine,'projects.quota'],[machine,'datasets.list'],[machine,'projects.list']]);
 now=start+5*minute/MACHINES.length;await f.service.refreshStorage(true);assert.deepEqual(f.calls.filter(row=>row[1]==='projects.list').map(row=>row[0]),[machine,MACHINES[1].id]);
 now=start+5*minute-1;await f.service.refreshStorage(true);assert.equal(f.calls.filter(row=>row[0]===machine).length,3);
 now=start+5*minute;await f.service.refreshStorage(true);for(const operation of ['projects.quota','datasets.list','projects.list'])assert.equal(f.calls.filter(row=>row[0]===machine&&row[1]===operation).length,2,operation);
});

test('a restarted Portal refreshes restored snapshots one server at a time from a minute after start and saves once per pass',async t=>{
 let now=Date.now();t.mock.method(Date,'now',()=>now);const f=await fixture(t);
 const saves=t.mock.method(f.service,'save');for(const {id} of MACHINES)f.service.scheduleStorageRefresh(id,0);await f.service.refreshStorage();
 assert.equal(f.calls.length,3*MACHINES.length);assert.equal(saves.mock.callCount(),1);
 for(const {id} of MACHINES)f.service.storageSnapshots[id].scannedAt=new Date(now-10*minute).toISOString();f.service.save();
 await f.reopen();f.calls.length=0;
 await f.service.refreshStorage(true);assert.equal(f.calls.length,0);
 now+=minute;await f.service.refreshStorage(true);assert.deepEqual([...new Set(f.calls.map(row=>row[0]))],[machine]);
 await f.service.invoke(f.token(),'storage.refresh',{machine:MACHINES[1].id});await f.service.storageWork;
 assert.deepEqual([...new Set(f.calls.map(row=>row[0]))],[machine,MACHINES[1].id]);
});

test('dataset upload completion and project changes schedule one debounced refresh',async t=>{
 const f=await fixture(t);let now=Date.now();t.mock.method(Date,'now',()=>now);
 const call=(operation,args)=>f.service.invoke(f.token(),operation,{machine,...args});
 await call('data.upload.finish',{area:'dataset',dataset:'images',key:randomUUID()});
 assert.equal((await f.snapshot(machine)).machines[0].refreshing,true);assert.equal(f.calls.length,1);
 now+=20000;await call('projects.create',{project:'vision'});now+=29999;await f.service.refreshStorage();assert.equal(f.calls.length,2);
 now++;await f.service.refreshStorage();assert.equal(f.calls.filter(row=>row[1]==='datasets.list').length,1);
 f.read(async()=>({state:'TRASHED'}));await call('datasets.delete',{dataset:'images',key:randomUUID()});await call('projects.retire',{project:'vision',key:randomUUID()});
 now+=30000;await f.service.refreshStorage();assert.equal(f.calls.filter(row=>row[1]==='datasets.list').length,2);
});

test('failed writes and unfinished uploads do not schedule size scans',async t=>{
 const f=await fixture(t);f.read(async()=>({state:'UNKNOWN'}));
 await f.service.invoke(f.token(),'data.upload.finish',{machine,area:'dataset',dataset:'images',key:randomUUID()});
 f.read(async()=>{throw Error('node unavailable');});await assert.rejects(f.service.invoke(f.token(),'projects.create',{machine,project:'vision'}));
 assert.equal((await f.snapshot(machine)).machines[0].refreshing,false);
});

test('cache survives Portal restart without node reads and preserves partial and unknown sizes',async t=>{
 const f=await fixture(t);await f.service.invoke(f.token(),'storage.refresh',{machine});await f.service.storageWork;
 const before=await f.snapshot(machine);await f.reopen();f.calls.length=0;
 assert.deepEqual(await f.snapshot(machine),before);assert.equal(f.calls.length,0);
 await f.service.invoke(f.token(),'storage.refresh',{machine});assert.equal(f.calls.length,0);
});

test('current saved snapshots move out of account/job state without losing readings or unknown fields',async t=>{
 const f=await fixture(t);await f.service.invoke(f.token(),'storage.refresh',{machine});await f.service.storageWork;
 const reading=readStorage(f.service,machine);reading.projects.extra={futureField:['kept',null]};
 const state={...f.service.export(),storage:{[machine]:reading}};
 f.service.db.prepare('UPDATE portal_state_v2 SET data=? WHERE id=1').run(JSON.stringify(state));
 f.service.db.exec('DELETE FROM portal_storage');
 await f.reopen();f.calls.length=0;
 const before=await f.snapshot(machine);
 assert.equal(f.calls.length,0);assert.deepEqual(before.machines[0].projects.extra,{futureField:['kept',null]});
 assert.equal(before.machines[0].datasets.datasets[0].size,null);
 assert.equal(JSON.parse(f.service.db.prepare('SELECT data FROM portal_state_v2 WHERE id=1').get().data).storage,undefined);
 f.service.save();await f.reopen();assert.deepEqual(await f.snapshot(machine),before);
});

test('deploy, rollback with an offline node, and redeploy retain good stored readings with the failure',async t=>{
 let now=Date.now();t.mock.method(Date,'now',()=>now);const f=await fixture(t);
 for(const {id} of MACHINES)f.service.scheduleStorageRefresh(id,0);await f.service.refreshStorage();
 const readings=Object.fromEntries(MACHINES.map(({id})=>[id,readStorage(f.service,id)]));
 // Start with the state format written by the release before this PR.
 f.service.db.prepare('UPDATE portal_state_v2 SET data=? WHERE id=1').run(JSON.stringify({...f.service.export(),storage:readings}));
 f.service.db.exec('DELETE FROM portal_storage');await f.reopen();
 const before=await f.snapshot(),error='暂时读不到，请稍后刷新。';now+=5*minute;
 // Only the old release's database connection is open during rollback. It
 // restores no inline readings, then persists a failed refresh for one node.
 await f.reopen(database=>{
  const db=new DatabaseSync(database);
  try{
   const state=JSON.parse(db.prepare('SELECT data FROM portal_state_v2 WHERE id=1').get().data);
   assert.equal(state.storage,undefined);state.storage=state.storage||{};
   state.storage[machine]={quota:{error},datasets:{error},projects:{error},scannedAt:new Date(now).toISOString()};
   db.prepare('UPDATE portal_state_v2 SET data=? WHERE id=1').run(JSON.stringify(state));
  }finally{db.close();}
 });
 const restored=(await f.snapshot(machine)).machines[0],saved=before.machines[0];
 assert.equal(restored.checkedAt,saved.checkedAt);
 for(const part of ['quota','datasets','projects'])assert.deepEqual(restored[part],{...saved[part],error});
 assert.deepEqual((await f.snapshot()).machines.slice(1),before.machines.slice(1),'unrefreshed nodes retain their readings');
 assert.equal(JSON.parse(f.service.db.prepare('SELECT data FROM portal_state_v2 WHERE id=1').get().data).storage,undefined);
 f.read(async()=>{throw Error('node remains offline');});f.service.scheduleStorageRefresh(machine,0);await f.service.refreshStorage();
 await f.reopen();assert.deepEqual((await f.snapshot(machine)).machines[0],restored,'offline refresh and restart keep the recovered readings');
});

test('redeploy migration merges partial failures and never replaces newer checked readings with older ones',async t=>{
 const f=await fixture(t);for(const {id} of MACHINES)f.service.scheduleStorageRefresh(id,0);await f.service.refreshStorage();
 const stored=Object.fromEntries(MACHINES.map(({id})=>[id,readStorage(f.service,id)]));
 const incoming=structuredClone(stored),older='2026-11-06T00:00:00.000Z',newer='2099-01-01T00:00:00.000Z';
 incoming[machine].checkedAt=older;incoming[machine].quota.volumes=[];incoming[machine].datasets.datasets=[];incoming[machine].projects.projects=[];
 const selected=MACHINES[1].id,error='暂时读不到，请稍后刷新。';
 incoming[selected]={...incoming[selected],checkedAt:newer,quota:{volumes:[],checkedAt:newer},datasets:{error},projects:{projects:[],checkedAt:older}};
 f.service.db.prepare('UPDATE portal_state_v2 SET data=? WHERE id=1').run(JSON.stringify({...f.service.export(),storage:incoming}));
 await f.reopen();
 assert.deepEqual(readStorage(f.service,machine),stored[machine],'an older row cannot replace a newer reading');
 const merged=readStorage(f.service,selected);
 assert.equal(merged.checkedAt,newer);assert.deepEqual(merged.quota,incoming[selected].quota,'a newer empty reading is valid');
 assert.deepEqual(merged.datasets,{...stored[selected].datasets,error});assert.deepEqual(merged.projects,stored[selected].projects);
 await f.reopen();assert.deepEqual(readStorage(f.service,selected),merged);
});

test('editing a returned snapshot cannot change the persisted readings',async t=>{
 const f=await fixture(t);await f.service.invoke(f.token(),'storage.refresh',{machine});await f.service.storageWork;
 const before=await f.snapshot(machine),changed=await f.snapshot(machine);
 changed.machines[0].quota.volumes[0].usedBytes=999;
 changed.machines[0].datasets.datasets[0].dataset='changed';changed.machines[0].projects.projects[0].size=999;
 assert.deepEqual(await f.snapshot(machine),before);
});

test('snapshots pass through project parts, every disk composition and the node sample time, with owner names',async t=>{
 const f=await fixture(t),outputs={size:17,complete:true,count:2},environment={size:31,complete:true},checkedAt='2026-11-07T00:00:00.000Z';
 const disks=[{mountPoint:'/fixture/data0',totalBytes:100,usedBytes:60,availableBytes:40,media:'ssd',roles:['workspace'],accounting:'quota',trashBytes:5,futureField:'kept',items:[
  {kind:'project',ownerId:'builtin-admin',project:'vision',files:3,outputs:17,environment:31},{kind:'images',ownerId:'gone',bytes:4},{kind:'external',path:'/fixture/data0/cyx',bytes:2},{kind:'filesystem',bytes:3}]},
  {mountPoint:'/fixture/data1',totalBytes:100,usedBytes:null,availableBytes:null,media:null,roles:['datasets'],accounting:'unavailable',items:[]}];
 f.read(async(_host,operation)=>operation==='projects.list'?{projects:[{project:'vision',ownerId:'builtin-admin',size:3,complete:true,outputs,environment}],disks,checkedAt,complete:true}:operation==='projects.quota'?{volumes:[]}:{datasets:[]});
 await f.service.invoke(f.token(),'storage.refresh',{machine});await f.service.storageWork;
 const before=(await f.snapshot(machine)).machines[0].projects;
 assert.equal(before.checkedAt,checkedAt,'the node sample time, not the Portal read time');
 assert.deepEqual(before.projects[0].outputs,outputs);assert.deepEqual(before.projects[0].environment,environment);
 assert.equal(before.disks.length,2);assert.equal(before.disks[0].futureField,'kept');assert.deepEqual(before.disks[1],disks[1]);
 assert.deepEqual(before.disks[0].items.map(item=>item.ownerName),['管理员',null,undefined,undefined]);
 assert.equal('areas' in before,false);
 await f.reopen();assert.deepEqual((await f.snapshot(machine)).machines[0].projects,before);
 // A node without a sample says so; the Portal does not substitute its own read time.
 f.read(async(_host,operation)=>operation==='projects.list'?{projects:[],disks:[],checkedAt:null}:operation==='projects.quota'?{volumes:[]}:{datasets:[]});
 f.service.scheduleStorageRefresh(machine,0);await f.service.refreshStorage();
 assert.equal((await f.snapshot(machine)).machines[0].projects.checkedAt,null);
});

test('a failed refresh retains the last readings and timestamps with an error, never invented zeros',async t=>{
 const f=await fixture(t);let now=Date.now();t.mock.method(Date,'now',()=>now);
 await f.service.invoke(f.token(),'storage.refresh',{machine});await f.service.storageWork;const saved=(await f.snapshot(machine)).machines[0];
 now+=5*minute;f.read(async()=>{throw Error('node offline');});await f.service.invoke(f.token(),'storage.refresh',{machine});await f.service.storageWork;
 const failed=(await f.snapshot(machine)).machines[0];assert.equal(failed.refreshing,false);assert.equal(failed.checkedAt,saved.checkedAt);
 for(const part of ['quota','datasets','projects']){assert.equal(failed[part].checkedAt,saved[part].checkedAt);assert.ok(failed[part].error);}
 assert.equal(failed.datasets.datasets[0].size,null);assert.equal(failed.quota.volumes[0].usedBytes,3);
});
