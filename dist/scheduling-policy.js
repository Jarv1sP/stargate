// Shared browser/server contract. Rendering and DOM state live in scheduling-ui.
const FIELDS=new Set(['rank','yieldPolicy','restartPolicy','checkpointable','mode']);
const DEFAULTS=Object.freeze({rank:'P2',yieldPolicy:'never',restartPolicy:'never',checkpointable:false});

export function schedulingPolicy(value,admin=false){
  if(!value||typeof value!=='object'||Array.isArray(value)){
    throw Error('自定义调度参数无效。');
  }
  const policy={...DEFAULTS,...Object.fromEntries([...FIELDS].filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]]))};
  const {rank,yieldPolicy,restartPolicy,checkpointable}=policy;
  if(Object.hasOwn(value,'mode')){
    const modes={queue:'queue','preempt1':'preempt-save','preempt2':'preempt-now','preempt-save':'preempt-save','preempt-now':'preempt-now'};
    if(typeof value.mode!=='string'||!Object.hasOwn(modes,value.mode))throw Error('模式须为 queue、preempt1 或 preempt2。');
    policy.mode=modes[value.mode];
    if(policy.mode==='queue')delete policy.mode;
  }
  if(typeof rank!=='string'||!/^P[0-4]$/.test(rank))throw Error('排队等级必须为 P0–P4。');
  if(!['never','now','save'].includes(yieldPolicy)||!['never','on-preempt'].includes(restartPolicy)||typeof checkpointable!=='boolean'){
    throw Error('让位或恢复策略无效。');
  }
  if(yieldPolicy==='save'&&!checkpointable)throw Error('保存让位需要明确确认训练已接入 epoch checkpoint 适配器。');
  if(restartPolicy==='on-preempt'&&(yieldPolicy!=='save'||!checkpointable)){
    throw Error('自动恢复需要保存让位和 checkpoint 适配器；立即让位不自动从头重跑。');
  }
  return policy;
}
