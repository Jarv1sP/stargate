// Real Portal/CSP and disposable identities; no production or node operations.
import assert from 'node:assert/strict';
import net from 'node:net';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/machines.js';
import {guardedRoute} from './browser-route-guard.mjs';
import {layoutReadOperations,layoutReadReply} from './layout-read-fixtures.mjs';
import {layoutWidths,layoutHeights,layoutZooms} from './layout-geometry.mjs';
import {inspectOperationalGeometry,scanOperationalGeometry} from './operational-geometry.mjs';

const full=process.argv.includes('--full-scan'),output=join(process.env.UI_SCREENSHOTS||'/tmp/stargate-admin','admin-console');
const temporary=await mkdtemp(join(tmpdir(),'admin-console-')),password='Local-Admin-Console-2026!';
const errors=[],outside=[],geometry=[],requests=[];let server,service,browser;
const widths=[...new Set([...layoutWidths,360,375,390,414,768,820,1024])].sort((a,b)=>a-b);
const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
const spec={roots:['#page-admin'],controls:'a[href],button,input,select,summary',
  centers:[{parent:'.admin-navigation>a',children:':scope>span',wrap:false}],
  textContainment:['.admin-navigation>a>span','#admin-content h2','#admin-denied h2'],
  repeatedPadding:['.admin-navigation>a'],repeatedGaps:['.admin-navigation'],
  bottomReserve:[{content:'#main-content',controls:'#mobile-control,#room-nav,#control-strip'}]};
const settle=page=>page.evaluate(async()=>{await document.fonts.ready;for(const animation of document.getAnimations())if(Number.isFinite(animation.effect?.getComputedTiming().endTime))animation.finish();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
async function capture(page,name,roomSpec=spec){
  for(const width of [1440,390,320]){
    await page.setViewportSize({width,height:width<760?844:900});await settle(page);
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
    const state=()=>{const data=structuredClone(service.state(actor||principals.member));data.machines=structuredClone(MACHINES);data.executionEnabled=true;data.jobs=[];
      const checkedAt=new Date().toISOString();data.gpuq={checkedAt,stale:false,hosts:MACHINES.map(row=>({id:row.id,checkedAt,reachable:true,
        gpus:Array.from({length:row.cards},(_,index)=>({index,model:row.model,memoryTotalMiB:32768,memoryUsedMiB:0,utilization:0,processesAvailable:true,processes:[]})),gpuq:{connected:true,jobs:[]}}))};return data;};
    await context.route('**/*',guardedRoute(async route=>{
      const url=new URL(route.request().url());
      if(url.origin!==origin&&!['data:','blob:'].includes(url.protocol)){outside.push(url.href);await route.abort();return;}
      const reply=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
      // Exercise the frame's zero/one registry in isolation; the real member module
      // has separate acceptance with its actual controls and administration API.
      if(url.pathname==='/admin-maintenance-ui.js'){await route.fulfill({contentType:'text/javascript',body:'export function maintenanceAdminUI(){return ()=>{}}'});return;}
      if(url.pathname==='/admin-members-ui.js'){await route.fulfill({contentType:'text/javascript',body:`export const membersRoute=route=>String(route??'').replace(/^#/,'')==='users'?'#admin/members':route;export const membersAdminUI=()=>({active:()=>false,capture:()=>null,current:()=>false,owns:()=>false,dispose(){}});`});return;}
      if(url.pathname==='/admin-gpu-tasks.js'){await route.fulfill({contentType:'text/javascript',body:'export function registerGpuTasksAdmin(){}'});return;}
      if(url.pathname==='/machines.js'){await route.fulfill({contentType:'text/javascript',body:'export const MACHINES='+JSON.stringify(MACHINES)+';'});return;}
      // Isolate the frame's zero/one registrations; real storage mounting is
      // exercised by the dataset/admin storage acceptance entry.
      if(url.pathname==='/admin-data-storage.js'){await route.fulfill({contentType:'text/javascript',body:'export function registerDatasetStorageAdmin(){}'});return;}
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
  for(const role of ['anonymous','member']){
    const {page,context}=await open(role);
    try{
      assert.equal(await page.locator('#admin-denied').innerText(),'需要管理员权限\n返回工作台');
      assert.equal(await page.locator('#admin-frame').isVisible(),false);
      assert.equal(await page.locator('#account-menu [data-shell-action=admin]').isVisible(),false);
      await page.evaluate(async()=>{const {registerAdminSection}=await import('/admin-ui.js');globalThis.deniedMounts=0;registerAdminSection({id:'storage',order:20,mount(){deniedMounts++;}});location.hash='#admin/storage';});
      await page.waitForFunction(()=>location.hash==='#admin/storage');await settle(page);assert.equal(await page.evaluate(()=>deniedMounts),0);
      await capture(page,role+'-denied');
      if(full)for(const zoom of layoutZooms){const rows=await scanOperationalGeometry(page,spec,{widths,heights:layoutHeights,zoom});geometry.push(...rows.map(row=>({name:role+'-denied-dense',...row})));assert.deepEqual(rows.filter(row=>!row.pass),[],role+' denied geometry at '+zoom);}
      if(role==='member'){
        await page.locator('[data-shell-action=control]').first().click();await page.locator('#control-command').fill('管理后台');assert.equal(await page.locator('[data-command-id=admin]').count(),0);await page.locator('[data-control-close]').click();
        await page.setViewportSize({width:390,height:844});await page.locator('[data-nav=me]').click();assert.equal(await page.locator('#me-content [data-shell-action=admin]').count(),0);
      }
      assert.deepEqual(await page.evaluate(()=>adminCSP),[]);
    }finally{await context.close();}
  }
  const {page,context,setActor,holdLogin}=await open('admin');
  try{
    assert.equal(new URL(page.url()).hash,'#work','a zero-section admin deep link returns to the workbench');
    assert.equal(await page.locator('#page-admin').isVisible(),false);
    assert.equal(await page.locator('#admin-sections a').count(),0);
    assert.equal(await page.locator('#account-menu [data-shell-action=admin]').isVisible(),false,'zero sections hide the account entry');
    await page.locator('[data-shell-action=control]').first().click();await page.locator('#control-command').fill('管理后台');assert.equal(await page.locator('[data-command-id=admin]').count(),0,'zero sections hide the command');await page.locator('[data-control-close]').click();
    await page.setViewportSize({width:390,height:844});await page.locator('[data-nav=me]').click();assert.equal(await page.locator('#me-content [data-shell-action=admin]').count(),0,'zero sections hide the phone entry');
    await page.evaluate(async()=>{
      const {registerAdminSection}=await import('/admin-ui.js');globalThis.basicRemovers={};
      globalThis.basicAdminMount=title=>(el,ctx)=>{
        const section=document.createElement('section'),heading=document.createElement('h2');section.className='me-hero hero-frame';heading.className='disp';heading.textContent=title;section.append(heading);el.append(section);
        return ctx.store.call('datasets.storage.status',{machine:ctx.store.data.machines[0].id},{signal:ctx.signal}).then(result=>{if(ctx.signal.aborted)return;const fact=document.createElement('p');fact.textContent=result.available?'状态已确认':'状态暂时未知';section.append(fact);});
      };
      basicRemovers.storage=registerAdminSection({id:'storage',order:20,mount:basicAdminMount('数据与存储')});
    });
    await page.locator('#me-content [data-shell-action=admin]').click();
    assert.deepEqual(await page.locator('#admin-sections a').allTextContents(),['01数据与存储'],'one registered section renders exactly one navigation entry');
    assert.equal(await page.locator('#admin-content h2').innerText(),'数据与存储');assert.equal(new URL(page.url()).hash,'#admin/storage');
    assert.equal(await page.locator('#admin-empty').count(),0,'default placeholders do not exist');
    await capture(page,'admin-one-section');
    await page.evaluate(async()=>{
      const {registerAdminSection}=await import('/admin-ui.js');for(const [id,title,order] of [['tasks','显卡与任务',10],['members','成员与额度',30],['maintenance','维护',40]])basicRemovers[id]=registerAdminSection({id,order,mount:basicAdminMount(title)});
    });
    assert.deepEqual(await page.locator('#admin-sections a').allTextContents(),['01显卡与任务','02数据与存储','03成员与额度','04维护']);
    for(const [id,title] of [['tasks','显卡与任务'],['storage','数据与存储'],['members','成员与额度'],['maintenance','维护']]){
      await page.locator('[data-admin-section='+id+']').click();assert.equal(await page.locator('#admin-content h2').innerText(),title);
      assert.equal(await page.locator('#admin-sections [aria-current=page]').getAttribute('data-admin-section'),id);
    }
    await page.locator('[data-admin-section=tasks]').focus();await page.keyboard.press('Enter');await page.locator('#page-title').click();await page.mouse.move(0,0);await capture(page,'admin-registered-sections');
    if(full)for(const zoom of layoutZooms){const rows=await scanOperationalGeometry(page,spec,{widths,heights:layoutHeights,zoom});geometry.push(...rows.map(row=>({name:'admin-four-sections-dense',...row})));assert.deepEqual(rows.filter(row=>!row.pass),[],'four registered sections geometry at '+zoom);}
    await page.setViewportSize({width:1440,height:900});await page.locator('[data-nav=work]').click();await page.locator('#account-menu-toggle').click();await settle(page);await page.screenshot({path:join(output,'admin-account-entry-1440.png'),animations:'disabled'});await page.locator('#account-menu [data-shell-action=admin]').click();await page.locator('#page-admin').waitFor({state:'visible'});assert.equal(await page.locator('#account-menu').getAttribute('open'),null);
    await page.locator('[data-shell-action=control]').first().click();await page.locator('#control-command').fill('管理后台');await page.locator('[data-command-id=admin]').click();assert.equal(await page.locator('#mission-control').isVisible(),false);assert.equal(new URL(page.url()).hash,'#admin/tasks');
    await page.setViewportSize({width:390,height:844});await page.locator('[data-nav=me]').click();await settle(page);await page.screenshot({path:join(output,'admin-phone-entry-390.png'),animations:'disabled'});await page.locator('#me-content [data-shell-action=admin]').click();assert.equal(await page.locator('[data-nav=me]').getAttribute('aria-current'),'page');
    await page.evaluate(async()=>{
      const {registerAdminSection}=await import('/admin-ui.js');for(const id of ['storage','members','maintenance'])basicRemovers[id]();globalThis.adminEvents=[];globalThis.adminContexts=[];globalThis.staleResolvers=[];
      globalThis.removeStorage=registerAdminSection({id:'storage',order:20,mount(el,ctx){
        adminContexts.push(ctx);adminEvents.push('mount:'+ctx.principal.userId);globalThis.lastAdminContext=ctx;
        const heading=document.createElement('h2');heading.textContent='已挂载的数据与存储';el.append(heading);
        ctx.signal.addEventListener('abort',()=>adminEvents.push('abort'),{once:true});
        ctx.subscribe(()=>adminEvents.push('render'));
        ctx.store.call('datasets.storage.status',{machine:ctx.store.data.machines[0].id},{signal:ctx.signal}).catch(()=>{});
        new Promise(resolve=>staleResolvers.push(resolve)).then(()=>{el.textContent='旧账号晚回包';ctx.toast('旧账号提示');});
      },unmount(){adminEvents.push('unmount:'+lastAdminContext.signal.aborted);}});
    });
    assert.equal(await page.evaluate(()=>adminContexts.length),0,'registering a non-selected section must not mount');
    await page.locator('[data-admin-section=storage]').click();await page.getByRole('heading',{name:'已挂载的数据与存储'}).waitFor();
    assert.deepEqual(await page.evaluate(()=>({role:lastAdminContext.principal.role,store:typeof lastAdminContext.store.call,toast:typeof lastAdminContext.toast,aborted:lastAdminContext.signal.aborted})),{role:'admin',store:'function',toast:'function',aborted:false});
    await page.locator('#refresh-state').click();await page.waitForFunction(()=>adminEvents.filter(row=>row==='render').length>1);assert.equal(await page.evaluate(()=>adminContexts.length),1,'state updates preserve the section host');
    await page.locator('[data-admin-section=tasks]').click();assert.deepEqual(await page.evaluate(()=>adminEvents.slice(-2)),['abort','unmount:true']);
    await page.evaluate(()=>staleResolvers.shift()());await settle(page);assert.doesNotMatch(await page.locator('#page-admin').innerText(),/旧账号晚回包/);assert.doesNotMatch(await page.locator('#toast').innerText(),/旧账号提示/);
    await page.locator('[data-admin-section=storage]').click();setActor(principals.member);await page.locator('#refresh-state').click();await page.locator('#admin-denied').waitFor();assert.equal(await page.evaluate(()=>lastAdminContext.signal.aborted),true,'revocation aborts the privileged mount');
    const before=await page.evaluate(()=>adminContexts.length);await page.evaluate(()=>location.hash='#admin/storage');await settle(page);assert.equal(await page.evaluate(()=>adminContexts.length),before,'a downgraded actor cannot remount');
    await page.locator('#account-menu-toggle').click();await page.locator('#switch-account').click();await page.locator('#login-dialog').waitFor();
    setActor(principals.admin);const releaseLogin=holdLogin();await page.locator('#login-form [name=username]').fill(principals.admin.username);await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();
    await page.waitForFunction(()=>document.querySelector('#login-form [type=submit]').disabled);assert.equal(await page.evaluate(()=>adminContexts.length),before,'an unconfirmed login must not mount');
    releaseLogin();await page.locator('#login-dialog').waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>adminContexts.length),before,'confirming admin outside the backend must not mount');
    await page.locator('#account-menu-toggle').click();await page.locator('#account-menu [data-shell-action=admin]').click();await page.locator('[data-admin-section=storage]').click();await page.getByRole('heading',{name:'已挂载的数据与存储'}).waitFor();
    assert.equal(await page.evaluate(()=>adminContexts.length),before+1);assert.equal(await page.evaluate(()=>adminContexts.at(-1).signal===adminContexts[0].signal),false);
    setActor(principals.second);await page.locator('#refresh-state').click();await page.waitForFunction(()=>lastAdminContext.principal.username==='admin-layout-second');
    assert.equal(await page.evaluate(()=>adminContexts.at(-2).signal.aborted),true,'a different administrator gets a fresh host and signal');
    await page.evaluate(()=>{for(const resolve of staleResolvers.splice(0,-1))resolve();});await settle(page);
    assert.doesNotMatch(await page.locator('#admin-content').innerText(),/旧账号晚回包/);assert.doesNotMatch(await page.locator('#toast').innerText(),/旧账号提示/);
    await page.evaluate(()=>removeStorage());assert.equal(await page.locator('#admin-content h2').innerText(),'显卡与任务');assert.equal(await page.evaluate(()=>lastAdminContext.signal.aborted),true);assert.equal(new URL(page.url()).hash,'#admin/tasks');
    await page.evaluate(()=>basicRemovers.tasks());assert.equal(new URL(page.url()).hash,'#work');assert.equal(await page.locator('#account-menu [data-shell-action=admin]').isVisible(),false,'removing the last mount also removes the entry');
    await page.evaluate(async()=>{const {registerAdminSection}=await import('/admin-ui.js');globalThis.failedMounts=0;globalThis.removeTasks=registerAdminSection({id:'tasks',title:'<img src=x onerror=alert(1)>',order:10,mount(){failedMounts++;throw Error('Private backend detail');}});});
    await page.locator('#account-menu-toggle').click();await page.locator('#account-menu [data-shell-action=admin]').click();assert.equal(await page.locator('#admin-content').innerText(),'暂时无法显示这个区块。\n\n重新打开');assert.equal(await page.locator('#admin-sections img').count(),0);assert.match(await page.locator('#admin-sections').innerText(),/<img src=x/);
    await page.locator('#admin-content button').click();assert.equal(await page.evaluate(()=>failedMounts),2,'failed mount retries only through the explicit recovery action');
    await page.evaluate(()=>removeTasks());assert.equal(new URL(page.url()).hash,'#work');
    await page.evaluate(async()=>{const {registerAdminSection}=await import('/admin-ui.js');registerAdminSection({id:'storage',order:20,mount:basicAdminMount('数据与存储')});});
    await page.locator('#account-menu-toggle').click();await page.locator('#account-menu [data-shell-action=admin]').click();assert.deepEqual(await page.locator('#admin-sections a').allTextContents(),['01数据与存储']);
    await capture(page,'admin-real-mount-after-unmount');
    if(full)for(const zoom of layoutZooms){const rows=await scanOperationalGeometry(page,spec,{widths,heights:layoutHeights,zoom});geometry.push(...rows.map(row=>({name:'admin-navigation-dense',...row})));assert.deepEqual(rows.filter(row=>!row.pass),[],'admin adaptive geometry at '+zoom);}
    assert.deepEqual(await page.evaluate(()=>adminCSP),[]);
  }catch(error){await writeFile(join(output,'failure-dom.html'),await page.content());await page.screenshot({path:join(output,'failure.png'),animations:'disabled'});await writeFile(join(output,'failure-context.json'),JSON.stringify({message:error.message,requests,events:await page.evaluate(()=>globalThis.adminEvents||[])},null,2));throw error;
  }finally{await context.close();}
  assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);assert.ok(requests.some(row=>row.operation==='datasets.storage.status'));assert.ok(requests.filter(row=>row.operation==='datasets.storage.status').every(row=>row.role==='admin'));
  await writeFile(join(output,'checks.json'),JSON.stringify({full,geometry,errors,outside,requests},null,2)+'\n');
  console.log(JSON.stringify({status:'PASS',features:['registered-only 0/1 entries','no default placeholders','privileged mount','store/toast/signal','abort before unmount','late reply detached','logout and downgrade','unconfirmed login','account/command/phone entries','ordered deep links','XSS text','CSP'],measurements:geometry.length,output}));
}finally{
  await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}if(service&&!service.closing)service.close();await rm(temporary,{recursive:true,force:true});
}
