import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {schedulingPolicy} from '../dist/scheduling-policy.js';
import {schedulingFromForm} from '../dist/scheduling-ui.js';
import {schedulingContractLabel,priorityDescription} from '../dist/execution-ui.js';
import {normalizeJobSubmission,createSubmittedJob} from '../job-submission.mjs';
import {MACHINES} from '../dist/model.js';
import {elasticAllocation} from '../dist/gpu-allocation.js';

test('voluntary yielding defaults to requeue while protected jobs and explicit opt-out stay unchanged',()=>{
 for(const yieldPolicy of ['now','save']){
  const input={rank:'P1',yieldPolicy,checkpointable:yieldPolicy==='save'};
  assert.equal(schedulingPolicy(input).restartPolicy,'on-preempt');
  assert.equal(schedulingPolicy({...input,restartPolicy:'never'}).restartPolicy,'never');
 }
 assert.equal(schedulingPolicy({}).restartPolicy,'never');
 assert.throws(()=>schedulingPolicy({yieldPolicy:'save'}),/checkpoint/);
 assert.throws(()=>elasticAllocation({minCards:1,globalBatch:8,microBatch:1,autoExpand:true},2,{yieldPolicy:'now',checkpointable:true}),/保存/);
});
test('browser default requeue handles never, now, save and an explicit stop without inventing checkpoint support',()=>{
 const form=new FormData();for(const [key,value] of Object.entries({'custom-policy':'on','queue-rank':'P1','yield-policy':'never','restart-policy':'on-preempt'}))form.set(key,value);
 assert.equal(schedulingFromForm(form).restartPolicy,'never');
 form.set('yield-policy','now');assert.equal(schedulingFromForm(form).restartPolicy,'on-preempt');
 form.set('restart-policy','never');assert.equal(schedulingFromForm(form).restartPolicy,'never');
 form.set('yield-policy','save');form.set('restart-policy','on-preempt');assert.throws(()=>schedulingFromForm(form),/checkpoint/);
 form.set('checkpointable','on');assert.equal(schedulingFromForm(form).restartPolicy,'on-preempt');
});
test('task labels distinguish restart from checkpoint resume and explain the idle preset',()=>{
 assert.match(schedulingContractLabel({yield_policy:'now',restart_policy:'on-preempt'}),/从头/);
 assert.match(schedulingContractLabel({yield_policy:'save',restart_policy:'on-preempt'}),/checkpoint/);
 assert.match(schedulingContractLabel({yield_policy:'now',restart_policy:'never'}),/不重排/);
 assert.match(priorityDescription('idle'),/自动重排/);assert.match(priorityDescription('idle'),/从头/);
});
test('portal normalizes and persists the default once; an old explicit never request remains never',()=>{
 const args={machine:MACHINES[0].id,cards:1,argv:['python','train.py'],key:'11111111-1111-4111-8111-111111111111',scheduling:{rank:'P1',yieldPolicy:'now'}},principal={userId:'fixture'};
 const request=normalizeJobSubmission(args,principal),job=createSubmittedJob(request,{id:'fixture',username:'fixture'},true);
 assert.equal(job.spec.scheduling.restartPolicy,'on-preempt');assert.equal(job.scheduling.restartPolicy,'on-preempt');
 const old=normalizeJobSubmission({...args,scheduling:{...args.scheduling,restartPolicy:'never'}},principal);
 assert.equal(createSubmittedJob(old,{id:'fixture',username:'fixture'},true).spec.scheduling.restartPolicy,'never');
});
test('CLI voluntary yielding defaults to requeue and preserves an explicit never option',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'preempt-defaults-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const requests=[],server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const call=JSON.parse(raw);requests.push(call);
  res.setHeader('Content-Type','application/json');
  if(call.operation==='community.announcements.pending')return res.end(JSON.stringify({result:{posts:[]}}));
  assert.equal(call.operation,'jobs.submit');res.statusCode=403;res.end(JSON.stringify({error:'Synthetic submission captured; no task created'}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
 const url='http://127.0.0.1:'+server.address().port,session=join(dir,'session.json');
 await writeFile(session,JSON.stringify({url,token:'loopback-only',machine:'fixture-node',principal:{userId:'fixture',username:'fixture',role:'member'}}));
 const cli=process.env.PREEMPT_DEFAULTS_TEST_CLI||fileURLToPath(new URL('../cli.mjs',import.meta.url));
 for(const [options,restart] of [[['--yield','now'],'on-preempt'],[['--yield','save','--checkpointable'],'on-preempt'],[['--yield','now','--restart-policy','never'],'never'],[['--yield','save','--checkpointable','--restart-policy','never'],'never'],[['--yield','never'],'never']]){
  requests.length=0;
  const result=await new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,[cli,'--session-file',session,'--url',url,'run',...options,'-g','1','--','python','synthetic.py'],{stdio:['ignore','pipe','pipe']});
   let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);child.stdout.resume();child.on('error',reject);child.on('close',code=>resolve({code,stderr}));
  });
  assert.equal(result.code,1);assert.match(result.stderr,/Synthetic submission captured/);
  const calls=requests.filter(call=>call.operation==='jobs.submit');assert.equal(calls.length,1);
  assert.equal(calls[0].args.scheduling.restartPolicy,restart,options.join(' '));
 }
});
