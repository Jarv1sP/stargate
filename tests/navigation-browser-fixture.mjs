// Runs from the existing transfers HTTP smoke entry in CI. Real Portal,
// cookies and CSP; only disposable accounts and synthetic node observations.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/machines.js';

const directory=await mkdtemp(join(tmpdir(),'dataset-navigation-'));
const password='Local-Navigation-Fixture-Only-2026!',errors=[];
let server,service,browser;
try{
  const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const bootstrap=join(directory,'bootstrap');await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});
  ({server,service}=await createPortalServer({database:join(directory,'portal.db'),bootstrap,origin,secure:false,bridge:async(machine,operation)=>{
    if(operation==='projects.list')return {projects:[]};
    if(operation==='datasets.list')return {datasets:[]};
    if(operation==='datasets.capacity')return {filesystemBytes:1024**4,availableBytes:512*1024**3,reserveBytes:20*1024**3,usableBytes:492*1024**3,totalInodes:100000,availableInodes:50000,inodeUsageKnown:true,guarded:true};
    throw Error('Unexpected fixture node operation '+operation);
  }}));
  clearInterval(service.executionTimer);await new Promise(resolve=>server.listen(new URL(origin).port,'127.0.0.1',resolve));
  const admin=await service.login('admin',password);
  const member=(await service.invoke(admin.token,'users.create',{username:'navigation-member',password})).result;
  await service.invoke(admin.token,'policy.full',{userId:member.id,policyVersion:0});
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  async function login(page,username,hash=''){
    await page.goto(origin+'/'+hash);await page.locator('#login-form [name=username]').fill(username);
    await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();
    await page.locator('#login-dialog').waitFor({state:'hidden'});await page.evaluate(()=>document.fonts.ready);
  }
  const memberPage=await browser.newPage({viewport:{width:1440,height:1000}});memberPage.on('pageerror',error=>errors.push(error.message));
  const assertTransfer=async page=>{
    await page.locator('#page-transfers').waitFor({state:'visible'});
    assert.equal(await page.evaluate(()=>location.hash),'#datasets/transfers');
    assert.equal(await page.locator('#room-nav [aria-current=page]').getAttribute('data-nav'),'datasets');
    assert.equal(await page.locator('body').getAttribute('data-room'),'datasets');
    assert.equal(await page.locator('#page-title').textContent(),'存储');
    assert.equal(await page.locator('#page-transfers .data-room-tabs [aria-current=page]').textContent(),'传输与导入');
    assert.equal(await page.locator('#page-datasets').isVisible(),false);
  };
  await login(memberPage,member.username,'#transfers');await assertTransfer(memberPage);
  await memberPage.reload();await assertTransfer(memberPage);
  assert.equal(await memberPage.locator('#login-dialog').isVisible(),false,'canonical tab survives a cookie-backed reload');
  assert.equal(await memberPage.locator('#room-nav [data-nav=transfers]').count(),0);
  assert.deepEqual(await memberPage.locator('#room-nav [data-nav]:visible').evaluateAll(nodes=>nodes.map(node=>node.dataset.nav)),['work','resources','datasets','community','workshop']);
  await memberPage.locator('[data-nav=work]').click();await memberPage.keyboard.press('Control+k');
  await memberPage.locator('#control-command').fill('传输');assert.equal(await memberPage.locator('#control-suggestions [data-command-id]').count(),1);
  await memberPage.keyboard.press('Enter');await assertTransfer(memberPage);
  await memberPage.locator('#mission-control').waitFor({state:'hidden'});
  await memberPage.locator('#page-transfers .data-room-tabs a[href="#datasets"]').click();
  await memberPage.locator('#page-datasets').waitFor({state:'visible'});
  assert.equal(await memberPage.locator('.room-transition-layer').count(),0,'dataset tabs do not animate a second room');
  assert.equal(await memberPage.locator('.desktop-route-slide').count(),0);
  assert.equal(await memberPage.locator('[data-nav=datasets]').textContent(),'存储');
  await memberPage.evaluate(()=>location.hash='#storage');await memberPage.waitForFunction(()=>location.hash==='#datasets');
  assert.equal(await memberPage.locator('#page-title').textContent().then(text=>text.startsWith('存储')),true);
  assert.equal(await memberPage.locator('[data-storage-view=warehouse]').getAttribute('aria-selected'),'true');
  const records=memberPage.locator('#warehouse-page-actions a[href="#datasets/transfers"]');assert.equal(await records.textContent(),'传输记录');assert.equal(await memberPage.locator('#page-datasets .data-room-tabs').count(),0,'one warehouse has no duplicate dataset tabs');await records.click();await assertTransfer(memberPage);
  // Existing control-strip/notification callers keep their `transfers` target.
  await memberPage.locator('[data-nav=work]').click();
  await memberPage.evaluate(()=>{location.hash='transfers';});await assertTransfer(memberPage);
  const adminPage=await browser.newPage({viewport:{width:1440,height:1000}});adminPage.on('pageerror',error=>errors.push(error.message));
  await login(adminPage,'admin','#datasets/transfers');await assertTransfer(adminPage);
  assert.deepEqual(await adminPage.locator('#room-nav [data-nav]:visible').evaluateAll(nodes=>nodes.map(node=>node.dataset.nav)),['work','resources','datasets','community','workshop']);
  // Direction follows the dataset room, including the legacy transfer route.
  for(const [from,to,expected] of [['resources','transfers','translateX(24px)'],['community','transfers','translateX(-24px)']]){
    const direction=await adminPage.evaluate(({from,to})=>{
      document.querySelector(`[data-nav="${from}"]`).click();location.hash=to;dispatchEvent(new HashChangeEvent('hashchange'));
      const animation=document.querySelector('#page-transfers').getAnimations().find(animation=>animation.effect.getTiming().duration===280);
      return animation?.effect.getKeyframes()[0].transform;
    },{from,to});assert.equal(direction,expected);
  }
  for(const page of [memberPage,adminPage]){await page.locator('#context-machine').selectOption(MACHINES[0].id);await page.waitForFunction(()=>!document.querySelector('[name=workspace-machine]').disabled);}
  const shots=process.env.UI_SCREENSHOTS;
  for(const [role,page] of [['member',memberPage],['admin',adminPage]])for(const width of [1440,390,320]){
    await page.setViewportSize({width,height:width<760?844:1000});await assertTransfer(page);
    const geometry=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,
      topbar:document.querySelector('#app-topbar').getBoundingClientRect().toJSON(),
      nav:[...document.querySelectorAll('#room-nav [data-nav]')].filter(node=>node.getBoundingClientRect().width>0&&node.getBoundingClientRect().height>0).map(node=>({id:node.dataset.nav,height:node.getBoundingClientRect().height})),
      controls:[...document.querySelectorAll('#app-topbar .brand,#app-topbar .guide-link,#refresh-state,#account-menu-toggle')].filter(node=>node.getBoundingClientRect().width>0).map(node=>node.getBoundingClientRect().toJSON())}));
    assert.ok(geometry.scroll<=width+1,`no page overflow at ${role}/${width}: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.topbar.left>=-1&&geometry.topbar.right<=width+1,'topbar fits the viewport');
    assert.ok(geometry.controls.every(rect=>rect.left>=-1&&rect.right<=width+1),'topbar controls are not clipped');
    if(width<760){assert.deepEqual(geometry.nav.map(item=>item.id),['work','resources','datasets','community','workshop','me']);assert.ok(geometry.nav.every(item=>item.height>=44));}
    if(shots){await page.mouse.move(0,200);await mkdir(shots,{recursive:true});await page.screenshot({path:join(shots,`navigation-${role}-${width}.png`),animations:'disabled'});}
  }
  await memberPage.emulateMedia({reducedMotion:'reduce'});await memberPage.locator('[data-nav=work]').click();
  await memberPage.evaluate(()=>{location.hash='transfers';});await assertTransfer(memberPage);
  assert.ok(await memberPage.evaluate(()=>document.querySelector('#page-transfers').getAnimations().every(animation=>animation.effect.getKeyframes().every(frame=>!frame.transform||frame.transform==='none'))));
  await memberPage.evaluate(()=>{location.hash='users';});await memberPage.locator('#admin-denied').waitFor({state:'visible'});
  assert.equal(await memberPage.locator('#page-users').isVisible(),false,'member deep links do not expose the admin room');
  assert.ok(MACHINES.length);assert.deepEqual(errors,[]);
  console.log('DATASET NAVIGATION PASS: legacy/canonical/auth/reload routes, member/admin counts and order, transfer command, same-room tabs and direction, reduced motion, 1440/390/320 topbar, six mobile tabs, admin guard.');
}finally{
  await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}else service?.close();
  await rm(directory,{recursive:true,force:true});
}
