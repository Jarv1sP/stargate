import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {chromium} from 'playwright';
const root=resolve(import.meta.dirname,'../dist'),origin='https://terminal-recovery.test';
const id='11111111-2222-4333-8444-555555555555';
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
try{
 for(const width of [1440,390,320]){
  const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'}),page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());assert.equal(url.origin,origin);
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><link rel="stylesheet" href="/terminal.css"><link rel="stylesheet" href="/vendor/xterm.css"></head><body>
    <select name="terminal-machine"><option>fixture-node</option></select><select name="workspace-project"><option>demo</option></select>
    <button id="terminal-open">新建终端</button><button id="terminal-reconnect">重连</button><output id="notice"></output>
    <script src="/vendor/xterm.js"></script><script src="/vendor/addon-fit.js"></script>
    <script type="module">
    import {terminalUI,projectTerminalStorage} from '/terminal-ui.js';
    const record={userId:'member-a',machine:'fixture-node',project:'demo',id:'${id}'};
    window.calls=[];window.directory=[];window.statusState='UNKNOWN';window.openMissing=true;window.exchangeMissing=false;window.detachMissing=false;
    window.seed=()=>projectTerminalStorage(localStorage).remember(record);seed();
    document.addEventListener('gpuq-terminal-state',event=>window.directory=event.detail.sessions);
    const store={principal:{userId:'member-a',role:'member'},authGeneration:1,users:[{id:'member-a',enabled:true,limits:{'fixture-node':1}}],data:{machines:[{id:'fixture-node'}]},async call(op,args,options={}){
      calls.push({op,args});let result;
      const missing={id:args.id||args.key,state:'NOT_FOUND',canCreate:true,created:false};
      if(op==='terminal.status')result={id:args.id,state:statusState,...(statusState==='NOT_FOUND'?missing:{})};
      else if(op==='terminal.open')result=openMissing?missing:{id:args.key,writerToken:'fixture-writer',state:'OPEN'};
      else if(op==='terminal.exchange')result=exchangeMissing?missing:{offset:0,data:'',exited:false};
      else if(op==='terminal.detach')result=detachMissing?missing:{detached:true};
      else if(op==='terminal.close')result=missing;
      else throw Error('Unexpected RPC '+op);
      options.accept?.(result);return result;
    }};
    terminalUI(store,text=>document.querySelector('#notice').textContent=text);
    window.recover=state=>{statusState=state;document.dispatchEvent(new CustomEvent('gpuq-workspace-context',{detail:record}));};
    window.ready=true;
    </script></body></html>`});
   const path=resolve(root,'.'+url.pathname);assert.ok(path.startsWith(root+'/'));
   return route.fulfill({contentType:extname(path)==='.js'?'text/javascript':extname(path)==='.css'?'text/css':'application/octet-stream',body:await readFile(path)});
  });
  for(const [state,expected] of [['ALIVE','detached'],['STOPPED','ended'],['UNKNOWN','unknown'],['NOT_FOUND',null]]){
   await page.goto(origin);await page.waitForFunction(()=>window.ready);await page.evaluate(state=>recover(state),state);
   await page.waitForFunction(expected=>expected?directory[0]?.connectionState===expected:directory.length===0,expected);
   assert.equal(await page.evaluate(()=>calls.filter(c=>c.op==='terminal.open').length),0);
   if(state==='NOT_FOUND'){
    assert.match(await page.locator('#notice').textContent(),/原终端没有创建，可以新建/);
    assert.equal(await page.evaluate(()=>localStorage.length),0);
   }
  }
  // A reconnect and a delayed new-open response both use the missing branch,
  // never a success, STOPPED, or an automatic replacement request.
  page.on('dialog',dialog=>dialog.accept(id));
  await page.locator('#terminal-reconnect').click();await page.waitForFunction(()=>!document.querySelector('#terminal-reconnect').disabled);
  assert.match(await page.locator('#notice').textContent(),/原终端没有创建，可以新建/);
  assert.equal(await page.evaluate(()=>directory.length),0);
  assert.equal(await page.locator('#terminal-screen').count(),0);
  await page.locator('#terminal-open').click();await page.waitForFunction(()=>!document.querySelector('#terminal-open').disabled);
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.op==='terminal.open').length),2);
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.op==='terminal.exchange').length),0);
  assert.match(await page.locator('#notice').textContent(),/原终端没有创建，可以新建/);
  // A user can explicitly create a different terminal. If exchange discovers
  // absence, stop polling and expose the explicit new button.
  await page.evaluate(()=>{openMissing=false;exchangeMissing=true;});await page.locator('#terminal-open').click();
  await page.locator('#terminal-new').waitFor({state:'visible'});
  assert.match(await page.locator('#terminal-connection-note').textContent(),/原终端没有创建，可以新建/);
  assert.equal(await page.evaluate(()=>directory.length),0);
  const count=await page.evaluate(()=>calls.length);await page.waitForTimeout(900);assert.equal(await page.evaluate(()=>calls.length),count);
  await page.locator('#terminal-new').click();await page.waitForFunction(()=>calls.filter(c=>c.op==='terminal.open').length===4);
  const opened=await page.evaluate(()=>calls.filter(c=>c.op==='terminal.open').map(c=>c.args));
  assert.equal(opened[0].mode,'reconnect');assert.equal(opened[0].id,id);
  for(const request of opened.slice(1)){assert.equal(request.mode,'new');assert.notEqual(request.key,id);}
  assert.notEqual(opened[2].key,opened[3].key);
  await page.waitForFunction(()=>!document.querySelector('#terminal-open').disabled&&calls.filter(c=>c.op==='terminal.exchange').length===2);
  await page.locator('#terminal-stop').click();await page.waitForFunction(()=>!document.querySelector('.terminal-dialog').open);
  assert.match(await page.locator('#notice').textContent(),/原终端没有创建，可以新建/);
  assert.equal(await page.evaluate(()=>directory.length),0);assert.equal(await page.evaluate(()=>localStorage.length),0);
  await page.evaluate(()=>{exchangeMissing=false;detachMissing=true;document.querySelector('#notice').textContent='';});
  await page.locator('#terminal-open').click();await page.locator('.terminal-dialog').waitFor({state:'visible'});
  await page.locator('#terminal-disconnect').click();await page.waitForFunction(()=>directory.length===0);
  assert.match(await page.locator('#notice').textContent(),/原终端没有创建，可以新建/);
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.op==='terminal.open').length),5);
  assert.equal(await page.evaluate(()=>localStorage.length),0);
  assert.deepEqual(errors,[]);await context.close();console.log('PASS terminal NOT_FOUND recovery '+width);
 }
}finally{await browser.close();}
