import {setTimeout as delay} from 'node:timers/promises';
import {JOB_TERMINAL,feedbackKey,jobFeedbackText,watchExitCode} from './dist/job-progress.js';
import {nativeObservationText} from './job-observation.mjs';

export async function watchJob(call,jobId,{interval=5,json=false,signal,write=chunk=>process.stdout.write(chunk)}={}){
  if(typeof jobId!=='string'||!jobId||jobId.length>256)throw Error('Use watch JOB_ID');
  if(!Number.isFinite(interval)||interval<1||interval>60)throw Error('--interval must be 1–60 seconds');
  let previous;
  while(!signal?.aborted){
    let job;
    try{job=(await call('jobs.watch',{jobId},signal)).result;}
    catch(error){if(signal?.aborted)return 130;if(error.status!==undefined&&![429,502,503,504].includes(error.status))throw error;write(json?JSON.stringify({id:jobId,state:'UNKNOWN'})+'\n':'暂时无法读取，正在查询原任务。\n');await delay(interval*1000,undefined,{signal}).catch(error=>{if(!signal?.aborted)throw error;});continue;}
    if(signal?.aborted)return 130;
    if(!job||job.id!==jobId||typeof job.state!=='string')throw Error('Server returned an invalid task watch response');
    const key=feedbackKey(job);
    if(key!==previous){write(json?JSON.stringify(job)+'\n':(job.nativeObservation?'门户历史结果（命令退出码仍按此结果）：\n':'')+jobFeedbackText(job)+(job.nativeObservation?'\n'+nativeObservationText(job.nativeObservation):'')+'\n\n');previous=key;}
    if(JOB_TERMINAL.has(job.state))return watchExitCode(job);
    try{await delay(interval*1000,undefined,{signal});}catch(error){if(error.name!=='AbortError')throw error;}
  }
  return 130;
}
