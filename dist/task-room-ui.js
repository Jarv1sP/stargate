import {escapeUI as esc,endedJob,missionGPUs,elapsedTraining,trainingReadout,trajectoryHTML,infoHTML} from './workbench-ui.js';

export function filterTaskJobs(jobs,{scope='mine',userId,machine,project,ownerId,search='',state=''}={}){
  const text=search.trim().toLocaleLowerCase();
  return jobs.filter(job=>{
    if(scope==='mine'&&job.userId!==userId)return false;
    if(scope==='project'&&(!machine||!project||job.machine!==machine||job.project!==project||ownerId&&(job.ownerId||job.userId)!==ownerId))return false;
    if(state&&job.state!==state)return false;
    return !text||[job.id,job.name,job.description,job.username,job.project,job.machine].some(value=>String(value||'').toLocaleLowerCase().includes(text));
  });
}

export function taskDashboardHTML(job,{snapshot,machines=[],now=Date.now()/1000}={}){
  // A finished allocation can already belong to another task. Do not display its
  // current device readings as the finished task's resource usage.
  const live=['RUNNING','STARTING'].includes(job.state),gpus=live?missionGPUs(job,snapshot,machines):[];
  const utilization=gpus.length&&gpus.every(gpu=>gpu.utilization!==null)?Math.round(gpus.reduce((sum,gpu)=>sum+gpu.utilization,0)/gpus.length):null;
  const memoryKnown=gpus.length&&gpus.every(gpu=>gpu.known),elapsed=elapsedTraining(job,now),readout=trainingReadout(job);
  const used=memoryKnown?(gpus.reduce((sum,gpu)=>sum+gpu.usedMiB,0)/1024).toFixed(1):null,total=memoryKnown?(gpus.reduce((sum,gpu)=>sum+gpu.totalMiB,0)/1024).toFixed(1):null;
  return `<section class="task-dashboard" data-task-dashboard data-task-state="${esc(job.state)}" aria-label="任务实时仪表盘"><dl class="task-hud"><div><dt>GPU 利用率</dt><dd data-task-metric="gpu">${utilization===null?'未知':utilization+'%'}</dd></div><div><dt>${endedJob(job)?'运行时长 T+':['PENDING','QUEUED'].includes(job.state)?'等待显卡':'已运行 T+'}</dt><dd class="mono" data-task-elapsed>${elapsed||(['PENDING','QUEUED'].includes(job.state)?'排队中':'未知')}</dd></div><div><dt>显存</dt><dd data-task-metric="vram">${memoryKnown?used+' / '+total+' GiB':'未知'}</dd></div></dl>${gpus.length?`<ul class="task-gpu-readings" aria-label="本次分配的显卡">${gpus.map(gpu=>`<li data-task-gpu="${gpu.index}">GPU ${gpu.index} · ${gpu.utilization===null?'利用率未知':gpu.utilization+'%'} · ${gpu.known?gpu.used+' / '+gpu.total+' GiB':'显存未知'}</li>`).join('')}</ul>`:'<p class="muted">'+(endedJob(job)?'任务已结束，实时显卡读数不再属于本任务。':'显卡尚未分配或采集未知。')+'</p>'}<div class="task-training-readout"><span>训练上报 ${readout.percent===null?'未知':readout.percent+'%'}</span>${readout.epoch?`<span>${esc(readout.epoch)}</span>`:''}${readout.completionPending?'<span>完成待确认</span>':''}${infoHTML(readout.description,'进度状态')}${readout.metrics.map(([key,value])=>`<span>${esc(key)} <strong>${esc(value)}</strong></span>`).join('')}</div>${trajectoryHTML(job)}${job.state==='SUCCEEDED'?'<div data-task-completion role="status"><span data-completion-illustration="tower-catch" aria-hidden="true"></span>任务已完成</div>':''}</section>`;
}

export function taskFiltersHTML(){
  return '<div class="task-toolbar" data-task-filters><div role="group" aria-label="任务范围"><button class="button quiet" type="button" data-task-scope="mine" aria-pressed="true">我的</button><button class="button quiet" type="button" data-task-scope="project" aria-pressed="false">本项目</button><button class="button quiet" type="button" data-task-scope="all" aria-pressed="false">全部</button></div><label>搜索任务<input type="search" name="task-search" placeholder="名称、编号、项目或成员"></label><label>状态<select data-job-history-filter><option value="">全部状态</option><option value="FAILED">失败</option></select></label><label data-task-project-field hidden>本项目<select name="task-project" aria-label="筛选项目"></select></label><p data-task-list-status role="status" aria-live="polite"></p></div>';
}
