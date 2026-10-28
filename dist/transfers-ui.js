import {maintenanceFor,restoreMaintenanceControls,disableMaintenanceControls} from './maintenance-state.js';
import {routePresentation,transferBytes} from './data-route.js';
import {usableMachines} from './workbench-ui.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const done=new Set(['SUCCEEDED','CANCELED']);
const stateNames={PENDING:'等待开始',QUEUED:'等待开始',STARTING:'正在连接',DISPATCHING:'正在连接',WAITING_CLIENT:'等待客户端',RUNNING:'传输中',RETRYING:'正在重试',UNKNOWN:'状态待确认',PAUSED:'已暂停',FAILED:'需要处理',SUCCEEDED:'已完成',CANCELED:'已终止',CANCELING:'正在停止'};
const kindNames={upload:'上传',download:'下载',copy:'服务器间复制'};
const attention=new Set(['FAILED','PAUSED','UNKNOWN','WAITING_CLIENT']);
export function transferGroups(rows){
  return [
    {id:'attention',name:'需要处理',rows:rows.filter(row=>attention.has(row.state)||!Object.hasOwn(stateNames,row.state))},
    {id:'active',name:'进行中',rows:rows.filter(row=>Object.hasOwn(stateNames,row.state)&&!attention.has(row.state)&&!done.has(row.state))},
    {id:'done',name:'已完成',rows:rows.filter(row=>done.has(row.state))}
  ].filter(group=>group.rows.length);
}
export function transferCard(row){
  const state=Object.hasOwn(stateNames,row.state)?row.state:'UNKNOWN';
  const r=row.result||{},bytes=r.bytes??(r.totalBytes!==undefined&&r.remainingBytes!==undefined?r.totalBytes-r.remainingBytes:null),total=r.totalBytes??row.totalBytes;
  const route=routePresentation(row.lastConfirmedRoute||r.lastConfirmedRoute||row.route||r.route),known=Number.isFinite(bytes)&&bytes>=0&&Number.isFinite(total)&&total>0&&bytes<=total;
  const progress=known?`<progress max="${total}" value="${bytes}" aria-label="已传输 ${esc(transferBytes(bytes))}，共 ${esc(transferBytes(total))}"></progress>`:'';
  return `<div class="transfer-card-heading"><h3>${esc(row.name||row.reference?.dataset||'数据传输')}</h3><span class="transfer-state" data-state="${state}">${esc(stateNames[state])}</span></div>
    <p class="transfer-endpoints">${esc(row.from?row.from+' → '+row.machine:row.machine)}<span>${esc(kindNames[row.kind]||'传输')} · ${esc(row.owner?.name||row.owner?.username||'')}</span></p>
    <div class="transfer-meter"><span>${esc(transferBytes(bytes))}<small> / ${esc(transferBytes(total))}</small></span><span class="transfer-route" data-route="${esc(route.kind)}">${route.kind==='unknown'?'':'最近确认 · '}${esc(route.label)}</span></div>${progress}
    ${row.error||r.error?`<p class="transfer-error" role="status">${esc(row.error||r.error)}</p>`:r.path?`<p class="transfer-path">${esc(r.path)}</p>`:''}
    <div class="transfer-card-actions"><button class="button quiet" type="button" data-transfer-action="status" data-id="${esc(row.id)}">核对状态</button>${!done.has(row.state)?`<button class="button danger" type="button" data-transfer-action="cancel" data-id="${esc(row.id)}">终止传输</button>`:''}${['FAILED','PAUSED'].includes(row.state)&&row.kind==='copy'&&!row.cancelRequested?`<button type="button" class="button transfer-resume" data-transfer-action="resume" data-id="${esc(row.id)}">继续传输</button>`:''}</div>
    <details class="transfer-details"><summary>任务详情</summary><p>任务编号 <code>${esc(row.id)}</code></p><p>后台状态 <code>${esc(row.state)}</code></p><p>${esc(route.note)}${['PAUSED','FAILED','CANCELED'].includes(row.state)?' 未完成文件保留；本机上传需在原客户端继续。':''}</p></details>`;
}
export function transfersUI(store,toast){
  const section=document.querySelector('#page-transfers');let identity='',busy=false,generation=0,cursor=0,records=new Map(),pendingReveal=null,pendingCopy=null;
  function activities(complete){
    if(!store.principal)return;
    document.dispatchEvent(new CustomEvent('gpuq-data-activities',{detail:{userId:store.principal.userId,items:[...records.values()].map(row=>({id:row.id,kind:row.kind,state:row.state,machine:row.machine,name:row.name||row.reference?.dataset||'数据传输',finishedAt:row.finishedAt,updatedAt:row.updatedAt,error:row.error||row.result?.error})),complete}}));
  }
  function maintenanceControls(){
    restoreMaintenanceControls(section);
    const state=store.data?.operationalMaintenance;
    disableMaintenanceControls(section,'#transfer-copy-form [type=submit]',maintenanceFor(state,section.querySelector('[name=transfer-from]')?.value)||maintenanceFor(state,section.querySelector('[name=transfer-machine]')?.value));
    for(const button of section.querySelectorAll('[data-transfer-action=resume]')){const row=records.get(button.dataset.id);disableMaintenanceControls(section,'[data-transfer-action=resume][data-id="'+CSS.escape(button.dataset.id)+'"]',maintenanceFor(state,row?.machine)||maintenanceFor(state,row?.from));}
  }
  document.addEventListener('gpuq-maintenance-state',maintenanceControls);
  section.addEventListener('input',event=>{if(event.target.closest('#transfer-copy-form')){pendingCopy=null;section.querySelector('#transfer-copy-form [type=submit]').textContent='开始后台复制';}});
  section.addEventListener('change',event=>{if(event.target.closest('#transfer-copy-form'))pendingCopy=null;if(['transfer-from','transfer-machine'].includes(event.target.name))maintenanceControls();});
  function renderRecords(){
    const list=section.querySelector('#transfer-list');list.replaceChildren();let first=true;
    for(const group of transferGroups([...records.values()])){
      const block=document.createElement('section');block.className='transfer-group'+(first?' hero-frame':'');first=false;block.dataset.transferGroup=group.id;block.setAttribute('aria-labelledby','transfer-group-'+group.id);
      block.innerHTML=`<div class="transfer-group-heading"><h3 id="transfer-group-${group.id}">${group.name}</h3><span>${group.rows.length} 项${cursor?' · 已加载':''}</span></div>`;
      let parent=block;
      for(const [index,row] of group.rows.entries()){
        if(group.id==='attention'&&index===3){parent=document.createElement('details');parent.className='transfer-overflow';parent.innerHTML=`<summary>还有 ${group.rows.length-3} 项需要处理</summary>`;block.append(parent);}
        const node=document.createElement('article');node.className='panel transfer-card';node.dataset.transferId=row.id;node.dataset.state=Object.hasOwn(stateNames,row.state)?row.state:'UNKNOWN';node.innerHTML=transferCard(row);parent.append(node);
      }
      list.append(block);
    }
    maintenanceControls();
  }
  function viewed(id){if(records.has(id))document.dispatchEvent(new CustomEvent('gpuq-attention-viewed',{detail:{userId:store.principal?.userId,kind:'data',id}}));}
  function revealPending(fresh=false){
    if(busy&&!fresh||!pendingReveal||pendingReveal.userId!==store.principal?.userId)return;
    const card=[...section.querySelectorAll('[data-transfer-id]')].find(row=>row.dataset.transferId===pendingReveal.id);if(!card)return;
    pendingReveal=null;for(let parent=card.parentElement;parent&&parent!==section;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;
    card.querySelector('.transfer-details').open=true;viewed(card.dataset.transferId);requestAnimationFrame(()=>card.scrollIntoView({block:'center'}));
  }
  section.addEventListener('toggle',event=>{if(event.target.matches('.transfer-details')&&event.target.open)viewed(event.target.closest('[data-transfer-id]')?.dataset.transferId);},true);
  document.addEventListener('gpuq-reveal-data-activity',event=>{if(!store.principal||event.detail?.userId!==store.principal.userId)return;pendingReveal={id:event.detail.id,userId:event.detail.userId};revealPending();});
  store.onAuthChange?.(()=>{generation++;identity='';busy=false;pendingReveal=null;pendingCopy=null;records.clear();section.replaceChildren();});
  async function load(next=false){
    if(busy||!store.principal||!store.production)return;busy=true;const token=generation,requestedCursor=next?cursor:0;let follow=false;
    try{const result=await store.call('transfers.list',{cursor:requestedCursor});if(token!==generation)return;cursor=result.nextCursor;if(!next&&Array.isArray(result.transfers))records.clear();for(const row of result.transfers||[])records.set(row.id,row);renderRecords();activities(!cursor&&result.partial!==true);revealPending(true);follow=!!pendingReveal&&!!cursor&&cursor!==requestedCursor;section.querySelector('#transfer-more').hidden=!cursor;section.querySelector('#transfer-status').textContent=result.state==='UNKNOWN'||result.partial===true?'部分服务器状态未知，请稍后刷新；已显示上次记录。':records.size?(cursor?'已显示部分记录；加载下一页可继续核对。':'状态已更新。服务器间复制会在后台继续。'):'还没有传输任务。可从“数据集”上传数据，或创建服务器间复制。';}
    catch(e){if(token===generation){section.querySelector('#transfer-status').textContent=e.message;activities(false);}}finally{if(token===generation)busy=false;}if(follow&&token===generation)load(true);
  }
  section.addEventListener('submit',async e=>{
    if(e.target.id!=='transfer-copy-form')return;e.preventDefault();if(busy)return;
    const form=e.target,values=new FormData(form),dataset=String(values.get('transfer-reference')).trim(),payload={kind:'copy',from:values.get('transfer-from'),machine:values.get('transfer-machine'),reference:{dataset},name:values.get('transfer-name')},account=store.principal?.userId;
    const intent=JSON.stringify([account,payload]);
    if(pendingCopy?.intent!==intent)pendingCopy={intent,key:crypto.randomUUID()};
    const requestKey=pendingCopy.key;e.submitter.disabled=true;const token=generation;
    try{const row=await store.call('transfers.create',{...payload,key:requestKey});if(token!==generation)return;pendingCopy=null;toast('传输 '+row.id+' · '+row.state);await load();}catch(error){if(token===generation)toast(error.message+'；重试将沿用原编号 '+requestKey);}finally{if(token===generation){e.submitter.disabled=false;e.submitter.textContent=pendingCopy?'重试原复制':'开始后台复制';}}
  });
  section.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b||b.disabled)return;if(b.id==='transfer-refresh')return load();if(b.id==='transfer-more')return load(true);if(!b.dataset.transferAction)return;b.disabled=true;const token=generation;try{await store.call('transfers.'+b.dataset.transferAction,{id:b.dataset.id});if(token===generation)await load();}catch(error){if(token===generation)toast(error.message);}finally{if(token===generation)b.disabled=false;}});
  return active=>{
    const machines=usableMachines(store),next=store.principal?JSON.stringify([store.authGeneration,store.principal.userId,machines.map(m=>m.id)]):'';
    if(next!==identity){identity=next;generation++;busy=false;cursor=0;records.clear();activities(false);const enabled=store.production&&!!store.principal,options=machines.map(m=>`<option value="${esc(m.id)}">${esc(m.name||m.id)}</option>`).join('');section.innerHTML=`<nav class="data-room-tabs" aria-label="数据集内容"><a href="#datasets">数据集</a><a href="#datasets/transfers" aria-current="page">传输与导入</a></nav><div class="transfer-section-heading"><div><span class="data-eyebrow">DATA / ACTIVITIES</span><h3>传输记录</h3></div><button class="button quiet" id="transfer-refresh" ${enabled?'':'disabled'}>刷新状态</button></div><p id="transfer-status" role="status">${enabled?'刷新可查看已有任务。':'当前为演示或旧后台，未启用真实传输。'}</p><div id="transfer-list"></div><button class="button" id="transfer-more" hidden>下一页</button><details id="transfer-copy" class="transfer-copy"><summary class="button primary">复制到另一台服务器</summary><form id="transfer-copy-form" class="panel"><div class="transfer-form-heading"><span class="transfer-eyebrow">SERVER TO SERVER</span><h3>复制数据集目录</h3><p>关闭网页后，后台继续传输；复制保留源目录。</p></div><label>源服务器<select name="transfer-from">${options}</select></label><label>目标服务器<select name="transfer-machine">${options}</select></label><label>数据集目录名<input name="transfer-reference" placeholder="例如 images" required></label><label>目标数据集名称<input name="transfer-name" placeholder="留空则同名"></label><button class="button primary" type="submit" ${enabled?'':'disabled'}>开始后台复制</button></form></details><details class="transfer-cli-help"><summary>在命令行中使用</summary><p>上传目录：<code>gpuctl data upload</code><br>传输操作：<code>gpuctl transfer --help</code></p></details>`;}
    maintenanceControls();if(active&&!busy)load();
  };
}
