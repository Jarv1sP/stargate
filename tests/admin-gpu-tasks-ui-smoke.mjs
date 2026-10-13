// Real Portal/CSP and disposable identities; no production or node operations.
import assert from 'node:assert/strict';
import net from 'node:net';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES as EXAMPLE_MACHINES} from '../dist/machines.js';
const MACHINES=process.env.UI_INVENTORY?JSON.parse(await readFile(process.env.UI_INVENTORY,'utf8')):EXAMPLE_MACHINES;
import {guardedRoute} from './browser-route-guard.mjs';
import {layoutReadOperations,layoutReadReply} from './layout-read-fixtures.mjs';
import {layoutWidths,layoutHeights,layoutZooms} from './layout-geometry.mjs';
import {inspectOperationalGeometry,scanOperationalGeometry} from './operational-geometry.mjs';
import {assertResourceNames} from './resource-name-assertions.mjs';

const full=process.argv.includes('--full-scan'),output=join(process.env.UI_SCREENSHOTS||'/tmp/stargate-admin','admin-tasks');
const temporary=await mkdtemp(join(tmpdir(),'admin-console-')),password='Local-Admin-Console-2026!';
const errors=[],outside=[],geometry=[],requests=[];let server,service,browser;
const widths=[...new Set([...layoutWidths,360,375,390,414,768,820,1024])].sort((a,b)=>a-b);
const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
const spec={roots:['#page-admin'],controls:'a[href],button,input,select,summary',
  largeTargets:'.resource-portrait .resource-select,.resource-tower',
  unbrokenValues:['.resource-portrait-utils b'],
  tokenGap:[{parent:'.resource-portrait-utils>span',left:'small',right:'b',minimum:6}],
  centers:[{parent:'.admin-navigation>a',children:':scope>span',wrap:false}],
  textContainment:['.admin-navigation>a>span','#admin-denied h2'],
  sameRowControls:[{parent:'.admin-task-filters',children:'select'}],
  nativeHelpRows:['.admin-gpu-tasks .resource-hardware-caption>span'],
  repeatedPadding:['.admin-navigation>a'],repeatedGaps:['.admin-navigation'],
  bottomReserve:[{content:'#main-content',controls:'#mobile-control,#room-nav,#control-strip'}]};
const settle=page=>page.evaluate(async()=>{await document.fonts.ready;for(const animation of document.getAnimations())if(Number.isFinite(animation.effect?.getComputedTiming().endTime))animation.finish();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
async function capture(page,name,roomSpec=spec){
  for(const width of [1440,1024,390,320]){
    await page.setViewportSize({width,height:width<760?844:900});await page.mouse.move(0,0);await settle(page);
    if(name==='admin-gpu-tasks')await assertResourceNames(page,'#admin-content');
    const result=await inspectOperationalGeometry(page,roomSpec);geometry.push({name,width,...result});
    assert.deepEqual(result.failures,[],name+' '+width+' geometry');
    await page.screenshot({path:join(output,name+'-'+width+'.png'),animations:'disabled'});
  }
}
try{
  await mkdir(output,{recursive:true});const bootstrap=join(temporary,'bootstrap');await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});
  ({server,service}=await createPortalServer({database:join(temporary,'db'),bootstrap,origin,secure:false,
    bridge:async()=>{throw Error('Admin fixture must not execute a node operation');}}));
  clearInterval(service.executionTimer);clearInterval(service.transferTimer);
  await new Promise(resolve=>server.listen(new URL(origin).port,'127.0.0.1',resolve));
  const account=await service.login('admin',password),member=(await service.invoke(account.token,'users.create',{username:'admin-layout-member',name:'后台权限检查成员',password})).result;
  await service.invoke(account.token,'policy.full',{userId:member.id,policyVersion:0});
  const second=(await service.invoke(account.token,'users.create',{username:'admin-layout-second',name:'第二位后台管理员',password,role:'admin'})).result;
  const principals={admin:account.principal,second:{userId:second.id,username:second.username,role:'admin'},member:{userId:member.id,username:member.username,role:'member'}};
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  async function open(role='admin',hash='#admin'){
    const context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'}),page=await context.newPage();
    let actor=role==='anonymous'?null:principals[role],logged=false,heldLogin=null;
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>{globalThis.adminCSP=[];document.addEventListener('securitypolicyviolation',event=>adminCSP.push(event.violatedDirective));});
    const state=()=>{const data=structuredClone(service.state(actor||principals.member));data.machines=structuredClone(MACHINES);if(process.env.UI_INVENTORY)for(const user of data.users)user.limits=Object.fromEntries(MACHINES.map(row=>[row.id,row.cards]));data.executionEnabled=true;data.execution={priorityCapabilities:Object.fromEntries(MACHINES.map(row=>[row.id,true]))};data.jobs=[{id:'11111111-1111-4111-8111-111111111111',userId:principals.admin.userId,machine:MACHINES[0].id,name:'本人排队',state:'PENDING',cards:1,priority:'normal',canSetPriority:true},{id:'22222222-2222-4222-8222-222222222222',userId:principals.member.userId,machine:MACHINES[1].id,name:'成员训练',state:'UNKNOWN',cards:1,priority:'normal'},{id:'33333333-3333-4333-8333-333333333333',userId:principals.member.userId,machine:MACHINES[0].id,name:'历史失败',state:'FAILED',cards:1,priority:'normal',finishedAt:new Date().toISOString()}];if(actor?.role!=='admin')data.jobs=data.jobs.filter(row=>row.userId===actor?.userId);
      const checkedAt=new Date().toISOString();data.gpuq={checkedAt,stale:false,hosts:MACHINES.map(row=>({id:row.id,checkedAt,reachable:true,
        gpus:Array.from({length:row.cards},(_,index)=>({index,model:row.model,memoryTotalMiB:32768,memoryUsedMiB:0,utilization:0,processesAvailable:true,processes:index===0?[{pid:123,name:'PRIVATE-PROGRAM',owner:'PRIVATE-SYSTEM-USER',memoryUsedMiB:1}]:[]})),gpuq:{connected:true,jobs:[]}}))};return data;};
    await context.route('**/*',guardedRoute(async route=>{
      const url=new URL(route.request().url());
      if(url.origin!==origin&&!['data:','blob:'].includes(url.protocol)){outside.push(url.href);await route.abort();return;}
      const reply=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
      if(url.pathname==='/machines.js'){await route.fulfill({contentType:'text/javascript',body:'export const MACHINES='+JSON.stringify(MACHINES)+';'});return;}
      if(url.pathname==='/api/login'){
        if(heldLogin)await heldLogin.promise;
        logged=true;await reply({principal:actor,state:state()});return;
      }
      if(url.pathname==='/api/call'){
        const {operation,args}=route.request().postDataJSON();requests.push({role:actor?.role||'anonymous',operation,args});
        if(operation==='logout'){logged=false;actor=null;await reply({result:null});return;}
        if(!logged){await reply({error:'请登录'},401);return;}
        let result;
        if(operation==='state'){await reply({state:state(),principal:actor});return;}
        if(operation==='workshop.mine'){assert.deepEqual(args,{});await reply({result:{installed:[]},principal:actor});return;}
        if(operation==='datasets.overview'){assert.deepEqual(args,{});result={protocol:0};}else if(['projects.list','datasets.list','datasets.catalog','notifications.list','transfers.list'].includes(operation))result={projects:[],datasets:[],items:[],machines:MACHINES.map(row=>({machine:row.id,state:'ok'}))};
        else if(operation==='maintenance.status')result=state().operationalMaintenance;
        else if(['datasets.capacity','transfers.capabilities'].includes(operation))result={available:false,enabled:false};
        else if(operation==='datasets.storage.status'){assert.equal(actor.role,'admin','management request requires a confirmed admin');result={available:false};}
        else if(layoutReadOperations.has(operation))result=layoutReadReply(operation,args,{principal:actor,state:state()});
        else throw Error('Unexpected admin fixture API: '+operation);
        await reply({result,state:state(),principal:actor});return;
      }
      await route.continue();
    }));
    await page.goto(origin+'/'+hash);await page.locator('#login-dialog').waitFor();
    if(role==='anonymous')await page.locator('#login-form [data-close=login-dialog]').first().click();
    else{
      await page.locator('#login-form [name=username]').fill(actor.username);await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});
    }
    await settle(page);
    return {context,page,setActor(value){actor=value;},holdLogin(){let resolve;const promise=new Promise(done=>resolve=done);heldLogin={promise,resolve};return()=>{resolve();heldLogin=null;};}};
  }

  for(const role of ['member','admin']){
    const {page,context}=await open(role,'#work');
    try{
      assert.equal(await page.locator('#host-maintenance').isVisible(),false);
      assert.equal(await page.locator('#my-job-table [data-job-priority]').count(),0);
      assert.equal(await page.locator('[name=priority] option[value=high]').count(),0);
      assert.equal(await page.locator('[name=queue-rank] option[value=P4]').count(),0);
      await page.locator('[data-nav=resources]').click();
      assert.equal(await page.locator('#page-resources [data-resource-root]').count(),0);
      assert.ok(!(await page.locator('#page-resources').innerText()).includes('PRIVATE-PROGRAM'));
      for(const width of [1440,1024,390,320]){
        await page.setViewportSize({width,height:width<760?844:900});await settle(page);
        await assertResourceNames(page,'#page-resources');
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        await page.screenshot({path:join(output,role+'-compute-'+width+'.png'),animations:'disabled'});
      }
      await page.setViewportSize({width:1440,height:900});await settle(page);
      await page.evaluate(()=>location.hash='#admin/tasks');
      if(role==='member'){
        await page.locator('#admin-denied').waitFor({state:'visible'});
        assert.equal(await page.locator('#all-jobs').count(),0);
        assert.equal(await page.locator('#admin-frame').isVisible(),false);
        await capture(page,'member-admin-denied');
      }else{
        await page.locator('#admin-content #all-jobs').waitFor({state:'visible'});
        assert.equal(await page.locator('#all-jobs').count(),1,'All-user training appears exactly once, in the task section');
        assert.equal(await page.locator('.admin-task-list #all-jobs').count(),1);
        await page.locator('[data-admin-section=members]').click();await page.locator('#admin-content #page-users').waitFor({state:'visible'});
        assert.equal(await page.locator('.team-jobs').count(),0,'The member section does not duplicate training management');
        assert.equal(await page.locator('#all-jobs').count(),0,'Task management unmounts outside its sole section');
        await page.locator('[data-admin-section=tasks]').click();await page.locator('#admin-content #all-jobs').waitFor({state:'visible'});
        assert.equal(await page.locator('#all-jobs').count(),1,'Returning to tasks mounts one table');
        assert.equal(await page.locator('#all-jobs tbody tr').count(),2);
        assert.ok((await page.locator('#admin-content .resource-process-table').textContent()).includes('PRIVATE-PROGRAM'));
        assert.equal(await page.locator('#admin-content [data-job-priority]').count(),1);
        await page.locator('[data-admin-owner]').selectOption(principals.member.userId);
        assert.equal(await page.locator('#all-jobs tbody tr').count(),1);
        assert.match(await page.locator('#all-jobs').innerText(),/成员训练/);
        await page.locator('[data-admin-state]').selectOption('ended');
        assert.match(await page.locator('#all-jobs').innerText(),/历史失败/);
        assert.equal(await page.locator('#all-jobs [data-job-priority]').count(),0);
        await page.locator('[data-admin-owner]').selectOption('');await page.locator('[data-admin-state]').selectOption('active');
        await capture(page,'admin-gpu-tasks');
        await page.setViewportSize({width:1440,height:900});await settle(page);
        // Exercise the measured fallback with synthetic IDs, never real assets.
        const fallback=await page.evaluate(async()=>{
          const {fitResourceNames}=await import('/resources-ui.js');
          const labels=[...document.querySelectorAll('#admin-content .resource-mini .resource-id-label')];
          const titles=labels.map(label=>label.title);
          labels.forEach((label,index)=>label.title='fixture-'+('long-id-'.repeat(12))+'model-'+index.toString().padStart(2,'0'));
          fitResourceNames(document.querySelector('.admin-gpu-fleet'));
          const result={below:document.querySelector('#admin-content .resource-fleet').classList.contains('resource-names-below'),names:labels.map(label=>({text:label.textContent,title:label.title}))};
          labels.forEach((label,index)=>label.title=titles[index]);fitResourceNames(document.querySelector('.admin-gpu-fleet'));
          return result;
        });
        assert.equal(fallback.below,true,'Names that cannot fit at 20px move the fleet below the chassis before shortening');
        for(const name of fallback.names){assert.ok(name.text.includes('…'));assert.ok(name.text.endsWith(name.title.split('-').slice(-2).join('-')));}
        assert.equal(new Set(fallback.names.map(name=>name.text)).size,fallback.names.length);
        await assertResourceNames(page,'#admin-content');
        const before=requests.filter(row=>row.operation.startsWith('terminal.')).length;
        assert.equal(await page.locator('[data-resource-root],#admin-content #host-maintenance').count(),0,'tasks no longer owns ROOT maintenance');
        await page.evaluate(()=>location.hash='#admin/maintenance');await page.locator('#admin-content #host-maintenance').waitFor();await page.locator('#host-maintenance summary').click();page.once('dialog',dialog=>dialog.dismiss());await page.locator('#terminal-root-open').click();
        assert.equal(requests.filter(row=>row.operation.startsWith('terminal.')).length,before,'root refusal sends no request');
        await page.evaluate(()=>location.hash='#admin/tasks');await page.locator('[data-admin-submit]').waitFor();
        await page.locator('[data-admin-submit]').click();await page.locator('#work-submit[open]').waitFor();
        assert.equal(await page.locator('[name=priority] option[value=high]').count(),1);assert.equal(await page.locator('[name=queue-rank] option[value=P4]').count(),1);
        await page.locator('[name=priority]').selectOption('high');await page.locator('#close-submit').click();await page.locator('#work-submit').waitFor({state:'hidden'});
        await page.locator('[data-nav=work]').click();await page.locator('#open-submit').click();
        assert.equal(await page.locator('#work-submit').isVisible(),false,'privileged draft is retained without silently changing it');assert.equal(await page.locator('[name=priority]').inputValue(),'high');assert.match(await page.locator('#toast').innerText(),/草稿已保留/);
        await page.evaluate(()=>location.hash='#admin/tasks');await page.locator('[data-admin-submit]').click();await page.locator('#work-submit[open]').waitFor();assert.equal(await page.locator('[name=priority]').inputValue(),'high');await page.locator('[name=priority]').selectOption('normal');await page.locator('#close-submit').click();await page.locator('#work-submit').waitFor({state:'hidden'});
        await page.locator('[data-nav=work]').click();await page.locator('#open-submit').click();await page.locator('#work-submit[open]').waitFor();assert.equal(await page.locator('[name=priority] option[value=high]').count(),0);assert.equal(await page.locator('[name=queue-rank] option[value=P4]').count(),0);
      }
      assert.deepEqual(await page.evaluate(()=>adminCSP),[]);
    }finally{await context.close();}
  }
  assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
  await writeFile(join(output,'geometry.json'),JSON.stringify(geometry,null,2));
  console.log(JSON.stringify({status:'passed',measurements:geometry.length,checks:['main member-equivalent controls','privileged mount','all owner/server/state filters','unknown and ended history','private process columns','root explicit refusal','high-priority draft retained','four widths','CSP']}));
}finally{await browser?.close();clearInterval(service?.executionTimer);clearInterval(service?.transferTimer);if(server)await new Promise(resolve=>server.close(resolve));await rm(temporary,{recursive:true,force:true});}

// Canonical native metadata stays readonly in this same registered task room.
await import("./native-task-owner-ui-smoke.mjs");
