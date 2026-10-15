import {uploadBrowserFile} from './personal-upload.js';
import {downloadBrowserPath} from './file-transfer-ui.js';
import {createJobDiagnostics} from './job-diagnostics-ui.js';
import {formatTimestamp} from './time-format.js';
import {createJobResultAccess,resultFilesHTML,resultPullCommand,deletableResultJob,deleteJobOutputs} from './job-results-ui.js';
import {jobProgressHTML,jobNotificationHTML} from './job-progress-ui.js';
import {schedulingFields,schedulingFromForm,schedulingSummary} from './scheduling-ui.js';
import {elasticFields,elasticFromForm,allocationSummary,placementFields,placementFromForm,placementSummary} from './gpu-allocation-ui.js';
import {taskDescription} from './task-metadata.js';
import {installTaskLabelEditor,taskLabelEditorHTML} from './task-display-ui.js';
import {createProjectManagement,projectSelectHTML} from './project-management-ui.js';
import {escapeUI as escape,workbenchCards,jobOverviewHTML,endedJob,stateHTML,stateClass,trainingReadout,quotaLedgerHTML,personalQuotaReadout,boundarySweep,taskMissionUI,infoHTML,discloseInfo,projectEnvironmentLabel,createProjectActivity} from './workbench-ui.js';
import {trainingStorageMessage,trainingSelectionHTML} from './training-storage-ui.js';
import {revealSheet,dismissSheet,sharedObject} from './motion-ui.js';
import {createTaskNotesUI} from './task-notes-ui.js';
import {maintenanceFor,heldDuringMaintenance,maintenanceTime,maintenanceInfoHTML} from './maintenance-state.js';
const terminal=new Set(['SUCCEEDED','FAILED','CANCELED']);
const uuidPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function trainingUnavailable(snapshot,hosts=[]){
  return snapshot?.stale===false&&hosts.length>0&&hosts.every(host=>host.reachable===false||host.gpuq?.connected===false||host.gpuq?.observeOnly===true||host.gpuq?.health==='degraded');
}
const priorities={normal:{label:'普通',description:'默认排队，不会因新任务自动中断。'},idle:{label:'最低 · 可中断',description:'只适合可丢弃或自行保存进度的任务；让位时结束进程，已写入的输出保留。'},high:{label:'高',description:'优先排队，可让最低任务让位；不自动中断普通任务。'}};
export function priorityLabel(value){return priorities[value]?.label||(Number.isInteger(value)&&value>=0&&value<=4?`P${value}（原队列）`:'未标注');}
export function priorityOptions(admin=false,selected='normal'){return ['normal','idle','high'].map(value=>`<option value="${value}" ${value===selected?'selected':''}>${priorities[value].label}</option>`).join('');}
export function trainingPriority(value,admin=false){if(!Object.hasOwn(priorities,value))throw Error('请选择任务优先级。');return value;}
export function priorityDescription(value){return priorities[value]?.description||'优先级尚未确认。';}
const rankLabels=['P0 最低','P1 低','P2 普通','P3 较高','P4 最高'];
export function priorityRankOptions(selected){return ['idle','P1','normal','P3','high'].map((value,i)=>`<option value="${value}" ${value===selected?'selected':''}>${rankLabels[i]}</option>`).join('');}
export function priorityRankValue(value){if(!['idle','P1','normal','P3','high','P0','P2','P4'].includes(value))throw Error('请选择 P0–P4 排队等级。');return value;}
export function priorityRankLabel(job){return job.priority!=null&&Number.isInteger(job.schedulerPriority)&&job.schedulerPriority>=0&&job.schedulerPriority<=4?rankLabels[job.schedulerPriority]:priorityLabel(job.priority);}
export function schedulingContractLabel(policy){if(!policy)return '让位/恢复策略未确认';return `${({never:'不让位',now:'允许立即让位',save:'保存后让位'})[policy.yield_policy]||'让位方式未知'} · ${policy.restart_policy==='on-preempt'?'被抢占后重新排队':policy.restart_policy==='never'?'被抢占后不重排':'重启方式未知'}`;}
export function sampleTime(value){
  return formatTimestamp(value);
}
export function taskStateLabel(job){
  if(job.state==='CANCELED'&&job.preempted===true)return '让位结束';
  return {SUBMITTING:'提交中',PENDING:'排队中',QUEUED:'排队中',STARTING:'启动中',RUNNING:'运行中',UNKNOWN:'状态待核对',SUCCEEDED:'已完成',FAILED:'失败',CANCELED:'已取消',PREEMPTING:'正在让位',PREEMPTED:'让位结束'}[job.state]||job.state||'状态未知';
}
export const validProject=value=>typeof value==='string'&&/^[a-z][a-z0-9_-]{0,47}$/.test(value);
export function projectDirectoryListing(result){
  if(!Array.isArray(result?.projects))throw Error('项目列表尚未确认，请重新读取。');
  return {projects:result.projects.filter(item=>validProject(item?.project)),environmentModes:Array.isArray(result.environmentModes)?result.environmentModes.filter(mode=>mode==='oci'):[]};
}
export function projectDirectoryEntries(directory,machines){
  return machines.flatMap(({id})=>(directory.get(id)?.projects||[]).map(info=>({machine:id,info})));
}
export function projectDirectoryValue(entry,entries,selectedMachine=''){
  if(entries.some(item=>item!==entry&&item.machine===entry.machine&&item.info.project===entry.info.project&&item.info.ownerId!==entry.info.ownerId))return JSON.stringify([entry.machine,entry.info.ownerId,entry.info.project]);
  return entry.machine===selectedMachine||entries.filter(item=>item.info.project===entry.info.project).length===1?entry.info.project:JSON.stringify([entry.machine,entry.info.project]);
}
export function projectDirectorySelection(value,entries,selectedMachine=''){return entries.find(entry=>projectDirectoryValue(entry,entries,selectedMachine)===value);}
export function projectCreationMachine(mode,focus,source,directory,machines){
  const ids=machines.map(item=>item.id);
  if(mode!=='oci')return ids.includes(focus)?focus:'';
  return [source,focus,...ids].find(id=>ids.includes(id))||'';
}
export function projectStatusText(info){
  const git=info?.git;
  return git?[git.url,git.branch,git.commit].filter(Boolean).join(' · '):'工作区 /workspace；共享数据 /datasets；任务输出 /outputs。';
}
export function trainingProject(project){
  if(!validProject(project?.project))throw Error('请选择项目工作区。');
  return {project:project.project,...(project.ownerId?{ownerId:project.ownerId}:{})};
}
export function trainingTarget(mode,machine,project,candidates,machines){
  if(mode==='current')return {machine};
  if(mode!=='auto')throw Error('请选择服务器或自动选机。');
  const ids=String(candidates||'').trim().split(/[\s,，]+/).filter(Boolean);
  if(new Set(ids).size!==ids.length||ids.some(id=>!machines.some(m=>m.id===id)))throw Error('候选服务器需填写清单中的完整名称，不要重复。');
  return {machine:'auto',machineSelection:{mode:'auto',...(ids.length?{candidates:ids.sort()}: {})}};
}
export function trainingReceiptMatches(job,args,userId,machines){
  return !!job?.id&&job.key===args.key;
}
// A machine lookup can finish after a newer dataset choice. Keep each explicit
// submission intent separate from project request epochs and authentication.
export function createSubmitSelectionGuard(){
  let generation=0,latest=null;
  return {
    begin(machine,datasetRef,identity){latest=Object.freeze({generation:++generation,machine,datasetRef,identity});return latest;},
    current(value,machine,identity){return !!value&&value===latest&&value.generation===generation&&value.machine===machine&&value.identity===identity;},
    invalidate(){generation++;latest=null;}
  };
}
export function projectDiskQuotaHTML(value){
  const bytes=n=>Number.isFinite(n)?new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1}).format(n/1024**3)+' GiB':'未知';
  if(value?.enabled===false)return '<p class="disk-quota-status">未启用</p>';
  return '<ul class="disk-quota-volumes">'+(value?.volumes||[]).map(row=>`<li><strong>${escape(row.volume)}</strong><dl><dt>容量</dt><dd>${bytes(row.usedBytes)} / ${bytes(row.bytes)}</dd><dt>文件与目录</dt><dd>${escape(row.usedInodes??'未知')} / ${escape(row.inodes??'未知')}</dd></dl></li>`).join('')+'</ul>';
}
export async function uploadProjectFile(file,context,call,progress=()=>{},{signal,key,current=()=>true,onRecoverySupport=()=>{}}={}){
  const check=()=>{signal?.throwIfAborted();if(!current())throw new DOMException('项目或账号已改变，上传已暂停。','AbortError');};
  check();
  if(context.area!=='code')throw Error('请选择项目代码目录。');
  if(!Number.isSafeInteger(file.size)||file.size<0)throw Error('文件大小无效。');
  check();onRecoverySupport(true);
  return uploadBrowserFile(file,{machine:context.machine,project:context.project,ownerId:context.ownerId,area:'code',path:context.path,key,
    overwrite:true,signal,call:async(operation,args)=>{check();const result=await call(operation,args);check();return result;},
    onProgress:row=>{check();progress(row.offset,file.size,row);}});
}

export function executionUI(store,refresh,toast){
  let section,log,actor=null,submitKey=crypto.randomUUID(),machine='',project='',projectOwner='',catalog=[],catalogError='',projectBusy=false,operationBusy=false;
  let focusMachine='',directory=new Map(),directoryOwner='',directoryLoading=false,directoryError='';
  let epoch=0,machineIdentity='';
  const projectActivity=createProjectActivity(),explicitProjectReads=new Set(),closedProjectDialogs=new WeakSet();let directoryRead=null,projectPaused=false,pageActive=true,projectOperation=false,projectDialogObserver;
  let submitDialog,settingsDialog,settingsSource=null,outputPlace=null,focusedJob=null,historyState='',jobHTML='',lastJobs=new Map(),liveJobs=new Set(),deepLinkHandled=false,notes=null,notesJob=null,notesGeneration=0;
  let submitReceipt=null,parsedTarget=null,acceptedDraft=false,managementSubmit=false;
  let projectManagement=null;
  let quotaKey='',quotaState='idle',quotaResult=null,quotaError='',quotaController;
  let uploadRecovery=null;
  let fileReadController=null,fileReadTurn=0,resultFilePath=null;
  const resultAccess=createJobResultAccess({store,changed:()=>{resultAccess.paint();}});
  const uploadScope=()=>JSON.stringify([store.authGeneration,store.principal?.userId,actor,machine,projectOwner,project]);
  const managementAllowed=()=>managementSubmit&&store.principal?.role==='admin';
  function submissionMode(management){
    const priority=query('[name=priority]'),rank=query('[name=queue-rank]');if(!priority||!rank)return false;
    managementSubmit=management;const value=priority.value;priority.innerHTML=priorityOptions(management,value);
    const selected=rank.value;rank.replaceChildren(...[0,1,2,3,4].map(n=>new Option('P'+n,'P'+n,false,'P'+n===selected)));
    updateControls();return true;
  }
  const mission=taskMissionUI(store,{toast,resultAction:job=>resultAccess.markup(job),onOpen:id=>{focusedJob=id;renderJobs(ownJobs());document.dispatchEvent(new CustomEvent('gpuq-focused-job',{detail:{id}}));document.dispatchEvent(new CustomEvent('gpuq-attention-viewed',{detail:{userId:store.principal?.userId,kind:'job',id}}));}});
  installTaskLabelEditor(store,{toast,refresh});
  const jobHeading=id=>[...document.querySelectorAll('[data-workbench-job]')].find(row=>row.dataset.workbenchJob===id)?.querySelector('.wb-job-heading');
  const overviewWithLabels=(job,options)=>resultAccess.markup(job)+jobOverviewHTML(job,options)+taskLabelEditorHTML(job,store.principal);
  const diagnostics=createJobDiagnostics(store,()=>log,toast,{drawer:true,header:job=>`<span class="sheet-object">${stateHTML(job,false)}<span>${escape(job.name||'训练详情')}</span></span>`,reveal:(dialog,job,origin)=>{sharedObject(origin||jobHeading(job.id),dialog.querySelector('.sheet-object'));revealSheet(dialog,{drilldown:true});},dismiss:dialog=>dismissSheet(dialog,{drilldown:true,target:jobHeading(focusedJob)}),overview:job=>overviewWithLabels(job,{owned:!!store.principal,schedulingHTML:allocationSummary(job)+placementSummary(job)+`<span>排队优先级：${escape(priorityRankLabel(job))}</span>`+schedulingSummary(job)+`<span>${escape(schedulingContractLabel(job.schedulerPolicy??{yield_policy:job.yieldPolicy,restart_policy:job.restartPolicy}))}</span><span>状态：${escape(job.schedulerState||'未提供')}</span><span>更新于 ${escape(sampleTime(job.schedulerCheckedAt))}</span>`}),output:showOutput,notes:showNotes,onCompletion:(value,job)=>resultAccess.accept(job,value),onView:next=>{if(next!=='notes')notes?.sync(false,true);}});
  const call=(operation,args)=>store.call(operation,{...(projectOwner?{ownerId:projectOwner}:{}),...args}),query=selector=>section?.querySelector(selector)||submitDialog?.querySelector(selector)||settingsDialog?.querySelector(selector)||log?.querySelector(selector)||document.querySelector('#shell-context')?.querySelector(selector);
  const context=()=>({machine,...(project?{project,...(projectOwner?{ownerId:projectOwner}:{})}:{})}),currentProject=()=>catalog.find(item=>item.project===project&&(!projectOwner||item.ownerId===projectOwner));
  const projectMachines=()=>store.principal?(store.data?.machines||[]):[];
  const directoryEntries=()=>projectDirectoryEntries(directory,projectMachines());
  const executionActive=()=>store.production&&!!store.principal&&store.data?.executionEnabled===true;
  const creationMachine=()=>projectCreationMachine('oci',focusMachine,project?machine:'',directory,projectMachines());
  function rememberCatalog(selected=machine){if(selected)directory.set(selected,{...directory.get(selected),projects:catalog});}
  const currentToken=()=>JSON.stringify([actor,machine,projectOwner,project,epoch,projectActivity.generation,store.principal?.userId,store.principal?.role,store.authGeneration]),ownJobs=()=>store.jobs;
  const submitSelection=createSubmitSelectionGuard(),submitIdentity=()=>JSON.stringify([currentToken(),store.principal?.userId,store.principal?.role,store.authGeneration,document.body.dataset.room]);
  const automaticTraining=()=>query('[name=training-target]')?.value==='auto';
  const interactiveTraining=()=>query('[name=interactive]').checked;
  const trainingHosts=()=>{
    const candidates=String(query('[name=training-candidates]')?.value||'').trim().split(/[\s,，]+/).filter(Boolean),user=store.users.find(u=>u.id===actor);
    return (store.data?.gpuq?.hosts||[]).filter(h=>automaticTraining()?user?.limits?.[h.id]>0&&(!candidates.length||candidates.includes(h.id))&&!maintenanceFor(store.data?.operationalMaintenance,h.id):h.id===machine);
  };
  const priorityAvailable=()=>enabled();
  const customAvailable=()=>enabled();
  const enabled=()=>executionActive()&&projectMachines().some(item=>item.id===machine);
  const isVisible=()=>section?.isConnected===true&&!section.hidden&&!document.hidden&&(!section.closest('[data-page]')?.hidden||submitDialog?.open||settingsDialog?.open||log?.open);
  const projectActive=()=>pageActive&&!projectPaused&&isVisible();
  const projectReadable=()=>pageActive&&!document.hidden&&(projectActive()||explicitProjectReads.size>0);
  const projectCall=(operation,args)=>projectActivity.run(signal=>store.call(operation,{...(projectOwner&&args?.project===project?{ownerId:projectOwner}:{}),...args},{signal}));
  async function explicitProjectRead(read){const ticket={};explicitProjectReads.add(ticket);try{return await read();}finally{explicitProjectReads.delete(ticket);}}
  const status=(text,error=false)=>{const element=query('#project-status');if(element){element.textContent=text;element.classList.toggle('form-error',error);}};
  function cancelProjectActivity(){
    cancelDiskQuota();
    projectPaused=true;projectActivity.cancel();explicitProjectReads.clear();projectBusy=false;
    if(directoryLoading){directoryOwner='';directoryLoading=false;}
    if(projectOperation){operationBusy=false;projectOperation=false;}
    if(section&&actor)updateControls();
  }
  function activateProjectActivity(){flushClosedProjectDialogs();if(!pageActive||!isVisible())return false;projectPaused=false;return true;}
  function cancelDiskQuota(){quotaController?.abort();quotaController=null;if(quotaState==='loading')quotaState='idle';}
  function renderDiskQuota(){
    const panel=query('#project-disk-quota');if(!panel)return;
    query('#disk-quota-state').textContent=({idle:'',loading:' · 查询中',ready:' · 已启用',disabled:' · 未启用',unknown:' · 待确认'})[quotaState];
    const place=query('#disk-quota-machine');place.textContent=machine||'选择项目后查看';place.title=machine;
    query('#disk-quota-refresh').disabled=!enabled()||quotaState==='loading';
    const result=query('#disk-quota-result');
    if(quotaResult!==null)result.innerHTML=quotaResult;
    else{result.textContent=quotaState==='unknown'?quotaError||'磁盘用量待确认，请稍后刷新。':quotaState==='loading'?'正在查询…':machine?'点击刷新查看项目磁盘用量。':'先选择项目或服务器。';}
  }
  function syncDiskQuota(){
    const key=currentToken();if(key!==quotaKey){cancelDiskQuota();quotaKey=key;quotaState='idle';quotaResult=null;quotaError='';}
    renderDiskQuota();if(query('#project-disk-quota')?.open&&projectActive()&&enabled()&&quotaState==='idle')void loadDiskQuota();
  }
  async function loadDiskQuota(){
    if(!enabled()||!activateProjectActivity()||quotaState==='loading')return;
    cancelDiskQuota();const token=currentToken(),controller=new AbortController(),target=machine,owner=actor;quotaController=controller;quotaKey=token;quotaState='loading';quotaResult=null;quotaError='';renderDiskQuota();
    const current=()=>!controller.signal.aborted&&token===currentToken()&&query('#project-disk-quota')?.open&&projectActive();
    try{
      const value=await projectActivity.run(signal=>store.call('projects.quota',{machine:target,...(projectOwner?{ownerId:projectOwner}:{}),...(project?{project}:{})},{signal:AbortSignal.any([signal,controller.signal])}));
      if(!current())return;quotaResult=projectDiskQuotaHTML(value,owner);quotaState=value.enabled?'ready':'disabled';
    }catch(error){if(!current()||error.name==='AbortError')return;quotaState='unknown';quotaResult=null;quotaError=error.message||'磁盘用量待确认，请稍后刷新。';}
    finally{if(current()){quotaController=null;renderDiskQuota();}}
  }
  function validateProjectName(){
    const input=query('[name=new-project]'),error=query('#project-name-error');if(!input||!error)return true;
    const invalid=!!input.value&&!validProject(input.value);input.setAttribute('aria-invalid',String(invalid));error.hidden=!invalid;error.textContent=invalid?'小写字母开头，限字母、数字、_ 和 -，最多 48 位。':'';
    return validProject(input.value);
  }
  function notifyContext(){document.dispatchEvent(new CustomEvent('gpuq-workspace-context',{detail:{userId:actor,...context()}}));}
  const reduced=()=>matchMedia('(prefers-reduced-motion:reduce)').matches;
  function showSheet(dialog,options={}){if(dialog.open)return;dialog.showModal();if(dialog===submitDialog||dialog===settingsDialog){activateProjectActivity();}revealSheet(dialog,options);}
  function closeSettings(){if(!settingsSource)return;const source=settingsSource;settingsSource=null;source.append(...settingsDialog.querySelector('.sheet-scroll').children);source.open=false;settingsDialog.close();}
  function settings(source){closeSettings();settingsSource=source;settingsDialog.querySelector('h2').textContent=source.querySelector('summary').textContent;for(const control of source.querySelectorAll('input,select,textarea'))control.setAttribute('form','train-form');settingsDialog.querySelector('.sheet-scroll').append(...[...source.children].filter(child=>child.tagName!=='SUMMARY'));showSheet(settingsDialog,{drilldown:true});}
  function adaptWorkspace(){
    const selectors=section.querySelectorAll('.workspace-context-grid>label');
    for(const [index,selector] of ['#context-machine','#context-project'].entries()){const proxy=document.querySelector(selector),label=selectors[index],select=label?.querySelector('select');if(proxy&&label&&select){select.id=proxy.id;proxy.closest('label').replaceWith(label);}}
    section.querySelector('.workspace-context-grid').remove();
    section.querySelector('.workspace-context-heading').querySelector('.eyebrow').textContent='代码与环境';
    section.querySelector('#workspace-context-title').textContent='团队项目';
    const projectLabel=query('[name=workspace-project]').closest('label');for(const node of projectLabel.childNodes)if(node.nodeType===Node.TEXT_NODE)node.textContent='团队项目';
    const projectLocation=document.createElement('p');projectLocation.id='project-location';projectLocation.className='workspace-status mono server-id';projectLocation.hidden=true;query('#project-environment').after(projectLocation);
    for(const id of ['terminal-open'])query('#'+id).classList.remove('primary');
    const train=section.querySelector('#train-form'),panel=train.closest('details');panel.id='train-panel';panel.querySelector('summary').hidden=true;
    submitDialog=document.createElement('dialog');submitDialog.id='work-submit';submitDialog.className='work-sheet submit-sheet';submitDialog.setAttribute('aria-labelledby','submit-title');
    submitDialog.innerHTML='<header class="sheet-header glass"><div><p id="submit-context" class="mono"></p><h2 id="submit-title">提交训练</h2></div><button class="button quiet" type="button" id="close-submit" aria-label="关闭提交抽屉">关闭</button></header>';
    submitDialog.append(panel);document.body.append(submitDialog);
    const scroll=document.createElement('div');scroll.className='sheet-scroll';const submit=train.querySelector('[type=submit]');for(const child of [...train.children])if(child!==submit)scroll.append(child);train.append(scroll);
    const checks=document.createElement('section');checks.className='submit-checks';checks.innerHTML='<div class="spread"><h3>提交设置</h3><button class="button quiet" type="button" id="submit-check-refresh">刷新状态</button></div><ul id="submit-check-list" class="checks"></ul>';
    const cli=document.createElement('details');cli.className='submit-cli';cli.innerHTML='<summary>等价命令 · 你的电脑</summary><pre id="submit-command" tabindex="0"></pre><button class="button quiet" type="button" id="copy-submit-command">复制完整命令</button><p class="muted">命令包含当前项目与服务器；请先在自己的电脑登录 gpuctl。</p>';
    scroll.append(checks,cli);const footer=document.createElement('div');footer.className='sheet-footer glass';footer.innerHTML='<div><p id="submit-summary" class="muted">提交到所选服务器</p><div id="submit-receipt-actions"></div></div>';footer.append(submit);train.append(footer);
    panel.addEventListener('toggle',()=>{if(panel.open){updatePreflight();showSheet(submitDialog);}else submitDialog.close();});
    submitDialog.addEventListener('close',()=>{if(submitDialog.open)return;submitSelection.invalidate();closeSettings();panel.open=false;});
    submitDialog.addEventListener('cancel',event=>{event.preventDefault();submitSelection.invalidate();closeSettings();dismissSheet(submitDialog);});
    settingsDialog=document.createElement('dialog');settingsDialog.id='work-submit-panel';settingsDialog.className='work-sheet settings-sheet';settingsDialog.setAttribute('aria-labelledby','submit-panel-title');settingsDialog.innerHTML='<header class="sheet-header glass"><h2 id="submit-panel-title">提交设置</h2><button class="button quiet" id="close-submit-panel" type="button">返回提交</button></header><div class="sheet-scroll"></div>';document.body.append(settingsDialog);
    settingsDialog.addEventListener('cancel',event=>{event.preventDefault();dismissSheet(settingsDialog,{drilldown:true});closeSettings();});settingsDialog.addEventListener('close',()=>{if(!settingsDialog.open)closeSettings();});
    for(const detail of train.querySelectorAll('.training-advanced>details'))detail.querySelector('summary').addEventListener('click',event=>{event.preventDefault();settings(detail);});
    const layout=document.createElement('div');layout.className='wb-layout';const jobs=document.createElement('section');jobs.className='wb-jobs';jobs.setAttribute('aria-label','我的训练');const rail=document.createElement('aside');rail.className='wb-rail';rail.setAttribute('aria-label','项目、开发终端与文件');
    const table=query('#my-job-table'),kicker=section.querySelector('.section-kicker'),explanation=kicker.nextElementSibling;explanation.className='wb-job-explanation muted';jobs.append(table,kicker,explanation);rail.append(...section.children);layout.append(jobs,rail);section.append(layout);
    const receipt=document.createElement('section');receipt.id='submission-receipt';receipt.className='wb-receipt';receipt.setAttribute('aria-live','polite');receipt.hidden=true;jobs.prepend(receipt);
    const projectHelp=document.createElement('p');projectHelp.id='project-status-detail';query('#project-status').after(projectHelp);discloseInfo(projectHelp,'项目状态详情');
    const fileRoute=document.createElement('span');fileRoute.id='workspace-upload-route';fileRoute.innerHTML=infoHTML('文件使用校园网 HTTPS 直连；上传失败保留原编号和偏移。','文件传输路线');query('#workspace-files>summary').append(fileRoute);
    const prefill=document.createElement('div');prefill.id='submit-prefill';prefill.className='submit-prefill';prefill.hidden=true;scroll.prepend(prefill);
    for(const [id,label] of [['workspace-mode-note','代码与环境说明'],['terminal-mode-note','开发终端说明'],['training-target-note','训练位置说明'],['priority-note','优先级说明'],['custom-policy-note','排队与让位说明'],['elastic-note','弹性显卡说明'],['placement-note','共享显卡说明']])discloseInfo(query('#'+id),label);
    for(const text of section.querySelectorAll('.wb-rail p.muted,.wb-rail .project-actions>span'))discloseInfo(text,'工作区说明');
    for(const text of train.querySelectorAll('p.muted,label>small'))if(!text.closest('.submit-cli,.sheet-footer'))discloseInfo(text,'训练配置说明');
    discloseInfo(explanation,'任务额度说明');
    const contextInfo=query('#workspace-mode-note').closest('.ui-info'),statusInfo=query('#project-status-detail').closest('.ui-info'),contextCopy=document.createElement('div');contextCopy.className='ui-info-content';
    for(const id of ['workspace-mode-note','project-status-detail']){const note=query('#'+id);note.classList.remove('ui-info-content');contextCopy.append(note);}contextInfo.append(contextCopy);statusInfo.remove();contextInfo.querySelector('summary').setAttribute('aria-label','项目与 Git 说明');query('.workspace-context-heading>div').append(contextInfo);
    const disk=document.createElement('details');disk.id='project-disk-quota';disk.className='execution-panel';
    disk.innerHTML='<summary>磁盘配额<span id="disk-quota-state"></span></summary><div class="disk-quota-head"><span id="disk-quota-machine" class="server-id mono"></span>'+infoHTML('当前项目所属成员在这台服务器上的磁盘用量。未启用不代表零用量或无限容量，与显卡额度分开。','磁盘配额说明')+'<button id="disk-quota-refresh" class="button quiet" type="button">刷新</button></div><div id="disk-quota-result" role="status" aria-live="polite"></div>';
    query('#workspace-files').before(disk);disk.addEventListener('toggle',()=>{if(disk.open){activateProjectActivity();syncDiskQuota();}else cancelDiskQuota();});query('#disk-quota-refresh').addEventListener('click',()=>void loadDiskQuota());
  }
  const receiptActor=()=>JSON.stringify([store.principal?.userId,store.principal?.role,store.authGeneration]);
  function renderReceipt(){
    const root=query('#submission-receipt');if(!root)return;
    const receipt=submitReceipt&&submitReceipt.actor===receiptActor()?submitReceipt:null;root.hidden=!receipt;if(!receipt){root.replaceChildren();query('#submit-receipt-actions')?.replaceChildren();return;}
    const retryAllowed=!operationBusy&&store.production&&store.data?.executionEnabled===true&&!maintenanceFor(store.data?.operationalMaintenance,receipt.args.machine),errorClass=receipt.maintenance?'maintenance-held':'form-error';
    const job=receipt.job,word={pending:'正在提交',confirmed:'已提交',unknown:'提交结果待确认',rejected:'未提交'}[receipt.status];
    const selection=receipt.status==='confirmed'&&receipt.args.machine==='auto'?trainingSelectionHTML(job):'';
    const sheet=query('#submit-receipt-actions');if(sheet)sheet.innerHTML=`${selection}${receipt.error?`<p class="${errorClass}">${escape(receipt.error)}</p>`:''}${receipt.status==='unknown'?`<button class="button quiet" type="button" data-receipt-refresh ${operationBusy?'disabled':''}>刷新核对</button><button class="button quiet" type="button" data-receipt-retry ${retryAllowed?'':'disabled'}>原样重试</button>`:receipt.status==='confirmed'?'<button class="button quiet" type="button" data-receipt-new-draft>再次使用配置</button>':''}`;
    root.innerHTML=`<div><strong>${word}</strong><span>${escape(job?.machine||(receipt.args.machine==='auto'?'自动选机':receipt.args.machine))} · ${escape(receipt.args.name)}${job?.createdAt?' · '+escape(sampleTime(job.createdAt)):''}${job?.id?' · '+escape(job.id.slice(0,8)):''}</span>${selection}${receipt.error?`<p class="${errorClass}">${escape(receipt.error)}</p>`:''}</div><div class="job-acts">${job?.id?`<button class="button quiet" type="button" data-job-detail="${escape(job.id)}">查看任务</button><button class="button quiet" type="button" id="submission-new-draft">再次使用配置</button>`:''}${receipt.status==='unknown'?`<button class="button quiet" type="button" id="submission-refresh" ${operationBusy?'disabled':''}>刷新核对</button><button class="button quiet" type="button" id="submission-retry" ${retryAllowed?'':'disabled'}>原样重试</button>${infoHTML('重试使用原服务器、原请求和同一个提交标识。不会重复创建同一次提交。','重试说明')}`:''}</div>`;
    updatePreflight();
  }
  async function submitRequest(args){
    const owner=receiptActor(),previouslyUnknown=submitReceipt?.actor===owner&&submitReceipt.status==='unknown'&&submitReceipt.args.key===args.key;submitReceipt={actor:owner,args:structuredClone(args),status:'pending'};renderReceipt();
    try{
      const job=await call('jobs.submit',args);if(owner!==receiptActor())return;
      if(!trainingReceiptMatches(job,args))throw Error('提交结果未知，请按原编号查询：'+args.key);
      submitReceipt={actor:owner,args:structuredClone(args),status:'confirmed',job};acceptedDraft=true;submitKey=crypto.randomUUID();refresh();renderReceipt();toast('已提交。');
    }catch(error){
      if(owner!==receiptActor())return;
      // A refused retry cannot disprove acceptance of an earlier lost reply.
      submitReceipt={actor:owner,args:structuredClone(args),status:!previouslyUnknown&&(['MAINTENANCE_ACTIVE','SUBMISSION_REJECTED'].includes(error.code)||[400,401,403,409,422,429].includes(error.status))?'rejected':'unknown',maintenance:error.code==='MAINTENANCE_ACTIVE',error:trainingStorageMessage(error)};renderReceipt();throw error;
    }
  }
  function updatePreflight(){
    if(!submitDialog||!actor)return;query('#submit-context').textContent=(machine||'未选择服务器')+' · '+(project||'选择项目');
    query('.submit-cli').hidden=false;
    const user=store.users.find(item=>item.id===actor),used=store.usage(actor),quota=user?.total,info=currentProject(),host=store.data?.gpuq?.hosts?.find(item=>item.id===machine),fresh=store.production&&!store.data?.gpuq?.stale&&host?.reachable===true;
    const quotaReadout=personalQuotaReadout(user,used,quota);
    const authorized=enabled(),automatic=automaticTraining();

    const rows=[['服务器',authorized?machine:'选择已授权服务器',authorized],['额度',quotaReadout.exempt?`不限个人额度 · 已占用 ${quotaReadout.value} 张`:Number.isFinite(quota)?`${used} / ${quota} 张`:'待更新',quotaReadout.exempt||Number.isFinite(quota)],['工作区',project||'默认项目',true],['监控',fresh?'已更新':'待更新',fresh],['数据','直接读取共享 /datasets 目录',true]];
    if(automatic)rows[0]=['训练服务器','自动选择 · 开发仍在 '+machine,authorized];
    const unavailable=trainingUnavailable(store.data?.gpuq,trainingHosts());
    if(unavailable)rows.unshift(['等待调度','节点状态更新后继续',true]);
    query('#submit-check-list').innerHTML=rows.map(([label,text,ok])=>`<li><span class="what">${escape(label)}<small>${escape(text)}</small></span></li>`).join('');
    const entry=maintenanceFor(store.data?.operationalMaintenance,machine);
    let maintenance=query('#submit-maintenance');if(!maintenance){maintenance=document.createElement('div');maintenance.id='submit-maintenance';query('#train-form .sheet-scroll').prepend(maintenance);}
    maintenance.hidden=!entry;
    if(entry){const alternatives=(store.data?.machines||[]).filter(item=>user?.limits?.[item.id]>0&&!maintenanceFor(store.data?.operationalMaintenance,item.id));maintenance.innerHTML=`<p><span class="maintenance-pause" aria-hidden="true"></span> ${escape(store.data.operationalMaintenance.global?'全平台':machine)}维护中 · 自 ${escape(maintenanceTime(entry.since))}</p><p>${escape(entry.reason)}</p>${maintenanceInfoHTML("换机后请检查代码、环境和数据。不会自动提交。","换机说明")}${alternatives.length?`<label>改用其他服务器<select id="submit-maintenance-machine" aria-label="选择其他服务器">${alternatives.map(item=>`<option value="${escape(item.id)}">${escape(item.id)}</option>`).join('')}</select></label><button type="button" class="button" id="submit-maintenance-switch">改用其他服务器</button>`:'<p>没有其他可用服务器。</p>'}`;}
    query('#submit-summary').textContent=submitReceipt?.actor===receiptActor()&&submitReceipt.status==='rejected'?'未提交':entry?'维护中，暂停提交':unavailable?'等待调度':submitReceipt?.actor===receiptActor()&&['pending','unknown'].includes(submitReceipt.status)?(submitReceipt.status==='pending'?'正在提交':'提交结果待确认'):acceptedDraft&&submitReceipt?.job?'已提交 · '+submitReceipt.job.machine+' · '+submitReceipt.job.id.slice(0,8):automatic?'自动选机 · 排队':'提交到 '+machine;
    const prefill=query('#submit-prefill');prefill.hidden=!parsedTarget;if(parsedTarget)prefill.innerHTML=`<span>已预填 · ${escape(parsedTarget.machine)} / ${escape(parsedTarget.project||'选择项目')}</span>${infoHTML('识别只预填配置，不会提交训练。目标改变后，需明确改用当前目标。','预填说明')}<button type="button" class="button quiet" id="clear-training-prefill">改用当前目标</button>`;
    const quote=value=>"'"+String(value).replaceAll("'","'\\''")+"'",get=name=>query(`[name=${name}]`).value;
    const args=['gpuctl run',...(automatic?['--machine auto']:[quote(machine||'SERVER')]),'-g',get('cards'),'--min-vram',get('memory'),'--name',quote(get('name'))];
    if(automatic&&get('training-candidates').trim())args.push('--candidates',quote(get('training-candidates').trim().split(/[\s,，]+/).join(',')));
    if(project)args.push('--project',quote(project));if(get('task-description').trim())args.push('--description',quote(get('task-description')));
    if(query('[name=custom-policy]').checked){args.push('--rank',get('queue-rank'),'--yield',get('yield-policy'),'--restart-policy',get('restart-policy'));if(query('[name=checkpointable]').checked)args.push('--checkpointable');if(get('request-mode'))args.push('--mode',get('request-mode'));}else if(priorityAvailable())args.push('--priority',get('priority'));
    if(query('[name=elastic]').checked){args.push('--min-cards',get('min-cards'),'--global-batch',get('global-batch'),'--micro-batch',get('micro-batch'));if(query('[name=auto-expand]').checked)args.push('--auto-expand');}
    if(get('gpu-placement')!=='any'){args.push('--gpu',quote(get('gpu-indices')));if(get('gpu-placement')==='shared')args.push('--share','--vram-mib',get('vram-mib'));if(query('[name=hami]').checked)args.push('--hami','--sm-percent',get('sm-percent'));}
    if(interactiveTraining())args.push('--interactive');else args.push('-- /bin/bash -c',quote(get('command')));
    query('#submit-command').textContent=args.join(' ');
  }
  function renderJobs(jobs){
    const table=query('#my-job-table'),detailKey=item=>item.className+'|'+(item.closest('[data-workbench-job]')?.dataset.workbenchJob||'')+'|'+(item.querySelector('summary')?.getAttribute('aria-label')||item.querySelector('summary>span')?.textContent||item.querySelector('summary')?.textContent||''),details=new Map([...table.querySelectorAll('details')].map(item=>[detailKey(item),item.open])),scrolls=new Map([...table.querySelectorAll('.wb-scroll-list')].map(item=>[item.getAttribute('aria-label'),item.scrollTop])),active=document.activeElement,focus=table.contains(active)?{id:active.closest('[data-workbench-job]')?.dataset.workbenchJob,hook:[...active.attributes].find(attr=>attr.name.startsWith('data-'))?.name}:null;
    const actions=job=>`${job.interactive&&job.state==='RUNNING'?`<button class="button" data-gpu-shell="${escape(job.id)}">连接 GPU 终端</button>`:''}${heldDuringMaintenance(job,store.data?.operationalMaintenance)?'<span class="maintenance-held"><span class="maintenance-pause" aria-hidden="true"></span>维护期间暂不派发</span>':''}${jobNotificationHTML(job,actor)}${resultAccess.markup(job)}<button class="button quiet" data-job-logs="${escape(job.id)}">日志</button><button class="button quiet" data-job-detail="${escape(job.id)}" data-job-view="diagnostics">诊断</button><button class="button quiet" data-job-output="${escape(job.id)}">输出</button><button class="button quiet" data-job-detail="${escape(job.id)}" data-job-view="notes">留言</button><button class="button danger" data-job-cancel="${escape(job.id)}" ${endedJob(job)||job.cancelRequested?'disabled':''}>取消</button>`;
    const drafts=new Map([...table.querySelectorAll('[data-job-priority]')].map(input=>[input.dataset.jobPriority,{value:input.value,original:input.dataset.originalPriority}]));
    const html=workbenchCards(jobs,{actions,focusId:focusedJob,historyState,maintenance:store.data?.operationalMaintenance,ledger:quotaLedgerHTML(store,machine)});if(html===jobHTML){resultAccess.sync(jobs);return;}jobHTML=html;table.innerHTML=html;resultAccess.sync(jobs);
    for(const detail of table.querySelectorAll('details'))if(details.has(detailKey(detail)))detail.open=details.get(detailKey(detail));
    for(const list of table.querySelectorAll('.wb-scroll-list'))if(scrolls.has(list.getAttribute('aria-label')))list.scrollTop=scrolls.get(list.getAttribute('aria-label'));
    for(const input of table.querySelectorAll('[data-job-priority]')){const draft=drafts.get(input.dataset.jobPriority);if(draft&&draft.value!==draft.original){input.value=draft.value;input.dataset.originalPriority=draft.original;}}
    for(const job of jobs){const previous=lastJobs.get(job.id),row=[...table.querySelectorAll('[data-workbench-job]')].find(item=>item.dataset.workbenchJob===job.id);if(previous&&row&&previous.state!==job.state){row.animate([{outline:'1px solid var(--line-3)'},{outline:'1px solid transparent'}],{duration:reduced()?150:220});if(['RUNNING','STARTING','SUBMITTING'].includes(job.state))liveJobs.add(job.id);}if(previous&&row&&previous.percent!==trainingReadout(job).percent&&trainingReadout(job).percent!==null){row.querySelector('.wb-progress-number')?.animate(reduced()?[{opacity:.4},{opacity:1}]:[{opacity:.4,transform:`translateY(${trainingReadout(job).percent>(previous.percent??0)?3:-3}px)`},{opacity:1,transform:'none'}],{duration:reduced()?150:220});if(job.state==='RUNNING')liveJobs.add(job.id);}if(liveJobs.has(job.id)&&['st-run','st-start'].includes(stateClass(job)))row?.querySelector('.st')?.classList.add('is-live');}
    for(const job of jobs)if(lastJobs.get(job.id)?.state==='STARTING'&&job.state==='RUNNING')boundarySweep([...table.querySelectorAll('[data-workbench-job]')].find(row=>row.dataset.workbenchJob===job.id));
    lastJobs=new Map(jobs.map(job=>[job.id,{state:job.state,percent:trainingReadout(job).percent}]));
    if(focus?.id&&focus.hook)for(const button of table.querySelectorAll(`[${focus.hook}]`))if(button.closest('[data-workbench-job]')?.dataset.workbenchJob===focus.id){button.focus({preventScroll:true});break;}
  }
  async function showOutput(id,container){
    const job=ownJobs().find(item=>item.id===id);if(!job){container.textContent='任务状态未知，请刷新后重试。';return;}
    const files=query('#workspace-files');if(!outputPlace){outputPlace=document.createComment('workspace files');files.before(outputPlace);}container.append(files);files.open=true;
    try{await selectMachine(job.machine);const entries=directoryEntries(),entry=entries.find(row=>row.machine===job.machine&&row.info.project===job.project&&row.info.ownerId===(job.ownerId||job.userId));await selectProject(entry?projectDirectoryValue(entry,entries,machine):job.project);query('[name=file-area]').value='output';query('[name=file-path]').value='.';query('[name=file-run-id]').value=job.id;renderRuns();query('[name=file-run]').value=job.id;updateControls();await listFiles();}catch(error){query('#workspace-result').textContent=error.message;}
  }
  async function showNotes(id,container){
    if(notesJob===id&&notes){notes.sync(true,true);return;}notes?.reset();notes=null;notesJob=id;const generation=++notesGeneration,owner=actor;container.textContent='正在核对任务留言功能…';
    try{      notes=createTaskNotesUI(container,store,toast,{prefix:'drawer-',jobId:id});container.querySelector('#drawer-task-note-lifetime').value='task';notes.sync(true,true);
    }catch(error){if(generation===notesGeneration&&owner===actor)container.textContent='留言暂不可用：'+error.message;}
  }
  document.addEventListener('gpuq-job-drawer-close',()=>{stopFileRead();notesGeneration++;notes?.reset();notes=null;notesJob=null;const files=query('#workspace-files');if(outputPlace&&files){outputPlace.after(files);outputPlace.remove();outputPlace=null;}});
  function assertContext(){if(!enabled())throw Error('先在工作台顶部选择服务器。');return context();}
  function updateControls(){
    if(!section||!actor)return;
    const available=enabled(),locked=operationBusy||projectBusy,info=currentProject(),archived=info?.lifecycle?.state==='ARCHIVED';
    const active=executionActive()&&projectMachines().length>0,createTarget=creationMachine();
    for(const name of ['workspace-machine','workspace-project'])query(`[name=${name}]`).disabled=locked||(name==='workspace-project'&&!active);
    query('#project-network-check').disabled=!available||locked;
    query('#projects-refresh').disabled=!active||locked;query('#project-create-form [type=submit]').disabled=!active||!createTarget||locked||!validateProjectName()||!!maintenanceFor(store.data?.operationalMaintenance,createTarget);
    for(const field of query('#project-create-form').querySelectorAll('input,select'))field.disabled=!active||locked;
    query('[name=interactive]').disabled=locked;
    const command=query('[name=command]');command.disabled=interactiveTraining();command.required=!interactiveTraining();command.closest('label').hidden=interactiveTraining();
    for(const id of ['terminal-open','terminal-reconnect'])query('#'+id).disabled=!available||locked;
    const target=query('[name=training-target]');
    const automatic=automaticTraining();target.disabled=!available||locked;
    target.querySelector('[value=auto]').disabled=false;
    query('[name=training-candidates]').disabled=!automatic||locked;query('#training-candidates-field').hidden=!automatic;
    query('#training-target-note').textContent=automatic?'自动选择服务器；使用目标服务器上的项目或默认容器，不自动复制文件。':'在当前服务器自动分配显卡；不搬运项目或切换服务器。';
    const capacity=automatic?Math.max(1,...(store.data?.machines||[]).filter(m=>trainingHosts().some(h=>h.id===m.id)).map(m=>m.cards||1)):(store.data?.machines||[]).find(m=>m.id===machine)?.cards||1;
    query('[name=cards]').max=String(capacity);
    const custom=query('[name=custom-policy]'),customOn=custom.checked;
    custom.disabled=!available||locked;
    for(const name of ['queue-rank','yield-policy','restart-policy','checkpointable','request-mode'])query(`[name=${name}]`).disabled=!available||locked||!customOn;
    query('#custom-policy-note').textContent=customAvailable()?'等级与让位独立。只抢占严格低等级且明确允许让位的任务；保存失败或超时不会强制杀掉保存任务。':'服务器尚未确认训练控制通道，不能提交自定义策略；不会自动降级。';
    const elastic=query('[name=elastic]'),elasticOn=elastic.checked;
    elastic.disabled=!available||locked;
    for(const name of ['min-cards','global-batch','micro-batch','auto-expand'])query(`[name=${name}]`).disabled=!available||locked||!elasticOn;
    query('#elastic-note').textContent='卡数按 global batch 整除分配；最大卡数计入额度。自动扩卡使用 checkpoint 恢复。';
    const placementMode=query('[name=gpu-placement]'),shared=placementMode.value==='shared',hami=query('[name=hami]');
    placementMode.disabled=!available||locked;
    query('[name=gpu-indices]').disabled=!available||locked||placementMode.value==='any';
    for(const name of ['vram-mib','hami'])query(`[name=${name}]`).disabled=!available||locked||!shared;
    query('[name=sm-percent]').disabled=!available||locked||!shared||!hami.checked;
    query('#placement-note').textContent='指定 GPU 编号或共享显存预算；HAMi 只限制当前任务。';
    const priority=query('[name=priority]');priority.disabled=!available||locked||customOn;
    for(const option of priority.options){option.disabled=option.value!=='normal'&&!priorityAvailable();if(option.value==='normal')option.textContent=machine&&!priorityAvailable()?'默认（旧策略未确认）':'普通';}
    query('#priority-note').textContent=(!machine?'选择服务器后确认优先级能力。':!priorityAvailable()?'这台服务器尚未确认支持优先级控制。':'')+' '+(machine&&!priorityAvailable()&&priority.value==='normal'?'暂按服务器原有策略提交。':priorityDescription(priority.value));
    query('#priority-note').classList.toggle('priority-warning',priority.value==='idle'||priority.value!=='normal'&&!priorityAvailable());
    query('[name=task-description]').disabled=locked;
    query('#train-form [type=submit]').disabled=!available||locked||acceptedDraft;
    const output=query('[name=file-area]').value==='output';
    const deleteOutputs=query('#workspace-delete-outputs');deleteOutputs.hidden=!output||!deletableResultJob(store,outputSelectionJob());deleteOutputs.disabled=locked||!available;
    const resultCopy=query('#workspace-pull-command');resultCopy.hidden=!output||!resultJob();resultCopy.disabled=!resultFilePath||query('[name=file-path]').value!==resultFilePath||locked||!available;
    if(!output)query('#workspace-output-files').hidden=true;
    for(const id of ['workspace-list','workspace-download'])query('#'+id).disabled=!available||locked;
    query('#workspace-upload').textContent=project&&uploadRecovery?.scope===uploadScope()&&uploadRecovery.keys?.size?'续传原上传':'上传';
    query('#workspace-upload').disabled=!available||locked||output;query('[name=files]').disabled=!available||locked||output;
    query('#workspace-upload').hidden=!!output;query('[name=files]').hidden=!!output;
    query('[name=file-area]').disabled=locked;query('.output-run-fields').hidden=!output;
    query('#workspace-mode-note').textContent='工作区在 SSD，数据集在 HDD；容器内使用 /workspace、/datasets 和 /outputs。';
    query('#terminal-mode-note').textContent='容器终端没有 GPU；可管理 /workspace、/datasets，容器内 root 不接触系统盘。';
    if(maintenanceFor(store.data?.operationalMaintenance,machine)){
      for(const selector of ['#terminal-open','#terminal-reconnect','#train-form [type=submit]','#workspace-upload','[name=files]'])query(selector).disabled=true;
      query('#terminal-mode-note').textContent='维护中，暂停新建和重连。';
    }
    if(archived)for(const selector of ['#terminal-open','#terminal-reconnect','#train-form [type=submit]','#workspace-upload','[name=files]'])query(selector).disabled=true;
    projectManagement?.update();
  }
  function renderProject(){
    if(!section||!actor)return;
    const entries=directoryEntries(),selected=entries.find(item=>item.machine===machine&&item.info.project===project&&(!projectOwner||item.info.ownerId===projectOwner));
    const value=selected?projectDirectoryValue(selected,entries,machine):'';
    query('[name=workspace-project]').innerHTML=projectSelectHTML(entries.map(entry=>({...entry.info,machine:entry.machine,selectionValue:projectDirectoryValue(entry,entries,machine)})),value,projectManagement?.includeArchived(),projectEnvironmentLabel);
    query('[name=workspace-project]').value=value;
    const info=currentProject(),environment=query('#project-environment');environment.hidden=!info;environment.textContent=info?'OCI 容器':'';
    const location=query('#project-location');location.hidden=!machine;location.textContent=machine;location.title=machine;
    status(catalogError|| (info?'工作区就绪':directoryLoading?'正在读取项目…':'选择项目，或新建项目'),!!catalogError);
    query('#project-status-detail').textContent=projectStatusText(info);
    renderRuns();updateControls();updatePreflight();syncDiskQuota();document.dispatchEvent(new Event('gpuq-workspace-rendered'));
  }
  function renderRuns(){
    const select=query('[name=file-run]');if(!select)return;const previous=select.value,jobs=ownJobs().filter(job=>job.machine===machine&&(job.project||'')===project);
    select.innerHTML='<option value="">选择任务，或输入任务 ID</option>'+jobs.map(job=>`<option value="${escape(job.id)}">${escape(job.name)} · ${escape(job.id.slice(0,8))} · ${escape(job.state)}</option>`).join('');
    if(jobs.some(job=>job.id===previous))select.value=previous;
  }
  function clearFileContext(){stopFileRead();query('#project-network-result').hidden=true;query('#project-network-result').textContent='';query('[name=file-path]').value='.';query('[name=file-area]').value='code';query('[name=file-run-id]').value='';query('[name=file-run]').value='';query('[name=files]').value='';query('#workspace-result').textContent='选择目录或文件。';}
  function syncMachineFields(){for(const name of ['workspace-machine','machine','terminal-machine','file-machine']){const field=query(`[name=${name}]`),selected=name==='workspace-machine'?focusMachine:machine;field.value=selected;field.title=selected;}const selected=(store.data?.machines||[]).find(item=>item.id===machine);query('[name=cards]').max=String(selected?.cards||1);}
  async function selectMachine(value,{keepContainer=false}={}){
    if(value===focusMachine&&(!project||machine===value))return;
    focusMachine=projectMachines().some(item=>item.id===value)?value:'';
    if(keepContainer&&currentProject()?.environmentMode==='oci'){syncMachineFields();renderProject();notifyContext();return;}
    cancelProjectActivity();activateProjectActivity();machine=focusMachine;project='';projectOwner='';catalog=directory.get(machine)?.projects||[];catalogError='';epoch++;projectBusy=false;
    query('[name=environment-mode]').value='oci';

    query('[name=training-target]').value='current';query('[name=training-candidates]').value='';syncMachineFields();clearFileContext();renderProject();notifyContext();submitKey=crypto.randomUUID();if(machine)await explicitProjectRead(loadProjects);
  }
  async function selectProject(value){
    const entry=value?projectDirectorySelection(value,directoryEntries(),machine):null;
    if(value&&!entry){toast('请刷新项目列表后再选择。');return;}
    if(entry?.machine===machine&&entry?.info.project===project&&(entry?.info.ownerId||'')===projectOwner){activateProjectActivity();if(project)await explicitProjectRead(loadProjectStatus);return;}
    cancelProjectActivity();activateProjectActivity();machine=entry?.machine||focusMachine;project=entry?.info.project||'';projectOwner=entry?.info.ownerId||'';catalog=directory.get(machine)?.projects||[];
    if(entry&&entry.info.environmentMode!=='oci')focusMachine=machine;
    epoch++;projectBusy=false;catalogError='';query('[name=training-target]').value='current';syncMachineFields();clearFileContext();renderProject();notifyContext();submitKey=crypto.randomUUID();if(project)await explicitProjectRead(loadProjectStatus);
  }
  function ensureDirectory(){
    const owner=JSON.stringify([receiptActor(),projectMachines().map(item=>item.id)]);
    if(!executionActive()||!projectMachines().length||!isVisible()||!pageActive||directoryOwner===owner||projectBusy||operationBusy)return;
    directoryOwner=owner;projectPaused=false;directoryRead=loadDirectory();
  }
  async function loadDirectory(){
    if(!projectReadable()||!executionActive()||projectBusy||operationBusy)return;
    const token=currentToken(),machines=projectMachines();directoryLoading=true;projectBusy=true;updateControls();status('正在读取团队项目…');
    const results=await Promise.allSettled(machines.map(async selected=>({machine:selected.id,...projectDirectoryListing(await projectCall('projects.list',{machine:selected.id}))})));
    if(token!==currentToken())return;
    const failures=[];
    results.forEach((result,index)=>{if(result.status==='fulfilled')directory.set(result.value.machine,result.value);else{const id=machines[index].id;directory.set(id,{projects:directory.get(id)?.projects||[],environmentModes:[],error:result.reason.message});failures.push(id+'：'+result.reason.message);}});
    directoryError=failures.join('；');catalog=directory.get(machine)?.projects||[];catalogError=directory.get(machine)?.error||'';
    if(project&&!catalogError&&!catalog.some(item=>item.project===project&&(!projectOwner||item.ownerId===projectOwner))){project='';clearFileContext();notifyContext();}
    directoryLoading=false;projectBusy=false;renderProject();
  }
  async function loadProjects(){
    if(!projectReadable()||!enabled()||projectBusy||operationBusy)return;let token=currentToken();const selected=machine;projectBusy=true;updateControls();status('正在读取这台服务器的项目…');
    try{const result=await projectCall('projects.list',{machine:selected});if(token!==currentToken())return;
      const listing=projectDirectoryListing(result);catalog=listing.projects;directory.set(selected,listing);catalogError='';
      if(project&&!catalog.some(item=>item.project===project&&(!projectOwner||item.ownerId===projectOwner))){project='';epoch++;clearFileContext();notifyContext();token=currentToken();}
    }catch(error){if(token===currentToken()){catalogError=error.message;directory.set(selected,{projects:catalog,environmentModes:[],error:error.message});}}
    finally{if(token===currentToken()){projectBusy=false;renderProject();}}
  }
  async function readProjectStatus(target,token){
    if(!projectReadable()||token!==currentToken())return null;
    const result=await projectCall('projects.status',target);if(token!==currentToken())return null;
    catalog=catalog.map(item=>item.project===target.project&&(!target.ownerId||item.ownerId===target.ownerId)?{...item,...result}:item);rememberCatalog(target.machine);catalogError='';return result;
  }
  async function loadProjectStatus(){
    if(!projectReadable()||!project||!enabled()||projectBusy||operationBusy)return;const token=currentToken(),target=context();projectBusy=true;updateControls();
    try{await readProjectStatus(target,token);}
    catch(error){if(token===currentToken()){catalogError=error.message;}}
    finally{if(token===currentToken()){projectBusy=false;renderProject();}}
  }
  async function guarded(button,fn,scoped=false){if(operationBusy||scoped&&!activateProjectActivity())return;const owner=receiptActor(),turn=projectActivity.generation,current=()=>owner===receiptActor()&&(!scoped||turn===projectActivity.generation);operationBusy=true;if(scoped)projectOperation=true;button.disabled=true;updateControls();try{await fn();}catch(error){if(current()&&error.name!=='AbortError'){toast(error.message);status(error.message,error.code!=='MAINTENANCE_ACTIVE');}}finally{if(current()){operationBusy=false;if(scoped)projectOperation=false;if(button.isConnected)button.disabled=false;updateControls();renderReceipt();}}}
  function fileContext(){const target=assertContext();const area=query('[name=file-area]').value;if(area==='code')return {...target,area};const runId=query('[name=file-run-id]').value.trim();if(!uuidPattern.test(runId))throw Error('请选择本项目任务，或输入完整任务 ID。');const job=store.jobs.find(job=>job.id===runId);return {...target,...(job?{ownerId:job.ownerId||job.userId}:{}),area:'output',runId};}
  function resultJob(){const id=query('[name=file-run-id]')?.value,job=ownJobs().find(row=>row.id===id&&row.machine===machine&&row.project===project);return resultAccess.allowed(job)?job:null;}
  function outputSelectionJob(){const id=query('[name=file-run-id]')?.value;return ownJobs().find(row=>row.id===id&&row.machine===machine&&row.project===project);}
  function stopFileRead(){fileReadTurn++;fileReadController?.abort();fileReadController=null;resultFilePath=null;const tree=query('#workspace-output-files');if(tree){tree.hidden=true;tree.replaceChildren();}const copy=query('#workspace-pull-command');if(copy)copy.hidden=true;const result=query('#workspace-result');if(result)result.hidden=false;}
  async function listFiles(){
    stopFileRead();const target=fileContext(),path=query('[name=file-path]').value||'.',token=currentToken(),turn=fileReadTurn,controller=new AbortController();fileReadController=controller;
    const result=await store.call('files.list',{...target,path},{signal:controller.signal});
    if(controller.signal.aborted||turn!==fileReadTurn||token!==currentToken()||target.area==='output'&&query('[name=file-run-id]').value!==target.runId)return;
    if(target.area==='output'&&(resultJob()||deletableResultJob(store,outputSelectionJob()))){query('#workspace-output-files').innerHTML=resultFilesHTML(result.entries,path,{deletable:deletableResultJob(store,outputSelectionJob())});query('#workspace-output-files').hidden=false;query('#workspace-result').textContent='';query('#workspace-result').hidden=true;query('#workspace-pull-command').hidden=!resultJob();query('#workspace-pull-command').disabled=true;}
    else query('#workspace-result').textContent=result.entries.map(file=>`${file.type==='directory'?'[目录]':'[文件]'} ${file.name}  ${file.type==='file'?file.size+' B':''}`).join('\n')||'目录为空';
  }
  document.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button||button.disabled)return;
    if(button.dataset.jobFocus){focusedJob=button.dataset.jobFocus;renderJobs(ownJobs());document.dispatchEvent(new CustomEvent('gpuq-focused-job',{detail:{id:focusedJob}}));return;}
    if(button.id==='clear-training-prefill'){parsedTarget=null;acceptedDraft=false;updateControls();updatePreflight();return;}
    if(button.id==='submission-new-draft'||button.hasAttribute('data-receipt-new-draft')){acceptedDraft=false;query('#train-panel').open=true;updateControls();updatePreflight();return;}
    if((button.id==='submission-retry'||button.hasAttribute('data-receipt-retry'))&&submitReceipt?.status==='unknown'&&submitReceipt.actor===receiptActor()){const args=structuredClone(submitReceipt.args);guarded(button,()=>submitRequest(args));return;}
    if((button.id==='submission-refresh'||button.hasAttribute('data-receipt-refresh'))&&submitReceipt?.actor===receiptActor()){const receipt=submitReceipt;guarded(button,async()=>{await store.refresh();if(receipt.actor!==receiptActor()||submitReceipt!==receipt)return;const job=store.jobs.find(job=>job.userId===store.principal.userId&&job.key===receipt.args.key);if(job&&trainingReceiptMatches(job,receipt.args,store.principal.userId,store.data?.machines||[])){submitReceipt={...receipt,status:'confirmed',job,error:''};acceptedDraft=true;submitKey=crypto.randomUUID();}refresh();renderReceipt();});return;}
    if(button.id==='open-submit'){if(!submissionMode(false))return;submitSelection.invalidate();if(submitDialog)query('#train-panel').open=true;return;}
    if(button.id==='submit-maintenance-switch'){const target=query('#submit-maintenance-machine')?.value;if(target&&(store.data?.machines||[]).some(item=>item.id===target)&&!maintenanceFor(store.data?.operationalMaintenance,target))guarded(button,async()=>{await selectMachine(target);updatePreflight();toast('已按你的选择换机。请检查项目和训练参数后提交。');});return;}
    if(button.id==='close-submit'){submitSelection.invalidate();dismissSheet(submitDialog);return;}
    if(button.id==='close-submit-panel'){dismissSheet(settingsDialog,{drilldown:true});closeSettings();updatePreflight();return;}
    if(button.id==='submit-check-refresh'){document.querySelector('#refresh-state').click();if(project)loadProjectStatus();updatePreflight();return;}
    if(button.id==='copy-submit-command'){navigator.clipboard.writeText(query('#submit-command').textContent).then(()=>toast('完整命令已复制。'),()=>toast('复制失败；请选中命令手动复制。'));return;}
    if(button.dataset.jobDetail){focusedJob=button.dataset.jobDetail;document.dispatchEvent(new CustomEvent('gpuq-focused-job',{detail:{id:focusedJob}}));guarded(button,()=>diagnostics.openLogs(focusedJob,button.dataset.jobView||'overview',jobHeading(focusedJob)));return;}
    if(button.dataset.jobLogs){focusedJob=button.dataset.jobLogs;guarded(button,()=>diagnostics.openLogs(focusedJob,'logs',jobHeading(focusedJob)));}
    if(button.dataset.jobNotify)guarded(button,async()=>{
      const job=store.jobs.find(item=>item.id===button.dataset.jobNotify);
      if(!job)throw Error('任务暂不可用，请刷新。');
      const enabled=job.notifications?.enabled!==true;
      await call('notifications.job',{jobId:job.id,enabled});refresh();toast(enabled?'Telegram 任务通知已开启。':'Telegram 任务通知已关闭。');
    });
    if(button.dataset.jobCancel)guarded(button,async()=>{await call('jobs.cancel',{jobId:button.dataset.jobCancel});refresh();toast('已请求取消；等待服务器确认停止。');});
    if(button.dataset.jobPrioritySave)guarded(button,async()=>{
      const jobId=button.dataset.jobPrioritySave,job=store.jobs.find(item=>item.id===jobId),control=button.closest('[data-priority-editor]')?.querySelector('select');
      if(!job||!canEditPriority(job,true)||!control)throw Error('任务已不在可调整的队列状态，请刷新后核对。');
      const priority=priorityRankValue(control.value);if(priority===job.priority){toast('优先级未改变。');return;}
      await call('jobs.priority',{jobId,priority});control.dataset.originalPriority=priority;refresh();toast('已请求调整优先级；等待服务器更新状态。');
    });
    if(button.id==='close-job-log')dismissSheet(log,{drilldown:true,target:jobHeading(focusedJob)});
    if(button.id==='projects-refresh'){activateProjectActivity();loadDirectory();}
    if(button.id==='project-network-check')guarded(button,async()=>{const target=context(),token=currentToken(),result=await call('projects.status',{...target,diagnoseNetwork:true});if(token!==currentToken())return;query('#project-network-result').hidden=false;query('#project-network-result').textContent=result.network?JSON.stringify(result.network,null,2):'网络状态未知，请稍后重试。';});
    if(button.id==='workspace-list')guarded(button,listFiles);
    if(button.id==='workspace-upload')guarded(button,async()=>{
      const target=fileContext(),token=currentToken(),dir=query('[name=file-path]').value||'.',files=[...query('[name=files]').files];if(target.area==='output')throw Error('任务输出只支持查看和下载。');if(!files.length)throw Error('先选择文件。');
      query('#workspace-result').textContent='正在上传…';
      const keys=uploadRecovery?.scope===uploadScope()?uploadRecovery.keys||new Map():new Map();uploadRecovery={scope:uploadScope(),supported:true,keys};
      for(const file of files){const path=dir==='.'?file.name:dir+'/'+file.name,progress=(offset,total,info)=>{if(info?.key)keys.set(path,info.key);if(token===currentToken())query('#workspace-result').textContent=`${info?.resumed?'接着上传':'正在上传'} ${file.name}：${offset} / ${total??file.size} B`;};
          try{await projectActivity.run(signal=>uploadProjectFile(file,{...target,path},(operation,args)=>store.call(operation,{...(projectOwner&&args?.project===project?{ownerId:projectOwner}:{}),...args},{signal}),progress,{signal,key:keys.get(path),current:()=>token===currentToken(),onRecoverySupport:supported=>{if(token===currentToken()){uploadRecovery={scope:uploadScope(),supported,keys};updateControls();}}}));}
          catch(error){if(token===currentToken())query('#workspace-result').textContent=error.message;throw error;}
      }
      if(token!==currentToken())return;
      keys.clear();query('#workspace-result').textContent=`已上传 ${files.length} 个文件，可直接运行。`;renderProject();toast('文件上传完成。');
    },true);
    if(button.hasAttribute('data-result-delete')||button.id==='workspace-delete-outputs'){
      const job=outputSelectionJob();if(!deletableResultJob(store,job))return;
      const token=currentToken(),jobId=job.id,path=button.id==='workspace-delete-outputs'?'.':button.dataset.resultDelete,recursive=button.id==='workspace-delete-outputs'||button.dataset.deleteRecursive==='true';
      guarded(button,async()=>{try{const result=await deleteJobOutputs(store,job,{path,recursive,current:()=>token===currentToken()&&outputSelectionJob()?.id===jobId&&deletableResultJob(store,outputSelectionJob())});if(!result)return;if(result.state!=='TRASHED'){if(token===currentToken()){query('#workspace-result').hidden=false;query('#workspace-result').textContent='结果未知，请按原编号查询：'+result.key;}return;}if(token===currentToken()){await listFiles();toast(`已删除，7 天内可在项目回收站恢复`);}}catch(error){if(token===currentToken()){query('#workspace-result').hidden=false;query('#workspace-result').textContent=error.message;}throw error;}});return;
    }
    if(button.dataset.resultPath){
      if(!resultJob()&&!deletableResultJob(store,outputSelectionJob()))return;
      query('[name=file-path]').value=button.dataset.resultPath;
      if(button.dataset.resultType==='directory')guarded(button,listFiles);
      else{resultFilePath=button.dataset.resultPath;if(resultJob()){query('#workspace-pull-command').disabled=false;query('#workspace-pull-command').title=resultPullCommand(resultJob(),resultFilePath);}}
      return;
    }
    if(button.id==='workspace-pull-command'){const job=resultJob();if(!job||!resultFilePath||query('[name=file-path]').value!==resultFilePath)return;navigator.clipboard.writeText(resultPullCommand(job,resultFilePath)).then(()=>toast('CLI 命令已复制。'),()=>toast('复制失败。'));return;}
    if(button.id==='workspace-download')guarded(button,async()=>{
      const target=fileContext(),path=query('[name=file-path]').value,token=currentToken(),turn=fileReadTurn;if(!path)throw Error('请填写工作区或输出内的相对路径。');
      query('#workspace-result').hidden=false;
      await downloadBrowserPath((op,args)=>call(op,args),target,path,{directory:path==='.',onProgress:row=>{if(token===currentToken()&&turn===fileReadTurn)query('#workspace-result').textContent=`正在下载 ${row.path}：${row.offset} / ${row.size} B`;}});

    });
    if(button.dataset.jobPull)guarded(button,async()=>{const job=ownJobs().find(row=>row.id===button.dataset.jobPull);if(!job||!resultAccess.allowed(job))throw Error('任务暂未出现在列表，请刷新后重试。');await diagnostics.openLogs(job.id,'output');});
    if(button.dataset.jobOutput)guarded(button,()=>diagnostics.openLogs(button.dataset.jobOutput,'output'));
  });
  document.addEventListener('change',event=>{if(section?.contains(event.target)&&['files','file-path'].includes(event.target.name)){uploadRecovery=null;updateControls();}});
  document.addEventListener('submit',event=>{
    if(event.target.id==='project-create-form'){event.preventDefault();const slug=query('[name=new-project]').value;guarded(event.target.querySelector('[type=submit]'),async()=>{
      const selected=creationMachine(),token=currentToken();if(!selected)throw Error('请选择服务器。');if(!validProject(slug))throw Error('项目名需小写字母开头，使用字母、数字、下划线或短横线，最多 48 位。');
      const environmentMode='oci',repo=query('[name=new-project-repo]').value.trim();
      query('#project-create-error').hidden=true;
      let result;try{result=await store.call('projects.create',{machine:selected,project:slug,ownerId:actor,environmentMode,...(repo?{repo}:{})});if(token!==currentToken())return;}catch(error){if(token===currentToken()){query('#project-create-error').hidden=false;query('#project-create-error').textContent=error.message;}throw error;}
      machine=selected;projectOwner=result.ownerId||actor;catalog=[...(directory.get(selected)?.projects||[]).filter(item=>item.project!==slug||item.ownerId&&item.ownerId!==projectOwner),{...result,ownerId:projectOwner}];rememberCatalog(selected);project=slug;epoch++;query('[name=training-target]').value='current';syncMachineFields();clearFileContext();catalogError='';renderProject();notifyContext();query('[name=new-project]').value='';query('#project-create').open=false;submitKey=crypto.randomUUID();toast('项目已创建。');
    },true);return;}
    if(event.target.id!=='train-form')return;event.preventDefault();const form=new FormData(event.target);
    guarded(event.target.querySelector('[type=submit]'),async()=>{if(acceptedDraft)throw Error('此配置已提交，请先选择再次使用配置。');const target=assertContext();
      const customOn=query('[name=custom-policy]').checked;
      const scheduling=customOn?schedulingFromForm(form,managementAllowed()):null;
      const elastic=elasticFromForm(form,Number(form.get('cards')),scheduling);
      if(customOn&&!scheduling)throw Error('请刷新状态自定义调度选项。');
      const priority=customOn?'normal':trainingPriority(form.get('priority'),managementAllowed());
      const placement=placementFromForm(form,Number(form.get('cards')),elastic,scheduling,priority);
      const selection=trainingTarget(form.get('training-target'),target.machine,currentProject(),form.get('training-candidates'),store.data?.machines||[]);
      if(selection.machine==='auto'&&placement)throw Error('跨服务器选机请使用自动分卡；固定卡号或共享请使用当前服务器。');
      const interactive=form.get('interactive')==='on';
      await submitRequest({...selection,cards:Number(form.get('cards')),minVramGiB:Number(form.get('memory')),name:form.get('name')||'train',description:taskDescription(form.get('task-description')||''),...(scheduling?{scheduling}:priorityAvailable()?{priority}:{}),...(elastic?{elastic}:{}),...(placement?{placement}:{}),...(interactive?{interactive:true}:{}),argv:interactive?['/bin/bash','--noprofile','--norc','-i']:['/bin/bash','-c',String(form.get('command'))],key:submitKey,...(project?trainingProject(currentProject()):{})});
    });
  });
  document.addEventListener('change',event=>{
    if(!event.target.closest('#execution-workspace,#work-submit,#work-submit-panel,#shell-context,.job-log-dialog'))return;const name=event.target.name;
    if(event.target.closest('#train-form,#work-submit-panel'))acceptedDraft=false;
    if(['workspace-machine','machine','terminal-machine','file-machine'].includes(name)){
      const keepContainer=name==='workspace-machine'&&currentProject()?.environmentMode==='oci';
      selectMachine(event.target.value,{keepContainer});
    }
    if(name==='workspace-project')selectProject(event.target.value);
        if(['priority','interactive'].includes(name)){submitKey=crypto.randomUUID();updateControls();}
    if(['training-target','training-candidates','gpu-placement'].includes(name)){submitSelection.invalidate();parsedTarget=null;submitKey=crypto.randomUUID();updateControls();}
    if(['custom-policy','queue-rank','yield-policy','restart-policy','checkpointable','request-mode','elastic','auto-expand'].includes(name)){submitKey=crypto.randomUUID();updateControls();}
    if(name==='file-area'){stopFileRead();query('[name=file-path]').value='.';query('[name=file-run-id]').value='';query('[name=file-run]').value='';query('#workspace-result').textContent='已切换文件区域。';updateControls();}
    if(name==='file-run'){stopFileRead();query('[name=file-run-id]').value=event.target.value;updateControls();}
    updatePreflight();
  });
  document.addEventListener('input',event=>{if(['file-path','file-run-id'].includes(event.target.name)){stopFileRead();updateControls();return;}if(event.target.name==='new-project'){query('#project-create-error').hidden=true;updateControls();return;}if(!event.target.closest('#train-form,#work-submit-panel'))return;submitSelection.invalidate();acceptedDraft=false;submitKey=crypto.randomUUID();const selected=query('[name=machine]').value;if(selected!==machine)selectMachine(selected);if(['sm-percent','training-candidates'].includes(event.target.name))updateControls();updatePreflight();});
  document.addEventListener('gpuq-open-submit',async event=>{
    if(!submitDialog||!actor)return;
    flushClosedProjectDialogs();
    const detail=event.detail||{},selected=detail.machine||machine,ref=detail.datasetRef||'',origin=detail.origin,config=detail.trainingConfig;
    if(!submissionMode(detail.adminConsole===true&&document.body.dataset.room==='admin'&&store.principal?.role==='admin'))return;
    const pending=selected!==machine?selectMachine(selected):Promise.resolve();
    const intent=submitSelection.begin(selected,ref,submitIdentity()),valid=()=>submitSelection.current(intent,machine,submitIdentity())&&enabled();
    try{
      await pending;if(!valid())return;
      if(config){
        const target=(store.data?.machines||[]).find(row=>row.id===machine);
        if(!Number.isSafeInteger(config.cards)||config.cards<1||config.cards>target?.cards||typeof config.command!=='string'||!config.command.trim())throw Error('训练配置待确认，请重新预填。');

      }
      if(config){query('[name=training-target]').value='current';query('[name=training-candidates]').value='';query('[name=cards]').value=String(config.cards);query('[name=command]').value=config.command;parsedTarget={machine,project};acceptedDraft=false;submitKey=crypto.randomUUID();updateControls();}
      query('#train-panel').open=true;updatePreflight();
      if(origin)requestAnimationFrame(()=>{if(valid()&&submitDialog?.open)sharedObject(origin,query('#training-data-field'));});
      if(machine)loadProjectStatus();
    }catch(error){if(valid())toast(error.message);}
  });
  document.addEventListener('gpuq-open-job',event=>{if(!log||!store.principal)return;const {id,view,origin}=event.detail||{};if(!store.jobs.some(job=>job.id===id)){toast('任务暂未出现在当前账号的状态中，请刷新核对。');return;}focusedJob=id;diagnostics.openLogs(id,view||'overview',origin).catch(error=>toast(error.message));});
  document.addEventListener('gpuq-show-job-history',event=>{
    if(!store.principal||event.detail?.userId!==store.principal.userId||event.detail.state!=='FAILED')return;
    historyState='FAILED';renderJobs(ownJobs());
    const history=query('#my-job-table .wb-ended');if(history){history.open=true;requestAnimationFrame(()=>history.scrollIntoView({block:'start'}));}
  });
  document.addEventListener('change',event=>{
    if(!event.target.matches('#my-job-table [data-job-history-filter]'))return;
    historyState=event.target.value==='FAILED'?'FAILED':'';renderJobs(ownJobs());query('#my-job-table .wb-ended')?.setAttribute('open','');
  });
  store.onAuthChange?.(()=>{stopFileRead();cancelProjectActivity();directory.clear();directoryOwner='';submitReceipt=null;parsedTarget=null;acceptedDraft=false;query('#submission-receipt')?.replaceChildren();});
  const workRoom=document.querySelector('[data-page=work]');
  let wasVisible=isVisible();
  function visibilityChanged(){
    const visible=pageActive&&isVisible();
    if(!visible){wasVisible=false;if(!projectPaused)cancelProjectActivity();return;}
    if(wasVisible)return;wasVisible=true;projectPaused=false;ensureDirectory();
  }
  document.addEventListener('visibilitychange',visibilityChanged);
  document.addEventListener('gpuq-route-leaving',()=>{flushClosedProjectDialogs();wasVisible=false;cancelProjectActivity();});
  window.addEventListener('pagehide',()=>{pageActive=false;wasVisible=false;cancelProjectActivity();});
  window.addEventListener('pageshow',()=>{pageActive=true;visibilityChanged();});
  // A periodic render must not resume a context that was explicitly closed.
  const projectDialogs='#work-submit,#work-submit-panel,#job-mission,.job-log-dialog,.terminal-dialog,#mission-control';
  function projectDialogClosed(dialog){if(!dialog.isConnected||closedProjectDialogs.has(dialog))return;closedProjectDialogs.add(dialog);cancelProjectActivity();}
  function processProjectDialogChanges(records){for(const {target} of records){if(!target.isConnected||!target.matches?.(projectDialogs))continue;if(target.open)closedProjectDialogs.delete(target);else projectDialogClosed(target);}}
  function flushClosedProjectDialogs(){if(projectDialogObserver)processProjectDialogChanges(projectDialogObserver.takeRecords());}
  document.addEventListener('cancel',event=>{if(event.target.matches?.(projectDialogs))projectDialogClosed(event.target);},true);
  document.addEventListener('close',event=>{if(!event.target.open&&event.target.matches?.(projectDialogs))projectDialogClosed(event.target);},true);
  // The native close event is queued; invalidate requests as soon as the
  // dialog closes, including closures performed by another UI module.
  projectDialogObserver=new MutationObserver(processProjectDialogChanges);projectDialogObserver.observe(document.body,{subtree:true,attributes:true,attributeFilter:['open']});
  if(workRoom)new MutationObserver(visibilityChanged).observe(workRoom,{attributes:true,attributeFilter:['hidden']});
  const render=()=>{
    if(!section){section=document.createElement('section');section.id='execution-workspace';section.className='execution-workspace';document.querySelector('#execution-host').append(section);log=document.createElement('dialog');log.className='job-log-dialog';log.setAttribute('aria-labelledby','job-log-title');log.innerHTML='<div class="modal-head"><h2 id="job-log-title">训练日志 · 最近 200 行</h2><button class="button" id="close-job-log">关闭</button></div><pre></pre>';document.body.append(log);diagnostics.install();}
    diagnostics.sync();mission.sync();renderReceipt();section.hidden=!store.principal;if(section.hidden){diagnostics.reset();submitDialog?.close();settingsDialog?.close();submitReceipt=null;parsedTarget=null;acceptedDraft=false;actor=null;machine='';project='';catalog=[];catalogError='';epoch++;section.innerHTML='';notifyContext();return;}
    if(actor!==store.principal.userId){
      diagnostics.reset();
      submitDialog?.close();submitDialog?.remove();settingsDialog?.close();settingsDialog?.remove();submitDialog=null;settingsDialog=null;settingsSource=null;jobHTML='';lastJobs.clear();liveJobs.clear();focusedJob=null;historyState='';deepLinkHandled=false;
      submitReceipt=null;parsedTarget=null;acceptedDraft=false;managementSubmit=false;actor=store.principal.userId;machine='';focusMachine='';project='';catalog=[];directory.clear();directoryOwner='';directoryError='';catalogError='';epoch++;machineIdentity='';submitKey=crypto.randomUUID();operationBusy=false;projectBusy=false;
      section.innerHTML=`<section class="workspace-context" aria-labelledby="workspace-context-title"><div class="workspace-context-heading"><div><div class="eyebrow">WORKSPACE</div><h2 id="workspace-context-title">选择服务器与项目</h2><span id="project-environment" class="project-environment" hidden></span></div><div class="file-actions"><button class="button" id="projects-refresh">刷新项目</button><button class="button quiet" id="project-network-check">网络诊断</button></div></div><div class="workspace-context-grid"><label>服务器<select name="workspace-machine" aria-describedby="workspace-mode-note"></select></label><label>项目<select name="workspace-project"><option value="">选择项目</option></select></label></div><p id="workspace-mode-note" class="muted"></p><p id="project-status" class="workspace-status" role="status" aria-live="polite"></p><pre id="project-network-result" class="file-result" hidden></pre><details id="project-create"><summary>新建项目</summary><form id="project-create-form"><label>项目名称<input name="new-project" pattern="[a-z][a-z0-9_-]{0,47}" maxlength="48" required placeholder="例如 vision-baseline" aria-describedby="project-name-error" spellcheck="false" autocomplete="off"><span id="project-name-error" class="form-error project-name-error" hidden></span></label><label>Git 仓库（可选）<input name="new-project-repo" type="text" placeholder="https://github.com/team/project.git" autocomplete="off"><small>创建时克隆到 /workspace；Git 凭据请在容器里配置。</small></label><fieldset class="project-environment-choice"><legend>个人容器</legend><select name="environment-mode" hidden aria-hidden="true" tabindex="-1"><option value="oci">个人容器</option></select></fieldset><button type="submit" class="button">创建项目</button><p id="project-create-error" class="form-error" role="alert" hidden></p></form></details></section>
      <section class="personal-terminal" aria-labelledby="personal-terminal-title"><div class="terminal-heading"><h3 id="personal-terminal-title">个人开发终端</h3><span class="terminal-scope">日常开发 · 不占 GPU</span></div><p id="terminal-mode-note" class="muted"></p><div class="terminal-controls"><select name="terminal-machine" hidden aria-label="终端服务器"></select><button id="terminal-open" class="button primary">新建开发终端</button><button id="terminal-reconnect" class="button">重连开发会话</button></div></section>
      <details class="execution-panel" id="workspace-files"><summary>项目材料与训练结果 · 上传 / 下载</summary><select name="file-machine" hidden aria-label="文件服务器"></select><div class="file-location-grid"><label>文件区域<select name="file-area"><option value="code">工作区</option><option value="output">任务输出</option></select></label><label>目录或文件的相对路径<input name="file-path" value="." spellcheck="false"></label></div><div class="output-run-fields"><label>本项目任务<select name="file-run"></select></label><label>完整任务 ID<input name="file-run-id" spellcheck="false" placeholder="选择上面的任务或输入完整 UUID"></label></div><div class="file-actions"><button class="button" id="workspace-list">列目录</button><button class="button" id="workspace-download">下载文件</button><input type="file" name="files" multiple aria-label="选择上传文件"><button class="button" id="workspace-upload">上传</button></div><div id="workspace-output-files" class="job-result-files" hidden></div><button class="button danger" id="workspace-delete-outputs" type="button" hidden>删除全部输出</button><button class="button quiet" id="workspace-pull-command" type="button" hidden disabled>复制 CLI 命令</button><pre id="workspace-result" class="file-result" aria-live="polite">选择目录或文件。</pre></details>
      <details class="execution-panel"><summary>提交训练</summary><form id="train-form">
        <select name="machine" hidden aria-label="训练服务器"></select>
        <label>训练位置<select name="training-target"><option value="current">当前服务器 · 自动分卡</option><option value="auto">自动选择</option></select></label>
        <p id="training-target-note" class="muted"></p><label id="training-candidates-field" hidden>候选服务器（可选）<input name="training-candidates" placeholder="留空使用全部授权机器；多个完整名称以逗号分隔" spellcheck="false"><small>自编 CUDA 扩展不一定兼容其他显卡型号；不确定时只填写已验证的服务器。</small></label>
        <div class="train-grid"><label>卡数<input name="cards" type="number" min="1" max="1" value="1" required></label><label>每卡显存下限（GiB）<input name="memory" type="number" min="0" max="128" value="0" step="0.5"></label><label>任务名称<input name="name" maxlength="64" value="train" required></label></div>
        <label>任务描述 ${infoHTML('同一服务器获授权的成员可以看到描述。请勿填写口令或令牌。','描述可见范围')}<textarea name="task-description" rows="3" maxlength="2000" placeholder="例如：验证新数据集上的 baseline，预计运行约两小时。不要填写密码或令牌。"></textarea></label>
        <div class="priority-choice"><label>任务优先级<select name="priority" aria-describedby="priority-note">${priorityOptions()}</select></label><p id="priority-note" class="priority-note"></p></div>
        <label><input type="checkbox" name="interactive">GPU 交互终端（申请一次卡，连续运行多个命令）</label>
        <label>训练命令<textarea name="command" rows="3" required spellcheck="false">python train.py</textarea></label>
        <p class="muted">代码、环境、HOME 和输出持续保留；目录自行组织。断开 GPU 终端不释放卡，退出 shell 或取消任务才释放。</p>
        <div id="training-data-field">训练直接读取共享 HDD <code>/datasets</code>（只读）；终端可在该目录整理数据。</div>
        <div class="training-advanced">${schedulingFields()}${elasticFields()}${placementFields()}</div><button type="submit" class="button primary">提交训练</button>
      </form></details>
      <div class="section-kicker"><span>团队训练任务</span><span id="my-job-count"></span></div><p class="muted">排队、运行及待核对任务均占用个人额度；取消确认后释放。</p><div id="my-job-table"></div>`;
      adaptWorkspace();
      projectManagement=createProjectManagement({getContext:()=>({owner:actor,ownerId:projectOwner,isAdmin:store.principal?.role==='admin',machine,project,info:currentProject(),token:currentToken(),enabled:enabled(),locked:operationBusy||projectBusy,maintenance:!!maintenanceFor(store.data?.operationalMaintenance,machine)}),call:projectCall,run:(button,fn)=>guarded(button,fn,true),refresh:async options=>{if(options?.retired&&options.retired.machine===machine&&options.retired.project===project){catalog=catalog.filter(x=>x.project!==project||projectOwner&&x.ownerId!==projectOwner);rememberCatalog();project='';epoch++;clearFileContext();renderProject();notifyContext();return;}if(options?.presentationOnly){renderProject();return;}if(options?.restored){const token=currentToken(),listing=projectDirectoryListing(await projectCall('projects.list',{machine}));if(token!==currentToken())return;directory.set(machine,listing);catalog=listing.projects;renderProject();return;}const token=currentToken();await readProjectStatus(context(),token);if(token===currentToken())renderProject();},select:async(server,id,ownerId)=>{await selectMachine(server);const entries=directoryEntries(),entry=entries.find(row=>row.machine===server&&row.info.project===id&&(!ownerId||row.info.ownerId===ownerId));await selectProject(entry?projectDirectoryValue(entry,entries,machine):id);}});
      query('.workspace-context').append(projectManagement.element);notifyContext();
    }
    const machines=store.data?.machines||[],next=JSON.stringify(machines);
    if(machineIdentity!==next){machineIdentity=next;const options='<option value="">请选择服务器</option>'+machines.map(item=>`<option value="${escape(item.id)}">${escape(item.id)}</option>`).join('');for(const name of ['workspace-machine','machine','terminal-machine','file-machine'])query(`[name=${name}]`).innerHTML=options;if(!machines.some(item=>item.id===machine)){machine='';project='';projectOwner='';catalog=[];epoch++;clearFileContext();notifyContext();}syncMachineFields();}
    ensureDirectory();
    const jobs=ownJobs();renderJobs(jobs);query('#my-job-count').textContent=jobs.filter(job=>!terminal.has(job.state)).length+' 项进行中';renderProject();
    if(!deepLinkHandled){deepLinkHandled=true;const id=new URL(location.href).searchParams.get('job');if(id&&store.jobs.some(job=>job.id===id))diagnostics.openLogs(id,'overview');}
  };
  render.openProject=async detail=>{
    const binding=receiptActor(),token=currentToken(),matches=()=>detail.userId===store.principal?.userId&&detail.authGeneration===store.authGeneration&&binding===receiptActor();
    if(!matches()||!validProject(detail.project)||!projectMachines().some(row=>row.id===detail.machine))return;
    if(directoryRead)await directoryRead;
    if(!matches()||token!==currentToken()||!pageActive||!isVisible())return;
    if(projectBusy||operationBusy){toast('当前项目正在处理中，请稍后。');return;}
    const entries=directoryEntries(),entry=entries.find(row=>row.machine===detail.machine&&row.info.project===detail.project&&(!detail.ownerId||row.info.ownerId===detail.ownerId)&&row.info.environmentMode==='oci');
    if(!entry){toast('项目暂不可用，请刷新。');return;}
    await selectProject(projectDirectoryValue(entry,entries,machine));
    if(matches()&&detail.view==='trash'&&machine===detail.machine&&project===detail.project){const trash=projectManagement.element.querySelector('.project-trash');if(trash){projectManagement.element.open=true;trash.open=true;trash.scrollIntoView({block:'nearest'});}else toast('回收站暂不可用');}
  };
  return render;
}

export function canEditPriority(job,admin=false){return job.source!=='native'&&['PENDING','QUEUED'].includes(job.state)&&!job.cancelRequested&&['idle','P1','normal','P3','high'].includes(job.priority);}
// The catalog's native submitter is the OS owner, not display_metadata.submitter.
// This label is presentation only; it never identifies a platform account.
export function nativeOwnerLabel(job){
  const owner=job?.source==='native'?job.submitter?.username:null;
  return typeof owner==='string'&&owner?`原生用户 ${owner}`:null;
}
export function taskIdentityHTML(job){
  const nativeOwner=nativeOwnerLabel(job),name=nativeOwner||job.submitter?.name||job.submitterName||job.username||'未知提交者',username=nativeOwner?null:job.submitter?.username||job.username;
  return `<strong>${escape(job.name)}</strong><small>${escape(name)}${username&&username!==name?'（'+escape(username)+'）':''} · ${escape(job.id)}</small>
    <p class="task-description">${escape(job.description||'未填写描述')}</p>${job.source==='native'?'<small>未关联平台提交记录</small>':''}`;
}
export function taskTable(jobs,{admin=false,userId}={}){return `<div class="live-table-wrap task-table-wrap"><table class="live-table task-table"><caption class="sr-only">训练任务、优先级与最近调度结果</caption><thead><tr><th>任务 / 用户</th><th>机器 / 卡数</th><th>状态</th><th>优先级 / 调度</th><th>操作</th></tr></thead><tbody>${[...jobs].reverse().map(job=>`<tr><td data-label="任务 / 用户">${taskIdentityHTML(job)}${job.project?`<small>${escape(job.project)}</small>`:''}</td><td data-label="机器 / 卡数">${escape(job.machine)}${allocationSummary(job)}${placementSummary(job)}</td><td data-label="状态"><span class="task-state">${escape(taskStateLabel(job))}</span><small>${escape(job.state)}${job.cancelRequested&&!terminal.has(job.state)?' · 正在取消':''}</small>${job.preempted?'<small>已写入的输出保留，不自动恢复。</small>':''}${job.error?`<small class="task-error">${escape(job.error)}</small>`:''}${jobProgressHTML(job)}</td><td data-label="优先级 / 调度"><span class="priority-pill priority-${Object.hasOwn(priorities,job.priority)?job.priority:'unknown'}">${escape(priorityRankLabel(job))}</span>${schedulingSummary(job)}${Number.isInteger(job.schedulerPriority)?`<small>节点优先级：P${escape(job.schedulerPriority)}</small>`:''}<small>${escape(schedulingContractLabel(job.schedulerPolicy??{yield_policy:job.yieldPolicy,restart_policy:job.restartPolicy}))}</small><small>状态：${escape(job.schedulerState||'未提供')}</small><small class="queue-reason">${escape(job.queueReason||'暂无调度说明。')}</small><small class="scheduler-time">更新于 ${escape(sampleTime(job.schedulerCheckedAt))}</small>${canEditPriority(job,admin)?`<div class="priority-editor" data-priority-editor><label><span class="sr-only">${escape(job.name)} 的排队优先级</span><select data-job-priority="${escape(job.id)}" data-original-priority="${escape(job.priority)}">${priorityRankOptions(job.priority)}</select></label><button class="button" data-job-priority-save="${escape(job.id)}">保存优先级</button><small>仅改排队顺序，不改变让位和重启方式。</small></div>`:''}</td><td data-label="操作"><div class="task-actions">${job.source==='native'?'<span class="muted">只读</span>':`${jobNotificationHTML(job,userId)}<button class="button" data-job-logs="${escape(job.id)}">日志</button>${job.project?`<button class="button" data-job-output="${escape(job.id)}">输出</button>`:''}<button class="button danger" data-job-cancel="${escape(job.id)}" ${terminal.has(job.state)||job.cancelRequested?'disabled':''}>取消</button>`}</div></td></tr>`).join('')||'<tr><td colspan="5" class="task-empty">暂无任务。先选择服务器，准备代码，再提交训练。</td></tr>'}</tbody></table></div>`;}
export function renderTaskTable(container,jobs,options={}){
  const drafts=new Map([...container.querySelectorAll('[data-job-priority]')].filter(input=>input.value!==input.dataset.originalPriority).map(input=>[input.dataset.jobPriority,{value:input.value,original:input.dataset.originalPriority}]));
  const active=container.ownerDocument.activeElement,focus=active?.dataset?.jobPriority?['jobPriority',active.dataset.jobPriority]:active?.dataset?.jobPrioritySave?['jobPrioritySave',active.dataset.jobPrioritySave]:null;
  const scroll=container.querySelector('.task-table-wrap'),top=scroll?.scrollTop||0,left=scroll?.scrollLeft||0;
  container.innerHTML=taskTable(jobs,options);
  for(const input of container.querySelectorAll('[data-job-priority]'))if(drafts.has(input.dataset.jobPriority)){const draft=drafts.get(input.dataset.jobPriority);input.value=draft.value;input.dataset.originalPriority=draft.original;}
  if(focus)for(const input of container.querySelectorAll('[data-job-priority],[data-job-priority-save]'))if(input.dataset[focus[0]]===focus[1])input.focus({preventScroll:true});
  const next=container.querySelector('.task-table-wrap');if(next){next.scrollTop=top;next.scrollLeft=left;}
}
