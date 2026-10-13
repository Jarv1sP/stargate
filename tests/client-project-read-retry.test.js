import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {apiPost} from '../client-http.mjs';
const {uploadCodeFiles}=await import(process.env.STARGATE_CLIENT_UNDER_TEST||'../cli.mjs');

const origin='https://portal.example';
const busy='[Errno 11] Resource temporarily unavailable';
const upload={operation:'files.upload.status',args:{machine:'node-a',project:'paper',path:'train.py',uploadId:'11111111-1111-4111-8111-111111111111',totalSize:12,sha256:'a'.repeat(64)}};
const failure=(status=400,message=busy)=>new Response(JSON.stringify({error:message}),{status});

test('short EAGAIN queries the same original upload, without sending a write',async()=>{
  const requests=[],delays=[];
  const result=await apiPost(origin,'call',upload,{token:'fixture-user-a',sleep:async ms=>delays.push(ms),fetchImpl:async(url,options)=>{
    requests.push({url:String(url),body:options.body,authorization:options.headers.Authorization});
    return requests.length===1?failure():new Response(JSON.stringify({result:{protocol:2,state:'UPLOADING',uploadId:upload.args.uploadId,receivedBytes:8}}));
  }});
  assert.equal(result.result.uploadId,upload.args.uploadId);
  assert.equal(result.result.receivedBytes,8);
  assert.deepEqual(delays,[100]);
  assert.equal(requests.length,2);
  assert.ok(requests.every(request=>request.body===JSON.stringify(upload)&&request.authorization==='Bearer fixture-user-a'&&request.url===origin+'/api/call'));
});

test('project status lock retry preserves the frozen project scope',async()=>{
  const body={operation:'projects.status',args:{machine:'node-a',project:'paper'}},original=JSON.stringify(body),requests=[];
  const result=await apiPost(origin,'call',body,{sleep:async()=>{body.args.project='another';},fetchImpl:async(url,options)=>{
    requests.push(options.body);
    return requests.length===1?failure():new Response('{"result":{"project":"paper","state":"FAILED"}}');
  }});
  assert.equal(result.result.project,'paper');
  assert.equal(result.result.state,'FAILED');
  assert.deepEqual(requests,[original,original]);
});

test('persistent EAGAIN stops after two seconds of bounded backoff and retains the refusal',async()=>{
  let count=0;const delays=[];
  await assert.rejects(apiPost(origin,'call',upload,{sleep:async ms=>delays.push(ms),fetchImpl:async()=>{count++;return failure();}}),error=>error.status===400&&error.message.includes(busy));
  assert.equal(count,6);
  assert.deepEqual(delays,[100,200,400,800,500]);
  assert.equal(delays.reduce((sum,ms)=>sum+ms,0),2000);
});

test('caller cancellation during project lock backoff makes no further query',async()=>{
  const controller=new AbortController();let count=0;
  await assert.rejects(apiPost(origin,'call',upload,{signal:controller.signal,fetchImpl:async()=>{count++;return failure();},sleep:async(ms,signal)=>{
    controller.abort(new Error('user stopped'));signal.throwIfAborted();
  }}),/user stopped/);
  assert.equal(count,1);
});

test('EAGAIN never replays upload, publish, terminal or login mutations',async()=>{
  for(const operation of ['data.upload.begin','data.upload.chunk','data.upload.finish','files.put','files.upload.cancel','projects.publish','projects.create','projects.local-import.begin','terminal.open','terminal.exchange','jobs.submit','datasets.unregister','login']){
    let count=0;
    await assert.rejects(apiPost(origin,'call',{operation,args:upload.args},{fetchImpl:async()=>{count++;return failure();},sleep:async()=>assert.fail('mutation must not retry')}),error=>error.status===400&&error.message.includes(busy));
    assert.equal(count,1,operation);
  }
});

test('permission errors, other native errors and incomplete responses never become a lock retry',async()=>{
  for(const [status,message] of [[401,busy],[403,busy],[404,busy],[409,busy],[400,'[Errno 13] Permission denied'],[400,'[Errno 5] Input/output error'],[400,'project not found'],[400,'EAGAIN'],[400,'Resource temporarily unavailable']]){
    let count=0;
    await assert.rejects(apiPost(origin,'call',upload,{fetchImpl:async()=>{count++;return failure(status,message);},sleep:async()=>assert.fail('not a confirmed native EAGAIN')}),error=>error.status===status);
    assert.equal(count,1,message);
  }
  for(const body of ['<html>'+busy+'</html>',JSON.stringify({message:busy}),JSON.stringify([busy])]){
    let count=0;
    await assert.rejects(apiPost(origin,'call',upload,{fetchImpl:async()=>{count++;return new Response(body,{status:400});},sleep:async()=>assert.fail('incomplete response must not retry')}),error=>error.status===400);
    assert.equal(count,1);
  }
});

test('EAGAIN does not broaden the generic read allowlist',async()=>{
  for(const operation of ['files.get','files.list','projects.list','projects.quota','state','unknown.operation']){
    let count=0;
    await assert.rejects(apiPost(origin,'call',{operation,args:upload.args},{fetchImpl:async()=>{count++;return failure();},sleep:async()=>assert.fail('outside the two scoped status queries')}),error=>error.status===400);
    assert.equal(count,1,operation);
  }
});

test('existing gateway retry still returns only the authoritative status and freezes its body',async()=>{
  const requests=[],delays=[],body=structuredClone(upload),original=JSON.stringify(body);
  const result=await apiPost(origin,'call',body,{sleep:async ms=>{delays.push(ms);body.args.uploadId='22222222-2222-4222-8222-222222222222';},fetchImpl:async(url,options)=>{
    requests.push(options.body);return requests.length===1?failure(503,'bridge unavailable'):new Response('{"result":{"state":"UNKNOWN"}}');
  }});
  assert.equal(result.result.state,'UNKNOWN');
  assert.deepEqual(requests,[original,original]);
  assert.deepEqual(delays,[500]);
});

async function localCode(t){
  const folder=await mkdtemp(join(tmpdir(),'stargate-project-read-'));
  t.after(()=>rm(folder,{recursive:true,force:true}));
  const local=join(folder,'train.py'),bytes=Buffer.from('abcd');
  await writeFile(local,bytes);
  return {local,bytes,sha256:createHash('sha256').update(bytes).digest('hex')};
}

// Persistent workspaces use data.upload.*, not the historical files.put protocol.
// Ambiguous writes stop; a later explicit push observes the original handle.
test('actual CLI resumes the discovered workspace upload after gateway retry at the confirmed offset',async t=>{
  const code=await localCode(t),queries=[],writes=[];
  let row={path:'train.py',key:upload.args.uploadId,state:'UPLOADING',totalSize:4,sha256:code.sha256,receivedBytes:2};
  const call=(operation,args)=>apiPost(origin,'call',{operation,args},{token:'fixture-user-a',sleep:async()=>{},fetchImpl:async(url,options)=>{
    const request=JSON.parse(options.body);
    assert.equal(request.args.machine,'node-a');assert.equal(request.args.project,'paper');
    if(request.operation==='data.upload.chunk'){
      assert.equal(request.args.key,upload.args.uploadId);
      writes.push({...request.args,bytes:Buffer.from(request.args.data,'base64')});
      row={...row,receivedBytes:4};
    }else if(request.operation==='data.upload.finish'){
      assert.equal(request.args.key,upload.args.uploadId);row={...row,state:'COMPLETE'};
    }else{
      assert.equal(request.operation,'data.upload.status');assert.equal(request.args.path,'train.py');queries.push(request);
      if(queries.length===1)return failure(503,'bridge unavailable');
    }
    return new Response(JSON.stringify({result:row}));
  }});
  const result=await uploadCodeFiles(call,{machine:'node-a',context:{project:'paper',area:'code'},local:code.local,remote:'train.py',progress:()=>{}});
  assert.equal(result.uploaded,1);
  assert.deepEqual(queries[0],queries[1]);
  assert.equal(writes.length,1);
  assert.equal(writes[0].offset,2);
  assert.equal(writes[0].bytes.toString(),'cd');
  assert.deepEqual(await readFile(code.local),code.bytes);
});

test('actual CLI keeps the source and performs zero writes when its workspace query is refused',async t=>{
  const code=await localCode(t);let count=0;
  const call=(operation,args)=>apiPost(origin,'call',{operation,args},{sleep:async()=>assert.fail('data uploads do not use the old project-lock retry'),fetchImpl:async(url,options)=>{assert.equal(JSON.parse(options.body).operation,'data.upload.status','unknown status must not send file bytes');count++;return failure();}});
  await assert.rejects(uploadCodeFiles(call,{machine:'node-a',context:{project:'paper',area:'code'},local:code.local,remote:'train.py',progress:()=>{}}),error=>error.status===400&&error.message.includes(busy));
  assert.equal(count,1);
  assert.deepEqual(await readFile(code.local),code.bytes);
});

test('actual CLI repeat after lost finish ACK confirms completion without replaying bytes',async t=>{
  const code=await localCode(t),queries=[],operations=[];let row;
  const call=(operation,args)=>apiPost(origin,'call',{operation,args},{sleep:async()=>{},fetchImpl:async(url,options)=>{
    const request=JSON.parse(options.body);operations.push(request.operation);
    assert.equal(request.args.machine,'node-a');assert.equal(request.args.project,'paper');
    if(request.operation==='data.upload.begin'){
      assert.equal(request.args.path,'train.py');assert.equal(request.args.totalSize,4);assert.equal(request.args.sha256,code.sha256);
      row={...request.args,state:'UPLOADING',receivedBytes:0};
    }else if(request.operation==='data.upload.chunk'){
      assert.equal(request.args.key,row.key);assert.equal(request.args.offset,0);
      assert.deepEqual(Buffer.from(request.args.data,'base64'),code.bytes);row={...row,receivedBytes:4};
    }else if(request.operation==='data.upload.finish'){
      assert.equal(request.args.key,row.key);row={...row,state:'COMPLETE'};throw new TypeError('final ACK lost');
    }else{
      assert.equal(request.operation,'data.upload.status');queries.push(request);
      if(queries.length===1)return new Response('{"result":{"path":"train.py","state":"ABSENT","receivedBytes":0}}');
      if(queries.length===2)return failure(503,'bridge unavailable');
    }
    return new Response(JSON.stringify({result:row}));
  }});
  const options={machine:'node-a',context:{project:'paper',area:'code'},local:code.local,remote:'train.py',progress:()=>{}};
  await assert.rejects(uploadCodeFiles(call,options),/操作结果尚未确认/);
  assert.deepEqual(operations,['data.upload.status','data.upload.begin','data.upload.chunk','data.upload.finish']);
  const result=await uploadCodeFiles(call,options);
  assert.equal(result.uploaded,1);
  assert.equal(operations.filter(op=>op==='data.upload.chunk').length,1);
  assert.equal(operations.filter(op=>op==='data.upload.finish').length,1);
  assert.equal(queries.length,3);
  assert.deepEqual(queries[1],queries[2]);
  assert.deepEqual(await readFile(code.local),code.bytes);
});
