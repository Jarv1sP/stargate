import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
const {uploadCodeFiles}=await import(process.env.STARGATE_CLIENT_UNDER_TEST||'../cli.mjs');

const CHUNK=1024*1024;
async function fixture(t,bytes=Buffer.alloc(CHUNK+7,65)){
  const dir=await mkdtemp(join(tmpdir(),'project-recovery-')),local=join(dir,'bundle');await writeFile(local,bytes);
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const calls=[],path='bundle.tar',sha256=createHash('sha256').update(bytes).digest('hex');
  const run=call=>uploadCodeFiles(async(op,args)=>{
    calls.push({op,args});assert.equal(args.machine,'gpu-1');assert.equal(args.project,'alpha');
    assert.equal('area' in args,false);assert.equal(op.startsWith('data.upload.'),true,op);
    return {result:await call(op,args)};
  },{machine:'gpu-1',context:{project:'alpha',area:'code'},local,remote:path,progress:()=>{}});
  return {run,calls,path,sha256,totalSize:bytes.length,local,dir,bytes};
}
const absent=path=>({state:'ABSENT',path,receivedBytes:0});
const original=(f,extra={})=>({key:randomUUID(),path:f.path,sha256:f.sha256,totalSize:f.totalSize,state:'UPLOADING',receivedBytes:0,...extra});
const chunks=f=>f.calls.filter(v=>v.op==='data.upload.chunk');
const writes=f=>f.calls.filter(v=>v.op!=='data.upload.status');

test('lost middle ACK stops; explicit repeat resumes original ID without resending accepted bytes',async t=>{
  const f=await fixture(t);let row,failed=false;
  const call=(op,args)=>{
    if(op==='data.upload.status')return row||absent(f.path);
    if(op==='data.upload.begin')row=original(f,{key:args.key});
    if(op==='data.upload.chunk'){
      assert.equal(args.key,row.key);assert.equal(args.offset,row.receivedBytes);
      row={...row,receivedBytes:args.offset+Buffer.from(args.data,'base64').length};
      if(!failed){failed=true;throw Object.assign(Error('lost ACK'),{status:502});}
    }
    if(op==='data.upload.finish'){assert.equal(args.key,row.key);row={...row,state:'COMPLETE'};}
    return row;
  };
  await assert.rejects(f.run(call),/lost ACK/);
  assert.deepEqual(f.calls.map(v=>v.op),['data.upload.status','data.upload.begin','data.upload.chunk']);
  const result=await f.run(call);
  assert.equal(result.uploaded,1);
  assert.deepEqual(chunks(f).map(v=>v.args.offset),[0,CHUNK]);
  assert.ok(writes(f).every(v=>v.args.key===row.key));
  assert.equal(f.calls.filter(v=>v.op==='data.upload.begin').length,1);
  assert.deepEqual(await readFile(f.local),f.bytes);
});

test('lost final ACK is confirmed by the next push with no replay or publication',async t=>{
  const f=await fixture(t,Buffer.from('one small complete file'));let row;
  const call=(op,args)=>{
    if(op==='data.upload.status')return row||absent(f.path);
    if(op==='data.upload.begin')row=original(f,{key:args.key});
    if(op==='data.upload.chunk')row={...row,receivedBytes:f.totalSize};
    if(op==='data.upload.finish'){row={...row,state:'COMPLETE'};throw Object.assign(Error('reset'),{status:502});}
    return row;
  };
  await assert.rejects(f.run(call),/reset/);const before=f.calls.length;
  assert.equal((await f.run(call)).uploaded,1);
  assert.deepEqual(f.calls.slice(before).map(v=>v.op),['data.upload.status']);
  assert.equal(chunks(f).length,1);
});

test('lost begin ACK preserves its allocated handle and repeated push does not allocate another',async t=>{
  const f=await fixture(t,Buffer.from('small'));let row;
  const call=(op,args)=>{
    if(op==='data.upload.status')return row||absent(f.path);
    if(op==='data.upload.begin'){row=original(f,{key:args.key});throw Object.assign(Error('begin receipt lost'),{status:504});}
    assert.equal(args.key,row.key);
    if(op==='data.upload.chunk')row={...row,receivedBytes:f.totalSize};
    if(op==='data.upload.finish')row={...row,state:'COMPLETE'};
    return row;
  };
  await assert.rejects(f.run(call),/begin receipt lost/);
  assert.equal(chunks(f).length,0);
  assert.equal((await f.run(call)).uploaded,1);
  assert.equal(f.calls.filter(v=>v.op==='data.upload.begin').length,1);
});

test('repeated invocation resumes the owned existing ID and exact offset',async t=>{
  const f=await fixture(t),row=original(f,{receivedBytes:CHUNK});
  await f.run((op,args)=>{
    if(op==='data.upload.status')return row;
    assert.equal(args.key,row.key);
    return {...row,receivedBytes:f.totalSize,state:op==='data.upload.finish'?'COMPLETE':'UPLOADING'};
  });
  assert.equal(chunks(f).length,1);assert.equal(chunks(f)[0].args.offset,CHUNK);
  assert.deepEqual(Buffer.from(chunks(f)[0].args.data,'base64'),f.bytes.subarray(CHUNK));
});

test('all bytes staged and empty files finish original IDs without file chunk replay',async t=>{
  for(const bytes of [Buffer.from('small'),Buffer.alloc(0)]){
    const f=await fixture(t,bytes),row=original(f,{receivedBytes:f.totalSize});
    await f.run((op,args)=>{
      if(op==='data.upload.status')return row;
      assert.equal(op,'data.upload.finish');assert.equal(args.key,row.key);return {...row,state:'COMPLETE'};
    });
    assert.deepEqual(f.calls.map(v=>v.op),['data.upload.status','data.upload.finish']);
  }
});

test('verification or commit in progress retains the original ID and uploads no more bytes',async t=>{
  for(const state of ['VERIFYING','COMMITTING']){
    const f=await fixture(t,Buffer.from('small')),row=original(f,{receivedBytes:f.totalSize,state});
    await f.run((op,args)=>{
      if(op==='data.upload.status')return row;
      assert.equal(op,'data.upload.finish');assert.equal(args.key,row.key);return {...row,state:'COMPLETE'};
    });
    assert.equal(chunks(f).length,0);assert.equal(writes(f).length,1);
  }
});

test('unknown, legacy, mismatched identity and invalid offsets never create a replacement or write bytes',async t=>{
  const f=await fixture(t);
  for(const extra of [{state:'UNKNOWN'},{state:'FAILED'},{key:undefined},{path:'other'},
    {sha256:'0'.repeat(64)},{totalSize:1},{receivedBytes:-1},{receivedBytes:f.totalSize+1},{receivedBytes:0.5}]){
    const before=f.calls.length;
    await assert.rejects(f.run(()=>original(f,extra)),/上传身份|原上传状态/);
    assert.deepEqual(f.calls.slice(before).map(v=>v.op),['data.upload.status']);
  }
  await assert.rejects(f.run(()=>({protocol:2,state:'UPLOADING',uploadId:randomUUID(),path:f.path,
    sha256:f.sha256,totalSize:f.totalSize,receivedBytes:10,resumable:false,legacy:true})),/上传身份/);
  assert.equal(writes(f).length,0);assert.deepEqual(await readFile(f.local),f.bytes);
});

test('permission refusal and unavailable status perform zero writes; unavailable mutations do not replay',async t=>{
  for(const status of [403,503]){
    const f=await fixture(t);
    await assert.rejects(f.run(()=>{throw Object.assign(Error('refused'),{status});}),e=>e.status===status);
    assert.equal(writes(f).length,0);
    const g=await fixture(t);
    await assert.rejects(g.run(op=>{if(op==='data.upload.status')return absent(g.path);throw Object.assign(Error('refused'),{status});}),e=>e.status===status);
    assert.deepEqual(g.calls.map(v=>v.op),['data.upload.status','data.upload.begin']);
  }
});

test('source edit after a confirmed chunk stops before another chunk or finish',async t=>{
  const f=await fixture(t),row=original(f);
  await assert.rejects(f.run(async(op,args)=>{
    if(op==='data.upload.status')return row;
    assert.equal(op,'data.upload.chunk');await writeFile(f.local,'changed');
    return {...row,receivedBytes:Buffer.from(args.data,'base64').length};
  }),/Local file changed/);
  assert.equal(chunks(f).length,1);assert.equal(f.calls.some(v=>v.op==='data.upload.finish'),false);
});

test('source edit after a lost ACK cannot be appended on repeated push',async t=>{
  const f=await fixture(t);let row=original(f);
  const call=async(op,args)=>{
    if(op==='data.upload.status')return row;
    assert.equal(op,'data.upload.chunk');row={...row,receivedBytes:Buffer.from(args.data,'base64').length};
    await writeFile(f.local,'changed');throw Object.assign(Error('reset'),{status:502});
  };
  await assert.rejects(f.run(call),/reset/);
  await assert.rejects(f.run(call),/上传身份/);
  assert.equal(chunks(f).length,1);
});

test('unconfirmed chunk identity or offset stops before finish',async t=>{
  for(const change of [{key:randomUUID()},{receivedBytes:1}]){
    const f=await fixture(t,Buffer.from('small')),row=original(f);
    await assert.rejects(f.run(op=>op==='data.upload.status'?row:{...row,receivedBytes:f.totalSize,...change}),/上传身份|上传偏移/);
    assert.deepEqual(f.calls.map(v=>v.op),['data.upload.status','data.upload.chunk']);
  }
});

test('workspaces require a project before any remote query or file write',async t=>{
  const f=await fixture(t);
  await assert.rejects(uploadCodeFiles(async()=>assert.fail('must not call'),{machine:'gpu-1',context:{},local:f.local,remote:f.path}),/请选择项目工作区/);
});

test('CLI to actual DataUploads resumes original handles and preserves externally edited destinations',async t=>{
  for(const fault of ['middle','finish','rename','target-edit']){
    const f=await fixture(t);
    const child=spawn('python3',['-B',fileURLToPath(new URL('./fixtures/workspace-upload-rpc.py',import.meta.url)),f.dir,fault],{stdio:['pipe','pipe','pipe']});
    const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();let stderr='';child.stderr.on('data',value=>stderr+=value);
    const exited=new Promise(resolve=>child.on('close',code=>resolve(code)));
    t.after(()=>{child.stdin.end();child.kill();});
    const call=async(operation,args)=>{
      child.stdin.write(JSON.stringify({operation,args})+'\n');const next=await lines.next();
      assert.equal(next.done,false,stderr);const value=JSON.parse(next.value);
      if(value.error)throw Object.assign(Error(value.error),{status:value.status});return value.result;
    };
    if(fault==='target-edit'){
      await assert.rejects(f.run(call),/Destination changed during upload/);
      const stopped=f.calls.length;
      await assert.rejects(f.run(call),/原上传状态为 FAILED/);
      assert.deepEqual(f.calls.slice(stopped).map(v=>v.op),['data.upload.status']);
      assert.deepEqual(await readFile(join(f.dir,'project','code',f.path)),Buffer.from('edited in terminal'));
      const begin=f.calls.find(v=>v.op==='data.upload.begin');
      assert.deepEqual(await readFile(join(f.dir,'project','uploads',begin.args.key+'.part')),f.bytes);
      child.stdin.end();assert.equal(await exited,0,stderr);continue;
    }
    await assert.rejects(f.run(call),/lost .* receipt/);
    const stopped=f.calls.length;
    assert.equal((await f.run(call)).uploaded,1);
    const proof=await call('fixture.proof',{path:f.path});
    assert.equal(proof.state,'COMPLETE');assert.equal(proof.sha256,f.sha256);assert.equal(proof.bytes,f.totalSize);
    assert.equal(proof.receivedBytes,f.totalSize);assert.equal(proof.unfinished,0);assert.equal(proof.verifierLaunches,1);
    assert.equal(proof.otherAccountState,'ABSENT');assert.equal(proof.otherAccountDenied,true);
    assert.equal(f.calls.filter(v=>v.op==='data.upload.begin').length,1);
    assert.ok(writes(f).every(v=>v.args.key===proof.key));
    assert.deepEqual(chunks(f).map(v=>v.args.offset),[0,CHUNK]);
    assert.deepEqual(f.calls.slice(stopped).map(v=>v.op),fault==='middle'
      ?['data.upload.status','data.upload.chunk','data.upload.finish']:['data.upload.status']);
    assert.deepEqual(await readFile(f.local),f.bytes);
    child.stdin.end();assert.equal(await exited,0,stderr);
  }
});
