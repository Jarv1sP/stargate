// Real Portal/CSP, actual canonical backend projection, and browser-local API
// replies. No production login, node operation or native metadata mutation.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {visibleGPUQStatus} from '../gpuq-status.mjs';
import {MACHINES as EXAMPLE_MACHINES} from '../dist/machines.js';
const MACHINES=process.env.UI_INVENTORY?JSON.parse(await readFile(process.env.UI_INVENTORY,'utf8')):EXAMPLE_MACHINES;
import {guardedRoute} from './browser-route-guard.mjs';
import {inspectOperationalGeometry} from './operational-geometry.mjs';
import {selectResource,closeResource} from './resources-workflows.mjs';
import {refreshVisible} from './starbase-workflows.mjs';

const dir=await mkdtemp(join(tmpdir(),'native-owner-browser-')),output=join(process.env.UI_SCREENSHOTS||'/tmp/stargate-native-owner','native-owner');
const password='Local-Native-Owner-Fixture-Only-2026!',nativeId='J0123456789ab',nativeOwner='native-fixture-owner';
const name='原生训练 <img src=x onerror=alert(1)>',description='第二阶段\n<script>只作文字</script>';
const errors=[],outside=[],violations=[],calls=[],checks=[];let server,service,browser,currentPage,currentRole;
const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+reserve.address().port;await new Promise(r=>reserve.close(r));
const settle=page=>page.evaluate(async()=>{await document.fonts.ready;for(const animation of document.getAnimations())if(Number.isFinite(animation.effect?.getComputedTiming().endTime))animation.finish();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
try{
  await mkdir(output,{recursive:true});const bootstrap=join(dir,'bootstrap');await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  ({server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,origin,secure:false,bridge:async()=>{throw Error('This readonly browser fixture must not execute');}}));
  for(const timer of ['executionTimer','maintenanceTimer','transferTimer'])clearInterval(service[timer]);
  await new Promise(r=>server.listen(new URL(origin).port,'127.0.0.1',r));
  const signed=await service.login('admin',password),member=(await service.invoke(signed.token,'users.create',{username:'native-owner-reader',password})).result;
  await service.invoke(signed.token,'policy.full',{userId:member.id,policyVersion:0});
  const principals={admin:signed.principal,member:{userId:member.id,username:member.username,role:'member'}};
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  for(const role of ['admin','member']){
    const context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'}),page=await context.newPage(),actor=principals[role];let logged=false,mode='fresh';
    currentPage=page;currentRole=role;console.log(JSON.stringify({scene:role,step:'login'}));
    function state(){
      const data=structuredClone(service.state(actor));data.machines=structuredClone(MACHINES);if(process.env.UI_INVENTORY)for(const u of data.users)u.limits=Object.fromEntries(MACHINES.map(m=>[m.id,m.cards]));data.executionEnabled=true;data.jobs=[];data.execution={priorityCapabilities:Object.fromEntries(MACHINES.map(m=>[m.id,true]))};
      const checkedAt=new Date().toISOString(),hosts=MACHINES.map(m=>({id:m.id,reachable:true,gpus:Array.from({length:m.cards},(_,index)=>({index,model:m.model,memoryTotalMiB:24576,memoryUsedMiB:index===0?1200:0,utilization:10,processesAvailable:true,processes:index===0&&m.id===MACHINES[0].id?[{pid:42,memoryUsedMiB:1200,scheduling:{jobId:nativeId,priority:2}}]:[]})),gpuq:{connected:true,jobs:m.id===MACHINES[0].id?[{id:nativeId,name:'legacy-wrapper',owner:nativeOwner,state:'RUNNING',priority:2,gpu_count:1,assigned_gpu_indices:[0],display_metadata:{name,description,submitter:{name:'不可推断的平台账号',username:'admin'}}}]:[]}}));
      if(mode==='duplicate')hosts[0].gpuq.jobs.push(structuredClone(hosts[0].gpuq.jobs[0]));
      if(mode==='disconnected')hosts[0].gpuq.connected=false;
      if(mode==='stale'){for(const h of hosts){h.reachable=false;h.gpus=[];h.gpuq={connected:false,jobs:[]};}}
      data.gpuq=visibleGPUQStatus({checkedAt,stale:mode==='stale',hosts},actor,actor.role==='admin'?{}:data.users.find(u=>u.id===actor.userId).limits,{jobs:[],users:data.users});return data;
    }
    page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(()=>{globalThis.nativeOwnerViolations=[];document.addEventListener('securitypolicyviolation',e=>nativeOwnerViolations.push(e.violatedDirective));});
    await context.route('**/*',guardedRoute(async route=>{
      const url=new URL(route.request().url());if(url.origin!==origin&&!['data:','blob:'].includes(url.protocol)){outside.push(url.href);return route.abort();}
      const reply=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
      if(url.pathname==='/machines.js')return route.fulfill({contentType:'text/javascript',body:'export const MACHINES='+JSON.stringify(MACHINES)+';'});
      if(url.pathname==='/api/login'){logged=true;return reply({principal:actor,state:state()});}
      if(url.pathname==='/api/call'){
        const {operation,args}=route.request().postDataJSON();calls.push({role,operation,args});if(!logged)return reply({error:'请登录'},401);
        if(operation==='state')return reply({principal:actor,state:state()});
        if(operation==='workshop.mine'){assert.deepEqual(args,{});return reply({principal:actor,result:{installed:[]}});}
        let result;if(operation==='datasets.overview'){assert.deepEqual(args,{});result={protocol:0};}else if(['projects.list','datasets.list','datasets.catalog','notifications.list','transfers.list'].includes(operation))result={environmentModes:['shared','isolated','oci'],projects:[],datasets:[],items:[],machines:MACHINES.map(m=>({machine:m.id,state:'ok'}))};
        else if(operation==='maintenance.status')result=state().operationalMaintenance;
        else if(['datasets.capacity','transfers.capabilities','datasets.storage.status'].includes(operation))result={available:false,enabled:false};
        else throw Error('Unexpected readonly native-owner fixture operation '+operation);
        return reply({principal:actor,state:state(),result});
      }
      return route.continue();
    }));
    await page.goto(origin+'/#resources');await page.locator('#login-form [name=username]').fill(actor.username);await page.locator('#login-form [name=password]').fill(password);const loginReply=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/login');await page.locator('#login-form [type=submit]').click();const loginResponse=await loginReply;assert.equal(loginResponse.status(),200);await writeFile(join(output,role+'-login-fixture.json'),JSON.stringify(await loginResponse.json(),null,2));await page.locator('#login-dialog').waitFor({state:'hidden'});await settle(page);
    for(const room of role==='admin'?['resources','admin/tasks']:['resources']){
      await page.evaluate(value=>location.hash='#'+value,room);const root=page.locator(room==='resources'?'#page-resources':'#admin-content');await root.waitFor({state:'visible'});
      for(const width of [1440,1024,390,320]){
        await page.setViewportSize({width,height:width<760?844:900});await settle(page);
        const title=await root.locator('.resource-chassis-bays .resource-tower-bar').first().getAttribute('title');
        const detail=room==='resources'&&width<760?await selectResource(page,MACHINES[0].id):root;
        const queue=detail.locator('.node-queue');await queue.waitFor();await queue.evaluate(e=>e.open=true);
        if(role==='admin'){
          assert.ok(title.includes(name+' · 原生用户 '+nativeOwner),title);assert.ok((await queue.innerText()).includes('原生用户 '+nativeOwner));assert.ok((await queue.innerText()).includes(description));
          assert.equal(await queue.locator('button,[data-task-label-editor],[data-job-cancel],[data-job-logs],[data-job-priority]').count(),0);
          assert.ok(!(await queue.innerText()).includes('不可推断的平台账号'));
        }else{
          const text=(await root.innerText())+'\n'+(await detail.innerText());assert.ok(text.includes('GPUQ 任务（未关联平台）'));for(const hidden of [name,'原生训练',nativeOwner,'不可推断的平台账号','原生用户'])assert.ok(!text.includes(hidden),hidden);assert.ok(!title.includes(nativeOwner));
        }
        assert.equal(await queue.locator('img,script').count(),0);
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        const geometry=await inspectOperationalGeometry(page,{roots:[room==='resources'?(width<760?'#resource-sheet':'#page-resources'):'#page-admin'],controls:'button,input,select,summary',largeTargets:'.resource-portrait .resource-select,.resource-tower',nativeHelpRows:['.resource-hardware-caption>span']});
        assert.deepEqual(geometry.failures,[],JSON.stringify({role,room,width,geometry}));checks.push({role,room,width,geometry});
        if(width>=760)await root.locator('.resource-detail').scrollIntoViewIfNeeded();
        console.log(JSON.stringify({scene:role,room,width,status:'PASS'}));
        await page.screenshot({path:join(output,role+'-'+room.replace('/','-')+'-'+width+'.png'),animations:'disabled'});
        if(room==='resources')await closeResource(page);
      }
    }
    if(role==='admin'){
      await page.setViewportSize({width:1440,height:900});
      for(const changed of ['duplicate','disconnected','stale']){
        mode=changed;const response=page.waitForResponse(r=>r.request().postDataJSON()?.operation==='state');await refreshVisible(page);assert.equal((await response).status(),200);await settle(page);
        const text=await page.locator('#admin-content').innerText();assert.ok(!text.includes('原生训练'),changed);assert.ok(!text.includes('第二阶段'),changed);assert.equal(await page.locator('.node-queue [data-task-label-editor]').count(),0);
      }
    }else{
      await page.evaluate(()=>location.hash='#admin/tasks');await page.locator('#admin-denied').waitFor({state:'visible'});assert.equal(await page.locator('#admin-content [data-task-label-editor]').count(),0);
    }
    violations.push(...await page.evaluate(()=>nativeOwnerViolations));await context.close();
  }
  assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);assert.deepEqual(violations,[]);assert.equal(calls.filter(c=>/^(jobs\.|tasks\.display\.|terminal\.)/.test(c.operation)).length,0);
  await writeFile(join(output,'checks.json'),JSON.stringify({status:'PASS',checks,calls,errors,outside,violations},null,2));console.log(JSON.stringify({status:'PASS',suite:'native-owner',views:checks.length,readonly:true,ownerSource:'canonical catalog, never display_metadata.submitter',output}));
}catch(error){
  await writeFile(join(output,'failure.json'),JSON.stringify({role:currentRole,error:error.stack,errors,outside,calls,checks},null,2));
  if(currentPage&&!currentPage.isClosed()){await writeFile(join(output,'failure.html'),await currentPage.content());await currentPage.screenshot({path:join(output,'failure.png')});}
  throw error;
}finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await rm(dir,{recursive:true,force:true});}
