import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {bridgeClient} from '../execution.mjs';

test('admission BUSY is typed only for the two read RPCs and never replays a request',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'training-busy-bridge-')),path=join(dir,'bridge.sock');
 let calls=0;
 const server=net.createServer(socket=>{let raw='';socket.on('data',part=>raw+=part);socket.on('end',()=>{
  JSON.parse(raw);calls++;socket.end(JSON.stringify({ok:false,status:503,code:'TRAINING_ADMISSION_BUSY',error:'/private?ticket=secret',outcomeUnconfirmed:true}));
 });});
 await new Promise(r=>server.listen(path,r));
 t.after(async()=>{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
 const bridge=bridgeClient(path);
 for(const operation of ['datasets.training.status','storage.training.plan'])
  await assert.rejects(bridge('node',operation,{}),e=>e.code==='TRAINING_ADMISSION_BUSY'&&e.status===503&&!/private|ticket|secret/.test(e.message));
 await assert.rejects(bridge('node','sync',{}),e=>e.code==='EXECUTOR_UNCONFIRMED');
 assert.equal(calls,3);
});
import {createPortalServer} from '../portal-server.mjs';
import {apiPost} from '../client-http.mjs';

async function fixture(t,handler){
 const dir=await mkdtemp(join(tmpdir(),'bridge-availability-')),path=join(dir,'bridge.sock');
 const peers=new Set(),server=net.createServer({allowHalfOpen:true},socket=>{
  peers.add(socket);socket.on('close',()=>peers.delete(socket));socket.on('error',()=>{});
  let raw='';socket.on('data',part=>raw+=part);socket.on('end',()=>handler(socket,JSON.parse(raw)));
 });
 t.after(async()=>{for(const peer of peers)peer.destroy();if(server.listening)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
 return {dir,path,server,start:()=>new Promise(resolve=>server.listen(path,resolve))};
}
test('absent or refused executor socket is a safe 503 and never exposes its path',async t=>{
 const f=await fixture(t,()=>{});
 for(const state of ['absent','stale']){
  if(state==='stale')await writeFile(f.path,'not a listener');
  await assert.rejects(bridgeClient(f.path)('node','host.status',{}),e=>e.status===503&&e.code==='EXECUTOR_UNAVAILABLE'&&!e.message.includes(f.dir));
 }
});
test('bridge success and native refusal retain protocol semantics without replay',async t=>{
 const calls=[],f=await fixture(t,(socket,request)=>{calls.push(request);socket.end(JSON.stringify(request.operation==='host.status'?{ok:true,result:{state:'RUNNING'}}:{ok:false,error:'Command handle is not owned by this administrator'}));});await f.start();
 const call=bridgeClient(f.path);
 assert.deepEqual(await call('node','host.status',{}),{state:'RUNNING'});
 await assert.rejects(call('node','host.exec',{}),e=>e.status===undefined&&/not owned/.test(e.message));
 assert.equal(calls.length,2);
});
test('lost or malformed response never silently replays a mutation',async t=>{
 const calls=[],f=await fixture(t,(socket,request)=>{calls.push(request);socket.end(request.operation==='host.exec'?'':'PRIVATE malformed response');});await f.start();
 await assert.rejects(bridgeClient(f.path)('node','host.exec',{key:'fixed'}),e=>e.status===503);
 await assert.rejects(bridgeClient(f.path)('node','host.cancel',{id:'fixed'}),e=>e.status===502&&!e.message.includes('PRIVATE'));
 assert.equal(calls.length,2);
});
test('only exact trusted transport code/status pairs are promoted; native denials remain domain errors',async t=>{
 const calls=[],f=await fixture(t,(socket,request)=>{
  calls.push(request);
  socket.end(JSON.stringify(request.args));
 });await f.start();const call=bridgeClient(f.path);
 for(const [code,status] of [['NODE_TRANSPORT_BUSY',503],['NODE_CONNECT_FAILED',503],['NODE_RESPONSE_TIMEOUT',504],['NODE_SSH_AUTH_FAILED',502],['NODE_SSH_HOSTKEY_FAILED',502],['NODE_RESPONSE_INVALID',502]]){
  await assert.rejects(call('node','host.status',{ok:false,error:'PRIVATE ssh stderr and key',code,status}),e=>e.code===code&&e.status===status&&!e.message.includes('PRIVATE'));
 }
 for(const body of [{ok:false,error:'Native refusal',code:'NODE_CONNECT_FAILED',status:200},{ok:false,error:'Native refusal',code:'ARBITRARY',status:503}])
  await assert.rejects(call('node','host.exec',body),e=>e.status===undefined&&e.message==='Native refusal');
 assert.equal(calls.length,8);
});
test('partial response activity cannot extend the hard 32-second elapsed deadline',async t=>{
 let accepted;const started=new Promise(resolve=>accepted=resolve);
 const f=await fixture(t,(socket)=>{socket.write('{"ok":');accepted(socket);});await f.start();
 t.mock.timers.enable({apis:['setTimeout']});
 const result=bridgeClient(f.path)('node','host.status',{}),socket=await started;
 t.mock.timers.tick(16000);socket.write('true,');await new Promise(setImmediate);
 t.mock.timers.tick(16001);await assert.rejects(result,e=>e.status===504&&e.code==='EXECUTOR_TIMEOUT');
});
test('real HTTP reports 503 during bridge absence and same host status recovers once listener starts',async t=>{
 const calls=[],f=await fixture(t,(socket,request)=>{calls.push(request);socket.end(JSON.stringify({ok:true,result:{id:request.args.id,state:'RUNNING'}}));});
 const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
 const origin='http://127.0.0.1:'+port,password='Only-Test-Bridge-2026!',bootstrap=join(f.dir,'bootstrap');
 await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
 const {server,service}=await createPortalServer({database:join(f.dir,'database'),bootstrap,origin,secure:false,bridgeSocket:f.path});
 clearInterval(service.executionTimer);clearInterval(service.maintenanceTimer);
 await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const login=await service.login('admin',password),body={operation:'host.status',args:{machine:'gpu-1',id:'11111111-1111-4111-8111-111111111111'}};
 const statuses=[];
 const result=await apiPost(origin,'call',body,{token:login.token,
  fetchImpl:async(...args)=>{const response=await fetch(...args);statuses.push(response.status);return response;},
  sleep:async()=>{await f.start();}
 });
 assert.deepEqual(statuses,[503,200]);assert.equal(result.result.state,'RUNNING');
 assert.equal(calls.length,1);assert.equal(calls[0].operation,'host.status');assert.equal(calls[0].args.id,body.args.id);
});


test('explicit dedicated training uncertainty becomes safe 503 without replay or native error disclosure',async t=>{
 const calls=[],f=await fixture(t,(socket,request)=>{calls.push(request);socket.end(JSON.stringify({ok:false,error:'Dedicated training exchange unconfirmed PRIVATE path',errorType:'ValueError',outcomeUnconfirmed:true}));});await f.start();
 await assert.rejects(bridgeClient(f.path)('node','projects.copy.probe',{userId:'u',project:'vision',release:'a'.repeat(64)}),e=>e.status===503&&e.code==='EXECUTOR_UNCONFIRMED'&&!/PRIVATE|ValueError/.test(e.message));
 assert.equal(calls.length,1);assert.equal(calls[0].operation,'projects.copy.probe');
});
