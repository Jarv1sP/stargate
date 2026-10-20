// Real Portal + temporary SQLite. No GPU work or production accounts.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {workshopTestServer,pluginPackage} from './workshop-test-server.mjs';
import {inspectGeometry} from './layout-geometry.mjs';
const f=await workshopTestServer(),screenshots=process.env.UI_SCREENSHOTS||'/tmp/stargate-workshop-lean';
await mkdir(screenshots,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
const errors=[];
try{
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.addCookies([{name:'team_session',value:f.alice.token,url:f.origin,httpOnly:true,sameSite:'Strict'}]);
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(f.origin+'/#workshop');
  await page.locator('.workshop-card').filter({hasText:'浅色紧凑'}).waitFor();
  await page.locator('#startup-wordmark').waitFor({state:'hidden'});
  for(const width of [1440,390,320]){
    await page.setViewportSize({width,height:900});
    const geometry=await inspectGeometry(page,{roots:['#page-workshop','#room-nav']});
    assert.deepEqual(geometry.failures,[],JSON.stringify(geometry));
    await page.screenshot({path:`${screenshots}/catalog-${width}.png`});
  }
  await page.locator('.workshop-card').filter({hasText:'浅色紧凑'}).getByRole('button').click();
  await page.locator('[data-workshop=preview]').click();
  assert.equal(await page.locator('body').evaluate(n=>getComputedStyle(n).backgroundColor),'rgb(243, 243, 240)');
  await page.locator('[data-workshop=stop-preview]').click();
  await page.locator('[data-workshop=install]').click();await page.locator('#workshop-confirm-accept').click();
  await page.waitForFunction(()=>document.querySelector('[data-workshop=install]')?.textContent==='已安装此版本');
  await page.reload();await page.locator('.workshop-card').filter({hasText:'已安装 v1'}).waitFor();
  assert.equal(await page.locator('body').evaluate(n=>getComputedStyle(n).backgroundColor),'rgb(243, 243, 240)');
  assert.equal((await f.call(f.bob.token,'workshop.mine')).body.result.installed.length,0);

  await page.locator('[data-workshop=create]').click();
  await page.locator('#workshop-source').fill(JSON.stringify(pluginPackage,null,2));
  let lost=false;const keys=[];
  await page.route('**/api/call',async route=>{
    const request=route.request().postDataJSON();
    if(request.operation==='workshop.publish'){
      keys.push(request.args.key);
      if(!lost){lost=true;await route.fetch();return route.abort('failed');}
    }
    return route.continue();
  });
  await page.locator('#workshop-publish').click();
  await page.locator('#workshop-publish-error').filter({hasText:'待确认'}).waitFor();
  await page.locator('#workshop-publish').click();
  await page.locator('#workshop-editor').waitFor({state:'hidden'});
  assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);
  assert.equal(f.service.db.prepare("SELECT count(*) AS n FROM workshop_items WHERE kind='plugin'").get().n,1);
  await page.locator('[data-workshop=install]').click();await page.locator('#workshop-confirm-accept').click();
  await page.waitForFunction(()=>document.querySelector('[data-workshop=install]')?.textContent==='已安装此版本');
  await page.locator('[data-workshop=close-detail]').click();
  await page.locator('[data-nav=work]').click();
  const frame=page.frameLocator('#workshop-widgets iframe');await frame.locator('#result').filter({hasText:'alice training'}).waitFor();
  assert.doesNotMatch(await frame.locator('#result').innerText(),/bob private training/);
  await page.goto(f.origin+'/?workshop=off#workshop');await page.locator('.workshop-card').first().waitFor();
  assert.equal(await page.locator('#workshop-widgets iframe').count(),0);
  await page.locator('#workshop-recovery button').click();await page.locator('#workshop-confirm-accept').click();
  await page.waitForFunction(()=>!document.querySelector('.workshop-card')?.textContent.includes('已安装 v'));
  assert.equal((await f.call(f.alice.token,'workshop.mine')).body.result.installed.length,0);
  assert.equal(f.ownJob.cancelRequested,false);assert.equal(f.otherJob.cancelRequested,false);assert.deepEqual(errors,[]);
  console.log('Workshop UI passed: builtin preview/install, persistence, per-account choices, lost-reply retry, plugin, bypass/reset, 1440/390/320.');
}finally{await browser.close();await f.close();}
