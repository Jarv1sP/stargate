import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const origin='https://job-history.test';
const fixture=`import {installJobHistory} from '/job-history-ui.js';
const jobs=[1,2].map(i=>({id:'00000000-0000-4000-8000-'+String(i).padStart(12,'0'),machine:'gpu-1',name:i===1?'<img src=x onerror=alert(1)> 长任务名':'第二条记录',historyPurgeAt:'2030-06-08T00:00:00Z'}));
const removed=new Set();window.calls=[];window.failList=false;
window.store={principal:{userId:'viewer',role:new URL(location.href).searchParams.get('role')},authGeneration:1,refresh:async()=>{},call:async(operation,args)=>{
  calls.push({operation,args});
  if(operation==='jobs.history.restore'){removed.add(args.jobId);return {message:'已恢复任务记录，不会重跑训练。'};}
  if(failList){failList=false;throw Error('暂时无法读取，请刷新');}
  const available=jobs.filter(j=>!removed.has(j.id)),start=args.cursor?Number(args.cursor):0;
  const result={jobs:available.slice(start,start+1),nextCursor:start+1<available.length?String(start+1):null};
  if(window.deferList){window.deferList=false;return new Promise(resolve=>window.releaseList=()=>resolve(result));}
  return result;
}};
window.controller=installJobHistory(store,document.querySelector('#host'),text=>document.querySelector('#notice').textContent=text);controller.sync(true);`;
const browser=await chromium.launch({headless:true});
try{
  for(const role of ['member','admin'])for(const width of [1440,390,320]){
    const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route(origin+'/**',async route=>{
      const path=new URL(route.request().url()).pathname;
      if(path==='/')return route.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'"},body:'<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/workspace.css"><link rel="stylesheet" href="/jobs-room.css"></head><body class="sb"><div id="host"><div class="jr-toolbar"></div></div><p id="notice" role="status"></p><script type="module" src="/app.mjs"></script></body></html>'});
      if(path==='/app.mjs')return route.fulfill({contentType:'text/javascript',body:fixture});
      if(['/job-history-ui.js','/styles.css','/workspace.css','/jobs-room.css'].includes(path))return route.fulfill({contentType:path.endsWith('.js')?'text/javascript':'text/css',body:await readFile(new URL('../dist'+path,import.meta.url),'utf8')});
      return route.fulfill({status:404});
    });
    await page.goto(origin+'/?role='+role);await page.locator('#jobs-history-trash').click();
    const dialog=page.locator('dialog');await page.locator('[data-history-restore]').first().waitFor();
    assert.equal(await dialog.locator('img').count(),0,'task names remain text');
    await page.locator('[data-history-more]').click();await page.locator('[data-history-restore]').nth(1).waitFor();
    await page.locator('[data-history-restore]').first().click();await page.getByText('已恢复任务记录，不会重跑训练。',{exact:true}).waitFor();
    assert.equal(await page.locator('[data-history-restore="00000000-0000-4000-8000-000000000001"]').count(),0);
    assert.equal(await page.evaluate(()=>calls.some(c=>c.operation==='jobs.submit')),false);
    await page.locator('[data-history-close]').click();await page.evaluate(()=>{failList=true;});await page.locator('#jobs-history-trash').click();
    await page.getByText('暂时无法读取，请刷新',{exact:true}).waitFor();await page.locator('[data-history-refresh]').click();await page.waitForFunction(()=>!document.querySelector('[data-history-error]').textContent);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    assert.equal(await dialog.evaluate(d=>d.scrollWidth<=d.clientWidth+1),true);
    await page.locator('[data-history-close]').click();await page.evaluate(()=>{deferList=true;});await page.locator('#jobs-history-trash').click();
    await page.waitForFunction(()=>typeof releaseList==='function');
    await page.evaluate(()=>{store.principal={userId:'next',role:'member'};store.authGeneration++;controller.sync(true);releaseList();});
    assert.equal(await dialog.evaluate(d=>d.open),false);assert.equal(await page.locator('[data-history-list]').textContent(),'');
    await page.locator('#jobs-history-trash').click();await page.evaluate(()=>{const d=document.querySelector('dialog');d.close();document.querySelector('#jobs-history-trash').click();d.dispatchEvent(new Event('close'));});
    assert.equal(await dialog.evaluate(d=>d.open),true);
    await page.locator('[data-history-close]').click();assert.deepEqual(errors,[]);
    await context.close();console.log('PASS task history '+role+' '+width+': pagination, restore, error retry, identity reset, close/reopen and widths');
  }
}finally{await browser.close();}
