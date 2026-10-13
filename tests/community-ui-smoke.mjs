import {accountMenu,refreshVisible} from './starbase-workflows.mjs';
// Real durable community APIs, real HTTP cookie auth, disposable SQLite only.
// No GPU executor, production data, external network, SSH or shell sessions.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';

const folder=await mkdtemp(join(tmpdir(),'gpuq-community-browser-')),screenshots=process.env.UI_SCREENSHOTS||'/tmp/gpuq-community-ui';
const password='Community-Browser-Fixture-Only-2026!',errors=[],external=[],sent=[],captures=[];
const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const origin='http://127.0.0.1:'+port,bootstrap=join(folder,'bootstrap.json'),database=join(folder,'portal.sqlite');
let server,service,browser,dropOperation=null,heldOperation=null,releaseHeld=null,holdDeleteId=null,releaseDelete=null;
const start=async()=>{({server,service}=await createPortalServer({database,bootstrap,origin,secure:false}));await new Promise(r=>server.listen(port,'127.0.0.1',r));};
const stop=async()=>{await new Promise(r=>server.close(r));server=null;};
try{
  await mkdir(screenshots,{recursive:true});await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});await start();
  const admin=(await service.login('admin',password)).token;
  const alice=(await service.invoke(admin,'users.create',{username:'alice',password,role:'member'})).result;
  const bob=(await service.invoke(admin,'users.create',{username:'bob',password,role:'member'})).result;
  service.store.users.find(u=>u.id===alice.id).name='<img src=x onerror=window.XSS=1>';service.save();
  const aliceToken=(await service.login('alice',password)).token,bobToken=(await service.login('bob',password)).token;
  const call=async(operation,args={},token=admin)=>(await service.invoke(token,'community.'+operation,args)).result;
  const clearRates=()=>service.db.exec('DELETE FROM community_rate');
  const post=async(title,body,kind='feedback',token=aliceToken)=>{clearRates();return (await call('posts.create',{key:randomUUID(),kind,title,body,...(kind==='announcement'?{announcementType:'maintenance'}:{})},token)).post;};
  const announcement=await post('本周维护安排','周五 20:00–21:00 例行维护。请提前保存训练进度。','announcement',admin);
  await call('posts.update',{id:announcement.id,revision:announcement.revision,pinned:true});
  for(let i=0;i<24;i++)await post('实验反馈 '+String(i+1).padStart(2,'0'),'任务日志在页面刷新后如何继续查看？已补充复现步骤。');
  const xss=await post('<img src=x onerror=window.XSS=2>','<script>window.XSS=3</script>\n纯文本反馈');
  for(let i=0;i<55;i++){clearRates();await call('comments.create',{postId:xss.id,key:randomUUID(),body:'回复 '+i},i%2?aliceToken:bobToken);}
  clearRates();
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  page.on('dialog',dialog=>dialog.accept());
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());if(url.origin!==origin){if(['data:','blob:'].includes(url.protocol))return route.continue();external.push(url.href);return route.abort();}
    if(url.pathname==='/api/call'){
      const data=route.request().postDataJSON();sent.push(data);
      if(data.operation==='community.posts.delete'&&data.args.id===holdDeleteId){holdDeleteId=null;const response=await route.fetch();await new Promise(resolve=>releaseDelete=resolve);return route.fulfill({response});}
      if(data.operation===dropOperation){dropOperation=null;await route.fetch();return route.abort('failed');}
      if(data.operation===heldOperation){heldOperation=null;await new Promise(resolve=>releaseHeld=resolve);return route.abort('failed');}
    }
    return route.continue();
  });
  const login=async username=>{await page.locator('#login-dialog').waitFor();await page.locator('#login-form [name=username]').fill(username);await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});await page.locator('[data-nav=community]').click();await page.locator('#community-status').filter({hasText:'正在连接'}).waitFor({state:'hidden'});};
  // Desktop exposes both live panels. Exercise the original tab/cursor flows
  // below at tablet width, where a real user still switches those panels.
  const tab=async name=>{if(page.viewportSize().width>=1100)await page.setViewportSize({width:820,height:1000});await page.locator('[data-community-tab='+(name==='chat'?'chat':'posts')+']').click();if(name!=='chat')await page.locator('#community-kind').selectOption(name==='posts'?'':name);};
  const loaded=async()=>{await page.waitForFunction(()=>!document.querySelector('#community-status').textContent.startsWith('正在'));};
  const snapshot=async name=>{const size=page.viewportSize();if(name.endsWith('-desktop'))await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>{scrollTo(0,0);document.querySelector('#toast')?.classList.remove('visible');});await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(400);await page.screenshot({path:join(screenshots,name+'.png')});captures.push({name,viewport:page.viewportSize(),...await page.evaluate(()=>({documentHeight:document.documentElement.scrollHeight,sheetHeight:document.querySelector('.community-dialog[open]')?.getBoundingClientRect().height||null}))});if(page.viewportSize().width!==size.width)await page.setViewportSize(size);};
  await page.goto(origin+'/#community');await login('alice');await loaded();
  const guide=await page.request.get(origin+'/guide/community');assert.equal(guide.status(),200);assert.match(guide.headers()['content-type'],/^text\/html/);
  const guideHTML=await guide.text();
  assert.match(guideHTML,/协作区只有“帖子”和“聊天”两个入口/);
  assert.match(guideHTML,/不会自动改变配额、队列或取消任务/,'the guide must preserve the collaboration boundary without depending on its introductory wording');
  assert.deepEqual(await page.locator('[data-community-tab]').evaluateAll(nodes=>nodes.map(node=>node.dataset.communityTab)),['posts','chat']);
  assert.equal(await page.locator('#community-tabs').isVisible(),false,'desktop uses the visible forum and live chat rail');
  assert.equal(await page.locator('#community-chat').isVisible(),true);
  await page.locator('#community-messages .community-empty').waitFor();
  await page.waitForFunction(()=>document.querySelector('#community-chat').getBoundingClientRect().bottom<=document.querySelector('#control-strip').getBoundingClientRect().top-10);
  const live=(await call('chat.send',{key:randomUUID(),body:'桌面侧栏自动更新验证'},bobToken)).message;
  await page.locator('.chat-message').filter({hasText:'桌面侧栏自动更新验证'}).waitFor();
  await call('chat.delete',{id:live.id,revision:live.revision},bobToken);await page.locator('#chat-refresh').click();await page.locator('#community-messages .community-empty').waitFor();
  assert.equal(await page.locator('#community-create').isVisible(),true,'members can post from the unified list');
  await page.locator('#community-create').click();assert.equal(await page.locator('#community-compose-form [name=kind] option[value=announcement]').count(),0);await snapshot('compose-member-desktop');await page.locator('.community-composer [data-compose-close]').first().click();
  assert.match(await page.locator('#community-posts').innerText(),/本周维护安排/);
  await snapshot('announcements-desktop');
  clearRates();await page.locator('#community-create').click();await page.locator('#community-compose-form [name=kind]').selectOption('discussion');await page.locator('#community-compose-form [name=title]').fill('讨论：共享训练经验');await page.locator('#community-compose-form [name=body]').fill('欢迎补充训练环境的准备方法。');await page.locator('#community-compose-form [type=submit]').click();await page.locator('.community-composer').waitFor({state:'hidden'});await tab('discussion');await loaded();assert.equal(await page.locator('.community-post').count(),1);assert.match(await page.locator('.community-post-top').innerText(),/讨论/);assert.doesNotMatch(await page.locator('.community-post-top').innerText(),/待处理/);
  await tab('chat');await page.locator('#community-messages .community-empty').waitFor();
  for(let i=0;i<51;i++){clearRates();await call('chat.send',{key:randomUUID(),body:'用卡计划 '+i},i%2?aliceToken:bobToken);}
  await tab('feedback');await loaded();await tab('chat');await page.locator('#chat-older').waitFor();assert.equal(await page.locator('.chat-message').count(),50);
  await page.locator('#chat-older').click();await page.waitForFunction(()=>document.querySelectorAll('.chat-message').length===51);assert.match(await page.locator('.chat-message').first().innerText(),/用卡计划 0/);
  for(let i=51;i<55;i++){clearRates();await call('chat.send',{key:randomUUID(),body:'用卡计划 '+i},i%2?aliceToken:bobToken);}clearRates();await page.locator('#chat-refresh').click();await page.waitForFunction(()=>document.querySelectorAll('.chat-message').length===50);
  await tab('feedback');await loaded();assert.equal(await page.locator('.community-post').count(),20);
  await page.locator('#community-more').click();await loaded();assert.equal(await page.locator('.community-post').count(),25);
  assert.equal(await page.locator('#community-posts img,#community-posts script').count(),0);assert.equal(await page.evaluate(()=>window.XSS),undefined);
  await page.locator('[data-post-id="'+xss.id+'"]').click();await page.locator('#community-comments .community-comment').first().waitFor();
  assert.equal(await page.locator('#community-comments .community-comment').count(),50);
  await page.locator('#community-comments-more').click();await page.waitForFunction(()=>document.querySelectorAll('#community-comments .community-comment').length===55);
  assert.equal(await page.locator('.community-detail img,.community-detail script').count(),0);
  await page.locator('#community-comment-body').fill('保留回复草稿');await page.locator('#community-replies-refresh').click();
  assert.equal(await page.locator('#community-comment-body').inputValue(),'保留回复草稿');
  await snapshot('feedback-detail-desktop');
  // A committed response lost in transit must reuse its exact create key.
  dropOperation='community.comments.create';await page.locator('#community-comment-form [type=submit]').click();
  await page.locator('#community-comment-error').filter({hasText:'发送结果未确认'}).waitFor();
  await page.locator('[data-community-close]').click();await page.locator('[data-post-id="'+xss.id+'"]').click();
  await page.waitForFunction(()=>document.querySelector('#community-post-title').textContent.includes('<img'));
  assert.equal(await page.locator('#community-comment-body').inputValue(),'保留回复草稿');
  assert.equal(await page.locator('#community-comment-body').evaluate(n=>n.readOnly),true);
  await page.locator('#community-comment-form [type=submit]').click();await page.waitForFunction(()=>document.querySelector('#community-comment-body').value==='');
  const retries=sent.filter(x=>x.operation==='community.comments.create');assert.equal(retries.at(-1).args.key,retries.at(-2).args.key);
  assert.equal(service.db.prepare('SELECT count(*) AS n FROM community_comments WHERE body=?').get('保留回复草稿').n,1);
  // Stale edit is rejected by the real revision fence without discarding text.
  await page.locator('#community-post-actions').getByRole('button',{name:'编辑',exact:true}).click();
  await page.locator('#community-compose-form [name=body]').fill('浏览器里未保存的新正文');
  await call('posts.update',{id:xss.id,revision:xss.revision,body:'其他客户端先保存'},aliceToken);
  await page.locator('#community-compose-form [type=submit]').click();await page.locator('#community-compose-error').filter({hasText:'内容已被更新'}).waitFor();
  assert.equal(await page.locator('#community-compose-form [name=body]').inputValue(),'浏览器里未保存的新正文');
  await page.locator('.community-composer [data-compose-close]').first().click();await page.locator('[data-community-close]').click();
  await page.locator('#community-create').click();await page.locator('#community-compose-form [name=title]').fill('新反馈：训练日志显示');await page.locator('#community-compose-form [name=body]').fill('请帮助排查训练日志的显示。');
  dropOperation='community.posts.create';await page.locator('#community-compose-form [type=submit]').click();await page.locator('#community-compose-error').filter({hasText:'发送结果未确认'}).waitFor();
  assert.equal(await page.locator('#community-compose-form [name=body]').evaluate(n=>n.readOnly),true);
  await page.locator('#community-compose-form [type=submit]').click();await page.locator('.community-composer').waitFor({state:'hidden'});await loaded();
  assert.equal(service.db.prepare('SELECT count(*) AS n FROM community_posts WHERE title=?').get('新反馈：训练日志显示').n,1);
  await snapshot('feedback-desktop');
  await tab('chat');await page.locator('.chat-message').first().waitFor();
  assert.equal(await page.locator('.chat-message').count(),50);await page.locator('#chat-older').click();await page.locator('#chat-latest').waitFor();assert.equal(await page.locator('.chat-message').count(),55);
  await page.locator('#chat-latest').click();await page.locator('#chat-latest').waitFor({state:'hidden'});
  await page.locator('#community-chat-body').fill('仍在编辑的排队计划');await refreshVisible(page);assert.equal(await page.locator('#community-chat-body').inputValue(),'仍在编辑的排队计划');
  for(let i=0;i<105;i++){clearRates();await call('chat.send',{key:randomUUID(),body:'连续新消息 '+i},bobToken);}clearRates();
  await tab('feedback');await loaded();await tab('chat');await page.waitForFunction(()=>document.querySelector('#community-messages').textContent.includes('连续新消息 104'));
  assert.equal(await page.locator('.chat-message').filter({hasText:'连续新消息 '}).count(),105,'forward polling must not skip the second/third page');
  assert.equal(await page.locator('#community-chat-body').inputValue(),'仍在编辑的排队计划');
  const recentRows=service.db.prepare('SELECT id,revision,body FROM community_chat ORDER BY id DESC LIMIT 2').all();
  await call('chat.update',{id:String(recentRows[0].id),revision:recentRows[0].revision,body:'其他客户端已修改的计划'},bobToken);
  await call('chat.delete',{id:String(recentRows[1].id),revision:recentRows[1].revision},bobToken);
  // Advance only browser wall time; no network, scheduler or server clock changes.
  await page.evaluate(()=>{window.realDateNow=Date.now;Date.now=()=>window.realDateNow()+31000;});
  await tab('feedback');await loaded();await tab('chat');await page.locator('.chat-message').filter({hasText:'其他客户端已修改的计划'}).waitFor();
  assert.equal(await page.locator('[data-message-id="'+recentRows[1].id+'"]').count(),0,'periodic latest-window reconciliation removes deleted rows');
  assert.equal(await page.locator('#community-chat-body').inputValue(),'仍在编辑的排队计划');await page.evaluate(()=>{Date.now=window.realDateNow;});
  // A true rate-limit error retains an editable draft.
  service.db.prepare('INSERT INTO community_rate(author_id,bucket,count,until_ms) VALUES(?,?,20,?) ON CONFLICT(author_id,bucket) DO UPDATE SET count=20,until_ms=excluded.until_ms').run(alice.id,'message',Date.now()+60000);
  await page.locator('#community-chat-form [type=submit]').click();await page.locator('#chat-error').filter({hasText:/频繁|稍后|过多/}).waitFor();
  assert.equal(await page.locator('#community-chat-body').inputValue(),'仍在编辑的排队计划');assert.equal(await page.locator('#community-chat-body').evaluate(n=>n.readOnly),false);clearRates();
  dropOperation='community.chat.send';await page.locator('#community-chat-form [type=submit]').click();await page.locator('#chat-error').filter({hasText:'发送结果未确认'}).waitFor();
  const deleted=service.db.prepare('SELECT id,revision FROM community_chat WHERE body=?').get('仍在编辑的排队计划');await call('chat.delete',{id:String(deleted.id),revision:deleted.revision});
  await page.locator('#community-chat-form [type=submit]').click();await page.locator('#chat-error').filter({hasText:'没有重新发送'}).waitFor();
  assert.equal(service.db.prepare('SELECT count(*) AS n FROM community_chat WHERE body=?').get('仍在编辑的排队计划').n,0);
  await page.locator('#community-chat-body').fill('gpu-1 的训练预计 18:00 结束，有需要的同学可以留言。');await page.locator('#community-chat-form [type=submit]').click();await page.waitForFunction(()=>document.querySelector('#community-chat-body').value==='');
  await snapshot('chat-desktop');
  for(const width of [820,390,320]){
    await page.setViewportSize({width,height:920});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'mobile overflow '+width);
    assert.equal(await page.locator('#community-chat-body').evaluate(n=>parseFloat(getComputedStyle(n).fontSize)>=16||innerWidth>700),true);
    if(width===390)await snapshot('chat-mobile');
  }
  await page.setViewportSize({width:390,height:920});await tab('feedback');await loaded();await snapshot('feedback-mobile');
  await page.locator('[data-post-id="'+xss.id+'"]').click();await page.locator('#community-post-body').filter({hasText:'其他客户端先保存'}).waitFor();await snapshot('detail-member-mobile');await page.locator('[data-community-close]').click();
  // Server permission boundary, independent of hidden controls.
  const denied=await page.evaluate(async()=>{const r=await fetch('/api/call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'community.posts.create',args:{key:crypto.randomUUID(),kind:'announcement',title:'越权',body:'不可发布'}})});return r.status;});assert.equal(denied,403);
  // Leaving the account while a request is unresolved must wipe its text.
  await tab('chat');await page.locator('#community-chat-body').fill('上一账号未确认内容');heldOperation='community.chat.send';await page.locator('#community-chat-form [type=submit]').click();await page.waitForFunction(()=>document.querySelector('#community-chat-form [type=submit]').disabled);
  await accountMenu(page);await page.locator('#switch-account').click();for(let i=0;!releaseHeld&&i<30;i++)await new Promise(r=>setTimeout(r,10));assert(releaseHeld);releaseHeld();
  await page.locator('#login-dialog').waitFor();await login('admin');await loaded();await tab('announcement');await loaded();
  assert.equal(await page.locator('#community-chat-body').inputValue(),'');assert.equal(await page.locator('#community-create').isVisible(),true);
  await page.locator('[data-post-id="'+announcement.id+'"]').click();await page.locator('#community-post-actions').getByRole('button',{name:'取消置顶',exact:true}).waitFor();
  await page.locator('#community-post-actions').getByRole('button',{name:'取消置顶',exact:true}).click();await page.locator('#community-post-actions').getByRole('button',{name:'置顶',exact:true}).waitFor();await page.locator('[data-community-close]').click();
  await tab('feedback');await loaded();await page.locator('[data-post-id="'+xss.id+'"]').click();await page.locator('#community-post-actions select').waitFor();
  assert.equal(await page.locator('#community-post-actions').getByRole('button',{name:'编辑',exact:true}).count(),0,'admin cannot rewrite member body');
  assert.equal(await page.locator('#community-post-actions').getByRole('button',{name:'置顶',exact:true}).count(),0,'only announcement can be pinned');
  await page.locator('#community-post-actions select').selectOption('resolved');await page.locator('#community-post-actions').getByRole('button',{name:'更新状态',exact:true}).click();await page.locator('#community-detail-status').filter({hasText:'已更新'}).waitFor();
  await snapshot('moderation-mobile');await page.locator('[data-community-close]').click();
  await page.locator('#community-filter').selectOption('resolved');await loaded();assert.equal(await page.locator('.community-post').count(),1);
  // Admin announcement create/edit/delete goes through the same real APIs.
  await tab('announcement');await loaded();clearRates();await page.locator('#community-create').click();
  await snapshot('compose-admin-mobile');
  await page.locator('#community-compose-form [name=title]').fill('临时测试公告');await page.locator('#community-compose-form [name=body]').fill('维护已完成');await page.locator('#community-compose-form [name=announcementType]').selectOption('notice');await page.locator('#community-compose-form [name=pinned]').check();await page.locator('#community-compose-form [type=submit]').click();await page.locator('.community-composer').waitFor({state:'hidden'});await loaded();assert.equal(service.db.prepare('SELECT pinned FROM community_posts WHERE title=?').get('临时测试公告').pinned,1);
  const temporary=service.db.prepare('SELECT id FROM community_posts WHERE title=?').get('临时测试公告');await page.locator('[data-post-id="'+temporary.id+'"]').click();await page.locator('#community-post-actions').getByRole('button',{name:'编辑',exact:true}).click();await page.locator('#community-compose-form [name=body]').fill('维护已完成，可以继续训练');await page.locator('#community-compose-form [type=submit]').click();await page.locator('.community-composer').waitFor({state:'hidden'});assert.equal(await page.locator('#community-post-body').innerText(),'维护已完成，可以继续训练');
  holdDeleteId=String(temporary.id);await page.locator('#community-post-actions').getByRole('button',{name:'删除',exact:true}).click();
  await page.locator('[data-community-close]').click();await page.locator('[data-post-id="'+announcement.id+'"]').click();await page.locator('#community-post-title').filter({hasText:'本周维护安排'}).waitFor();
  for(let i=0;!releaseDelete&&i<100;i++)await new Promise(r=>setTimeout(r,10));assert(releaseDelete);releaseDelete();await page.locator('#toast').filter({hasText:'已删除'}).waitFor();
  assert.equal(await page.locator('.community-detail').isVisible(),true,'late deletion reply must not close a different post');assert.equal(await page.locator('#community-post-title').innerText(),'本周维护安排');await page.locator('[data-community-close]').click();assert.equal(service.db.prepare('SELECT count(*) AS n FROM community_posts WHERE id=?').get(temporary.id).n,0);
  await tab('chat');await page.locator('#community-chat-body').fill('管理员测试消息');await page.locator('#community-chat-form [type=submit]').click();await page.waitForFunction(()=>document.querySelector('#community-chat-body').value==='');await page.locator('#chat-refresh').click();await loaded();
  const ownMessage=page.locator('.chat-message').filter({hasText:'管理员测试消息'});await ownMessage.getByRole('button',{name:'编辑',exact:true}).click();await page.locator('#community-compose-form [name=body]').fill('管理员修改后的消息');await page.locator('#community-compose-form [type=submit]').click();await page.locator('.community-composer').waitFor({state:'hidden'});await page.locator('.chat-message').filter({hasText:'管理员修改后的消息'}).waitFor();await page.locator('.chat-message').filter({hasText:'管理员修改后的消息'}).getByRole('button',{name:'删除',exact:true}).click();await page.locator('.chat-message').filter({hasText:'管理员修改后的消息'}).waitFor({state:'hidden'});
  // Keyboard tab navigation and all six narrow-screen app entries remain usable.
  await page.locator('[data-community-tab=chat]').focus();await page.keyboard.press('Home');assert.equal(await page.locator('[data-community-tab=posts]').getAttribute('aria-selected'),'true');await loaded();
  const phoneNav=await page.locator('[data-nav]').evaluateAll(nodes=>nodes.filter(n=>!n.hidden&&getComputedStyle(n).display!=='none').map(n=>({room:n.dataset.nav,height:n.getBoundingClientRect().height})));
  assert.deepEqual(phoneNav.map(n=>n.room),['work','resources','datasets','community','workshop','me']);
  assert.equal(phoneNav.every(n=>n.height>=44),true);
  // A temporarily missing backend does not pretend to publish locally.
  const unavailable=await context.newPage();await unavailable.route('**/api/call',route=>route.request().postDataJSON().operation.startsWith('community.')?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'协作维护中'})}):route.continue());await unavailable.goto(origin+'/#community');await unavailable.locator('#community-status').filter({hasText:'暂不可用'}).waitFor();assert.equal(await unavailable.locator('#community-create').isDisabled(),true);await unavailable.close();
  // Capacity refusal is a definite rollback, not an ambiguous network result.
  const count=service.db.prepare('SELECT count(*) AS n FROM community_posts').get().n;
  service.db.prepare("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?) INSERT INTO community_posts(author_id,kind,title,body,created_at,updated_at) SELECT ?,'feedback','capacity fixture','fixture',?,? FROM n").run(10000-count,alice.id,Date.now(),Date.now());clearRates();
  await tab('feedback');await loaded();await page.locator('#community-create').click();await page.locator('#community-compose-form [name=title]').fill('容量已满时仍可取消');await page.locator('#community-compose-form [name=body]').fill('保留可编辑的草稿');
  const capacityResponse=page.waitForResponse(r=>r.url()===origin+'/api/call'&&r.request().postDataJSON()?.operation==='community.posts.create');await page.locator('#community-compose-form [type=submit]').click();assert.equal((await capacityResponse).status(),507);await page.waitForFunction(()=>document.querySelector('#community-compose-error').textContent.length>0);
  assert.equal(await page.locator('#community-compose-form [name=body]').evaluate(n=>n.readOnly),false);await page.locator('#community-compose-form [name=body]').fill('仍可修改');await page.locator('.community-composer [data-compose-close]').first().click();await page.locator('.community-composer').waitFor({state:'hidden'});
  await browser.close();browser=null;await stop();await start();
  const restarted=(await service.login('alice',password)).token;
  assert.equal((await service.invoke(restarted,'community.posts.get',{id:xss.id})).result.post.status,'resolved');
  assert(service.db.prepare('SELECT count(*) AS n FROM community_chat').get().n>100);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  await writeFile(join(screenshots,'checks.json'),JSON.stringify({status:'passed',errors,external,captures,features:['real SQLite restart persistence','member/admin permissions','plain-text XSS','posts/comments cursor pages','105-message forward polling','unknown-send idempotent retry','deleted retry does not resurrect','409 preserves edit','429 preserves draft','auth reset','320–1440 responsive layout']},null,2));
  console.log(JSON.stringify({status:'passed',screenshots,requests:sent.length}));
}finally{await browser?.close();if(server)await stop();await rm(folder,{recursive:true,force:true});}
await import('./polish-rooms-ui-smoke.mjs');
