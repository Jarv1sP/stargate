import {infoHTML,escapeUI as escape} from './workbench-ui.js';
import {progressPercent,progressText} from './job-progress.js';
export function jobProgressHTML(job){
  const progress=job.progress,s=progress?.snapshot,percent=progressPercent(progress);
  const metrics=s?Object.entries(s.metrics||{}).slice(0,4).map(([key,value])=>key+'='+Number(value).toPrecision(5)).join(' · '):'';
  return `<div class="task-progress"><small>${escape(progressText(progress).replaceAll('训练自报','训练上报'))}</small>${percent===null?'':`<progress max="100" value="${percent}" aria-label="${escape(job.name)} 的训练上报进度">${percent}%</progress>`}${metrics?`<small>${escape(metrics)}</small>`:''}${s?infoHTML('进度来自训练上报。任务完成由服务器确认。','进度来源'):''}${job.latestAttempt?.exitCode===null||job.latestAttempt?.exitCode===undefined?'':`<small>退出码：${escape(job.latestAttempt.exitCode)}</small>`}${job.latestAttempt?.failureReason?`<small class="task-error">${escape(job.latestAttempt.failureReason)}</small>`:''}</div>`;
}

export function jobNotificationHTML(job,userId){
  if(!job.notifications?.configured)return '';
  if(job.notifications.degraded)return '<small>通知存储暂不可用</small>';
  const enabled=job.notifications.enabled===true,terminal=['SUCCEEDED','FAILED','CANCELED'].includes(job.state);
  return `<button class="button" data-job-notify="${escape(job.id)}" ${terminal&&!enabled?'disabled':''}>${enabled?'关闭 Telegram 通知':'开启 Telegram 通知'}</button>`;
}
