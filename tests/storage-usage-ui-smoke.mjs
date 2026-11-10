// Real Portal, data page, project settings and CLI; the node bridge answers with
// synthetic readings in the per-project accounting contract (no node code).
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {setProjectShared} from '../project-catalog.mjs';
import {readStorage,writeStorage} from '../portal-storage.mjs';
import {credential} from '../dist/service.js';
import {MACHINES} from '../dist/model.js';
const temporary=await mkdtemp(join(tmpdir(),'storage-usage-ui-')),shots=process.env.UI_SCREENSHOTS||temporary;await mkdir(shots,{recursive:true});
const G=1024**3,password='Synthetic-Storage-Usage-2026!',statusPath=join(temporary,'status.json'),bootstrap=join(temporary,'bootstrap.json');
const status=()=>{const checkedAt=new Date().toISOString();return {checkedAt,hosts:MACHINES.map(m=>({id:m.id,checkedAt,reachable:true,gpus:[],gpuq:{connected:true,health:'ok',jobs:[]}}))};};
const refresh=async()=>{await writeFile(statusPath+'.new',JSON.stringify(status()));await rename(statusPath+'.new',statusPath);};await refresh();await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
const part=size=>({size,complete:size!==null});
const row=(ownerId,project,files,outputs,environment)=>({project,ownerId,lifecycle:{state:'ACTIVE'},environmentMode:'oci',size:files,complete:files!==null,outputs:{...part(outputs),count:2},environment:part(environment)});
const item=(ownerId,project,files,outputs,environment)=>({kind:'project',ownerId,project,files,outputs,environment});
const disk=(mountPoint,roles,media,totalBytes,availableBytes,items,extra={})=>({mountPoint,roles,media,totalBytes,availableBytes,accounting:'quota',items,usedBytes:items.reduce((sum,value)=>sum+(value.kind==='project'?value.files+value.outputs+value.environment:value.bytes),0),...extra});
const volume=(kind,media,value)=>value?{kind,media,fs:kind,usedBytes:value.usedBytes,totalBytes:value.totalBytes,availableBytes:value.availableBytes}:{kind,media,fs:kind,usedBytes:4*G,totalBytes:100*G,availableBytes:96*G};
const unaccounted=(mountPoint,roles)=>({mountPoint,roles,media:'hdd',totalBytes:8*1024*G,usedBytes:2*1024*G,availableBytes:6*1024*G,accounting:'unavailable',items:[],trashBytes:null});
// gpu-1: two accounted disks; gpu-2: one shared disk without accounting; gpu-3: one of each, low space; gpu-4: unreachable.
const nodes={
 'gpu-1':(()=>{const data0=disk('/fixture/data0',['workspace'],'ssd',3584*G,2400*G,[item('fixture-member','vision',300*G,500*G,40*G),item('builtin-admin','render',100*G,20*G,10*G),item('fixture-member','old',12*G,0,0),
   {kind:'images',ownerId:'fixture-member',bytes:60*G},{kind:'images',ownerId:'builtin-admin',bytes:25*G},{kind:'platform',bytes:8*G},{kind:'unassignedOutputs',bytes:3*G},{kind:'untracked',bytes:4*G},{kind:'filesystem',bytes:2*G}],{trashBytes:12*G});
  const data1=disk('/fixture/data1',['datasets'],'hdd',16384*G,12000*G,[{kind:'dataset',name:'images',bytes:2000*G},{kind:'dataset',name:'motion',bytes:500*G},{kind:'external',path:'/fixture/data1/cyx',bytes:1200*G},{kind:'external',path:'/fixture/data1/user-archives',bytes:300*G},{kind:'untracked',bytes:10*G},{kind:'filesystem',bytes:30*G}]);
  return {volumes:[volume('workspace','ssd',data0),volume('datasets','hdd',data1)],projects:[row('fixture-member','vision',300*G,500*G,40*G),row('builtin-admin','render',100*G,20*G,10*G)],disks:[data0,data1],
   datasets:[{dataset:'images',name:'images',size:2000*G,complete:true,uploadedBy:'fixture-member',modifiedAt:1792000000},{dataset:'motion',name:'motion',size:500*G,complete:true,uploadedBy:'builtin-admin',modifiedAt:1792000000}]};})(),
 'gpu-2':{volumes:[volume('shared','hdd',unaccounted('/fixture/data1'))],projects:[row('fixture-member','notes',null,null,null)],disks:[unaccounted('/fixture/data1',['workspace','datasets'])],datasets:[{dataset:'scans',name:'scans',size:5*G,complete:true,uploadedBy:'fixture-member'}]},
 'gpu-3':(()=>{const data0=disk('/fixture/data0',['workspace'],'ssd',100*G,30*G,[item('builtin-admin','probe',10*G,1*G,1*G),{kind:'images',ownerId:'builtin-admin',bytes:5*G},{kind:'filesystem',bytes:1*G}]);
  return {volumes:[volume('workspace','ssd',data0),volume('datasets','hdd',unaccounted('/fixture/data1'))],projects:[row('builtin-admin','probe',10*G,1*G,1*G)],disks:[data0,unaccounted('/fixture/data1',['datasets'])],datasets:[]};})(),
};
const sampled=new Date(Date.now()-3*60000).toISOString(),calls=[],errors=[],external=[];
const bridge=async(machine,operation,args)=>{
 calls.push({machine,operation});const node=nodes[machine];
 if(operation==='projects.storage.limits.sync')return {synced:true};
 if(operation==='transfers.list')return {transfers:[]};
 if(operation==='projects.retire.list')return {items:[]};
 if(!node)throw Object.assign(Error('节点暂未响应，请稍后重试。'),{status:503});
 if(operation==='projects.quota')return {volumes:structuredClone(node.volumes)};
 if(operation==='datasets.list')return {datasets:structuredClone(node.datasets),complete:true};
 if(operation==='projects.list')return args.includeUsage?{projects:structuredClone(node.projects),disks:structuredClone(node.disks),checkedAt:sampled,complete:true}:{projects:node.projects.map(({project,ownerId,lifecycle,environmentMode})=>({project,ownerId,lifecycle,environmentMode}))};
 if(operation==='projects.status'){const found=node.projects.find(value=>value.project===args.project&&value.ownerId===args.ownerId);if(!found)throw Error('这台服务器上没有这个项目。');return {project:found.project,ownerId:found.ownerId,lifecycle:found.lifecycle,environmentMode:'oci'};}
 if(operation==='files.list')return {entries:[],hasMore:false};
 throw Object.assign(Error('节点暂未响应，请稍后重试。'),{status:503});
};
let server,browser,timer;const observations=[];
const text=locator=>locator.evaluate(node=>node.textContent.replace(/\s+/g,' ').trim());
try{
 const reserved=createServer();await new Promise(resolve=>reserved.listen(0,'127.0.0.1',resolve));const port=reserved.address().port;await new Promise(resolve=>reserved.close(resolve));const origin='http://127.0.0.1:'+port;
 const created=await createPortalServer({database:join(temporary,'portal.sqlite'),bootstrap,origin,secure:false,statusPath,bridge,fileLanEndpoints:'{}',directUploadOrigins:'[]'});server=created.server;const service=created.service;clearInterval(service.executionTimer);
 const saveProjects=fixture=>{const saved=readStorage(service,'gpu-1');writeStorage(service,'gpu-1',{...saved,projects:{...saved.projects,projects:structuredClone(fixture)}});};
 const limits=Object.fromEntries(MACHINES.map(m=>[m.id,m.cards]));Object.assign(service.store.users[0],{name:'管理员乙',limits,total:30,approvedAt:new Date().toISOString()});service.store.users.push({id:'fixture-member',username:'member',name:'成员甲',role:'member',enabled:true,total:8,limits,approvedAt:new Date().toISOString()});service.accounts.insert(service.store.users.at(-1),await credential(password,600000));service.accounts.rename('builtin-admin','管理员乙');service.refreshAccounts();service.save();
 setProjectShared(service,'builtin-admin','gpu-1','render',true);
 for(const machine of MACHINES)service.scheduleStorageRefresh(machine.id,0);await service.refreshStorage();
 await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));timer=setInterval(()=>refresh().catch(()=>{}),2000);
 browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
 for(const role of ['member','admin'])for(const width of [1440,390,320]){
  const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'}),page=await context.newPage();page.setDefaultTimeout(12000);
  page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){external.push(route.request().url());return route.abort();}return route.continue();});
  const login=await context.request.post(origin+'/api/login',{headers:{Origin:origin},data:{username:role==='admin'?'admin':'member',password,client:'browser'}});assert.equal(login.ok(),true,'login HTTP '+login.status());
  await page.goto(origin+'/#storage');await page.locator('[data-nav=datasets][aria-current=page]').waitFor();
  await page.waitForFunction(()=>[...document.querySelectorAll('[data-storage-machine]')].every(node=>node.dataset.loading==='false'));
  const card=id=>page.locator(`[data-storage-machine=${id}]`),show=async id=>{await page.locator(`[data-gauge=${id}]`).click();await card(id).waitFor({state:'visible'});};
  // gpu-1: one card per data disk, listed parts add up to used space, no "其他".
  await show('gpu-1');const first=card('gpu-1');
  assert.match(await first.locator('[data-storage-caption]').innerText(),/统计于 [34] 分钟前/,'the caption shows the node sample time');
  assert.equal(await first.locator('.dr-mix').count(),2);
  const mixes=await first.locator('.dr-mix').evaluateAll(nodes=>nodes.map(node=>({text:node.textContent,fill:[...node.querySelectorAll('.dr-mix-bar [data-fill]')].reduce((sum,bar)=>sum+Number(bar.dataset.fill),0),drawn:[...node.querySelectorAll('.dr-mix-bar i')].every(bar=>bar.getBoundingClientRect().width>0)})));
  for(const [index,value] of [nodes['gpu-1'].disks[0],nodes['gpu-1'].disks[1]].entries()){
   assert.ok(Math.abs(mixes[index].fill-value.usedBytes/value.totalBytes*100)<1e-9,'the drawn parts add up to the used space');
   assert.ok(mixes[index].drawn,'bar widths reach the page through CSSOM under the real CSP');
   assert.doesNotMatch(mixes[index].text,/其他|基础镜像/);
  }
  assert.match(mixes[0].text,/项目982 GiB成员甲852 GiB管理员乙130 GiB镜像与容器引擎85 GiB成员甲60 GiB管理员乙25 GiB.*平台运行数据8 GiB未归属输出3 GiB未登记4 GiB文件系统开销2 GiB可用2\.3 TiB/);
  assert.match(mixes[0].text,/其中回收站 12 GiB，7 天内可恢复/);
  assert.match(mixes[1].text,/数据集2\.4 TiB外部目录1\.5 TiB\/fixture\/data1\/cyx1\.2 TiB\/fixture\/data1\/user-archives300 GiB未登记10 GiB文件系统开销30 GiB/);
  // Project list: total with parts, owner, and the creator of a shared project.
  const render=first.locator('[data-project-row=render]');
  assert.equal(await text(render.locator('.dr-main .dr-s').first()),'共用 · 创建人 管理员乙');
  assert.equal(await text(render.locator('[data-project-parts]')),'文件 100 GiB · 输出 20 GiB · 环境 10 GiB');assert.equal(await text(render.locator('[data-project-total]')),'130 GiB');
  assert.equal(await text(first.locator('[data-project-row=vision] [data-project-total]')),'840 GiB');
  assert.ok((await first.locator('[data-storage-projects]').innerText()).indexOf('vision')<(await first.locator('[data-storage-projects]').innerText()).indexOf('render'),'sorted by total');
  // Quota states and administrator editor at every required viewport.
  const fixture=nodes['gpu-1'].projects;
  Object.assign(fixture[0],{limitBytes:400*G,desiredLimitBytes:100*G,effectiveLimitBytes:400*G,enforced:true,graceUntil:1800000000});
  Object.assign(fixture[1],{limitBytes:110*G,desiredLimitBytes:110*G,enforced:true});
  saveProjects(fixture);
  await first.locator('[data-storage-refresh]').click();await page.waitForFunction(()=>document.querySelector('[data-storage-machine=gpu-1]')?.dataset.loading==='false');
  assert.match(await first.locator('[data-project-row=vision]').innerText(),/超限，宽限至/);
  assert.match(await first.locator('[data-project-row=render]').innerText(),/≥90%/);
  assert.equal(await first.locator('[data-storage-limit]').count(),role==='admin'?2:0);
  if(role==='admin'){
   await first.locator('[data-storage-limit=render]').click();const editor=page.locator('dialog[aria-label="项目文件上限"]');await editor.waitFor({state:'visible'});
   await editor.locator('input').fill('200');await page.screenshot({path:join(shots,`limit-admin-${width}-edit.png`),fullPage:true,animations:'disabled'});
   await editor.getByRole('button',{name:'保存',exact:true}).click();
   await page.waitForFunction(()=>{const d=document.querySelector('dialog[aria-label="项目文件上限"]');return !d.open||d.querySelector('[data-limit-status]').textContent;});
   assert.equal(await editor.locator('[data-limit-status]').textContent(),'');await editor.waitFor({state:'hidden'});
   assert.equal(service.projectStorageLimit('builtin-admin','gpu-1','render'),200_000_000_000);
   assert.match(await first.locator('[data-project-row=render]').innerText(),/待生效/);
  }
  await page.screenshot({path:join(shots,`limits-${role}-${width}-states.png`),fullPage:true,animations:'disabled'});
  fixture[1].enforced=false;saveProjects(fixture);
  await first.locator('[data-storage-refresh]').click();await page.waitForFunction(()=>document.querySelector('[data-storage-machine=gpu-1]')?.dataset.loading==='false');
  assert.match(await first.locator('[data-project-row=render]').innerText(),/上限未生效.*待生效/);
  if(width<=390)assert.ok(await first.locator('.dr-ct .dr-main').evaluateAll(nodes=>nodes.every(node=>node.getBoundingClientRect().width>=node.parentElement.clientWidth-20)),'mobile project text keeps the full row width beside administrator actions');
  await page.screenshot({path:join(shots,`limits-${role}-${width}-disabled.png`),fullPage:true,animations:'disabled'});
  // A processed below-range request reports the actual target instead of waiting forever.
  Object.assign(fixture[1],{requestedLimitBytes:500_000_000,desiredLimitBytes:1_000_000_000,effectiveLimitBytes:1_000_001_536,limitBytes:1_000_001_536,limitBlockBytes:4096,enforced:true});
  service.db.prepare('INSERT INTO project_storage_limits_v2(owner_id,machine,project,bytes,updated_by,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(owner_id,machine,project) DO UPDATE SET bytes=excluded.bytes').run('builtin-admin','gpu-1','render',500_000_000,'admin',new Date().toISOString());
  saveProjects(fixture);
  await first.locator('[data-storage-refresh]').click();await page.waitForFunction(()=>document.querySelector('[data-storage-machine=gpu-1]')?.dataset.loading==='false');
  const clamped=await first.locator('[data-project-row=render]').innerText();assert.match(clamped,/已按节点范围调整/);assert.doesNotMatch(clamped,/待生效/);
  await page.screenshot({path:join(shots,`limits-${role}-${width}-clamped.png`),fullPage:true,animations:'disabled'});
  for(const value of fixture)for(const key of ['limitBytes','requestedLimitBytes','desiredLimitBytes','effectiveLimitBytes','enforced','graceUntil','limitBlockBytes'])delete value[key];
  service.db.prepare('DELETE FROM project_storage_limits_v2').run();saveProjects(fixture);
  // People: projects (by creator, including the trashed one) plus images.
  assert.equal(await text(first.locator('[data-owner-row=fixture-member] [data-owner-total]')),'912 GiB');assert.equal(await text(first.locator('[data-owner-row=builtin-admin] [data-owner-total]')),'155 GiB');
  assert.match(await text(first.locator('[data-owner-row=fixture-member] .dr-s').first()),/项目 852 GiB · 镜像与容器引擎 60 GiB/);
  await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:join(shots,`usage-${role}-${width}-accounted.png`),fullPage:true,animations:'disabled'});
  const layout=await page.locator('#page-datasets').evaluate(node=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,undersized:[...node.querySelectorAll('button')].filter(b=>b.getClientRects().length&&b.getBoundingClientRect().height<43).map(b=>b.textContent),
   overflow:[...node.querySelectorAll('.dr-mix,.dr-row')].filter(row=>row.getClientRects().length&&row.getBoundingClientRect().right>innerWidth+1).length,
   clipped:[...node.querySelectorAll('[data-storage-machine]:not([hidden]) :is(.dr-ct,.dr-ow) .dr-main .dr-s')].filter(line=>line.scrollWidth>line.clientWidth+1).map(line=>line.textContent)}));
  assert.equal(layout.scrollWidth,width,'no horizontal page scroll');assert.deepEqual(layout.undersized,[]);assert.equal(layout.overflow,0);assert.deepEqual(layout.clipped,[],'owner and part lines wrap instead of being cut off');observations.push({role,...layout});
  // gpu-2: no project accounting stays unknown, never zero.
  await show('gpu-2');const second=card('gpu-2');
  assert.match(await second.locator('.dr-mix').innerText(),/未开启项目记账，用量未知/);assert.equal(await second.locator('.dr-mix-bar.is-unknown').count(),1);assert.equal(await second.locator('.dr-mix [data-fill]').count(),0);
  assert.equal(await text(second.locator('[data-project-row=notes] [data-project-total]')),'未知');assert.equal(await text(second.locator('[data-project-row=notes] [data-project-parts]')),'文件 未知 · 输出 未知 · 环境 未知');
  assert.match(await second.locator('[data-storage-owners]').innerText(),/未知：这台服务器还没有项目记账数据/);
  await page.screenshot({path:join(shots,`usage-${role}-${width}-unaccounted.png`),fullPage:true,animations:'disabled'});
  // gpu-3: one disk without accounting makes people totals lower bounds.
  await show('gpu-3');assert.equal(await text(card('gpu-3').locator('[data-owner-row=builtin-admin] [data-owner-total]')),'至少 17 GiB');assert.equal(await card('gpu-3').locator('.dr-mix').count(),2);
  // gpu-4: nothing read yet.
  await show('gpu-4');assert.match(await card('gpu-4').locator('[data-storage-mix]').innerText(),/空间构成\s*未知，请刷新重试/);assert.match(await card('gpu-4').locator('[data-storage-owners]').innerText(),/未知/);
  if(role==='member'&&width===1440){
   // Project settings shows the same total and parts as the data page.
   await show('gpu-1');await first.locator('[data-storage-project=render]').click();
   await page.waitForFunction(()=>{const selected=document.querySelector('[name=workspace-project]')?.selectedOptions[0];return selected?.dataset.machine==='gpu-1'&&selected.dataset.ownerId==='builtin-admin'&&selected.dataset.project==='render';});
   await page.locator('[data-pt=settings]').click();await page.locator('#project-disk-quota>summary').click();
   await page.locator('#disk-quota-result').filter({hasText:'项目用量：130 GiB'}).waitFor();
   assert.equal(await text(page.locator('#disk-quota-result .disk-quota-parts')),'文件 100 GiB · 输出 20 GiB · 环境 10 GiB');
   await page.screenshot({path:join(shots,'usage-member-1440-project-settings.png'),fullPage:true,animations:'disabled'});
   // So does the CLI, from the same snapshot.
   const login=await service.login('member',password),session=join(temporary,'session.json');await writeFile(session,JSON.stringify({url:origin,token:login.token,principal:login.principal}));
   const cli=args=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[new URL('../cli.mjs',import.meta.url).pathname,'project','quota','--machine','gpu-1','--session-file',session,...args]);let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));child.stdin.end();});
   const one=await cli(['--project','render','--owner','admin']);assert.equal(one.code,0,one.stderr);assert.match(one.stdout,/项目 render（共用 · 创建人 管理员乙）：合计 130 GiB；文件 100 GiB · 输出 20 GiB · 环境 10 GiB\n统计于 [34] 分钟前/);
   const all=await cli(['--all']);assert.equal(all.code,0,all.stderr);assert.match(all.stdout,/  vision（成员甲）：合计 840 GiB；文件 300 GiB · 输出 500 GiB · 环境 40 GiB\n  render（共用 · 创建人 管理员乙）：合计 130 GiB/);
   assert.match(all.stdout,/按人汇总：\n  成员甲：合计 912 GiB；项目 852 GiB · 镜像与容器引擎 60 GiB\n  管理员乙：合计 155 GiB；项目 130 GiB · 镜像与容器引擎 25 GiB/);
   observations.push({cli:{one:one.stdout,all:all.stdout}});
  }
  await context.close();console.log(role+' '+width+' storage usage PASS');
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);if(process.env.UI_SCREENSHOTS)await writeFile(join(shots,'storage-usage-observations.json'),JSON.stringify({synthetic:true,observations,errors,external},null,2));
}finally{
 clearInterval(timer);await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await rm(temporary,{recursive:true,force:true});
}
