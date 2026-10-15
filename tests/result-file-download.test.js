import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {downloadResultFile} from '../client-result-download.mjs';
const machine='fixture-node',context={area:'code',project:'vision'},owner='fixture-member';
async function fixture(t,bytes){const root=await mkdtemp(join(tmpdir(),'c3-file-download-'));t.after(()=>rm(root,{recursive:true,force:true}));return {bytes,root,options:{machine,context,path:'sample.bin',destination:join(root,'sample.bin'),origin:'https://fixture.test',userId:owner}};}
test('negotiated 16MiB campus downloads retain the byte bound and atomic publication',async t=>{
 const f=await fixture(t,Buffer.alloc(16*1024**2+3,71)),offsets=[];let closed=0;
 const value=await downloadResultFile(()=>assert.fail('no relay'),{...f.options,via:'direct'},{transportFactory:async(_call,args)=>{assert.equal(args.context.project,'vision');return {chunkBytes:16*1024**2,request:async({offset})=>{offsets.push(offset);return {size:f.bytes.length,offset,data:f.bytes.subarray(offset,offset+16*1024**2).toString('base64')};},close:async()=>closed++};}});
 assert.deepEqual(offsets,[0,16*1024**2]);assert.equal(value.bytes,f.bytes.length);assert.equal(closed,1);assert.deepEqual(await readFile(f.options.destination),f.bytes);
 await assert.rejects(lstat(f.options.destination+'.gpuctl-partial'),{code:'ENOENT'});
});
test('explicit HTTPS relay resumes the original workspace and exact partial offset',async t=>{
 const f=await fixture(t,Buffer.alloc(1024**2+37,123)),calls=[];let lost=true;
 const call=async(op,args)=>{assert.equal(op,'files.get');calls.push(args);if(lost&&args.offset===1024**2){lost=false;throw Error('connection interrupted');}return {result:{size:f.bytes.length,offset:args.offset,data:f.bytes.subarray(args.offset,args.offset+1024**2).toString('base64'),futureField:'ignored'}};};
 await assert.rejects(downloadResultFile(call,{...f.options,via:'portal'}),/interrupted/);await assert.rejects(lstat(f.options.destination),{code:'ENOENT'});
 const mark=calls.length;const value=await downloadResultFile(call,{...f.options,via:'portal'});assert.equal(value.resumed,true);assert.equal(calls[mark].offset,1024**2);assert.equal(calls[mark].project,'vision');assert.deepEqual(await readFile(f.options.destination),f.bytes);
});
test('authorization denial never falls back, retries bytes or creates a payload',async t=>{
 const f=await fixture(t,Buffer.from('private'));let calls=0;
 await assert.rejects(downloadResultFile(()=>assert.fail('no fallback'),{...f.options,via:'direct'},{transportFactory:async()=>{calls++;throw Object.assign(Error('请重新登录'),{status:403});}}),{status:403});
 assert.equal(calls,1);await assert.rejects(lstat(f.options.destination),{code:'ENOENT'});
});
test('workspace root directory download uses plain relative child paths and nested directories',async t=>{
 const f=await fixture(t,Buffer.from('abc')),calls=[];
 const call=async(op,args)=>{calls.push({op,args});assert.ok(!args.path.startsWith('./'));if(op==='files.list')return {result:{entries:args.path==='.'?[{name:'nested',type:'directory'}]:[{name:'sample.bin',type:'file',size:3}]}};assert.equal(op,'files.get');assert.equal(args.path,'nested/sample.bin');return {result:{size:3,offset:0,data:f.bytes.toString('base64')}};};
 const result=await downloadResultFile(call,{...f.options,path:'.',destination:join(f.root,'dataset'),directory:true,via:'portal'});assert.equal(result.files,1);assert.deepEqual(await readFile(join(f.root,'dataset/nested/sample.bin')),f.bytes);
});
test('an explicit Portal output download keeps the original job and route',async t=>{
 const f=await fixture(t,Buffer.from('output'));
 await downloadResultFile(async(op,args)=>{assert.equal(op,'files.get');assert.equal(args.runId,'11111111-1111-4111-8111-111111111111');return {result:{size:f.bytes.length,offset:args.offset,data:f.bytes.toString('base64')}};},{...f.options,via:'portal',context:{area:'output',project:'vision',runId:'11111111-1111-4111-8111-111111111111'}},{transportFactory:()=>assert.fail('explicit Portal does not use campus')});
 assert.deepEqual(await readFile(f.options.destination),f.bytes);
});
