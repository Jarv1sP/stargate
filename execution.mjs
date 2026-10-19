import {randomUUID} from 'node:crypto';
import {UUID as uuid,selectFields} from './portal-request-validation.mjs';
export {bridgeClient} from './execution-bridge.mjs';
import {submitTask,firstDispatch,SUBMISSION_SAFE_WINDOW_MS,submissionError,submissionDelay,priorityCapable,priorityRankCapable} from './tasks/submit.mjs';
export {SUBMISSION_SAFE_WINDOW_MS,priorityCapable,priorityRankCapable};
import {setTimeout as readDelay} from 'node:timers/promises';
import {MACHINES} from './dist/model.js';
import {taskIdentity,nativeTaskDisplay,canControlJob} from './dist/task-metadata.js';
import {nativeJobRequest,nativeJobSpec} from './native-task-metadata.mjs';
import {applyJobFeedback,jobTiming,projectProgress} from './dist/job-progress.js';
import {maintainTaskNotes} from './community.mjs';
import {projectCall,projectReference,validateProjectFile,UUID} from './projects.mjs';
import {personalCardQuotaExempt} from './job-submission.mjs';
import {terminalNativeObservation,unavailableObservation,portalTerminalSnapshot,jobCompletion} from './job-observation.mjs';

export const TERMINAL=new Set(['SUCCEEDED','FAILED','CANCELED']);
const fail=(message,status=400,code)=>{throw Object.assign(Error(message),{status,...(code?{code}:{})});};
const RANKS={idle:0,normal:2,high:4,P0:0,P1:1,P2:2,P3:3,P4:4};
function rankValue(value){if(typeof value!=='string'||!Object.hasOwn(RANKS,value))fail('排队优先级必须为 P0–P4（或 idle/normal/high）。');return value;}
export function schedulerResult(job,result){
  if(result.displaySync&&['SYNCED','PRESERVED','UNAVAILABLE'].includes(result.displaySync.state))
    job.nativeDisplay={state:result.displaySync.state,...(typeof result.displaySync.error==='string'?{error:result.displaySync.error.slice(0,200)}:{})};
  if(result.displaySync?.state==='PRESERVED'){
    const display=nativeTaskDisplay(result.displaySync.metadata,job.spec?.username);
    if(display)job.nativeTaskDisplay=display;
  }
  if(result.displaySync?.state==='SYNCED')delete job.nativeTaskDisplay;
  job.nodeJobId=result.nodeJobId||job.nodeJobId;
  job.state=['PENDING','STARTING','RUNNING','PREEMPTING',...TERMINAL].includes(result.state)?result.state:'UNKNOWN';
  job.assignedIndices=Array.isArray(result.assignedIndices)?result.assignedIndices:null;job.error=result.error||null;job.checkedAt=new Date().toISOString();
  if(result.notSubmitted===true&&job.state==='FAILED'){
    job.notSubmitted=true;
    job.failureCode=typeof result.failureCode==='string'?result.failureCode.slice(0,80):null;
  }
  job.actualCards=job.assignedIndices?.length??null;
  job.schedulerState=typeof result.schedulerState==='string'?result.schedulerState:result.state;
  job.queueReason=typeof result.queueReason==='string'?result.queueReason.slice(0,400):null;
  job.schedulerCheckedAt=job.checkedAt;
  job.schedulerPriority=Number.isInteger(result.schedulerPriority)?result.schedulerPriority:null;
  job.gpuMetrics=result.gpuMetrics??null;
  job.priority=typeof result.priority==='string'&&Object.hasOwn(RANKS,result.priority)?result.priority:null;
  job.schedulerPolicy=result.schedulerPolicy||null;
  job.priorityMutable=result.priorityMutable===true;
  job.preempted=result.preempted===true;
  applyJobFeedback(job,result);
  job.progressCheckedAt=job.checkedAt;
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
export function installExecution(service,bridge){
  service.bridge=bridge;service.executionEnabled=!!bridge;service.reconciling=false;
  let cycle=null;
  const kind=job=>job.cancelRequested&&!TERMINAL.has(job.state)?'cancel':job.state==='SUBMITTING'&&job.dispatchPending===true?'first':'observe';
  const eligible=(job,maintained)=>!TERMINAL.has(job.state)&&(!maintained||job.cancelRequested)&&(job.cancelRequested||job.state!=='SUBMITTING'||job.dispatchPending===true||!(Date.parse(job.submissionReconciliation?.nextCheckAt)>Date.now()));
  const step=async job=>{
    let dispatched=false;
    try{
      if(job.cancelRequested&&job.dispatchPending===true&&job.spec.projectCopy){
        await service.bridge(job.machine,'transfers.cancel',{id:job.id,userId:job.userId});
        await service.enqueue(()=>{job.state='CANCELED';job.finishedAt=new Date().toISOString();job.notSubmitted=true;service.save();});
        return;
      }
      if(job.state==='SUBMITTING'&&job.dispatchPending!==true&&!job.cancelRequested){
        // Watch never submits or releases resources; only definite absence allows dispatch.
        const result=await service.bridge(job.machine,'watch',{job:nativeJobSpec(job)},{rpcTimeoutMs:27000});
        await service.enqueue(()=>{
          const current=service.store.jobs.find(j=>j.id===job.id);
          if(!current||service.closing||current.state!=='SUBMITTING'||current.cancelRequested)return;
          if(result?.state==='FAILED'&&result.notSubmitted===true||
            typeof result?.nodeJobId==='string'&&/^J[a-f0-9]{12}$/.test(result.nodeJobId)&&
            ['PENDING','STARTING','RUNNING','PREEMPTING','LOST','UNKNOWN',...TERMINAL].includes(result.state)){
            persistSchedulerResult(service,current,result);delete current.submissionReconciliation;service.save();return;
          }
          const now=Date.now(),old=current.submissionReconciliation||{},attempts=(old.attempts||0)+1;
          const absent=result?.schedulerState==='NOT_SUBMITTED'&&!result.nodeJobId&&!result.latestAttempt;
          const confirmed=absent;
          current.submissionReconciliation={...old,state:confirmed?'NOT_DISPATCHED':'CHECKING',attempts,
            checkedAt:new Date(now).toISOString(),nextCheckAt:new Date(now+submissionDelay(attempts-1)).toISOString(),
            ...(confirmed?{absenceConfirmedAt:new Date(now).toISOString()}:{}),
          };
          if(confirmed){
            current.dispatchPending=true;current.submissionReconciliation.dispatchRetries=(old.dispatchRetries||0)+1;
            current.error=null;service.audit('system','jobs.submit',current.id,'auto-retry-original-dispatch');
          }else current.error=submissionError(current);
          current.checkedAt=new Date(now).toISOString();service.save();
        });
        return;
      }
      const action=job.cancelRequested?'cancel':'sync';
      const attempt=action==='sync'&&job.state==='SUBMITTING'&&job.dispatchPending===true?await firstDispatch(service,job,{usage,RANKS,fail}):{response:service.bridge(job.machine,action,nativeJobRequest(service,job))};
      if(!attempt)return;
      dispatched=attempt.dispatched===true;
      const result=await attempt.response;
      await service.enqueue(()=>{
        const current=service.store.jobs.find(j=>j.id===job.id);if(!current||service.closing||TERMINAL.has(current.state))return;
        // LOST/unknown remains nonterminal: retain quota until confirmed.
        persistSchedulerResult(service,current,result);maintainTaskNotes(service);
      });
    }catch(e){await service.enqueue(()=>{const current=service.store.jobs.find(j=>j.id===job.id);if(current&&!service.closing&&!TERMINAL.has(current.state)){
      const pending=current.state==='SUBMITTING'&&current.dispatchPending!==true&&!current.cancelRequested;
      if(pending){const old=current.submissionReconciliation||{},attempts=(old.attempts||0)+1;
        current.submissionReconciliation={...old,state:'CHECKING',attempts,lastReason:e.code||'UNCONFIRMED',nextCheckAt:new Date(Date.now()+submissionDelay(attempts-1)).toISOString()};}
      if(current.state==='SUBMITTING'&&current.dispatchPending===true&&e.status===403){
        current.state='FAILED';current.notSubmitted=true;current.failureCode=e.code||'SUBMISSION_AUTH_REVOKED';current.finishedAt=new Date().toISOString();
      }
      current.error=pending?submissionError(current):String(e.message).slice(0,200);current.checkedAt=new Date().toISOString();service.save();
    }});}
    finally{if(dispatched)await service.enqueue(()=>{const current=service.store.jobs.find(j=>j.id===job.id);if(current&&!service.closing){current.dispatchFinishedAt=new Date().toISOString();service.save();}});}
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
      pump();return promise;
    }
    // Preserve the explicit pause used by callers while no pass is active.
    if(service.reconciling)return Promise.resolve();
    const current={active:new Set(),slots:new Set(),seen:new Set(),error:null};
    current.promise=new Promise((resolve,reject)=>{current.resolve=resolve;current.reject=reject;});
    cycle=current;service.reconciling=true;pump();return current.promise;
  };
  if(bridge){service.executionTimer=setInterval(()=>{service.reconcile().catch(()=>{});service.refreshStorage?.(true).catch(()=>{});},15000);service.executionTimer.unref();}
}
export function usage(jobs,userId,machine){
  const active=jobs.filter(j=>j.userId===userId&&!TERMINAL.has(j.state)&&(!machine||j.machine===machine));
  const total=active.reduce((sum,job)=>sum+job.cards,0);
  if(!active.some(job=>job.after?.length))return total;
  // Maximum concurrent card demand is the weighted antichain of this DAG.
  // A flow matches reusable parent/child card slots; branches stay independent.
  // Relay through other-user jobs keeps transitive dependencies intact.
  jobs=jobs.filter(job=>!TERMINAL.has(job.state));
  const ids=new Map(jobs.map((job,index)=>[job.id,index])),weights=new Map(active.map(job=>[job.id,job.cards]));
  const source=jobs.length*2,sink=source+1,graph=Array.from({length:sink+1},()=>[]);
  const edge=(from,to,capacity)=>{
    const forward={to,capacity},backward={to:from,capacity:0};
    forward.reverse=backward;backward.reverse=forward;graph[from].push(forward);graph[to].push(backward);
  };
  jobs.forEach((job,index)=>{
    const left=index*2,right=left+1,weight=weights.get(job.id)||0;
    edge(source,left,weight);edge(right,sink,weight);edge(right,left,total);
    for(const dependency of job.after||[]){const parent=ids.get(dependency.id);if(parent!==undefined)edge(parent*2,right,total);}
  });
  let overlap=0;
  for(;;){
    const previous=Array(graph.length).fill(null),queue=[source];previous[source]=[];
    for(const from of queue){
      for(const link of graph[from])if(link.capacity>0&&previous[link.to]===null){previous[link.to]=[from,link];queue.push(link.to);}
      if(previous[sink])break;
    }
    if(!previous[sink])return total-overlap;
    let amount=total;
    for(let at=sink;at!==source;at=previous[at][0])amount=Math.min(amount,previous[at][1].capacity);
    for(let at=sink;at!==source;at=previous[at][0]){const link=previous[at][1];link.capacity-=amount;link.reverse.capacity+=amount;}
    overlap+=amount;
  }
}
// Presentation only: never persist these deductions or use them for admission.
// A node-supplied reason remains authoritative; missing observations are not
// proof of free cards, a sharing limit, or a new dispatch opportunity.
export function pendingJobReason(service,job,now=Date.now()){
  const reported=typeof job.queueReason==='string'&&job.queueReason.trim()?job.queueReason:null;
  if(!['PENDING','QUEUED','SUBMITTING'].includes(job.state)||job.cancelRequested)return reported;
  if(reported)return reported;
  if(job.after?.length){
    const waiting=job.after.filter(item=>service.store.jobs.find(row=>row.id===item.id)?.state!=='SUCCEEDED');
    if(waiting.length)return '等待依赖：'+waiting.map(item=>item.name||item.id).join('、');
  }
  const snapshot=service.gpuq,host=snapshot?.hosts?.find(h=>h.id===job.machine);
  const observed=Date.parse(snapshot?.checkedAt),age=now-observed;
  const fresh=snapshot?.stale===false&&Number.isFinite(age)&&age>=-30000&&age<=180000&&host?.reachable===true&&host.gpuq?.connected===true;
  const machine=MACHINES.find(m=>m.id===job.machine),jobs=service.store.jobs||[];
  const shared=job.placement?.shared===true||job.spec?.placement?.shared===true;
  if(fresh&&machine){
    const native=host.gpuq.jobs||[],occupied=new Set(),draining=new Set();
    const nativeReason=native.find(row=>row.id===job.nodeJobId&&row.state==='PENDING')?.state_reason;
    if(typeof nativeReason==='string'&&nativeReason.trim())return nativeReason.slice(0,400);
    const add=(indices,into=occupied)=>{for(const index of indices||[])if(Number.isSafeInteger(index)&&index>=0&&index<machine.cards)into.add(index);};
    for(const row of native)if(['STARTING','RUNNING','PREEMPTING','CANCELING'].includes(row.state))add(row.assigned_gpu_indices);
    for(const row of jobs)if(row.machine===job.machine&&['STARTING','RUNNING','PREEMPTING','CANCELING'].includes(row.state))add(row.assignedIndices);
    // A canceled native job can retain its allocation while descendants exit.
    // Low utilization and an empty CUDA process list do not release that lease.
    for(const row of jobs){
      const checked=Date.parse(row.schedulerCheckedAt),elapsed=now-checked;
      if(row.machine===job.machine&&row.latestAttempt?.state==='DRAINING'&&row.latestAttempt.finishedAt==null&&
        Number.isFinite(elapsed)&&elapsed>=-30000&&elapsed<=180000){
        add(row.assignedIndices);add(row.assignedIndices,draining);
      }
    }
    for(const gpu of host.gpus||[])if(gpu.processesAvailable===true&&gpu.processes?.length)add([gpu.index]);
    // An occupied card can still accept an explicitly shared job. In particular
    // process count is not a lease count or a declared sharing-person limit.
    if(!shared&&occupied.size===machine.cards){
      const rank=row=>Number.isInteger(row.schedulerPriority)?row.schedulerPriority:
        Number.isInteger(row.priority)?row.priority:RANKS[row.priority]??RANKS[row.spec?.scheduling?.rank]??2;
      const time=value=>typeof value==='number'?value*(value<1e12?1000:1):Date.parse(value);
      const before=row=>rank(row)>rank(job)||rank(row)===rank(job)&&time(row.createdAt??row.created_at)<time(job.createdAt);
      const pending=jobs.filter(row=>row.machine===job.machine&&row.id!==job.id&&row.state==='PENDING'&&!row.cancelRequested);
      const known=new Set(jobs.filter(row=>row.machine===job.machine).map(row=>row.nodeJobId).filter(Boolean));
      const other=[...new Map(native.filter(row=>row.state==='PENDING'&&row.id!==job.nodeJobId&&!known.has(row.id)).map(row=>[row.id,row])).values()];
      const ahead=[...pending,...other].filter(before).length;
      return `显卡已满（${occupied.size}/${machine.cards} 张被占用，${draining.size?`其中 ${draining.size} 张等待任务收尾，`:''}前面还有 ${ahead} 个排队）`;
    }
    // The current node contract exposes share_gpu, not a maximum people count.
    // Only an explicit node state_reason can confirm that limit (handled above).
  }
  if(service.maintenanceFor?.(job.machine))return '机器维护中';
  const user=service.store.get(job.userId),limit=user.limits?.[job.machine];
  if(!personalCardQuotaExempt(user)&&Number.isSafeInteger(limit)&&limit>=0){
    // The current pending job already owns its reservation; counting it as
    // its own blocker would incorrectly label an admitted one-card job full.
    const used=Math.max(0,usage(jobs,job.userId,job.machine)-job.cards);
    if(used>=limit)return `配额已满（本人在该机已用 ${used}/${limit} 张）`;
  }
  return '等待调度器分配，原因未上报';
}
function publicGpuMetrics(job){
  const metrics=job.gpuMetrics;
  if(!metrics)return null;
  const receivedAt=Date.parse(job.schedulerCheckedAt);
  const fresh=!TERMINAL.has(job.state)&&job.state!=='UNKNOWN'&&Number.isFinite(receivedAt)&&Date.now()-receivedAt<=30000;
  return {...metrics,gpus:(metrics.gpus||[]).map(gpu=>fresh?{...gpu}:{...gpu,utilization:null,memoryUsedMiB:null})};
}
export function publicJob(job,users=[]){const {spec,schedulerPolicy,dispatchPending,dispatchStartedAt,dispatchFinishedAt,submissionReconciliation,nativeTaskDisplay:displayCache,...safe}=job;return {...safe,gpuMetrics:publicGpuMetrics(job),
  ...(job.state==='SUBMITTING'&&dispatchPending!==true?{submissionState:submissionReconciliation?.state||'CHECKING',
    canRetryDispatch:false,error:submissionError(job)}:{}),
  ...projectProgress(job),...jobTiming(job),...taskIdentity(job,users),ownerId:job.ownerId??job.userId,ownerName:users.find(user=>user.id===job.userId)?.name??null,command:spec.argv,
  yieldPolicy:['legacy','never','now','save'].includes(schedulerPolicy?.yield_policy)?schedulerPolicy.yield_policy:null,
  restartPolicy:['never','on-preempt'].includes(schedulerPolicy?.restart_policy)?schedulerPolicy.restart_policy:null,
  dispatchMode:['queue','preempt-now','preempt-save'].includes(schedulerPolicy?.dispatch_mode)?schedulerPolicy.dispatch_mode:null};}
export async function executionCall(service,principal,operation,args,readContext){
  if(!service.bridge)fail('节点暂未连接，请稍后按原编号查询。',503);
  const user=service.store.get(principal.userId);
  if(!user.enabled)fail('请重新登录。',403);
  service.assertMaintenanceAllowed?.(operation,args,principal);
  const authorizedMachine=machine=>{if(!MACHINES.some(m=>m.id===machine))fail('请选择列表中的服务器。');};
  const actor={userId:principal.userId,isAdmin:principal.role==='admin'};
  const jobView=job=>({...publicJob(job,service.store.users),queueReason:pendingJobReason(service,job)});
  const bridge=(machine,operation,payload)=>readContext?service.bridge(machine,operation,payload,readContext):service.bridge(machine,operation,payload);
  if(operation==='datasets.list'||operation==='datasets.delete'){
    args=selectFields(args,['machine',...(operation==='datasets.delete'?['dataset','key']:[])]);
    authorizedMachine(args.machine);
    if(operation==='datasets.delete'){directoryName(args.dataset);if(!UUID.test(args.key||''))fail('请提供删除的原 UUID。');}
    const {machine,...request}=args;
    const result=await bridge(machine,operation,{...request,userId:user.id,actor});
    if(operation==='datasets.list')return {...result,datasets:result.datasets?.map(row=>{
      const id=row.ownerId??(typeof row.uploadedBy==='string'?row.uploadedBy:row.uploadedBy?.userId)??null;
      const owner=service.store.users.find(value=>value.id===id);
      return {...row,ownerId:id,ownerName:owner?.name??row.ownerName??null};
    })};
    service.audit(principal.username,operation,machine,JSON.stringify({dataset:args.dataset,key:args.key}));
    return {...result,...(result?.state==='TRASHED'?{message:'已删除，7 天内可在回收站恢复；可能影响正在使用它的任务。'}:{})};
  }
  if(operation.startsWith('projects.')){
    const result=await projectCall(service,principal,user,operation,args,authorizedMachine);
    if(result===undefined)fail('未知项目操作。');return result;
  }
  if(operation.startsWith('data.upload.')){
    const action=operation.slice('data.upload.'.length),keys={begin:['path','key','totalSize','overwrite','executable','transferId'],status:['key'],chunk:['key','offset','data'],finish:['key','executable'],cancel:['key']}[action];
    if(!keys)fail('未知上传操作。');
    args=selectFields(args,['machine','ownerId','area','dataset','project',...keys]);authorizedMachine(args.machine);
    if(!UUID.test(args.key||''))fail('请使用上传的原 UUID。');
    if(action==='begin')args.area??=args.dataset?'dataset':'code';
    if(args.path!==undefined)relativePath(args.path);
    if(args.dataset!==undefined)directoryName(args.dataset);else if(action==='begin'||args.project!==undefined)projectReference(args,{optional:false});
    if(args.totalSize!==undefined&&(!Number.isSafeInteger(args.totalSize)||args.totalSize<0))fail('文件大小无效。');
    if(args.offset!==undefined&&(!Number.isSafeInteger(args.offset)||args.offset<0))fail('文件偏移无效。');
    if(args.data!==undefined&&(typeof args.data!=='string'||args.data.length>1398104))fail('文件分块不能超过 1 MiB。');
    if(args.transferId&&action==='begin'){
      const record=service.db.prepare('SELECT data FROM directory_transfers WHERE id=?').get(args.transferId);
      if(record){const parent=JSON.parse(record.data);if(parent.state==='CANCELED')fail('原传输已取消，请查询原编号。',409);parent.uploadKeys=[...new Set([...(parent.uploadKeys||[]),args.key])];service.db.prepare('UPDATE directory_transfers SET data=? WHERE id=?').run(JSON.stringify(parent),parent.id);}
    }
    const {machine,...request}=args;
    return bridge(machine,operation,{...request,userId:user.id,ownerId:args.ownerId??user.id,actor});
  }
  const jobById=id=>{const job=service.store.jobs.find(j=>j.id===id);if(!job)fail('任务不存在。',404);return job;};
  const controlledJob=id=>{const job=jobById(id);if(!canControlJob(job,principal))fail('只能操作自己的任务',403);return job;};
  if(operation==='outputs.delete'){
    args=selectFields(args,['jobId','key','path','recursive','dryRun']);
    if(args.key!==undefined&&!UUID.test(args.key))fail('删除输出请使用原 UUID 编号。');
    args.key??=randomUUID();
    if(['recursive','dryRun'].some(key=>args[key]!==undefined&&typeof args[key]!=='boolean'))fail('输出删除参数无效。');
    const job=jobById(args.jobId);
    const path=args.path??'.';
    if(typeof path!=='string'||!path||path.length>4096||path.includes('\\')||/[\p{Cc}\p{Cf}]/u.test(path)||
      path!=='.'&&path.split('/').some(part=>!part||part==='.'||part==='..'))fail('只能删除本任务 outputs 内的相对路径。');
    const request={key:args.key,jobId:job.id,userId:user.id,ownerId:job.ownerId??job.userId,actor:{userId:user.id,isAdmin:principal.role==='admin'},hostAdmin:principal.role==='admin',path,recursive:args.recursive===true,dryRun:args.dryRun===true};
    if(request.dryRun){const value=await service.bridge(job.machine,'files.stat',{area:'output',runId:job.id,path,userId:user.id,ownerId:job.ownerId??job.userId,actor});return {...value,dryRun:true,state:'PREVIEW'};}
    service.audit(principal.username,operation,job.id,JSON.stringify({path,dryRun:request.dryRun,event:'requested'}));
    // Query the same key after an uncertain delete; never start a second operation.
    const result=await service.bridge(job.machine,operation,request);
    service.audit(principal.username,operation,job.id,JSON.stringify({path,dryRun:request.dryRun,files:result?.files,bytes:result?.bytes,freedBytes:result?.freedBytes}));
    return {...result,...(!request.dryRun&&result?.state==='TRASHED'?{message:'已删除，7 天内可在项目回收站恢复。'}:{})};
  }
  // Only explicit observations retry. sync, submit, cancellation, terminal
  // input and resource reconciliation keep their original one-shot dispatch.
  const observeJob=async(job,kind,request)=>{
    const check=()=>{
      readContext?.check?.();
      if(service.closing)fail('服务正在关闭，请稍后查询。',503);
      authorizedMachine(job.machine);readContext?.signal?.throwIfAborted();
    };
    for(let attempt=0;;attempt++){
      check();
      try{
        const options=readContext?{signal:readContext.signal,rpcTimeoutMs:Math.min(27000,Math.max(1,readContext.deadline-Date.now()))}:undefined;
        const value=await (options?service.bridge(job.machine,kind,request,options):service.bridge(job.machine,kind,request));
        check();return value;
      }catch(error){
        check();
        const transient=['NODE_CONNECT_FAILED','NODE_TRANSPORT_BUSY','NODE_RESPONSE_TIMEOUT','EXECUTOR_UNAVAILABLE','EXECUTOR_TIMEOUT','EXECUTOR_UNCONFIRMED',
          'ECONNRESET','ECONNREFUSED','EPIPE','ETIMEDOUT','EHOSTUNREACH'].includes(error?.code)||
          !error?.code&&[502,503,504].includes(error?.status);
        if(attempt||!transient||[401,403].includes(error?.status)||readContext?.deadline-Date.now()<=250)throw error;
        await readDelay(250,undefined,{signal:readContext?.signal});
      }
    }
  };
  if(['terminal.open','terminal.exchange','terminal.close','terminal.detach','terminal.status'].includes(operation)){
    authorizedMachine(args.machine);
    const opening=operation==='terminal.open',status=operation==='terminal.status',stoppedClose=operation==='terminal.close'&&args.writerToken===undefined,mode=args.mode||'new';
    const allowed=['machine','id','project',...(!status?['clientId','writerToken']:[]),...(opening?['key','mode','takeover','clientLabel']:operation==='terminal.exchange'?['input','offset','rows','cols']:[])];
    args=selectFields(args,[...allowed,'ownerId']);
    if(!status&&!stoppedClose&&(typeof args.clientId!=='string'||!uuid.test(args.clientId)))fail('请升级客户端或刷新网页：终端需要独立会话和单写租约。');
    if(args.clientId!==undefined&&(typeof args.clientId!=='string'||!uuid.test(args.clientId)))fail('终端客户端 ID 无效。');
    if(stoppedClose)delete args.clientId;
    if(opening){
      if(args.clientLabel!==undefined&&(typeof args.clientLabel!=='string'||![...args.clientLabel].length||[...args.clientLabel].length>128||/[\p{Cc}\p{Cf}]/u.test(args.clientLabel)))fail('终端来源名称无效。');
      if(!['new','reconnect'].includes(mode)||typeof args.key!=='string'||!uuid.test(args.key))fail('需明确新建或重连，并提供 UUID 连接键。');
      if(args.takeover!==undefined&&typeof args.takeover!=='boolean'||args.takeover&&mode!=='reconnect')fail('仅显式重连可确认接管。');
      if(mode==='new'){delete args.id;delete args.writerToken;}
    }
    if((!opening||mode==='reconnect')&&(typeof args.id!=='string'||!uuid.test(args.id)))fail('需指定完整终端会话 ID。');
    if(args.writerToken!==undefined&&(typeof args.writerToken!=='string'||!args.writerToken||args.writerToken.length>4096))fail('终端写入凭据无效。');
    if(!opening&&!status&&!stoppedClose&&args.writerToken===undefined)fail('缺少终端写入凭据；请显式重连。');
    const project=projectReference(args,{optional:!opening});
    if(args.input&&(typeof args.input!=='string'||args.input.length>12000))fail('终端输入过长。');
    const ownerId=args.ownerId??user.id;
    if((operation==='terminal.close'||operation==='terminal.exchange'&&args.input)&&service.store.jobs.some(job=>job.id===args.id&&job.interactive))controlledJob(args.id);
    if(operation==='terminal.open')service.audit(principal.username,operation,args.machine,'project:'+mode+(args.takeover?':takeover':''));
    const result=await service.bridge(args.machine,operation,{...args,ownerId,userId:user.id,username:user.username,hostAdmin:false});
    if(opening&&result?.state==='REJECTED')
      fail(result.reason||'终端准入被拒绝；未创建会话。',400,'TERMINAL_OPEN_REJECTED');
    return result;
  }
  if(operation==='jobs.submit')return submitTask(service,principal,user,args,{fail,authorizedMachine,jobView,usage});
  if(operation==='jobs.priority'){
    args=selectFields(args,['jobId','priority']);
    const job=controlledJob(args.jobId),priority=rankValue(args.priority);
    authorizedMachine(job.machine);
    service.audit(principal.username,operation,job.id,priority);
    try{
      const result=await service.bridge(job.machine,'priority',nativeJobRequest(service,job,{priority,rankOnly:true}));
      if(!TERMINAL.has(job.state)){schedulerResult(job,result);service.save();maintainTaskNotes(service);}return jobView(job);
    }catch(error){
      if(!TERMINAL.has(job.state)&&(['EXECUTOR_UNAVAILABLE','EXECUTOR_TIMEOUT','EXECUTOR_UNCONFIRMED','NODE_TRANSPORT_BUSY','NODE_CONNECT_FAILED','NODE_RESPONSE_TIMEOUT','NODE_SSH_AUTH_FAILED','NODE_SSH_HOSTKEY_FAILED','NODE_RESPONSE_INVALID'].includes(error.code)||!error.code&&[502,503,504].includes(error.status))){
        job.priorityMutable=false;job.error='调整结果未知，请按原任务编号查询。';service.save();
        setImmediate(()=>service.reconcile().catch(()=>{}));
      }
      throw error;
    }
  }
  if(operation==='jobs.cancel'){
    const job=controlledJob(args.jobId);
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
  if(operation==='jobs.logs'){const job=jobById(args.jobId);return observeJob(job,'logs',{job:nativeJobSpec(job)});}
  if(operation==='jobs.reconcile-resources'){
    const job=jobById(args.jobId);
    service.audit(principal.username,operation,job.id,'requested');
    return service.bridge(job.machine,operation,{job:nativeJobSpec(job),actor:{userId:principal.userId,isAdmin:principal.role==='admin'}});
  }
  if(operation==='jobs.completion'){
    args=selectFields(args,['jobId']);
    const job=jobById(args.jobId);authorizedMachine(job.machine);
    let result;
    if(job.nodeJobId||['SUBMITTING','UNKNOWN'].includes(job.state)&&job.dispatchPending!==true)
      try{result=await observeJob(job,'watch',{job:nativeJobSpec(job)});}catch{}
    readContext?.check?.();
    const completion=jobCompletion(job,result);
    if(!TERMINAL.has(job.state)&&result?.nodeJobId&&(completion.completed||
      ['PENDING','STARTING','RUNNING','PREEMPTING'].includes(result.state)))persistSchedulerResult(service,job,result);
    return completion.state==='PENDING'?{...completion,queueReason:pendingJobReason(service,job)}:completion;
  }
  if(operation==='jobs.watch'){
    args=selectFields(args,['jobId']);
    const job=jobById(args.jobId);
    if(!job.machine)return jobView(job);
    if(TERMINAL.has(job.state)){
      authorizedMachine(job.machine);
      const original=jobView(job);
      if(!job.nodeJobId)return {...original,nativeObservation:unavailableObservation()};
      try{
        const result=await observeJob(job,'watch',{job:nativeJobSpec(job)});
        return {...original,nativeObservation:terminalNativeObservation(job,result)};
      }catch{return {...original,nativeObservation:unavailableObservation()};}
    }
    authorizedMachine(job.machine);
    let result;
    try{result=await observeJob(job,'watch',{job:nativeJobSpec(job)});}
    catch{return {...jobView(job),state:'UNKNOWN',error:'节点进度查询失败，任务状态待核对。',checkedAt:new Date().toISOString()};}
    if(!result?.nodeJobId)return jobView(job);
    try{persistSchedulerResult(service,job,result);return jobView(job);}
    catch{
      // Keep advisory progress inspectable, but never treat an observation as
      // a saved lifecycle result or release the restored reservation.
      const observed={...job};applyJobFeedback(observed,result);observed.progressCheckedAt=new Date().toISOString();
      return {...jobView(observed),state:'UNKNOWN',notSaved:true,error:'节点观察结果未保存，任务状态待核对。',checkedAt:new Date().toISOString()};
    }
  }
  if(operation==='jobs.diagnostics'){
    args=selectFields(args,['jobId']);
    const job=jobById(args.jobId);authorizedMachine(job.machine);
    const dependencies={after:job.after||[],queueReason:pendingJobReason(service,job)};
    if(!TERMINAL.has(job.state))return {...await observeJob(job,'diagnostics',{job:nativeJobSpec(job)}),...dependencies};
    try{
      const result=await observeJob(job,'diagnostics',{job:nativeJobSpec(job)});
      const nativeObservation=terminalNativeObservation(job,result);
      return {...result,...dependencies,portalTerminal:portalTerminalSnapshot(job),nativeObservation};
    }catch{return {jobId:job.id,state:'UNAVAILABLE',...dependencies,portalTerminal:portalTerminalSnapshot(job),nativeObservation:unavailableObservation()};}
  }
  if(['files.list','files.get'].includes(operation)){
    args=selectFields(args,['machine','ownerId','dataset','project','area','runId','path','offset','cursor','limit']);
    if(args.area==='output'){
      const job=jobById(args.runId);args={...args,machine:job.machine,project:job.project,ownerId:job.ownerId??job.userId};
    }
    authorizedMachine(args.machine);const context=validateProjectFile(args);
    if(context.area==='dataset')directoryName(args.dataset);else delete args.dataset;
    if(args.path!==undefined)relativePath(args.path,{directory:operation==='files.list'});
    if(args.offset!==undefined&&(!Number.isSafeInteger(args.offset)||args.offset<0))fail('文件偏移无效。');
    if(args.limit!==undefined&&(!Number.isSafeInteger(args.limit)||args.limit<1||args.limit>1000))fail('每页最多 1000 项。');
    const {machine,cursor,...request}=args;
    if(operation==='files.list'&&cursor!==undefined){const offset=Number(cursor);if(!Number.isSafeInteger(offset)||offset<0)fail('目录页码无效，请从第一页重新读取。');request.offset=offset;}
    const result=await bridge(machine,operation,{...request,ownerId:args.ownerId??user.id,userId:user.id,actor});
    return operation==='files.list'?{...result,hasMore:result.nextOffset!=null,nextCursor:result.nextOffset==null?null:String(result.nextOffset)}:result;
  }
  fail('未知操作。');
}
function directoryName(value){
  if(typeof value!=='string'||!value||Buffer.byteLength(value)>255||value==='.'||value==='..'||value==='.trash'||/[\/\\\x00-\x1f\x7f]/.test(value))fail('数据集目录名称无效。');
}
function relativePath(value,{directory=false}={}){
  if(typeof value!=='string'||Buffer.byteLength(value)>4096||/[\\\x00-\x1f\x7f]/.test(value)||value.startsWith('/')||
    !directory&&!value||value&&value.split('/').some(part=>part==='..'))fail('请使用所选目录内的相对路径。');
}
