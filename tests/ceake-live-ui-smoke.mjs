// Real app/store/workshop/native view modules, with isolated RPC data and no live node.
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm,mkdir} from 'node:fs/promises';
import {resolve,join,extname} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
import {renderWorkshopFrame} from '../workshop-frame.mjs';
const dir=await mkdtemp(join(tmpdir(),'ceake-live-')),bundle=join(dir,'package.json'),origin='https://ceake-live.test',root=resolve(import.meta.dirname,'../dist');
execFileSync(process.execPath,['scripts/package-ceake-live.mjs',bundle]);const pkg=JSON.parse(await readFile(bundle,'utf8'));
const item={id:'11111111-1111-4111-8111-111111111111',version:1,kind:'plugin',presentation:'interface',name:pkg.name,description:pkg.description,author:{name:'fixture'},canEdit:true};
const machine='fixture-node',owner='member-a',peer='member-b',principal={userId:owner,username:'alice',role:process.env.CEAKE_ROLE||'admin'};
const projects=[{project:'peer-project',displayName:'团队项目',ownerId:peer,ownerName:'成员乙',environmentMode:'oci',state:'ACTIVE'}];
const jobs=[{id:'22222222-2222-4222-8222-222222222222',nodeJobId:'J111111111111',userId:peer,ownerId:peer,machine,project:'peer-project',name:'团队训练',state:'RUNNING',cards:1,argv:['python','train.py'],submitter:{name:'成员乙'},createdAt:'2026-10-20T00:00:00Z',startedAt:'2026-10-20T00:00:00Z'}];
let datasets=[{dataset:'shared-images',name:'shared-images',size:1024,uploadedBy:'成员乙',modifiedAt:1792454400}],trash=[],installed=true,failProjects=false,lostSubmit=true,unknownDelete=true,lostNote=true;
const state={machines:[{id:machine,cards:2,model:'Fixture GPU'}],users:[{id:owner,name:'成员甲',username:'alice',role:principal.role,enabled:true,total:2,limits:{[machine]:2}},{id:peer,name:'成员乙',username:'bob',role:'member',enabled:true}],jobs,executionEnabled:true,execution:{},frontendWorkshop:{version:1},gpuq:{stale:false,checkedAt:'2026-10-20T00:00:00Z',hosts:[{id:machine,reachable:true,gpus:[{index:0,model:'Fixture GPU',utilization:30,memoryUsedMiB:100,memoryTotalMiB:1000,processes:[],processesAvailable:true}],disks:[],tasks:[],gpuq:{connected:true,health:'ok'}}]},announcements:{pending:[]},operationalMaintenance:{global:null,machines:{}}};
const calls=[],errors=[],submissions=new Map(),notes=[];
async function rpc(op,args){calls.push({op,args:structuredClone(args)});
 if(op==='state')return {principal,state};
 if(op==='workshop.mine')return {installed:installed?[{item,package:pkg}]:[]};
 if(op==='workshop.list')return {items:[item]};
 if(op==='workshop.get')return {item,package:pkg};
 if(op==='workshop.uninstall'){installed=false;return {installed:[]};}
 if(op==='projects.list'){if(failProjects)throw Error('节点暂时读不到');return {projects};}
 if(op==='projects.create'){const p={project:args.project,ownerId:owner,ownerName:'成员甲',environmentMode:'oci',lifecycle:{state:'ACTIVE'}};projects.push(p);return p;}
 if(op==='projects.status')return {...projects.find(p=>p.project===args.project),git:{url:'https://example.test/vision.git',branch:'main'}};
 if(op==='projects.catalog')return {groups:[]};
 if(op==='projects.quota')return {volumes:[],projectUsage:{size:null,complete:false}};
 if(op==='projects.retire.list')return {items:trash};
 if(op==='projects.retire.restore'){const row=trash.find(r=>r.key===args.key);if(row.kind==='dataset')datasets.push({dataset:row.dataset,name:row.dataset,size:1024});trash=trash.filter(r=>r!==row);return {state:'RESTORED',key:args.key};}
 if(op==='storage.snapshot')return {machines:[{machine,checkedAt:'2026-10-20T00:00:00Z',quota:{volumes:[]},projects:{projects},datasets:{datasets}}]};
 if(op==='datasets.list')return {datasets};
 if(op==='datasets.delete'){if(trash.some(row=>row.key===args.key))return {state:'TRASHED',key:args.key};datasets=datasets.filter(d=>d.dataset!==args.dataset);trash.push({...args,kind:'dataset',state:'TRASHED',retainUntil:1793059200});if(unknownDelete){unknownDelete=false;return {state:'UNKNOWN',key:args.key};}return {state:'TRASHED',key:args.key};}
 if(op==='files.list')return {entries:[{name:'sample.txt',type:'file',size:3}],hasMore:false};
 if(op==='jobs.logs')return {text:'backend log\n真实后端日志示例\n'};
 if(op==='jobs.diagnostics')return {state:'RUNNING',cpu:{percent:20},memory:{usedBytes:1000}};
 if(op==='jobs.submit'){
  if(!submissions.has(args.key)){const job={...args,id:'33333333-3333-4333-8333-333333333333',userId:owner,state:'PENDING',createdAt:'2026-10-20T00:00:00Z'};submissions.set(args.key,job);jobs.push(job);}
  if(lostSubmit){lostSubmit=false;throw Object.assign(Error('响应丢失'),{status:503});}return submissions.get(args.key);
 }
 if(op==='jobs.cancel'){jobs.find(j=>j.id===args.jobId).cancelRequested=true;return {cancelRequested:true};}
 if(op==='jobs.priority'){jobs.find(j=>j.id===args.jobId).schedulerPriority=Number(args.priority.slice(1));return {};}
 if(op==='community.notes.list')return {notes};
 if(op==='community.notes.create'){let row=notes.find(n=>n.key===args.key);if(!row){row={...args,id:'note-1',authorName:'成员甲'};notes.push(row);}if(lostNote){lostNote=false;throw Object.assign(Error('留言响应丢失'),{status:503});}return row;}
 if(op==='community.rooms.list')return {rooms:[],canCreate:false};
 if(op==='community.posts.list')return {posts:[],nextCursor:null};
 if(op==='community.chat.list')return {messages:[],nextCursor:null};
 if(op==='transfers.list')return {transfers:[],nextCursor:null};
 if(op==='cloud.import.list')return {imports:[]};
 throw Error('Unexpected RPC '+op);
}
let browser;
try{
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/Content Security Policy|Blocked form submission/.test(m.text()))errors.push(m.text());});
 await page.route('**/*',async route=>{const u=new URL(route.request().url());assert.equal(u.origin,origin);
  if(u.pathname==='/'){let html=await readFile(join(root,'index.html'),'utf8');html=html.replace('globalThis.GPUQ_LOCAL_API=false;','globalThis.GPUQ_LOCAL_API=true;globalThis.GPUQ_PRODUCTION=true;globalThis.GPUQ_HAS_SESSION=true;');html=html.replace('<head>','<head><meta name="gpuq-style-nonce" content="ceakeLiveFixtureNonce12345">');return route.fulfill({contentType:'text/html',body:html});}
  if(u.pathname.startsWith('/workshop/frame/')){const frame=renderWorkshopFrame(pkg,{origin,nonce:'ceakeLiveFixtureNonce12345'});return route.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':frame.csp},body:frame.html});}
  if(u.pathname==='/machines.js')return route.fulfill({contentType:'text/javascript',body:'export const MACHINES='+JSON.stringify(state.machines)});
  if(u.pathname.startsWith('/api/')){const body=route.request().postDataJSON();try{const result=await rpc(body.operation,body.args||{});return route.fulfill({contentType:'application/json',body:JSON.stringify(body.operation==='state'?result:{ok:true,result})});}catch(e){return route.fulfill({status:e.status||500,contentType:'application/json',body:JSON.stringify({error:e.message})});}}
  const path=resolve(root,'.'+u.pathname);assert.ok(path.startsWith(root+'/'));return route.fulfill({contentType:extname(path)==='.js'?'text/javascript':extname(path)==='.css'?'text/css':'application/octet-stream',body:await readFile(path)});
 });
 await page.goto(origin+'/#workshop');await page.locator('#startup-wordmark').waitFor({state:'hidden'});
 const f=page.frameLocator('.workshop-interface iframe');await f.locator('.live-connection').waitFor();
 const goRoute=async key=>{if(!await f.locator('.mside [data-route='+key+']').count()){const group={projects:'全局管理',trash:'全局管理',jobs:'模型开发',datasets:'数据服务'}[key];await f.locator('[data-group="'+group+'"]').click();}await f.locator('.mside [data-route='+key+']').click();};
 await goRoute('projects');await f.locator('.tbl').filter({hasText:'团队项目'}).waitFor();
 await f.locator('[data-action=project-new]').click();await f.locator('#live-form [name=project]').fill('new-live-project');await f.locator('#live-form [name=project]').press('Enter');await f.locator('.tbl').filter({hasText:'new-live-project'}).waitFor();assert.equal(calls.filter(c=>c.op==='projects.create').length,1);
 await f.locator('.tbl tr').filter({hasText:'团队项目'}).locator('[data-action=terminal]').click();await page.locator('.workshop-native-panel #pr-name').filter({hasText:'团队项目'}).waitFor();assert.equal(await page.locator('.workshop-native-panel #terminal-open').isVisible(),true);await page.locator('.workshop-native-panel [data-pt=files]').click();await page.locator('.workshop-native-panel [data-code-path="sample.txt"]').waitFor();assert.ok(calls.some(c=>c.op==='files.list'&&c.args.ownerId===peer));await page.locator('.workshop-native-heading button').click();await page.locator('.workshop-native-panel').waitFor({state:'detached'});
 await f.locator('[data-action=project-new]').click();await f.locator('#live-form [name=project]').fill('created-after-cache');await f.locator('.dialog [data-ok]').click();await f.locator('.tbl tr').filter({hasText:'created-after-cache'}).locator('[data-action=files]').click();await page.locator('.workshop-native-panel #pr-name').filter({hasText:'created-after-cache'}).waitFor();await page.locator('.workshop-native-panel [data-code-path="sample.txt"]').waitFor();await page.locator('.workshop-native-heading button').click();await page.locator('.workshop-native-panel').waitFor({state:'detached'});
 await goRoute('jobs');await f.locator('.tbl').filter({hasText:'团队训练'}).waitFor();await f.locator('[data-action=job-advanced]').click();await page.locator('.workshop-native-panel [data-submit-form]').waitFor();await page.locator('.workshop-native-panel [data-gpu]').first().waitFor();await page.locator('.workshop-native-heading button').click();await page.locator('.workshop-native-panel').waitFor({state:'detached'});await f.locator('[data-action=job-new]').click();await f.locator('#live-form [name=name]').fill('live-submit');await f.locator('#live-form [name=command]').fill('python train.py --epochs 2');await f.locator('.dialog [data-ok]').click();await f.locator('#live-form [role=status]').filter({hasText:'结果未知'}).waitFor();assert.equal(await f.locator('#live-form [name=command]').isDisabled(),true);await f.locator('.dialog [data-ok]').click();await f.locator('.dialog').waitFor({state:'detached'});await f.locator('.tbl').filter({hasText:'live-submit'}).waitFor();await mkdir('out/ceake-live/screenshots',{recursive:true});await page.screenshot({path:'out/ceake-live/screenshots/real-job-table.png'});
 const submits=calls.filter(c=>c.op==='jobs.submit');assert.equal(submits.length,2);assert.deepEqual(submits[0].args,submits[1].args);assert.equal(submissions.size,1);assert.deepEqual(submits[0].args.argv,['/bin/bash','-c','python train.py --epochs 2']);
 await f.locator('.tbl tr').filter({hasText:'团队训练'}).locator('[data-action=job]').first().click();await f.locator('[data-tab=log]').click();await f.locator('#live-log').filter({hasText:'真实后端日志示例'}).waitFor();await f.locator('[data-tab=out]').click();await f.locator('[data-action=job-native]').click();await page.locator('.workshop-native-panel .jr-dr-name').filter({hasText:'团队训练'}).waitFor();await page.locator('.workshop-native-panel [data-tab=out]').click();await page.locator('.workshop-native-panel [data-outputs]').filter({hasText:'sample.txt'}).waitFor();await page.locator('.workshop-native-panel .jr-x').click();await page.locator('.workshop-native-panel').waitFor({state:'detached'});await f.locator('[data-tab=note]').click();await f.locator('#note-form textarea').fill('训练留言');await f.locator('#note-form button').click();await f.locator('#note-form [role=status]').filter({hasText:'结果未知'}).waitFor().catch(async e=>{console.error(JSON.stringify({notes,calls:calls.slice(-12),errors,form:await f.locator('#note-form').innerText()}));throw e;});assert.equal(await f.locator('#note-form textarea').isDisabled(),true);await f.locator('#note-form button').click();await f.locator('#live-notes').filter({hasText:'训练留言'}).waitFor();assert.equal(notes.length,1);const noteCalls=calls.filter(c=>c.op==='community.notes.create');assert.deepEqual(noteCalls[0].args,noteCalls[1].args);await goRoute('jobs');await f.locator('.tbl tr').filter({hasText:'团队训练'}).locator('[data-action=job-more]').click();await f.locator('.dd-it').filter({hasText:'取消任务'}).click();await page.locator('.workshop-confirm[open]').waitFor();assert.equal(calls.filter(c=>c.op==='jobs.cancel').length,0);await page.getByRole('button',{name:'确认取消训练',exact:true}).click();await f.locator('.tbl tr').filter({hasText:'团队训练'}).filter({hasText:'正在取消'}).waitFor();assert.equal(calls.filter(c=>c.op==='jobs.cancel').length,1);
 await goRoute('datasets');await f.locator('.tbl').filter({hasText:'shared-images'}).waitFor();await f.locator('[data-action=dataset-native][data-id=shared-images]').click();await page.locator('.workshop-native-panel [data-dataset-current]').filter({hasText:'shared-images'}).waitFor();assert.equal(await page.locator('.workshop-native-panel [name=dataset-machine]').inputValue(),machine);await page.evaluate(({owner,machine,peer})=>document.dispatchEvent(new CustomEvent('gpuq-open-project',{detail:{userId:owner,authGeneration:0,machine,project:'peer-project',ownerId:peer}})),{owner,machine,peer});await page.locator('.workshop-native-panel #pr-name').filter({hasText:'团队项目'}).waitFor();await page.locator('.workshop-native-heading button').click();await page.locator('.workshop-native-panel').waitFor({state:'detached'});await f.locator('[data-action=dataset-delete]').click();await f.locator('.dialog [data-ok]').click();await f.locator('.toast').filter({hasText:'结果未知'}).waitFor();await f.locator('[data-action=dataset-delete]').click();await f.locator('.dialog [data-ok]').click();await f.locator('.tbl').filter({hasText:'shared-images'}).waitFor({state:'hidden'});const deletes=calls.filter(c=>c.op==='datasets.delete');assert.equal(deletes.length,2);assert.deepEqual(deletes[0].args,deletes[1].args);assert.equal(trash.length,1);assert.equal(datasets.length,0);
 await goRoute('trash');await f.locator('[data-action=restore]').click();await f.locator('[data-action=restore]').waitFor({state:'detached'});assert.equal(datasets[0].dataset,'shared-images');
 failProjects=true;await goRoute('projects');await f.locator('.live-missing').filter({hasText:'节点暂时读不到'}).waitFor();assert.match(await f.locator('.tbl').innerText(),/未读到/);
 await mkdir('out/ceake-live/screenshots',{recursive:true});await page.screenshot({path:'out/ceake-live/screenshots/live-interface.png'});
 await f.locator('#live-search').focus();await page.keyboard.press('Control+Alt+0');await page.locator('.workshop-interface').waitFor({state:'detached'});assert.equal(installed,false);assert.deepEqual(errors,[]);
 console.log('PASS live backend: team projects, real RPC create, native terminal panel, stable-key submit retry, real logs, dataset recycle/restore, unknown nodes and keyboard recovery');
}finally{await browser?.close();await rm(dir,{recursive:true,force:true});}
