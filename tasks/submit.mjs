import {MACHINES} from '../dist/model.js';
import {normalizeJobSubmission,createSubmittedJob,personalCardQuotaExempt} from '../job-submission.mjs';
import {selectMachine} from '../machine-selection.mjs';
import {nativeJobRequest} from '../native-task-metadata.mjs';
import {transferCall} from '../transfers.mjs';

export const priorityCapable=host=>host?.reachable===true&&host.gpuq?.connected===true&&Array.isArray(host.gpuq.capabilities)&&host.gpuq.capabilities.includes('priority-policy-v1')&&host.gpuq.capabilities.includes('preempt-idle-only-v1');
export const priorityRankCapable=host=>priorityCapable(host)&&host.gpuq.capabilities.includes('priority-rank-v1');
export const SUBMISSION_SAFE_WINDOW_MS=120000;
const SUBMISSION_CHECK_MESSAGE='正在确认节点状态（自动重查中）';
export const submissionError=job=>Date.now()-Date.parse(job.dispatchStartedAt||job.createdAt)>=SUBMISSION_SAFE_WINDOW_MS&&job.submissionReconciliation?.lastReason
  ?`节点尚未确认派发（${job.submissionReconciliation.lastReason}），正在自动核对。`:SUBMISSION_CHECK_MESSAGE;
export const submissionDelay=attempt=>Math.min(60000,15000*2**Math.min(2,attempt));

export async function firstDispatch(service,job,{usage,RANKS,fail}){
  if(job.after?.length){
    const dependencies=job.after.map(item=>service.store.jobs.find(row=>row.id===item.id));
    const failed=dependencies.find(row=>row&&(['FAILED','CANCELED'].includes(row.state)||row.schedulerState==='LOST'));
    if(failed){
      await service.enqueue(()=>{job.state='CANCELED';job.error=`依赖作业 ${failed.name} 失败/已取消，未运行`;job.queueReason=null;job.notSubmitted=true;job.dispatchPending=false;job.finishedAt=new Date().toISOString();service.save();});
      return null;
    }
    if(dependencies.some(row=>!row?.nodeJobId))return null;
    job.spec.after=dependencies.map(row=>row.nodeJobId);
  }
  if(job.spec.projectCopy){
    const user=service.store.get(job.userId),principal={userId:user.id,username:user.username,role:user.role};
    let result=await transferCall(service,principal,job.projectPreparation?'transfers.status':'transfers.create',
      job.projectPreparation?{id:job.id}:{key:job.id,kind:'copy',from:job.sourceMachine,machine:job.machine,
        reference:{project:job.project,ownerId:job.ownerId,environment:true,jobId:job.id}});
    if(result.state==='ABSENT')result=await transferCall(service,principal,'transfers.resume',{id:job.id});
    await service.enqueue(()=>{
      job.projectPreparation={id:job.id,state:result.state,...(result.error?{error:result.error}:{})};
      job.error=['FAILED','PAUSED'].includes(result.state)?`项目复制已暂停：${result.error||'传输中断'}。续传：gpuctl transfer resume ${job.id}`:null;
      service.save();
    });
    if(result.state!=='SUCCEEDED')return null;
    if(result.installed)await service.enqueue(()=>{delete job.spec.projectCopy;service.save();});
  }
  // Node writers retain the live disk guard. Do not repeat remote reads before dispatch.
  return service.enqueue(()=>{
    const current=service.store.jobs.find(j=>j.id===job.id);
    if(!current||service.closing||current.state!=='SUBMITTING'||current.cancelRequested||service.maintenanceFor?.(current.machine))return null;
    const user=service.store.get(current.userId),capacity=MACHINES.find(m=>m.id===current.machine)?.cards||0;
    if(!user.enabled||current.cards>capacity||!personalCardQuotaExempt(user)&&(!user.limits[current.machine]||current.cards>user.limits[current.machine]||current.cards>user.total))
      fail('首次派发前账号或机器授权已改变；未启动训练。',403,'SUBMISSION_AUTH_REVOKED');
    if(!personalCardQuotaExempt(user)){
      const local=usage(service.store.jobs,user.id,current.machine,current),total=usage(service.store.jobs,user.id,undefined,current);
      if(local>user.limits[current.machine]||total>user.total){
        current.queueReason=local>user.limits[current.machine]?`已占用 ${usage(service.store.jobs,user.id,current.machine)}/${user.limits[current.machine]} 张卡`:`已占用 ${usage(service.store.jobs,user.id)}/${user.total} 张卡`;
        current.error=null;service.save();return null;
      }
    }
    current.queueReason=null;
    current.dispatchPending=false;current.dispatchStartedAt=new Date().toISOString();delete current.dispatchFinishedAt;
    try{service.save();}catch(error){current.dispatchPending=true;throw error;}
    // Begin the attempt in the same serialized turn as admission, but return a
    // wrapped promise so slow remote I/O never holds the mutation queue. Persist
    // before sending: a lost reply or restart cannot reinterpret an attempt as
    // a safely retractable reservation or stop a possibly running experiment.
    return {dispatched:true,response:service.bridge(current.machine,'sync',nativeJobRequest(service,current))};
  });
}

export async function submitTask(service,principal,user,args,{fail,authorizedMachine,jobView,usage}){
  const operation='jobs.submit';
  // Only explicit admission refusals before persistence prove no submission.
  const rejectSubmission=(message,status)=>fail(message,status,status>=500?'TRAINING_ADMISSION_BUSY':'SUBMISSION_REJECTED');
  const request=normalizeJobSubmission(args,principal);
  const {project,explicit,minVramGiB:min}=request;
  const previous=service.store.jobs.find(j=>j.key===request.key);
  if(previous){
    return jobView(previous);
  }
  if(request.after?.length){
    const dependencies=request.after.map(id=>service.store.jobs.find(job=>job.id===id));
    if(dependencies.some(job=>!job))rejectSubmission('依赖作业不存在，请使用 gpuctl jobs 中的完整作业编号。',404);
    const machine=dependencies[0].machine;
    if(dependencies.some(job=>job.machine!==machine))rejectSubmission('依赖作业必须都在同一台服务器上。',400);
    if(!request.machineSelection&&request.machine!==machine)rejectSubmission('指定服务器与依赖作业所在服务器不一致，请选择 '+machine+' 或 auto。',400);
    request.machine=machine;request.after=dependencies.map(({id,name})=>({id,name}));
    delete request.machineSelection;delete request.sourceMachine;
  }
  if(request.cards>user.total)rejectSubmission('任务卡数超出跨机器用卡总额度。',409);
  if(request.machineSelection){
    try{Object.assign(request,await selectMachine(service,user,request,usage));}
    catch(error){error.code=error.status>=500?'TRAINING_ADMISSION_BUSY':'SUBMISSION_REJECTED';throw error;}
  }
  authorizedMachine(request.machine);
  if(request.cards>MACHINES.find(machine=>machine.id===request.machine).cards)rejectSubmission('申请卡数超过所选服务器的总卡数；未提交任务。',409);
  if(request.cards>user.limits[request.machine])rejectSubmission('任务卡数超出所选机器的用卡额度；不会自动切换服务器。',409);
  await service.refreshGPUQ();
  // Queue admission does not need a successful monitoring sample.
  // Keep the chosen node and policy; GPUQ decides when cards/VRAM are ready.
  const queued=(explicit?.mode??'queue')==='queue';
  if(!queued&&(!service.gpuq||service.gpuq.stale))rejectSubmission('机器状态已过期，暂不接受新任务。',503);
  const host=service.gpuq?.hosts.find(h=>h.id===request.machine);
  // Unknown monitoring may queue; a complete physical inventory still proves
  // that no card can ever satisfy this request, regardless of current load.
  if(host?.gpus?.length===MACHINES.find(machine=>machine.id===request.machine).cards&&
    host.gpus.every(g=>Number.isFinite(g.memoryTotalMiB)&&g.memoryTotalMiB>0)&&
    host.gpus.filter(g=>g.memoryTotalMiB>=min*1024-512).length<request.cards)
    rejectSubmission('所选机器不满足卡数/显存条件；不会自动切换服务器。',409);
  if(host?.gpuq?.observeOnly===true)rejectSubmission('所选服务器已设为仅观察，不接受训练。',409);
  if(request.placement){
    if(request.placement.gpuIndices.some(index=>index>=MACHINES.find(machine=>machine.id===request.machine).cards))rejectSubmission('指定显卡编号超过所选服务器的总卡数。',409);
    if(!queued){
      const selected=request.placement.gpuIndices.map(index=>host.gpus.find(g=>g.index===index));
      if(selected.some(g=>!g||g.memoryTotalMiB<min*1024-512)||request.placement.shared&&selected[0].memoryTotalMiB<request.placement.vramMiB)rejectSubmission('指定显卡不存在或不满足显存要求。',409);
    }
  }
  if(!queued&&(!host?.reachable||!host.gpuq.connected||host.gpus.filter(g=>g.memoryTotalMiB>=min*1024-512).length<request.cards))rejectSubmission('所选机器当前无法执行，或不满足卡数/显存条件；不会自动切换服务器。',409);
  const prioritySupported=true;
  if(service.maintenanceFor?.(request.machine))rejectSubmission('机器维护状态已改变；未提交训练。',409);
  const job=createSubmittedJob(request,user,prioritySupported),{id}=job;
  service.db.exec('BEGIN IMMEDIATE');
  try{service.store.jobs.push(job);service.save();service.audit(principal.username,operation,id,'reserved');service.db.exec('COMMIT');}
  catch(e){service.db.exec('ROLLBACK');service.store.jobs=service.store.jobs.filter(j=>j.id!==id);throw e;}
  setImmediate(()=>service.reconcile().catch(()=>{}));return jobView(job);
}
