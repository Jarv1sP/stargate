import {openMembers} from './admin-members-workflows.mjs';
// Visual and responsive acceptance with synthetic API data only.
// No real accounts, shell, SSH, jobs, credentials, or external requests.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {MACHINES} from '../dist/machines.js';
import {STARBASE_ASSETS} from '../frontend-assets.mjs';
import {openSubmit,closeSubmit} from './starbase-workflows.mjs';
import {selectResource,closeResource} from './resources-workflows.mjs';
import {guardedRoute} from './browser-route-guard.mjs';
const screenshots=process.env.UI_SCREENSHOTS||'/tmp/gpuq-ui-polish';
const baseline=process.env.UI_BASELINE==='1',errors=[],external=[],checks=[];
const machine=MACHINES[0].id,release='a'.repeat(64),checkedAt=new Date().toISOString();
const job={id:'11111111-1111-4111-8111-111111111111',machine,userId:'admin',username:'admin',name:'vision-baseline',project:'vision-lab',release,cards:2,state:'RUNNING',priority:'normal',schedulerPriority:2,schedulerState:'RUNNING',schedulerCheckedAt:checkedAt,queueReason:'训练中；普通任务不会自动让位。',assignedIndices:[0,1]};
const state={machines:MACHINES,executionEnabled:true,execution:{priorityCapabilities:{[machine]:true}},
  users:[{id:'admin',name:'实验室管理员',username:'admin',role:'admin',enabled:true,approvedAt:checkedAt,total:8,limits:Object.fromEntries(MACHINES.map(m=>[m.id,m.cards]))}],
  jobs:[job,{...job,id:'22222222-2222-4222-8222-222222222222',name:'ablation / queued experiment',state:'PENDING',priority:'idle',schedulerPriority:0,schedulerState:'PENDING',canSetPriority:true,assignedIndices:[],queueReason:'等待空闲 GPU；最低任务允许让位结束，保留已写入输出。'}],
  gpuq:{checkedAt,stale:false,hosts:MACHINES.map(m=>({id:m.id,reachable:true,checkedAt,
    gpus:Array.from({length:m.cards},(_,index)=>({index,model:m.model,uuid:'GPU-'+m.id+'-'+index,memoryTotalMiB:32768,memoryUsedMiB:index<2?12800:0,utilization:index<2?76:0,temperatureC:index<2?62:31,powerDrawW:index<2?224:18,powerLimitW:450,processesAvailable:true,processes:index===0?[{pid:24018,name:'python train.py',owner:'researcher',memoryUsedMiB:12800,scheduling:{priority:2,jobId:job.id}}]:[]})),
    gpuq:{connected:true,observeOnly:false,jobs:[{id:'node-queue-1',name:'ablation-study',owner:'researcher',state:'PENDING',priority:0,yield_policy:'now',state_reason:'等待空闲 GPU',assigned_gpu_indices:[]}]}}))}};
let server,browser;
try{
  await mkdir(screenshots,{recursive:true});
  server=createServer(async(req,res)=>{
    const file=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';
    if(!/^(index\.html|[a-z-]+\.(js|css))$/.test(file)&&!Object.hasOwn(STARBASE_ASSETS,file)){res.writeHead(404);res.end();return;}
    try{let content=await readFile(new URL('../dist/'+file,import.meta.url));if(file==='index.html')content=content.toString().replace('globalThis.GPUQ_LOCAL_API=false;','globalThis.GPUQ_LOCAL_API=true;globalThis.GPUQ_PRODUCTION=true;');res.writeHead(200,{'Content-Type':file.endsWith('.woff2')?'font/woff2':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});res.end(content);}catch{res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:1080}});
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',guardedRoute(async route=>{
    const url=new URL(route.request().url());
    if(url.origin!==origin){if(['data:','blob:'].includes(url.protocol)){await route.fallback();return;}external.push(url.href);await route.abort();return;}
    if(url.pathname!=='/api/call'){await route.fallback();return;}
    const {operation}=route.request().postDataJSON();let result=null;
    if(operation==='projects.list')result={projects:[{project:'vision-lab',state:'READY',environmentMode:'shared',latestReadyRelease:release,releases:[{release,state:'READY'}]}]};
    else if(operation==='projects.status')result={project:'vision-lab',state:'READY',environmentMode:'shared',latestReadyRelease:release,releases:[{release,state:'READY'}]};
    else if(operation==='datasets.list')result={datasets:[]};
    else if(operation==='datasets.overview')result={protocol:0};
    else if(operation==='datasets.catalog')result={machine,machines:MACHINES.map(item=>({machine:item.id,state:'ok'})),datasets:[{dataset:'vision-train',versions:[{version:release,state:'READY',files:18420,bytes:12*1024**3,canPrepare:false,locations:[{machine,state:'READY'}]}]},{dataset:'vision-validation',versions:[{version:'b'.repeat(64),state:'PREPARING',files:2048,bytes:2*1024**3,canPrepare:true,sourceMachine:MACHINES[1].id,locations:[{machine,state:'PREPARING'},{machine:MACHINES[1].id,state:'READY'}]}]}]};
    else if(operation==='datasets.capacity')result={machine,available:true,filesystemBytes:4*1024**4,availableBytes:2*1024**4,reserveBytes:20*1024**3,usableBytes:2*1024**4-20*1024**3,guarded:true};
    else assert.equal(operation,'state','Visual review cannot mutate data');
    await route.fulfill({contentType:'application/json',body:JSON.stringify({result,state,principal:{userId:'admin',username:'admin',role:'admin'}})});
  }));
  await page.goto(origin);await page.locator('#execution-workspace').waitFor();
  await page.locator('[name=workspace-machine]').selectOption(machine);await page.locator('[name=workspace-project] option[value=vision-lab]').waitFor({state:'attached'});
  await page.locator('[name=workspace-project]').selectOption('vision-lab');
  await openSubmit(page);
  await page.locator('[name=command]').fill('python train.py --output /outputs/result.json');
  await closeSubmit(page);
  const capture=async name=>{await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:join(screenshots,name+'.png'),animations:'disabled'});};
  assert.match(await page.title(),/^STARGATE/);
  if(baseline)assert.equal(await page.locator('.brand-wordmark').innerText(),'STARGATE');
  else assert.equal(await page.getByRole('link',{name:'STARGATE 工作台',exact:true}).count(),1);
  const currentNav=async expected=>{
    assert.equal(await page.locator('[data-nav][aria-current=page]').count(),1);
    assert.equal(await page.locator('[data-nav].active').count(),1);
    assert.equal(await page.locator('[data-nav][aria-current=page]').getAttribute('data-nav'),expected);
    assert.equal(await page.locator('[data-nav].active').getAttribute('data-nav'),expected);
  };
  const textContrast=async()=>{
    const failures=await page.evaluate(()=>{
      const rgba=value=>{const values=value.match(/[\d.]+/g)?.map(Number);return values?.length>=3?[...values.slice(0,3),values[3]??1]:[255,255,255,1];};
      const over=(front,back)=>front.slice(0,3).map((c,i)=>c*front[3]+back[i]*(1-front[3]));
      const luminance=rgb=>rgb.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
      const background=el=>{const ancestors=[];for(let n=el;n;n=n.parentElement)ancestors.unshift(n);return ancestors.reduce((bg,n)=>over(rgba(getComputedStyle(n).backgroundColor),bg),[255,255,255]);};
      const selectors='[data-nav],.muted,.self-summary small,.self-summary strong span,.resource-explainer,.resource-spec,.resource-policy,.gpu-table th,.gpu-table small,.terminal-scope,.page-heading p,.page-heading .eyebrow,.topbar #current-account,.section-kicker,.help-links>span,.datasets-capacity,.dataset-readiness,.dataset-locations,.datasets-add>summary span,.datasets-flow,.dataset-source-tabs button,.user-row,.user-meta,.username,.permission-spec,.permission-bottom,.team-jobs,.v3-id,.v3-owner,.v3-pip-id,.v3-store>span,.v3-server-text>span,.v3-meta,.v3-idline,.v3-lab,.v3-train .v3-lock';
      return [...document.querySelectorAll(selectors)].filter(el=>el.getClientRects().length&&el.textContent.trim()&&!el.closest('[disabled],[aria-hidden="true"],[inert]')).flatMap(el=>{
        const bg=background(el),fg=over(rgba(getComputedStyle(el).color),bg),a=luminance(fg),b=luminance(bg),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
        return ratio>=4.5?[]:[{element:el.className||el.tagName,text:el.textContent.trim().slice(0,45),ratio:Number(ratio.toFixed(2))}];
      });
    });
    assert.deepEqual(failures,[],'Helper text must retain AA contrast against its computed solid surface');
  };
  await currentNav('work');
  await textContrast();
  await capture('workspace-desktop');
  const personalSummary=await page.locator('#self-summary').innerText();
  assert.match(personalSummary,/不限个人额度\n已占用 4 张/);
  assert.doesNotMatch(personalSummary,/4 \/ 8|占用额度 \/ 上限/);
  assert.equal(await page.locator('[name=priority] option').count(),2,'Main submit offers the same normal/idle choices for both roles');
  assert.deepEqual(await page.locator('[name=priority] option').evaluateAll(rows=>rows.map(row=>row.value)),['normal','idle']);
  await page.evaluate(()=>location.hash='#admin/tasks');await page.locator('[data-admin-submit]').waitFor();await page.locator('[data-admin-submit]').click();
  await page.locator('#work-submit[open]').waitFor({state:'visible'});
  assert.equal(await page.locator('[name=priority] option').count(),3,'The original administrator priority choices remain available in the backend');
  assert.deepEqual(await page.locator('[name=priority] option').evaluateAll(rows=>rows.map(row=>row.value)),['normal','idle','high']);
  await closeSubmit(page);await page.locator('[data-nav=work]').click();
  const queueCard=page.locator('[data-workbench-job="22222222-2222-4222-8222-222222222222"]');
  const queueInfo=queueCard.locator('.ui-info>summary');await queueInfo.click();
  await queueCard.locator('.ui-info[open] .ui-info-content').waitFor({state:'visible'});
  assert.match(await queueCard.locator('.ui-info[open] .ui-info-content').innerText(),/等待空闲 GPU/);
  assert.match(await page.locator('#my-job-table').innerText(),/等待空闲 GPU/);await queueInfo.click();
  await page.locator('[data-nav=resources]').click();
  await currentNav('resources');
  if(baseline)assert.equal(await page.locator('[data-gpu-index]').count(),MACHINES.reduce((n,m)=>n+m.cards,0));
  else{
    assert.equal(await page.locator('.resource-tower').count(),MACHINES.reduce((n,m)=>n+m.cards,0));
    for(const server of MACHINES){await selectResource(page,server.id,{metrics:true});assert.equal(await page.locator('[data-gpu-index]').count(),server.cards);}
    await selectResource(page,machine,{metrics:true});
  }
  const first=page.locator('[data-resource-detail="'+machine+':0"]');await first.locator(':scope > summary').click();
  assert.equal(await page.locator('#machine-grid .node-queue').count(),0,'Unlinked raw native queue records stay in the management view');
  for(const text of ['76%','12.5','62 °C','24018'])assert.ok((await page.locator('#machine-grid').innerText()).includes(text),text);
  for(const text of ['python train.py','researcher','等待空闲 GPU'])assert.ok(!(await page.locator('#machine-grid').innerText()).includes(text),'Main process columns hide private fields and raw native queue: '+text);
  await page.evaluate(()=>location.hash='#admin/tasks');await page.locator('#admin-content .resource-full-metrics').waitFor();
  await page.locator('#admin-content .resource-full-metrics>summary').click();await page.locator('#admin-content [data-resource-detail="'+machine+':0"]>summary').click();await page.locator('#admin-content .node-queue>summary').click();
  for(const text of ['76%','12.5','62 °C','24018','python train.py','researcher','等待空闲 GPU'])assert.ok((await page.locator('#admin-content').innerText()).includes(text),'Backend preserves existing metrics/private process and queue evidence: '+text);
  await capture('admin-resources-desktop');await page.locator('[data-nav=resources]').click();
  await capture('resources-desktop');
  await textContrast();
  for(const width of [1024,900,820,768,390,320]){
    await page.setViewportSize({width,height:960});
    const layout=await page.evaluate(()=>({width:innerWidth,document:document.documentElement.scrollWidth,nav:[...document.querySelectorAll('[data-nav]')].filter(el=>!el.hidden&&getComputedStyle(el).display!=='none').map(el=>({id:el.dataset.nav,visible:el.getBoundingClientRect().width>0&&el.getBoundingClientRect().height>0,height:el.getBoundingClientRect().height}))}));
    checks.push(layout);
    if(!baseline){
      assert(layout.document<=width+1,`page overflow at ${width}`);
      const visible=layout.nav.filter(nav=>nav.visible);
      assert.deepEqual(visible.map(nav=>nav.id),width<760?['work','resources','datasets','community','workshop','me']:['work','resources','datasets','community','workshop'],`room navigation at ${width}`);
      assert(visible.every(nav=>nav.height>=(width<760?44:36)),`navigation targets too small at ${width}`);
    }
    await textContrast();
    if([820,390,320].includes(width))await capture('resources-'+width);
    if(width===390){
      if(!baseline)await selectResource(page,machine,{metrics:true});
      await page.locator('.gpu-table-scroll').first().evaluate(el=>el.scrollLeft=el.scrollWidth);await capture('resources-390-processes');
      if(!baseline)await closeResource(page);
      await page.locator('[data-nav=work]').click();await currentNav('work');await capture('workspace-mobile');
      assert.equal(await page.locator('[name=command]').inputValue(),'python train.py --output /outputs/result.json');
      if(!baseline)assert.equal(await page.locator('#context-machine').evaluate(el=>parseFloat(getComputedStyle(el).fontSize)>=16),true);
      await page.locator('[data-nav=resources]').click();
    }
    if(width===320){
      await page.locator('[data-nav=work]').click();await currentNav('work');
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await textContrast();await capture('workspace-320');
      await page.locator('[data-nav=resources]').click();
    }
  }
  await page.setViewportSize({width:1440,height:1080});
  await page.locator('[data-nav=datasets]').click();await currentNav('datasets');
  await page.locator('#datasets-refresh').click();
  await page.locator('[data-v3-select=vision-validation]').click();
  const preparing=page.locator('#page-datasets .v3-server.cur .v3-g.fetch');
  await preparing.waitFor({state:'attached'});
  assert.equal(await page.locator('#page-datasets .v3-server.cur .v3-server-text>span').innerText(),'取回中');
  await preparing.waitFor();
  await textContrast();await capture('datasets-desktop');
  assert.equal(await preparing.evaluate(el=>el.getAnimations().length),0,'The first confirmed catalog is settled; motion requires a real state diff');
  assert.equal(await page.locator('#page-datasets .v3-server.cur .v3-server-text>span').textContent(),'取回中','Readiness remains clear without motion');
  await page.locator('[data-nav=work]').click();
  assert.equal(await preparing.evaluate(el=>el.getAnimations().length),0,'Hidden pages never add a decorative readiness pulse');
  await page.locator('[data-nav=datasets]').click();
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});
  assert.equal(await preparing.evaluate(el=>el.getAnimations().length),0,'Inactive tabs stay settled');
  await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
  await page.setViewportSize({width:390,height:960});await capture('datasets-mobile');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await textContrast();
  await page.setViewportSize({width:320,height:960});await capture('datasets-320');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await textContrast();
  await page.setViewportSize({width:820,height:960});
  if(!baseline){
    await page.keyboard.press('Tab');
    await page.locator('.skip-link').focus();await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'main-content');
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  if(!baseline)assert.equal(await page.locator('#refresh-state').evaluate(el=>getComputedStyle(el).transitionProperty),'none');
  assert.equal(await preparing.evaluate(el=>getComputedStyle(el,'::before').animationName),'none');
  await page.setViewportSize({width:1440,height:1080});await openMembers(page);await page.locator('#filter-all').click();await textContrast();await capture('users-carbon-compatibility');
  await page.setViewportSize({width:390,height:960});await page.waitForFunction(()=>document.querySelector('[data-nav=me]').getAttribute('aria-current')==='page');await currentNav('me');await textContrast();await capture('users-carbon-compatibility-390');
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  await writeFile(join(screenshots,'checks.json'),JSON.stringify({baseline,checks,errors,external},null,2));
  console.log(JSON.stringify({status:'passed',baseline,screenshots,widths:checks.map(x=>x.width),features:['all per-card metrics/processes','raw GPUQ queue','quota','workspace draft','priority choices','320–1440 layout','tablet navigation','keyboard skip link','single current navigation','STARGATE accessible brand','helper text AA contrast','confirmed readiness without decorative motion','reduced motion']}));
}finally{if(browser)for(const context of browser.contexts()){await Promise.all(context.pages().map(page=>page.unrouteAll({behavior:'wait'})));await context.unrouteAll({behavior:'wait'});}await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));}

// The existing CI entry point runs Portal/CSP, compute, inventory names, and R5 acceptance.
if(!baseline){
  await import('./starbase-ui-smoke.mjs');
  await import('./resources-ui-smoke.mjs');
  await import('./resource-ids-ui-smoke.mjs');
  await import('./r5-ui-smoke.mjs');
  await import('./polish-shell-ui-smoke.mjs');
  await import('./polish-operational-ui-smoke.mjs');
  await import('./admin-ui-smoke.mjs');
  await import('./admin-members-ui-smoke.mjs');
  await import('./admin-create-user-ui-smoke.mjs');
}

await import('./admin-gpu-tasks-ui-smoke.mjs');
if(!baseline)await import('./admin-maintenance-ui-smoke.mjs');
