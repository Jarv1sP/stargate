import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';

const minute=60000,machine=MACHINES[0].id;
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'storage-snapshot-')),database=join(root,'portal'),bootstrap=join(root,'bootstrap'),calls=[];
 await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Storage-Cache-Local-Fixture!'}));
 let read=async(_machine,operation)=>operation==='projects.quota'?{volumes:[{kind:'shared',fs:'11',usedBytes:3,availableBytes:9,totalBytes:12}]}:operation==='datasets.list'?{datasets:[{dataset:'images',size:null,complete:false,uploadedBy:'peer'}],complete:true}:operation==='projects.list'?{projects:[{project:'vision',ownerId:'peer',size:3,complete:false}],complete:true}:{state:'COMPLETE',project:'vision'};
 const bridge=async(...args)=>{calls.push(structuredClone(args));return read(...args);};
 let service;
 const open=async()=>{service=await PortalService.open(database,bootstrap,undefined,bridge);clearInterval(service.executionTimer);return service;};
 await open();
 const token=()=>service.issueSession({userId:'builtin-admin',username:'admin',role:'admin'});
 t.after(async()=>{await service.storageWork;service.close();await rm(root,{recursive:true,force:true});});
 return {get service(){return service;},calls,token,read:value=>read=value,reopen:async()=>{await service.storageWork;service.close();await open();},snapshot:async id=>(await service.invoke(token(),'storage.snapshot',id?{machine:id}:{})).result};
}

test('storage.snapshot is local, accepts extra fields, and an empty cache stays unknown',async t=>{
 const f=await fixture(t),reply=(await f.service.invoke(f.token(),'storage.snapshot',{extra:'ignored'})).result;
 assert.equal(reply.machines.length,MACHINES.length);assert.equal(f.calls.length,0);
 for(const row of reply.machines){assert.equal(row.checkedAt,null);assert.equal(row.refreshing,false);assert.equal(row.quota.checkedAt,null);assert.equal(row.datasets.complete,false);assert.equal(row.projects.complete,false);}
 await assert.rejects(f.service.invoke('not-logged-in','storage.snapshot',{}),{status:401});assert.equal(f.calls.length,0);
});

test('refresh scans only the requested server once and reuses its cache for five minutes',async t=>{
 const f=await fixture(t),selected=MACHINES[1].id;let now=Date.now();t.mock.method(Date,'now',()=>now);
 const reply=(await f.service.invoke(f.token(),'storage.refresh',{machine:selected,extra:'ignored'})).result;assert.equal(reply.machines[0].refreshing,true);
 await f.service.storageWork;
 assert.deepEqual(f.calls.map(row=>[row[0],row[1]]),[[selected,'projects.quota'],[selected,'datasets.list'],[selected,'projects.list']]);assert.equal(f.calls[2][2].includeUsage,true);
 const saved=(await f.snapshot(selected)).machines[0];assert.equal(saved.quota.volumes[0].kind,'shared');assert.equal(saved.datasets.datasets[0].size,null);assert.equal(saved.projects.projects[0].complete,false);
 for(const part of ['quota','datasets','projects'])assert.ok(saved[part].checkedAt);assert.ok(saved.checkedAt);
 now+=5*minute-1;const cached=(await f.service.invoke(f.token(),'storage.refresh',{machine:selected})).result;assert.equal(cached.machines[0].refreshing,false);assert.equal(f.calls.length,3);
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

test('periodic usage scans are staggered by server; quota alone updates every five minutes',async t=>{
 let now=Date.now();t.mock.method(Date,'now',()=>now);const f=await fixture(t),start=now;
 await f.service.refreshStorage(true);assert.deepEqual(f.calls.filter(row=>row[1]==='datasets.list').map(row=>row[0]),[machine]);
 now=start+5*minute;await f.service.refreshStorage(true);assert.equal(f.calls.filter(row=>row[0]===machine&&row[1]==='projects.quota').length,2);assert.equal(f.calls.filter(row=>row[1]==='datasets.list').length,1);
 now=start+30*minute/MACHINES.length;await f.service.refreshStorage(true);assert.deepEqual(f.calls.filter(row=>row[1]==='datasets.list').map(row=>row[0]),[machine,MACHINES[1].id]);
 now=start+30*minute;await f.service.refreshStorage(true);assert.equal(f.calls.filter(row=>row[0]===machine&&row[1]==='datasets.list').length,2);
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

test('project presentation and persisted storage snapshots pass through environment, outputs and all area readings',async t=>{
 const f=await fixture(t),outputs={size:17,complete:false,count:2},environment={size:31,complete:false},areasCheckedAt='2026-10-20T00:00:00.000Z';
 const areas={outputs:{size:23,complete:true},environments:{size:null,complete:false},trash:{size:5,complete:true},temporary:{size:7,complete:true}};
 f.read(async(_host,operation)=>operation==='projects.list'?{projects:[{project:'vision',ownerId:'peer',size:3,complete:true,outputs,environment}],areas,areasCheckedAt,complete:true}:operation==='projects.quota'?{volumes:[]}:{datasets:[]});
 await f.service.invoke(f.token(),'storage.refresh',{machine});await f.service.storageWork;
 const before=(await f.snapshot(machine)).machines[0].projects;
 assert.deepEqual(before.areas,areas);assert.deepEqual(before.projects[0].outputs,outputs);
 assert.deepEqual(before.projects[0].environment,environment);
 assert.equal(before.areasCheckedAt,areasCheckedAt);
 const direct=(await f.service.invoke(f.token(),'projects.list',{machine,includeUsage:true})).result;
 assert.deepEqual(direct.areas,areas);assert.deepEqual(direct.projects[0].outputs,outputs);
 assert.deepEqual(direct.projects[0].environment,environment);
 assert.equal(direct.areasCheckedAt,areasCheckedAt);
 await f.reopen();assert.deepEqual((await f.snapshot(machine)).machines[0].projects,before);
});

test('a failed refresh retains the last readings and timestamps with an error, never invented zeros',async t=>{
 const f=await fixture(t);let now=Date.now();t.mock.method(Date,'now',()=>now);
 await f.service.invoke(f.token(),'storage.refresh',{machine});await f.service.storageWork;const saved=(await f.snapshot(machine)).machines[0];
 now+=5*minute;f.read(async()=>{throw Error('node offline');});await f.service.invoke(f.token(),'storage.refresh',{machine});await f.service.storageWork;
 const failed=(await f.snapshot(machine)).machines[0];assert.equal(failed.refreshing,false);assert.equal(failed.checkedAt,saved.checkedAt);
 for(const part of ['quota','datasets','projects']){assert.equal(failed[part].checkedAt,saved[part].checkedAt);assert.ok(failed[part].error);}
 assert.equal(failed.datasets.datasets[0].size,null);assert.equal(failed.quota.volumes[0].usedBytes,3);
});
