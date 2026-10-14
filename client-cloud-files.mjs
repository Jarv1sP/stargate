import {randomUUID} from 'node:crypto';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail=message=>{throw Error(message);};
export async function runCloudFiles({positionals,options,machine,call,stderr=process.stderr}){
  const action=positionals[2]||'list',expected={info:3,list:3,status:4,cancel:4,download:5,upload:4};
  if(!Object.hasOwn(expected,action)||positionals.length!==expected[action])fail('Usage: data cloud info|list | download FILE_ID PATH | upload PATH | status|cancel OPERATION_ID');
  if(options.datasets?.length||Object.keys(options).some(k=>!['machines','datasets','url','session-file','json','key','dataset','project'].includes(k)))fail('云文件参数无效，请运行 gpuctl help。');
  const args={machine};
  if(['download','upload'].includes(action)){
    args.key=options.key||randomUUID();if(!UUID.test(args.key))fail('Use a complete UUID --key');
    stderr.write(`Cloud operation: ${args.key}. A lost response is not permission to repeat an upload with a new key.\n`);
  }else if(options.key)fail('--key is only valid for download or upload');
  if(action==='download'){args.fileId=positionals[3];const listing=(await call('cloud.files.list',{machine})).result;const file=listing.files?.find(row=>row.id===args.fileId);if(!Number.isSafeInteger(file?.size)||file.size<0)fail('暂未读到这个云文件的大小，请稍后刷新云文件列表后重试。');args.size=file.size;}
  if(['status','cancel'].includes(action)){if(!UUID.test(positionals[3]))fail('Use the complete cloud operation UUID');args.operationId=positionals[3];}
  if(['download','upload'].includes(action)){
    args.path=positionals[action==='download'?4:3];
    if(!args.path||/[\\\x00-\x1f\x7f]/.test(args.path)||args.path.split('/').some(p=>!p||p==='.'||p==='..'||Buffer.byteLength(p)>255)||Buffer.byteLength(args.path)>1024)fail('Use a relative filename within the dataset or /workspace');
  }
  if(['download','upload'].includes(action)){if(!options.dataset&&!options.project)fail('用 --dataset NAME 或 --project NAME 选择服务器上的目录。');Object.assign(args,options.dataset?{area:'dataset',dataset:options.dataset}:{area:'code',project:options.project});}
  return {...(await call('cloud.files.'+action,args)).result,machine};
}
