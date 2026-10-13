import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {bridgeClient} from '../execution-bridge.mjs';

test('standalone transport preserves job identity across a lost submit reply and explicit observe/cancel',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'workspace-job-bridge-')),path=join(dir,'bridge.sock');
 const requests=[],peers=new Set();
 const server=net.createServer({allowHalfOpen:true},socket=>{
  peers.add(socket);socket.on('close',()=>peers.delete(socket));socket.on('error',()=>{});
  let raw='';socket.on('data',part=>raw+=part);socket.on('end',()=>{
   const request=JSON.parse(raw);requests.push(request);
   if(request.operation==='sync'){socket.end();return;}
   socket.end(JSON.stringify({ok:true,result:{nodeJobId:'J123456789abc',
    state:request.operation==='watch'?'PENDING':'CANCELED',assignedIndices:[]}}));
  });
 });
 t.after(async()=>{for(const peer of peers)peer.destroy();if(server.listening)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(path,resolve);});
 const call=bridgeClient(path),machine='gpu-1';
 const job={id:'11111111-1111-4111-8111-111111111111',userId:'demo-user-1',username:'alice',
  cards:1,argv:['python','train.py'],name:'workspace test',minVramGiB:0,project:'vision',workspace:true};
 await assert.rejects(call(machine,'sync',{job}),error=>error.code==='EXECUTOR_UNAVAILABLE');
 assert.deepEqual(requests,[{machine,operation:'sync',args:{job}}]);
 assert.deepEqual(await call(machine,'watch',{job}),{nodeJobId:'J123456789abc',state:'PENDING',assignedIndices:[]});
 assert.deepEqual(await call(machine,'cancel',{job}),{nodeJobId:'J123456789abc',state:'CANCELED',assignedIndices:[]});
 assert.deepEqual(requests,['sync','watch','cancel'].map(operation=>({machine,operation,args:{job}})));
});
