import {randomUUID} from 'node:crypto';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function httpsURL(value){
  let parsed;try{parsed=new URL(value);}catch{throw Error('请输入完整 HTTPS 下载链接。');}
  if(typeof value!=='string'||value.length>16384||/[\x00-\x20\x7f]/.test(value)||parsed.protocol!=='https:')throw Error('请使用 HTTPS 下载链接。');
  return parsed.href;
}
export async function runCloudImport({action,positionals,options,machine,call,stderr=process.stderr}){
  const allowed=['machines','datasets','url','session-file','json','key','file-id','password-code','source-url','dataset','project','owner'];
  if(Object.keys(options).some(k=>!allowed.includes(k))||options.datasets?.length)throw Error('导入参数无效。');
  if(options['source-url']!==undefined&&action!=='import-resume')throw Error('--source-url 仅用于 data import-resume ID，更新同一文件的过期链接。');
  if(action!=='import'&&['key','file-id','password-code'].some(k=>options[k]!==undefined))throw Error('新建导入参数不能用于查询、取消或继续。');
  if(action==='imports'){if(positionals.length!==2)throw Error('Usage: data imports');return (await call('cloud.import.list',{machine})).result;}
  if(['import-status','import-cancel','import-resume','import-discard'].includes(action)){
    if(positionals.length!==3||!UUID.test(positionals[2]))throw Error('Usage: data '+action+' UUID'+(action==='import-resume'?' [--source-url HTTPS_LINK]':''));
    const args={machine,operationId:positionals[2]};
    if(options['source-url']!==undefined)args.url=httpsURL(options['source-url']);
    const result=(await call('cloud.import.'+action.slice(7),args)).result;
    if(action==='import-cancel')stderr.write(result?.state==='CANCELING'?'正在取消；临时文件仍保留，可稍后继续同一任务。请查询状态确认已停止。\n':'取消不会删除已下载的临时文件；可继续同一任务。\n');
    if(action==='import-discard')stderr.write('已清理导入记录；已完成的目标文件保留。\n');
    return result;
  }
  if(action!=='import'||positionals.length<3||positionals.length>4)throw Error('Usage: data import LINK [REMOTE_FILE] [--file-id ID]');
  if(options.key!==undefined&&!UUID.test(options.key))throw Error('--key 必须是之前保留的 UUID 导入标识。');
  const url=httpsURL(positionals[2]),reference=new URL(url),isAliyun=['alipan.com','www.alipan.com','aliyundrive.com','www.aliyundrive.com'].includes(reference.hostname);
  let args;
  if(isAliyun){
    const scan=(await call('cloud.inspect',{machine,url,password:options['password-code']||''})).result;
    if(!scan.files.length)throw Error('分享根目录没有文件；请先压缩后分享。');
    const file=options['file-id']?scan.files.find(f=>f.id===options['file-id']):scan.files.length===1?scan.files[0]:null;
    if(!file)return {files:scan.files,next:'重复命令并加 --file-id FILE_ID 选择一个文件。'};
    args={machine,inspectionId:scan.inspectionId,fileId:file.id,path:positionals[3]||'incoming/'+file.name};
  }else{
    if(options['file-id']!==undefined||options['password-code']!==undefined)throw Error('--file-id 和 --password-code 仅用于阿里云盘分享。');
    if(!positionals[3])throw Error('HTTPS 下载需指定保存文件名：data import LINK incoming/data.zip');
    args={machine,url,path:positionals[3]};
  }
  if(!options.dataset&&!options.project)throw Error('用 --dataset NAME 或 --project NAME 选择目标。');
  Object.assign(args,options.dataset?{area:'dataset',dataset:options.dataset}:{area:'code',project:options.project});
  args.key=options.key||randomUUID();stderr.write('导入标识：'+args.key+'（响应不明时先用 data import-status 查询，再以 --key 沿用此标识重试；不要创建新标识）\n');
  try{return (await call('cloud.import.start',args)).result;}
  catch(error){
    stderr.write('请保留导入标识 '+args.key+'；先运行 gpuctl data import-status '+args.key+' 并选择同一服务器核对。原命令重试时加 --key '+args.key+'。\n');
    throw error;
  }
}
