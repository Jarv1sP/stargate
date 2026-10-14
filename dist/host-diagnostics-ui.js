import {escapeUI as esc} from './workbench-ui.js';

export const hostDiagnosticPresets=Object.freeze([
  Object.freeze({id:'gpu',title:'GPU 状态'}),
  Object.freeze({id:'disk',title:'数据盘用量'}),
]);
const number=(value,unit='')=>Number.isFinite(value)&&value>=0?value+unit:'未知';
const bytes=value=>Number.isFinite(value)&&value>=0?(value/1024**3).toFixed(2)+' GiB':'未知';
export function hostDiagnosticAvailability(data,machine){
  const host=data?.gpuq?.hosts?.find(row=>row.id===machine);
  return !host||host.reachable!==true?'主机状态未知，请稍后刷新。':host.samplingStale||data.gpuq.stale?'采样已过期，下面保留上次读数；请刷新。':'';
}
export function hostDiagnosticText(data,machine,kind='gpu'){
  const host=data?.gpuq?.hosts?.find(row=>row.id===machine);
  if(!host)return '主机状态未知，请稍后刷新。';
  if(kind==='disk')return (host.disks||[]).map(disk=>[
    disk.mountPoint||'挂载点未知',
    '已用 '+bytes(disk.usedBytes)+' / 总量 '+bytes(disk.totalBytes)+' / 可用 '+bytes(disk.availableBytes),
  ].join('\n')).join('\n\n')||'数据盘采样未知，请稍后刷新。';
  return (host.gpus||[]).map(gpu=>{
    const tasks=new Map();
    for(const process of gpu.processes||[]){const task=process.task;if(task)tasks.set(task.id||task.jobId,task.name||task.id||task.jobId);}
    for(const task of host.tasks||[])if((task.assignedIndices||[]).includes(gpu.index))tasks.set(task.id,task.name||task.id);
    const processes=(gpu.processes||[]).map(process=>'PID '+process.pid+' · '+number(process.memoryUsedMiB,' MiB')).join('；');
    return ['GPU '+gpu.index+' · '+(gpu.model||'型号未知'),
      '使用率 '+number(gpu.utilization,'%')+' · 显存 '+number(gpu.memoryUsedMiB)+' / '+number(gpu.memoryTotalMiB,' MiB')+' · 温度 '+number(gpu.temperatureC,' °C'),
      '功率 '+number(gpu.powerDrawW)+' / '+number(gpu.powerLimitW,' W'),
      '正在用卡的任务：'+([...tasks.values()].filter(Boolean).join('、')||(gpu.processesAvailable===true&&!gpu.processes?.length?'无':'未知')),
      ...(processes?['进程：'+processes]:[])].join('\n');
  }).join('\n\n')||'GPU 采样未知，请稍后刷新。';
}

export function hostDiagnosticsUI(store,{toast=()=>{}}={}){
  const root=document.createElement('section');root.id='admin-host-diagnostics';root.className='host-diagnostics';
  let ctx=null,machine='',kind='gpu',refreshing=false;
  const active=()=>ctx&&!ctx.signal.aborted&&!store.authPending&&store.principal?.role==='admin'&&store.principal.userId===ctx.principal.userId;
  function paint(){
    if(!active())return;
    root.querySelector('[data-host-machine]').value=machine;
    root.querySelector('[data-host-unavailable]').textContent=hostDiagnosticAvailability(store.data,machine);
    const host=store.data?.gpuq?.hosts?.find(row=>row.id===machine),checked=host?.checkedAt||store.data?.gpuq?.checkedAt;
    root.querySelector('[data-host-state]').textContent=(hostDiagnosticPresets.find(row=>row.id===kind)?.title||'主机状态')+' · '+(checked?'更新于 '+checked:'采样时间未知');
    root.querySelector('[data-host-receipt]').textContent=hostDiagnosticText(store.data,machine,kind);
    for(const button of root.querySelectorAll('[data-host-preset]'))button.setAttribute('aria-pressed',String(button.dataset.hostPreset===kind));
    root.querySelector('[data-host-query]').disabled=refreshing;
  }
  function select(target){if(active()&&store.data?.machines?.some(row=>row.id===target)){machine=target;paint();}}
  function mount(el,context){
    ctx=context;el.append(root);
    root.innerHTML=`<div class="host-diagnostics-heading"><h3>主机诊断</h3><label>服务器<select data-host-machine></select></label></div><p role="status" data-host-unavailable></p><div class="host-diagnostic-presets">${hostDiagnosticPresets.map(row=>`<button type="button" class="button" data-host-preset="${esc(row.id)}">${esc(row.title)}</button>`).join('')}</div><div class="host-command-result"><strong data-host-state></strong><pre tabindex="0" aria-label="诊断输出" data-host-receipt></pre><div class="host-command-actions"><button type="button" class="button quiet" data-host-copy-output>复制结果</button><button type="button" class="button" data-host-query>刷新采样</button></div></div>`;
    root.addEventListener('click',async event=>{
      const button=event.target.closest('button');if(!active()||!button||button.disabled)return;
      if(button.dataset.hostPreset){kind=button.dataset.hostPreset;paint();}
      else if(button.hasAttribute('data-host-copy-output'))try{await navigator.clipboard.writeText(hostDiagnosticText(store.data,machine,kind));toast('已复制');}catch{toast('复制未完成，请选中文字复制。');}
      else if(button.hasAttribute('data-host-query')){const current=ctx;refreshing=true;paint();try{await store.refresh();}catch(error){if(ctx===current&&active())toast(error.message);}finally{if(ctx===current&&active()){refreshing=false;paint();}}}
    },{signal:context.signal});
    root.querySelector('[data-host-machine]').addEventListener('change',event=>select(event.target.value),{signal:context.signal});
    context.subscribe(()=>{if(!active())return;const rows=store.data?.machines||[],selector=root.querySelector('[data-host-machine]');selector.innerHTML=rows.map(row=>`<option value="${esc(row.id)}">${esc(row.id)}</option>`).join('');if(!rows.some(row=>row.id===machine))machine=rows[0]?.id||'';paint();});
  }
  function unmount(){ctx=null;machine='';kind='gpu';refreshing=false;root.replaceChildren();root.remove();}
  return {mount,unmount,select};
}
