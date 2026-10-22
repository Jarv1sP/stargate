import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {downloadJobLog} from '../client-job-log-download.mjs';

const jobId='11111111-1111-4111-8111-111111111111',attempt='A'+'1'.repeat(32);
async function fixture(t,content=Buffer.alloc(1024**2+79,55)){
 const dir=await mkdtemp(join(tmpdir(),'job-log-download-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const options={jobId,destination:join(dir,'job.log'),origin:'https://fixture.test',userId:'reader'},calls=[];
 let latest=attempt,stopped=false;
 const call=async(op,args)=>{
  assert.equal(op,'jobs.logs');assert.equal(args.jobId,jobId);assert.equal(args.download,true);calls.push({...args});
  if(args.offset===undefined)return {result:{attemptId:latest}};
  assert.equal(args.attemptId,attempt);
  if(stopped&&args.offset)throw Error('fixture interrupted');
  return {result:{size:content.length,offset:args.offset,data:content.subarray(args.offset,args.offset+1024**2).toString('base64')}};
 };
 return {call,calls,content,options,stop:value=>{stopped=value;},latest:value=>{latest=value;}};
}

test('complete job log uses bounded file reads and saves all bytes',async t=>{
 const f=await fixture(t),value=await downloadJobLog(f.call,f.options);
 assert.equal(value.bytes,f.content.length);assert.deepEqual(await readFile(f.options.destination),f.content);
 assert.deepEqual(f.calls.filter(r=>r.offset!==undefined).map(r=>r.offset),[0,1024**2]);
 await assert.rejects(lstat(f.options.destination+'.gpuctl-download.json'),{code:'ENOENT'});
});
test('log resume uses the saved attempt and offset after the job has a newer run',async t=>{
 const f=await fixture(t);f.stop(true);
 await assert.rejects(downloadJobLog(f.call,f.options),/fixture interrupted/);
 await assert.rejects(lstat(f.options.destination),{code:'ENOENT'});
 assert.equal((await lstat(f.options.destination+'.gpuctl-partial')).size,1024**2);
 const saved=JSON.parse(await readFile(f.options.destination+'.gpuctl-download.json','utf8'));
 assert.equal(saved.identity.path,attempt);assert.equal(saved.identity.runId,jobId);
 f.stop(false);f.latest('A'+'2'.repeat(32));f.calls.length=0;
 const value=await downloadJobLog(f.call,f.options);assert.equal(value.resumed,true);
 assert.equal(f.calls[1].attemptId,attempt);assert.equal(f.calls[1].offset,1024**2);
 assert.deepEqual(await readFile(f.options.destination),f.content);
});
test('empty recorded logs succeed but an unknown job log never becomes an empty success',async t=>{
 const f=await fixture(t,Buffer.alloc(0));assert.equal((await downloadJobLog(f.call,f.options)).bytes,0);
 await assert.rejects(downloadJobLog(async()=>({result:{state:'UNKNOWN'}}),{...f.options,destination:f.options.destination+'.unknown'}),/日志暂不可用/);
 await assert.rejects(lstat(f.options.destination+'.unknown'),{code:'ENOENT'});
});
test('a growing log pauses without publishing a final file',async t=>{
 const f=await fixture(t);
 await assert.rejects(downloadJobLog(async(op,args)=>{
  const value=await f.call(op,args);if(args.offset)value.result.size++;return value;
 },f.options),/size changed/);
 await assert.rejects(lstat(f.options.destination),{code:'ENOENT'});
 assert.equal((await lstat(f.options.destination+'.gpuctl-partial')).size,1024**2);
});
test('revoked login is propagated without claiming the remaining bytes were saved',async t=>{
 const f=await fixture(t);
 await assert.rejects(downloadJobLog(async(op,args)=>{
  if(args.offset)throw Object.assign(Error('login revoked'),{status:401});return f.call(op,args);
 },f.options),{status:401});
 await assert.rejects(lstat(f.options.destination),{code:'ENOENT'});
 assert.equal((await lstat(f.options.destination+'.gpuctl-partial')).size,1024**2);
});
