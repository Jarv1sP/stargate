import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {chromium} from 'playwright';

const root=resolve(import.meta.dirname,'../dist'),origin='https://backfill-fixture.test';
const browser=await chromium.launch({headless:true,...process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}});
try{
  for(const role of ['member','admin'])for(const width of [1440,390,320]){
    const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'}),page=await context.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());assert.equal(url.origin,origin);
      if(url.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${['styles.css','fonts.css','starbase.css','shell.css','workbench.css','jobs-room.css'].map(f=>'<link rel="stylesheet" href="/'+f+'">').join('')}</head><body class="sb"><main id="main-content"><div class="heading-actions"></div><section id="jobs-room"></section></main><script type="module">
        import {jobsRoom} from '/jobs-room.js';
        const userId='fixture-user';
        window.store={principal:{userId,role:${JSON.stringify(role)}},jobs:[
          {id:'head',userId,name:'三卡任务',machine:'fixture-node',cards:3,state:'PENDING',queueReason:'需要 3 张卡，当前可用 1 张；等待凑齐（已放行一批补位）'},
          {id:'borrower',userId,name:'临时任务',machine:'fixture-node',cards:1,state:'RUNNING',backfillFor:'head'},
          {id:'normal',userId,name:'普通任务',machine:'fixture-node',cards:1,state:'RUNNING'}
        ],call:()=>{throw Error('render must not write');}};
        window.render=jobsRoom(store,{toast:()=>{},machines:[],getPage:()=> 'jobs'});render();
      </script></body></html>`});
      const path=resolve(root,'.'+url.pathname);assert.ok(path.startsWith(root+'/'));
      return route.fulfill({contentType:extname(path)==='.js'?'text/javascript':extname(path)==='.css'?'text/css':'application/octet-stream',body:await readFile(path)});
    });
    await page.goto(origin);await page.locator('.jr-row[data-job=borrower]').waitFor();
    assert.match(await page.locator('[data-job=head]').innerText(),/需要 3 张卡，当前可用 1 张/);
    assert.match(await page.locator('[data-job=borrower]').innerText(),/临时借用空卡/);
    assert.doesNotMatch(await page.locator('[data-job=normal]').innerText(),/临时借用/);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await page.evaluate(()=>{store.jobs[1].backfillFor=null;render();});
    assert.doesNotMatch(await page.locator('[data-job=borrower]').innerText(),/临时借用/);
    assert.deepEqual(errors,[]);await context.close();
    console.log('PASS backfill '+role+' '+width+': reason, loan, clear and no overflow');
  }
}finally{await browser.close();}
