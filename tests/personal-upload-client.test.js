import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {uploadPersonalFile} from '../dist/personal-upload.js';

test('resume skips acknowledged bytes, keeps the UUID, and waits for server checksum',async()=>{
  const key=randomUUID(),calls=[],reads=[],path='image.bin',sha256='a'.repeat(64),size=1024*1024+4;
  let row={key,path,sha256,totalSize:size,receivedBytes:1024*1024,state:'UPLOADING'};
  const result=await uploadPersonalFile({machine:'gpu-1',path,size,sha256,wait:async()=>{},
    read:async(offset,length)=>{reads.push(offset);return new Uint8Array(length);},
    call:async(operation,args)=>{
      calls.push({operation,args});
      if(operation==='data.upload.chunk'){assert.equal(args.key,key);row={...row,receivedBytes:size};}
      if(operation==='data.upload.finish')row={...row,state:'VERIFYING'};
      else if(row.state==='VERIFYING')row={...row,state:'COMPLETE'};
      return row;
    }});
  assert.equal(result.state,'COMPLETE');assert.equal(result.key,key);
  assert.deepEqual(reads,[1024*1024]);
  assert.deepEqual(calls.map(c=>c.operation),['data.upload.status','data.upload.chunk','data.upload.finish','data.upload.status']);
});

test('lost chunk reply stops without replacing the handle or retrying a write',async()=>{
  const key=randomUUID(),path='a',sha256='b'.repeat(64),calls=[];
  await assert.rejects(uploadPersonalFile({machine:'gpu-1',path,size:2,sha256,read:async()=>new Uint8Array(2),
    call:async(operation,args)=>{calls.push(operation);if(operation==='data.upload.chunk')throw Error('reply lost');return {key,path,sha256,totalSize:2,receivedBytes:0,state:'UPLOADING'};}}),/reply lost/);
  assert.deepEqual(calls,['data.upload.status','data.upload.chunk']);
});

test('changed content is not appended to an existing unfinished upload',async()=>{
  let reads=0;
  await assert.rejects(uploadPersonalFile({machine:'gpu-1',path:'a',size:2,sha256:'c'.repeat(64),
    read:async()=>{reads++;return new Uint8Array(2);},call:async()=>({key:randomUUID(),path:'a',sha256:'d'.repeat(64),totalSize:2,receivedBytes:1,state:'UPLOADING'})}),/身份/);
  assert.equal(reads,0);
});
