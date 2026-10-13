import test from 'node:test';
import assert from 'node:assert/strict';
import {executionCall,usage} from '../execution.mjs';
import {terminalNativeObservation,nativeObservationText} from '../job-observation.mjs';
import {watchJob} from '../job-watch.mjs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createPortalServer} from '../portal-server.mjs';

const ID='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',NODE='J0123456789ab';
const fixture=()=>{
  const owner={id:'demo-user-1',enabled:true,limits:{'gpu-1':1}},other={id:'demo-user-2',enabled:true,limits:{'gpu-1':1}};
  const job={id:ID,userId:owner.id,machine:'gpu-1',nodeJobId:NODE,state:'CANCELED',cancelRequested:true,cards:1,
    checkedAt:'2026-01-01T00:00:00Z',finishedAt:'2026-01-01T00:00:00Z',spec:{id:ID,userId:owner.id,argv:['train']},
    latestAttempt:{id:'Aold',ordinal:1,state:'CANCELED',startedAt:50,finishedAt:100},
    dataPreparationHold:{state:'RELEASED',spec:{id:ID,userId:owner.id,argv:['train']}},assignedIndices:[],actualCards:0};
  const raw={protocol:'native-observation-v1',status:'CONFIRMED',jobId:ID,userId:owner.id,nodeJobId:NODE,submitKey:ID,specVerified:true,
    state:'PENDING',nativeVersion:7,observedAt:300,latestRetry:{eventId:9,createdAt:200},
    latestAttempt:{id:'Aold',ordinal:1,state:'CANCELED',started_at:50,finished_at:100},progress:null};
  const calls=[],service={store:{get:id=>[owner,other].find(user=>user.id===id),jobs:[job]},save(){assert.fail('Observation must never save lifecycle');},
    bridge:async(...args)=>{calls.push(args);return {nodeJobId:NODE,state:'PENDING',nativeObservation:raw};}};
  return {owner,other,job,raw,calls,service,principal:{userId:owner.id,role:'member'}};
};

test('same-attempt pending retry is observed without changing canceled lifecycle, holds or quota',async()=>{
  const f=fixture(),before=structuredClone(f.job);
  const result=await executionCall(f.service,f.principal,'jobs.watch',{jobId:ID});
  assert.equal(result.state,'CANCELED');assert.equal(result.cancelRequested,true);
  assert.equal(result.nativeObservation.state,'PENDING');assert.equal(result.nativeObservation.retryDetected,true);
  assert.equal(result.nativeObservation.manualRecovery.reason,'HOST_RETRY_REQUIRES_EXPLICIT_RECOVERY');
  assert.equal(usage(f.service.store.jobs,f.owner.id),0);assert.deepEqual(f.job,before);
  assert.deepEqual(f.calls,[['gpu-1','watch',{job:f.job.spec,expectedNodeJobId:NODE}]]);
});

test('failed history and current running attempt are separate, including diagnostics',async()=>{
  const f=fixture();f.job.state='FAILED';f.job.cancelRequested=false;
  Object.assign(f.raw,{state:'RUNNING',latestAttempt:{id:'Anew',ordinal:4,state:'RUNNING',started_at:250,finished_at:null}});
  const before=structuredClone(f.job);
  const result=await executionCall(f.service,f.principal,'jobs.diagnostics',{jobId:ID});
  assert.equal(result.portalTerminal.state,'FAILED');assert.equal(result.nativeObservation.state,'RUNNING');
  assert.equal(result.nativeObservation.latestAttempt.ordinal,4);assert.equal(result.nativeObservation.retryDetected,true);
  assert.deepEqual(f.job,before);assert.equal(f.calls[0][1],'diagnostics');
});

test('native activity without a later trustworthy retry event is not a proven retry',()=>{
  for(const patch of [{latestRetry:null},{latestRetry:{eventId:9,createdAt:99}}]){
    const f=fixture(),value=terminalNativeObservation(f.job,{...f.raw,...patch});
    assert.equal(value.retryDetected,false);assert.equal(value.manualRecovery.reason,'TERMINAL_DIVERGENCE_UNCONFIRMED');
  }
  const f=fixture();delete f.job.latestAttempt.finishedAt;
  assert.equal(terminalNativeObservation(f.job,f.raw).retryDetected,false);
});

test('mismatched identity, stale attempt and invalid evidence fail closed without leaking raw fields',()=>{
  const f=fixture();
  for(const patch of [{nodeJobId:'Jffffffffffff'},{jobId:'other'},{userId:'demo-user-2'},{submitKey:'other'},
    {specVerified:false},{nativeVersion:-1},{nativeVersion:true},{state:'invented'},
    {latestAttempt:{id:'Awrong',ordinal:1}},{latestAttempt:null},{latestRetry:{eventId:9,createdAt:400}},
    {latestRetry:{eventId:0,createdAt:200}},{observedAt:Infinity},{status:'UNKNOWN'}]){
    const result=terminalNativeObservation(f.job,{...f.raw,...patch,secret:'do-not-leak'});
    assert.equal(result.status,'UNKNOWN',JSON.stringify(patch));assert.equal(result.retryDetected,false);
    assert.doesNotMatch(JSON.stringify(result),/do-not-leak/);
  }
});

test('authorization and public argument allowlist precede observation, with no control fallback',async()=>{
  const f=fixture();
  for(const op of ['jobs.watch','jobs.diagnostics']){
    await assert.rejects(executionCall(f.service,{userId:f.other.id,role:'member'},op,{jobId:ID}),e=>e.status===403);
    await assert.rejects(executionCall(f.service,f.principal,op,{jobId:ID,expectedNodeJobId:NODE}));
    f.owner.enabled=false;await assert.rejects(executionCall(f.service,f.principal,op,{jobId:ID}),e=>e.status===403);f.owner.enabled=true;
    f.owner.limits={};await assert.rejects(executionCall(f.service,f.principal,op,{jobId:ID}),e=>e.status===403);f.owner.limits={'gpu-1':1};
  }
  assert.equal(f.calls.length,0);
});

test('missing native ID, old node and timeout keep terminal immutable and never sync',async()=>{
  const f=fixture(),before=structuredClone(f.job);
  f.service.bridge=async(...args)=>{f.calls.push(args);throw Error('private transport error');};
  const failed=await executionCall(f.service,f.principal,'jobs.watch',{jobId:ID});
  assert.equal(failed.nativeObservation.status,'UNKNOWN');assert.doesNotMatch(JSON.stringify(failed),/private transport/);
  const unavailable=await executionCall(f.service,f.principal,'jobs.diagnostics',{jobId:ID});
  assert.equal(unavailable.state,'UNAVAILABLE');assert.equal(unavailable.portalTerminal.state,'CANCELED');
  assert.equal(unavailable.nativeObservation.status,'UNKNOWN');assert.doesNotMatch(JSON.stringify(unavailable),/private transport/);
  assert.deepEqual(f.job,before);f.service.bridge=async()=>({state:'PENDING',nodeJobId:NODE});
  assert.equal((await executionCall(f.service,f.principal,'jobs.watch',{jobId:ID})).nativeObservation.status,'UNKNOWN');
  delete f.job.nodeJobId;f.service.bridge=()=>assert.fail('No node ID must not query or submit');
  assert.equal((await executionCall(f.service,f.principal,'jobs.watch',{jobId:ID})).state,'CANCELED');
});

test('CLI renders both states and preserves terminal exit semantics without retry/cancel',async()=>{
  const f=fixture(),job={...f.job,nativeObservation:terminalNativeObservation(f.job,f.raw)},calls=[],out=[];
  const exit=await watchJob(async(op,args)=>{calls.push({op,args});return {result:job};},ID,{write:line=>out.push(line)});
  assert.equal(exit,130);assert.match(out.join(''),/CANCELED.*节点只读观察：PENDING/s);
  assert.match(out.join(''),/已确认宿主手动重试/);assert.match(out.join(''),/未批准或执行新的重试/);
  assert.deepEqual(calls,[{op:'jobs.watch',args:{jobId:ID}}]);
  assert.match(nativeObservationText({status:'UNKNOWN'}),/UNKNOWN/);
  assert.match(out.join(''),/门户历史结果（命令退出码仍按此结果）/);
});

test('real HTTP and downloaded CLI return observation while SQLite history remains byte-equivalent',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-native-observation-')),bootstrap=join(dir,'bootstrap');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Observation-Fixture-2026!'}));
  const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));const origin='http://127.0.0.1:'+port;
  const f=fixture(),calls=[];
  const bridge=async(machine,operation,args)=>{
    calls.push({machine,operation,args});assert.ok(['watch','diagnostics'].includes(operation));
    assert.equal(args.expectedNodeJobId,NODE);assert.deepEqual(args.job,f.job.spec);
    return {jobId:ID,nodeJobId:NODE,state:operation==='diagnostics'?'PARTIAL':'PENDING',nativeObservation:f.raw};
  };
  const {server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,origin,secure:false,bridge});
  clearInterval(service.executionTimer);await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const login=await service.login('admin','Observation-Fixture-2026!');
  f.job.userId=login.principal.userId;f.job.spec.userId=login.principal.userId;f.job.dataPreparationHold.spec.userId=login.principal.userId;f.raw.userId=login.principal.userId;
  service.store.jobs.push(f.job);service.save();const before=service.db.prepare('SELECT data FROM portal_state').get().data;
  const api=async operation=>{
    const r=await fetch(origin+'/api/call',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+login.token},body:JSON.stringify({operation,args:{jobId:ID}})});
    assert.equal(r.status,200);return (await r.json()).result;
  };
  const observed=await api('jobs.watch');assert.equal(observed.state,'CANCELED');assert.equal(observed.nativeObservation.state,'PENDING');
  const diagnostic=await api('jobs.diagnostics');assert.equal(diagnostic.portalTerminal.state,'CANCELED');assert.equal(diagnostic.nativeObservation.retryDetected,true);
  const response=await fetch(origin+'/gpuctl.mjs');assert.equal(response.status,200);
  const file=join(dir,'gpuctl.mjs'),session=join(dir,'session');await writeFile(file,await response.text());
  await writeFile(session,JSON.stringify({url:origin,token:login.token,principal:login.principal}));
  const output=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[file,'--session-file',session,'watch',ID]);let stdout='',stderr='';
    child.stdout.on('data',s=>stdout+=s);child.stderr.on('data',s=>stderr+=s);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));
  });
  assert.equal(output.code,130,output.stderr);assert.match(output.stdout,/门户历史结果.*CANCELED.*节点只读观察：PENDING/s);
  assert.equal(service.db.prepare('SELECT data FROM portal_state').get().data,before);
  assert.deepEqual(calls.map(c=>c.operation),['watch','diagnostics','watch']);assert.equal(usage(service.store.jobs,f.job.userId),0);
  await service.invoke(login.token,'logout',{});
});
