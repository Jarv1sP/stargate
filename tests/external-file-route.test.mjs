import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createPortalServer} from '../portal-server.mjs';
test('only pinned campus prepare uses the existing file bridge; workspace, lists and new data RPCs retain the external executor',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'external-route-')),bootstrap=join(dir,'bootstrap'),received=[];
 await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Only-Temporary-Route-2026!'}));
 const servers=[];let service;t.after(async()=>{service?.close();for(const server of servers)if(server.listening)await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
 for(const source of ['executor','personal']){const server=net.createServer(socket=>{let raw='';socket.on('data',bytes=>{raw+=bytes;if(!raw.includes('\n'))return;const value=JSON.parse(raw);received.push({source,...value});socket.end(JSON.stringify({ok:true,result:{source}})+'\n');});});servers.push(server);await new Promise(r=>server.listen(join(dir,source+'.sock'),r));}
 ({service}=await createPortalServer({database:join(dir,'db'),bootstrap,origin:'http://127.0.0.1:12345',secure:false,bridgeSocket:join(dir,'executor.sock'),fileBridgeSocket:join(dir,'personal.sock')}));
 for(const operation of ['files.direct.prepare','projects.list','projects.status','data.upload.status']){
  const result=await service.bridge('fixture-machine',operation,{userId:'fixture-owner'});
  assert.equal(result.source,operation==='files.direct.prepare'?'personal':'executor');assert.equal(received.at(-1).operation,operation);assert.equal(received.at(-1).args.userId,'fixture-owner');
 }
});
