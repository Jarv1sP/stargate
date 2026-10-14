import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PortalService} from '../portal-service.mjs';

test('community reads bypass a slow remote write without bypassing authorization or write ordering',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'stargate-community-read-'));
  const bootstrap=join(directory,'bootstrap.json'),password='Local-Community-Read-Test!';
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const service=await PortalService.open(join(directory,'portal.sqlite'),bootstrap);
  t.after(async()=>{service.close();await rm(directory,{recursive:true,force:true});});
  const admin=await service.login('admin',password);
  const account=(await service.invoke(admin.token,'users.create',{username:'read-fixture',password})).result;
  const member=await service.login('read-fixture',password);
  const post=(await service.invoke(member.token,'community.posts.create',{key:randomUUID(),kind:'feedback',title:'只读队列夹具',body:'本地测试'})).result.post;
  let release;const held=service.enqueue(()=>new Promise(resolve=>{release=resolve;}));await Promise.resolve();
  let wrote=false;const write=service.invoke(member.token,'community.chat.send',{key:randomUUID(),body:'queued write'}).then(()=>{wrote=true;});
  let timer;
  try{
    const reads=Promise.all([
      ['community.info',{}],['community.posts.list',{}],['community.posts.get',{id:post.id}],
      ['community.comments.list',{postId:post.id}],['community.chat.list',{}],['community.notes.list',{}]
    ].map(([operation,args])=>service.invoke(member.token,operation,args)));
    const result=await Promise.race([reads,new Promise(resolve=>{timer=setTimeout(()=>resolve('BLOCKED_BY_WRITE'),100);})]);
    assert.notEqual(result,'BLOCKED_BY_WRITE');assert.equal(result.length,6);assert.equal(wrote,false);
    for(const reply of result)assert.equal(reply.principal.userId,account.id);
    await assert.rejects(service.invoke('invalid','community.posts.list'),error=>error.status===401);
    const user=service.store.users.find(value=>value.id==='builtin-admin');user.enabled=false;
    await assert.rejects(service.invoke(admin.token,'community.posts.list'),error=>error.status===403);
    user.enabled=true;
  }finally{clearTimeout(timer);release();await held;await write;}
  assert.equal(wrote,true);
});
