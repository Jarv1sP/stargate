// Real browser/Portal/SQLite; synthetic node transport, no production access.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/machines.js';
import {openSubmit,closeSubmit} from './starbase-workflows.mjs';
import {guardedRoute} from './browser-route-guard.mjs';
import {trainingPlan} from './training-storage-fixture.mjs';

const dir=await mkdtemp(join(tmpdir(),'gpuq-live-ui-')),password='Workspace-Fixture-2026!',machine=MACHINES[0].id;
const project={project:'live-project',environmentMode:'oci',state:'AVAILABLE',workspace:{protocol:1,persistent:true}};
const calls=[],errors=[];let browser,server,service,member;
const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const origin='http://127.0.0.1:'+port;
try{
  const bootstrap=join(dir,'bootstrap'),statusPath=join(dir,'status');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(statusPath,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,
    gpus:Array.from({length:m.cards},(_,index)=>({index,memoryTotalMiB:32768,processes:[],processesAvailable:true})),
    gpuq:{connected:true,health:'ok',observeOnly:false,schedulableIndices:[0,1],jobs:[],capabilities:[]}}))}));
  const bridge=async(node,operation,args)=>{
    calls.push({node,operation,args:structuredClone(args)});
    if(operation==='projects.list')return {projects:[project]};
    if(['projects.status','projects.workspace'].includes(operation))return project;
    if(operation==='storage.training.plan'){
      assert.equal(args.workspace,true);assert.equal(args.projectFootprint,null);
      return trainingPlan(node,args);
    }
    if(operation==='sync')return {state:'RUNNING',nodeJobId:'J123456789abc',assignedIndices:[0]};
    if(operation==='terminal.open'){
      assert.equal(args.mode,'reconnect');assert.equal(args.userId,member.id);
      assert.equal(args.id,service.store.jobs.find(job=>job.interactive).id);
      return {id:args.id,clientId:args.clientId,writerToken:randomUUID(),leaseExpiresAt:Date.now()/1000+30,mode:'reconnect'};
    }
    if(operation==='terminal.exchange')return {data:Buffer.from('GPU workspace shell\r\n').toString('base64'),offset:21,exited:false};
    if(operation==='terminal.detach')return {id:args.id,detached:true};
    if(operation==='files.list')return {entries:[]};
    throw Error('Unexpected live-workspace operation '+operation);
  };
  ({server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,statusPath,bridge,secure:false,origin}));
  service.ociProjectAdmission=async()=>{};
  await new Promise(r=>server.listen(port,'127.0.0.1',r));const admin=await service.login('admin',password);
  member=(await service.invoke(admin.token,'users.create',{username:'live-member',password})).result;
  await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:2,limits:{[machine]:2}});
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',guardedRoute(async route=>{assert.equal(new URL(route.request().url()).origin,origin);return route.fallback();}));
  await page.goto(origin);await page.locator('#login-form [name=username]').fill('live-member');await page.locator('#login-form [name=password]').fill(password);await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});
  await page.locator('[name=workspace-machine]').selectOption(machine);await page.waitForFunction(()=>!document.querySelector('[name=workspace-machine]').disabled);
  await page.locator('[name=workspace-project]').selectOption('live-project');await page.waitForFunction(()=>!document.querySelector('[name=workspace-machine]').disabled);
  assert.equal(await page.locator('#project-publish').isVisible(),false);
  await openSubmit(page);
  assert.equal(await page.locator('#project-release-field').isVisible(),false);
  assert.equal(await page.locator('[name=training-target]').inputValue(),'current');
  assert.equal(await page.locator('#train-form [type=submit]').isEnabled(),true);
  await page.locator('[name=interactive]').check();
  assert.equal(await page.locator('[name=command]').isVisible(),false);
  assert.match(await page.locator('#submit-command').textContent(),/--interactive/);
  assert.doesNotMatch(await page.locator('#submit-command').textContent(),/train\.py|--release/);
  for(const width of [1440,390,320]){
    await page.setViewportSize({width,height:1000});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    if(process.env.UI_SCREENSHOTS){await mkdir(process.env.UI_SCREENSHOTS,{recursive:true});await page.screenshot({path:join(process.env.UI_SCREENSHOTS,'workspace-'+width+'.png'),fullPage:true});}
  }
  const submitted=page.waitForResponse(r=>r.url()===origin+'/api/call'&&r.request().postDataJSON()?.operation==='jobs.submit');
  await page.locator('#train-form [type=submit]').click();const response=await submitted;assert.equal(response.status(),200,await response.text());
  const job=(await response.json()).result;assert.equal(job.interactive,true);assert.equal(job.workspace,true);assert.equal(Object.hasOwn(job,'release'),false);
  assert.deepEqual(job.command,['/bin/bash','--noprofile','--norc','-i']);
  await closeSubmit(page);await page.locator(`[data-gpu-shell="${job.id}"]`).waitFor({state:'visible'});
  await page.locator(`[data-gpu-shell="${job.id}"]`).click();await page.locator('.terminal-dialog').waitFor({state:'visible'});
  await page.locator('#terminal-disconnect').click();
  assert.equal(calls.some(c=>['projects.publish','projects.verify','projects.copy.probe'].includes(c.operation)),false);
  assert.equal(calls.filter(c=>c.operation==='terminal.open').length,1);assert.deepEqual(errors,[]);
  console.log('Live workspace browser: no publication, scheduled GPU shell, owner-bound attach, 1440/390/320 passed');
}finally{
  if(browser)await browser.close();
  if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
  else if(service)service.close();
  await rm(dir,{recursive:true,force:true});
}
