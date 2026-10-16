import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {downloadResultFile} from '../client-result-download.mjs';
import {createPersonalFileTransport} from '../client-personal-file-campus.mjs';
import {readBrowserFile} from '../dist/file-transfer-ui.js';
import {apiPost} from '../client-http.mjs';

const CHUNK=1024**2,key='11111111-1111-4111-8111-111111111111';
const clock=()=>{let elapsed=0;const delays=[];return {now:()=>elapsed,sleep:async ms=>{delays.push(ms);elapsed+=ms;},delays};};
const viaAPI=(call,retry)=>(operation,args)=>apiPost('https://fixture.invalid','call',{operation,args},{...retry,fetchImpl:async(_url,options)=>{
 const request=JSON.parse(options.body);
 try{return new Response(JSON.stringify(await call(request.operation,request.args)));}
 catch(error){if(['ECONNRESET','ETIMEDOUT'].includes(error.code))throw error;return new Response(JSON.stringify({error:error.message,code:error.code}),{status:error.status||(['EACCES','ENOENT'].includes(error.code)||/暂时无法读取/.test(error.message)?400:503)});}
}});
async function fixture(t,area){const root=await mkdtemp(join(tmpdir(),'pull-retry-'));t.after(()=>rm(root,{recursive:true,force:true}));return {machine:'fixture-node',context:{area,project:'vision',...(area==='output'?{runId:key}:{})},path:'file',destination:join(root,'file')};}
const failures=[()=>Error('files.get：暂时无法读取，请稍后再查。'),()=>Object.assign(Error('read unavailable'),{code:'READ_UNAVAILABLE'}),()=>Object.assign(Error('node temporarily unavailable'),{status:503}),()=>Object.assign(Error('connection reset'),{code:'ECONNRESET'}),()=>Object.assign(Error('connection timed out'),{code:'ETIMEDOUT'})];
for(const area of ['code','output'])for(const [index,failure] of failures.entries())test(`${area} Portal chunk resumes the original request after temporary failure ${index}`,async t=>{
 const options=await fixture(t,area),retry=clock(),bytes=Buffer.alloc(CHUNK+7,71),requests=[];let failed=0;
 const call=async(op,args)=>{assert.equal(op,'files.get');requests.push(structuredClone(args));if(args.offset===CHUNK&&failed++<2)throw failure();return {result:{size:bytes.length,offset:args.offset,data:bytes.subarray(args.offset,args.offset+CHUNK).toString('base64')}};};
 const result=await downloadResultFile(viaAPI(call,retry),{...options,via:'portal'},{transportFactory:()=>assert.fail('chosen Portal route stays Portal')});
 assert.equal(result.bytes,bytes.length);assert.deepEqual(await readFile(options.destination),bytes);assert.deepEqual(requests.map(row=>row.offset),[0,CHUNK,CHUNK,CHUNK]);assert.deepEqual(requests[1],requests[2]);assert.deepEqual(requests[2],requests[3]);assert.deepEqual(retry.delays,[1000,2000]);
});
for(const area of ['code','output'])for(const failure of [failures[0],failures[2]])test(`${area} campus chunk uses the existing retry loop without Portal fallback`,async t=>{
 const options=await fixture(t,area),retry=clock(),bytes=Buffer.alloc(CHUNK+7,72),offsets=[];let failed=0;
 const result=await downloadResultFile(()=>assert.fail('no Portal byte request'),{...options,via:'direct'},{retry,transportFactory:async(call,args)=>createPersonalFileTransport(call,{...args,
  initialGrant:{endpoint:'https://campus.invalid',grantId:key,ticket:'synthetic-local-ticket-value',certificateSha256:'a'.repeat(64),chunkBytes:CHUNK,expiresAt:Date.now()/1000+600,file:{size:bytes.length}},agentFactory:()=>({destroy:async()=>{}}),retry,
  send:async(grant,_agent,action,row)=>{assert.equal(grant.grantId,key);assert.equal(action,'get');offsets.push(row.offset);if(row.offset===CHUNK&&failed++<2)throw failure();return {size:bytes.length,offset:row.offset,data:bytes.subarray(row.offset,row.offset+CHUNK).toString('base64')};}})});
 assert.equal(result.bytes,bytes.length);assert.deepEqual(await readFile(options.destination),bytes);assert.deepEqual(offsets,[0,CHUNK,CHUNK,CHUNK]);assert.deepEqual(retry.delays,[1000,2000]);
});
for(const area of ['code','output'])test(`${area} browser Portal download retries the same chunk`,async()=>{
 const retry=clock(),requests=[],scope={machine:'fixture-node',area,project:'vision',runId:key};
 const blob=await readBrowserFile(async(op,args)=>{assert.equal(op,'files.get');requests.push(args);if(requests.length<3)throw failures[0]();return {size:3,offset:0,data:'YWJj'};},scope,'file',{route:{via:'portal'},retry});
 assert.equal(await blob.text(),'abc');assert.deepEqual(requests,[requests[0],requests[0],requests[0]]);assert.deepEqual(retry.delays,[1000,2000]);
});
for(const denied of [{status:403,code:'READ_UNAVAILABLE'},{status:400},{status:404},{code:'EACCES'},{code:'ENOENT'}])test(`permanent download error ${JSON.stringify(denied)} is sent once`,async t=>{
 const options=await fixture(t,'output'),retry=clock();let requests=0;
 const send=async()=>{requests++;throw Object.assign(Error('permission or path denied'),denied);};
 await assert.rejects(downloadResultFile(viaAPI(send,retry),{...options,via:'portal'}),error=>error.status===(denied.status||400));assert.equal(requests,1);assert.deepEqual(retry.delays,[]);
 requests=0;await assert.rejects(readBrowserFile(send,{area:'output'},'file',{route:{via:'portal'},retry}),denied);assert.equal(requests,1);assert.deepEqual(retry.delays,[]);
});
test('an exhausted Portal chunk reports its first cause after the existing minute budget',async t=>{
 const options=await fixture(t,'output'),retry=clock(),first=failures[0]();let requests=0;
 await assert.rejects(downloadResultFile(viaAPI(async()=>{requests++;throw requests===1?first:failures[2]();},retry),{...options,via:'portal'}),error=>error.status===400&&error.code==='READ_UNAVAILABLE');
 assert.equal(requests,7);assert.equal(retry.now(),60000);assert.deepEqual(retry.delays,[1000,2000,4000,8000,16000,16000,13000]);
});
