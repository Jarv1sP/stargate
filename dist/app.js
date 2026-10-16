import {discloseInfo,serverIdHTML,personalQuotaReadout,escapeUI as esc} from './workbench-ui.js';
import {DemoClient} from './client.js';
import {executionUI} from './execution-ui.js';
import {jobsRoom} from './jobs-room.js';
import {registerGpuTasksAdmin} from './admin-gpu-tasks.js';
import {terminalUI} from './terminal-ui.js';
import {resourcesUI,monitorSummary} from './resources-ui.js';
import {datasetsUI} from './datasets-ui.js';
import {createCommunityUI} from './community-ui.js';
import {createAnnouncementUI} from './announcement-ui.js';
import {operationalMaintenanceUI} from './maintenance-ui.js';
import {maintenanceExperienceUI} from './maintenance-experience.js';
import {transfersUI} from './transfers-ui.js';
import {shellUI} from './shell-ui.js';
import {reducedMotion} from './motion-ui.js';
import {copyHelp} from './copy-help-ui.js';
import {pageForRoute,hashForPage} from './navigation.js';
import {createAdminUI,adminHashForRoute,adminSectionForRoute,hasAdminSections,onAdminSectionsChange,registerAdminSection} from './admin-ui.js';
import {membersAdminUI,membersRoute} from './admin-members-ui.js';
import {maintenanceAdminUI} from './admin-maintenance-ui.js';
import {toastPosition} from './toast-ui.js';
const store=await DemoClient.create(),$=s=>document.querySelector(s);
const MACHINES=[];let capacity=0;
async function loadInventory(){
  if(!store.principal)return;
  const visible=store.data?.machines||[];
  MACHINES.splice(0,MACHINES.length,...visible);
  capacity=MACHINES.reduce((n,m)=>n+m.cards,0);
}
await loadInventory();
let page=pageForRoute(location.hash)==='admin'?'admin':'resources',pendingRoute=pageForRoute(location.hash)==='admin'?membersRoute(location.hash):pageForRoute(location.hash),selected=null,draft=null,filter='pending',toastTimer,refreshing=false,members;
const shell=shellUI(store,{navigate:choosePage,getPage:()=>page,toast});
registerGpuTasksAdmin(registerAdminSection);
const adminConsole=createAdminUI(store,{navigate:choosePage,getPage:()=>page,toast});
const renderExecution=executionUI(store,()=>render(true),toast);
const renderDatasets=datasetsUI(store,toast);
const renderCommunity=createCommunityUI(store,toast);
const renderAnnouncements=createAnnouncementUI(store,{toast});
const renderOperationalMaintenance=operationalMaintenanceUI(store,toast,()=>render(true));
const renderMaintenanceExperience=maintenanceExperienceUI(store,toast,{getPage:()=>page,refresh:()=>render(true)});
const renderTransfers=transfersUI(store,toast);
const renderResourceView=resourcesUI(store,{machines:MACHINES,getPage:()=>page,navigate:choosePage});
const renderJobsRoom=jobsRoom(store,{toast,machines:MACHINES,getPage:()=>page});
terminalUI(store,toast);
const isAdmin=()=>store.principal?.role==='admin';
const own=()=>store.users.find(u=>u.id===store.principal?.userId);
store.onAuthChange(()=>{MACHINES.length=0;capacity=0;});
const pending=u=>u.enabled&&u.role!=='admin'&&!u.approvedAt&&u.total===0;
const pendingUsers=()=>store.users.filter(pending);
const label=u=>!u.enabled?'已暂停':u.role==='admin'?'管理员':pending(u)?'待处理':u.total?'已授权':'零额度';
const dirty=()=>members?.active()&&draft&&store.users.some(u=>u.id===selected)&&(JSON.stringify(draft.limits)!==JSON.stringify(store.get(selected).limits)||draft.total!==store.get(selected).total);
const placeToast=toastPosition($('#toast'));
const rocket='<svg class="toast-rocket" width="12" height="18" viewBox="0 0 12 18" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M6 1c2.2 2 3 4.5 3 7v5H3V8c0-2.5.8-5 3-7z"/><path d="M3 13l-2 3M9 13l2 3M6 13v4"/></svg>';
function toast(message,{launch=false}={}){clearTimeout(toastTimer);const target=$('#toast'),shown=target.classList.contains('visible');target.innerHTML=(launch?rocket:'')+'<span></span>';target.lastChild.textContent=message;target.classList.toggle('launch',launch);target.classList.add('visible');placeToast();if(!shown&&!reducedMotion())target.animate([{opacity:0,transform:'translateY(20px)'},{opacity:1,transform:'none'}],{duration:450,easing:'cubic-bezier(.34,1.32,.5,1)'});toastTimer=setTimeout(()=>target.classList.remove('visible'),3500);}
function report(error){toast(error.message);if(error.status===401){store.principal=null;store.data=null;MACHINES.length=0;capacity=0;draft=null;render();openLogin();}}
const identityPortal=globalThis.GPUQ_CENTRAL_IDENTITY?.portal||'https://www.j4rv1s.xyz';
function openLogin(){location.replace('/auth/login');}
function choosePage(route){route=membersRoute(route);const next=pageForRoute(route);if(!next)return;const hash=next==='admin'?adminHashForRoute(route):hashForPage(next),sameSection=next!=='admin'||adminConsole.currentSection()===adminSectionForRoute(route);if(next===page&&sameSection){if(!store.principal)pendingRoute=hash;history.replaceState(null,'',hash);if(next==='admin')adminConsole.update();return;}if(dirty()){history.replaceState(null,'',page==='admin'?'#admin/'+adminConsole.currentSection():hashForPage(page));toast('请先保存或撤销授权草稿。');return;}if(!store.principal)pendingRoute=hash;shell.route(next,()=>{page=next;history.replaceState(null,'',hash);render();});}
function defaultPage(){const route=membersRoute(pendingRoute||'resources');page=pageForRoute(route)||'resources';pendingRoute=null;selected=null;draft=null;filter=pendingUsers().length?'pending':'all';history.replaceState(null,'',page==='admin'?adminHashForRoute(route):hashForPage(page));}
function render(preserve=false){
  const logged=!!store.principal,admin=isAdmin(),u=own();
  if(logged)for(const node of document.querySelectorAll('[data-public-maintenance]')){node.textContent=store.data?.operationalMaintenance?.global?.reason||'';node.hidden=!node.textContent;}
  document.body.classList.toggle('not-admin',!admin);
  for(const el of document.querySelectorAll('[data-admin-only]'))el.hidden=!admin||el.hasAttribute('data-admin-entry')&&!hasAdminSections();
  for(const el of document.querySelectorAll('[data-page]'))el.hidden=el.dataset.page!==page;
  for(const el of document.querySelectorAll('[data-nav]')){el.classList.toggle('active',el.dataset.nav===page);el.setAttribute('aria-current',el.dataset.nav===page?'page':'false');}
  $('#current-account').innerHTML=logged?`<span class="current-account-name">${esc(store.principal.username)}</span><span class="current-account-role">${admin?'管理员':'普通用户'}</span>`:'尚未登录';
  $('#profile-name').textContent=logged?u?.name||store.principal.username:'未登录';$('#profile-role').textContent=admin?'管理员':'个人工作空间';
  $('#profile-name').title=$('#profile-name').textContent;
  $('#edit-profile').hidden=!logged;
  $('#switch-account').textContent=logged?'退出 AMAX':'登录';$('#refresh-state').disabled=!logged;
  const titles={me:['我的额度',''],transfers:['数据',''],work:['项目',''],jobs:['任务',''],resources:['算力',''],datasets:['数据',''],community:['协作',''],users:['成员与额度',''],admin:['管理台','']};
  const concisePage=['community','users','admin'].includes(page);
  const eyebrows={resources:MACHINES.length+' 台服务器 · 实时',work:'容器工作区 · /workspace',jobs:'全队共用',datasets:'SSD 工作区 · HDD 数据集',transfers:'SSD 工作区 · HDD 数据集',community:'帖子 · 聊天 · 公告',users:'仅管理员可见',admin:'仅管理员可见'};
  let eyebrow=$('#page-eyebrow');if(!eyebrow){eyebrow=document.createElement('div');eyebrow.id='page-eyebrow';eyebrow.className='page-eyebrow';$('#page-title').before(eyebrow);}
  eyebrow.textContent=logged?eyebrows[page]||'':'';eyebrow.hidden=!eyebrow.textContent;
  $('#page-title').textContent=titles[page][0];$('#page-description').textContent=concisePage?'':titles[page][1];$('#page-description').hidden=concisePage||!titles[page][1];$('.help-links').hidden=concisePage;$('#breadcrumb').textContent=titles[page][0];
  if(!concisePage&&titles[page][1])discloseInfo($('#page-description'),'页面说明');
  const descriptionInfo=$('#page-description').closest('.ui-info');if(descriptionInfo)descriptionInfo.hidden=concisePage||!titles[page][1];
  const firstUseNote=$('.help-links>span:last-child');
  if(firstUseNote&&!firstUseNote.classList.contains('copy-help')){
    const template=document.createElement('template');template.innerHTML=copyHelp('首次使用说明',firstUseNote.textContent,'/guide/start');firstUseNote.replaceWith(template.content);
  }
  const note=!logged?'请登录。':!store.production?'本地演示：不会连接真实服务器或启动训练。':!u?.total&&page!=='community'?'暂无用卡额度，等待授权。':'';
  const monitorNotice=logged&&store.production&&store.data?.gpuq?.stale&&page!=='resources'?'显卡监控待更新':'';
  if(concisePage){
    const mode=!logged?'请登录':!store.production?'演示':note?'额度 0':'';
    $('#mode-note').innerHTML=[mode?`<span>${mode}</span>${copyHelp('当前状态',!logged?'在统一门户注册并登录。':!store.production?'演示不会连接真实服务器或启动训练。':'获得管理员授权后才能提交训练，仍可查看资源和参与协作。','/guide/start')}`:'',monitorNotice?`<span>监控未更新</span>${copyHelp('监控未更新','显卡占用暂时未知。任务停止、额度释放以平台确认的结果为准。','/guide/troubleshooting')}`:''].filter(Boolean).join(' · ');
  }else $('#mode-note').textContent=[note,monitorNotice].filter(Boolean).join(' ');
  $('.demo-note').hidden=!note&&!monitorNotice;
  renderOperationalMaintenance();
  renderTransfers(page==='transfers');renderResources();renderExecution();renderJobsRoom();renderDatasets();renderCommunity(page==='community');renderAnnouncements();
  $('#open-submit').hidden=true;
  shell.update();
  adminConsole.update();
  renderMaintenanceExperience();
}
function renderResources(){
  $('#resource-summary').textContent=(store.data?.machines?.length||0)+' 台服务器';
  $('#monitor-status').textContent=monitorSummary(store.data?.gpuq,store.production);
  $('#monitor-status').title=store.data?.gpuq?.checkedAt||'';
  renderResourceView();
}
function filteredUsers(){return [...store.users].filter(u=>filter!=='pending'||pending(u)).sort((a,b)=>Number(pending(b))-Number(pending(a))||a.username.localeCompare(b.username,'zh-CN'));}
function renderMembers(){
  const keepDraft=dirty();
  if(!keepDraft){const list=filteredUsers();if(!list.some(user=>user.id===selected))selected=list[0]?.id||null;draft=selected?store.get(selected):null;}
  renderUsers();if(!keepDraft)renderEditor();
}
function renderUsers(){
  const list=$('#user-list'),focused=document.activeElement,scrollTop=list.scrollTop;
  const focusedUser=list.contains(focused)?focused.closest('[data-user]')?.dataset.user:null;
  $('#filter-pending').textContent=`待处理 ${pendingUsers().length}`;$('#filter-all').textContent=`全部账号 ${store.users.length}`;
  $('#filter-pending').setAttribute('aria-pressed',String(filter==='pending'));$('#filter-all').setAttribute('aria-pressed',String(filter==='all'));
  list.innerHTML=filteredUsers().map(u=>`<button class="user-row ${u.id===selected?'selected':''}" data-user="${esc(u.id)}" aria-pressed="${u.id===selected}"><span class="avatar">${esc(u.name.slice(0,1))}</span><span class="user-details"><span class="user-name" title="${esc(u.name)}">${esc(u.name)}</span><span class="user-meta">${label(u)}${personalQuotaReadout(u).exempt?' · 免个人额度':u.total?' · '+u.total+' 张':''}</span></span><span class="user-chevron">›</span></button>`).join('')||'<div class="empty">暂无待处理账号。</div>';
  list.scrollTop=scrollTop;
  if(focusedUser)for(const row of list.querySelectorAll('[data-user]'))if(row.dataset.user===focusedUser){row.focus({preventScroll:true});break;}
}
function renderEditor(){
  if(!draft){$('#editor').innerHTML=`<div class="editor-empty"><h2>审批都处理好了</h2><p class="muted">切到“全部账号”可调整已有授权。</p></div>`;return;}
  const u=store.get(selected),self=u.id===store.principal.userId,admin=u.role==='admin';
  const permissionsHelp=copyHelp('服务器额度','勾选服务器分配用卡额度，所有成员都能查看和操作团队项目与数据。新账号会自动出现在待处理，额度为 0，批准后才能提交训练。','/guide/start');
  const totalHelp=copyHelp('合计额度','排队也占用额度，所有服务器同时受这个上限限制。有额度仍可能需要等空卡。','/guide/queue');
  const accountHelp=()=>copyHelp('账号权限','管理员免个人累计卡数额度，单次申请仍受目标物理卡数限制，资源不足正常排队；成员额度与维护由计算平台管理员管理，账号在统一门户管理。','/guide/start');
  $('#editor').innerHTML=`<span class="hero-label">${pending(u)?'待审批':'成员授权'}</span>
    <div class="editor-head"><div><h2>${esc(u.name)}</h2><p class="muted"><span class="member-username">${esc(u.username)}</span> · ${label(u)}${self?' · 当前账号':''}</p></div></div>
    <div class="editor-body">${admin?`<div class="approval-note copy-caption"><span>全部服务器 · 免个人额度</span>${accountHelp()}</div>`:`
      <div class="editor-save"><div><p id="policy-summary"></p><p class="save-state" id="save-state" role="status"></p></div><div><button class="button ghost" data-action="reset-draft">撤销</button><button class="button primary" data-action="save-policy">${pending(u)?'批准授权':'保存额度'}</button></div></div>
      <p class="form-error" id="policy-error" role="alert"></p>
      <div class="permission-heading"><div class="copy-caption"><h3>服务器额度</h3>${permissionsHelp}</div><button class="button" data-action="grant-full">全部最大额度</button></div>
      <div class="permissions">${MACHINES.map(m=>`<div class="permission ${draft.limits[m.id]?'granted':''}"><label class="permission-top"><input type="checkbox" data-machine="${esc(m.id)}" ${draft.limits[m.id]?'checked':''}><span class="permission-name">${serverIdHTML(m.id)}</span><small class="permission-spec">${m.cards} × ${esc(m.model)}</small></label><div class="permission-bottom"><span class="permission-meter" data-permission-meter="${esc(m.id)}" aria-hidden="true">${Array.from({length:m.cards},()=>'<i></i>').join('')}</span><label>最多使用<input class="quota-input" type="number" min="1" max="${m.cards}" data-quota="${esc(m.id)}" value="${draft.limits[m.id]||0}" ${draft.limits[m.id]?'':'disabled'}> / ${m.cards} 张</label></div></div>`).join('')}</div>
      <div class="total-limit"><div class="copy-caption"><label for="member-total"><strong>合计额度</strong></label>${totalHelp}</div><span><input id="member-total" class="quota-input" type="number" min="0" max="${capacity}" data-quota="total" value="${draft.total}"> / ${capacity} 张</span></div>
      <div class="member-draft-note copy-caption" hidden><span>刷新会丢弃修改。</span>${copyHelp('授权草稿','自动更新会保留正在填写的草稿。关闭或刷新页面会丢弃未保存的修改。','/guide/start')}</div>`}
    </div>`;
  updateDirty();
}
function updateDirty(){
  const state=$('#save-state');if(state)state.textContent=dirty()?'未保存':'已保存';
  const draftNote=$('.member-draft-note');if(draftNote)draftNote.hidden=!dirty();
  const summary=$('#policy-summary');if(!summary||!draft)return;
  const valid=Number.isSafeInteger(draft.total)&&draft.total>=0&&draft.total<=capacity&&MACHINES.every(m=>draft.limits[m.id]===undefined||Number.isSafeInteger(draft.limits[m.id])&&draft.limits[m.id]>=1&&draft.limits[m.id]<=m.cards);
  summary.textContent=valid?[...MACHINES.filter(m=>draft.limits[m.id]>0).map(m=>m.id+' '+draft.limits[m.id]+' 张'),'合计 '+draft.total+' 张'].join(' · '):'额度草稿中有待校正的数值';
  for(const meter of document.querySelectorAll('[data-permission-meter]')){
    const count=draft.limits[meter.dataset.permissionMeter]||0,max=MACHINES.find(m=>m.id===meter.dataset.permissionMeter).cards;
    for(const [index,tick] of [...meter.children].entries())tick.classList.toggle('is-on',Number.isSafeInteger(count)&&count>=0&&count<=max&&index<count);
  }
}
async function refresh(){if(refreshing||!store.principal)return;refreshing=true;shell.syncStatus('syncing');try{await store.refresh();render(true);shell.syncStatus('ready',Date.now());}catch(e){shell.syncStatus('failed');report(e);}finally{refreshing=false;}}
async function guardedChange(action){await action();}
document.addEventListener('click',async event=>{
  const b=event.target.closest('button,a[data-nav]');if(!b||b.disabled)return;
  if(members.owns(b)&&!members.active())return;
  if(b.dataset.nav){event.preventDefault();choosePage(b.dataset.nav);return;}
  if(b.dataset.close){$('#'+b.dataset.close).close();return;}
  if(b.dataset.user){await guardedChange(()=>{selected=b.dataset.user;draft=store.get(selected);renderUsers();renderEditor();});return;}
  if(b.dataset.useMachine){
    const id=b.dataset.useMachine;if(!store.principal||!store.data?.machines?.some(machine=>machine.id===id)){toast('未获此服务器授权，请刷新核对。');return;}
    choosePage('work');if(page!=='work')return;
    const target=$('[name=workspace-machine]');if(target){target.value=id;target.dispatchEvent(new Event('change',{bubbles:true}));}return;
  }
  const action=b.dataset.action||b.id;
  try{switch(action){
    case 'filter-pending':case 'filter-all':await guardedChange(()=>{filter=action==='filter-pending'?'pending':'all';selected=null;render();});break;
    case 'refresh-state':await refresh();toast('已更新');break;
    case 'switch-account':if(store.principal)await store.logout();pendingRoute=null;selected=null;draft=null;location.assign(new URL('/',identityPortal).href);break;
    case 'reset-draft':draft=store.get(selected);renderEditor();break;
    case 'save-policy':{const stamp=members.capture();b.disabled=true;try{await store.save(selected,draft);if(members.current(stamp)){draft=null;render();toast('额度已保存，用户端会自动更新');}}catch(e){if(members.current(stamp))$('#policy-error').textContent=e.message;}finally{b.disabled=false;}break;}
    case 'grant-full':await store.call('policy.full',{userId:selected});draft=null;render();toast('已批准全部用卡额度');break;
  }}catch(e){report(e);}
});
document.addEventListener('change',event=>{const id=event.target.dataset.machine;if(!members.active()||!members.owns(event.target)||!id||!draft)return;if(event.target.checked){draft.limits[id]=1;if(!draft.total)draft.total=1;}else{delete draft.limits[id];draft.total=Math.min(draft.total,Object.values(draft.limits).reduce((a,b)=>a+b,0));}renderEditor();$(`[data-machine="${id}"]`).focus();});
document.addEventListener('input',event=>{const key=event.target.dataset.quota;if(!members.active()||!members.owns(event.target)||!key||!draft)return;const value=event.target.value===''?NaN:Number(event.target.value);if(key==='total')draft.total=value;else draft.limits[key]=value;updateDirty();});
$('#edit-profile').addEventListener('click',()=>location.assign(new URL('/account',identityPortal).href));
for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
members=membersAdminUI(store,{getPage:()=>page,render:renderMembers,unmount:()=>{selected=null;draft=null;}});
maintenanceAdminUI(store,renderMaintenanceExperience,{getPage:()=>page,toast,refresh:()=>render(true)});
if(store.principal)defaultPage();render();if(store.principal)shell.syncStatus('ready',Date.now());else openLogin();
onAdminSectionsChange(()=>render(true));
const poll=setInterval(()=>{if(!document.hidden)refresh();},15000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
document.addEventListener('gpuq-open-project',async event=>{const detail=event.detail||{};if(detail.userId!==store.principal?.userId||detail.authGeneration!==store.authGeneration)return;try{await choosePage('work');await renderExecution.openProject(detail);}catch(error){toast(error.message);}});
addEventListener('hashchange',()=>choosePage(location.hash));
addEventListener('pagehide',()=>clearInterval(poll),{once:true});
