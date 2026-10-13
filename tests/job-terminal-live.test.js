// Real native SQLite/cancel/finalize -> node -> Portal SQLite/HTTP/downloaded CLI.
// The only fake execution component is CUDA/systemd, never a training state.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {createPortalServer} from '../portal-server.mjs';
import {usage} from '../execution.mjs';

async function native(t,file='native-terminal-rpc.py'){
  const child=spawn('python3',['-B',fileURLToPath(new URL('./fixtures/'+file,import.meta.url))]);
  const readers=createInterface({input:child.stdout}),pending=new Map();let count=0,stderr='',readyResolve,readyReject;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  child.stderr.on('data',part=>{stderr+=part;});
  readers.on('line',line=>{
    const message=JSON.parse(line);
    if(message.ready){readyResolve(message);return;}
    const request=pending.get(message.id);if(!request)return;
    pending.delete(message.id);message.ok?request.resolve(message.result):request.reject(Error(message.error));
  });
  child.once('exit',code=>{const error=Error('native fixture exited '+code+': '+stderr);readyReject(error);for(const request of pending.values())request.reject(error);pending.clear();});
  t.after(async()=>{child.stdin.end();await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve));readers.close();});
  const info=await ready;
  return {...info,call:(operation,args={},extra={})=>new Promise((resolve,reject)=>{
    const id=++count;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,operation,args,...extra})+'\n');
  })};
}

async function fixture(t){
  const node=await native(t),dir=await mkdtemp(join(tmpdir(),'gpuq-terminal-live-')),bootstrap=join(dir,'bootstrap'),password=randomUUID()+randomUUID(),calls=[];
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));const origin='http://127.0.0.1:'+port;
  let sqlError=false;
  const bridge=async(machine,operation,args)=>{calls.push({machine,operation,args});return (await node.call(operation,args,{sqlError})).node;};
  const {server,service}=await createPortalServer({database:join(dir,'portal.db'),bootstrap,origin,secure:false,bridge});clearInterval(service.executionTimer);service.reconciling=true;
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));const admin=await service.login('admin',password);
  const member=(await service.invoke(admin.token,'users.create',{username:'alice',password})).result;
  await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:1,limits:{'gpu-1':1}});
  const login=await service.login('alice',password);assert.equal(login.principal.userId,node.job.userId);
  const job={id:node.job.id,userId:login.principal.userId,username:'alice',name:node.job.name,machine:'gpu-1',cards:1,state:'RUNNING',spec:node.job};
  service.store.jobs.push(job);service.save();
  const response=await fetch(origin+'/gpuctl.mjs');assert.equal(response.status,200);const client=join(dir,'gpuctl.mjs'),session=join(dir,'session');
  await writeFile(client,await response.text());await writeFile(session,JSON.stringify({url:origin,token:login.token,principal:login.principal}));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const watch=()=>service.invoke(login.token,'jobs.watch',{jobId:job.id}).then(reply=>reply.result);
  const cli=()=>new Promise(resolve=>{const child=spawn(process.execPath,[client,'--session-file',session,'watch',job.id,'--json']);let out='',err='';child.stdout.on('data',part=>out+=part);child.stderr.on('data',part=>err+=part);child.once('close',code=>resolve({code,out,err}));});
  const step=async()=>{service.reconciling=false;try{await service.reconcile();}finally{service.reconciling=true;}};
  return {node,calls,service,job,watch,cli,step,cancel:()=>service.invoke(login.token,'jobs.cancel',{jobId:job.id}),setSqlError:value=>sqlError=value,quota:()=>usage(service.store.jobs,job.userId)};
}

test('native cancel before drain stays UNKNOWN with quota; downloaded watch only inspects, and releases only after native finalize',async t=>{
  const f=await fixture(t);await f.node.call('cancel-native');
  assert.deepEqual(await f.node.call('state'),{jobState:'CANCELED',attemptState:'TERM_REQUESTED',leases:1});
  const observed=await f.watch();assert.equal(observed.state,'UNKNOWN');assert.equal(observed.schedulerState,'CANCELED');assert.deepEqual(observed.assignedIndices,[3]);assert.equal(f.quota(),1);
  const held=await f.cli();assert.equal(held.code,3,held.err);assert.equal(JSON.parse(held.out).state,'UNKNOWN');assert.ok(f.calls.every(call=>call.operation==='watch'));
  const stored=JSON.parse(f.service.db.prepare('SELECT data FROM portal_state WHERE id=1').get().data).jobs[0];assert.equal(stored.state,'UNKNOWN');
  const drained=await f.node.call('drain-native');assert.deepEqual(drained,{jobState:'CANCELED',attemptState:'CANCELED',leases:0});
  const done=await f.cli();assert.equal(done.code,130,done.err);assert.equal(JSON.parse(done.out).state,'CANCELED');assert.equal(f.quota(),0);assert.ok(f.calls.every(call=>call.operation==='watch'));
});

test('a node read-only SQL error cannot make a canceled-but-running task terminal or release quota',async t=>{
  const f=await fixture(t);await f.node.call('cancel-native');f.setSqlError(true);
  const result=await f.watch();assert.equal(result.state,'UNKNOWN');assert.equal(f.job.state,'RUNNING');assert.equal(f.quota(),1);
  const cli=await f.cli();assert.equal(cli.code,3,cli.err);assert.equal(f.quota(),1);assert.equal(f.job.finishedAt,undefined);
  f.setSqlError(false);assert.equal((await f.watch()).state,'UNKNOWN');assert.equal(f.quota(),1);
  await f.node.call('drain-native');assert.equal((await f.watch()).state,'CANCELED');assert.equal(f.quota(),0);
});

test('Portal cancellation goes through the real native cancel receipt and keeps quota until the native finalizer drains',async t=>{
  const f=await fixture(t);const requested=(await f.cancel()).result;
  assert.equal(requested.cancelRequested,true);assert.equal(requested.state,'RUNNING');assert.equal(f.quota(),1);
  await f.step();assert.equal(f.job.state,'UNKNOWN');assert.equal(f.quota(),1);
  assert.deepEqual(await f.node.call('state'),{jobState:'CANCELED',attemptState:'TERM_REQUESTED',leases:1});
  await f.node.call('drain-native');await f.step();assert.equal(f.job.state,'CANCELED');assert.equal(f.quota(),0);
  assert.deepEqual(f.calls.map(call=>call.operation),['cancel','cancel']);
});

async function workspaceFixture(t,{loseSubmitReply=false}={}){
  const node=await native(t,'native-workspace-rpc.py'),dir=await mkdtemp(join(tmpdir(),'gpuq-workspace-live-'));
  const bootstrap=join(dir,'bootstrap'),statusPath=join(dir,'status'),password=randomUUID()+randomUUID(),calls=[];
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(statusPath,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:[{
    id:'gpu-1',reachable:true,gpus:[{index:3,memoryTotalMiB:24576,memoryUsedMiB:22000,utilizationGpu:100}],
    gpuq:{connected:true,health:'ok',observeOnly:false,schedulableIndices:[],jobs:[]},
  }]}));
  const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
  const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));const origin='http://127.0.0.1:'+port;
  const bridge=async(machine,operation,args)=>{
    calls.push({machine,operation,args});const reply=await node.call(operation,args);
    if(operation==='sync'&&loseSubmitReply){loseSubmitReply=false;throw Error('fixture: native accepted, reply lost');}
    return reply.node;
  };
  const {server,service}=await createPortalServer({database:join(dir,'portal.db'),bootstrap,statusPath,origin,secure:false,bridge});
  clearInterval(service.executionTimer);service.reconciling=true;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  const admin=await service.login('admin',password);
  const member=(await service.invoke(admin.token,'users.create',{username:'alice',password})).result;
  assert.equal(member.id,node.owner);
  await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:1,limits:{'gpu-1':1}});
  const login=await service.login('alice',password),client=join(dir,'gpuctl.mjs'),session=join(dir,'session');
  const download=await fetch(origin+'/gpuctl.mjs');assert.equal(download.status,200);await writeFile(client,await download.text());
  await writeFile(session,JSON.stringify({url:origin,token:login.token,principal:login.principal,machine:'gpu-1',project:node.project}));
  const cli=args=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[client,'--session-file',session,'--json',...args]);let out='',err='';
    child.stdout.on('data',part=>out+=part);child.stderr.on('data',part=>err+=part);child.once('error',reject);
    child.once('close',code=>resolve({code,out,err}));
  });
  const step=async()=>{service.reconciling=false;try{await service.reconcile();}finally{service.reconciling=true;}};
  const watch=async jobId=>{
    const response=await fetch(origin+'/api/call',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+login.token},
      body:JSON.stringify({operation:'jobs.watch',args:{jobId}})});
    assert.equal(response.status,200);return (await response.json()).result;
  };
  return {node,service,calls,cli,watch,step,quota:()=>usage(service.store.jobs,member.id)};
}

for(const loseSubmitReply of [false,true])test(`downloaded CLI submits a live workspace to a busy native queue once; lost reply=${loseSubmitReply}`,async t=>{
  const f=await workspaceFixture(t,{loseSubmitReply}),key=randomUUID();
  const argv=['run','--project',f.node.project,'--key',key,'-g','1','--','python','train.py','--data','/data/hdd/sample'];
  const first=await f.cli(argv);assert.equal(first.code,0,first.err);
  assert.equal(f.service.store.jobs.length,1);const job=f.service.store.jobs[0],id=job.id;
  assert.equal(job.key,key);assert.equal(job.spec.workspace,true);assert.equal(Object.hasOwn(job.spec,'release'),false);
  await f.step();
  const queued=await f.node.call('facts',{jobId:id});
  assert.equal(queued.job.submit_key,id);assert.equal(queued.job.state,'PENDING');assert.equal(queued.submits,1);
  assert.equal(queued.nativeJobs,2);assert.equal(queued.blockerState,'RUNNING');assert.equal(queued.blockerLeases,1);
  assert.deepEqual(queued.attempts,[]);assert.deepEqual(queued.leases,[]);assert.equal(f.quota(),1);
  assert.deepEqual(queued.project,f.node.initial.project);
  assert.deepEqual(f.calls.map(call=>call.operation),['projects.workspace','sync']);
  if(loseSubmitReply){assert.equal(job.state,'SUBMITTING');assert.equal(job.submissionReconciliation.state,'CHECKING');}
  else assert.equal(job.state,'PENDING');
  const retry=await f.cli(argv);assert.equal(retry.code,0,retry.err);
  assert.equal(f.service.store.jobs.length,1);assert.equal(f.service.store.jobs[0].id,id);
  const watched=await f.watch(id);
  assert.equal(watched.state,'PENDING');assert.equal(job.nodeJobId,queued.job.id);
  assert.equal((await f.node.call('facts',{jobId:id})).submits,1);
  await f.node.call('start-target',{jobId:id});
  const running=await f.watch(id);assert.equal(running.state,'RUNNING');
  const cancel=await f.cli(['cancel',id]);assert.equal(cancel.code,0,cancel.err);await f.step();
  const stopping=await f.node.call('facts',{jobId:id});
  assert.equal(stopping.job.state,'CANCELED');assert.equal(stopping.attempts[0].state,'TERM_REQUESTED');
  assert.equal(stopping.leases.length,1);assert.equal(job.state,'UNKNOWN');assert.equal(f.quota(),1);
  assert.deepEqual(stopping.project,f.node.initial.project);
  await f.node.call('drain-target',{jobId:id});
  const done=await f.cli(['watch',id]);assert.equal(done.code,130,done.err);assert.equal(JSON.parse(done.out).state,'CANCELED');
  assert.equal(f.quota(),0);const final=await f.node.call('facts',{jobId:id});
  assert.deepEqual(final.leases,[]);assert.equal(final.submits,1);assert.deepEqual(final.project,f.node.initial.project);
  assert.ok(f.calls.every(call=>['projects.workspace','sync','watch','cancel'].includes(call.operation)));
});
