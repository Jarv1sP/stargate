// Real Portal/SQLite installation and recovery of a whole-interface work.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {workshopTestServer} from './workshop-test-server.mjs';
const f=await workshopTestServer();let browser;
try{
 const pkg={apiVersion:1,kind:'plugin',presentation:'interface',name:'整站演示测试',description:'安装后替换整个可见界面',permissions:[],html:'<h1>示例整站界面</h1><button id="action">模拟创建</button><p id="result"></p>',css:'body{background:#eef5ff;color:#234}',script:'document.querySelector("#action").onclick=()=>document.querySelector("#result").textContent="模拟创建成功";'};
 const published=(await f.call(f.alice.token,'workshop.publish',{key:randomUUID(),package:pkg})).body.result;
 browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000}});
 await context.addCookies([{name:'team_session',value:f.alice.token,url:f.origin,httpOnly:true,sameSite:'Strict'}]);
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(f.origin+'/#workshop');await page.locator('#startup-wordmark').waitFor({state:'hidden'});
 await page.locator('.workshop-card').filter({hasText:pkg.name}).getByRole('button').click();
 await page.locator('[data-workshop=install]').click();await page.locator('#workshop-confirm-accept').click();
 await page.frameLocator('.workshop-interface iframe').locator('h1').filter({hasText:'示例整站界面'}).waitFor();
 await page.locator('#workshop-detail').waitFor({state:'hidden'});
 const frameBox=await page.locator('.workshop-interface iframe').boundingBox();assert.deepEqual(frameBox,{x:0,y:0,width:1440,height:1000});
 assert.equal(await page.locator('.shell').evaluate(n=>n.inert),true);assert.equal(await page.locator('#room-nav').isVisible(),false);
 await page.frameLocator('.workshop-interface iframe').locator('#action').click();await page.frameLocator('.workshop-interface iframe').locator('#result').filter({hasText:'模拟创建成功'}).waitFor();
 await page.reload();await page.frameLocator('.workshop-interface iframe').locator('h1').waitFor();await page.locator('#startup-wordmark').waitFor({state:'hidden'});
 await page.getByRole('button',{name:'恢复平台界面'}).click();await page.locator('.workshop-interface').waitFor({state:'detached'});
 assert.equal(await page.locator('.shell').evaluate(n=>n.inert),false);assert.equal(await page.locator('#room-nav').isVisible(),true);
 assert.equal((await f.call(f.alice.token,'workshop.mine')).body.result.installed.length,0);
 assert.equal((await f.call(f.bob.token,'workshop.mine')).body.result.installed.length,0);
 await f.call(f.alice.token,'workshop.install',{id:published.item.id,version:1,permissions:[]});
 await page.goto(f.origin+'/?workshop=off#workshop');await page.locator('.workshop-card').first().waitFor();assert.equal(await page.locator('.workshop-interface').count(),0);
 assert.equal(f.ownJob.cancelRequested,false);assert.equal(f.otherJob.cancelRequested,false);assert.deepEqual(errors,[]);
 console.log('PASS whole-interface install, full viewport, mock interaction, reload persistence, portal recovery, per-account isolation and bypass');
}finally{await browser?.close();await f.close();}
