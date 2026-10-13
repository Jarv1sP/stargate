import test from 'node:test';
import assert from 'node:assert/strict';
import {trainingTarget,trainingReceiptMatches} from '../dist/execution-ui.js';
import {trainingSelectionHTML} from '../dist/training-storage-ui.js';

const source='fixture-development',target='fixture-training-8',machines=[{id:source},{id:target}];
const project={project:'vision',environmentMode:'oci'};
const args={...trainingTarget('auto',source,project,target,machines),project:project.project,cards:1,key:'11111111-1111-4111-8111-111111111111'};
const job={...args,id:'22222222-2222-4222-8222-222222222222',machine:target,userId:'fixture-member',selectionSummary:{protocol:1,selectedMachine:target,reason:'local-workspace-and-resource-rank',gpuPoolAvailable:false,queuedJobs:3}};

test('web AUTO uses the run contract and confirms the fixed actual target',()=>{
  assert.equal(args.machine,'auto');assert.deepEqual(args.machineSelection,{mode:'auto',candidates:[target]});
  assert.equal(trainingReceiptMatches(job,args,'fixture-member',machines),true);
  for(const change of [{machine:source},{machine:'unlisted'},{userId:'another-member'},{key:'other'},{project:'other'},{release:'b'.repeat(64)},{machineSelection:{mode:'current'}}])assert.equal(trainingReceiptMatches({...job,...change},args,'fixture-member',machines),false);
  assert.equal(Object.hasOwn(args,'release'),false);
  assert.throws(()=>trainingTarget('auto',source,{...project,environmentMode:'shared'},'',machines),/已存在的项目工作区/);
});
test('confirmed AUTO receipt shows allocated machine and the real reason only in one disclosure',()=>{
  const html=trainingSelectionHTML(job);
  assert.match(html,/已分配到/);assert.match(html,/title="fixture-training-8"/);
  assert.match(html,/aria-label="自动选择原因"/);assert.match(html,/按已有工作区、显卡和排队情况选择/);
  assert.equal((html.match(/<details/g)||[]).length,1);
  assert.doesNotMatch(html,/已预留|空闲服务器|存储容量|<p(?:\s|>)/);
});
test('unverified and unknown reasons never invent capacity or resource promises',()=>{
  for(const change of [{reason:'future-reason'},{reason:null},{reason:'storage-fit-and-resource-rank',storageVerified:false},{reason:'storage-fit-and-resource-rank',storageVerified:'true'}]){
    const html=trainingSelectionHTML({...job,selectionSummary:{...job.selectionSummary,...change}});
    assert.match(html,/已分配到/);assert.doesNotMatch(html,/按存储容量|自动选择原因|<details/);
  }
  for(const summary of [null,{}, {...job.selectionSummary,protocol:0},{...job.selectionSummary,selectedMachine:source}])assert.equal(trainingSelectionHTML({...job,selectionSummary:summary}),'');
});
test('historical verified storage receipts retain their original explanation',()=>{
  const html=trainingSelectionHTML({...job,selectionSummary:{...job.selectionSummary,reason:'storage-fit-and-resource-rank',storageVerified:true}});
  assert.match(html,/按存储容量、显卡和排队情况选择/);assert.doesNotMatch(html,/按已有工作区/);
});
test('defined exclusions stay escaped inside the same disclosure',()=>{
  const unsafe='<img src=x onerror=alert(1)>',html=trainingSelectionHTML({...job,machine:unsafe,selectionSummary:{...job.selectionSummary,selectedMachine:unsafe,storageExcluded:[{machine:'fixture-small',reason:'storage-insufficient'},{machine:unsafe,reason:'storage-unverified'},{machine:'ignored',reason:'future-reason'}]}});
  assert.match(html,/fixture-small 空间不足/);assert.match(html,/&lt;img/);assert.match(html,/空间未核实/);
  assert.doesNotMatch(html,/<img|ignored/);assert.equal((html.match(/<details/g)||[]).length,1);
});
