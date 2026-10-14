import {selectFields} from './portal-request-validation.mjs';
// Presentation only: clients never supply owner, submit key, spec or submitter.
import {MACHINES} from './dist/model.js';
import {taskDescription} from './dist/task-metadata.js';
import {nativeJobSpec,nativeTaskPresentation} from './native-task-metadata.mjs';
const NODE=/^J[a-f0-9]{12}$/;
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
  const setting=operation==='tasks.display.set',allowed=['machine','nodeJobId',...(setting?['name','description']:[])];
  if(!['tasks.display.get','tasks.display.set'].includes(operation)||!args||typeof args!=='object'||Array.isArray(args)
      ||typeof args.nodeJobId!=='string'||!NODE.test(args.nodeJobId))fail('任务标签参数无效。');
  args=selectFields(args,allowed);
  if(setting){
    if(!Object.hasOwn(args,'name')||!Object.hasOwn(args,'description'))fail('请提供任务名称和描述。');
    if(!nativeTaskPresentation({name:args.name,description:args.description,submitter:{name:'验证',username:'validation'}}))fail('任务名称或描述格式无效。');
    args={...args,description:taskDescription(args.description)};
  }
  const principal=service.principal(token),actor=service.store.get(principal.userId);
  const matches=service.store.jobs.filter(j=>j.machine===args.machine&&j.nodeJobId===args.nodeJobId);
  const job=matches[0];
  const check=()=>{
    const current=service.principal(token);
    if(service.closing)fail('服务正在关闭，请稍后查询。',503);
    if(!MACHINES.some(m=>m.id===args.machine))fail('请选择列表中的服务器。');
    if(setting)service.assertMaintenanceAllowed?.(operation,args,current);
  };
  check();
  if(service.taskDisplayPending>=4)fail('任务标签正在读取，请稍后重试。',429);
  const key=args.machine+'|'+args.nodeJobId,lane=service.taskDisplayLanes.get(key)||{tail:Promise.resolve(),pending:0};
  if(lane.pending>=2)fail('同一任务的标签请求正在处理。',429);
  service.taskDisplayLanes.set(key,lane);lane.pending++;service.taskDisplayPending++;
  const run=lane.tail.then(async()=>{
    check();
    if(setting)await service.enqueue(()=>{check();service.audit(principal.username,operation,args.machine,args.nodeJobId);});
    check();
    const request={userId:actor.id,hostAdmin:actor.role==='admin',nodeJobId:args.nodeJobId,...(job?{job:nativeJobSpec(job)}:{}),
      ...(setting?{name:args.name,description:args.description}:{})};
    let result;try{result=await service.bridge(args.machine,operation,request);}finally{check();}
    if(!result||!nativeTaskPresentation(result.metadata))fail('任务标签暂不可用，请稍后读取同一任务。',502);
    // The bounded view bridges collector lag; the caller is already logged in.
    if(service.taskDisplayViews.size>=256&&!service.taskDisplayViews.has(key))service.taskDisplayViews.delete(service.taskDisplayViews.keys().next().value);
    if(result.binding?.name&&result.binding?.owner)service.taskDisplayViews.set(key,{metadata:result.metadata,binding:result.binding,observedAt:Date.now(),jobId:job?.id});
    return {protocol:result.protocol,nodeJobId:result.nodeJobId,available:result.available,name:result.name,description:result.description,revision:result.revision};
  });
  lane.tail=run.catch(()=>{});
  try{return await run;}finally{lane.pending--;service.taskDisplayPending--;if(!lane.pending)service.taskDisplayLanes.delete(key);}
}
