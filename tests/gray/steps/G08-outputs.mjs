import {AssertionFailure} from '../lib/context.mjs';
import training from './G07-training.mjs';
import {call,download,trashRestore,submit,waitJob,terminalStates,openTerminal,terminalCommand} from '../lib/exec.mjs';
import {closeObserved} from '../lib/terminal-observation.mjs';
export async function trained(ctx){if(!ctx.shared.trained?.length&&ctx.shared.trainingError)throw new AssertionFailure('训练前置失败，未产生可下载输出：'+ctx.shared.trainingError);if(!ctx.shared.trained?.length)await training.run(ctx);return ctx.shared.trained[0];}
export default {features:["训练输出：浏览、下载、删除（进回收站，可恢复）"],id:'G08',title:'输出浏览下载、删除恢复（FEATURES 五）',level:'fast',async run(ctx){
  const item=await trained(ctx),{member,jobId}=item,args={machine:ctx.machine,area:'output',runId:jobId};
  const list=await call(ctx,member,'files.list',{...args,path:''});
  ctx.check('输出列表包含 result.json',list.entries.some(e=>e.name==='result.json'));
  const bytes=await download(ctx,member,{...args,path:'result.json'});
  ctx.check('下载输出字节正确',bytes.equals(Buffer.from(item.bytes,'base64')));
  await trashRestore(ctx,member,{key:ctx.key(),remove:'outputs.delete',args:{jobId,path:'result.json'},kind:'output'});
  ctx.check('恢复输出字节不变',(await download(ctx,member,{...args,path:'result.json'})).equals(bytes));
  const source='/job-outputs/'+jobId+'/result.json';
  const shared='/job-outputs/'+jobId+'/';
  const read='from pathlib import Path; import base64, shutil; raw=Path('+JSON.stringify(source)+').read_bytes(); assert raw==base64.b64decode('+JSON.stringify(item.bytes)+')';
  const terminal=await openTerminal(ctx,member,item.project);
  try{
    const copy='; shutil.copyfile('+JSON.stringify(source)+','+JSON.stringify(shared+'terminal-copy.json')+')';
    const output=await terminalCommand(ctx,member,terminal,"python -c '"+read+copy+'; print("GRAY_"+"HISTORY_OK")'+"'\n",'GRAY_HISTORY_OK');
    ctx.check('开发终端直接读写本容器历史任务输出',output.includes('GRAY_HISTORY_OK'));
    ctx.check('开发终端复制的文件可从原任务下载',(await download(ctx,member,{...args,path:'terminal-copy.json'})).equals(bytes));
  }finally{await closeObserved(ctx,member,terminal);}
  const copy='; shutil.copyfile('+JSON.stringify(shared+'terminal-copy.json')+',"/outputs/comparison.json"); shutil.copyfile("/outputs/comparison.json",'+JSON.stringify(shared+'task-copy.json')+')';
  const comparison=await submit(ctx,member,item.project,['python','-c',read+copy]);
  try{
    const ended=await waitJob(ctx,member,comparison.id,terminalStates);
    ctx.check('后续任务读取、复制和写入前序输出并成功结束',ended.state==='SUCCEEDED',ended);
    ctx.check('比较任务单独保存输出',(await download(ctx,member,{area:'output',runId:comparison.id,path:'comparison.json'})).equals(bytes));
    ctx.check('后续任务写回的文件可从原任务下载',(await download(ctx,member,{...args,path:'task-copy.json'})).equals(bytes));
    ctx.check('前序任务输出仍在原位置且字节不变',(await download(ctx,member,{...args,path:'result.json'})).equals(bytes));
  }finally{
    const current=await call(ctx,member,'jobs.watch',{jobId:comparison.id});
    if(!terminalStates.includes(current.state)){await call(ctx,member,'jobs.cancel',{jobId:comparison.id});await waitJob(ctx,member,comparison.id,terminalStates);}
  }
}};
