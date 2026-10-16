import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {resolve,join,extname} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';

const root=resolve(import.meta.dirname,'../dist'),origin='https://compute-fixture.test';
const temporary=await mkdtemp(join(tmpdir(),'compute-ui-')),shots=process.env.UI_SCREENSHOTS||temporary;
await mkdir(shots,{recursive:true});
const machines=[{id:'fixture-node-eight',cards:8,model:'Fixture GPU'},{id:'fixture-node-six',cards:6,model:'Fixture GPU'},{id:'fixture-node-unknown',cards:1,model:'Fixture GPU'}];
const task=(id,name,username)=>({id,name,submitter:{name:username,username}});
const own=task('own-job','我的训练','成员甲'),peer=task('peer-job','团队训练','成员乙');
function host(machine,index){
  return {id:machine.id,reachable:index!==2,checkedAt:'2026-10-15T18:00:00Z',gpuq:{connected:true,health:'ok'},
    gpus:Array.from({length:machine.cards},(_,index)=>({index,model:'Fixture GPU',memoryUsedMiB:index<3?4096:0,memoryTotalMiB:8192,utilization:index<3?75:0,temperatureC:42,powerDrawW:100,powerLimitW:350,processesAvailable:index!==3,
      processes:index===0?[{pid:101,name:'python',owner:'fixture-user',memoryUsedMiB:4096,task:own}]:index===1?[{pid:102,memoryUsedMiB:1024,task:own},{pid:103,memoryUsedMiB:3072,task:peer}]:index===2?[{pid:104,memoryUsedMiB:4096,task:peer}]:[]})),
    disks:(index===0?['ssd','hdd']:['ssd']).map(name=>({mountPoint:'/fixture/'+name,totalBytes:1024**4,usedBytes:256*1024**3,availableBytes:768*1024**3})),
    tasks:[{...peer,state:'QUEUED',priority:'normal',gpuCount:2,assignedGpuIndices:[],updatedAt:'2026-10-15T18:00:00Z'}]};
}
const browser=await chromium.launch({headless:true,...process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}});
try{
  for(const role of ['member','admin'])for(const width of [1440,390,320]){
    const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'}),page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(10000);
    const data={machines,principal:{userId:'member-a',role},users:[{id:'member-a',role,limits:{},total:0}],jobs:[{id:'own-job',userId:'member-a'}],gpuq:{stale:false,checkedAt:'2026-10-15T18:00:00Z',hosts:machines.map(host)}};
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());assert.equal(url.origin,origin);
      if(url.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',headers:{'Content-Security-Policy':"style-src 'self'"},body:`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">${['styles.css','fonts.css','starbase.css','shell.css','workspace.css','workbench.css','maintenance-experience.css','resources.css','portal-shell.css'].map(name=>'<link rel="stylesheet" href="/'+name+'">').join('')}</head><body class="sb"><main id="main-content"><div class="heading-actions"></div><section id="page-resources"><span id="resource-summary"></span><p id="monitor-status"></p><div id="machine-grid"></div></section></main><script type="module">
        import {resourcesUI} from '/resources-ui.js';
        const fixture=${JSON.stringify(data)};let room='resources',auth;
        const store={principal:fixture.principal,users:fixture.users,jobs:fixture.jobs,production:true,data:{gpuq:fixture.gpuq},usage:()=>0,onAuthChange:callback=>{auth=callback;}};
        const render=resourcesUI(store,{machines:fixture.machines,getPage:()=>room,navigate:page=>{room=page;render();}});
        window.refresh=render;window.fixture=fixture;window.store=store;
        window.leave=()=>{room='work';render();};window.logout=()=>{store.principal=null;auth();};render();
      </script></body></html>`});
      const path=resolve(root,'.'+url.pathname);assert.ok(path.startsWith(root+'/'));
      return route.fulfill({contentType:extname(path)==='.js'?'text/javascript':extname(path)==='.css'?'text/css':extname(path)==='.woff2'?'font/woff2':'application/octet-stream',body:await readFile(path)});
    });
    try{
      await page.goto(origin);await page.locator('.resource-chassis-bays button').first().waitFor();await page.evaluate(()=>document.fonts.ready);
      // The portal CSP blocks inline style attributes; the rack labels must still form one column per GPU.
      assert.equal(await page.locator('.resource-baylabels').evaluate(node=>getComputedStyle(node).gridTemplateColumns.split(' ').length),8);
      const bays=page.locator('.resource-chassis-bays button');assert.equal(await bays.count(),8);
      assert.equal(await page.locator('.resource-disks .resource-disk').count(),2);
      assert.equal(await page.locator('[data-summary]').count(),3);
      assert.deepEqual(await page.locator('[data-summary]').allTextContents(),['未知','未知','未知']);
      assert.match(await page.locator('[data-resource-queue-row]').innerText(),/P2 · 2 张/);assert.equal(await page.locator('.resource-queue details').count(),0);
      await page.evaluate(()=>{
        const sample=structuredClone(window.fixture.gpuq);sample.hosts[2].reachable=true;
        for(const host of sample.hosts)for(const gpu of host.gpus)gpu.processesAvailable=true;
        sample.hosts[0].disks=sample.hosts[0].disks.map(disk=>({...disk,totalBytes:0,usedBytes:0,availableBytes:0}));
        window.store.data.gpuq=sample;window.refresh();
      });
      assert.deepEqual(await page.locator('[data-summary]').allTextContents(),['8','7','3']);
      assert.equal(await page.locator('.resource-disks .resource-disk.unknown').count(),2);assert.doesNotMatch(await page.locator('.resource-disks').innerText(),/空间不足|0\.0/);
      await page.evaluate(()=>{window.store.data.gpuq=window.fixture.gpuq;window.refresh();});
      const targets=await page.locator('#machine-grid button,#machine-grid summary').evaluateAll(nodes=>nodes.filter(node=>node.getClientRects().length).map(node=>({label:node.getAttribute('aria-label')||node.textContent,width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height})));
      assert.ok(targets.every(r=>r.width>=44&&r.height>=44),JSON.stringify(targets.filter(r=>r.width<44||r.height<44)));
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
      assert.equal(await page.locator('.resource-chassis-bays .resource-tower-bar.unknown').count(),1);
      await page.screenshot({path:join(shots,`compute-${role}-${width}-memory.png`),fullPage:true,animations:'disabled'});
      await page.locator('[data-resource-metric=utilization]').click();assert.equal(await page.locator('[data-resource-metric=utilization]').getAttribute('aria-pressed'),'true');
      assert.equal(await page.locator('.resource-chassis-bays [data-resource-level]').first().getAttribute('data-resource-level'),'75');
      await page.locator('.resource-chassis-bays [data-resource-card="1"]').click();await page.locator('#resource-sheet[open]').waitFor();
      assert.equal(await page.locator('#resource-sheet [data-resource-gpu]').getAttribute('data-resource-gpu'),'1');assert.match(await page.locator('#resource-sheet').innerText(),/我的训练/);assert.match(await page.locator('#resource-sheet').innerText(),/团队训练/);
      await page.locator('[data-resource-gpu-picker]').selectOption('0');assert.equal(await page.locator('#resource-sheet [data-resource-gpu]').getAttribute('data-resource-gpu'),'0');
      assert.equal((await page.locator('#resource-sheet').innerText()).includes('fixture-user'),role==='admin');
      await page.evaluate(()=>window.refresh());assert.equal(await page.locator('#resource-sheet').isVisible(),true);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
      await page.screenshot({path:join(shots,`compute-${role}-${width}-gpu.png`),animations:'disabled'});
      await page.keyboard.press('Escape');await page.locator('#resource-sheet').waitFor({state:'hidden'});assert.equal(await page.locator('.resource-chassis-bays [data-resource-card="1"]').evaluate(node=>document.activeElement===node),true);
      await page.locator('.resource-chassis-bays [data-resource-card="2"]').click();await page.locator('#resource-sheet[open]').waitFor();await page.keyboard.press('Escape');await page.locator('#resource-sheet').waitFor({state:'hidden'});assert.equal(await page.locator('.resource-chassis-bays [data-resource-card="2"]').evaluate(node=>document.activeElement===node),true);
      await page.locator('[data-resource-select="fixture-node-six"]').click();assert.equal(await page.locator('.resource-chassis-bays button').count(),6);
      assert.equal(await page.locator('[data-resource-metric=utilization]').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('.resource-disks .resource-disk').count(),1);
      assert.match(await page.locator('.resource-disks').innerText(),/SSD · 工作区与数据集共用/);assert.doesNotMatch(await page.locator('.resource-disks').innerText(),/HDD/);
      await page.screenshot({path:join(shots,`compute-${role}-${width}-single-disk.png`),fullPage:true,animations:'disabled'});
      await page.locator('[data-resource-select="fixture-node-unknown"]').click();assert.equal(await page.locator('.resource-chassis-bays .resource-tower-bar.unknown').count(),1);assert.match(await page.locator('.resource-disks').innerText(),/未知/);
      await page.locator('.resource-chassis-bays button').click();await page.locator('#resource-sheet[open]').waitFor();await page.evaluate(()=>window.leave());await page.locator('#resource-sheet').waitFor({state:'hidden'});
      await page.evaluate(()=>window.logout());assert.equal(await page.locator('#machine-grid').textContent(),'');
      assert.deepEqual(errors,[]);console.log(`compute ${role} ${width} PASS`);
    }finally{await context.close();}
  }
}finally{await browser.close();if(!process.env.UI_SCREENSHOTS)await rm(temporary,{recursive:true,force:true});}
