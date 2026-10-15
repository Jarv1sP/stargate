import {refreshVisible} from './starbase-workflows.mjs';
// Real PortalService / SQLite / cookie HTTP / actual static asset routing.
// Native node observations are controlled; no real GPUs, SSH or training starts.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/machines.js';

const dir=await mkdtemp(join(tmpdir(),'gpuq-real-progress-ui-')),password='Real-Progress-Browser-2026!',errors=[],calls=[],readCalls=[],failedAssets=[];
let server,service,browser,state='RUNNING',memberId;
const progress={reported:true,stale:true,snapshot:{sequence:1,phase:'train',epochs_completed:3,epochs_total:10,steps_completed:null,steps_total:null,metrics:{loss:0.5},eta_seconds:60,severity:'error',message:'<img src=x onerror=window.XSS=1>',updated_at:1}};
try{
  const bootstrap=join(dir,'bootstrap');await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));const origin='http://127.0.0.1:'+port;
  ({server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,origin,secure:false,bridge:async(machine,operation,args)=>{
    if(operation==='datasets.list'){
      assert.ok(MACHINES.some(item=>item.id===machine));assert.deepEqual(args,{userId:'builtin-admin',hostAdmin:true});
      readCalls.push(operation);return {datasets:[]};
    }
    if(operation==='datasets.capacity'){
      assert.equal(machine,'gpu-1');assert.deepEqual(args,{userId:memberId,hostAdmin:false});
      readCalls.push(operation);return {available:true,filesystemBytes:4096,availableBytes:2048,reserveBytes:512,usableBytes:1536};
    }
    if(operation==='transfers.capabilities'){
      assert.equal(machine,'gpu-1');assert.deepEqual(args,{userId:memberId});
      readCalls.push(operation);return {protocol:'lan-transfer-v1',enabled:false,sourceReady:false,sources:[]};
    }
    if(operation==='projects.list'){
      assert.equal(machine,'gpu-1');assert.deepEqual(args,{userId:memberId});
      readCalls.push(operation);return {projects:[]};
    }
    calls.push(operation);assert.ok(['sync','watch'].includes(operation));return {nodeJobId:'Jbrowser',state,assignedIndices:[0],progress,latestAttempt:{id:'Abrowser',ordinal:1,state,exit_code:state==='FAILED'?1:null,failure_reason:state==='FAILED'?'native confirmed failure':null}};
  }}));
  clearInterval(service.executionTimer);await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  const admin=await service.login('admin',password),user=(await service.invoke(admin.token,'users.create',{username:'alice',password})).result;
  memberId=user.id;
  const policyVersion=service.state(admin.principal).users.find(item=>item.id===user.id).policyVersion;
  await service.invoke(admin.token,'policy.save',{userId:user.id,policyVersion,limits:{'gpu-1':1},total:1});
  const id=randomUUID();service.store.jobs.push({id,userId:user.id,username:'alice',name:'real-progress-job',machine:'gpu-1',cards:1,state:'RUNNING',spec:{id,argv:['python','train.py']}});service.save();await service.reconcile();
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});const page=await browser.newPage({viewport:{width:390,height:920}});page.on('pageerror',e=>errors.push(e.message));page.on('response',response=>{if(response.url().startsWith(origin)&&response.status()>=400&&!response.url().includes('/api/'))failedAssets.push(response.url());});
  const response=await page.request.post(origin+'/api/login',{headers:{Origin:origin},data:{username:'alice',password,client:'browser'}});assert.equal(response.ok(),true,'browser login HTTP '+response.status());
  await page.goto(origin+'/#jobs');await page.locator('[data-nav=jobs][aria-current=page]').waitFor();
  const row=page.locator('#my-job-table article[data-workbench-job]').filter({hasText:'real-progress-job'});await row.waitFor();await row.locator('summary[aria-label="进度状态"]').click();await row.locator('summary[aria-label="任务事实"]').click();assert.match(await row.textContent(),/上次轮次 3\/10/);assert.equal(await row.locator('.wb-progress-number').innerText(),'—');assert.match(await row.textContent(),/进度停滞/);assert.match(await row.textContent(),/RUNNING/);assert.equal(await row.locator('progress').count(),0);assert.equal(await row.locator('img,script').count(),0);assert.equal(await page.evaluate(()=>window.XSS),undefined);
  progress.stale=false;progress.snapshot.updated_at=Date.now()/1000;progress.snapshot.epochs_completed=10;await service.reconcile();await refreshVisible(page);await page.waitForFunction(()=>document.querySelector('#my-job-table progress')?.value===100);assert.match(await row.textContent(),/RUNNING/);
  const stored=service.store.jobs[0];stored.progressCheckedAt=new Date(Date.now()-300000).toISOString();service.save();
  const before=JSON.stringify(stored);await refreshVisible(page);
  await page.waitForFunction(()=>document.querySelector('#my-job-table').textContent.includes('进度快照已过期'));
  assert.equal(await row.locator('progress').count(),0);assert.match(await row.textContent(),/RUNNING/);
  assert.doesNotMatch(await row.textContent(),/训练上报超时/);assert.equal(JSON.stringify(stored),before);
  assert.equal(await page.locator('body img[src="x"]').count(),0);assert.deepEqual(errors,[]);
  const progressDetail=row.locator('summary[aria-label="进度状态"]');if(!await progressDetail.evaluate(el=>el.parentElement.open))await progressDetail.click();
  const screenshot=join(dir,'job-progress-390.png');
  await page.screenshot({path:screenshot,animations:'disabled'});
  console.log(JSON.stringify({status:'passed',checks:['real SQLite/cookie HTTP/assets','390px cached progress shows expired observation','no stale live percentage','original lifecycle and receipt unchanged','fresh native report stays fresh','no starts/cancel/retry'],screenshot}));
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
