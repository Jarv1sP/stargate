import test from 'node:test';
import assert from 'node:assert/strict';
import {usableMachines} from '../dist/workbench-ui.js';
import {resourceCards} from '../dist/resources-ui.js';

const machines=[{id:'node-a',cards:2,model:'Example GPU'},{id:'node-b',cards:2,model:'Example GPU'},{id:'node-c',cards:2,model:'Example GPU'}];
const store=(principal,user)=>({principal,users:user?[user]:[],data:{machines}});
const ids=rows=>rows.map(row=>row.id);

test('usable servers follow the portal rule: admin, or an enabled account with a positive grant',()=>{
  const member={id:'member-a',role:'member',enabled:true,limits:{'node-a':2,'node-b':0}};
  assert.deepEqual(ids(usableMachines(store({userId:'admin-a',role:'admin'},{id:'admin-a',role:'admin',enabled:true,limits:{}}))),['node-a','node-b','node-c'],'admins use every server');
  assert.deepEqual(ids(usableMachines(store({userId:'member-a',role:'member'},member))),['node-a'],'only granted servers; a zero limit is not a grant');
  assert.deepEqual(ids(usableMachines(store({userId:'member-a',role:'member'},{...member,limits:{}}))),[],'no grants at all');
  assert.deepEqual(ids(usableMachines(store({userId:'member-a',role:'member'},{...member,enabled:false}))),[],'a disabled account uses nothing');
  assert.deepEqual(usableMachines(store(null,member)),[],'signed out');
  assert.deepEqual(ids(usableMachines(store({userId:'member-a',role:'member'},member),[machines[1],machines[0]])),['node-a'],'an explicit inventory is filtered the same way');
});

test('compute overview marks servers outside the grants as 未开通 and keeps their readings',()=>{
  const snapshot={stale:false,hosts:machines.map(machine=>({id:machine.id,reachable:true,checkedAt:'2026-10-28T10:00:00Z',displayMasked:machine.id!=='node-a',gpuq:{connected:true,health:'ok'},
    gpus:[0,1].map(index=>({index,utilization:60,memoryUsedMiB:4096,memoryTotalMiB:8192,processesAvailable:true,processes:[]}))}))};
  const html=resourceCards({machines,snapshot,production:true,usable:['node-a']});
  const card=id=>html.match(new RegExp(`data-resource-machine="${id}"[\\s\\S]*?</article>`))[0];
  assert.doesNotMatch(card('node-a'),/未开通/);for(const id of ['node-b','node-c']){assert.match(card(id),/class="resource-closed">未开通/);assert.match(card(id),/data-resource-towers/);}
  assert.doesNotMatch(resourceCards({machines,snapshot,production:true,usable:ids(machines)}),/未开通/,'admins see no tag');
});
