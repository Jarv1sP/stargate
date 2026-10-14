import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve,extname} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {PortalService} from '../portal-service.mjs';

const temporary=await mkdtemp(join(tmpdir(),'announcement-ui-')),root=resolve(import.meta.dirname,'../dist');
const shots=process.env.ANNOUNCEMENT_SHOTS||temporary;await mkdir(shots,{recursive:true});
const bootstrap=join(temporary,'bootstrap');await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Local-Announcement-UI!'}));
const service=await PortalService.open(join(temporary,'db'),bootstrap);
for(const name of ['executionTimer','notificationTimer','maintenanceTimer','transferTimer','storageArchiveTimer','projectCopyTimer'])clearInterval(service[name]);
const admin=service.store.users[0],actors=Object.fromEntries(['admin','member'].flatMap((role,r)=>[1440,390,320].map((width,i)=>{
  const user={...admin,id:'demo-user-'+(100+r*10+i),username:'fixture-'+role+'-'+width,name:'Fixture '+role,role};service.store.users.push(user);
  return [role+'-'+width,user];
})));
const token=user=>service.issueSession({userId:user.id,username:user.username,role:user.role});
const post=(await service.invoke(token(admin),'community.posts.create',{key:randomUUID(),kind:'announcement',title:'Scheduled notice',body:'Plain text <script>window.bodyExecuted=true</script>',popup:true,appearance:{background:'#112233',text:'#ffffff',accent:'#ff8800'}})).result.post;
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${['styles','fonts','starbase','shell','workbench','copy-help','community','announcements'].map(name=>'<link rel="stylesheet" href="/'+name+'.css">').join('')}
<style>body{margin:0}main{padding:16px;max-width:1280px;margin:auto;box-sizing:border-box}</style>
<body class="sb"><main><section id="page-community"></section></main><script type="module">
import {createAnnouncementUI} from '/announcement-ui.js';import {createCommunityUI} from '/community-ui.js';
const actor=new URL(location.href).searchParams.get('actor'),get=async(path,body)=>{const r=await fetch(path+'?actor='+actor,{method:body?'POST':'GET',...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});const value=await r.json();if(!r.ok)throw Object.assign(Error(value.error),{status:r.status});return value;};
window.calls=[];window.toasts=[];window.refreshes=0;const callbacks=[],initial=await get('/state');
const store={...initial,authGeneration:1,jobs:[],onAuthChange(fn){callbacks.push(fn);},async call(op,args={}){calls.push({op,args});return get('/call',{op,args});},async refresh(){refreshes++;const value=await get('/state');this.data=value.data;this.users=value.users;renderAnnouncements();}};
window.store=store;window.logout=()=>{store.principal=null;store.authGeneration++;for(const fn of callbacks)fn();};
const renderAnnouncements=createAnnouncementUI(store,{toast:text=>toasts.push(text)}),renderCommunity=createCommunityUI(store,text=>toasts.push(text));
renderCommunity(true);renderAnnouncements();window.ready=true;
</script></html>`;
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost'),user=actors[url.searchParams.get('actor')];
  try{
    if(url.pathname==='/'){res.setHeader('content-type','text/html');res.end(html);return;}
    if(url.pathname==='/state'){
      assert.ok(user);const pending=(await service.invoke(token(user),'community.announcements.pending',{})).result.posts;
      res.setHeader('content-type','application/json');res.end(JSON.stringify({principal:{userId:user.id,role:user.role},users:user.role==='admin'?service.store.users:[user],data:{announcements:{version:1,pending:pending.map(p=>({id:p.id,revision:p.revision}))}}}));return;
    }
    if(url.pathname==='/call'){
      assert.ok(user);let text='';for await(const bytes of req)text+=bytes;const {op,args}=JSON.parse(text);
      const reply=await service.invoke(token(user),op,args);res.setHeader('content-type','application/json');res.end(JSON.stringify(reply.result));return;
    }
    const file=resolve(root,'.'+url.pathname);if(!file.startsWith(root+'/')){res.writeHead(404).end();return;}
    const value=await readFile(file);res.setHeader('content-type',extname(file)==='.js'?'text/javascript':extname(file)==='.css'?'text/css':'application/octet-stream');res.end(value);
  }catch(error){res.writeHead(error.status||404,{'content-type':'application/json'});res.end(JSON.stringify({error:error.message}));}
});
let browser;
try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({headless:true,...process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}});
  for(const role of ['member','admin'])for(const width of [1440,390,320]){
    const page=await browser.newPage({viewport:{width,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    const url='http://127.0.0.1:'+server.address().port+'/?actor='+role+'-'+width;
    await page.goto(url);await page.waitForFunction(()=>window.ready);const dialog=page.locator('#announcement-dialog');await dialog.waitFor({state:'visible'});await page.evaluate(()=>document.fonts.ready);
    assert.match(await page.locator('#announcement-body').textContent(),/<script>/);assert.equal(await page.evaluate(()=>window.bodyExecuted),undefined);
    assert.equal(await dialog.evaluate(n=>getComputedStyle(n).backgroundColor),'rgb(17, 34, 51)');
    for(const button of ['#announcement-later','#announcement-ack'])assert.ok(await page.locator(button).evaluate(n=>n.getBoundingClientRect().height>=44));
    const box=await dialog.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+1);
    await page.screenshot({path:join(shots,`announcement-${role}-${width}.png`)});
    await page.locator('#announcement-later').click();await dialog.waitFor({state:'hidden'});
    assert.equal(await page.evaluate(()=>calls.filter(c=>c.op==='community.announcements.ack').length),0);
    await page.reload();await page.waitForFunction(()=>window.ready);await dialog.waitFor({state:'visible'});
    await page.waitForFunction(()=>!document.querySelector('#announcement-ack').disabled);
    const revision=service.db.prepare('SELECT revision FROM community_posts_v2 WHERE id=?').get(post.id).revision;
    const title='Updated notice '+role+' '+width;
    await service.invoke(token(admin),'community.posts.update',{id:post.id,title});
    await page.locator('#announcement-ack').click();
    await page.waitForFunction(title=>document.querySelector('#announcement-title').textContent===title&&!document.querySelector('#announcement-ack').disabled,title);
    const firstAck=await page.evaluate(()=>calls.filter(c=>c.op==='community.announcements.ack'));
    assert.deepEqual(firstAck.map(c=>c.args),[{id:post.id,revision}]);
    assert.equal(service.db.prepare('SELECT revision FROM announcement_acknowledgements_v2 WHERE user_id=? AND post_id=?').get(actors[role+'-'+width].id,post.id).revision,revision);
    assert.equal(await page.locator('#announcement-error').textContent(),'');
    assert.deepEqual(await page.evaluate(()=>toasts),[]);assert.equal(await page.evaluate(()=>refreshes),0);
    await page.locator('#announcement-ack').click();await dialog.waitFor({state:'hidden'});
    assert.deepEqual(await page.evaluate(()=>calls.filter(c=>c.op==='community.announcements.ack').map(c=>c.args.revision)),[revision,revision+1]);
    await page.reload();await page.waitForFunction(()=>window.ready);assert.equal(await dialog.isVisible(),false);
    await page.waitForFunction(()=>!document.querySelector('#community-refresh').disabled);
    await page.locator('#community-announcements').click();await page.waitForFunction(()=>document.querySelectorAll('.community-post').length>0);
    assert.equal(await page.locator('#community-publish-announcement').isVisible(),role==='admin');
    if(role==='admin'){
      await page.locator('#community-publish-announcement').click();const form=page.locator('#community-compose-form');
      await form.locator('[name=title]').fill('Targeted '+width);await form.locator('[name=body]').fill('Local editor notice');
      await form.locator('[name=audience]').selectOption('users');await form.locator('[name=audienceUser][value="demo-user-110"]').check();
      await page.locator('#announcement-appearance-editor summary').click();await form.locator('[name=layout]').selectOption('centered');
      await page.screenshot({path:join(shots,`announcement-editor-${width}.png`),fullPage:true});
      await form.locator('[type=submit]').click();await page.locator('.community-composer').waitFor({state:'hidden'});
      const created=await page.evaluate(()=>calls.find(c=>c.op==='community.posts.create'));
      assert.deepEqual(created.args.audience,{type:'users',userIds:['demo-user-110']});assert.equal(created.args.appearance.layout,'centered');assert.equal(created.args.popup,true);
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.evaluate(()=>{logout();});assert.equal(await dialog.isVisible(),false);assert.equal(await page.locator('#announcement-body').textContent(),'');
    assert.deepEqual(errors,[]);await page.close();console.log('PASS announcement '+role+'/'+width+': native dialog, defer/ack, older edition ack shows updated edition without error or refresh, plain text, targeting/editor, account isolation');
  }
}finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));service.close();await rm(temporary,{recursive:true,force:true});}
