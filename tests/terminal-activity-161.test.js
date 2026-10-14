import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {executionCall} from '../execution.mjs';
import {MACHINES} from '../dist/model.js';

const machine=MACHINES[0].id;
function fixture(){
  const user={id:'own-member',username:'owner',role:'member',enabled:true,limits:{[machine]:1}},calls=[];
  const service={store:{get:()=>user},audit(){},bridge:async(m,op,args)=>{calls.push({m,op,args});return {id:args.key};}};
  return {user,calls,service,principal:{userId:user.id,username:user.username,role:user.role}};
}
const open=()=>({machine,project:'alpha',key:randomUUID(),clientId:randomUUID(),mode:'new',clientLabel:'gpuctl · laptop'});

test('only terminal.open forwards the optional label and derives identity from the current account',async()=>{
  const f=fixture(),args=open();await executionCall(f.service,f.principal,'terminal.open',args);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].args.clientLabel,args.clientLabel);assert.equal(f.calls[0].args.userId,f.user.id);
  await executionCall(f.service,f.principal,'terminal.status',{machine,id:args.key,clientLabel:'ignored'});assert.equal(f.calls.at(-1).args.clientLabel,undefined);
  await executionCall(f.service,f.principal,'terminal.open',{...open(),userId:'other'});assert.equal(f.calls.at(-1).args.userId,f.user.id);assert.equal(f.calls.length,3);
});
test('bad labels and revoked accounts cannot reach the terminal bridge',async()=>{
  const f=fixture();for(const label of ['',null,{},'x'.repeat(129),'bad\nlabel'])await assert.rejects(executionCall(f.service,f.principal,'terminal.open',{...open(),clientLabel:label}),/来源名称无效/);
  f.user.enabled=false;await assert.rejects(executionCall(f.service,f.principal,'terminal.open',open()),e=>e.status===403);
  assert.equal(f.calls.length,0);f.user.enabled=true;f.user.limits={};await executionCall(f.service,f.principal,'terminal.open',open());assert.equal(f.calls.length,1);
});
test('optional terminal labels do not add an admission gate',async()=>{
  const f=fixture(),{clientLabel,...args}=open();await executionCall(f.service,f.principal,'terminal.open',args);assert.equal(f.calls.length,1);assert.equal(f.calls[0].args.clientLabel,undefined);
});
