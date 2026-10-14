import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {createPortalServer} from '../portal-server.mjs';
import {apiPost} from '../client-http.mjs';

test('#158 pre-creation refusal crosses node result, Portal HTTP and official client unchanged',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'terminal-158-')),bootstrap=join(dir,'bootstrap');
 await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Terminal-Test-Password-2026!'}));
 let mode='reject';const calls=[];
 const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));const base='http://127.0.0.1:'+port;
 const {server,service}=await createPortalServer({database:join(dir,'state.sqlite'),bootstrap,origin:base,secure:false,
  bridge:async(machine,operation,args)=>{
   calls.push({machine,operation,args});
   if(mode==='reject')return {protocol:'terminal-session-status-v1',id:args.key,state:'REJECTED',created:false,reason:'availableBytes=100; requestedBytes=10; hardFloorBytes=200'};
   if(mode==='missing')return {protocol:'terminal-session-status-v1',id:args.id,state:'NOT_FOUND',canCreate:true,evidence:{confirmed:true},message:'未找到这个终端，可以重新运行原 ssh 命令新建终端。'};
   return {protocol:'terminal-session-status-v1',id:randomUUID(),state:'REJECTED',created:false,reason:'wrong ID cannot prove non-creation'};
  }});
 clearInterval(service.executionTimer);clearInterval(service.maintenanceTimer);
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
 // Exercise HTTP without changing the configured host authorization.
 await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
 const user={id:'demo-user-1',username:'alice',name:'alice',role:'member',enabled:true,limits:{'gpu-1':1},total:1,policyVersion:0};service.store.users.push(user);
 const token=service.issueSession({userId:user.id,username:user.username,role:user.role});
 const request={machine:'gpu-1',project:'test',key:randomUUID(),clientId:randomUUID(),mode:'new',hostAdmin:false};
 const requestFetch=fetch;
 await assert.rejects(apiPost(base,'call',{operation:'terminal.open',args:request},{token,fetchImpl:requestFetch}),e=>e.status===400&&e.code==='TERMINAL_OPEN_REJECTED'&&e.message.includes('availableBytes=100'));
 assert.equal(calls.length,1);assert.equal(calls[0].args.userId,user.id);
 mode='missing';const status=await apiPost(base,'call',{operation:'terminal.status',args:{machine:'gpu-1',id:request.key,hostAdmin:false}},{token,fetchImpl:requestFetch});
 assert.equal(status.result.state,'NOT_FOUND');assert.equal(status.result.id,request.key);assert.equal(calls.length,2);
 await apiPost(base,'call',{operation:'terminal.status',args:{machine:'gpu-2',id:request.key,hostAdmin:false}},{token,fetchImpl:requestFetch});
 assert.equal(calls.length,3,'Team members can inspect every configured server');

});
