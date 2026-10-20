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
${['styles','fonts','starbase','shell','workbench','jobs-room','copy-help','community','collab-room'].map(name=>'<link rel="stylesheet" href="/'+name+'.css">').join('')}
<style nonce="chat-fixture">body{margin:0}main{padding:16px;max-width:1280px;margin:auto;box-sizing:border-box}</style>
<body class="sb"><p id="fake-nav"><a href="#community" data-nav="community">协作</a></p><main><section id="page-community"></section></main><script type="module">
import {createCommunityUI} from '/community-ui.js';
const actor=new URL(location.href).searchParams.get('actor'),get=async(path,body)=>{const r=await fetch(path+'?actor='+actor,{method:body?'POST':'GET',...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});const value=await r.json();if(!r.ok)throw Object.assign(Error(value.error),{status:r.status});return value;};
window.calls=[];window.toasts=[];const initial=await get('/state');
const store={...initial,authGeneration:1,jobs:[],onAuthChange(){},async call(op,args={}){calls.push({op,args});return get('/call',{op,args});},async refresh(){}};
window.store=store;const renderCommunity=createCommunityUI(store,text=>window.toasts.push(text));renderCommunity(true);window.community=renderCommunity;window.ready=true;
</script></html>`;
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost'),user=actors[url.searchParams.get('actor')];
  try{
    if(url.pathname==='/'){res.setHeader('content-type','text/html');res.setHeader('Content-Security-Policy',"style-src 'self' 'nonce-chat-fixture'");res.end(html);return;}
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
  if(width<900)await page.locator('[data-community-tab="chat"]').click();
  await page.waitForFunction(()=>!document.querySelector('#community-chat-body').disabled&&document.querySelector('#community-messages .community-empty,#community-messages .chat-message')&&window.calls.some(c=>c.op==='community.rooms.list'));
  await page.waitForTimeout(100);
  return {page,errors};
}
const chips=page=>page.locator('.chat-room[role=tab]');
const roomChip=(page,id)=>page.locator(`.chat-room[data-room-id="${id}"]`);
const bodies=page=>page.locator('#community-messages .community-body').allTextContents();
const fits=async page=>{assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no sideways page scroll');};
async function createRoom(page,name,invited=[]){
  await page.locator('.chat-room-new').click();const dialog=page.locator('.chat-room-dialog');await dialog.waitFor({state:'visible'});
  await dialog.locator('[name=name]').fill(name);
  for(const who of invited)await dialog.locator('label',{hasText:who}).locator('[name=invite]').check();
  await dialog.locator('#chat-room-submit').click();await dialog.waitFor({state:'hidden'});
  await page.waitForFunction(name=>document.querySelector('.chat-room[aria-selected=true] .chat-room-name')?.textContent===name,name);
  assert.equal(await page.locator('#chat-room-title').textContent(),name);
  return page.locator('.chat-room[aria-selected=true]').getAttribute('data-room-id');
}
async function settings(page){await page.locator('#chat-room-settings').click();const dialog=page.locator('.chat-room-dialog');await dialog.waitFor({state:'visible'});return dialog;}
async function shot(page,width,state){await fits(page);await page.screenshot({path:join(shots,`room-${state}-${width}.png`),animations:'disabled'});}
try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({headless:true,...process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}});
  for(const width of [1440,390,320]){
    for(const table of ['community_chat_v2','community_chat_images_v2','community_chat_mentions_v2','community_rooms_v2','community_room_members_v2','community_room_messages_v2'])service.db.exec('DELETE FROM '+table);
    await service.invoke(token(actors.carol),'community.chat.send',{key:randomUUID(),body:'实验室里大家好'});
    const boss=await open(width,'owner'),page=boss.page;
    assert.deepEqual(await chips(page).allTextContents(),['实验室聊天']);assert.equal(await roomChip(page,'').getAttribute('aria-selected'),'true');
    assert.equal(await page.locator('#chat-room-title').textContent(),'实验室聊天');assert.equal(await page.locator('#chat-room-settings').isVisible(),false);
    assert.equal(await page.locator('#chat-room-private').isVisible(),false);
    const first=await createRoom(page,'东方的太阳',['爱丽丝','鲍勃']);
    assert.equal(await roomChip(page,'').getAttribute('aria-selected'),'false');assert.equal(await page.locator('.chat-room[aria-selected=true]').count(),1);
    assert.equal(await page.locator('#chat-room-private').isVisible(),true);assert.equal(await page.locator('#chat-room-settings').isVisible(),true);
    assert.equal(await page.locator('#chat-room-title').locator('..').locator('[data-copy-help]').isVisible(),true,'chat help stays visible in private rooms');
    assert.deepEqual(await bodies(page),[],'a new room starts empty');
    const input=page.locator('#community-chat-body');await input.click();await input.pressSequentially('@');
    await page.locator('.chat-mention-list').waitFor({state:'visible'});
    assert.deepEqual((await page.locator('.chat-mention-option').allTextContents()).map(t=>t.replace(/@?(alice|bob)$/,'')).sort(),['爱丽丝','鲍勃'].sort());
    await input.press('Escape');await input.fill('@alice 欢迎来到东方的太阳');await input.press('Enter');
    await page.waitForFunction(()=>document.querySelectorAll('#community-messages .chat-message').length===1);
    let dialog=await settings(page);
    assert.equal(await dialog.locator('.chat-room-member-list li').count(),3);
    await dialog.locator('li',{hasText:'爱丽丝'}).getByRole('button',{name:'设为管理员'}).click();
    await dialog.locator('li',{hasText:'爱丽丝'}).locator('.community-tag',{hasText:'管理员'}).waitFor();
    await dialog.locator('[name=name]').fill('东方的新太阳');await dialog.locator('#chat-room-rename').click();
    await page.waitForFunction(()=>document.querySelector('#chat-room-title').textContent==='东方的新太阳');
    assert.equal(await roomChip(page,first).locator('.chat-room-name').textContent(),'东方的新太阳');
    await dialog.locator('[name=name]').fill(' 东方的晨光 ');await dialog.locator('[name=name]').press('Enter');
    await page.waitForFunction(()=>document.querySelector('#chat-room-title').textContent==='东方的晨光');
    assert.equal(await roomChip(page,first).locator('.chat-room-name').textContent(),'东方的晨光');
    assert.equal(await dialog.locator('#chat-room-error').textContent(),'');
    assert.equal(await dialog.locator('#chat-room-delete').isVisible(),true);
    const box=await dialog.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width,'the dialog fits the screen');
    await shot(page,width,'owner-settings');await dialog.locator('.modal-head [data-room-close]').click();
    await shot(page,width,'selected-private');
    await roomChip(page,'').click();
    await page.waitForFunction(()=>[...document.querySelectorAll('#community-messages .community-body')].map(n=>n.textContent).join()==='实验室里大家好');
    assert.equal(await page.locator('#chat-room-title').textContent(),'实验室聊天');assert.equal(await page.locator('#chat-room-settings').isVisible(),false);assert.equal(await page.locator('#chat-room-private').isVisible(),false);
    assert.equal(await page.evaluate(()=>window.community.chatOpen()),true);
    await page.evaluate(id=>window.community.showChat(id),first);assert.equal(await roomChip(page,first).getAttribute('aria-selected'),'true');
    await page.waitForFunction(()=>document.querySelector('#community-messages .community-body')?.textContent.includes('欢迎来到东方的太阳'));
    let last;
    const longName='很长的聊天室名称'.repeat(3).slice(0,30);
    for(let index=0;index<8;index++)last=await createRoom(page,index===7?longName:'更多聊天室 '+(index+1));
    assert.equal(await chips(page).count(),10);assert.equal(await page.locator('.chat-room[aria-selected=true]').count(),1);
    await roomChip(page,'').click();await roomChip(page,last).click();
    const row=await page.locator('#chat-rooms').evaluate(node=>{
      const rect=node.getBoundingClientRect(),buttons=[...node.children].map(button=>button.getBoundingClientRect()),chosen=node.querySelector('[aria-selected=true]').getBoundingClientRect();
      return {scrollWidth:node.scrollWidth,clientWidth:node.clientWidth,height:rect.height,tops:buttons.map(b=>b.top),buttonHeight:buttons[0].height,left:rect.left,right:rect.right,chosenLeft:chosen.left,chosenRight:chosen.right};
    });
    assert.ok(row.scrollWidth>row.clientWidth,'many rooms scroll horizontally');
    assert.ok(row.tops.every(top=>Math.abs(top-row.tops[0])<1),'all buttons stay on one row');
    assert.ok(row.height<row.buttonHeight*2,'the switcher is only one row tall');
    assert.ok(row.chosenLeft>=row.left&&row.chosenRight<=row.right,'the selected last room is fully visible in the row');
    assert.equal(await roomChip(page,last).getAttribute('title'),longName);
    assert.equal(await page.locator('#chat-room-title').evaluate(node=>getComputedStyle(node).whiteSpace),'nowrap');
    assert.equal(await roomChip(page,last).locator('.chat-room-name').evaluate(node=>getComputedStyle(node).textOverflow),'ellipsis');
    await shot(page,width,'many');
    await page.emulateMedia({reducedMotion:'reduce'});await roomChip(page,first).click();
    await page.waitForFunction(()=>document.querySelector('#community-messages .chat-message'));
    assert.equal(await page.locator('#community-messages').evaluate(node=>node.getAnimations({subtree:true}).length),0);
    assert.equal(await roomChip(page,first).evaluate(node=>getComputedStyle(node).transitionDuration),'0s');
    await page.emulateMedia({reducedMotion:'no-preference'});
    // A normal member sees the list only; a room admin can rename and remove members.
    const bob=await open(width,'bob');await roomChip(bob.page,first).click();const bobDialog=await settings(bob.page);
    assert.equal(await bobDialog.locator('#chat-room-name-field').isVisible(),false);assert.equal(await bobDialog.locator('#chat-room-rename').isVisible(),false);assert.equal(await bobDialog.locator('#chat-room-delete').isVisible(),false);
    assert.equal(await bobDialog.locator('.chat-room-member-actions button').count(),0);await fits(bob.page);await bobDialog.locator('.modal-head [data-room-close]').click();
    const alice=await open(width,'alice');assert.match((await roomChip(alice.page,first).textContent()),/@1/);
    await roomChip(alice.page,first).click();await alice.page.waitForFunction(()=>document.querySelector('.chat-message.mentions-me'));
    await alice.page.waitForFunction(()=>calls.some(c=>c.op==='community.chat.read'&&c.args.room));await alice.page.waitForFunction(()=>!document.querySelector('.chat-room-mention'));
    const aliceDialog=await settings(alice.page);
    assert.equal(await aliceDialog.locator('#chat-room-name-field').isVisible(),true);assert.equal(await aliceDialog.locator('#chat-room-rename').isVisible(),true);assert.equal(await aliceDialog.locator('#chat-room-delete').isVisible(),false);
    assert.equal(await aliceDialog.getByRole('button',{name:'设为管理员'}).count(),0,'only the owner names admins');
    assert.equal(await aliceDialog.locator('.chat-room-member-list li').first().getByRole('button').count(),0,'nobody removes the owner');
    await aliceDialog.locator('li',{hasText:'鲍勃'}).getByRole('button',{name:'移出'}).click();await aliceDialog.locator('li',{hasText:'鲍勃'}).waitFor({state:'detached'});
    assert.ok(await aliceDialog.locator('.chat-room-candidates label',{hasText:'鲍勃'}).count(),'bob can be invited again');
    await shot(alice.page,width,'admin-settings');await aliceDialog.locator('.modal-head [data-room-close]').click();
    await bob.page.waitForFunction(()=>toasts.includes('这个聊天室已不可用，已回到实验室聊天。'));
    assert.equal(await roomChip(bob.page,'').getAttribute('aria-selected'),'true');assert.equal(await roomChip(bob.page,first).count(),0);
    assert.equal(await bob.page.locator('#chat-rooms').isVisible(),false);
    await bob.page.waitForFunction(()=>[...document.querySelectorAll('#community-messages .community-body')].map(node=>node.textContent).join()==='实验室里大家好');assert.deepEqual(await bodies(bob.page),['实验室里大家好']);
    const carol=await open(width,'carol');assert.equal(await carol.page.locator('#chat-rooms').isVisible(),false);assert.equal(await roomChip(carol.page,first).count(),0);assert.equal(await carol.page.locator('.chat-room-new').count(),0);
    assert.deepEqual(await bodies(carol.page),['实验室里大家好']);await fits(carol.page);
    // Room removal falls back immediately for its owner and after refresh for a member.
    await roomChip(page,first).click();dialog=await settings(page);await dialog.locator('#chat-room-delete').click();await dialog.waitFor({state:'hidden'});
    assert.equal(await roomChip(page,first).count(),0);assert.equal(await roomChip(page,'').getAttribute('aria-selected'),'true');assert.equal(await page.locator('#chat-room-title').textContent(),'实验室聊天');
    assert.equal(await page.evaluate(()=>toasts.includes('已删除聊天室。')),true);
    await alice.page.reload();await alice.page.waitForFunction(()=>window.ready);
    if(width<900)await alice.page.locator('[data-community-tab="chat"]').click();
    await alice.page.waitForFunction(()=>calls.some(c=>c.op==='community.rooms.list'));
    assert.equal(await roomChip(alice.page,first).count(),0);
    for(const result of [boss,alice,bob,carol]){await fits(result.page);assert.deepEqual(result.errors,[]);await result.page.close();}
    console.log('PASS chat rooms '+width+': one-row switching, scrolling, rename/Enter/delete, roles, mentions, removal fallback, reduced motion and no overflow');
  }
}finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));service.close();await rm(temporary,{recursive:true,force:true});}
