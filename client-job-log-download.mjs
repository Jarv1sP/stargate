import {downloadFile} from './client-file-download.mjs';

// Use the ordinary file downloader: original source/offset, size and atomic save.
// The attempt is a file selector, so a retry cannot switch to a newer run.
export async function downloadJobLog(call,{jobId,destination,origin,userId}){
 const result=(await call('jobs.logs',{jobId,download:true})).result;
 if(!result?.attemptId)throw Error('运行日志暂不可用，请按原任务编号稍后查询。');
 return downloadFile((_operation,request)=>call('jobs.logs',{
  jobId:request.runId,download:true,attemptId:request.path,offset:request.offset
 }),{context:{runId:jobId},path:result.attemptId,destination,origin,userId});
}
