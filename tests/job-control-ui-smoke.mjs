import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,join,extname} from 'node:path';
import {chromium} from 'playwright';

const root=resolve(process.env.JOB_CONTROL_UI_ROOT||'dist'),origin='http://127.0.0.1:4188';
const shots=process.env.JOB_CONTROL_SHOTS;if(shots)await mkdir(shots,{recursive:true});
const jobs=['own','peer'].map((name,index)=>({id:name+'-job',userId:name==='own'?'member-a':'member-b',
  ownerId:'member-a',name:name+' training',username:name,project:'shared',machine:'gpu-1',cards:1,
  state:'PENDING',priority:'normal',schedulerPriority:2,createdAt:new Date(Date.now()+index).toISOString()}));
const browser=await chromium.launch({headless:true,...process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}});
try{
  for(const role of ['member','admin'])for(const width of [1440,390,320]){
    const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'}),page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());assert.equal(url.origin,origin);
      if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1">
        ${['styles','fonts','starbase','shell','workbench','jobs-room'].map(name=>'<link rel="stylesheet" href="/'+name+'.css">').join('')}
        <body class="sb"><main><div class="heading-actions"></div><section id="jobs-room"></section><section id="table-check" hidden></section></main><script type="module">
        import {jobsRoom} from '/jobs-room.js';import {taskTable} from '/execution-ui.js';
        const store={principal:{userId:'member-a',role:${JSON.stringify(role)}},jobs:${JSON.stringify(jobs)},data:{gpuq:{hosts:[]}},
          async call(op,args){return op==='jobs.logs'?{text:'shared log'}:op==='jobs.diagnostics'?{state:'COMPLETE'}:op==='community.notes.list'?{notes:[]}:{state:'PENDING'};}};
        const render=jobsRoom(store,{machines:[{id:'gpu-1',cards:8}],toast(){},getPage:()=> 'jobs'});render();
        window.renderTable=id=>document.querySelector('#table-check').innerHTML=taskTable(store.jobs.filter(j=>j.id===id),{admin:store.principal.role==='admin',userId:store.principal.userId});
        </script></html>`});
      const path=resolve(root,'.'+url.pathname);assert.ok(path.startsWith(root+'/'));
      return route.fulfill({contentType:extname(path)==='.js'?'text/javascript':extname(path)==='.css'?'text/css':'application/octet-stream',body:await readFile(path)});
    });
    try{
      await page.goto(origin);await page.locator('[data-scope=all]').click();
      assert.equal(await page.locator('.jr-row').count(),2);
      for(const id of ['own-job','peer-job']){
        const permitted=id==='own-job'||role==='admin';
        await page.locator(`[data-job="${id}"]`).click();const drawer=page.locator('.jr-drawer.on');await drawer.waitFor();
        assert.equal(await drawer.locator('[data-cancel]').count(),permitted?1:0,role+'/'+id+' cancel');
        assert.equal(await drawer.locator('[data-priority]').count(),permitted?5:0,role+'/'+id+' priority');
        await drawer.locator('[data-tab=diag]').click();
        assert.equal(await drawer.locator('[data-recover="jobs.watch"]').count(),1);
        assert.equal(await drawer.locator('[data-recover="jobs.completion"]').count(),1);
        await drawer.locator('[data-tab=log]').click();assert.match(await drawer.locator('[data-log]').innerText(),/shared log/);
        await page.evaluate(id=>window.renderTable(id),id);
        assert.equal(await page.locator('#table-check [data-job-cancel]').count(),permitted?1:0);
        assert.equal(await page.locator('#table-check [data-job-priority-save]').count(),permitted?1:0);
        if(shots&&id==='peer-job')await page.screenshot({path:join(shots,`job-control-${role}-${width}.png`),fullPage:true,animations:'disabled'});
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
        await drawer.locator('.jr-x').click();
      }
      assert.deepEqual(errors,[]);console.log(`PASS job controls ${role}/${width}: submitter/admin controls, peer read access, table and drawer`);
    }finally{await context.close();}
  }
}finally{await browser.close();}
