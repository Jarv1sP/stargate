import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/model.js';

test('four concurrent pull --job commands succeed when one node read takes longer than ten seconds',async t=>{
 const root=await mkdtemp(join(tmpdir(),'pull-concurrent-')),machine=MACHINES[0].id,bootstrap=join(root,'bootstrap'),password='Concurrent-Pull-Local-Fixture!';
 await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
 const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
 const origin='http://127.0.0.1:'+port,ids=Array.from({length:4},()=>randomUUID()),files=new Map(ids.map((id,index)=>[id,Buffer.alloc(1024**2+7,65+index)])),requests=[],stateRequests=[],children=new Set();let slow=false;
 const {server,service}=await createPortalServer({database:join(root,'db'),bootstrap,origin,secure:false,bridge:async(host,operation,args)=>{
  assert.equal(host,machine);assert.equal(operation,'files.get');requests.push(structuredClone(args));
  if(args.runId===ids[0]&&!slow){slow=true;await new Promise(resolve=>setTimeout(resolve,11200));}
  const bytes=files.get(args.runId);assert.ok(bytes);return {size:bytes.length,offset:args.offset,data:bytes.subarray(args.offset,args.offset+1024**2).toString('base64')};
 }});
 for(const key of ['executionTimer','notificationTimer','maintenanceTimer','transferTimer'])clearInterval(service[key]);
 t.after(async()=>{for(const child of children)child.kill();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
 await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));const login=await service.login('admin',password);
 service.store.jobs=ids.map(id=>({id,key:id,machine,project:'vision',userId:'peer',ownerId:'peer',state:'SUCCEEDED',cards:1,spec:{id,userId:'peer',project:'vision',argv:['true']}}));service.save();
 service.state=()=>assert.fail('pull must not construct full state');service.refreshGPUQ=()=>assert.fail('pull needs only its local job address');
 const readState=service.readState.bind(service);service.readState=(token,args)=>{stateRequests.push(structuredClone(args));return readState(token,args);};
 const session=join(root,'session.json');await writeFile(session,JSON.stringify({url:origin,token:login.token,principal:login.principal}));
 const values=await Promise.all(ids.map((id,index)=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[process.env.PULL_RETRY_CLI||new URL('../cli.mjs',import.meta.url).pathname,'--session-file',session,'--json','pull','weights.bin',join(root,'result-'+index),'--job',id,'--via','portal']);children.add(child);
  let out='',err='';child.stdout.on('data',bytes=>out+=bytes);child.stderr.on('data',bytes=>err+=bytes);child.on('error',reject);child.on('close',code=>{children.delete(child);resolve({code,out,err});});child.stdin.end();
 })));
 for(const [index,value] of values.entries()){assert.equal(value.code,0,value.err);assert.deepEqual(await readFile(join(root,'result-'+index)),files.get(ids[index]));}
 assert.equal(stateRequests.length,4);assert.deepEqual(new Set(stateRequests.map(args=>args.jobId)),new Set(ids));assert.ok(stateRequests.every(args=>args.view==='summary'));
 assert.equal(requests.length,8);assert.ok(requests.every(args=>args.ownerId==='peer'&&args.project==='vision'));assert.equal(slow,true);
});
