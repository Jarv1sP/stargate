// Real browser/HTTP/SQLite admission; node/copy/GPU are isolated fixtures.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/machines.js';
import {usage} from '../execution.mjs';
import {openSubmit,closeSubmit} from './starbase-workflows.mjs';
import {guardedRoute} from './browser-route-guard.mjs';

const dir=await mkdtemp(join(tmpdir(),'gpuq-auto-browser-')),password='Auto-Browser-Fixture-Only-2026!';
const source=MACHINES[0].id,target=MACHINES[1].id;
const projects=[{project:'vision',environmentMode:'oci',state:'AVAILABLE',workspace:{protocol:1,persistent:true}},
  {project:'legacy',environmentMode:'shared',state:'AVAILABLE',workspace:{protocol:1,persistent:true}}];
const calls=[],requests=[],errors=[],outside=[];let server,service,browser,member;
const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const origin='http://127.0.0.1:'+port;
try{
  const bootstrap=join(dir,'bootstrap'),statusPath=join(dir,'status');await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(statusPath,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,
    gpus:Array.from({length:m.cards},(_,index)=>({index,memoryTotalMiB:32768,processes:[],processesAvailable:true})),
    gpuq:{connected:true,health:'ok',observeOnly:false,schedulableIndices:m.id===target?[0,1]:[],jobs:[],capabilities:[]}}))}));
  const bridge=async(machine,operation,args)=>{
    calls.push({machine,operation,args:structuredClone(args)});
    if(operation==='projects.list')return {projects};
    if(operation==='data.roots')return {directories:[{path:'/data/hdd',readOnly:true}],personal:{path:'/data/mine',readOnly:false}};
    if(['projects.status','projects.workspace'].includes(operation)){
      assert.equal(args.userId,member.id);return projects.find(p=>p.project===args.project);
    }
    throw Error('Unexpected fixture operation '+operation);
  };
  ({server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,statusPath,bridge,secure:false,origin}));
  clearInterval(service.executionTimer);service.reconcile=async()=>{};service.ociProjectAdmission=async()=>{};
  service.prepareProject=async()=>{assert.fail('AUTO must not copy a workspace');};
  await new Promise(r=>server.listen(port,'127.0.0.1',r));const admin=await service.login('admin',password);
  member=(await service.invoke(admin.token,'users.create',{username:'auto-member',password})).result;
  await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:2,limits:{[source]:2,[target]:2}});
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const page=await browser.newPage({viewport:{width:1280,height:1000}});
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url()===origin+'/api/call')requests.push(r.postDataJSON());});
  await page.route('**/*',guardedRoute(async route=>{if(new URL(route.request().url()).origin!==origin){outside.push(route.request().url());return route.abort();}return route.fallback();}));
  await page.goto(origin);await page.locator('#login-form [name=username]').fill('auto-member');await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});
  await page.locator('[name=workspace-machine]').selectOption(source);await page.waitForFunction(()=>!document.querySelector('[name=workspace-machine]').disabled);
  await page.locator('[name=workspace-project]').selectOption('vision');await page.waitForFunction(()=>!document.querySelector('[name=workspace-machine]').disabled);
  await openSubmit(page);assert.equal(await page.locator('[name=training-target]').inputValue(),'current');
  await page.locator('[name=command]').fill('python train.py --data /data/hdd/sample --output /outputs');
  await page.locator('[name=training-target]').selectOption('auto');await page.locator('[name=training-candidates]').fill(source+','+target);
  assert.equal(await page.locator('[name=workspace-machine]').inputValue(),source);
  assert.equal(await page.locator('[name=workspace-project]').inputValue(),'vision');
  assert.match(await page.locator('#submit-command').textContent(),/--machine auto/);
  assert.doesNotMatch(await page.locator('#submit-command').textContent(),/--release|--prepare-data|--data-read/);
  const submitResponse=page.waitForResponse(r=>r.url()===origin+'/api/call'&&r.request().postDataJSON()?.operation==='jobs.submit');
  await page.locator('#train-form [type=submit]').click();const firstResponse=await submitResponse;assert.equal(firstResponse.status(),200,await firstResponse.text());
  await page.waitForFunction(target=>document.querySelector('#submission-receipt').textContent.includes(target)&&document.querySelector('#submission-receipt').textContent.includes('已提交'),target);
  const job=service.store.jobs[0];assert.equal(job.machine,target);assert.equal(job.state,'SUBMITTING');assert.equal(job.project,'vision');assert.equal(job.workspace,true);
  assert.deepEqual(job.spec.argv,['/bin/bash','-c','python train.py --data /data/hdd/sample --output /outputs']);
  assert.equal(Object.hasOwn(job,'release'),false);assert.equal(Object.hasOwn(job,'dataPreparationHold'),false);
  assert.equal(job.selectionSummary.reason,'local-workspace-and-resource-rank');assert.equal(job.selectionSummary.selectedMachine,target);
  assert.equal(await page.locator('[name=training-target] option[value=auto]').textContent(),'自动选择');
  const selection=page.locator('#submit-receipt-actions .training-selection');
  assert.match(await selection.textContent(),new RegExp('已分配到\\s*'+target));
  assert.equal(await selection.locator('summary[aria-label="自动选择原因"]').count(),1);
  assert.match(await selection.locator('summary').getAttribute('title'),/按已有工作区、显卡和排队情况选择/);
  if(process.env.UI_SCREENSHOTS){
    await mkdir(process.env.UI_SCREENSHOTS,{recursive:true});
    for(const width of [1440,390,320]){
      await page.setViewportSize({width,height:1000});
      await page.screenshot({path:join(process.env.UI_SCREENSHOTS,'auto-allocation-'+width+'.png'),fullPage:true});
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      await selection.locator('summary').click();
      await page.waitForFunction(()=>{
        const node=document.querySelector('#submit-receipt-actions .ui-info[open] .ui-info-content'),r=node?.getBoundingClientRect();
        return r&&r.width>0&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;
      });
      assert.match(await selection.locator('.ui-info-content').textContent(),/按已有工作区、显卡和排队情况选择/);
      await page.screenshot({path:join(process.env.UI_SCREENSHOTS,'auto-allocation-reason-'+width+'.png'),fullPage:true});
      await selection.locator('summary').click();
    }
  }
  assert.deepEqual(calls.filter(c=>c.operation==='projects.workspace'),[{machine:target,operation:'projects.workspace',args:{project:'vision',userId:member.id}}]);
  assert.equal(calls.some(c=>['storage.training.plan','projects.copy.probe','projects.publish','projects.verify','datasets.prepare'].includes(c.operation)),false);
  assert.equal(usage(service.store.jobs,member.id),1);
  assert.equal(requests.filter(r=>r.operation==='jobs.submit').length,1);
  // Deliberately lose the second POST reply. Explicit retry must keep the key
  // and chosen machine even after the live free pool changes completely.
  await page.locator('[data-receipt-new-draft]').click();await page.locator('[name=name]').fill('second');
  let drop=true;const lost=guardedRoute(async route=>{if(route.request().postDataJSON()?.operation==='jobs.submit'&&drop){drop=false;await route.fetch();return route.abort('connectionreset');}return route.fallback();});
  await page.route(origin+'/api/call',lost);await page.locator('#train-form [type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('#submission-receipt').textContent.includes('提交结果待确认'));
  const second=structuredClone(service.store.jobs[1]);assert.equal(second.machine,target);assert.equal(service.store.jobs.length,2);
  const refresh=service.refreshGPUQ;service.refreshGPUQ=async()=>{await refresh.call(service);for(const host of service.gpuq.hosts)host.gpuq.schedulableIndices=host.id===source?[0,1]:[];};
  await page.unroute(origin+'/api/call',lost);await page.locator('[data-receipt-retry]').click();
  await page.waitForFunction(()=>document.querySelector('#submission-receipt').textContent.includes('已提交'));
  assert.equal(service.store.jobs.length,2);assert.equal(service.store.jobs[1].id,second.id);assert.equal(service.store.jobs[1].machine,second.machine);
  assert.equal(requests.filter(r=>r.operation==='jobs.submit').at(-1).args.key,second.key);
  assert.equal(calls.filter(c=>['projects.workspace'].includes(c.operation)).length,2,'same-key recovery does not reopen or move the workspace');
  assert.equal(await page.locator('[name=workspace-machine]').inputValue(),source);
  assert.equal(calls.some(c=>c.operation==='terminal.open'||c.operation==='sync'),false);
  await closeSubmit(page);await page.locator('[name=workspace-project]').selectOption('legacy');await page.waitForFunction(()=>!document.querySelector('[name=workspace-machine]').disabled);
  await openSubmit(page);assert.equal(await page.locator('[name=training-target] option[value=auto]').evaluate(el=>el.disabled),true,JSON.stringify(await page.evaluate(()=>({context:document.querySelector('[name=workspace-project]').value,environment:document.querySelector('#project-environment').textContent,note:document.querySelector('#training-target-note').textContent}))));
  await page.locator('[name=training-target]').selectOption('current');assert.equal(await page.locator('[name=machine]').inputValue(),source);
  assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
  console.log(JSON.stringify({passed:true,automaticTarget:target,developmentContext:source,persistentSubmissions:2,duplicateSubmissions:0,realGpuJobs:0}));
}finally{await browser?.close();if(server)await new Promise(r=>server.close(r));if(service&&!service.closing)service.close();await rm(dir,{recursive:true,force:true});}
