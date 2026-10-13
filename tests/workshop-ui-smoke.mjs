// Full browser -> current Portal API -> SQLite -> sandboxed plugin workflow.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {workshopTestServer} from './workshop-test-server.mjs';
import {inspectGeometry} from './layout-geometry.mjs';

const f=await workshopTestServer(),errors=[],requests=[];
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
const screenshots=process.env.UI_SCREENSHOTS;
if(screenshots)await mkdir(screenshots,{recursive:true});
const setup=async username=>{
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(r.url()===f.origin+'/api/call')requests.push(r.postDataJSON());});
  await page.goto(f.origin+'/#workshop');
  await page.locator('#login-form [name=username]').fill(username);
  await page.locator('#login-form [name=password]').fill(f.password);
  await page.locator('#login-form [type=submit]').click();
  await page.locator('#login-dialog').waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.querySelector('#page-workshop').hidden===false);
  await page.locator('[data-workshop=create]').waitFor({state:'visible'});
  await page.waitForFunction(()=>!document.querySelector('[data-workshop=create]').disabled);
  return {context,page};
};
const openItem=async(page,id)=>{
  await page.locator('#room-nav [data-nav=workshop]').click();
  await page.locator(`[data-workshop=detail][data-id="${id}"]`).click();
  await page.locator('#workshop-detail [data-workshop=install]').waitFor({state:'visible'});
};
const install=async page=>{
  await page.locator('#workshop-detail [data-workshop=install]').click();
  await page.locator('#workshop-confirm-accept').click();
  await page.waitForFunction(()=>document.querySelector('#workshop-detail [data-workshop=install]')?.textContent==='已安装此版本');
};
const publish=async(page,example)=>{
  await page.locator('[data-workshop=create]').click();
  await page.locator('#workshop-example').selectOption(example);
  await page.locator('#workshop-publish').click();
  await page.locator('#workshop-editor').waitFor({state:'hidden'});
  await page.locator('#workshop-detail').waitFor({state:'visible'});
  return f.service.db.prepare('SELECT id FROM workshop_items ORDER BY rowid DESC LIMIT 1').get().id;
};
const capture=async(page,name)=>{
  for(const width of [1440,390,320]){
    await page.setViewportSize({width,height:1000});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,name+' '+width);
    // A modal intentionally covers the inert page beneath it. Measure its
    // active controls, not the background toolbar as if both were interactive.
    const roots=name==='workshop-detail'?['#workshop-detail[open]']:['#page-workshop','#workshop-recovery','#workshop-widgets'];
    const geometry=await inspectGeometry(page,{roots});
    assert.deepEqual(geometry.failures,[],JSON.stringify({name,width,geometry}));
    if(screenshots)await page.screenshot({path:join(screenshots,`${name}-${width}.png`),fullPage:true});
  }
  await page.setViewportSize({width:1440,height:1000});
};
try{
  const alice=await setup('alice'),a=alice.page;
  const theme=await publish(a,'light');
  await a.locator('[data-workshop=preview]').click();
  assert.equal(await a.evaluate(()=>getComputedStyle(document.body).getPropertyValue('--bg').trim()),'#f3f3f0');
  assert.equal(await a.evaluate(()=>getComputedStyle(document.querySelector('#app-topbar .brand-wordmark')).color),
    await a.evaluate(()=>getComputedStyle(document.body).color),'brand must follow the chosen foreground, not stay white on a light theme');
  assert.equal(await a.evaluate(()=>getComputedStyle(document.body).getPropertyValue('--content').trim()),'1600px');
  assert.equal((await f.call(f.alice.token,'workshop.mine')).body.result.installed.length,0,'preview must not save');
  await a.locator('[data-workshop=stop-preview]').click();
  assert.notEqual(await a.evaluate(()=>getComputedStyle(document.body).getPropertyValue('--bg').trim()),'#f3f3f0');
  await install(a);
  await a.locator('[data-workshop=close-detail]').click();
  await a.reload();await a.waitForFunction(()=>getComputedStyle(document.body).getPropertyValue('--bg').trim()==='#f3f3f0');
  const plugin=await publish(a,'jobs');
  assert.equal((await f.call(f.alice.token,'workshop.mine')).body.result.installed.length,1,'publishing plugin never installs it');
  await a.locator('[data-workshop=close-detail]').click();

  const bob=await setup('bob'),b=bob.page;
  assert.notEqual(await b.evaluate(()=>getComputedStyle(document.body).getPropertyValue('--bg').trim()),'#f3f3f0','theme stays with its owner');
  await openItem(b,plugin);await install(b);await b.locator('[data-workshop=close-detail]').click();
  await b.locator('#room-nav [data-nav=work]').click();
  const iframe=b.locator('#workshop-widgets iframe'),frame=b.frameLocator('#workshop-widgets iframe');
  await frame.locator('#jobs').getByText('bob private training',{exact:true}).waitFor();
  assert.equal(await frame.locator('#jobs').getByText('alice training',{exact:true}).count(),0);
  assert.equal(await iframe.getAttribute('sandbox'),'allow-scripts');
  const isolated=await (await iframe.elementHandle()).contentFrame();
  assert.equal(await isolated.evaluate(()=>{try{parent.document.body;return false;}catch{return true;}}),true);
  assert.equal(await isolated.evaluate(()=>stargate.call('users.role',{role:'admin'}).then(()=>false,()=>true)),true);
  const before=requests.filter(r=>r.operation==='jobs.cancel').length;
  await frame.getByRole('button',{name:'取消任务',exact:true}).click();
  await b.getByRole('button',{name:'不取消',exact:true}).click();
  assert.equal(requests.filter(r=>r.operation==='jobs.cancel').length,before);
  await frame.getByRole('button',{name:'取消任务',exact:true}).click();
  assert.equal(f.otherJob.cancelRequested,false,'iframe cannot confirm itself');
  await b.getByRole('button',{name:'确认取消训练',exact:true}).click();
  await b.waitForFunction(()=>document.querySelector('#workshop-widgets iframe')!==null);
  await frame.locator('#status').filter({hasText:/仅显示本人任务|已请求取消/}).waitFor();
  assert.equal(f.otherJob.cancelRequested,true);assert.equal(f.ownJob.cancelRequested,false);
  assert.equal(requests.filter(r=>r.operation==='jobs.cancel').length,before+1);

  let frameLoads=0;b.on('request',r=>{if(r.url().includes('/workshop/frame/'))frameLoads++;});
  await b.locator('#room-nav [data-nav=resources]').click();
  await b.locator('#room-nav [data-nav=work]').click();
  assert.equal(frameLoads,0,'navigation animation must not clone and execute a second iframe');
  await capture(b,'workshop-widget');
  await b.goto(f.origin+'/?workshop=off#workshop');
  await b.waitForFunction(()=>document.querySelector('#workshop-status')?.textContent.includes('停用主题和插件'));
  assert.equal(await b.locator('#workshop-widgets iframe').count(),0);
  assert.equal((await f.call(f.bob.token,'workshop.mine')).body.result.installed.length,1,'bypass does not erase preferences');
  await b.locator('#workshop-recovery button').click();
  const resetReply=b.waitForResponse(r=>r.url()===f.origin+'/api/call'&&r.request().postDataJSON()?.operation==='workshop.reset');
  await b.locator('#workshop-confirm-accept').click();assert.equal((await resetReply).status(),200);
  assert.equal((await f.call(f.bob.token,'workshop.mine')).body.result.installed.length,0);
  assert.equal((await f.call(f.alice.token,'workshop.mine')).body.result.installed[0].item.id,theme);

  // The first publish commits but loses its HTTP reply. Explicit retry uses
  // exactly the same key and package; it must not create another version.
  await a.locator('[data-workshop=create]').click();await a.locator('#workshop-example').selectOption('gpu');
  let dropped=false;
  await a.route('**/api/call',async route=>{
    const body=route.request().postDataJSON();
    if(body.operation==='workshop.publish'&&!dropped){dropped=true;await route.fetch();return route.abort('connectionreset');}
    return route.continue();
  });
  await a.locator('#workshop-publish').click();
  await a.locator('#workshop-publish-error').filter({hasText:/./}).waitFor();
  const original=requests.filter(r=>r.operation==='workshop.publish').at(-1),versions=f.service.db.prepare('SELECT count(*) AS n FROM workshop_versions').get().n;
  await a.unroute('**/api/call');await a.locator('#workshop-publish').click();
  await a.locator('#workshop-editor').waitFor({state:'hidden'});
  assert.deepEqual(requests.filter(r=>r.operation==='workshop.publish').at(-1),original);
  assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM workshop_versions').get().n,versions);
  await capture(a,'workshop-detail');await a.locator('[data-workshop=close-detail]').click();
  await capture(a,'workshop-catalog');
  assert.deepEqual(errors,[]);
  assert.equal(f.service.store.jobs.length,2,'workshop never creates training');
  console.log('Workshop browser passed: publish, preview, persisted account install, actual iframe RPC, trusted cancel, original-key retry, safe mode, 1440/390/320. No real GPU jobs.');
}finally{await browser.close();await f.close();}
