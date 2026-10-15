import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {resolve,extname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {guidePage} from '../guide.mjs';
const origin='https://c3-offline.test',root=resolve(import.meta.dirname,'../dist'),temporary=await mkdtemp(join(tmpdir(),'c3-directory-ui-'));
const shots=process.env.UI_SCREENSHOTS||temporary;await mkdir(shots,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
try{
 for(const role of ['member','admin'])for(const width of [1440,390,320]){
  const owner='member-a',peer='member-b',machine='fixture-node-a',jobId='11111111-1111-4111-8111-111111111111';
  let cloudConnected=false,campusReachable=true,probes=0;const calls=[],errors=[],requests=[],files=new Map(),uploads=new Map(),grants=new Map(),trash=[];let datasets=[{dataset:'images',name:'images',size:3,ownerId:peer,ownerName:'成员乙',uploadedBy:'成员乙',modifiedAt:1700000000}];
  const users=[{id:owner,username:'alice',name:'成员甲',role,enabled:true,approvedAt:'2026-10-14T11:00:00.000Z',total:4,limits:{[machine]:4}},{id:peer,username:'bob',name:'成员乙',role:'member',enabled:true,total:4,limits:{[machine]:4}}];
  const projects=[{project:'vision',ownerId:peer,ownerName:'成员乙',displayName:'共享实验',environmentMode:'oci',lifecycle:{state:'ACTIVE'},git:{url:'https://example.test/team/repo.git',branch:'main',commit:'abc123'}}];
  const state={machines:[{id:machine,name:'示例服务器',cards:4,model:'Fixture GPU'}],users,jobs:[{id:jobId,nodeJobId:'J111111111111',machine,userId:peer,ownerId:peer,username:'bob',name:'团队训练',project:'vision',cards:1,state:'RUNNING',priority:'normal',assignedIndices:[0],createdAt:'2026-10-14T11:00:00.000Z',argv:['python','train.py']}],executionEnabled:true,execution:{},gpuq:{stale:false,connected:true,checkedAt:'2026-10-14T11:00:00.000Z',hosts:[{id:machine,reachable:true,checkedAt:'2026-10-14T11:00:00.000Z',gpus:Array.from({length:4},(_,index)=>({index,model:'Fixture GPU',utilization:index?0:80,memoryUsedMiB:index?0:1024,memoryTotalMiB:8192,temperatureC:40,processes:[],processesAvailable:true})),disks:[{mountPoint:'/fixture-data',totalBytes:1000,usedBytes:100,availableBytes:900}],tasks:[],gpuq:{connected:true,health:'ok',observeOnly:false,schedulableIndices:[0,1,2,3]}}]},operationalMaintenance:{global:null,machines:{}},announcements:{pending:[]},transfers:{}};
  const principal={userId:owner,username:'alice',role,enabled:true},resource=args=>JSON.stringify([args.machine,args.area,args.dataset||args.project,args.ownerId,args.path]);
  files.set(JSON.stringify([machine,'dataset','images',undefined,'sample.bin']),Buffer.from('abc'));
  async function rpc(op,args){
   calls.push({op,args});
   if(op==='cloud.info')return {aliyunConnected:cloudConnected,backend:'aliyun',managedExternally:false,disabled:false,status:cloudConnected?'connected':'disconnected'};
   if(op==='cloud.auth.begin')return {id:'fixture-cloud-login',image:'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22240%22 height=%22240%22/%3E'};
   if(op==='cloud.auth.poll'){cloudConnected=true;return {state:'CONFIRMED'};}
   if(op==='cloud.auth.disconnect'){cloudConnected=false;return {disconnected:true};}
   if(op==='state')return {principal,state};
   if(op==='logout')return {loggedOut:true};
   if(op==='projects.list')return {projects,environmentModes:['oci']};
   if(op==='projects.status'&&args.diagnoseNetwork)return {network:{dns:'ok',https:'ok'}};
   if(op==='projects.status')return projects.find(row=>row.project===args.project&&(!args.ownerId||row.ownerId===args.ownerId))||{};
   if(op==='projects.create'){const row={project:args.project,ownerId:owner,ownerName:'成员甲',environmentMode:'oci',lifecycle:{state:'ACTIVE'},git:args.repo?{url:args.repo,branch:'main',commit:'def456'}:null};projects.push(row);return row;}
   if(op==='projects.quota')return {volumes:[{kind:'workspace',usedBytes:12,totalBytes:1000,availableBytes:988},{kind:'datasets',usedBytes:20,totalBytes:2000,availableBytes:1980}],projectUsage:{size:3,complete:true}};
   if(op==='projects.catalog')return {groups:[]};
   if(op==='datasets.list')return {datasets};
   if(op==='files.list')return {entries:args.path==='.'?[{name:'sample.bin',type:'file',size:3}]:[],hasMore:false};
   if(op==='files.get')return {size:3,offset:args.offset||0,data:Buffer.from('abc').subarray(args.offset||0).toString('base64'),eof:true};
   if(op==='data.upload.begin'){if(!uploads.has(args.key))uploads.set(args.key,{...args,state:'UPLOADING',offset:0,bytes:Buffer.alloc(0)});return uploads.get(args.key);}
   if(op==='data.upload.status')return uploads.get(args.key)||{state:'ABSENT'};
   if(op==='data.upload.chunk'){const row=uploads.get(args.key),bytes=Buffer.from(args.data,'base64');assert.equal(args.offset,row.offset);row.bytes=Buffer.concat([row.bytes,bytes]);row.offset+=bytes.length;return {offset:row.offset,state:'UPLOADING'};}
   if(op==='data.upload.finish'){const row=uploads.get(args.key);assert.equal(row.offset,row.totalSize);row.state='COMPLETE';files.set(resource(row),row.bytes);return {key:args.key,state:'COMPLETE',size:row.totalSize};}
   if(op==='files.direct-ticket'){const id=randomUUID();grants.set(id,args);return {grantId:id,endpoint:origin,ticket:'isolated-browser-ticket',expiresAt:1791975900,chunkBytes:1024**2,file:{size:files.get(resource(args))?.length||3}};}
   if(op==='datasets.delete'){datasets=datasets.filter(row=>row.dataset!==args.dataset);const row={...args,kind:'dataset',state:'TRASHED',retainUntil:1792580400,actor:{userId:owner},originalPath:args.dataset};trash.push(row);return row;}
   if(op==='outputs.delete'){const row={key:args.key,kind:'output',ownerId:peer,project:'vision',jobId:args.jobId,state:'TRASHED',originalPath:args.path,actor:{userId:owner},retainUntil:1792580400};trash.push(row);return row;}
   if(op==='projects.retire.list')return {items:trash};
   if(op==='projects.retire.restore'){const row=trash.find(row=>row.key===args.key);assert.equal(args.kind,row.kind);if(row.kind==='dataset')datasets.push({dataset:row.dataset,name:row.dataset,size:3,ownerName:'成员乙'});trash.splice(trash.indexOf(row),1);return {state:'RESTORED',key:args.key};}
   if(op==='projects.retire.purge'){const row=trash.find(row=>row.key===args.key);trash.splice(trash.indexOf(row),1);return {state:'PURGED',key:args.key};}
   if(op==='cloud.import.list')return {imports:[]};
   if(op==='cloud.import.start')return {operationId:args.key,state:'QUEUED'};
   if(op==='transfers.list')return {transfers:[],nextCursor:null};
   if(op==='community.posts.list')return {posts:[],nextCursor:null};
   if(op==='community.chat.list')return {messages:[],nextCursor:null};
   if(op==='community.notes.list')return {notes:[],nextCursor:null};
   if(op==='invites.list')return {invites:[]};
   if(op==='maintenance.set'){if(args.scope==='all')state.operationalMaintenance.global=args.enabled?{reason:args.reason,since:'2026-10-14T11:00:00.000Z'}:null;return state.operationalMaintenance;}
   if(op==='jobs.watch')return {state:'RUNNING',nativeObservation:{state:'RUNNING'}};
   if(op==='jobs.logs')return {text:'fixture log\n'};
   if(op==='jobs.diagnostics')return {state:'RUNNING'};
   throw Error('Unexpected RPC '+op);
  }
  const context=await browser.newContext({viewport:{width,height:1000},acceptDownloads:true,reducedMotion:'reduce'});await context.addInitScript(()=>{const RealDate=Date;globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[1791975600000]));}static now(){return 1791975600000;}};});const page=await context.newPage();page.setDefaultTimeout(10000);page.setDefaultNavigationTimeout(10000);page.on('pageerror',error=>{errors.push(error.stack);console.error(error.stack);});
  await page.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());if(url.origin!==origin){requests.push(url.href);return route.abort();}
   try{
    if(url.pathname==='/'){let html=await readFile(join(root,'index.html'),'utf8');html=html.replace('globalThis.GPUQ_LOCAL_API=false;','globalThis.GPUQ_LOCAL_API=true;');html=html.replace('<head>','<head><script>window.GPUQ_LOCAL_API=true;window.GPUQ_PRODUCTION=true;window.GPUQ_HAS_SESSION=true;</script>');return route.fulfill({contentType:'text/html',body:html});}
    if(url.pathname==='/auth/login')return route.fulfill({contentType:'text/html',body:'统一门户登录'});
    if(url.pathname==='/guide')return route.fulfill({contentType:'text/html',body:await guidePage(null,origin)});
    if(url.pathname==='/machines.js')return route.fulfill({contentType:'text/javascript',body:'export const MACHINES='+JSON.stringify(state.machines)});
    if(url.pathname==='/capabilities'){probes++;return campusReachable?route.fulfill({contentType:'application/json',body:'{}'}):route.abort('connectionrefused');}
    if(url.pathname.startsWith('/api/')){const body=request.postDataJSON(),result=await rpc(body.operation,body.args||{});return route.fulfill({contentType:'application/json',body:JSON.stringify(body.operation==='state'?result:{ok:true,result})});}
    if(url.pathname.startsWith('/v1/files/')){const parts=url.pathname.split('/'),args=grants.get(parts[3]),offset=Number(url.searchParams.get('offset'));assert.ok(args);if(parts[4]==='put'){const bytes=request.postDataBuffer(),row=uploads.get(args.uploadId);assert.equal(offset,row.offset);assert.ok(bytes.length<=1024**2);row.bytes=Buffer.concat([row.bytes,bytes]);row.offset+=bytes.length;return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,result:{key:row.key,offset:row.offset,state:'UPLOADING'}})});}const bytes=files.get(resource(args))||Buffer.from('abc');return route.fulfill({contentType:'application/octet-stream',headers:{'x-gpuq-file-metadata':Buffer.from(JSON.stringify({size:bytes.length,offset})).toString('base64url')},body:bytes.subarray(offset)});}
    const path=resolve(root,'.'+url.pathname);if(!path.startsWith(root+'/'))throw Error('Outside static root');return route.fulfill({contentType:extname(path)==='.js'?'text/javascript':extname(path)==='.css'?'text/css':extname(path)==='.woff2'?'font/woff2':'application/octet-stream',body:await readFile(path)});
   }catch(error){errors.push(error.stack);console.error(error.stack);await route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:error.message})});}
  });
  await page.goto(origin);await page.locator('[data-nav=resources][aria-current=page]').waitFor();await page.locator('[data-nav=work]').click();await page.locator('[name=workspace-project] option[data-owner-id="member-b"]').waitFor({state:'attached'}).catch(async error=>{console.error(JSON.stringify({errors,calls,requests,body:(await page.locator('body').innerText()).slice(0,500)}));throw error;});
  await page.locator('[name=workspace-project]').selectOption({label:'共享实验 · 成员乙 · OCI 容器 · '+machine});
  await page.waitForFunction(()=>!document.querySelector('[name=workspace-project]').disabled);
  assert.match(await page.locator('#project-status-detail').textContent(),/abc123/);assert.equal(await page.locator('#project-publish').count(),0);assert.equal(await page.locator('[name=release]').count(),0);
  await page.locator('#project-create>summary').click();await page.locator('[name=new-project]').fill('git-test');await page.locator('[name=new-project-repo]').fill('https://example.test/team/new.git');await page.locator('#project-create-form [type=submit]').click();await page.waitForFunction(()=>document.querySelector('#project-status-detail').textContent.includes('def456'));
  assert.equal(calls.find(row=>row.op==='projects.create').args.repo,'https://example.test/team/new.git');await page.locator('[name=workspace-project]').selectOption({label:'共享实验 · 成员乙 · OCI 容器 · '+machine});await page.waitForFunction(()=>!document.querySelector('[name=workspace-project]').disabled);
  await page.evaluate(()=>document.fonts.ready);await page.screenshot({animations:'disabled',path:join(shots,role+'-'+width+'-work.png'),fullPage:true});
  await page.locator('#project-network-check').click();await page.locator('#project-network-result').filter({hasText:'https'}).waitFor();
  await page.locator('[data-nav=jobs]').click();await page.locator('[data-job-output="'+jobId+'"]').first().click();await page.locator('[data-result-delete="sample.bin"]').waitFor();
  assert.equal(await page.locator('#workspace-upload').isVisible(),false);assert.equal(await page.locator('[name=files]').isVisible(),false);
  await page.screenshot({path:join(shots,role+'-'+width+'-outputs.png'),fullPage:true,animations:'disabled'});
  await page.locator('[data-result-path="sample.bin"]').click();const outputDownloaded=page.waitForEvent('download');await page.locator('#workspace-download').click();const outputDownload=await outputDownloaded;assert.deepEqual(await readFile(await outputDownload.path()),Buffer.from('abc'));
  assert.ok(calls.some(row=>row.op==='files.get'&&row.args.area==='output'&&row.args.runId===jobId));assert.equal(calls.some(row=>row.op==='files.direct-ticket'&&row.args.area==='output'),false);
  const deleteTarget=page.locator('[data-result-delete="sample.bin"]');assert.ok((await deleteTarget.boundingBox()).height>=44);await deleteTarget.click();await page.waitForFunction(()=>document.body.innerText.includes('已删除，7 天内可在项目回收站恢复'),null,{timeout:10000});
  assert.equal(calls.filter(row=>row.op==='outputs.delete').length,1);assert.equal(trash[0].kind,'output');
  await page.locator('.job-log-dialog').evaluate(node=>node.close());

  await page.locator('[data-nav=datasets]').click();await page.locator('[data-dataset-open=images]').waitFor();assert.match(await page.locator('[data-dataset-list]').textContent(),/成员乙/);
  await page.locator('[data-dataset-open=images]').click();await page.locator('[data-file-path="sample.bin"]').waitFor();
  await page.locator('#dataset-upload-form').evaluate(node=>node.closest('details').open=true);
  await page.locator('[name=upload-files]').setInputFiles({name:'new.bin',mimeType:'application/octet-stream',buffer:Buffer.alloc(1024**2+3,11)});
  await page.locator('#dataset-upload-form [type=submit]').click();await page.waitForFunction(()=>document.querySelector('[data-dataset-status]').textContent.includes('上传完成'));
  assert.equal([...uploads.values()][0].bytes.length,1024**2+3);assert.ok(calls.filter(row=>row.op==='data.upload.begin').every(row=>row.args.area==='dataset'&&row.args.dataset==='images'));
  const directKey=[...uploads.keys()][0];assert.equal(await page.evaluate(cache=>localStorage.getItem(cache),'dataset-upload:'+owner+':'+directKey+':via'),'direct');assert.equal(probes,1);assert.equal(calls.filter(row=>row.op==='data.upload.chunk').length,0);
  campusReachable=false;const relayKey=randomUUID();await page.locator('[name=upload-key]').fill(relayKey);await page.locator('#dataset-upload-form [type=submit]').click();await page.waitForFunction(()=>document.querySelector('[data-dataset-status]').textContent.includes('上传完成'));assert.equal(probes,2);assert.equal(uploads.get(relayKey).bytes.length,1024**2+3);assert.equal(await page.evaluate(cache=>localStorage.getItem(cache),'dataset-upload:'+owner+':'+relayKey+':via'),'relay');
  const beforeResume=probes;await page.locator('[name=upload-key]').fill(relayKey);await page.locator('#dataset-upload-form [type=submit]').click();await page.waitForFunction(()=>document.querySelector('[data-dataset-status]').textContent.includes('上传完成'));assert.equal(probes,beforeResume);campusReachable=true;
  const fileDownloaded=page.waitForEvent('download');await page.locator('[data-file-path="sample.bin"]').click();const fileDownload=await fileDownloaded;assert.deepEqual(await readFile(await fileDownload.path()),Buffer.from('abc'));
  const directoryDownloaded=page.waitForEvent('download');await page.locator('[data-dataset-download=images]').click();const directoryDownload=await directoryDownloaded;const tar=await readFile(await directoryDownload.path());assert.ok(tar.includes(Buffer.from('sample.bin')));assert.ok(tar.includes(Buffer.from('abc')));
  await page.locator('[data-dataset-delete=images]').click();await page.waitForFunction(()=>document.querySelector('[data-dataset-status]').textContent.includes('7 天'));
  await page.locator('#page-datasets .project-trash>summary').click();await page.locator('#page-datasets [data-trash-restore]').last().click();await page.locator('[data-dataset-open=images]').waitFor();
  await page.locator('#page-datasets [data-trash-restore]').first().click();assert.ok(calls.some(row=>row.op==='projects.retire.restore'&&row.args.kind==='output'));
  if(role==='admin'){await page.locator('[data-dataset-delete=images]').click();await page.locator('#page-datasets [data-trash-refresh]').click();await page.locator('#page-datasets [data-trash-purge]').waitFor();page.once('dialog',dialog=>dialog.accept());await page.locator('#page-datasets [data-trash-purge]').click();await page.waitForFunction(()=>document.querySelector('[data-dataset-status]').textContent==='已彻底删除。',null,{timeout:2000});}
  await page.locator('.storage-import>summary').click();
  await page.locator('[name=cloud-target-name]').fill('images');await page.locator('[name=cloud-url]').fill('https://example.test/payload.bin');await page.locator('[name=cloud-path]').fill('payload.bin');await page.locator('#cloud-import-form [type=submit]').click();await page.waitForTimeout(50);const imported=calls.find(row=>row.op==='cloud.import.start');assert.equal(imported.args.area,'dataset');assert.equal(imported.args.dataset,'images');
  if(role==='admin'){await page.locator('#cloud-admin>summary').click({position:{x:8,y:8}});await page.waitForFunction(()=>document.querySelector('#cloud-auth-status').textContent.includes('未连接'));for(let round=0;round<2;round++){await page.locator('#cloud-auth-begin').click();await page.locator('#cloud-auth-check').waitFor({state:'visible'});await page.locator('#cloud-auth-check').click();await page.waitForFunction(()=>document.querySelector('#cloud-auth-status').textContent==='云盘已连接。');await page.locator('#cloud-auth-disconnect').click();await page.waitForFunction(()=>document.querySelector('#cloud-auth-status').textContent==='已断开。');}await page.locator('#cloud-admin>summary').click({position:{x:8,y:8}});}
  await page.evaluate(()=>document.fonts.ready);await page.screenshot({animations:'disabled',path:join(shots,role+'-'+width+'-datasets.png'),fullPage:true});
  await page.locator('[data-nav=resources]').click();await page.evaluate(()=>document.fonts.ready);await page.screenshot({animations:'disabled',path:join(shots,role+'-'+width+'-resources.png'),fullPage:true});
  await page.locator('[data-nav=community]').click();await page.waitForTimeout(50);await page.evaluate(()=>document.fonts.ready);await page.screenshot({animations:'disabled',path:join(shots,role+'-'+width+'-community.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'no horizontal page overflow at '+width);
  if(role==='admin'){
   await page.evaluate(()=>{location.hash='#admin/maintenance';});await page.locator('[data-maintenance-settings]').waitFor();
   await page.locator('[data-maintenance-settings]').click();await page.locator('#maintenance-settings-reason').fill('隔离测试维护');
   await page.locator('#maintenance-settings-dialog [type=submit]').click();await page.locator('#maintenance-settings-dialog').waitFor({state:'hidden'});
   assert.equal(state.operationalMaintenance.global.reason,'隔离测试维护');
   await page.locator('[data-maintenance-settings]').click();await page.locator('#maintenance-settings-dialog [data-maintenance-resume]').click();
   await page.locator('#maintenance-settings-dialog').waitFor({state:'hidden'});assert.equal(state.operationalMaintenance.global,null);
   assert.equal(await page.locator('[data-maintenance-settings]').evaluate(node=>document.activeElement===node),true);
   await page.locator('[data-maintenance-settings]').click();await page.evaluate(()=>{location.hash='#resources';});
   await page.locator('#maintenance-settings-dialog').waitFor({state:'detached'});assert.equal(await page.locator('[data-nav=resources][aria-current=page]').count(),1,'leaving admin also closes and removes its maintenance dialog');
   await page.evaluate(()=>{location.hash='#admin/maintenance';});await page.locator('[data-maintenance-settings]').waitFor();
   await page.evaluate(()=>document.fonts.ready);await page.screenshot({animations:'disabled',path:join(shots,role+'-'+width+'-admin.png'),fullPage:true});
  }
  await page.locator('#account-menu-toggle').click();assert.equal(await page.locator('[data-shell-action=admin]').isVisible(),role==='admin');
  await page.screenshot({path:join(shots,role+'-'+width+'-account.png'),fullPage:true,animations:'disabled'});
  await page.locator('[data-shell-action=quota]').click();await page.locator('#quota-ledger').waitFor();
  assert.equal(await page.locator('#room-nav [data-nav]').count(),5);assert.equal(await page.locator('[data-shell-action=control]').count(),1);assert.equal(await page.locator('#control-strip,#mobile-control,#shell-context').count(),0);
  const touch=await page.locator('#room-nav a,#account-menu-toggle,.command-trigger').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return r.width>=44&&r.height>=44;}));assert.ok(touch.every(Boolean));
  await page.locator('.command-trigger').click();await page.locator('#control-command').fill('火星');await page.locator('.egg-mars').waitFor();
  await page.screenshot({path:join(shots,role+'-'+width+'-palette.png'),animations:'disabled'});
  await page.locator('#control-command').fill('月球');await page.locator('.egg-moon').waitFor();await page.keyboard.press('Escape');assert.equal(await page.locator('.command-trigger').evaluate(node=>node===document.activeElement),true);
  await page.keyboard.press('Control+k');await page.locator('#control-command').fill('团队训练');await page.locator('[data-command-id="job:'+jobId+'"]').waitFor();await page.keyboard.press('Enter');await page.locator('.job-log-dialog[open]').waitFor();await page.locator('.job-log-dialog').evaluate(node=>node.close());
  await page.locator('.command-trigger').click();await page.locator('#control-command').fill('新建任务');await page.locator('[data-command-id=submit]').click();await page.locator('#work-submit[open]').waitFor();await page.locator('#close-submit').click();await page.locator('#work-submit').waitFor({state:'hidden'});
  await page.locator('.command-trigger').click();await page.locator('#control-command').fill('共享实验');await page.locator('[data-command-id^="project:"]').click();await page.locator('[data-nav=work][aria-current=page]').waitFor();
  await page.locator('.command-trigger').click();await page.locator('#control-command').fill('images');await page.locator('[data-command-id^="dataset:"]').click();await page.locator('[data-nav=datasets][aria-current=page]').waitFor();await page.locator('[data-dataset-current]').filter({hasText:'images'}).waitFor();await page.locator('[data-dataset-files]').waitFor({state:'visible'});await page.locator('[data-file-path="sample.bin"]').waitFor();assert.equal(await page.locator('[name=dataset-machine]').inputValue(),machine);
  assert.ok(await page.evaluate(()=>document.getAnimations().every(animation=>animation.playState!=='running')),'reduced motion disables animation');
  await page.goto(origin+'/guide');await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:join(shots,role+'-'+width+'-guide.png'),fullPage:true,animations:'disabled'});
  await page.route('https://www.j4rv1s.xyz/',route=>route.fulfill({contentType:'text/html',body:'统一门户首页'}));
  await page.goto(origin+'/#resources');await page.locator('#account-menu-toggle').click();assert.equal(await page.locator('#switch-account').innerText(),'退出 AMAX');await page.locator('#switch-account').click();await page.waitForURL('https://www.j4rv1s.xyz/');assert.equal(calls.filter(row=>row.op==='logout').length,1);
  await page.route(origin+'/',async route=>{let html=await readFile(join(root,'index.html'),'utf8');html=html.replace('globalThis.GPUQ_LOCAL_API=false;','globalThis.GPUQ_LOCAL_API=true;');html=html.replace('<head>','<head><script>window.GPUQ_PRODUCTION=true;window.GPUQ_HAS_SESSION=false;</script>');await route.fulfill({contentType:'text/html',body:html});});
  await page.goto(origin);await page.waitForURL(origin+'/auth/login');assert.equal(await page.locator('#login-dialog,#register-dialog').count(),0);await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:join(shots,role+'-'+width+'-login.png'),fullPage:true,animations:'disabled'});
  assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);await context.close();console.log(role+' '+width+' PASS');
 }
}finally{await browser.close();if(!process.env.UI_SCREENSHOTS)await rm(temporary,{recursive:true,force:true});}
