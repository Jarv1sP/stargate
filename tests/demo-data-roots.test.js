import test from 'node:test';
import assert from 'node:assert/strict';
import {DemoService} from '../dist/service.js';

test('demo data roots is an authenticated authorized read, not a real node probe',async()=>{
 const service=new DemoService(),member=service.store.get('demo-lin');
 const machine=Object.keys(member.limits)[0],other=service.store.snapshot().machines.find(row=>!member.limits[row.id]).id;
 const session=user=>service.issueSession({userId:user.id,username:user.username,role:user.role});
 const token=session(member),read=args=>service.invoke(token,'data.roots',args);
 assert.deepEqual((await read({machine})).result,{directories:[],personal:{path:'/data/mine',readOnly:false}});
 await assert.rejects(read({machine:other}),error=>error.status===403);
 await assert.rejects(read({machine,userId:'builtin-admin'}),/只接受目标服务器/);
 await assert.rejects(service.invoke(session(service.store.get('demo-wang')),'data.roots',{machine}),error=>error.status===403);
 await assert.rejects(service.invoke(null,'data.roots',{machine}),error=>error.status===401);
 assert.deepEqual((await service.invoke(session(service.store.get('builtin-admin')),'data.roots',{machine:other})).result,
  {directories:[],personal:{path:'/data/mine',readOnly:false}});
 service.store.users.find(user=>user.id===member.id).enabled=false;
 await assert.rejects(read({machine}),error=>error.status===403);
 assert.deepEqual(service.store.jobs,[]);
});
