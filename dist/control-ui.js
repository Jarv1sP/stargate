import {hasAdminSections} from './admin-ui.js';
import {escapeUI as esc,stateWord,endedJob,personalQuotaReadout,usableMachines,noServerText} from './workbench-ui.js';
import {openDialogs,reducedMotion} from './motion-ui.js';
import {skyReading} from './sky-ui.js';
import {recentFailure,failureReadKey} from './attention-state.js';

const finite=value=>Number.isSafeInteger(value)&&value>=0;
const activeData=new Set(['UPLOADING','QUEUED','RUNNING','IMPORTING','DOWNLOADING','COPYING']);
const failedData=new Set(['FAILED','UNKNOWN','PARTIAL','UNCONFIRMED']);
export function controlSnapshot(store,{sessions=[],activities=[],activitiesComplete=false,focusJobId,now=Date.now(),seen=null}={}){
  const principal=store.principal,user=store.users.find(row=>row.id===principal?.userId);
  if(!principal)return {jobs:[],active:[],attention:[],approvals:[],failedJobs:[],servers:[],sessions:[],activities:[],focal:null,quota:null,usage:null,dataCount:null};
  const jobs=store.jobs,active=jobs.filter(row=>!endedJob(row));
  const focal=active.find(row=>row.id===focusJobId&&row.state==='RUNNING'&&!row.cancelRequested)||active.find(row=>row.state==='RUNNING'&&!row.cancelRequested)||null;
  const ownedSessions=sessions.filter(row=>row.userId===principal.userId);
  const ownedActivities=[...new Map(activities.filter(row=>typeof row.id==='string').map(row=>[row.id,row])).values()];
  const unread=(kind,row)=>recentFailure(row,now)&&!seen?.has(failureReadKey(kind,row)),failedJobs=jobs.filter(row=>row.state==='FAILED');
  const attention=jobs.filter(row=>row.state==='UNKNOWN'||row.state==='FAILED'&&unread('job',row)).map(row=>({id:'job:'+row.id,name:row.name||'训练',fact:row.error||row.latestAttempt?.failureReason||stateWord(row),action:row.state==='FAILED'?'查看诊断':'刷新核对',jobId:row.id,state:row.state,readKey:row.state==='FAILED'?failureReadKey('job',row):null}));
  for(const row of ownedActivities.filter(row=>failedData.has(row.state)&&(row.state!=='FAILED'||unread('data',row))))attention.push({id:'data:'+row.id,name:row.name||row.kind||'后台数据任务',fact:row.error||row.state,action:'查看数据任务',activityId:row.id,state:row.state,readKey:row.state==='FAILED'?failureReadKey('data',row):null});
  const approvals=principal.role==='admin'?store.users.filter(row=>row.enabled&&row.role!=='admin'&&!row.approvedAt&&row.total===0):[];
  const hosts=new Map((store.data?.gpuq?.hosts||[]).map(host=>[host.id,host]));
  const servers=(store.data?.machines||[]).map(machine=>{
    // Reachability alone is not a confirmed scheduler observation. Never paint
    // missing/failed collection as online or infer that unknown cards are free.
    const host=hosts.get(machine.id),fresh=store.production===true&&store.data?.gpuq?.stale===false&&host?.reachable===true&&host.gpuq?.connected===true&&host.gpuq?.health==='ok';
    const state=!fresh?'unknown':host.gpuq?.observeOnly?'observe':'online';
    const available=Array.isArray(host?.gpus)&&host.gpus.length===machine.cards&&new Set(host.gpus.map(gpu=>gpu.index)).size===machine.cards&&host.gpus.every(gpu=>Number.isSafeInteger(gpu.index)&&gpu.index>=0&&gpu.index<machine.cards&&gpu.processesAvailable===true&&Array.isArray(gpu.processes));
    const busy=fresh&&available?host.gpus.filter(gpu=>gpu.processes?.length>0).length:null;
    return {...machine,host,fresh,available,state,busy,quota:finite(user?.limits?.[machine.id])?user.limits[machine.id]:null};
  });
  const usage=user&&typeof store.usage==='function'?store.usage(user.id):null;
  return {jobs,active,attention,approvals,failedJobs,servers,sessions:ownedSessions,activities:ownedActivities,focal,quota:finite(user?.total)?user.total:null,usage,quotaReadout:personalQuotaReadout(user,usage),dataCount:activitiesComplete?ownedActivities.filter(row=>activeData.has(row.state)).length:null};
}


// One global palette. Results call the existing page actions and never submit a write.
export function controlUI(store,{navigate,toast,openSubmit,openJob}){
  const dialog=document.querySelector('#mission-control'),content=document.querySelector('#mission-control-content');
  let commands=[],shown=[],cursor=0,returnFocus,readController,actor,loading=false,readFailed=false;
  const q=selector=>dialog.querySelector(selector);
  const jump=(id,label,run,detail='跳转')=>({id,label,run,detail});
  function baseCommands(){
    const rows=[['resources','算力'],['work','项目'],['jobs','任务'],['datasets','数据'],['community','协作'],['workshop','创意工坊']].map(([id,label])=>jump(id,label,()=>navigate(id)));
    if(store.production&&store.data?.executionEnabled===true)rows.push(jump('submit','新建任务',()=>{navigate('jobs');openSubmit();},'动作'));
    rows.push(jump('new-project','新建项目',()=>{navigate('work');if(!usableMachines(store).length)return void toast(noServerText);const panel=document.querySelector('#project-create');if(panel){panel.open=true;panel.scrollIntoView({block:'center'});panel.querySelector('input')?.focus();}},'动作'));
    rows.push(jump('terminal','打开终端',()=>{navigate('work');if(!usableMachines(store).length)return void toast(noServerText);const button=document.querySelector('#terminal-open');if(!button||button.disabled){toast('先选择一个项目，再打开终端。');document.querySelector('[name=workspace-project]')?.focus();return;}for(let parent=button.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;button.click();},'动作'));
    rows.push(jump('upload','上传数据集',()=>{navigate('datasets');const form=document.querySelector('#dataset-upload-form');if(form){form.closest('details').open=true;form.scrollIntoView({block:'center'});form.querySelector('input')?.focus();}},'动作'));
    rows.push(jump('transfers','传输与导入',()=>navigate('transfers')));
    if(store.principal?.role==='admin'&&hasAdminSections())rows.push(jump('admin','管理台',()=>navigate('admin')));
    for(const job of store.jobs)rows.push(jump('job:'+job.id,job.name||job.id,()=>{navigate('jobs');openJob(job.id);},'任务 · '+stateWord(job)+' · '+(job.machine||'未知')));
    return rows;
  }
  function render(){
    if(!dialog.open)return;
    const search=q('#control-command').value.trim().toLocaleLowerCase(),list=q('#control-suggestions'),sky=skyReading();
    if(['火星','mars','月球','月亮','moon'].includes(search)){
      const mars=['火星','mars'].includes(search);shown=[];q('#control-command').removeAttribute('aria-activedescendant');
      list.innerHTML=`<div class="palette-egg" role="status"><span class="${mars?'egg-mars':'egg-moon'}" aria-hidden="true">${mars?'◉':'◐'}</span><div><strong>${esc(mars?sky.mars:sky.moon)}</strong><p>${mars?'约 780 天，再一次奔赴火星。':'今晚的月相，陪你等待下一次结果。'}</p></div></div>`;return;
    }
    shown=commands.filter(row=>(row.label+' '+row.detail+' '+row.id).toLocaleLowerCase().includes(search)).slice(0,40);cursor=Math.min(cursor,Math.max(0,shown.length-1));
    list.innerHTML=shown.length?shown.map((row,index)=>`<button type="button" id="control-option-${index}" title="${esc(row.label+' · '+row.detail)}" class="palette-result ${index===cursor?'selected':''}" role="option" aria-selected="${index===cursor}" data-command-id="${esc(row.id)}"><span>${esc(row.label)}</span><small>${esc(row.detail)}</small><span aria-hidden="true">↵</span></button>`).join(''):`<p class="palette-empty" role="status">${loading?'正在搜索…':readFailed?'部分内容暂时读不到，请重新打开搜索。':'没有找到结果'}</p>`;
    if(shown.length)q('#control-command').setAttribute('aria-activedescendant','control-option-'+cursor);else q('#control-command').removeAttribute('aria-activedescendant');
    q('#palette-status').textContent=loading?'正在读取项目和数据集':readFailed?'部分内容暂时读不到':'↑ ↓ 选择 · Enter 打开 · Esc 关闭';
    for(const [index,element] of [...list.querySelectorAll('button')].entries())element.style.setProperty('--result-delay',Math.min(index,8)*20+'ms');
  }
  async function readCatalog(){
    readController?.abort();const controller=new AbortController();readController=controller;const user=store.principal?.userId,generation=store.authGeneration;loading=true;readFailed=false;
    const results=await Promise.allSettled(usableMachines(store).flatMap(machine=>['projects.list','datasets.list'].map(async operation=>({machine:machine.id,operation,result:await store.call(operation,{machine:machine.id},{signal:controller.signal})}))));
    if(controller.signal.aborted||user!==store.principal?.userId||generation!==store.authGeneration||!dialog.open)return;
    for(const result of results){
      if(result.status==='rejected'){readFailed=true;continue;}
      const {machine,operation,result:data}=result.value;
      if(operation==='projects.list')for(const project of data.projects||[])commands.push(jump('project:'+machine+':'+(project.ownerId||'')+':'+project.project,project.displayName||project.project,()=>document.dispatchEvent(new CustomEvent('gpuq-open-project',{detail:{userId:user,authGeneration:generation,machine,project:project.project,ownerId:project.ownerId}})),'项目 · '+machine+' · '+project.project));
      else for(const dataset of data.datasets||[])commands.push(jump('dataset:'+machine+':'+dataset.dataset,dataset.name||dataset.dataset,()=>{navigate('datasets');document.dispatchEvent(new CustomEvent('gpuq-open-dataset',{detail:{userId:user,machine,dataset:dataset.dataset}}));},'数据集 · '+machine));
    }
    loading=false;render();
  }
  function close(){readController?.abort();if(dialog.open)dialog.close();returnFocus?.focus({preventScroll:true});}
  function open(){
    if(!store.principal)return;
    if(dialog.open){q('#control-command').focus();return;}
    returnFocus=document.activeElement;commands=baseCommands();cursor=0;actor=store.principal?.userId;
    content.innerHTML='<div class="palette-head"><label class="sr-only" id="mission-control-title" for="control-command">搜索与命令</label><input id="control-command" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="control-suggestions" autocomplete="off" placeholder="搜索项目、任务、数据集或动作…"><button type="button" data-control-close aria-label="关闭命令面板">Esc</button></div><div id="control-suggestions" role="listbox" aria-label="搜索结果"></div><p id="palette-status" class="palette-footer"></p>';
    dialog.showModal();render();q('#control-command').focus();
    if(!reducedMotion())dialog.animate([{opacity:0,transform:'scale(.98)'},{opacity:1,transform:'none'}],{duration:280,easing:'cubic-bezier(.34,1.32,.5,1)'});
    void readCatalog();
  }
  function run(id){const command=shown.find(row=>row.id===id);if(command){close();command.run();}}
  document.addEventListener('click',event=>{if(event.target.closest('[data-shell-action=control]'))open();});
  dialog.addEventListener('click',event=>{const button=event.target.closest('[data-command-id]');if(button)run(button.dataset.commandId);if(event.target.closest('[data-control-close]')||event.target===dialog)close();});
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  dialog.addEventListener('close',()=>readController?.abort());
  dialog.addEventListener('input',event=>{if(event.target.id==='control-command'){cursor=0;render();}});
  document.addEventListener('keydown',event=>{
    if(openDialogs().some(layer=>layer!==dialog))return;
    if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();if(dialog.open)close();else open();return;}
    if(event.target.id!=='control-command'||!['ArrowDown','ArrowUp','Enter','Home','End'].includes(event.key))return;
    event.preventDefault();if(!shown.length)return;if(event.key==='Enter'){run(shown[cursor].id);return;}
    cursor=event.key==='Home'?0:event.key==='End'?shown.length-1:(cursor+(event.key==='ArrowUp'?-1:1)+shown.length)%shown.length;for(const [index,row] of [...q('#control-suggestions').querySelectorAll('[role=option]')].entries()){row.classList.toggle('selected',index===cursor);row.setAttribute('aria-selected',String(index===cursor));}q('#control-command').setAttribute('aria-activedescendant','control-option-'+cursor);q('#control-option-'+cursor)?.scrollIntoView({block:'nearest'});
  });
  store.onAuthChange(()=>{close();commands=[];shown=[];actor=null;});
  return {open,close,update(){if(actor&&actor!==store.principal?.userId)close();}};
}
