import {UUID,selectFields,assertArgv} from './portal-request-validation.mjs';
import {randomUUID} from 'node:crypto';
import {MACHINES} from './dist/model.js';
import {projectReference} from './projects.mjs';
import {schedulingPolicy} from './dist/scheduling-policy.js';
import {elasticAllocation,gpuPlacement} from './dist/gpu-allocation.js';
import {taskDescription,displayName} from './dist/task-metadata.js';

const FIELDS=new Set([
  'machine','cards','minVramGiB','argv','name','description','key',
  'project','priority','scheduling','elastic','placement',
  'machineSelection','interactive','memoryLimitGiB','sourceMachine',
]);
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};

// Current enabled administrators are exempt from personal cumulative card
// counts, not per-job physical capacity, placement, VRAM or dataset leases.
export const personalCardQuotaExempt=user=>user.enabled===true&&user.role==='admin';

export function normalizeJobSubmission(args,principal){
  if(!args||typeof args!=='object'||Array.isArray(args))fail('提交参数无效。');
  args=selectFields(args,[...FIELDS,'ownerId']);
  if(args.memoryLimitGiB!==undefined&&(!Number.isSafeInteger(args.memoryLimitGiB)||args.memoryLimitGiB<1||args.memoryLimitGiB>1048576))fail('内存上限须为正整数 GiB。');
  if(args.scheduling!==undefined&&args.priority!==undefined)fail('自定义调度不能与旧优先级预设混用。');
  let explicit=null;
  if(args.scheduling!==undefined){
    try{explicit=schedulingPolicy(args.scheduling,true);}
    catch(error){fail(error.message,error.status||400);}
  }
  const priority=args.priority===undefined?'normal':args.priority;
  if(!['idle','normal','high'].includes(priority))fail('优先级必须为 idle、normal 或 high。');
  let machineSelection;
  if(args.machineSelection!==undefined||args.machine==='auto'){
    const selection=args.machineSelection??{mode:'auto'};
    if(!selection||typeof selection!=='object'||Array.isArray(selection)||selection.mode!=='auto'||
      Object.hasOwn(args,'machine')&&args.machine!=='auto')fail('自动选机参数无效；不要同时指定固定服务器。');
    const candidates=selection.candidates;
    if(candidates!==undefined&&(!Array.isArray(candidates)||!candidates.length||candidates.length>MACHINES.length||candidates.some(id=>!MACHINES.some(m=>m.id===id))||new Set(candidates).size!==candidates.length))fail('候选服务器须为不重复的有效机器列表。');
    machineSelection={mode:'auto',...(candidates?{candidates:[...candidates].sort()}: {})};
  }else if(!Object.hasOwn(args,'machine')||typeof args.machine!=='string'||!MACHINES.some(m=>m.id===args.machine))fail('请选择有效的服务器，或使用 auto 自动选机。');
  const project={...projectReference({project:args.project??'default'},{optional:false}),ownerId:args.ownerId??principal.userId,workspace:true};
  const sourceMachine=MACHINES.some(machine=>machine.id===args.sourceMachine)?args.sourceMachine:undefined;
  if(args.interactive!==undefined&&(args.interactive!==true||!project.workspace||JSON.stringify(args.argv)!==JSON.stringify(['/bin/bash','--noprofile','--norc','-i'])))fail('GPU 交互终端需要当前项目工作区和交互 shell。');
  if(args.interactive&&explicit?.restartPolicy==='on-preempt')fail('交互终端不能自动重放手动命令；需要自动恢复或扩卡，请直接提交训练命令。');
  if(typeof args.key!=='string'||!UUID.test(args.key))fail('需提供 UUID 提交键，重试必须复用。');
  assertArgv(args.argv);
  if(!Number.isInteger(args.cards)||args.cards<1||args.cards>Math.max(...MACHINES.map(m=>m.cards)))fail('申请卡数超出单机容量。');
  let allocation=null;
  if(args.elastic!==undefined){try{allocation=elasticAllocation(args.elastic,args.cards,explicit);}catch(error){fail(error.message);}}
  let placement=null;
  if(args.placement!==undefined){try{placement=gpuPlacement(args.placement,args.cards,allocation,explicit,priority);}catch(error){fail(error.message);}}
  const minVramGiB=args.minVramGiB??0;
  if(typeof minVramGiB!=='number'||!Number.isFinite(minVramGiB)||minVramGiB<0||minVramGiB>128)fail('最低显存参数无效。');
  const name=args.name||'train';
  if(typeof name!=='string')fail('任务名称无效。');
  if(name.length>64)fail(`任务名称最多 64 个字符（当前 ${name.length} 个），请缩短 --name。`);
  if(/[\x00-\x1f]/.test(name))fail('任务名称不能包含换行或控制字符。');
  const description=taskDescription(args.description);
  const request={machine:machineSelection?'auto':args.machine,cards:args.cards,minVramGiB,argv:[...args.argv],name,description,key:args.key,
    ...(sourceMachine?{sourceMachine}:{}),
    project,priority,priorityProvided:args.priority!==undefined,explicit,
    ...(machineSelection?{machineSelection}:{}),...(args.interactive?{interactive:true}:{}),
    ...(placement?{placement}:{}),
    ...(allocation?{elastic:allocation.elastic,allowedGpuCounts:allocation.allowed}:{})};
  if(args.memoryLimitGiB!==undefined)request.memoryLimitGiB=args.memoryLimitGiB;
  return request;
}

export function createSubmittedJob(request,user,prioritySupported,{id=randomUUID(),now=new Date().toISOString()}={}){
  const {machine,cards,minVramGiB,name,key,project,priority,explicit}=request;
  const context={...project,...(request.sourceMachine&&request.sourceMachine!==machine?{projectCopy:id}:{}),...(request.interactive?{interactive:true}:{}),...(request.elastic?{elastic:structuredClone(request.elastic)}:{}),...(request.placement?{placement:structuredClone(request.placement)}:{})};
  const policy=explicit?{scheduling:structuredClone(explicit)}:prioritySupported?{priority,preemptIdleOnly:true}:{};
  const spec={id,userId:user.id,username:user.username,cards,argv:[...request.argv],name,minVramGiB,...context,...policy,...(request.memoryLimitGiB!==undefined?{memoryLimitGiB:request.memoryLimitGiB}:{})};
  return {id,key,spec,userId:user.id,username:user.username,submitterName:displayName(user.name??user.username),machine,cards,name,description:request.description,...context,
    ...(request.sourceMachine?{sourceMachine:request.sourceMachine}:{}),
    ...(request.machineSelection?{machineSelection:structuredClone(request.machineSelection),
      ...(request.selectionSummary?{selectionSummary:structuredClone(request.selectionSummary)}:{})}:{}),
    ...(request.elastic?{allowedGpuCounts:[...request.allowedGpuCounts]}:{}),
    ...(explicit?{scheduling:structuredClone(explicit)}:{}),priority:explicit?null:prioritySupported?priority:null,
    state:'SUBMITTING',dispatchPending:true,createdAt:now,cancelRequested:false};
}
