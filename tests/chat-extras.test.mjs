import {seedAccounts} from './fixtures/accounts.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {createPortalServer} from '../portal-server.mjs';
import {COMMUNITY_LIMITS} from '../community.mjs';
import {formatCommunityResult} from '../community-cli.mjs';
import {chatSegments,mentionedUsers} from '../dist/chat-content.js';

const picture=Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(4),Buffer.from('WEBPVP8 '),Buffer.alloc(32,7)]);
const image=(bytes=picture)=>({type:'image/webp',data:bytes.toString('base64'),width:320,height:200});
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'chat-extras-')),bootstrap=join(dir,'bootstrap');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Chat-Extras-Local-Only-2026!'}));
  const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  const origin='http://127.0.0.1:'+port;
  const {server,service}=await createPortalServer({database:join(dir,'portal.sqlite'),bootstrap,origin,secure:false,bridge:async()=>({})});
  for(const timer of ['executionTimer','notificationTimer','maintenanceTimer','transferTimer','storageArchiveTimer','projectCopyTimer'])clearInterval(service[timer]);
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const admin=service.store.users[0],[alice,bob,lin]=['alice','bob','lin'].map(username=>({...admin,id:'demo-user-'+username,username,name:username.toUpperCase(),role:'member'}));
  seedAccounts(service,alice,bob,lin);
  const token=user=>service.issueSession({userId:user.id,username:user.username,role:user.role});
  const call=(user,op,args={})=>service.invoke(token(user),'community.'+op,args).then(reply=>reply.result);
  const send=(user,fields)=>call(user,'chat.send',{key:randomUUID(),...fields});
  const mentions=async user=>(await service.invoke(token(user),'state')).state.chatMentions;
  const fetchImage=(url,user)=>fetch(origin+url,{headers:user?{Authorization:'Bearer '+token(user)}:{}});
  return {service,alice,bob,lin,call,send,mentions,fetchImage};
}

test('a picture-only message is listed with its size and served once, cacheable, to logged-in members',async t=>{
  const f=await fixture(t),{message}=await f.send(f.alice,{image:image()});
  assert.equal(message.body,'');assert.deepEqual(message.image,{url:'/community/chat-images/'+message.id,width:320,height:200});
  const listed=(await f.call(f.bob,'chat.list')).messages.at(-1);assert.deepEqual(listed.image,message.image);
  const reply=await f.fetchImage(message.image.url,f.bob);
  assert.equal(reply.status,200);assert.equal(reply.headers.get('content-type'),'image/webp');
  assert.match(reply.headers.get('cache-control'),/immutable/);assert.equal(reply.headers.get('x-content-type-options'),'nosniff');
  assert.deepEqual(Buffer.from(await reply.arrayBuffer()),picture);
  assert.equal((await f.fetchImage(message.image.url)).status,401,'anonymous visitors never get chat pictures');
  assert.equal(formatCommunityResult({messages:[message]}).includes('[图片，请在网页查看]'),true,'the CLI says a picture is there');
});

test('text with a picture keeps its text; deleting the message removes the picture',async t=>{
  const f=await fixture(t),{message}=await f.send(f.alice,{body:'训练曲线',image:image()});
  assert.equal(message.body,'训练曲线');
  await f.call(f.alice,'chat.delete',{id:message.id});
  assert.equal((await f.fetchImage(message.image.url,f.bob)).status,404);
  assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM community_chat_images_v2').get().n,0);
});

test('empty messages, unknown picture types and oversized pictures are refused with a plain reason',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.send(f.alice,{body:'  '}),error=>error.status===400);
  await assert.rejects(f.send(f.alice,{image:{...image(),type:'image/svg+xml'}}),/PNG、JPEG 或 WebP/);
  await assert.rejects(f.send(f.alice,{image:image(Buffer.alloc(COMMUNITY_LIMITS.chatImageBytes+1))}),/不超过 700 KB/);
  assert.equal((await f.call(f.alice,'chat.list')).messages.length,0);
});

test('past the picture total the oldest pictures go first, with any picture-only message',async t=>{
  const f=await fixture(t),old=(await f.send(f.alice,{image:image()})).message,captioned=(await f.send(f.alice,{body:'留着文字',image:image()})).message;
  // Pretend the stored pictures already fill the disk allowance.
  const size=f.service.db.prepare('UPDATE community_chat_images_v2 SET size=? WHERE message_id=?');
  size.run(1,Number(old.id));size.run(COMMUNITY_LIMITS.chatImagesTotalBytes,Number(captioned.id));
  const fresh=(await f.send(f.bob,{image:image()})).message;
  const rows=(await f.call(f.bob,'chat.list')).messages;
  assert.deepEqual(rows.map(row=>row.id),[captioned.id,fresh.id],'the picture-only message went with its picture');
  assert.equal(rows[0].image,undefined);assert.equal(rows[0].body,'留着文字');assert.ok(rows[1].image);
  assert.equal((await f.fetchImage(old.image.url,f.bob)).status,404);
});

test('@username notifies that member until they read the chat; self and partial names are not mentions',async t=>{
  const f=await fixture(t);
  const {message}=await f.send(f.alice,{body:'@bob 看下 @alice 的卡，@linx 不是人，@lin，好'});
  assert.equal(await f.mentions(f.bob),1);assert.equal(await f.mentions(f.lin),1);assert.equal(await f.mentions(f.alice),0);
  await f.send(f.alice,{body:'@bob 再看一次'});assert.equal(await f.mentions(f.bob),2);
  assert.equal((await f.call(f.bob,'chat.read',{id:message.id})).chatMentions,1,'reading up to a message clears only up to it');
  const last=(await f.call(f.bob,'chat.list')).messages.at(-1);
  assert.equal((await f.call(f.bob,'chat.read',{id:last.id})).chatMentions,0);
  await f.call(f.alice,'chat.update',{id:message.id,body:'改成不提人'});assert.equal(await f.mentions(f.lin),0,'editing a mention away clears it');
});

test('mention parsing prefers the longest username and needs a word boundary',()=>{
  const users=[{id:'1',username:'li'},{id:'2',username:'lin'},{id:'3',username:'张三'}];
  assert.deepEqual(mentionedUsers('@lin 和 @li，还有 @张三 好',users).map(user=>user.id),['2','1','3']);
  assert.deepEqual(mentionedUsers('@张三你好 a@lin2',users),[]);
  assert.deepEqual(chatSegments('hi @lin!',users).map(part=>[part.text,part.user?.id]),[['hi ',undefined],['@lin','2'],['!',undefined]]);
});
