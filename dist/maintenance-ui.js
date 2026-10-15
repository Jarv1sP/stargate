import {maintenanceFor,maintenanceInfoHTML} from './maintenance-state.js';
import {copyHelp} from './copy-help-ui.js';
const visible=v=>String(v??'').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,c=>c==='\n'?c:'\\u{'+c.codePointAt(0).toString(16).padStart(4,'0')+'}');
const esc=v=>visible(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function operationalMaintenanceHTML(value,machine,{unknown=false}={}){
  if(unknown||!value)return '<aside class="maintenance-banner glass" role="status"><strong>维护状态未确认</strong></aside>';
  const entry=maintenanceFor(value,machine);if(!entry)return '';
  const scope=value.global?'全平台':machine;
  return `<aside class="maintenance-banner glass" role="status"><strong>${esc(scope)}维护中</strong><span class="maintenance-notice-reason" title="${esc(entry.reason)}">${esc(entry.reason)}</span><span>暂停训练提交、终端输入和数据写入</span>${maintenanceInfoHTML("仍可查看日志、下载和取消任务。维护不会自动结束已有任务；需管理员明确恢复。","维护限制")}</aside>`;
}
export function operationalMaintenanceUI(store,toast,onChange=()=>{},{host=document.querySelector('#operational-maintenance'),management=false,active=()=>true}={}){
  let identity=null,revision=-1,workspaceMachine=null;
  const render=()=>{
    if(!host)return;
    const value=store.data?.operationalMaintenance,actor=store.principal,admin=management&&actor?.role==='admin';
    if(!actor||!active()||management&&!admin){host.replaceChildren();identity=null;revision=-1;return;}
    if(!management){const machine=document.querySelector('#context-machine')?.value||document.querySelector('[name=workspace-machine]')?.value||workspaceMachine;host.innerHTML=operationalMaintenanceHTML(value,machine,{unknown:store.maintenanceStatusUnknown});return;}
    const nextIdentity=actor.userId+':'+actor.role;
    if(identity!==nextIdentity){
      identity=nextIdentity;revision=-1;
      host.innerHTML=(management?'':'<div data-maintenance-banner></div>')+(admin?`<dialog id="maintenance-settings-dialog" class="modal maintenance-settings" aria-labelledby="maintenance-settings-title"><div class="modal-head"><div class="copy-caption"><h2 id="maintenance-settings-title">维护设置</h2>${copyHelp('维护设置','维护暂停新操作，已有任务不会自动停止。维修完成后需要明确恢复。')}</div><button type="button" class="button quiet" data-maintenance-settings-close>关闭</button></div><form><label>范围<select name="scope"><option value="all">全平台</option>${(store.data.machines||[]).map(m=>`<option value="${esc(m.id)}">${esc(m.id)}</option>`).join('')}</select></label><div class="maintenance-reason-field"><div class="field-caption"><label for="maintenance-settings-reason">公开维护原因</label><span data-maintenance-public-reason></span></div><input id="maintenance-settings-reason" name="reason" maxlength="300" placeholder="例如：存储维护"></div><div><button class="button" type="submit">启用维护</button><button class="button" type="button" data-maintenance-resume>明确恢复此范围</button><button class="button" type="button" data-maintenance-refresh>刷新状态</button></div><p data-maintenance-error class="form-error" role="alert"></p></form></dialog>`:'');
      if(admin){
        const form=host.querySelector('form'),error=host.querySelector('[data-maintenance-error]'),stamp=store.authGeneration;
        host.querySelector('[data-maintenance-settings-close]').addEventListener('click',()=>host.querySelector('dialog').close());
        const current=()=>active()&&!store.authPending&&stamp===store.authGeneration&&identity===nextIdentity&&host.contains(form)&&store.principal?.role==='admin';
        const select=()=>{const current=store.data.operationalMaintenance||{machines:{}},scope=form.elements.scope.value;form.elements.reason.value=(scope==='all'?current.global:current.machines[scope])?.reason||'';form.querySelector('[data-maintenance-public-reason]').innerHTML=scope==='all'?copyHelp('全平台维护原因说明','全平台维护原因会公开显示在登录页，请勿写服务器名或内部信息。'):'';};
        form.elements.scope.addEventListener('change',select);
        const apply=async enabled=>{
          if(!current())return;
          const userId=store.principal?.userId;
          const buttons=[...form.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);error.textContent='';
          try{
            await store.call('maintenance.set',{scope:form.elements.scope.value,enabled,...(enabled?{reason:form.elements.reason.value}:{})});
            if(store.principal?.userId!==userId||!current())return;
            select();host.querySelector('dialog')?.close();if(!management)host.querySelector('[data-maintenance-banner]').innerHTML=operationalMaintenanceHTML(store.data.operationalMaintenance);onChange();toast(enabled?'维护已启用；已有任务不会自动结束':'已明确解除所选范围的维护');
          }catch(e){if(store.principal?.userId===userId&&current())error.textContent=e.message;}finally{if(current())buttons.forEach(b=>b.disabled=false);}
        };
        form.addEventListener('submit',event=>{event.preventDefault();apply(true);});
        form.querySelector('[data-maintenance-resume]').addEventListener('click',()=>{if(current())apply(false);});
        form.querySelector('[data-maintenance-refresh]').addEventListener('click',async()=>{if(!current())return;try{await store.refresh();if(!current())return;select();error.textContent='';if(!management)host.querySelector('[data-maintenance-banner]').innerHTML=operationalMaintenanceHTML(store.data.operationalMaintenance);onChange();}catch(e){if(current())error.textContent=e.message;}});
        select();
      }
    }
    if(revision!==value?.revision){if(!management)host.querySelector('[data-maintenance-banner]').innerHTML=operationalMaintenanceHTML(value);revision=value?.revision;}
  };
  if(!management){document.addEventListener('gpuq-workspace-context',event=>{workspaceMachine=event.detail?.userId===store.principal?.userId?event.detail.machine:null;render();});document.addEventListener('gpuq-maintenance-observation',render);store.onAuthChange(()=>{workspaceMachine=null;host?.replaceChildren();});}
  return render;
}
