import {progressPercent,progressText,jobTiming} from './job-progress.js';
import {formatTimestamp} from './time-format.js';
import {maintenanceActive} from './maintenance-state.js';
import {captureObject,sharedObject,reducedMotion} from './motion-ui.js';

export const escapeUI=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export function serverIdHTML(value,className=''){
  const id=String(value??''),characters=[...id],split=characters.length>8?characters.length-4:characters.length;
  return `<span class="server-id ${className}" title="${escapeUI(id)}"><span class="server-id-head">${escapeUI(characters.slice(0,split).join(''))}</span><span class="server-id-tail">${escapeUI(characters.slice(split).join(''))}</span></span>`;
}
export function serverSelectLabel(select){
  if(!select)return;
  let wrapper=select.closest('.server-select');
  if(!wrapper){wrapper=document.createElement('span');wrapper.className='server-select';select.before(wrapper);wrapper.append(select);const label=document.createElement('span');label.className='server-select-label';label.setAttribute('aria-hidden','true');wrapper.append(label);}
  select.title=select.value;wrapper.querySelector('.server-select-label').innerHTML=serverIdHTML(select.value||select.selectedOptions[0]?.textContent||'');
}
export function containerContextPrompt({environmentMode,trainingTarget,source='',focus=''}={}){
  if(environmentMode!=='oci')return {label:'服务器',empty:'请选择服务器',title:focus,ariaLabel:'切换所选服务器'};
  const ariaLabel='切换服务器焦点，个人容器开发位置保持不变';
  if(!focus&&trainingTarget==='auto')return {label:'训练',empty:'自动选择',title:'自动选择兼容服务器',ariaLabel};
  if(!focus&&trainingTarget==='current'&&source)return {label:'训练',empty:'开发位置',title:source,ariaLabel};
  return {label:'服务器',empty:'可选服务器',title:focus,ariaLabel};
}
export function jobCancelConfirmation(job){
  const cards=job?.state==='PREPARING_DATA'?0:job?.cards;
  return Number.isSafeInteger(cards)&&cards>=0?`取消这个训练任务？确认停止后释放 ${cards} 张卡的额度，已保存的文件保留。`:'取消这个训练任务？占用额度尚未确认，停止后由服务器确认释放；已保存的文件保留。';
}
const infoMark='<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="6.25"/><path d="M8 7v4M8 4.5v.1"/></svg>';
export function infoHTML(text,label='说明'){
  return `<details class="ui-info"><summary aria-label="${escapeUI(label)}">${infoMark}</summary><div class="ui-info-content" role="note">${escapeUI(text)}</div></details>`;
}
// Keep the original node and its aria-describedby ID when moving copy offscreen.
export function discloseInfo(element,label='说明'){
  if(!element||element.closest('.ui-info'))return;
  const help=document.createElement('details'),summary=document.createElement('summary');help.className='ui-info';summary.innerHTML=infoMark;summary.setAttribute('aria-label',label);element.before(help);help.append(summary,element);element.classList.add('ui-info-content');element.hidden=false;
}
export const projectEnvironments={shared:'共享',isolated:'隔离',oci:'个人容器'};
export function projectEnvironmentLabel(mode){return mode===undefined?'共享':typeof mode==='string'&&Object.hasOwn(projectEnvironments,mode)?projectEnvironments[mode]:'环境未确认';}
export function confirmProjectCreation(result,{project,environmentMode}){
  if(!result||result.project!==project)throw Error('项目返回身份不匹配，请重新查询。');
  if(!Object.hasOwn(projectEnvironments,environmentMode)||!(result.environmentMode===environmentMode||environmentMode==='shared'&&result.environmentMode===undefined))throw Error('服务器未确认所选环境，请重新查询。');
  return result;
}
const publicationKey=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const projectName=/^[a-z][a-z0-9_-]{0,47}$/,releaseHash=/^[a-f0-9]{64}$/;
const publicationPrefix='stargate.project-publication.v1:';
// These records contain only a non-secret intent. The account is part of the
// storage namespace, never an API argument or an authority claim.
export function projectPublicationStorage(storage){
  const name=(account,machine,project)=>publicationPrefix+JSON.stringify([account,machine,project]);
  const valid=value=>value&&typeof value.machine==='string'&&value.machine&&value.machine!=='auto'&&typeof value.project==='string'&&projectName.test(value.project)&&typeof value.key==='string'&&publicationKey.test(value.key)&&Number.isSafeInteger(value.startedAt)&&value.startedAt>=0;
  const read=(account,machine,project)=>{
    try{const value=JSON.parse(storage.getItem(name(account,machine,project)));return valid(value)&&value.machine===machine&&value.project===project?value:null;}catch{return null;}
  };
  return {
    read,
    save(account,value){
      if(typeof account!=='string'||!account||!valid(value))throw Error('发布请求无效，未发送。');
      const record={machine:value.machine,project:value.project,key:value.key,startedAt:value.startedAt};
      try{storage.setItem(name(account,record.machine,record.project),JSON.stringify(record));}catch{throw Error('无法保存发布请求，未发送。请允许本地存储后重试。');}
      return record;
    },
    list(account){
      const records=[];
      try{for(let i=0;i<storage.length;i++){const key=storage.key(i);if(!key?.startsWith(publicationPrefix))continue;let identity;try{identity=JSON.parse(key.slice(publicationPrefix.length));}catch{continue;}if(Array.isArray(identity)&&identity.length===3&&identity[0]===account){const value=read(...identity);if(value)records.push(value);}}}catch{}
      return records.sort((a,b)=>b.startedAt-a.startedAt);
    },
    clear(account,record){if(read(account,record.machine,record.project)?.key===record.key)storage.removeItem(name(account,record.machine,record.project));}
  };
}
export function projectPublicationOutcome(info,record){
  const receipt=info?.publication;
  if(!record||!receipt||receipt.id!==record.key)return {state:'UNKNOWN'};
  if(receipt.state==='READY'&&typeof receipt.release==='string'&&releaseHash.test(receipt.release)&&Array.isArray(info.releases)&&info.releases.some(item=>item?.state==='READY'&&item.release===receipt.release))return {state:'READY',release:receipt.release};
  if(receipt.state==='PUBLISHING')return {state:'PUBLISHING'};
  if(receipt.state==='FAILED')return {state:'FAILED',error:info.error?String(info.error):'生成训练版本失败',errorDetails:info.errorDetails};
  return {state:'UNKNOWN'};
}
export const projectPublicationDelay=attempt=>[2000,5000,10000][Math.min(2,Math.max(0,attempt))];
// A context owns its requests as well as its next polling timer. Cancelling
// bounds even a promise whose underlying operation cannot undo a sent write.
export function createProjectActivity(){
  let controller=new AbortController(),generation=0;
  return {
    get generation(){return generation;},
    cancel(){generation++;controller.abort();controller=new AbortController();},
    async run(action){
      const signal=controller.signal,turn=generation;let onAbort;
      const cancelled=new Promise((_,reject)=>{onAbort=()=>reject(signal.reason);signal.addEventListener('abort',onAbort,{once:true});});
      try{const result=await Promise.race([action(signal),cancelled]);signal.throwIfAborted();if(turn!==generation)throw new DOMException('项目上下文已改变','AbortError');return result;}
      finally{signal.removeEventListener('abort',onAbort);}
    }
  };
}
export function projectPublicationProgressHTML(progress){
  const phases=[['scanning','扫描'],['copying','复制'],['verifying','校验'],['publishing','写入版本']],active=phases.findIndex(([phase])=>phase===progress?.phase);
  if(active<0)return '';
  const counts=Number.isSafeInteger(progress.completedEntries)&&progress.completedEntries>=0?`${progress.completedEntries}${Number.isSafeInteger(progress.totalEntries)&&progress.totalEntries>=0?' / '+progress.totalEntries:''} 项`:'';
  return `<ol class="wb-trajectory publication-trajectory" aria-label="训练版本生成阶段">${phases.map(([phase,label],index)=>`<li class="${index<active?'done':index===active?'active':''}" ${index===active?'aria-current="step"':''}><span class="d" aria-hidden="true"></span>${label}</li>`).join('')}</ol>${counts?`<span class="publication-count mono">${counts}</span>`:''}`;
}
export function confirmPublicationMotion(element){element?.animate([{opacity:.45},{opacity:1}],{duration:reducedMotion()?150:480,easing:'cubic-bezier(.2,0,0,1)'});}
if(typeof document!=='undefined'){
  let infoFrame;
  function placeInfo(help){
    const popup=help.querySelector(':scope>.ui-info-content');if(!popup||!help.open||!help.getClientRects().length)return;
    popup.style.translate='none';
    const anchor=(help.querySelector(':scope>summary')||help).getBoundingClientRect(),margin=16,gap=8;
    const previousBox=popup.getBoundingClientRect(),contentHeight=Math.max(previousBox.height,popup.scrollHeight+previousBox.height-popup.clientHeight);
    const below=Math.max(0,innerHeight-margin-anchor.bottom-gap),above=Math.max(0,anchor.top-margin-gap);
    const opensBelow=contentHeight<=below||below>=above;
    popup.style.maxHeight=Math.max(0,Math.min(innerHeight-margin*2,opensBelow?below:above))+'px';
    const box=popup.getBoundingClientRect();
    const left=Math.max(margin,Math.min(innerWidth-margin-box.width,box.left));
    const preferredTop=opensBelow?anchor.bottom+gap:anchor.top-box.height-gap;
    const top=Math.max(margin,Math.min(innerHeight-margin-box.height,preferredTop));
    popup.style.translate=(left-box.left)+'px '+(top-box.top)+'px';
  }
  function placeOpenInfo(){
    cancelAnimationFrame(infoFrame);
    infoFrame=requestAnimationFrame(()=>{for(const help of document.querySelectorAll('.ui-info[open]'))placeInfo(help);});
  }
  document.addEventListener('click',event=>{
    for(const help of document.querySelectorAll('.ui-info[open]'))if(!help.contains(event.target))help.open=false;
  },{capture:true});
  document.addEventListener('toggle',event=>{if(event.target.matches?.('.ui-info'))placeOpenInfo();},{capture:true});
  document.addEventListener('scroll',placeOpenInfo,{capture:true,passive:true});
  globalThis.addEventListener?.('resize',placeOpenInfo);
  document.fonts?.ready.then(placeOpenInfo);
}
export const endedJob=job=>['SUCCEEDED','FAILED','CANCELED'].includes(job.state);
export function stateClass(job){
  if(job.cancelRequested&&!endedJob(job))return 'st-cancel';
  return {RUNNING:'st-run',STARTING:'st-start',PENDING:'st-queue',QUEUED:'st-queue',PREPARING_DATA:'st-prep',SUBMITTING:'st-start',FAILED:'st-err',UNKNOWN:'st-unk',SUCCEEDED:'st-done',CANCELED:'st-stop',PREEMPTING:'st-cancel',PREEMPTED:'st-stop'}[job.state]||'st-unk';
}
export function stateWord(job){
  if(job.cancelRequested&&!endedJob(job))return '正在取消';
  if(job.state==='SUBMITTING'&&job.submissionState==='NOT_DISPATCHED')return '未派发';
  if(job.state==='CANCELED'&&job.preempted===true)return '让位结束';
  return {RUNNING:'运行中',STARTING:'启动中',PENDING:'排队中',QUEUED:'排队中',PREPARING_DATA:'准备数据',SUBMITTING:'提交中',FAILED:'失败',UNKNOWN:'状态待核对',SUCCEEDED:'已完成',CANCELED:'已取消',PREEMPTING:'正在让位',PREEMPTED:'让位结束'}[job.state]||'状态未知';
}
export function stateHTML(job,word=true){return `<span class="st ${stateClass(job)}"><span class="g" aria-hidden="true"></span>${word?escapeUI(stateWord(job)):''}</span>`;}
export function projectPreparationReadout(job){
  if(job.state!=='PREPARING_DATA'||!job.projectPreparation)return null;
  const preparation=job.projectPreparation,copying=['WAITING','PREPARING'].includes(preparation.state);
  return {copying,label:copying?'复制项目':preparation.state==='READY'?'准备数据':preparation.state==='FAILED'?'项目复制失败':'项目准备待确认',
    message:copying?'复制项目到':preparation.state==='READY'?'项目已就绪':preparation.state==='FAILED'?'项目复制失败':'项目准备待确认',
    from:typeof preparation.from==='string'?preparation.from:'',operationId:typeof preparation.operationId==='string'?preparation.operationId:''};
}
function automaticSelectionHTML(job,separator=true){return job.machineSelection?.mode==='auto'?'<span class="mono">自动选机</span>'+(separator?' · ':''):'';}
function projectPreparationHTML(job){
  const preparation=projectPreparationReadout(job);if(!preparation)return '';
  const details=[preparation.from&&'开发位置：'+preparation.from,preparation.operationId&&'复制操作：'+preparation.operationId].filter(Boolean).join('。');
  return `<div class="job-project-preparation" data-project-preparation><span>${preparation.message}</span>${preparation.copying?serverIdHTML(job.machine||'服务器未确认'):''}<span>未占显卡</span>${details?infoHTML(details,'项目复制详情'):''}</div>`;
}
function requestedCards(job){return (job.state==='PREPARING_DATA'?'请求 ':'')+(Number.isSafeInteger(job.cards)?job.cards+' 张':'卡数待更新');}
export function trainingReadout(job){
  const p=job.progress,s=p?.snapshot,percent=progressPercent(p),fresh=job.state!=='PREPARING_DATA'&&p?.reported===true&&!!s&&!p.stale&&!p.error;
  let eta='';
  if(fresh&&Number.isFinite(s.etaSeconds)&&s.etaSeconds>=0){
    if(Number.isFinite(s.updatedAt)&&s.updatedAt>0){const date=new Date((s.updatedAt+s.etaSeconds)*1000);if(Number.isFinite(date.getTime()))eta='约 '+date.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false})+' · 训练上报';}
    else eta='剩余约 '+Math.ceil(s.etaSeconds/60)+' 分钟 · 训练上报';
  }
  const rank=key=>({loss:0,val_acc:1,lr:2})[key]??3;
  const metrics=fresh?Object.entries(s.metrics||{}).filter(([key,value])=>Number.isFinite(value)&&!/^epochs?$/i.test(key)).sort(([a],[b])=>rank(a)-rank(b)).slice(0,3):[];
  const description=p?.stale?'进度停滞（训练上报超时）'+(s?.epochsTotal?` · 上次轮次 ${s.epochsCompleted}/${s.epochsTotal}`:'')+(s?.message?' · '+s.message:''):progressText(p);
  return {fresh,percent:fresh?percent:null,eta,epoch:fresh&&s.epochsTotal?`第 ${s.epochsCompleted} / ${s.epochsTotal} 轮`:'',metrics,description,phase:fresh?s.phase||'':'',updatedAt:fresh?s.updatedAt:null,completionPending:fresh&&percent>=100&&!endedJob(job)};
}
function shortTime(value){
  return formatTimestamp(value,{clock:true,format:{hour:'2-digit',minute:'2-digit',hour12:false}});
}
export function trajectoryHTML(job){
  const stages=[['提交','submit'],...(job.datasets?.length||job.state==='PREPARING_DATA'?[['准备数据','prepare']]:[]),['排队','queue'],['启动','start'],['运行','run'],['结束','end']];
  const key=endedJob(job)?'end':({PREPARING_DATA:'prepare',PENDING:'queue',QUEUED:'queue',STARTING:'start',RUNNING:'run',SUBMITTING:'submit'})[job.state];
  const current=stages.findIndex(([,value])=>value===key),times={submit:job.createdAt,run:job.latestAttempt?.startedAt,end:job.latestAttempt?.finishedAt};
  return `<ol class="tl wb-trajectory" aria-label="任务轨迹">${stages.map(([label,value],index)=>`<li class="${index===current?'now':current>=0&&index<current?'done':''}"><span class="d" aria-hidden="true"></span><span class="n">${label}</span>${shortTime(times[value])!=='—'?`<time class="t">${escapeUI(shortTime(times[value]))}</time>`:'<span class="t">—</span>'}</li>`).join('')}</ol>`;
}
export function jobFacts(job){
  const indices=job.assignedIndices?.length?'GPU '+job.assignedIndices.join(' · '):Number.isSafeInteger(job.cards)?job.cards+' 张':'卡数未确认';
  const allocation=job.state==='PREPARING_DATA'?requestedCards(job):job.elastic?`弹性 ${job.elastic.minCards}–${job.cards} 张 · 当前 ${Number.isSafeInteger(job.actualCards)?job.actualCards:job.assignedIndices?.length||'未确认'} 张`:indices;
  const placement=job.placement,placementText=placement?`${placement.shared?'共享':'固定'} GPU ${placement.gpuIndices.join(',')}${placement.shared?' · 预算 '+placement.vramMiB+' MiB':''}${placement.hami?' · HAMi SM '+placement.smPercent+'%':''}`:'';
  return [job.machineSelection?.mode==='auto'?'自动选机':'',job.machine||'服务器未确认',projectPreparationReadout(job)?.copying?'复制项目到 '+(job.machine||'服务器未确认'):'',allocation,placementText,job.state==='PREPARING_DATA'?'不占 GPU 额度':job.queueReason||job.latestAttempt?.failureReason||job.error||job.description||'暂无调度说明',job.latestAttempt?.exitCode!==null&&job.latestAttempt?.exitCode!==undefined?'退出码：'+job.latestAttempt.exitCode:'',job.schedulerState||job.state].filter(Boolean).join(' · ');
}
export function parseTrainingCommand(text,machines=[]){
  const value=String(text??'').trim();
  const match=value.match(/^(\S+)\s+([1-9]\d*|[一二两三四五六七八九十]+)\s*张(?:显卡|卡)?\s+(?:跑|运行)\s+(.+)\s+用\s+([A-Za-z0-9][A-Za-z0-9_-]{0,63}(?:@[a-f0-9]{64})?)\s*$/u);
  if(!match||!/^(?:[1-9]\d*|[一二两三四五六七八九]|[一二两三四五六七八九]?十[一二三四五六七八九]?)$/.test(match[2]))return null;
  const [,machine,count,command,reference]=match,digits={'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};
  const cards=/^\d+$/.test(count)?Number(count):count.includes('十')?(count.split('十')[0]?digits[count.split('十')[0]]:1)*10+(count.split('十')[1]?digits[count.split('十')[1]]:0):digits[count];
  const target=machines.find(row=>row.id===machine),[dataset,version]=reference.split('@');
  if(!target||!Number.isSafeInteger(cards)||cards<1||!Number.isSafeInteger(target.cards)||cards>target.cards||!command.trim()||/[\u0000-\u001f\u007f]/.test(command))return null;
  return {machine,cards,command:command.trim(),dataset,...(version?{version}:{})};
}
export function personalQuotaReadout(user,usage,limit=user?.total){
  const number=value=>Number.isSafeInteger(value)&&value>=0?String(value):'—';
  // STARGATE 功能与接口手册（2026-10-07）：启用管理员的 shared/独占/AUTO 免个人累计额度。
  // An explicit backend flag overrides the documented role fallback; it never enables a disabled account.
  const exempt=user?.enabled===true&&(typeof user.personalCardQuotaExempt==='boolean'?user.personalCardQuotaExempt:user.role==='admin');
  return {exempt,label:exempt?'不限个人额度':'占用额度 / 上限',value:exempt?number(usage):`${number(usage)} / ${number(limit)}`,note:''};
}
export function quotaLedgerHTML(store,machine=''){
  const user=store.users.find(row=>row.id===store.principal?.userId);if(!user)return '';
  const jobs=store.jobs.filter(job=>job.userId===user.id&&!endedJob(job)&&job.state!=='PREPARING_DATA'&&(!machine||job.machine===machine));
  const groups=[{label:'运行 / 启动 / 待确认',rows:jobs.filter(job=>!['PENDING','QUEUED'].includes(job.state)||job.cancelRequested)},{label:'排队占用',rows:jobs.filter(job=>['PENDING','QUEUED'].includes(job.state)&&!job.cancelRequested)}].filter(group=>group.rows.length);
  const number=value=>Number.isSafeInteger(value)&&value>=0?value:'—';
  const usage=store.usage(user.id,machine||undefined),limit=machine?user.limits?.[machine]:user.total,total=store.usage(user.id);
  const readout=personalQuotaReadout(user,usage,limit),totalReadout=personalQuotaReadout(user,total);
  if(readout.exempt)groups.forEach(group=>{if(group.label==='排队占用')group.label='排队请求';});
  return `<section class="wb-ledger" id="quota-ledger" aria-labelledby="quota-ledger-title"><div class="wb-ledger-head"><h2 id="quota-ledger-title">${readout.exempt?'不限个人额度':'我的额度'}</h2>${infoHTML(readout.exempt?'管理员免个人累计卡数额度。这里统计运行、启动、待确认和排队请求，不代表实际占卡；资源不足正常排队，不自动抢停他人任务。':'占用数来自任务记录，排队也计入。准备数据暂不占额度；服务器确认结束后才释放。',readout.exempt?'用卡请求来源':'额度来源')}${machine?serverIdHTML(machine,'mono'):'<span class="mono">全部服务器</span>'}<strong>${readout.exempt?'<small>已占用 </small>':''}${readout.value} <small>张</small></strong></div>${readout.exempt?'<div class="wb-ledger-total">不限个人额度 · 资源不足正常排队</div>':''}${machine?`<div class="wb-ledger-total">合计 ${totalReadout.value} 张</div>`:''}<div class="wb-ledger-groups">${groups.map(group=>`<details><summary><span>${group.label}</span><strong>${group.rows.every(job=>Number.isSafeInteger(job.cards)&&job.cards>=0)?group.rows.reduce((sum,job)=>sum+job.cards,0):'—'} <small>张</small></strong></summary><ul>${group.rows.map(job=>`<li><button class="button quiet" type="button" data-job-detail="${escapeUI(job.id)}">${escapeUI(job.name||'训练')}</button><span class="mono">${number(job.cards)} 张</span></li>`).join('')}</ul></details>`).join('')||'<span class="muted">'+(readout.exempt?'没有进行中的用卡请求':'没有占用额度')+'</span>'}</div></section>`;
}
export function boundarySweep(element){
  const line=element?.querySelector('.r5-boundary-line');if(!line)return;
  for(const animation of line.getAnimations())animation.cancel();
  line.animate(reducedMotion()?[{opacity:.65},{opacity:0}]:[{transform:'scaleX(0)',opacity:1},{transform:'scaleX(1)',opacity:1,offset:.8},{transform:'scaleX(1)',opacity:0}],{duration:reducedMotion()?150:320,easing:'cubic-bezier(.2,0,0,1)'});
}
export function workbenchCards(jobs,{actions=()=>'',focusId,maintenance,ledger='',historyState=''}={}){
  const active=jobs.filter(job=>!endedJob(job));
  const focal=active.find(job=>job.id===focusId)||active.find(job=>job.state==='RUNNING'&&!job.cancelRequested)||active.find(job=>job.state==='UNKNOWN')||active[0]||(historyState?null:jobs.at(-1));
  const completed=jobs.filter(job=>endedJob(job)&&job.id!==focal?.id&&(!historyState||job.state===historyState));
  const heading=(job,compact=false)=>`<div class="job-top"><div class="wb-job-heading">${stateHTML(job)}<button type="button" class="wb-job-name" title="${escapeUI(job.name||'训练')}" data-job-detail="${escapeUI(job.id)}">${escapeUI(job.name||'训练')}</button>${compact?`<span class="wb-job-quick">${escapeUI(requestedCards(job))}</span>`:''}</div><span class="mono wb-job-id" title="${escapeUI(job.id)}">${escapeUI(String(job.id).slice(0,8))}</span></div>`;
  const compact=job=>`<article class="job compact-job" data-workbench-job="${escapeUI(job.id)}">${heading(job,true)}${job.machineSelection?.mode==='auto'?`<div class="subline">${automaticSelectionHTML(job)}${serverIdHTML(job.machine||'服务器未确认')}</div>`:''}${projectPreparationHTML(job)}${job.error?`<p class="form-error">${escapeUI(job.error)}</p>`:''}<div class="job-acts"><button class="button quiet" type="button" data-job-focus="${escapeUI(job.id)}">聚焦</button>${actions(job)}${infoHTML(jobFacts(job),'任务事实')}</div></article>`;
  let hero='';
  if(focal){
    const running=focal.state==='RUNNING'&&!focal.cancelRequested,readout=trainingReadout(focal),prep=focal.dataPreparation?.datasets;
    const prepFact=Array.isArray(prep)&&prep.length?`${prep.filter(row=>row.state==='READY').length} / ${prep.length} 项已就绪`:'';
    const label=focal.state==='UNKNOWN'?'需要处理':endedJob(focal)?'最近一次训练':'当前训练';
    const phase=running?`<div class="wb-progress-hero"><div><div class="wb-report-label"><span class="label">训练上报</span>${infoHTML('进度来自训练上报。任务结束和额度释放以服务器确认的状态为准。','进度来源')}</div><div class="wb-progress-number ${readout.fresh?'':'unknown'}">${readout.percent===null?'—':readout.percent+'%'}</div></div><div class="wb-progress-meta">${readout.epoch?`<span>${escapeUI(readout.epoch)}</span>`:''}${readout.updatedAt?`<span class="mono">更新于 ${escapeUI(shortTime(readout.updatedAt))}</span>`:''}${readout.eta?`<span class="mono">${escapeUI(readout.eta)}</span>`:''}${readout.completionPending?'<span class="wb-completion-pending">完成待确认</span>':''}${!readout.fresh?`<span>进度未更新 ${infoHTML(readout.description,'进度状态')}</span>`:''}</div></div>`:`<div class="wb-stage-hero"><strong>${escapeUI(focal.cancelRequested&&!endedJob(focal)?'正在取消':({PENDING:'等待显卡',QUEUED:'等待显卡',PREPARING_DATA:projectPreparationReadout(focal)?.label||'准备数据',STARTING:'启动中',SUBMITTING:'提交中',UNKNOWN:'状态待核对',FAILED:'训练失败',SUCCEEDED:'已完成',CANCELED:'已取消'})[focal.state]||stateWord(focal))}</strong>${prepFact&&focal.state==='PREPARING_DATA'?`<span class="mono">${escapeUI(prepFact)}</span>`:''}${focal.queueReason&&!focal.error?infoHTML(focal.queueReason,'等待原因'):''}</div>`;
    hero=`<article class="job hero-frame wb-focal ${running?'':'wb-focus-state'}" data-workbench-job="${escapeUI(focal.id)}"><span class="r5-boundary-line" aria-hidden="true"></span><span class="hero-label">${label}</span>${heading(focal)}<div class="subline">${automaticSelectionHTML(focal)}${serverIdHTML(focal.machine||'服务器待更新')} · ${escapeUI(requestedCards(focal))}${infoHTML(jobFacts(focal),'任务事实')}</div>${phase}${projectPreparationHTML(focal)}${focal.error?`<p class="form-error">${escapeUI(focal.error)}</p>`:''}${running&&readout.percent!==null?`<progress class="wb-progress-line" max="100" value="${readout.percent}" aria-label="${escapeUI(focal.name)} 的训练上报进度"></progress>`:''}${trajectoryHTML(focal)}${running&&readout.metrics.length?`<div class="wb-metrics">${readout.metrics.map(([key,value])=>`<div><span class="label">${escapeUI(key)}</span><strong class="mono">${escapeUI(Number(value).toPrecision(5))}</strong></div>`).join('')}</div>`:''}<div class="job-acts"><button class="button quiet" type="button" data-job-mission="${escapeUI(focal.id)}">全屏查看</button>${actions(focal)}</div></article>`;
  }
  const others=active.filter(job=>job.id!==focal?.id).sort((a,b)=>Number(['FAILED','UNKNOWN'].includes(b.state))-Number(['FAILED','UNKNOWN'].includes(a.state)));
  const list=(rows,label)=>`<div class="wb-scroll-list" tabindex="0" role="region" aria-label="${label}">${rows.map(compact).join('')}</div>`;
  const history=completed.length||historyState?`<details class="wb-ended" ${historyState?'open':''}><summary>已结束的训练 · ${completed.length} 项</summary><label class="wb-history-filter">状态<select data-job-history-filter aria-label="已结束训练状态"><option value="">全部</option><option value="FAILED" ${historyState==='FAILED'?'selected':''}>失败</option></select></label>${completed.length?list([...completed].reverse(),'已结束的训练'):'<p class="muted">没有失败的训练。</p>'}</details>`:'';
  return hero+ledger+(others.length?`<div class="wb-list-title"><h2>其他进行中的训练</h2><span class="mono">${others.length} 项</span></div>`+list(others,'其他进行中的训练'):'')+history+(!jobs.length&&maintenanceActive(maintenance)?'<section class="wb-empty hero-frame"><span class="hero-label">我的训练任务</span><h2>暂无训练任务</h2></section>':!jobs.length?'<section class="wb-empty hero-frame"><span class="hero-label">开始一次训练</span><h2>准备好下一次实验</h2><p>准备代码，开始训练。</p></section>':'');
}

export function jobOverviewHTML(job,{owned=true,schedulingHTML=''}={}){
  const readout=trainingReadout(job);
  const command=Array.isArray(job.command)?job.command:job.argv;
  return `<section class="job-overview"><div class="job-overview-fact">${stateHTML(job)}${automaticSelectionHTML(job)}${serverIdHTML(job.machine||'服务器未确认')}<span>${Number.isSafeInteger(job.cards)?job.cards+' 张':'卡数未确认'}</span></div><p>${escapeUI(job.description||'未填写描述')}</p>${projectPreparationHTML(job)}<dl class="job-overview-grid"><div><dt>完整任务 ID</dt><dd><code>${escapeUI(job.id)}</code><button class="button quiet" type="button" data-copy-job="${escapeUI(job.id)}">复制 ID</button></dd></div>${job.project?`<div><dt>项目 / 训练版本</dt><dd>${escapeUI(job.project)}<code>${escapeUI(job.release||'版本未提供')}</code></dd></div>`:''}<div><dt>调度说明</dt><dd>${escapeUI(job.queueReason||'暂无调度说明')}</dd></div><div><dt>更新于</dt><dd>${escapeUI(shortTime(job.schedulerCheckedAt||job.checkedAt)||'未提供')}</dd></div></dl>${jobTimingHTML(job)}${trajectoryHTML(job)}${infoHTML(readout.description.replaceAll('自报','训练上报'),'训练进度说明')}${owned&&command?.length?`<details class="job-command"><summary>训练命令</summary><pre>${escapeUI(command.join(' '))}</pre></details>`:''}${schedulingHTML?`<details class="job-command"><summary>卡数与调度策略</summary><div class="job-scheduling-facts">${schedulingHTML}</div></details>`:''}${job.latestAttempt?`<details class="job-command"><summary>最近运行记录</summary><dl><dt>运行 ID</dt><dd>${escapeUI(job.latestAttempt.id||'未记录')}</dd><dt>退出码</dt><dd>${escapeUI(job.latestAttempt.exitCode??'未记录')}</dd><dt>原因</dt><dd>${escapeUI(job.latestAttempt.failureReason||'未记录')}</dd></dl></details>`:''}<h3>主日志</h3><pre id="job-log-preview">正在读取主日志…</pre></section>`;
}

export function jobTimingHTML(job){
  if(!endedJob(job))return '';
  const timing=jobTiming(job),display=value=>value?`<time datetime="${escapeUI(value)}">${escapeUI(formatTimestamp(value))}</time>`:'未确认';
  return `<dl class="job-overview-grid"><div><dt>节点运行结束</dt><dd>${display(timing.workerFinishedAt)}</dd></div><div><dt>门户确认终态</dt><dd>${display(timing.terminalObservedAt)}</dd></div></dl>`;
}

export function elapsedTraining(job,now=Date.now()/1000){
  const start=job.latestAttempt?.startedAt,end=endedJob(job)?job.latestAttempt?.finishedAt:now;
  if(!Number.isFinite(start)||start<=0||!Number.isFinite(end)||end<start||!endedJob(job)&&job.state!=='RUNNING')return null;
  const seconds=Math.floor(end-start),hours=Math.floor(seconds/3600),minutes=Math.floor(seconds/60)%60;
  return (hours?hours+':':'')+String(minutes).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');
}
export function missionGPUs(job,snapshot,machines=[]){
  const host=snapshot?.hosts?.find(row=>row.id===job.machine),machine=machines.find(row=>row.id===job.machine);
  if(job.state==='PREPARING_DATA'||!machine||!Array.isArray(job.assignedIndices)||!job.assignedIndices.length)return [];
  const ids=[...new Set(job.assignedIndices)].filter(index=>Number.isSafeInteger(index)&&index>=0&&index<machine.cards);
  const samples=new Map(),duplicates=new Set();for(const gpu of host?.gpus||[]){if(samples.has(gpu.index))duplicates.add(gpu.index);samples.set(gpu.index,gpu);}
  return ids.map(index=>{
    const gpu=samples.get(index),known=!duplicates.has(index)&&snapshot?.stale===false&&host?.reachable===true&&Number.isFinite(gpu?.memoryTotalMiB)&&gpu.memoryTotalMiB>0&&Number.isFinite(gpu.memoryUsedMiB)&&gpu.memoryUsedMiB>=0&&gpu.memoryUsedMiB<=gpu.memoryTotalMiB;
    return {index,known,ratio:known?gpu.memoryUsedMiB/gpu.memoryTotalMiB:null,used:known?(gpu.memoryUsedMiB/1024).toFixed(1):'—',total:known?(gpu.memoryTotalMiB/1024).toFixed(1):'—',utilization:known&&Number.isFinite(gpu.utilization)&&gpu.utilization>=0&&gpu.utilization<=100?gpu.utilization:null};
  });
}
export function missionHTML(job,{snapshot,machines=[],now=Date.now()/1000,resultAction=''}={}){
  const r=trainingReadout(job),gpus=missionGPUs(job,snapshot,machines),elapsed=elapsedTraining(job,now),width=gpus.length?384/gpus.length:0;
  const hardware=gpus.length?`<svg class="r5-mission-hardware" viewBox="0 0 432 205" role="img" aria-label="${escapeUI(job.machine)} 本次分配的 ${gpus.length} 张显卡"><defs><pattern id="mission-unknown" width="6" height="6" patternUnits="userSpaceOnUse"><path d="M-1 1L1-1M0 6L6 0M5 7L7 5" class="mission-hatch"></path></pattern><pattern id="mission-perforation" width="7" height="7" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r=".7" class="mission-hole"></circle></pattern></defs><rect x="1" y="1" width="430" height="195" rx="3" class="mission-chassis"></rect><rect x="8" y="9" width="416" height="176" class="mission-panel"></rect><rect x="16" y="17" width="400" height="12" fill="url(#mission-perforation)"></rect>${gpus.map((gpu,n)=>{const x=24+n*width,h=gpu.known?120*gpu.ratio:120;return `<g><rect x="${x}" y="38" width="${width-9}" height="120" class="mission-bay"></rect><rect x="${x+1}" y="${158-h}" width="${width-11}" height="${h}" class="mission-fill ${gpu.known?'':'unknown'}" ${gpu.known?'':'fill="url(#mission-unknown)"'}></rect><text x="${x+5}" y="174">GPU ${gpu.index}</text></g>`;}).join('')}<path d="M16 184H416M16 190H52M64 190H89M102 190H133" class="mission-io"></path></svg><div class="r5-mission-gpu-facts">${gpus.map(gpu=>`<div><strong>GPU ${gpu.index}</strong><span class="mono">${gpu.known?gpu.used+' / '+gpu.total+' GiB':'显存待更新'}</span>${gpu.utilization===null?'':`<span>利用率 ${gpu.utilization}%</span>`}</div>`).join('')}</div>`:`<p class="r5-mission-empty">${job.state==='PREPARING_DATA'||Array.isArray(job.assignedIndices)&&job.assignedIndices.length===0?'显卡尚未分配':'本次显卡待更新'}</p>`;
  return `<header class="r5-mission-head"><span class="wordmark" aria-hidden="true"></span><span class="r5-mission-label">任务全屏</span><div class="r5-mission-actions">${resultAction}<button class="button quiet" type="button" data-job-logs="${escapeUI(job.id)}">日志</button><button class="button quiet" type="button" data-job-output="${escapeUI(job.id)}">输出</button><button class="button danger" type="button" data-job-cancel="${escapeUI(job.id)}" ${endedJob(job)||job.cancelRequested?'disabled':''}>取消</button><button class="button quiet" type="button" data-copy-job="${escapeUI(job.id)}" title="${escapeUI(job.id)}">复制 ID</button><button class="button quiet" type="button" data-mission-close>退出全屏 <kbd>Esc</kbd></button></div></header><div class="r5-mission-body"><div class="r5-mission-identity"><p class="mono" title="${escapeUI(job.machine)}${job.project?' / '+escapeUI(job.project):''}">${serverIdHTML(job.machine)}${job.project?'<span class="r5-mission-project"> / '+escapeUI(job.project)+'</span>':''}</p><h1 id="job-mission-title">${escapeUI(job.name||'训练')}</h1><div>${stateHTML(job)}${automaticSelectionHTML(job,false)}${job.schedulerCheckedAt?`<span class="mono">更新于 ${escapeUI(shortTime(job.schedulerCheckedAt))}</span>`:''}</div></div>${projectPreparationHTML(job)}<div class="r5-mission-focus"><section class="r5-mission-progress">${job.state==='PREPARING_DATA'?`<div class="wb-stage-hero"><strong>${escapeUI(projectPreparationReadout(job)?.label||'准备数据')}</strong></div>`:`<div class="wb-report-label"><span class="label">训练上报</span>${infoHTML('进度、指标和预计结束时间来自训练上报。任务结束和额度释放以服务器确认的状态为准。','训练上报说明')}</div><div class="r5-mission-percentage">${r.percent===null?'—':r.percent}<small>${r.percent===null?'':'%'}</small></div><div class="r5-mission-report">${r.epoch?`<span>${escapeUI(r.epoch)}</span>`:''}${r.completionPending?'<strong>完成待确认</strong>':''}${!r.fresh?'<span>进度未更新</span>':''}</div>`}</section><section class="r5-mission-time"><div><span class="label">${endedJob(job)?'运行时长':'已运行'}</span><strong class="mono" data-mission-elapsed>${elapsed||'—'}</strong></div>${!endedJob(job)&&r.eta?`<div><span class="label">预计结束</span><span>${escapeUI(r.eta)}</span></div>`:''}</section><section class="r5-mission-gpus"><div class="r5-mission-section-title"><h2>本次显卡</h2>${serverIdHTML(job.machine,'mono')}${infoHTML('液位表示显存占比。斜线表示采集未知，不代表空闲。','显卡图例')}</div>${hardware}</section></div>${job.error?`<p class="form-error">${escapeUI(job.error)}</p>`:''}${r.metrics.length?`<section class="r5-mission-metrics" aria-label="最新指标">${r.metrics.map(([name,value])=>`<div><span class="label">${escapeUI(name)}</span><strong class="mono">${escapeUI(Number(value).toPrecision(5))}</strong></div>`).join('')}</section>`:''}<section class="r5-mission-trajectory"><div class="r5-mission-section-title"><h2>任务轨迹</h2>${infoHTML('各阶段依据任务状态显示。只有已返回的时间会显示，缺失时间不会推算。','轨迹来源')}</div>${trajectoryHTML(job)}</section></div>`;
}
export function taskMissionUI(store,{onOpen=()=>{},toast=()=>{},resultAction=()=>''}={}){
  const dialog=document.createElement('dialog');dialog.id='job-mission';dialog.className='r5-mission';dialog.setAttribute('aria-labelledby','job-mission-title');document.body.append(dialog);
  let id=null,opener=null,html='',timer=null;
  const owned=()=>store.jobs.find(job=>job.id===id&&job.userId===store.principal?.userId);
  function close(animate=true){
    if(!dialog.open)return;
    const title=captureObject(dialog.querySelector('#job-mission-title')),number=captureObject(dialog.querySelector('.r5-mission-percentage'));
    dialog.close();clearInterval(timer);timer=null;
    const row=[...document.querySelectorAll('[data-workbench-job]')].find(node=>node.dataset.workbenchJob===id);
    if(animate){sharedObject(title,row?.querySelector('.wb-job-name'));sharedObject(number,row?.querySelector('.wb-progress-number'));}
    (opener?.isConnected?opener:row?.querySelector('[data-job-mission]')||row?.querySelector('.wb-job-name'))?.focus({preventScroll:true});
  }
  function sync(){
    const job=owned();if(!job){close(false);dialog.replaceChildren();id=null;html='';return;}
    if(!dialog.open)return;
    const next=missionHTML(job,{snapshot:store.data?.gpuq,machines:store.data?.machines,resultAction:resultAction(job)});
    if(next!==html){const hooks=['data-mission-close','data-copy-job','data-job-logs','data-job-output','data-job-pull','data-job-cancel'],focus=dialog.contains(document.activeElement)?hooks.find(hook=>document.activeElement?.hasAttribute(hook)):null;html=next;dialog.innerHTML=next;if(focus)dialog.querySelector(`[${focus}]`)?.focus({preventScroll:true});}
  }
  function open(jobId,source){
    if(!store.jobs.some(job=>job.id===jobId&&job.userId===store.principal?.userId))return;
    opener=source;const row=source?.closest('[data-workbench-job]'),title=captureObject(row?.querySelector('.wb-job-name')),number=captureObject(row?.querySelector('.wb-progress-number'));
    id=jobId;onOpen(id);html=missionHTML(owned(),{snapshot:store.data?.gpuq,machines:store.data?.machines,resultAction:resultAction(owned())});dialog.innerHTML=html;dialog.showModal();
    sharedObject(title,dialog.querySelector('#job-mission-title'));sharedObject(number,dialog.querySelector('.r5-mission-percentage'));dialog.querySelector('[data-mission-close]').focus({preventScroll:true});
    clearInterval(timer);timer=setInterval(()=>{if(document.hidden)return;const job=owned(),elapsed=job?elapsedTraining(job):null;const label=dialog.querySelector('[data-mission-elapsed]');if(label)label.textContent=elapsed||'—';},1000);
  }
  document.addEventListener('click',event=>{const button=event.target.closest('button');if(!button||button.disabled)return;if(button.dataset.jobMission)open(button.dataset.jobMission,button);if(button.hasAttribute('data-mission-close'))close();});
  dialog.addEventListener('click',event=>{const button=event.target.closest('[data-copy-job]');if(button&&owned()?.id===button.dataset.copyJob)navigator.clipboard.writeText(button.dataset.copyJob).then(()=>toast('已复制任务 ID'),()=>toast('复制失败，请手动复制。'));});
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  store.onAuthChange?.(()=>{close(false);dialog.replaceChildren();id=null;html='';});
  return {sync,close};
}
