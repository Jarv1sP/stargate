import assert from 'node:assert/strict';
import {join} from 'node:path';
import {refreshVisible} from './starbase-workflows.mjs';

// Run inside the real directory workflow fixture, using its in-memory job.
export async function checkLayout({page,shots,role,width,job}) {
  const shot=name=>page.screenshot({path:join(shots,`${role}-${width}-aispace-${name}.png`),animations:'disabled'});
  const drawer=page.locator('.jr-drawer.on');
  assert.equal(await page.locator('#jobs-room .jr-toolbar #jobs-new').count(),1);
  await drawer.locator('[data-aispace-detail]').click();
  assert.equal(await drawer.locator('.jr-hud').isVisible(),true);
  assert.equal(await drawer.locator('[data-log]').isVisible(),false);
  await shot('details');
  await drawer.locator('[data-tab=log]').click();
  assert.equal(await drawer.locator('.jr-hud').isVisible(),false);
  assert.equal(await drawer.locator('[data-log]').isVisible(),true);
  assert.equal(await drawer.locator('[data-log]>div').first().evaluate(node=>getComputedStyle(node,'::before').content),'counter(aispace-log)');
  const logText=await drawer.locator('[data-log]').textContent();
  await page.evaluate(()=>{document.body.dataset.workshopLayout='default';dispatchEvent(new CustomEvent('stargate:theme-change',{detail:{layout:'default'}}));});
  assert.equal(await page.locator('.aispace-cells,.aispace-table-head,[data-aispace-detail]').count(),0);
  assert.equal(await drawer.locator('[data-tab=log]').textContent(),'日志');
  assert.equal(await page.locator('.heading-actions #jobs-new').count(),1);
  assert.equal(await drawer.locator('[data-log]').textContent(),logText);
  await page.evaluate(()=>{document.body.dataset.workshopLayout='aispace';dispatchEvent(new CustomEvent('stargate:theme-change',{detail:{layout:'aispace'}}));});
  await drawer.locator('[data-aispace-detail]').waitFor();
  await drawer.locator('[data-aispace-detail]').click();
  await page.evaluate(()=>{window.aispaceAdapter.dispose();});
  assert.equal(await page.locator('[data-aispace-detail],.aispace-cells,.aispace-breadcrumb').count(),0);
  assert.equal(await drawer.locator('[data-tab=log]').getAttribute('aria-selected'),'true');
  await page.evaluate(()=>{window.aispaceAdapter=window.mountAISpace();});
  await drawer.locator('[data-aispace-detail]').waitFor();
  await page.keyboard.press('Escape');
  const identity={submitter:job.submitter,userId:job.userId,username:job.username};
  for(const [fields,expected] of [
    [{submitter:{name:'提交人显示名',username:'submitter-account'}},'提交人显示名'],
    [{submitter:{username:'submitter-account'}},'submitter-account'],
    [{submitter:null},'成员乙'],
    [{userId:'missing-user',username:'job-account'},'job-account'],
    [{username:null},'成员未知'],
  ]){
    Object.assign(job,fields);await refreshVisible(page);
    await page.waitForFunction(expected=>{window.aispaceAdapter.render();return document.querySelector('[data-label="创建人"]')?.textContent===expected;},expected);
    assert.equal(await page.locator(`[data-job="${job.id}"] [data-label="创建人"]`).textContent(),expected);
  }
  Object.assign(job,identity);await refreshVisible(page);
  const original={state:job.state,error:job.error};
  job.state='UNKNOWN';await refreshVisible(page);
  await page.locator('.aispace-cell[data-state=UNKNOWN]').filter({hasText:'状态待核对'}).waitFor();
  job.state='FAILED';job.error='示例：训练进程退出，请检查日志。';
  await refreshVisible(page);
  const row=page.locator(`[data-job="${job.id}"]`);
  await row.locator('.aispace-cell[data-state=FAILED]').waitFor();
  assert.match(await row.locator('.aispace-cells').innerText(),/失败/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const nav=await page.locator('#room-nav .nav-item').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right};}));
  assert.equal(nav.length,6);assert.ok(nav.every(r=>r.width>=44&&r.height>=44));
  if(width<760){assert.ok(nav.every(r=>Math.abs(r.y-nav[0].y)<1&&r.right<=width));}
  await shot('failed-table');
  await row.click();await drawer.locator('[data-log]').filter({hasText:'fixture log'}).waitFor();
  assert.match(await drawer.innerText(),/训练进程退出/);await shot('failed-log');
  Object.assign(job,original);await page.keyboard.press('Escape');await refreshVisible(page);await row.click();
  await drawer.locator('[data-log]').filter({hasText:'fixture log'}).waitFor();
}
