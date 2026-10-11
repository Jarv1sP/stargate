import {authorizationPolicy,MACHINES} from './dist/model.js';
import {elasticCapable,placementCapable} from './dist/gpu-allocation.js';
import {yieldCapable} from './dist/scheduling-policy.js';
import {datasetCatalogCall} from './dataset-catalog.mjs';
import {personalCardQuotaExempt} from './job-submission.mjs';
import {trainingStoragePlan} from './training-storage.mjs';
import {resolveTrainingDataset} from './training-datasets.mjs';

const fail=(message,status=409)=>{throw Object.assign(Error(message),{status});};
const readyProbe=(value,project)=>value?.protocol==='portable-project-v1'&&value.enabled===true&&value.environmentMode==='oci'&&
  ['amd64','arm64'].includes(value.architecture)&&value.project===project.project&&value.release===project.release&&value.releaseReady===true&&/^sha256:[a-f0-9]{64}$/.test(value.image);

// Admission only: every operation here is read-only. A chosen target is stored
// with the job before project/data workers may start. Queuing never reselects it.
export async function selectMachine(service,user,request,priorityCapable,usage){
  if(!service.projectCopyProbe||!service.prepareProject)fail('跨机个人容器尚未启用；请先手选服务器。',503);
  const policy=authorizationPolicy(user),check=()=>{
    if(service.closing||authorizationPolicy(service.store.get(user.id))!==policy)fail('账号授权已改变，请重试；未提交训练。',403);
  };
  await service.refreshGPUQ();check();
  if(service.gpuq?.stale!==false)fail('机器状态已过期，暂不接受自动选机。',503);
  const hosts=service.gpuq.hosts;
  const authorized=MACHINES.filter(m=>user.limits[m.id]>0&&hosts.find(h=>h.id===m.id)?.reachable===true&&!service.maintenanceFor?.(m.id));
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
  let sourceUnconfirmed=false;
  const sources=(await Promise.all(authorized.map(async m=>{
    try{const probe=await service.projectCopyProbe(user.id,m.id,request.project);return readyProbe(probe,request.project)?{machine:m.id,probe}:null;}
    catch(error){if(error.status>=500)sourceUnconfirmed=true;return null;}
  }))).filter(Boolean);check();
  if(!sources.length&&sourceUnconfirmed)fail('项目版本查询暂未确认；未提交训练，请稍后重试。',503);
  if(!sources.length)fail('未找到可迁移的 READY 个人容器项目版本；请先发布项目。');
  const source=sources[0];
  if(sources.some(s=>s.probe.architecture!==source.probe.architecture||s.probe.image!==source.probe.image))fail('同一项目版本的镜像或架构信息不一致；请管理员核对，未提交训练。');
  const storageExcluded=[];
  const choices=(await Promise.all(eligible.map(async m=>{
    check();
    let local=sources.find(s=>s.machine===m.id),from=local?.machine;
    if(!local){
      for(const candidate of sources){
        try{const target=await service.projectCopyProbe(user.id,m.id,{project:request.project.project,from:candidate.machine});
          if(target?.protocol==='portable-project-v1'&&target.enabled===true&&target.environmentMode==='oci'&&target.project===request.project.project&&target.architecture===candidate.probe.architecture&&target.sources?.includes(candidate.machine)){from=candidate.machine;break;}
        }catch{}
      }
      if(!from)return null;
    }
    let localData=0,catalog;
    if(request.datasets.length){
      if(request.datasetReadMode==='warehouse'){
        // Explicit local HDD reads cannot select another server's original or
        // turn catalog cache readiness into a warehouse-capability assertion.
        for(const ref of request.datasets){
          try{
            const resolved=await resolveTrainingDataset(service,user.id,m.id,ref,'warehouse');
            if(resolved.status.state!=='READY'||!resolved.reference)return null;
            localData++;
          }catch{return null;}
        }
      }else{
        try{catalog=await datasetCatalogCall(service,{userId:user.id,username:user.username,role:user.role},'datasets.catalog',{machine:m.id});}catch{return null;}
        for(const ref of request.datasets){
          const value=catalog.datasets?.find(d=>d.dataset===ref.dataset)?.versions?.find(v=>v.version===ref.version);
          if(value?.canUse!==true)return null;
          if(value.state==='READY')localData++;
          else if(!value||!(value.canPrepare===true||value.state==='PREPARING'))return null;
        }
      }
    }
    let storagePlan;
    try{
      storagePlan=await trainingStoragePlan(service,user,m.id,request,{from,projectProbe:sources.find(s=>s.machine===from)?.probe,catalog});
    }catch(error){
      storageExcluded.push({machine:m.id,reason:error.code==='TRAINING_STORAGE_INSUFFICIENT'?'storage-insufficient':'storage-unverified'});
      return null;
    } // Unknown capacity/old protocol is not a fitting target.
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
    const notObserved=service.store.jobs.filter(j=>j.machine===m.id&&['PREPARING_DATA','SUBMITTING','PENDING','STARTING'].includes(j.state)&&
      !j.cancelRequested&&!queue.some(native=>native.id===j.nodeJobId));
    const pendingCards=notObserved.reduce((sum,j)=>sum+(j.cards||0),0);
    const quotaReady=personalCardQuotaExempt(user,request)||
      usage(service.store.jobs,user.id)+request.cards<=user.total&&usage(service.store.jobs,user.id,m.id)+request.cards<=user.limits[m.id];
    const freeEnough=freeCards-pendingCards>=minimum;
    return {machine:m.id,from,localProject:!!local,localData,waiting:waiting+notObserved.length,quotaReady,freeEnough,storagePlan};
  }))).filter(Boolean);check();
  if(!choices.length)fail('候选机器缺少兼容的项目复制通道、可读取的数据来源或已确认足够的项目／缓存卷容量；未提交训练。');
  // Prefer an admissible free pool even when its immutable project/data must
  // first be copied. If every compatible node is busy, retain normal queuing.
  // A later availability change never moves an already persisted job.
  choices.sort((a,b)=>Number(b.quotaReady)-Number(a.quotaReady)||Number(b.freeEnough)-Number(a.freeEnough)||
    (a.freeEnough&&b.freeEnough?a.waiting-b.waiting:0)||
    Number(b.localProject&&b.localData===request.datasets.length)-Number(a.localProject&&a.localData===request.datasets.length)||
    b.localData-a.localData||Number(b.localProject)-Number(a.localProject)||a.waiting-b.waiting||a.machine.localeCompare(b.machine));
  const chosen=choices[0];
  if(service.maintenanceFor?.(chosen.machine))fail('选中的服务器刚进入维护，请重新提交；未启动准备。');
  return {machine:chosen.machine,projectPreparation:{from:chosen.from,...request.project,state:chosen.localProject?'READY':'WAITING'},trainingStoragePlan:chosen.storagePlan,
    selectionSummary:{protocol:1,selectedMachine:chosen.machine,reason:'storage-fit-and-resource-rank',storageVerified:true,
      gpuPoolAvailable:chosen.freeEnough,queuedJobs:chosen.waiting,localProject:chosen.localProject,localDatasetCount:chosen.localData,
      observedAt:chosen.storagePlan.checkedAt,storageExcluded:storageExcluded.sort((a,b)=>a.machine.localeCompare(b.machine))}};
}
