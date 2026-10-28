import {MACHINES} from './dist/model.js';
import {personalCardQuotaExempt} from './job-submission.mjs';
import {availableMachines,assertMachineAccess} from './machine-access.mjs';

const fail=(message,status=409)=>{throw Object.assign(Error(message),{status});};
// Admission only: every operation here is read-only. A chosen target is stored
// with the job before project/data workers may start. Queuing never reselects it.
export async function selectMachine(service,user,request,usage){
  const check=()=>{if(service.closing||!service.store.get(user.id).enabled)fail('请重新登录。',403);};
  const machines=availableMachines(user,MACHINES),allowed=request.machineSelection.candidates;
  if(!machines.length)assertMachineAccess(user,undefined,MACHINES);
  if(allowed?.length&&!machines.some(machine=>allowed.includes(machine.id)))assertMachineAccess(user,allowed[0],MACHINES);
  await service.refreshGPUQ();check();
  if(service.gpuq?.stale!==false)fail('服务器状态暂未读到，请保留原提交编号稍后重试。',503);
  const hosts=service.gpuq.hosts;
  const authorized=machines.filter(m=>hosts.find(h=>h.id===m.id)?.reachable===true&&!service.maintenanceFor?.(m.id));
  const eligible=authorized.filter(m=>{
    const h=hosts.find(h=>h.id===m.id),gpus=h.gpus||[],q=h.gpuq;
    // schedulableIndices is the currently free pool, not healthy total
    // capacity: an empty pool can still accept queued/shared work. Health is
    // the authoritative node fence (including GPU/Xid recovery failures).
    if(allowed&&!allowed.includes(m.id)||user.limits[m.id]<request.cards||q?.connected!==true||q.health!=='ok'||q.observeOnly!==false||gpus.filter(g=>g.memoryTotalMiB>=request.minVramGiB*1024-512).length<request.cards)return false;
    if(request.placement){const selected=request.placement.gpuIndices.map(index=>gpus.find(g=>g.index===index));
      if(selected.some(g=>!g||g.memoryTotalMiB<request.minVramGiB*1024-512)||request.placement.shared&&selected[0].memoryTotalMiB<request.placement.vramMiB)return false;}
    return true;
  });
  if(!eligible.length)fail('没有已授权、健康且满足卡数、显存和调度能力的候选服务器。');
  const choices=eligible.map(m=>{
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
    const notObserved=service.store.jobs.filter(j=>j.machine===m.id&&['SUBMITTING','PENDING','STARTING'].includes(j.state)&&
      !j.cancelRequested&&!queue.some(native=>native.id===j.nodeJobId));
    const pendingCards=notObserved.reduce((sum,j)=>sum+(j.cards||0),0);
    const quotaReady=personalCardQuotaExempt(user,request)||
      usage(service.store.jobs,user.id,undefined,{...request,machine:m.id})<=user.total&&usage(service.store.jobs,user.id,m.id,{...request,machine:m.id})<=user.limits[m.id];
    const freeEnough=freeCards-pendingCards>=minimum;
    return {machine:m.id,waiting:waiting+notObserved.length,quotaReady,freeEnough};
  });
  choices.sort((a,b)=>Number(b.quotaReady)-Number(a.quotaReady)||Number(b.freeEnough)-Number(a.freeEnough)||
    a.waiting-b.waiting||a.machine.localeCompare(b.machine));
  const chosen=choices[0];
  if(service.maintenanceFor?.(chosen.machine))fail('选中的服务器维护中，请保留原提交编号稍后重试。');
  return {machine:chosen.machine,selectionSummary:{protocol:1,selectedMachine:chosen.machine,
    reason:'resource-rank',gpuPoolAvailable:chosen.freeEnough,queuedJobs:chosen.waiting}};
}
