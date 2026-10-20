import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {workshopTestServer,pluginPackage,themePackage} from './workshop-test-server.mjs';

test('real HTTP serves only the installed immutable plugin, with frame-specific isolation',async t=>{
  const f=await workshopTestServer();t.after(()=>f.close());
  const guide=await fetch(f.origin+'/guide/workshop');assert.equal(guide.status,200);assert.match(await guide.text(),/恢复默认/);
  const publish=await f.call(f.alice.token,'workshop.publish',{key:randomUUID(),package:pluginPackage});
  assert.equal(publish.response.status,200);const {item}=publish.body.result;
  const path=f.origin+`/workshop/frame/${item.id}/${item.version}`;
  const frame=(token,extra={})=>fetch(path,{headers:{...(token?{Authorization:'Bearer '+token}:{}),...extra}});
  assert.equal((await frame()).status,401);
  assert.notEqual((await frame(f.alice.token)).status,200,'publishing never installs or runs the author code');
  const install=await f.call(f.bob.token,'workshop.install',{id:item.id,version:item.version,permissions:pluginPackage.permissions});
  assert.equal(install.response.status,200);
  const response=await frame(f.bob.token),html=await response.text(),csp=response.headers.get('content-security-policy');
  assert.equal(response.status,200);assert.ok(html.includes('stargate'));
  assert.match(csp,/sandbox allow-scripts/);assert.doesNotMatch(csp,/allow-same-origin/);
  assert.match(csp,/default-src 'none'/);assert.match(csp,/connect-src 'none'/);
  assert.match(csp,/frame-ancestors 'self'/);assert.equal(response.headers.get('x-frame-options'),'SAMEORIGIN');
  assert.match(response.headers.get('cache-control'),/private.*no-store/);
  assert.equal(html.includes(f.alice.token)||html.includes(f.bob.token),false);
  assert.equal((await frame(f.bob.token,{Origin:'https://outside.invalid'})).status,403);
  const page=await fetch(f.origin+'/');
  assert.equal(page.headers.get('x-frame-options'),'DENY');
  assert.match(page.headers.get('content-security-policy'),/script-src 'self';/,'plugin support does not relax parent script policy');
  const newer=await f.call(f.alice.token,'workshop.publish',{id:item.id,key:randomUUID(),package:{...pluginPackage,name:'new version'}});
  assert.equal(newer.response.status,200);
  assert.equal((await frame(f.bob.token)).status,200,'installed original is still available');
  const uninstalledVersion=await fetch(f.origin+`/workshop/frame/${item.id}/${newer.body.result.item.version}`,{headers:{Authorization:'Bearer '+f.bob.token}});
  assert.notEqual(uninstalledVersion.status,200,'publishing an update does not silently enable it');
  await f.call(f.bob.token,'workshop.uninstall',{id:item.id});
  assert.notEqual((await frame(f.bob.token)).status,200);
  assert.equal(f.service.store.jobs.length,2);assert.equal(f.ownJob.cancelRequested,false);assert.equal(f.otherJob.cancelRequested,false);
});

test('theme never becomes an executable frame and disabled users cannot read packages',async t=>{
  const f=await workshopTestServer();t.after(()=>f.close());
  const published=await f.call(f.alice.token,'workshop.publish',{key:randomUUID(),package:themePackage});
  const {item}=published.body.result;
  await f.call(f.bob.token,'workshop.install',{id:item.id,version:item.version,permissions:[]});
  const frame=await fetch(f.origin+`/workshop/frame/${item.id}/${item.version}`,{headers:{Authorization:'Bearer '+f.bob.token}});
  assert.notEqual(frame.status,200);
  await f.service.invoke(f.admin.token,'users.enabled',{userId:f.bob.user.id,enabled:false});
  assert.equal((await f.call(f.bob.token,'workshop.mine')).response.status,401);
  const publicList=await fetch(f.origin+'/api/call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'workshop.list',args:{},client:{name:'gpuctl',protocol:2}})});
  assert.equal(publicList.status,401);
});
