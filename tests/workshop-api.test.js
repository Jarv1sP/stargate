import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {normalizeWorkshopPackage,THEME_TOKENS,WORKSHOP_PERMISSIONS,WORKSHOP_PACKAGE_BYTES} from '../dist/workshop-package.js';
import {installWorkshop,workshopCall,installedWorkshopPlugin} from '../workshop.mjs';
import {PortalService} from '../portal-service.mjs';

const actors={alice:{userId:'alice-id',username:'alice',role:'member'},bob:{userId:'bob-id',username:'bob',role:'member'},admin:{userId:'admin-id',username:'admin',role:'admin'}};
const theme=(extra={})=>({apiVersion:1,kind:'theme',name:'深空',description:'配色与布局',theme:{tokens:{'--bg':'#112233'},density:'compact',width:'wide',columns:2},...extra});
const plugin=(extra={})=>({apiVersion:1,kind:'plugin',name:'任务卡片',description:'读取我的任务',html:'<p id="status"></p>',css:'p {color:#fff}',script:'document.querySelector("p").textContent="READY";',permissions:['jobs.read'],...extra});
const status=number=>error=>error.status===number;
function fixture(t){
  const service={db:new DatabaseSync(':memory:'),store:{users:Object.values(actors).map(actor=>({id:actor.userId,username:actor.username,name:actor.username,role:actor.role,enabled:true,limits:{},total:0,private:'DO_NOT_EXPOSE'})),jobs:[]},audit(){}};
  installWorkshop(service);t.after(()=>service.db.close());
  const call=(op,args={},name='alice')=>workshopCall(service,actors[name],'workshop.'+op,args);
  const publish=(pkg=theme(),args={},name='alice')=>call('publish',{key:randomUUID(),package:pkg,...args},name);
  const install=(published,name='alice',permissions=published.package.permissions||[])=>call('install',{id:published.item.id,version:published.item.version,permissions},name);
  return {service,call,publish,install};
}

test('manifest normalization shares exact colors, layout defaults and permission order',()=>{
  assert(THEME_TOKENS.every(token=>token.startsWith('--')));
  assert.deepEqual(normalizeWorkshopPackage(theme({theme:{tokens:{'--ink':'#FFF','--bg':'#123456FF'}},permissions:[]})).theme,
    {tokens:{'--bg':'#123456ff','--ink':'#fff'},density:'comfortable',width:'normal',columns:1});
  assert.equal(Object.hasOwn(normalizeWorkshopPackage(theme({permissions:[]})),'permissions'),false);
  assert.deepEqual(normalizeWorkshopPackage(plugin({permissions:[...WORKSHOP_PERMISSIONS].reverse()})).permissions,WORKSHOP_PERMISSIONS);
  assert.equal(normalizeWorkshopPackage(plugin({script:'',html:'',css:'',permissions:[]})).script,'');
  assert.equal(normalizeWorkshopPackage(theme({name:'  深空  ',description:''})).name,'深空');
});

test('themes reject script, non-colors, arbitrary properties and malformed layouts',()=>{
  for(const extra of [{script:''},{css:''},{html:''},{permissions:['jobs.read']},{permissions:null},{url:'x'},{apiVersion:2},{kind:'layout'},
    {theme:null},{theme:{tokens:[]}},{theme:{tokens:{'--bg':'url(https://example.invalid/a)'}}},{theme:{tokens:{'--bg':'#fff;display:none'}}},
    {theme:{tokens:{'--unknown':'#fff'}}},{theme:{tokens:{'--content':'#fff'}}},{theme:{density:'tiny'}},{theme:{width:'huge'}},
    {theme:{columns:3}},{theme:{columns:'2'}},{theme:{font:'custom'}},{theme:{tokens:{'--bg':'#abcd'}}}])
    assert.throws(()=>normalizeWorkshopPackage(theme(extra)),status(400),JSON.stringify(extra));
});

test('packages enforce UTF-8 size, names, descriptions and explicit plugin permissions',()=>{
  for(const extra of [{name:''},{name:'x'.repeat(65)},{description:'x'.repeat(1001)},{description:null},{name:'\0invalid'},{name:'\ud800'},
    {permissions:['root']},{permissions:['jobs.read','jobs.read']},{permissions:null},{permissions:undefined},{script:3},{html:undefined},
    {css:undefined},{script:'\0'},{theme:{tokens:{}}},{script:'中'.repeat(WORKSHOP_PACKAGE_BYTES/2)}])
    assert.throws(()=>normalizeWorkshopPackage(plugin(extra)),status(400));
  assert.equal(normalizeWorkshopPackage(plugin({name:'中'.repeat(64)})).name.length,64);
  assert.throws(()=>normalizeWorkshopPackage({...theme(),description:' '.repeat(WORKSHOP_PACKAGE_BYTES)}),status(400));
  assert.throws(()=>normalizeWorkshopPackage(null),status(400));
});

test('publish, list and get expose only public author fields and immutable versions',t=>{
  const f=fixture(t),first=f.publish(),id=first.item.id;
  assert.equal(first.item.version,1);assert.deepEqual(first.item.author,{id:'alice-id',username:'alice',name:'alice'});
  const second=f.publish(theme({name:'第二版'}),{id});assert.equal(second.item.version,2);
  assert.equal(f.call('get',{id,version:1}).item.name,'深空');
  assert.equal(f.call('get',{id}).item.name,'第二版');
  assert.deepEqual(f.call('list').items.map(item=>[item.id,item.version]),[[id,2]]);
  const other=f.call('get',{id},'bob');assert.equal(other.item.canEdit,false);assert.equal(other.item.canRemove,false);
  assert.equal(f.call('get',{id},'admin').item.canEdit,false);assert.equal(f.call('get',{id},'admin').item.canRemove,true);
  assert.equal(JSON.stringify(f.call('list')).includes('DO_NOT_EXPOSE'),false);
  assert.throws(()=>f.publish(plugin(),{id}),status(400));
  assert.throws(()=>f.call('get',{id,version:3}),status(404));
});

test('publish keys recover original receipts without duplicate items, versions or substituted content',t=>{
  const f=fixture(t),key=randomUUID(),first=f.publish(theme(),{key});
  assert.equal(f.publish(theme(),{key}).duplicate,true);
  assert.equal(f.publish(theme(),{key}).item.id,first.item.id);
  f.publish(theme({name:'下一版'}),{id:first.item.id});
  assert.equal(f.publish(theme(),{key}).item.version,1);
  assert.throws(()=>f.publish(theme({name:'换内容'}),{key}),status(409));
  assert.throws(()=>f.publish(theme(),{key,id:first.item.id}),status(409));
  assert.notEqual(f.publish(theme(),{key},'bob').item.id,first.item.id);
  assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM workshop_versions').get().n,3);
  assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM workshop_items').get().n,2);
});

test('only original author updates; administrative removal does not grant edit or impersonation',t=>{
  const f=fixture(t),first=f.publish();
  for(const name of ['bob','admin'])assert.throws(()=>f.publish(theme(),{id:first.item.id},name),status(403));
  for(const extra of [{owner:'bob-id'},{author:{id:'bob-id'}},{userId:'bob-id'},{role:'admin'},{version:99}])
    assert.throws(()=>f.publish(theme(),extra),status(400));
  assert.throws(()=>f.call('remove',{id:first.item.id},'bob'),status(403));
  assert.throws(()=>f.call('publish',{package:theme()}),status(400));
  assert.throws(()=>f.call('get',{id:'../path'}),status(400));
});

test('installs pin exact versions and account choices; theme replacement never removes plugins',t=>{
  const f=fixture(t),first=f.publish(),panel=f.publish(plugin());
  f.install(first);f.install(first,'bob');f.install(panel);
  const update=f.publish(theme({name:'更新但不自动启用'}),{id:first.item.id});
  assert.equal(f.call('mine').installed.find(entry=>entry.item.id===first.item.id).item.version,1);
  f.install(update);assert.equal(f.call('mine').installed.find(entry=>entry.item.id===first.item.id).item.version,2);
  assert.equal(f.call('mine',{},'bob').installed[0].item.version,1);
  const other=f.publish(theme({name:'另一个主题'}));f.install(other);
  assert.deepEqual(new Set(f.call('mine').installed.map(entry=>entry.item.id)),new Set([other.item.id,panel.item.id]));
  assert.equal(f.call('mine',{},'bob').installed[0].item.id,first.item.id);
  assert.equal(f.service.store.jobs.length,0);
});

test('installation requires exact declared permissions and explicit existing integer version',t=>{
  const f=fixture(t),panel=f.publish(plugin({permissions:['resources.read','jobs.cancel']}));
  for(const permissions of [undefined,[],['jobs.cancel'],['resources.read','jobs.cancel','jobs.read'],['jobs.cancel','jobs.cancel']])
    assert.throws(()=>f.call('install',{id:panel.item.id,version:1,permissions}),status(400));
  for(const version of [undefined,0,'1',1.5])assert.throws(()=>f.call('install',{id:panel.item.id,version,permissions:panel.package.permissions}),status(400));
  assert.throws(()=>f.call('install',{id:panel.item.id,version:2,permissions:panel.package.permissions}),status(404));
  assert.deepEqual(f.call('mine').installed,[]);
  assert.equal(f.install(panel,'alice',['jobs.cancel','resources.read']).installed.length,1);
});

test('uninstall and reset are idempotent and only change current account choices',t=>{
  const f=fixture(t),skin=f.publish(),panel=f.publish(plugin());
  for(const who of ['alice','bob']){f.install(skin,who);f.install(panel,who);}
  assert.equal(f.call('uninstall',{id:panel.item.id}).installed.length,1);
  assert.equal(f.call('uninstall',{id:panel.item.id}).installed.length,1);
  assert.deepEqual(f.call('reset'),{installed:[]});assert.deepEqual(f.call('reset'),{installed:[]});
  assert.equal(f.call('mine',{},'bob').installed.length,2);assert.equal(f.call('list').items.length,2);
  assert.throws(()=>f.call('reset',{userId:'bob-id'}),status(400));
});

test('removal stops every installed version without deleting history or resurrecting old keys',t=>{
  const f=fixture(t),key=randomUUID(),panel=f.publish(plugin(),{key});
  f.install(panel);f.install(panel,'bob');const id=panel.item.id;
  assert.deepEqual(installedWorkshopPlugin(f.service,actors.alice,{id,version:1}),panel.package);
  assert.equal(f.call('remove',{id},'admin').removed,true);assert.equal(f.call('remove',{id}).removed,true);
  assert.deepEqual(f.call('list').items,[]);
  for(const who of ['alice','bob']){
    assert.deepEqual(f.call('mine',{},who).installed,[]);
    assert.throws(()=>installedWorkshopPlugin(f.service,actors[who],{id,version:1}),status(410));
    assert.throws(()=>f.install(panel,who),status(410));
  }
  assert.throws(()=>f.publish(plugin(),{key}),status(410));
  assert.throws(()=>f.publish(plugin(),{id}),status(410));
  assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM workshop_versions').get().n,1);
  assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM workshop_installs').get().n,2);
  assert.deepEqual(f.call('uninstall',{id}).installed,[]);
});

test('frame loading requires current account installation of that exact active plugin version',t=>{
  const f=fixture(t),panel=f.publish(plugin()),id=panel.item.id;
  assert.throws(()=>installedWorkshopPlugin(f.service,actors.alice,{id,version:1}),status(403));
  f.install(panel);assert.throws(()=>installedWorkshopPlugin(f.service,actors.bob,{id,version:1}),status(403));
  f.publish(plugin({name:'更新'}),{id});
  assert.throws(()=>installedWorkshopPlugin(f.service,actors.alice,{id,version:2}),status(403));
  const skin=f.publish();f.install(skin);
  assert.throws(()=>installedWorkshopPlugin(f.service,actors.alice,{id:skin.item.id,version:1}),status(403));
  f.call('uninstall',{id});assert.throws(()=>installedWorkshopPlugin(f.service,actors.alice,{id,version:1}),status(403));
});

test('zero GPU grants are allowed, but disabled accounts and stale roles cannot use workshop',t=>{
  const f=fixture(t),panel=f.publish(plugin());f.install(panel);
  const alice=f.service.store.users.find(user=>user.id==='alice-id');
  alice.enabled=false;
  for(const operation of ['list','mine','get','publish','install','uninstall','reset','remove'])
    assert.throws(()=>f.call(operation),status(403));
  assert.throws(()=>installedWorkshopPlugin(f.service,actors.alice,{id:panel.item.id,version:1}),status(403));
  alice.enabled=true;alice.role='admin';assert.throws(()=>f.call('list'),status(401));
  alice.role='member';alice.username='changed';assert.throws(()=>f.call('list'),status(401));
});

test('transaction failures roll back version receipts and theme replacement together',t=>{
  const f=fixture(t),skin=f.publish(),key=randomUUID();f.install(skin);
  const before=f.call('mine');
  f.service.audit=()=>{throw Error('audit unavailable');};
  assert.throws(()=>f.publish(theme({name:'失败'}),{key}),/audit unavailable/);
  assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM workshop_items').get().n,1);
  assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM workshop_versions').get().n,1);
  assert.throws(()=>f.call('reset'),/audit unavailable/);assert.deepEqual(f.call('mine'),before);
  f.service.audit=()=>{};const replacement=f.publish(theme({name:'替代'}));
  f.service.audit=()=>{throw Error('audit unavailable');};
  assert.throws(()=>f.install(replacement),/audit unavailable/);assert.deepEqual(f.call('mine'),before);
  f.service.audit=()=>{};assert.equal(f.publish(theme({name:'失败'}),{key}).duplicate,false);
});

test('unknown fields and operations reject without changing installations',t=>{
  const f=fixture(t),skin=f.publish();
  for(const operation of ['list','mine','get','publish','install','uninstall','reset','remove'])
    assert.throws(()=>f.call(operation,{owner:'alice-id'}),status(400));
  assert.throws(()=>f.call('execute',{id:skin.item.id}),status(400));
  assert.throws(()=>f.call('list',[]),status(400));assert.deepEqual(f.call('mine').installed,[]);
});

test('real Portal queue, sessions, lost receipt replay and installations survive reopen with no jobs or bridge calls',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-workshop-')),database=join(dir,'portal.sqlite'),bootstrap=join(dir,'bootstrap.json'),password='Local-Workshop-Test-Password!';
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  let bridgeCalls=0,service=await PortalService.open(database,bootstrap,undefined,async()=>{bridgeCalls++;throw Error('workshop must not call nodes');});
  t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});
  const admin=await service.login('admin',password),account=(await service.invoke(admin.token,'users.create',{username:'workshop-user',password})).result;
  const member=await service.login('workshop-user',password),args={key:randomUUID(),package:plugin()};
  assert.deepEqual(admin.state.frontendWorkshop,{version:1});
  assert.deepEqual(member.state.frontendWorkshop,{version:1});
  assert.deepEqual((await service.invoke(member.token,'state')).state.frontendWorkshop,{version:1});
  const before=service.db.prepare('SELECT data FROM portal_state').get().data;
  await assert.rejects(service.invoke('invalid','workshop.list'),status(401));
  const replies=await Promise.all(Array.from({length:4},()=>service.invoke(member.token,'workshop.publish',args)));
  assert.equal(new Set(replies.map(reply=>reply.result.item.id)).size,1);assert.equal(replies.filter(reply=>!reply.result.duplicate).length,1);
  const published=replies[0].result;
  await service.invoke(member.token,'workshop.install',{id:published.item.id,version:1,permissions:['jobs.read']});
  assert.equal(service.db.prepare('SELECT data FROM portal_state').get().data,before);
  assert.equal(JSON.stringify(service.db.prepare('SELECT * FROM audit').all()).includes(args.package.script),false);
  service.close();service=await PortalService.open(database);
  assert.deepEqual(service.state(service.principal(member.token)).frontendWorkshop,{version:1});
  const receipt=await service.invoke(member.token,'workshop.publish',args);
  assert.equal(receipt.result.item.id,published.item.id);assert.equal(receipt.result.duplicate,true);assert.equal(receipt.state,undefined);
  assert.equal((await service.invoke(member.token,'workshop.mine')).result.installed[0].item.id,published.item.id);
  assert.equal((await service.invoke(admin.token,'workshop.mine')).result.installed.length,0);
  assert.equal(service.store.jobs.length,0);assert.equal(bridgeCalls,0);
  await service.invoke(admin.token,'users.enabled',{userId:account.id,enabled:false});
  await assert.rejects(service.invoke(member.token,'workshop.mine'),status(401));
});
