import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {MAX_ARGV_BYTES,assertArgv} from '../portal-request-validation.mjs';
import {normalizeJobSubmission} from '../job-submission.mjs';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';

const machine=MACHINES[0].id,password='Only-Argv-Fixture-2026!';
const request=argv=>({machine,project:'sample',cards:1,argv,key:randomUUID()});
const oversized=error=>error.status===400&&/把长代码写进工作区文件再用脚本路径运行/.test(error.message);

test('argv counts UTF-8 bytes across arguments: 1MiB accepted, 1MiB+1 refused, with no count cap',()=>{
  assert.equal(MAX_ARGV_BYTES,1048576);
  const boundaries=[['x'.repeat(MAX_ARGV_BYTES)],['中'.repeat(Math.floor(MAX_ARGV_BYTES/3))+'x'],Array(1024).fill('x'.repeat(1024))];
  for(const argv of boundaries){
    assert.equal(argv.reduce((n,arg)=>n+Buffer.byteLength(arg),0),MAX_ARGV_BYTES);
    assert.deepEqual(normalizeJobSubmission(request(argv),{role:'member'}).argv,argv);
    assert.doesNotThrow(()=>assertArgv(argv,{requireCommand:true}));
    assert.throws(()=>normalizeJobSubmission(request([...argv,'x']),{role:'member'}),oversized);
    assert.throws(()=>assertArgv([...argv,'x'],{requireCommand:true}),oversized);
  }
});

test('argv validation stops immediately after the byte limit without reading later arguments',()=>{
  const argv=['x'.repeat(MAX_ARGV_BYTES+1)];
  Object.defineProperty(argv,1,{get:()=>assert.fail('later argument must not be read after overflow')});
  assert.throws(()=>normalizeJobSubmission(request(argv),{role:'member'}),oversized);
  assert.throws(()=>assertArgv(argv,{requireCommand:true}),oversized);
});

test('job API rejects over-limit argv before registration, audit or node dispatch',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'argv-api-')),bootstrap=join(directory,'bootstrap'),status=join(directory,'status');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,gpus:[],gpuq:{connected:true,jobs:[]},hostCommand:{version:1,available:true}}))}));
  const calls=[];
  const service=await PortalService.open(join(directory,'db'),bootstrap,status,async(m,operation,args)=>{
    calls.push({m,operation,args});
    if(operation==='projects.workspace')return {project:args.project,state:'AVAILABLE',workspace:{persistent:true}};
    assert.equal(operation,'host.exec');return {id:args.key,state:'RUNNING'};
  },undefined,undefined,[],undefined,['builtin-admin']);
  for(const key of ['executionTimer','notificationTimer','maintenanceTimer','transferTimer','storageArchiveTimer','projectCopyTimer'])clearInterval(service[key]);
  service.reconciling=true;
  t.after(async()=>{service.close();await rm(directory,{recursive:true,force:true});});
  const admin=await service.login('admin',password),argv=['x'.repeat(MAX_ARGV_BYTES+1)];
  await assert.rejects(service.invoke(admin.token,'jobs.submit',request(argv)),oversized);
  assert.equal(service.store.jobs.length,0);assert.equal(calls.length,0);
  const accepted=['x'.repeat(MAX_ARGV_BYTES)];
  const job=(await service.invoke(admin.token,'jobs.submit',request(accepted))).result;
  assert.equal(service.store.jobs.length,1);assert.equal(service.store.jobs[0].id,job.id);
  assert.equal(calls.some(row=>row.operation==='sync'),false);
});
