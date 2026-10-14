import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {submitJobWithReceipt} from '../client-state.mjs';

const key='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const principal={userId:'owner',role:'member'},args={key,machine:'gpu-0',project:'sample',cards:1,argv:['echo','synthetic']};
const job={id,key,userId:principal.userId,machine:args.machine,cards:1,state:'PENDING',command:args.argv};

test('lost submit reply recovers the original owner-bound UUID with one write and one read',async()=>{
  const calls=[],error=Error('network reply lost'),before=structuredClone(args);
  const result=await submitJobWithReceipt(async(operation,value)=>{
    calls.push({operation,args:value});
    if(operation==='jobs.submit')throw error;
    assert.equal(operation,'state');assert.deepEqual(value,{});return {state:{jobs:[job]},principal};
  },args,principal);
  assert.equal(result.result.id,id);assert.equal(result.receiptRecovered,true);
  assert.deepEqual(calls.map(row=>row.operation),['jobs.submit','state']);assert.deepEqual(args,before);
});

test('authoritative refusals never recover or replay a submission',async()=>{
  for(const status of [400,401,403,409,429]){
    const error=Object.assign(Error('refused'),{status}),calls=[];
    await assert.rejects(submitJobWithReceipt(async operation=>{calls.push(operation);throw error;},args,principal),value=>value===error);
    assert.deepEqual(calls,['jobs.submit']);
  }
});

test('missing, ambiguous, wrong-owner or changed-account receipts preserve the original unconfirmed error',async()=>{
  for(const state of [{state:{jobs:[]},principal},
    {state:{jobs:[job,job]},principal},
    {state:{jobs:[{...job,userId:'other'}]},principal},
    {state:{jobs:[job]},principal:{userId:'other'}},
    {state:{jobs:[{...job,key:'different'}]},principal}]){
    const error=Error('original unconfirmed submission'),calls=[];
    await assert.rejects(submitJobWithReceipt(async operation=>{
      calls.push(operation);if(operation==='jobs.submit')throw error;return state;
    },args,principal),value=>value===error);
    assert.deepEqual(calls,['jobs.submit','state']);
  }
});

test('successful submission returns its existing receipt and performs no recovery read',async()=>{
  const response={result:job},calls=[];
  assert.equal(await submitJobWithReceipt(async operation=>{calls.push(operation);return response;},args,principal),response);
  assert.deepEqual(calls,['jobs.submit']);
});

test('source CLI returns the original UUID after a dropped response without submitting twice',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'submit-key-recovery-')),requests=[];
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const server=createServer(async(req,res)=>{
    let text='';for await(const part of req)text+=part;const call=JSON.parse(text);if(call.operation==='community.announcements.pending'){assert.deepEqual(call.args,{});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({result:{posts:[]}}));return;}requests.push(call);
    if(call.operation==='jobs.submit'){req.socket.destroy();return;}
    assert.equal(call.operation,'state');
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({state:{machines:[{id:'gpu-0',cards:8}],users:[],jobs:call.args.view==='summary'?[]:[job],
      demo:false,gpuqConnected:true,taskMetadata:{version:1}},principal}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const url='http://127.0.0.1:'+server.address().port,sessionFile=join(dir,'session.json');
  await writeFile(sessionFile,JSON.stringify({url,token:'local-fixture-token',principal,machine:'gpu-0'}));
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL('../cli.mjs',import.meta.url)),'--session-file',sessionFile,
      '--json','run','gpu-0','--project','sample','--key',key,'--','echo','synthetic'],{stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',part=>stdout+=part);child.stderr.on('data',part=>stderr+=part);
    child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));
  });
  assert.equal(result.code,0,result.stderr);assert.equal(JSON.parse(result.stdout).data.id,id);
  assert.match(result.stderr,/按原 key 找回已登记任务/);
  assert.equal(requests.filter(row=>row.operation==='jobs.submit').length,1);
  assert.equal(requests.filter(row=>row.operation==='state').length,1);
  assert.deepEqual(requests.find(row=>row.operation==='jobs.submit').args.argv,args.argv);
});
