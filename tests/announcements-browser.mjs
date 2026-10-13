// Real HTTP, authentication and SQLite. No production accounts or GPU nodes.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {inspectGeometry} from './layout-geometry.mjs';

const folder=await mkdtemp(join(tmpdir(),'announcements-browser-'));
const screenshots=process.env.UI_SCREENSHOTS||'/tmp/gpuq-announcements-ui';
const password='Announcement-Fixture-Only-2026!',errors=[];
const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));
const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const origin=`http://127.0.0.1:${port}`,bootstrap=join(folder,'bootstrap.json');
let server,browser;
try{
  await mkdir(screenshots,{recursive:true});
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});
  const created=await createPortalServer({database:join(folder,'portal.sqlite'),bootstrap,origin,secure:false});
  server=created.server;const service=created.service;
  await new Promise(r=>server.listen(port,'127.0.0.1',r));
  const admin=(await service.login('admin',password)).token;
  const alice=(await service.invoke(admin,'users.create',{username:'alice',password,role:'member'})).result;
  await service.invoke(admin,'users.create',{username:'bob',password,role:'member'});
  const call=async(operation,args)=>(await service.invoke(admin,operation,args)).result;
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  async function login(username){
    const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin+'/#community');
    await page.locator('#login-form [name=username]').fill(username);
    await page.locator('#login-form [name=password]').fill(password);
    await page.locator('#login-form [type=submit]').click();
    await page.locator('#login-dialog').waitFor({state:'hidden'});
    return page;
  }
  const editor=await login('admin');
  await editor.locator('#community-publish-announcement').click();
  await editor.locator('#community-compose-form [name=title]').fill('雷霆大公告：仅 Alice 可见');
  await editor.locator('#community-compose-form [name=body]').fill('这是一份专属公告。\n'+('请阅读公告正文，确认后点击我知道了。\n').repeat(50));
  await editor.locator('#announcement-appearance-editor summary').click();
  await editor.locator('[name=layout]').selectOption('centered');
  await editor.locator('[name=background]').fill('#112233');
  await editor.locator('[name=accent]').fill('#ff8800');
  assert.equal(await editor.locator('.announcement-preview').evaluate(n=>getComputedStyle(n).backgroundColor),'rgb(17, 34, 51)');
  await editor.locator('#community-compose-form [name=audience]').selectOption('users');
  await editor.locator(`[name=audienceUser][value="${alice.id}"]`).check();
  assert.equal(await editor.locator('#community-compose-form [name=popup]').isChecked(),true);
  await editor.locator('#community-compose-form [type=submit]').click();
  await editor.locator('.community-composer').waitFor({state:'hidden'});
  const row=service.db.prepare('SELECT id,revision FROM community_posts WHERE title=?').get('雷霆大公告：仅 Alice 可见');
  assert.ok(row);
  const bob=await login('bob');
  assert.equal(await bob.locator('#announcement-dialog').isVisible(),false);
  assert.doesNotMatch(await bob.locator('#community-posts').innerText(),/雷霆大公告/);
  const page=await login('alice');
  await page.locator('#announcement-title').filter({hasText:'雷霆大公告'}).waitFor();
  assert.equal(await page.locator('#announcement-dialog').getAttribute('data-layout'),'centered');
  assert.equal(await page.locator('#announcement-dialog').evaluate(n=>getComputedStyle(n).backgroundColor),'rgb(17, 34, 51)');
  for(const width of [1440,390,320]){
    await page.setViewportSize({width,height:900});
    const geometry=await inspectGeometry(page,{roots:['#announcement-dialog[open]']});
    assert.deepEqual(geometry.failures,[],JSON.stringify(geometry));
    await page.screenshot({path:join(screenshots,`announcement-${width}.png`)});
  }
  await page.locator('#announcement-later').click();
  await page.locator('#announcement-dialog').waitFor({state:'hidden'});
  await page.reload();
  await page.locator('#announcement-title').filter({hasText:'雷霆大公告'}).waitFor();
  await page.locator('#announcement-ack').click();
  await page.locator('#announcement-dialog').waitFor({state:'hidden'});
  await page.reload();await page.locator('#community-create').waitFor();
  assert.equal(await page.locator('#announcement-dialog').isVisible(),false);
  const second=await login('alice');await second.locator('#community-create').waitFor();
  assert.equal(await second.locator('#announcement-dialog').isVisible(),false,'receipt follows account, not browser');
  await call('community.posts.update',{id:String(row.id),revision:row.revision,body:'新版本必须重新确认。'});
  await page.reload();await page.locator('#announcement-body').filter({hasText:'新版本必须重新确认'}).waitFor();
  assert.equal(await editor.locator('#announcement-dialog').isVisible(),false,'admin management access does not opt into recipient popup');
  assert.deepEqual(errors,[]);
  console.log('Announcement browser: audience editor, targeted login popup, 1440/390/320 geometry, later, account receipt and revision update passed.');
}finally{
  await browser?.close();
  if(server)await new Promise(r=>server.close(r));
  await rm(folder,{recursive:true,force:true});
}
