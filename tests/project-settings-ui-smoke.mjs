// Real project room modules, isolated loopback RPCs; no live accounts or nodes.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {resolve,join,extname} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';
const root=resolve(import.meta.dirname,'../dist'),temporary=await mkdtemp(join(tmpdir(),'project-settings-ui-'));
const shots=process.env.UI_SCREENSHOTS||temporary;await mkdir(shots,{recursive:true});
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${['styles','workspace','fonts','starbase','shell','workbench','jobs-room','projects-room','copy-help','portal-shell'].map(name=>'<link rel="stylesheet" href="/'+name+'.css">').join('')}
<body class="sb root" data-room="work"><main data-page="work"><div id="execution-host"></div></main>
<script type="module">
import {executionUI} from '/execution-ui.js';
const role=new URL(location.href).searchParams.get('role'),owner='fixture-'+role;
window.calls=[];window.callbacks=[];window.toasts=[];window.gates={};window.missing=false;
const machine='fixture-node',projects=[{project:'vision',ownerId:'peer',ownerName:'成员乙',displayName:'共享实验',environmentMode:'oci',lifecycle:{state:'ACTIVE'},git:{url:'https://example.test/team/vision.git'}},{project:'vision',ownerId:owner,ownerName:'我',displayName:'自己的同名项目',environmentMode:'oci',lifecycle:{state:'ACTIVE'}}];
window.hold=op=>{let release;const promise=new Promise(resolve=>release=resolve);gates[op]={promise,release};};
window.release=op=>{gates[op]?.release();delete gates[op];};hold('projects.status');
window.store={production:true,authGeneration:1,principal:{userId:owner,role},users:[{id:owner,name:'成员甲',username:'fixture',role,enabled:true,total:8,limits:{[machine]:8}}],jobs:[],usage:()=>0,
 data:{machines:[{id:machine,cards:8}],executionEnabled:true,execution:{},gpuq:{stale:false,hosts:[{id:machine,reachable:true,gpus:[],gpuq:{connected:true,health:'ok'}}]}},
 onAuthChange(fn){callbacks.push(fn);},
 async call(op,args,options={}){
  const row={op,args:structuredClone(args),started:performance.now()};calls.push(row);
  try{await gates[op]?.promise;options.signal?.throwIfAborted();
   if(op==='projects.list')return {projects:structuredClone(projects)};
   if(op==='projects.status'){if(window.failStatus)throw Error('节点暂时没有响应。');return {...structuredClone(projects.find(row=>row.ownerId===args.ownerId)),git:{url:'https://example.test/team/vision.git',branch:'main',commit:'abc123'}};}
   if(op==='storage.snapshot'){const checkedAt=new Date(Date.now()-7*60000).toISOString();return {machines:[{machine,checkedAt,refreshing:false,quota:{volumes:[{kind:'shared',usedBytes:40*1024**3,totalBytes:400*1024**3,availableBytes:360*1024**3}],checkedAt},projects:{projects:missing?[]:[{project:'vision',ownerId:'peer',size:3*1024**3,complete:false},{project:'vision',ownerId:owner,size:null,complete:false}],checkedAt:missing?null:checkedAt}}]};}
   if(op==='projects.quota')return {volumes:[],projectUsage:{size:99*1024**3,complete:true}};
   if(op==='projects.catalog')return {groups:[{id:'fixture-group',logical:true,name:'研究组',instances:[{machine,project:'vision',ownerId:'peer',ownerName:'成员乙',displayName:'共享实验'}]}]};
   if(op==='projects.retire.list')return {items:[]};
   throw Error('Unexpected RPC '+op);
  }finally{row.finished=performance.now();}
 }};
localStorage.setItem('sg-last-project',JSON.stringify({machine,project:'vision',ownerId:'peer'}));
window.view=executionUI(store,()=>view(),text=>toasts.push(text));view();window.ready=true;
</script></html>`;
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/'){res.setHeader('content-type','text/html');res.end(html);return;}
 if(url.pathname==='/machines.js'){res.setHeader('content-type','text/javascript');res.end('export const MACHINES=[];');return;}
 const path=resolve(root,'.'+url.pathname);if(!path.startsWith(root+'/')){res.writeHead(404).end();return;}
 try{res.setHeader('content-type',extname(path)==='.js'?'text/javascript':extname(path)==='.css'?'text/css':'application/octet-stream');res.end(await readFile(path));}catch{res.writeHead(404).end();}
});
const timings=[];let browser;
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({headless:true,...process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}});
 for(const role of ['member','admin'])for(const width of [1440,390,320]){
  const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'}),page=await context.newPage(),errors=[];
  page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  await page.goto('http://127.0.0.1:'+server.address().port+'/?role='+role);await page.waitForFunction(()=>window.ready&&document.querySelector('#pr-name').textContent==='共享实验');
  await page.waitForFunction(()=>calls.some(row=>row.op==='projects.status'));
  const start=await page.evaluate(()=>performance.now());await page.locator('[data-pt=settings]').click();
  await page.locator('#project-management>summary').click();await page.locator('#project-disk-quota>summary').click();
  assert.equal(await page.locator('[data-display-name]').inputValue(),'共享实验','the first settings paint uses known project metadata');
  const firstContentMs=await page.evaluate(t=>performance.now()-t,start);
  assert.equal(await page.locator('[data-display-name]').isEnabled(),true,'pending Git does not lock the settings forms');
  assert.equal(await page.locator('#project-network-check').isEnabled(),true,'pending Git does not lock other operations');
  assert.match(await page.locator('#project-status-detail').textContent(),/读取|更新/,'Git has its own loading placeholder');
  await page.locator('#disk-quota-result').filter({hasText:'至少 3.00 GiB'}).waitFor();
  assert.match(await page.locator('#disk-quota-state').textContent(),/统计于 7 分钟前/);
  assert.equal(await page.evaluate(()=>calls.filter(row=>row.op==='projects.quota').length),0,'project size never scans the node');
  assert.equal(await page.evaluate(()=>calls.filter(row=>row.op==='storage.refresh').length),0,'opening settings does not request a new scan');
  assert.equal(await page.evaluate(()=>calls.filter(row=>row.op==='projects.status'&&!row.finished).length),1,'cached size renders before the node Git response');
  await page.evaluate(()=>hold('projects.catalog'));await page.locator('[data-project-catalog]').click();
  assert.equal(await page.locator('[data-display-name]').isEnabled(),true,'a slow cross-machine catalog only affects its block');
  assert.equal(await page.locator('#disk-quota-refresh').isEnabled(),true);
  await page.evaluate(()=>release('projects.status'));await page.locator('#project-status-detail').filter({hasText:'abc123'}).waitFor({state:'attached'});
  await page.evaluate(()=>release('projects.catalog'));await page.locator('[data-catalog-output] button').waitFor();
  const before=await page.evaluate(()=>calls.length);await page.locator('[data-pt=term]').click();await page.locator('[data-pt=settings]').click();
  await page.locator('[data-project-catalog]').click();await page.waitForTimeout(50);
  assert.equal(await page.evaluate(()=>calls.length),before,'quickly reopening the same project reuses completed reads');
  await page.locator('#disk-quota-refresh').click();await page.waitForFunction(n=>calls.length>n,before);
  assert.equal(await page.evaluate(()=>calls.at(-1).op),'storage.snapshot','manual size refresh reads the snapshot again');
  await page.screenshot({path:join(shots,'settings-'+role+'-'+width+'-ready.png'),fullPage:true,animations:'disabled'});
  // A project switch invalidates the small in-memory cache, including same slugs with different owners.
  await page.locator('#pr-switch').click();await page.locator('[name=workspace-project]').selectOption({label:'自己的同名项目 · 我 · OCI 容器 · fixture-node'});await page.locator('#pr-switch-sheet').waitFor({state:'hidden'});
  await page.locator('#disk-quota-result').filter({hasText:'项目文件用量：未知'}).waitFor();
  assert.doesNotMatch(await page.locator('#disk-quota-result').textContent(),/至少 3/,'another owner never inherits the old size');
  await page.locator('#pr-switch').click();await page.locator('[name=workspace-project]').selectOption({label:'共享实验 · 成员乙 · OCI 容器 · fixture-node'});await page.locator('#pr-switch-sheet').waitFor({state:'hidden'});
  await page.locator('#disk-quota-result').filter({hasText:'至少 3.00 GiB'}).waitFor();
  {
   // Refresh bypasses short-lived Git/catalog results but does not wait to render cached content.
   await page.evaluate(()=>{hold('projects.status');window.failStatus=true;});
   await page.locator('#pr-switch').click();await page.locator('#projects-refresh').click();await page.locator('#pr-switch-close').click();
   await page.waitForFunction(()=>calls.filter(row=>row.op==='projects.status'&&!row.finished).length===1);
   assert.equal(await page.locator('[data-display-name]').isEnabled(),true);
   await page.evaluate(()=>release('projects.status'));await page.locator('#project-status-detail').filter({hasText:'Git 状态未知'}).waitFor({state:'attached'});
   assert.equal(await page.locator('[data-display-name]').isEnabled(),true,'a failed Git read only marks Git unknown');
   assert.match(await page.locator('#disk-quota-result').textContent(),/至少 3.00 GiB/);
   await page.screenshot({path:join(shots,'settings-'+role+'-'+width+'-git-unavailable.png'),fullPage:true,animations:'disabled'});
   await page.evaluate(()=>{window.failStatus=false;});await page.locator('#pr-switch').click();await page.locator('#projects-refresh').click();await page.locator('#pr-switch-close').click();
   await page.locator('#project-status-detail').filter({hasText:'abc123'}).waitFor({state:'attached'});
  }
  await page.evaluate(()=>{missing=true;});await page.locator('#disk-quota-refresh').click();
  await page.locator('#disk-quota-result').filter({hasText:'项目文件用量：未知'}).waitFor();
  assert.match(await page.locator('#disk-quota-state').textContent(),/统计时间未知/);
  assert.doesNotMatch(await page.locator('#disk-quota-result').textContent(),/项目文件用量：0/);
  await page.screenshot({path:join(shots,'settings-'+role+'-'+width+'-unknown.png'),fullPage:true,animations:'disabled'});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.equal(await page.evaluate(()=>calls.some(row=>['projects.group.get','projects.label.get'].includes(row.op))),false,'known presentation fields need no duplicate read');
  timings.push({role,width,firstContentMs,calls:await page.evaluate(()=>calls)});
  assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>toasts),[]);await context.close();console.log('PASS settings '+role+'/'+width+': independent reads, snapshot size, memory reuse, project switch and unknown');
 }
 await writeFile(join(shots,'settings-requests.json'),JSON.stringify(timings,null,2)+'\n');
}finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(temporary,{recursive:true,force:true});}
