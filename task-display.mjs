// Presentation only: clients never supply owner, submit key, spec or submitter.
import {authorizationPolicy,MACHINES} from './dist/model.js';
import {createHash} from 'node:crypto';
import {nativeTaskDisplay,taskDescription} from './dist/task-metadata.js';
import {nativeTaskPresentation} from './native-task-metadata.mjs';
const NODE=/^J[a-f0-9]{12}$/,REVISION=/^[a-f0-9]{64}$/;
const displayRevision=value=>createHash('sha256').update(JSON.stringify({description:value.description,name:value.name,submitter:{name:value.submitter.name,username:value.submitter.username}})).digest('hex');
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
export function installTaskDisplay(service){
  service.taskDisplayLanes=new Map();service.taskDisplayPending=0;service.taskDisplayViews=new Map();
  service.taskDisplaySnapshot=snapshot=>{
    if(snapshot.stale!==false)return snapshot;
    const checked=Date.parse(snapshot.checkedAt),now=Date.now(),views=service.taskDisplayViews;
    return {...snapshot,hosts:snapshot.hosts.map(host=>{
      let changed=false;
      const jobs=(host.gpuq?.jobs||[]).map(native=>{
        const key=host.id+'|'+native.id,row=views.get(key);if(!row)return native;
        if(now-row.observedAt>180000||checked>row.observedAt){views.delete(key);return native;}
        if(native.name!==row.binding.name||native.owner!==row.binding.owner||host.gpuq.jobs.filter(j=>j.id===native.id).length!==1)return native;
        changed=true;return {...native,display_metadata:row.metadata};
      });
      return changed?{...host,gpuq:{...host.gpuq,jobs}}:host;
    })};
  };
  service.taskDisplayJob=job=>{
    const row=service.taskDisplayViews.get(job.machine+'|'+job.nodeJobId);
    return row&&row.jobId===job.id&&Date.now()-row.observedAt<=180000?{...job,nativeTaskDisplay:row.metadata}:job;
  };
}
export async function taskDisplayCall(service,token,operation,args){
  const setting=operation==='tasks.display.set',allowed=['machine','nodeJobId',...(setting?['name','description','revision']:[])];
  if(!['tasks.display.get','tasks.display.set'].includes(operation)||!args||typeof args!=='object'||Array.isArray(args)
      ||Object.keys(args).some(k=>!allowed.includes(k))||typeof args.nodeJobId!=='string'||!NODE.test(args.nodeJobId))fail('任务标签参数无效。');
  if(setting){
    if(!Object.hasOwn(args,'name')||!Object.hasOwn(args,'description')||typeof args.revision!=='string'||!REVISION.test(args.revision))fail('先读取原任务的显示版本，再提供名称和描述。');
    if(!nativeTaskPresentation({name:args.name,description:args.description,submitter:{name:'验证',username:'validation'}}))fail('任务名称或描述格式无效。');
    args={...args,description:taskDescription(args.description)};
  }
  const principal=service.principal(token),actor=service.store.get(principal.userId),policy=authorizationPolicy(actor);
  const matches=service.store.jobs.filter(j=>j.machine===args.machine&&j.nodeJobId===args.nodeJobId);
  if(matches.length>1)fail('任务关联不明确，不能编辑。',409);
  const job=matches[0],original=job?JSON.stringify({id:job.id,machine:job.machine,nodeJobId:job.nodeJobId,userId:job.userId,spec:job.spec}):null;
  const check=()=>{
    const current=service.principal(token),user=service.store.get(current.userId);
    if(service.closing||current.userId!==principal.userId||current.username!==principal.username||current.role!==principal.role||authorizationPolicy(user)!==policy)fail('账号授权已改变，请重新读取任务。',403);
    if(!user.enabled||!MACHINES.some(m=>m.id===args.machine)||!user.limits[args.machine])fail('这台机器未授权。',403);
    const now=service.store.jobs.filter(j=>j.machine===args.machine&&j.nodeJobId===args.nodeJobId);
    if(now.length!==matches.length||job&&(now[0]!==job||JSON.stringify({id:job.id,machine:job.machine,nodeJobId:job.nodeJobId,userId:job.userId,spec:job.spec})!==original))fail('原任务关联已改变，请重新读取。',409);
    if(job?job.userId!==user.id&&user.role!=='admin':user.role!=='admin')fail('只能查看和编辑本人任务；未关联任务仅管理员可用。',403);
    if(setting)service.assertMaintenanceAllowed?.(operation,args,current);
  };
  check();
  const host=service.gpuq?.hosts.find(h=>h.id===args.machine);
  if(service.gpuq?.stale!==false||host?.reachable!==true||host.gpuq?.connected!==true||!Array.isArray(host.gpuq.capabilities)||!host.gpuq.capabilities.includes('console-task-display-edit-v1')){
    if(setting)fail('节点尚未确认安全编辑能力，未修改任务。',503);
    return {protocol:'task-display-edit-v1',nodeJobId:args.nodeJobId,available:false,reason:'NODE_CAPABILITY_UNCONFIRMED'};
  }
  if(service.taskDisplayPending>=4)fail('任务标签正在读取，请稍后重试。',429);
  const key=args.machine+'|'+args.nodeJobId,lane=service.taskDisplayLanes.get(key)||{tail:Promise.resolve(),pending:0};
  if(lane.pending>=2)fail('同一任务的标签请求正在处理。',429);
  service.taskDisplayLanes.set(key,lane);lane.pending++;service.taskDisplayPending++;
  const run=lane.tail.then(async()=>{
    check();
    if(setting)await service.enqueue(()=>{check();service.audit(principal.username,operation,args.machine,args.nodeJobId);});
    check();
    const request={userId:actor.id,hostAdmin:actor.role==='admin',nodeJobId:args.nodeJobId,...(job?{job:job.spec}:{}),
      ...(setting?{name:args.name,description:args.description,revision:args.revision}:{})};
    let result;try{result=await service.bridge(args.machine,operation,request);}finally{check();}
    if(!result||result.protocol!=='task-display-edit-v1'||result.nodeJobId!==args.nodeJobId||typeof result.available!=='boolean'
        ||typeof result.revision!=='string'||!REVISION.test(result.revision)||!nativeTaskPresentation(result.metadata)
        ||result.metadata.name!==result.name||result.metadata.description!==result.description
        ||!result.binding||Object.keys(result.binding).sort().join(',')!=='name,owner,submitKey'
        ||typeof result.binding.name!=='string'||typeof result.binding.owner!=='string'||typeof result.binding.submitKey!=='string'
        ||job&&(!nativeTaskDisplay(result.metadata,job.username)||result.binding.submitKey!==job.id||result.binding.name!=='portal-'+job.id.slice(0,8)
          ||result.binding.owner!==(typeof job.username==='string'&&/^[a-z][a-z0-9_-]{1,23}$/.test(job.username)?job.username:'portal-'+createHash('sha256').update(job.userId).digest('hex').slice(0,24)))
        ||setting&&(!result.available||result.name!==args.name||result.description!==args.description||result.revision!==displayRevision(result.metadata)))fail('标签结果未确认，请查询同一任务；不要自动重发修改。',502);
    // A bounded verified view bridges collector lag only, never authorization.
    if(service.taskDisplayViews.size>=256&&!service.taskDisplayViews.has(key))service.taskDisplayViews.delete(service.taskDisplayViews.keys().next().value);
    service.taskDisplayViews.set(key,{metadata:result.metadata,binding:result.binding,observedAt:Date.now(),jobId:job?.id});
    return {protocol:result.protocol,nodeJobId:result.nodeJobId,available:result.available,name:result.name,description:result.description,revision:result.revision};
  });
  lane.tail=run.catch(()=>{});
  try{return await run;}finally{lane.pending--;service.taskDisplayPending--;if(!lane.pending)service.taskDisplayLanes.delete(key);}
}
