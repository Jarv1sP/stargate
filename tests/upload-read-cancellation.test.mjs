import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PortalService} from '../portal-service.mjs';
import {createPortalServer} from '../portal-server.mjs';
import {bridgeClient} from '../execution-bridge.mjs';
import {MACHINES} from '../dist/model.js';
const machine=MACHINES[0].id,key='11111111-1111-4111-8111-111111111111',password='Read-Cancellation-Local-Only!';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(t,bridge,{httpServer=false}={}){
 const dir=await mkdtemp(join(tmpdir(),'C2-read-cancel-')),bootstrap=join(dir,'bootstrap');await writeFile(bootstrap,JSON.stringify({username:'admin',password}));let service,server;
 if(httpServer){({service,server}=await createPortalServer({database:join(dir,'db'),bootstrap,origin:'http://localhost',secure:false,bridge}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));}
 else service=await PortalService.open(join(dir,'db'),bootstrap,undefined,bridge);
 clearInterval(service.executionTimer);const user=service.store.users[0],token=service.issueSession({userId:user.id,username:user.username,role:user.role});
 t.after(async()=>{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}else service.close();await rm(dir,{recursive:true,force:true});});return {dir,service,server,token};
}
async function socketFixture(t){
 const dir=await mkdtemp(join(tmpdir(),'C2-real-read-socket-')),path=join(dir,'bridge.sock'),started=deferred(),closed=deferred(),requests=[];const sockets=new Set();
 const server=net.createServer({allowHalfOpen:true},socket=>{sockets.add(socket);let raw='';socket.on('data',chunk=>raw+=chunk);let timer;socket.on('error',()=>{});socket.on('end',()=>{requests.push(JSON.parse(raw));timer=setInterval(()=>socket.write(' '),5);timer.unref();started.resolve();});socket.on('close',()=>{clearInterval(timer);sockets.delete(socket);closed.resolve();});});
 await new Promise(resolve=>server.listen(path,resolve));t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});return {bridge:bridgeClient(path),started,closed,requests};
}
test('same-key status reads share a real observation and bypass a stalled mutation without adding writes',async t=>{
 const remote=deferred(),started=deferred(),held=deferred(),calls=[],f=await fixture(t,async(host,op,args)=>{calls.push({host,op,args});started.resolve();await remote.promise;return {key,state:'UPLOADING',offset:2,totalSize:4};});
 const write=f.service.enqueue(()=>held.promise);const args={machine,key},a=f.service.invoke(f.token,'data.upload.status',args);await started.promise;const b=f.service.invoke(f.token,'data.upload.status',args);remote.resolve();assert.deepEqual(await a,await b);assert.equal(calls.length,1);assert.equal(calls[0].args.key,key);assert.equal(f.service.pending,1);held.resolve();await write;
});
test('canceling the final observer closes the real node socket and releases the read slot without replay',async t=>{
 const socket=await socketFixture(t),f=await fixture(t,socket.bridge),controller=new AbortController(),pending=f.service.invoke(f.token,'data.upload.status',{machine,key},{signal:controller.signal});
 const rejected=assert.rejects(pending,e=>e.status===499||e.name==='AbortError');await socket.started.promise;controller.abort();await rejected;await socket.closed.promise;assert.equal(socket.requests.length,1);assert.equal(socket.requests[0].args.key,key);assert.equal(f.service.readObservations.size,0);
});
test('an HTTP client disconnect cancels its status dependency rather than leaving a node read running',async t=>{
 const socket=await socketFixture(t),f=await fixture(t,socket.bridge,{httpServer:true}),body=JSON.stringify({client:{name:'gpuctl',protocol:2},operation:'data.upload.status',args:{machine,key}});
 const request=http.request({host:'127.0.0.1',port:f.server.address().port,path:'/api/call',method:'POST',headers:{Host:'localhost','Content-Type':'application/json',Authorization:'Bearer '+f.token}});request.on('error',()=>{});request.end(body);await socket.started.promise;request.destroy();await socket.closed.promise;assert.equal(socket.requests.length,1);assert.equal(f.service.readObservations.size,0);
});
