import {discloseInfo,escapeUI as esc} from './workbench-ui.js';
import {DemoClient} from './client.js';
import {executionUI} from './execution-ui.js';
import {jobsRoom} from './jobs-room.js';
import {terminalUI} from './terminal-ui.js';
import {resourcesUI,monitorSummary} from './resources-ui.js';
import {datasetsUI} from './datasets-ui.js';
import {createCommunityUI,renderChatMentionBadge} from './community-ui.js';
import {createAnnouncementUI} from './announcement-ui.js';
import {createMentionPopup} from './mention-popup-ui.js';
import {operationalMaintenanceUI} from './maintenance-ui.js';
import {transfersUI} from './transfers-ui.js';
import {shellUI} from './shell-ui.js';
import {reducedMotion} from './motion-ui.js';
import {copyHelp} from './copy-help-ui.js';
import {pageForRoute,hashForPage} from './navigation.js';
import {createAdminUI,adminHashForRoute,hasAdminSections,onAdminSectionsChange} from './admin-ui.js';
import {adminRoomUI} from './admin-room.js';
import {toastPosition} from './toast-ui.js';
const store=await DemoClient.create(),$=s=>document.querySelector(s);
const MACHINES=[];
async function loadInventory(){
  if(!store.principal)return;
  const visible=store.data?.machines||[];
  MACHINES.splice(0,MACHINES.length,...visible);
}
await loadInventory();
let page=pageForRoute(location.hash)==='admin'?'admin':'resources',pendingRoute=pageForRoute(location.hash)==='admin'?location.hash:pageForRoute(location.hash),toastTimer,refreshing=false;
const shell=shellUI(store,{navigate:choosePage,getPage:()=>page,toast});
const adminConsole=createAdminUI(store,{navigate:choosePage,getPage:()=>page,toast});
const renderExecution=executionUI(store,()=>render(true),toast);
const renderDatasets=datasetsUI(store,toast);
const renderCommunity=createCommunityUI(store,toast);
const renderAnnouncements=createAnnouncementUI(store,{toast});
const renderMentionPopup=createMentionPopup(store,{openChat:()=>{choosePage('community');renderCommunity.showChat();},chatOpen:()=>page==='community'&&renderCommunity.chatOpen()});
const renderOperationalMaintenance=operationalMaintenanceUI(store);
const renderTransfers=transfersUI(store,toast);
const renderResourceView=resourcesUI(store,{machines:MACHINES,getPage:()=>page,navigate:choosePage});
const renderJobsRoom=jobsRoom(store,{toast,machines:MACHINES,getPage:()=>page});
terminalUI(store,toast);
const isAdmin=()=>store.principal?.role==='admin';
const own=()=>store.users.find(u=>u.id===store.principal?.userId);
store.onAuthChange(()=>{MACHINES.length=0;});
const placeToast=toastPosition($('#toast'));
const rocket='<svg class="toast-rocket" width="12" height="18" viewBox="0 0 12 18" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M6 1c2.2 2 3 4.5 3 7v5H3V8c0-2.5.8-5 3-7z"/><path d="M3 13l-2 3M9 13l2 3M6 13v4"/></svg>';
function toast(message,{launch=false}={}){clearTimeout(toastTimer);const target=$('#toast'),shown=target.classList.contains('visible');target.innerHTML=(launch?rocket:'')+'<span></span>';target.lastChild.textContent=message;target.classList.toggle('launch',launch);target.classList.add('visible');placeToast();if(!shown&&!reducedMotion())target.animate([{opacity:0,transform:'translateY(20px)'},{opacity:1,transform:'none'}],{duration:450,easing:'cubic-bezier(.34,1.32,.5,1)'});toastTimer=setTimeout(()=>target.classList.remove('visible'),3500);}
function report(error){toast(error.message);if(error.status===401){store.principal=null;store.data=null;MACHINES.length=0;render();openLogin();}}
const identityPortal=globalThis.GPUQ_CENTRAL_IDENTITY?.portal||'https://www.j4rv1s.xyz';
function openLogin(){location.replace('/auth/login');}
function choosePage(route){const next=pageForRoute(route);if(!next)return;const hash=next==='admin'?adminHashForRoute(route):hashForPage(next);if(next===page){if(!store.principal)pendingRoute=hash;history.replaceState(null,'',hash);if(next==='admin')adminConsole.update();return;}if(!store.principal)pendingRoute=hash;shell.route(next,()=>{page=next;history.replaceState(null,'',hash);render();});}
function defaultPage(){const route=pendingRoute||'resources';page=pageForRoute(route)||'resources';pendingRoute=null;history.replaceState(null,'',page==='admin'?adminHashForRoute(route):hashForPage(page));}
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
  const titles={me:['我的额度',''],transfers:['数据',''],work:['项目',''],jobs:['任务',''],resources:['算力',''],datasets:['数据',''],community:['协作',''],admin:['管理台','']};
  const concisePage=['community','admin'].includes(page);
  const eyebrows={resources:MACHINES.length+' 台服务器 · 实时',work:'容器工作区 · /workspace',jobs:'全队共用',datasets:'SSD 工作区 · HDD 数据集',transfers:'SSD 工作区 · HDD 数据集',community:'帖子 · 聊天 · 公告',admin:'仅管理员可见'};
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
  renderTransfers(page==='transfers');renderResources();renderExecution();renderJobsRoom();renderDatasets();renderCommunity(page==='community');renderChatMentionBadge(store);renderAnnouncements();renderMentionPopup();
  $('#open-submit').hidden=true;
  shell.update();
  adminConsole.update();
}
function renderResources(){
  $('#resource-summary').textContent=(store.data?.machines?.length||0)+' 台服务器';
  $('#monitor-status').textContent=monitorSummary(store.data?.gpuq,store.production);
  $('#monitor-status').title=store.data?.gpuq?.checkedAt||'';
  renderResourceView();
}
async function refresh(){if(refreshing||!store.principal)return;refreshing=true;shell.syncStatus('syncing');try{await store.refresh();render(true);shell.syncStatus('ready',Date.now());}catch(e){shell.syncStatus('failed');report(e);}finally{refreshing=false;}}
document.addEventListener('click',async event=>{
  const b=event.target.closest('button,a[data-nav]');if(!b||b.disabled)return;
  if(b.dataset.nav){event.preventDefault();choosePage(b.dataset.nav);return;}
  if(b.dataset.close){$('#'+b.dataset.close).close();return;}
  if(b.dataset.useMachine){
    const id=b.dataset.useMachine;if(!store.principal||!store.data?.machines?.some(machine=>machine.id===id)){toast('未获此服务器授权，请刷新核对。');return;}
    choosePage('work');if(page!=='work')return;
    const target=$('[name=workspace-machine]');if(target){target.value=id;target.dispatchEvent(new Event('change',{bubbles:true}));}return;
  }
  const action=b.dataset.action||b.id;
  try{switch(action){
    case 'refresh-state':await refresh();toast('已更新');break;
    case 'switch-account':if(store.principal)await store.logout();pendingRoute=null;location.assign(new URL('/',identityPortal).href);break;
  }}catch(e){report(e);}
});
$('#edit-profile').addEventListener('click',()=>location.assign(new URL('/account',identityPortal).href));
for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
adminRoomUI(store,{machines:MACHINES,refresh:()=>render(true)});
if(store.principal)defaultPage();render();if(store.principal)shell.syncStatus('ready',Date.now());else openLogin();
onAdminSectionsChange(()=>render(true));
const poll=setInterval(()=>{if(!document.hidden)refresh();},15000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
document.addEventListener('gpuq-open-project',async event=>{const detail=event.detail||{};if(detail.userId!==store.principal?.userId||detail.authGeneration!==store.authGeneration)return;try{await choosePage('work');await renderExecution.openProject(detail);}catch(error){toast(error.message);}});
addEventListener('hashchange',()=>choosePage(location.hash));
addEventListener('pagehide',()=>clearInterval(poll),{once:true});
