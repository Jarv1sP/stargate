import {normalizeAttempt,normalizeProgress,jobTiming} from './dist/job-progress.js';
const states=new Set(['PENDING','STARTING','RUNNING','PREEMPTING','SUCCEEDED','FAILED','CANCELED','LOST']);
const terminal=new Set(['SUCCEEDED','FAILED','CANCELED']);
export function unavailableObservation(reason='UNAVAILABLE'){
 return {readOnly:true,status:'UNKNOWN',retryDetected:false,manualRecovery:{required:true,reason},message:'节点暂未响应，请按原任务编号稍后查询；不会重新提交。'};
}
export function terminalNativeObservation(job,result){
 if(!states.has(result?.state))return unavailableObservation();
 const latestAttempt=normalizeAttempt(result.latestAttempt);
 return {readOnly:true,status:'CONFIRMED',nodeJobId:result.nodeJobId??job.nodeJobId??null,state:result.state,
  observedAt:Date.now()/1000,latestAttempt,progress:normalizeProgress(result.progress),retryDetected:(latestAttempt?.ordinal??1)>1,
  manualRecovery:{required:false,reason:null},message:'节点当前状态。'};
}
export const portalTerminalSnapshot=job=>({state:job.state,cancelRequested:job.cancelRequested===true,...jobTiming(job)});
export function jobCompletion(job,result){
 const nativeObservation=terminalNativeObservation(job,result),completed=terminal.has(result?.state);
 return {readOnly:true,jobId:job.id,machine:job.machine,userId:job.userId,nodeJobId:result?.nodeJobId??job.nodeJobId??null,
  project:job.spec?.project??job.project??null,submission:{key:job.key??null},portalHistory:portalTerminalSnapshot(job),
  completed,state:completed?result.state:result?.state??'UNKNOWN',nativeObservation,
  ...(completed?{completedAttempt:nativeObservation.latestAttempt,observedAt:nativeObservation.observedAt}:{}),
  message:completed?'训练已结束。':'任务尚未结束或节点暂未响应，请按原编号查询。'};
}
export function nativeObservationText(value){
 if(!value)return '';
 if(value.status!=='CONFIRMED')return '节点状态未知，请按原任务编号稍后查询。';
 return `节点当前状态：${value.state}${value.latestAttempt?.ordinal?` · 第 ${value.latestAttempt.ordinal} 次运行`:''}`;
}
