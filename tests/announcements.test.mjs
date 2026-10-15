import {seedAccounts} from './fixtures/accounts.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {runCommunityCommand,showCLIAnnouncements} from '../community-cli.mjs';
import {defaultAppearance,normalizeAppearance} from '../dist/announcement-appearance.js';

async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'lean-announcements-')),database=join(dir,'db'),bootstrap=join(dir,'bootstrap');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Announcement-Local-Only!'}));
  const service=await PortalService.open(database,bootstrap);
  for(const timer of ['executionTimer','notificationTimer','maintenanceTimer','transferTimer','storageArchiveTimer','projectCopyTimer'])clearInterval(service[timer]);
  t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});
  const admin=service.store.users[0],members=[1,2].map(n=>({...admin,id:'demo-user-'+n,username:'member-'+n,role:'member'}));seedAccounts(service,...members);
  const token=user=>service.issueSession({userId:user.id,username:user.username,role:user.role});
  const call=(user,op,args={})=>service.invoke(token(user),'community.'+op,args).then(reply=>reply.result);
  const publish=(fields={})=>call(admin,'posts.create',{key:randomUUID(),kind:'announcement',title:'Notice',body:'Visible only to recipients',popup:true,...fields});
  return {service,admin,members,call,publish,token};
}

test('targeted titles, bodies and comments are filtered by the server before pagination',async t=>{
  const f=await fixture(t),[a,b]=f.members;
  const {post}=await f.publish({audience:{type:'users',userIds:[a.id]}});
  assert.deepEqual((await f.call(a,'posts.list',{limit:1})).posts.map(p=>p.id),[post.id]);
  assert.deepEqual((await f.call(b,'posts.list')).posts,[]);
  assert.equal((await f.call(f.admin,'posts.get',{id:post.id})).post.audience.userIds[0],a.id);
  assert.equal(Object.hasOwn((await f.call(a,'posts.get',{id:post.id})).post,'audience'),false);
  for(const [op,args] of [['posts.get',{id:post.id}],['comments.list',{postId:post.id}],['comments.create',{key:randomUUID(),postId:post.id,body:'not authorized'}]])
    await assert.rejects(f.call(b,op,args),error=>error.status===404);
  assert.equal((await f.call(a,'announcements.pending')).posts.length,1);
  assert.equal((await f.call(b,'announcements.pending')).posts.length,0);
  assert.equal((await f.call(f.admin,'announcements.pending')).posts.length,0,'administrators manage all but only receive targeted popups');
});

test('role audiences and announcement publishing retain authorization',async t=>{
  const f=await fixture(t);
  await f.publish({audience:{type:'role',role:'member'}});
  assert.equal((await f.call(f.members[0],'announcements.pending')).posts.length,1);
  assert.equal((await f.call(f.admin,'announcements.pending')).posts.length,0);
  await assert.rejects(f.call(f.members[0],'posts.create',{key:randomUUID(),kind:'announcement',title:'denied',body:'denied'}),error=>error.status===403);
  const post=(await f.call(f.admin,'posts.list')).posts[0];
  await assert.rejects(f.call(f.members[0],'posts.update',{id:post.id,body:'denied'}),error=>error.status===403);
});

test('acknowledging an older read edition succeeds and leaves the updated edition pending',async t=>{
  const f=await fixture(t),a=f.members[0],{post}=await f.publish();
  await f.call(a,'announcements.ack',{id:post.id,revision:post.revision});
  assert.deepEqual((await f.call(a,'announcements.pending')).posts,[]);
  assert.equal((await f.call(f.members[1],'announcements.pending')).posts.length,1);
  const updated=(await f.call(f.admin,'posts.update',{id:post.id,revision:-100,title:'New edition'})).post;
  assert.equal(updated.revision,2);
  const older=await f.call(a,'announcements.ack',{id:post.id,revision:1});
  assert.equal(older.acknowledged,true);assert.equal(older.revision,1);
  assert.equal(f.service.db.prepare('SELECT revision FROM announcement_acknowledgements_v2 WHERE user_id=? AND post_id=?').get(a.id,post.id).revision,1);
  assert.deepEqual(older.announcements.pending.map(p=>[p.id,p.revision]),[[post.id,2]]);
  assert.equal((await f.call(a,'announcements.pending')).posts[0].revision,2);
  const current=await f.call(a,'announcements.ack',{id:post.id,revision:2});assert.deepEqual(current.announcements.pending,[]);
  assert.deepEqual(f.service.db.prepare('SELECT revision FROM announcement_acknowledgements_v2 WHERE user_id=? AND post_id=?').get(a.id,post.id).revision,2);
});

test('pending reads bypass a held write and never sign an acknowledgement implicitly',async t=>{
  const f=await fixture(t);await f.publish();let release;
  const held=f.service.enqueue(()=>new Promise(resolve=>{release=resolve;}));await Promise.resolve();
  try{
    const reply=await f.call(f.members[0],'announcements.pending');assert.equal(reply.posts.length,1);
    assert.equal(f.service.db.prepare('SELECT count(*) n FROM announcement_acknowledgements_v2').get().n,0);
  }finally{release();await held;}
});


test('recipient count has no 200-person gate; unknown style fields fall back safely',async t=>{
  const f=await fixture(t),users=Array.from({length:201},(_,i)=>({...f.members[0],id:'demo-user-'+(i+100),username:'recipient-'+i}));seedAccounts(f.service,...users);
  const {post}=await f.publish({audience:{type:'users',userIds:users.map(u=>u.id)},appearance:{layout:'future',background:'url(unsafe)',extra:'ignored'}});
  assert.equal(post.audience.userIds.length,201);assert.deepEqual(post.appearance,defaultAppearance);
  assert.deepEqual(normalizeAppearance({layout:'centered',text:'#AaBBcC'}),{...defaultAppearance,layout:'centered',text:'#aabbcc'});
});

test('publishing and editing a pinned announcement has no 20-item admission gate',async t=>{
  const f=await fixture(t),insert=f.service.db.prepare('INSERT INTO community_posts_v2(author_id,kind,title,body,pinned,created_at,updated_at) VALUES(?,?,?,?,?,?,?)');
  for(let i=0;i<20;i++)insert.run(f.admin.id,'announcement','existing-'+i,'kept',1,1,1);
  const {post}=await f.publish({pinned:true});assert.equal(post.pinned,true);
  await f.call(f.admin,'posts.update',{id:post.id,pinned:false});
  assert.equal((await f.call(f.admin,'posts.update',{id:post.id,pinned:true})).post.pinned,true);
});

test('CLI batches pending bodies once, warns without blocking, and never automatically acknowledges',async()=>{
  const calls=[],post={id:'1',revision:2,title:'Notice',body:'Message'};let output='';
  await showCLIAnnouncements(async(op,args)=>{calls.push([op,args]);return {result:{posts:[post]}};},[{id:'1',revision:2}],text=>output+=text);
  assert.deepEqual(calls,[['community.announcements.pending',{}]]);assert.match(output,/Message/);assert.match(output,/ack 1 --revision 2/);
  await showCLIAnnouncements(()=>assert.fail('empty state adds no RPC'),[],()=>{});
  await showCLIAnnouncements(async()=>{throw Error('temporary');},undefined,text=>output=text);assert.match(output,/temporary/);
});

test('CLI styles keep lean publish/edit semantics while acknowledgement names its read edition',async()=>{
  const calls=[],call=async(op,args)=>{calls.push([op,args]);return {result:{acknowledged:op.endsWith('.ack')}};};
  await runCommunityCommand({positionals:['community','post'],options:{kind:'announcement',title:'Notice',body:'Text',pin:true,layout:'compact'},call,onKey:()=>{}});
  assert.equal(calls.length,1);assert.equal(calls[0][0],'community.posts.create');assert.equal(calls[0][1].appearance.layout,'compact');
  await runCommunityCommand({positionals:['community','edit','1'],options:{layout:'centered'},call});
  assert.equal(Object.hasOwn(calls[1][1],'revision'),false);
  await runCommunityCommand({positionals:['community','ack','1'],options:{revision:'2'},call});
  assert.deepEqual(calls[2],['community.announcements.ack',{id:'1',revision:2}]);
});
