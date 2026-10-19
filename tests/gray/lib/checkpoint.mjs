import {readFile} from 'node:fs/promises';
import {approvedMember} from './accounts.mjs';
import {upload,submit,call,waitJob,terminalStates} from './exec.mjs';
import {waitFor} from './context.mjs';
export async function checkpoint(ctx,member,project){
  await upload(ctx,member,{area:'code',project,path:'gray-checkpoint.py',content:await readFile(new URL('../fixtures/checkpoint.py',import.meta.url))});
  const jobs=[],other=await approvedMember(ctx,'b');
  try{
    const job=await submit(ctx,member,project,['python','-u','gray-checkpoint.py'],{cards:2,scheduling:{rank:'P0',yieldPolicy:'save',restartPolicy:'on-preempt',checkpointable:true}});jobs.push([job.id,member]);
    const progress=await waitFor(()=>call(ctx,member,'jobs.watch',{jobId:job.id}),r=>r.progress?.reported||terminalStates.includes(r.state),{what:'SDK进度上报'});
    ctx.check('SDK进度真实上报',progress.progress?.reported===true&&progress.progress.snapshot.epochsCompleted>0,progress);
    const preemptor=await submit(ctx,other,project,['python','-u','-c','import time;time.sleep(10)'],{cards:2,ownerId:member.userId,scheduling:{rank:'P4',yieldPolicy:'never',restartPolicy:'never',checkpointable:false,mode:'preempt-save'}});jobs.push([preemptor.id,other]);
    await waitJob(ctx,other,preemptor.id,terminalStates);
    const resumed=await waitJob(ctx,member,job.id,terminalStates,{timeoutMs:180000});
    const logs=await call(ctx,member,'jobs.logs',{jobId:job.id});
    ctx.check('原任务从checkpoint恢复成功',resumed.state==='SUCCEEDED'&&resumed.latestAttempt?.ordinal>=2&&logs.text.includes('GRAY_RESUMED'),resumed);
  }finally{for(const [jobId,actor] of jobs.reverse()){await call(ctx,actor,'jobs.cancel',{jobId});await waitJob(ctx,member,jobId,terminalStates);}}
}
