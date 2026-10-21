// Exercise the actual app shell with synthetic chat data, including poll timing.
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join,resolve,extname} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';
const root=resolve(import.meta.dirname,'../dist'),temporary=await mkdtemp(join(tmpdir(),'chat-layout-'));
const shots=process.env.CHAT_SHOTS||temporary;await mkdir(shots,{recursive:true});
const origin='https://chat-layout.test',metrics=[];
const browser=await chromium.launch({headless:true,...process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}});
try{
 for(const [width,height,ratio] of [[1440,900,.6],[390,844,.55],[320,568,.4]]){
  const owner={id:'member-a',username:'alice',name:'成员甲',role:'admin',enabled:true},peer={id:'member-b',username:'bob',name:'成员乙',role:'member',enabled:true};
  const principal={userId:owner.id,username:owner.username,role:owner.role},users=[owner,peer];
  const state={machines:[],users,jobs:[],executionEnabled:true,execution:{},gpuq:{stale:false,hosts:[]},announcements:{pending:[]},operationalMaintenance:{global:null,machines:{}},transfers:{}};
  const today=new Date();today.setHours(10,0,0,0);const when=(minutes=0)=>new Date(+today+minutes*60000).toISOString();
  const yesterday=new Date(today);yesterday.setDate(today.getDate()-1);
  const row=(id,author,body,createdAt=when(Number(id)))=>({id:String(id),author,body,createdAt,canEdit:author===owner,canDelete:author===owner});
  const messages=[row(1,peer,'昨天的实验已经完成。',yesterday.toISOString()),row(2,peer,'今天继续整理训练结果。'),row(3,peer,'第一轮已经跑完。'),row(4,peer,'指标放在项目输出里。'),row(5,owner,'收到，我来整理对照实验。'),row(6,peer,'图片和结果一起发给大家。'),{...row(7,peer,'示例图片'),image:{url:'/fixture-picture.svg',width:160,height:64}},row(8,peer,'@alice 这组结果请帮忙看一下。')];
  const rooms=[{id:'1',name:'东方的太阳',members:users,mentions:0,role:'owner'},{id:'2',name:'新的讨论',members:users,mentions:0,role:'owner'}],notes=[],calls=[],errors=[];let earlier=false;
  async function rpc(op,args){
   calls.push({op,args});if(op==='state')return {principal,state};
   if(op==='community.rooms.list')return {rooms,canCreate:true};
   if(op==='community.posts.list')return {posts:[{id:'post-1',kind:'discussion',title:'今天的实验安排',body:'一起交流训练进展。',author:peer,createdAt:when(),commentCount:0}],nextCursor:null};
   if(op==='community.chat.list'){
    if(args.before)return {messages:[row(0,peer,'更早的讨论',yesterday.toISOString())],nextCursor:null,hasMore:false};
    const source=args.room==='2'?[]:args.room==='1'?[row(100,peer,'只有聊天室成员能看到这条消息。')]:messages;
    const items=args.after?source.filter(m=>Number(m.id)>Number(args.after)):source;
    return {messages:items,latestCursor:source.at(-1)?.id||null,nextCursor:(args.after?items.at(-1)?.id:items[0]?.id)||null,hasMore:earlier&&!args.after&&!args.room};
   }
   if(op==='community.chat.read')return {chatMentions:0};
   if(op==='community.chat.send'){const message=row(Number(messages.at(-1).id)+1,owner,args.body,new Date().toISOString());messages.push(message);return {message};}
   if(op==='community.notes.list')return {notes,nextCursor:null};
   if(op==='community.notes.create'){const note={id:'note-1',body:args.body,author:owner,createdAt:when(),canEdit:true,canDelete:true};notes.push(note);return {note};}
   if(op==='workshop.mine')return {installed:[]};
   if(op==='transfers.list')return {transfers:[],nextCursor:null};
   if(op==='storage.snapshot')return {machines:[]};
   if(op==='cloud.import.list')return {imports:[]};
   throw Error('Unexpected RPC '+op);
  }
  const context=await browser.newContext({viewport:{width,height},hasTouch:width<900,isMobile:width<900,reducedMotion:'reduce'}),page=await context.newPage();page.setDefaultTimeout(15000);
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/Content Security Policy/.test(m.text()))errors.push(m.text());});
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());assert.equal(url.origin,origin);
   try{
    if(url.pathname==='/'){let html=await readFile(join(root,'index.html'),'utf8');html=html.replace('globalThis.GPUQ_LOCAL_API=false;','globalThis.GPUQ_LOCAL_API=true;globalThis.GPUQ_PRODUCTION=true;globalThis.GPUQ_HAS_SESSION=true;');return route.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':"style-src 'self'"},body:html});}
    if(url.pathname==='/machines.js')return route.fulfill({contentType:'text/javascript',body:'export const MACHINES=[]'});
    if(url.pathname==='/fixture-picture.svg')return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="160" height="64"><rect width="160" height="64" fill="#242526"/><path d="M8 52 40 30 72 40 105 16 152 8" fill="none" stroke="#F2F2EF" stroke-width="2"/><text x="8" y="16" fill="#F2F2EF" font-size="10">Training / fixture</text></svg>'});
    if(url.pathname.startsWith('/api/')){const body=route.request().postDataJSON(),result=await rpc(body.operation,body.args||{});return route.fulfill({contentType:'application/json',body:JSON.stringify(body.operation==='state'?result:{ok:true,result})});}
    const file=resolve(root,'.'+url.pathname);assert.ok(file.startsWith(root+'/'));return route.fulfill({contentType:extname(file)==='.js'?'text/javascript':extname(file)==='.css'?'text/css':'application/octet-stream',body:await readFile(file)});
   }catch(e){errors.push(e.message);return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:e.message})});}
  });
  await page.goto(origin+'/#community');await page.locator('#startup-wordmark').waitFor({state:'hidden'});await page.emulateMedia({reducedMotion:'no-preference'});
  if(width<900)await page.getByRole('tab',{name:'聊天',exact:true}).click();
  await page.locator('[data-message-id="8"]').waitFor();await page.waitForTimeout(1000);
  const fit=await page.evaluate(()=>{const c=document.querySelector('#community-chat').getBoundingClientRect(),m=document.querySelector('#community-messages').getBoundingClientRect();return {width:innerWidth,height:innerHeight,top:c.top,card:c.height,messages:m.height,bottom:c.bottom,overflow:document.documentElement.scrollWidth>innerWidth};});
  assert.ok(await page.locator('#community-chat>.chat-topline').evaluate(n=>n.getBoundingClientRect().height<=54));
  assert.ok((await page.locator('.chat-room').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().height))).every(h=>h===32));
  metrics.push(fit);assert.ok(fit.messages/fit.card>=ratio,JSON.stringify(fit));assert.equal(fit.overflow,false);if(width>=900)assert.ok(fit.bottom<=height,JSON.stringify(fit));
  assert.equal(await page.locator('#community-chat #community-task-notes').count(),0);assert.equal(await page.locator('#community-forum #community-task-notes').count(),1);
  const input=page.locator('#community-chat-body'),send=page.getByRole('button',{name:'发送消息',exact:true});
  const inputRow=await page.locator('#community-chat-form').evaluate(form=>['.chat-tools button:first-child','.chat-tools button:nth-child(2)','textarea','[type=submit]'].map(s=>{const r=form.querySelector(s).getBoundingClientRect();return {top:r.top,width:r.width};}));
  assert.ok(Math.max(...inputRow.map(r=>r.top))-Math.min(...inputRow.map(r=>r.top))<4,JSON.stringify(inputRow));if(width===320)assert.ok(inputRow[2].width>=140,JSON.stringify(inputRow));
  assert.ok(Number(await send.evaluate(n=>getComputedStyle(n).opacity))<.5);
  assert.deepEqual(await page.locator('.chat-day').allTextContents(),['昨天','今天']);
  for(const id of [2,6]){assert.equal(await page.locator(`[data-message-id="${id}"] .chat-author`).count(),1);assert.equal(await page.locator(`[data-message-id="${id}"] .chat-avatar`).count(),1);}
  for(const id of [3,4]){assert.equal(await page.locator(`[data-message-id="${id}"] .chat-author`).count(),0);assert.equal(await page.locator(`[data-message-id="${id}"] .chat-avatar`).count(),0);assert.ok(await page.locator(`[data-message-id="${id}"]`).getAttribute('title'));}
  const own=page.locator('[data-message-id="5"]'),actions=own.locator('.community-item-actions');await page.mouse.move(0,0);
  if(await page.evaluate(()=>matchMedia('(hover:hover)').matches)){
   await page.locator('#community-messages').focus();await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-message-id="5"] .community-item-actions')).opacity==='0');
   await own.hover();await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-message-id="5"] .community-item-actions')).opacity==='1');
   await page.mouse.move(0,0);await page.locator('#community-messages').focus();await page.keyboard.press('Tab');await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-message-id="5"] .community-item-actions')).opacity==='1');
   assert.equal(await own.locator('button:focus').count(),1);
  }else assert.equal(await actions.evaluate(n=>getComputedStyle(n).opacity),'1','touch actions remain visible');
  await input.focus();await page.mouse.move(0,0);await page.waitForTimeout(1000);
  const shot=async name=>{assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:join(shots,`chat-${name}-${width}.png`),animations:'disabled'});};
  await page.locator('#community-messages').evaluate(n=>n.scrollTop=0);await shot('lab');await page.locator('#community-messages').evaluate(n=>n.scrollTop=n.scrollHeight);await shot('lab-bottom');
  await page.evaluate(()=>{window.chatAnimations=[];document.querySelector('#community-messages').addEventListener('animationstart',event=>{window.chatAnimations.push({name:event.animationName,id:event.target.dataset.messageId,active:document.querySelector('#community-messages').getAnimations({subtree:true}).filter(a=>a.playState==='running').map(a=>({id:a.effect.target.closest('[data-message-id]')?.dataset.messageId,name:a.animationName}))});});});
  // Capture animationstart in the browser so a slow runner cannot miss a 240ms animation.
  // Wait for the genuine five-second poll; never call the rendering code from the test.
  messages.push(row(9,peer,'轮询带来的一条新消息。'));await page.locator('[data-message-id="9"]').waitFor();
  await page.waitForFunction(()=>window.chatAnimations.some(a=>a.id==='9'));
  assert.deepEqual(await page.evaluate(()=>window.chatAnimations.find(a=>a.id==='9').active),[{id:'9',name:'jr-rise'}]);
  await page.waitForTimeout(300);await input.fill('我的新消息');await input.press('Enter');await page.locator('[data-message-id="10"]').waitFor();
  await page.waitForFunction(()=>window.chatAnimations.some(a=>a.id==='10'&&a.name==='chat-sent'));
  await page.locator('.chat-room[data-room-id="1"]').click();await page.waitForFunction(()=>window.chatAnimations.some(a=>a.name==='sb-swap'));
  assert.equal(await page.locator('#community-messages .is-new').count(),0);await page.getByRole('button',{name:'成员与设置',exact:true}).waitFor();assert.equal(await page.locator('#chat-room-count').textContent(),'2');await shot('private');
  await page.locator('.chat-room[data-room-id="2"]').click();await page.locator('.chat-empty strong',{hasText:'这是「新的讨论」的开始'}).waitFor();await shot('empty');
  await page.locator('.chat-room[data-room-id=""]').click();await page.locator('[data-message-id="10"]').waitFor();
  for(let i=11;i<=30;i++)messages.push(row(i,peer,'新的实验记录 '+i,when(i*6)));await page.getByRole('button',{name:'刷新',exact:true}).filter({has:page.locator('svg')}).click();await page.locator('[data-message-id="30"]').waitFor();await page.locator('#community-messages').evaluate(n=>n.scrollTop=0);
  messages.push(row(31,peer,'滚动上方时的新消息'));await page.locator('#chat-new').waitFor({state:'visible'});assert.match(await page.locator('#chat-new').textContent(),/1 条新消息/);await shot('unread');
  await page.locator('#chat-new').click();await page.waitForFunction(()=>{const n=document.querySelector('#community-messages');return n.scrollHeight-n.scrollTop-n.clientHeight<2;});
  // Notes stay functional on the posts tab after moving out of chat.
  if(width<900)await page.getByRole('tab',{name:'帖子',exact:true}).click();await page.locator('#community-task-notes summary').click();await page.locator('#task-note-lifetime').selectOption('general');await page.locator('#task-note-body').fill('帖子栏中的任务留言');await page.getByRole('button',{name:'发布留言',exact:true}).click();await page.locator('#task-notes-list').filter({hasText:'帖子栏中的任务留言'}).waitFor();
  if(width<900){await page.getByRole('tab',{name:'聊天',exact:true}).click();const count=calls.filter(c=>c.op==='community.notes.list').length;await page.waitForTimeout(5500);assert.equal(calls.filter(c=>c.op==='community.notes.list').length,count,'hidden notes stop polling');}
  // History controls float above the list without covering its date separator.
  earlier=true;await page.locator('#chat-refresh').click();await page.locator('#chat-older').waitFor({state:'visible'});assert.ok(await page.locator('#community-messages').evaluate(n=>n.scrollHeight-n.scrollTop-n.clientHeight<2),'history controls keep latest messages in view');await page.locator('#community-messages').evaluate(n=>n.scrollTop=0);
  const historyFits=async()=>assert.ok(await page.locator('.chat-history').evaluate(n=>[...n.querySelectorAll('button:not([hidden])')].every(b=>b.getBoundingClientRect().bottom<=document.querySelector('.chat-day').getBoundingClientRect().top)),'history controls must not cover the first date');
  await historyFits();await page.locator('#chat-older').click();await page.locator('[data-message-id="0"]').waitFor();await page.locator('#chat-latest').waitFor({state:'visible'});await historyFits();await page.waitForFunction(()=>document.querySelector('#community-chat-form').getBoundingClientRect().bottom<=(innerWidth<900?document.querySelector('#room-nav').getBoundingClientRect().top:innerHeight));await shot('history');
  const historyCalls=calls.filter(c=>c.op==='community.chat.list').length;await page.waitForTimeout(5500);assert.equal(calls.filter(c=>c.op==='community.chat.list').length,historyCalls,'history mode pauses polling');
  earlier=false;await page.locator('#chat-latest').click();await page.locator('#chat-latest').waitFor({state:'hidden'});assert.equal(await page.locator('[data-message-id="0"]').count(),0,'latest mode replaces older history');
  await page.emulateMedia({reducedMotion:'reduce'});await page.locator('.chat-room[data-room-id="1"]').click();await page.locator('[data-message-id="100"]').waitFor();
  assert.equal(await page.locator('#community-messages').evaluate(n=>n.getAnimations({subtree:true}).length),0);
  for(const selector of ['.chat-room','.chat-tool','.chat-send','#community-chat-body','.community-item-actions'])assert.ok((await page.locator(selector).evaluateAll(nodes=>nodes.map(n=>getComputedStyle(n).transitionDuration))).every(d=>d==='0s'),selector);
  assert.deepEqual(errors,[]);console.log('PASS chat layout '+width+'x'+height+': '+JSON.stringify(fit));await context.close();
 }
 await writeFile(join(shots,'chat-layout-metrics.json'),JSON.stringify(metrics,null,2)+'\n');
}finally{await browser.close();await rm(temporary,{recursive:true,force:true});}
