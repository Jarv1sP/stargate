import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {request,createServer as httpServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createPortalServer} from '../portal-server.mjs';
import {datasetReferences,usage} from '../execution.mjs';
import {MACHINES} from '../dist/model.js';
import {trainingPlan,trainingSource} from './training-storage-fixture.mjs';

const password='Dataset-Only-Test-Password-2026!';
const version='a'.repeat(64),otherVersion='b'.repeat(64);
const reference={dataset:'sample',version};

async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-datasets-api-'));
  const database=join(dir,'state.sqlite'),bootstrap=join(dir,'bootstrap.json'),statusPath=join(dir,'status.json');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(statusPath,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({
    id:m.id,reachable:true,gpus:Array.from({length:m.cards},(_,index)=>({index,memoryTotalMiB:32768})),
    gpuq:{connected:true,observeOnly:false,schedulableIndices:m.id==='gpu-1'?[0,1,2,3]:[0],jobs:[]}
  }))}));
  const calls=[],states=new Map(),deniedOwners=new Set();let failure=null,syncResult=null,syncFailure=null,listing=null;
  const bridge=async(machine,operation,args)=>{
    calls.push({machine,operation,args:structuredClone(args)});
    if(operation==='storage.training.plan')return trainingPlan(machine,args);
    if(operation.startsWith('datasets.')){
      if(failure)throw failure;
      if(!args.hostAdmin&&deniedOwners.has(args.userId))throw Error('dataset owner authorization required');
      if(operation==='datasets.list')return listing||{datasets:[{dataset:'sample',versions:[{version,state:states.get(machine+':sample')??'READY',canPrepare:true}]}]};
      const state=states.get(machine+':'+args.dataset)??'READY';
      if(state instanceof Error)throw state;
      if(operation==='datasets.training.status')return trainingSource(machine,args,{state});
      return {dataset:args.dataset,version:args.version,state,remainingBytes:state==='READY'?0:64};
    }
    if(operation.startsWith('terminal.'))return {id:args.id||args.key,writerToken:randomUUID(),offset:0,data:'',exited:false};
    if(syncFailure)throw syncFailure;
    return syncResult||{state:'PENDING',nodeJobId:'node-'+args.job.id,assignedIndices:[]};
  };
  const origin='https://gpuq.example.test';
  let server,service;
  async function start(){
    ({server,service}=await createPortalServer({database,bootstrap,origin,statusPath,bridge}));
    clearInterval(service.executionTimer);
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  }
  await start();
  let admin=await service.login('admin',password);
  const member=(await service.invoke(admin.token,'users.create',{username:'dataset-user',password})).result;
  const other=(await service.invoke(admin.token,'users.create',{username:'other-user',password})).result;
  let user=await service.login('dataset-user',password),outsider=await service.login('other-user',password);
  async function settle(){await new Promise(resolve=>setImmediate(resolve));while(service.reconciling)await new Promise(resolve=>setTimeout(resolve,5));}
  const post=(operation,args={},token=user.token)=>new Promise((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port:server.address().port,path:'/api/call',method:'POST',headers:{
      Host:'gpuq.example.test','Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})
    }},res=>{let data='';res.on('data',part=>data+=part);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(data)}));});
    req.on('error',reject);req.end(JSON.stringify({operation,args}));
  });
  return {get service(){return service},get user(){return user},get admin(){return admin},outsider,member,other,calls,states,deniedOwners,post,settle,
    fail:value=>failure=value,
    list:value=>listing=value,
    sync:result=>{syncResult=result;},syncFail:error=>{syncFailure=error;},
    grant:async(total=4,limits={'gpu-1':2,'gpu-2':2})=>service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:service.store.get(member.id).policyVersion,total,limits}),
    submit:more=>post('jobs.submit',{machine:'gpu-1',cards:1,argv:['python','train.py'],key:randomUUID(),datasets:[reference],...more}),
    reopen:async()=>{await settle();await new Promise(resolve=>server.close(resolve));await start();admin=await service.login('admin',password);user=await service.login('dataset-user',password);},
    close:async()=>{await settle();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
  };
}

test('opt-in dataset preparation is durable, reserves no GPU and dispatches only after local READY',async()=>{
  const f=await fixture();try{
    await f.grant();f.states.set('gpu-1:sample','REGISTERED');
    const submitted=await f.submit({prepareData:true});assert.equal(submitted.status,200,JSON.stringify(submitted.data));
    const id=submitted.data.result.id;assert.equal(submitted.data.result.state,'PREPARING_DATA');
    await f.settle();assert.equal(usage(f.service.store.jobs,f.member.id),0);assert.equal(f.calls.some(c=>c.operation==='sync'),false);
    await f.reopen();assert.equal(f.service.store.jobs.find(j=>j.id===id).state,'PREPARING_DATA');
    f.states.set('gpu-1:sample','READY');await f.service.reconcile();
    assert.equal(f.service.store.jobs.find(j=>j.id===id).state,'SUBMITTING');assert.equal(usage(f.service.store.jobs,f.member.id),1);
    await f.service.reconcile();assert.equal(f.calls.filter(c=>c.operation==='sync').length,1);
  }finally{await f.close();}
});
test('public foreign dataset metadata cannot prepare, label or enter a training preparation job',async()=>{
  const f=await fixture();try{
    await f.grant();f.states.set('gpu-1:sample','REGISTERED');
    for(const state of ['READY','PREPARING']){
      f.list({datasets:[{dataset:'sample',ownerIds:[f.other.id],versions:[{version,state,canPrepare:true}]}]});
      const catalog=await f.post('datasets.catalog',{machine:'gpu-1'});
      assert.equal(catalog.status,200);assert.equal(catalog.data.result.datasets[0].versions[0].canUse,false);
      assert.equal((await f.post('datasets.prepare',{machine:'gpu-1',...reference})).status,403);
      const submitted=await f.submit({prepareData:true});assert.equal(submitted.status,403,JSON.stringify(submitted.data));
      assert.equal((await f.post('datasets.label.set',{machine:'gpu-1',dataset:'sample',displayName:'Foreign',revision:0})).status,403);
    }
    await f.settle();assert.equal(f.service.store.jobs.length,0);assert.equal(usage(f.service.store.jobs,f.member.id),0);
    assert.equal(f.calls.some(c=>['datasets.prepare','transfers.create','sync'].includes(c.operation)),false);
    assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM dataset_labels').get().n,0);
  }finally{await f.close();}
});
test('zero-quota directory browsing never grants prepare, training or label rights',async()=>{
  const f=await fixture();try{
    f.list({datasets:[{dataset:'sample',ownerIds:[f.member.id],versions:[{version,state:'READY',canPrepare:true}]}]});
    for(const args of [{},{machine:'gpu-1'}]){
      const catalog=await f.post('datasets.catalog',args);assert.equal(catalog.status,200);
      assert.equal(catalog.data.result.datasets[0].versions[0].canUse,false);
    }
    assert.equal((await f.post('datasets.prepare',{machine:'gpu-1',...reference})).status,403);
    assert.equal((await f.submit({prepareData:true})).status,409);
    assert.equal((await f.post('datasets.label.set',{machine:'gpu-1',dataset:'sample',displayName:'No grant',revision:0})).status,403);
    await f.settle();assert.equal(f.service.store.jobs.length,0);assert.equal(usage(f.service.store.jobs,f.member.id),0);
    assert.ok(f.calls.every(c=>['datasets.list','transfers.capabilities'].includes(c.operation)));
  }finally{await f.close();}
});
test('explicit node authorization rejection is not converted into preparation availability',async()=>{
  const f=await fixture();try{
    await f.grant();f.states.set('gpu-1:sample',Object.assign(Error('read access revoked'),{status:403}));
    const result=await f.submit({prepareData:true});assert.equal(result.status,403,JSON.stringify(result.data));
    assert.equal(f.service.store.jobs.length,0);assert.equal(f.calls.some(c=>['datasets.prepare','sync'].includes(c.operation)),false);
  }finally{await f.close();}
});
test('canceling data preparation never dispatches or cancels a shared cache worker',async()=>{
  const f=await fixture();try{
    await f.grant();f.states.set('gpu-1:sample','REGISTERED');
    const j=(await f.submit({prepareData:true})).data.result;await f.settle();
    await f.post('jobs.cancel',{jobId:j.id});await f.settle();await f.service.reconcile();
    assert.equal(f.service.store.jobs.find(v=>v.id===j.id).state,'CANCELED');
    assert.equal(f.calls.some(c=>['sync','cancel'].includes(c.operation)),false);
  }finally{await f.close();}
});
test('proven pre-dispatch cache eviction ends cleanly, while unknown transport retains quota',async()=>{
  const f=await fixture();try{
    await f.grant();f.states.set('gpu-1:sample','REGISTERED');
    const created=await f.submit({prepareData:true});await f.settle();
    f.states.set('gpu-1:sample','READY');await f.service.reconcile();
    const job=f.service.store.jobs.find(value=>value.id===created.data.result.id);
    assert.equal(job.state,'SUBMITTING');assert.equal(usage(f.service.store.jobs,f.member.id),1);
    f.syncFail(Error('response lost'));await f.service.reconcile();
    assert.equal(job.state,'SUBMITTING');assert.equal(usage(f.service.store.jobs,f.member.id),1);
    job.submissionReconciliation.nextCheckAt=new Date(0).toISOString();
    f.syncFail(null);f.sync({state:'FAILED',notSubmitted:true,failureCode:'DATASET_NOT_READY',assignedIndices:[],error:'重新准备后新建任务。'});
    await f.service.reconcile();assert.equal(job.state,'FAILED');assert.equal(job.notSubmitted,true);
    assert.equal(job.failureCode,'DATASET_NOT_READY');assert.equal(usage(f.service.store.jobs,f.member.id),0);
    assert.match(job.error,/重新准备/);assert.ok(job.finishedAt);
  }finally{await f.close();}
});
test('administrator personal replica status prefers its verified alias over an old registered record',async()=>{
  const f=await fixture();try{
    f.states.set('gpu-1:sample','REGISTERED');
    f.service.datasetPhysicalReference=(owner,machine,ref)=>owner==='builtin-admin'?{...ref,dataset:'u-personal-copy'}:ref;
    let resolved=0;f.service.resolveDataset=async(owner,machine,ref)=>{assert.equal(owner,'builtin-admin');resolved++;return {status:{...ref,state:'READY'}};};
    const response=await f.post('datasets.status',{machine:'gpu-1',...reference},f.admin.token);
    assert.equal(response.status,200);assert.equal(response.data.result.state,'READY');assert.equal(resolved,1);
    assert.equal(f.calls.some(call=>call.operation==='datasets.status'),false);
  }finally{await f.close();}
});
test('preparation rechecks grants before taking a GPU reservation',async()=>{
  const f=await fixture();try{
    await f.grant();f.states.set('gpu-1:sample','REGISTERED');
    const j=(await f.submit({prepareData:true})).data.result;await f.settle();
    await f.grant(0,{});f.states.set('gpu-1:sample','READY');await f.service.reconcile();
    assert.equal(f.service.store.jobs.find(v=>v.id===j.id).state,'FAILED');assert.equal(f.calls.some(c=>c.operation==='sync'),false);
  }finally{await f.close();}
});
test('occupied GPU quota does not block staging a next job, but staging cannot spend that quota',async()=>{
  const f=await fixture();try{
    await f.grant(1,{'gpu-1':1});
    const running=await f.submit();assert.equal(running.status,200);await f.settle();
    f.states.set('gpu-1:sample','REGISTERED');
    const next=await f.submit({prepareData:true});assert.equal(next.status,200,JSON.stringify(next.data));await f.settle();
    const job=f.service.store.jobs.find(value=>value.id===next.data.result.id);
    assert.equal(job.state,'PREPARING_DATA');assert.equal(usage(f.service.store.jobs,f.member.id),1);
    f.states.set('gpu-1:sample','READY');await f.service.reconcile();
    assert.equal(job.state,'PREPARING_DATA');assert.match(job.queueReason,/等待个人可用卡数额度/);
    assert.equal(f.calls.filter(call=>call.operation==='sync'&&call.args.job.id===job.id).length,0);
    assert.equal((await f.submit({prepareData:true,cards:2})).status,409);
  }finally{await f.close();}
});
test('user deletion cannot discard a pending preparation just because GPU usage is zero',async()=>{
  const f=await fixture();try{
    await f.grant();f.states.set('gpu-1:sample','REGISTERED');
    const created=await f.submit({prepareData:true});assert.equal(created.status,200);await f.settle();
    assert.equal(usage(f.service.store.jobs,f.member.id),0);
    f.service.store.users.find(user=>user.id===f.member.id).enabled=false;f.service.save();
    await assert.rejects(f.service.invoke(f.admin.token,'users.delete',{userId:f.member.id}),/没有待完成任务/);
    assert.ok(f.service.store.users.some(user=>user.id===f.member.id));
  }finally{await f.close();}
});
test('dataset list/status/prepare use authenticated identity and preserve node state without reserving GPUs',async()=>{
  const f=await fixture();try{
    await f.grant();
    for(const operation of ['datasets.list','datasets.status','datasets.prepare']){
      const result=await f.post(operation,{machine:'gpu-1',...(operation==='datasets.list'?{}:reference)});
      assert.equal(result.status,200,JSON.stringify(result.data));
      const sent=f.calls.at(-1);assert.equal(sent.args.userId,f.member.id);assert.equal(sent.args.hostAdmin,false);
      if(operation!=='datasets.list')assert.equal(result.data.result.state,'READY');
    }
    const admin=await f.post('datasets.status',{machine:'gpu-1',...reference},f.admin.token);
    assert.equal(admin.status,200);assert.equal(f.calls.at(-1).args.userId,'builtin-admin');assert.equal(f.calls.at(-1).args.hostAdmin,true);
    assert.equal(f.service.store.jobs.length,0);assert.equal(usage(f.service.store.jobs,f.member.id),0);
    assert.equal(f.service.db.prepare("SELECT count(*) AS n FROM audit WHERE operation='datasets.prepare'").get().n,1);
  }finally{await f.close();}
});

test('dataset endpoints reject identity/path spoofing, unauthorized machines and unauthenticated callers before bridge',async()=>{
  const f=await fixture();try{
    await f.grant();
    for(const operation of ['datasets.list','datasets.status','datasets.prepare']){
      const args={machine:'gpu-1',...(operation==='datasets.list'?{}:reference)};
      for(const extra of [{userId:f.other.id},{hostAdmin:true},{role:'admin'},{path:'/private/source'},{sourceId:'secret'}]){
        assert.equal((await f.post(operation,{...args,...extra})).status,400);
      }
      assert.equal((await f.post(operation,{...args,machine:'gpu-4'})).status,403);
      assert.equal((await f.post(operation,args,f.outsider.token)).status,403);
      assert.equal((await f.post(operation,args,null)).status,401);
    }
    assert.equal(f.calls.length,0);
  }finally{await f.close();}
});

test('dataset APIs return only mapped ownership labels after normal node authorization',async()=>{
  const f=await fixture();try{
    await f.grant();
    f.list({datasets:[{dataset:'sample',ownerIds:[f.member.id],ownerLabel:'forged',sourcePath:'/private',users:f.service.store.users,versions:[{version,state:'READY',sourceId:'private-source'}]}]});
    for(const operation of ['datasets.list','datasets.catalog']){
      const response=await f.post(operation,{machine:'gpu-1'});
      assert.equal(response.status,200,JSON.stringify(response.data));
      const item=response.data.result.datasets[0];
      assert.equal(operation==='datasets.list'?item.ownerLabel:item.versions[0].ownerLabel,'所属用户：dataset-user');
      assert.doesNotMatch(JSON.stringify(response.data.result),/ownerIds|other-user|private|forged|password|credentials/);
    }
    f.list({datasets:[{dataset:'sample',ownerIds:[f.member.id,f.other.id],versions:[{version,state:'READY'}]}]});
    assert.equal((await f.post('datasets.list',{machine:'gpu-1'})).data.result.datasets[0].ownerLabel,'共享授权用户：dataset-user、other-user');
    f.service.store.users=f.service.store.users.filter(user=>user.id!==f.other.id);
    assert.match((await f.post('datasets.list',{machine:'gpu-1'})).data.result.datasets[0].ownerLabel,/未知用户 1 位/);
    f.deniedOwners.add(f.member.id);
    const denied=await f.post('datasets.list',{machine:'gpu-1'});assert.notEqual(denied.status,200);assert.doesNotMatch(JSON.stringify(denied.data),/ownerLabel|dataset-user/);
    const admin=await f.post('datasets.list',{machine:'gpu-1'},f.admin.token);assert.equal(admin.status,200);assert.equal(f.calls.at(-1).args.hostAdmin,true);
  }finally{await f.close();}
});

test('personal upload API is member-accessible and always derives an unprivileged owner',async()=>{
  const f=await fixture();try{
    await f.grant();const key=randomUUID();
    const requests={begin:{name:'my-data',key,manifestBytes:99,manifestSha256:version,totalBytes:64,entries:1},manifest:{uploadId:key,offset:0,data:Buffer.from('{}').toString('base64')},seal:{uploadId:key},status:{uploadId:key,path:'a/b.txt'},chunk:{uploadId:key,path:'a/b.txt',offset:0,data:Buffer.alloc(1024*1024).toString('base64')},commit:{uploadId:key},discard:{uploadId:key}};
    for(const [action,args] of Object.entries(requests)){
      const response=await f.post('datasets.upload.'+action,{machine:'gpu-1',...args});
      assert.equal(response.status,200,JSON.stringify(response.data));
      assert.deepEqual(f.calls.at(-1),{machine:'gpu-1',operation:'datasets.upload.'+action,args:{...args,userId:f.member.id,hostAdmin:false}});
    }
    await f.post('datasets.upload.begin',{machine:'gpu-1',...requests.begin},f.admin.token);
    assert.equal(f.calls.at(-1).args.hostAdmin,false);
    assert.equal(f.calls.at(-1).args.userId,'builtin-admin');
    assert.equal(f.service.store.jobs.length,0);
  }finally{await f.close();}
});

test('personal upload rejects identity injection and revoked machine access before any node request',async()=>{
  const f=await fixture();try{
    await f.grant();const key=randomUUID();
    for(const action of ['begin','manifest','seal','status','chunk','commit','discard']){
      const args=action==='begin'?{machine:'gpu-1',name:'data',key,manifestBytes:1,manifestSha256:version,totalBytes:0,entries:0}:action==='manifest'?{machine:'gpu-1',uploadId:key,offset:0,data:''}:action==='chunk'?{machine:'gpu-1',uploadId:key,path:'a',offset:0,data:''}:{machine:'gpu-1',uploadId:key};
      for(const extra of [{userId:f.other.id},{hostAdmin:true},{sourceId:'source'},{owners:[f.member.id]},{root:'/tmp'},{dataset:'other'},{version}])assert.equal((await f.post('datasets.upload.'+action,{...args,...extra})).status,400);
      assert.equal((await f.post('datasets.upload.'+action,{...args,machine:'gpu-4'})).status,403);
      assert.equal((await f.post('datasets.upload.'+action,args,f.outsider.token)).status,403);
      assert.equal((await f.post('datasets.upload.'+action,args,null)).status,401);
    }
    assert.equal(f.calls.length,0);
  }finally{await f.close();}
});

test('personal upload bounds request metadata, chunk encoding and relative paths',async()=>{
  const f=await fixture();try{
    await f.grant();const uploadId=randomUUID(),base={machine:'gpu-1',uploadId,path:'file',offset:0,data:'YQ=='};
    for(const path of ['/etc/passwd','../foo','a/../b','a//b','a\\b','.ssh/key','a\0b','x'.repeat(4097)])assert.equal((await f.post('datasets.upload.chunk',{...base,path})).status,400);
    for(const data of ['YQ=','YR==','!!!!','YQ==\n',Buffer.alloc(1024*1024+1).toString('base64')])assert.equal((await f.post('datasets.upload.chunk',{...base,data})).status,400);
    for(const offset of [-1,0.5,Number.MAX_SAFE_INTEGER+1,'0'])assert.equal((await f.post('datasets.upload.chunk',{...base,offset})).status,400);
    const begin={machine:'gpu-1',name:'data',key:uploadId,manifestBytes:1,manifestSha256:version,totalBytes:0,entries:0};
    for(const extra of [{name:'../x'},{name:'x'.repeat(41)},{manifestBytes:64*1024*1024+1},{manifestSha256:'short'},{entries:500001},{totalBytes:-1},{key:'bad'}])assert.equal((await f.post('datasets.upload.begin',{...begin,...extra})).status,400);
    assert.equal((await f.post('datasets.upload.unknown',{machine:'gpu-1',uploadId})).status,400);
    assert.equal(f.calls.length,0);
  }finally{await f.close();}
});

test('personal data workspace is member-accessible and administrator calls remain personal and unprivileged',async()=>{
  const f=await fixture();try{
    await f.grant();const key=randomUUID(),requests={list:{path:'.'},get:{path:'incoming/a.zip',offset:0},put:{path:'incoming/a.zip',offset:0,data:'YQ==',truncate:false},publish:{path:'prepared',name:'mine',key},status:{operationId:key}};
    for(const [action,args] of Object.entries(requests)){
      const response=await f.post('datasets.workspace.'+action,{machine:'gpu-1',...args});assert.equal(response.status,200,JSON.stringify(response.data));
      assert.deepEqual(f.calls.at(-1),{machine:'gpu-1',operation:'datasets.workspace.'+action,args:{...args,userId:f.member.id,hostAdmin:false}});
    }
    assert.equal((await f.post('datasets.workspace.list',{machine:'gpu-1'},f.admin.token)).status,200);assert.equal(f.calls.at(-1).args.userId,'builtin-admin');assert.equal(f.calls.at(-1).args.hostAdmin,false);
    assert.equal(f.service.store.jobs.length,0);assert.equal(usage(f.service.store.jobs,f.member.id),0);
  }finally{await f.close();}
});

test('personal data workspace rejects owner, role, host paths, malformed chunks and revoked access before node calls',async()=>{
  const f=await fixture();try{
    await f.grant();const key=randomUUID(),requests={list:{path:'.'},get:{path:'a',offset:0},put:{path:'a',offset:0,data:'YQ=='},publish:{path:'prepared',name:'mine',key},status:{operationId:key}};
    for(const [action,args] of Object.entries(requests)){
      for(const extra of [{userId:f.other.id},{hostAdmin:true},{role:'admin'},{owners:[f.member.id]},{root:'/data2'},{sourceId:'other'},{project:'other'}])assert.equal((await f.post('datasets.workspace.'+action,{machine:'gpu-1',...args,...extra})).status,400);
      assert.equal((await f.post('datasets.workspace.'+action,{machine:'gpu-4',...args})).status,403);
      assert.equal((await f.post('datasets.workspace.'+action,{machine:'gpu-1',...args},f.outsider.token)).status,403);
      assert.equal((await f.post('datasets.workspace.'+action,{machine:'gpu-1',...args},null)).status,401);
    }
    const base={machine:'gpu-1',path:'a',offset:0,data:'YQ=='};
    for(const path of ['.','../escape','a/../b','/data2/a','a//b','a\\b','a\0b','x'.repeat(256),'a/'.repeat(512)+'b'])assert.equal((await f.post('datasets.workspace.put',{...base,path})).status,400,path);
    for(const offset of [-1,0.1,'0',100*1024**3+1])assert.equal((await f.post('datasets.workspace.put',{...base,offset})).status,400);
    for(const data of ['YQ=','YR==','!!!!','YQ==\n',Buffer.alloc(1024*1024+1).toString('base64')])assert.equal((await f.post('datasets.workspace.put',{...base,data})).status,400);
    for(const extra of [{truncate:'true'},{truncate:true,offset:1},{offset:100*1024**3}])assert.equal((await f.post('datasets.workspace.put',{...base,...extra})).status,400,JSON.stringify(extra));
    assert.equal((await f.post('datasets.workspace.publish',{machine:'gpu-1',path:'prepared',name:'../mine',key})).status,400);
    assert.equal((await f.post('datasets.workspace.status',{machine:'gpu-1',operationId:'bad'})).status,400);
    assert.equal(f.calls.length,0);
    assert.equal((await f.post('datasets.workspace.put',{...base,offset:100*1024**3-1})).status,200);
    await f.grant(0,{});const before=f.calls.length;
    for(const [action,args] of Object.entries(requests))assert.equal((await f.post('datasets.workspace.'+action,{machine:'gpu-1',...args})).status,403);
    assert.equal(f.calls.length,before);
  }finally{await f.close();}
});

test('data terminal scope is separate from projects and ROOT on every operation and respects revoked permissions',async()=>{
  const f=await fixture();try{
    await f.grant();const common={machine:'gpu-1',dataWorkspace:true,clientId:randomUUID()},key=randomUUID(),id=randomUUID(),writerToken=randomUUID();
    const requests={open:{...common,key,mode:'new'},exchange:{...common,id,writerToken,input:'',offset:0},detach:{...common,id,writerToken},close:{...common,id,writerToken}};
    for(const [action,args] of Object.entries(requests)){
      assert.equal((await f.post('terminal.'+action,args)).status,200);assert.equal(f.calls.at(-1).args.dataWorkspace,true);assert.equal(f.calls.at(-1).args.hostAdmin,false);assert.equal(f.calls.at(-1).args.userId,f.member.id);
      const count=f.calls.length;
      for(const extra of [{project:'project-x'},{dataWorkspace:'true'},{userId:f.other.id},{role:'admin'}])assert.equal((await f.post('terminal.'+action,{...args,...extra})).status,400);
      assert.equal((await f.post('terminal.'+action,{...args,hostAdmin:true},f.admin.token)).status,400);
      assert.equal(f.calls.length,count);
    }
    await f.grant(0,{});const before=f.calls.length;
    for(const [action,args] of Object.entries(requests))assert.equal((await f.post('terminal.'+action,args)).status,403);
    assert.equal(f.calls.length,before);
  }finally{await f.close();}
});

test('dataset reference validation rejects coerced names/hashes, duplicate names, paths and additional properties',()=>{
  for(const datasets of [null,{},[{dataset:123,version}],[{dataset:['sample'],version}],[{dataset:'sample',version:[version]}],
    [{dataset:['sample'],version},{dataset:['sample'],version}], [{...reference,path:'/tmp/source'}],
    [{dataset:'../private',version}],[{dataset:'sample',version:'short'}],[reference,{...reference,version:otherVersion}],Array(9).fill(reference)]){
    assert.throws(()=>datasetReferences(datasets),undefined,JSON.stringify(datasets));
  }
  assert.deepEqual(datasetReferences(undefined),[]);assert.deepEqual(datasetReferences([]),[]);
  assert.deepEqual(datasetReferences([reference]),[reference]);
});

test('HTTP job submission rejects missing/invalid targets; explicit AUTO requires a published project before node queries',async()=>{
  const f=await fixture();try{
    await f.grant();
    for(const machine of [undefined,'',null,'unknown-machine',{},['gpu-1']]){
      const result=await f.submit({machine});
      assert.equal(result.status,400,JSON.stringify(result.data));
      assert.match(result.data.error,/请选择有效的服务器/);
    }
    const auto=await f.submit({machine:'auto'});
    assert.equal(auto.status,400);assert.match(auto.data.error,/自动选机需要已发布.*项目和固定版本/);
    await f.settle();assert.equal(f.calls.length,0);
    assert.equal(f.service.store.jobs.length,0);assert.equal(usage(f.service.store.jobs,f.member.id),0);
  }finally{await f.close();}
});

test('administrator training requires dataset ownership before reservation while management visibility remains privileged',async()=>{
  const f=await fixture();try{
    f.deniedOwners.add('builtin-admin');
    for(const operation of ['datasets.list','datasets.status']){
      const response=await f.post(operation,{machine:'gpu-1',...(operation==='datasets.status'?reference:{})},f.admin.token);
      assert.equal(response.status,200,JSON.stringify(response.data));
      assert.equal(f.calls.at(-1).args.hostAdmin,true);
    }
    f.calls.length=0;
    for(const machine of ['gpu-1','gpu-2']){
      const response=await f.post('jobs.submit',{machine,cards:1,argv:['python','train.py'],key:randomUUID(),datasets:[reference]},f.admin.token);
      assert.equal(response.status,403,JSON.stringify(response.data));
      assert.match(response.data.error,/数据集读取授权/);assert.match(response.data.error,/owners/);assert.match(response.data.error,/未占用 GPU/);
      assert.equal(f.service.store.jobs.length,0);assert.equal(usage(f.service.store.jobs,'builtin-admin'),0);
    }
    await f.settle();
    assert.ok(f.calls.length>0);assert.ok(f.calls.every(call=>call.operation==='datasets.status'&&call.args.userId==='builtin-admin'&&call.args.hostAdmin===false));
    assert.equal(f.calls.some(call=>call.operation==='sync'),false);
    assert.equal(f.service.db.prepare("SELECT count(*) AS n FROM audit WHERE operation='jobs.submit' AND outcome='reserved'").get().n,0);
    // Once the actual identity is an owner, an administrator can train without
    // adding a role override to the job spec or widening the node principal.
    f.deniedOwners.delete('builtin-admin');f.calls.length=0;
    const accepted=await f.post('jobs.submit',{machine:'gpu-1',cards:1,argv:['python','train.py'],key:randomUUID(),datasets:[reference]},f.admin.token);
    assert.equal(accepted.status,200,JSON.stringify(accepted.data));await f.settle();
    assert.equal(f.service.store.jobs.length,1);assert.equal(usage(f.service.store.jobs,'builtin-admin'),1);
    assert.equal(f.calls.find(call=>call.operation==='datasets.status').args.hostAdmin,false);
    const spec=f.calls.find(call=>call.operation==='sync').args.job;
    assert.deepEqual(spec.datasets,[reference]);assert.equal(Object.hasOwn(spec,'hostAdmin'),false);
  }finally{await f.close();}
});

test('manual selection uses only that READY replica even when another machine has more idle GPUs',async()=>{
  const f=await fixture();try{
    await f.grant();f.states.set('gpu-1:sample','REGISTERED');
    const result=await f.submit({machine:'gpu-2'});assert.equal(result.status,200,JSON.stringify(result.data));
    assert.equal(result.data.result.machine,'gpu-2');assert.deepEqual(result.data.result.datasets,[reference]);
    assert.deepEqual(f.service.store.jobs[0].spec.datasets,[reference]);
    await f.settle();
    // Submission readiness, capacity admission, and first-dispatch capacity
    // recheck all stay pinned to the same explicitly selected server.
    assert.deepEqual(f.calls.filter(c=>c.operation==='datasets.status').map(c=>c.machine),['gpu-2','gpu-2','gpu-2']);
    assert.equal(f.calls.filter(c=>c.operation==='storage.training.plan').length,2);
    assert.ok(f.calls.filter(c=>['datasets.training.status','storage.training.plan'].includes(c.operation))
      .every(c=>c.machine==='gpu-2'&&c.args.userId===f.member.id&&c.args.hostAdmin===false));
    assert.deepEqual(f.calls.find(c=>c.operation==='sync').args.job.datasets,[reference]);
    assert.equal(usage(f.service.store.jobs,f.member.id),1);
  }finally{await f.close();}
});

test('all referenced versions must be READY on the same machine; staging never reserves a GPU',async()=>{
  const f=await fixture();try{
    await f.grant();f.states.set('gpu-1:sample','STAGING');f.states.set('gpu-2:second','REGISTERED');
    const result=await f.submit({datasets:[reference,{dataset:'second',version:otherVersion}]});
    assert.equal(result.status,409);assert.match(result.data.error,/未占用 GPU/);
    await f.settle();assert.equal(f.service.store.jobs.length,0);assert.equal(usage(f.service.store.jobs,f.member.id),0);
    assert.equal(f.calls.some(c=>c.operation==='sync'),false);
    const preparation=await f.post('datasets.prepare',{machine:'gpu-1',...reference});
    assert.equal(preparation.status,200);assert.equal(preparation.data.result.state,'STAGING');
    assert.equal(f.service.store.jobs.length,0);
  }finally{await f.close();}
});

test('readiness transport failures are unavailable, not falsely reported as missing replicas',async()=>{
  const f=await fixture();try{
    await f.grant();f.fail(Error('test transport timeout'));
    const result=await f.submit();assert.equal(result.status,503,JSON.stringify(result.data));
    assert.doesNotMatch(result.data.error,/先用 gpuctl data prepare/);
    assert.equal(f.service.store.jobs.length,0);assert.equal(f.calls.some(c=>c.operation==='sync'),false);
    const status=await f.post('datasets.status',{machine:'gpu-1',...reference});
    assert.notEqual(status.status,200);assert.equal(status.data.result,undefined);
  }finally{await f.close();}
});

test('failed selected-node readiness waits with its authorized key instead of borrowing another READY machine',async()=>{
  const f=await fixture();try{
    await f.grant();f.service.reconciling=true;f.states.set('gpu-1:sample',Error('offline')); // Isolate admission from its subsequent background observation.
    const key=randomUUID(),result=await f.submit({key});assert.equal(result.status,200,JSON.stringify(result.data));
    assert.equal(result.data.result.state,'PREPARING_DATA');assert.equal(f.service.store.jobs.length,1);
    assert.equal(f.service.store.jobs[0].key,key);assert.equal(usage(f.service.store.jobs,f.member.id),0);
    assert.deepEqual(f.calls.map(call=>[call.machine,call.operation]),[['gpu-1','datasets.status'],['gpu-1','datasets.list']]);
    const before=f.calls.length,again=await f.submit({key});assert.equal(again.data.result.id,result.data.result.id);
    assert.equal(f.calls.length,before);assert.equal(f.service.store.jobs.length,1);
  }finally{f.service.reconciling=false;await f.close();}
});

test('dataset job retry is durable and idempotent; changing versions under the same key conflicts',async()=>{
  const f=await fixture();try{
    await f.grant();const key=randomUUID();
    const both=await Promise.all([f.submit({key}),f.submit({key})]);
    assert.equal(both[0].status,200);assert.equal(both[1].status,200);assert.equal(both[0].data.result.id,both[1].data.result.id);
    assert.equal(f.service.store.jobs.length,1);await f.reopen();f.fail(Error('now offline'));
    const again=await f.submit({key});assert.equal(again.status,200);assert.equal(again.data.result.id,both[0].data.result.id);
    const changed=await f.submit({key,datasets:[{...reference,version:otherVersion}]});assert.equal(changed.status,409);
    assert.equal(f.service.store.jobs.length,1);
  }finally{await f.close();}
});

test('legacy jobs without datasets retain their old digest and accept an explicit empty list retry',async()=>{
  const f=await fixture();try{
    await f.grant();const key=randomUUID();
    const result=await f.submit({key,datasets:undefined});assert.equal(result.status,200);
    assert.equal(f.service.store.jobs[0].digest,createHash('sha256').update(JSON.stringify(['gpu-1',1,0,['python','train.py'],'train'])).digest('hex'));
    assert.equal(Object.hasOwn(f.service.store.jobs[0].spec,'datasets'),false);
    assert.equal(f.calls.some(c=>c.operation==='datasets.status'),false);
    await f.reopen();const repeated=await f.submit({key,datasets:[]});assert.equal(repeated.status,200);assert.equal(repeated.data.result.id,result.data.result.id);
    const changed=await f.submit({key,datasets:[reference]});assert.equal(changed.status,409);
  }finally{await f.close();}
});

test('CLI dataset operations target the selected machine and run keeps training argv untouched',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-dataset-cli-')),session=join(dir,'session.json'),calls=[];
  const server=httpServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);calls.push(body);
    res.setHeader('content-type','application/json');
    if(body.operation==='state')res.end(JSON.stringify({state:{demo:false,machines:[{id:'gpu-1'},{id:'gpu-2'}],users:[],jobs:[]}}));
    else res.end(JSON.stringify({result:body.operation==='jobs.submit'?{id:'job-test',state:'SUBMITTING'}:{state:'READY'}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port;
  const cli=args=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[new URL('../cli.mjs',import.meta.url).pathname,'--url',url,'--session-file',session,'--json',...args]);
    let out='',err='';child.stdout.on('data',data=>out+=data);child.stderr.on('data',data=>err+=data);child.on('error',reject);child.on('close',code=>resolve({code,out,err}));
  });
  try{
    await writeFile(session,JSON.stringify({url,token:'local-test-token',principal:{userId:'user-test',role:'member'},machine:'gpu-2'}));
    for(const action of ['list','status','prepare']){
      const result=await cli(['data',action,...(action==='list'?[]:['sample@'+version])]);assert.equal(result.code,0,result.err);
      assert.equal(calls.at(-1).operation,'datasets.'+action);assert.equal(calls.at(-1).args.machine,'gpu-2');
    }
    // Global flags precede -- so they never become accidental training options.
    const result=await cli(['run','gpu-2','--data','sample@'+version,'--','python','train.py','--data','/data2/sample']);
    assert.equal(result.code,0,result.err);const sent=calls.at(-1).args;
    assert.deepEqual(sent.datasets,[reference]);assert.equal(sent.machine,'gpu-2');
    assert.deepEqual(sent.argv,['python','train.py','--data','/data2/sample']);
    const bad=await cli(['data','status','sample@short']);assert.equal(bad.code,1);assert.match(bad.err,/FULL_VERSION_HASH/);
  }finally{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});
