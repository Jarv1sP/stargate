import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {approvedMember} from '../lib/accounts.mjs';
import {call,upload,download,trashRestore} from '../lib/exec.mjs';
export default {id:'G06',title:'数据集上传续传、追加、下载与恢复（FEATURES 六）',level:'fast',async run(ctx){
  const member=await approvedMember(ctx,'a'),dataset=ctx.name('digits');
  const {stdout}=await promisify(execFile)('python3',[fileURLToPath(new URL('../datasets/generate.py',import.meta.url)),ctx.artifacts]);
  const generated=JSON.parse(stdout),folder=generated.directory;
  const files=['labels.csv',...(await readdir(join(folder,'images'))).sort().map(n=>'images/'+n)];
  ctx.check('固定夹具有 601 个文件',files.length===601&&generated.files===601&&generated.bytes>450000&&generated.bytes<600000);
  // 第一个文件停止于 64 字节，再用原 key 和原参数继续。
  const first=files.shift(),content=await readFile(join(folder,first));
  const partial=await upload(ctx,member,{dataset,area:'dataset',path:first,content,chunkSize:64,stopAfter:64});
  const status=await call(ctx,member,'data.upload.status',{machine:ctx.machine,key:partial.key});
  ctx.check('数据集中断后偏移保留',status.offset===64&&status.state==='UPLOADING');
  await upload(ctx,member,{dataset,area:'dataset',path:first,content,key:partial.key});
  // 两路上传只影响本轮夹具；每个文件的 begin/chunk/finish 仍按顺序执行。
  let next=0;
  const worker=async()=>{while(next<files.length){const path=files[next++];await upload(ctx,member,{dataset,area:'dataset',path,content:await readFile(join(folder,path))});}};
  const uploads=await Promise.allSettled([worker(),worker()]);
  const failed=uploads.find(result=>result.status==='rejected');if(failed)throw failed.reason;
  const extra=Buffer.from('gray append\n');await upload(ctx,member,{dataset,area:'dataset',path:'extra.txt',content:extra});
  ctx.shared.dataset={name:dataset,files:generated.files+1,bytes:generated.bytes+extra.length,member};
  const list=await call(ctx,member,'datasets.list',{machine:ctx.machine}),row=list.datasets.find(d=>d.name===dataset);
  ctx.check('列表有名称、大小、上传人、修改时间',row&&row.size===ctx.shared.dataset.bytes&&row.uploadedBy===member.userId&&row.modifiedAt>0,row);
  const browsing=await call(ctx,member,'files.list',{machine:ctx.machine,area:'dataset',dataset,path:''});
  ctx.check('可浏览数据集文件',browsing.entries.some(e=>e.name==='labels.csv')&&browsing.entries.some(e=>e.name==='images'));
  ctx.check('下载标签文件字节一致',(await download(ctx,member,{area:'dataset',dataset,path:first})).equals(content));
  ctx.check('追加文件字节一致',(await download(ctx,member,{area:'dataset',dataset,path:'extra.txt'})).equals(extra));
  await trashRestore(ctx,member,{key:ctx.key(),remove:'datasets.delete',args:{machine:ctx.machine,dataset},kind:'dataset'});
  ctx.check('恢复后文件存在且字节一致',(await download(ctx,member,{area:'dataset',dataset,path:first})).equals(content));
  ctx.todo('single-node-copy','复制到其他服务器未测');
}};
