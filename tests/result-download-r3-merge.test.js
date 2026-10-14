import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {apiPost} from '../client-http.mjs';
import {downloadResultFile} from '../client-result-download.mjs';

test('live result download keeps its authorized scope through one transient read retry',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'e2e-result-r3-'));
 const bytes=Buffer.from('owned result'),requests=[];
 const scope={machine:'fixture-node',path:'result.txt',context:{area:'output',project:'fixture-project',runId:'fixture-job'},origin:'https://portal.example.test',userId:'fixture-owner'};
 try{
  const value=await downloadResultFile((operation,args)=>apiPost(scope.origin,'call',{operation,args},{token:'fixture-token',sleep:async()=>{},fetchImpl:async(url,options)=>{
   requests.push(JSON.parse(options.body));
   if(requests.length===1)return new Response(JSON.stringify({error:'temporarily busy'}),{status:503});
   return new Response(JSON.stringify({result:{protocol:2,fingerprint:'a'.repeat(64),path:scope.path,offset:0,size:bytes.length,eof:true,data:bytes.toString('base64')}}));
  }}),{...scope,via:'portal',destination:join(directory,'result.txt')});
  assert.equal(value.bytes,bytes.length);
  assert.deepEqual(await readFile(join(directory,'result.txt')),bytes);
  assert.equal(requests.length,2);
  assert.deepEqual(requests[0],requests[1]);
  assert.equal(requests[0].operation,'files.get');
  assert.equal(requests[0].args.runId,scope.context.runId);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('result download authorization denial never retries or falls back to a legacy file operation',async()=>{
 let requests=0;
 await assert.rejects(downloadResultFile((operation,args)=>{
  assert.equal(operation,'files.get');
  return apiPost('https://portal.example.test','call',{operation,args},{token:'fixture-token',fetchImpl:async()=>{
   requests++;return new Response(JSON.stringify({error:'Forbidden'}),{status:403});
  }});
 },{machine:'fixture-node',path:'result.txt',context:{area:'output',project:'fixture-project',runId:'fixture-job'},via:'portal',destination:join(tmpdir(),'never-written-result-r3')}),{status:403});
 assert.equal(requests,1);
});
