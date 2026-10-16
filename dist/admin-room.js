// Admin console from the approved prototype: 成员与额度 and 维护模式 as plain
// tables on one page. Quotas save through policy.save, maintenance through
// maintenance.set; per-server limits and reasons open in sheets.
import {registerAdminSection} from './admin-ui.js';
import {openSheet,closeSheet,confirmSheet} from './sheet-ui.js';
import {hostDiagnosticsUI} from './host-diagnostics-ui.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pending=u=>u.enabled&&u.role!=='admin'&&!u.approvedAt&&u.total===0;
const roleLabel=u=>!u.enabled?'已暂停':u.role==='admin'?'管理员':pending(u)?'待审批':'成员';
const short=id=>String(id||'').replace(/^amax-/,'');
const when=value=>{const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'';};

export function adminRoomUI(store,{machines,toast,refresh,experience}){
  let memberSheet=null;
  const changed=async ctx=>{await store.call('state',{}, {signal:ctx.signal});if(!ctx.signal.aborted)await refresh();};
  const capacity=()=>machines.reduce((sum,m)=>sum+(m.cards||0),0);
  const sheetHead=(eyebrow,title)=>`<div class="pr-sheet-head"><div><div class="page-eyebrow">${eyebrow}</div><div class="pr-sheet-title">${title}</div></div><button type="button" class="jr-x" data-sheet-close aria-label="关闭">✕</button></div>`;

  // 成员与额度
  registerAdminSection({id:'members',title:'成员与额度',order:10,mount(el,ctx){
    let filter='all',busy=false;const sheet=document.createElement('dialog');sheet.className='pr-sheet adm-sheet';sheet.setAttribute('aria-label','服务器额度');document.body.append(sheet);memberSheet=sheet;
    el.className='adm-sec';
    function rows(){return [...store.users].filter(u=>filter!=='pending'||pending(u)).sort((a,b)=>Number(pending(b))-Number(pending(a))||a.username.localeCompare(b.username,'zh-CN'));}
    function render(){
      const list=rows(),waiting=store.users.filter(pending).length;
      el.innerHTML=`<div class="adm-head"><h2>成员与额度</h2><div class="jr-seg" role="group" aria-label="成员范围"><button type="button" data-adm-filter="all" aria-pressed="${filter==='all'}">全部 ${store.users.length}</button><button type="button" data-adm-filter="pending" aria-pressed="${filter==='pending'}">待审批 ${waiting}</button></div></div>
        <div class="adm-scroll"><table class="adm-tbl"><thead><tr><th>成员</th><th>角色</th><th>卡数额度</th><th>各服务器</th><th>正在用</th><th></th></tr></thead><tbody>${list.map(u=>{
          const admin=u.role==='admin',limits=Object.entries(u.limits||{}).filter(([,n])=>n>0);
          return `<tr data-adm-user="${esc(u.id)}"><td><div class="adm-name">${esc(u.name||u.username)}</div><div class="adm-sub mono">${esc(u.username)}</div></td><td class="adm-sub">${roleLabel(u)}</td>
            <td>${admin?'<span class="adm-sub">不限（管理员）</span>':`<div class="jr-stepper adm-stepper"><button type="button" data-adm-step="-1" aria-label="减少 ${esc(u.name)} 的额度" ${busy||u.total<=0?'disabled':''}>−</button><span>${u.total}</span><button type="button" data-adm-step="1" aria-label="增加 ${esc(u.name)} 的额度" ${busy||u.total>=capacity()?'disabled':''}>+</button></div>`}</td>
            <td class="adm-sub mono">${admin?'全部':limits.length?limits.map(([m,n])=>`${esc(short(m))} ${n}`).join(' · '):'未授权'}</td>
            <td class="mono adm-sub">${store.usage(u.id)} 张</td>
            <td class="adm-acts">${admin?'':`${pending(u)?'<button type="button" class="jr-btn primary" data-adm-full>批准全部额度</button>':''}<button type="button" class="jr-link" data-adm-edit>编辑</button>`}</td></tr>`;}).join('')||'<tr><td colspan="6" class="adm-sub">暂无待审批成员。</td></tr>'}</tbody></table></div>
        <p class="jr-hint">额度按卡数算，排队也占额度。管理员不受个人额度限制。账号本身在统一门户管理。</p>`;
      requestAnimationFrame(()=>{const seg=el.querySelector('.jr-seg');if(!seg)return;});
    }
    async function save(user,next){
      busy=true;render();
      try{await store.save(user.id,{...store.get(user.id),...next});await changed(ctx);ctx.toast('额度已保存');}
      catch(error){ctx.toast(error.message);}finally{busy=false;if(!ctx.signal.aborted)render();}
    }
    function editLimits(user){
      const draft=store.get(user.id);
      sheet.innerHTML=`<div class="pr-sheet-in">${sheetHead('服务器额度',esc(draft.name||draft.username))}
        <div class="adm-limits">${machines.map(m=>`<label class="adm-limit"><input type="checkbox" data-adm-machine="${esc(m.id)}" ${draft.limits[m.id]?'checked':''}><span class="adm-name">${esc(m.id)}</span><span class="adm-sub">${m.cards} × ${esc(m.model||'')}</span><span class="adm-limit-n">最多 <input class="jr-input adm-num" type="number" min="1" max="${m.cards}" data-adm-limit="${esc(m.id)}" value="${draft.limits[m.id]||1}" ${draft.limits[m.id]?'':'disabled'}> / ${m.cards} 张</span></label>`).join('')}</div>
        <label class="adm-total">合计额度 <input class="jr-input adm-num" type="number" min="0" max="${capacity()}" data-adm-total value="${draft.total}"> / ${capacity()} 张</label>
        <p class="jr-error" data-adm-error hidden></p>
        <div class="jr-actions"><button type="button" class="jr-btn ghost" data-sheet-close>取消</button><button type="button" class="jr-btn primary" data-adm-save>${pending(user)?'批准授权':'保存'}</button></div></div>`;
      sheet.onchange=event=>{const id=event.target.dataset.admMachine;if(!id)return;const input=sheet.querySelector(`[data-adm-limit="${CSS.escape(id)}"]`);input.disabled=!event.target.checked;};
      sheet.onclick=async event=>{
        if(event.target.closest('[data-sheet-close]')){closeSheet(sheet);return;}
        if(!event.target.closest('[data-adm-save]'))return;
        const limits={};for(const box of sheet.querySelectorAll('[data-adm-machine]'))if(box.checked)limits[box.dataset.admMachine]=Number(sheet.querySelector(`[data-adm-limit="${CSS.escape(box.dataset.admMachine)}"]`).value);
        const total=Number(sheet.querySelector('[data-adm-total]').value),error=sheet.querySelector('[data-adm-error]');
        if(!Number.isSafeInteger(total)||total<0||total>capacity()||Object.entries(limits).some(([id,n])=>!Number.isSafeInteger(n)||n<1||n>(machines.find(m=>m.id===id)?.cards||0))){error.textContent='额度要是整数，并且不超过服务器的卡数。';error.hidden=false;return;}
        const button=event.target.closest('[data-adm-save]');button.disabled=true;
        try{await store.save(user.id,{...draft,limits,total});await changed(ctx);if(ctx.signal.aborted)return;closeSheet(sheet);ctx.toast(pending(user)?'已批准授权':'额度已保存');}
        catch(problem){if(!ctx.signal.aborted){error.textContent=problem.message;error.hidden=false;}}finally{button.disabled=false;}
      };
      sheet.addEventListener('cancel',event=>{event.preventDefault();closeSheet(sheet);},{once:true});
      openSheet(sheet);
    }
    el.addEventListener('click',event=>{
      const f=event.target.closest('[data-adm-filter]');if(f){filter=f.dataset.admFilter;render();return;}
      const row=event.target.closest('[data-adm-user]');if(!row)return;const user=store.users.find(u=>u.id===row.dataset.admUser);if(!user)return;
      const step=event.target.closest('[data-adm-step]');if(step&&!step.disabled){const total=Math.max(0,Math.min(capacity(),user.total+Number(step.dataset.admStep)));if(total!==user.total)void save(user,{total});return;}
      if(event.target.closest('[data-adm-edit]')){editLimits(user);return;}
      if(event.target.closest('[data-adm-full]'))confirmSheet({signal:ctx.signal,title:`批准 ${user.name||user.username}？`,body:'给这位成员所有服务器的最大额度。之后可以在“编辑”里收紧。',action:'批准',run:async()=>{await store.call('policy.full',{userId:user.id});await changed(ctx);ctx.toast('已批准全部用卡额度');}});
    },{signal:ctx.signal});
    ctx.subscribe(()=>{if(!busy)render();});
  },unmount(){memberSheet?.close();memberSheet?.remove();memberSheet=null;}});

  // 维护模式
  const diagnostics=hostDiagnosticsUI(store,{toast});
  registerAdminSection({id:'maintenance',title:'维护模式',order:20,mount(el,ctx){
    el.className='adm-sec';
    const table=document.createElement('div'),sheet=document.createElement('dialog');sheet.className='pr-sheet adm-sheet';sheet.id='maintenance-settings-dialog';sheet.setAttribute('aria-label','开启维护');document.body.append(sheet);
    el.append(table);experience?.mountAdmin(el,ctx);diagnostics.mount(el,ctx);
    let maintenanceScope='all';
    const focusToggle=()=>{if(!ctx.signal.aborted)table.querySelector(`[data-adm-scope="${CSS.escape(maintenanceScope)}"] [data-maintenance-settings]`)?.focus({preventScroll:true});};
    sheet.addEventListener('close',focusToggle,{signal:ctx.signal});
    const state=()=>store.data?.operationalMaintenance||{global:null,machines:{}};
    function render(){
      const m=state(),rows=[{scope:'all',name:'全平台',entry:m.global},...machines.map(machine=>({scope:machine.id,name:machine.id,entry:m.machines?.[machine.id]||null}))];
      table.innerHTML=`<div class="adm-head"><h2>维护模式</h2></div><p class="jr-hint adm-lede">开启后不再接新任务，正在跑的任务继续。</p>
        <div class="adm-scroll"><table class="adm-tbl"><tbody>${rows.map(row=>`<tr data-adm-scope="${esc(row.scope)}"><td><div class="adm-name">${esc(row.name)}</div>${row.entry?`<div class="adm-sub">${esc(row.entry.reason||'未写原因')}${row.entry.since?' · 自 '+esc(when(row.entry.since)):''}</div>`:''}</td><td class="adm-sub">${row.entry?'<span class="jr-chip queue">维护中</span>':m.global&&row.scope!=='all'?'随全平台维护':'正常'}</td><td class="adm-acts"><button type="button" class="adm-tog" role="switch" aria-checked="${!!row.entry}" aria-label="${esc(row.name)} 维护模式" data-maintenance-settings></button></td></tr>`).join('')}</tbody></table></div>`;
    }
    function enable(scope,name){
      maintenanceScope=scope;
      sheet.innerHTML=`<div class="pr-sheet-in">${sheetHead('开启维护',esc(name))}<form data-adm-maint><label class="adm-field">原因（会显示给成员${scope==='all'?'，也会显示在登录页，不要写服务器内部信息':''}）<textarea class="jr-input" id="maintenance-settings-reason" name="reason" maxlength="200" required></textarea></label><p class="jr-error" data-adm-error hidden></p><div class="jr-actions"><button type="button" class="jr-btn ghost" data-sheet-close>取消</button><button type="submit" class="jr-btn primary">开启维护</button></div></form></div>`;
      sheet.querySelector('form').onsubmit=async event=>{event.preventDefault();const error=sheet.querySelector('[data-adm-error]');
        try{await store.call('maintenance.set',{scope,enabled:true,reason:event.target.reason.value});await changed(ctx);if(ctx.signal.aborted)return;closeSheet(sheet);ctx.toast('维护已启用；已有任务不会自动结束');}
        catch(problem){if(!ctx.signal.aborted){error.textContent=problem.message;error.hidden=false;}}};
      sheet.onclick=event=>{if(event.target.closest('[data-sheet-close]'))closeSheet(sheet);};
      sheet.addEventListener('cancel',event=>{event.preventDefault();closeSheet(sheet);},{once:true});
      openSheet(sheet);sheet.querySelector('textarea').focus();
    }
    table.addEventListener('click',event=>{
      const toggle=event.target.closest('[data-maintenance-settings]');if(!toggle)return;
      const row=toggle.closest('[data-adm-scope]'),scope=row.dataset.admScope,name=scope==='all'?'全平台':scope;
      if(toggle.getAttribute('aria-checked')!=='true'){enable(scope,name);return;}
      maintenanceScope=scope;
      confirmSheet({signal:ctx.signal,onClose:focusToggle,title:`解除 ${name} 的维护？`,body:'解除后立即恢复接新任务。',action:'解除维护',run:async()=>{await store.call('maintenance.set',{scope,enabled:false});await changed(ctx);ctx.toast('已明确解除所选范围的维护');}});
    },{signal:ctx.signal});
    document.addEventListener('gpuq-maintenance-host',event=>{if(event.detail?.userId!==ctx.principal.userId)return;diagnostics.select(event.detail.machine);document.querySelector('#admin-host-diagnostics')?.scrollIntoView({block:'start'});},{signal:ctx.signal});
    ctx.subscribe(render);
  },unmount(){diagnostics.unmount();experience?.unmountAdmin();document.querySelector('#maintenance-settings-dialog')?.remove();}});
}
