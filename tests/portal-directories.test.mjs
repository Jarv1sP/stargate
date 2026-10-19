import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rename,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
const machine=MACHINES[0].id,password='C2-Directory-Fixture-Password!';
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'C2-directories-')),database=join(root,'portal.db'),bootstrap=join(root,'bootstrap');
 let override;
 const hdd=join(root,'hdd'),ssd=join(root,'ssd'),uploads=new Map(),trash=new Map(),projects=new Map(),calls=[];
 await Promise.all([mkdir(hdd),mkdir(ssd),writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600})]);
 const old=new DatabaseSync(database);old.exec("CREATE TABLE portal_state(id INTEGER PRIMARY KEY,data TEXT); INSERT INTO portal_state VALUES(1,'old platform records must not be read');");old.close();
 const fileRoot=args=>args.area==='dataset'?join(hdd,args.dataset):args.area==='output'?join(ssd,'outputs',args.runId):join(ssd,args.ownerId,args.project);
 const retire=async(path,kind,args,extra={})=>{
  const target=join(kind==='dataset'?hdd:ssd,'.trash',args.key);await mkdir(dirname(target),{recursive:true});await rename(path,target);
  const row={key:args.key,kind,state:'TRASHED',originalPath:path,actor:args.actor,retainUntil:Date.now()/1000+7*86400,...extra};trash.set(args.key,{...row,target});return row;
 };
 const bridge=async(host,op,args)=>{
  calls.push({host,op,args:structuredClone(args)});
  if(override){const value=await override(host,op,args);if(value!==undefined)return value;}
  assert.equal(host,machine);
  if(op==='projects.create'){
   const row={project:args.project,ownerId:args.ownerId,state:'READY',git:{url:args.repo??null,branch:args.repo?'main':null,commit:args.repo?'b'.repeat(40):null}};
   await mkdir(join(ssd,args.ownerId,args.project),{recursive:true});projects.set(args.ownerId+':'+args.project,row);return row;
  }
  if(op==='projects.list')return {projects:[...projects.values()]};
  if(op==='projects.status')return projects.get(args.ownerId+':'+args.project);
  if(op==='datasets.list')return {datasets:(await readdir(hdd,{withFileTypes:true})).filter(row=>row.isDirectory()&&row.name!=='.trash').map(row=>({dataset:row.name,name:row.name,size:null,ownerId:'demo-user-1',modifiedAt:new Date().toISOString()}))};
  if(op==='data.upload.begin'){
   let row=uploads.get(args.key);if(!row){const path=join(fileRoot(args),args.path),part=path+'.part-'+args.key;await mkdir(dirname(path),{recursive:true});await writeFile(part,'');row={key:args.key,path,part,offset:0,totalSize:args.totalSize,state:'UPLOADING'};uploads.set(args.key,row);}return row;
  }
  if(op==='data.upload.status')return uploads.get(args.key)??{key:args.key,state:'ABSENT'};
  if(op==='data.upload.cancel'){const row=uploads.get(args.key);if(row){await rm(row.part,{force:true});row.state='CANCELED';}return {key:args.key,state:'CANCELED'};}
  if(op==='files.stat'){const value=await stat(join(fileRoot(args),args.path));return {exists:true,size:value.size};}
  if(op==='data.upload.chunk'){
   const row=uploads.get(args.key),bytes=Buffer.from(args.data,'base64');assert.equal(args.offset,row.offset);assert.ok(row.offset+bytes.length<=row.totalSize);
   await writeFile(row.part,bytes,{flag:'a'});row.offset+=bytes.length;return {...row};
  }
  if(op==='data.upload.finish'){
   const row=uploads.get(args.key);assert.equal(row.offset,row.totalSize);await rename(row.part,row.path);row.state='COMPLETE';return {key:row.key,state:row.state,size:row.totalSize};
  }
  if(op==='files.get'){const path=join(fileRoot(args),args.path),data=await readFile(path);return {path:args.path,size:data.length,offset:args.offset??0,data:data.subarray(args.offset??0).toString('base64'),eof:true};}
  if(op==='files.list')return {entries:(await readdir(join(fileRoot(args),args.path||''),{withFileTypes:true})).map(row=>({name:row.name,path:row.name,type:row.isDirectory()?'directory':'file'}))};
  if(op==='datasets.delete')return retire(join(hdd,args.dataset),'dataset',args,{dataset:args.dataset});
  if(op==='outputs.delete')return retire(join(ssd,'outputs',args.jobId,args.path),'output',args,{jobId:args.jobId,project:'sample',ownerId:args.ownerId});
  if(op==='projects.retire.list')return {items:[...trash.values()].map(({target,...row})=>row)};
  if(op==='projects.retire.restore'){const row=trash.get(args.key);await mkdir(dirname(row.originalPath),{recursive:true});await rename(row.target,row.originalPath);trash.delete(args.key);return {key:args.key,state:'RESTORED'};}
  if(op==='projects.retire.purge'){assert.equal(args.actor.isAdmin,true);const row=trash.get(args.key);await rm(row.target,{recursive:true,force:true});trash.delete(args.key);return {key:args.key,state:'PURGED'};}
  if(op==='sync')return {state:'RUNNING',nodeJobId:'J'+args.job.id.replaceAll('-','').slice(0,12),assignedIndices:[0]};
  if(op==='logs')return {text:'shared job log'};
  if(op==='cancel')return {state:'CANCELED',nodeJobId:'J'+args.job.id.replaceAll('-','').slice(0,12),assignedIndices:[]};
  throw Error('Unexpected fixture RPC '+op);
 };
 const service=await PortalService.open(database,bootstrap,undefined,bridge);clearInterval(service.executionTimer);
 const admin=await service.login('admin',password);
 const aliceUser=(await service.invoke(admin.token,'users.create',{username:'alice',password})).result,bobUser=(await service.invoke(admin.token,'users.create',{username:'bob',password})).result;
 const alice=await service.login('alice',password),bob=await service.login('bob',password);
 const call=async(op,args={},actor=bob)=>(await service.invoke(actor.token,op,{machine,...args})).result;
 const upload=async(dataset,path,bytes,key=randomUUID())=>{
  const base={area:'dataset',dataset,key};await call('data.upload.begin',{...base,path,totalSize:bytes.length,overwrite:true,sha256:'ignored',extension:'ignored'});
  await call('data.upload.chunk',{...base,offset:0,data:bytes.toString('base64')});await call('data.upload.finish',base);return key;
 };
 t.after(async()=>{if(service.reconciling)await service.reconcile();service.close();await rm(root,{recursive:true,force:true});});
 return {service,admin,alice,bob,aliceUser,bobUser,call,upload,calls,hdd,ssd,setHandler:fn=>override=fn};
}
test('ordinary directory uploads replace same-size bytes and resume the exact original file key',async t=>{
 const f=await fixture(t);const key=await f.upload('shared','file.bin',Buffer.from('aaaa'));
 assert.deepEqual(await readFile(join(f.hdd,'shared','file.bin')),Buffer.from('aaaa'));
 await f.upload('shared','file.bin',Buffer.from('bbbb'));assert.deepEqual(await readFile(join(f.hdd,'shared','file.bin')),Buffer.from('bbbb'));
 const status=await f.call('data.upload.status',{area:'dataset',dataset:'shared',key});assert.equal(status.offset,4);assert.equal(status.key,key);
 const listing=await f.call('files.list',{area:'dataset',dataset:'shared',path:''});assert.equal(listing.entries.length,1);
 const file=await f.call('files.get',{area:'dataset',dataset:'shared',path:'file.bin'});assert.equal(Buffer.from(file.data,'base64').toString(),'bbbb');
 assert.equal((await f.call('datasets.list')).datasets[0].dataset,'shared');
});
test('deletion, shared trash listing and another member restore preserve real directory bytes',async t=>{
 const f=await fixture(t);await f.upload('dataset','bytes',Buffer.from('recover me'));
 const key=randomUUID(),deleted=await f.call('datasets.delete',{dataset:'dataset',key},f.alice);assert.equal(deleted.state,'TRASHED');assert.match(deleted.message,/7 天/);
 assert.equal((await f.call('datasets.list')).datasets.length,0);
 const row=(await f.call('projects.retire.list')).items.find(row=>row.key===key);assert.equal(row.kind,'dataset');assert.equal(row.actor.userId,f.aliceUser.id);
 await f.call('projects.retire.restore',{key,kind:'dataset'});assert.equal(await readFile(join(f.hdd,'dataset','bytes'),'utf8'),'recover me');
});
test('immediate purge requires admin, while normal deletion and restore remain shared',async t=>{
 const f=await fixture(t);await f.upload('purge','file',Buffer.from('test'));const key=randomUUID();await f.call('datasets.delete',{dataset:'purge',key});
 const count=f.calls.length;await assert.rejects(f.call('projects.retire.purge',{key,kind:'dataset',actor:{isAdmin:true}}),error=>error.status===403);assert.equal(f.calls.length,count);
 assert.equal((await f.call('projects.retire.purge',{key,kind:'dataset'},f.admin)).state,'PURGED');
});
test('projects accept a repository, expose current git facts and address another member explicitly',async t=>{
 const f=await fixture(t),repo='https://example.invalid/team/repo.git';
 const created=await f.call('projects.create',{ownerId:f.aliceUser.id,project:'sample',repo,release:'ignored'});assert.equal(created.git.url,repo);
 const request=f.calls.find(row=>row.op==='projects.create').args;assert.equal(request.ownerId,f.aliceUser.id);assert.equal(request.actor.userId,f.bobUser.id);assert.equal(request.release,undefined);
 const list=await f.call('projects.list');assert.equal(list.projects[0].ownerId,f.aliceUser.id);assert.equal(list.projects[0].ownerName,'alice');
 await assert.rejects(f.call('projects.create',{project:'secret',repo:'https://user:token@example.invalid/repo.git'}),/不要带密码/);
});
test('output deletion uses job ID and the same project recycle bin, without an active-job precheck',async t=>{
 const f=await fixture(t),jobId=randomUUID(),path=join(f.ssd,'outputs',jobId);await mkdir(path,{recursive:true});await writeFile(join(path,'result.txt'),'output bytes');
 f.service.store.jobs.push({id:jobId,key:randomUUID(),userId:f.aliceUser.id,ownerId:f.aliceUser.id,machine,project:'sample',spec:{id:jobId,userId:f.aliceUser.id,project:'sample',argv:['train']},state:'RUNNING',cards:1});
 const key=randomUUID(),result=await f.call('outputs.delete',{jobId,key,path:'result.txt'});assert.equal(result.state,'TRASHED');assert.equal(f.calls.filter(row=>row.op==='outputs.delete').length,1);
 assert.equal((await f.call('projects.retire.list')).items[0].kind,'output');await f.call('projects.retire.restore',{key,kind:'output',ownerId:f.aliceUser.id,project:'sample'});
 assert.equal(await readFile(join(path,'result.txt'),'utf8'),'output bytes');f.service.store.jobs[0].state='SUCCEEDED';
});
test('path escape fails before a node call and unknown component fields are simply ignored',async t=>{
 const f=await fixture(t),before=f.calls.length;
 await assert.rejects(f.call('files.get',{area:'dataset',dataset:'safe',path:'../escape'}),/相对路径/);assert.equal(f.calls.length,before);
 await f.call('projects.create',{project:'safe',unrecognized:true,hostRoot:true});assert.equal(f.calls.at(-1).args.unrecognized,undefined);assert.equal(f.calls.at(-1).args.hostRoot,undefined);
});
test('current-workspace submit preserves resource limits, one original key and shared job reads',async t=>{
 const f=await fixture(t);await f.service.invoke(f.admin.token,'policy.save',{userId:f.aliceUser.id,total:1,limits:{[machine]:1}});
 const key=randomUUID(),args={machine,project:'sample',cards:1,argv:['python','train.py'],key};
 const first=(await f.service.invoke(f.alice.token,'jobs.submit',args)).result;await f.service.reconcile();
 assert.equal((await f.service.invoke(f.alice.token,'jobs.submit',{...args,argv:['ignored-new-request']})).result.id,first.id);assert.equal(f.service.store.jobs.length,1);
 assert.equal((await f.call('jobs.logs',{jobId:first.id})).text,'shared job log');
 await assert.rejects(f.service.invoke(f.alice.token,'jobs.submit',{...args,key:randomUUID(),cards:2}),/额度/);
 await f.call('jobs.cancel',{jobId:first.id});await f.service.reconcile();
 const spec=f.calls.find(row=>row.op==='sync').args.job;assert.equal(spec.project,'sample');assert.equal(spec.workspace,true);assert.equal(spec.release,undefined);assert.equal(spec.datasets,undefined);
});

test('parent upload records share progress and cancel every original child key, including retry after a lost cancel reply',async t=>{
 const f=await fixture(t),key=randomUUID(),child=randomUUID();
 const parent=await f.call('transfers.create',{key,kind:'upload',reference:{dataset:'shared'}});assert.equal(parent.state,'WAITING_CLIENT');
 await f.call('data.upload.begin',{transferId:key,key:child,dataset:'shared',path:'partial',totalSize:4});
 await f.call('data.upload.chunk',{key:child,offset:0,data:Buffer.from('ab').toString('base64')});
 assert.equal((await f.call('data.upload.status',{key:child})).offset,2);
 await f.call('transfers.progress',{id:key,bytes:2});assert.equal((await f.call('transfers.status',{id:key},f.alice)).bytes,2);
 let lost=true;f.setHandler((_host,op)=>{if(op==='data.upload.cancel'&&lost){lost=false;throw Object.assign(Error('lost cancel reply'),{code:'NODE_RESPONSE_TIMEOUT'});}});
 assert.equal((await f.call('transfers.cancel',{id:key})).state,'UNKNOWN');
 assert.equal((await f.call('transfers.cancel',{id:key},f.alice)).state,'CANCELED');
 assert.equal((await f.call('data.upload.status',{key:child})).state,'CANCELED');
 await assert.rejects(readFile(join(f.hdd,'shared','partial')),e=>e.code==='ENOENT');
});
test('directory copy performs one source authorization and starts the target with the same UUID',async t=>{
 const f=await fixture(t),target=MACHINES[1].id,key=randomUUID();let launched=0;
 f.setHandler((host,op,args)=>{if(op==='transfers.prepare'){assert.equal(host,machine);return {id:key,token:'source-token'};}
  if(op==='transfers.start'){assert.equal(host,target);assert.equal(args.id,key);assert.deepEqual(args.ticket,{id:key,token:'source-token'});assert.equal(args.sourceMachine,machine);assert.equal(args.target.dataset,'copied');launched++;return {state:'RUNNING',id:key};}
  if(op==='transfers.status')return {id:key,state:'SUCCEEDED',bytes:4};
 });
 assert.equal((await f.call('transfers.create',{key,kind:'copy',machine:target,from:machine,reference:{dataset:'source'},name:'copied'})).state,'RUNNING');
 assert.equal((await f.call('transfers.resume',{id:key},f.alice)).state,'SUCCEEDED');assert.equal(launched,1);
});

test('project copy keeps the environment and project owner instead of turning the target into a dataset',async t=>{
 const f=await fixture(t),target=MACHINES[1].id,key=randomUUID();let started;
 f.setHandler((host,op,args)=>{
  if(op==='transfers.project.mode'){assert.equal(host,target);return {mode:'incremental'};}
  if(op.endsWith('prepare')){assert.equal(op,'transfers.project.prepare');assert.equal(host,machine);assert.equal(args.mode,'incremental');assert.equal(args.source.environment,true);assert.equal(args.source.ownerId,f.aliceUser.id);return {id:key,token:'source-token'};}
  if(op.endsWith('start')){assert.equal(op,'transfers.project.start');assert.equal(host,target);started=args;return {id:key,state:'PENDING'};}
 });
 await f.call('transfers.create',{key,kind:'copy',from:machine,machine:target,name:'project-copy',reference:{project:'sample',ownerId:f.aliceUser.id,environment:true}},f.bob);
 assert.equal(started.target.project,'project-copy');assert.equal(started.target.ownerId,f.aliceUser.id);assert.equal(started.target.environment,true);
 assert.equal(started.target.mode,'incremental');
 assert.equal(started.target.dataset,undefined);assert.equal(started.source.project,'sample');
});

test('canceling after a lost copy start reply still cancels the original target transfer before GPU dispatch',async t=>{
 const f=await fixture(t),target=MACHINES[1].id;
 f.setHandler((host,op,args)=>{
  if(op==='transfers.project.mode')return {mode:'full'};
  if(op==='transfers.project.prepare')return {id:args.id,token:'source-token'};
  if(op==='transfers.project.start')throw Error('lost response after starting copy');
  if(op==='transfers.cancel')return {id:args.id,state:'CANCELED'};
 });
 const submitted=await f.call('jobs.submit',{machine:target,sourceMachine:machine,project:'sample',cards:1,argv:['true'],key:randomUUID()},f.admin);
 await f.service.reconcile();const row=f.service.store.jobs.find(job=>job.id===submitted.id);
 assert.equal(row.projectPreparation,undefined);assert.equal(row.dispatchPending,true);
 await f.call('jobs.cancel',{jobId:row.id},f.admin);await f.service.reconcile();
 assert.equal(row.state,'CANCELED');
 assert.ok(f.calls.some(call=>call.host===target&&call.op==='transfers.cancel'&&call.args.id===row.id));
 assert.equal(f.calls.filter(call=>call.op==='sync').length,0);
});
test('unknown node transfer listings are reported as unknown, rather than an empty successful list',async t=>{
 const f=await fixture(t);f.setHandler(()=>{throw Object.assign(Error('offline'),{code:'NODE_CONNECT_FAILED'});});
 const value=await f.call('transfers.list');assert.equal(value.state,'UNKNOWN');assert.equal(value.transfers,null);assert.equal(value.partial,true);
});
test('HTTPS cloud imports keep the original target and can be resumed and discarded by another team member',async t=>{
 const f=await fixture(t),key=randomUUID(),requests=[];
 f.setHandler((_host,op,args)=>{if(['datasets.import.start','datasets.import.resume'].includes(op)){requests.push({op,...args});return {id:key,state:op==='datasets.import.resume'?'PENDING':'PAUSED',bytes:2};}if(op==='datasets.import.discard')return {discarded:true};});
 await f.call('cloud.import.start',{key,area:'dataset',dataset:'shared',path:'data.bin',url:'https://example.invalid/file',expectedBytes:4},f.alice);
 const resumed=await f.call('cloud.import.resume',{operationId:key,url:'https://example.invalid/file?fresh=1'},f.bob);
 assert.equal(requests[1].op,'datasets.import.resume');assert.equal(requests[1].operationId,key);assert.equal(resumed.state,'PENDING');assert.equal(resumed.bytes,2);
 await f.call('cloud.import.resume',{operationId:key},f.bob);
 assert.equal(requests.length,3);assert.equal(requests[1].dataset,'shared');assert.equal(requests[1].key,key);assert.equal(requests[1].userId,f.bobUser.id);assert.equal(requests[1].expectedBytes,4);
 assert.equal(requests[1].path,'data.bin');assert.equal(requests[1].url,'https://example.invalid/file?fresh=1');assert.equal(requests[2].url,requests[1].url);
 await f.call('cloud.import.discard',{operationId:key},f.bob);assert.equal(f.service.db.prepare('SELECT count(*) n FROM cloud_downloads').get().n,0);
});
test('output preview reads size without deleting files or creating a trash record',async t=>{
 const f=await fixture(t),jobId=randomUUID(),path=join(f.ssd,'outputs',jobId);await mkdir(path,{recursive:true});await writeFile(join(path,'result'),'preview');
 f.service.store.jobs.push({id:jobId,key:randomUUID(),userId:f.aliceUser.id,ownerId:f.aliceUser.id,machine,project:'sample',spec:{project:'sample'},state:'SUCCEEDED',cards:1});
 const view=await f.call('outputs.delete',{jobId,path:'result',dryRun:true});assert.equal(view.state,'PREVIEW');assert.equal(view.size,7);assert.equal(await readFile(join(path,'result'),'utf8'),'preview');assert.equal(f.calls.filter(row=>row.op==='outputs.delete').length,0);
});

test('cloud files forward real non-UUID file IDs, path and size without proof fields',async t=>{
 const f=await fixture(t),key=randomUUID(),fileId='real-cloud-file-id_42';let request;
 f.setHandler((_host,operation,args)=>{if(operation==='datasets.cloud.download'){request=args;return {operationId:key,state:'PENDING'};}});
 await f.call('cloud.files.download',{key,area:'dataset',dataset:'shared',fileId,path:'download.bin',size:17,proof:'ignored',receipt:'ignored',sha256:'ignored'});
 assert.equal(request.fileId,fileId);assert.equal(request.path,'download.bin');assert.equal(request.size,17);assert.equal(request.key,key);
 for(const key of ['proof','receipt','sha256','totalBytes'])assert.equal(Object.hasOwn(request,key),false);
});

test('cloud browsing and server-file upload stay available without credentials or verification fields in member requests',async t=>{
 const f=await fixture(t),key=randomUUID(),seen=[];f.setHandler((_host,op,args)=>{if(op==='datasets.cloud.list'){seen.push({op,args});return {files:[{fileId:'remote-cloud-id',path:'shared/data.bin',size:17}]};}if(op==='datasets.cloud.upload'){seen.push({op,args});return {operationId:key,fileId:'real-new-cloud-id',size:17,state:'SUCCEEDED'};}});
 assert.equal((await f.call('cloud.files.list')).files[0].fileId,'remote-cloud-id');
 const value=await f.call('cloud.files.upload',{key,area:'dataset',dataset:'shared',path:'data.bin',name:'data.bin',size:17,receipt:'ignored',verify:true,privateConfig:'ignored'});assert.equal(value.fileId,'real-new-cloud-id');assert.equal(value.size,17);assert.equal(seen[1].args.size,17);assert.equal(seen[1].args.name,'data.bin');for(const name of ['receipt','verify','privateConfig'])assert.equal(Object.hasOwn(seen[1].args,name),false);
});

test('shared collaboration has no minute-based posting gate and task notes read only the current durable state',async t=>{
 const f=await fixture(t);
 for(let index=0;index<4;index++)assert.ok((await f.call('community.posts.create',{key:randomUUID(),kind:'discussion',title:'team '+index,body:'shared'},f.alice)).post.id);
 const jobId=randomUUID();f.service.store.jobs.push({id:jobId,userId:f.aliceUser.id,machine,project:'sample',state:'RUNNING',cards:1,spec:{argv:['true']}});f.service.save();
 const note=(await f.call('community.notes.create',{key:randomUUID(),jobId,body:'running task'},f.bob)).note;
 f.service.store.jobs.at(-1).state='SUCCEEDED';assert.ok((await f.call('community.notes.list')).notes.some(row=>row.id===note.id));
 f.service.save();assert.ok(!(await f.call('community.notes.list')).notes.some(row=>row.id===note.id));
 assert.deepEqual(f.service.db.prepare('PRAGMA table_info(community_keys_v2)').all().map(row=>row.name),['author_id','client_key','operation','entity_id','created_at']);
});

test('cloud.info exposes disconnected, connected and reconnect states throughout the administrator auth flow',async t=>{
 const f=await fixture(t);let connected=false,scans=0;
 f.service.cloudProvider={connected:()=>connected,begin:async()=>({secret:'node-private-scan-'+(++scans),image:'data:image/png;base64,AA==',expiresAt:Date.now()+60000}),poll:async()=>{connected=true;return {state:'CONFIRMED'};},clear:()=>{connected=false;}};
 assert.deepEqual([(await f.call('cloud.info')).aliyunConnected,(await f.call('cloud.info')).status],[false,'disconnected']);
 await assert.rejects(f.call('cloud.auth.begin',{},f.bob),e=>e.status===403);
 for(let index=0;index<2;index++){
  const login=await f.call('cloud.auth.begin',{},f.admin);assert.equal(typeof login.id,'string');assert.equal(Object.hasOwn(login,'secret'),false);
  assert.equal((await f.call('cloud.auth.poll',{id:login.id},f.admin)).state,'CONFIRMED');const info=await f.call('cloud.info');assert.equal(info.aliyunConnected,true);assert.equal(info.status,'connected');
  await f.call('cloud.auth.disconnect',{},f.admin);assert.equal((await f.call('cloud.info')).status,'disconnected');
 }
 assert.equal(scans,2);
});
