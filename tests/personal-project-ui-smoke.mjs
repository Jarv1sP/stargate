// Real loopback Portal, cookies, SQLite and CSP; only the node is synthetic.
// Optional untracked IDs are used only for separate layout evidence.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/machines.js';
import {accountMenu,closeSubmit,openSubmit} from './starbase-workflows.mjs';
import {guardedRoute} from './browser-route-guard.mjs';
import {inspectOperationalGeometry} from './operational-geometry.mjs';

const directory=await mkdtemp(join(tmpdir(),'personal-project-browser-')),shots=process.env.UI_SCREENSHOTS||'/tmp/personal-project-ui';
const password='Personal-Project-Local-Only-2026!',machine=MACHINES[0].id,oldRelease='a'.repeat(64),release='b'.repeat(64);
const projects=new Map(),sessions=new Map(),calls=[],requests=[],errors=[],outside=[],csp=[],animations=[];
const identity=(node,user,project)=>JSON.stringify([node,user,project]),copy=value=>structuredClone(value);
let server,service,browser,createMode=null,createError='',unconfirmedClose=false,environmentModes=['shared','isolated','oci'];
const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
const origin='http://127.0.0.1:'+port;
const ready=(project,environmentMode='oci')=>({project,environmentMode,state:'READY',releases:[{release:oldRelease,state:'READY'}],latestReadyRelease:oldRelease});
try{
  await mkdir(shots,{recursive:true});const bootstrap=join(directory,'bootstrap'),statusPath=join(directory,'status');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});
  await writeFile(statusPath,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(node=>({id:node.id,reachable:true,checkedAt:new Date().toISOString(),gpus:Array.from({length:node.cards},(_,index)=>({index,model:node.model,memoryTotalMiB:32768,memoryUsedMiB:0,processesAvailable:true,processes:[]})),gpuq:{connected:true,health:'ok',observeOnly:false,schedulableIndices:[0],jobs:[]}}))}));
  const bridge=async(node,operation,args)=>{
    calls.push({node,operation,args:copy(args)});const key=identity(node,args.userId,args.project),project=projects.get(key);
    if(operation==='projects.list')return {...(environmentModes?{environmentModes}:{}),projects:[...projects].filter(([entry])=>{const [m,u]=JSON.parse(entry);return m===node&&u===args.userId;}).map(([,value])=>copy(value))};
    if(operation==='projects.create'){
      if(createError)throw Error(createError);
      const result={project:args.project,state:'DRAFT',releases:[],latestReadyRelease:null,...(createMode==='missing'?{}:{environmentMode:createMode||args.environmentMode})};projects.set(key,result);return copy(result);
    }
    if(operation==='projects.status'){assert.ok(project);assert.equal(args.key,undefined);return copy(project);}
    if(operation==='projects.publish'){
      assert.ok(project);assert.match(args.key,/^[a-f0-9-]{36}$/);
      if([...sessions.values()].some(value=>value.machine===node&&value.userId===args.userId&&value.project===args.project))throw Error('先结束开发终端（断开不算）');
      if(project.publication?.id!==args.key){project.publication={id:args.key,state:'PUBLISHING'};project.state='PUBLISHING';project.progress={phase:'scanning',completedEntries:0,totalEntries:null};delete project.error;delete project.errorDetails;}
      return copy(project);
    }
    if(operation==='terminal.open'){
      const id=args.mode==='reconnect'?args.id:randomUUID(),writerToken=randomUUID();if(args.mode==='reconnect')assert.ok(sessions.has(id));sessions.set(id,{...args,machine:node,writerToken});return {id,writerToken};
    }
    if(operation==='terminal.exchange'){assert.ok(sessions.has(args.id));assert.equal(sessions.get(args.id).writerToken,args.writerToken);return {offset:0,data:'',exited:false};}
    if(operation==='terminal.detach')return {detached:true};
    if(operation==='terminal.close'){assert.ok(sessions.has(args.id));assert.equal(sessions.get(args.id).userId,args.userId);if(unconfirmedClose)return {closed:false};sessions.delete(args.id);return {closed:true};}
    throw Error('Unexpected local operation: '+operation);
  };
  ({server,service}=await createPortalServer({database:join(directory,'portal.sqlite'),bootstrap,statusPath,bridge,secure:false,origin}));
  clearInterval(service.executionTimer);await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'personal-member',password})).result;
  const zero=(await service.invoke(admin.token,'users.create',{username:'no-access',password})).result;
  await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:8,limits:{[machine]:Math.min(8,MACHINES[0].cards)}});
  projects.set(identity(machine,'builtin-admin','admin-project'),ready('admin-project','shared'));
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const context=await browser.newContext({viewport:{width:1440,height:1080}}),page=await context.newPage();
  async function configure(target){
    target.on('pageerror',error=>errors.push(error.message));
    target.on('request',request=>{if(request.url()===origin+'/api/call')requests.push(request.postDataJSON());});
    await target.addInitScript(()=>{
      globalThis.publicationAnimations=[];globalThis.publicationCSP=[];
      document.addEventListener('securitypolicyviolation',event=>publicationCSP.push(event.violatedDirective));
      const animate=Element.prototype.animate;Element.prototype.animate=function(frames,options){if(this.id==='project-status')publicationAnimations.push(options.duration);return animate.call(this,frames,options);};
    });
    await target.route('**/*',guardedRoute(async route=>{const url=new URL(route.request().url());if(url.origin===origin||['data:','blob:'].includes(url.protocol)){await route.fallback();return;}outside.push(url.href);await route.abort();}));
  }
  await configure(page);
  const responseFor=(target,operation)=>target.waitForResponse(response=>response.url()===origin+'/api/call'&&response.request().postDataJSON()?.operation===operation);
  async function action(operation,fn,target=page){const waiting=responseFor(target,operation);await fn();const response=await waiting;assert.equal(response.status(),200,await response.text());return response;}
  async function idle(target=page){await target.waitForFunction(()=>!document.querySelector('[name=workspace-machine]')?.disabled);}
  async function login(target,username){await target.goto(origin);await target.locator('#login-form [name=username]').fill(username);await target.locator('#login-form [name=password]').fill(password);await target.locator('#login-form [type=submit]').click();await target.locator('#login-dialog').waitFor({state:'hidden'});await target.locator('[data-nav=work]').click();}
  async function chooseMachine(target=page){await action('projects.list',()=>target.locator('[name=workspace-machine]').selectOption(machine),target);await idle(target);}
  async function create(name,expected=200){
    await page.locator('#project-create').evaluate(element=>element.open=true);await page.locator('[name=new-project]').fill(name);assert.equal(await page.locator('[name=environment-choice]').count(),0);assert.equal(await page.locator('[name=environment-mode]').inputValue(),'oci');
    const response=await responseForAfter('projects.create',()=>page.locator('#project-create-form [type=submit]').click());assert.equal(response.status(),expected,await response.text());await idle();
  }
  async function responseForAfter(operation,fn){const waiting=responseFor(page,operation);await fn();return waiting;}
  const publishes=()=>calls.filter(row=>row.operation==='projects.publish'),statuses=()=>calls.filter(row=>row.operation==='projects.status');
  async function pendingRecords(){return page.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('stargate.project-publication.v1:')).map(key=>({name:key,value:JSON.parse(localStorage[key])})));}
  async function query(){await action('projects.status',()=>page.locator('#publication-query').click());await idle();}
  async function makeReady(project,version=release){project.state='READY';project.publication={id:project.publication.id,state:'READY',release:version};if(!project.releases.some(item=>item.release===version))project.releases.push({release:version,state:'READY'});project.latestReadyRelease=version;delete project.error;delete project.errorDetails;}

  await login(page,'personal-member');await chooseMachine();await page.locator('#project-create>summary').click();
  assert.equal(await page.locator('[name=environment-choice]').count(),0,'2026-10-08 handoff: new projects have no legacy environment picker');assert.equal(await page.locator('[name=environment-mode]').inputValue(),'oci');
  for(const name of ['Bad','1bad','bad.name','a'.repeat(49)]){await page.locator('[name=new-project]').evaluate((input,value)=>{input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));},name);assert.equal(await page.locator('#project-create-form [type=submit]').isDisabled(),true);assert.equal(await page.locator('#project-name-error').isVisible(),true);}
  assert.equal(calls.some(row=>row.operation==='projects.create'),false);
  await create('container-experiment');const project=projects.get(identity(machine,member.id,'container-experiment'));
  assert.equal(project.environmentMode,'oci');assert.equal(await page.locator('#project-environment').textContent(),'个人容器');
  assert.match(await page.locator('[name=workspace-project] option:checked').textContent(),/container-experiment · 个人容器/);
  await page.locator('#project-create').evaluate(element=>element.open=true);assert.equal(await page.locator('[name=environment-mode]').inputValue(),'oci');
  assert.equal(await page.locator('#environment-mode-note').textContent(),'可在容器内安装系统软件；开发终端没有 GPU；容器内 root 不是服务器 root。');
  createMode='shared';await create('mode-mismatch',503);assert.match(await page.locator('#project-create-error').textContent(),/未确认个人容器项目/);assert.equal(await page.locator('[name=workspace-project]').inputValue(),project.project);
  createMode='missing';await create('unconfirmed-container',503);assert.match(await page.locator('#project-create-error').textContent(),/未确认个人容器项目/);assert.equal(await page.locator('[name=workspace-project]').inputValue(),project.project,'missing mode cannot confirm new OCI or downgrade it');
  const legacyShared=ready('legacy-shared');delete legacyShared.environmentMode;projects.set(identity(machine,member.id,'legacy-shared'),legacyShared);projects.set(identity(machine,member.id,'legacy-isolated'),ready('legacy-isolated','isolated'));
  await action('projects.list',()=>page.locator('#projects-refresh').click());await idle();
  for(const [name,label] of [['legacy-isolated','隔离'],['legacy-shared','共享']]){
    await action('projects.status',()=>page.locator('[name=workspace-project]').selectOption(name));await idle();
    assert.equal(await page.locator('#project-environment').textContent(),label+' · 旧环境（兼容）');assert.match(await page.locator('[name=workspace-project] option:checked').textContent(),/旧环境（兼容）/);
    for(const button of ['project-publish','terminal-open','workspace-upload'])assert.equal(await page.locator('#'+button).isEnabled(),true,name+' keeps its existing workflow');
    assert.equal(await page.locator('[name=training-target]').inputValue(),'current');assert.equal(await page.locator('[name=release]').inputValue(),oldRelease);
  }
  // The Portal advertises only OCI. Both legacy-only and omitted node modes
  // become an empty capability list; neither confirms container availability.
  for(const modes of [['shared','isolated'],null]){
    environmentModes=modes;await action('projects.list',()=>page.locator('#projects-refresh').click());await idle();await page.locator('#project-create').evaluate(element=>element.open=true);await page.locator('[name=new-project]').fill('unsupported-container');
    assert.equal(await page.locator('#project-create-form [type=submit]').isDisabled(),true);assert.equal(await page.locator('#project-create-availability').isVisible(),true);assert.equal(await page.locator('#project-create-availability').textContent(),'个人容器状态未知');
    const before=calls.filter(row=>row.operation==='projects.create').length;await page.locator('#project-create-form').evaluate(form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await idle();assert.equal(calls.filter(row=>row.operation==='projects.create').length,before,'no capability means no node create, including a synthetic submit');assert.equal(await page.locator('#project-publish').isEnabled(),true,'old projects remain usable without OCI capability');
  }
  environmentModes=['shared','isolated','oci'];await action('projects.list',()=>page.locator('#projects-refresh').click());await idle();
  assert.equal(await page.locator('#project-materials-note').textContent(),'权重、tokenizer 放在项目里；发布不携带开发 HOME');
  createMode=null;createError='这台服务器未为此账号启用个人容器。';
  const rejected=await responseForAfter('projects.create',async()=>{await page.locator('#project-create').evaluate(element=>element.open=true);await page.locator('[name=new-project]').fill('denied-container');assert.equal(await page.locator('[name=environment-mode]').inputValue(),'oci');await page.locator('#project-create-form [type=submit]').click();});
  assert.ok(rejected.status()>=400);await idle();assert.equal(await page.locator('#project-create-error').textContent(),createError);createError='';
  await page.locator('#project-create').evaluate(element=>element.open=false);await action('projects.status',()=>page.locator('[name=workspace-project]').selectOption(project.project));await idle();
  Object.assign(project,ready(project.project));await action('projects.status',()=>page.locator('[name=workspace-project]').selectOption(project.project));await idle();

  await action('terminal.open',()=>page.locator('#terminal-open').click());await page.locator('.terminal-dialog').waitFor({state:'visible'});await page.locator('#terminal-disconnect').click();
  assert.equal(await page.locator('#project-publish').isDisabled(),true);assert.equal(await page.locator('#project-terminal-block').textContent(),'先结束开发终端（断开不算）');assert.equal(sessions.size,1);
  const beforeClose=calls.filter(row=>row.operation==='terminal.close').length;page.once('dialog',dialog=>dialog.dismiss());await page.locator('#project-terminal-stop').click();await idle();
  assert.equal(calls.filter(row=>row.operation==='terminal.close').length,beforeClose);assert.equal(sessions.size,1);
  unconfirmedClose=true;page.once('dialog',dialog=>dialog.accept());await page.locator('#project-terminal-stop').click();await page.waitForFunction(()=>document.querySelector('#project-status').textContent.includes('结束结果未确认'));await idle();
  assert.equal(await page.locator('#project-publish').isDisabled(),true);assert.equal(sessions.size,1);unconfirmedClose=false;
  page.once('dialog',dialog=>dialog.accept());await action('terminal.close',()=>page.locator('#project-terminal-stop').click());await idle();assert.equal(sessions.size,0);assert.equal(await page.locator('#project-publish').isEnabled(),true);

  await action('projects.publish',()=>page.locator('#project-publish').click());await idle();const firstKey=project.publication.id;
  assert.deepEqual(publishes().at(-1).args.key,firstKey);assert.equal((await pendingRecords())[0].value.key,firstKey);
  assert.match(await page.locator('#publication-progress').textContent(),/扫描.*复制.*校验.*写入版本/);assert.doesNotMatch(await page.locator('#project-status').textContent(),/已生成/);
  const beforePause=statuses().length;await page.locator('[data-nav=resources]').click();await page.waitForTimeout(2300);assert.equal(statuses().length,beforePause,'leaving the room pauses publication polling');
  await makeReady(project);await page.locator('[data-nav=work]').click();await responseFor(page,'projects.status');await idle();
  assert.equal(await page.locator('#project-status').textContent(),'训练版本已生成 · '+release.slice(0,8));assert.equal(await page.locator('[name=release]').inputValue(),release);assert.deepEqual(await pendingRecords(),[]);
  assert.deepEqual(await page.evaluate(()=>publicationAnimations),[480]);animations.push(...await page.evaluate(()=>publicationAnimations));

  await action('projects.publish',()=>page.locator('#project-publish').click());await idle();const unknownKey=project.publication.id;
  project.state='READY';project.publication={id:randomUUID(),state:'READY',release:oldRelease};
  await page.locator('[name=workspace-project]').selectOption(project.project);await idle();
  assert.equal(await page.locator('#project-status').textContent(),'发布结果未确认');assert.equal(await page.locator('[name=release]').inputValue(),release);assert.equal(await page.locator('#project-publish').isDisabled(),true);
  project.publication={id:unknownKey,state:'UNKNOWN'};await query();const beforeRetry=publishes().length;
  await action('projects.publish',()=>page.locator('#publication-retry').click());await idle();assert.equal(publishes().length,beforeRetry+1);assert.equal(publishes().at(-1).args.key,unknownKey);
  assert.equal(calls.at(-2).operation,'projects.status','same-key retry first queries the original status');assert.equal(await page.locator('#project-status').textContent(),'发布结果未确认');
  await makeReady(project);await query();assert.deepEqual(await pendingRecords(),[]);

  // The node accepted a write, but its HTTP response is lost to this browser.
  let drop=true;const loseResponse=guardedRoute(async route=>{if(route.request().postDataJSON()?.operation==='projects.publish'&&drop){drop=false;await route.fetch();await route.abort('connectionreset');return;}await route.fallback();});
  await page.route(origin+'/api/call',loseResponse);const lostCount=publishes().length;await page.locator('#project-publish').click();await page.waitForFunction(()=>document.querySelector('#project-status').textContent.includes('正在生成训练版本'));await idle();
  assert.equal(publishes().length,lostCount+1);const lostKey=project.publication.id;assert.equal(calls.at(-1).operation,'projects.status');assert.equal((await pendingRecords())[0].value.key,lostKey);await page.unroute(origin+'/api/call',loseResponse);
  const beforeRefresh=publishes().length;await page.reload();await page.waitForFunction(name=>document.querySelector('[name=workspace-project]')?.value===name,project.project);await idle();
  assert.equal(await page.locator('[name=workspace-machine]').inputValue(),machine);assert.equal(publishes().length,beforeRefresh);assert.equal((await pendingRecords())[0].value.key,lostKey);
  project.state='UNKNOWN';project.publication={id:lostKey,state:'UNKNOWN'};await page.locator('[name=workspace-project]').selectOption(project.project);await idle();
  await action('projects.publish',()=>page.locator('#publication-retry').click());await idle();assert.equal(publishes().at(-1).args.key,lostKey);await makeReady(project);await query();

  await action('projects.publish',()=>page.locator('#project-publish').click());await idle();project.state='FAILED';project.publication.state='FAILED';project.error='文件仍被其他用户写入';project.errorDetails={path:'code/<img onerror=bad>',kind:'file',mode:'0o664',links:2,remediation:'复制为自己的文件'};
  await page.locator('[name=workspace-project]').selectOption(project.project);await idle();assert.equal(await page.locator('#project-status').textContent(),'生成训练版本失败 · 文件仍被其他用户写入');
  for(const value of Object.values(project.errorDetails))assert.ok((await page.locator('#project-status-detail').textContent()).includes(String(value)));assert.equal(await page.locator('#project-status-detail img').count(),0);
  assert.equal(await page.locator('#project-publish').isEnabled(),true);

  // A different account must neither recover nor retry the previous intent.
  await action('projects.publish',()=>page.locator('#project-publish').click());await idle();const memberKey=project.publication.id;project.state='UNKNOWN';project.publication.state='UNKNOWN';
  await accountMenu(page);await page.locator('#switch-account').click();await page.locator('#login-dialog').waitFor({state:'visible'});await login(page,'admin');await idle();
  assert.equal(await page.locator('[name=workspace-machine]').inputValue(),'');assert.equal(await page.locator('#publication-actions').isVisible(),false);assert.ok((await pendingRecords()).some(item=>item.value.key===memberKey));
  const adminPublishCount=publishes().length;await chooseMachine();await action('projects.status',()=>page.locator('[name=workspace-project]').selectOption('admin-project'));await idle();assert.equal(publishes().length,adminPublishCount);
  assert.equal(await page.locator('#project-environment').textContent(),'共享 · 旧环境（兼容）');
  const zeroPage=await browser.newPage({viewport:{width:320,height:844}});await configure(zeroPage);await login(zeroPage,'no-access');
  assert.equal(await zeroPage.locator('[name=workspace-machine] option').count(),1);assert.equal(await zeroPage.locator('#project-create-form [type=submit]').isDisabled(),true);assert.equal(await zeroPage.locator('#project-publish').isDisabled(),true);
  const countBeforeForgery=calls.length;const forbidden=await zeroPage.evaluate(async machine=>{const response=await fetch('/api/call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'projects.create',args:{machine,project:'forged',environmentMode:'oci'}})});return response.status;},machine);
  assert.equal(forbidden,403);assert.equal(calls.length,countBeforeForgery,'zero authorization never reaches the node');await zeroPage.close();assert.ok(zero.id);

  for(const request of requests.filter(row=>row.operation==='projects.status'))assert.deepEqual(Object.keys(request.args).sort(),['machine','project']);
  for(const request of requests.filter(row=>row.operation==='projects.publish'))assert.deepEqual(Object.keys(request.args).sort(),['key','machine','project']);
  for(const request of requests.filter(row=>row.operation==='projects.create'))assert.deepEqual(Object.keys(request.args).sort(),['environmentMode','machine','project']);
  csp.push(...await page.evaluate(()=>publicationCSP));assert.deepEqual(csp,[]);assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);

  // Layout-only mocked states run after the real authorization acceptance.
  const layoutMachines=process.env.PERSONAL_PROJECT_ID_MANIFEST?JSON.parse(await readFile(process.env.PERSONAL_PROJECT_ID_MANIFEST,'utf8')):MACHINES.map(node=>({...node,id:node.id+'-node'}));
  for(const role of ['member','admin'])for(const width of [1440,390,320]){
    const layout=await browser.newPage({viewport:{width,height:width<760?844:1080},reducedMotion:width===320?'reduce':'no-preference'});await configure(layout);
    const logged=await layout.context().request.post(origin+'/api/login',{headers:{Origin:origin},data:{username:'admin',password,client:'browser'}});assert.equal(logged.status(),200);
    const user={id:'layout-'+role,username:'layout-'+role,name:'排版验收',role,enabled:true,approvedAt:new Date().toISOString(),policyVersion:0,total:8,limits:Object.fromEntries(layoutMachines.map(node=>[node.id,node.cards]))},principal={userId:user.id,username:user.username,role};
    const state={machines:layoutMachines,users:[user],jobs:[],executionEnabled:true,operationalMaintenance:{version:1,revision:0,global:null,machines:{}},gpuq:{stale:false,checkedAt:new Date().toISOString(),hosts:[]}};
    const layoutProject={...ready('container-layout'),sharedData:{protocol:'shared-data-directories-v1',available:true,directories:[{name:'imagenet',path:'/datasets/imagenet',readOnly:true,state:'READABLE'}]}};let layoutRequest=null;const layoutCalls=[];
    await layout.route('**/*',guardedRoute(async route=>{
      const request=route.request(),url=new URL(request.url());if(url.origin!==origin){await route.fallback();return;}
      if(url.pathname==='/machines.js'){await route.fulfill({contentType:'text/javascript',body:'export const MACHINES='+JSON.stringify(layoutMachines)+';'});return;}
      if(!url.pathname.startsWith('/api/')){await route.fallback();return;}const {operation,args}=request.postDataJSON();layoutCalls.push({operation,args});let result=null;
      if(operation==='state'){}else if(operation==='projects.list')result={environmentModes:['shared','isolated','oci'],projects:[layoutProject]};else if(operation==='projects.status')result=layoutProject;else if(operation==='projects.publish'){layoutRequest=args;layoutProject.state='UNKNOWN';layoutProject.publication={id:args.key,state:'UNKNOWN'};result=layoutProject;}else throw Error('Unexpected layout operation '+operation);
      await route.fulfill({contentType:'application/json',body:JSON.stringify({result,state,principal})});
    }));
    await layout.goto(origin);await layout.locator('[name=workspace-machine]').waitFor();await layout.evaluate(()=>document.fonts.ready);
    for(const node of layoutMachines){
      await action('projects.list',()=>layout.locator('#projects-refresh').click(),layout);await idle(layout);await layout.locator('[name=workspace-machine]').selectOption(node.id);await idle(layout);
      assert.equal(await layout.evaluate(()=>document.body.dataset.room),'work');
      assert.equal(await layout.locator('#page-datasets').evaluate(section=>section.hidden),true);
      assert.deepEqual(layoutCalls.filter(call=>call.operation.startsWith('datasets.')),[],'Personal projects do not read the hidden dataset room');
      const selected=await layout.locator('[name=workspace-project] option').evaluateAll((options,id)=>options.find(option=>option.dataset.project==='container-layout'&&option.dataset.machine===id)?.value,node.id);assert.ok(selected,'the exact source project is present');
      await action('projects.status',()=>layout.locator('[name=workspace-project]').selectOption(selected),layout);await idle(layout);
      await layout.waitForFunction(id=>document.querySelector('[name=dataset-machine]')?.value===id,node.id,{timeout:10000});
      assert.deepEqual(layoutCalls.filter(call=>call.operation.startsWith('datasets.')),[],'Selecting the actual source container still does not load the hidden dataset room');
      await layout.locator('#project-create').evaluate(element=>element.open=true);await layout.locator('[name=new-project]').fill('new-container');assert.equal(await layout.locator('[name=environment-choice]').count(),0);assert.equal(await layout.locator('[name=environment-mode]').inputValue(),'oci');
      await layout.locator('#project-create-form').evaluate(form=>{document.activeElement?.blur();form.scrollIntoView({block:'center',behavior:'instant'});});
      await layout.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      assert.equal(await layout.locator('#project-create-form [type=submit]').evaluate(button=>{const box=button.getBoundingClientRect(),hit=document.elementFromPoint(box.left+box.width/2,box.top+box.height/2);return button===hit||button.contains(hit);}),true,'creation remains reachable above fixed navigation');
      await layout.screenshot({path:join(shots,`personal-${role}-${width}-${node.id}-create.png`)});
      assert.ok(await layout.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),role+' '+width+' '+node.id+' does not overflow');
      assert.equal(await layout.locator('[name=workspace-machine]').getAttribute('title'),node.id);
      assert.equal(await layout.locator('#shared-data-note').isVisible(),true);
      assert.match(await layout.locator('#shared-data-note').textContent(),/默认只读.*\/datasets\/imagenet/);
      await layout.locator('#shared-data-note').evaluate(node=>node.scrollIntoView({block:'center',behavior:'instant'}));
      await layout.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
      const sharedGeometry=await inspectOperationalGeometry(layout,{roots:['.personal-terminal'],controls:'button',focusedTargets:['#shared-data-note'],viewportContainment:[{child:'#shared-data-note',parent:'.personal-terminal'}]});
      assert.deepEqual(sharedGeometry.failures,[],JSON.stringify({role,width,sharedGeometry}));
      await layout.screenshot({path:join(shots,`shared-data-${role}-${width}-${node.id}.png`)});
      assert.ok(await layout.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Shared directory path does not overflow');
      await layout.locator('#project-create').evaluate(element=>element.open=false);
    }
    await action('projects.publish',()=>layout.locator('#project-publish').click(),layout);await idle(layout);assert.ok(layoutRequest.key);assert.equal(await layout.locator('#project-status').textContent(),'发布结果未确认');
    await layout.locator('#project-status').scrollIntoViewIfNeeded();await layout.screenshot({path:join(shots,`personal-${role}-${width}-unknown.png`)});
    layoutProject.state='READY';layoutProject.publication={id:layoutRequest.key,state:'READY',release:oldRelease};await action('projects.status',()=>layout.locator('#publication-query').click(),layout);await idle(layout);
    assert.deepEqual(await layout.evaluate(()=>publicationAnimations),[width===320?150:480]);assert.deepEqual(await layout.evaluate(()=>publicationCSP),[]);
    assert.deepEqual(layoutCalls.filter(call=>call.operation.startsWith('datasets.')),[],'Project creation and publication never need a dataset directory');await layout.close();
  }
  assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);

  // Fake time and a deliberately hung fetch make lifecycle cancellation
  // deterministic. Late completion must not confirm a release or restart
  // polling, even though the node-side publication intent remains recoverable.
  const lifecycle=[];
  for(const departure of ['modal-close-and-logout','room','project','pagehide','logout','refresh-recovery']){
    const target=await browser.newPage({viewport:{width:1440,height:1080}});await configure(target);
    await target.addInitScript(()=>{
      const send=globalThis.fetch.bind(globalThis);globalThis.projectProbe={hold:localStorage.getItem('lifecycle-hold-on-reload'),trace:[],pending:[]};
      globalThis.fetch=(url,options={})=>{
        let request;try{request=JSON.parse(options.body);}catch{}
        if(request?.operation?.startsWith('projects.')){
          const entry={operation:request.operation,project:request.args?.project,aborted:false};projectProbe.trace.push(entry);
          if(projectProbe.hold===request.operation){
            projectProbe.hold=false;
            return new Promise((resolve,reject)=>{
              const aborted=()=>{entry.aborted=true;reject(options.signal.reason);};
              options.signal.addEventListener('abort',aborted,{once:true});
              projectProbe.pending.push({resolve:value=>resolve(new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}})),entry});
            });
          }
        }
        return send(url,options);
      };
    });
    const name='cleanup-'+departure,publishing=ready(name);
    projects.set(identity(machine,'builtin-admin',name),publishing);
    const logged=await target.context().request.post(origin+'/api/login',{headers:{Origin:origin},data:{username:'admin',password,client:'browser'}});assert.equal(logged.status(),200);
    await target.goto(origin);await target.locator('[data-nav=work]').click();await chooseMachine(target);
    await action('projects.status',()=>target.locator('[name=workspace-project]').selectOption(name),target);await idle(target);
    await target.clock.install();await target.clock.pauseAt(new Date());
    await action('projects.publish',()=>target.locator('#project-publish').click(),target);await idle(target);
    if(departure==='modal-close-and-logout')await openSubmit(target);
    if(departure==='refresh-recovery'){await target.evaluate(()=>localStorage.setItem('lifecycle-hold-on-reload','projects.list'));await target.reload();}
    else{await target.evaluate(()=>projectProbe.hold='projects.status');await target.clock.runFor(2100);}
    try{await target.waitForFunction(()=>projectProbe.pending.length===1,null,{timeout:5000});}catch(error){console.error('lifecycle polling evidence',departure,await target.evaluate(()=>({trace:projectProbe.trace,status:document.querySelector('#project-status')?.textContent,dialogs:[...document.querySelectorAll('dialog[open]')].map(dialog=>dialog.id),workHidden:document.querySelector('[data-page=work]')?.hidden})));throw error;}
    if(departure==='modal-close-and-logout')await target.locator('#work-submit').evaluate(dialog=>dialog.close());
    else if(departure==='room')await target.locator('[data-nav=resources]').click();
    else if(departure==='project')await target.locator('[name=workspace-project]').evaluate(select=>{select.value='admin-project';select.dispatchEvent(new Event('change',{bubbles:true}));});
    else if(departure==='pagehide'||departure==='refresh-recovery')await target.evaluate(()=>dispatchEvent(new PageTransitionEvent('pagehide')));
    else{await accountMenu(target);await action('logout',()=>target.locator('#switch-account').evaluate(button=>button.click()),target);}
    await target.clock.runFor(50);
    const stopped=await target.evaluate(()=>({aborted:projectProbe.pending[0].entry.aborted,dialogs:[...document.querySelectorAll('dialog')].map(dialog=>({id:dialog.id,open:dialog.open})),trace:projectProbe.trace}));
    assert.equal(stopped.aborted,true,departure+' aborts the pending fetch: '+JSON.stringify(stopped));
    await idle(target);
    const frozen=await target.evaluate(()=>projectProbe.trace.length);
    const before=await target.evaluate(()=>document.querySelector('#project-status')?.textContent??null);
    await target.evaluate(({project,release,key})=>{const stale={project,state:'READY',publication:{id:key,state:'READY',release},releases:[{state:'READY',release}]};projectProbe.pending[0].resolve({result:projectProbe.pending[0].entry.operation==='projects.list'?{projects:[stale]}:stale});},{project:name,release,key:publishing.publication.id});
    await target.clock.runFor(31000);
    assert.equal(await target.evaluate(()=>projectProbe.trace.length),frozen,departure+' sends no project requests after cancellation');
    assert.equal(await target.evaluate(()=>document.querySelector('#project-status')?.textContent??null),before,departure+' ignores late READY');
    assert.equal(await target.evaluate(key=>Object.keys(localStorage).some(name=>name.startsWith('stargate.project-publication.v1:')&&JSON.parse(localStorage[name]).key===key),publishing.publication.id),true,departure+' keeps the original intent for explicit confirmation');
    if(departure==='project')assert.equal(await target.locator('[name=workspace-project]').inputValue(),'admin-project');
    if(departure==='modal-close-and-logout'){
      assert.equal(await target.locator('#project-publish').isDisabled(),true,'unconfirmed publication stays fenced');
      await accountMenu(target);await action('logout',()=>target.locator('#switch-account').evaluate(button=>button.click()),target);
      await target.clock.runFor(31000);assert.equal(await target.evaluate(()=>projectProbe.trace.length),frozen,'closed polling stays stopped after logout');
      assert.equal(await target.locator('#login-dialog').isVisible(),true);
    }
    assert.deepEqual(await target.evaluate(()=>publicationCSP),[]);
    lifecycle.push({departure,aborted:true,noMoreProjectRequests:true,lateResultIgnored:true});await target.close();
  }
  assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
  await writeFile(join(shots,'publication-lifecycle.json'),JSON.stringify(lifecycle,null,2));
  await writeFile(join(shots,'personal-checks.json'),JSON.stringify({status:'passed',checks:['personal OCI default and exact name validation','strict container confirmation without shared fallback; historical shared projects remain readable','server rejection unchanged','detached terminals block publish','confirmed close, cancellation and unconfirmed close','matching receipt plus READY release','old READY never confirms new request','same-key explicit retry queries first','lost response queries without duplicate publish','refresh restores scoped intent','FAILED details escaped in help','room departure pauses polling','account isolation and zero authorization','status args never include key','member/admin long IDs at 1440/390/320','480ms confirmation and 150ms reduced motion','no CSP errors or external requests','hung polling cancelled on modal close then logout, room/project change, pagehide and logout','late READY cannot restart polling or mutate another context'],calls:calls.length,shots,animations,lifecycle},null,2));
  console.log(JSON.stringify({status:'passed',test:'personal-project-ui',shots,calls:calls.length}));
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
