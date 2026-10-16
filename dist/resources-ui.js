import {priorityLabel,taskIdentityHTML,nativeOwnerLabel} from './execution-ui.js';
import {revealSheet,dismissSheet,reducedMotion,captureObject,sharedObject} from './motion-ui.js';
import {resourceOrbits} from './resource-orbits.js';
import {transferBytes} from './data-route.js';
import {maintenanceFor,maintenanceTime,maintenanceInfoHTML} from './maintenance-state.js';
import {serverIdHTML,personalQuotaReadout,escapeUI as esc} from './workbench-ui.js';
const known=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const metric=(value,suffix='',digits=0)=>known(value)?`${value.toFixed(digits)}${suffix}`:'未知';
const gib=value=>metric(known(value)?value/1024:null,'',1);
function info(id,label,text){return `<details class="resource-info" data-resource-info="${esc(id)}"><summary aria-label="${esc(label)}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.2"/></svg></summary><div class="resource-info-content" role="note">${text}</div></details>`;}
const help={memory:'柱高可切换显存占比或 GPU 利用率。白色是自己的任务，灰色是其他进程；混用时仅将能归属到自己的显存画白。利用率无法拆分到进程，混用时统一画灰。斜纹表示读数或进程列表采集不可用；未检测到进程不等于能立即开始训练。',sample:'细线保留上次采集的位置，变化时闪一次。第一次采集、过期或恢复连接都直接显示。',quota:'额度是你的并发上限，排队也占额度。服务器卡数是物理容量，何时开始由服务器安排。',process:'提交者只在服务器确认进程所属任务后显示，其他显示未知。任务的命令、日志和操作在任务详情中查看。'};
function clock(value){return Number.isFinite(Date.parse(value))?new Date(value).toLocaleTimeString('zh-CN',{hour12:false,hour:'2-digit',minute:'2-digit'}):'—';}
function maintenanceBand(view){return view.maintenance?`<div class="maintenance-lock-band"><span class="maintenance-pause" aria-hidden="true"></span>维护中 · 自 ${esc(maintenanceTime(view.maintenance.since))}</div>`:'';}
function maintenanceReason(view){return view.maintenance?`<p class="maintenance-resource-reason">${esc(view.maintenance.reason)} ${maintenanceInfoHTML('暂停新操作；监控与运行任务继续。维护结束后由管理员恢复。','维护说明')}</p>`:'';}
function processPriority(process,admin){
  const s=process.scheduling;
  if(!s||!Number.isInteger(s.priority)||s.priority<0||s.priority>4)return '<span class="muted">未确认</span>';
  return `${esc(priorityLabel(s.priority))}${admin&&s.jobId?`<small>${esc(s.jobId)}</small>`:''}`;
}
function processList(gpu,admin,key){
  const list=Array.isArray(gpu.processes)?gpu.processes:[],available=gpu.processesAvailable===true&&Array.isArray(gpu.processes);
  return `<details open class="gpu-processes" data-resource-detail="${esc(key)}"><summary>${available?`${list.length} 个进程`:list.length?`${list.length} 个 · 列表不完整`:'采集不可用'}</summary><div class="process-content">${gpu.processesError?'<p class="monitor-warning">进程采集不完整。</p>':''}${!list.length?`<p class="muted">${available?'未检测到进程。':'采集失败，请稍后刷新。'}</p>`:`<table class="process-table"><thead><tr><th>PID</th><th>任务 / 提交者 / 描述</th>${admin?'<th>程序</th><th>系统用户</th>':''}<th>显存 MiB</th><th>优先级</th></tr></thead><tbody>${list.map(p=>`<tr><td>${esc(p.pid)}</td><td>${p.task?taskIdentityHTML(p.task):'<span class="muted">外部进程／未确认归属</span>'}</td>${admin?`<td>${esc(p.name||'—')}</td><td>${esc(p.owner||'—')}</td>`:''}<td>${metric(p.memoryUsedMiB)}</td><td>${processPriority(p,admin)}</td></tr>`).join('')}</tbody></table>${info(key+':process-info','了解进程归属',help.process)}`}</div></details>`;
}
const waitingStates=new Set(['PENDING','QUEUED']);
function queuedTasks(view){
  if(!view.fresh)return null;
  const rows=Array.isArray(view.host?.tasks)?view.host.tasks:Array.isArray(view.host?.gpuq?.jobs)?view.host.gpuq.jobs:null;
  if(!rows||rows.some(row=>!row.state||row.state==='UNKNOWN'))return null;
  return rows.filter(row=>waitingStates.has(row.state));
}
// Totals cover the servers observed right now. A server that is offline or not
// fully read is named in \`missing\` instead of being counted as idle.
export function resourceTotals(views){
  const seen=views.filter(view=>view.processesComplete),queues=seen.map(queuedTasks);
  return {free:seen.length?seen.reduce((sum,view)=>sum+view.count-view.busy,0):null,busy:seen.length?seen.reduce((sum,view)=>sum+view.busy,0):null,
    queued:seen.length&&queues.every(rows=>rows!==null)?queues.reduce((sum,rows)=>sum+rows.length,0):null,missing:views.filter(view=>!view.processesComplete).map(view=>view.machine.id)};
}
const QUEUE_PREVIEW=5;
function queue(view){
  if(view.maintenance)return '<p class="muted">维护中，不接新任务。</p>';
  const rows=queuedTasks(view);
  if(rows===null)return '<p class="muted hatch">队列读数未知</p>';
  if(!rows.length)return `<p class="muted">${view.host.gpuq?.connected===true&&view.host.gpuq?.observeOnly!==true&&view.host.gpuq?.health!=='degraded'?'没有排队，提交即开始。':'没有排队任务。'}</p>`;
  // The full queue lives in Tasks; here only the next few are shown.
  const more=rows.length-QUEUE_PREVIEW;
  return `<ol class="resource-queue-list">${rows.slice(0,QUEUE_PREVIEW).map((task,index)=>{
    const rank=Number.isInteger(task.priority)?task.priority:({idle:0,P1:1,normal:2,P3:3,high:4})[task.priority],cards=task.gpuCount??task.gpu_count??task.cards;
    return `<li class="resource-queue-row" data-resource-queue-row><span>${index+1}. ${esc(task.name||task.id||'未命名任务')}</span><span>${rank==null?'优先级未知':'P'+rank} · ${known(cards)?cards:'未知'} 张</span></li>`;
  }).join('')}</ol>${more>0?`<a class="resource-queue-more" href="#jobs">还有 ${more} 个排队 · 在任务里看全部</a>`:''}`;
}
// Monitoring, process evidence and scheduler admission are independent. A
// measured memory level never proves that the scheduler can start a task.
export function resourceServerView(machine,{limits={},snapshot,admin=false,production=false,maintenance}={}){
  const quota=known(limits[machine.id])?limits[machine.id]:0;
  const hosts=(snapshot?.hosts||[]).filter(host=>host.id===machine.id),host=hosts.length===1?hosts[0]:null;
  const observed=production===true&&host?.reachable===true&&(snapshot?.stale===false||host.samplingStale===true);
  const fresh=observed&&snapshot?.stale===false&&host.samplingStale!==true;
  const count=Number.isSafeInteger(machine.cards)&&machine.cards>0&&machine.cards<=64?machine.cards:0;
  const raw=Array.isArray(host?.gpus)?host.gpus:[];
  const validInventory=count>0&&raw.every(gpu=>gpu&&Number.isSafeInteger(gpu.index)&&gpu.index>=0&&gpu.index<count)&&new Set(raw.map(gpu=>gpu.index)).size===raw.length;
  const gpus=observed&&validInventory?[...raw].sort((a,b)=>a.index-b.index):[];
  const complete=validInventory&&gpus.length===count;
  const processesComplete=fresh&&complete&&gpus.every(gpu=>gpu.processesAvailable===true&&Array.isArray(gpu.processes));
  const busy=processesComplete?gpus.filter(gpu=>gpu.processes.length>0).length:null;
  const status=!production?'暂无采集':observed&&!fresh?'上次采样 · '+clock(host.checkedAt):snapshot?.stale===true?'采集已过期':!fresh?'无法采集':host.gpuq?.observeOnly===true?'仅观察':host.gpuq?.health==='degraded'?'监控在线 · 调度异常':'监控在线';
  return {machine,quota,host,observed,fresh,count,gpus,complete,validInventory,processesComplete,busy,status,checkedAt:host?.checkedAt||snapshot?.checkedAt,maintenance:maintenanceFor(maintenance,machine.id)};
}
function gpuLevel(gpu){return gpu&&known(gpu.memoryUsedMiB)&&known(gpu.memoryTotalMiB)&&gpu.memoryTotalMiB>0&&gpu.memoryUsedMiB<=gpu.memoryTotalMiB?gpu.memoryUsedMiB/gpu.memoryTotalMiB*100:null;}
function processEvidence(gpu,view){
  const list=Array.isArray(gpu?.processes)?gpu.processes:[];
  return list.length?`${list.length} 个已采集进程`:view.fresh&&view.validInventory&&gpu?.processesAvailable===true&&Array.isArray(gpu.processes)?'未检测到进程':'进程占用未确认';
}
function cardState(gpu,view,mine){
  if(!view.fresh||!view.validInventory||gpu?.processesAvailable!==true||!Array.isArray(gpu.processes)||gpuLevel(gpu)===null)return 'unknown';
  const issue=view.host?.gpuq?.health==='degraded'?view.host.gpuq.healthIssue:null;
  if(issue?.kind==='managed-gpu-missing'&&Array.isArray(issue.indices)&&issue.indices.includes(gpu.index))return 'unknown';
  if(!gpu.processes.length)return 'free';
  return gpu.processes.every(process=>process.task&&mine.has(process.task.id))?'mine':'used';
}
function gpuTaskSummary(tasks,mine,gpu,view){
  if(!tasks.length)return processEvidence(gpu,view);
  const task=tasks[0],submitter=nativeOwnerLabel(task)||task.submitter?.name||task.submitter?.username||'未知提交者';
  return `<strong title="${esc(task.name)}">${esc(task.name)}</strong><span title="${esc(submitter)}">${esc(submitter)}${mine.has(task.id)?' · 我':''}</span>${tasks.length>1?`<span>另 ${tasks.length-1} 个任务 · 详见进程</span>`:''}`;
}
function towers(view,mine,{portrait=false,selectedGPU=0,metricMode='memory',drawer=true}={}){
  const byIndex=new Map(view.gpus.map(gpu=>[gpu.index,gpu]));
  return `<div class="resource-towers ${portrait?'resource-chassis-bays':''}" data-resource-towers="${esc(view.machine.id)}" data-resource-card-count="${view.count}" role="group" aria-label="${esc(view.machine.id)} 每张显卡的${metricMode==='utilization'?'利用率':'显存'}">${Array.from({length:view.count},(_,index)=>{
    const gpu=byIndex.get(index),memory=gpuLevel(gpu),value=metricMode==='utilization'?(known(gpu?.utilization)&&gpu.utilization<=100?gpu.utilization:null):memory;
    const state=value===null?'unknown':cardState(gpu,view,mine),chosen=index===selectedGPU;
    // Only colour memory backed by this user's linked process evidence. GPU
    // utilization has no per-process attribution in the monitor response.
    const ownMemory=(gpu?.processes||[]).filter(p=>p.task&&mine.has(p.task.id)).reduce((sum,p)=>sum+(known(p.memoryUsedMiB)?p.memoryUsedMiB:0),0);
    const own=state==='mine'?100:metricMode==='memory'&&known(gpu?.memoryUsedMiB)&&gpu.memoryUsedMiB>0?Math.min(100,ownMemory/gpu.memoryUsedMiB*100):0;
    const tasks=[...new Map((gpu?.processes||[]).filter(p=>p.task).map(p=>[p.task.id,p.task])).values()];
    const label=!gpu?'占用未知':`显存 ${gib(gpu.memoryUsedMiB)} / ${gib(gpu.memoryTotalMiB)} GiB · 利用率 ${metric(gpu.utilization,'%')} · ${state==='unknown'?'占用未知':processEvidence(gpu,view)}${tasks.map(task=>' · '+(task.name||task.id)+' · '+(mine.has(task.id)?'我':nativeOwnerLabel(task)||task.submitter?.name||'未知提交者')).join('')}`;
    const inside=`<span class="resource-tower-bar ${state}" role="img" aria-label="GPU ${index} · ${esc(label)}">${value===null?'':`<i class="resource-fill" data-resource-level="${value}" data-resource-sample="${esc(view.checkedAt)}" data-resource-fill-key="${esc(view.machine.id)}:${index}:${metricMode}" data-resource-confirmed="${state!=='unknown'}" aria-hidden="true"><svg viewBox="0 0 100 100" preserveAspectRatio="none"><rect class="resource-fill-own" width="${own}" height="100"/></svg></i><i class="resource-previous" hidden aria-hidden="true"></i><i class="resource-delta" aria-hidden="true"></i><i class="resource-sample-edge" aria-hidden="true"></i>`}<span class="resource-bay-label">${String(index).padStart(2,'0')}</span>${portrait?`<span class="resource-bay-value">${state==='unknown'?'未知':metric(value,'%')}</span>`:''}</span>`;
    return portrait?`<button type="button" class="resource-tower ${chosen?'selected':''}" data-resource-card="${index}" data-resource-server="${esc(view.machine.id)}" ${drawer?'aria-haspopup="dialog"':''} aria-label="查看 GPU ${index} · ${esc(label)}">${inside}</button>`:`<span class="resource-tower">${inside}</span>`;
  }).join('')}</div>`;
}
function gpuFacts(view,index,mine){
  const gpu=view.gpus.find(row=>row.index===index),tasks=[...new Map((Array.isArray(gpu?.processes)?gpu.processes:[]).filter(p=>p.task).map(p=>[p.task.id,p.task])).values()];
  return {gpu,tasks,owner:tasks.length?gpuTaskSummary(tasks,mine,gpu,view):processEvidence(gpu,view)};
}
function chassis(view,mine,index,metricMode,drawer){
  return `<div class="resource-chassis"><div class="resource-chassis-ear" aria-hidden="true"><i></i><b></b><i></i></div><div class="resource-chassis-face">${towers(view,mine,{portrait:true,selectedGPU:index,metricMode,drawer})}<div class="resource-chassis-controls" aria-hidden="true"><span class="resource-led ${view.fresh?'online':''}"></span><svg width="20" height="20" viewBox="0 0 24 24"><path d="M12 3v8"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/></svg><svg class="resource-slots" width="110" height="20" viewBox="0 0 110 20"><rect x="1" y="3" width="30" height="14" rx="1"/><path d="M6 8h20M6 12h20"/><rect x="37" y="3" width="30" height="14" rx="1"/><path d="M42 8h20M42 12h20"/><rect x="74" y="2" width="16" height="16" rx="1"/><path d="M78 2v5h8V2"/><path d="M99 5v10M104 5v10"/></svg><span class="resource-vents"></span><span class="mono">${view.count} GPU</span></div></div><div class="resource-chassis-ear" aria-hidden="true"><i></i><b></b><i></i></div></div>`;
}
const diskBytes=value=>known(value)?transferBytes(value):'未知';
function disksHTML(view){
  const disks=[];
  // The monitor reports configured data mounts. Do not manufacture a second
  // disk from the GPU model or duplicate one filesystem when it is identified.
  if(view.observed)for(const disk of view.host?.disks||[]){
    if(disks.some(row=>disk.filesystem!=null&&disk.filesystem!==''&&row.filesystem===disk.filesystem||disk.mountPoint&&row.mountPoint===disk.mountPoint))continue;
    disks.push(disk);
  }
  return `<section class="resource-disks" aria-label="数据盘"><h3>${disks.length===1?'数据盘':disks.length?disks.length+' 块数据盘':'数据盘'}</h3>${disks.length?disks.map((disk,index)=>{
    const label=disks.length===1?'SSD · 工作区与数据集共用':/ssd/i.test(disk.mountPoint)?'工作区 SSD':/hdd/i.test(disk.mountPoint)?'数据集 HDD':'数据盘 '+(index+1);
    const measured=view.fresh&&known(disk.usedBytes)&&known(disk.availableBytes)&&known(disk.totalBytes)&&disk.totalBytes>0,low=measured&&disk.availableBytes<64*1024**3;
    return `<div class="resource-disk ${measured?'measured':'unknown'}${low?' low':''}"><div class="resource-disk-label">${esc(label)}<span>${view.fresh?'':'上次采样 · '}可用 ${diskBytes(measured?disk.availableBytes:null)} / ${diskBytes(measured?disk.totalBytes:null)}</span></div><div class="resource-disk-bar" role="img" aria-label="${esc(label)} · 已用 ${diskBytes(measured?disk.usedBytes:null)} · 可用 ${diskBytes(measured?disk.availableBytes:null)}">${measured?`<i data-resource-disk-level="${Math.min(100,disk.usedBytes/disk.totalBytes*100)}"></i>`:''}</div>${low?'<p>空间不足，低于 64 GiB</p>':''}</div>`;
  }).join(''):'<p class="muted">数据盘读数未知</p>'}</section>`;
}
function bayLabels(view){
  const byIndex=new Map(view.gpus.map(gpu=>[gpu.index,gpu]));
  return `<div class="resource-baylabels" data-resource-card-count="${view.count}" aria-hidden="true">${Array.from({length:view.count},(_,index)=>{const gpu=byIndex.get(index);return `<span>${String(index).padStart(2,'0')} <b>${view.fresh&&known(gpu?.utilization)?gpu.utilization+'%':'—'}</b></span>`;}).join('')}</div>`;
}
function gpuLine(view,mine,index,drawer){
  const {gpu,owner}=gpuFacts(view,index,mine),state=cardState(gpu,view,mine);
  const reading=state==='unknown'?'读数未知':`${gib(gpu?.memoryUsedMiB)} / ${gib(gpu?.memoryTotalMiB)} GiB`;
  const who=state==='unknown'?'':state==='free'?'空闲':`${owner.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim()} · ${metric(gpu?.utilization,'%')} · ${metric(gpu?.temperatureC,'°C')}`;
  return `<div class="resource-gpuline"><span><span class="mono">GPU ${index}</span><b>${esc(reading)}</b></span><span class="resource-gpuline-who">${esc(who)}</span><button type="button" class="link" data-resource-card="${index}" data-resource-server="${esc(view.machine.id)}" ${drawer?'aria-haspopup="dialog"':''}>显卡详情 ↓</button></div>`;
}
function selectedDetail(view,{admin,mine,production,index,idPrefix=''}){
  const m=view.machine,h=view.host,{gpu,owner}=gpuFacts(view,index,mine),state=cardState(gpu,view,mine);
  const warning=!production?'演示模式，无真实采集。':!view.observed?'状态未知，请稍后刷新。':!view.fresh?'上次采样 · '+clock(view.checkedAt):!view.validInventory?'卡号异常，请刷新。':!view.complete?`已采集 ${view.gpus.length} / ${view.count} 张`:'',issue=view.fresh&&h?.gpuq?.health==='degraded'?h.gpuq.healthIssue:null;
  const diagnosis=issue?.kind==='managed-gpu-missing'?'部分 GPU 不可用；调度状态异常。':view.fresh&&h?.gpuq?.health==='degraded'?'调度状态异常；不能据此判断任务可启动。':'';
  return `<section class="resource-detail" data-resource-selected="${esc(m.id)}" aria-labelledby="${esc(idPrefix)}resource-selected-title"><header class="resource-detail-head"><h2 id="${esc(idPrefix)}resource-selected-title">${serverIdHTML(m.id)}<span class="resource-gpu-number">· GPU ${index}</span></h2></header>${warning||diagnosis?`<p class="monitor-warning">${esc([warning,diagnosis].filter(Boolean).join(' · '))}</p>`:''}<article class="resource-gpu ${state}" data-resource-gpu="${index}"><p class="resource-gpu-model">${esc(gpu?.model||m.model)}</p><div class="resource-gpu-owner">${owner}</div><dl class="resource-card-metrics"><div><dd ${view.fresh&&known(gpu?.utilization)?`data-resource-reading="${gpu.utilization}" data-resource-reading-key="${esc(m.id)}:${index}" data-resource-sample="${esc(view.checkedAt)}"`:""}>${metric(gpu?.utilization,'%')}</dd><dt>利用率</dt></div><div><dd>${gib(gpu?.memoryUsedMiB)} <small>/ ${gib(gpu?.memoryTotalMiB)} GiB</small></dd><dt>显存</dt></div><div><dd>${metric(gpu?.temperatureC,' °C')}</dd><dt>温度</dt></div><div><dd>${metric(gpu?.powerDrawW,' W')} <small>/ ${metric(gpu?.powerLimitW,' W')}</small></dd><dt>功率</dt></div></dl></article>${maintenanceBand(view)}${maintenanceReason(view)}${gpu?processList(gpu,admin,`${m.id}:${index}`):'<p class="monitor-empty">这张显卡的读数未知，请稍后刷新。</p>'}</section>`;
}
export function resourceCards({machines=[],limits={},snapshot,admin=false,management=admin,production=false,maintenance,selectedMachine,selectedGPU=0,idPrefix='',userId,jobs=[],metricMode='memory',drawer=true}={}){
  const views=machines.map(machine=>resourceServerView(machine,{limits,snapshot,admin,production,maintenance})),selected=views.find(view=>view.machine.id===selectedMachine)||views[0];
  if(!selected)return '<div class="monitor-empty">暂无服务器，请联系管理员。<button type="button" class="button" data-resource-contact>去协作区</button></div>';
  const mine=new Set(jobs.filter(job=>userId&&job.userId===userId).map(job=>job.id)),m=selected.machine,index=Number.isSafeInteger(selectedGPU)&&selectedGPU>=0&&selectedGPU<selected.count?selectedGPU:0;
  const scheduler=!production||!selected.fresh?'':selected.host.gpuq?.observeOnly?'仅观察':selected.host.gpuq?.connected!==true?'训练连接不可用':selected.host.gpuq?.health==='degraded'?'调度异常':'';
  const status=[...new Set([selected.status,scheduler].filter(Boolean))].join(' · ');
  const capacity=selected.gpus.length&&selected.gpus.every(gpu=>gpu.memoryTotalMiB===selected.gpus[0].memoryTotalMiB)&&known(selected.gpus[0].memoryTotalMiB)&&selected.gpus[0].memoryTotalMiB>0?gib(selected.gpus[0].memoryTotalMiB)+' GiB':m.memory||'未知';
  return `<section class="resource-fleet hero-frame" aria-label="服务器显卡"><div class="resource-hardware-layout"><article class="resource-card resource-portrait fleet-server selected${selected.maintenance?' maintenance-resource':''}" data-resource-machine="${esc(m.id)}"><canvas class="resource-orbit" aria-hidden="true"></canvas><div class="resource-hardware-caption"><div class="resource-metric-switch" role="group" aria-label="卡槽显示指标"><button type="button" data-resource-metric="memory" aria-pressed="${metricMode==='memory'}">显存</button><button type="button" data-resource-metric="utilization" aria-pressed="${metricMode==='utilization'}">利用率</button>${info('memory','了解卡槽读数',help.memory)}</div><span>采样于 ${clock(selected.checkedAt)} ${info('sample','了解采样细线',help.sample)}</span></div><h2 class="resource-identity" id="${esc(idPrefix)}resource-identity"><button type="button" class="resource-select" data-resource-select="${esc(m.id)}" aria-label="查看 ${esc(m.id)} 显卡详情" ${drawer?'aria-haspopup="dialog"':''}><span class="resource-id-label" title="${esc(m.id)}">${esc(m.id)}</span></button></h2><div class="resource-portrait-meta"><span class="resource-spec">${m.cards} × ${esc(m.model)} · ${esc(capacity)} / 卡</span><span>${esc(status)}</span></div><div class="maintenance-resource-body"><div class="maintenance-resource-metrics">${chassis(selected,mine,index,metricMode,drawer)}</div>${maintenanceBand(selected)}</div>${maintenanceReason(selected)}${bayLabels(selected)}${gpuLine(selected,mine,index,drawer)}<div class="resource-below">${disksHTML(selected)}<section class="resource-queue" aria-label="这台的队列"><h3>这台的队列</h3>${queue(selected)}</section></div></article><aside class="resource-mini-fleet" aria-label="其他服务器">${views.filter(view=>view!==selected).map(view=>`<article class="resource-card resource-mini fleet-server${view.maintenance?' maintenance-resource':''}" data-resource-machine="${esc(view.machine.id)}"><h2><button type="button" class="resource-select" data-resource-select="${esc(view.machine.id)}" data-resource-swap="true" aria-label="选择 ${esc(view.machine.id)}"><span class="resource-id-label" title="${esc(view.machine.id)}">${esc(view.machine.id)}</span><span class="resource-swap-arrow" aria-hidden="true">→</span></button></h2><p class="resource-spec">${view.machine.cards} × ${esc(view.machine.model)}</p><div class="maintenance-resource-body"><div class="maintenance-resource-metrics">${towers(view,mine,{metricMode})}</div>${maintenanceBand(view)}</div>${maintenanceReason(view)}<div class="resource-mini-index" data-resource-card-count="${view.count}" aria-hidden="true">${Array.from({length:view.count},(_,i)=>`<span>${i}</span>`).join('')}</div><p class="resource-fleet-state">${view.fresh?'<i class="resource-live" aria-hidden="true"></i>':''}${esc(view.status)}</p></article>`).join('')}</aside></div></section>${selectedDetail(selected,{admin:management,mine,production,index,idPrefix})}`;
}

export function monitorSummary(snapshot,production){
  if(!production)return '演示模式';
  if(!snapshot?.checkedAt)return '暂无采集';
  const samples=(snapshot.hosts||[]).filter(host=>host.gpus?.length);
  if(samples.length&&samples.every(host=>host.samplingStale))return '上次采样 · '+clock(samples.map(host=>host.checkedAt).sort().at(-1));
  return snapshot.stale?'采集已过期':'更新于 '+clock(snapshot.checkedAt);
}

// Keep the final two ID segments: adjacent servers often differ only there.
// The inventory value and accessible button name remain the complete ID.
export function compactResourceId(id,fits){
  id=String(id);
  if(fits(id))return id;
  const parts=id.split('-'),suffix=parts.slice(parts.length>2?-2:-1).join('-');
  const prefix=id.slice(0,id.length-suffix.length);
  for(let length=prefix.length-1;length>=0;length--){
    const candidate=prefix.slice(0,length)+'…'+suffix;
    if(fits(candidate))return candidate;
  }
  return '…'+suffix;
}

export function fitResourceNames(root){
  function fit(label,compact=false){
    const button=label.parentElement,full=label.title,heading=button?.closest('.resource-identity');
    if(!button?.clientWidth)return true;
    label.textContent=full;label.classList.remove('resource-id-wrap');
    button.style.removeProperty('font-size');heading?.style.removeProperty('font-size');
    const arrow=button.querySelector('.resource-swap-arrow');
    const available=button.clientWidth-(arrow?arrow.getBoundingClientRect().width+parseFloat(getComputedStyle(arrow).marginLeft):0)-1;
    const range=label.ownerDocument.createRange();
    const width=()=>{range.selectNodeContents(label);return range.getBoundingClientRect().width;};
    let size=parseFloat(getComputedStyle(heading||button).fontSize);
    button.style.fontSize=size+'px';
    size=Math.max(20,Math.min(size,Math.floor(size*available/Math.max(1,width()))));
    button.style.fontSize=size+'px';
    while(size>20&&width()>available)button.style.fontSize=--size+'px';
    // Keep the heading's line box in sync with the visible fitted text.
    if(heading)heading.style.fontSize=size+'px';
    if(width()<=available)return true;
    if(compact){
      label.textContent=compactResourceId(full,value=>{label.textContent=value;return width()<=available;});
      // Exceptionally long suffixes wrap rather than clipping their identity.
      label.classList.toggle('resource-id-wrap',width()>available);
    }
    return false;
  }
  for(const fleet of root.querySelectorAll('.resource-fleet')){
    fleet.classList.remove('resource-names-below');
    const labels=[...fleet.querySelectorAll('.resource-id-label')];
    const overflow=labels.map(label=>!fit(label));
    if(labels.some((label,index)=>overflow[index]&&label.closest('.resource-mini')))fleet.classList.add('resource-names-below');
    for(const label of labels)fit(label,true);
  }
}

// Fleet totals roll from the shown value to the new one; unknown stays a word.
function rollNumber(element,value){
  const from=Number(element.dataset.value),text=metric(value);
  element.dataset.value=Number.isFinite(value)?String(value):'';
  if(!Number.isFinite(value)||!Number.isFinite(from)||from===value||reducedMotion()){element.textContent=text;return;}
  const start=performance.now();
  const step=now=>{const k=Math.min(1,(now-start)/700),eased=1-Math.pow(1-k,3);element.textContent=k<1?String(Math.round(from+(value-from)*eased)):text;if(k<1&&element.isConnected)requestAnimationFrame(step);};
  requestAnimationFrame(step);
}
export function resourcesUI(store,{machines,getPage,navigate}){
  const grid=document.querySelector('#machine-grid');
  const orbit=document.createElement('canvas');orbit.className='resource-orbit';orbit.setAttribute('aria-hidden','true');
  const updateOrbit=resourceOrbits(orbit,()=>!!store.principal&&getPage()==='resources');
  document.querySelector('#resource-summary').hidden=true;document.querySelector('#monitor-status').hidden=true;
  const summary=document.createElement('dl');summary.className='resource-summary';summary.hidden=true;summary.setAttribute('aria-label','平台显卡与排队任务');
  summary.innerHTML=[['free','空闲','张'],['busy','使用中','张'],['queued','排队任务','个']].map(([key,label,unit])=>`<div><dt>${label}</dt><dd><span data-summary="${key}">未知</span> <small>${unit}</small></dd></div>`).join('')+'<p class="resource-summary-note" data-summary-note hidden></p>';
  document.querySelector('.heading-actions').append(summary);
  const sheet=document.createElement('dialog');sheet.className='work-sheet resource-sheet';sheet.id='resource-sheet';sheet.setAttribute('aria-labelledby','resource-sheet-title');
  sheet.innerHTML='<header class="sheet-header glass"><h2 id="resource-sheet-title">服务器详情</h2><select data-resource-gpu-picker aria-label="选择显卡"></select><button type="button" class="button quiet" data-resource-back>返回算力</button></header><div class="sheet-scroll"></div>';
  document.body.append(sheet);
  let actor=null,selected=null,metricMode='memory',returnFocus=null,resourceHTML='',levels=new Map(),readings=new Map();const expanded=new Map(),selectedGPUs=new Map();
  const fitIdentity=()=>fitResourceNames(grid);
  const identityResize=new ResizeObserver(()=>fitIdentity());identityResize.observe(grid);
  document.fonts?.addEventListener('loadingdone',()=>fitIdentity(true));
  const identity=()=>store.principal?store.principal.userId+'|'+store.principal.role:null;
  function restoreDetail(){const detail=sheet.querySelector('.resource-detail');if(detail)grid.append(detail);}
  function close(animate=true){
    if(!sheet.open)return;
    if(animate)dismissSheet(sheet,{drilldown:true});else sheet.close();
    restoreDetail();
    const target=returnFocus?.card!==undefined?grid.querySelector(`${returnFocus.row?'.resource-gpu-row':'.resource-chassis-bays .resource-tower'}[data-resource-card="${CSS.escape(returnFocus.card)}"]`):grid.querySelector(`[data-resource-select="${CSS.escape(selected||'')}"]`);target?.focus({preventScroll:true});
  }
  function applyMeasurements(){
    const nextLevels=new Map(),nextReadings=new Map(),visible=getPage()==='resources'&&!document.hidden;
    for(const root of [grid,sheet]){
      for(const towers of root.querySelectorAll('[data-resource-card-count]'))towers.style.setProperty('--gpu-count',String(Number(towers.dataset.resourceCardCount)||1));
      for(const disk of root.querySelectorAll('[data-resource-disk-level]'))disk.style.width=disk.dataset.resourceDiskLevel+'%';
      for(const fill of root.querySelectorAll('[data-resource-level]')){
        const value=Number(fill.dataset.resourceLevel),key=fill.dataset.resourceFillKey,sample=fill.dataset.resourceSample,confirmed=fill.dataset.resourceConfirmed==='true',previous=levels.get(key);
        const newSample=Number.isFinite(Date.parse(sample))&&Date.parse(sample)>Date.parse(previous?.sample),trusted=confirmed&&previous?.confirmed,prior=trusted?newSample?previous.value:sample===previous.sample?previous.prior:null:null;
        fill.style.height=value+'%';nextLevels.set(key,{value,sample,confirmed,prior});
        const line=fill.parentElement.querySelector('.resource-previous'),delta=fill.parentElement.querySelector('.resource-delta'),edge=fill.parentElement.querySelector('.resource-sample-edge');
        if(line){line.hidden=prior===null||prior===undefined;if(!line.hidden)line.style.bottom=prior+'%';}
        if(visible&&fill.getClientRects().length&&trusted&&newSample&&value!==previous.value){
          fill.animate(reducedMotion()?[{opacity:.6},{opacity:1}]:[{height:previous.value+'%'},{height:value+'%'}],{duration:reducedMotion()?0:480,easing:'cubic-bezier(.2,0,0,1)'});
          if(!reducedMotion()&&delta&&edge){delta.style.bottom=Math.min(value,previous.value)+'%';delta.style.height=Math.abs(value-previous.value)+'%';edge.style.bottom=value+'%';for(const element of [delta,edge])element.animate([{opacity:0},{opacity:element===edge?1:.45,offset:.2},{opacity:0}],{duration:480,easing:'cubic-bezier(.2,0,0,1)'});}
        }
      }
      for(const readout of root.querySelectorAll('[data-resource-reading]')){
        const value=Number(readout.dataset.resourceReading),key=readout.dataset.resourceReadingKey,sample=readout.dataset.resourceSample,previous=readings.get(key);nextReadings.set(key,{value,sample});
        if(visible&&readout.getClientRects().length&&previous&&Date.parse(sample)>Date.parse(previous.sample)&&value!==previous.value)readout.animate(reducedMotion()?[{opacity:.6},{opacity:1}]:[{opacity:.6,transform:`translateY(${value>previous.value?3:-3}px)`},{opacity:1,transform:'none'}],{duration:reducedMotion()?0:220,easing:'cubic-bezier(.2,0,0,1)'});
      }
    }
    levels=nextLevels;readings=nextReadings;
  }
  function render(){
    if(actor!==identity()){actor=identity();selected=null;metricMode='memory';levels.clear();readings.clear();expanded.clear();selectedGPUs.clear();close(false);}
    if(sheet.open&&getPage()!=='resources')close(false);
    const focused=document.activeElement,focusDetail=focused?.closest('details[data-resource-detail]')?.dataset.resourceDetail,focusInfo=focused?.closest('details[data-resource-info]')?.dataset.resourceInfo,focusSelect=focused?.dataset.resourceSelect,focusCard=focused?.dataset.resourceCard,focusMetric=focused?.dataset.resourceMetric,focusRow=focused?.classList.contains('resource-gpu-row'),scrollPositions=new Map();
    const regionKey=region=>region.closest('[data-resource-detail]')?.dataset.resourceDetail||region.closest('[data-resource-machine]')?.dataset.resourceMachine+':chassis';
    for(const root of [grid,sheet])for(const region of root.querySelectorAll('.gpu-table-scroll,.process-content')){
      const key=regionKey(region);
      if(key)scrollPositions.set(key,{top:region.scrollTop,left:region.scrollLeft});
    }
    for(const root of [grid,sheet])for(const detail of root.querySelectorAll('details[data-resource-detail],details[data-resource-info]'))expanded.set(detail.dataset.resourceDetail||'info:'+detail.dataset.resourceInfo,detail.open);
    const user=store.users.find(row=>row.id===store.principal?.userId),admin=store.principal?.role==='admin',options={limits:user?.limits||{},snapshot:store.data?.gpuq,admin,production:store.production,maintenance:store.data?.operationalMaintenance,quotaExempt:personalQuotaReadout(user).exempt};
    const views=machines.map(machine=>resourceServerView(machine,options));
    if(!views.some(view=>view.machine.id===selected))selected=(views[0])?.machine.id||null;
    const view=views.find(view=>view.machine.id===selected);
    const remembered=selectedGPUs.get(selected),index=Number.isSafeInteger(remembered)&&remembered>=0&&remembered<view?.count?remembered:0;
    const html=resourceCards({machines,...options,management:admin,selectedMachine:selected,selectedGPU:index,metricMode,userId:store.principal?.userId,jobs:store.jobs});
    if(html!==resourceHTML){resourceHTML=html;grid.innerHTML=html;grid.querySelector('.resource-orbit')?.replaceWith(orbit);}
    updateOrbit();
    if(sheet.open){const detail=grid.querySelector('.resource-detail');if(detail)sheet.querySelector('.sheet-scroll').replaceChildren(detail);sheet.querySelector('#resource-sheet-title').textContent=selected;sheet.querySelector('#resource-sheet-title').title=selected;}
    summary.hidden=!store.principal||getPage()!=='resources';
    const totals=resourceTotals(views);for(const number of summary.querySelectorAll('[data-summary]')){const value=totals[number.dataset.summary];rollNumber(number,value);number.classList.toggle('hatch',value===null);}
    const note=summary.querySelector('[data-summary-note]');note.textContent=totals.missing.length&&totals.missing.length<views.length?'不含 '+totals.missing.join('、')+'（读不到）':'';note.hidden=!note.textContent;
    const picker=sheet.querySelector('[data-resource-gpu-picker]');picker.innerHTML=Array.from({length:view?.count||0},(_,number)=>`<option value="${number}">GPU ${number}</option>`).join('');picker.value=String(index);
    for(const root of [grid,sheet])for(const detail of root.querySelectorAll('details[data-resource-detail],details[data-resource-info]')){const key=detail.dataset.resourceDetail||'info:'+detail.dataset.resourceInfo;if(expanded.has(key))detail.open=expanded.get(key);if(focusDetail&&focusDetail===detail.dataset.resourceDetail||focusInfo&&focusInfo===detail.dataset.resourceInfo)detail.querySelector('summary')?.focus({preventScroll:true});}
    for(const root of [grid,sheet])for(const region of root.querySelectorAll('.gpu-table-scroll,.process-content')){
      const previous=scrollPositions.get(regionKey(region));
      if(previous){region.scrollTop=previous.top;region.scrollLeft=previous.left;}
    }
    if(focusMetric)grid.querySelector(`[data-resource-metric="${focusMetric}"]`)?.focus({preventScroll:true});
    if(!sheet.open&&focusSelect)grid.querySelector(`[data-resource-select="${CSS.escape(focusSelect)}"]`)?.focus({preventScroll:true});
    if(!sheet.open&&focusCard!==undefined)grid.querySelector(`${focusRow?'.resource-gpu-row':'.resource-chassis-bays .resource-tower'}[data-resource-card="${CSS.escape(focusCard)}"]`)?.focus({preventScroll:true});
    fitIdentity();applyMeasurements();
  }
  function select(id,drilldown=true,fromControl=false){
    if(!store.principal||!machines.some(machine=>machine.id===id))return;
    const changed=id!==selected,source=!fromControl&&changed?captureObject(grid.querySelector(`[data-resource-machine="${CSS.escape(id)}"] .resource-id-label`)):null;
    selected=id;render();
    if(changed&&!drilldown&&!fromControl){sharedObject(source,grid.querySelector('.resource-identity .resource-id-label'),{uniformScale:true});if(!reducedMotion())grid.querySelector('.resource-chassis')?.animate([{opacity:0},{opacity:1}],{duration:280,easing:'cubic-bezier(.2,0,0,1)'});const heading=grid.querySelector('.resource-identity');if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}}
    if(fromControl){grid.querySelector('.resource-fleet')?.scrollIntoView({block:'start',behavior:'instant'});const heading=grid.querySelector('.resource-identity');if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}}
    if(drilldown&&!sheet.open){
      sheet.querySelector('.sheet-scroll').replaceChildren(grid.querySelector('.resource-detail'));sheet.querySelector('#resource-sheet-title').textContent=id;sheet.querySelector('#resource-sheet-title').title=id;
      sheet.querySelector('.sheet-scroll').scrollTop=0;
      // A new foreground action replaces an unfinished visual-only exit.
      for(const ghost of document.querySelectorAll('.object-transition-layer'))ghost.remove();
      sheet.showModal();revealSheet(sheet,{drilldown:true});sheet.querySelector('[data-resource-back]').focus({preventScroll:true});
    }
  }

  document.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button||button.disabled||!grid.contains(button)&&!sheet.contains(button))return;
    if(button.dataset.resourceSelect){returnFocus={};select(button.dataset.resourceSelect,!button.hasAttribute('data-resource-swap'));}
    if(button.hasAttribute('data-resource-card')&&button.dataset.resourceServer===selected){returnFocus={card:button.dataset.resourceCard,row:button.classList.contains('resource-gpu-row')};selectedGPUs.set(selected,Number(button.dataset.resourceCard));select(selected);}
    if(button.dataset.resourceMetric&&button.dataset.resourceMetric!==metricMode){
      const before=new Map([...grid.querySelectorAll('[data-resource-confirmed=true]')].map(fill=>[fill.dataset.resourceFillKey.split(':').slice(0,-1).join(':'),Number(fill.dataset.resourceLevel)]));
      metricMode=button.dataset.resourceMetric;render();
      if(!reducedMotion())for(const fill of grid.querySelectorAll('[data-resource-confirmed=true]')){
        const previous=before.get(fill.dataset.resourceFillKey.split(':').slice(0,-1).join(':'));
        if(previous!==undefined)fill.animate([{height:previous+'%'},{height:fill.dataset.resourceLevel+'%'}],{duration:380,easing:'cubic-bezier(.2,.8,.2,1)'});
      }
    }
    if(button.hasAttribute('data-resource-contact'))navigate('community');
    if(button.hasAttribute('data-resource-back'))close();
  });
  sheet.addEventListener('cancel',event=>{event.preventDefault();close();});sheet.addEventListener('click',event=>{if(event.target===sheet){const r=sheet.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)close();}});
  sheet.addEventListener('change',event=>{if(event.target.hasAttribute('data-resource-gpu-picker')){selectedGPUs.set(selected,Number(event.target.value));render();}});
  document.addEventListener('gpuq-open-resource',event=>{if(event.detail?.userId!==store.principal?.userId||getPage()!=='resources')return;select(event.detail.machine,false,true);});
  store.onAuthChange(()=>{close(false);sheet.querySelector('.sheet-scroll').replaceChildren();grid.replaceChildren();summary.hidden=true;actor=null;selected=null;metricMode='memory';resourceHTML='';updateOrbit();levels.clear();readings.clear();expanded.clear();selectedGPUs.clear();});
  return render;
}
