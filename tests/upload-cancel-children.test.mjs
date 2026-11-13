import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
import {uploadTransfer,downloadTransfer} from '../client-transfers.mjs';
const machine=MACHINES[0].id;
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'upload-cancel-')),bootstrap=join(root,'bootstrap'),calls=[],uploads=new Map(),gates=[];
  await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Synthetic-Cancel-Fixture-Only!'}));
  let handler;
  const service=await PortalService.open(join(root,'db'),bootstrap,undefined,async(host,operation,args)=>{
    calls.push({host,operation,args});if(handler){const reply=await handler(operation,args);if(reply)return reply;}
    if(operation==='data.upload.begin'){uploads.set(args.key,'UPLOADING');return {state:'UPLOADING',offset:0,key:args.key};}
    if(operation==='data.upload.finish'){uploads.set(args.key,'COMPLETE');return {state:'COMPLETE',key:args.key};}
    if(operation==='data.upload.cancel'){if(uploads.get(args.key)!=='COMPLETE')uploads.set(args.key,'CANCELED');return {state:uploads.get(args.key),key:args.key};}
    throw Error('Unexpected synthetic operation '+operation);
  });clearInterval(service.executionTimer);service.reconciling=true;
  const token=service.issueSession({userId:'builtin-admin',username:'admin',role:'admin'});
  const call=async(operation,args={})=>(await service.invoke(token,operation,{machine,...args})).result;
  t.after(async()=>{for(const gate of gates)gate.resolve();await Promise.allSettled([...service.transferWrites.values()]);service.close();await rm(root,{recursive:true,force:true});});
  return {service,calls,uploads,call,handler:fn=>handler=fn,gate:()=>{const gate=deferred();gates.push(gate);return gate;},
    create:async()=>{const id=randomUUID();await call('transfers.create',{key:id,kind:'upload',reference:{dataset:'fixture'}});return id;},
    begin:(id,key)=>call('data.upload.begin',{transferId:id,key,dataset:'fixture',path:key,totalSize:1}),
    saved:id=>JSON.parse(service.db.prepare('SELECT data FROM directory_transfers WHERE id=?').get(id).data)};
}

test('cancel blocks new child registration while a completed child reply is in flight',async t=>{
  const f=await fixture(t),id=await f.create(),a=randomUUID(),b=randomUUID(),entered=f.gate(),release=f.gate();
  await f.begin(id,a);await f.call('data.upload.finish',{key:a,dataset:'fixture'});
  f.handler(async(op,args)=>{if(op==='data.upload.cancel'&&args.key===a){entered.resolve();await release.promise;}});
  const cancel=f.call('transfers.cancel',{id});await entered.promise;
  await assert.rejects(f.begin(id,b),e=>e.status===409);
  release.resolve();assert.equal((await cancel).state,'CANCELED');
  assert.deepEqual(f.saved(id).uploadKeys,[a]);assert.equal(f.uploads.has(b),false);assert.equal(f.uploads.get(a),'COMPLETE');
});

test('cancel waits for accepted child begins, ignores late completion, and coalesces duplicate cancellation',async t=>{
  const f=await fixture(t),id=await f.create(),a=randomUUID(),entered=f.gate(),release=f.gate();
  f.handler(async op=>{if(op==='data.upload.begin'){entered.resolve();await release.promise;}});
  const begin=f.begin(id,a);await entered.promise;
  const first=f.call('transfers.cancel',{id}),second=f.call('transfers.cancel',{id});await tick();
  assert.equal(f.calls.filter(c=>c.operation==='data.upload.cancel').length,0);
  assert.equal((await f.call('transfers.progress',{id,bytes:1,complete:true})).state,'CANCELING');
  release.resolve();await begin;assert.equal((await first).state,'CANCELED');assert.equal((await second).state,'CANCELED');
  assert.equal(f.uploads.get(a),'CANCELED');assert.deepEqual(f.saved(id).uploadKeys,[a]);
  assert.equal(f.calls.filter(c=>c.operation==='data.upload.cancel').length,1);
  assert.equal((await f.call('transfers.progress',{id,bytes:1,complete:true})).state,'CANCELED');
});

test('unrelated transfers are not blocked by one slow child begin',async t=>{
  const f=await fixture(t),a=await f.create(),b=await f.create(),key=randomUUID(),entered=f.gate(),release=f.gate();
  f.handler(async(op,args)=>{if(op==='data.upload.begin'&&args.key===key){entered.resolve();await release.promise;}});
  const slow=f.begin(a,key);await entered.promise;
  assert.equal((await f.begin(b,randomUUID())).state,'UPLOADING');release.resolve();await slow;
});

test('unknown cancellation keeps original children and remains resumable without accepting new begins',async t=>{
  const f=await fixture(t),id=await f.create(),key=randomUUID();await f.begin(id,key);
  f.handler(async op=>op==='data.upload.cancel'?{state:'UNKNOWN'}:undefined);
  assert.equal((await f.call('transfers.cancel',{id})).state,'UNKNOWN');assert.equal(f.saved(id).state,'CANCELING');
  assert.deepEqual(f.saved(id).uploadKeys,[key]);await assert.rejects(f.begin(id,randomUUID()),e=>e.status===409);
  // Only durable state is needed after the in-flight map is gone.
  assert.equal(f.service.transferWrites.size,0);f.handler(undefined);
  assert.equal((await f.call('transfers.resume',{id})).state,'CANCELED');assert.equal(f.uploads.get(key),'CANCELED');
});

for(const kind of ['upload','download'])test(kind+' client preserves parent cancellation returned at completion',async t=>{
  const root=await mkdtemp(join(tmpdir(),'canceled-client-')),id=randomUUID();t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'empty'));const call=async operation=>{
    if(operation==='transfers.create')return {result:{id,state:'WAITING_CLIENT'}};
    if(operation==='files.list')return {result:{entries:[],nextCursor:null,complete:true}};
    assert.equal(operation,'transfers.progress');return {result:{id,state:'CANCELED'}};
  };
  const result=kind==='upload'?await uploadTransfer(call,{machine,dataset:'fixture',directory:join(root,'empty'),key:id}):
    await downloadTransfer(call,{machine,dataset:'fixture',destination:join(root,'download'),key:id,origin:'https://fixture.invalid',userId:'fixture'});
  assert.equal(result.state,'CANCELED');assert.equal(result.transferId,id);
});
