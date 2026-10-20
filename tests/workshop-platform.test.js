import test from 'node:test';
import assert from 'node:assert/strict';
import {platformSnapshot,platformCall} from '../dist/workshop-platform.js';
test('live snapshot contains team tasks and public account fields but no session or account secrets',()=>{
 const store={principal:{userId:'a',username:'alice',role:'member',token:'secret-token'},users:[{id:'a',name:'成员甲',username:'alice',passwordHash:'secret-password'},{id:'b',name:'成员乙',username:'bob'}],jobs:[{id:'j-b',userId:'b',state:'UNKNOWN',argv:['python','train.py'],submitter:{name:'成员乙'},bridgeToken:'secret-bridge'}],sessionToken:'secret-session'};
 const snapshot=platformSnapshot(store,{stale:true,machines:[]});
 assert.equal(snapshot.jobs[0].userId,'b');assert.equal(snapshot.jobs[0].state,'UNKNOWN');assert.equal(snapshot.principal.name,'成员甲');assert.doesNotMatch(JSON.stringify(snapshot),/secret-/);
});
test('read/write scope forwards existing operations with the exact request and original submission key',async()=>{
 const calls=[],store={call:async(op,args)=>{calls.push({op,args});return {id:'existing-job'};}};
 const request={machine:'node',project:'vision',ownerId:'peer',key:'same-key',argv:['/bin/bash','-c','python train.py'],cards:1};
 assert.deepEqual(await platformCall(store,'platform.write',{operation:'jobs.submit',args:request}),{id:'existing-job'});
 await platformCall(store,'platform.write',{operation:'jobs.submit',args:request});assert.equal(calls[0].args,request);assert.equal(calls[1].args.key,'same-key');
 await assert.rejects(platformCall(store,'platform.read',{operation:'jobs.submit',args:request}),/未向工坊开放/);
 await assert.rejects(platformCall(store,'platform.write',{operation:'terminal.exchange',args:{data:'rm'}}),/未向工坊开放/);
 await assert.rejects(platformCall(store,'platform.write',{operation:'users.role',args:{}}),/未向工坊开放/);
});
test('live state refresh uses the existing store refresh and preserves backend failures',async()=>{
 const error=Object.assign(Error('配额不足'),{status:409}),store={principal:{},users:[],jobs:[],refresh:async()=>{store.jobs=[{id:'new',state:'RUNNING'}];},call:async()=>{throw error;}};
 assert.equal((await platformCall(store,'platform.read',{operation:'state',refresh:true},()=>({stale:false}))).jobs[0].id,'new');
 await assert.rejects(platformCall(store,'platform.write',{operation:'projects.create',args:{}}),e=>e===error);
});
