import {resourceCards,fitResourceNames} from './resources-ui.js';
import {renderTaskTable} from './execution-ui.js';
import {endedJob,personalQuotaReadout,escapeUI as esc} from './workbench-ui.js';
import {maintenanceFor} from './maintenance-state.js';
import {controlSnapshot} from './control-ui.js';

export function adminTasks(store,{owner='',machine='',state='active'}={}){
  return store.jobs.filter(job=>(!owner||job.userId===owner)&&(!machine||job.machine===machine)&&
    (state==='all'||(state==='ended'?endedJob(job):state==='active'&&!endedJob(job))));
}

export function registerGpuTasksAdmin(register){
  return register({id:'tasks',title:'显卡与任务',order:10,mount(el,ctx){
    const {store,signal}=ctx;
    let selected='',selectedGPU=0,resourceHTML='';
    const actor=ctx.principal.userId,generation=store.authGeneration,permitted=()=>!signal.aborted&&store.authGeneration===generation&&store.principal?.userId===actor&&store.principal?.role==='admin'&&!store.authPending;
    el.className='admin-gpu-tasks';
    el.innerHTML='<div class="admin-task-heading"><h2>显卡与任务</h2><button type="button" class="button primary" data-admin-submit>提交训练</button></div><div class="admin-task-filters"><label>提交者<select data-admin-owner><option value="">全部用户</option></select></label><label>服务器<select data-admin-machine><option value="">全部服务器</option></select></label><label>任务<select data-admin-state><option value="active">进行中</option><option value="ended">已结束</option><option value="all">全部记录</option></select></label></div><div class="admin-task-approvals" hidden></div><div class="admin-gpu-fleet"></div><section class="admin-task-list" aria-label="全部用户的训练任务"><div class="section-kicker"><h3>训练任务</h3><span data-admin-job-count></span></div><div id="all-jobs"></div></section>';
    const q=selector=>el.querySelector(selector),fleet=q('.admin-gpu-fleet'),owner=q('[data-admin-owner]'),machine=q('[data-admin-machine]'),state=q('[data-admin-state]');
    function options(select,rows,all){
      const value=select.value,signature=JSON.stringify(rows);if(select.dataset.rows===signature)return;
      select.dataset.rows=signature;select.innerHTML=`<option value="">${all}</option>`+rows.map(row=>`<option value="${esc(row.id)}">${esc(row.name||row.id)}</option>`).join('');
      if(rows.some(row=>row.id===value))select.value=value;select.title=select.selectedOptions[0]?.textContent||'';
    }
    function render(){
      if(!permitted())return;
      const machines=store.data?.machines||[],user=store.users.find(row=>row.id===actor);
      options(owner,store.users.map(row=>({id:row.id,name:row.name||row.username})),'全部用户');options(machine,machines,'全部服务器');
      if(!machines.some(row=>row.id===selected)){selected=machines[0]?.id||'';selectedGPU=0;}
      const node=machines.find(row=>row.id===selected);if(selectedGPU>=(node?.cards||0))selectedGPU=0;
      const html=resourceCards({machines,admin:true,management:true,quotaExempt:personalQuotaReadout(user).exempt,idPrefix:'admin-',limits:user?.limits||{},snapshot:store.data?.gpuq,production:store.production,maintenance:store.data?.operationalMaintenance,selectedMachine:selected,selectedGPU,userId:actor,jobs:store.jobs});
      if(html!==resourceHTML){
        const open=new Set([...fleet.querySelectorAll('details[open]')].map(row=>row.dataset.resourceDetail||row.dataset.resourceInfo));
        resourceHTML=html;fleet.innerHTML=html;
        for(const row of fleet.querySelectorAll('details'))row.open=open.has(row.dataset.resourceDetail||row.dataset.resourceInfo);
        for(const row of fleet.querySelectorAll('[data-resource-card-count]'))row.style.setProperty('--gpu-count',row.dataset.resourceCardCount);
        for(const row of fleet.querySelectorAll('[data-resource-level]'))row.style.height=row.dataset.resourceLevel+'%';
      }
      fitResourceNames(fleet);
      q('[data-admin-submit]').disabled=!selected||store.data?.executionEnabled!==true||!!maintenanceFor(store.data?.operationalMaintenance,selected);
      const approvals=controlSnapshot(store).approvals;q('.admin-task-approvals').hidden=!approvals.length;q('.admin-task-approvals').innerHTML=`<span>待审批 ${approvals.length} 人</span><a class="button quiet" href="${document.querySelector('[data-admin-section=members]')?'#admin/members':'#users'}">去审批</a>`;
      const jobs=adminTasks(store,{owner:owner.value,machine:machine.value,state:state.value});q('[data-admin-job-count]').textContent=jobs.length+' 项';
      renderTaskTable(q('#all-jobs'),jobs,{admin:true,userId:actor});
    }
    el.addEventListener('change',event=>{if(!permitted()||!event.target.matches('.admin-task-filters select'))return;event.target.title=event.target.selectedOptions[0]?.textContent||'';if(event.target===machine&&machine.value){selected=machine.value;selectedGPU=0;}render();},{signal});
    el.addEventListener('click',event=>{
      if(!permitted())return;const button=event.target.closest('button');if(!button||button.disabled)return;
      if(button.dataset.resourceSelect){selected=button.dataset.resourceSelect;selectedGPU=0;render();}
      if(button.hasAttribute('data-resource-card')){selectedGPU=Number(button.dataset.resourceCard);render();}
      if(button.hasAttribute('data-admin-submit'))document.dispatchEvent(new CustomEvent('gpuq-open-submit',{detail:{machine:selected,adminConsole:true}}));
    },{signal});
    const observer=new ResizeObserver(render);observer.observe(fleet);signal.addEventListener('abort',()=>observer.disconnect(),{once:true});
    document.fonts?.addEventListener('loadingdone',render,{signal});
    ctx.subscribe(render);
  }});
}
