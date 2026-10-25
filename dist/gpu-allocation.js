// One allocation contract shared by browser, CLI and submission service.
import {schedulingPolicy} from './scheduling-policy.js';
// Existing Console contract: scripts/configure.mjs inventories and the
// job-resources.py budget reader both support up to 64 cards per node. Native
// GPUQ itself limits by configured pool size; this is not a new native cap.
export function elasticAllocation(value,cards,scheduling){
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('弹性卡参数无效。');
  const {minCards,globalBatch,microBatch,autoExpand=false}=value;
  if(!Number.isInteger(cards)||cards<1||cards>64||!Number.isInteger(minCards)||minCards<1||minCards>cards)throw Error('最低卡数须为 1 到最大卡数之间的整数。');
  if(!Number.isSafeInteger(globalBatch)||globalBatch<1||!Number.isSafeInteger(microBatch)||microBatch<1||typeof autoExpand!=='boolean')throw Error('global batch、每卡 micro batch 须为正整数。');
  // Division first avoids unsafe products for large valid JS integers.
  const allowed=globalBatch%microBatch===0?Array.from({length:cards-minCards+1},(_,i)=>i+minCards).filter(n=>(globalBatch/microBatch)%n===0):[];
  if(!allowed.length)throw Error('弹性范围内没有能够整除 global batch 的合法卡数。');
  if(autoExpand){
    let consent;
    try{consent=schedulingPolicy(scheduling,true);}catch(error){throw Error('自动扩卡需要有效的保存和恢复策略：'+error.message);}
    if(consent.yieldPolicy!=='save'||!consent.checkpointable||consent.restartPolicy!=='on-preempt')throw Error('自动扩卡需要 checkpoint 适配器及保存后自动恢复策略。');
  }
  if(autoExpand&&allowed.length<2)throw Error('自动扩卡需要至少两种合法卡数。');
  return {elastic:{minCards,globalBatch,microBatch,autoExpand},allowed};
}

export function allocationLabel(job){const p=job.placement;return (job.elastic?`弹性 ${job.elastic.minCards}–${job.cards} 张 · 当前 ${job.actualCards??job.assignedIndices?.length??0} 张 · 合法卡数 ${(job.allowedGpuCounts||[]).join(',')}`:`${job.cards} 张`)+(p?` · ${p.shared?'共享':'固定'} GPU ${p.gpuIndices.join(',')}${p.shared?' · '+p.vramMiB+' MiB':''}${p.hami?' · HAMi SM '+p.smPercent+'%':''}`:'');}

export function gpuPlacement(value,cards,elastic,scheduling,priority){
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('固定/共享选卡参数无效。');
  const {gpuIndices,shared=false,hami=false,smPercent=hami?100:undefined}=value;
  if(elastic)throw Error('固定或共享显卡不能与弹性卡数混用。');
  if(!Number.isInteger(cards)||cards<1||cards>64||!Array.isArray(gpuIndices)||gpuIndices.length!==cards||gpuIndices.some(n=>!Number.isSafeInteger(n)||n<0)||new Set(gpuIndices).size!==cards||typeof shared!=='boolean'||typeof hami!=='boolean')throw Error('显卡编号必须唯一，且数量等于申请卡数。');
  const placement={gpuIndices:[...gpuIndices].sort((a,b)=>a-b),shared};
  if(shared){
    if(cards!==1||!Number.isInteger(value.vramMiB)||value.vramMiB<1||value.vramMiB>2**31-1)throw Error('共享需明确选择一张卡并声明正整数 MiB 显存预算。');
    const policy=scheduling===undefined||scheduling===null?null:schedulingPolicy(scheduling,true);
    if(policy&&(policy.yieldPolicy!=='never'||policy.restartPolicy!=='never'||(policy.mode??'queue')!=='queue')||priority==='idle')throw Error('共享任务使用普通排队，且不支持自动让位或恢复。');
    Object.assign(placement,{vramMiB:value.vramMiB,hami});
    if(hami){if(!Number.isInteger(smPercent)||smPercent<1||smPercent>100)throw Error('HAMi SM 百分比须为 1–100 的整数。');placement.smPercent=smPercent;}
    else if(value.smPercent!==undefined)throw Error('SM 限制需要启用 HAMi。');
  }else if(value.vramMiB!==undefined||hami||value.smPercent!==undefined)throw Error('显存预算和 HAMi 仅用于共享任务。');
  return placement;
}
