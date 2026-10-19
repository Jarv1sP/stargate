import {seedAccounts} from './fixtures/accounts.mjs';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve,extname} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';
import {PortalService} from '../portal-service.mjs';

const temporary=await mkdtemp(join(tmpdir(),'chat-compose-ui-')),root=resolve(import.meta.dirname,'../dist');
const shots=process.env.CHAT_SHOTS||temporary;await mkdir(shots,{recursive:true});
const bootstrap=join(temporary,'bootstrap');await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Local-Chat-Compose-UI-2026!'}));
const service=await PortalService.open(join(temporary,'db'),bootstrap);
for(const name of ['executionTimer','notificationTimer','maintenanceTimer','transferTimer','storageArchiveTimer','projectCopyTimer'])clearInterval(service[name]);
const admin=service.store.users[0],actors={};
for(const width of [1440,390,320])for(const name of ['alice','bob']){
  const user={...admin,id:`demo-user-${name}-${width}`,username:`${name}-${width}`,name:name==='bob'?'鲍勃 '+width:'Alice '+width,role:'member'};seedAccounts(service,user);actors[name+'-'+width]=user;
}
// A team larger than one screen of suggestions.
for(let n=1;n<=8;n++)seedAccounts(service,{...admin,id:'demo-user-crew-'+n,username:'crew-'+n,name:'组员 '+n,role:'member'});
const token=user=>service.issueSession({userId:user.id,username:user.username,role:user.role});
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${['styles','fonts','starbase','shell','workbench','copy-help','community','collab-room'].map(name=>'<link rel="stylesheet" href="/'+name+'.css">').join('')}
<style>body{margin:0}main{padding:16px;max-width:1280px;margin:auto;box-sizing:border-box}</style>
<body class="sb"><p id="fake-nav"><a href="#community" data-nav="community">协作</a></p><main><section id="page-community"></section></main><script type="module">
import {createCommunityUI,renderChatMentionBadge} from '/community-ui.js';
const actor=new URL(location.href).searchParams.get('actor'),get=async(path,body)=>{const r=await fetch(path+'?actor='+actor,{method:body?'POST':'GET',...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});const value=await r.json();if(!r.ok)throw Object.assign(Error(value.error),{status:r.status});return value;};
window.calls=[];const initial=await get('/state');
const store={...initial,authGeneration:1,jobs:[],onAuthChange(){},async call(op,args={}){calls.push({op,args});return get('/call',{op,args});},async refresh(){}};
window.store=store;const renderCommunity=createCommunityUI(store,()=>{});
renderCommunity(true);renderChatMentionBadge(store);window.ready=true;
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
    const picture=/^\/community\/chat-images\/(\d+)$/.exec(url.pathname);
    if(picture){const image=service.communityImage(token(admin),picture[1]);res.setHeader('content-type',image.type);res.end(image.data);return;}
    const file=resolve(root,'.'+url.pathname);if(!file.startsWith(root+'/')){res.writeHead(404).end();return;}
    const value=await readFile(file);res.setHeader('content-type',extname(file)==='.js'?'text/javascript':extname(file)==='.css'?'text/css':'application/octet-stream');res.end(value);
  }catch(error){res.writeHead(error.status||404,{'content-type':'application/json'});res.end(JSON.stringify({error:error.message}));}
});
const sent=page=>page.evaluate(()=>calls.filter(c=>c.op==='community.chat.send').map(c=>c.args));
async function open(width,name){
  const page=await browser.newPage({viewport:{width,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port+'/?actor='+name+'-'+width);await page.waitForFunction(()=>window.ready);
  if(await page.locator('[data-community-tab="chat"]').isVisible())await page.locator('[data-community-tab="chat"]').click();
  await page.waitForFunction(()=>!document.querySelector('#community-chat-body').disabled&&document.querySelector('#community-messages .community-empty,#community-messages .chat-message'));
  return {page,errors};
}
let browser;
try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({headless:true,...process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}});
  for(const width of [1440,390,320]){
    for(const table of ['community_chat_v2','community_chat_images_v2','community_chat_mentions_v2'])service.db.exec('DELETE FROM '+table);
    const {page,errors}=await open(width,'alice'),input=page.locator('#community-chat-body');
    // Shift+Enter is a new line, Enter sends.
    await input.click();await input.pressSequentially('第一行');await input.press('Shift+Enter');await input.pressSequentially('第二行');await input.press('Enter');
    await page.waitForFunction(()=>document.querySelectorAll('.chat-message').length===1&&document.querySelector('#community-chat-body').value==='');
    assert.equal((await sent(page))[0].body,'第一行\n第二行');
    // Enter while an IME is composing confirms the word and never sends.
    await input.fill('拼音');await input.evaluate(n=>n.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true})));
    assert.equal((await sent(page)).length,1);await input.fill('');
    // A bare @, even right after Chinese, lists every other member; the list scrolls to the last one.
    await input.pressSequentially('请@');const everyone=page.locator('.chat-mention-option');await page.locator('.chat-mention-list').waitFor({state:'visible'});
    assert.equal(await everyone.count(),service.store.users.length-1);
    await input.press('ArrowUp');assert.ok(await everyone.last().evaluate(n=>{const list=n.parentElement.getBoundingClientRect(),row=n.getBoundingClientRect();return row.top>=list.top-1&&row.bottom<=list.bottom+1;}),'the chosen member is scrolled into view');
    await input.press('Escape');await input.fill('mail@b');assert.equal(await page.locator('.chat-mention-list').isVisible(),false,'an e-mail address is not a mention');await input.fill('');
    // @ suggests members; Enter picks one instead of sending.
    await input.pressSequentially('@bob-'+width);const list=page.locator('.chat-mention-list');await list.waitFor({state:'visible'});
    assert.match(await list.textContent(),new RegExp('鲍勃 '+width));assert.doesNotMatch(await list.textContent(),/alice/,'no self-mention');
    await input.press('Enter');assert.equal(await input.inputValue(),`@bob-${width} `);assert.equal(await list.isVisible(),false);
    await input.pressSequentially('看下');
    await page.locator('.chat-tool[aria-label="插入表情"]').click();await page.locator('.chat-emoji-panel').waitFor({state:'visible'});
    const box=await page.locator('.chat-emoji-panel').boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width,'emoji panel stays on screen');
    await page.locator('.chat-emoji',{hasText:'👍'}).click();assert.equal(await input.inputValue(),`@bob-${width} 看下👍`);
    await input.press('Enter');await page.waitForFunction(()=>document.querySelectorAll('.chat-message').length===2);
    assert.equal(service.db.prepare('SELECT count(*) AS n FROM community_chat_mentions_v2 WHERE user_id=?').get(actors['bob-'+width].id).n,1);
    // A picture: compressed in the browser, sent without text, shown from the portal.
    await page.locator('.chat-tools input[type=file]').evaluate(async input=>{
      const canvas=document.createElement('canvas');canvas.width=2400;canvas.height=1200;const c=canvas.getContext('2d');c.fillStyle='#3a6';c.fillRect(0,0,2400,1200);c.fillStyle='#fff';c.fillRect(200,200,800,400);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png')),files=new DataTransfer();files.items.add(new File([blob],'shot.png',{type:'image/png'}));
      input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    });
    await page.locator('.chat-attachment img').waitFor({state:'visible'});await input.press('Enter');
    await page.waitForFunction(()=>document.querySelector('.chat-message:last-child .chat-image img')?.naturalWidth>0);
    const picture=(await sent(page)).at(-1).image;assert.equal(picture.width,1600);assert.equal(picture.height,800);assert.ok(['image/webp','image/jpeg'].includes(picture.type));
    assert.equal(await page.locator('.chat-attachment').isVisible(),false);
    const form=await page.locator('#community-chat-form').boundingBox(),text=await input.boundingBox();
    assert.ok(form.x>=0&&form.x+form.width<=width+1);assert.ok(text.width>=150,'the text box keeps a usable width');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:join(shots,`chat-sender-${width}.png`),fullPage:true});
    await page.locator('#community-chat').screenshot({path:join(shots,`chat-card-${width}.png`)});
    // The mentioned member sees the highlight and the 协作 badge until the chat is read.
    const bob=await open(width,'bob');
    assert.equal(await bob.page.locator('.chat-message.mentions-me .chat-mention.me').textContent(),'@鲍勃 '+width);
    await bob.page.waitForFunction(()=>calls.some(c=>c.op==='community.chat.read')&&!document.querySelector('.nav-mention'));
    assert.equal((await service.invoke(token(actors['bob-'+width]),'state')).state.chatMentions,0);
    await bob.page.screenshot({path:join(shots,`chat-mentioned-${width}.png`),fullPage:true});
    assert.deepEqual([...errors,...bob.errors],[]);await bob.page.close();await page.close();
    console.log('PASS chat composer '+width+': Enter/Shift+Enter/IME, @ pick and notify, emoji, compressed picture, no overflow');
  }
}finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));service.close();await rm(temporary,{recursive:true,force:true});}
