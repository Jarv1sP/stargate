// Actual external workspace layout; all accounts and RPCs are loopback fixtures.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {resolve,join,extname} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';
const root=resolve(import.meta.dirname,'../dist'),temporary=await mkdtemp(join(tmpdir(),'external-package2-ui-'));
const out=process.env.PACKAGE2_SHOTS||temporary;
await mkdir(out,{recursive:true});
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${['styles','fonts','starbase','shell','workspace','workbench','datasets','copy-help'].map(name=>'<link rel="stylesheet" href="/'+name+'.css">').join('')}
<style>body{margin:0}main{max-width:1280px;margin:auto;padding:24px;box-sizing:border-box}</style>
<body class="sb" data-room="work"><main data-page="work"><div id="execution-host"></div></main>
<script type="module">
import {executionUI} from '/execution-ui.js';
const role=new URL(location.href).searchParams.get('role')||'member',owner='fixture-'+role,at=new Date().toISOString();
const machines=[{id:'fixture-node-long-alpha',cards:8,model:'Fixture'},{id:'fixture-node-long-beta',cards:8,model:'Fixture'}];
const active={project:'active',state:'DRAFT',environmentMode:'oci',workspaceProtocol:1,releases:[],lifecycle:{protocol:'project-lifecycle-v1',state:'ACTIVE',revision:0}};
const retirement='12345678-1234-4234-8234-123456789abc';
window.calls=[];window.toasts=[];window.callbacks=[];window.restored=false;
const layers=Object.fromEntries(['dev','activeReleases','retiredReleases','outputs','oci','other'].map(name=>[name,{logicalBytes:200,allocatedBytes:100,sharedBytes:0,reclaimableBytes:0,checkedAt:at,complete:true,...(name==='retiredReleases'?{releases:[],reclaimableSchedule:[]}:{}),...(name==='oci'?{sharedImageBytes:null}:{})}]));
Object.assign(layers,{protocol:1,checkedAt:at});
const store={production:true,authGeneration:1,principal:{userId:owner,role},users:[{id:owner,username:'fixture',name:'Fixture',role,enabled:true,total:8,limits:Object.fromEntries(machines.map(m=>[m.id,8]))}],jobs:[],usage:()=>0,
 data:{machines,executionEnabled:true,execution:{},gpuq:{stale:false,hosts:machines.map(m=>({id:m.id,reachable:true,gpus:[],gpuq:{connected:true,health:'ok',schedulableIndices:[0]}}))}},
 onAuthChange(fn){callbacks.push(fn);return()=>{const index=callbacks.indexOf(fn);if(index>=0)callbacks.splice(index,1);};},
 async call(op,args){calls.push({op,args:structuredClone(args)});
  if(op==='projects.list')return {environmentModes:['oci'],projects:args.machine===machines[0].id?[active,...(restored?[{...active,project:'restored'}]:[])]:[]};
  if(op==='projects.status')return {...active,project:args.project};
  if(op==='projects.quota')return {volumes:[{kind:'workspace',usedBytes:null,availableBytes:null,totalBytes:null},{kind:'datasets',usedBytes:null,availableBytes:null,totalBytes:null}]};
  if(op==='projects.retire.list')return {protocol:'project-lifecycle-v1',items:restored?[]:[{project:'restored',key:retirement,kind:'project',ownerId:owner,state:'TRASHED',bytes:2048,retiredAt:Date.now()/1000,retainUntil:Date.now()/1000+604800}]};
  if(op==='projects.release.list')return {protocol:'project-release-retirement-v1',items:[]};
  if(op==='projects.retire.restore'){if(args.key!==retirement||args.project!=='restored')throw Error('Wrong original retirement identity');restored=true;return {protocol:'project-lifecycle-v1',state:'RESTORED',project:args.project,retirementId:args.key};}
  if(op==='datasets.capacity')return {storageOverview:{cache:{containersAvailable:true,projectUsageComplete:true,containers:[{id:'a'.repeat(64),project:args.machine===machines[0].id?'active':'other',userId:store.principal.userId,ownerLabel:'Fixture',bytes:600,sharedBytes:0,checkedAt:at,state:'not-running',complete:true,runtimeIds:[],layers}]}}};
  throw Error('Unexpected operation '+op);
 }};
window.store=store;window.machines=machines;window.view=executionUI(store,()=>view(),text=>toasts.push(text));view();window.ready=true;
</script></html>`;
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/'){res.setHeader('content-type','text/html');res.end(html);return;}
 if(url.pathname==='/machines.js'){res.setHeader('content-type','text/javascript');res.end('export const MACHINES=[];');return;}
 const path=resolve(root,'.'+url.pathname);if(!path.startsWith(root+'/')){res.writeHead(404).end();return;}
 try{const value=await readFile(path);res.setHeader('content-type',extname(path)==='.js'?'text/javascript':extname(path)==='.css'?'text/css':'application/octet-stream');res.end(value);}catch{res.writeHead(404).end();}
});
let browser;
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({headless:true,...process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}});
 for(const role of ['member','admin'])for(const width of [1440,390,320]){
  const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];page.on('pageerror',error=>{errors.push(error.message);console.error('Fixture page error: '+error.stack);});page.on('console',message=>{if(message.type()==='error')console.error('Fixture console: '+message.text());});
  await page.goto('http://127.0.0.1:'+server.address().port+'/?role='+role);await page.waitForFunction(()=>window.ready);
  await page.waitForFunction(()=>document.querySelector('[name=workspace-project] option[data-project=active]'));
  const activeProject=await page.locator('[name=workspace-project] option[data-project=active]').getAttribute('value');
  if(!await page.locator('#pr-switch-sheet[open]').count())await page.locator('#pr-switch').click();await page.locator('[name=workspace-project]').selectOption(activeProject);
  await page.waitForFunction(()=>!document.querySelector('[name=workspace-project]').disabled);
  await page.evaluate(()=>document.fonts.ready);
  assert.equal(await page.locator('#project-publish').count(),0,'workspace runs still do not require publication');
  assert.equal(await page.locator('[name=release]').count(),0,'version controls are retired');
  assert.equal(await page.locator('[name=training-target]').inputValue(),'current','new contexts keep the current server default');
  assert.equal(await page.locator('[name=training-target] option[value=auto]').evaluate(node=>node.disabled),false,'OCI workspace supports explicit AUTO');
  await page.evaluate(()=>{
    const target=document.querySelector('[name=training-target]');target.value='auto';target.dispatchEvent(new Event('change',{bubbles:true}));
  });
  assert.equal(await page.locator('[name=training-target]').inputValue(),'auto','controls must not force AUTO back to current');
  await page.evaluate(()=>view());
  assert.equal(await page.locator('[name=training-target]').inputValue(),'auto','state refresh preserves the explicit target');
  if(!await page.locator('#pr-switch-sheet[open]').count())await page.locator('#pr-switch').click();await page.locator('#projects-refresh').click();await page.waitForFunction(()=>!document.querySelector('#projects-refresh').disabled);await page.locator('#pr-switch-close').click();await page.locator('#pr-switch-sheet').waitFor({state:'hidden'});
  assert.equal(await page.locator('[name=training-target]').inputValue(),'auto','project refresh preserves the explicit target');
  assert.match(await page.locator('#submit-command').textContent(),/--machine auto/);
  await page.locator('[data-pt=settings]').click();const management=page.locator('#project-management');await management.locator(':scope>summary').click();await management.locator('.project-trash>summary').click();
  await page.locator('[data-trash-restore]').waitFor({state:'visible'});
  const before=await page.evaluate(()=>calls.filter(c=>c.op==='projects.list').length);
  await page.locator('[data-trash-restore]').click();
  await page.waitForFunction(()=>!!document.querySelector('[name=workspace-project] option[data-project=restored]'));
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.op==='projects.list').length),before+1,'restore refreshes the actual external project directory');
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.op==='projects.retire.restore').length),1);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:join(out,`external-package2-${role}-${width}.png`),fullPage:true});
  await page.evaluate(()=>{window.previousPrincipal=store.principal;store.principal=null;store.authGeneration++;for(const fn of [...callbacks])fn();view();});
  assert.equal(await page.locator('[name=workspace-project]').count(),0,'logout removes the project controls and their account data');
  assert.equal(await page.locator('#execution-workspace').isVisible(),false,'logout hides the workspace');
  assert.equal(await page.locator('#work-submit[open],#work-submit-panel[open],.job-log-dialog[open]').count(),0,'logout closes project and job drawers');
  await page.evaluate(()=>{store.principal=window.previousPrincipal;store.authGeneration++;for(const fn of [...callbacks])fn();view();});
  await page.locator('[name=workspace-project] option[data-project=active]').waitFor({state:'attached'});
  if(!await page.locator('#pr-switch-sheet[open]').count())await page.locator('#pr-switch').click();await page.locator('[name=workspace-project]').selectOption(activeProject);
  await page.waitForFunction(()=>!document.querySelector('[name=workspace-project]').disabled);
  if(!await page.locator('#pr-switch-sheet[open]').count())await page.locator('#pr-switch').click();assert.equal(await page.locator('[name=workspace-project]').isVisible(),true,'the current project switcher is usable after signing in again');
  assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>toasts),[]);await page.close();console.log('PASS external workbench '+role+'/'+width+': workspace automatic target, restore refresh, widths and logout');
 }
}finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(temporary,{recursive:true,force:true});}
