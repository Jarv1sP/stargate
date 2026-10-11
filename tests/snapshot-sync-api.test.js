import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {snapshotSyncCall} from '../snapshot-sync.mjs';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
const hash='a'.repeat(64),principal={userId:'demo-user-1',username:'alice',role:'member'},user={id:principal.userId,username:principal.username,enabled:true,role:'member',limits:{'gpu-1':1,'gpu-2':1},total:1};
function fixture(){const calls=[],info={state:'READY',manifestBytes:100,manifestSha256:hash,totalBytes:30,entries:2};return {calls,info,service:{bridge:async(machine,op,args)=>{calls.push({machine,op,args});return info;},audit(){}},auth:machine=>{if(!['gpu-1','gpu-2'].includes(machine))throw Object.assign(Error('unauthorized'),{status:403});}};}
test('fixed code provenance authorizes both nodes and checks manifest before target begin',async()=>{
  const f=fixture(),args={machine:'gpu-2',project:'new-project',key:randomUUID(),manifestBytes:100,manifestSha256:hash,totalBytes:30,entries:2,source:{kind:'release',machine:'gpu-1',project:'source',release:hash}};
  await snapshotSyncCall(f.service,principal,user,'projects.sync.begin',args,f.auth);assert.equal(f.calls.length,2);assert.equal(f.calls[0].machine,'gpu-1');assert.equal(f.calls[1].machine,'gpu-2');assert.equal(f.calls[1].args.userId,user.id);assert.equal(f.calls[1].args.hostAdmin,undefined);
  f.calls.length=0;await assert.rejects(snapshotSyncCall(f.service,principal,user,'projects.sync.begin',{...args,totalBytes:31},f.auth),e=>e.status===409);assert.equal(f.calls.length,1);
  f.calls.length=0;await assert.rejects(snapshotSyncCall(f.service,principal,user,'projects.sync.begin',{...args,source:{...args.source,machine:'gpu-3'}},f.auth),e=>e.status===403);assert.equal(f.calls.length,0);
});
test('snapshot reads derive identities and roles; client fields cannot expose host files or owners',async()=>{
  const f=fixture(),args={machine:'gpu-1',dataset:'private-data',version:hash,path:'samples/train.bin',offset:0};
  await snapshotSyncCall(f.service,principal,user,'datasets.snapshot.get',args,f.auth);assert.equal(f.calls[0].args.userId,user.id);assert.equal(f.calls[0].args.hostAdmin,false);
  for(const extra of [{userId:'builtin-admin'},{hostAdmin:true},{sourceId:'/etc'},{path:'/root/key'},{path:'../private'},{offset:-1}])await assert.rejects(snapshotSyncCall(f.service,principal,user,'datasets.snapshot.get',{...args,...extra},f.auth));
  await assert.rejects(snapshotSyncCall(f.service,principal,user,'projects.snapshot.info',{machine:'gpu-1',project:'abc',release:'latest'},f.auth));
});
test('Git imports pin a full commit and bounded chunks without accepting environment modes or execution',async()=>{
  const f=fixture(),args={machine:'gpu-2',project:'new-project',key:randomUUID(),manifestBytes:100,manifestSha256:hash,totalBytes:30,entries:2,source:{kind:'git',commit:'b'.repeat(40)}};
  await snapshotSyncCall(f.service,principal,user,'projects.sync.begin',args,f.auth);assert.equal(f.calls[0].op,'projects.sync.begin');
  for(const extra of [{environmentMode:'shared'},{argv:['rm']},{source:{kind:'git',commit:'HEAD'}},{source:{kind:'git',commit:'b'.repeat(40),machine:'gpu-1'}}])await assert.rejects(snapshotSyncCall(f.service,principal,user,'projects.sync.begin',{...args,...extra},f.auth));
  await assert.rejects(snapshotSyncCall(f.service,principal,user,'projects.sync.chunk',{machine:'gpu-2',project:'new-project',key:args.key,path:'file',offset:0,data:'%%%invalid%%%'},f.auth));
});
test('code-only sync uses the same OCI cohort admission and preserves both pre/post dispatch authorization fences',async()=>{
 const args={machine:'gpu-2',project:'new-project',key:randomUUID(),manifestBytes:100,manifestSha256:hash,totalBytes:30,entries:2,source:{kind:'git',commit:'b'.repeat(40)}};
 const f=fixture(),admissions=[];f.service.ociProjectAdmission=async(...call)=>admissions.push(call);
 await snapshotSyncCall(f.service,principal,user,'projects.sync.begin',args,f.auth);
 assert.deepEqual(admissions,[['gpu-2',user.id,'new-project',{creatingOCI:true}]]);
 assert.equal(f.calls.at(-1).args.environmentMode,undefined,'OCI mode is node-controlled, never a client override');
 f.calls.length=0;f.service.ociProjectAdmission=async()=>{throw Object.assign(Error('Cohort not confirmed'),{status:503});};
 await assert.rejects(snapshotSyncCall(f.service,principal,user,'projects.sync.begin',args,f.auth),e=>e.status===503);assert.equal(f.calls.length,0);
 const g=fixture();let current={...user};g.service.store={get:()=>current};g.service.ociProjectAdmission=async()=>{current={...user,enabled:false};};
 await assert.rejects(snapshotSyncCall(g.service,principal,user,'projects.sync.begin',args,g.auth),e=>e.status===403);assert.equal(g.calls.length,0);
 const h=fixture();current={...user};h.service.store={get:()=>current};const bridge=h.service.bridge;
 h.service.bridge=async(...call)=>{const result=await bridge(...call);current={...user,enabled:false};return result;};
 await assert.rejects(snapshotSyncCall(h.service,principal,user,'projects.sync.begin',args,h.auth),e=>e.status===403);assert.equal(h.calls.length,1);
});
test('container and unified node manifest include the required sync runtime imports',async()=>{
  const docker=await readFile(new URL('../deploy/Dockerfile',import.meta.url),'utf8'),manifest=JSON.parse(await readFile(new URL('../deploy/node-runtime.json',import.meta.url),'utf8'));assert.match(docker,/COPY[^\n]*snapshot-sync\.mjs/);assert.ok(manifest.dependencies.includes('snapshot-sync.py'));assert.ok(manifest.dependencies.includes('data-workspace.py'));
});
test('authenticated PortalService routes code/data snapshots without allocating any GPU task',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-sync-api-')),bootstrap=join(dir,'bootstrap'),password='Fixture-Sync-API-2026!',calls=[];
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));const service=await PortalService.open(join(dir,'db'),bootstrap,undefined,async(machine,operation,args)=>{calls.push({machine,operation,args});return {state:'READY',manifestBytes:100,manifestSha256:hash,totalBytes:30,entries:2};});clearInterval(service.executionTimer);t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'alice',password})).result;
  await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:1,limits:{[MACHINES[0].id]:1,[MACHINES[1].id]:1}});const login=await service.login('alice',password);
  await service.invoke(login.token,'projects.snapshot.info',{machine:MACHINES[0].id,project:'vision',release:hash});await service.invoke(login.token,'datasets.snapshot.info',{machine:MACHINES[1].id,dataset:'samples',version:hash});assert.equal(calls.length,2);assert.equal(calls.every(c=>c.args.userId===member.id),true);assert.equal(service.store.jobs.length,0);
  await assert.rejects(service.invoke(login.token,'projects.snapshot.info',{machine:MACHINES[2].id,project:'vision',release:hash}),e=>e.status===403);assert.equal(calls.length,2);
});
