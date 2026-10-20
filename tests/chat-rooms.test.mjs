import {seedAccounts} from './fixtures/accounts.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {createPortalServer} from '../portal-server.mjs';

const picture=Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(4),Buffer.from('WEBPVP8 '),Buffer.alloc(32,7)]);
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'chat-rooms-')),bootstrap=join(dir,'bootstrap');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Chat-Rooms-Local-Only-2026!'}));
  const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  const origin='http://127.0.0.1:'+port;
  const {server,service}=await createPortalServer({database:join(dir,'portal.sqlite'),bootstrap,origin,secure:false,bridge:async()=>({})});
  for(const timer of ['executionTimer','notificationTimer','maintenanceTimer','transferTimer','storageArchiveTimer','projectCopyTimer'])clearInterval(service[timer]);
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const owner=service.store.users[0],[alice,bob,lin,boss]=['alice','bob','lin','boss'].map(username=>({...owner,id:'demo-user-'+username,username,name:username.toUpperCase(),role:username==='boss'?'admin':'member'}));
  seedAccounts(service,alice,bob,lin,boss);
  const token=user=>service.issueSession({userId:user.id,username:user.username,role:user.role});
  const call=(user,op,args={})=>service.invoke(token(user),'community.'+op,args).then(reply=>reply.result);
  const refused=(promise,status)=>assert.rejects(promise,error=>error.status===status);
  const send=(user,fields)=>call(user,'chat.send',{key:randomUUID(),...fields});
  const mentions=async user=>(await service.invoke(token(user),'state')).state.chatMentions;
  const fetchImage=(url,user)=>fetch(origin+url,{headers:{Authorization:'Bearer '+token(user)}});
  const {room}=await call(owner,'rooms.create',{key:randomUUID(),name:'东方的太阳'});
  return {service,owner,alice,bob,lin,boss,room,call,refused,send,mentions,fetchImage};
}

test('a private room is invisible to everyone outside it, platform admins included',async t=>{
  const f=await fixture(t);
  assert.equal(f.room.name,'东方的太阳');assert.equal(f.room.role,'owner');assert.deepEqual(f.room.members.map(m=>m.role),['owner']);
  await f.call(f.owner,'rooms.members.add',{room:f.room.id,userIds:[f.alice.id]});
  const secret=(await f.send(f.alice,{room:f.room.id,body:'只给自己人看'})).message;await f.send(f.bob,{body:'实验室消息'});
  assert.deepEqual((await f.call(f.alice,'chat.list',{room:f.room.id})).messages.map(m=>m.body),['只给自己人看']);
  for(const user of [f.alice,f.bob,f.boss])assert.deepEqual((await f.call(user,'chat.list')).messages.map(m=>m.body),['实验室消息'],'the lab chat never shows room messages');
  for(const user of [f.bob,f.boss]){
    assert.deepEqual((await f.call(user,'rooms.list')).rooms,[]);
    await f.refused(f.call(user,'chat.list',{room:f.room.id}),404);await f.refused(f.send(user,{room:f.room.id,body:'混进来'}),404);
    await f.refused(f.call(user,'chat.update',{id:secret.id,body:'改掉'}),404);await f.refused(f.call(user,'chat.delete',{id:secret.id}),404);
  }
  assert.deepEqual((await f.call(f.alice,'rooms.list')).rooms.map(r=>[r.name,r.role]),[['东方的太阳','member']]);
  assert.equal((await f.call(f.boss,'rooms.list')).canCreate,true);assert.equal((await f.call(f.alice,'rooms.list')).canCreate,false);
  await f.refused(f.call(f.alice,'rooms.create',{key:randomUUID(),name:'自己开'}),403);
});

test('the owner names room admins; admins invite and remove members but not the owner or other admins',async t=>{
  const f=await fixture(t),{room}=f;
  await f.call(f.owner,'rooms.members.add',{room:room.id,userIds:[f.alice.id,f.bob.id]});
  await f.refused(f.call(f.bob,'rooms.members.add',{room:room.id,userIds:[f.lin.id]}),403);
  await f.refused(f.call(f.alice,'rooms.members.role',{room:room.id,userId:f.bob.id,role:'admin'}),403);
  assert.equal((await f.call(f.owner,'rooms.members.role',{room:room.id,userId:f.alice.id,role:'admin'})).room.members.find(m=>m.id===f.alice.id).role,'admin');
  assert.ok((await f.call(f.alice,'rooms.members.add',{room:room.id,userIds:[f.lin.id]})).room.members.some(m=>m.id===f.lin.id),'a room admin invites');
  await f.refused(f.call(f.alice,'rooms.members.remove',{room:room.id,userId:f.owner.id}),403);
  await f.call(f.owner,'rooms.members.role',{room:room.id,userId:f.bob.id,role:'admin'});
  await f.refused(f.call(f.alice,'rooms.members.remove',{room:room.id,userId:f.bob.id}),403);
  await f.call(f.alice,'rooms.members.remove',{room:room.id,userId:f.lin.id});
  assert.deepEqual((await f.call(f.lin,'rooms.list')).rooms,[],'a removed member no longer sees the room');
  await f.refused(f.call(f.lin,'chat.list',{room:room.id}),404);
  await f.call(f.owner,'rooms.members.remove',{room:room.id,userId:f.bob.id});
  assert.deepEqual((await f.call(f.owner,'rooms.list')).rooms[0].members.map(m=>[m.username,m.role]),[['admin','owner'],['alice','admin']]);
});

test('room @mentions reach members only, clear per room, and room pictures stay inside',async t=>{
  const f=await fixture(t),{room}=f;
  await f.call(f.owner,'rooms.members.add',{room:room.id,userIds:[f.alice.id,f.bob.id]});
  const {message}=await f.send(f.owner,{room:room.id,body:'@alice @lin 看图',image:{type:'image/webp',data:picture.toString('base64'),width:320,height:200}});
  assert.equal(await f.mentions(f.lin),0,'a non-member is never notified');assert.equal(await f.mentions(f.alice),1);
  const lab=(await f.send(f.bob,{body:'@alice 实验室这边'})).message;assert.equal(await f.mentions(f.alice),2);
  const popup=await f.call(f.alice,'chat.mentions');
  assert.deepEqual(popup.messages.map(m=>m.room?.name??null),[null,'东方的太阳']);
  assert.equal((await f.call(f.alice,'rooms.list')).rooms[0].mentions,1);
  assert.equal((await f.call(f.alice,'chat.read',{id:lab.id})).chatMentions,1,'reading the lab chat leaves the room mention');
  assert.equal((await f.call(f.alice,'chat.read',{id:lab.id,room:room.id})).chatMentions,0);
  assert.equal((await f.fetchImage(message.image.url,f.bob)).status,200);
  for(const user of [f.lin,f.boss])assert.equal((await f.fetchImage(message.image.url,user)).status,404);
  await f.send(f.owner,{room:room.id,body:'@bob 还有你'});assert.equal(await f.mentions(f.bob),1);
  await f.call(f.owner,'rooms.members.remove',{room:room.id,userId:f.bob.id});assert.equal(await f.mentions(f.bob),0,'removal clears that room\'s mentions');
  await f.send(f.bob,{body:'@alice 再一次'});await f.send(f.owner,{room:room.id,body:'@alice 群里'});
  assert.equal((await f.call(f.alice,'chat.read',{id:'999999999999999',all:true})).chatMentions,0,'我知道了 clears every room');
});

test('room names are editable by owners and room admins, never by members or outsiders',async t=>{
  const f=await fixture(t),room=f.room.id;
  assert.ok((await f.call(f.owner,'info')).capabilities.includes('chat-rooms-manage-v1'));
  await f.call(f.owner,'rooms.members.add',{room,userIds:[f.alice.id,f.bob.id]});
  await f.call(f.owner,'rooms.members.role',{room,userId:f.alice.id,role:'admin'});
  assert.equal((await f.call(f.owner,'rooms.rename',{room,name:'新的太阳'})).room.name,'新的太阳');
  assert.equal((await f.call(f.alice,'rooms.rename',{room,name:'东方的月亮'})).room.name,'东方的月亮');
  await assert.rejects(f.call(f.bob,'rooms.rename',{room,name:'成员改名'}),error=>error.status===403&&error.message==='只有群主和聊天室管理员可以改名。');
  for(const user of [f.lin,f.boss])await f.refused(f.call(user,'rooms.rename',{room,name:'外人改名'}),404);
  for(const name of ['', '   ', '名'.repeat(31)])await f.refused(f.call(f.owner,'rooms.rename',{room,name}),400);
  assert.equal((await f.call(f.owner,'rooms.rename',{room,name:'名'.repeat(30)})).room.name,'名'.repeat(30));
});

test('only the owner deletes a room with its messages, images and mentions, leaving lab chat intact',async t=>{
  const f=await fixture(t),room=f.room.id;
  await f.call(f.owner,'rooms.members.add',{room,userIds:[f.alice.id,f.bob.id]});
  await f.call(f.owner,'rooms.members.role',{room,userId:f.alice.id,role:'admin'});
  const message=(await f.send(f.owner,{room,body:'@alice 一起看图',image:{type:'image/webp',data:picture.toString('base64'),width:320,height:200}})).message;
  const other=(await f.send(f.bob,{room,body:'第二条私密消息'})).message;
  const lab=(await f.send(f.lin,{body:'实验室聊天保留',image:{type:'image/webp',data:picture.toString('base64'),width:320,height:200}})).message;
  assert.equal(await f.mentions(f.alice),1);assert.equal((await f.fetchImage(message.image.url,f.alice)).status,200);
  for(const user of [f.alice,f.bob])await assert.rejects(f.call(user,'rooms.delete',{room}),error=>error.status===403&&error.message==='只有群主可以删除聊天室。');
  for(const user of [f.lin,f.boss])await f.refused(f.call(user,'rooms.delete',{room}),404);
  const result=await f.call(f.owner,'rooms.delete',{room});assert.equal(result.deleted,true);assert.equal(result.id,room);
  for(const user of [f.owner,f.alice,f.bob])assert.deepEqual((await f.call(user,'rooms.list')).rooms,[]);
  for(const table of ['community_rooms_v2','community_room_messages_v2','community_room_members_v2','community_chat_mentions_v2'])assert.equal(f.service.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,0,table);
  for(const id of [message.id,other.id]){
    assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM community_chat_v2 WHERE id=?').get(id).n,0);
    assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM community_chat_images_v2 WHERE message_id=?').get(id).n,0);
  }
  assert.equal((await f.fetchImage(message.image.url,f.owner)).status,404);assert.equal(await f.mentions(f.alice),0);
  assert.deepEqual((await f.call(f.bob,'chat.list')).messages.map(m=>m.id),[lab.id]);assert.equal((await f.fetchImage(lab.image.url,f.bob)).status,200);
  await f.refused(f.call(f.bob,'rooms.create',{key:randomUUID(),name:'普通成员不能新建'}),403);
});
