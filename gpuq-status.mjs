import {readFile,stat} from 'node:fs/promises';
import {MACHINES} from './dist/model.js';
import {taskCatalog} from './task-catalog.mjs';

const number=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const text=(value,limit=120)=>typeof value==='string'?value.replace(/[\x00-\x1f\x7f]/g,'').slice(0,limit):null;
function scheduling(value,admin=true){
  if(!value||!Number.isInteger(value.priority)||value.priority<0||value.priority>4)return undefined;
  return {priority:value.priority,...(admin?{jobId:text(value.jobId),yieldPolicy:['legacy','never','now','save'].includes(value.yieldPolicy)?value.yieldPolicy:null}:{})};
}
function gpuMetrics(gpu){
  const utilization=number(gpu.utilization);
  return {index:gpu.index,uuid:text(gpu.uuid),model:text(gpu.model),memoryTotalMiB:number(gpu.memoryTotalMiB),memoryUsedMiB:number(gpu.memoryUsedMiB),utilization:utilization!==null&&utilization<=100?utilization:null,temperatureC:number(gpu.temperatureC),powerDrawW:number(gpu.powerDrawW),powerLimitW:number(gpu.powerLimitW)};
}
function healthIssue(value,cards=64){
  if(value?.kind==='scheduler-degraded')return {kind:'scheduler-degraded'};
  if(value?.kind!=='managed-gpu-missing'||!Array.isArray(value.indices)||value.indices.length>64||value.indices.some(index=>!Number.isSafeInteger(index)||index<0||index>=cards)||new Set(value.indices).size!==value.indices.length)return undefined;
  return {kind:'managed-gpu-missing',indices:[...value.indices].sort((a,b)=>a-b)};
}
function gpuStatus(gpu){
  const raw=Array.isArray(gpu.processes)?gpu.processes:[],valid=raw.filter(p=>p&&Number.isSafeInteger(p.pid)&&p.pid>0&&p.pid<=2147483647),incomplete=valid.length!==raw.length||valid.length>128;
  return {...gpuMetrics(gpu),processesAvailable:gpu.processesAvailable===true&&!incomplete,
    ...(incomplete?{processesError:'GPU process list incomplete'}:gpu.processesError?{processesError:text(gpu.processesError)}:{}),
    processes:valid.slice(0,128).map(p=>({pid:p.pid,name:text(p.name)?.split(/[\\/]/).pop()||null,owner:text(p.owner,80),memoryUsedMiB:number(p.memoryUsedMiB),type:'compute',...(scheduling(p.scheduling)?{scheduling:scheduling(p.scheduling)}:{})}))};
}

export async function readGPUQStatus(path,now=Date.now(),previous){
  let data={checkedAt:null,hosts:[]},stale=true;
  try{
    if(path&&(await stat(path)).size<=2_000_000){
      const value=JSON.parse(await readFile(path,'utf8')),checked=Date.parse(value.checkedAt);
      if(Number.isFinite(checked)&&Array.isArray(value.hosts)){
        data=value;stale=now-checked>180000||checked-now>30000;
      }
    }
  }catch{/* Preserve the previous observation, never manufacture a new one. */}
  return {checkedAt:data.checkedAt||previous?.checkedAt||null,stale,hosts:MACHINES.map(machine=>{
      const host=data.hosts.find(item=>item?.id===machine.id);
      const last=previous?.hosts?.find(item=>item.id===machine.id);
      if((stale||host?.reachable!==true||!Array.isArray(host.gpus)||!host.gpus.length)&&last?.reachable===true&&last.gpus?.length)
        return {...last,samplingStale:true,checkedAt:last.checkedAt||previous.checkedAt,
          };
      if(!host||stale)return {id:machine.id,reachable:false,gpus:[],gpuq:{connected:false,jobs:[]},error:stale?'状态已过期':'暂无状态'};
      return {...host,checkedAt:host.checkedAt||data.checkedAt,samplingStale:host.samplingStale===true,reachable:host.reachable===true,
        gpus:Array.isArray(host.gpus)?host.gpus.filter(g=>g&&Number.isInteger(g.index)&&g.index>=0).slice(0,machine.cards).map(gpuStatus):[],
        gpuq:{...host.gpuq,connected:host.gpuq?.connected===true,
          healthIssue:host.gpuq?.health==='degraded'?healthIssue(host.gpuq?.healthIssue,machine.cards):undefined,
          jobs:Array.isArray(host.gpuq?.jobs)?host.gpuq.jobs:[]}};
    })};
}

export function visibleGPUQStatus(snapshot,principal,limits,context){
  return {...snapshot,hosts:snapshot.hosts.map(host=>{
    const base=structuredClone(host),catalog=context?taskCatalog(host,context,true):null;
    // All team members receive the same sampled GPU/data-volume facts.
    // No host shell or filesystem read is dispatched for these diagnostics.
    base.gpus=host.gpus.map(gpu=>({...structuredClone(gpu),processes:(gpu.processes||[]).map(process=>{
      const task=catalog?.byNode.get(process.scheduling?.jobId);
      return {...structuredClone(process),...(task?{task}:{})};
    })}));
    if(catalog)base.tasks=catalog.tasks;
    delete base.hostCommand;
    return base;
  })};
}
