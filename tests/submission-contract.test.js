import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,symlink,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {parseCLIOptions} from '../cli.mjs';
import {normalizeJobSubmission,createSubmittedJob} from '../job-submission.mjs';
import {MACHINES} from '../dist/model.js';
import {buildClient} from '../scripts/build-client.mjs';

test('one CLI option registry handles old/new flags, aliases, repetition and literal training argv',()=>{
  const result=parseCLIOptions(['run','-g','2','--rank','P1','--yield','save','--checkpointable','--machine','gpu-1','--machine','gpu-2','--data','a','--data','b','--','python','train.py','--rank','99','-g','9']);
  assert.deepEqual(result.positionals,['run']);assert.equal(result.options.cards,'2');assert.equal(result.options.checkpointable,true);
  assert.deepEqual(result.options.machines,['gpu-1','gpu-2']);assert.deepEqual(result.options.datasets,['a','b']);
  assert.deepEqual(result.training,['python','train.py','--rank','99','-g','9']);
  assert.deepEqual(parseCLIOptions(['jobs']).options,{machines:[],datasets:[]});
  for(const args of [['-g','1','--cards','2'],['--rank','P1','--rank','P2'],['--checkpointable','--checkpointable'],['--rank'],['--rank','--json'],['--unknown']])assert.throws(()=>parseCLIOptions(args));
});

test('maintenance shares the CLI registry without losing approval fields or duplicate checks',()=>{
  const request=parseCLIOptions(['maintenance','request','--name','Review','--reason','Needs approval','--script-file','request.sh','--parent','parent-id','--cwd','/root','--timeout','60']);
  assert.deepEqual(request.positionals,['maintenance','request']);
  assert.deepEqual(request.options,{machines:[],datasets:[],name:'Review',reason:'Needs approval','script-file':'request.sh',parent:'parent-id',cwd:'/root',timeout:'60'});
  const approval=parseCLIOptions(['maintenance','approve','request-id','--revision','1','--preview-token','frozen-token','--ack-unknown']);
  assert.equal(approval.options.revision,'1');assert.equal(approval.options['preview-token'],'frozen-token');assert.equal(approval.options['ack-unknown'],true);
  assert.equal(parseCLIOptions(['maintenance','list','--cursor','20','--limit','5']).options.limit,'5');
  for(const args of [['--reason','one','--reason','two'],['--ack-unknown','--ack-unknown'],['--preview-token'],['--revision','--json']])assert.throws(()=>parseCLIOptions(args));
  assert.deepEqual(parseCLIOptions(['run','--','python','--reason','literal','--ack-unknown']).training,['python','--reason','literal','--ack-unknown']);
});

test('standalone CLI entry point still runs through the installed symlink',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-cli-entry-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await buildClient({outfile:join(dir,'client.mjs')});await symlink(join(dir,'client.mjs'),join(dir,'gpuctl'));
  const result=spawnSync(process.execPath,[join(dir,'gpuctl'),'--help'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/GPUQ/);
});

test('one submission normalizer preserves persisted legacy digest layouts',()=>{
  const base={machine:MACHINES[0].id,cards:2,argv:['python','train.py'],key:randomUUID()},principal={role:'admin'};
  const cases=[{}, {priority:'idle'}, {project:'vision',release:'a'.repeat(64)}, {datasets:[{dataset:'coco',version:'b'.repeat(64)}]}, {scheduling:{rank:'P1',yieldPolicy:'save',restartPolicy:'on-preempt',checkpointable:true}}];
  for(const extra of cases){
    const request=normalizeJobSubmission({...base,...extra},principal),identity=[base.machine,2,0,base.argv,'train'];
    if(extra.datasets)identity.push(extra.datasets);if(extra.project)identity.push({project:extra.project,release:extra.release});
    if(extra.priority)identity.push({priority:extra.priority});if(extra.scheduling)identity.push({scheduling:extra.scheduling});
    assert.equal(request.digest,createHash('sha256').update(JSON.stringify(identity)).digest('hex'));
  }
  const inherited=Object.assign(Object.create({machine:base.machine}),{cards:base.cards,argv:base.argv,key:base.key});
  assert.throws(()=>normalizeJobSubmission(inherited,principal));
});

test('a project without a release runs its live workspace and never silently moves nodes',()=>{
  const args={machine:MACHINES[0].id,project:'vision',cards:1,argv:['python','test.py'],key:randomUUID()};
  const request=normalizeJobSubmission(args,{role:'member'});
  assert.deepEqual(request.project,{project:'vision',workspace:true});
  const job=createSubmittedJob(request,{id:'demo-user-1',username:'alice'},true);
  assert.equal(job.spec.workspace,true);assert.equal(Object.hasOwn(job.spec,'release'),false);
  assert.throws(()=>normalizeJobSubmission({...args,machine:'auto'},{role:'member'}),/跨机/);
  assert.throws(()=>normalizeJobSubmission({...args,workspace:true},{role:'member'}),/提交参数/);
});

test('GPU shell is a normal scheduled workspace job, not an unscheduled terminal',()=>{
  const args={machine:MACHINES[0].id,project:'vision',interactive:true,cards:1,
    argv:['/bin/bash','--noprofile','--norc','-i'],key:randomUUID()};
  const request=normalizeJobSubmission(args,{role:'member'});
  const job=createSubmittedJob(request,{id:'demo-user-1',username:'alice'},true);
  assert.equal(job.spec.interactive,true);assert.equal(job.spec.workspace,true);assert.equal(job.cards,1);
  assert.notEqual(request.digest,normalizeJobSubmission({...args,interactive:undefined},{role:'member'}).digest);
  for(const extra of [{release:'a'.repeat(64)},{project:undefined},{argv:['bash']},{interactive:false}])
    assert.throws(()=>normalizeJobSubmission({...args,...extra},{role:'member'}));
  assert.throws(()=>normalizeJobSubmission({...args,scheduling:{rank:'P1',yieldPolicy:'save',restartPolicy:'on-preempt',checkpointable:true}},{role:'member'}),/不能自动重放/);
});

test('validated request is independent of caller mutations and has one job/spec constructor',()=>{
  const args={machine:MACHINES[0].id,cards:1,argv:['python','train.py'],key:randomUUID(),scheduling:{rank:'P1'},datasets:[{dataset:'a',version:'a'.repeat(64)}]};
  const request=normalizeJobSubmission(args,{role:'member'}),digest=request.digest;
  args.argv[0]='unvalidated';args.scheduling.rank='P4';args.datasets[0].version='b'.repeat(64);
  const job=createSubmittedJob(request,{id:'alice',username:'alice'},true,{id:'fixed-id',now:'fixed-time'});
  assert.deepEqual(job.spec.argv,['python','train.py']);assert.equal(job.spec.scheduling.rank,'P1');assert.equal(job.spec.datasets[0].version,'a'.repeat(64));
  assert.equal(job.digest,digest);assert.equal(job.id,'fixed-id');assert.equal(job.spec.id,job.id);assert.equal(job.createdAt,'fixed-time');
  assert.equal(Object.hasOwn(job.spec,'preemptIdleOnly'),false);
  const legacy=normalizeJobSubmission({...args,scheduling:undefined,datasets:undefined},{role:'member'});
  const old=createSubmittedJob(legacy,{id:'alice',username:'alice'},false);
  assert.equal(Object.hasOwn(old.spec,'priority'),false);assert.equal(old.priority,null);
});

test('container packaging includes the submission module used at runtime',async()=>{
  assert.match(await readFile(new URL('../deploy/Dockerfile',import.meta.url),'utf8'),/COPY[^\n]*job-submission\.mjs/);
});
