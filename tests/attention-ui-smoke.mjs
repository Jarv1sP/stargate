// Real Portal, cookies, CSP and UI actions; disposable history and node records.
// No production requests, shell sessions or GPU execution.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/machines.js';
import {accountMenu,refreshVisible} from './starbase-workflows.mjs';
import {guardedRoute} from './browser-route-guard.mjs';
import {attentionStorageKey} from '../dist/attention-state.js';

const directory=await mkdtemp(join(tmpdir(),'attention-browser-'));
const shots=process.env.UI_SCREENSHOTS||join(directory,'shots');
const password='Local-Attention-Fixture-2026!',errors=[],outside=[],requests=[];
const layoutMachines=process.env.ATTENTION_MACHINE_MANIFEST?JSON.parse(await readFile(process.env.ATTENTION_MACHINE_MANIFEST,'utf8')):MACHINES;
const forward=new Map(MACHINES.map((row,index)=>[row.id,layoutMachines[index].id])),reverse=new Map([...forward].map(([key,value])=>[value,key]));
const remap=(value,map)=>typeof value==='string'?(map.get(value)||value):Array.isArray(value)?value.map(item=>remap(item,map)):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[map.get(key)||key,remap(item,map)])):value;
let server,service,browser,member,peer,adminUser,onlyFailures,manyUnknown,uncertainData;
const jobs=new Map(),dataRows=new Map(),pendingName='待审批的新成员';
const uncertainRows=[];
try{
  await mkdir(shots,{recursive:true});
  const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const bootstrap=join(directory,'bootstrap');await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});
  ({server,service}=await createPortalServer({database:join(directory,'portal.db'),bootstrap,origin,secure:false,bridge:async(machine,operation,args)=>{
    if(operation==='projects.list')return {projects:[]};
    if(operation==='datasets.list')return {datasets:[]};
    if(operation==='datasets.capacity')return {filesystemBytes:1024**4,availableBytes:512*1024**3,reserveBytes:10*1024**3,usableBytes:502*1024**3,guarded:true};
    if(operation==='logs')return {text:'Local task log. No command executes.'};
    if(operation==='diagnostics')return {jobId:args.job.id,state:'COMPLETE',schedulerState:'FAILED',attempts:[],captures:[],historyAvailable:true,allocationHistory:[]};
    throw Error('Unexpected synthetic operation '+operation);
  }}));
  // Keep these explicit observations stable; the fixture never contacts a node.
  clearInterval(service.executionTimer);clearInterval(service.transferTimer);await new Promise(resolve=>server.listen(new URL(origin).port,'127.0.0.1',resolve));
  const admin=await service.login('admin',password);adminUser=service.store.users.find(row=>row.username==='admin');
  async function create(username,name){const user=(await service.invoke(admin.token,'users.create',{username,name,password})).result;await service.invoke(admin.token,'policy.full',{userId:user.id,policyVersion:0});return user;}
  member=await create('attention-member','陈思远');peer=await create('attention-peer','另一账号');
  onlyFailures=await create('attention-only-failures','只有失败的账号');manyUnknown=await create('attention-many-unknown','状态待确认的账号');
  uncertainData=await create('attention-uncertain-data','数据待确认的账号');
  await service.invoke(admin.token,'users.create',{username:'attention-pending',name:pendingName,password});
  const now=Date.now(),old=now-48*60*60*1000;
  function job(user,name,state,extra={}){const id=randomUUID();return {id,userId:user.id,username:user.username,name,state,machine:MACHINES[0].id,cards:1,createdAt:old/1000,priority:'normal',spec:{id,argv:['python','train.py']},...extra};}
  for(const user of [member,adminUser]){
    const historical=Array.from({length:211},(_,index)=>job(user,'历史失败 '+(index+1),'FAILED',{error:'原有失败记录仍保留',latestAttempt:{finishedAt:old/1000}}));
    const recent=['最近失败 · 输出路径','最近失败 · 显存不足','最近失败 · 保存权重'].map(name=>job(user,name,'FAILED',{error:'请查看日志与诊断',latestAttempt:{finishedAt:(now-60*1000)/1000,exitCode:1}}));
    const unknown=job(user,'训练状态待确认','UNKNOWN'),missing=job(user,'未记录失败时间','FAILED'),success=job(user,'已完成的训练','SUCCEEDED');
    const running=job(user,'当前训练','RUNNING',{progress:{reported:true,stale:false,snapshot:{epochsCompleted:12,epochsTotal:40,updatedAt:now/1000}}});
    const rows=[...historical,...recent,missing,success,unknown,running];jobs.set(user.id,{rows,historical,recent,unknown,missing,success,running});service.store.jobs.push(...rows);
  }
  const peerFailure=job(peer,'另一账号的最近失败','FAILED',{finishedAt:new Date(now-60*1000).toISOString()});service.store.jobs.push(peerFailure);
  const onlyFailure=job(onlyFailures,'最近失败','FAILED',{finishedAt:new Date(now-60*1000).toISOString()});service.store.jobs.push(onlyFailure);
  service.store.jobs.push(...Array.from({length:101},(_,index)=>job(manyUnknown,'待确认 '+index,'UNKNOWN')));service.save();
  const insert=service.db.prepare('INSERT INTO transfers (id,owner_id,client_key,digest,state,created_at,updated_at,data) VALUES (?,?,?,?,?,?,?,?)');
  for(const [name,state,time] of [['最近失败的数据任务','FAILED',now-60000],['历史失败的数据任务','FAILED',old],['复制进行中','RUNNING',now]]){
    const id=randomUUID(),data={owner:{id:member.id,name:member.name},name,kind:'copy',machine:MACHINES[0].id,from:MACHINES[1].id,error:state==='FAILED'?'复制被中断 <img src=x onerror=bad>':null};
    insert.run(id,member.id,randomUUID(),'local-fixture',state,old,time,JSON.stringify(data));dataRows.set(name,id);
  }
  // A full first page of ended records must not hide the older actionable row.
  for(let i=0;i<51;i++){const id=randomUUID();insert.run(id,member.id,randomUUID(),'local-fixture','SUCCEEDED',old+1000,old+1000,JSON.stringify({owner:{id:member.id,name:member.name},name:'已结束传输 '+i,kind:'copy',machine:MACHINES[0].id}));}
  for(const [state,time] of [['UNKNOWN',old],['PARTIAL',now-60000],['UNCONFIRMED',old],['FAILED',now-60000]]){
    const id=randomUUID(),data={owner:{id:uncertainData.id,name:uncertainData.name},name:'数据待确认 '+state,kind:'copy',machine:MACHINES[0].id,from:MACHINES[1].id};
    insert.run(id,uncertainData.id,randomUUID(),'local-fixture',state,old,time,JSON.stringify(data));uncertainRows.push({id,state});
  }
  const unchangedJobs=structuredClone(service.store.jobs);
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  async function pageFor(width,{storageError}={}){
    const context=await browser.newContext({viewport:{width,height:width<760?844:1080},reducedMotion:'reduce'});
    if(storageError)await context.addInitScript(phase=>{const key=phase==='read'?'getItem':'setItem',original=Storage.prototype[key];Storage.prototype[key]=function(name,...args){if(name.startsWith('stargate:attention-read:'))throw Error('Fixture storage failure');return original.call(this,name,...args);};},storageError);
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>{window.attentionCSP=[];window.attentionTrace=[];document.addEventListener('securitypolicyviolation',event=>attentionCSP.push(event.violatedDirective));for(const type of ['gpuq-data-activities','gpuq-attention-viewed'])document.addEventListener(type,event=>attentionTrace.push({time:Date.now(),type,detail:event.detail}));});
    page.on('request',request=>{if(request.url().endsWith('/api/call'))requests.push(request.postDataJSON().operation);});
    await page.route('**/*',guardedRoute(async route=>{const url=new URL(route.request().url());if(url.origin===origin||['data:','blob:'].includes(url.protocol)){await route.continue();return;}outside.push(url.href);await route.abort();}));
    if(process.env.ATTENTION_MACHINE_MANIFEST)await page.route(origin+'/**',guardedRoute(async route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.pathname==='/machines.js'){const response=await route.fetch();if(response.status()===200)await route.fulfill({response,contentType:'text/javascript',body:'export const MACHINES='+JSON.stringify(layoutMachines)+';'});else await route.fulfill({response});return;}
      if(!url.pathname.startsWith('/api/')){await route.fallback();return;}
      const response=await route.fetch({postData:JSON.stringify(remap(request.postDataJSON(),reverse))});
      await route.fulfill({response,json:remap(await response.json(),forward)});
    }));
    return page;
  }
  async function login(page,user,hash='#resources'){
    await page.goto(origin+'/'+hash);await page.locator('#login-form [name=username]').fill(user.username);await page.locator('#login-form [name=password]').fill(password);
    await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});await page.evaluate(()=>document.fonts.ready);
    if([member.id,uncertainData.id].includes(user.id)){await page.waitForFunction(()=>document.querySelector('#control-strip').textContent.includes('后台数据'));assert.equal(await page.locator('#transfer-list [data-transfer-id]').count(),0,'attention is available before entering the data room');}
    await page.locator('#page-resources').waitFor({state:'visible'});
  }
  async function count(page,expected){
    try{await page.waitForFunction(n=>{const text=document.querySelector('#control-strip .cs-attention')?.textContent;return n?text==='需处理 '+(n>99?'99+':n):!text;},expected);}
    catch(error){
      const evidence=await page.evaluate(()=>({strip:document.querySelector('#control-strip')?.textContent,pill:document.querySelector('#live-pill')?.textContent,trace:attentionTrace,readMarkers:Object.fromEntries(Object.keys(localStorage).filter(key=>key.startsWith('stargate:attention-read:')).map(key=>{try{return [key,localStorage.getItem(key)];}catch{return [key,'unavailable'];}}))}));
      await writeFile(join(shots,'attention-failure.json'),JSON.stringify({expected,...evidence},null,2));await writeFile(join(shots,'attention-failure.html'),await page.content());await page.screenshot({path:join(shots,'attention-failure.png')});throw error;
    }
  }
  async function open(page){if(page.viewportSize().width<760&&await page.locator('#live-pill').isVisible())await page.locator('#live-pill').click();else await page.keyboard.press('Control+k');await page.locator('#mission-control').waitFor({state:'visible'});}
  async function close(page){await page.keyboard.press('Escape');await page.locator('#mission-control').waitFor({state:'hidden'});}
  async function geometry(page){
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no page horizontal scrolling');
    assert.ok(await page.evaluate(()=>[...document.querySelectorAll('#mission-control .mc-attention-item')].every(node=>{const rect=node.getBoundingClientRect();return rect.left>=-1&&rect.right<=innerWidth+1&&node.scrollWidth<=node.clientWidth+1;})),'attention cards fit without cropping or horizontal scrolling');
    assert.deepEqual(await page.evaluate(()=>attentionCSP),[]);
  }
  const pages=new Map();
  for(const [role,user,expected] of [['member',member,5],['admin',adminUser,4]])for(const width of [1440,390,320]){
    const page=await pageFor(width);pages.set(role+'-'+width,page);await login(page,user);await count(page,expected);
    if(width<760)assert.match(await page.locator('#live-pill').innerText(),new RegExp('需处理 '+expected));
    await geometry(page);await page.screenshot({path:join(shots,`attention-${role}-strip-${width}.png`),animations:'disabled'});
    await open(page);assert.equal(await page.locator('#control-attention .mc-attention-item').count(),expected);
    assert.equal(await page.locator('[data-control-ack]').count(),role==='member'?4:3);
    assert.equal(await page.locator('[data-control-ack-all]').count(),1);
    assert.equal(await page.locator('[data-control-history]').textContent(),'查看全部失败 215 项');
    assert.doesNotMatch(await page.locator('#control-attention').innerText(),/历史失败|未记录失败时间|另一账号的最近失败/);
    assert.doesNotMatch(await page.locator('#control-attention').innerText(),new RegExp(pendingName),'member approvals belong only in the backend');
    assert.equal(await page.locator('#mission-control img').count(),0);await geometry(page);
    assert.equal(await page.locator('.mc-footer>.ui-info').count(),0,'no orphan footer help');
    assert.ok(await page.locator('.mc-footer-command').evaluate(group=>{
      const label=group.querySelector('span').getBoundingClientRect(),help=group.querySelector('summary').getBoundingClientRect();
      return Math.abs((label.top+label.bottom-help.top-help.bottom)/2)<=1&&help.left>=label.right&&group.scrollWidth<=group.clientWidth+1;
    }),'command label and help remain centered on the same row');
    await page.screenshot({path:join(shots,`attention-${role}-panel-${width}.png`),animations:'disabled'});
    await close(page);
    // Partial pages and a failed refresh cannot erase the cached reminders.
    await page.evaluate(userId=>document.dispatchEvent(new CustomEvent('gpuq-data-activities',{detail:{userId,items:[],complete:false}})),user.id);await count(page,expected);
    for(const room of ['work','resources','datasets','community','me']){
      await page.evaluate(room=>location.hash='#'+room,room);await page.waitForFunction(room=>document.body.dataset.room===room,room);await count(page,expected);
      if(width<760&&room!=='work')assert.match(await page.locator('#live-pill').innerText(),new RegExp('需处理 '+expected));
      await open(page);assert.equal(await page.locator('#control-attention .mc-attention-item').count(),expected);assert.equal(await page.locator('#control-attention-title').innerText(),'需要处理 · '+expected);await close(page);
    }
    await page.evaluate(()=>location.hash='#resources');await page.waitForFunction(()=>document.body.dataset.room==='resources');await open(page);

  }
  const desktop=pages.get('member-1440'),recent=jobs.get(member.id).recent;
  await desktop.locator(`[data-control-ack="job:${recent[0].id}"]`).click();await count(desktop,4);
  await desktop.locator(`[data-control-attention="job:${recent[1].id}"]`).click();await desktop.locator('#job-diagnostic-view h3').first().waitFor();await count(desktop,3);
  await desktop.locator('#close-job-log').click();await desktop.locator('.job-log-dialog').waitFor({state:'hidden'});await open(desktop);
  await desktop.locator('[data-control-history]').click();await desktop.locator('#page-work').waitFor({state:'visible'});
  assert.equal(await desktop.locator('.wb-ended').getAttribute('open'),'');assert.equal(await desktop.locator('[data-job-history-filter]').inputValue(),'FAILED');
  assert.equal(await desktop.locator('.wb-ended [data-workbench-job]').count(),215);assert.equal(await desktop.locator(`.wb-ended [data-workbench-job="${jobs.get(member.id).success.id}"]`).count(),0);
  assert.equal(await desktop.locator('.wb-ended .job-top .st-err').count(),215);assert.equal(await desktop.locator('.wb-ended [data-workbench-job]').filter({hasText:'历史失败'}).count(),211);
  await desktop.locator(`.wb-ended [data-job-logs="${recent[2].id}"]`).click();await desktop.locator('#job-main-log').filter({hasText:'Local task log'}).waitFor();await count(desktop,2);
  await desktop.locator('#close-job-log').click();await desktop.locator('.job-log-dialog').waitFor({state:'hidden'});await open(desktop);
  const dataId=dataRows.get('最近失败的数据任务');await desktop.locator(`[data-control-attention="data:${dataId}"]`).click();
  await desktop.locator(`[data-transfer-id="${dataId}"] .transfer-details[open]`).waitFor();await count(desktop,1);
  await desktop.reload();await desktop.locator('#login-dialog').waitFor({state:'hidden'});await desktop.locator('#transfer-list [data-transfer-id]').first().waitFor();await count(desktop,1);await open(desktop);
  assert.equal(await desktop.locator('[data-control-ack]').count(),0);assert.equal(await desktop.locator('[data-control-ack-all]').count(),0);
  assert.match(await desktop.locator('#control-attention').innerText(),/训练状态待确认/);
  const phone=pages.get('member-390');await phone.locator('[data-control-history]').click();await phone.locator(`.wb-ended [data-workbench-job="${recent[0].id}"] .wb-job-name`).click();
  await phone.locator('#job-overview-view').waitFor({state:'visible'});await count(phone,4);
  await phone.locator('#close-job-log').click();await phone.locator('.job-log-dialog').waitFor({state:'hidden'});await open(phone);await phone.locator('[data-control-ack-all]').click();await count(phone,1);
  assert.equal(await phone.locator('#control-attention .mc-attention-item').count(),1);assert.equal(await phone.locator('[data-control-history]').textContent(),'查看全部失败 215 项');
  const adminPage=pages.get('admin-320');await adminPage.locator('[data-control-ack-all]').click();await count(adminPage,1);assert.doesNotMatch(await adminPage.locator('#control-attention').innerText(),new RegExp(pendingName));assert.match(await adminPage.locator('#control-attention').innerText(),/训练状态待确认/);
  await close(adminPage);await adminPage.evaluate(()=>location.hash='#admin/tasks');await adminPage.locator('.admin-task-approvals').waitFor({state:'visible'});assert.match(await adminPage.locator('.admin-task-approvals').innerText(),/待审批 1 人/);await adminPage.locator('.admin-task-approvals a').click();await adminPage.locator('#admin-content #page-users').waitFor({state:'visible'});await adminPage.locator('#user-list [data-user]').filter({hasText:pendingName}).waitFor();assert.match(await adminPage.locator('#user-list').innerText(),new RegExp(pendingName),'acknowledgment cannot clear pending approvals');
  // Same browser/account switch retains only the original account's read markers.
  await close(desktop);await accountMenu(desktop);await desktop.locator('#switch-account').click();await desktop.locator('#login-dialog').waitFor({state:'visible'});
  await desktop.locator('#login-form [name=username]').fill(peer.username);await desktop.locator('#login-form [name=password]').fill(password);await desktop.locator('#login-form [type=submit]').click();await desktop.locator('#login-dialog').waitFor({state:'hidden'});await count(desktop,1);
  const accountKeys=await desktop.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('stargate:attention-read:')));
  assert.ok(accountKeys.includes(attentionStorageKey(member.id)));assert.ok(!accountKeys.includes(attentionStorageKey(peer.id)));
  for(const storageError of ['read','write']){
    const page=await pageFor(390,{storageError});await login(page,member);await count(page,5);await open(page);await page.locator('[data-control-ack-all]').click();await count(page,5);
    assert.equal(await page.locator('#control-attention .mc-attention-item').count(),5);await geometry(page);await close(page);await refreshVisible(page);await count(page,5);await page.context().close();
  }
  const zero=await pageFor(390);await login(zero,onlyFailures);await count(zero,1);await open(zero);await zero.locator('[data-control-ack-all]').click();await count(zero,0);
  assert.equal(await zero.locator('#live-pill').isVisible(),false);assert.equal(await zero.locator('[data-control-history]').textContent(),'查看全部失败 1 项');
  await close(zero);await zero.reload();await zero.locator('#login-dialog').waitFor({state:'hidden'});await count(zero,0);
  const many=await pageFor(390);await login(many,manyUnknown);await count(many,101);assert.match(await many.locator('#live-pill').innerText(),/需处理 99\+/);await open(many);
  assert.equal(await many.locator('#control-attention-title').innerText(),'需要处理 · 99+');assert.equal(await many.locator('.mc-meter-alert .mc-meter-value').innerText(),'99+');assert.equal(await many.locator('#control-attention .mc-attention-item').count(),101);await geometry(many);
  // Unknown/partial data may still hold resources; neither time nor viewing a
  // detail (or acknowledging actual failures) proves its lifecycle complete.
  const uncertain=await pageFor(390);await login(uncertain,uncertainData);await count(uncertain,4);await open(uncertain);
  assert.equal(await uncertain.locator('[data-control-ack]').count(),1);
  await uncertain.locator('[data-control-ack-all]').click();await count(uncertain,3);
  for(const row of uncertainRows.filter(row=>row.state!=='FAILED')){
    assert.equal(await uncertain.locator('[data-control-ack]').count(),0);
    assert.equal(await uncertain.locator('[data-control-ack-all]').count(),0);
    await uncertain.locator(`[data-control-attention="data:${row.id}"]`).click();
    await uncertain.locator(`[data-transfer-id="${row.id}"] .transfer-details[open]`).waitFor();await count(uncertain,3);await open(uncertain);
  }
  const uncertainReads=await uncertain.evaluate(key=>JSON.parse(localStorage.getItem(key)),attentionStorageKey(uncertainData.id));
  assert.equal(uncertainReads.length,1);assert.equal(JSON.parse(uncertainReads[0])[1],uncertainRows.find(row=>row.state==='FAILED').id);
  await close(uncertain);await uncertain.reload();await uncertain.locator('#login-dialog').waitFor({state:'hidden'});await uncertain.locator('#transfer-list [data-transfer-id]').first().waitFor();await count(uncertain,3);await open(uncertain);await geometry(uncertain);
  assert.equal(await uncertain.locator('[data-control-ack]').count(),0);
  await writeFile(join(shots,'attention-unconfirmed-data-checks.json'),JSON.stringify({status:'passed',states:['UNKNOWN','PARTIAL','UNCONFIRMED'],remainingAfterAcknowledgeAndDetailsAndReload:3,readMarkers:1,onlyFailedAcknowledged:true},null,2));
  const readOperations=['state','workshop.mine','projects.list','transfers.list','datasets.list','datasets.catalog','datasets.overview','datasets.capacity','datasets.upload.routes','transfers.capabilities','community.info','community.posts.list','community.chat.list','jobs.logs','jobs.diagnostics','jobs.watch','logout'];
  const unexpectedOperations=[...new Set(requests.filter(operation=>!readOperations.includes(operation)))];
  assert.deepEqual(unexpectedOperations,[],'acknowledgment and history navigation never write server state');
  assert.deepEqual(service.store.jobs,unchangedJobs);assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
  await writeFile(join(shots,'attention-checks.json'),JSON.stringify({status:'passed',historicalFailures:211,failedHistoryPerAccount:215,memberAttention:5,adminAttention:4,widths:[1440,390,320],checks:['shared desktop/pill/panel rules','24h/missing time exclusion','acknowledge one/all','opening diagnostics/logs/details marks read','data timestamps and detail navigation','UNKNOWN stays; approvals move to backend','history link and actual FAILED filter','reload and account isolation','storage read/write fallback','zero capsule hidden','99+ display','unchanged server task records','no page/card overflow, script/CSP errors or external requests'],shots},null,2));
  console.log('ATTENTION PASS: 211 historical failures excluded; account-scoped reads/one/all/views/history/storage fallback/99+/zero; member/admin 1440/390/320.');
}finally{
  await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}else service?.close();
  await rm(directory,{recursive:true,force:true});
}
