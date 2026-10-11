import {archiveUploadSpecification} from './dist/dataset-upload.js';
import net from 'node:net';
import {MACHINES} from './dist/model.js';
import {taskIdentity,nativeTaskDisplay} from './dist/task-metadata.js';
import {nativeJobRequest} from './native-task-metadata.mjs';
import {applyJobFeedback,jobTiming} from './dist/job-progress.js';
import {maintainTaskNotes} from './community.mjs';
import {projectCall,projectReference,validateProjectFile,UUID} from './projects.mjs';
import {yieldCapable} from './dist/scheduling-policy.js';
import {normalizeJobSubmission,createSubmittedJob,datasetReferences,personalCardQuotaExempt} from './job-submission.mjs';
import {snapshotSyncCall} from './snapshot-sync.mjs';
import {elasticCapable,placementCapable} from './dist/gpu-allocation.js';
import {datasetCatalogCall,datasetListView,createDatasetRemovalGuard} from './dataset-catalog.mjs';
import {datasetStorageOverviewCall} from './dataset-storage-overview.mjs';
import {datasetFilesCall} from './dataset-files.mjs';
import {DATA_PREPARING,advanceDataPreparation,releaseDataPreparation} from './dataset-preparation.mjs';
import {installDatasetReplication} from './dataset-replication.mjs';
import {selectMachine} from './machine-selection.mjs';
import {resolveTrainingDataset,trainingDatasetCapabilities} from './training-datasets.mjs';
import {trainingStoragePlan} from './training-storage.mjs';
import {terminalNativeObservation,unavailableObservation,portalTerminalSnapshot,jobCompletion} from './job-observation.mjs';
export {datasetReferences} from './job-submission.mjs';

export const TERMINAL=new Set(['SUCCEEDED','FAILED','CANCELED']);
export const PRIORITIES=new Set(['idle','normal','high']);
const DISPLAY_OPERATIONS=new Set(['datasets.overview','datasets.catalog','datasets.capacity','datasets.list','datasets.files.list','files.list','storage.usage.mine','storage.usage.users']);
const DISPLAY_NODE_OPERATIONS=new Set(['datasets.list','datasets.capacity','datasets.files.list','files.list']);
const displayServices=new WeakMap();
export function displayReadService(service,operation){
  if(!DISPLAY_OPERATIONS.has(operation)||typeof service.displayBridge!=='function')return service;
  let record=displayServices.get(service);
  if(!record||record.displayBridge!==service.displayBridge){
    const view=Object.create(service),displayBridge=service.displayBridge;
    view.bridge=(machine,nodeOperation,args)=>DISPLAY_NODE_OPERATIONS.has(nodeOperation)
      ?displayBridge.call(service,machine,nodeOperation,args)
      :service.bridge(machine,nodeOperation,args);
    record={view,displayBridge};displayServices.set(service,record);
  }
  // Reuse the view so bounded observation caches retain their normal TTL.
  // Only an explicit display request selects it; mutation dependency reads
  // remain on the authoritative executor even when their node op is a list.
  return record.view;
}
const fail=(message,status=400,code)=>{throw Object.assign(Error(message),{status,...(code?{code}:{})});};
export const priorityCapable=host=>host?.reachable===true&&host.gpuq?.connected===true&&Array.isArray(host.gpuq.capabilities)&&host.gpuq.capabilities.includes('priority-policy-v1')&&host.gpuq.capabilities.includes('preempt-idle-only-v1');
export const priorityRankCapable=host=>priorityCapable(host)&&host.gpuq.capabilities.includes('priority-rank-v1');
const RANKS={idle:0,normal:2,high:4,P0:0,P1:1,P2:2,P3:3,P4:4};
function rankValue(value){if(typeof value!=='string'||!Object.hasOwn(RANKS,value))fail('排队优先级必须为 P0–P4（或 idle/normal/high）。');return value;}
function priorityValue(value){if(!PRIORITIES.has(value))fail('优先级必须为 idle、normal 或 high。');return value;}
export function schedulerResult(job,result){
  if(result.displaySync&&['SYNCED','PRESERVED','UNAVAILABLE','LEGACY'].includes(result.displaySync.state))
    job.nativeDisplay={state:result.displaySync.state,...(typeof result.displaySync.error==='string'?{error:result.displaySync.error.slice(0,200)}:{})};
  if(result.displaySync?.state==='PRESERVED'){
    const display=nativeTaskDisplay(result.displaySync.metadata,job.spec?.username);
    if(display)job.nativeTaskDisplay=display;
  }
  if(result.displaySync?.state==='SYNCED')delete job.nativeTaskDisplay;
  job.nodeJobId=result.nodeJobId||job.nodeJobId;
  job.state=['PENDING','STARTING','RUNNING','PREEMPTING',...TERMINAL].includes(result.state)?result.state:'UNKNOWN';
  job.assignedIndices=result.assignedIndices||[];job.error=result.error||null;job.checkedAt=new Date().toISOString();
  if(result.notSubmitted===true&&job.state==='FAILED'){
    job.notSubmitted=true;
    job.failureCode=typeof result.failureCode==='string'?result.failureCode.slice(0,80):null;
  }
  job.actualCards=job.assignedIndices.length;
  job.schedulerState=typeof result.schedulerState==='string'?result.schedulerState:result.state;
  job.queueReason=typeof result.queueReason==='string'?result.queueReason.slice(0,400):null;
  job.schedulerCheckedAt=job.checkedAt;
  job.schedulerPriority=Number.isInteger(result.schedulerPriority)?result.schedulerPriority:null;
  job.priority=typeof result.priority==='string'&&Object.hasOwn(RANKS,result.priority)?result.priority:null;
  job.schedulerPolicy=result.schedulerPolicy||null;
  job.priorityMutable=result.priorityMutable===true;
  job.preempted=result.preempted===true;
  applyJobFeedback(job,result);
  if(TERMINAL.has(job.state))job.finishedAt||=job.checkedAt;
}
function persistSchedulerResult(service,job,result){
  const before=structuredClone(job);
  try{schedulerResult(job,result);service.save();}
  catch(error){
    for(const key of Object.keys(job))if(!Object.hasOwn(before,key))delete job[key];
    Object.assign(job,before);throw error;
  }
}
async function firstDispatch(service,job){
  // Only new records with this durable marker are known never to have reached
  // a node. Legacy/attempted/unknown jobs must keep their existing sync path.
  let storagePlan,storageSnapshot;
  if(job.trainingStoragePlan){
    const user=service.store.get(job.userId);
    storageSnapshot=JSON.stringify({digest:job.digest,spec:job.spec,policyRevision:job.policyRevision||0});
    // Capacity I/O must not hold the global mutation queue. Recheck the fixed
    // target immediately before its first attempt, then fence the observation
    // against cancellation, identity changes and expiry in the serialized turn.
    storagePlan=await trainingStoragePlan(service,user,job.machine,{
      project:job.project?{project:job.project,release:job.release}:{},
      datasets:job.datasets||[],datasetReadMode:job.datasetReadMode,
    });
  }
  return service.enqueue(()=>{
    const current=service.store.jobs.find(j=>j.id===job.id);
    if(!current||service.closing||current.state!=='SUBMITTING'||current.cancelRequested||service.maintenanceFor?.(current.machine))return null;
    const user=service.store.get(current.userId),capacity=MACHINES.find(m=>m.id===current.machine)?.cards||0;
    if(!user.enabled||!user.limits[current.machine]||current.cards>user.limits[current.machine]||current.cards>user.total||current.cards>capacity)
      throw Error('首次派发前账号或机器授权已改变；未启动训练，请恢复授权或取消任务。');
    if(user.role!=='admin'&&(current.spec.priority==='high'||RANKS[current.spec.scheduling?.rank]>2))
      throw Error('首次派发前管理员角色已改变；P3/P4 任务未启动，请取消后重新提交。');
    if(!personalCardQuotaExempt(user)&&(usage(service.store.jobs,user.id)>user.total||usage(service.store.jobs,user.id,current.machine)>user.limits[current.machine]))
      throw Error('首次派发等待个人可用卡数额度；未启动训练，请等待已有任务释放或取消多余任务。');
    if(storagePlan&&(JSON.stringify({digest:current.digest,spec:current.spec,policyRevision:current.policyRevision||0})!==storageSnapshot||
       Date.now()-Date.parse(storagePlan.checkedAt)>30000))throw Error('首次派发前容量核验已过期或任务已改变；未启动训练。');
    if(storagePlan)current.trainingStoragePlan=storagePlan;
    current.dispatchPending=false;
    try{service.save();}catch(error){current.dispatchPending=true;throw error;}
    // Begin the attempt in the same serialized turn as admission, but return a
    // wrapped promise so slow remote I/O never holds the mutation queue. Persist
    // before sending: a lost reply or restart cannot reinterpret an attempt as
    // a safely retractable reservation or stop a possibly running experiment.
    return {response:service.bridge(current.machine,'sync',nativeJobRequest(service,current))};
  });
}
export function bridgeClient(socketPath){
  return (machine,operation,args)=>new Promise((resolve,reject)=>{
    const socket=net.createConnection(socketPath);let raw='',settled=false;
    let timer;
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(result);};
    const unavailable=()=>Object.assign(Error('节点执行桥暂时不可用；操作结果未确认，请查询原任务状态。'),{status:503,code:'EXECUTOR_UNAVAILABLE'});
    const timeout=()=>Object.assign(Error('节点响应超时；操作结果未确认，请查询原任务状态。'),{status:504,code:'EXECUTOR_TIMEOUT'});
    // A bridge restart is infrastructure unavailability, not a bad user
    // request. Never reconnect/replay here: input or a mutation may be sent.
    // This is an elapsed deadline, not merely an inactivity timeout: partial
    // bytes cannot keep an abandoned remote query alive indefinitely.
    timer=setTimeout(()=>socket.destroy(timeout()),32000);
    socket.setTimeout(32000,()=>socket.destroy(timeout()));
    socket.on('connect',()=>socket.end(JSON.stringify({machine,operation,args})+'\n'));
    socket.on('data',part=>{raw+=part;if(Buffer.byteLength(raw)>2_000_000)socket.destroy(Object.assign(Error('节点执行桥响应过大；操作结果未确认。'),{status:502}));});
    socket.on('error',error=>finish(Number.isInteger(error.status)?error:unavailable()));
    socket.on('end',()=>{
      if(!raw)return finish(unavailable());
      let data;
      try{data=JSON.parse(raw);if(!data||typeof data!=='object'||Array.isArray(data)||typeof data.ok!=='boolean')throw Error();}
      catch{return finish(Object.assign(Error('节点执行桥响应不完整；操作结果未确认。'),{status:502}));}
      // Native domain refusals keep their existing semantics, never become a
      // transient transport error and never trigger an implicit second write.
      if(!data.ok){
        if(['storage.training.plan','datasets.training.status'].includes(operation)&&data.code==='TRAINING_ADMISSION_BUSY'&&data.status===503)
          return finish(Object.assign(Error('数据正在使用，请稍后用原提交键重试；未提交训练。'),{status:503,code:'TRAINING_ADMISSION_BUSY'}));
        const transports={NODE_TRANSPORT_BUSY:[503,'节点连接查询繁忙；请稍后查询原状态。'],NODE_CONNECT_FAILED:[503,'节点连接暂时失败；操作结果未确认，请查询原状态。'],NODE_RESPONSE_TIMEOUT:[504,'节点处理超时；操作结果未确认，请查询原状态。'],NODE_SSH_AUTH_FAILED:[502,'节点 SSH 身份校验失败，请联系管理员；原操作不会自动重派。'],NODE_SSH_HOSTKEY_FAILED:[502,'节点 SSH 主机密钥校验失败，请联系管理员；原操作不会自动重派。'],NODE_RESPONSE_INVALID:[502,'节点响应协议异常；操作结果未确认，请查询原状态。']};
        const known=Object.hasOwn(transports,data.code)?transports[data.code]:null;
        if(known&&data.status===known[0])return finish(Object.assign(Error(known[1]),{status:known[0],code:data.code}));
        // A fixed training entry can fail before invoking the operation. Its
        // explicit uncertainty is not proof that a published release is absent.
        if(data.outcomeUnconfirmed===true)return finish(Object.assign(Error('节点操作结果未确认，请稍后查询原状态；不会自动重试。'),{status:503,code:'EXECUTOR_UNCONFIRMED'}));
        return finish(Error(data.error||'节点操作失败'));
      }
      finish(null,data.result);
    });
    socket.on('close',()=>{if(!settled)finish(unavailable());});
  });
}
export function installExecution(service,bridge){
  service.bridge=bridge;service.executionEnabled=!!bridge;service.reconciling=false;
  installDatasetReplication(service);
  let cycle=null;
  const kind=job=>job.cancelRequested&&!TERMINAL.has(job.state)?'cancel':job.state==='SUBMITTING'&&job.dispatchPending===true?'first':'observe';
  const eligible=(job,maintained)=>(!TERMINAL.has(job.state)||job.dataPreparationHold&&job.dataPreparationHold.state!=='RELEASED')&&
    (TERMINAL.has(job.state)||!maintained||job.cancelRequested);
  const step=async job=>{
    if(TERMINAL.has(job.state)){try{await releaseDataPreparation(service,job);}catch{}return;}
    const policyRevision=job.policyRevision||0;
    try{
      if(job.state===DATA_PREPARING){await advanceDataPreparation(service,job,usage);return;}
      const action=job.cancelRequested?'cancel':'sync';
      const attempt=action==='sync'&&job.state==='SUBMITTING'&&job.dispatchPending===true?await firstDispatch(service,job):{response:service.bridge(job.machine,action,nativeJobRequest(service,job))};
      if(!attempt)return;
      const result=await attempt.response;
      await service.enqueue(()=>{
        const current=service.store.jobs.find(j=>j.id===job.id);if(!current||service.closing||TERMINAL.has(current.state)||(current.policyRevision||0)!==policyRevision)return;
        // LOST/unknown remains nonterminal: retain quota until confirmed.
        persistSchedulerResult(service,current,result);maintainTaskNotes(service);
      });
      if(TERMINAL.has(job.state))await releaseDataPreparation(service,job);
    }catch(e){await service.enqueue(()=>{const current=service.store.jobs.find(j=>j.id===job.id);if(current&&!service.closing&&!TERMINAL.has(current.state)&&(current.policyRevision||0)===policyRevision){current.error=String(e.message).slice(0,200);current.checkedAt=new Date().toISOString();service.save();}});}
  };
  const pump=()=>{
    const current=cycle;if(!current)return;
    // Reserve one lane per machine for first dispatch/cancel and one for old
    // observations. New jobs can enter an active pass; neither a slow other
    // host nor a backlog of old polls consumes their reserved lane. There is
    // never more than one operation per job or two per configured machine.
    try{if(!service.closing&&!current.error)for(const machine of MACHINES){
      if(current.slots.has(machine.id+':urgent')&&current.slots.has(machine.id+':observe'))continue;
      // Maintenance may read persistent state. Check once per available host,
      // not again for every already-seen job in each queue scan.
      const maintained=service.maintenanceFor?.(machine.id);
      for(const lane of ['urgent','observe']){
      const slot=machine.id+':'+lane;if(current.slots.has(slot))continue;
      const job=service.store.jobs.find(job=>job.machine===machine.id&&!current.active.has(job.id)&&
        !current.seen.has(job.id+':'+kind(job))&&(lane==='urgent'?kind(job)!=='observe':kind(job)==='observe')&&eligible(job,maintained));
      if(!job)continue;
      const operationKind=kind(job);
      current.seen.add(job.id+':'+operationKind);
      // A first attempt already observes the job. Do not immediately sync it
      // again in the background lane, including after a lost first reply.
      current.seen.add(job.id+':observe');
      // Preserve the separate preparation/promotion and dispatch turns. A
      // later kick may admit that newly prepared job even while other hosts
      // are still busy, but completion alone never collapses the two stages.
      if(job.state===DATA_PREPARING){current.seen.add(job.id+':first');current.preparations.add(job.id);}
      current.active.add(job.id);current.slots.add(slot);
      step(job).catch(error=>{current.error||=error;}).finally(()=>{
        current.active.delete(job.id);current.slots.delete(slot);pump();
      });
    }}}catch(error){current.error||=error;}
    if(current.active.size)return;
    cycle=null;service.reconciling=false;
    try{maintainTaskNotes(service);}catch(error){current.error||=error;}
    current.error?current.reject(current.error):current.resolve();
  };
  service.reconcile=()=>{
    if(!bridge||service.closing)return Promise.resolve();
    if(cycle){
      const promise=cycle.promise;
      for(const id of cycle.preparations){
        const job=service.store.jobs.find(job=>job.id===id);
        if(job?.state==='SUBMITTING'&&job.dispatchPending===true&&!cycle.active.has(id)){
          cycle.seen.delete(id+':first');cycle.preparations.delete(id);
        }
      }
      pump();return promise;
    }
    // Preserve the explicit pause used by callers while no pass is active.
    if(service.reconciling)return Promise.resolve();
    const current={active:new Set(),slots:new Set(),seen:new Set(),preparations:new Set(),error:null};
    current.promise=new Promise((resolve,reject)=>{current.resolve=resolve;current.reject=reject;});
    cycle=current;service.reconciling=true;pump();return current.promise;
  };
  if(bridge){service.executionTimer=setInterval(()=>service.reconcile().catch(()=>{}),15000);service.executionTimer.unref();}
}
export function usage(jobs,userId,machine){return jobs.filter(j=>j.userId===userId&&!TERMINAL.has(j.state)&&j.state!==DATA_PREPARING&&(!machine||j.machine===machine)).reduce((sum,j)=>sum+j.cards,0);}
export function publicJob(job,users=[]){const {spec,digest,schedulerPolicy,dataPreparationHold,dispatchPending,trainingStoragePlan:privateStoragePlan,trainingStorageRequest:privateStorageRequest,trainingPreparations:privatePreparations,nativeTaskDisplay:displayCache,...safe}=job;return {...safe,...jobTiming(job),...taskIdentity(job,users),command:spec.argv,
  yieldPolicy:['legacy','never','now','save'].includes(schedulerPolicy?.yield_policy)?schedulerPolicy.yield_policy:null,
  restartPolicy:['never','on-preempt'].includes(schedulerPolicy?.restart_policy)?schedulerPolicy.restart_policy:null,
  dispatchMode:['queue','preempt-now','preempt-save'].includes(schedulerPolicy?.dispatch_mode)?schedulerPolicy.dispatch_mode:null};}
export async function executionCall(service,principal,operation,args){
  if(!service.bridge&&!['datasets.upload.admission.create','datasets.upload.admission.status'].includes(operation))fail('节点执行桥尚未配置，未启动训练。',503,operation==='jobs.submit'?'SUBMISSION_REJECTED':undefined);
  const user=service.store.get(principal.userId);
  const jobView=job=>publicJob(job,service.store.users);
  if(!user.enabled)fail('账号已暂停。',403);
  service.assertMaintenanceAllowed?.(operation,args,principal);
  service=displayReadService(service,operation);
  if(['datasets.delete','datasets.delete.status','datasets.delete.restore','datasets.delete.continue','datasets.delete.cancel','datasets.delete.registration.discard'].includes(operation))return service.datasetDeletionCall(principal,operation,args);
  if(['datasets.catalog','datasets.capacity'].includes(operation))return datasetCatalogCall(service,principal,operation,args);
  if(operation==='datasets.overview')return datasetStorageOverviewCall(service,principal,args);
  if(operation==='datasets.files.list')return datasetFilesCall(service,principal,args);
  if(operation==='datasets.training.capabilities')return trainingDatasetCapabilities(service,principal,args);
  const authorizedMachine=machine=>{if(!MACHINES.some(m=>m.id===machine)||!user.limits[machine])fail('这台机器未授权。',403);};
  if(operation.startsWith('datasets.storage.')){
    if(principal.role!=='admin')fail('存储管理仅管理员可用。',403);
    authorizedMachine(args.machine);
    const action=operation.slice('datasets.storage.'.length);
    const definitions={status:['dataset','version','pinId'],plan:['neededBytes'],pin:['dataset','version','pinId'],unpin:['dataset','version','pinId']};
    const fields=Object.hasOwn(definitions,action)?definitions[action]:null;
    if(!fields||Object.keys(args).some(k=>k!=='machine'&&!fields.includes(k)))fail('存储管理参数无效。');
    if(action==='pin'||action==='unpin'||Object.hasOwn(args,'dataset')||Object.hasOwn(args,'version')||Object.hasOwn(args,'pinId'))datasetReferences([{dataset:args.dataset,version:args.version}]);
    if(action==='plan'&&args.neededBytes!==undefined&&(!Number.isSafeInteger(args.neededBytes)||args.neededBytes<0))fail('预计新增容量必须是非负整数字节。');
    if(action==='pin'||action==='unpin'||Object.hasOwn(args,'pinId')){
      if(typeof args.pinId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(args.pinId)||args.pinId.startsWith('authority-'))fail('固定标记需为 1–64 位字母数字、短横线或下划线；不能修改归档保护。');
      if(action!=='status')service.audit(principal.username,operation,args.machine,args.dataset+'@'+args.version+':'+args.pinId);
    }
    const {machine,...request}=args;
    return service.bridge(machine,operation,{...request,userId:user.id,hostAdmin:true});
  }
  const jobById=id=>{const job=service.store.jobs.find(j=>j.id===id);if(!job||(principal.role!=='admin'&&job.userId!==user.id))fail('任务不存在或无权访问。',403);return job;};
  if(/^(projects|datasets)\.(snapshot|sync)\./.test(operation)){
    const result=await snapshotSyncCall(service,principal,user,operation,args,authorizedMachine);
    if(result===undefined)fail('未知同步操作。');return result;
  }
  if(['host.exec','host.status','host.cancel'].includes(operation)){
    if(principal.role!=='admin')fail('宿主机命令仅管理员可用。',403);
    authorizedMachine(args.machine);
    const allowed=operation==='host.exec'?['machine','key','argv','cwd','timeoutSec']:['machine','id'];
    if(Object.keys(args).some(k=>!allowed.includes(k)))fail('宿主机命令参数无效。');
    const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
    const handle=operation==='host.exec'?args.key:args.id;
    if(typeof handle!=='string'||!uuid.test(handle))fail('需提供有效 UUID 命令标识。');
    if(operation==='host.exec'){
      if(!Array.isArray(args.argv)||!args.argv.length||!args.argv[0]||args.argv.length>128||args.argv.some(a=>typeof a!=='string'||a.includes('\0'))||Buffer.byteLength(JSON.stringify(args.argv))>12000)fail('命令参数无效或过长。');
      if(args.cwd!==undefined&&(typeof args.cwd!=='string'||!args.cwd.startsWith('/')||args.cwd.includes('\0')||args.cwd.length>1024))fail('工作目录必须为绝对路径。');
      if(args.timeoutSec!==undefined&&(!Number.isInteger(args.timeoutSec)||args.timeoutSec<1||args.timeoutSec>86400))fail('超时时间必须为 1–86400 秒。');
      await service.refreshGPUQ();
      const host=service.gpuq?.hosts.find(h=>h.id===args.machine);
      if(service.gpuq?.stale!==false||host?.reachable!==true||host.hostCommand?.version!==1||host.hostCommand?.available!==true)
        fail('这台服务器尚未启用或尚未确认管理员非交互命令，未提交命令；请联系管理员。已有 ROOT 终端不受影响。',503);
    }
    const {machine,...request}=args;
    // Never audit argument contents: operators may pass a credential in argv.
    if(operation!=='host.status')service.audit(principal.username,operation,machine,request.key||request.id);
    return service.bridge(machine,operation,{...request,userId:user.id,username:user.username,hostAdmin:true});
  }
  if(operation.startsWith('projects.')){
    const result=await projectCall(service,principal,user,operation,args,authorizedMachine);
    if(result===undefined)fail('未知项目操作。');
    return result;
  }
  if(operation.startsWith('datasets.workspace.')){
    authorizedMachine(args.machine);
    const action=operation.slice('datasets.workspace.'.length);
    const fields={list:['path'],get:['path','offset'],put:['path','offset','data','truncate'],status:['operationId'],publish:['path','name','key']}[action];
    if(!fields||Object.keys(args).some(k=>!['machine',...fields].includes(k)))fail('个人数据目录参数无效。');
    const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
    if(action!=='status'){
      const path=args.path??(action==='list'?'.':undefined);
      if(typeof path!=='string'||!path||Buffer.byteLength(path)>1024||/[\\\x00-\x1f\x7f]/.test(path)||
          (path!=='.'&&path.split('/').some(p=>!p||p==='.'||p==='..'||Buffer.byteLength(p)>255))||
          (path==='.'&&['put','get','publish'].includes(action)))fail('请使用个人 /data2 内的相对路径，不要填写宿主机路径。');
    }
    if(args.offset!==undefined&&(!Number.isSafeInteger(args.offset)||args.offset<0||args.offset>100*1024**3))fail('文件偏移量无效。');
    if(action==='put'){
      if(!Number.isSafeInteger(args.offset)||args.truncate!==undefined&&typeof args.truncate!=='boolean'||args.truncate&&args.offset!==0)fail('上传偏移或覆盖参数无效。');
      if(typeof args.data!=='string'||args.data.length>1398104||args.data.length%4!==0||/[^A-Za-z0-9+/=]/.test(args.data)||Buffer.from(args.data,'base64').toString('base64')!==args.data||Buffer.from(args.data,'base64').length>1024*1024)fail('上传分块最多 1 MiB，且需使用规范 Base64。');
      if(args.offset+Buffer.from(args.data,'base64').length>100*1024**3)fail('单文件上限 100 GiB；更大文件请联系管理员本地导入。');
    }
    if(action==='publish'&&(!uuid.test(args.key||'')||typeof args.name!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(args.name)))fail('发布需提供连接键和有效的数据集名称。');
    if(action==='status'&&args.operationId!==undefined&&!uuid.test(args.operationId))fail('发布操作编号无效。');
    const {machine,...request}=args;
    if(action==='publish')service.audit(principal.username,operation,machine,args.name);
    return service.bridge(machine,operation,{...request,userId:user.id,hostAdmin:false});
  }
  if(operation.startsWith('datasets.upload.')){
    authorizedMachine(args.machine);
    const fields={begin:['name','key','manifestBytes','manifestSha256','totalBytes','entries','allowRelay','archive'],'admission.create':['name','key','manifestBytes','manifestSha256','totalBytes','entries','archive'],'admission.status':['key'],manifest:['uploadId','offset','data'],seal:['uploadId'],status:['uploadId','path'],chunk:['uploadId','path','offset','data'],commit:['uploadId'],discard:['uploadId'],routes:service.datasetUploadIngress?['uploadId']:[],'direct-ticket':['uploadId','routeId'],'direct-revoke':['uploadId']};
    const action=operation.slice('datasets.upload.'.length),allowed=fields[action];
    if(!allowed||Object.keys(args).some(k=>k!=='machine'&&!allowed.includes(k)))fail('个人数据集上传参数无效。');
    const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
    const id=action==='begin'||action.startsWith('admission.')?args.key:args.uploadId;
    if((action!=='routes'||args.uploadId!==undefined)&&(typeof id!=='string'||!uuid.test(id)))fail('上传编号必须为完整 UUID。');
    if(args.routeId!==undefined&&(typeof args.routeId!=='string'||!/^[a-z][a-z0-9-]{0,31}$/.test(args.routeId)))fail('上传通道编号无效。');
    if(action==='begin'||action==='admission.create'){
      if(args.archive!==undefined&&!archiveUploadSpecification(args.archive,args.totalBytes,args.entries))fail('压缩包规格无效。',400,'ARCHIVE_FORMAT_UNSUPPORTED');
      if(args.archive&&args.allowRelay===true)fail('压缩包只走校内直连。',403,'CAMPUS_ROUTE_UNAVAILABLE');
      if(args.allowRelay!==undefined&&typeof args.allowRelay!=='boolean')fail('中转确认必须是明确的布尔值。');
      if(typeof args.name!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(args.name))fail('名称请用 1–40 位字母、数字、短横线或下划线。');
      if(!Number.isSafeInteger(args.manifestBytes)||args.manifestBytes<1||args.manifestBytes>64*1024*1024||typeof args.manifestSha256!=='string'||!/^[a-f0-9]{64}$/.test(args.manifestSha256))fail('数据清单大小或校验值无效（上限 64 MiB）。');
      if(!Number.isSafeInteger(args.totalBytes)||args.totalBytes<0||!Number.isSafeInteger(args.entries)||args.entries<0||args.entries>500000)fail('数据容量或条目数无效（上限 50 万条）。');
    }
    if(action==='chunk'||Object.hasOwn(args,'path')){
      if(typeof args.path!=='string'||!args.path||Buffer.byteLength(args.path)>4096||/[\\\x00-\x1f\x7f]/.test(args.path)||args.path.split('/').some(p=>!p||p==='.'||p==='..'||['.ssh','.env','.git','.venv','anaconda3','miniconda3','.conda'].includes(p)))fail('只能上传数据目录内的安全相对路径。');
    }
    if(action==='manifest'||action==='chunk'){
      if(!Number.isSafeInteger(args.offset)||args.offset<0||typeof args.data!=='string'||args.data.length>1398104||args.data.length%4!==0||/[^A-Za-z0-9+/=]/.test(args.data))fail('上传分块参数无效。');
      const data=Buffer.from(args.data,'base64');
      if(data.length>1024*1024||data.toString('base64')!==args.data)fail('上传分块最多 1 MiB，且需使用规范 Base64。');
    }
    const {machine,...request}=args;
    if(action.startsWith('admission.')&&!service.datasetUploadIngress)fail('机械仓库新上传准入尚未安装。',503);
    // Every upload is personal, including uploads made by administrators. No
    // client-provided role, source mapping or filesystem path crosses the bridge.
    if(['begin','admission.create','seal','commit','discard','direct-ticket','direct-revoke'].includes(action))service.audit(principal.username,operation,machine,id);
    if(service.datasetUploadIngress)return service.datasetUploadIngress(principal,action,args);
    // The public routes uploadId is a Portal placement selector. Legacy node
    // route metadata has no session field and must keep its old wire contract.
    if(action==='routes')delete request.uploadId;
    return service.bridge(machine,operation,{...request,userId:user.id,hostAdmin:false});
  }
  if(operation==='datasets.archive.enroll'){
    if(!service.enrollStorageArchive)fail('长期归档尚未配置。',409);
    return service.enrollStorageArchive(principal,args);
  }
  if(operation==='datasets.archive.retire'){
    if(!service.retireStorageArchive)fail('长期归档尚未配置。',409);
    return service.retireStorageArchive(principal,args);
  }
  if(operation==='datasets.archive.cancel-intent'){
    if(!service.cancelStorageArchiveIntent)fail('长期归档尚未配置。',409);
    return service.cancelStorageArchiveIntent(principal,args);
  }
  if(operation==='datasets.archive.retire-authority'){
    if(!service.retireStorageAuthority)fail('长期归档尚未配置。',409);
    return service.retireStorageAuthority(principal,args);
  }
  if(operation==='datasets.archive.retry'){
    authorizedMachine(args.machine);
    if(Object.keys(args).sort().join(',')!=='dataset,machine,version')fail('归档重试需要固定数据集版本。');
    datasetReferences([{dataset:args.dataset,version:args.version}]);
    if(!service.retryStorageArchive)fail('长期归档尚未配置。',409);
    const result=service.retryStorageArchive(user.id,args.machine,{dataset:args.dataset,version:args.version});
    service.audit(principal.username,operation,args.machine,args.dataset+'@'+args.version);
    return result;
  }
  if(['datasets.list','datasets.status','datasets.prepare','datasets.unregister'].includes(operation)){
    authorizedMachine(args.machine);
    if(operation==='datasets.unregister'&&principal.role!=='admin'&&(typeof args.version!=='string'||!/^[a-f0-9]{64}$/.test(args.version)))fail('成员只能删除本人上传、工作区或副本的完整版本。',403);
    const byOperation=operation==='datasets.status'&&Object.hasOwn(args,'operationId');
    const allowed=operation==='datasets.list'?['machine','includeEmpty']:byOperation?['machine','operationId']:['machine','dataset','version'];
    if(Object.keys(args).some(k=>!allowed.includes(k)))fail('数据集参数无效。');
    if(operation==='datasets.list'&&args.includeEmpty!==undefined&&typeof args.includeEmpty!=='boolean')fail('includeEmpty 需为布尔值。');
    if(byOperation){
      if(typeof args.operationId!=='string'||!/^[a-f0-9]{64}$/.test(args.operationId))fail('数据集后台操作编号无效。');
    }else if(operation==='datasets.unregister'){
      if(typeof args.dataset!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(args.dataset))fail('数据集名称无效。');
      if(args.version!==undefined&&args.version!==null)datasetReferences([{dataset:args.dataset,version:args.version}]);
      // Persist intent before the node may begin destructive cache cleanup.
      service.audit(principal.username,operation,args.machine,args.dataset+(args.version?'@'+args.version:''));
    }else if(operation!=='datasets.list')datasetReferences([{dataset:args.dataset,version:args.version}]);
    // Identity comes only from the authenticated portal; node paths and roles
    // cannot be supplied by the client. Large copies run in a node-local worker.
    const {machine,includeEmpty,...reference}=args;
    let removalGuard,removalV1=false;
    if(operation==='datasets.unregister'){
      // Fail before entering M2's lane/inserting a pending exclusion. The
      // bridge also checks again for a fence claimed during async reads.
      if(service.confirmDatasetNotDeleting)await service.confirmDatasetNotDeleting(machine,reference,{userId:user.id,hostAdmin:principal.role==='admin'});
      else service.assertDatasetNotDeleting?.(machine,reference);
      // Only v1 nodes can authorize personal version removal;
      // a failed capability read is not evidence that any data is absent.
      let capability;
      try{capability=await service.bridge(machine,'storage.dataset-delete.capabilities',{userId:user.id,hostAdmin:principal.role==='admin'});}
      catch{ /* Capability failure never proves absence of data. */ }
      removalV1=capability?.protocol==='dataset-delete-node-v1'&&capability.machine===machine&&capability.datasetDelete===1;
      if(!removalV1){
        if(principal.role!=='admin')fail('这台服务器还不支持安全删除，请等待节点更新。',409);
        // PR-M2 owns the shared guard and its durable exclusions. Read +
        // dispatch must stay inside its cross-machine version lock.
      }
      if(principal.role==='admin')removalGuard=createDatasetRemovalGuard(service,principal,{allowEmptyPersonalRegistration:removalV1});
    }
    if(operation==='datasets.prepare'&&service.prepareDataset){
      const result=await service.prepareDataset(user.id,machine,reference);
      service.audit(principal.username,operation,machine,args.dataset+'@'+args.version);return result;
    }
    if(operation==='datasets.status'&&!byOperation&&service.resolveDataset){
      const mapped=service.datasetPhysicalReference?.(user.id,machine,reference);
      // An administrator's personal replica has the same logical identity as
      // a member's. Unmapped records retain the privileged management view.
      if(principal.role!=='admin'||mapped&&mapped.dataset!==reference.dataset)return (await service.resolveDataset(user.id,machine,reference)).status;
    }
    let result;
    try{const send=proof=>service.bridge(machine,operation,{...reference,userId:user.id,hostAdmin:principal.role==='admin',
        ...(operation==='datasets.unregister'&&removalV1?{protocol:'dataset-delete-node-v1',
          ...(principal.role==='admin'?{portalProvedOtherCopy:{protocol:'dataset-portal-copy-proof-v1',versions:proof.map(row=>row.version)}}:{})}:{})});
      result=removalGuard?await removalGuard.withProtectedRemoval(machine,reference.dataset,reference.version,send):await send();}
    catch(error){if(operation==='datasets.status'&&!byOperation&&service.resolveDataset)return (await service.resolveDataset(user.id,machine,reference)).status;throw error;}
    if(operation==='datasets.prepare')service.audit(principal.username,operation,args.machine,args.dataset+'@'+args.version);
    if(operation==='datasets.list'){
      const aliases=service.datasetAliases?.(user.id,machine),archives=service.archiveAliases?.(user.id,machine);
      return datasetListView(result,service.store.users,{includeEmpty:includeEmpty===true,
        ...(service.datasetLabelView?{labelView:dataset=>service.datasetLabelView(user.id,dataset)}:{}),
        logicalName:item=>{
          // A privileged list may include other owners. Its personal aliases
          // cannot rename their records; legacy member lists are owner-scoped.
          const own=Array.isArray(item.ownerIds)?item.ownerIds.includes(user.id):item.ownerIds==null&&principal.role!=='admin';
          if(!own)return item.dataset;
          const names=new Set(item.versions.filter(v=>/^[a-f0-9]{64}$/.test(v?.version)).map(v=>aliases?.get(item.dataset+'@'+v.version)||archives?.get(item.dataset+'@'+v.version)||item.dataset));
          return names.size===1?[...names][0]:item.dataset;
        }});
    }
    return result;
  }
  if(['terminal.open','terminal.exchange','terminal.close','terminal.detach','terminal.status'].includes(operation)){
    authorizedMachine(args.machine);
    const opening=operation==='terminal.open',status=operation==='terminal.status',stoppedClose=operation==='terminal.close'&&args.writerToken===undefined,mode=args.mode||'new';
    const allowed=['machine','id','hostAdmin','project','dataWorkspace',...(!status?['clientId','writerToken']:[]),...(opening?['key','mode','takeover']:operation==='terminal.exchange'?['input','offset','rows','cols']:[])];
    if(Object.keys(args).some(k=>!allowed.includes(k)))fail('终端参数无效。');
    if(args.hostAdmin&&principal.role!=='admin')fail('宿主机 root 终端仅管理员可用。',403);
    const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
    if(!status&&!stoppedClose&&(typeof args.clientId!=='string'||!uuid.test(args.clientId)))fail('请升级客户端或刷新网页：终端需要独立会话和单写租约。');
    if(args.clientId!==undefined&&(typeof args.clientId!=='string'||!uuid.test(args.clientId)))fail('终端客户端 ID 无效。');
    if(stoppedClose&&args.clientId!==undefined)fail('缺少终端写入凭据；停止会话收口不得携带旧附件 ID。');
    if(opening){
      if(!['new','reconnect'].includes(mode)||typeof args.key!=='string'||!uuid.test(args.key))fail('需明确新建或重连，并提供 UUID 连接键。');
      if(args.takeover!==undefined&&typeof args.takeover!=='boolean'||args.takeover&&mode!=='reconnect')fail('仅显式重连可确认接管。');
      if(mode==='new'&&(args.id!==undefined||args.writerToken!==undefined))fail('新建终端不能携带旧会话。');
    }
    if((!opening||mode==='reconnect')&&(typeof args.id!=='string'||!uuid.test(args.id)))fail('需指定完整终端会话 ID。');
    if(args.writerToken!==undefined&&(typeof args.writerToken!=='string'||!uuid.test(args.writerToken)))fail('终端写入凭据无效。');
    if(!opening&&!status&&!stoppedClose&&args.writerToken===undefined)fail('缺少终端写入凭据；请显式重连。');
    if(args.hostAdmin!==undefined&&typeof args.hostAdmin!=='boolean')fail('终端模式无效。');
    if(args.dataWorkspace!==undefined&&typeof args.dataWorkspace!=='boolean')fail('数据终端模式无效。');
    const project=projectReference(args);
    if(project.project&&args.hostAdmin)fail('项目终端与宿主机 root 维护入口分开使用。');
    if(args.dataWorkspace&&(project.project||args.hostAdmin))fail('个人数据终端与项目、ROOT 终端分开使用。');
    if(args.input&&(typeof args.input!=='string'||args.input.length>12000))fail('终端输入过长。');
    if(opening&&project.project)await service.ociProjectAdmission?.(args.machine,user.id,project.project);
    if(operation==='terminal.open')service.audit(principal.username,operation,args.machine,(args.hostAdmin?'host-root':args.dataWorkspace?'private-data':'private')+':'+mode+(args.takeover?':takeover':''));
    return service.bridge(args.machine,operation,{...args,userId:user.id,username:user.username,hostAdmin:args.hostAdmin===true});
  }
  if(operation==='jobs.submit'){
    // Only explicit admission refusals before persistence prove no submission.
    const rejectSubmission=(message,status)=>fail(message,status,'SUBMISSION_REJECTED');
    const request=normalizeJobSubmission(args,principal);
    const {datasets,project,explicit,digest,minVramGiB:min}=request;
    const previous=service.store.jobs.find(j=>j.userId===user.id&&j.key===request.key);
    if(previous){if(previous.digest!==digest)rejectSubmission('同一提交键不能用于不同任务。',409);return jobView(previous);}
    if(service.store.jobs.length>=5000)rejectSubmission('任务历史达到归档上限，请联系管理员归档后提交。',503);
    if(request.cards>user.total)rejectSubmission('任务卡数超出跨机器用卡总额度。',409);
    if(request.machineSelection){
      try{Object.assign(request,await selectMachine(service,user,request,priorityCapable,usage));}
      catch(error){error.code='SUBMISSION_REJECTED';throw error;}
    }
    authorizedMachine(request.machine);
    if(project.project&&!request.machineSelection){
      await service.ociProjectAdmission?.(request.machine,user.id,project.project);
      let prepared;
      try{prepared=await service.bridge(request.machine,'projects.verify',{...project,userId:user.id});}
      catch{rejectSubmission('所选服务器的项目版本不可用或基础环境已改变；请先完成项目发布。未占用 GPU。',409);}
      if(prepared?.state!=='READY'||prepared.project!==project.project||prepared.release!==project.release)rejectSubmission('项目版本尚未准备完成，未占用 GPU。',409);
    }
    if(request.cards>user.limits[request.machine])rejectSubmission('任务卡数超出所选机器的用卡额度；不会自动切换服务器。',409);
    await service.refreshGPUQ();
    if(!service.gpuq||service.gpuq.stale)rejectSubmission('机器状态已过期，暂不接受新任务。',503);
    const host=service.gpuq.hosts.find(h=>h.id===request.machine);
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
    let needsPreparation=!!request.machineSelection,resolvedReferences=[];
    if(datasets.length){
      // Personal training uses the same owner-only Principal as node lease
      // acquisition. Only the explicitly selected node is queried; management
      // visibility and another node's READY copy cannot bypass this preflight.
      let states;
      try{states=await Promise.all(datasets.map(async ref=>{
        if(request.datasetReadMode==='warehouse'){
          const resolved=await resolveTrainingDataset(service,user.id,request.machine,ref,'warehouse');
          if(resolved.reference)resolvedReferences.push(resolved.reference);
          return resolved.status;
        }
        if(service.resolveDataset){
          try{
            const resolved=await service.resolveDataset(user.id,request.machine,ref);
            if(resolved.reference)resolvedReferences.push(resolved.reference);
            return resolved.status;
          }catch(error){if(!request.prepareData||error.status===403||error.message==='dataset owner authorization required')throw error;return {...ref,state:'UNKNOWN'};}
        }
        const transfer=service.datasetReplicaState?.(user.id,request.machine,ref);
        try{const result=await service.bridge(request.machine,'datasets.status',{...ref,userId:user.id,hostAdmin:false});return result.state==='READY'?result:transfer||result;}
        catch(error){if(!request.prepareData||error?.status===403||error?.message==='dataset owner authorization required')throw error;return {...ref,state:'UNKNOWN'};}
      }));}
      catch(error){
        if(error?.status===403||error?.message==='dataset owner authorization required')rejectSubmission('当前账号没有数据集读取授权；管理员个人训练也必须列入数据集 owners。未占用 GPU。',403);
        if(error?.code==='TRAINING_ADMISSION_BUSY')throw error;
        rejectSubmission('无法确认所选机器的数据授权或准备状态，未占用 GPU。请稍后重试或查看数据集状态。',503);
      }
      if(!states.every(s=>s.state==='READY')){
        if(request.datasetReadMode==='warehouse')rejectSubmission('所选服务器没有这个固定版本的可读仓库原件；未复制到缓存、切换服务器或占用 GPU。',409);
        if(!request.prepareData)rejectSubmission('所选机器没有完整的本地数据副本。先用 gpuctl data prepare 数据集@版本 准备数据；此时未占用 GPU，不会自动切换服务器。',409);
        const catalog=await datasetCatalogCall(service,{...principal,userId:user.id},'datasets.catalog',{machine:request.machine});
        const catalogVersions=datasets.map(ref=>catalog.datasets?.find(d=>d.dataset===ref.dataset)?.versions?.find(v=>v.version===ref.version));
        if(catalogVersions.some((value,index)=>states[index].state!=='READY'&&value&&value.canUse!==true))
          rejectSubmission('当前账号没有数据集读取授权；目录可见不代表可以训练读取。未占用 GPU。',403);
        if(!datasets.every((ref,index)=>states[index].state==='READY'||catalogVersions[index]?.canUse===true&&(catalogVersions[index].canPrepare===true||catalogVersions[index].state==='PREPARING')))rejectSubmission('部分数据没有可用来源；请先在数据集页面完成导入。未占用 GPU。',409);
        if(service.store.jobs.filter(j=>j.userId===user.id&&j.state===DATA_PREPARING).length>=10)rejectSubmission('最多保留 10 个数据准备中的训练，请先等待或取消。',429);
        needsPreparation=true;
      }
    }
    if(needsPreparation&&service.store.jobs.filter(j=>j.userId===user.id&&j.state===DATA_PREPARING).length>=10)rejectSubmission('最多保留 10 个准备中的训练，请先等待或取消。',429);
    if(request.machineSelection&&(JSON.stringify(service.store.get(user.id))!==JSON.stringify(user)||service.maintenanceFor?.(request.machine)))rejectSubmission('账号授权或机器维护状态已改变；未提交训练。',409);
    let storagePlan;
    if(project.project||datasets.length){
      try{storagePlan=await trainingStoragePlan(service,user,request.machine,request,{from:request.projectPreparation?.from});}
      catch(error){if(error.code!=='TRAINING_ADMISSION_BUSY')error.code='SUBMISSION_REJECTED';throw error;}
      if(JSON.stringify(service.store.get(user.id))!==JSON.stringify(user)||service.maintenanceFor?.(request.machine))rejectSubmission('容量核对期间账号授权或机器维护状态已改变；未提交训练。',409);
    }
    if(!needsPreparation&&!personalCardQuotaExempt(user,request)){
      if(usage(service.store.jobs,user.id)+request.cards>user.total)rejectSubmission('超出跨机器用卡总额度（排队、运行和待核对任务均计入）。',409);
      if(usage(service.store.jobs,user.id,request.machine)+request.cards>user.limits[request.machine])rejectSubmission('超出所选机器的用卡额度（排队、运行和待核对任务均计入）；不会自动切换服务器。',409);
    }
    const job=createSubmittedJob(request,user,prioritySupported),{id}=job;
    if(storagePlan)job.trainingStoragePlan=storagePlan;
    if(!needsPreparation&&datasets.length&&resolvedReferences.length===datasets.length)job.spec.datasets=datasets.map(ref=>resolvedReferences.find(value=>(value.mountAs||value.dataset)===ref.dataset));
    if(needsPreparation){job.state=DATA_PREPARING;job.queueReason='等待准备项目和本机数据；尚未申请 GPU。';job.dataPreparation={datasets:datasets.map(ref=>({...ref,state:'WAITING'}))};}
    service.db.exec('BEGIN IMMEDIATE');
    try{service.store.jobs.push(job);service.save();service.audit(principal.username,operation,id,'reserved');service.db.exec('COMMIT');}
    catch(e){service.db.exec('ROLLBACK');service.store.jobs=service.store.jobs.filter(j=>j.id!==id);throw e;}
    setImmediate(()=>service.reconcile().catch(()=>{}));return jobView(job);
  }
  if(operation==='jobs.priority'){
    if(principal.role!=='admin')fail('调整排队优先级仅管理员可用。',403);
    if(Object.keys(args).some(k=>!['jobId','priority','expectedPriority'].includes(k)))fail('优先级参数无效。');
    const priority=rankValue(args.priority),job=jobById(args.jobId);
    authorizedMachine(job.machine);
    if(job.state!=='PENDING'||job.cancelRequested||!job.priorityMutable||!(job.spec.preemptIdleOnly===true||job.spec.scheduling)||!job.schedulerPolicy)fail('仅能调整已核验、尚未启动的新版平台任务；运行中或旧任务不变。',409);
    if(args.expectedPriority!==undefined&&args.expectedPriority!==job.priority)fail('优先级已变化，请刷新后重试。',409);
    await service.refreshGPUQ();
    if(service.gpuq?.stale||!priorityRankCapable(service.gpuq?.hosts.find(h=>h.id===job.machine)))fail('节点未确认只改优先级能力，未调整；不会回退到改变整套策略的接口。',503);
    // The immutable submit specification is never rewritten. The scheduler
    // changes the live policy atomically after checking PENDING + expected.
    job.policyRevision=(job.policyRevision||0)+1;service.save();
    service.audit(principal.username,operation,job.id,priority);
    try{
      const result=await service.bridge(job.machine,'priority',nativeJobRequest(service,job,{priority,rankOnly:true,expected:job.schedulerPolicy}));
      job.policyRevision++;
      schedulerResult(job,result);service.save();maintainTaskNotes(service);return jobView(job);
    }catch(error){
      job.policyRevision++;
      job.priorityMutable=false;job.error='优先级调整结果待核验，请刷新；不会重复提交任务。';service.save();
      setImmediate(()=>service.reconcile().catch(()=>{}));throw error;
    }
  }
  if(operation==='jobs.cancel'){
    const job=jobById(args.jobId);
    if(!TERMINAL.has(job.state)){
      const before=structuredClone(job);let transaction=false;
      try{
        service.db.exec('BEGIN IMMEDIATE');transaction=true;
        job.cancelRequested=true;
        service.save();service.audit(principal.username,operation,job.id,'requested');
        service.db.exec('COMMIT');transaction=false;
      }catch(error){
        try{if(transaction)service.db.exec('ROLLBACK');}
        finally{for(const key of Object.keys(job))delete job[key];Object.assign(job,before);}
        throw error;
      }
      setImmediate(()=>service.reconcile().catch(()=>{}));
    }
    return jobView(job);
  }
  if(operation==='jobs.logs'){const job=jobById(args.jobId);if(job.state===DATA_PREPARING)return {text:job.queueReason||'正在准备本机数据；尚未申请 GPU。'};return service.bridge(job.machine,'logs',{job:job.spec});}
  if(operation==='jobs.reconcile-resources'){
    if(Object.keys(args).some(k=>k!=='jobId'))fail('资源对账仅接受任务 ID。');
    const job=jobById(args.jobId);authorizedMachine(job.machine);
    if(!TERMINAL.has(job.state)||!job.nodeJobId)fail('仅能对账已有原生任务的历史终态；不会取消或重跑任务。',409);
    const snapshot=JSON.stringify(job),actorSnapshot=JSON.stringify(service.store.get(principal.userId));
    const check=()=>{if(service.closing||JSON.stringify(service.store.get(principal.userId))!==actorSnapshot||JSON.stringify(job)!==snapshot)fail('授权或任务状态已改变，请重新查询后对账。',409);};
    const before=await service.bridge(job.machine,'watch',{job:job.spec,expectedNodeJobId:job.nodeJobId});check();
    const observation=terminalNativeObservation(job,before?.nativeObservation),attempt=observation.latestAttempt;
    if(observation.status!=='CONFIRMED'||!TERMINAL.has(observation.state)||!attempt||
       !/^A[a-f0-9]{32}$/.test(attempt.id)||!['EXITED_SUCCESS','EXITED_FAILURE','CANCELED','PREEMPTED'].includes(attempt.state))
      fail('最新原生尝试尚未确认终止；未释放任何资源。',409);
    const expectedNative={nodeJobId:job.nodeJobId,attemptId:attempt.id,attemptOrdinal:attempt.ordinal,nativeVersion:observation.nativeVersion};
    service.audit(principal.username,operation,job.id,JSON.stringify(expectedNative));check();
    const released=await service.bridge(job.machine,'storage.lease.cancel',{job:job.spec,expectedNative});check();
    if(released?.released!==true||released.jobId!==job.id||released.state!=='CANCELED'||
       !released.reconciledNative||Object.keys(released.reconciledNative).length!==4||
       Object.entries(expectedNative).some(([key,value])=>released.reconciledNative[key]!==value))
      fail('资源收尾尚未确认；请查询原任务，不要重新提交。',409);
    const after=await service.bridge(job.machine,'watch',{job:job.spec,expectedNodeJobId:job.nodeJobId});check();
    return {protocol:'job-resource-reconciliation-v1',jobId:job.id,reconciledNative:expectedNative,resourcesReleased:true,
      portalHistory:portalTerminalSnapshot(job),completion:jobCompletion(job,after)};
  }
  if(operation==='jobs.completion'){
    if(Object.keys(args).some(k=>k!=='jobId'))fail('完成核验仅接受任务 ID。');
    const job=jobById(args.jobId);authorizedMachine(job.machine);
    const snapshot=JSON.stringify(job),actorSnapshot=JSON.stringify(service.store.get(principal.userId));
    let result;
    if(job.nodeJobId)try{result=await service.bridge(job.machine,'watch',{job:job.spec,expectedNodeJobId:job.nodeJobId});}catch{}
    if(service.closing||JSON.stringify(service.store.get(principal.userId))!==actorSnapshot||JSON.stringify(job)!==snapshot)
      fail('授权或任务状态已改变，请重新查询完成状态。',409);
    return jobCompletion(job,result);
  }
  if(operation==='jobs.watch'){
    if(Object.keys(args).some(k=>k!=='jobId'))fail('进度查询参数无效。');
    const job=jobById(args.jobId);
    if(!job.machine||job.state===DATA_PREPARING)return jobView(job);
    if(TERMINAL.has(job.state)){
      authorizedMachine(job.machine);
      const original=jobView(job);
      if(!job.nodeJobId)return {...original,nativeObservation:unavailableObservation('NATIVE_ID_UNAVAILABLE')};
      try{
        const result=await service.bridge(job.machine,'watch',{job:job.spec,expectedNodeJobId:job.nodeJobId});
        return {...original,nativeObservation:terminalNativeObservation(job,result?.nativeObservation)};
      }catch{return {...original,nativeObservation:unavailableObservation()};}
    }
    authorizedMachine(job.machine);
    let result;
    try{result=await service.bridge(job.machine,'watch',{job:job.spec});}
    catch{return {...jobView(job),state:'UNKNOWN',error:'节点进度查询失败，任务状态待核对。',checkedAt:new Date().toISOString()};}
    if(!result?.nodeJobId)return jobView(job);
    try{persistSchedulerResult(service,job,result);return jobView(job);}
    catch{
      // Keep advisory progress inspectable, but never treat an observation as
      // a saved lifecycle result or release the restored reservation.
      const observed={...job};applyJobFeedback(observed,result);
      return {...jobView(observed),state:'UNKNOWN',notSaved:true,error:'节点观察结果未保存，任务状态待核对。',checkedAt:new Date().toISOString()};
    }
  }
  if(operation==='jobs.diagnostics'){
    if(Object.keys(args).some(k=>k!=='jobId'))fail('诊断参数无效。');
    const job=jobById(args.jobId);authorizedMachine(job.machine);
    if(!TERMINAL.has(job.state))return service.bridge(job.machine,'diagnostics',{job:job.spec});
    try{
      const result=await service.bridge(job.machine,'diagnostics',{job:job.spec,...(job.nodeJobId?{expectedNodeJobId:job.nodeJobId}:{})});
      return {...result,portalTerminal:portalTerminalSnapshot(job),nativeObservation:terminalNativeObservation(job,result?.nativeObservation)};
    }catch{return {jobId:job.id,state:'UNAVAILABLE',portalTerminal:portalTerminalSnapshot(job),nativeObservation:unavailableObservation()};}
  }
  if(['files.list','files.put','files.get','files.upload.status','files.upload.list','files.upload.cancel'].includes(operation)){
    authorizedMachine(args.machine);
    if(Object.keys(args).some(k=>!['machine','path','data','offset','truncate','project','area','runId','uploadId','totalSize','sha256','final',...(operation==='files.get'?['fingerprint']:[])].includes(k)))fail('文件参数无效。');
    if(args.fingerprint!==undefined&&(typeof args.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(args.fingerprint)))fail('下载文件身份无效。');
    const project=validateProjectFile(args);
    if(operation==='files.upload.status'&&(!args.project||project.area==='output'||Object.keys(args).some(k=>!['machine','path','project','area','uploadId','totalSize','sha256'].includes(k))))fail('上传状态仅用于个人项目代码文件的固定路径、大小和校验和。');
    if(['files.upload.list','files.upload.cancel'].includes(operation)){
      const allowed=['machine','project','area',...(operation==='files.upload.cancel'?['uploadId']:[])];
      if(!args.project||project.area!=='code'||Object.keys(args).some(k=>!allowed.includes(k)))fail('待上传管理只适用于本人的项目代码。');
      if(operation==='files.upload.cancel'&&(typeof args.uploadId!=='string'||!UUID.test(args.uploadId)))fail('取消上传必须使用原上传 UUID。');
    }
    if(project.area==='output'){
      const job=jobById(args.runId);
      // Admin resource inspection does not implicitly read somebody else's
      // personal output. Host-root maintenance is its own audited interface.
      if(job.userId!==user.id||job.machine!==args.machine||job.project!==args.project)fail('任务输出不属于当前用户、项目或服务器。',403);
      if(operation==='files.put')fail('不能通过上传覆盖训练输出。');
    }
    if(args.project&&operation==='files.put'&&args.truncate!==undefined)fail('项目上传须完整校验后原子提交，不接受 truncate。');
    return service.bridge(args.machine,operation,{...args,userId:user.id});
  }
  fail('未知执行操作。');
}
