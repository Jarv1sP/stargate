import {maintenanceFor,maintenanceClock} from './maintenance-state.js';
import {serverIdHTML,escapeUI as esc} from './workbench-ui.js';
export function maintenanceExperienceUI(store,toast,{getPage}){
  const host=document.createElement('section');host.id='admin-maintenance-console';let context=null;
  function update(){
    if(!context||context.signal.aborted||getPage()!=='admin'||store.principal?.role!=='admin')return;
    const value=store.data?.operationalMaintenance;
    host.innerHTML=`<header class="maintenance-console-heading"><h3>维护模式</h3><button type="button" class="button" data-maintenance-settings>设置范围与开关</button></header><p>维护暂停新操作，不结束正在运行的任务。</p><div class="maintenance-server-list">${(store.data?.machines||[]).map(machine=>{const entry=maintenanceFor(value,machine.id);return `<article class="maintenance-server-row"><strong>${serverIdHTML(machine.id)}</strong><span>${value?entry?'维护中 · '+esc(entry.reason)+' · '+esc(maintenanceClock(entry.since)):'未开启维护':'维护状态未知，可刷新或直接设置'}</span><button type="button" class="button quiet" data-maintenance-host="${esc(machine.id)}">主机状态</button></article>`;}).join('')}</div>`;
  }
  host.addEventListener('click',event=>{const button=event.target.closest('[data-maintenance-host]');if(button)document.dispatchEvent(new CustomEvent('gpuq-maintenance-host',{detail:{machine:button.dataset.maintenanceHost,userId:store.principal?.userId}}));});
  update.mountAdmin=(element,ctx)=>{context=ctx;element.append(host);ctx.subscribe(update);};
  update.unmountAdmin=()=>{context=null;host.replaceChildren();host.remove();};
  return update;
}
