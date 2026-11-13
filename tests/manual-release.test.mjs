import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const workflow=await readFile(new URL('../.github/workflows/deploy.yml',import.meta.url),'utf8');
const block=workflow.match(/- name: Resolve tested main revision[\s\S]*?script: \|\n([\s\S]*?)\n      - uses: actions\/checkout/)[1];
const execute=new (Object.getPrototypeOf(async function(){}).constructor)('github','context','core',block.replace(/^ {12}/gm,''));
const revision='a'.repeat(40),repo={owner:'fixture',repo:'stargate'};
function fixture(){
  const calls=[],output={};
  const runs={};for(const name of ['ci.yml','gray.yml'])runs[name]=[{head_sha:revision,head_branch:'main',head_repository:{full_name:'fixture/stargate'},status:'completed',conclusion:'success'}];
  const f={status:'ahead',runs,calls,output,context:{eventName:'workflow_dispatch',ref:'refs/heads/main',repo,payload:{inputs:{revision}}}};
  f.github={rest:{repos:{compareCommitsWithBasehead:async args=>{calls.push(args);return {data:{status:f.status}};}},actions:{listWorkflowRuns:async args=>{calls.push(args);return {data:{workflow_runs:runs[args.workflow_id]}};}}}};
  f.core={setOutput:(k,v)=>output[k]=v,exportVariable:(k,v)=>output[k]=v};
  f.run=()=>execute(f.github,f.context,f.core);return f;
}
test('manual release selects an accepted main ancestor and exports the same tested revision',async()=>{
  const f=fixture();await f.run();assert.deepEqual(f.output,{revision,STARGATE_RELEASE_REVISION:revision});
  assert.equal(f.calls[0].basehead,revision+'...main');
  assert.deepEqual(f.calls.slice(1).map(c=>[c.workflow_id,c.head_sha,c.branch,c.event]),[['ci.yml',revision,'main','push'],['gray.yml',revision,'main','push']]);
});
test('manual gate rejects unmerged or malformed targets and dispatch from a branch',async()=>{
  for(const change of [f=>f.status='behind',f=>f.status='diverged',f=>f.context.ref='refs/heads/feature',f=>f.context.payload.inputs.revision='main']){
    const f=fixture();change(f);await assert.rejects(f.run());assert.deepEqual(f.output,{});
  }
});
test('both main workflows must finish successfully for the exact repository and commit',async()=>{
  for(const name of ['ci.yml','gray.yml'])for(const change of [r=>r.conclusion='failure',r=>r.status='in_progress',r=>r.head_sha='b'.repeat(40),r=>r.head_branch='feature',r=>r.head_repository.full_name='another/stargate']){
    const f=fixture();change(f.runs[name][0]);await assert.rejects(f.run());assert.deepEqual(f.output,{});
  }
  const f=fixture();f.runs['gray.yml']=[];await assert.rejects(f.run());
});
test('a pending latest rerun cannot borrow an older successful run',async()=>{
  const f=fixture();f.runs['gray.yml'].unshift({...f.runs['gray.yml'][0],status:'in_progress',conclusion:null});await assert.rejects(f.run());
});
test('automatic release conditions and production protections stay in place',async()=>{
  const f=fixture();f.context={eventName:'workflow_run',repo,payload:{workflow_run:{head_sha:revision}}};await f.run();assert.equal(f.calls.length,0);
  assert.match(workflow,/head_branch == 'main'/);assert.match(workflow,/head_repository.full_name == github.repository/);
  assert.match(workflow,/conclusion == 'success'/);assert.match(workflow,/!contains\(github.event.workflow_run.head_commit.message, '【手动】'\)/);
  assert.match(workflow,/environment: production/);assert.match(workflow,/group: production\n  cancel-in-progress: false/);
  assert.match(workflow,/ref: \$\{\{ steps.source.outputs.revision \}\}/);
});
