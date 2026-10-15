import {AssertionFailure} from '../lib/context.mjs';
import training from './G07-training.mjs';
import {call,download,trashRestore} from '../lib/exec.mjs';
export async function trained(ctx){if(!ctx.shared.trained?.length&&ctx.shared.trainingError)throw new AssertionFailure('训练前置失败，未产生可下载输出：'+ctx.shared.trainingError);if(!ctx.shared.trained?.length)await training.run(ctx);return ctx.shared.trained[0];}
export default {id:'G08',title:'输出浏览下载、删除恢复（FEATURES 五）',level:'fast',async run(ctx){
  const item=await trained(ctx),{member,jobId}=item,args={machine:ctx.machine,area:'output',runId:jobId};
  const list=await call(ctx,member,'files.list',{...args,path:''});
  ctx.check('输出列表包含 result.json',list.entries.some(e=>e.name==='result.json'));
  const bytes=await download(ctx,member,{...args,path:'result.json'});
  ctx.check('下载输出字节正确',bytes.equals(Buffer.from(item.bytes,'base64')));
  await trashRestore(ctx,member,{key:ctx.key(),remove:'outputs.delete',args:{jobId,path:'result.json'},kind:'output'});
  ctx.check('恢复输出字节不变',(await download(ctx,member,{...args,path:'result.json'})).equals(bytes));
}};
