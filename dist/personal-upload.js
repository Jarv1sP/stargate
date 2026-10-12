// The same resumable file protocol for the browser and CLI. No publication.
const CHUNK=1024*1024;
const encode=bytes=>{let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text);};

export async function uploadPersonalFile({call,machine,project,path,size,sha256,read,overwrite=false,key,
  signal,onProgress=()=>{},wait=()=>new Promise(resolve=>setTimeout(resolve,1000))}){
  const check=()=>{if(signal?.aborted)throw Error('上传已停止；服务器上的原编号和断点保留。');};
  const request=async(action,args)=>{check();const value=await call('data.upload.'+action,{machine,...(project?{project}:{}),...args});check();return value;};
  let result=await request('status',{path});
  const matches=value=>value.path===path&&value.totalSize===size&&value.sha256===sha256;
  if(result.state==='ABSENT'||['COMPLETE','CONFLICT','FAILED'].includes(result.state)&&!matches(result)||result.state==='CONFLICT'&&overwrite){
    key ||= crypto.randomUUID();
    onProgress({key,path,totalSize:size,receivedBytes:0,state:'STARTING'});
    result=await request('begin',{path,key,totalSize:size,sha256,overwrite});
  }
  const validate=value=>{
    if(!matches(value)||typeof value.key!=='string'||key&&value.key!==key||
      !Number.isSafeInteger(value.receivedBytes)||value.receivedBytes<0||value.receivedBytes>size)
      throw Error('上传身份或已确认偏移不一致；没有重建或覆盖原上传。');
  };
  validate(result);key=result.key;
  onProgress(result);
  if(result.state==='COMPLETE')return result;
  if(!['UPLOADING','VERIFYING','COMMITTING'].includes(result.state))throw Error('原上传状态为 '+result.state+'；文件保留，请检查原编号 '+key);
  if(result.state==='UPLOADING'){
    let offset=result.receivedBytes;
    while(offset<size){
      check();const bytes=await read(offset,Math.min(CHUNK,size-offset));check();
      if(bytes.length!==Math.min(CHUNK,size-offset))throw Error('本地文件长度改变；原上传未覆盖。');
      result=await request('chunk',{key,offset,data:encode(bytes)});validate(result);
      if(result.receivedBytes!==offset+bytes.length)throw Error('上传偏移未确认，请沿原编号查询。');
      offset=result.receivedBytes;onProgress(result);
    }
  }
  result=await request('finish',{key});validate(result);
  while(result.state!=='COMPLETE'){
    if(!['VERIFYING','COMMITTING'].includes(result.state))throw Error('上传校验未完成：'+result.state+'；原编号 '+key);
    onProgress(result);await wait();result=await request('status',{path});validate(result);
  }
  onProgress(result);return result;
}
