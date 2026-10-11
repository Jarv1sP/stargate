import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {uploadCodeFiles} from '../cli.mjs';
import {projectUploadTransport} from './helpers/project-upload-transport.mjs';

async function fixture(t,bytes=Buffer.alloc(1024*1024+7,65)){
 const dir=await mkdtemp(join(tmpdir(),'project-recovery-')),local=join(dir,'bundle');await writeFile(local,bytes);
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const calls=[],sleeps=[],grants=[],path='bundle.tar',sha256=createHash('sha256').update(bytes).digest('hex');let closed=0;
 t.after(()=>assert.equal(closed,grants.length,'every authorized test transport is closed'));
 const run=call=>uploadCodeFiles(async(op,args)=>{
  assert.equal(op,'files.upload.status','control requests never carry file bytes');
  calls.push({op,args,channel:'control'});return {result:await call(op,args)};
 },{machine:'gpu-1',context:{project:'alpha',area:'code'},local,remote:path,progress:()=>{},recoverySleep:async ms=>sleeps.push(ms),
  transportFactory:projectUploadTransport(async args=>{calls.push({op:'files.put',args,channel:'data'});return call('files.put',args);},
   {onAuthorize:request=>grants.push(request),onClose:()=>{closed++;}})});
 return {run,calls,sleeps,grants,path,sha256,totalSize:bytes.length,local,dir};
}
const absent=path=>({protocol:2,state:'ABSENT',complete:false,path,receivedBytes:0});
const complete=args=>({protocol:2,state:'COMPLETE',complete:true,...args,receivedBytes:args.totalSize,size:args.totalSize});
const receipt=args=>({complete:args.final,size:args.offset+Buffer.from(args.data,'base64').length,sha256:args.sha256});

test('lost middle ACK queries and resumes same ID without resending accepted bytes',async t=>{
 const f=await fixture(t);let active=null,received=0,failed=false;
 await f.run((op,args)=>{
  if(op==='files.upload.status')return active?{protocol:2,state:'UPLOADING',complete:false,...active,receivedBytes:received,resumable:true}:absent(f.path);
  active={path:args.path,uploadId:args.uploadId,totalSize:args.totalSize,sha256:args.sha256};received=args.offset+Buffer.from(args.data,'base64').length;
  if(!failed){failed=true;throw Object.assign(Error('lost ACK'),{status:502});}return receipt(args);
 });
 const puts=f.calls.filter(v=>v.op==='files.put');assert.equal(puts.length,2);assert.equal(puts[0].args.uploadId,puts[1].args.uploadId);
 assert.deepEqual(puts.map(v=>v.args.offset),[0,1024*1024]);assert.deepEqual(f.sleeps,[1000]);
 assert.ok(puts.every(value=>value.channel==='data'));
 assert.equal(f.grants.length,2);assert.deepEqual(f.grants[0],f.grants[1],'recovery reauthorizes the same immutable file scope');
});

test('lost final ACK is confirmed by status and never resends or publishes',async t=>{
 const f=await fixture(t,Buffer.from('one small complete file'));let done=null;
 const result=await f.run((op,args)=>{if(op==='files.upload.status')return done||absent(f.path);done=complete(args);throw Object.assign(Error('reset'),{status:502});});
 assert.equal(result.uploaded,1);assert.equal(f.calls.filter(v=>v.op==='files.put').length,1);assert.equal(f.calls.some(v=>v.op.startsWith('projects.')),false);
});

test('committed bytes with a pending completion journal finalize the same ID without reuploading',async t=>{
 for(const initiallyPending of [true,false]){
  const f=await fixture(t,Buffer.from('small'));let uploadId=randomUUID(),pending=initiallyPending;
  await f.run((op,args)=>{
   if(op==='files.upload.status')return pending?{...complete({path:f.path,totalSize:f.totalSize,sha256:f.sha256,uploadId}),completionPending:true}:absent(f.path);
   if(!pending){pending=true;uploadId=args.uploadId;assert.notEqual(args.data,'');throw Object.assign(Error('rename committed, receipt interrupted'),{status:502});}
   assert.equal(args.uploadId,initiallyPending?uploadId:f.calls.find(v=>v.op==='files.put').args.uploadId);
   assert.equal(args.offset,f.totalSize);assert.equal(args.data,'');assert.equal(args.final,true);
   return {...receipt(args),completionPending:false};
  });
  const puts=f.calls.filter(v=>v.op==='files.put');assert.equal(puts.length,initiallyPending?1:2);
  assert.equal(f.calls.some(v=>v.op.startsWith('projects.')),false);
 }
});

test('repeated invocation resumes the owned existing ID and offset',async t=>{
 const f=await fixture(t),uploadId=randomUUID();
 await f.run((op,args)=>op==='files.upload.status'?{protocol:2,state:'UPLOADING',complete:false,path:f.path,sha256:f.sha256,totalSize:f.totalSize,uploadId,receivedBytes:1024*1024,resumable:true}:receipt(args));
 const puts=f.calls.filter(v=>v.op==='files.put');assert.equal(puts.length,1);assert.equal(puts[0].args.uploadId,uploadId);assert.equal(puts[0].args.offset,1024*1024);
});

test('legacy or unproven staging is preserved without a replacement UUID/write',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.run(()=>({protocol:2,state:'UPLOADING',complete:false,path:f.path,sha256:f.sha256,totalSize:f.totalSize,uploadId:randomUUID(),receivedBytes:10,resumable:false,legacy:true})),/original ID and partial bytes were preserved/);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].op,'files.upload.status');
});

test('changed target after a lost ACK fails closed without a second write',async t=>{
 const f=await fixture(t);let failed=false;
 await assert.rejects(f.run((op,args)=>{if(op==='files.upload.status')return failed?{protocol:2,state:'CONFLICT',path:f.path,complete:false}:absent(f.path);failed=true;throw Object.assign(Error('reset'),{status:502});}),/not safely resumable/);
 assert.equal(f.calls.filter(v=>v.op==='files.put').length,1);
});

test('all bytes staged but final unconfirmed sends only a zero-byte final fence',async t=>{
 const f=await fixture(t,Buffer.from('small')),uploadId=randomUUID();
 await f.run((op,args)=>op==='files.upload.status'?{protocol:2,state:'UPLOADING',complete:false,path:f.path,sha256:f.sha256,totalSize:f.totalSize,uploadId,receivedBytes:f.totalSize,resumable:true}:receipt(args));
 const args=f.calls.find(v=>v.op==='files.put').args;assert.equal(args.offset,f.totalSize);assert.equal(args.data,'');assert.equal(args.final,true);
});

test('recovery is bounded and a source mutation or authorization error is never retried',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.run((op,args)=>{if(op==='files.upload.status')return absent(f.path);throw Object.assign(Error('down'),{status:503});}),/down/);
 assert.equal(f.calls.filter(v=>v.op==='files.put').length,11);
 assert.deepEqual(f.sleeps,[1000,2000,4000,8000,16000,16000,16000,16000,16000,16000]);
 assert.equal(f.grants.length,11);assert.ok(f.grants.every(value=>JSON.stringify(value)===JSON.stringify(f.grants[0])));
 const g=await fixture(t);await assert.rejects(g.run((op,args)=>{if(op==='files.upload.status')return absent(g.path);throw Object.assign(Error('forbidden'),{status:403});}),/forbidden/);
 assert.equal(g.sleeps.length,0);assert.equal(g.calls.filter(v=>v.op==='files.put').length,1);
 const h=await fixture(t);await assert.rejects(h.run(async(op,args)=>{if(op==='files.upload.status')return absent(h.path);await writeFile(h.local,'changed');throw Object.assign(Error('reset'),{status:502});}),/Local file changed/);
 assert.equal(h.calls.filter(v=>v.op==='files.put').length,1);
});

test('retired non-project uploads are rejected before any RPC or automatic retry',async t=>{
 const f=await fixture(t);let calls=0;
 await assert.rejects(uploadCodeFiles(async()=>{calls++;throw Object.assign(Error('reset'),{status:502});},{machine:'gpu-1',context:{},local:f.local,remote:f.path,progress:()=>{},recoverySleep:()=>{throw Error('must not sleep');}}),/Campus push requires a selected personal project/);
 assert.equal(calls,0);
});

test('CLI to real temporary native project recovers rename-without-receipt and unblocks publication',async t=>{
 const f=await fixture(t,Buffer.from('actual native commit fixture'));
 const child=spawn('python3',['-B',fileURLToPath(new URL('./project-upload-recovery.test.py',import.meta.url)),'--rpc-fixture'],{stdio:['pipe','pipe','pipe']});
 const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();let stderr='';child.stderr.on('data',value=>stderr+=value);
 const exited=new Promise(resolve=>child.on('close',code=>resolve(code)));
 t.after(()=>{child.stdin.end();child.kill();});
 const call=async(operation,args)=>{
  child.stdin.write(JSON.stringify({operation,args})+'\n');const next=await lines.next();
  assert.equal(next.done,false,stderr);const value=JSON.parse(next.value);
  if(value.error)throw Object.assign(Error(value.error),{status:value.status});return value.result;
 };
 await f.run(call);
 const proof=await call('fixture.assert-clean',{path:f.path});
 assert.deepEqual(proof,{unfinished:0,receipts:1,sha256:f.sha256,interrupted:true});
 const puts=f.calls.filter(value=>value.op==='files.put');assert.equal(puts.length,2);
 assert.equal(puts[0].args.uploadId,puts[1].args.uploadId);assert.equal(puts[1].args.data,'');assert.equal(puts[1].args.offset,f.totalSize);
 const published=await call('fixture.publish',{});
 assert.equal(published.state,'READY');assert.equal(published.publication.state,'READY');assert.equal(published.publication.release,published.release);
 child.stdin.end();assert.equal(await exited,0,stderr);
});
