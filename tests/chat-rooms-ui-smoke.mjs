import {seedAccounts} from './fixtures/accounts.mjs';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve,extname} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {PortalService} from '../portal-service.mjs';

const temporary=await mkdtemp(join(tmpdir(),'chat-rooms-ui-')),root=resolve(import.meta.dirname,'../dist');
const shots=process.env.CHAT_SHOTS||temporary;await mkdir(shots,{recursive:true});
const bootstrap=join(temporary,'bootstrap');await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Local-Chat-Rooms-UI-2026!'}));
const service=await PortalService.open(join(temporary,'db'),bootstrap);
for(const name of ['executionTimer','notificationTimer','maintenanceTimer','transferTimer','storageArchiveTimer','projectCopyTimer'])clearInterval(service[name]);
const owner=service.store.users[0],actors={owner};
for(const [name,display] of [['alice','爱丽丝'],['bob','鲍勃'],['carol','卡罗尔']]){actors[name]={...owner,id:'demo-user-'+name,username:name,name:display,role:'member'};seedAccounts(service,actors[name]);}
const token=user=>service.issueSession({userId:user.id,username:user.username,role:user.role});
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${['styles','fonts','starbase','shell','workbench','copy-help','community','collab-room'].map(name=>'<link rel="stylesheet" href="/'+name+'.css">').join('')}
<style>body{margin:0}main{padding:16px;max-width:1280px;margin:auto;box-sizing:border-box}</style>
<body class="sb"><p id="fake-nav"><a href="#community" data-nav="community">协作</a></p><main><section id="page-community"></section></main><script type="module">
import {createCommunityUI} from '/community-ui.js';
const actor=new URL(location.href).searchParams.get('actor'),get=async(path,body)=>{const r=await fetch(path+'?actor='+actor,{method:body?'POST':'GET',...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});const value=await r.json();if(!r.ok)throw Object.assign(Error(value.error),{status:r.status});return value;};
window.calls=[];const initial=await get('/state');
const store={...initial,authGeneration:1,jobs:[],onAuthChange(){},async call(op,args={}){calls.push({op,args});return get('/call',{op,args});},async refresh(){}};
window.store=store;const renderCommunity=createCommunityUI(store,()=>{});renderCommunity(true);window.ready=true;
</script></html>`;
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost'),user=actors[url.searchParams.get('actor')];
  try{
    if(url.pathname==='/'){res.setHeader('content-type','text/html');res.end(html);return;}
    if(url.pathname==='/state'){
      const {state}=await service.invoke(token(user),'state');
      res.setHeader('content-type','application/json');res.end(JSON.stringify({principal:{userId:user.id,role:user.role,username:user.username},users:service.store.users,data:{chatMentions:state.chatMentions}}));return;
    }
    if(url.pathname==='/call'){
      let text='';for await(const bytes of req)text+=bytes;const {op,args}=JSON.parse(text);
      const reply=await service.invoke(token(user),op,args);res.setHeader('content-type','application/json');res.end(JSON.stringify(reply.result));return;
    }
    const file=resolve(root,'.'+url.pathname);if(!file.startsWith(root+'/')){res.writeHead(404).end();return;}
    const value=await readFile(file);res.setHeader('content-type',extname(file)==='.js'?'text/javascript':extname(file)==='.css'?'text/css':'application/octet-stream');res.end(value);
  }catch(error){res.writeHead(error.status||404,{'content-type':'application/json'});res.end(JSON.stringify({error:error.message}));}
});
let browser;
async function open(width,name){
  const page=await browser.newPage({viewport:{width,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',dialog=>dialog.accept());
  await page.goto('http://127.0.0.1:'+server.address().port+'/?actor='+name);await page.waitForFunction(()=>window.ready);
  if(await page.locator('[data-community-tab="chat"]').isVisible())await page.locator('[data-community-tab="chat"]').click();
  await page.waitForFunction(()=>!document.querySelector('#community-chat-body').disabled&&document.querySelector('#community-messages .community-empty,#community-messages .chat-message')&&window.calls.some(c=>c.op==='community.rooms.list'));
  await page.waitForTimeout(100);
  return {page,errors};
}
const chips=page=>page.locator('.chat-room').allTextContents();
const bodies=page=>page.locator('#community-messages .community-body').allTextContents();
const fits=async(page,width)=>{assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no sideways page scroll');};
try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({headless:true,...process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}});
  for(const width of [1440,390,320]){
    for(const table of ['community_chat_v2','community_chat_images_v2','community_chat_mentions_v2','community_rooms_v2','community_room_members_v2','community_room_messages_v2'])service.db.exec('DELETE FROM '+table);
    await service.invoke(token(actors.carol),'community.chat.send',{key:randomUUID(),body:'实验室里大家好'});
    // The owner creates the room from the chat and invites two people.
    const boss=await open(width,'owner');
    assert.deepEqual(await chips(boss.page),['实验室聊天','+ 私密聊天室']);
    await boss.page.locator('.chat-room-new').click();const dialog=boss.page.locator('.chat-room-dialog');await dialog.waitFor({state:'visible'});
    await dialog.locator('[name=name]').fill('东方的太阳');
    for(const name of ['爱丽丝','鲍勃'])await dialog.locator('label',{hasText:name}).locator('input').check();
    let box=await dialog.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width,'the dialog fits the screen');
    await boss.page.screenshot({path:join(shots,`room-create-${width}.png`)});
    await dialog.locator('#chat-room-submit').click();await dialog.waitFor({state:'hidden'});
    await boss.page.waitForFunction(()=>document.querySelector('#chat-room-title').textContent==='东方的太阳');
    assert.deepEqual(await chips(boss.page),['实验室聊天','东方的太阳','+ 私密聊天室']);assert.equal(await boss.page.locator('#chat-room-private').isVisible(),true);
    assert.deepEqual(await bodies(boss.page),[],'a new room starts empty');
    // @ inside the room suggests room members only.
    const input=boss.page.locator('#community-chat-body');await input.click();await input.pressSequentially('@');
    await boss.page.locator('.chat-mention-list').waitFor({state:'visible'});
    assert.deepEqual((await boss.page.locator('.chat-mention-option').allTextContents()).map(t=>t.replace(/@?(alice|bob)$/,'')).sort(),['爱丽丝','鲍勃'].sort());
    await input.press('Escape');await input.fill('@alice 欢迎来到东方的太阳');await input.press('Enter');
    await boss.page.waitForFunction(()=>document.querySelectorAll('#community-messages .chat-message').length===1);
    // The owner makes alice a room admin.
    await boss.page.locator('#chat-room-members').click();await dialog.waitFor({state:'visible'});
    assert.equal(await dialog.locator('.chat-room-member-list li').count(),3);
    await dialog.locator('li',{hasText:'爱丽丝'}).getByRole('button',{name:'设为管理员'}).click();
    await dialog.locator('li',{hasText:'爱丽丝'}).locator('.community-tag',{hasText:'管理员'}).waitFor();
    box=await dialog.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width);
    await boss.page.screenshot({path:join(shots,`room-members-${width}.png`)});
    await dialog.locator('.modal-head [data-room-close]').click();
    await boss.page.locator('.chat-room',{hasText:'实验室聊天'}).click();await boss.page.waitForFunction(()=>document.querySelector('#chat-room-title').textContent==='实验室聊天');
    await boss.page.waitForFunction(()=>[...document.querySelectorAll('#community-messages .community-body')].map(n=>n.textContent).join()==='实验室里大家好');
    await fits(boss.page,width);
    // alice sees the room with her @, reads it, and removes bob as a room admin.
    const alice=await open(width,'alice');
    assert.deepEqual(await chips(alice.page),['实验室聊天','东方的太阳@1']);
    await alice.page.locator('.chat-room',{hasText:'东方的太阳'}).click();
    await alice.page.waitForFunction(()=>document.querySelector('.chat-message.mentions-me'));
    await alice.page.waitForFunction(()=>calls.some(c=>c.op==='community.chat.read'&&c.args.room));
    await alice.page.waitForFunction(()=>!document.querySelector('.chat-room-mention'));
    await alice.page.locator('#chat-room-members').click();const aliceDialog=alice.page.locator('.chat-room-dialog');await aliceDialog.waitFor({state:'visible'});
    assert.equal(await aliceDialog.getByRole('button',{name:'设为管理员'}).count(),0,'only the owner names admins');
    assert.equal(await aliceDialog.locator('.chat-room-member-list li').first().getByRole('button').count(),0,'nobody removes the owner');
    await aliceDialog.locator('li',{hasText:'鲍勃'}).getByRole('button',{name:'移出'}).click();
    await aliceDialog.locator('li',{hasText:'鲍勃'}).waitFor({state:'detached'});
    assert.ok(await aliceDialog.locator('.chat-room-candidates label',{hasText:'鲍勃'}).count(),'bob can be invited again');
    await alice.page.screenshot({path:join(shots,`room-admin-${width}.png`)});
    await aliceDialog.locator('.modal-head [data-room-close]').click();await fits(alice.page,width);
    await alice.page.screenshot({path:join(shots,`room-chat-${width}.png`),fullPage:true});
    // Outsiders see neither the room nor its messages.
    for(const name of ['bob','carol']){
      const other=await open(width,name);
      assert.equal(await other.page.locator('#chat-rooms').isVisible(),false,name+' sees no room switcher');
      assert.deepEqual(await bodies(other.page),['实验室里大家好']);await fits(other.page,width);
      assert.deepEqual(other.errors,[]);await other.page.close();
    }
    assert.deepEqual([...boss.errors,...alice.errors],[]);await boss.page.close();await alice.page.close();
    console.log('PASS chat rooms '+width+': create, invite, room-only @, owner names admin, admin removes member, outsiders see nothing');
  }
}finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));service.close();await rm(temporary,{recursive:true,force:true});}
