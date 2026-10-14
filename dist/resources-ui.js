import {priorityLabel,sampleTime,taskIdentityHTML,taskStateLabel,nativeOwnerLabel} from './execution-ui.js';
import {taskLabelEditorHTML} from './task-display-ui.js';
import {revealSheet,dismissSheet,reducedMotion,captureObject,sharedObject} from './motion-ui.js';
import {maintenanceFor,maintenanceTime,maintenanceInfoHTML} from './maintenance-state.js';
import {serverIdHTML,personalQuotaReadout,escapeUI as esc} from './workbench-ui.js';
const known=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const metric=(value,suffix='',digits=0)=>known(value)?`${value.toFixed(digits)}${suffix}`:'—';
const gib=value=>metric(known(value)?value/1024:null,'',1);
function info(id,label,text){return `<details class="resource-info" data-resource-info="${esc(id)}"><summary aria-label="${esc(label)}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.2"/></svg></summary><div class="resource-info-content" role="note">${text}</div></details>`;}
const help={memory:'柱高表示已用显存的比例，利用率另列。斜线表示占用未确认；没有检测到进程，也不等于能马上开始训练。',sample:'细线保留上次采集的位置，变化时闪一次。第一次采集、过期或恢复连接都直接显示。',quota:'额度是你的并发上限，排队也占额度。服务器卡数是物理容量，何时开始由服务器安排。',process:'提交者只在服务器确认进程所属任务后显示，其他显示未知。成员不能查看他人的命令、日志或操作。',queue:'这些记录只供查看，分配记录不是当前占用。优先级和让位方式显示服务器返回的值。',taskQueue:'分配记录不是当前占用。管理员可编辑已确认任务的显示名称与描述，不改变命令或调度；成员在本人任务详情中编辑。'};
function clock(value){return Number.isFinite(Date.parse(value))?new Date(value).toLocaleTimeString('zh-CN',{hour12:false,hour:'2-digit',minute:'2-digit'}):'—';}
function maintenanceBand(view){return view.maintenance?`<div class="maintenance-lock-band"><span class="maintenance-pause" aria-hidden="true"></span>维护中 · 自 ${esc(maintenanceTime(view.maintenance.since))}</div>`:'';}
function maintenanceReason(view){return view.maintenance?`<p class="maintenance-resource-reason">${esc(view.maintenance.reason)} ${maintenanceInfoHTML('暂停新操作；监控与运行任务继续。维护结束后由管理员恢复。','维护说明')}</p>`:'';}
function bar(value,max,label){return known(value)&&known(max)&&max>0?`<progress class="gpu-meter" max="${max}" value="${Math.min(value,max)}" aria-label="${esc(label)}"></progress>`:'';}
function processPriority(process,admin){
  const s=process.scheduling;
  if(!s||!Number.isInteger(s.priority)||s.priority<0||s.priority>4)return '<span class="muted">未确认</span>';
  return `${esc(priorityLabel(s.priority))}${admin&&s.jobId?`<small>${esc(s.jobId)}</small>`:''}`;
}
function processList(gpu,admin,key){
  const list=Array.isArray(gpu.processes)?gpu.processes:[],available=gpu.processesAvailable===true&&Array.isArray(gpu.processes);
  return `<details class="gpu-processes" data-resource-detail="${esc(key)}"><summary>${available?`${list.length} 个进程`:list.length?`${list.length} 个 · 列表不完整`:'采集不可用'}</summary><div class="process-content">${gpu.processesError?'<p class="monitor-warning">进程采集不完整。</p>':''}${!list.length?`<p class="muted">${available?'未检测到进程。':'采集失败，请稍后刷新。'}</p>`:`<table class="process-table"><thead><tr><th>PID</th><th>任务 / 提交者 / 描述</th>${admin?'<th>程序</th><th>系统用户</th>':''}<th>显存 MiB</th><th>优先级</th></tr></thead><tbody>${list.map(p=>`<tr><td>${esc(p.pid)}</td><td>${p.task?taskIdentityHTML(p.task):'<span class="muted">外部进程／未确认归属</span>'}</td>${admin?`<td>${esc(p.name||'—')}</td><td>${esc(p.owner||'—')}</td>`:''}<td>${metric(p.memoryUsedMiB)}</td><td>${processPriority(p,admin)}</td></tr>`).join('')}</tbody></table>${info(key+':process-info','了解进程归属',help.process)}`}</div></details>`;
}
function gpuTable(host,admin,machine){
  if(!host.gpus?.length)return '<div class="monitor-empty">逐卡状态暂不可用，请稍后刷新。</div>';
  return `<div class="gpu-table-scroll"><table class="gpu-table"><caption class="sr-only">${esc(machine.id)} 每张 GPU 的使用量与进程</caption><thead><tr><th>GPU</th><th>利用率</th><th>显存 GiB</th><th>温度 / 功耗</th><th>进程</th></tr></thead><tbody>${host.gpus.map(g=>`<tr data-gpu-index="${g.index}"><th scope="row"><span class="gpu-index">#${g.index}</span><small>${esc(g.model||machine.model)}</small></th><td><strong>${metric(g.utilization,'%')}</strong>${bar(g.utilization,100,'GPU 利用率')}</td><td><strong>${gib(g.memoryUsedMiB)} <span class="muted">/ ${gib(g.memoryTotalMiB)}</span></strong>${bar(g.memoryUsedMiB,g.memoryTotalMiB,'显存使用量')}</td><td>${metric(g.temperatureC,' °C')}<small>${metric(g.powerDrawW,' W')} / ${metric(g.powerLimitW,' W')}</small></td><td>${processList(g,admin,`${machine.id}:${g.index}`)}</td></tr>`).join('')}</tbody></table></div>`;
}
function queue(host,machine,checkedAt,admin=false){
  if(Array.isArray(host.tasks))return taskQueue(host.tasks,machine,checkedAt,admin);
  const jobs=host.gpuq?.jobs||[];
  return `<details class="node-queue" data-resource-detail="${esc(machine.id)}:queue"><summary>任务记录 · ${jobs.length} 条</summary>${info(machine.id+':queue-info','了解任务记录',help.queue)}${jobs.length?`<div class="gpu-table-scroll"><table class="process-table"><thead><tr><th>任务 / 用户</th><th>状态 / 优先级</th><th>调度说明</th><th>分配 GPU</th></tr></thead><tbody>${jobs.map(j=>`<tr><td>${esc(j.name||j.id)}<small>${esc(j.owner||'—')} · ${esc(j.id||'')}</small></td><td>${esc(j.state)}<small>${esc(priorityLabel(j.priority))}</small><small>让位策略：${esc(({never:'不自动中断',now:'允许直接中断',save:'保存后让位'})[j.yield_policy]||'未提供')}</small></td><td class="queue-reason">${esc(j.state_reason||'节点未提供说明')}<small>${j.updated_at?'更新于':'采集时间'}：${esc(sampleTime(j.updated_at||checkedAt))}</small></td><td>${esc(Array.isArray(j.assigned_gpu_indices)&&j.assigned_gpu_indices.length?j.assigned_gpu_indices.join(', '):'—')}</td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">本次未返回队列记录。</p>'}</details>`;
}
function taskQueue(tasks,machine,checkedAt,admin){
  return `<details class="node-queue" data-resource-detail="${esc(machine.id)}:queue"><summary>任务队列与近期记录 · ${tasks.length} 条</summary>${info(machine.id+':queue-info','了解任务记录',help.taskQueue)}${tasks.length?`<div class="gpu-table-scroll"><table class="process-table"><thead><tr><th>任务 / 提交者 / 描述</th><th>状态 / 优先级</th><th>分配 GPU</th><th>更新于</th></tr></thead><tbody>${tasks.map(t=>`<tr><td>${taskIdentityHTML(t)}${admin?taskLabelEditorHTML({...t,machine:machine.id},{role:'admin'}):''}</td><td>${esc(taskStateLabel(t))}<small>${esc(priorityLabel(t.priority))}</small>${admin&&t.schedulerState&&t.schedulerState!==t.state?`<small>服务器状态：${esc(t.schedulerState)}</small>`:''}</td><td>${esc(t.assignedGpuIndices?.length?t.assignedGpuIndices.join(', '):'—')}</td><td>${esc(sampleTime(t.updatedAt||checkedAt))}</td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">本次没有返回任务记录。</p>'}</details>`;
}
// Monitoring, process evidence and scheduler admission are independent. A
// measured memory level never proves that the scheduler can start a task.
export function resourceServerView(machine,{limits={},snapshot,admin=false,production=false,maintenance}={}){
  const quota=known(limits[machine.id])?limits[machine.id]:0,authorized=admin||quota>0;
  const hosts=(snapshot?.hosts||[]).filter(host=>host.id===machine.id),host=hosts.length===1?hosts[0]:null;
  const observed=authorized&&production===true&&host?.reachable===true&&(snapshot?.stale===false||host.samplingStale===true);
  const fresh=observed&&snapshot?.stale===false&&host.samplingStale!==true;
  const count=Number.isSafeInteger(machine.cards)&&machine.cards>0&&machine.cards<=64?machine.cards:0;
  const raw=Array.isArray(host?.gpus)?host.gpus:[];
  const validInventory=count>0&&raw.every(gpu=>gpu&&Number.isSafeInteger(gpu.index)&&gpu.index>=0&&gpu.index<count)&&new Set(raw.map(gpu=>gpu.index)).size===raw.length;
  const gpus=observed&&validInventory?[...raw].sort((a,b)=>a.index-b.index):[];
  const complete=validInventory&&gpus.length===count;
  const processesComplete=fresh&&complete&&gpus.every(gpu=>gpu.processesAvailable===true&&Array.isArray(gpu.processes));
  const busy=processesComplete?gpus.filter(gpu=>gpu.processes.length>0).length:null;
  const status=!authorized?'未授权':!production?'暂无采集':observed&&!fresh?'上次采样 · '+clock(host.checkedAt):snapshot?.stale===true?'采集已过期':!fresh?'无法采集':host.gpuq?.observeOnly===true?'仅观察':host.gpuq?.health==='degraded'?'监控在线 · 调度异常':'监控在线';
  return {machine,quota,authorized,host,observed,fresh,count,gpus,complete,validInventory,processesComplete,busy,status,checkedAt:host?.checkedAt||snapshot?.checkedAt,maintenance:authorized?maintenanceFor(maintenance,machine.id):null};
}
function gpuLevel(gpu){return gpu&&known(gpu.memoryUsedMiB)&&known(gpu.memoryTotalMiB)&&gpu.memoryTotalMiB>0&&gpu.memoryUsedMiB<=gpu.memoryTotalMiB?gpu.memoryUsedMiB/gpu.memoryTotalMiB*100:null;}
function processEvidence(gpu,view){
  const list=Array.isArray(gpu?.processes)?gpu.processes:[];
  return list.length?`${list.length} 个已采集进程`:view.fresh&&view.validInventory&&gpu?.processesAvailable===true&&Array.isArray(gpu.processes)?'未检测到进程':'进程占用未确认';
}
function cardState(gpu,view,mine){
  if(!view.authorized)return 'locked';
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
const HARDWARE='<svg class="resource-chassis-linework" viewBox="0 0 880 290" aria-hidden="true">\n<path class="chassis-back" d="M18 1H862L879 18V272L862 289H18L1 272V18Z"></path>\n<path class="chassis-bevel" d="M18 1H862L855 17H25Z"></path>\n<path class="chassis-bevel" d="M18 289H862L855 273H25Z"></path>\n<path class="chassis-ear" d="M1 24H22V266H1M879 24H858V266H879"></path>\n<rect class="chassis-face" x="22" y="18" width="836" height="256" rx="3"></rect>\n<rect class="chassis-aperture" x="51" y="35" width="778" height="175" rx="2"></rect>\n<path class="chassis-rail" d="M51 213H829M51 218H829M41 28v234M839 28v234"></path>\n<path class="chassis-handle" d="M30 83H42V207H30ZM838 83H850V207H838Z"></path>\n<g class="chassis-fasteners"><circle cx="11" cy="39" r="3.5"></circle><path d="M9 39h4"></path><circle cx="11" cy="251" r="3.5"></circle><path d="M9 251h4"></path><circle cx="869" cy="39" r="3.5"></circle><path d="M867 39h4"></path><circle cx="869" cy="251" r="3.5"></circle><path d="M867 251h4"></path></g>\n<g class="chassis-io"><circle cx="85" cy="241" r="10"></circle><path d="M85 234v7M80 237a7 7 0 1 0 10 0"></path><rect x="117" y="232" width="35" height="17" rx="1"></rect><path d="M123 237h23m-23 7h23"></path><rect x="164" y="232" width="35" height="17" rx="1"></rect><path d="M170 237h23m-23 7h23"></path><rect x="211" y="231" width="23" height="19" rx="1"></rect><path d="M217 232v5h11v-5M216 247h13"></path><path d="M260 232v18M272 232v18"></path></g>\n<g class="chassis-perforation"><circle cx="318" cy="230" r="1.1"></circle><circle cx="325" cy="230" r="1.1"></circle><circle cx="332" cy="230" r="1.1"></circle><circle cx="339" cy="230" r="1.1"></circle><circle cx="346" cy="230" r="1.1"></circle><circle cx="353" cy="230" r="1.1"></circle><circle cx="360" cy="230" r="1.1"></circle><circle cx="367" cy="230" r="1.1"></circle><circle cx="374" cy="230" r="1.1"></circle><circle cx="381" cy="230" r="1.1"></circle><circle cx="388" cy="230" r="1.1"></circle><circle cx="395" cy="230" r="1.1"></circle><circle cx="402" cy="230" r="1.1"></circle><circle cx="409" cy="230" r="1.1"></circle><circle cx="416" cy="230" r="1.1"></circle><circle cx="423" cy="230" r="1.1"></circle><circle cx="430" cy="230" r="1.1"></circle><circle cx="437" cy="230" r="1.1"></circle><circle cx="444" cy="230" r="1.1"></circle><circle cx="451" cy="230" r="1.1"></circle><circle cx="458" cy="230" r="1.1"></circle><circle cx="465" cy="230" r="1.1"></circle><circle cx="472" cy="230" r="1.1"></circle><circle cx="479" cy="230" r="1.1"></circle><circle cx="486" cy="230" r="1.1"></circle><circle cx="493" cy="230" r="1.1"></circle><circle cx="500" cy="230" r="1.1"></circle><circle cx="507" cy="230" r="1.1"></circle><circle cx="514" cy="230" r="1.1"></circle><circle cx="521" cy="230" r="1.1"></circle><circle cx="528" cy="230" r="1.1"></circle><circle cx="535" cy="230" r="1.1"></circle><circle cx="542" cy="230" r="1.1"></circle><circle cx="549" cy="230" r="1.1"></circle><circle cx="556" cy="230" r="1.1"></circle><circle cx="563" cy="230" r="1.1"></circle><circle cx="570" cy="230" r="1.1"></circle><circle cx="577" cy="230" r="1.1"></circle><circle cx="584" cy="230" r="1.1"></circle><circle cx="591" cy="230" r="1.1"></circle><circle cx="598" cy="230" r="1.1"></circle><circle cx="605" cy="230" r="1.1"></circle><circle cx="612" cy="230" r="1.1"></circle><circle cx="619" cy="230" r="1.1"></circle><circle cx="626" cy="230" r="1.1"></circle><circle cx="633" cy="230" r="1.1"></circle><circle cx="640" cy="230" r="1.1"></circle><circle cx="647" cy="230" r="1.1"></circle><circle cx="654" cy="230" r="1.1"></circle><circle cx="661" cy="230" r="1.1"></circle><circle cx="668" cy="230" r="1.1"></circle><circle cx="675" cy="230" r="1.1"></circle><circle cx="682" cy="230" r="1.1"></circle><circle cx="689" cy="230" r="1.1"></circle><circle cx="696" cy="230" r="1.1"></circle><circle cx="703" cy="230" r="1.1"></circle><circle cx="710" cy="230" r="1.1"></circle><circle cx="717" cy="230" r="1.1"></circle><circle cx="724" cy="230" r="1.1"></circle><circle cx="731" cy="230" r="1.1"></circle><circle cx="738" cy="230" r="1.1"></circle><circle cx="745" cy="230" r="1.1"></circle><circle cx="752" cy="230" r="1.1"></circle><circle cx="318" cy="237" r="1.1"></circle><circle cx="325" cy="237" r="1.1"></circle><circle cx="332" cy="237" r="1.1"></circle><circle cx="339" cy="237" r="1.1"></circle><circle cx="346" cy="237" r="1.1"></circle><circle cx="353" cy="237" r="1.1"></circle><circle cx="360" cy="237" r="1.1"></circle><circle cx="367" cy="237" r="1.1"></circle><circle cx="374" cy="237" r="1.1"></circle><circle cx="381" cy="237" r="1.1"></circle><circle cx="388" cy="237" r="1.1"></circle><circle cx="395" cy="237" r="1.1"></circle><circle cx="402" cy="237" r="1.1"></circle><circle cx="409" cy="237" r="1.1"></circle><circle cx="416" cy="237" r="1.1"></circle><circle cx="423" cy="237" r="1.1"></circle><circle cx="430" cy="237" r="1.1"></circle><circle cx="437" cy="237" r="1.1"></circle><circle cx="444" cy="237" r="1.1"></circle><circle cx="451" cy="237" r="1.1"></circle><circle cx="458" cy="237" r="1.1"></circle><circle cx="465" cy="237" r="1.1"></circle><circle cx="472" cy="237" r="1.1"></circle><circle cx="479" cy="237" r="1.1"></circle><circle cx="486" cy="237" r="1.1"></circle><circle cx="493" cy="237" r="1.1"></circle><circle cx="500" cy="237" r="1.1"></circle><circle cx="507" cy="237" r="1.1"></circle><circle cx="514" cy="237" r="1.1"></circle><circle cx="521" cy="237" r="1.1"></circle><circle cx="528" cy="237" r="1.1"></circle><circle cx="535" cy="237" r="1.1"></circle><circle cx="542" cy="237" r="1.1"></circle><circle cx="549" cy="237" r="1.1"></circle><circle cx="556" cy="237" r="1.1"></circle><circle cx="563" cy="237" r="1.1"></circle><circle cx="570" cy="237" r="1.1"></circle><circle cx="577" cy="237" r="1.1"></circle><circle cx="584" cy="237" r="1.1"></circle><circle cx="591" cy="237" r="1.1"></circle><circle cx="598" cy="237" r="1.1"></circle><circle cx="605" cy="237" r="1.1"></circle><circle cx="612" cy="237" r="1.1"></circle><circle cx="619" cy="237" r="1.1"></circle><circle cx="626" cy="237" r="1.1"></circle><circle cx="633" cy="237" r="1.1"></circle><circle cx="640" cy="237" r="1.1"></circle><circle cx="647" cy="237" r="1.1"></circle><circle cx="654" cy="237" r="1.1"></circle><circle cx="661" cy="237" r="1.1"></circle><circle cx="668" cy="237" r="1.1"></circle><circle cx="675" cy="237" r="1.1"></circle><circle cx="682" cy="237" r="1.1"></circle><circle cx="689" cy="237" r="1.1"></circle><circle cx="696" cy="237" r="1.1"></circle><circle cx="703" cy="237" r="1.1"></circle><circle cx="710" cy="237" r="1.1"></circle><circle cx="717" cy="237" r="1.1"></circle><circle cx="724" cy="237" r="1.1"></circle><circle cx="731" cy="237" r="1.1"></circle><circle cx="738" cy="237" r="1.1"></circle><circle cx="745" cy="237" r="1.1"></circle><circle cx="752" cy="237" r="1.1"></circle><circle cx="318" cy="244" r="1.1"></circle><circle cx="325" cy="244" r="1.1"></circle><circle cx="332" cy="244" r="1.1"></circle><circle cx="339" cy="244" r="1.1"></circle><circle cx="346" cy="244" r="1.1"></circle><circle cx="353" cy="244" r="1.1"></circle><circle cx="360" cy="244" r="1.1"></circle><circle cx="367" cy="244" r="1.1"></circle><circle cx="374" cy="244" r="1.1"></circle><circle cx="381" cy="244" r="1.1"></circle><circle cx="388" cy="244" r="1.1"></circle><circle cx="395" cy="244" r="1.1"></circle><circle cx="402" cy="244" r="1.1"></circle><circle cx="409" cy="244" r="1.1"></circle><circle cx="416" cy="244" r="1.1"></circle><circle cx="423" cy="244" r="1.1"></circle><circle cx="430" cy="244" r="1.1"></circle><circle cx="437" cy="244" r="1.1"></circle><circle cx="444" cy="244" r="1.1"></circle><circle cx="451" cy="244" r="1.1"></circle><circle cx="458" cy="244" r="1.1"></circle><circle cx="465" cy="244" r="1.1"></circle><circle cx="472" cy="244" r="1.1"></circle><circle cx="479" cy="244" r="1.1"></circle><circle cx="486" cy="244" r="1.1"></circle><circle cx="493" cy="244" r="1.1"></circle><circle cx="500" cy="244" r="1.1"></circle><circle cx="507" cy="244" r="1.1"></circle><circle cx="514" cy="244" r="1.1"></circle><circle cx="521" cy="244" r="1.1"></circle><circle cx="528" cy="244" r="1.1"></circle><circle cx="535" cy="244" r="1.1"></circle><circle cx="542" cy="244" r="1.1"></circle><circle cx="549" cy="244" r="1.1"></circle><circle cx="556" cy="244" r="1.1"></circle><circle cx="563" cy="244" r="1.1"></circle><circle cx="570" cy="244" r="1.1"></circle><circle cx="577" cy="244" r="1.1"></circle><circle cx="584" cy="244" r="1.1"></circle><circle cx="591" cy="244" r="1.1"></circle><circle cx="598" cy="244" r="1.1"></circle><circle cx="605" cy="244" r="1.1"></circle><circle cx="612" cy="244" r="1.1"></circle><circle cx="619" cy="244" r="1.1"></circle><circle cx="626" cy="244" r="1.1"></circle><circle cx="633" cy="244" r="1.1"></circle><circle cx="640" cy="244" r="1.1"></circle><circle cx="647" cy="244" r="1.1"></circle><circle cx="654" cy="244" r="1.1"></circle><circle cx="661" cy="244" r="1.1"></circle><circle cx="668" cy="244" r="1.1"></circle><circle cx="675" cy="244" r="1.1"></circle><circle cx="682" cy="244" r="1.1"></circle><circle cx="689" cy="244" r="1.1"></circle><circle cx="696" cy="244" r="1.1"></circle><circle cx="703" cy="244" r="1.1"></circle><circle cx="710" cy="244" r="1.1"></circle><circle cx="717" cy="244" r="1.1"></circle><circle cx="724" cy="244" r="1.1"></circle><circle cx="731" cy="244" r="1.1"></circle><circle cx="738" cy="244" r="1.1"></circle><circle cx="745" cy="244" r="1.1"></circle><circle cx="752" cy="244" r="1.1"></circle><circle cx="318" cy="251" r="1.1"></circle><circle cx="325" cy="251" r="1.1"></circle><circle cx="332" cy="251" r="1.1"></circle><circle cx="339" cy="251" r="1.1"></circle><circle cx="346" cy="251" r="1.1"></circle><circle cx="353" cy="251" r="1.1"></circle><circle cx="360" cy="251" r="1.1"></circle><circle cx="367" cy="251" r="1.1"></circle><circle cx="374" cy="251" r="1.1"></circle><circle cx="381" cy="251" r="1.1"></circle><circle cx="388" cy="251" r="1.1"></circle><circle cx="395" cy="251" r="1.1"></circle><circle cx="402" cy="251" r="1.1"></circle><circle cx="409" cy="251" r="1.1"></circle><circle cx="416" cy="251" r="1.1"></circle><circle cx="423" cy="251" r="1.1"></circle><circle cx="430" cy="251" r="1.1"></circle><circle cx="437" cy="251" r="1.1"></circle><circle cx="444" cy="251" r="1.1"></circle><circle cx="451" cy="251" r="1.1"></circle><circle cx="458" cy="251" r="1.1"></circle><circle cx="465" cy="251" r="1.1"></circle><circle cx="472" cy="251" r="1.1"></circle><circle cx="479" cy="251" r="1.1"></circle><circle cx="486" cy="251" r="1.1"></circle><circle cx="493" cy="251" r="1.1"></circle><circle cx="500" cy="251" r="1.1"></circle><circle cx="507" cy="251" r="1.1"></circle><circle cx="514" cy="251" r="1.1"></circle><circle cx="521" cy="251" r="1.1"></circle><circle cx="528" cy="251" r="1.1"></circle><circle cx="535" cy="251" r="1.1"></circle><circle cx="542" cy="251" r="1.1"></circle><circle cx="549" cy="251" r="1.1"></circle><circle cx="556" cy="251" r="1.1"></circle><circle cx="563" cy="251" r="1.1"></circle><circle cx="570" cy="251" r="1.1"></circle><circle cx="577" cy="251" r="1.1"></circle><circle cx="584" cy="251" r="1.1"></circle><circle cx="591" cy="251" r="1.1"></circle><circle cx="598" cy="251" r="1.1"></circle><circle cx="605" cy="251" r="1.1"></circle><circle cx="612" cy="251" r="1.1"></circle><circle cx="619" cy="251" r="1.1"></circle><circle cx="626" cy="251" r="1.1"></circle><circle cx="633" cy="251" r="1.1"></circle><circle cx="640" cy="251" r="1.1"></circle><circle cx="647" cy="251" r="1.1"></circle><circle cx="654" cy="251" r="1.1"></circle><circle cx="661" cy="251" r="1.1"></circle><circle cx="668" cy="251" r="1.1"></circle><circle cx="675" cy="251" r="1.1"></circle><circle cx="682" cy="251" r="1.1"></circle><circle cx="689" cy="251" r="1.1"></circle><circle cx="696" cy="251" r="1.1"></circle><circle cx="703" cy="251" r="1.1"></circle><circle cx="710" cy="251" r="1.1"></circle><circle cx="717" cy="251" r="1.1"></circle><circle cx="724" cy="251" r="1.1"></circle><circle cx="731" cy="251" r="1.1"></circle><circle cx="738" cy="251" r="1.1"></circle><circle cx="745" cy="251" r="1.1"></circle><circle cx="752" cy="251" r="1.1"></circle></g>\n<path class="chassis-rim" d="M25 270H855M25 21H855"></path>\n</svg>';
function towers(view,mine,{portrait=false,selectedGPU=0}={}){
  const byIndex=new Map(view.gpus.map(gpu=>[gpu.index,gpu]));
  return `<div class="resource-towers ${portrait?'resource-chassis-bays':''}" data-resource-towers="${esc(view.machine.id)}" data-resource-card-count="${view.count}" role="group" aria-label="${esc(view.machine.id)} 每张显卡的显存">${Array.from({length:view.count},(_,index)=>{
    const gpu=byIndex.get(index),state=cardState(gpu,view,mine),level=gpuLevel(gpu),chosen=index===selectedGPU;
    const nativeTasks=[...new Map((gpu?.processes||[]).filter(p=>nativeOwnerLabel(p.task)).map(p=>[p.task.id,p.task])).values()];
    const label=!view.authorized?'未授权':!gpu?'占用未确认':`显存 ${gib(gpu.memoryUsedMiB)} / ${gib(gpu.memoryTotalMiB)} GiB · 利用率 ${metric(gpu.utilization,'%')} · ${processEvidence(gpu,view)}${nativeTasks.map(task=>' · '+task.name+' · '+nativeOwnerLabel(task)).join('')}`;
    const inside=`<span class="resource-tower-bar ${state}" role="img" aria-label="GPU ${index} · ${esc(label)}" title="GPU ${index} · ${esc(label)}">${level===null?'':`<i class="resource-fill" data-resource-level="${level}" data-resource-sample="${esc(view.checkedAt)}" data-resource-fill-key="${esc(view.machine.id)}:${index}" data-resource-confirmed="${state!=='unknown'}" aria-hidden="true"></i><i class="resource-previous" hidden aria-hidden="true"></i><i class="resource-delta" aria-hidden="true"></i><i class="resource-sample-edge" aria-hidden="true"></i>`}${portrait?`<span class="resource-bay-label">${String(index).padStart(2,'0')}</span>`:''}</span>`;
    return portrait?`<button type="button" class="resource-tower ${chosen?'selected':''}" data-resource-card="${index}" data-resource-server="${esc(view.machine.id)}" aria-pressed="${chosen}" aria-label="选择 GPU ${index} · ${esc(label)}" ${view.authorized?'':'disabled'}>${inside}</button>`:`<span class="resource-tower">${inside}<span class="resource-tower-index">${index}</span></span>`;
  }).join('')}</div>`;
}
function gpuFacts(view,index,mine){
  const gpu=view.gpus.find(row=>row.index===index),tasks=[...new Map((Array.isArray(gpu?.processes)?gpu.processes:[]).filter(p=>p.task).map(p=>[p.task.id,p.task])).values()];
  return {gpu,tasks,owner:tasks.length?gpuTaskSummary(tasks,mine,gpu,view):processEvidence(gpu,view)};
}
function chassis(view,mine,index){
  return `<div class="resource-chassis-scroll"><div class="resource-chassis" data-resource-card-count="${view.count}">${HARDWARE}${towers(view,mine,{portrait:true,selectedGPU:index})}</div><div class="resource-portrait-utils" data-resource-card-count="${view.count}" aria-label="各显卡使用率">${Array.from({length:view.count},(_,number)=>`<span aria-label="GPU ${number}"><small>${String(number).padStart(2,'0')}</small><b>${metric(view.gpus.find(gpu=>gpu.index===number)?.utilization,'%')}</b></span>`).join('')}</div></div>`;
}
function allProcesses(view,admin){
  const rows=view.gpus.flatMap(gpu=>(Array.isArray(gpu.processes)?gpu.processes:[]).map(process=>({gpu,process})));
  const label=view.processesComplete?`${rows.length}`:rows.length?`${rows.length} · 部分采集`:'未确认';
  return `<details class="resource-process-list" data-resource-detail="${esc(view.machine.id)}:processes"><summary>进程 · ${label}</summary>${info(view.machine.id+':process-info','了解进程归属',help.process)}<div class="resource-process-scroll" tabindex="0" role="region" aria-label="${esc(view.machine.id)} 已采集进程">${rows.length?`<table class="process-table resource-process-table"><caption class="sr-only">${esc(view.machine.id)} 进程；程序与系统用户只向管理员展示</caption><thead><tr><th>GPU</th><th>PID</th><th>任务 / 提交者 / 描述</th>${admin?'<th>程序</th><th>系统用户</th>':''}<th>显存 MiB</th><th>优先级</th></tr></thead><tbody>${rows.map(({gpu,process:p})=>`<tr><td>${gpu.index}</td><td>${esc(p.pid)}</td><td>${p.task?taskIdentityHTML(p.task):'<span class="muted">外部进程／归属未知</span>'}</td>${admin?`<td>${esc(p.name||'—')}</td><td>${esc(p.owner||'—')}</td>`:''}<td>${metric(p.memoryUsedMiB)}</td><td>${processPriority(p,admin)}</td></tr>`).join('')}</tbody></table>`:`<p class="muted">${view.processesComplete?'未检测到进程。':'采集未确认，请稍后刷新。'}</p>`}</div></details>`;
}
function selectedDetail(view,{admin,mine,production,index,idPrefix=''}){
  const m=view.machine,h=view.host,{gpu,tasks,owner}=gpuFacts(view,index,mine),state=cardState(gpu,view,mine);
  const knownProcess=Array.isArray(gpu?.processes)?gpu.processes:[],pid=knownProcess[0]?.pid;
  const warning=!view.authorized?'未授权，请联系管理员。':!production?'演示模式，无真实采集。':!view.observed?'状态未知，请稍后刷新。':!view.validInventory?'卡号异常，请刷新。':!view.complete?`已采集 ${view.gpus.length} / ${view.count} 张`:'',showQueue=view.authorized&&production&&(Array.isArray(h?.tasks)||admin&&view.fresh&&h?.gpuq?.connected);
  const issue=view.fresh&&h?.gpuq?.health==='degraded'?h.gpuq.healthIssue:null;
  const missing=issue?.kind==='managed-gpu-missing'&&Array.isArray(issue.indices)&&issue.indices.length<=64&&issue.indices.every(value=>Number.isSafeInteger(value)&&value>=0&&value<view.count)?issue.indices:[];
  const diagnosis=issue?.kind==='managed-gpu-missing'?`${missing.length?'GPU '+missing.join('、'):'部分 GPU'} 不可用；调度状态异常。`:view.fresh&&h?.gpuq?.health==='degraded'?'调度状态异常；已采集指标保留，不能据此判断任务可启动。':'';
  const content=view.authorized&&production&&view.observed?`<article class="resource-gpu ${state}" data-resource-gpu="${index}"><div class="resource-gpu-owner">${owner}</div><dl class="resource-card-metrics"><div><dd class="resource-gpu-util" ${known(gpu?.utilization)&&state!=='unknown'?`data-resource-reading="${gpu.utilization}" data-resource-reading-key="${esc(m.id)}:${index}" data-resource-sample="${esc(view.checkedAt)}"`:''}>${metric(gpu?.utilization,'%')}</dd><dt>利用率</dt></div><div><dd>${metric(gpu?.temperatureC,' °C')}</dd><dt>温度</dt></div><div><dd>${metric(gpu?.powerDrawW,' W')} <small>/ ${metric(gpu?.powerLimitW,' W')}</small></dd><dt>功率</dt></div><div><dd>${esc(pid??'—')}${knownProcess.length>1?` <small>+${knownProcess.length-1}</small>`:''}</dd><dt>PID</dt></div></dl></article>`:'';
  const reference=view.authorized&&production&&view.observed?`${allProcesses(view,admin)}<details class="resource-full-metrics" data-resource-detail="${esc(m.id)}:metrics"><summary>完整指标与逐卡进程</summary>${gpuTable({...h,gpus:view.gpus},admin,m)}</details>`:'';
  return `<section class="resource-detail" data-resource-selected="${esc(m.id)}" aria-labelledby="${esc(idPrefix)}resource-selected-title"><header class="resource-detail-head"><h2 id="${esc(idPrefix)}resource-selected-title">${serverIdHTML(m.id)}<span class="resource-gpu-number">· GPU ${index}</span></h2></header>${warning||diagnosis?`<p class="monitor-warning">${warning}${warning&&diagnosis?' · ':''}${esc(diagnosis)}</p>`:''}${view.maintenance?`<div class="maintenance-resource"><div class="maintenance-resource-body"><div class="maintenance-resource-metrics">${content}</div>${maintenanceBand(view)}</div>${maintenanceReason(view)}</div>`:content}${reference}${showQueue?queue(h,m,view.checkedAt,admin):''}</section>`;
}
export function resourceCards({machines=[],limits={},snapshot,admin=false,management=admin,quotaExempt=admin,production=false,maintenance,selectedMachine,selectedGPU=0,idPrefix='',userId,jobs=[],usage}={}){
  const views=machines.map(machine=>resourceServerView(machine,{limits,snapshot,admin,production,maintenance})),selected=views.find(view=>view.machine.id===selectedMachine)||views.find(view=>view.authorized)||views[0];
  if(!selected)return '<div class="monitor-empty">暂无服务器，请联系管理员。</div>';
  const mine=new Set(jobs.filter(job=>userId&&job.userId===userId).map(job=>job.id)),m=selected.machine,index=Number.isSafeInteger(selectedGPU)&&selectedGPU>=0&&selectedGPU<selected.count?selectedGPU:0,used=typeof usage==='function'?usage(m.id):null,{gpu}=gpuFacts(selected,index,mine);
  const scheduler=!selected.authorized||!production?'':!selected.fresh?'':selected.host.gpuq?.observeOnly?'仅观察':selected.host.gpuq?.connected!==true?'训练连接不可用':selected.host.gpuq?.health==='degraded'?'调度异常':'训练连接正常';
  const status=[...new Set([selected.status,selected.status.includes(scheduler)?'':scheduler].filter(Boolean))].join(' · ');
  const capacity=selected.gpus.length&&selected.gpus.every(gpu=>gpu.memoryTotalMiB===selected.gpus[0].memoryTotalMiB)&&known(selected.gpus[0].memoryTotalMiB)&&selected.gpus[0].memoryTotalMiB>0?gib(selected.gpus[0].memoryTotalMiB)+' GiB':m.memory;
  return `<section class="resource-fleet hero-frame" aria-label="服务器显卡"><div class="resource-hardware-caption"><span>显存 ${info('memory','了解显存柱高',help.memory)}</span><span>采样于 ${clock(selected.checkedAt)} ${info('sample','了解采样细线',help.sample)}</span></div><div class="resource-hardware-layout"><article class="resource-card resource-portrait fleet-server selected${selected.maintenance?' maintenance-resource':''}" data-resource-machine="${esc(m.id)}"><h2 class="resource-identity" id="${esc(idPrefix)}resource-identity"><button type="button" class="resource-select" data-resource-select="${esc(m.id)}" aria-label="查看 ${esc(m.id)} 显卡详情"><span class="resource-id-label" title="${esc(m.id)}">${esc(m.id)}</span></button></h2><div class="resource-portrait-meta"><span class="resource-spec">${m.cards} × ${esc(m.model)} · ${esc(capacity)} / 卡</span><span>${status}</span></div><div class="maintenance-resource-body"><div class="maintenance-resource-metrics">${chassis(selected,mine,index)}</div>${maintenanceBand(selected)}</div>${maintenanceReason(selected)}<div class="resource-selection" role="status"><span class="mono">GPU ${index}</span><span>${selected.authorized&&selected.observed?`${gib(gpu?.memoryUsedMiB)} / ${gib(gpu?.memoryTotalMiB)} GiB`:'—'}</span><button type="button" class="button quiet" data-resource-select="${esc(m.id)}">显卡详情 ↓</button></div><div class="resource-fleet-actions">${selected.authorized?`<span>${quotaExempt?`不限个人额度 · 已占用 ${known(used)?used:'—'} 张`:`占用 ${known(used)?used:'—'} / ${selected.quota} 张 ${info('quota','了解额度',help.quota)}`}</span><button type="button" class="button quiet" data-use-machine="${esc(m.id)}">在 ${esc(m.id)} 工作</button>`:'<span>未授权</span>'}</div></article><aside class="resource-mini-fleet" aria-label="其他服务器">${views.filter(view=>view!==selected).map(view=>`<article class="resource-card resource-mini fleet-server${view.maintenance?' maintenance-resource':''}" data-resource-machine="${esc(view.machine.id)}"><h2><button type="button" class="resource-select" data-resource-select="${esc(view.machine.id)}" data-resource-swap="true" aria-label="选择 ${esc(view.machine.id)}"><span class="resource-id-label" title="${esc(view.machine.id)}">${esc(view.machine.id)}</span><span class="resource-swap-arrow" aria-hidden="true">→</span></button></h2><p class="resource-spec">${view.machine.cards} × ${esc(view.machine.model)} · ${esc(view.machine.memory)}</p><div class="maintenance-resource-body"><div class="maintenance-resource-metrics">${towers(view,mine)}</div>${maintenanceBand(view)}</div>${maintenanceReason(view)}<p class="resource-fleet-state">${view.status}</p></article>`).join('')}</aside></div><div class="resource-legend" aria-label="显卡图例"><span><i class="mine" aria-hidden="true"></i>我的任务</span><span><i class="used" aria-hidden="true"></i>其他进程</span><span><i class="free" aria-hidden="true"></i>未检测到进程</span><span><i class="unknown" aria-hidden="true"></i>未知</span><span><i class="locked" aria-hidden="true"></i>未授权</span><span><i class="previous" aria-hidden="true"></i>上次采样</span></div></section>${selectedDetail(selected,{admin:management,mine,production,index,idPrefix})}`;
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
    let size=label.closest('.resource-portrait')?160:parseFloat(getComputedStyle(button).fontSize);
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

export function resourcesUI(store,{machines,getPage,navigate}){
  const grid=document.querySelector('#machine-grid'),phone=()=>matchMedia('(max-width:759px)').matches;
  const primary=document.createElement('button');primary.id='resource-primary';primary.type='button';primary.className='button primary';primary.hidden=true;document.querySelector('.heading-actions').prepend(primary);
  const telemetry=document.createElement('div');telemetry.className='resource-head-telemetry';telemetry.hidden=true;telemetry.append(document.querySelector('#resource-summary'),document.querySelector('#monitor-status'));primary.after(telemetry);
  const sheet=document.createElement('dialog');sheet.className='work-sheet resource-sheet';sheet.id='resource-sheet';sheet.setAttribute('aria-labelledby','resource-sheet-title');
  sheet.innerHTML='<header class="sheet-header glass"><h2 id="resource-sheet-title">服务器详情</h2><select data-resource-gpu-picker aria-label="选择显卡"></select><button type="button" class="button quiet" data-resource-back>返回算力</button></header><div class="sheet-scroll"></div><footer class="sheet-footer glass"><button type="button" class="button primary" id="resource-sheet-work"></button></footer>';
  document.body.append(sheet);
  let actor=null,selected=null,levels=new Map(),readings=new Map();const expanded=new Map(),selectedGPUs=new Map();
  const fitIdentity=()=>fitResourceNames(grid);
  const identityResize=new ResizeObserver(()=>fitIdentity());identityResize.observe(grid);
  document.fonts?.addEventListener('loadingdone',()=>fitIdentity(true));
  const identity=()=>store.principal?store.principal.userId+'|'+store.principal.role:null;
  function restoreDetail(){const detail=sheet.querySelector('.resource-detail');if(detail)grid.append(detail);}
  function close(animate=true){
    if(!sheet.open)return;
    if(animate)dismissSheet(sheet,{drilldown:true});else sheet.close();
    restoreDetail();grid.querySelector(`[data-resource-select="${CSS.escape(selected||'')}"]`)?.focus({preventScroll:true});
  }
  function updatePrimary(button,view){
    delete button.dataset.useMachine;delete button.dataset.resourceContact;
    if(view?.authorized){button.dataset.useMachine=view.machine.id;button.innerHTML=`在 ${serverIdHTML(view.machine.id)} 工作`;button.title='在 '+view.machine.id+' 工作';}
    else{button.dataset.resourceContact='true';button.textContent='去协作区联系管理员';button.removeAttribute('title');}
  }
  function applyMeasurements(){
    const nextLevels=new Map(),nextReadings=new Map(),visible=getPage()==='resources'&&!document.hidden;
    for(const root of [grid,sheet]){
      for(const towers of root.querySelectorAll('[data-resource-card-count]'))towers.style.setProperty('--gpu-count',String(Number(towers.dataset.resourceCardCount)||1));
      for(const fill of root.querySelectorAll('[data-resource-level]')){
        const value=Number(fill.dataset.resourceLevel),key=fill.dataset.resourceFillKey,sample=fill.dataset.resourceSample,confirmed=fill.dataset.resourceConfirmed==='true',previous=levels.get(key);
        const newSample=Number.isFinite(Date.parse(sample))&&Date.parse(sample)>Date.parse(previous?.sample),trusted=confirmed&&previous?.confirmed,prior=trusted?newSample?previous.value:sample===previous.sample?previous.prior:null:null;
        fill.style.height=value+'%';nextLevels.set(key,{value,sample,confirmed,prior});
        const line=fill.parentElement.querySelector('.resource-previous'),delta=fill.parentElement.querySelector('.resource-delta'),edge=fill.parentElement.querySelector('.resource-sample-edge');
        if(line){line.hidden=prior===null||prior===undefined;if(!line.hidden)line.style.bottom=prior+'%';}
        if(visible&&fill.getClientRects().length&&trusted&&newSample&&value!==previous.value){
          fill.animate(reducedMotion()?[{opacity:.6},{opacity:1}]:[{height:previous.value+'%'},{height:value+'%'}],{duration:reducedMotion()?150:480,easing:'cubic-bezier(.2,0,0,1)'});
          if(!reducedMotion()&&delta&&edge){delta.style.bottom=Math.min(value,previous.value)+'%';delta.style.height=Math.abs(value-previous.value)+'%';edge.style.bottom=value+'%';for(const element of [delta,edge])element.animate([{opacity:0},{opacity:element===edge?1:.45,offset:.2},{opacity:0}],{duration:480,easing:'cubic-bezier(.2,0,0,1)'});}
        }
      }
      for(const readout of root.querySelectorAll('[data-resource-reading]')){
        const value=Number(readout.dataset.resourceReading),key=readout.dataset.resourceReadingKey,sample=readout.dataset.resourceSample,previous=readings.get(key);nextReadings.set(key,{value,sample});
        if(visible&&readout.getClientRects().length&&previous&&Date.parse(sample)>Date.parse(previous.sample)&&value!==previous.value)readout.animate(reducedMotion()?[{opacity:.6},{opacity:1}]:[{opacity:.6,transform:`translateY(${value>previous.value?3:-3}px)`},{opacity:1,transform:'none'}],{duration:reducedMotion()?150:220,easing:'cubic-bezier(.2,0,0,1)'});
      }
    }
    levels=nextLevels;readings=nextReadings;
  }
  function render(){
    if(actor!==identity()){actor=identity();selected=null;levels.clear();readings.clear();expanded.clear();selectedGPUs.clear();close(false);}
    if(sheet.open&&(!phone()||getPage()!=='resources'))close(false);
    const focused=document.activeElement,focusDetail=focused?.closest('details[data-resource-detail]')?.dataset.resourceDetail,focusInfo=focused?.closest('details[data-resource-info]')?.dataset.resourceInfo,focusSelect=focused?.dataset.resourceSelect,focusCard=focused?.dataset.resourceCard,scrollPositions=new Map();
    const regionKey=region=>region.closest('[data-resource-detail]')?.dataset.resourceDetail||region.closest('[data-resource-machine]')?.dataset.resourceMachine+':chassis';
    for(const root of [grid,sheet])for(const region of root.querySelectorAll('.resource-process-scroll,.gpu-table-scroll,.process-content,.resource-chassis-scroll')){
      const key=regionKey(region);
      if(key)scrollPositions.set(key,{top:region.scrollTop,left:region.scrollLeft});
    }
    for(const root of [grid,sheet])for(const detail of root.querySelectorAll('details[data-resource-detail],details[data-resource-info]'))expanded.set(detail.dataset.resourceDetail||'info:'+detail.dataset.resourceInfo,detail.open);
    const user=store.users.find(row=>row.id===store.principal?.userId),admin=store.principal?.role==='admin',options={limits:user?.limits||{},snapshot:store.data?.gpuq,admin,production:store.production,maintenance:store.data?.operationalMaintenance,quotaExempt:personalQuotaReadout(user).exempt};
    const views=machines.map(machine=>resourceServerView(machine,options));
    if(!views.some(view=>view.machine.id===selected))selected=(views.find(view=>view.authorized)||views[0])?.machine.id||null;
    const view=views.find(view=>view.machine.id===selected);
    const remembered=selectedGPUs.get(selected),index=Number.isSafeInteger(remembered)&&remembered>=0&&remembered<view?.count?remembered:0;
    grid.innerHTML=resourceCards({machines,...options,management:false,selectedMachine:selected,selectedGPU:index,userId:store.principal?.userId,jobs:store.jobs,usage:id=>user?store.usage(user.id,id):null});
    if(sheet.open){sheet.querySelector('.sheet-scroll').replaceChildren(grid.querySelector('.resource-detail'));sheet.querySelector('#resource-sheet-title').textContent=selected;sheet.querySelector('#resource-sheet-title').title=selected;}
    primary.hidden=telemetry.hidden=!store.principal||getPage()!=='resources';updatePrimary(primary,view);updatePrimary(sheet.querySelector('#resource-sheet-work'),view);
    const picker=sheet.querySelector('[data-resource-gpu-picker]');picker.innerHTML=Array.from({length:view?.count||0},(_,number)=>`<option value="${number}">GPU ${number}</option>`).join('');picker.value=String(index);
    for(const root of [grid,sheet])for(const detail of root.querySelectorAll('details[data-resource-detail],details[data-resource-info]')){const key=detail.dataset.resourceDetail||'info:'+detail.dataset.resourceInfo;if(expanded.has(key))detail.open=expanded.get(key);if(focusDetail&&focusDetail===detail.dataset.resourceDetail||focusInfo&&focusInfo===detail.dataset.resourceInfo)detail.querySelector('summary')?.focus({preventScroll:true});}
    for(const root of [grid,sheet])for(const region of root.querySelectorAll('.resource-process-scroll,.gpu-table-scroll,.process-content,.resource-chassis-scroll')){
      const previous=scrollPositions.get(regionKey(region));
      if(previous){region.scrollTop=previous.top;region.scrollLeft=previous.left;}
    }
    if(focusSelect)grid.querySelector(`[data-resource-select="${CSS.escape(focusSelect)}"]`)?.focus({preventScroll:true});
    if(focusCard!==undefined)grid.querySelector(`[data-resource-card="${CSS.escape(focusCard)}"]`)?.focus({preventScroll:true});
    fitIdentity();applyMeasurements();
  }
  function select(id,drilldown=true,fromControl=false){
    if(!store.principal||!machines.some(machine=>machine.id===id))return;
    const changed=id!==selected,source=!fromControl&&changed?captureObject(grid.querySelector(`[data-resource-machine="${CSS.escape(id)}"] .resource-id-label`)):null;
    selected=id;render();
    if(changed&&!drilldown&&!fromControl){sharedObject(source,grid.querySelector('.resource-identity .resource-id-label'),{uniformScale:true});grid.querySelector('.resource-chassis')?.animate([{opacity:0},{opacity:1}],{duration:150,easing:'linear'});const heading=grid.querySelector('.resource-identity');if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}}
    if(fromControl){grid.querySelector('.resource-fleet')?.scrollIntoView({block:'start',behavior:'instant'});const heading=grid.querySelector('.resource-identity');if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}}
    if(phone()&&drilldown&&!sheet.open){
      sheet.querySelector('.sheet-scroll').replaceChildren(grid.querySelector('.resource-detail'));sheet.querySelector('#resource-sheet-title').textContent=id;sheet.querySelector('#resource-sheet-title').title=id;
      sheet.querySelector('.sheet-scroll').scrollTop=0;
      // A new foreground action replaces an unfinished visual-only exit.
      for(const ghost of document.querySelectorAll('.object-transition-layer'))ghost.remove();
      sheet.showModal();revealSheet(sheet,{drilldown:true});sheet.querySelector('[data-resource-back]').focus({preventScroll:true});
    }else if(!phone()&&drilldown){
      const detail=grid.querySelector('.resource-detail');detail?.scrollIntoView({block:'start',behavior:'instant'});
      const heading=detail?.querySelector('h2');if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}
    }
  }
  document.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button||button.disabled||button!==primary&&!grid.contains(button)&&!sheet.contains(button))return;
    if(button.dataset.resourceSelect)select(button.dataset.resourceSelect,!button.hasAttribute('data-resource-swap'));
    if(button.hasAttribute('data-resource-card')&&button.dataset.resourceServer===selected){selectedGPUs.set(selected,Number(button.dataset.resourceCard));render();}
    if(button.dataset.resourceContact)navigate('community');
    if(button.hasAttribute('data-resource-back'))close();
  });
  sheet.addEventListener('cancel',event=>{event.preventDefault();close();});sheet.addEventListener('click',event=>{if(event.target===sheet)close();});
  sheet.addEventListener('change',event=>{if(event.target.hasAttribute('data-resource-gpu-picker')){selectedGPUs.set(selected,Number(event.target.value));render();}});
  document.addEventListener('gpuq-open-resource',event=>{if(event.detail?.userId!==store.principal?.userId||getPage()!=='resources')return;select(event.detail.machine,phone(),true);});
  store.onAuthChange(()=>{close(false);sheet.querySelector('.sheet-scroll').replaceChildren();grid.replaceChildren();primary.hidden=telemetry.hidden=true;actor=null;selected=null;levels.clear();readings.clear();expanded.clear();selectedGPUs.clear();});
  addEventListener('resize',()=>{if(sheet.open&&!phone())close(false);});
  return render;
}
