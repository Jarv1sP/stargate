import test from 'node:test';
import assert from 'node:assert/strict';
import {runCommunityCommand,communityHelp} from '../community-cli.mjs';

const invoke=(options,call)=>runCommunityCommand({positionals:['community','edit','42'],options,call});

test('feedback status edits preserve the explicit ID in one authenticated update',async()=>{
  const seen=[];
  for(const status of ['open','investigating','resolved','closed']){
    const result=await invoke({status},async(op,args)=>{
      seen.push([op,args]);return {result:{post:{id:args.id,revision:8,status:args.status}}};
    });
    assert.equal(result.post.status,status);
    assert.deepEqual(seen.at(-1),['community.posts.update',{id:'42',status}]);
  }
  assert.equal(seen.length,4);
  assert.match(communityHelp,/community edit ID.*--status open\|investigating\|resolved\|closed/);
});

test('status can accompany content while invalid status never call the API',async()=>{
  const seen=[];
  await invoke({status:'resolved',title:'已修复',body:'验收通过'},async(op,args)=>{
    seen.push([op,args]);return {result:{}};
  });
  assert.deepEqual(seen,[['community.posts.update',{id:'42',title:'已修复',body:'验收通过',status:'resolved'}]]);
  for(const options of [{status:'done'},{status:true}]){
    await assert.rejects(()=>invoke(options,()=>assert.fail('invalid edits must not call the API')));
  }
});

test('explicit server failures are preserved without replay',async()=>{
  for(const [status,message] of [[403,'administrator only'],[400,'feedback only'],[503,'节点暂未响应']]){
    const refused=Object.assign(Error(message),{status});let calls=0;
    await assert.rejects(()=>invoke({status:'closed'},async(op,args)=>{
      calls++;assert.equal(op,'community.posts.update');assert.deepEqual(args,{id:'42',status:'closed'});throw refused;
    }),error=>error===refused);
    assert.equal(calls,1);
  }
});
