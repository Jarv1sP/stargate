import test from 'node:test';
import assert from 'node:assert/strict';
import {uploadBrowserFile} from '../dist/personal-upload.js';
import {readBrowserFile} from '../dist/file-transfer-ui.js';

const scope={machine:'fixture-node',area:'dataset',dataset:'images'},key='11111111-1111-4111-8111-111111111111';
for(const reachable of [false,true])test(`browser dataset upload selects ${reachable?'campus':'VPS'} once and persists it for the original key`,async t=>{
 const bytes=Buffer.alloc(1024**2+3,97),saved=[],messages=[];let offset=0,probes=0,campus=0,relay=0,tickets=0;
 const chunk=args=>{assert.equal(args.offset,offset);const part=Buffer.from(args.data,'base64');assert.deepEqual(part,bytes.subarray(offset,offset+part.length));offset+=part.length;return {offset};};
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(new URL(url).pathname==='/capabilities'){probes++;assert.equal(options.mode,'no-cors');assert.ok(options.signal);if(!reachable)throw TypeError('campus offline');return {};}
  campus++;return {ok:true,json:async()=>({result:chunk({offset:Number(new URL(url).searchParams.get('offset')),data:Buffer.from(options.body).toString('base64')})})};
 });
 const call=async(op,args)=>{if(op==='files.direct-ticket'){tickets++;assert.equal(args.uploadId,key);return {endpoint:'https://campus.invalid',grantId:key,ticket:'fixture',expiresAt:Date.now()/1000+600};}assert.equal(args.key,key);if(op==='data.upload.begin')return {state:'UPLOADING',offset};if(op==='data.upload.finish')return {state:'COMPLETE'};assert.equal(op,'data.upload.chunk');relay++;return chunk(args);};
 const options={...scope,call,path:'sample',key,route:{save:via=>saved.push(via)},onRoute:message=>messages.push(message)};
 assert.equal((await uploadBrowserFile(new Blob([bytes]),options)).state,'COMPLETE');
 assert.equal(offset,bytes.length);assert.equal(probes,1);assert.equal(tickets,1);assert.equal(campus,reachable?2:0);assert.equal(relay,reachable?0:2);assert.deepEqual(saved,[reachable?'direct':'relay']);assert.deepEqual(messages,reachable?[]:['校园网不可达，本次经 VPS 传输（较慢）。']);
 await uploadBrowserFile(new Blob([bytes]),{...options,route:{via:saved[0]}});assert.equal(probes,1);
});
for(const reachable of [false,true])test(`browser dataset upload keeps ${reachable?'campus':'VPS'} and the original offset after a mid-transfer failure`,async t=>{
 const bytes=Buffer.alloc(1024**2+3,98);let offset=0,probes=0,failed=false,selected,campus=0,relay=0;
 const chunk=(at,part)=>{assert.equal(at,offset);if(offset&&!failed){failed=true;throw TypeError('connection interrupted');}assert.deepEqual(part,bytes.subarray(offset,offset+part.length));offset+=part.length;return {offset};};
 t.mock.method(globalThis,'fetch',async(url,options)=>{if(new URL(url).pathname==='/capabilities'){probes++;if(!reachable)throw TypeError('campus offline');return {};}
  campus++;return {ok:true,json:async()=>({result:chunk(Number(new URL(url).searchParams.get('offset')),Buffer.from(options.body))})};});
 const call=async(op,args)=>{if(op==='files.direct-ticket')return {endpoint:'https://campus.invalid',grantId:key,ticket:'fixture',expiresAt:Date.now()/1000+600};assert.equal(args.key,key);if(op==='data.upload.begin')return {state:'UPLOADING',offset};if(op==='data.upload.finish')return {state:'COMPLETE'};assert.equal(op,'data.upload.chunk');relay++;return chunk(args.offset,Buffer.from(args.data,'base64'));};
 const options={...scope,call,path:'sample',key,route:{save:via=>{selected=via;}},onRoute:()=>{}};
 await assert.rejects(uploadBrowserFile(new Blob([bytes]),options),error=>{assert.match(error.message,new RegExp(key));return true;});assert.equal(offset,1024**2);assert.equal(campus,reachable?2:0);assert.equal(relay,reachable?0:2);
 assert.equal((await uploadBrowserFile(new Blob([bytes]),{...options,route:{via:selected}})).state,'COMPLETE');assert.equal(probes,1);assert.equal(offset,bytes.length);assert.equal(campus,reachable?3:0);assert.equal(relay,reachable?0:3);
});
test('one browser directory upload shares its selected route across files and later resumes',async t=>{
 let probes=0,saved,relay=0;const route={save:via=>{saved=via;}};
 t.mock.method(globalThis,'fetch',async()=>{probes++;throw TypeError('campus offline');});
 const call=async(op,args)=>{if(op==='files.direct-ticket')return {endpoint:'https://campus.invalid'};if(op==='data.upload.begin')return {state:'UPLOADING',offset:0};if(op==='data.upload.finish')return {state:'COMPLETE'};assert.equal(op,'data.upload.chunk');relay++;return {offset:3};};
 for(const path of ['first','second'])await uploadBrowserFile(new Blob(['abc']),{...scope,call,path,key,route,onRoute:()=>{}});
 await uploadBrowserFile(new Blob(['abc']),{...scope,call,path:'third',key,route:{via:saved}});assert.equal(probes,1);assert.equal(relay,3);assert.equal(saved,'relay');
});
test('browser route probe stops after 1.5 seconds before selecting VPS',async t=>{
 let elapsed;const started=performance.now();
 t.mock.method(globalThis,'fetch',async(_url,options)=>new Promise((resolve,reject)=>{const keepAlive=setTimeout(resolve,5000);options.signal.addEventListener('abort',()=>{clearTimeout(keepAlive);elapsed=performance.now()-started;reject(options.signal.reason);},{once:true});}));
 const call=async op=>op==='files.direct-ticket'?{endpoint:'https://campus.invalid'}:op==='data.upload.begin'?{state:'UPLOADING',offset:0}:op==='data.upload.finish'?{state:'COMPLETE'}:{offset:3};
 assert.equal((await uploadBrowserFile(new Blob(['abc']),{...scope,call,path:'sample',key,route:{},onRoute:()=>{}})).state,'COMPLETE');assert.ok(elapsed>=1400&&elapsed<3000,elapsed);
});
test('cancelling a browser probe never starts a VPS upload',async t=>{
 const controller=new AbortController();let chunks=0;
 t.mock.method(globalThis,'fetch',async()=>{controller.abort();throw controller.signal.reason;});
 const call=async op=>{if(op==='files.direct-ticket')return {endpoint:'https://campus.invalid'};if(op==='data.upload.begin')return {state:'UPLOADING',offset:0};chunks++;assert.fail(op);};
 await assert.rejects(uploadBrowserFile(new Blob(['abc']),{...scope,call,path:'sample',key,signal:controller.signal}),{name:'AbortError'});assert.equal(chunks,0);
});
for(const reachable of [false,true])test(`browser dataset download selects ${reachable?'campus':'VPS'} once before reading bytes`,async t=>{
 let probes=0,campus=0,portal=0;
 t.mock.method(globalThis,'fetch',async url=>{if(new URL(url).pathname==='/capabilities'){probes++;if(!reachable)throw TypeError('offline');return {};}
  campus++;return {ok:true,arrayBuffer:async()=>Buffer.from('abc'),headers:new Headers({'x-gpuq-file-metadata':Buffer.from(JSON.stringify({size:3,offset:0})).toString('base64')})};});
 const call=async(op,args)=>{if(op==='files.direct-ticket')return {endpoint:'https://campus.invalid',grantId:key,ticket:'fixture',expiresAt:Date.now()/1000+600};assert.equal(op,'files.get');portal++;return {size:3,offset:args.offset,data:'YWJj'};};
 const blob=await readBrowserFile(call,scope,'sample',{onRoute:()=>{}});assert.equal(await blob.text(),'abc');assert.equal(probes,1);assert.equal(campus,reachable?1:0);assert.equal(portal,reachable?0:1);
});
