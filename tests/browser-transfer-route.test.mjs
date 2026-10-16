import test from 'node:test';
import assert from 'node:assert/strict';
import {uploadBrowserFile,BROWSER_DATASET_HELP} from '../dist/personal-upload.js';
import {readBrowserFile} from '../dist/file-transfer-ui.js';
const key='11111111-1111-4111-8111-111111111111',grant={endpoint:'https://campus.invalid',grantId:key,ticket:'fixture',expiresAt:Date.now()/1000+600};
const retryClock=()=>{let elapsed=0;return {now:()=>elapsed,sleep:async ms=>{elapsed+=ms;}};};
for(const area of ['code','dataset'])for(const reachable of [false,true])test(`browser ${area} upload direct=${reachable}: dataset never uses VPS, workspace can continue`,async t=>{
 const bytes=Buffer.alloc(1024**2+3,97),saved=[],messages=[];let offset=0,probes=0,campus=0,relay=0;
 const chunk=(at,part)=>{assert.equal(at,offset);assert.deepEqual(part,bytes.subarray(offset,offset+part.length));offset+=part.length;return {offset};};
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(new URL(url).pathname==='/capabilities'){probes++;assert.equal(options.mode,'no-cors');if(!reachable)throw TypeError('campus offline');return {};}
  campus++;if(!reachable)throw TypeError('direct retries fail');return {ok:true,json:async()=>({result:chunk(Number(new URL(url).searchParams.get('offset')),Buffer.from(options.body))})};
 });
 const call=async(op,args)=>{if(op==='files.direct-ticket')return grant;assert.equal(args.key,key);if(op==='data.upload.begin'||op==='data.upload.status')return {state:'UPLOADING',offset};if(op==='data.upload.finish')return {state:'COMPLETE'};assert.equal(op,'data.upload.chunk');relay++;return chunk(args.offset,Buffer.from(args.data,'base64'));};
 const options={machine:'fixture',area,project:'vision',dataset:'images',call,path:'sample',key,route:{save:via=>saved.push(via)},onRoute:message=>messages.push(message),retry:retryClock()};
 const upload=()=>uploadBrowserFile(new Blob([bytes]),options);
 if(area==='dataset'&&!reachable){await assert.rejects(upload(),e=>e.message.includes(BROWSER_DATASET_HELP));assert.equal(offset,0);assert.equal(campus,0);assert.equal(relay,0);assert.deepEqual(saved,[]);return;}
 assert.equal((await upload()).state,'COMPLETE');assert.equal(offset,bytes.length);assert.equal(probes,area==='dataset'?1:0);assert.equal(relay,reachable?0:2);assert.equal(saved.at(-1),reachable?'direct':'relay');assert.deepEqual(messages,reachable?[]:['校园直连失败，改经 VPS 继续']);
});
for(const area of ['code','output','dataset'])for(const reachable of [false,true])test(`browser ${area} download direct=${reachable} keeps complete bytes and the allowed route`,async t=>{
 let probes=0,campus=0,portal=0;const messages=[];
 t.mock.method(globalThis,'fetch',async url=>{if(new URL(url).pathname==='/capabilities'){probes++;if(!reachable)throw TypeError('offline');return {};}
  campus++;if(!reachable)throw TypeError('first direct download error');return {ok:true,arrayBuffer:async()=>Buffer.from('abc'),headers:new Headers({'x-gpuq-file-metadata':Buffer.from(JSON.stringify({size:3,offset:0})).toString('base64')})};});
 const call=async(op,args)=>{if(op==='files.direct-ticket')return grant;assert.equal(op,'files.get');portal++;return {size:3,offset:args.offset,data:'YWJj'};};
 const download=()=>readBrowserFile(call,{machine:'fixture',area,project:'vision',dataset:'images'},'sample',{retry:retryClock(),onRoute:message=>messages.push(message)});
 if(area==='dataset'&&!reachable){await assert.rejects(download(),e=>e.message.includes(BROWSER_DATASET_HELP));assert.equal(campus,0);assert.equal(portal,0);return;}
 assert.equal(await (await download()).text(),'abc');assert.equal(probes,area==='dataset'?1:0);assert.equal(portal,reachable?0:1);assert.deepEqual(messages,reachable?[]:['校园直连失败，改经 VPS 继续']);
});
test('browser upload retries a lost response by reading the original key offset, without duplicating bytes',async t=>{
 const bytes=Buffer.alloc(1024**2+3,98),seen=[];let offset=0,failed=false,probes=0;
 t.mock.method(globalThis,'fetch',async(url,options)=>{if(new URL(url).pathname==='/capabilities'){probes++;return {};}
  const at=Number(new URL(url).searchParams.get('offset'));seen.push(at);assert.equal(at,offset);const part=Buffer.from(options.body);offset+=part.length;
  if(!failed){failed=true;throw TypeError('response lost after writing');}return {ok:true,json:async()=>({result:{offset}})};
 });
 const call=async(op,args)=>{if(op==='files.direct-ticket')return grant;assert.equal(args.key,key);if(op==='data.upload.begin'||op==='data.upload.status')return {state:'UPLOADING',offset};assert.equal(op,'data.upload.finish');return {state:'COMPLETE'};};
 assert.equal((await uploadBrowserFile(new Blob([bytes]),{machine:'fixture',area:'dataset',dataset:'images',call,path:'sample',key,retry:retryClock()})).state,'COMPLETE');assert.equal(offset,bytes.length);assert.deepEqual(seen,[0,1024**2]);assert.equal(probes,1);
});
test('one browser dataset directory shares the direct route and probes only once',async t=>{
 let probes=0,campus=0;const route={};
 t.mock.method(globalThis,'fetch',async url=>{if(new URL(url).pathname==='/capabilities'){probes++;return {};}campus++;return {ok:true,json:async()=>({result:{offset:3}})};});
 const call=async op=>{if(op==='files.direct-ticket')return grant;if(op==='data.upload.begin')return {state:'UPLOADING',offset:0};assert.equal(op,'data.upload.finish');return {state:'COMPLETE'};};
 for(const path of ['first','second','third'])await uploadBrowserFile(new Blob(['abc']),{machine:'fixture',area:'dataset',dataset:'images',call,path,key,route});
 assert.equal(probes,1);assert.equal(campus,3);assert.equal(route.via,'direct');
});
test('browser dataset probe stops after 1.5 seconds without a VPS data request',async t=>{
 let elapsed;const started=performance.now();
 t.mock.method(globalThis,'fetch',async(_url,options)=>new Promise((resolve,reject)=>{const timer=setTimeout(resolve,5000);options.signal.addEventListener('abort',()=>{clearTimeout(timer);elapsed=performance.now()-started;reject(options.signal.reason);},{once:true});}));
 const call=async op=>{assert.equal(op,'files.direct-ticket');return grant;};
 await assert.rejects(uploadBrowserFile(new Blob(['abc']),{machine:'fixture',area:'dataset',dataset:'images',call,path:'sample',key}),e=>e.message.includes(BROWSER_DATASET_HELP));assert.ok(elapsed>=1400&&elapsed<3000,elapsed);
});
test('cancelling a browser dataset probe never starts a VPS upload',async t=>{
 const controller=new AbortController();let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{controller.abort();throw controller.signal.reason;});
 const call=async op=>{calls++;assert.equal(op,'files.direct-ticket');return grant;};
 await assert.rejects(uploadBrowserFile(new Blob(['abc']),{machine:'fixture',area:'dataset',dataset:'images',call,path:'sample',key,signal:controller.signal}),{name:'AbortError'});assert.equal(calls,1);
});
