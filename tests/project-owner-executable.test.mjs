import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MACHINES} from '../dist/model.js';
const {uploadCodeFiles}=await import(process.env.OWNER_EXEC_TEST_CLI??'../cli.mjs');
const machine=MACHINES[0].id,key='11111111-1111-4111-8111-111111111111';
async function fixture(t,{executable=false,complete=false,verifyTree=false}={}){
 const root=await mkdtemp(join(tmpdir(),'owner-executable-')),source=join(root,'run.sh'),bytes=Buffer.from('#!/bin/sh\nexit 0\n');
 await writeFile(source,bytes);await chmod(source,executable?0o755:0o644);
 t.after(()=>rm(root,{recursive:true,force:true}));
 const calls=[];let row;
 const call=async(op,args)=>{
  calls.push({op,args});
  if(op==='data.upload.status')return {result:row??(complete?{path:'run.sh',key,totalSize:bytes.length,offset:bytes.length,state:'COMPLETE'}:{path:args.path,state:'ABSENT'})};
  if(op==='data.upload.begin')return {result:row={...args,key:args.key,offset:complete?bytes.length:0,state:complete?'COMPLETE':'UPLOADING',ownerExecutable:false}};
  assert.ok(row||complete);row??={path:'run.sh',key,totalSize:bytes.length,offset:bytes.length};
  if(op==='data.upload.chunk'){assert.equal(args.offset,0);assert.deepEqual(Buffer.from(args.data,'base64'),bytes);return {result:row={...row,offset:bytes.length}};}
  assert.equal(op,'data.upload.finish');assert.equal(args.key,row.key);
  return {result:row={...row,state:'COMPLETE',executable:args.executable}};
 };
 return {calls,run:()=>uploadCodeFiles(call,{machine,context:{project:'paper',area:'code'},local:verifyTree?root:source,remote:verifyTree?'.':'run.sh',via:'relay',key:complete?key:undefined,progress:()=>{}})};
}
for(const verifyTree of [false,true])test(`project ${verifyTree?'tree upload':'push'} preserves only owner executable intent at final commit`,async t=>{
 for(const executable of process.platform==='win32'?[false]:[false,true]){
  const f=await fixture(t,{executable,verifyTree}),result=await f.run();assert.equal(result.uploaded,1);
  const finish=f.calls.find(c=>c.op==='data.upload.finish');assert.equal(finish.args.executable,executable);
  assert.ok(f.calls.filter(c=>c.op!=='data.upload.finish').every(c=>!Object.hasOwn(c.args,'executable')));
  assert.ok(f.calls.every(c=>!Object.hasOwn(c.args,'mode')));
 }
});
test('unchanged POSIX executable bytes repair their owner execute bit using the original upload key, without reuploading',{skip:process.platform==='win32'?'Windows file stats do not expose a POSIX owner execute bit':false},async t=>{
 const f=await fixture(t,{executable:true,complete:true});await f.run();
 assert.deepEqual(f.calls.map(c=>c.op),['data.upload.begin','data.upload.finish']);
 assert.deepEqual(f.calls[1].args,{machine,area:'code',project:'paper',path:'run.sh',key,executable:true});
});
