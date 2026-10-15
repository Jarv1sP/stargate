import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRolloutServer} from '../portal-rollout.mjs';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';

const listen=async server=>{server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;};
const close=server=>new Promise(resolve=>server.close(resolve));
async function until(check){for(let i=0;i<200;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.ok(check(),'request did not reach the fixture');}
const request=(url,operation,args={})=>fetch(url+'/api/call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation,args})}).then(async res=>({status:res.status,body:await res.json()}));

test('handoff classifies terminal, logs, poll, reads and writes without exposing request arguments',{timeout:5000},async()=>{
  const old=http.createServer(async(req,res)=>{for await(const chunk of req){};res.write('waiting');});
  const oldURL=await listen(old),r=createRolloutServer({upstream:oldURL,startActive:()=>oldURL}),url=await listen(r.server);
  const operations=['terminal.exchange','jobs.logs','jobs.watch','files.get','jobs.submit'];
  const requests=operations.map(operation=>request(url,operation,{input:'private-input-not-for-release-record',key:randomUUID()}).catch(()=>null));
  try{
    await until(()=>r.state().forwarding===operations.length);
    await until(()=>r.state().inFlightByType.terminal===1);
    assert.deepEqual(r.state().inFlightByType,{terminal:1,logs:1,poll:1,read:1,write:1});
    assert.equal(JSON.stringify(r.state()).includes('private-input'),false);
  }finally{old.closeAllConnections();const closing=close(old);await Promise.all(requests);await closing;await r.close();}
});

test('an event stream is a long poll and fragmented call bytes reach the owner unchanged',async()=>{
  let received='';
  const old=http.createServer(async(req,res)=>{for await(const chunk of req)received+=chunk;res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: waiting\n\n');});
  const oldURL=await listen(old),r=createRolloutServer({upstream:oldURL,startActive:()=>oldURL}),url=await listen(r.server);
  const body=JSON.stringify({operation:'terminal.exchange',args:{input:'never replay this',padding:'x'.repeat(16384)}});
  let done;
  const completion=new Promise(resolve=>done=resolve);
  const req=http.request(url+'/api/call',{method:'POST'},res=>{res.resume();res.on('close',done);});req.on('error',done);
  try{
    req.write(body.slice(0,10));req.end(body.slice(10));
    await until(()=>r.state().inFlightByType.poll===1);
    assert.equal(received,body);
  }finally{old.closeAllConnections();const closing=close(old);await completion;await closing;await r.close();}
});

test('interrupted committed submit recovers its durable original key after switching with long connections', {timeout:15000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'stargate-drain-')),database=join(root,'portal.db'),bootstrap=join(root,'bootstrap');
  const password='drain-fixture-password-not-a-real-credential';
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});
  let service,releaseOld,committed;
  const nativeJobs=new Map(),observedIds=[];
  const committedReply=new Promise(resolve=>committed=resolve),oldGate=new Promise(resolve=>releaseOld=resolve);
  const bridge=async(_machine,operation,args)=>{
    assert.equal(operation,'sync');observedIds.push(args.job.id);
    if(!nativeJobs.has(args.job.id))nativeJobs.set(args.job.id,{state:'PENDING',nodeJobId:'J'+args.job.id.replaceAll('-','').slice(0,12),assignedIndices:[]});
    return nativeJobs.get(args.job.id);
  };
  const open=async()=>{const value=await PortalService.open(database,bootstrap,undefined,bridge);clearInterval(value.executionTimer);return value;};
  service=await open();const login=await service.login('admin',password),newCalls=[];
  const old=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;const data=JSON.parse(body);
    if(data.operation==='jobs.submit'){
      const reply=await service.invoke(login.token,data.operation,data.args);await service.reconcile();committed(reply);
      await oldGate;if(!res.destroyed)res.end(JSON.stringify(reply));
    }else{await oldGate;if(!res.destroyed)res.end('{}');}
  });
  const next=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;const data=JSON.parse(body);newCalls.push(data.operation);
    const reply=await service.invoke(login.token,data.operation,data.args);res.end(JSON.stringify(reply));
  });
  const oldURL=await listen(old),nextURL=await listen(next);
  const r=createRolloutServer({upstream:oldURL,startActive:async()=>{service=await open();return nextURL;}}),url=await listen(r.server);
  const args={machine:MACHINES[0].id,project:'smoke',cards:1,argv:['true'],key:randomUUID()};
  const write=request(url,'jobs.submit',args).catch(()=>null);
  const long=['terminal.exchange','jobs.logs','jobs.watch'].map(op=>request(url,op,{input:op==='terminal.exchange'?'input with unknown result':undefined}).catch(()=>null));
  try{
    const original=await committedReply;
    await until(()=>r.state().forwarding===4);
    assert.deepEqual(r.state().inFlightByType,{write:1,terminal:1,logs:1,poll:1});
    r.hold();const retry=request(url,'jobs.submit',args);
    await until(()=>r.state().pending===1);assert.deepEqual(newCalls,[]);
    // Simulate the old container stopping at the publisher's drain deadline.
    old.closeAllConnections();await close(old);await Promise.all([write,...long]);
    await until(()=>r.state().forwarding===0);service.close();releaseOld();
    await r.activate();const recovered=await retry;
    assert.equal(recovered.status,200);assert.equal(recovered.body.result.id,original.result.id);
    assert.equal(recovered.body.result.key,args.key);assert.equal(service.store.jobs.length,1);
    assert.deepEqual([...nativeJobs.keys()],[original.result.id]);assert.ok(observedIds.every(id=>id===original.result.id));
    assert.deepEqual(newCalls,['jobs.submit']);assert.equal(r.state().pending,0);
  }finally{
    releaseOld();old.closeAllConnections();if(old.listening)await close(old);
    await r.close();await close(next);service.close();await rm(root,{recursive:true,force:true});
  }
});
