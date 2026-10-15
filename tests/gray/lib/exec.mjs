import {approvedMember} from './accounts.mjs';
import {waitFor} from './context.mjs';
export const terminalStates=['SUCCEEDED','FAILED','CANCELED'];
export const call=async(ctx,member,operation,args={})=>(await ctx.client.call(member.token,operation,args)).result;
export async function project(ctx){
  const member=await approvedMember(ctx,'a');
  if(!ctx.shared.project){
    const name=ctx.name('project');ctx.shared.project={name,member};
    await call(ctx,member,'projects.create',{machine:ctx.machine,project:name,repo:'http://172.30.77.40:8000/fixture.git'});
  }
  const result=await waitFor(()=>call(ctx,member,'projects.status',{machine:ctx.machine,project:ctx.shared.project.name}),v=>['COMPLETE','FAILED'].includes(v.cloneState),{timeoutMs:180000,what:'Git 克隆'});
  ctx.check('Git 克隆完成',result.cloneState==='COMPLETE',result.cloneError);
  return ctx.shared.project;
}
export async function download(ctx,member,args){
  let offset=0;const chunks=[];
  for(;;){const result=await call(ctx,member,'files.get',{machine:ctx.machine,...args,offset});
    const bytes=Buffer.from(result.data,'base64');chunks.push(bytes);offset+=bytes.length;
    if(result.eof)return Buffer.concat(chunks);
    ctx.check('下载偏移前进',bytes.length>0);
  }
}
export async function upload(ctx,member,{content,path,key=ctx.key(),stopAfter,chunkSize=128*1024,...target}){
  const base={machine:ctx.machine,...target,key};
  const started=await call(ctx,member,'data.upload.begin',{...base,path,totalSize:content.length});
  let offset=started.offset;
  while(offset<content.length){
    const end=Math.min(content.length,offset+chunkSize);
    if(stopAfter!==undefined&&end>stopAfter)return {key,offset};
    const result=await call(ctx,member,'data.upload.chunk',{...base,offset,data:content.subarray(offset,end).toString('base64')});
    ctx.check('上传偏移按字节前进',result.offset===end);offset=end;
  }
  const result=await call(ctx,member,'data.upload.finish',base);
  ctx.check('上传完成且字节数正确',result.state==='COMPLETE'&&result.offset===content.length);return {key,offset};
}
export async function trashRestore(ctx,member,{key,remove,args,kind}){
  const removed=await call(ctx,member,remove,{...args,key});ctx.check('删除进入回收站',removed.state==='TRASHED');
  const trash=await call(ctx,member,'projects.retire.list',{machine:ctx.machine});
  ctx.check('回收站可见 '+kind,trash.items.some(row=>row.key===key&&row.kind===kind));
  const restored=await call(ctx,member,'projects.retire.restore',{machine:ctx.machine,key});ctx.check('恢复成功',restored.state==='RESTORED');
}
export async function submit(ctx,member,projectName,argv,extra={}){
  return call(ctx,member,'jobs.submit',{machine:ctx.machine,project:projectName,cards:1,minVramGiB:0,name:'灰度任务',key:ctx.key(),argv,...extra});
}
export async function waitJob(ctx,member,id,states,{timeoutMs=120000}={}){
  return waitFor(()=>call(ctx,member,'jobs.watch',{jobId:id}),v=>states.includes(v.state),{timeoutMs,what:'任务 '+id+' 到达 '+states.join('/')});
}
export async function openTerminal(ctx,member,projectName,extra={}){
  const ownerId=ctx.shared.project.member.userId;
  const opened=await call(ctx,member,'terminal.open',{machine:ctx.machine,project:projectName,ownerId,key:ctx.key(),clientId:ctx.key(),mode:'new',...extra});
  ctx.check('终端取得写入连接',!!opened.writerToken&&!!opened.id,opened);
  const terminal={machine:ctx.machine,project:projectName,ownerId,id:opened.id,clientId:opened.clientId,writerToken:opened.writerToken};
  await waitFor(()=>call(ctx,member,'terminal.exchange',{...terminal,offset:0}),v=>typeof v.data==='string'&&!v.exited,{what:'终端就绪'});
  return terminal;
}
export async function terminalCommand(ctx,member,terminal,input,marker){
  let offset=0,output='';
  const exchange=async input=>{
    const value=await call(ctx,member,'terminal.exchange',{...terminal,offset,...(input?{input:Buffer.from(input).toString('base64')}:{})});
    if(value.data)output+=Buffer.from(value.data,'base64').toString();offset=value.offset??offset;
    ctx.check('终端响应无业务错误',!value.error,value.error);return value;
  };
  await exchange(input); // 输入只发送一次；后续轮询只有读取。
  await waitFor(async()=>{const value=await exchange();ctx.check('终端未提前退出',!value.exited||output.includes(marker));return output;},text=>text.includes(marker),{what:'终端命令完成'});
  return output;
}
