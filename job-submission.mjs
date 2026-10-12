import {createHash,randomUUID} from 'node:crypto';
import {MACHINES} from './dist/model.js';
import {projectReference} from './projects.mjs';
import {schedulingPolicy} from './dist/scheduling-policy.js';
import {elasticAllocation,gpuPlacement} from './dist/gpu-allocation.js';
import {taskDescription,displayName} from './dist/task-metadata.js';

const FIELDS=new Set([
  'machine','cards','minVramGiB','argv','name','description','key',
  'project','priority','scheduling','elastic','placement',
  'machineSelection','interactive','memoryLimitGiB',
]);
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};

// Current enabled administrators are exempt from personal cumulative card
// counts, not per-job physical capacity, placement, VRAM or dataset leases.
export const personalCardQuotaExempt=user=>user.enabled===true&&user.role==='admin';

export function datasetReferences(value){
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>8)fail('每个任务最多关联 8 个数据集版本。');
  const names=new Set();
  for(const item of value){
    if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).sort().join(',')!=='dataset,version'||
       typeof item.dataset!=='string'||typeof item.version!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(item.dataset)||!/^[a-f0-9]{64}$/.test(item.version)||names.has(item.dataset))fail('数据集需指定唯一名称和完整版本哈希。');
    names.add(item.dataset);
  }
  return value.map(({dataset,version})=>({dataset,version}));
}

export function normalizeJobSubmission(args,principal){
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!FIELDS.has(k)))fail('提交参数无效。');
  if(args.memoryLimitGiB!==undefined&&(!Number.isSafeInteger(args.memoryLimitGiB)||args.memoryLimitGiB<1||args.memoryLimitGiB>1048576))fail('内存上限须为正整数 GiB；不填则共享节点内存池。');
  if(args.scheduling!==undefined&&args.priority!==undefined)fail('自定义调度不能与旧优先级预设混用。');
  let explicit=null;
  if(args.scheduling!==undefined){
    try{explicit=schedulingPolicy(args.scheduling,principal.role==='admin');}
    catch(error){fail(error.message,error.status||400);}
  }
  const priority=args.priority===undefined?'normal':args.priority;
  if(!['idle','normal','high'].includes(priority))fail('优先级必须为 idle、normal 或 high。');
  if(priority==='high'&&principal.role!=='admin')fail('高优先级仅管理员可用。',403);
  let machineSelection;
  if(args.machineSelection!==undefined||args.machine==='auto'){
    const selection=args.machineSelection??{mode:'auto'};
    if(!selection||typeof selection!=='object'||Array.isArray(selection)||Object.keys(selection).some(k=>!['mode','candidates'].includes(k))||selection.mode!=='auto'||
      Object.hasOwn(args,'machine')&&args.machine!=='auto')fail('自动选机参数无效；不要同时指定固定服务器。');
    const candidates=selection.candidates;
    if(candidates!==undefined&&(!Array.isArray(candidates)||!candidates.length||candidates.length>MACHINES.length||candidates.some(id=>!MACHINES.some(m=>m.id===id))||new Set(candidates).size!==candidates.length))fail('候选服务器须为不重复的有效机器列表。');
    machineSelection={mode:'auto',...(candidates?{candidates:[...candidates].sort()}: {})};
  }else if(!Object.hasOwn(args,'machine')||typeof args.machine!=='string'||!MACHINES.some(m=>m.id===args.machine))fail('请选择有效的服务器，或使用 auto 自动选机。');
  const project={...projectReference(args,{optional:false}),workspace:true};
  if(args.interactive!==undefined&&(args.interactive!==true||!project.workspace||JSON.stringify(args.argv)!==JSON.stringify(['/bin/bash','--noprofile','--norc','-i'])))fail('GPU 交互终端需要当前项目工作区和交互 shell。');
  if(args.interactive&&explicit?.restartPolicy==='on-preempt')fail('交互终端不能自动重放手动命令；需要自动恢复或扩卡，请直接提交训练命令。');
  if(typeof args.key!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(args.key))fail('需提供 UUID 提交键，重试必须复用。');
  if(!Array.isArray(args.argv)||!args.argv.length||args.argv.length>128||args.argv.some(a=>typeof a!=='string'||a.includes('\0'))||JSON.stringify(args.argv).length>12000)fail('训练命令无效或过长。');
  if(!Number.isInteger(args.cards)||args.cards<1||args.cards>Math.max(...MACHINES.map(m=>m.cards)))fail('申请卡数超出单机容量。');
  let allocation=null;
  if(args.elastic!==undefined){try{allocation=elasticAllocation(args.elastic,args.cards,explicit);}catch(error){fail(error.message);}}
  let placement=null;
  if(args.placement!==undefined){try{placement=gpuPlacement(args.placement,args.cards,allocation,explicit,priority);}catch(error){fail(error.message);}}
  const minVramGiB=args.minVramGiB??0;
  if(typeof minVramGiB!=='number'||!Number.isFinite(minVramGiB)||minVramGiB<0||minVramGiB>128)fail('最低显存参数无效。');
  const name=args.name||'train';
  if(typeof name!=='string'||name.length>64||/[\x00-\x1f]/.test(name))fail('任务名称无效。');
  const description=taskDescription(args.description);
  const request={machine:machineSelection?'auto':args.machine,cards:args.cards,minVramGiB,argv:[...args.argv],name,description,key:args.key,
    project,priority,priorityProvided:args.priority!==undefined,explicit,
    ...(machineSelection?{machineSelection}:{}),...(args.interactive?{interactive:true}:{}),
    ...(placement?{placement}:{}),
    ...(allocation?{elastic:allocation.elastic,allowedGpuCounts:allocation.allowed}:{})};
  // The key binds the complete request; retries cannot change the command.
  const identity=[request.machine,request.cards,minVramGiB,request.argv,name];
  if(project.project)identity.push(project);
  if(request.priorityProvided)identity.push({priority});
  if(explicit)identity.push({scheduling:explicit});
  if(allocation)identity.push({elastic:allocation.elastic});
  if(placement)identity.push({placement});
  if(description)identity.push({description});
  if(machineSelection)identity.push({machineSelection});
  if(request.interactive)identity.push({interactive:true});
  if(args.memoryLimitGiB!==undefined){request.memoryLimitGiB=args.memoryLimitGiB;identity.push({memoryLimitGiB:args.memoryLimitGiB});}
  request.digest=createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  return request;
}

export function createSubmittedJob(request,user,prioritySupported,{id=randomUUID(),now=new Date().toISOString()}={}){
  const {machine,cards,minVramGiB,name,key,digest,project,priority,explicit}=request;
  const context={...project,...(request.interactive?{interactive:true}:{}),...(request.elastic?{elastic:structuredClone(request.elastic)}:{}),...(request.placement?{placement:structuredClone(request.placement)}:{})};
  const policy=explicit?{scheduling:structuredClone(explicit)}:prioritySupported?{priority,preemptIdleOnly:true}:{};
  const spec={id,userId:user.id,username:user.username,cards,argv:[...request.argv],name,minVramGiB,...context,...policy,...(request.memoryLimitGiB!==undefined?{memoryLimitGiB:request.memoryLimitGiB}:{})};
  // Human-facing metadata belongs to the portal record, not the immutable
  // node execution spec: old nodes/receipts continue accepting the same spec.
  return {id,key,digest,spec,userId:user.id,username:user.username,submitterName:displayName(user.name??user.username),machine,cards,name,description:request.description,...context,
    ...(request.machineSelection?{machineSelection:structuredClone(request.machineSelection),
      ...(request.selectionSummary?{selectionSummary:structuredClone(request.selectionSummary)}:{})}:{}),
    ...(request.elastic?{allowedGpuCounts:[...request.allowedGpuCounts]}:{}),
    ...(explicit?{scheduling:structuredClone(explicit)}:{}),priority:explicit?null:prioritySupported?priority:null,
    state:'SUBMITTING',dispatchPending:true,createdAt:now,cancelRequested:false};
}
