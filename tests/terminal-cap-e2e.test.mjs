import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createServer as reserveServer} from 'node:net';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/model.js';
import {gpuCardUsage} from '../dist/gpu-allocation.js';

const python=String.raw`
import importlib.util,json,sys
from pathlib import Path
source=Path(sys.argv[1])
s=importlib.util.spec_from_file_location('terminal_cap_fixture',source/'tests/terminal-lifecycle.test.py')
f=importlib.util.module_from_spec(s);s.loader.exec_module(f)
case=f.TerminalLifecycle();case.setUp();node,folder,life,terminals=case.fixture()
node.projects().store.create('builtin-admin','demo')
for _ in range(20):case.terminal(node,folder,life,owner='builtin-admin')
node.gpu=f.Mock(side_effect=AssertionError('a rejected GPU terminal must never dispatch'))
try:
 for line in sys.stdin:
  request=json.loads(line)
  try:
   if request['op']=='fixture.free-slots':case.live.clear();result={}
   elif request['op']=='fixture.gpu-calls':result=node.gpu.call_count
   else:result=node.process(request['op'],request['args'])
   print(json.dumps({'id':request['id'],'result':result}),flush=True)
  except Exception as error:print(json.dumps({'id':request['id'],'error':str(error)}),flush=True)
finally:case.doCleanups()
`;

for(const loseReply of [false,true])test(`HTTP GPU cap refusal, lost reply=${loseReply}: visible FAILED, quota released, no later dispatch`,async t=>{
 const directory=await mkdtemp(join(tmpdir(),'terminal-cap-e2e-')),bootstrap=join(directory,'bootstrap'),status=join(directory,'status');
 const password='Terminal-Cap-E2E-Only-2026!',machine=MACHINES[0].id;
 await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});
 await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,
  gpus:Array.from({length:m.cards},(_,index)=>({index,memoryTotalMiB:32768})),gpuq:{connected:true,observeOnly:false,jobs:[]}}))}));
 const child=spawn(process.env.PYTHON||'python3',['-u','-B','-c',python,import.meta.dirname+'/..'],{stdio:['pipe','pipe','pipe']});
 const lines=createInterface({input:child.stdout}),pending=new Map();let sequence=0,stderr='';
 child.stderr.on('data',chunk=>stderr+=chunk);
 lines.on('line',line=>{const value=JSON.parse(line),wait=pending.get(value.id);if(!wait)return;pending.delete(value.id);value.error?wait.reject(Error(value.error)):wait.resolve(value.result);});
 child.on('close',code=>{for(const wait of pending.values())wait.reject(Error(`node fixture exited ${code}: ${stderr}`));pending.clear();});
 const node=(op,args={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,op,args})+'\n');});
 const calls=[];let lost=false;
 const bridge=async(_machine,operation,args)=>{
  if(operation==='projects.workspace')return {project:args.project,state:'AVAILABLE',workspace:{persistent:true}};
  calls.push({operation,args:structuredClone(args)});const result=await node(operation,args);
  if(loseReply&&operation==='sync'&&!lost){lost=true;throw Error('fixture lost the persisted refusal reply');}
  return result;
 };
 const reserved=reserveServer();await new Promise(resolve=>reserved.listen(0,'127.0.0.1',resolve));
 const port=reserved.address().port;await new Promise(resolve=>reserved.close(resolve));const origin='http://127.0.0.1:'+port;
 const {server,service}=await createPortalServer({database:join(directory,'db'),bootstrap,statusPath:status,origin,secure:false,bridge});
 for(const name of ['executionTimer','notificationTimer','maintenanceTimer','transferTimer','storageArchiveTimer','projectCopyTimer'])clearInterval(service[name]);
 await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
 t.after(async()=>{
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  child.stdin.end();if(child.exitCode===null)await new Promise(resolve=>child.once('close',resolve));lines.close();
  await rm(directory,{recursive:true,force:true});
 });
 const login=await service.login('admin',password);
 const call=async(operation,args)=>{
  const response=await fetch(origin+'/api/call',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+login.token},body:JSON.stringify({operation,args:{machine,...args},client:{name:'gpuctl',protocol:2}})});
  const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body.result;
 };
 const key=randomUUID(),submitted=await call('jobs.submit',{key,project:'demo',cards:1,interactive:true,argv:['/bin/bash','--noprofile','--norc','-i']});
 for(let attempt=0;attempt<100&&service.job(submitted.id)?.state!=='FAILED';attempt++){
  const job=service.job(submitted.id);
  if(job.submissionReconciliation){job.submissionReconciliation.nextCheckAt=new Date(0).toISOString();service.save(job);}
  await service.reconcile();await service.tail;
  if(service.job(submitted.id)?.state!=='FAILED')await new Promise(resolve=>setTimeout(resolve,10));
 }
 const failed=await call('jobs.watch',{jobId:submitted.id});
 assert.equal(failed.state,'FAILED');assert.equal(failed.notSubmitted,true);assert.equal(failed.failureCode,'TERMINAL_LIMIT');
 assert.match(failed.error,/已有 20 个/);assert.match(failed.error,/gpuctl terminal close/);
 assert.equal(gpuCardUsage([service.job(submitted.id)],login.principal.userId),0);
 await node('fixture.free-slots');
 for(let index=0;index<3;index++)await service.reconcile();
 const job=service.job(submitted.id),watch=await node('watch',{job:job.spec}),retry=await node('sync',{job:job.spec});
 assert.equal(watch.state,'FAILED');assert.equal(retry.state,'FAILED');assert.equal(retry.notSubmitted,true);
 assert.equal(await node('fixture.gpu-calls'),0);assert.equal(calls.filter(call=>call.operation==='sync').length,1);
 assert.equal((await call('jobs.watch',{jobId:submitted.id})).error,failed.error);
});
