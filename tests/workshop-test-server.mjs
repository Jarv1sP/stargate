// Actual Portal/SQLite/HTTP, isolated users and GPU telemetry; never real nodes.
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer as netServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/machines.js';
import {createSubmittedJob,normalizeJobSubmission} from '../job-submission.mjs';

export const themePackage={apiVersion:1,kind:'theme',name:'测试主题',description:'只改变当前账号界面',
  theme:{tokens:{'--bg':'#102030','--ink':'#f0f0f0'},density:'compact',width:'wide',columns:2}};
export const pluginPackage={apiVersion:1,kind:'plugin',name:'测试插件',description:'读取本人任务',
  permissions:['jobs.read'],html:'<pre id="result">loading</pre>',css:'body{color:#ddd;background:#111}',
  script:'stargate.call("jobs.read").then(data=>document.querySelector("#result").textContent=JSON.stringify(data));'};

export async function workshopTestServer(){
  const dir=await mkdtemp(join(tmpdir(),'stargate-workshop-'));
  const reserve=netServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));
  const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const origin='http://127.0.0.1:'+port,password='Workshop-Local-Fixture-Only-2026!';
  const bootstrap=join(dir,'bootstrap.json'),statusPath=join(dir,'status.json');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(statusPath,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({
    id:m.id,reachable:true,gpus:[{index:0,memoryTotalMiB:24576,memoryUsedMiB:1024,utilizationGpu:5,processes:[],processesAvailable:true}],
    gpuq:{connected:true,health:'ok',observeOnly:false,schedulableIndices:[0],jobs:[],capabilities:[]},
  }))}));
  let server,service;
  try{
    ({server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,statusPath,secure:false,origin,
      bridge:async(_machine,operation)=>{if(operation==='projects.list')return {projects:[],environmentModes:['oci']};throw Error('Unexpected node call: '+operation);}}));
    clearInterval(service.executionTimer);service.reconcile=async()=>{};
    await new Promise(r=>server.listen(port,'127.0.0.1',r));
    const admin=await service.login('admin',password);
    const make=async username=>{
      const user=(await service.invoke(admin.token,'users.create',{username,password})).result;
      await service.invoke(admin.token,'policy.save',{userId:user.id,policyVersion:0,total:2,limits:{[MACHINES[0].id]:2}});
      return {user:service.store.get(user.id),...(await service.login(username,password))};
    };
    const alice=await make('alice'),bob=await make('bob');
    const addJob=(account,name)=>{
      const request=normalizeJobSubmission({key:randomUUID(),machine:MACHINES[0].id,cards:1,name,argv:['python','fixture.py']},{role:'member'});
      const job=createSubmittedJob(request,account.user,false);
      Object.assign(job,{state:'RUNNING',nodeJobId:'J'+job.id.replaceAll('-','').slice(0,12),assignedIndices:[0]});
      service.store.jobs.push(job);return job;
    };
    const ownJob=addJob(alice,'alice training'),otherJob=addJob(bob,'bob private training');service.save();
    const call=async(token,operation,args={})=>{
      const response=await fetch(origin+'/api/call',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({operation,args})});
      return {response,body:await response.json()};
    };
    return {dir,server,service,origin,password,admin,alice,bob,ownJob,otherJob,call,
      close:async()=>{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}};
  }catch(error){if(server?.listening)await new Promise(r=>server.close(r));else if(service&&!service.closing)service.close();await rm(dir,{recursive:true,force:true});throw error;}
}
