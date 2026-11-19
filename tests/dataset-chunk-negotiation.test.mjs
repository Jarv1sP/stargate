import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {uploadLocalFile} from '../client-transfers.mjs';
import {uploadPersonalFile} from '../dist/personal-upload.js';
import {createPersonalFileTransport} from '../client-personal-file-campus.mjs';
import {campusNativePersonalFileRequest} from '../client-campus-native.mjs';

const SMALL=1024**2,LARGE=16*SMALL;
function peer(modern,size,key){
 let offset=0,storedChunk;const requests=[],sent=[];
 const grant=args=>{
  requests.push({...args});const requested=args.maxChunkBytes||SMALL;
  if(args.action==='put')storedChunk=modern?requested:(storedChunk||requested);
  const chunk=args.action==='put'?storedChunk:requested;
  return {available:true,grantId:args.action==='put'?key:randomUUID(),endpoint:'https://campus.example',certificateSha256:'a'.repeat(64),
   ticket:'fixture-ticket-for-negotiation',expiresAt:Date.now()/1000+300,chunkBytes:chunk,...(modern?{maxChunkBytes:chunk}:{}),file:{size}};
 };
 const call=async(operation,args)=>{
  if(operation==='files.direct-ticket')return {result:grant(args)};
  if(operation==='data.upload.begin'||operation==='data.upload.status')return {result:{key,state:'UPLOADING',offset,totalSize:size}};
  if(operation==='data.upload.finish'){assert.equal(offset,size);return {result:{key,state:'COMPLETE',offset,totalSize:size}};}
  assert.fail('direct upload must not send file bytes through Portal: '+operation);
 };
 const agent={async request(header,bytes){
  const bound=header.grant.chunkBytes;assert.ok(bound===SMALL||bound===LARGE);
  if(bound===LARGE)assert.equal(header.grant.maxChunkBytes,LARGE);
  if(header.op==='put'){
   assert.ok(bytes.length<=bound);assert.equal(header.offset,offset);sent.push(bytes.length);offset+=bytes.length;
   return {value:{result:{key,state:'UPLOADING',offset,totalSize:size}},raw:Buffer.alloc(0)};
  }
  const length=Math.min(bound,size-header.offset);sent.push(length);
  return {value:{metadata:{offset:header.offset,nextOffset:header.offset+length,size,totalSize:size,eof:header.offset+length===size}},raw:Buffer.alloc(length,7)};
 },async destroy(){}};
 return {call,grant,agent,requests,sent};
}

for(const modernClient of [false,true])for(const modernNode of [false,true]){
 test(`dataset upload client=${modernClient?'new':'old'} node=${modernNode?'new':'old'}`,async()=>{
  const size=2*LARGE+19,key=randomUUID(),server=peer(modernNode,size,key),context={area:'dataset',dataset:'shared'},base={machine:'node-a',...context,path:'sample.bin',action:'put',uploadId:key,totalSize:size};
  const initial=server.grant(base);let result;
  if(modernClient){
   const info={size:BigInt(size),dev:1n,ino:2n,mode:0o100600,isFile:()=>true,isSymbolicLink:()=>false};
   result=await uploadLocalFile(server.call,{machine:'node-a',context,path:'sample.bin',local:'fixture',key,via:'direct',route:{via:'direct',grant:initial},
    lstatFile:async()=>info,openFile:async()=>({stat:async()=>info,read:async(buffer,_offset,length)=>{buffer.fill(7);return {bytesRead:length};},close:async()=>{}}),
    transportFactory:(call,options)=>createPersonalFileTransport(call,{...options,agentFactory:()=>server.agent,send:campusNativePersonalFileRequest})});
  }else{
   // The released CLI used the same upload loop with 512 KiB reads and v1 grants.
   result=await uploadPersonalFile({call:async(operation,args)=>operation==='data.upload.chunk'
    ?campusNativePersonalFileRequest(initial,server.agent,'put',{offset:args.offset,bytes:Buffer.from(args.data,'base64'),final:false}): (await server.call(operation,args)).result,
    machine:'node-a',...context,path:'sample.bin',size,key,chunkBytes:512*1024,read:async(_offset,length)=>Buffer.alloc(length,7)});
  }
  assert.equal(result.state,'COMPLETE');assert.equal(result.offset,size);
  const expected=modernClient&&modernNode?LARGE:modernClient?SMALL:512*1024;
  assert.equal(server.sent[0],expected);assert.ok(server.sent.every(length=>length<=expected));
  assert.ok(server.requests.every(request=>request.uploadId===key));
 });
 test(`dataset download client=${modernClient?'new':'old'} node=${modernNode?'new':'old'}`,async()=>{
  const size=LARGE+31,key=randomUUID(),server=peer(modernNode,size,key),scope={machine:'node-a',area:'dataset',dataset:'shared',path:'sample.bin',action:'get'},initial=server.grant(scope);
  const transport=modernClient?await createPersonalFileTransport(server.call,{machine:'node-a',context:{area:'dataset',dataset:'shared'},path:'sample.bin',action:'get',initialGrant:initial,agentFactory:()=>server.agent,send:campusNativePersonalFileRequest}):null;
  let offset=0;
  while(offset<size){
   const result=transport?await transport.request({offset}):await campusNativePersonalFileRequest(initial,server.agent,'get',{offset});
   const bytes=Buffer.from(result.data,'base64');assert.ok(bytes.every(value=>value===7));offset+=bytes.length;
  }
  await transport?.close();assert.equal(offset,size);
  assert.equal(server.sent[0],modernClient&&modernNode?LARGE:SMALL);
  if(modernClient&&!modernNode)assert.equal(server.requests.at(-1).maxChunkBytes,SMALL);
 });
}
