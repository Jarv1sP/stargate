import {authorizationPolicy,MACHINES} from '../dist/model.js';
import {yieldCapable} from '../dist/scheduling-policy.js';
import {elasticCapable,placementCapable} from '../dist/gpu-allocation.js';
import {normalizeJobSubmission,createSubmittedJob,personalCardQuotaExempt} from '../job-submission.mjs';
import {selectMachine} from '../machine-selection.mjs';

export const SUBMISSION_CHECK_MESSAGE='正在确认节点状态（自动重查中）';
const rejectSubmission=(message,status)=>{throw Object.assign(Error(message),{status,code:'SUBMISSION_REJECTED'});};

/** Persist one task on an existing workspace. GPUQ owns its queue and allocation.
 * The caller serializes mutations; reconciliation sends only after this commit.
 */
export async function submitTask(principal,user,args,{
  store,db,save,audit,bridge,refreshGPUQ,ociProjectAdmission,maintenanceFor,isClosing,
  reconcile,priorityCapable,usage,
}){
  const request=normalizeJobSubmission(args,principal);
  const {project,explicit,digest,minVramGiB:min}=request;
  const previous=store.jobs.find(j=>j.userId===user.id&&j.key===request.key);
  if(previous){
    if(previous.digest!==digest)rejectSubmission('同一提交键不能用于不同任务。',409);
    if(previous.state==='FAILED'&&previous.notSubmitted===true&&previous.failureCode==='SUBMISSION_NOT_DISPATCHED'&&!previous.nodeJobId&&!previous.cancelRequested){
      previous.state='SUBMITTING';previous.dispatchPending=false;previous.error=SUBMISSION_CHECK_MESSAGE;
      delete previous.notSubmitted;delete previous.failureCode;delete previous.finishedAt;
      previous.submissionReconciliation={...previous.submissionReconciliation,state:'CHECKING',nextCheckAt:new Date(0).toISOString()};
      audit(principal.username,'jobs.submit',previous.id,'recover-confirmed-non-dispatch');save();
    }
    return previous;
  }
  if(store.jobs.length>=5000)rejectSubmission('任务历史达到归档上限，请联系管理员归档后提交。',503);
  if(request.cards>user.total)rejectSubmission('任务卡数超出跨机器用卡总额度。',409);
  if(request.machineSelection){
    try{Object.assign(request,await selectMachine({store,refreshGPUQ,bridge,maintenanceFor,isClosing},user,request,priorityCapable,usage));}
    catch(error){error.code='SUBMISSION_REJECTED';throw error;}
  }
  if(!MACHINES.some(m=>m.id===request.machine)||!user.limits[request.machine])
    throw Object.assign(Error('这台机器未授权。'),{status:403});
  await ociProjectAdmission?.(request.machine,user.id,project.project);
  const prepared=await bridge(request.machine,'projects.workspace',{project:project.project,userId:user.id});
  if(prepared?.project!==project.project||prepared.state!=='AVAILABLE'||prepared.workspace?.persistent!==true)
    rejectSubmission('项目工作区尚未准备完成，未占用 GPU。',409);
  if(request.cards>user.limits[request.machine])rejectSubmission('任务卡数超出所选机器的用卡额度；不会自动切换服务器。',409);
  const gpuq=await refreshGPUQ();
  if(!gpuq||gpuq.stale)rejectSubmission('机器状态已过期，暂不接受新任务。',503);
  const host=gpuq.hosts.find(h=>h.id===request.machine);
  if(request.elastic&&!elasticCapable(host))rejectSubmission('节点未确认弹性分配和训练控制通道，未提交任务。',503);
  if(request.placement){
    if(!placementCapable(host,request.placement))rejectSubmission('节点尚未确认指定显卡/共享或 HAMi 能力，未提交任务。',503);
    const selected=request.placement.gpuIndices.map(index=>host.gpus.find(g=>g.index===index));
    if(selected.some(g=>!g||g.memoryTotalMiB<min*1024-512)||request.placement.shared&&selected[0].memoryTotalMiB<request.placement.vramMiB)rejectSubmission('指定显卡不存在或不满足显存要求。',409);
  }
  if(!host?.reachable||!host.gpuq.connected||host.gpuq.observeOnly||host.gpus.filter(g=>g.memoryTotalMiB>=min*1024-512).length<request.cards)rejectSubmission('所选机器当前无法执行，或不满足卡数/显存条件；不会自动切换服务器。',409);
  const prioritySupported=priorityCapable(host);
  if(explicit&&(!prioritySupported||!yieldCapable(host)))rejectSubmission('节点未接通独立让位与 checkpoint 控制通道；未提交任务。',503);
  if(explicit?.mode&&explicit.mode!=='queue'&&!host.gpuq.capabilities.includes('preempt-opt-in-only-v1'))rejectSubmission('节点尚未接通请求模式的主动让位范围限制。',503);
  if(request.priorityProvided&&!prioritySupported)rejectSubmission('所选机器尚未确认安全优先级功能，未提交任务；请刷新或联系管理员升级。',503);
  if(authorizationPolicy(store.get(user.id))!==authorizationPolicy(user)||maintenanceFor?.(request.machine))
    rejectSubmission('账号授权或机器维护状态已改变；未提交训练。',409);
  if(!personalCardQuotaExempt(user,request)){
    if(usage(store.jobs,user.id)+request.cards>user.total)rejectSubmission('超出跨机器用卡总额度。',409);
    if(usage(store.jobs,user.id,request.machine)+request.cards>user.limits[request.machine])rejectSubmission('超出所选机器的用卡额度。',409);
  }
  const job=createSubmittedJob(request,user,prioritySupported),{id}=job;
  db.exec('BEGIN IMMEDIATE');
  try{store.jobs.push(job);save();audit(principal.username,'jobs.submit',id,'reserved');db.exec('COMMIT');}
  catch(error){db.exec('ROLLBACK');store.jobs=store.jobs.filter(j=>j.id!==id);throw error;}
  setImmediate(()=>reconcile().catch(()=>{}));
  return job;
}
