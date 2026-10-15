import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {selectTransferRoute} from '../client-transfer-route.mjs';
import {uploadLocalFile} from '../client-transfers.mjs';
import {uploadBrowserFile} from '../dist/personal-upload.js';
import {readBrowserFile} from '../dist/file-transfer-ui.js';
import {createPersonalFileTransport} from '../client-personal-file-campus.mjs';
import {downloadResultFile} from '../client-result-download.mjs';
import {retryCampusRequest} from '../dist/personal-upload.js';

const help='数据集只走校园网直连，避免挤占 VPS 带宽。请连上校园网后用原命令重试，原 key 会续传。';
const key='11111111-1111-4111-8111-111111111111';
const grant={endpoint:'https://campus.invalid',certificateSha256:'a'.repeat(64),grantId:key,ticket:'fixture_ticket_for_local_test',chunkBytes:1024**2,expiresAt:Date.now()/1000+600,file:{size:3}};
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'route-v3-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
for(const action of ['put','get'])test(`offline dataset ${action} stops before sending file bytes through VPS`,async t=>{
 const dir=await fixture(t),local=join(dir,'file');await writeFile(local,'abc');const calls=[];
 const call=async op=>{calls.push(op);assert.equal(op,'files.direct-ticket');return {result:grant};};
 if(action==='put')await assert.rejects(uploadLocalFile(call,{machine:'fixture',context:{area:'dataset',dataset:'images'},path:'file',local,key,probe:async()=>false}),e=>e.message.includes(help));
 else await assert.rejects(selectTransferRoute({area:'dataset',action,getGrant:async()=>{calls.push('files.direct-ticket');return grant;},probe:async()=>false}),e=>e.message.includes(help));
 assert.deepEqual(calls,['files.direct-ticket']);
});
for(const area of ['code','output'])test(`${area} defaults to direct without a probe and resumes a recorded VPS continuation`,async t=>{
 const dir=await fixture(t),stateFile=join(dir,'route.json');
 const options={area,action:'get',stateFile,getGrant:()=>assert.fail('no separate ticket/probe'),probe:()=>assert.fail('no separate probe')};
 const selected=await selectTransferRoute(options);assert.equal(selected.via,'direct');
 await selected.save('portal');assert.equal((await selectTransferRoute(options)).via,'portal');
 assert.equal(JSON.parse(await readFile(stateFile,'utf8')).via,'portal');
 assert.equal((await selectTransferRoute({...options,via:'direct'})).via,'direct');
});
for(const via of ['relay','portal'])test(`dataset refuses an explicit ${via} lane`,async()=>{
 await assert.rejects(selectTransferRoute({area:'dataset',action:'put',via,getGrant:()=>assert.fail('invalid CLI option must not request a ticket')}),e=>e.message.includes(help));
});
for(const action of ['put','get'])test(`offline browser dataset ${action} never sends a Portal data chunk`,async t=>{
 t.mock.method(globalThis,'fetch',async()=>{throw TypeError('campus disconnected');});const calls=[];
 const call=async op=>{calls.push(op);if(op==='files.direct-ticket')return grant;if(op==='data.upload.begin')return {offset:0,state:'UPLOADING'};assert.fail(op);};
 const scope={machine:'fixture',area:'dataset',dataset:'images'};
 await assert.rejects(action==='put'?uploadBrowserFile(new Blob(['abc']),{...scope,call,path:'file',key}):readBrowserFile(call,scope,'file'),e=>e.message.includes(help));
 assert.equal(calls.includes('data.upload.chunk')||calls.includes('files.get'),false);
});
test('direct chunk retries reset/timeouts on the same key and offset, then return complete bytes',async()=>{
 let time=0,calls=0;const delays=[],offsets=[];
 const transport=await createPersonalFileTransport(async()=>({result:grant}),{machine:'fixture',context:{area:'dataset',dataset:'images'},path:'file',action:'get',
   agentFactory:()=>({destroy:async()=>{}}),send:async(value,_agent,_action,args)=>{assert.equal(value.grantId,key);offsets.push(args.offset);if(++calls<3)throw Object.assign(Error('first TCP timeout'),{code:calls===1?'TCP_TIMEOUT':'ECONNRESET'});return {size:3,offset:args.offset,data:'YWJj'};},
   retry:{now:()=>time,sleep:async ms=>{delays.push(ms);time+=ms;}}});
 try{const result=await transport.request({offset:0});assert.equal(Buffer.from(result.data,'base64').toString(),'abc');assert.deepEqual(offsets,[0,0,0]);assert.deepEqual(delays,[1000,2000]);}finally{await transport.close();}
});

test('workspace upload continues a partially written chunk over VPS at the confirmed offset and original key',async t=>{
 const dir=await fixture(t),local=join(dir,'source'),bytes=Buffer.alloc(512*1024+3,97);await writeFile(local,bytes);
 const messages=[],relayed=[],stored=[];let offset=0,direct=0;
 const call=async(op,args)=>{assert.equal(args.key,key);if(op==='data.upload.begin'||op==='data.upload.status')return {result:{state:'UPLOADING',offset}};
   if(op==='data.upload.finish')return {result:{state:'COMPLETE',offset}};assert.equal(op,'data.upload.chunk');relayed.push(args);const part=Buffer.from(args.data,'base64');stored.push(part);offset+=part.length;return {result:{offset}};};
 const options={machine:'fixture',context:{area:'code',project:'vision'},path:'source',local,key,stateDirectory:join(dir,'state'),probe:()=>assert.fail('no pre-probe'),notify:message=>messages.push(message),
   transportFactory:async()=>({request:async args=>{direct++;if(direct===1){stored.push(args.bytes);offset+=args.bytes.length;return {offset};}stored.push(args.bytes.subarray(0,1));offset++;throw Object.assign(Error('direct retries exhausted'),{code:'TCP_TIMEOUT',writeMayHaveReachedPeer:true});},close:async()=>{}})};
 assert.equal((await uploadLocalFile(call,options)).state,'COMPLETE');assert.equal(relayed.length,1);assert.equal(relayed[0].offset,512*1024+1);assert.equal(relayed[0].key,key);assert.deepEqual(Buffer.concat(stored),bytes);
 assert.deepEqual(messages,['校园直连失败，改经 VPS 继续']);assert.equal(JSON.parse(await readFile(join(dir,'state',key+'.route.json'),'utf8')).via,'relay');
});
for(const area of ['code','output'])test(`${area} download continues over VPS from the last local offset after direct retries end`,async t=>{
 const dir=await fixture(t),destination=join(dir,'download'),bytes=Buffer.alloc(1024**2+37,79),portal=[],messages=[];let direct=0;
 const reply=offset=>({size:bytes.length,offset,data:bytes.subarray(offset,offset+1024**2).toString('base64')});
 const result=await downloadResultFile(async(op,args)=>{assert.equal(op,'files.get');portal.push(args);return {result:reply(args.offset)};},
   {machine:'fixture',context:{area,project:'vision',runId:key},path:'file',destination},
   {probe:()=>assert.fail('no separate probe'),notify:message=>messages.push(message),transportFactory:async()=>({request:async({offset})=>{if(++direct===2)throw Object.assign(Error('first direct timeout'),{code:'TCP_TIMEOUT'});return reply(offset);},close:async()=>{}})});
 assert.equal(result.bytes,bytes.length);assert.deepEqual(await readFile(destination),bytes);assert.equal(portal.length,1);assert.equal(portal[0].offset,1024**2);assert.equal(portal[0].runId,key);assert.deepEqual(messages,['校园直连失败，改经 VPS 继续']);
});
test('a directory keeps the VPS continuation for later files without another direct attempt',async t=>{
 const dir=await fixture(t),destination=join(dir,'directory');let direct=0;const reads=[],messages=[];
 const call=async(op,args)=>{if(op==='files.list')return {result:{entries:[{name:'a',type:'file',size:3},{name:'b',type:'file',size:3}]}};assert.equal(op,'files.get');reads.push(args.path);return {result:{offset:0,size:3,data:'YWJj'}};};
 const result=await downloadResultFile(call,{machine:'fixture',context:{area:'output',project:'vision',runId:key},path:'.',destination},
   {notify:message=>messages.push(message),transportFactory:async()=>{direct++;return {request:async()=>{throw Object.assign(Error('direct retries ended'),{code:'TCP_TIMEOUT'});},close:async()=>{}};}});
 assert.equal(result.files,2);assert.equal(direct,1);assert.deepEqual(reads,['a','b']);assert.equal(await readFile(join(destination,'a'),'utf8'),'abc');assert.deepEqual(messages,['校园直连失败，改经 VPS 继续']);
});
test('one minute retry budget retains the first error and never sends after the deadline',async()=>{
 let elapsed=0,sends=0;const delays=[];
 await assert.rejects(retryCampusRequest(async()=>{sends++;throw Object.assign(Error(sends===1?'first timeout':'later reset'),{code:sends===1?'TCP_TIMEOUT':'ECONNRESET'});},{now:()=>elapsed,sleep:async ms=>{delays.push(ms);elapsed+=ms;}}),{code:'TCP_TIMEOUT',message:'first timeout'});
 assert.equal(elapsed,60000);assert.equal(sends,7);assert.deepEqual(delays,[1000,2000,4000,8000,16000,16000,13000]);
});
