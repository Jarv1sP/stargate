import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {PortalService} from '../portal-service.mjs';
import {executionCall} from '../execution.mjs';
import {MACHINES} from '../dist/model.js';

const [blocked,allowed,second]=MACHINES.map(row=>row.id),password='Local-Server-Access-Fixture-2026!';
const noServers='你还没有开通任何服务器，请联系管理员审批额度。';
const denied=(machine,servers=[allowed,second])=>`你没有 ${machine} 的使用权限。你可以使用：${servers.join('、')}。需要其他服务器请联系管理员开通。`;
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'server-access-')),bootstrap=join(root,'bootstrap');
 await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
 const calls=[],service=await PortalService.open(join(root,'db'),bootstrap,undefined,async(machine,operation,args)=>{
  calls.push({machine,operation,args});
  if(operation==='projects.list')return {projects:[{project:'team',ownerId:'builtin-admin'}]};
  if(operation==='transfers.list')return {transfers:[]};
  return {state:'AVAILABLE',entries:[],datasets:[],project:'team',ownerId:'builtin-admin'};
 });
 clearInterval(service.executionTimer);const admin=await service.login('admin',password);
 const member=(await service.invoke(admin.token,'users.create',{username:'access-member',password})).result;
 await service.invoke(admin.token,'policy.save',{userId:member.id,total:2,limits:{[allowed]:1,[second]:1}});
 const login=await service.login(member.username,password),principal=service.principal(login.token);
 const job={id:randomUUID(),key:randomUUID(),userId:'builtin-admin',ownerId:'builtin-admin',machine:blocked,project:'team',name:'team task',state:'RUNNING',cards:1,nodeJobId:'J0123456789ab',spec:{argv:['true'],project:'team'}};
 service.store.jobs.push(job);service.save();
 t.after(async()=>{await service.tail;service.close();await rm(root,{recursive:true,force:true});});
 return {root,service,calls,admin,member,login,principal,job,call:(op,args,token=login.token)=>service.invoke(token,op,args)};
}

test('all machine operations reject ungranted servers before contacting nodes and list usable servers',async t=>{
 const f=await fixture(t),key=randomUUID(),terminal={machine:blocked,project:'team',key,clientId:randomUUID(),mode:'new'},file={machine:blocked,area:'code',project:'team',path:'note.txt'};
 const operations=[
  ...['create','list','status','quota','retire.list'].map(action=>['projects.'+action,{machine:blocked,project:'team'}]),
  ['projects.label.get',{machine:blocked,project:'team'}],['projects.shared.set',{machine:blocked,project:'team',shared:true}],
  ['terminal.open',terminal],['terminal.status',{machine:blocked,id:key}],
  ['data.upload.begin',{...file,key,totalSize:3}],...['status','chunk','finish','cancel'].map(action=>['data.upload.'+action,{machine:blocked,key,offset:0,data:'YWJj'}]),
  ['datasets.list',{machine:blocked}],['datasets.delete',{machine:blocked,dataset:'images',key}],
  ['files.list',file],['files.get',file],['files.direct-ticket',{...file,action:'get'}],
  ['jobs.submit',{machine:blocked,project:'team',key,cards:1,argv:['true']}],
  ...['cancel','logs','watch','completion','diagnostics','reconcile-resources'].map(action=>['jobs.'+action,{jobId:f.job.id}]),
  ['jobs.priority',{jobId:f.job.id,priority:'P2'}],['outputs.delete',{jobId:f.job.id,key}],['notifications.job',{jobId:f.job.id,enabled:false}],
  ['cloud.inspect',{machine:blocked,url:'https://example.test/share'}],['cloud.import.list',{machine:blocked}],['cloud.files.list',{machine:blocked}],
  ['storage.snapshot',{machine:blocked}],['storage.refresh',{machine:blocked}],
  ['transfers.create',{machine:allowed,from:blocked,kind:'copy',key,reference:{dataset:'images'}}],
  ['transfers.create',{machine:blocked,from:allowed,kind:'copy',key,reference:{project:'team'}}]
 ];
 for(const [op,args] of operations)await assert.rejects(f.call(op,args),error=>error.status===403&&error.message===denied(blocked),op);
 assert.equal(f.calls.length,0);assert.equal(f.job.cancelRequested,undefined);
 assert.equal(f.service.db.prepare('SELECT COUNT(*) AS n FROM directory_transfers').get().n,0);
 for(const op of ['jobs.cancel','jobs.reconcile-resources','outputs.delete'])await assert.rejects(executionCall(f.service,f.principal,op,{jobId:f.job.id,key}),error=>error.status===403,op+' direct dispatcher');
 assert.equal(f.calls.length,0);
});

test('granted servers work for any project owner and admins retain access to every server',async t=>{
 const f=await fixture(t);
 for(const token of [f.login.token,f.admin.token]){
  const machine=token===f.login.token?allowed:blocked;
  for(const [op,args] of [['projects.create',{project:'team',ownerId:'builtin-admin'}],['projects.list',{}],['terminal.open',{project:'team',key:randomUUID(),clientId:randomUUID(),mode:'new'}],['data.upload.begin',{area:'dataset',dataset:'images',path:'note.txt',key:randomUUID(),totalSize:3}],['files.list',{area:'code',project:'team',path:'.'}]])await f.call(op,{machine,...args},token);
 }
 assert.equal(f.calls.length,10);
});

test('aggregate project and transfer lists only query servers the member can use',async t=>{
 const f=await fixture(t);
 const catalog=(await f.call('projects.catalog',{})).result;
 assert.deepEqual([...new Set(catalog.groups.flatMap(group=>group.instances.map(row=>row.machine)))],[allowed,second]);
 await f.call('transfers.list',{});
 assert.ok(f.calls.length>0);assert.ok(f.calls.every(call=>[allowed,second].includes(call.machine)));
});

test('a member with no grants receives the actionable approval message',async t=>{
 const f=await fixture(t);await f.service.invoke(f.admin.token,'policy.save',{userId:f.member.id,total:0,limits:{}});
 for(const [op,args] of [['projects.create',{machine:blocked,project:'team'}],['terminal.open',{machine:blocked}],['datasets.list',{machine:allowed}],['files.get',{machine:allowed,area:'code',project:'team',path:'x'}]])await assert.rejects(f.call(op,args),error=>error.status===403&&error.message===noServers,op);
 assert.equal(f.calls.length,0);
});

test('revoked transfer access rejects cached status and progress before changing the original record',async t=>{
 const f=await fixture(t),key=randomUUID();
 await f.call('transfers.create',{key,kind:'upload',machine:allowed,reference:{dataset:'images'}});
 await f.service.invoke(f.admin.token,'policy.save',{userId:f.member.id,total:1,limits:{[second]:1}});
 const before=f.service.db.prepare('SELECT data FROM directory_transfers WHERE id=?').get(key).data;
 for(const action of ['status','progress','cancel','resume'])await assert.rejects(f.call('transfers.'+action,{id:key,bytes:1}),error=>error.status===403&&error.message===denied(allowed,[second]),action);
 assert.equal(f.service.db.prepare('SELECT data FROM directory_transfers WHERE id=?').get(key).data,before);assert.equal(f.calls.length,0);
});

test('cached transfer lists and status hide copies involving an ungranted source or target',async t=>{
 const f=await fixture(t),hiddenSource=randomUUID(),hiddenTarget=randomUUID(),visible=randomUUID(),unindexed=randomUUID();
 for(const row of [
  {id:hiddenSource,machine:allowed,from:blocked,reference:{project:'hidden-project',ownerId:'hidden-owner',jobId:'hidden-run'}},
  {id:hiddenTarget,machine:blocked,from:allowed,reference:{project:'hidden-project',ownerId:'hidden-owner',jobId:'hidden-run'}},
  {id:visible,machine:allowed,from:second,reference:{project:'team'}}
 ])f.service.db.prepare('INSERT INTO directory_transfers VALUES(?,?)').run(row.id,JSON.stringify({...row,key:row.id,kind:'copy',state:'RUNNING'}));
 f.service.bridge=async(machine,operation,args)=>{
  f.calls.push({machine,operation,args});
  const rows=[hiddenSource,visible,unindexed].map(id=>({id,state:'RUNNING',source:{project:id===visible?'team':'hidden-project',ownerId:id===visible?'team-owner':'hidden-owner',jobId:id===visible?'team-run':'hidden-run'},target:{project:'team'}}));
  return operation==='transfers.list'?{transfers:machine===allowed?rows:[]}:{...rows.find(row=>row.id===args.id)};
 };
 const list=(await f.call('transfers.list',{})).result;
 assert.deepEqual(list.transfers.map(row=>row.id),[visible]);assert.doesNotMatch(JSON.stringify(list),/hidden-project|hidden-owner|hidden-run/);
 assert.ok(f.calls.every(call=>call.machine!==blocked));
 assert.equal(list.transfers.some(row=>row.id===hiddenSource||row.id===hiddenTarget||row.id===unindexed),false);
 f.calls.length=0;
 for(const id of [hiddenSource,hiddenTarget])await assert.rejects(f.call('transfers.status',{id}),error=>error.status===403&&error.message===denied(blocked));
 const unknown=(await f.call('transfers.status',{id:unindexed,machine:allowed})).result;
 assert.equal(unknown.state,'UNKNOWN');assert.equal(unknown.source,undefined);assert.equal(f.calls.length,0);
 const adminList=(await f.call('transfers.list',{},f.admin.token)).result;
 assert.ok(adminList.transfers.some(row=>row.id===hiddenSource));assert.ok(adminList.transfers.some(row=>row.id===unindexed));
});

test('revoking a source grant during transfer cancellation returns 403 without the copy metadata',async t=>{
 const f=await fixture(t),id=randomUUID();
 f.service.db.prepare('INSERT INTO directory_transfers VALUES(?,?)').run(id,JSON.stringify({id,key:id,kind:'copy',machine:allowed,from:second,reference:{project:'team',environment:true},state:'RUNNING'}));
 f.service.bridge=async()=>{delete f.service.store.users.find(user=>user.id===f.member.id).limits[second];return {state:'CANCELED'};};
 await assert.rejects(f.call('transfers.cancel',{id}),error=>error.status===403&&error.message===denied(second,[allowed]));
});

test('job observation fallbacks preserve a revoked grant error instead of returning task details',async t=>{
 const f=await fixture(t);f.job.machine=allowed;
 for(const state of ['RUNNING','SUCCEEDED'])for(const operation of ['jobs.watch','jobs.completion','jobs.diagnostics']){
  f.job.state=state;f.service.store.users.find(user=>user.id===f.member.id).limits[allowed]=1;
  f.service.bridge=async()=>{delete f.service.store.users.find(user=>user.id===f.member.id).limits[allowed];return {state:'SUCCEEDED'};};
  await assert.rejects(executionCall(f.service,f.principal,operation,{jobId:f.job.id}),error=>error.status===403&&error.message===denied(allowed,[second]),operation+'/'+state);
 }
});

async function cliFixture(t){
 const f=await fixture(t),requests=[];
 const server=createServer(async(req,res)=>{
  try{let raw='';for await(const data of req)raw+=data;const body=JSON.parse(raw);requests.push(body);
   const reply=await f.service.invoke(f.login.token,body.operation,body.args);res.setHeader('content-type','application/json');res.end(JSON.stringify(reply));
  }catch(error){res.writeHead(error.status||500,{'content-type':'application/json'});res.end(JSON.stringify({error:error.message}));}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port,session=join(f.root,'session.json');
 await writeFile(session,JSON.stringify({url,token:f.login.token,principal:f.login.principal}));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const run=args=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[new URL('../cli.mjs',import.meta.url).pathname,'--session-file',session,...args],{stdio:['ignore','pipe','pipe']});let out='',err='';
  child.stdout.on('data',data=>out+=data);child.stderr.on('data',data=>err+=data);child.once('error',reject);child.once('close',code=>resolve({code,out,err}));
 });
 return {...f,run,session,requests};
}

test('CLI use rejects ungranted servers without saving the selection; profile lists granted servers',async t=>{
 const f=await cliFixture(t),bad=await f.run(['use',blocked]);assert.equal(bad.code,1);assert.ok(bad.err.includes(denied(blocked)),bad.err);
 assert.equal(JSON.parse(await readFile(f.session,'utf8')).machine,undefined);
 const good=await f.run(['use',allowed]);assert.equal(good.code,0,good.err);assert.equal(JSON.parse(await readFile(f.session,'utf8')).machine,allowed);
 const profile=await f.run(['profile']);assert.equal(profile.code,0,profile.err);assert.ok(profile.out.includes('可用服务器：'+[allowed,second].join('、')),profile.out);
});

test('CLI defaults to the sole granted server even when the platform has several servers',async t=>{
 const f=await cliFixture(t);await f.service.invoke(f.admin.token,'policy.save',{userId:f.member.id,total:1,limits:{[second]:1}});
 const created=await f.run(['project','create','team']);assert.equal(created.code,0,created.err);
 assert.equal(f.calls.find(call=>call.operation==='projects.create').machine,second);
 assert.deepEqual(f.requests.filter(row=>row.operation==='state').map(row=>row.args),[{view:'summary'}]);
});
