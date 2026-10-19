import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/model.js';

const machine=MACHINES[0].id,password='Job-Control-Local-Fixture-2026!';
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'job-control-')),bootstrap=join(dir,'bootstrap'),calls=[];
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+reserve.address().port;await new Promise(r=>reserve.close(r));
  const {server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,origin,secure:false,bridge:async(host,op,args)=>{
    calls.push({host,op,args});
    if(op==='logs')return {text:'shared log'};
    if(op==='diagnostics')return {state:'COMPLETE',captures:[]};
    if(op==='jobs.reconcile-resources')return {resourcesReleased:true};
    if(op==='terminal.close')return {id:args.id,state:'STOPPED'};
    return {nodeJobId:'J0123456789ab',state:op==='priority'?'PENDING':'SUCCEEDED',schedulerPriority:4,priority:'P4',assignedIndices:[]};
  }});
  for(const name of ['executionTimer','notificationTimer','maintenanceTimer','transferTimer','storageArchiveTimer','projectCopyTimer'])clearInterval(service[name]);
  service.reconcile=async()=>{};
  await new Promise(r=>server.listen(new URL(origin).port,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
  const admin=await service.login('admin',password),members={};
  for(const username of ['alice','bob']){
    const user=(await service.invoke(admin.token,'users.create',{username,password})).result;
    members[username]={user,...await service.login(username,password)};
  }
  const id=randomUUID(),job={id,key:id,userId:members.bob.user.id,username:'bob',ownerId:members.alice.user.id,
    project:'shared',interactive:true,machine,cards:1,state:'PENDING',nodeJobId:'J0123456789ab',
    spec:{id,userId:members.bob.user.id,ownerId:members.alice.user.id,project:'shared',interactive:true,argv:['bash']}};
  service.store.jobs.push(job);service.save();
  const request=async(actor,operation,args)=>{
    const response=await fetch(origin+'/api/call',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+actor.token},
      body:JSON.stringify({operation,args,client:{name:'gpuctl',protocol:2}})});
    return {status:response.status,body:await response.json()};
  };
  return {dir,origin,service,admin,...members,job,calls,request};
}
const controls=job=>[
  ['jobs.cancel',{jobId:job.id}],
  ['jobs.priority',{jobId:job.id,priority:'P4'}],
  ['terminal.close',{machine,id:job.id,project:job.project}],
  ['terminal.exchange',{machine,id:job.id,project:job.project,clientId:randomUUID(),writerToken:randomUUID(),input:Buffer.from([3]).toString('base64')}],
];

test('a peer cannot cancel, reprioritize, close or send input to a GPU job, even when they own the project',async t=>{
  const f=await fixture(t),before=structuredClone(f.job);
  for(const [operation,args] of controls(f.job)){
    const response=await f.request(f.alice,operation,{...args,userId:f.bob.user.id,actor:{isAdmin:true}});
    assert.equal(response.status,403,operation);assert.equal(response.body.error,'只能操作自己的任务');
    assert.deepEqual(f.job,before);assert.deepEqual(f.calls,[]);
  }
});

for(const role of ['bob','admin'])test(`${role==='bob'?'the submitter':'an administrator'} can perform every existing job control`,async t=>{
  const f=await fixture(t),actor=f[role];
  for(const [operation,args] of controls(f.job)){
    f.job.state='PENDING';delete f.job.cancelRequested;
    const response=await f.request(actor,operation,args);assert.equal(response.status,200,operation);
    if(operation==='jobs.cancel')assert.equal(f.job.cancelRequested,true);
    if(operation==='jobs.priority')assert.equal(response.body.result.schedulerPriority,4);
    if(operation==='terminal.close')assert.equal(response.body.result.state,'STOPPED');
  }
});

test('team members retain logs, diagnostics, observations and completion reads, and ordinary project terminal close',async t=>{
  const f=await fixture(t);f.job.state='SUCCEEDED';
  for(const operation of ['jobs.logs','jobs.diagnostics','jobs.watch','jobs.completion','jobs.reconcile-resources'])
    assert.equal((await f.request(f.alice,operation,{jobId:f.job.id})).status,200,operation);
  assert.equal((await f.request(f.alice,'terminal.exchange',{machine,id:f.job.id,project:'shared',clientId:randomUUID(),writerToken:randomUUID()})).status,200);
  assert.equal((await f.request(f.alice,'terminal.close',{machine,id:randomUUID(),project:'shared'})).status,200);
});

test('cancel and priority CLI commands show the actual 403 message, in plain and JSON output',async t=>{
  const f=await fixture(t),session=join(f.dir,'session.json');
  await writeFile(session,JSON.stringify({url:f.origin,token:f.alice.token,principal:f.alice.principal}));
  for(const json of [false,true])for(const args of [['cancel',f.job.id],['priority',f.job.id,'P4']]){
    const result=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,['cli.mjs','--url',f.origin,'--session-file',session,...json?['--json']:[],...args],{cwd:new URL('..',import.meta.url)});
      let stdout='',stderr='';child.stdout.on('data',part=>stdout+=part);child.stderr.on('data',part=>stderr+=part);
      child.once('error',reject);child.once('close',code=>resolve({code,stdout,stderr}));child.stdin.end();
    });
    assert.equal(result.code,1);assert.equal(result.stdout,'');
    if(json)assert.match(JSON.parse(result.stderr).error,/只能操作自己的任务/);else assert.match(result.stderr,/只能操作自己的任务/);
    assert.equal(f.job.cancelRequested,undefined);assert.deepEqual(f.calls,[]);
  }
});
