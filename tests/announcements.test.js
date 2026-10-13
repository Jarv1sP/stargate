import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {installCommunity,communityCall,announcementState} from '../community.mjs';
import {showCLIAnnouncements,runCommunityCommand} from '../community-cli.mjs';

function fixture(t){
  const users=['admin','alice','bob'].map(id=>({id,username:id,name:id,role:id==='admin'?'admin':'member',enabled:true}));
  const service={db:new DatabaseSync(':memory:'),store:{users},audit(){}};installCommunity(service);t.after(()=>service.db.close());
  const actor=name=>({userId:name,username:name,role:users.find(u=>u.id===name).role});
  const call=(name,op,args={})=>communityCall(service,actor(name),'community.'+op,args);
  const post=(more={})=>call('admin','posts.create',{key:randomUUID(),kind:'announcement',title:'通知',body:'公告正文',popup:true,...more}).post;
  return {service,users,actor,call,post,pending:name=>announcementState(service,actor(name)).pending};
}
test('appearance persists and pending content is recipient-only; invalid CSS is rejected',t=>{
  const f=fixture(t),appearance={layout:'centered',background:'#112233',text:'#ffffff',accent:'#ff8800'};
  const post=f.post({appearance,audience:{type:'users',userIds:['alice']}});
  assert.deepEqual(post.appearance,appearance);
  assert.deepEqual(f.call('bob','announcements.pending').posts,[]);
  assert.deepEqual(f.call('alice','announcements.pending').posts[0].appearance,appearance);
  assert.throws(()=>f.call('admin','posts.update',{id:post.id,revision:1,appearance:{accent:'url(https://invalid)'}}),e=>e.status===400);
  const edited=f.call('admin','posts.update',{id:post.id,revision:1,appearance:{...appearance,layout:'compact'}}).post;
  assert.equal(edited.appearance.layout,'compact');assert.equal(edited.revision,2);
});
test('CLI shows whole announcement until explicit account-level confirmation',async t=>{
  const f=fixture(t),post=f.post({body:'正文\n请明确处理'}),seen=[],out=[];
  const call=async(op,args)=>{seen.push(op);return {result:f.call('alice',op.replace('community.',''),args)};};
  await showCLIAnnouncements(call,f.pending('alice'),s=>out.push(s));
  assert.match(out.join(''),/正文\n请明确处理/);assert.match(out.join(''),/community ack \d+ --revision 1/);
  assert.deepEqual(seen,['community.posts.get']);assert.equal(f.pending('alice').length,1);
  const pending=await runCommunityCommand({positionals:['community','announcements'],call});assert.equal(pending.posts.length,1);
  await runCommunityCommand({positionals:['community','ack',post.id],options:{revision:'1'},call});assert.equal(f.pending('alice').length,0);
});
test('targeted posts are filtered before pagination, including titles and replies',t=>{
  const f=fixture(t),publicPost=f.post(),privatePost=f.post({title:'PRIVATE TITLE',body:'PRIVATE BODY',audience:{type:'users',userIds:['alice']}});
  assert.deepEqual(f.pending('bob').map(p=>p.id),[publicPost.id]);assert.equal(f.pending('alice').length,2);
  const bob=f.call('bob','posts.list',{kind:'announcement',limit:1});assert.deepEqual(bob.posts.map(p=>p.id),[publicPost.id]);assert.equal(bob.nextCursor,null);
  assert.doesNotMatch(JSON.stringify(bob),/PRIVATE/);
  for(const [op,args] of [['posts.get',{id:privatePost.id}],['comments.list',{postId:privatePost.id}],['comments.create',{postId:privatePost.id,key:randomUUID(),body:'x'}],['announcements.ack',{id:privatePost.id,revision:1}]])
    assert.throws(()=>f.call('bob',op,args),e=>e.status===404);
  const allowed=f.call('alice','posts.get',{id:privatePost.id}).post;
  assert.equal(allowed.body,'PRIVATE BODY');assert.equal(Object.hasOwn(allowed,'audience'),false,'recipient list is admin-only');
  assert.equal(f.call('admin','posts.list').posts.length,2,'admins retain management visibility');
  assert.deepEqual(f.pending('admin').map(p=>p.id),[publicPost.id],'management visibility does not target the admin popup');
});
test('role groups match current roles, zero GPU quota is irrelevant, only admins publish',t=>{
  const f=fixture(t),members=f.post({audience:{type:'role',role:'member'}}),admins=f.post({audience:{type:'role',role:'admin'}});
  assert.deepEqual(f.pending('alice').map(p=>p.id),[members.id]);assert.deepEqual(f.pending('admin').map(p=>p.id),[admins.id]);
  assert.throws(()=>f.call('alice','posts.create',{key:randomUUID(),kind:'announcement',title:'x',body:'x',popup:true}),e=>e.status===403);
  f.users.find(u=>u.id==='alice').role='admin';assert.deepEqual(f.pending('alice').map(p=>p.id),[admins.id]);
});
test('ack is account and revision bound, idempotent, never acknowledges an unseen update',t=>{
  const f=fixture(t),post=f.post();
  assert.equal(f.call('alice','announcements.ack',{id:post.id,revision:1}).acknowledged,true);
  assert.equal(f.call('alice','announcements.ack',{id:post.id,revision:1}).acknowledged,true);assert.deepEqual(f.pending('alice'),[]);
  assert.equal(f.pending('bob').length,1);
  const updated=f.call('admin','posts.update',{id:post.id,revision:1,body:'新版'}).post;
  assert.deepEqual(f.pending('alice'),[{id:post.id,revision:2}]);
  assert.throws(()=>f.call('alice','announcements.ack',{id:post.id,revision:1}),e=>e.status===409);
  assert.equal(f.pending('alice').length,1);
  assert.throws(()=>f.call('alice','announcements.ack',{id:post.id,revision:2,userId:'bob'}),e=>e.status===400);
  f.call('admin','posts.delete',{id:updated.id,revision:2});assert.deepEqual(f.pending('bob'),[]);
  assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM announcement_acknowledgements').get().n,0);
});
test('target changes immediately close direct reads, comment retries and comment edits',t=>{
  const f=fixture(t),post=f.post({audience:{type:'users',userIds:['alice']}});
  const args={key:randomUUID(),postId:post.id,body:'private comment'},comment=f.call('alice','comments.create',args).comment;
  f.call('admin','posts.update',{id:post.id,revision:1,audience:{type:'users',userIds:['bob']}});
  assert.deepEqual(f.pending('alice'),[]);assert.equal(f.pending('bob').length,1);
  for(const [op,payload] of [['comments.create',args],['comments.update',{id:comment.id,revision:1,body:'changed'}],['comments.delete',{id:comment.id,revision:1}]])
    assert.throws(()=>f.call('alice',op,payload),e=>e.status===404);
});
test('legacy announcements remain all-member non-popup and old publication keys match',t=>{
  const f=fixture(t),args={key:randomUUID(),kind:'announcement',title:'旧公告',body:'原文'};
  const post=f.call('admin','posts.create',args).post;assert.equal(post.popup,false);assert.deepEqual(post.audience,{type:'all'});
  assert.deepEqual(f.pending('alice'),[]);
  assert.equal(f.call('admin','posts.create',{...args,audience:{type:'all'},popup:false}).post.id,post.id);
  installCommunity(f.service);assert.equal(f.call('alice','posts.get',{id:post.id}).post.body,'原文');
});
test('recipient validation rejects unknown identities and hidden fields without publication',t=>{
  const f=fixture(t);
  for(const audience of [{type:'users',userIds:[]},{type:'users',userIds:['unknown']},{type:'role',role:'root'},{type:'all',userId:'alice'},{type:'group',groupId:'imaginary'}])
    assert.throws(()=>f.post({audience}),e=>e.status===400);
  assert.throws(()=>f.post({popup:'yes'}),e=>e.status===400);
  assert.throws(()=>f.call('alice','posts.create',{key:randomUUID(),kind:'discussion',title:'x',body:'x',audience:{type:'all'}}),e=>e.status===400);
  assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM community_posts').get().n,0);
});
