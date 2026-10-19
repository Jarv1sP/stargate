import {seedAccounts} from './fixtures/accounts.mjs';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve,extname} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {PortalService} from '../portal-service.mjs';

const temporary=await mkdtemp(join(tmpdir(),'mention-popup-ui-')),root=resolve(import.meta.dirname,'../dist');
const shots=process.env.CHAT_SHOTS||temporary;await mkdir(shots,{recursive:true});
const bootstrap=join(temporary,'bootstrap');await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Local-Mention-Popup-UI-2026!'}));
const service=await PortalService.open(join(temporary,'db'),bootstrap);
for(const name of ['executionTimer','notificationTimer','maintenanceTimer','transferTimer','storageArchiveTimer','projectCopyTimer'])clearInterval(service[name]);
const admin=service.store.users[0],alice={...admin,id:'demo-user-alice',username:'alice',name:'爱丽丝',role:'member'},bob={...admin,id:'demo-user-bob',username:'bob',name:'鲍勃',role:'member'};
seedAccounts(service,alice,bob);
const token=user=>service.issueSession({userId:user.id,username:user.username,role:user.role});
const picture=Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(4),Buffer.from('WEBPVP8 '),Buffer.alloc(32,7)]);
const send=fields=>service.invoke(token(alice),'community.chat.send',{key:randomUUID(),...fields});
const unread=async()=>(await service.invoke(token(bob),'state')).state.chatMentions;
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${['styles','fonts','starbase','shell','workbench','copy-help','community','collab-room'].map(name=>'<link rel="stylesheet" href="/'+name+'.css">').join('')}
<body class="sb"><p><a href="#community" data-nav="community">协作</a></p><dialog id="other">别的弹窗</dialog><script type="module">
import {createMentionPopup} from '/mention-popup-ui.js';
const params=new URL(location.href).searchParams,get=async(path,body)=>{const r=await fetch(path,{method:body?'POST':'GET',...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});const value=await r.json();if(!r.ok)throw Object.assign(Error(value.error),{status:r.status});return value;};
window.calls=[];window.opened=0;
const store={...await get('/state'),authGeneration:1,onAuthChange(){},async call(op,args={}){calls.push({op,args});return get('/call',{op,args});}};
if(params.get('other'))document.querySelector('#other').showModal();
const render=createMentionPopup(store,{openChat:()=>opened++,chatOpen:()=>params.get('inchat')==='1'});
window.poll=async()=>{store.data=(await get('/state')).data;render();};
render();window.ready=true;
</script></html>`;
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  try{
    if(url.pathname==='/'){res.setHeader('content-type','text/html');res.end(html);return;}
    if(url.pathname==='/state'){res.setHeader('content-type','application/json');res.end(JSON.stringify({principal:{userId:bob.id,role:bob.role,username:bob.username},users:service.store.users,data:{chatMentions:await unread()}}));return;}
    if(url.pathname==='/call'){
      let text='';for await(const bytes of req)text+=bytes;const {op,args}=JSON.parse(text);
      const reply=await service.invoke(token(bob),op,args);res.setHeader('content-type','application/json');res.end(JSON.stringify(reply.result));return;
    }
    const file=resolve(root,'.'+url.pathname);if(!file.startsWith(root+'/')){res.writeHead(404).end();return;}
    const value=await readFile(file);res.setHeader('content-type',extname(file)==='.js'?'text/javascript':extname(file)==='.css'?'text/css':'application/octet-stream');res.end(value);
  }catch(error){res.writeHead(error.status||404,{'content-type':'application/json'});res.end(JSON.stringify({error:error.message}));}
});
let browser;
const fetches=page=>page.evaluate(()=>calls.filter(c=>c.op==='community.chat.mentions').length);
async function open(width,query=''){
  const page=await browser.newPage({viewport:{width,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port+'/'+query);await page.waitForFunction(()=>window.ready);
  return {page,errors,dialog:page.locator('#mention-dialog')};
}
try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({headless:true,...process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}});
  for(const width of [1440,390,320]){
    for(const table of ['community_chat_v2','community_chat_images_v2','community_chat_mentions_v2'])service.db.exec('DELETE FROM '+table);
    for(let n=1;n<=6;n++)await send({body:`@bob 第 ${n} 条，帮忙看下 ${n} 号卡上的训练日志，好像卡住了很久没有输出新的 loss 值`});
    await send({body:'@bob',image:{type:'image/webp',data:picture.toString('base64'),width:320,height:200}});
    // Opening the site shows the newest mentions, like an announcement.
    const {page,errors,dialog}=await open(width);
    await dialog.waitFor({state:'visible'});
    assert.equal(await page.locator('#mention-list li').count(),5);
    assert.match(await page.locator('#mention-meta').textContent(),/共 7 条未读/);
    assert.equal(await page.locator('#mention-list li').first().locator('.chat-mention.me').textContent(),'@鲍勃');
    assert.match(await page.locator('#mention-list li').first().textContent(),/爱丽丝 · .*\[图片\]/);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'mention-open');
    const box=await dialog.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width&&box.y>=0&&box.y+box.height<=800,'the pop-up fits the screen');
    for(const id of ['mention-later','mention-ack','mention-open']){const b=await page.locator('#'+id).boundingBox();assert.ok(b.x>=box.x&&b.x+b.width<=box.x+box.width+1&&b.height>=44,id+' is a full-size button inside the pop-up');}
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:join(shots,`mention-popup-${width}.png`)});
    // 稍后再看 quiets this page until someone mentions again.
    await page.locator('#mention-later').click();assert.equal(await dialog.isVisible(),false);
    await page.evaluate(()=>poll());await page.waitForTimeout(150);assert.equal(await dialog.isVisible(),false);
    await send({body:'@bob 新的一条'});await page.evaluate(()=>poll());await dialog.waitFor({state:'visible'});
    assert.match(await page.locator('#mention-meta').textContent(),/共 8 条未读/);
    // 去聊天室 hands over to the chat, which clears the mentions once seen.
    await page.locator('#mention-open').click();assert.equal(await dialog.isVisible(),false);assert.equal(await page.evaluate(()=>opened),1);
    assert.equal(await unread(),8);await page.close();
    // A fresh visit shows them again; 我知道了 clears them on the server.
    const again=await open(width);await again.dialog.waitFor({state:'visible'});
    await again.page.locator('#mention-ack').click();await again.page.waitForFunction(()=>!document.querySelector('#mention-dialog').open);
    assert.equal(await unread(),0);await again.page.close();
    const cleared=await open(width);await cleared.page.waitForTimeout(300);
    assert.equal(await cleared.dialog.isVisible(),false);assert.equal(await fetches(cleared.page),0,'no unread, no extra request');await cleared.page.close();
    // Already in the chat: no pop-up. Another dialog open: wait for it to close.
    await send({body:'@bob 在聊天室里'});
    const inChat=await open(width,'?inchat=1');await inChat.page.waitForTimeout(300);
    assert.equal(await inChat.dialog.isVisible(),false);assert.equal(await fetches(inChat.page),0);await inChat.page.close();
    const behind=await open(width,'?other=1');await behind.page.waitForFunction(()=>calls.length>0);await behind.page.waitForTimeout(150);
    assert.equal(await behind.dialog.isVisible(),false,'never stacks on another dialog');
    await behind.page.evaluate(()=>document.querySelector('#other').close());await behind.dialog.waitFor({state:'visible'});
    assert.deepEqual([...errors,...again.errors,...cleared.errors,...inChat.errors,...behind.errors],[]);await behind.page.close();
    console.log('PASS mention pop-up '+width+': shows on open, later/new mention, open chat, ack clears, skips in chat and behind dialogs');
  }
}finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));service.close();await rm(temporary,{recursive:true,force:true});}
