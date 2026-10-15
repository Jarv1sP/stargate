import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {createPortalServer} from '../portal-server.mjs';
const client={name:'gpuctl',protocol:2};
test('new CLI passes the one HTTP generation boundary; old CLI only receives the upgrade command',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'C2-round4-upgrade-')),bootstrap=join(dir,'bootstrap');
 await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Upgrade-Fixture-2026!'}),{mode:0o600});
 const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const origin='http://127.0.0.1:'+port,calls=[];
 const {server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,origin,secure:false,bridge:async(machine,operation,args)=>{calls.push({machine,operation,args});return {};}});
 clearInterval(service.executionTimer);await new Promise(r=>server.listen(port,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
 const post=async(path,body,headers={})=>{const res=await fetch(origin+'/api/'+path,{method:'POST',headers:{'content-type':'application/json',Connection:'close',...headers},body:JSON.stringify(body)});return {status:res.status,data:await res.json()};};
 const login=await post('login',{username:'admin',password:'Upgrade-Fixture-2026!',client});assert.equal(login.status,200);
 const bearer={Authorization:'Bearer '+login.data.token};
 assert.equal((await post('call',{operation:'state',args:{view:'summary'},client:{...client,extension:'ignored'}},bearer)).status,200);
 for(const old of [undefined,{name:'gpuctl',protocol:1}]){
  const result=await post('call',{operation:'state',args:{},client:old},bearer);
  assert.equal(result.status,426);assert.equal(result.data.code,'CLIENT_UPGRADE_REQUIRED');assert.match(result.data.error,/install.sh/);
  assert.equal((await post('login',{username:'admin',password:'Upgrade-Fixture-2026!',client:old})).status,426);
 }
 assert.equal(calls.length,0);
 assert.equal((await post('call',{operation:'state',args:{view:'summary'}},{Cookie:'team_session='+login.data.token,Origin:origin})).status,200);
 assert.equal((await post('call',{operation:'state',args:{},client},{Authorization:'Bearer '+'a'.repeat(64)})).status,401);
});
