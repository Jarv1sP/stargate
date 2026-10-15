import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createServer} from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {credential} from '../dist/service.js';
import {MACHINES} from '../dist/model.js';
const temporary=await mkdtemp(join(tmpdir(),'storage-node-ui-')),shots=process.env.UI_SCREENSHOTS||temporary;await mkdir(shots,{recursive:true});
const worker=spawn(process.env.PYTHON||'python3',[new URL('./fixtures/storage-node.py',import.meta.url).pathname],{stdio:['pipe','pipe','inherit']});
const exited=new Promise(resolve=>worker.once('exit',resolve));let serial=0;const pending=new Map();
createInterface({input:worker.stdout}).on('line',line=>{const value=JSON.parse(line),request=pending.get(value.id);pending.delete(value.id);if(value.error)request.reject(Error(value.error));else request.resolve(value.result);});
worker.on('exit',code=>{for(const request of pending.values())request.reject(Error('Local fixture stopped: '+code));pending.clear();});
const local=(machine,operation,args)=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});worker.stdin.write(JSON.stringify({id,machine,operation,args})+'\n');});
const GiB=1024**3,statusPath=join(temporary,'status.json'),bootstrap=join(temporary,'bootstrap.json'),password='Synthetic-Storage-UI-2026!';
const status=()=>{const checkedAt=new Date().toISOString();return {checkedAt,hosts:MACHINES.map(m=>({id:m.id,checkedAt,reachable:true,gpus:[],gpuq:{connected:true,health:'ok',jobs:[]}}))};};
const refresh=async()=>{await writeFile(statusPath+'.new',JSON.stringify(status()));await rename(statusPath+'.new',statusPath);};await refresh();await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
let hold=false,release,failed='',server,browser,timer;const calls=[],errors=[],external=[],observations=[];
const bridge=async(machine,operation,args)=>{
 calls.push({machine,operation,args});
 if(operation==='transfers.list')return {transfers:[]};
 if(operation==='projects.retire.list')return {items:[]};
 if(machine==='gpu-4'||machine===failed)throw Object.assign(Error('节点暂未响应，请稍后重试。'),{status:503});
 if(hold&&(operation==='datasets.list'||operation==='projects.list'&&args.includeUsage))await new Promise(resolve=>{const previous=release;release=()=>{previous?.();resolve();};});
 return local(machine,operation,args);
};
try{
 const reserved=createServer();await new Promise(resolve=>reserved.listen(0,'127.0.0.1',resolve));const port=reserved.address().port;await new Promise(resolve=>reserved.close(resolve));const origin='http://127.0.0.1:'+port;
 const created=await createPortalServer({database:join(temporary,'portal.sqlite'),bootstrap,origin,secure:false,statusPath,bridge,fileLanEndpoints:'{}',directUploadOrigins:'[]'});server=created.server;const service=created.service;clearInterval(service.executionTimer);
 const limits=Object.fromEntries(MACHINES.map(m=>[m.id,m.cards]));Object.assign(service.store.users[0],{name:'管理员乙',limits,total:30,approvedAt:new Date().toISOString()});service.store.users.push({id:'fixture-member',username:'member',name:'成员甲',role:'member',enabled:true,total:8,limits,approvedAt:new Date().toISOString()});service.accounts.insert(service.store.users.at(-1),await credential(password,600000));service.accounts.rename('builtin-admin','管理员乙');service.refreshAccounts();service.save();
 await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));timer=setInterval(()=>refresh().catch(()=>{}),2000);
 browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
 for(const role of ['member','admin'])for(const width of [1440,390,320]){
  hold=role==='member'&&width===1440;const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'}),page=await context.newPage();page.setDefaultTimeout(12000);
  page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){external.push(route.request().url());return route.abort();}return route.continue();});
  const login=await context.request.post(origin+'/api/login',{headers:{Origin:origin},data:{username:role==='admin'?'admin':'member',password,client:'browser'}});assert.equal(login.ok(),true,'storage browser login HTTP '+login.status());
  const cookieName=login.headers()['set-cookie']?.split('=',1)[0];assert.ok(cookieName&&(await context.cookies()).some(cookie=>cookie.name===cookieName),'the browser context receives its session cookie');
  await page.goto(origin+'/#storage');await page.locator('[data-nav=datasets][aria-current=page]').waitFor();
  const first=page.locator('[data-storage-machine=gpu-1]');await first.locator('.storage-bar:not(.is-unknown)').first().waitFor();
  if(hold){
   assert.equal(await first.locator('[data-storage-projects]').innerText(),'读取中…');
   await page.evaluate(()=>document.dispatchEvent(new CustomEvent('gpuq-open-dataset',{detail:{userId:'fixture-member',machine:'gpu-2',dataset:'images'}})));
   await page.locator('[data-dataset-files]').waitFor({state:'visible'});await page.locator('[data-file-path="sample.bin"]').waitFor();
   assert.equal(await page.locator('[name=dataset-machine]').inputValue(),'gpu-2');
   hold=false;release();release=null;
  }
  await first.locator('[data-dataset-open=images]').waitFor();await page.waitForFunction(()=>[...document.querySelectorAll('[data-storage-machine]')].every(node=>node.dataset.loading==='false'));
  assert.equal(await page.locator('.storage-server').count(),MACHINES.length);assert.match(await page.locator('[data-storage-machine=gpu-2] [data-storage-datasets]').innerText(),/至少 3 B/);assert.match(await page.locator('[data-storage-machine=gpu-3] .storage-warning').innerText(),/空间不足/);assert.equal(await page.locator('[data-storage-machine=gpu-4] .storage-bar.is-unknown').count(),2);assert.equal(await page.locator('[data-storage-machine=gpu-4] .storage-bar i').count(),0);
  const scans=()=>calls.filter(r=>r.operation==='datasets.list'||r.operation==='projects.list'&&r.args.includeUsage).length,before=scans();
  const refreshed=page.waitForResponse(response=>response.request().url()===origin+'/api/call'&&response.request().postDataJSON()?.operation==='state');await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await refreshed;await page.waitForTimeout(50);assert.equal(scans(),before,'state refresh does not scan directory sizes');
  await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:join(shots,role+'-'+width+'-storage.png'),fullPage:true,animations:'disabled'});
  const bar=await first.locator('[data-volume=datasets] .storage-bar').evaluate(node=>node.firstElementChild.getBoundingClientRect().width/node.getBoundingClientRect().width);assert.ok(Math.abs(bar-.5)<.01,'real Portal CSP permits the actual 50% fill');
  assert.equal(await page.locator('.storage-figures').evaluateAll(rows=>rows.some(row=>[...row.querySelectorAll('dd')].some((item,i,items)=>i<items.length-1&&item.getBoundingClientRect().right>items[i+1].getBoundingClientRect().left))),false,'capacity figures do not overlap on phones');
  const layout=await page.locator('#page-datasets').evaluate(node=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,background:getComputedStyle(node.querySelector('.storage-server')).backgroundColor,undersized:[...node.querySelectorAll('button')].filter(b=>b.getClientRects().length&&b.getBoundingClientRect().height<43).map(b=>b.textContent)}));assert.equal(layout.scrollWidth,width);assert.notEqual(layout.background,'rgb(255, 255, 255)');assert.deepEqual(layout.undersized,[]);observations.push({role,...layout});
  await first.locator('[data-dataset-open=images]').click();await page.locator('[data-dataset-files]').waitFor({state:'visible'});await page.locator('[data-file-path="sample.bin"]').waitFor();
  await page.locator('.command-trigger').click();await page.locator('#control-command').fill('images');await page.locator('[data-command-id="dataset:gpu-2:images"]').waitFor();
  const searched=scans();await page.locator('[data-command-id="dataset:gpu-2:images"]').click();
  await page.locator('[data-dataset-current]').filter({hasText:'images'}).waitFor();await page.locator('[data-file-path="sample.bin"]').waitFor();
  assert.equal(await page.locator('[name=dataset-machine]').inputValue(),'gpu-2');assert.equal(scans(),searched,'opening a search result only reads files and does not rescan storage cards');
  await page.screenshot({path:join(shots,role+'-'+width+'-storage-browse.png'),fullPage:true,animations:'disabled'});
  if(role==='member'&&width===1440){
   const beforeTools=scans();
   await page.locator('[data-storage-machine=gpu-2] [data-storage-upload]').click();assert.equal(await page.locator('[name=dataset-machine]').inputValue(),'gpu-2');assert.equal(await page.locator('#dataset-upload').evaluate(node=>node.open),true);await page.locator('#dataset-upload').evaluate(node=>node.open=false);await page.locator('[data-storage-machine=gpu-2] [data-storage-trash]').click();await page.locator('#page-datasets .project-trash [data-trash-status]').filter({hasText:'回收站为空'}).waitFor();await page.locator('#page-datasets .project-trash').evaluate(node=>node.open=false);assert.equal(scans(),beforeTools,'upload/trash controls do not rescan directory sizes');
   await page.locator('[data-storage-machine=gpu-2] [data-dataset-open=images]').click();await page.locator('[data-file-path="sample.bin"]').waitFor();failed='gpu-1';await first.locator('[data-dataset-open=images]').click();await page.locator('[data-dataset-file-list]').filter({hasText:'未知'}).waitFor();assert.equal(await page.locator('[data-file-path="sample.bin"]').count(),0,'failed machine change removes previous file rows');
   await first.locator('[data-storage-refresh]').click();await page.waitForFunction(()=>document.querySelector('[data-storage-machine=gpu-1] [data-storage-datasets]').textContent.includes('未知'));assert.equal(await first.locator('[data-dataset-open=images]').count(),0);assert.equal(await page.locator('[data-storage-machine=gpu-2] [data-dataset-open=images]').count(),1);await page.screenshot({path:join(shots,'member-1440-storage-read-failed.png'),fullPage:true,animations:'disabled'});failed='';
   const login=await service.login('member',password),session=join(temporary,'session.json');await writeFile(session,JSON.stringify({url:origin,token:login.token,principal:login.principal}));
   const result=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[new URL('../cli.mjs',import.meta.url).pathname,'project','quota','--machine','gpu-2','--project','vision','--session-file',session]);let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));child.stdin.end();});assert.equal(result.code,0,result.stderr);assert.match(result.stdout,/项目 vision 文件用量：至少/);assert.match(result.stdout,/工作区盘（SSD）/);observations.push({nodeBytesCLI:result});
   await page.locator('[data-storage-machine=gpu-2] [data-storage-project=render]').click();await page.waitForFunction(()=>{const selected=document.querySelector('[name=workspace-project]').selectedOptions[0];return selected?.dataset.machine==='gpu-2'&&selected.dataset.ownerId==='builtin-admin'&&selected.dataset.project==='render';});
  }
  await context.close();console.log(role+' '+width+' storage PASS');
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);if(process.env.UI_SCREENSHOTS)await writeFile(join(shots,'storage-observations.json'),JSON.stringify({synthetic:true,observations,errors,external,calls},null,2));
}finally{
 hold=false;release?.();clearInterval(timer);await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}worker.stdin.end();await exited;await rm(temporary,{recursive:true,force:true});
}
