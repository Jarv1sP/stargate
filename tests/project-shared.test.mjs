import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';

const machine=MACHINES[0].id,otherMachine=MACHINES[1].id;
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'project-shared-')),database=join(root,'portal'),bootstrap=join(root,'bootstrap'),calls=[],projects=new Map(),trash=new Map();
 const password='Project-Shared-Local-Fixture!';
 await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
 let service,override;
 const bridge=async(host,operation,args)=>{
  calls.push({host,operation,args:structuredClone(args)});
  const value=await override?.(host,operation,args);if(value!==undefined)return value;
  const id=[host,args.ownerId,args.project].join(':');
  if(operation==='projects.create'){assert.equal(Object.hasOwn(args,'shared'),false);const row={project:args.project,ownerId:args.ownerId,state:'READY'};projects.set(id,row);return row;}
  if(operation==='projects.list')return {projects:[...projects].filter(([id,row])=>id.startsWith(host+':')&&(!args.ownerId||row.ownerId===args.ownerId)).map(([,row])=>({...row,size:null,complete:false}))};
  if(operation==='projects.status')return projects.get(id);
  if(operation==='projects.quota')return {volumes:[]};
  if(operation==='datasets.list')return {datasets:[]};
  if(operation==='projects.retire'){trash.set(args.key,{id,row:projects.get(id)});projects.delete(id);return {state:'TRASHED',key:args.key};}
  if(operation==='projects.retire.restore'){const {id,row}=trash.get(args.key);projects.set(id,row);trash.delete(args.key);return {state:'RESTORED',key:args.key};}
  throw Error('Unexpected fixture operation '+operation);
 };
 const open=async()=>{service=await PortalService.open(database,bootstrap,undefined,bridge);clearInterval(service.executionTimer);};
 await open();
 const admin=await service.login('admin',password),owners=[];
 for(const username of ['alice','bob'])owners.push((await service.invoke(admin.token,'users.create',{username,password})).result);
 for(const owner of owners)await service.invoke(admin.token,'policy.save',{userId:owner.id,total:2,limits:{[machine]:1,[otherMachine]:1}});
 const token=owner=>service.issueSession({userId:owner.id,username:owner.username,role:'member'});
 const call=async(operation,args={},owner=owners[1])=>(await service.invoke(token(owner),operation,{machine,project:'vision',...args})).result;
 t.after(async()=>{await service.storageWork;service.close();await rm(root,{recursive:true,force:true});});
 return {get service(){return service;},call,calls,owners,token,setHandler:value=>override=value,reopen:async()=>{await service.storageWork;service.close();await open();}};
}

test('creating a shared project stores presentation only after the node succeeds',async t=>{
 const f=await fixture(t),ownerId=f.owners[0].id;
 const created=await f.call('projects.create',{ownerId,shared:true,repo:'https://example.test/team/repo.git'});
 assert.equal(created.shared,true);assert.equal(created.ownerId,ownerId);
 assert.equal(f.calls[0].args.repo,'https://example.test/team/repo.git');assert.equal(f.calls[0].args.userId,f.owners[1].id);
 assert.equal((await f.call('projects.create',{project:'ordinary'})).shared,false);
 assert.equal((await f.call('projects.create',{project:'explicit',shared:false})).shared,false);
 f.setHandler(async()=>{throw Error('node unavailable');});
 await assert.rejects(f.call('projects.create',{project:'failed',shared:true}),/node unavailable/);
 assert.equal(f.service.db.prepare('SELECT 1 FROM project_shared_v2 WHERE project=?').get('failed'),undefined);
});

test('members toggle another owner project without node reads, preserving labels and normal login/maintenance handling',async t=>{
 const f=await fixture(t),ownerId=f.owners[0].id;
 await f.call('projects.create',{ownerId});await f.call('projects.label.set',{ownerId,displayName:'团队实验'});
 const before=f.calls.length,on=await f.call('projects.shared.set',{ownerId,shared:true,future:'ignored'});
 assert.equal(on.shared,true);assert.equal(on.ownerId,ownerId);assert.equal(on.ownerName,'alice');assert.equal(on.displayName,'团队实验');
 const saved=f.service.db.prepare('SELECT shared,updated_at FROM project_shared_v2 WHERE owner_id=? AND machine=? AND project=?').get(ownerId,machine,'vision');
 assert.equal(saved.shared,1);assert.ok(saved.updated_at);
 assert.equal((await f.call('projects.shared.set',{ownerId,shared:false},f.owners[0])).shared,false);assert.equal(f.calls.length,before);
 const token=f.token(f.owners[1]);f.service.revokeSession(token);
 await assert.rejects(f.service.invoke(token,'projects.shared.set',{machine,project:'vision',ownerId,shared:true}),{status:401});
 const admin=f.service.issueSession({userId:'builtin-admin',username:'admin',role:'admin'});
 await f.service.invoke(admin,'maintenance.set',{scope:machine,enabled:true,reason:'fixture maintenance'});
 await assert.rejects(f.call('projects.shared.set',{ownerId,shared:true}),e=>e.code==='MAINTENANCE_ACTIVE');
 assert.equal(f.service.projectPresentation(ownerId,machine,{project:'vision'}).shared,false);
});

test('list, catalog and persisted storage snapshots expose owner-scoped shared flags without rescanning',async t=>{
 const f=await fixture(t),ownerId=f.owners[0].id;
 await f.call('projects.create',{ownerId,shared:true});await f.call('projects.create');await f.call('projects.create',{ownerId,machine:otherMachine});
 const rows=(await f.call('projects.list')).projects;
 assert.equal(rows.find(row=>row.ownerId===ownerId).shared,true);assert.equal(rows.find(row=>row.ownerId!==ownerId).shared,false);
 const catalog=(await f.call('projects.catalog')).groups.flatMap(group=>group.instances);
 assert.equal(catalog.find(row=>row.ownerId===ownerId&&row.machine===machine).shared,true);
 assert.equal(catalog.find(row=>row.machine===otherMachine).shared,false);
 await f.service.invoke(f.token(f.owners[1]),'storage.refresh',{machine});await f.service.storageWork;
 const snapshot=async()=>{const value=await f.call('storage.snapshot');return value.machines.find(row=>row.machine===machine).projects.projects;};
 let count=f.calls.length;assert.equal((await snapshot()).find(row=>row.ownerId===ownerId).shared,true);assert.equal(f.calls.length,count);
 await f.reopen();count=f.calls.length;const restored=(await snapshot()).find(row=>row.ownerId===ownerId);
 assert.equal(restored.shared,true);assert.equal(restored.size,null);assert.equal(restored.complete,false);assert.equal(f.calls.length,count);
 await f.call('projects.shared.set',{ownerId,shared:false});assert.equal((await snapshot()).find(row=>row.ownerId===ownerId).shared,false);assert.equal(f.calls.length,count);
});

test('successful retirement clears shared metadata; failed or unknown deletion keeps it and restore defaults to false',async t=>{
 const f=await fixture(t),ownerId=f.owners[0].id,key=randomUUID();
 await f.call('projects.create',{ownerId,shared:true});await f.call('projects.create',{shared:true});
 const row=()=>f.service.projectPresentation(ownerId,machine,{project:'vision'});
 f.setHandler(async()=>{throw Error('temporary node failure');});await assert.rejects(f.call('projects.retire',{ownerId,key}),/temporary node failure/);assert.equal(row().shared,true);
 f.setHandler(async()=>({state:'UNKNOWN'}));await f.call('projects.retire',{ownerId,key});assert.equal(row().shared,true);
 f.setHandler(undefined);await f.call('projects.retire',{ownerId,key});
 assert.equal(f.service.db.prepare('SELECT 1 FROM project_shared_v2 WHERE owner_id=? AND machine=? AND project=?').get(ownerId,machine,'vision'),undefined);
 assert.equal(f.service.projectPresentation(f.owners[1].id,machine,{project:'vision'}).shared,true);
 await f.call('projects.retire.restore',{ownerId,key,kind:'project'});assert.equal((await f.call('projects.status',{ownerId})).shared,false);
});
