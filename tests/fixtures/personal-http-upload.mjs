// Synthetic durable node receipts for the retained data.upload.* wire contract.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {uploadCodeFiles} from '../../cli.mjs';
export const originalKey='11111111-1111-4111-8111-111111111111';
export const networkChanged=()=>Object.assign(Error('physical route changed'),{code:'NETWORK_CHANGED'});
export async function personalHTTPFixture(t,{offset=0,bytes=Buffer.from('the same original content'),present=offset>0}={}){
 const root=await mkdtemp(join(tmpdir(),'personal-http-')),local=join(root,'payload');t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(local,bytes);
 const calls=[],messages=[];
 const f={root,local,bytes,calls,messages,present,state:'UPLOADING',stored:Buffer.from(bytes.subarray(0,offset)),onCall:null,executable:false};
 f.receipt=()=>({path:'payload',key:originalKey,totalSize:bytes.length,offset:f.stored.length,state:f.state,executable:f.executable});
 f.perform=(op,args)=>{
  assert.equal(args.machine,'fixture-node');assert.equal(args.project,'fixture-project');assert.equal(Object.hasOwn(args,'userId'),false);assert.equal(Object.hasOwn(args,'hostAdmin'),false);
  if(op==='data.upload.status'){assert.equal(args.path,'payload');return {result:f.present?f.receipt():{state:'ABSENT',path:'payload'}};}
  assert.equal(args.key,originalKey,'the original upload identity is never replaced');
  if(op==='data.upload.begin'){assert.equal(args.totalSize,bytes.length);assert.equal(args.path,'payload');f.present=true;return {result:f.receipt()};}
  if(op==='data.upload.chunk'){
   const chunk=Buffer.from(args.data,'base64');assert.equal(args.offset,f.stored.length);assert.ok(chunk.length<=512*1024);assert.deepEqual(chunk,bytes.subarray(args.offset,args.offset+chunk.length));f.stored=Buffer.concat([f.stored,chunk]);return {result:f.receipt()};
  }
  assert.equal(op,'data.upload.finish');assert.deepEqual(f.stored,bytes);assert.equal(typeof args.executable,'boolean');f.executable=args.executable;f.state='COMPLETE';return {result:f.receipt()};
 };
 f.call=async(op,args)=>{calls.push({operation:op,args:structuredClone(args)});return f.onCall?f.onCall(op,args):f.perform(op,args);};
 f.options={machine:'fixture-node',context:{project:'fixture-project',area:'code'},local,remote:'payload',key:originalKey,via:'relay',progress:message=>messages.push(message)};
 f.run=extra=>uploadCodeFiles(f.call,{...f.options,...extra});return f;
}
