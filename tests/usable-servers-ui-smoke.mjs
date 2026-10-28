// Members only see and use the servers granted to them; nothing is ever requested on the others.
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {resolve,extname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';
const origin='https://usable-servers.test',root=resolve(import.meta.dirname,'../dist'),temporary=await mkdtemp(join(tmpdir(),'usable-servers-ui-'));
const shots=process.env.UI_SCREENSHOTS||temporary;await mkdir(shots,{recursive:true});
const machines=[{id:'node-5090',cards:8,model:'Fixture 5090',memory:'32 GB'},{id:'node-4090-8',cards:8,model:'Fixture 4090',memory:'24 GB'},{id:'node-4090-6',cards:6,model:'Fixture 4090',memory:'24 GB'},{id:'node-3090',cards:8,model:'Fixture 3090',memory:'24 GB'}];
const scenarios={two:{role:'member',limits:{'node-5090':4,'node-4090-8':2,'node-4090-6':0},usable:['node-5090','node-4090-8']},one:{role:'member',limits:{'node-5090':4},usable:['node-5090']},none:{role:'member',limits:{},usable:[]},admin:{role:'admin',limits:{},usable:machines.map(row=>row.id)}};
const checkedAt='2026-10-28T10:00:00.000Z',noServer='你还没有开通任何服务器，请联系管理员审批额度。';
// The portal sends anonymous readings for servers outside the grants.
const host=(machine,masked)=>({id:machine.id,reachable:true,checkedAt,samplingStale:false,...(masked?{displayMasked:true}:{}),gpuq:{connected:true,health:'ok',jobs:[]},tasks:[],disks:[],
 gpus:Array.from({length:machine.cards},(_,index)=>({index,model:machine.model,memoryUsedMiB:index<2||masked?16384:0,memoryTotalMiB:32768,utilization:index<2||masked?60:0,processesAvailable:true,processes:index<2||masked?[{pid:null,memoryUsedMiB:16384,task:{id:'task-'+machine.id+index,source:masked?'anonymous':'portal',name:masked?'匿名任务':'团队训练',submitter:{name:masked?'匿名用户':'成员乙'}}}]:[]}))});
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
const until=async(check,label)=>{for(let i=0;i<100&&!check();i++)await new Promise(resolve=>setTimeout(resolve,100));assert.ok(check(),label);};
const palette=async(page,command)=>{if(!await page.locator('#mission-control[open]').count())await page.keyboard.press('Control+k');await page.locator('#palette-status').filter({hasText:'Enter 打开'}).waitFor();await page.locator('#control-command').fill(command);await page.keyboard.press('Enter');};
const focused=page=>page.evaluate(()=>document.activeElement?.name);
const noScroll=async page=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'no horizontal scroll');
try{
 for(const [name,scenario] of Object.entries(scenarios))for(const width of [1440,390,320]){
  const userId='member-a',calls=[],errors=[],unexpected=[];
  const users=[{id:userId,username:'alice',name:'成员甲',role:scenario.role,enabled:true,approvedAt:checkedAt,total:Object.values(scenario.limits).reduce((sum,n)=>sum+n,0),limits:scenario.limits},{id:'member-b',username:'bob',name:'成员乙',role:'member',enabled:true,total:8,limits:Object.fromEntries(machines.map(row=>[row.id,8]))}];
  const state={machines,users,jobs:[],executionEnabled:true,execution:{},operationalMaintenance:{global:null,machines:{}},gpuq:{stale:false,checkedAt,hosts:machines.map(row=>host(row,!scenario.usable.includes(row.id)))}};
  const projects=machine=>[{project:'vision',ownerId:'member-b',ownerName:'成员乙',displayName:'视觉基线 '+machine,environmentMode:'oci',lifecycle:{state:'ACTIVE'}},{project:'team',ownerId:'member-c',ownerName:'成员丙',shared:true,displayName:'团队共用 '+machine,environmentMode:'oci',lifecycle:{state:'ACTIVE'}}];
  async function rpc(op,args){
   calls.push({op,args});
   if(args.machine&&!scenario.usable.includes(args.machine))unexpected.push(op+' '+args.machine);
   if(op==='state')return {principal:{userId,username:'alice',role:scenario.role},state};
   if(op==='projects.list')return {projects:projects(args.machine),environmentModes:['oci']};
   if(op==='projects.status')return projects(args.machine)[0];
   if(op==='projects.catalog')return {groups:[]};
   if(op==='projects.retire.list')return {items:[]};
   if(op==='datasets.list')return {datasets:[{dataset:'images',name:'images',size:3}]};
   if(op==='storage.snapshot')return {machines:[{machine:args.machine,checkedAt,refreshing:false,quota:{volumes:[{kind:'shared',media:'ssd',usedBytes:300*1024**3,totalBytes:1024**4,availableBytes:724*1024**3}],checkedAt},datasets:{datasets:[{dataset:'images',name:'images',size:3*1024**3,ownerName:'成员乙',modifiedAt:1792000000}],checkedAt},projects:{projects:projects(args.machine).map(row=>({...row,size:2*1024**3})),checkedAt}}]};
   if(op==='cloud.info')return {aliyunConnected:false,backend:'aliyun',managedExternally:false,disabled:false,status:'disconnected'};
   if(op==='cloud.import.list')return {imports:[]};
   if(op==='transfers.list')return {transfers:[],nextCursor:null};
   throw Object.assign(Error('Unexpected RPC '+op),{status:404});
  }
  const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'}),page=await context.newPage();page.setDefaultTimeout(10000);
  page.on('pageerror',error=>errors.push(error.stack));
  await page.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());if(url.origin!==origin)return route.abort();
   if(url.pathname==='/'){let html=await readFile(join(root,'index.html'),'utf8');html=html.replace('globalThis.GPUQ_LOCAL_API=false;','globalThis.GPUQ_LOCAL_API=true;').replace('<head>','<head><script>window.GPUQ_PRODUCTION=true;window.GPUQ_HAS_SESSION=true;</script>');return route.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':"style-src 'self'"},body:html});}
   if(url.pathname==='/machines.js')return route.fulfill({contentType:'text/javascript',body:'export const MACHINES='+JSON.stringify(machines)});
   if(url.pathname.startsWith('/api/')){const body=request.postDataJSON();try{const result=await rpc(body.operation,body.args||{});return route.fulfill({contentType:'application/json',body:JSON.stringify(body.operation==='state'?result:{ok:true,result})});}catch(error){return route.fulfill({status:error.status||500,contentType:'application/json',body:JSON.stringify({error:error.message})});}}
   const path=resolve(root,'.'+url.pathname);if(!path.startsWith(root+'/'))return route.abort();
   try{return route.fulfill({contentType:extname(path)==='.js'?'text/javascript':extname(path)==='.css'?'text/css':extname(path)==='.woff2'?'font/woff2':'application/octet-stream',body:await readFile(path)});}catch{return route.fulfill({status:404,body:''});}
  });
  const shot=async(label,fullPage=true)=>{await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:join(shots,`${name}-${width}-${label}.png`),fullPage,animations:'disabled',timeout:30000});};
  await page.goto(origin);await page.locator('[data-nav=resources][aria-current=page]').waitFor();
  // 算力: every server stays visible; the ones this account cannot use carry 未开通.
  await page.locator('.resource-mini').first().waitFor();
  const closed=machines.filter(row=>!scenario.usable.includes(row.id)).map(row=>row.id);
  for(const machine of machines)assert.equal(await page.locator(`[data-resource-machine="${machine.id}"] .resource-closed`).count(),closed.includes(machine.id)?1:0,machine.id);
  await noScroll(page);await shot('compute');
  if(closed.length&&name==='two'){await page.locator(`[data-resource-select="${closed[0]}"]`).click();await page.locator(`.resource-portrait[data-resource-machine="${closed[0]}"] .resource-closed`).waitFor();await noScroll(page);await shot('compute-closed');}
  // 项目: only usable servers are offered and listed; none means a plain empty state.
  await page.locator('[data-nav=work]').click();await page.locator('#pr-name').waitFor();
  if(scenario.usable.length){
   await until(()=>new Set(calls.filter(row=>row.op==='projects.list').map(row=>row.args.machine)).size===scenario.usable.length,'every usable server is listed');
   await page.waitForFunction(()=>!document.querySelector('[name=workspace-project]').disabled);
   if(!await page.locator('#pr-switch-sheet[open]').count())await page.locator('#pr-switch').click();await page.locator('#pr-switch-sheet[open]').waitFor();
   assert.deepEqual(await page.locator('[name=workspace-machine] option').evaluateAll(rows=>rows.map(row=>row.value).filter(Boolean)),scenario.usable);
   for(const field of ['workspace-machine','machine','terminal-machine','file-machine'])assert.equal(await page.locator(`[name=${field}]`).inputValue(),scenario.usable.length===1?scenario.usable[0]:'',field);
   assert.deepEqual([...new Set(calls.filter(row=>row.op==='projects.list').map(row=>row.args.machine))].sort(),[...scenario.usable].sort());
   const usableLine=page.locator('#pr-usable');
   if(scenario.role==='admin')assert.equal(await usableLine.isVisible(),false,'admins see all servers as before');
   else{const text=await usableLine.innerText();assert.match(text,/可用服务器/);for(const id of scenario.usable)assert.match(text,new RegExp(id+'\\s+'+scenario.limits[id]+' 张'));for(const id of closed)assert.doesNotMatch(text,new RegExp(id));}
   await noScroll(page);await shot('project-switch',false);await page.locator('#pr-switch-close').click();await page.locator('#pr-switch-sheet').waitFor({state:'hidden'});
  }else{
   await page.locator('#pr-no-server').waitFor();assert.equal(await page.locator('#pr-name').innerText(),'还没有开通服务器');assert.equal(await page.locator('#pr-no-server').innerText(),'请联系管理员审批额度后，再新建项目和终端。');
   for(const selector of ['#pr-switch','.pr-tabs','#terminal-open','#project-create'])assert.equal(await page.locator(selector).isVisible(),false,selector);
   assert.deepEqual(await page.locator('[name=workspace-machine] option').evaluateAll(rows=>rows.map(row=>row.value).filter(Boolean)),[]);
   await noScroll(page);await shot('project');
  }
  // Command palette: search reads only usable servers; actions explain when there are none.
  await page.keyboard.press('Control+k');await page.locator('#control-command').waitFor();await page.locator('#palette-status').filter({hasText:'Enter 打开'}).waitFor();
  assert.deepEqual([...new Set(calls.filter(row=>row.op==='datasets.list').map(row=>row.args.machine))].sort(),[...scenario.usable].sort());
  assert.doesNotMatch(await page.locator('#control-suggestions').innerText(),/部分内容暂时读不到/);
  if(!scenario.usable.length)for(const command of ['新建项目','打开终端','上传数据集']){
   await page.evaluate(()=>{document.querySelector('#toast').textContent='';});await palette(page,command);await page.locator('#toast').filter({hasText:noServer}).waitFor();
  }
  else{
   // 新建项目 opens the switch sheet with 新建项目 expanded and the name ready to type.
   await palette(page,'新建项目');await page.locator('#pr-switch-sheet[open] #project-create[open]').waitFor();assert.equal(await focused(page),'new-project');
   await noScroll(page);await shot('palette-new-project',false);await page.keyboard.press('Escape');await page.locator('#pr-switch-sheet').waitFor({state:'hidden'});
  }
  // 数据: gauges and the upload server list hold usable servers only.
  await page.locator('[data-nav=datasets]').click();
  if(scenario.usable.length){
   await page.locator('[data-gauge]').first().waitFor();assert.deepEqual(await page.locator('[data-gauge]').evaluateAll(rows=>rows.map(row=>row.dataset.gauge)),scenario.usable);
   assert.deepEqual(await page.locator('[name=dataset-machine] option').evaluateAll(rows=>rows.map(row=>row.value)),scenario.usable);
   await page.locator('[data-storage-machine]:not([hidden]) [data-dataset-open=images]').waitFor();await page.locator('#dr-upload-open').click();await page.locator('#dataset-upload[open]').waitFor();
   assert.equal(await page.locator('[name=dataset-machine]').inputValue(),scenario.usable[0]);assert.equal(await page.locator('[data-upload-to]').innerText(),scenario.usable[0]);
   await noScroll(page);await shot('datasets-upload',false);await page.keyboard.press('Escape');await page.locator('#dataset-upload').waitFor({state:'hidden'});
   // 上传数据集 from the palette opens the same dialog.
   await palette(page,'上传数据集');await page.locator('#dataset-upload[open]').waitFor();assert.equal(await focused(page),'upload-dataset');
  }else{await page.locator('.dr-none').waitFor();assert.equal(await page.locator('#dr-upload-open').isVisible(),false);assert.equal(await page.locator('#dataset-upload[open]').count(),0);assert.equal(await page.locator('[name=dataset-machine] option').count(),0);await noScroll(page);await shot('datasets');}
  // 新建任务 lists projects on usable servers; a shared one shows 共用, not its creator.
  if(scenario.usable.length){
   await page.keyboard.press('Escape');await page.locator('#dataset-upload').waitFor({state:'hidden'});await palette(page,'新建任务');await page.locator('.jr-sheet.on #jr-project').waitFor();
   const options=await page.locator('#jr-project option').allInnerTexts();
   assert.equal(options.length,scenario.usable.length*2);assert.ok(options.filter(text=>text.startsWith('team ')).every(text=>text.endsWith(' · 共用')),options.join('|'));assert.ok(options.every(text=>!text.includes('成员丙')));
   await noScroll(page);await shot('submit',false);await page.locator('.jr-sheet [data-sheet-close]').click();await page.locator('.jr-sheet.on').waitFor({state:'detached'});
  }
  assert.deepEqual(unexpected,[],'no request names a server outside the grants');assert.deepEqual(errors,[]);
  await context.close();console.log(name+' '+width+' PASS');
 }
}finally{await browser.close();if(!process.env.UI_SCREENSHOTS)await rm(temporary,{recursive:true,force:true});}
