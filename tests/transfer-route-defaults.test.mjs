import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {uploadLocalFile,uploadLocalTree} from '../client-transfers.mjs';
import {downloadResultFile} from '../client-result-download.mjs';
import {uploadBrowserFile} from '../dist/personal-upload.js';
import {readBrowserFile} from '../dist/file-transfer-ui.js';
import {selectTransferRoute} from '../client-transfer-route.mjs';
import {tcpCampusReachable} from '../client-campus-endpoints.mjs';

const help='校园网暂时不通（夜间认证时段），可以加 --via relay（上传）或 --via portal（下载）走 VPS，原 key 不变。';
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'transfer-route-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const local=join(root,'source'),bytes=Buffer.from('workspace bytes');await writeFile(local,bytes);
 return {root,local,bytes,machine:'fixture-machine',key:randomUUID()};
}
for(const area of ['code','dataset'])for(const via of [undefined,'direct','auto','relay'])test(`${area} CLI upload: ${via??'default'} uses the selected route and original key`,async t=>{
 const f=await fixture(t),context={area,...(area==='code'?{project:'fixture'}:{dataset:'fixture'})},direct=via==='direct'||(!via||via==='auto')&&area==='dataset';let offset=0,campus=0,relay=0;
 const chunk=args=>{assert.equal(args.offset,offset);const bytes=Buffer.from(args.data,'base64');assert.deepEqual(bytes,f.bytes);offset+=bytes.length;return {offset,state:'UPLOADING'};};
 const call=async(op,args)=>{if(op==='files.direct-ticket')return {result:{endpoint:'https://campus.invalid'}};assert.equal(args.key,f.key);if(op==='data.upload.begin')return {result:{offset,state:'UPLOADING'}};if(op==='data.upload.finish')return {result:{state:'COMPLETE'}};assert.equal(op,'data.upload.chunk');relay++;return {result:chunk(args)};};
 const result=await uploadLocalFile(call,{...f,context,path:'file',via,probe:async()=>true,transportFactory:async(_call,args)=>{campus++;assert.equal(args.identity.uploadId,f.key);return {request:async({offset,bytes})=>chunk({offset,data:bytes.toString('base64')}),close:async()=>{}};}});
 assert.equal(result.state,'COMPLETE');assert.equal(campus,direct?1:0);assert.equal(relay,direct?0:1);assert.equal(offset,f.bytes.length);
});
test('workspace trees pass the VPS default to every file',async t=>{
 const f=await fixture(t),routes=[];
 await uploadLocalTree(()=>assert.fail('no status query'),{...f,remote:'file',context:{area:'code',project:'fixture'},uploadFile:async(_call,args)=>{routes.push(args.via);return {state:'COMPLETE'};}});
 assert.deepEqual(routes,['relay']);
});
for(const area of ['code','dataset'])for(const via of [undefined,'direct','auto','portal'])test(`${area} CLI download: ${via??'default'} uses the selected route`,async t=>{
 const f=await fixture(t),destination=join(f.root,'download'),context={area,project:'fixture',dataset:'fixture',runId:'fixture-job'},direct=via==='direct'||(!via||via==='auto')&&area==='dataset';let campus=0,portal=0;
 const reply=offset=>({size:f.bytes.length,offset,data:f.bytes.subarray(offset).toString('base64')});
 const result=await downloadResultFile(async(op,args)=>{if(op==='files.direct-ticket')return {result:{endpoint:'https://campus.invalid'}};assert.equal(op,'files.get');portal++;return {result:reply(args.offset)};},{machine:f.machine,context,path:'file',destination,via},{probe:async()=>true,transportFactory:async()=>{campus++;return {chunkBytes:1024**2,request:async({offset})=>reply(offset),close:async()=>{}};}});
 assert.equal(result.bytes,f.bytes.length);assert.deepEqual(await readFile(destination),f.bytes);assert.equal(campus,direct?1:0);assert.equal(portal,direct?0:1);
});
for(const area of ['code','output'])test(`${area} default portal download resumes the exact byte offset without campus`,async t=>{
 const f=await fixture(t),bytes=Buffer.alloc(1024**2+3,97),destination=join(f.root,'download'),offsets=[];let fail=true;
 const call=async(op,args)=>{assert.equal(op,'files.get');offsets.push(args.offset);if(fail&&args.offset===1024**2){fail=false;throw Error('VPS temporarily disconnected');}return {result:{size:bytes.length,offset:args.offset,data:bytes.subarray(args.offset,args.offset+1024**2).toString('base64')}};};
 const download=()=>downloadResultFile(call,{machine:f.machine,context:{area,project:'fixture',runId:'fixture-job'},path:'file',destination},{transportFactory:()=>assert.fail('campus is offline')});
 await assert.rejects(download(),/VPS temporarily disconnected/);await assert.rejects(lstat(destination),{code:'ENOENT'});
 const mark=offsets.length;assert.equal((await download()).resumed,true);assert.equal(offsets[mark],1024**2);assert.deepEqual(await readFile(destination),bytes);
});
test('workspace directory download defaults every child to the portal',async t=>{
 const f=await fixture(t),destination=join(f.root,'directory');
 const result=await downloadResultFile(async(op,args)=>{if(op==='files.list')return {result:{entries:[{name:'file',type:'file',size:f.bytes.length}]}};assert.equal(op,'files.get');assert.equal(args.path,'file');return {result:{size:f.bytes.length,offset:0,data:f.bytes.toString('base64')}};},{machine:f.machine,context:{area:'code',project:'fixture'},path:'.',destination},{transportFactory:()=>assert.fail('campus is offline')});
 assert.equal(result.files,1);assert.deepEqual(await readFile(join(destination,'file')),f.bytes);
});
for(const area of ['code','dataset'])test(`${area} browser uploads keep the route and original key`,async t=>{
 const f=await fixture(t);let campus=0,relay=0;const file=new Blob([f.bytes]);
 t.mock.method(globalThis,'fetch',async url=>{if(new URL(url).pathname==='/capabilities')return {};campus++;return {ok:true,json:async()=>({result:{offset:f.bytes.length}})};});
 const call=async(op,args)=>{if(op==='files.direct-ticket')return {endpoint:'https://campus.invalid',grantId:'fixture',ticket:'fixture',expiresAt:Date.now()/1000+600};assert.equal(args.key,f.key);if(op==='data.upload.begin')return {state:'UPLOADING',offset:0};if(op==='data.upload.finish')return {state:'COMPLETE'};assert.equal(op,'data.upload.chunk');relay++;assert.deepEqual(Buffer.from(args.data,'base64'),f.bytes);return {offset:f.bytes.length};};
 assert.equal((await uploadBrowserFile(file,{call,machine:f.machine,area,project:'fixture',dataset:'fixture',path:'file',key:f.key})).state,'COMPLETE');assert.equal(campus,area==='dataset'?1:0);assert.equal(relay,area==='code'?1:0);
});
for(const area of ['code','output','dataset'])test(`${area} browser downloads select the expected route`,async t=>{
 const f=await fixture(t);let campus=0,portal=0;
 t.mock.method(globalThis,'fetch',async url=>{if(new URL(url).pathname==='/capabilities')return {};campus++;return {ok:true,arrayBuffer:async()=>f.bytes,headers:new Headers({'x-gpuq-file-metadata':Buffer.from(JSON.stringify({size:f.bytes.length,offset:0})).toString('base64')})};});
 const call=async(op,args)=>{if(op==='files.direct-ticket')return {endpoint:'https://campus.invalid',grantId:'fixture',ticket:'fixture',expiresAt:Date.now()/1000+600};assert.equal(op,'files.get');portal++;return {size:f.bytes.length,offset:args.offset,data:f.bytes.toString('base64')};};
 const blob=await readBrowserFile(call,{machine:f.machine,area,project:'fixture',dataset:'fixture'},'file');assert.deepEqual(Buffer.from(await blob.arrayBuffer()),f.bytes);assert.equal(campus,area==='dataset'?1:0);assert.equal(portal,area==='dataset'?0:1);
});
for(const action of ['upload','download'])test(`browser dataset ${action} failure gives VPS guidance without switching routes`,async t=>{
 const f=await fixture(t);let portalChunks=0;
 t.mock.method(globalThis,'fetch',async()=>{throw TypeError('Failed to fetch');});
 const call=async(op)=>{if(op==='files.direct-ticket')return {endpoint:'https://campus.invalid',grantId:'fixture',ticket:'fixture',expiresAt:Date.now()/1000+600};if(op==='data.upload.begin')return {state:'UPLOADING',offset:0};portalChunks++;assert.fail(op);};
 await assert.rejects(action==='upload'?uploadBrowserFile(new Blob([f.bytes]),{call,machine:f.machine,area:'dataset',dataset:'fixture',path:'file',key:f.key,route:{via:'direct'}}):readBrowserFile(call,{machine:f.machine,area:'dataset',dataset:'fixture'},'file',{route:{via:'direct'}}),error=>{assert.ok(error.message.includes(help));if(action==='upload')assert.match(error.message,new RegExp(f.key));return true;});assert.equal(portalChunks,0);
});
for(const reachable of [false,true])for(const action of ['put','get'])test(`dataset ${action} probes once (${reachable}) and resumes the chosen route`,async t=>{
 const f=await fixture(t),stateFile=join(f.root,'operation.route.json'),messages=[];let probes=0,tickets=0;
 const select=via=>selectTransferRoute({area:'dataset',action,via,stateFile,getGrant:async()=>{tickets++;return {endpoint:'https://campus.invalid'};},probe:async()=>{probes++;return reachable;},notify:message=>messages.push(message)});
 const expected=reachable?'direct':action==='put'?'relay':'portal';assert.equal((await select()).via,expected);assert.equal((await select()).via,expected);assert.equal(probes,1);assert.equal(tickets,1);assert.deepEqual(messages,reachable?[]:['校园网不可达，本次经 VPS 传输（较慢）。']);
 assert.equal((await select(action==='put'?'relay':'portal')).via,action==='put'?'relay':'portal');assert.equal(probes,1);
});
for(const via of ['direct','relay'])test(`dataset upload failure resumes ${via} with its original UUID and offset`,async t=>{
 const f=await fixture(t),stateDirectory=join(f.root,'uploads'),bytes=Buffer.alloc(512*1024+3,97);await writeFile(f.local,bytes);let offset=0,probe=0,direct=0,relay=0,fail=true;
 const chunk=()=>{if(offset&&fail){fail=false;throw Object.assign(Error('network disconnected before next chunk'),{code:'TCP_TIMEOUT',writeMayHaveReachedPeer:false});}offset=Math.min(bytes.length,offset+512*1024);return {offset};};
 const call=async(op,args)=>{if(op==='files.direct-ticket')return {result:{endpoint:'https://campus.invalid'}};assert.equal(args.key,f.key);if(op==='data.upload.begin'||op==='data.upload.status')return {result:{state:'UPLOADING',offset}};if(op==='data.upload.finish')return {result:{state:'COMPLETE'}};assert.equal(op,'data.upload.chunk');relay++;return {result:chunk()};};
 const options={...f,context:{area:'dataset',dataset:'fixture'},path:'file',stateDirectory,probe:async()=>{probe++;return via==='direct';},transportFactory:async()=>({request:async()=>{direct++;return chunk();},close:async()=>{}})};
 await assert.rejects(uploadLocalFile(call,options),{code:'TCP_TIMEOUT'});assert.equal(offset,512*1024);assert.equal(probe,1);assert.equal(direct,via==='direct'?2:0);assert.equal(relay,via==='relay'?2:0);
 assert.equal((await uploadLocalFile(call,{...options,probe:()=>assert.fail('resume must not probe again')})).state,'COMPLETE');assert.equal(offset,bytes.length);assert.equal(probe,1);assert.equal(direct,via==='direct'?3:0);assert.equal(relay,via==='relay'?3:0);
});
for(const reachable of [false,true])test(`dataset download retains its initial ${reachable?'direct':'portal'} route after interruption`,async t=>{
 const f=await fixture(t),destination=join(f.root,'result'),bytes=Buffer.alloc(1024**2+3,97);let probes=0,failed=false,portal=0,direct=0;const offsets=[];
 const chunk=offset=>{offsets.push(offset);if(offset&&!failed){failed=true;throw Object.assign(Error('download TCP timeout'),{code:'TCP_TIMEOUT'});}return {size:bytes.length,offset,data:bytes.subarray(offset,offset+1024**2).toString('base64')};};
 const call=async(op,args)=>{if(op==='files.direct-ticket')return {result:{endpoint:'https://campus.invalid'}};assert.equal(op,'files.get');portal++;return {result:chunk(args.offset)};};
 const options={machine:f.machine,context:{area:'dataset',dataset:'fixture'},path:'file',destination},hooks={probe:async()=>{probes++;return reachable;},transportFactory:async()=>({chunkBytes:1024**2,request:async({offset})=>{direct++;return chunk(offset);},close:async()=>{}})};
 await assert.rejects(downloadResultFile(call,options,hooks),{code:'TCP_TIMEOUT'});assert.equal(direct,reachable?2:0);assert.equal(portal,reachable?0:2);
 assert.equal((await downloadResultFile(call,options,{...hooks,probe:()=>assert.fail('do not probe during resume')})).resumed,true);assert.equal(probes,1);assert.deepEqual(offsets,[0,1024**2,1024**2]);assert.deepEqual(await readFile(destination),bytes);assert.equal(direct,reachable?3:0);assert.equal(portal,reachable?0:3);
});
test('dataset directory selects once, saves the route, and never switches between files',async t=>{
 const f=await fixture(t),local=join(f.root,'tree'),stateDirectory=join(f.root,'states');await mkdir(local);await writeFile(join(local,'a'),'a');await writeFile(join(local,'b'),'b');let probes=0;const routes=[];
 const options={...f,local,stateDirectory,context:{area:'dataset',dataset:'fixture'},probe:async()=>{probes++;return false;},uploadFile:async(_call,args)=>{routes.push(args.via);return {state:'COMPLETE'};}};
 const call=async op=>{assert.equal(op,'files.direct-ticket');return {result:{endpoint:'https://campus.invalid'}};};
 await uploadLocalTree(call,options);await uploadLocalTree(call,{...options,probe:()=>assert.fail('resume must retain route')});assert.equal(probes,1);assert.deepEqual(routes,['relay','relay','relay','relay']);
});
test('native route selection sends one TCP-only 1500ms probe and closes the helper',async()=>{
 const requests=[];let closed=0;
 for(const reachable of [false,true])assert.equal(await tcpCampusReachable({endpoint:'https://campus.invalid',certificateSha256:'a'.repeat(64)},{agentFactory:()=>({request:async frame=>{requests.push(frame);if(!reachable)throw Error('TCP timeout');return {value:{ok:true}};},destroy:async()=>{closed++;}})}),reachable);
 assert.equal(requests.length,2);assert.equal(closed,2);assert.ok(requests.every(frame=>frame.op==='probe'&&frame.tcpOnly===true&&frame.probeTimeoutMs===1500));
});
test('macOS route selection uses one plain TCP connection and sends no bytes',async t=>{
 let bytes=0;const ended=new Promise(resolve=>{
  const server=createServer(socket=>{socket.on('data',chunk=>bytes+=chunk.length);socket.on('end',resolve);});
  t.after(()=>new Promise(done=>server.close(done)));
  server.listen(0,'127.0.0.1',async()=>{try{assert.equal(await tcpCampusReachable({endpoint:'https://127.0.0.1:'+server.address().port},{platform:'darwin'}),true);}catch(error){resolve(Promise.reject(error));}});
 });
 await ended;assert.equal(bytes,0);
});
