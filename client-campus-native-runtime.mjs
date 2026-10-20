import {spawn} from 'node:child_process';
import {readFile,lstat,stat,mkdir,writeFile,rename,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {win32,posix,join,dirname} from 'node:path';

const fail=code=>Object.assign(Error(`Windows host transport stopped (${code}); no WSL network fallback`),{code});
export async function resolveCampusNativeRuntime({platform=process.platform,arch=process.arch,read=readFile}={}){
  if(platform==='darwin')return {platform:'darwin',arch,interop:false};
  if(!['x64','arm64'].includes(arch))throw fail('PLATFORM_UNSUPPORTED');
  if(platform==='win32'||platform==='windows')return {platform:'windows',arch,interop:false};
  if(platform!=='linux')throw fail('PLATFORM_UNSUPPORTED');
  let release;try{release=await read('/proc/sys/kernel/osrelease','utf8');}catch{throw fail('PLATFORM_UNCONFIRMED');}
  if(typeof release!=='string'||release.length>4096)throw fail('PLATFORM_UNCONFIRMED');
  return {platform:/microsoft/i.test(release)?'windows':'linux',arch,interop:/microsoft/i.test(release)};
}
const bootstrapEnv=()=>Object.fromEntries(['SystemRoot','WINDIR','WSL_INTEROP','TEMP','TMP','USERPROFILE','LOCALAPPDATA'].filter(key=>typeof process.env[key]==='string').map(key=>[key,process.env[key]]));
export function boundedLocalCommand(program,args,{spawnProcess=spawn,timeoutMs=8000,limit=8192}={}){
  return new Promise((resolve,reject)=>{
    let child,done=false,total=0,output=[],failure,exitTimer;
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);clearTimeout(exitTimer);error?reject(error):resolve(value);};
    const abort=error=>{if(failure||done)return;failure=error;child?.kill('SIGKILL');exitTimer=setTimeout(()=>finish(fail('WINDOWS_BOOTSTRAP_EXIT_UNCONFIRMED')),2000);};
    const timer=setTimeout(()=>abort(fail('WINDOWS_INTEROP_UNAVAILABLE')),timeoutMs);
    try{child=spawnProcess(program,args,{stdio:['ignore','pipe','pipe'],env:bootstrapEnv()});}catch{finish(fail('WINDOWS_INTEROP_UNAVAILABLE'));return;}
    child.stdout.on('data',part=>{if(failure)return;total+=part.length;if(total>limit)abort(fail('WINDOWS_BOOTSTRAP_INVALID'));else output.push(part);});
    child.stderr.on('data',()=>{});child.on('error',()=>finish(fail('WINDOWS_INTEROP_UNAVAILABLE')));
    child.on('close',code=>finish(failure||(code===0?null:fail('WINDOWS_INTEROP_UNAVAILABLE')),Buffer.concat(output).toString('utf8').replace(/^\uFEFF/,'')));
  });
}
export async function windowsPowerShell(runtime,{env=process.env,read=readFile,stat=lstat}={}){
  const candidates=[];
  if(!runtime.interop){for(const root of [env.SystemRoot,env.WINDIR])if(typeof root==='string'&&/^[A-Za-z]:\\/.test(root))candidates.push(win32.join(root,'System32','WindowsPowerShell','v1.0','powershell.exe'));}
  else{
    for(const dir of String(env.PATH||'').split(':')){
      if(/\/Windows\/System32$/i.test(dir))candidates.push(posix.join(dir,'WindowsPowerShell/v1.0/powershell.exe'));
      if(/\/WindowsPowerShell\/v1\.0\/?$/i.test(dir))candidates.push(posix.join(dir,'powershell.exe'));
    }
    // WSL may suppress the imported Windows PATH. Enumerate bounded existing
    // drive mounts; do not assume C: or /mnt/c and do not change automount.
    let mounts='';try{mounts=await read('/proc/mounts','utf8');}catch{}
    if(typeof mounts!=='string'||mounts.length>65536)throw fail('WINDOWS_INTEROP_UNAVAILABLE');
    for(const line of mounts.split('\n')){const fields=line.split(' ');if(fields.length>=4&&(fields[2]==='drvfs'||fields[2]==='9p'&&fields[3].includes('aname=drvfs'))){const mount=fields[1].replace(/\\040/g,' ');if(mount.startsWith('/'))candidates.push(posix.join(mount,'Windows/System32/WindowsPowerShell/v1.0/powershell.exe'));}}
  }
  for(const path of [...new Set(candidates)].slice(0,32)){try{const info=await stat(path);if(info.isFile()&&!info.isSymbolicLink())return path;}catch{}}
  throw fail('WINDOWS_INTEROP_UNAVAILABLE');
}
export function windowsTempScript(){
  return `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$temp=[IO.Path]::GetTempPath();if($temp -notmatch '^[A-Za-z]:\\\\'){throw 'local temp required'};$drive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($temp));if($drive.DriveType -ne [IO.DriveType]::Fixed){throw 'local fixed drive required'};$arch=if([Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITECTURE') -eq 'ARM64'){'arm64'}elseif([Environment]::Is64BitOperatingSystem){'x64'}else{throw 'unsupported architecture'};[Console]::Out.WriteLine((@{path=$temp;arch=$arch}|ConvertTo-Json -Compress))`;
}
export async function prepareWindowsNativeFolder(runtime,{command=boundedLocalCommand,powerShell=windowsPowerShell,
  cacheFile=join(homedir(),'.config','gpuq-console','windows-bootstrap.json')}={}){
  const mapped=async value=>runtime.interop?(await command('/usr/bin/wslpath',['-u',value.path])).trim():value.path;
  const invalidate=()=>rm(cacheFile,{force:true}).catch(()=>{});
  try{
    const value=JSON.parse(await readFile(cacheFile,'utf8'));
    if(typeof value?.path==='string'&&/^[A-Za-z]:\\/.test(value.path)&&['x64','arm64'].includes(value.arch)){
      const folder=await mapped(value);
      if((await stat(folder)).isDirectory())return {folder,arch:value.arch,interop:runtime.interop,invalidate};
    }
  }catch{/* A stale or unreadable cache is replaced by bootstrap. */}
  await invalidate();
  const ps=await powerShell(runtime);let value;try{value=JSON.parse((await command(ps,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',windowsTempScript()],{timeoutMs:30000})).trim());}catch(error){throw error?.code?error:fail('WINDOWS_BOOTSTRAP_INVALID');}
  const folder=await mapped(value),pending=cacheFile+'.'+process.pid+'.tmp';
  try{
    await mkdir(dirname(cacheFile),{recursive:true,mode:0o700});
    await writeFile(pending,JSON.stringify({path:value.path,arch:value.arch})+'\n',{mode:0o600});await rename(pending,cacheFile);
  }catch{/* Cache persistence must not stop a command. */}
  finally{await rm(pending,{force:true}).catch(()=>{});}
  return {folder,arch:value.arch,interop:runtime.interop,invalidate};
}
