// Browser-local synthetic receipts only. No server or user files are removed.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {inspectGeometry} from './layout-geometry.mjs';
const origin='https://offline-cleanup.test',screenshots='/tmp/stargate-cleanup-ui';
await mkdir(screenshots,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
try{for(const role of ['member','admin'])for(const width of [1440,390,320]){
  const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());assert.equal(url.origin,origin);
    if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+['styles','workspace','datasets','fonts','starbase','shell','dataset-flow'].map(name=>`<link rel="stylesheet" href="/${name}.css">`).join('')+'<body class="sb"><main><section id="page-datasets"></section></main>'});
    if(url.pathname==='/favicon.ico')return route.fulfill({status:204});
    assert(!url.pathname.includes('..'));return route.fulfill({body:await readFile(new URL('../dist'+url.pathname,import.meta.url)),contentType:url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.css')?'text/css':'font/woff2'});
  });
  await page.goto(origin);await page.evaluate(async role=>{
    const {dataWorkspaceUI,dataWorkspaceHTML}=await import('/data-workspace.js');
    const section=document.querySelector('#page-datasets');section.innerHTML='<select name="dataset-machine"><option>node-a</option><option>node-b</option></select>'+dataWorkspaceHTML();
    window.calls=[];window.receipts=new Map();window.lose=false;window.gate=false;window.capability=true;
    window.store={production:true,principal:{userId:'alice',role},authGeneration:0,data:{},async call(operation,args){
      calls.push({operation,args:structuredClone(args),user:this.principal.userId});
      if(operation==='datasets.workspace.list')return {path:args.path,...(capability?{cleanupProtocol:1}:{}),entries:[{name:'旧训练数据_需要清理',type:'directory'},{name:'keep.bin',type:'file',size:4}]};
      if(operation==='datasets.workspace.status')return {state:'EDITABLE'};
      if(operation==='datasets.workspace.remove-plan')return {protocol:1,...args,state:'PREVIEW',volume:{availableBytes:10*1024**3}};
      if(operation==='datasets.workspace.remove'){
        const result={protocol:1,...args,state:'QUEUED',freedBytes:null};receipts.set(args.key,result);
        if(gate)await new Promise(resolve=>window.release=resolve);
        if(lose){lose=false;throw Error('合成丢回包');}return result;
      }
      if(operation==='datasets.workspace.remove-status'){const result=receipts.get(args.key);if(!result)throw Error('not found');return structuredClone(result);}
      throw Error('unexpected operation '+operation);
    }};
    window.view=dataWorkspaceUI(store,section,()=>{});view.controls();
  },role);
  await page.locator('.data-workspace-browser').filter({has:page.locator('#data-workspace-refresh')}).locator(':scope > summary').click();
  await page.locator('#data-workspace-refresh').click();await page.waitForFunction(()=>document.querySelectorAll('[data-workspace-remove]').length===2);
  const target=page.locator('[data-workspace-remove]').first();
  page.once('dialog',d=>d.dismiss());await target.click();await page.waitForFunction(()=>!document.querySelector('#data-workspace-refresh').disabled);
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.operation==='datasets.workspace.remove').length),0,'cancelled confirmation must not delete');
  await page.evaluate(()=>{lose=true;});page.once('dialog',d=>d.accept());await target.click();
  await page.waitForFunction(()=>document.querySelector('#data-workspace-status').textContent==='合成丢回包');
  const request=await page.evaluate(()=>calls.find(c=>c.operation==='datasets.workspace.remove').args);
  assert.equal(await page.locator('#data-workspace-cleanup-status').isVisible(),true);
  await page.locator('#data-workspace-cleanup-status').click();await page.waitForFunction(()=>document.querySelector('#data-workspace-status').textContent.includes('已排队'));
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.operation==='datasets.workspace.remove').length),1);
  await page.evaluate(key=>Object.assign(receipts.get(key),{state:'UNKNOWN',retryable:true}),request.key);
  await page.locator('#data-workspace-cleanup-status').click();await page.locator('#data-workspace-cleanup-retry').waitFor();
  page.once('dialog',d=>d.accept());await page.locator('#data-workspace-cleanup-retry').click();
  await page.waitForFunction(()=>calls.filter(c=>c.operation==='datasets.workspace.remove').length===2&&!document.querySelector('#data-workspace-refresh').disabled);
  assert.deepEqual(await page.evaluate(()=>calls.filter(c=>c.operation==='datasets.workspace.remove').map(c=>c.args)),[request,request]);
  await page.evaluate(key=>Object.assign(receipts.get(key),{state:'SUCCEEDED',retryable:false}),request.key);
  await page.locator('#data-workspace-cleanup-status').click();await page.waitForFunction(()=>document.querySelector('#data-workspace-status').textContent.includes('已完成'));
  const geometry=await inspectGeometry(page,{roots:['.data-workspace-card'],controls:'[data-workspace-remove],#data-workspace-cleanup-status,#data-workspace-cleanup-retry'});
  assert.deepEqual(geometry.failures,[],JSON.stringify(geometry));assert(geometry.counts.controls>=3);
  await page.screenshot({path:`${screenshots}/${role}-${width}.png`,fullPage:true});
  // An accepted old-account operation must not update the next account.
  await page.evaluate(()=>{gate=true;});page.once('dialog',d=>d.accept());await page.locator('[data-workspace-remove="keep.bin"]').click();await page.waitForFunction(()=>typeof release==='function');
  await page.evaluate(()=>{store.principal={userId:'bob',role:'member'};store.authGeneration++;view.reset();view.controls();release();});
  await page.waitForTimeout(50);assert.equal(await page.locator('#data-workspace-cleanup-status').isHidden(),true);
  assert.equal(await page.evaluate(()=>calls.some(c=>c.user==='bob'&&c.operation.includes('remove'))),false);
  await page.evaluate(()=>{capability=false;});await page.locator('#data-workspace-refresh').click();await page.waitForFunction(()=>!document.querySelector('#data-workspace-refresh').disabled);
  assert.equal(await page.locator('[data-workspace-remove]').count(),0,'legacy nodes retain browse without delete capability');
  assert.deepEqual(errors,[]);await page.close();
}console.log('PRIVATE CLEANUP UI PASS: preview/cancel, lost reply, original UUID query/retry, account switch, legacy nodes, member/admin 1440/390/320 geometry.');}finally{await browser.close();}
