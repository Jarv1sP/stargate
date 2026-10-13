import {authorizationPolicy,MACHINES} from './dist/model.js';
import {elasticCapable,placementCapable} from './dist/gpu-allocation.js';
import {yieldCapable} from './dist/scheduling-policy.js';
import {personalCardQuotaExempt} from './job-submission.mjs';

const fail=(message,status=409)=>{throw Object.assign(Error(message),{status});};
// Read-only ranking of existing workspaces, never copying or allocating GPUs.
// The task stores one target before node sync; queuing never reselects it.
export async function selectMachine({store,refreshGPUQ,bridge,maintenanceFor,isClosing},user,request,priorityCapable,usage){
  const policy=authorizationPolicy(user),check=()=>{
    if(isClosing?.()||authorizationPolicy(store.get(user.id))!==policy)fail('账号授权已改变，请重试；未提交训练。',403);
  };
  const gpuq=await refreshGPUQ();check();
  if(gpuq?.stale!==false)fail('机器状态已过期，暂不接受自动选机。',503);
  const hosts=gpuq.hosts;
  const authorized=MACHINES.filter(m=>user.limits[m.id]>0&&hosts.find(h=>h.id===m.id)?.reachable===true&&!maintenanceFor?.(m.id));
  const allowed=request.machineSelection.candidates;
  const eligible=authorized.filter(m=>{
    const h=hosts.find(h=>h.id===m.id),gpus=h.gpus||[],q=h.gpuq;
    // schedulableIndices is the currently free pool, not healthy total
    // capacity: an empty pool can still accept queued/shared work. Health is
    // the authoritative node fence (including GPU/Xid recovery failures).
    if(allowed&&!allowed.includes(m.id)||user.limits[m.id]<request.cards||q?.connected!==true||q.health!=='ok'||q.observeOnly!==false||gpus.filter(g=>g.memoryTotalMiB>=request.minVramGiB*1024-512).length<request.cards)return false;
    if(request.elastic&&!elasticCapable(h)||request.placement&&!placementCapable(h,request.placement))return false;
    if(request.placement){const selected=request.placement.gpuIndices.map(index=>gpus.find(g=>g.index===index));
      if(selected.some(g=>!g||g.memoryTotalMiB<request.minVramGiB*1024-512)||request.placement.shared&&selected[0].memoryTotalMiB<request.placement.vramMiB)return false;}
    if(request.priorityProvided&&!priorityCapable(h)||request.explicit&&(!priorityCapable(h)||!yieldCapable(h)))return false;
    return !(request.explicit?.mode&&request.explicit.mode!=='queue'&&!q.capabilities?.includes('preempt-opt-in-only-v1'));
  });
  if(!eligible.length)fail('没有已授权、健康且满足卡数、显存和调度能力的候选服务器。');
  const choices=(await Promise.all(eligible.map(async m=>{
    const local=await bridge(m.id,'projects.list',{userId:user.id});
    check();
    if(!local.projects?.some(p=>p.project===request.project.project&&p.environmentMode==='oci'))return null;
    const host=hosts.find(h=>h.id===m.id),queue=host.gpuq.jobs||[];
    const waiting=queue.filter(j=>['PENDING','STARTING'].includes(j.state)).length;
    // The scheduler's free pool excludes leases, reservations, quarantine and
    // external CUDA processes. Never infer availability from low utilization.
    const free=new Set((Array.isArray(host.gpuq.schedulableIndices)?host.gpuq.schedulableIndices:[]).filter(index=>Number.isSafeInteger(index)&&
      host.gpus.some(g=>g.index===index&&g.memoryTotalMiB>=request.minVramGiB*1024-512)));
    const selected=request.placement?.gpuIndices;
    const freeCards=selected?selected.filter(index=>free.has(index)).length:free.size;
    const minimum=request.allowedGpuCounts?.[0]??request.cards;
    // Submissions prepared since this collector snapshot are not free capacity.
    // This is only a conservative ranking hint, never a second GPU allocator.
    const notObserved=store.jobs.filter(j=>j.machine===m.id&&['PREPARING_DATA','SUBMITTING','PENDING','STARTING'].includes(j.state)&&
      !j.cancelRequested&&!queue.some(native=>native.id===j.nodeJobId));
    const pendingCards=notObserved.reduce((sum,j)=>sum+(j.cards||0),0);
    const quotaReady=personalCardQuotaExempt(user,request)||
      usage(store.jobs,user.id)+request.cards<=user.total&&usage(store.jobs,user.id,m.id)+request.cards<=user.limits[m.id];
    const freeEnough=freeCards-pendingCards>=minimum;
    return {machine:m.id,waiting:waiting+notObserved.length,quotaReady,freeEnough};
  }))).filter(Boolean);check();
  if(!choices.length)fail('候选服务器没有这个项目工作区；请先把工作区和所需数据传到目标机。');
  choices.sort((a,b)=>Number(b.quotaReady)-Number(a.quotaReady)||Number(b.freeEnough)-Number(a.freeEnough)||
    a.waiting-b.waiting||a.machine.localeCompare(b.machine));
  const chosen=choices[0];
  if(maintenanceFor?.(chosen.machine))fail('选中的服务器刚进入维护，请重新提交；未启动准备。');
  return {machine:chosen.machine,selectionSummary:{protocol:1,selectedMachine:chosen.machine,
    reason:'local-workspace-and-resource-rank',gpuPoolAvailable:chosen.freeEnough,queuedJobs:chosen.waiting}};
}
