// Real opaque-origin frames and MessagePorts against a disposable loopback
// server. All state and cancellation replies are synthetic; no GPU or account
// outside this fixture is touched.
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {renderWorkshopFrame} from '../workshop-frame.mjs';

const nonce='workshop-browser-nonce-123456';
const theme={item:{id:'theme',version:1},package:{kind:'theme',name:'测试主题',theme:{tokens:{'--bg':'#123456'},width:'wide',density:'compact',columns:2}}};
const packages=new Map([
  ['reader',{kind:'plugin',name:'只读组件',permissions:['resources.read','jobs.read'],html:'<p id="ready">加载中</p>',css:'p{margin:0}',script:`window.receipts={};Promise.all([stargate.call('resources.read'),stargate.call('jobs.read')]).then(([resources,jobs])=>{receipts={resources,jobs};document.querySelector('#ready').textContent='已连接';});`}],
  ['cancel',{kind:'plugin',name:'取消组件',permissions:['jobs.read','jobs.cancel','ui.navigate'],html:'<button id="cancel">取消我的任务</button>',css:'',script:`document.querySelector('#cancel').onclick=()=>stargate.call('jobs.cancel',{jobId:'mine'}).then(result=>window.result=result).catch(error=>window.error=error.message);`}],
  ['broken',{kind:'plugin',name:'损坏组件',permissions:[],html:'<p>坏组件</p>',css:'',script:`throw new Error('isolated plugin failure')`}]
]);
const entries=[...packages].map(([id,pkg])=>({item:{id,version:1},package:pkg}));
let origin,browser;
const fixture=`
import {createWorkshopRuntime} from '/dist/workshop-runtime.js';
window.calls=[];window.navigation=[];window.listeners=[];window.toasts=[];
window.store={principal:{userId:'me'},authGeneration:1,jobs:[{id:'mine',userId:'me',name:'中文训练',state:'RUNNING',machine:'gpu',cards:1,command:'PRIVATE-COMMAND'},{id:'theirs',userId:'other',name:'PRIVATE-NAME',state:'RUNNING'}],data:{machines:[{id:'gpu',model:'RTX',cards:1}],gpuq:{stale:false,checkedAt:'2026-10-13',hosts:[{id:'gpu',reachable:true,gpus:[{index:0,utilization:40,memoryUsedMiB:20,memoryTotalMiB:100,processes:[{command:'PRIVATE-COMMAND'}]}]}]}},onAuthChange(fn){listeners.push(fn);return()=>listeners.splice(listeners.indexOf(fn),1);},async call(method,args){calls.push({method,args});if(this.fail){this.fail=false;throw new Error('取消回执丢失，请核对原任务');}this.jobs[0].cancelRequested=true;return {job:this.jobs[0]};}};
window.entries=${JSON.stringify(entries)};window.theme=${JSON.stringify(theme)};
window.runtime=createWorkshopRuntime({store,root:document.querySelector('#workshop-widgets'),navigate:page=>navigation.push(page),toast:message=>toasts.push(message)});
runtime.setInstalled([theme,...entries]);window.ready=true;
`;
const server=http.createServer(async(req,res)=>{
  const pathname=new URL(req.url,origin).pathname;
  if(pathname.startsWith('/workshop/frame/')){
    const pkg=packages.get(pathname.split('/')[3]);
    if(!pkg){res.writeHead(404);res.end();return;}
    const rendered=renderWorkshopFrame(pkg,{nonce,origin});
    res.writeHead(200,{'Content-Type':'text/html','Content-Security-Policy':rendered.csp,'X-Frame-Options':'SAMEORIGIN'});res.end(rendered.html);return;
  }
  if(['/dist/workshop-runtime.js','/dist/workshop-package.js'].includes(pathname)){
    res.writeHead(200,{'Content-Type':'text/javascript'});res.end(await readFile(new URL('..'+pathname,import.meta.url)));return;
  }
  if(pathname==='/navigated'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<p>离开组件</p>');return;}
  res.writeHead(200,{'Content-Type':'text/html','Content-Security-Policy':`default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; frame-src 'self'; object-src 'none'`});
  res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="gpuq-style-nonce" content="${nonce}"><style nonce="${nonce}">body.sb{--bg:#000;background:var(--bg)}.sb:not(.m){--content:1280px}.sb.light{--bg:#fff}iframe{width:100%;height:180px}dialog{max-width:400px}button{min-height:44px}</style></head><body class="sb"><div id="workshop-widgets"></div><script type="module" nonce="${nonce}">${fixture}</script></body></html>`);
});
try {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const page=await browser.newPage();await page.goto(origin);await page.waitForFunction(()=>window.ready);
  const reader=page.frames().find(frame=>frame.url().includes('/reader/'));
  await reader.waitForSelector('#ready:text("已连接")');
  assert.equal(await page.locator('iframe').count(),3);
  assert.equal(await page.evaluate(()=>getComputedStyle(document.body).backgroundColor),'rgb(18, 52, 86)');
  assert.equal(await page.evaluate(()=>getComputedStyle(document.body).getPropertyValue('--content')),'1600px');
  await page.evaluate(()=>document.body.classList.add('light'));
  assert.equal(await page.evaluate(()=>getComputedStyle(document.body).backgroundColor),'rgb(18, 52, 86)','theme overrides existing .sb.light token scope');
  await page.evaluate(()=>document.body.classList.remove('light'));
  const receipts=await reader.evaluate(()=>receipts);
  assert.deepEqual(receipts.jobs.jobs.map(job=>job.id),['mine']);
  assert.equal(receipts.resources.machines[0].gpus[0].utilization,40);
  assert.doesNotMatch(JSON.stringify(receipts),/PRIVATE|processes|command/);
  assert.equal(await reader.evaluate(()=>{try{return parent.document.cookie;}catch{return 'blocked';}}),'blocked');
  assert.equal(await reader.evaluate(()=>{try{return localStorage.getItem('secret');}catch{return 'blocked';}}),'blocked');
  assert.equal(await reader.evaluate(async()=>{try{await fetch('/api/call');return 'allowed';}catch{return 'blocked';}}),'blocked');
  assert.match(await reader.evaluate(async()=>{try{await stargate.call('jobs.cancel',{jobId:'mine'});return 'allowed';}catch(e){return e.message;}}),/未授予/);
  assert.equal(await page.locator('dialog').count(),0);
  assert.equal(await page.evaluate(async()=>{
    const channel=new MessageChannel();let received=false;channel.port1.onmessage=()=>received=true;
    window.postMessage({type:'stargate:workshop:ready',protocol:1},location.origin,[channel.port2]);
    channel.port1.postMessage({type:'call',id:1,method:'jobs.cancel',args:{jobId:'mine'}});
    await new Promise(resolve=>setTimeout(resolve,50));channel.port1.close();return received;
  }),false,'a matching message name from the wrong Window cannot acquire a capability');
  assert.equal(await page.evaluate(()=>calls.length),0);
  assert.match(await page.locator('.workshop-widget').filter({hasText:'损坏组件'}).textContent(),/isolated plugin failure/);
  await reader.evaluate(()=>window.kept=42);await page.evaluate(()=>{runtime.setInstalled([theme,...entries]);runtime.update();});
  assert.equal(await reader.evaluate(()=>kept),42,'refresh does not recreate plugin state');
  const actor=page.frames().find(frame=>frame.url().includes('/cancel/'));
  assert.match(await actor.evaluate(async()=>{try{await stargate.call('jobs.cancel',{jobId:'theirs'});return 'allowed';}catch(e){return e.message;}}),/本人/);
  assert.match(await actor.evaluate(async()=>{try{await stargate.call('ui.navigate',{page:'admin'});return 'allowed';}catch(e){return e.message;}}),/不支持/);
  await actor.evaluate(()=>stargate.call('ui.navigate',{page:'resources'}));assert.deepEqual(await page.evaluate(()=>navigation),['resources']);
  await actor.locator('#cancel').click();await page.getByRole('dialog').waitFor();
  assert.match(await page.getByRole('dialog').textContent(),/取消组件.*中文训练/);
  await page.getByRole('button',{name:'确认取消训练',exact:true}).evaluate(button=>button.click());
  assert.equal(await page.evaluate(()=>calls.length),0,'synthetic clicks do not consent');
  await page.getByRole('button',{name:'不取消',exact:true}).click();
  await actor.waitForFunction(()=>window.error?.includes('未确认取消'));
  assert.equal(await page.evaluate(()=>calls.length),0);
  await actor.locator('#cancel').click();await page.getByRole('button',{name:'确认取消训练',exact:true}).click();
  await actor.waitForFunction(()=>window.result?.cancelRequested===true);
  assert.deepEqual(await page.evaluate(()=>calls),[{method:'jobs.cancel',args:{jobId:'mine'}}]);
  await page.evaluate(()=>store.fail=true);await actor.locator('#cancel').click();await page.getByRole('button',{name:'确认取消训练',exact:true}).click();
  await actor.waitForFunction(()=>window.error?.includes('回执丢失'));
  await page.evaluate(()=>runtime.update());assert.equal(await page.evaluate(()=>calls.length),2,'failed writes are not replayed');
  await actor.locator('#cancel').click();await page.getByRole('dialog').waitFor();
  await page.evaluate(()=>runtime.setInstalled([theme,entries[0]]));
  assert.equal(await page.locator('dialog').count(),0);assert.equal(await page.evaluate(()=>calls.length),2);
  await page.evaluate(()=>runtime.previewTheme({kind:'theme',theme:{tokens:{'--bg':'#ffffff'}}}));
  assert.equal(await page.evaluate(()=>getComputedStyle(document.body).backgroundColor),'rgb(255, 255, 255)');
  await page.evaluate(()=>runtime.previewTheme(null));assert.equal(await page.evaluate(()=>getComputedStyle(document.body).backgroundColor),'rgb(18, 52, 86)');
  await reader.evaluate(origin=>location.href=origin+'/navigated',origin);
  await page.waitForFunction(()=>document.querySelector('.workshop-widget .form-error').textContent.includes('离开运行页面'));
  await page.evaluate(()=>{store.authGeneration++;store.principal=null;for(const listener of [...listeners])listener();runtime.update();});
  assert.equal(await page.locator('iframe').count(),0);assert.equal(await page.evaluate(()=>getComputedStyle(document.body).backgroundColor),'rgb(0, 0, 0)');
  assert.equal(await page.evaluate(()=>getComputedStyle(document.body).getPropertyValue('--content')),'1280px');
  assert.equal(await page.evaluate(()=>document.body.hasAttribute('data-workshop-theme')),false);
  await page.goto(origin+'/?workshop=off');await page.waitForFunction(()=>window.ready);
  assert.equal(await page.locator('iframe').count(),0);assert.equal(await page.evaluate(()=>getComputedStyle(document.body).backgroundColor),'rgb(0, 0, 0)');
  await page.evaluate(()=>runtime.previewTheme(theme.package));assert.equal(await page.evaluate(()=>getComputedStyle(document.body).backgroundColor),'rgb(0, 0, 0)');
  console.log('workshop runtime browser: sandbox, scoped SDK, trusted cancellation, lost reply, isolation, theme, account reset and off mode passed');
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
