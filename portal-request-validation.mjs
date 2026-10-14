export const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const SHA256=/^[a-f0-9]{64}$/;
export const hasUnexpectedFields=(value,allowed)=>Object.keys(value).some(key=>!allowed.includes(key));
export const selectFields=(value,allowed)=>Object.fromEntries(allowed.filter(key=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.hasOwn(value,key)).map(key=>[key,value[key]]));
export const MAX_ARGV_BYTES=1024**2;
export function assertArgv(argv,{requireCommand=false,message='训练命令无效。'}={}){
  if(!Array.isArray(argv)||!argv.length||requireCommand&&!argv[0])throw Object.assign(Error(message),{status:400});
  let bytes=0;
  for(const value of argv){
    if(typeof value!=='string'||value.includes('\0'))throw Object.assign(Error(message),{status:400});
    if((bytes+=Buffer.byteLength(value,'utf8'))>MAX_ARGV_BYTES)
      throw Object.assign(Error('命令参数总量不能超过 1 MiB；把长代码写进工作区文件再用脚本路径运行。'),{status:400});
  }
}
