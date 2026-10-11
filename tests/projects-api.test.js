import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
import {quotaStatus} from '../projects.mjs';
import {projectFootprint,trainingPlan} from './training-storage-fixture.mjs';
const release='a'.repeat(64),image='sha256:'+'b'.repeat(64),password='Project-Test-Long-Password-2026';
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'gpuq-project-api-')),bootstrap=join(dir,'bootstrap'),status=join(dir,'status');
 await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
 await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,gpus:Array.from({length:m.cards},(_,index)=>({index,memoryTotalMiB:32768})),gpuq:{connected:true,observeOnly:false,schedulableIndices:[0],jobs:[]}}))}));
 const calls=[];let ready=true;
 const bridge=async(machine,operation,args)=>{
  calls.push({machine,operation,args});
  if(operation==='projects.quota')return {enabled:false,enforcement:null,owner:args.userId,volumes:null};
  if(operation==='projects.verify')return {project:args.project,release:args.release,state:ready?'READY':'DRAFT'};
  if(operation==='projects.copy.probe'){
   assert.deepEqual(Object.keys(args).sort(),['project','release','userId']);
   assert.equal(service.store.get(args.userId).enabled,true);assert.ok(service.store.get(args.userId).limits[machine]>0);
   assert.equal(args.project,'my-project');assert.equal(args.release,release);
   return {protocol:'portable-project-v1',enabled:true,environmentMode:'oci',architecture:'amd64',
    project:args.project,release:args.release,releaseReady:ready,image,sources:[],...projectFootprint};
  }
  if(operation==='storage.training.plan'){
   assert.deepEqual(Object.keys(args).sort(),['datasetFootprints','datasetReadMode','datasets','hostAdmin','project','projectFootprint','release','userId']);
   assert.equal(service.store.get(args.userId).enabled,true);assert.ok(service.store.get(args.userId).limits[machine]>0);
   assert.equal(args.hostAdmin,false);assert.equal(args.project,'my-project');assert.equal(args.release,release);
   assert.equal(args.datasetReadMode,'cache');assert.deepEqual(args.datasets,[]);assert.deepEqual(args.datasetFootprints,[]);
   assert.deepEqual(args.projectFootprint,{sourceMachine:machine,image,architecture:'amd64',...projectFootprint});
   return trainingPlan(machine,args);
  }
  if(operation.startsWith('projects.'))return {project:args.project,state:'DRAFT',releases:[],latestReadyRelease:null,...(operation==='projects.create'?{environmentMode:args.environmentMode}:{})};
  if(operation==='sync')return {state:'RUNNING',nodeJobId:'node-'+args.job.id};
  return {entries:[]};
 };
 const service=await PortalService.open(join(dir,'db'),bootstrap,status,bridge);clearInterval(service.executionTimer);
 const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'alice',password})).result;
 await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:2,limits:{'gpu-1':2}});
 const user=await service.login('alice',password),other=(await service.invoke(admin.token,'users.create',{username:'other',password})).result;
 await service.invoke(admin.token,'policy.save',{userId:other.id,policyVersion:0,total:2,limits:{'gpu-1':2}});
 const otherLogin=await service.login('other',password);
 const call=(op,args={},token=user.token)=>service.invoke(token,op,{machine:'gpu-1',...args});
 const settle=async()=>{await new Promise(r=>setImmediate(r));while(service.reconciling)await new Promise(r=>setTimeout(r,2));};
 return {service,calls,user,admin,member,otherLogin,call,ready:v=>ready=v,settle,close:async()=>{await settle();service.close();await rm(dir,{recursive:true,force:true});}};
}
test('project display names are owner CAS metadata and never replace immutable execution references',async()=>{
 const f=await fixture();try{
  const ref={project:'my-project'},before=f.service.store.jobs.length;
  const first=(await f.call('projects.label.get',ref)).result;assert.equal(first.revision,0);assert.equal(first.displayName,'my-project');
  const changed=(await f.call('projects.label.set',{...ref,displayName:'机器人 · 中文名称',revision:0})).result;
  assert.equal(changed.revision,1);assert.equal(changed.project,'my-project');
  const status=(await f.call('projects.status',ref)).result;assert.equal(status.displayName,'机器人 · 中文名称');assert.equal(status.project,'my-project');
  await assert.rejects(f.call('projects.label.set',{...ref,displayName:'stale',revision:0}),e=>e.status===409);
  assert.equal((await f.call('projects.label.get',ref,f.otherLogin.token)).result.revision,0);
  for(const extra of [{userId:f.member.id},{hostAdmin:true},{project:'../other'},{machine:'gpu-2'},{displayName:'hidden\u200b',revision:1}])await assert.rejects(f.call('projects.label.set',{...ref,displayName:'valid',revision:1,...extra}));
  assert.equal(f.service.store.jobs.length,before);
 }finally{await f.close();}
});
test('logical projects group explicit authorized instances, preserve primary mapping and support detach without filesystem changes',async()=>{
 const f=await fixture();try{
  await f.service.invoke(f.admin.token,'policy.save',{userId:f.member.id,policyVersion:1,total:2,limits:{'gpu-1':1,'gpu-2':1}});
  const id=randomUUID(),members=[{machine:'gpu-1',project:'alpha'},{machine:'gpu-2',project:'beta'}];
  const set=async args=>(await f.service.invoke(f.user.token,'projects.group.set',args)).result;
  let row=await set({id,displayName:'One research project',revision:0,members,primary:members[0]});assert.equal(row.revision,1);assert.deepEqual(row.members,members);
  assert.deepEqual((await f.call('projects.status',{project:'alpha'})).result.primaryInstance,members[0]);
  await assert.rejects(set({id,displayName:'stale',revision:0,members}),e=>e.status===409);
  await assert.rejects(set({id:randomUUID(),displayName:'overlap',revision:0,members}),e=>e.status===409);
  await assert.rejects(set({id,displayName:'bad primary',revision:1,members,primary:{machine:'gpu-1',project:'foreign'}}));
  row=await set({id,displayName:'One research project',revision:1,members:[]});assert.equal(row.revision,2);assert.deepEqual(row.members,[]);
  assert.equal((await f.call('projects.status',{project:'alpha'})).result.logicalProjectId,null);
  const hidden=(await f.service.invoke(f.otherLogin.token,'projects.group.get',{id})).result;assert.equal(hidden.revision,0);assert.deepEqual(hidden.members,[]);
  assert.equal(f.calls.some(c=>c.operation==='projects.create'||c.operation==='projects.publish'),false);
 }finally{await f.close();}
});
test('catalog filters archived instances only in presentation and keeps unreachable nodes explicitly partial',async()=>{
 const f=await fixture();try{
  await f.service.invoke(f.admin.token,'policy.save',{userId:f.member.id,policyVersion:1,total:2,limits:{'gpu-1':1,'gpu-2':1}});
  const original=f.service.bridge;
  f.service.bridge=async(machine,op,args)=>op==='projects.list'?(machine==='gpu-2'?Promise.reject(Error('offline')):{projects:[{project:'alpha',state:'DRAFT',lifecycle:{state:'ACTIVE',revision:0}},{project:'old',state:'READY',lifecycle:{state:'ARCHIVED',revision:1}}]}):original(machine,op,args);
  const first=(await f.service.invoke(f.user.token,'projects.catalog',{})).result;assert.equal(first.partial,true);assert.equal(first.groups.length,1);assert.deepEqual(first.errors,[{machine:'gpu-2',error:'此节点项目清单未确认'}]);
  const full=(await f.service.invoke(f.user.token,'projects.catalog',{includeArchived:true})).result;assert.equal(full.groups.length,2);assert.equal(full.groups[1].instances[0].project,'old');
  await assert.rejects(f.service.invoke(f.user.token,'projects.catalog',{userId:f.member.id}));
 }finally{await f.close();}
});
test('lifecycle controls bind exact owner, revision and UUID; history cannot be retired and unknown dispatch cannot archive',async()=>{
 const f=await fixture();try{
  const ref={project:'alpha',revision:0},key=randomUUID(),digest='c'.repeat(64);
  for(const operation of ['projects.archive','projects.unarchive']){
   await f.call(operation,ref);assert.deepEqual(f.calls.at(-1).args,{project:'alpha',revision:0,userId:f.member.id});
  }
  await f.call('projects.retire.plan',{project:'alpha'});
  await f.call('projects.retire',{...ref,key,manifestSha256:digest});assert.equal(f.calls.at(-1).args.key,key);
  await f.call('projects.retire.status',{project:'alpha',key});
  for(const extra of [{revision:-1},{revision:'0'},{key:'invalid'},{manifestSha256:'short'},{hostPath:'/data1'},{machine:'gpu-2'}])await assert.rejects(f.call('projects.retire',{...ref,key,manifestSha256:digest,...extra}));
  f.service.store.jobs.push({id:randomUUID(),userId:f.member.id,machine:'gpu-1',project:'alpha',state:'SUCCEEDED',cards:1,key:randomUUID(),name:'fixture',spec:{argv:['true']}});
  await assert.rejects(f.call('projects.retire',{...ref,key,manifestSha256:digest}),e=>e.status===409);
  f.service.store.jobs.at(-1).state='UNKNOWN';await assert.rejects(f.call('projects.archive',ref),e=>e.status===409);
  f.service.store.jobs.at(-1).nodeJobId='confirmed-native';await f.call('projects.archive',ref);
  const revision=f.service.operationalMaintenance(f.admin.principal).revision;
  await f.service.invoke(f.admin.token,'maintenance.set',{scope:'all',enabled:true,reason:'lifecycle fixture',revision});
  await f.call('projects.retire.plan',{project:'alpha'});await f.call('projects.retire.status',{project:'alpha',key});
  for(const operation of ['projects.archive','projects.unarchive'])await assert.rejects(f.call(operation,ref));
  await assert.rejects(f.call('projects.label.set',{project:'alpha',displayName:'blocked',revision:0}));
 }finally{await f.close();}
});
test('authorization change during metadata proof cannot commit a display name',async()=>{
 const f=await fixture();try{
  const original=f.service.bridge;f.service.bridge=async(...args)=>{const result=await original(...args);f.service.store.setEnabled(f.member.id,false);return result;};
  await assert.rejects(f.call('projects.label.set',{project:'alpha',displayName:'not committed',revision:0}),e=>e.status===403);
  assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM project_labels WHERE owner_id=?').get(f.member.id).n,0);
 }finally{await f.close();}
});
test('post-commit audit failure preserves readable label/group receipts and stale CAS rejects replay',async()=>{
 const f=await fixture();try{
  const original=f.service.audit.bind(f.service),id=randomUUID(),members=[{machine:'gpu-1',project:'alpha'}];
  f.service.audit=(actor,operation,...args)=>{if(['projects.label.set','projects.group.set'].includes(operation))throw Error('Synthetic audit receipt failure');return original(actor,operation,...args);};
  await assert.rejects(f.call('projects.label.set',{project:'alpha',displayName:'Committed label',revision:0}),/Synthetic audit receipt failure/);
  const group={id,displayName:'Committed group',revision:0,members,primary:members[0]};
  await assert.rejects(f.service.invoke(f.user.token,'projects.group.set',group),/Synthetic audit receipt failure/);
  f.service.audit=original;
  const label=(await f.call('projects.label.get',{project:'alpha'})).result;assert.equal(label.revision,1);assert.equal(label.displayName,'Committed label');
  const saved=(await f.service.invoke(f.user.token,'projects.group.get',{id})).result;assert.equal(saved.revision,1);assert.deepEqual(saved.members,members);assert.equal(saved.displayName,'Committed group');
  await assert.rejects(f.call('projects.label.set',{project:'alpha',displayName:'Replay',revision:0}),e=>e.status===409);
  await assert.rejects(f.service.invoke(f.user.token,'projects.group.set',group),e=>e.status===409);
  assert.equal(f.service.store.jobs.length,0);
 }finally{await f.close();}
});
test('project upload status is read-only, owner-bound and usable during maintenance',async()=>{
 const f=await fixture();try{
  const args={project:'my-project',area:'code',path:'bundle.tar',totalSize:123,sha256:'b'.repeat(64),uploadId:randomUUID()};
  const revision=f.service.operationalMaintenance(f.admin.principal).revision;
  await f.service.invoke(f.admin.token,'maintenance.set',{scope:'all',enabled:true,reason:'upload status fixture',revision});
  await f.call('files.upload.status',args);
  assert.deepEqual(f.calls.at(-1),{machine:'gpu-1',operation:'files.upload.status',args:{machine:'gpu-1',...args,userId:f.member.id}});
  for(const extra of [{userId:'builtin-admin'},{hostAdmin:true},{data:'unsafe'},{offset:0},{final:true},{project:undefined},{area:'output'},{machine:'gpu-2'}])await assert.rejects(f.call('files.upload.status',{...args,...extra}));
  assert.equal(f.service.store.jobs.length,0);
 }finally{await f.close();}
});
test('local import binds current owner and machine; maintenance blocks begin but permits exact status and cancel',async()=>{
 const f=await fixture();try{
  const args={project:'my-project',key:randomUUID(),sourcePath:'source/code',destinationPath:'imported'};
  await f.call('projects.local-import.begin',args);
  assert.deepEqual(f.calls.at(-1),{machine:'gpu-1',operation:'projects.local-import.begin',args:{...args,userId:f.member.id}});
  for(const extra of [{userId:'builtin-admin'},{hostAdmin:true},{sourcePath:'/data1/source'},{destinationPath:'../escape'},{root:'/data2'},{machine:'gpu-2'},{key:'invalid'}])await assert.rejects(f.call('projects.local-import.begin',{...args,...extra}));
  const revision=f.service.operationalMaintenance(f.admin.principal).revision;
  await f.service.invoke(f.admin.token,'maintenance.set',{scope:'all',enabled:true,reason:'import test',revision});
  await assert.rejects(f.call('projects.local-import.begin',args));
  for(const op of ['status','cancel']){
   await f.call('projects.local-import.'+op,{project:args.project,key:args.key});
   assert.equal(f.calls.at(-1).args.userId,f.member.id);
   await assert.rejects(f.call('projects.local-import.'+op,args));
  }
  assert.equal(f.service.store.jobs.length,0);
 }finally{await f.close();}
});
test('pending upload list/cancel are exact own-project controls, including maintenance',async()=>{
 const f=await fixture();try{
  const revision=f.service.operationalMaintenance(f.admin.principal).revision;
  await f.service.invoke(f.admin.token,'maintenance.set',{scope:'all',enabled:true,reason:'upload cleanup test',revision});
  const args={project:'my-project',area:'code'};
  await f.call('files.upload.list',args);
  assert.equal(f.calls.at(-1).args.userId,f.member.id);
  const uploadId=randomUUID();await f.call('files.upload.cancel',{...args,uploadId});
  assert.equal(f.calls.at(-1).args.uploadId,uploadId);
  for(const extra of [{userId:'builtin-admin'},{hostAdmin:true},{path:'train.py'},{area:'output'},{machine:'gpu-2'},{uploadId:'invalid'}])await assert.rejects(f.call('files.upload.cancel',{...args,uploadId,...extra}));
  await assert.rejects(f.call('files.upload.list',{...args,uploadId}));
  assert.equal(f.service.store.jobs.length,0);
 }finally{await f.close();}
});
test('project operations bind authenticated owner and explicit node without reserving GPUs',async()=>{
 const f=await fixture();try{
  for(const op of ['projects.list','projects.create','projects.status','projects.publish']){
   await f.call(op,op==='projects.list'?{}:{project:'my-project'});
   const sent=f.calls.at(-1);assert.equal(sent.machine,'gpu-1');assert.equal(sent.args.userId,f.member.id);assert.equal(sent.args.hostAdmin,undefined);
  }
  assert.equal(f.service.store.jobs.length,0);
  for(const extra of [{userId:'builtin-admin'},{path:'/root'},{hostAdmin:true},{release}])await assert.rejects(f.call('projects.create',{project:'my-project',...extra}));
  await assert.rejects(f.call('projects.list',{machine:'gpu-2'}),e=>e.status===403);
  await assert.rejects(f.call('projects.verify',{project:'my-project',release}));
 }finally{await f.close();}
});
test('personal project list advertises only confirmed OCI without rewriting legacy project records',async()=>{
 const f=await fixture();try{
  const original=f.service.bridge,legacy={project:'my-project',state:'DRAFT',environmentMode:'isolated',releases:[],latestReadyRelease:null};
  let modes=['shared','isolated','oci'];
  f.service.bridge=async(machine,operation,args)=>operation==='projects.list'?{projects:[legacy],environmentModes:modes,unchangedField:'legacy-compatible'}:original(machine,operation,args);
  const result=(await f.call('projects.list')).result;
  assert.deepEqual(result.environmentModes,['oci']);assert.equal(result.unchangedField,'legacy-compatible');
  assert.equal(result.projects[0].project,legacy.project);assert.equal(result.projects[0].environmentMode,'isolated');assert.equal(result.projects[0].state,'DRAFT');assert.deepEqual(legacy,{project:'my-project',state:'DRAFT',environmentMode:'isolated',releases:[],latestReadyRelease:null});
  for(const unconfirmed of [undefined,null,'oci',[],['shared','isolated'],['OCI']]){modes=unconfirmed;assert.deepEqual((await f.call('projects.list')).result.environmentModes,[]);}
  const created=(await f.call('projects.create',{project:'personal-default'})).result;
  assert.equal(created.environmentMode,'oci');assert.deepEqual(f.calls.at(-1).args,{project:'personal-default',environmentMode:'oci',userId:f.member.id});
  assert.equal(f.service.store.jobs.length,0);
 }finally{await f.close();}
});
test('kernel quota status is owner-bound, read-only and available during maintenance',async()=>{
 const f=await fixture();try{
  const revision=f.service.operationalMaintenance(f.admin.principal).revision;
  await f.service.invoke(f.admin.token,'maintenance.set',{scope:'all',enabled:true,reason:'quota test',revision});
  const value=(await f.call('projects.quota')).result;
  assert.deepEqual(value,{enabled:false,enforcement:null,owner:f.member.id,volumes:null});
  assert.deepEqual(f.calls.at(-1).args,{userId:f.member.id});assert.equal(f.service.store.jobs.length,0);
  for(const extra of [{userId:'builtin-admin'},{path:'/etc'},{hostAdmin:true},{project:'alpha'},{projectId:10004}])await assert.rejects(f.call('projects.quota',extra));
  await assert.rejects(f.call('projects.quota',{machine:'gpu-2'}),e=>e.status===403);
 }finally{await f.close();}
});
test('quota API rejects stale owner, unknown fields and non-kernel or unsafe counters',()=>{
 const owner='demo-user-3',row={volume:'data',bytes:1048576,inodes:100,usedBytes:4096,usedInodes:4,remainingBytes:1044480,remainingInodes:96};
 const value={enabled:true,enforcement:'kernel-project-quota',owner,projectId:10003,volumes:[row]};
 assert.deepEqual(quotaStatus(value,owner),value);
 for(const bad of [{...value,owner:'demo-user-4'},{...value,path:'/data'},{...value,enforcement:'app-counts'},{...value,volumes:[row,row]},{...value,volumes:[{...row,usedBytes:Number.MAX_SAFE_INTEGER+1}]},{...value,volumes:[{...row,remainingBytes:0}]}])assert.throws(()=>quotaStatus(bad,owner),e=>e.status===503);
});
test('quota cohort exclusion remains explicit unknown usage, never zero counters',()=>{
 const owner='demo-user-3',value={enabled:false,enforcement:null,owner,volumes:null,reason:'OWNER_NOT_ACTIVATED'};
 assert.deepEqual(quotaStatus(value,owner),value);
 for(const bad of [{...value,reason:'UNKNOWN_OWNER'},{...value,volumes:[]},{...value,owner:'demo-user-4'},{...value,usedBytes:0}])assert.throws(()=>quotaStatus(bad,owner),e=>e.status===503);
});
test('project jobs pin one release and verify it before quota reservation',async()=>{
 const f=await fixture();try{
  const args={project:'my-project',release,cards:1,argv:['python','train.py'],key:randomUUID()};
  f.ready(false);await assert.rejects(f.call('jobs.submit',args),e=>e.status===409);assert.equal(f.service.store.jobs.length,0);
  f.ready(true);const result=(await f.call('jobs.submit',args)).result;await f.settle();
  assert.equal(result.project,'my-project');assert.equal(result.release,release);assert.equal(f.calls.find(c=>c.operation==='sync').args.job.release,release);
  const admission=f.calls.filter(c=>c.operation==='storage.training.plan');assert.equal(admission.length,1,'admission verifies capacity once; first dispatch uses node write guards');
  assert.ok(admission.every(c=>c.machine==='gpu-1'&&c.args.userId===f.member.id&&c.args.release===release));
  assert.equal(Object.hasOwn(result,'trainingStoragePlan'),false);assert.equal(Object.hasOwn(f.calls.find(c=>c.operation==='sync').args.job,'trainingStoragePlan'),false);
  assert.equal((await f.call('jobs.submit',args)).result.id,result.id);
  await assert.rejects(f.call('jobs.submit',{...args,release:'b'.repeat(64)}),e=>e.status===409);
  for(const bad of [{project:undefined},{release:undefined},{project:'../bad'},{release:'latest'}])await assert.rejects(f.call('jobs.submit',{...args,key:randomUUID(),...bad}));
 }finally{await f.close();}
});
test('publication key is publish-only and cannot supply another owner or host privileges',async()=>{
 const f=await fixture();try{
  const key=randomUUID();await f.call('projects.publish',{project:'my-project',key});
  assert.deepEqual(f.calls.at(-1).args,{project:'my-project',key,userId:f.member.id});
  for(const operation of ['projects.create','projects.status','projects.list'])await assert.rejects(f.call(operation,{project:'my-project',key}));
  for(const key of ['',null,123,'../other','a'.repeat(64)])await assert.rejects(f.call('projects.publish',{project:'my-project',key}));
  for(const extra of [{hostAdmin:true},{userId:'builtin-admin'},{publicationId:key}])await assert.rejects(f.call('projects.publish',{project:'my-project',key,...extra}));
  await assert.rejects(f.call('projects.publish',{machine:'gpu-2',project:'my-project',key}),e=>e.status===403);
 }finally{await f.close();}
});
test('new projects default to OCI and reject legacy modes before dispatch for members and admins',async()=>{
 const f=await fixture();try{
  for(const options of [{},{environmentMode:'oci'}]){
   await f.call('projects.create',{project:'clean-env',...options});
   assert.equal(f.calls.at(-1).args.environmentMode,'oci');assert.equal(f.calls.at(-1).args.userId,f.member.id);
  }
  const count=f.calls.length;
  for(const token of [f.user.token,f.admin.token])for(const environmentMode of ['shared','isolated',null,true,{},['oci'],'inherit',''])await assert.rejects(f.call('projects.create',{project:'clean-env',environmentMode},token),e=>e.status===400);
  assert.equal(f.calls.length,count,'legacy clients and manual args cannot bypass OCI creation');
  for(const op of ['projects.status','projects.list','projects.publish'])await assert.rejects(f.call(op,{project:'clean-env',environmentMode:'isolated'}));
  await assert.rejects(f.call('projects.create',{project:'clean-env',environmentMode:'isolated',userId:'builtin-admin'}));
  await assert.rejects(f.call('projects.create',{machine:'gpu-2',project:'clean-env',environmentMode:'isolated'}),e=>e.status===403);
 }finally{await f.close();}
});
test('OCI creation requires an exact confirmed project receipt and preserves permission race checks',async()=>{
 const f=await fixture();try{
  const bridge=f.service.bridge;
  for(const receipt of [undefined,{}, {project:'clean-env'},{project:'clean-env',environmentMode:'shared'},{project:'another',environmentMode:'oci'}]){
   f.service.bridge=async()=>receipt;
   await assert.rejects(f.call('projects.create',{project:'clean-env'}),e=>e.status===503);
  }
  f.service.bridge=async(...args)=>{const value=await bridge(...args);f.service.store.setEnabled(f.member.id,false);return value;};
  await assert.rejects(f.call('projects.create',{project:'clean-env'}),e=>e.status===403);
  assert.equal(f.service.store.jobs.length,0);
 }finally{await f.close();}
});
test('project terminal forbids host-root combination and retains context on all operations',async()=>{
 const f=await fixture();try{
  for(const operation of ['terminal.open','terminal.exchange','terminal.close','terminal.detach']){
   await f.call(operation,{project:'my-project',clientId:randomUUID(),...(operation==='terminal.open'?{mode:'new',key:randomUUID()}:{id:randomUUID(),writerToken:randomUUID()})});
   assert.equal(f.calls.at(-1).args.project,'my-project');assert.equal(f.calls.at(-1).args.userId,f.member.id);
  }
  await assert.rejects(f.call('terminal.open',{project:'my-project',key:randomUUID(),hostAdmin:true},f.admin.token));
 }finally{await f.close();}
});
test('terminal API requires explicit isolated attachment and fences legacy/forged client fields',async()=>{
 const f=await fixture();try{
  const clientId=randomUUID(),key=randomUUID(),id=randomUUID(),writerToken=randomUUID();
  await assert.rejects(f.call('terminal.open',{key}),/升级/);
  for(const args of [{clientId,key,mode:'new',id},{clientId,key,mode:'new',takeover:true},{clientId,key,mode:'shared'},{clientId,key,mode:'reconnect',id,takeover:'yes'},{clientId,key,mode:'new',userId:'somebody-else'}])await assert.rejects(f.call('terminal.open',args));
  await f.call('terminal.open',{clientId,key,mode:'new'});
  assert.equal(f.calls.at(-1).args.clientId,clientId);assert.equal(f.calls.at(-1).args.userId,f.member.id);
  await f.call('terminal.open',{clientId,key:randomUUID(),mode:'reconnect',id,writerToken,takeover:true});
  assert.equal(f.calls.at(-1).args.takeover,true);
  for(const operation of ['terminal.exchange','terminal.close','terminal.detach']){
   await assert.rejects(f.call(operation,{clientId,id}),/凭据/);
   await assert.rejects(f.call(operation,{clientId,id,writerToken,takeover:true}),/参数/);
  }
  await assert.rejects(f.call('terminal.open',{clientId,key,mode:'new',hostAdmin:true}),e=>e.status===403);
  await f.call('terminal.open',{clientId,key,mode:'new',hostAdmin:true},f.admin.token);
  assert.equal(f.calls.at(-1).args.userId,f.admin.principal.userId);
 }finally{await f.close();}
});
test('terminal status and ended-session cleanup use exact original identity without acquiring a writer',async()=>{
 const f=await fixture();try{
  const id=randomUUID(),project='my-project';
  for(const operation of ['terminal.status','terminal.close']){
   await f.call(operation,{id,project});
   assert.deepEqual(f.calls.at(-1),{machine:'gpu-1',operation,args:{machine:'gpu-1',id,project,userId:f.member.id,username:'alice',hostAdmin:false}});
   for(const more of [{userId:'builtin-admin'},{machine:'gpu-2'},{hostAdmin:true},{dataWorkspace:true},{input:'QQ=='},{id:'invalid'},{takeover:true},{writerToken:null}])await assert.rejects(f.call(operation,{id,project,...more}));
  }
  await assert.rejects(f.call('terminal.status',{id,clientId:randomUUID()}));
  await assert.rejects(f.call('terminal.status',{id,writerToken:randomUUID()}));
  await assert.rejects(f.call('terminal.close',{id,clientId:randomUUID()}),/凭据/);
  for(const op of ['terminal.exchange','terminal.detach'])await assert.rejects(f.call(op,{id}),/升级|凭据/);
  assert.equal(f.calls.some(c=>c.operation==='terminal.open'),false);assert.equal(f.service.store.jobs.length,0);
 }finally{await f.close();}
});
test('project outputs require same authenticated owner, machine, project and job',async()=>{
 const f=await fixture();try{
  const job=(await f.call('jobs.submit',{project:'my-project',release,cards:1,argv:['true'],key:randomUUID()})).result;await f.settle();
  const args={project:'my-project',area:'output',runId:job.id,path:'.'};
  await f.call('files.list',args);
  for(const token of [f.admin.token,f.otherLogin.token])await assert.rejects(f.call('files.list',args,token),e=>e.status===403);
  await assert.rejects(f.call('files.put',args));
  await assert.rejects(f.call('files.list',{...args,project:'other-project'}),e=>e.status===403);
  await assert.rejects(f.call('files.list',{...args,runId:undefined}));
  await assert.rejects(f.call('files.list',{...args,project:undefined}));
  await assert.rejects(f.call('files.put',{project:'my-project',truncate:true}));
 }finally{await f.close();}
});


test('project status/list preserve original terminal discovery only for the authenticated owner without terminal actions',async()=>{
 const f=await fixture();try{
  const sessions={protocol:1,state:'CONFIRMED',complete:true,sessions:[{id:'11111111-1111-4111-8111-111111111111',state:'UNCONFIRMED',requiresStatus:true,attachmentState:'DETACHED',writerLeaseExpired:true,legacy:false}]};
  f.service.bridge=async(machine,operation,args)=>{
   f.calls.push({machine,operation,args});assert.ok(['projects.status','projects.list'].includes(operation));assert.equal(args.userId,f.member.id);
   const project={project:'vision',state:'DRAFT',releases:[],latestReadyRelease:null,developmentTerminals:sessions};
   return operation==='projects.list'?{projects:[project]}:project;
  };
  const status=(await f.call('projects.status',{project:'vision'})).result;
  const list=(await f.call('projects.list')).result;
  assert.deepEqual(status.developmentTerminals,sessions);assert.deepEqual(list.projects[0].developmentTerminals,sessions);
  assert.deepEqual(f.calls.map(row=>row.operation),['projects.status','projects.list']);
  assert.deepEqual(f.calls[0].args,{userId:f.member.id,project:'vision'});assert.deepEqual(f.calls[1].args,{userId:f.member.id});
  for(const extra of [{userId:'builtin-admin'},{hostAdmin:true},{machine:'gpu-2'},{project:'../other'}])await assert.rejects(f.call('projects.status',{project:'vision',...extra}));
  assert.equal(f.calls.length,2);assert.equal(f.service.store.jobs.length,0);
 }finally{await f.close();}
});
