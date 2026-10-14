import test from 'node:test';
import assert from 'node:assert/strict';
import {executionCall} from '../execution.mjs';
import {MACHINES} from '../dist/model.js';
const machine=MACHINES[0].id,runId='11111111-1111-4111-8111-111111111111',principal={userId:'demo-user-1',role:'member'};
function fixture(){
 const user={id:principal.userId,enabled:true,limits:{}},calls=[],job={id:runId,userId:'other-member',machine,project:'test',spec:{}};
 const service={store:{get:()=>user,jobs:[job]},bridge:async(...args)=>{calls.push(args);return {entries:[{name:'sample',type:'file',size:1}],total:450,nextOffset:400};}};
 return {calls,call:(operation,args)=>executionCall(service,principal,operation,{machine,area:'output',runId,path:'.',...args})};
}
test('directory pagination converts one public cursor to node offset without losing later pages',async()=>{
 const f=fixture(),result=await f.call('files.list',{cursor:'200',limit:200});assert.equal(f.calls[0][2].offset,200);assert.equal(f.calls[0][2].cursor,undefined);assert.equal(result.hasMore,true);assert.equal(result.nextCursor,'400');assert.equal(f.calls[0][2].ownerId,'other-member');
});
test('size/offset bounds reject invalid pagination while extra component fields are ignored',async()=>{
 const f=fixture();for(const args of [{limit:0},{limit:1001},{limit:'5'},{cursor:-1},{cursor:'../escape'}])await assert.rejects(f.call('files.list',args),e=>e.status===400);assert.equal(f.calls.length,0);
 await f.call('files.list',{future:true,userId:'ignored',dataset:null});assert.equal(f.calls.length,1);assert.equal(f.calls[0][2].future,undefined);assert.equal(f.calls[0][2].dataset,undefined);
});
