import {maintenanceFor,maintenanceInfoHTML} from './maintenance-state.js';
const visible=v=>String(v??'').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,c=>c==='\n'?c:'\\u{'+c.codePointAt(0).toString(16).padStart(4,'0')+'}');
const esc=v=>visible(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function operationalMaintenanceHTML(value,machine,{unknown=false}={}){
  if(unknown||!value)return '<aside class="maintenance-banner glass" role="status"><strong>维护状态未确认</strong></aside>';
  const entry=maintenanceFor(value,machine);if(!entry)return '';
  const scope=value.global?'全平台':machine;
  return `<aside class="maintenance-banner glass" role="status"><strong>${esc(scope)}维护中</strong><span class="maintenance-notice-reason" title="${esc(entry.reason)}">${esc(entry.reason)}</span><span>暂停训练提交、终端输入和数据写入</span>${maintenanceInfoHTML("仍可查看日志、下载和取消任务。维护不会自动结束已有任务；需管理员明确恢复。","维护限制")}</aside>`;
}
export function operationalMaintenanceUI(store){
  const host=document.querySelector('#operational-maintenance');let workspaceMachine=null;
  const render=()=>{
    if(!host)return;
    if(!store.principal){host.replaceChildren();return;}
    const machine=document.querySelector('#context-machine')?.value||document.querySelector('[name=workspace-machine]')?.value||workspaceMachine;
    host.innerHTML=operationalMaintenanceHTML(store.data?.operationalMaintenance,machine,{unknown:store.maintenanceStatusUnknown});
  };
  document.addEventListener('gpuq-workspace-context',event=>{workspaceMachine=event.detail?.userId===store.principal?.userId?event.detail.machine:null;render();});
  document.addEventListener('gpuq-maintenance-observation',render);
  store.onAuthChange(()=>{workspaceMachine=null;host?.replaceChildren();});
  return render;
}
