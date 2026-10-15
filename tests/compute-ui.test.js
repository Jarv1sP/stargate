import test from 'node:test';
import assert from 'node:assert/strict';
import {resourceCards} from '../dist/resources-ui.js';

const machine={id:'fixture-node-a',cards:2,model:'Example GPU'};
const gpu=(index,overrides={})=>({index,utilization:75,memoryUsedMiB:4096,memoryTotalMiB:8192,temperatureC:42,processesAvailable:true,processes:[],...overrides});
function render({gpus=[gpu(0),gpu(1)],disks=[],host={},metricMode='memory',...options}={}){
  return resourceCards({machines:[machine],production:true,userId:'member-a',jobs:[{id:'mine',userId:'member-a'}],metricMode,
    snapshot:{stale:false,hosts:[{id:machine.id,reachable:true,checkedAt:'2026-10-15T18:00:00Z',gpuq:{connected:true},tasks:[],gpus,disks,...host}]},...options});
}
test('metric switch uses separate measured values and never turns unavailable readings into idle',()=>{
  const memory=render(),util=render({metricMode:'utilization'});
  assert.match(memory,/data-resource-level="50"/);assert.match(util,/data-resource-level="75"/);
  const unknown=render({gpus:[gpu(0,{utilization:null}),gpu(1)],metricMode:'utilization'});
  assert.match(unknown,/resource-tower-bar unknown/);
  assert.match(render({host:{samplingStale:true}}),/resource-tower-bar unknown/);
  assert.equal((render({gpus:[gpu(0)]}).match(/resource-tower-bar unknown/g)||[]).length,1,'a missing GPU stays striped while the collected GPU remains visible');
  assert.match(render({gpus:[gpu(0,{processesAvailable:false}),gpu(1)]}),/resource-tower-bar unknown/);
});
test('mixed ownership only paints the memory supported by my process evidence white',()=>{
  const mixed=gpu(0,{processes:[{pid:1,memoryUsedMiB:1024,task:{id:'mine',name:'my task'}},{pid:2,memoryUsedMiB:2048,task:{id:'peer',name:'peer task'}}]});
  assert.match(render({gpus:[mixed,gpu(1)]}),/class="resource-fill-own"[^>]*width="25"/);
  assert.match(render({gpus:[mixed,gpu(1)],metricMode:'utilization'}),/class="resource-fill-own"[^>]*width="0"/);
  assert.match(render({gpus:[gpu(0,{processes:[{task:{id:'mine',name:'my task'}}]}),gpu(1)]}),/class="resource-fill-own"[^>]*width="100"/);
});
test('disks follow observed inventory, merge known filesystems and keep missing samples unknown',()=>{
  const disk={mountPoint:'/fixture/ssd',totalBytes:1024**4,usedBytes:256*1024**3,availableBytes:768*1024**3};
  const single=render({disks:[disk]});assert.equal((single.match(/class="resource-disk /g)||[]).length,1);assert.match(single,/SSD · 工作区与数据集共用/);assert.doesNotMatch(single,/数据集 HDD/);
  assert.equal((render({disks:[disk,{...disk,mountPoint:'/fixture/hdd'}]}).match(/class="resource-disk /g)||[]).length,2);
  assert.equal((render({disks:[{...disk,filesystem:'shared'},{...disk,mountPoint:'/fixture/datasets',filesystem:'shared'}]}).match(/class="resource-disk /g)||[]).length,1);
  const unknown=render({disks:[{mountPoint:'/fixture/ssd',totalBytes:null,usedBytes:null,availableBytes:null}]});assert.match(unknown,/resource-disk unknown/);assert.match(unknown,/可用 未知/);assert.doesNotMatch(unknown,/可用 0/);
  assert.match(render(),/数据盘读数未知/);
  assert.match(render({disks:[{...disk,availableBytes:63*1024**3}]}),/空间不足，低于 64 GiB/);
  assert.doesNotMatch(render({disks:[{...disk,availableBytes:64*1024**3}]}),/空间不足/);
});
test('all cards stay inspectable with no personal quota and selected drawer contains only that card processes',()=>{
  const html=render({gpus:[gpu(0,{processes:[{pid:123,memoryUsedMiB:1024,task:{id:'peer',name:'peer task'}}]}),gpu(1)],selectedGPU:1});
  assert.equal((html.match(/class="resource-tower /g)||[]).length,2);assert.match(html,/data-resource-card="1"/);assert.match(html,/data-resource-gpu="1"/);assert.match(html,/data-use-machine="fixture-node-a"/);
  assert.doesNotMatch(html.slice(html.indexOf('<section class="resource-detail"')),/peer task/);
  assert.match(render({admin:true,management:true,selectedGPU:0,gpus:[gpu(0,{processes:[{pid:123,name:'python',owner:'fixture-user'}]}),gpu(1)]}),/系统用户/);
  assert.doesNotMatch(render({selectedGPU:0,gpus:[gpu(0,{processes:[{pid:123,name:'python',owner:'fixture-user'}]}),gpu(1)]}),/fixture-user/);
});
