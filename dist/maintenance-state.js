// Presentation and explicit recovery orchestration only. The Portal remains
// responsible for maintenance changes.
export function maintenanceInfoHTML(text,label='说明'){
  const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  return `<span class="maintenance-info"><button type="button" data-maintenance-info aria-expanded="false" aria-label="${escape(label)}">ⓘ</button><span class="maintenance-info-body" role="note">${escape(text)}</span></span>`;
}
export function maintenanceClock(value){const date=new Date(value);return value&&Number.isFinite(date.getTime())?date.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}):'未更新';}
export function maintenanceFor(value,machine){return value?.global||value?.machines?.[machine]||null;}
export const maintenanceActive=value=>!!(value?.global||Object.keys(value?.machines||{}).length);
export const heldDuringMaintenance=(job,value)=>!!maintenanceFor(value,job.machine)&&['PENDING','QUEUED'].includes(job.state)&&!job.cancelRequested;
export function maintenanceTime(since){const date=new Date(since);return since&&Number.isFinite(date.getTime())?date.toLocaleString('zh-CN',{hour12:false}):'开始时间未提供';}
const disabledBeforeMaintenance=new WeakMap();
export function restoreMaintenanceControls(root){
  for(const node of root.querySelectorAll('[data-maintenance-blocked]')){const previous=disabledBeforeMaintenance.get(node);if(previous){node.disabled=previous.disabled;node.title=previous.title;disabledBeforeMaintenance.delete(node);}node.removeAttribute('data-maintenance-blocked');}
}
export function disableMaintenanceControls(root,selectors,entry){
  if(!entry)return;
  for(const node of root.querySelectorAll(selectors)){if(!disabledBeforeMaintenance.has(node))disabledBeforeMaintenance.set(node,{disabled:node.disabled,title:node.title});node.disabled=true;node.title='维护中：平台写入暂停；仍可查看状态、下载或取消。';node.setAttribute('data-maintenance-blocked','');}
}
