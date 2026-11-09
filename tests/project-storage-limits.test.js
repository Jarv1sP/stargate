import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
import {credential} from '../dist/service.js';
import {projectLimitPresentation} from '../project-storage-limits.mjs';
import {filesLimitText,quotaReport,quotaUsageLines} from '../dist/storage-usage.js';
const machine=MACHINES[0].id;
test('only admins save audited caps; full lists sync immediately and on refresh, surviving node outage and restart',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'project-storage-limits-')),password='Fixture-Storage-Caps-2026!';
 await writeFile(join(dir,'bootstrap'),JSON.stringify({username:'admin',password}));
 const calls=[];let offline=false,service;
 const bridge=async(target,op,args)=>{calls.push({target,op,args});if(offline)throw Error('offline');return op==='projects.list'?{projects:[]}:{volumes:[],datasets:[]};};
 const open=()=>PortalService.open(join(dir,'db'),join(dir,'bootstrap'),undefined,bridge);
 const stop=()=>{for(const key of ['executionTimer','notificationTimer','maintenanceTimer','transferTimer','storageArchiveTimer','projectCopyTimer'])clearInterval(service[key]);};
 service=await open();stop();t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});
 const principal={id:'fixture-member',username:'member',name:'Member',role:'member',enabled:true,total:1,limits:{[machine]:1},approvedAt:new Date().toISOString()};
 service.store.users.push(principal);service.accounts.insert(principal,await credential(password,600000));service.refreshAccounts();service.save();
 const admin=(await service.login('admin',password)).token,member=(await service.login('member',password)).token;
 const args={machine,ownerId:principal.id,project:'demo',bytes:50_000_000_000,enabled:true};
 for(const ownerId of ['bad.owner','a'.repeat(65),'账号'])await assert.rejects(service.invoke(admin,'projects.storage.limit.set',{...args,ownerId}),{status:400});
 assert.equal(service.db.prepare('SELECT COUNT(*) AS count FROM project_storage_limits_v2').get().count,0);
 await assert.rejects(service.invoke(member,'projects.storage.limit.set',args),{status:403});assert.equal(calls.length,0);
 const result=(await service.invoke(admin,'projects.storage.limit.set',args)).result;assert.equal(result.synced,true);
 assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))),{target:machine,op:'projects.storage.limits.sync',args:{limits:[{ownerId:principal.id,project:'demo',bytes:args.bytes}],actor:{isAdmin:true}}});
 assert.equal(service.projectPresentation(principal.id,machine,{project:'demo'}).desiredLimitBytes,args.bytes);
 const audit=service.db.prepare("SELECT * FROM audit WHERE operation='projects.storage.limit.set'").get();assert.match(audit.outcome,/50000000000/);
 offline=true;assert.equal((await service.invoke(admin,'projects.storage.limit.set',{...args,project:'other',bytes:200_000_000_000})).result.synced,false);
 offline=false;calls.length=0;service.scheduleStorageRefresh(machine,0);await service.refreshStorage();
 assert.equal(calls[0].op,'projects.storage.limits.sync');assert.equal(calls[0].args.limits.length,2);
 service.db.prepare('INSERT INTO project_storage_limits_v2(owner_id,machine,project,bytes,updated_by,updated_at) VALUES(?,?,?,?,?,?)').run('bad.owner',machine,'old',1000,'admin',new Date().toISOString());
 await service.syncStorageLimits(machine);assert.equal(calls.at(-1).args.limits.length,2,'a pre-existing malformed owner cannot poison full-list sync');
 service.close();service=await open();stop();assert.equal(service.projectStorageLimit(principal.id,machine,'demo'),50_000_000_000);
 await assert.rejects(service.invoke((await service.login('admin',password)).token,'projects.storage.limit.set',{...args,bytes:0}),{status:400});
});
test('UI and CLI share applied, pending, disabled, 90 percent and grace states; outputs stay uncapped',()=>{
 const base={size:95,complete:true,desiredLimitBytes:100,limitBytes:1024,enforced:true};
 assert.match(filesLimitText({...base,size:950,desiredLimitBytes:1024}),/≥90%/);
 assert.match(filesLimitText({...base,size:1024,desiredLimitBytes:1024}),/超限/);
 assert.match(filesLimitText({...base,enforced:false}),/上限未生效.*待生效/);
 assert.match(filesLimitText({...base,enforced:null}),/上限状态未知/);
 assert.doesNotMatch(filesLimitText({...base,enforced:null}),/上限未生效/);
 assert.match(filesLimitText({...base,desiredLimitBytes:2048}),/待生效/);
 assert.match(filesLimitText({...base,size:120,desiredLimitBytes:100,graceUntil:1800000000,effectiveLimitBytes:1024}),/超限，宽限至/);
 const report=quotaReport({machine,projects:{projects:[{...base,project:'demo',ownerId:'a',outputs:{size:999999,complete:true}}]}},{project:'demo',ownerId:'a'});
 assert.match(quotaUsageLines(report).join('\n'),/文件.*上限.*输出/);assert.equal(report.projectUsage.outputs.limitBytes,undefined);
});

test('decimal and grace targets settle at the sampled filesystem block size in UI and CLI',()=>{
 const round=(n,b)=>Math.ceil(n/b)*b;
 for(const requested of [1_000_000_000,10_000_000_000,50_000_000_000,100_000_000_000,1_000_000_001]){
  const row={size:1,complete:true,limitBlockBytes:4096,requestedLimitBytes:requested,desiredLimitBytes:requested,limitBytes:round(requested,4096),enforced:true};
  assert.doesNotMatch(filesLimitText(row),/待生效/,String(requested));
  const report=quotaReport({projects:{projects:[{...row,project:'demo',ownerId:'a'}]}},{project:'demo',ownerId:'a'});
  assert.doesNotMatch(quotaUsageLines(report).join('\n'),/待生效/);
 }
 const row={size:150_000_000_000,desiredLimitBytes:100_000_000_000,effectiveLimitBytes:round(160_000_000_000,4096),limitBytes:round(160_000_000_000,4096),limitBlockBytes:4096,enforced:true,graceUntil:1800000000};
 assert.doesNotMatch(filesLimitText(row),/待生效/);assert.match(filesLimitText(row),/宽限至/);
});
test('processed clamps remain visible without pending; a newer request supersedes the old clamp',()=>{
 const block=4096,round=n=>Math.ceil(n/block)*block;
 for(const [requested,target] of [[500_000_000,1_000_000_000],[20_000_000_000_000,10_000_000_000_000]]){
  const node={requestedLimitBytes:requested,desiredLimitBytes:target,effectiveLimitBytes:round(target),limitBytes:round(target),limitBlockBytes:block,enforced:true,size:1};
  const row={...node,...projectLimitPresentation(node,requested)};
  assert.equal(row.desiredLimitBytes,target);assert.match(filesLimitText(row),/已按节点范围调整/);assert.doesNotMatch(filesLimitText(row),/待生效/);
  const newer={...node,...projectLimitPresentation(node,2_000_000_000)};
  assert.equal(newer.desiredLimitBytes,2_000_000_000);assert.equal(newer.graceUntil,null);assert.match(filesLimitText(newer),/待生效/);assert.doesNotMatch(filesLimitText(newer),/已按节点范围调整/);
 }
});
