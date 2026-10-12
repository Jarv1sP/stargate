#!/usr/bin/env node
import {readFile,mkdir,writeFile,chmod,unlink,open,lstat,readdir,rename} from 'node:fs/promises';
import {dirname,join,basename} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {createInterface} from 'node:readline/promises';
import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {uploadLocalDataset,workspaceDataPath,putWorkspaceData} from './client-data-upload.mjs';
import {runManualSync,remoteSnapshot} from './client-snapshot-sync.mjs';
import {uploadTransfer,downloadTransfer,transferText} from './client-transfers.mjs';
import {runCloudImport} from './client-cloud-import.mjs';
import {runCloudFiles} from './client-cloud-files.mjs';
import {runCommunityCommand,formatCommunityResult,communityJSON} from './community-cli.mjs';
import {cliHelp} from './cli-help.mjs';
import {watchJob} from './job-watch.mjs';
import {progressText,jobTimingText} from './dist/job-progress.js';
import {elasticAllocation,allocationLabel,gpuPlacement} from './dist/gpu-allocation.js';
import {displayName,taskDescription} from './dist/task-metadata.js';
import {apiPost} from './client-http.mjs';
import {downloadFile} from './client-file-download.mjs';

// Member metadata is untrusted even after submission validators improve: old
// stored records and older servers can still contain C1/ANSI or bidi controls.
const maintenanceVisible=(value,multiline=false)=>String(value??'').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,c=>multiline&&c==='\n'?c:'\\u{'+c.codePointAt(0).toString(16).padStart(4,'0')+'}');
const maintenanceJSON=value=>JSON.stringify(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,c=>c.split('').map(unit=>'\\u'+unit.charCodeAt(0).toString(16).padStart(4,'0')).join(''));
const terminalErrorMetadata=error=>({
  ...(Number.isInteger(error.status)&&error.status>=100&&error.status<=599?{status:error.status}:{}),
  ...(typeof error.code==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)?{code:error.code}:{})});
const terminalMetadata=(value,key='')=>typeof value==='string'?maintenanceVisible(value,['description','body'].includes(key)):
  Array.isArray(value)?value.map(item=>terminalMetadata(item,key)):
  value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([name,item])=>[maintenanceVisible(name),terminalMetadata(item,name)])):value;

export async function saveDatasetUploadSession(path,value){
  const before=await lstat(path,{bigint:true});
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n)throw Error('Unsafe upload session cache');
  const pending=path+'.upload-pending-'+randomUUID(),file=await open(pending,'wx',0o600);
  try{
    await file.writeFile(JSON.stringify(value));await file.sync();await file.close();
    const current=await lstat(path,{bigint:true});
    if(!current.isFile()||current.isSymbolicLink()||current.nlink!==1n||current.dev!==before.dev||current.ino!==before.ino||current.size!==before.size||current.mtimeNs!==before.mtimeNs||current.ctimeNs!==before.ctimeNs)throw Error('Upload session cache changed; no request was dispatched');
    await rename(pending,path);
    let directory;try{directory=await open(dirname(path),'r');await directory.sync();}
    catch(error){if(process.platform!=='win32'||!['EPERM','EISDIR','EINVAL'].includes(error.code))throw error;}
    finally{await directory?.close();}
  }finally{await file.close().catch(()=>{});await unlink(pending).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}

const args=process.argv.slice(2);let options,positionals,training;
let wantsJSON=args.slice(0,args.includes('--')?args.indexOf('--'):args.length).includes('--json');
function fail(message){throw Error(message);}
const CLI_OPTIONS=new Map([
  ['pin','flag'],...['kind','status','title','body','body-file','announcement-type'].map(key=>[key,'value']),
  ['via','value'],['data-read','value'],['memory-limit-gib','value'],
  ...['sha256','file-id','password-code','source-url'].map(key=>[key,'value']),
  ...['overwrite','json','password-stdin','credentials-stdin','help','full','root','legacy','detach','takeover','general','checkpointable','auto-expand','dry-run','share','hami','ack-unknown','sync','data-workspace'].map(key=>[key,'flag']),
  ['source-root','value'],['sync-dir','value'],['candidates','value'],['owner-id','value'],['interactive','flag'],
  ...['url','session-file','total','cards','as','role','name','description','display-name','min-vram','key','project','release','job','priority','cwd','timeout','reconnect','env-mode','rank','yield','restart-policy','mode','min-cards','global-batch','micro-batch','interval','from','to','ref','target-project','gpu','vram-mib','sm-percent','reason','script-file','revision','preview-token','parent','cursor','limit','members','primary','manifest-sha256'].map(key=>[key,'value']),
  ['machine','machines'],['data','datasets'],
]);

export function parseCLIOptions(argv){
  const options={machines:[],datasets:[]},positionals=[];
  for(let i=0;i<argv.length;i++){
    if(argv[i]==='--')return {options,positionals,training:argv.slice(i+1)};
    const item=argv[i]==='-g'?'--cards':argv[i]==='--on'?'--machine':argv[i];
    if(!item.startsWith('--')){positionals.push(item);continue;}
    const key=item.slice(2),kind=CLI_OPTIONS.get(key);
    if(!kind)fail(`Unknown option: ${item}`);
    if(Object.hasOwn(options,key))fail(`Duplicate option: ${item}`);
    if(kind==='flag'){options[key]=true;continue;}
    const value=argv[++i];
    if(value===undefined||value===''&&key!=='description'||value.startsWith('--'))fail(`Missing value: ${item}`);
    if(kind==='value')options[key]=value;
    else options[kind].push(value);
  }
  return {options,positionals,training:[]};
}
export async function uploadCodeFiles(call,{machine,context,local,remote,verifyTree=false,inspectOnly=false,progress=message=>process.stderr.write(message),recoverySleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
  let count=0,skipped=0;const observed=[],files=[],statuses=[];
  if(inspectOnly&&!context.project)fail('push-status requires a selected personal project');
  const excluded=name=>['.git','.ssh','.aws','.azure','.venv','venv','node_modules','__pycache__','id_rsa','id_ed25519','.env'].includes(name)||(name.startsWith('.env.')&&name!=='.env.example');
  const stable=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
  if(verifyTree&&!(await lstat(local)).isDirectory())fail('--sync-dir must be an ordinary local directory');
  async function upload(local,path){
    if(context.project&&excluded(basename(local))){skipped++;progress(`跳过项目上传：${local}\n`);return;}
    const st=await lstat(local);if(st.isSymbolicLink())fail('Symlink upload is not supported');
    if(st.isDirectory()){
      const names=(await readdir(local)).sort();if(verifyTree)observed.push({local,st,names});
      for(const name of names)await upload(join(local,name),path==='.'?name:`${path}/${name}`);return;
    }
    if(!st.isFile())fail('Only regular files/directories can be uploaded');
    if(!Number.isSafeInteger(st.size)||st.size<0)fail('File byte count cannot be represented exactly');
    if(context.project&&st.size>4*1024**3)console.error('项目文件超过 4 GiB，仍允许上传；请确认磁盘空间，并等待完整校验。');
    const file=await open(local,'r');let offset=0;
    try{
      const initial=await file.stat();if(!initial.isFile()||!stable(st,initial))fail('Local file changed before upload');
      let identity={},confirmed=false,recoveries=0;
      const inspectUpload=async()=>{
        const value=(await call('files.upload.status',{machine,path,...context,...identity})).result;
        if(value?.protocol!==2||!['ABSENT','UPLOADING','COMPLETE','CONFLICT'].includes(value.state)||value.path!==path)fail('Server did not confirm the project upload recovery protocol; no file was resent');
        if(['UPLOADING','COMPLETE'].includes(value.state)){
          if(value.sha256!==identity.sha256||value.totalSize!==identity.totalSize||!Number.isSafeInteger(value.receivedBytes)||value.receivedBytes<0||value.receivedBytes>identity.totalSize||!(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/).test(value.uploadId)||identity.uploadId&&value.uploadId!==identity.uploadId)fail('Project upload status identity differs; no file was resent');
          if(value.state==='COMPLETE'&&(value.complete!==true||value.size!==identity.totalSize))fail('Server did not confirm the complete verified upload');
          if(value.completionPending!==undefined&&typeof value.completionPending!=='boolean')fail('Server did not confirm the upload completion fence');
        }
        return value;
      };
      if(context.project){
        const hash=createHash('sha256'),buffer=Buffer.alloc(1024*1024);let at=0;
        while(at<initial.size){const {bytesRead}=await file.read(buffer,0,Math.min(buffer.length,initial.size-at),at);if(!bytesRead)fail('Local file changed during hashing');hash.update(buffer.subarray(0,bytesRead));at+=bytesRead;}
        if(!stable(initial,await file.stat()))fail('Local file changed during hashing');
        identity={totalSize:initial.size,sha256:hash.digest('hex')};
        const current=await inspectUpload();
        if(inspectOnly){statuses.push(current);return;}
        if(current.state==='CONFLICT')fail('Project upload target changed or another content upload is active; inspect the original target before replacing it');
        if(current.state==='UPLOADING'&&current.resumable!==true)fail('Existing upload has no safe recovery fence; its original ID and partial bytes were preserved. Ask an administrator to inspect it before restarting');
        if(current.state==='COMPLETE'){identity.uploadId=current.uploadId;offset=initial.size;confirmed=current.completionPending!==true;}
        else if(current.state==='UPLOADING'&&current.resumable===true){identity.uploadId=current.uploadId;offset=current.receivedBytes;}
        else identity.uploadId=randomUUID();
        if(offset)progress(`项目文件 ${maintenanceVisible(path)}：已确认 ${offset}/${initial.size} 字节${confirmed?'（完整校验）':'，续传原上传'}\n`);
      }
      if(!confirmed)do{
        const buffer=Buffer.alloc(1024*1024);const {bytesRead}=await file.read(buffer,0,Math.min(buffer.length,Math.max(0,initial.size-offset)),offset);
        if(!bytesRead&&offset<initial.size)fail('Local file changed during upload');
        const final=offset+bytesRead===initial.size;
        if(context.project&&final&&!stable(initial,await file.stat()))fail('Local file changed during upload; no final publish was sent');
        let response;
        try{response=(await call('files.put',{machine,path,offset,...context,...(context.project?{...identity,final}:{truncate:offset===0}),data:buffer.subarray(0,bytesRead).toString('base64')})).result;}
        catch(error){
          // Only this fixed, checksum-bound project protocol can recover an
          // uncertain write. Legacy uploads and other mutations never replay.
          if(!context.project||error.status!==undefined&&![502,503,504].includes(error.status)||recoveries>=3)throw error;
          await recoverySleep(1000*2**recoveries++);
          if(!stable(initial,await file.stat()))fail('Local file changed after an interrupted upload; no retry was sent');
          const current=await inspectUpload();
          if(current.state==='COMPLETE'){
            offset=initial.size;
            if(current.completionPending!==true){confirmed=true;break;}
            // The bytes were verified, but the completion journal still
            // blocks publication. Send only the same-ID zero-byte final.
            continue;
          }
          if(current.state==='CONFLICT'||current.state==='ABSENT'&&offset!==0||current.state==='UPLOADING'&&(current.resumable!==true||current.receivedBytes<offset||current.receivedBytes>offset+bytesRead))throw Error('Upload outcome is not safely resumable; keep the same source and target and inspect upload status');
          offset=current.state==='UPLOADING'?current.receivedBytes:0;
          progress(`项目文件 ${maintenanceVisible(path)}：连接恢复，服务器确认 ${offset}/${initial.size} 字节；保持原上传身份\n`);
          continue;
        }
        if(context.project&&final&&(response?.complete!==true||response.completionPending===true||response.sha256!==identity.sha256||response.size!==identity.totalSize))fail('Server did not confirm the complete verified upload; check and retry this file before publishing');
        offset+=bytesRead;
        confirmed=final;
      }while(!confirmed);
      if(context.project&&!stable(initial,await file.stat()))fail('Local file changed during upload; verify and upload again before project publish');
      if(verifyTree){observed.push({local,st:initial});files.push({path,size:identity.totalSize,sha256:identity.sha256});}
    }finally{await file.close();}count++;
  }
  await upload(local,remote);
  if(inspectOnly)return {machine,project:context.project,readOnly:true,files:statuses,skipped};
  if(verifyTree){
    if(!count)fail('No code files were uploaded; refusing to publish or submit an old draft');
    for(const item of observed){
      const current=await lstat(item.local);
      if(current.isSymbolicLink()||!stable(item.st,current)||item.names&&JSON.stringify((await readdir(item.local)).sort())!==JSON.stringify(item.names))fail('Local code tree changed during sync; no publication or job was submitted');
    }
  }
  return {uploaded:count,machine,...(context.project?{project:context.project,skipped}:{}),...(verifyTree?{files}:{})};
}

export async function synchronizeProjectRun(call,{machine,project,directory=process.cwd(),key=randomUUID(),timeoutMs=7200000,pollMs=1000,progress=message=>process.stderr.write(message)}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  const request=async(operation,args={})=>(await call(operation,{machine,project,...args},controller.signal)).result;
  try{
    const before=await request('projects.status');
    if(before?.publicationProtocol!==1)fail('Node does not support confirmed run --sync publications; upgrade it first. No code was uploaded.');
    if(!['READY','DRAFT','FAILED'].includes(before.state))fail('Project is busy or its publication outcome is unknown; inspect project status before syncing');
    const uploaded=await uploadCodeFiles((op,args)=>call(op,args,controller.signal),{machine,context:{project,area:'code'},local:directory,remote:'.',verifyTree:true,progress});
    progress(`Publication key: ${key}\n同步不会删除服务器多余文件；等待本次发布 READY。\n`);
    let result=await request('projects.publish',{key});
    while(true){
      const proof=result?.publication;
      if(result?.publicationProtocol!==1||proof?.id!==key)fail('This publication was not confirmed or was replaced; no job was submitted');
      if(proof.state==='READY'){
        if(result.state!=='READY'||!/^[a-f0-9]{64}$/.test(proof.release||'')||!result.releases?.some(r=>r.release===proof.release&&r.state==='READY'))fail('This publication has no verified READY release; no job was submitted');
        // A concurrent editor may change the draft between upload and publish.
        // Reuse the fixed-release export manifest to verify our actual bytes;
        // never infer code identity from latestReadyRelease or a success label.
        const snapshot=await remoteSnapshot((op,args)=>call(op,args,controller.signal),'projects',{machine,project,release:proof.release},()=>{});
        try{
          const files=new Map(snapshot.files.map(file=>[file.path,file]));
          if(files.size!==snapshot.files.length||uploaded.files.some(file=>files.get(file.path)?.size!==file.size||files.get(file.path)?.sha256!==file.sha256))fail('Published code differs from the uploaded files; no job was submitted');
          await snapshot.verify();
        }finally{await snapshot.cleanup();}
        return proof.release;
      }
      if(proof.state!=='PUBLISHING'||result.state!=='PUBLISHING')fail(`Publication ${proof.state||'UNKNOWN'}; no job was submitted and no older release was used. Inspect gpuctl project status.`);
      await new Promise((resolve,reject)=>{
        const abort=()=>{clearTimeout(wait);reject(Error('Publication wait timed out; no job was submitted'));};
        const wait=setTimeout(()=>{controller.signal.removeEventListener('abort',abort);resolve();},pollMs);
        controller.signal.addEventListener('abort',abort,{once:true});if(controller.signal.aborted)abort();
      });
      result=await request('projects.status');
    }
  }finally{clearTimeout(timer);}
}

async function secret(label='Password'){
  if(options['password-stdin']){let value='';for await(const chunk of process.stdin){value+=chunk;if(value.length>1024)fail('Password input too long');}return value.replace(/\r?\n$/,'');}
  if(!process.stdin.isTTY)fail('Use --password-stdin for non-interactive password input.');
  process.stderr.write(`${label}: `);process.stdin.setRawMode(true);process.stdin.resume();
  return new Promise((resolve,reject)=>{
    let value='';const finish=(error)=>{process.stdin.off('data',listener);process.stdin.setRawMode(false);process.stdin.pause();process.stderr.write('\n');error?reject(error):resolve(value);};
    const listener=chunk=>{for(const char of chunk.toString()){if(char==='\u0003')return finish(Error('Cancelled'));if(char==='\r'||char==='\n')return finish();if(char==='\u007f'||char==='\b')value=value.slice(0,-1);else if(char>=' ')value+=char;if(value.length>128)return finish(Error('Password too long'));}};
    process.stdin.on('data',listener);
  });
}
async function main(){
  ({options,positionals,training}=parseCLIOptions(args));
  if(positionals[0]==='help'){
    if(positionals.length>2||training.length)fail('Usage: gpuctl help [daily|admin|community]');
    console.log(cliHelp(positionals[1]));return;
  }
  if(options.help||!positionals.length){console.log(cliHelp());return;}
  if(positionals[0]!=='run'&&options.machines.includes('auto'))fail('开发容器需要指定服务器；自动选择只用于提交训练（gpuctl run --machine auto）');
  if(options.sync&&positionals[0]!=='run'||options['sync-dir']!==undefined&&!options.sync)fail('--sync is only for run; --sync-dir requires run --sync');
  if(options.sync&&['release','legacy','root','as','job'].some(key=>Object.hasOwn(options,key)))fail('run --sync requires a personal project; cannot combine with --release/--legacy/--root/--as/--job');
  const transferCopy=positionals[0]==='transfer'&&positionals[1]==='copy',projectCopy=positionals[0]==='project'&&positionals[1]==='copy',transferWatch=positionals[0]==='transfer'&&positionals[1]==='watch',transferList=positionals[0]==='transfer'&&positionals[1]==='list';
  const datasetLabel=positionals[0]==='data'&&positionals[1]==='label';
  const projectLifecycle=positionals[0]==='project'&&['label','group','archive','unarchive','retire'].includes(positionals[1]);
  if(['ref','target-project','dry-run'].some(key=>Object.hasOwn(options,key))&&positionals[0]!=='sync'||['from','to'].some(key=>Object.hasOwn(options,key))&&positionals[0]!=='sync'&&!transferCopy&&!projectCopy&&!(positionals[0]==='data'&&positionals[1]==='copy'))fail('--from/--to are for sync, project copy or transfer copy; ref/target-project/dry-run are only for sync');
  if(options.candidates!==undefined&&positionals[0]!=='run')fail('--candidates is only for run --machine auto');
  if(options.general&&positionals[0]!=='note')fail('--general is only valid for note');
  if(options.interval!==undefined&&positionals[0]!=='watch'&&!transferWatch)fail('--interval is only valid for watch');
  if(positionals[0]==='watch'){
    if(positionals.length!==2||training.length||options.machines.length||options.datasets.length||Object.keys(options).some(k=>!['machines','datasets','json','url','session-file','interval'].includes(k)))fail('Usage: watch JOB [--interval 1..60] [--json]');
    if(options.interval!==undefined&&(!Number.isFinite(Number(options.interval))||Number(options.interval)<1||Number(options.interval)>60))fail('--interval must be 1–60 seconds');
  }
  if(positionals[0]==='notify'&&(positionals.length!==3||!['on','off','status'].includes(positionals[2])||training.length||options.machines.length||options.datasets.length||Object.keys(options).some(k=>!['machines','datasets','json','url','session-file'].includes(k))))fail('Usage: notify JOB on|off|status');
  if(options.overwrite&&!(positionals[0]==='data'&&positionals[1]==='put'))fail('--overwrite is only valid for data put');
  if(options.via!==undefined&&(!((['data','transfer'].includes(positionals[0])&&positionals[1]==='upload')||(positionals[0]==='data'&&positionals[1]==='put'&&options.via!=='direct'))||!['auto','direct','relay'].includes(options.via)))fail('--via auto|direct|relay is for directory uploads; data put accepts only auto or relay');
  if(options.priority&&!['idle','normal','high'].includes(options.priority))fail('Priority must be idle, normal or high');
  if(options.priority&&positionals[0]!=='run')fail('--priority is only valid for run; use gpuctl priority JOB idle|normal|high');
  if(options.cwd!==undefined&&!['exec','maintenance'].includes(positionals[0])||options.timeout!==undefined&&!['exec','maintenance'].includes(positionals[0])&&!transferCopy||options.detach&&positionals[0]!=='exec'&&!transferCopy)fail('--cwd is for exec/maintenance; timeout also supports transfer copy; detach is for exec or transfer copy');
  if(['reason','script-file','preview-token','parent','ack-unknown'].some(key=>Object.hasOwn(options,key))&&positionals[0]!=='maintenance')fail('Maintenance options are only valid for maintenance');
  if(options.revision!==undefined&&!['maintenance','community'].includes(positionals[0])&&!datasetLabel&&!projectLifecycle&&!(positionals[0]==='task-label'&&positionals[1]==='set')||['cursor','limit'].some(key=>Object.hasOwn(options,key))&&!['maintenance','community'].includes(positionals[0])&&!transferList)fail('--revision is for community/maintenance/data label/project lifecycle/task-label set; cursor/limit also support transfer list');
  const customScheduling=['rank','yield','restart-policy','checkpointable','mode'].some(k=>Object.hasOwn(options,k));
  if(customScheduling&&(positionals[0]!=='run'||options.priority))fail('Custom scheduling is only valid for run and cannot mix with --priority presets');
  const scheduling=customScheduling?{rank:options.rank||'P2',yieldPolicy:options.yield||'never',restartPolicy:options['restart-policy']||'never',checkpointable:options.checkpointable===true}:null;
  if(options.mode){const modes={queue:'queue',preempt1:'preempt-save',preempt2:'preempt-now','preempt-save':'preempt-save','preempt-now':'preempt-now'};if(!Object.hasOwn(modes,options.mode))fail('Use --mode queue|preempt1|preempt2');if(modes[options.mode]!=='queue')scheduling.mode=modes[options.mode];}
  const elasticKeys=['min-cards','global-batch','micro-batch','auto-expand'];
  const placementKeys=['gpu','share','vram-mib','hami','sm-percent'];
  if(placementKeys.some(k=>Object.hasOwn(options,k))&&positionals[0]!=='run')fail('Placement options are only valid for run');
  if(options['data-read']!==undefined&&(positionals[0]!=='run'||!['cache','warehouse'].includes(options['data-read'])))fail('--data-read cache|warehouse is only valid for run');
  if(elasticKeys.some(k=>Object.hasOwn(options,k))&&positionals[0]!=='run')fail('Elastic GPU options are only valid for run');
  if(scheduling){
    if(!/^P[0-4]$/.test(scheduling.rank)||!['never','now','save'].includes(scheduling.yieldPolicy)||!['never','on-preempt'].includes(scheduling.restartPolicy))fail('Use --rank P0..P4, --yield never|now|save, --restart-policy never|on-preempt');
    if(scheduling.yieldPolicy==='save'&&!scheduling.checkpointable)fail('--yield save requires --checkpointable and an epoch checkpoint adapter');
    if(scheduling.restartPolicy==='on-preempt'&&(scheduling.yieldPolicy!=='save'||!scheduling.checkpointable))fail('Automatic resume requires --yield save --checkpointable');
  }
  const memoryLimitGiB=options['memory-limit-gib']===undefined?undefined:Number(options['memory-limit-gib']);
  if(memoryLimitGiB!==undefined&&(positionals[0]!=='run'||!Number.isSafeInteger(memoryLimitGiB)||memoryLimitGiB<1||memoryLimitGiB>1048576))fail('--memory-limit-gib 仅用于 run，须为正整数 GiB');
  const projectSlug=value=>{if(typeof value!=='string'||!/^[a-z][a-z0-9_-]{0,47}$/.test(value))fail('Project must start with a lowercase letter and use 1–48 lowercase letters, digits, _ or -');return value;};
  if(options.project)projectSlug(options.project);
  if(options.project&&options.legacy)fail('--project and --legacy cannot be combined');
  if(options.release&&!/^[a-f0-9]{64}$/.test(options.release))fail('Use --release FULL_64_CHARACTER_HASH');
  if(options.job&&!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(options.job))fail('Use --job JOB_UUID from gpuctl jobs');
  const explicitSession=options['session-file']||process.env.GPUQ_SESSION_FILE||process.env.AMAX_SESSION_FILE;
  if(options.description!==undefined&&positionals[0]!=='run'&&!(positionals[0]==='task-label'&&positionals[1]==='set'))fail('--description is only valid for run or task-label set');
  if(options['display-name']!==undefined&&!['profile','register'].includes(positionals[0])&&!datasetLabel&&!(positionals[0]==='project'&&['label','group'].includes(positionals[1])))fail('--display-name is only valid for profile, register, data label or project label/group');
  if(options['owner-id']!==undefined&&!datasetLabel&&!(positionals[0]==='data'&&positionals[1]==='archive-enroll'))fail('--owner-id is only valid for administrator data label/archive-enroll');
  let sessionFile=explicitSession||join(homedir(),'.config','gpuq-console','session.json');
  // Keep one cache: a previous installation continues using its existing file.
  if(!explicitSession){try{await lstat(sessionFile);}catch(e){if(e.code!=='ENOENT')throw e;const legacy=join(homedir(),'.config','amax-demo','session.json');try{await lstat(legacy);sessionFile=legacy;}catch(old){if(old.code!=='ENOENT')throw old;}}}
  let session;try{session=JSON.parse(await readFile(sessionFile,'utf8'));}catch(e){if(e.code!=='ENOENT')fail('Unable to read session cache.');}
  const bundled='__GPUQ_PUBLIC_ORIGIN__';
  const target=options.url||process.env.GPUQ_URL||process.env.AMAX_URL||(bundled.startsWith('https://')?bundled:session?.url);
  if(!target)fail('首次运行源码客户端请指定 --url https://你的服务域名，或从门户安装客户端。');
  const base=new URL(target);
  if(base.username||base.password||base.pathname!=='/'||base.search||base.hash)fail('Use a base URL without credentials, path or query.');
  if(base.protocol!=='https:'&&!(base.protocol==='http:'&&base.hostname==='127.0.0.1'))fail('Remote APIs require HTTPS.');
  if(session&&session.url!==base.origin)session=undefined;
  async function post(path,body,requestSignal){
    return apiPost(base,path,body,{token:session?.token,signal:requestSignal});
  }
  const call=(operation,args={},signal)=>post('call',{operation,args},signal);
  let command=positionals[0];let result,mode={demo:true,gpuqConnected:false};
  if(command==='register'){
    if(positionals.length!==2)fail('Usage: register USERNAME');
    if(options['password-stdin'])fail('Use --credentials-stdin with JSON {invite,password} for registration.');
    let credentials;
    if(options['credentials-stdin']){let value='';for await(const chunk of process.stdin){value+=chunk;if(value.length>1024)fail('Registration input too long');}try{credentials=JSON.parse(value);}catch{fail('Expected JSON {invite,password} on stdin');}if(!credentials||typeof credentials!=='object'||Array.isArray(credentials)||Object.keys(credentials).some(key=>!['invite','password'].includes(key)))fail('Expected only invite and password');}
    else credentials={invite:await secret('Invite code'),password:await secret()};
    result=await post('register',{username:positionals[1],...credentials,...(options['display-name']?{name:displayName(options['display-name'])}:{})});mode={demo:false,gpuqConnected:false};
  }else if(command==='login'){
    if(positionals.length===1&&process.stdin.isTTY){const rl=createInterface({input:process.stdin,output:process.stdout});positionals.push(await rl.question('用户名: '));rl.close();}
    if(positionals.length!==2)fail('Usage: login USERNAME');
    const login=await post('login',{username:positionals[1],password:await secret()});
    mode={demo:login.state.demo,gpuqConnected:login.state.gpuqConnected===true};
    await mkdir(dirname(sessionFile),{recursive:true,mode:0o700});
    const previous=session?.principal?.userId===login.principal.userId?session:null;
    await writeFile(sessionFile,JSON.stringify({url:base.origin,token:login.token,principal:login.principal,...(previous?.machine?{machine:previous.machine}:{}),...(previous?.projectsByMachine?{projectsByMachine:previous.projectsByMachine}:{}),...(previous?.datasetUploadKeys?{datasetUploadKeys:previous.datasetUploadKeys}:{}),...(previous?.datasetUploadIntents?{datasetUploadIntents:previous.datasetUploadIntents}:{}),...(previous?.datasetUploadHandles?{datasetUploadHandles:previous.datasetUploadHandles}:{}),...(previous?.terminalSessions?{terminalSessions:previous.terminalSessions}:{})}),{mode:0o600});await chmod(sessionFile,0o600);
    result={loggedIn:true,principal:login.principal};
  }else{
    if(!session)fail('请先登录：gpuctl login');
    const state=(await call('state')).state;
    const machineName=value=>{const exact=state.machines.find(m=>m.id===value);if(exact)return exact.id;const short=state.machines.filter(m=>m.id.endsWith('-'+value));return short.length===1?short[0].id:value;};
    const selectedMachine=()=>session.machine||(state.machines?.length===1?state.machines[0].id:null)||fail('先选择一次服务器：gpuctl use MACHINE_ID');
    const defaultMachine=()=>{if(options.machines.length){if(options.machines.length!==1||options.machines[0].includes('='))fail('Use one --machine SERVER outside grant');return machineName(options.machines[0]);}return selectedMachine();};
    const selectedProject=machine=>options.legacy?null:options.project||session.projectsByMachine?.[machine]||null;
    const projectArgs=machine=>{const project=selectedProject(machine);return project?{project:projectSlug(project)}:{};};
    const fileArgs=machine=>{const context=projectArgs(machine);if(options.job&&!context.project)fail('--job outputs require a selected project; use gpuctl project use NAME');return {...context,...(context.project?{area:options.job?'output':'code',...(options.job?{runId:options.job}:{})}:{})};};
    const saveSession=async()=>{await writeFile(sessionFile,JSON.stringify(session),{mode:0o600});await chmod(sessionFile,0o600);};
    const shortcut=command;
    const dataTerminal=command==='data'&&positionals[1]==='shell';
    if(dataTerminal){
      if(positionals.length!==2||training.length||options.datasets.length||Object.keys(options).some(k=>!['machines','datasets','url','session-file','json','reconnect','takeover'].includes(k)))fail('Usage: data shell [--machine SERVER] [--reconnect SESSION] [--takeover]');
      command='shell';positionals.splice(0,positionals.length,'shell',defaultMachine());
    }
    if(command==='ssh')command='shell';if(command==='push')command='upload';if(command==='push-status')command='upload-status';if(command==='pull')command='download';
    if((options.reconnect||options.takeover)&&command!=='shell')fail('--reconnect/--takeover are only valid for ssh');
    if(options['env-mode']!==undefined){
      if(command!=='project'||positionals[1]!=='create')fail('--env-mode is only valid for project create; existing environments are never rebuilt');
      if(options['env-mode']!=='oci')fail('New projects use personal containers; shared/isolated venv creation is no longer available. Omit --env-mode.');
    }
    if(command==='run'&&positionals.length>1&&options.machines.length)fail('Select a server once, either positionally or with --machine/--on');
    if(['run','shell'].includes(command)&&positionals.length===1)positionals.push(defaultMachine());
    if(['push','push-status','pull'].includes(shortcut))positionals.splice(1,0,defaultMachine());
    if(['push','push-status'].includes(shortcut)&&positionals.length===3&&(await lstat(positionals[2])).isDirectory())positionals.push('.');
    if(command==='files'&&(positionals.length===1||!state.machines.some(m=>m.id===machineName(positionals[1]))))positionals.splice(1,0,defaultMachine());
    if(['run','shell','upload','upload-status','download','files','use'].includes(command)&&positionals[1])positionals[1]=machineName(positionals[1]);
    mode={demo:state.demo,gpuqConnected:state.gpuqConnected===true};
    const find=username=>{const user=state.users.find(u=>u.username===username);if(!user)fail('Unknown or unauthorized username');return user.id;};
    const own=()=>session.principal.role==='admin'&&options.as?find(options.as):session.principal.userId;
    if(command==='transfer'){
      const action=positionals[1],common=['machines','datasets','url','session-file','json','key'],specific={upload:['name','via'],download:[],copy:['from','to','name','timeout','detach'],list:['cursor','limit'],status:[],watch:['interval'],cancel:[],resume:[]}[action];
      if(!specific||training.length||options.datasets.length||Object.keys(options).some(k=>!common.includes(k)&&!specific.includes(k)))fail('Usage: transfer upload|download|copy|list|status|watch|cancel|resume');
      const progress=(phase,v)=>process.stderr.write(phase==='ROUTE'?(v.kind==='campus-direct'?'传输路径：直连上传节点（文件不经平台中转）\n':v.kind==='tail-upload'?'传输路径：Tail 备用上传（不改变默认路由；中继可能影响速度）\n':`传输路径：VPS 中转${v.explicit?'（已明确选择）':'（小文件通道）'}\n`):`${phase} · ${v.transferId||v.path||''}${v.bytes!==undefined?' · '+v.bytes+' / '+(v.totalBytes??'?')+' bytes':''}\n`);
      if(action==='upload'){
        if(positionals.length!==3)fail('Usage: transfer upload LOCAL_DIR --name NAME');
        result=await uploadTransfer(call,{machine:defaultMachine(),name:options.name,userId:session.principal.userId,directory:positionals[2],key:options.key,progress,via:options.via||'auto'});
      }else if(action==='download'||action==='copy'){
        if(positionals.length!==(action==='download'?4:3))fail('Usage: transfer download NAME@VERSION NEW_DIR | transfer copy NAME@VERSION --from SOURCE --to TARGET --name NAME');
        const [dataset,version,...extra]=positionals[2].split('@');if(extra.length||!dataset||!/^[a-f0-9]{64}$/.test(version||''))fail('Select NAME@FULL_VERSION_HASH');
        if(action==='download')result=await downloadTransfer(call,{machine:defaultMachine(),dataset,version,destination:positionals[3],key:options.key,progress});
        else{
          if(options.machines.length||!options.from||!options.to)fail('copy requires --from and --to; no auto placement');
          const key=options.key||randomUUID();process.stderr.write('重试键：'+key+'（未确认时重复原命令并加 --key，不要换键）\n');
          result=(await call('transfers.create',{key,kind:'copy',from:machineName(options.from),machine:machineName(options.to),name:options.name,dataset,version,...(options.timeout?{timeoutSec:Number(options.timeout)}:{})})).result;
          if(!options.detach){while(!['SUCCEEDED','FAILED','PAUSED','CANCELED','UNKNOWN'].includes(result.state)){process.stderr.write(transferText(result)+'\n');await new Promise(r=>setTimeout(r,2000));result=(await call('transfers.status',{id:result.id})).result;}}
        }
      }else if(action==='list'){
        if(positionals.length!==2)fail('Usage: transfer list');result=(await call('transfers.list',{...(options.cursor?{cursor:Number(options.cursor)}:{}),...(options.limit?{limit:Number(options.limit)}:{})})).result;
      }else{
        if(positionals.length!==3)fail('Usage: transfer '+action+' ID');
        if(action==='watch'){
          const interval=Number(options.interval??2);if(!Number.isFinite(interval)||interval<1||interval>60)fail('Watch interval must be 1–60 seconds');
          do{result=(await call('transfers.status',{id:positionals[2]})).result;process.stderr.write(transferText(result)+'\n');if(['SUCCEEDED','FAILED','PAUSED','CANCELED','UNKNOWN','WAITING_CLIENT'].includes(result.state))break;await new Promise(r=>setTimeout(r,interval*1000));}while(true);
        }else result=(await call('transfers.'+action,{id:positionals[2]})).result;
      }
    }else if(command==='community'){
      result=await runCommunityCommand({positionals,options,training,call});
    }else if(command==='sync'){
      result=await runManualSync(call,{options,positionals,training,machines:state.machines,userId:session.principal.userId});
    }else if(command==='queue'){
      if(positionals.length!==1||training.length||options.datasets.length||options.machines.length>1||Object.keys(options).some(k=>!['machines','datasets','url','session-file','json'].includes(k)))fail('Usage: queue [--machine SERVER]');
      if(state.taskMetadata?.version!==1)fail('当前后台尚未支持公开任务信息，请升级门户。');
      const selected=options.machines.length?machineName(options.machines[0]):null;
      if(selected&&!state.machines.some(m=>m.id===selected))fail('这台机器未授权或不存在');
      result={stale:state.gpuq?.stale!==false,hosts:(state.gpuq?.hosts||[]).filter(h=>!selected||h.id===selected).map(h=>({machine:h.id,reachable:h.reachable,checkedAt:state.gpuq.checkedAt,tasks:h.tasks||[]}))};
    }else if(command==='task-label'){
      const action=positionals[1],setting=action==='set',allowed=['machines','datasets','url','session-file','json',...(setting?['name','description','revision']:[])];
      if(!['get','set'].includes(action)||positionals.length!==4||training.length||options.machines.length||options.datasets.length||Object.keys(options).some(k=>!allowed.includes(k)))fail('Usage: task-label get|set SERVER NODE_JOB_ID [--revision HASH --name TEXT --description TEXT]');
      const machine=machineName(positionals[2]),nodeJobId=positionals[3];
      if(!state.machines.some(m=>m.id===machine)||!/^J[a-f0-9]{12}$/.test(nodeJobId))fail('Use an authorized server and the complete original native job ID.');
      if(setting&&(typeof options.name!=='string'||typeof options.description!=='string'||!/^[a-f0-9]{64}$/.test(options.revision||'')))fail('Read task-label get first, then supply its exact --revision, --name and --description.');
      result=(await call('tasks.display.'+action,{machine,nodeJobId,...(setting?{name:options.name,description:taskDescription(options.description),revision:options.revision}:{})})).result;
    }else if(command==='profile'){
      if(positionals.length!==1||training.length||options.datasets.length||options.machines.length||Object.keys(options).some(k=>!['machines','datasets','url','session-file','json','display-name'].includes(k)))fail('Usage: profile [--display-name NAME]');
      if(options['display-name']){if(state.taskMetadata?.version!==1)fail('当前后台尚未支持姓名设置，请升级门户。');result=(await call('profile.update',{name:displayName(options['display-name'])})).result;}
      else result=state.users.find(u=>u.id===session.principal.userId);
    }else if(command==='use'&&positionals.length===2){
      if(!state.machines.some(m=>m.id===positionals[1]))fail('这台机器未授权或不存在');session.machine=positionals[1];await saveSession();result={selected:session.machine,project:selectedProject(session.machine)};
    }else if(command==='maintenance'){
      const action=positionals[1];
      if(['status','on','off'].includes(action)){
        if(state.operationalMaintenance?.version!==1)fail('当前后台尚未支持持久维护状态。');
        const allowed=['machines','datasets','url','session-file','json',...(action==='status'?[]:['reason','revision'])];
        if(training.length||options.machines.length||options.datasets.length||Object.keys(options).some(k=>!allowed.includes(k))||positionals.length!==(action==='status'?2:3))fail('Usage: maintenance status | maintenance on all|SERVER --reason TEXT --revision N | maintenance off all|SERVER --revision N');
        if(action==='status')result=(await call('maintenance.status')).result;
        else{
          if(session.principal.role!=='admin')fail('仅管理员可设置或解除维护状态。');
          if(!/^\d+$/.test(options.revision||'')||!Number.isSafeInteger(Number(options.revision)))fail('先 maintenance status，再用显示的 --revision N 明确操作。');
          result=(await call('maintenance.set',{scope:positionals[2],enabled:action==='on',revision:Number(options.revision),...(options.reason!==undefined?{reason:options.reason}:{})})).result;
        }
      }else{
      if(!['list','show'].includes(action))fail('维护申请已停用，仅支持 maintenance list / show ID 查看历史。系统依赖请在协作区反馈；管理员可使用 gpuctl exec 或独立 ROOT 终端。');
      if(state.demo||state.maintenance?.version!==1)fail('当前后台不提供历史运维记录。');
      const common=['machines','datasets','url','session-file','json','help'],specific=action==='list'?['cursor','limit']:[];
      if(training.length||options.machines.length||options.datasets.length||Object.keys(options).some(key=>!common.includes(key)&&!specific.includes(key)))fail('历史查询仅支持 list --cursor/--limit 或 show ID。');
      if(action==='list'?positionals.length!==2:positionals.length!==3)fail('Usage: maintenance list | maintenance show ID');
      const number=(value,label)=>{if(typeof value!=='string'||!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value)))fail(label+' 必须为整数');return Number(value);};
      if(action==='list')result=(await call('maintenance.list',{...(options.cursor?{cursor:options.cursor}:{}),...(options.limit?{limit:number(options.limit,'limit')}:{})})).result;
      else result=(await call('maintenance.get',{id:positionals[2]})).result;
      }
    }else if(command==='exec'){
      if(['as','project','release','job','root','legacy','cards','min-vram','name'].some(key=>Object.hasOwn(options,key))||options.datasets.length)fail('exec only accepts host-command options; project/training/impersonation flags are not supported');
      if(session.principal.role!=='admin')fail('Host commands require an existing administrator account');
      const action=['status','cancel'].includes(positionals[1])?positionals[1]:'exec';
      if(options.machines.length>1||options.machines.some(value=>value.includes('=')))fail('Use exactly one --machine SERVER');
      if(action==='exec'&&positionals.length>2||action!=='exec'&&positionals.length!==3)fail('Usage: exec [SERVER] -- argv... | exec status|cancel HANDLE [--machine SERVER]');
      if(action==='exec'&&positionals[1]&&options.machines.length)fail('Select a server once, either positionally or with --machine');
      const explicit=action==='exec'?positionals[1]:null;
      const machine=machineName(explicit||options.machines[0]||session.machine||fail('Select a server explicitly: gpuctl use MACHINE_ID, or exec --machine MACHINE_ID'));
      if(machine==='auto'||!state.machines.some(m=>m.id===machine))fail('This server is not explicitly selected and authorized');
      const terminal=new Set(['SUCCEEDED','FAILED','CANCELED','TIMED_OUT']);
      let request;
      if(action==='exec'){
        const host=state.gpuq?.hosts?.find(h=>h.id===machine);
        if(state.gpuq?.stale!==false||host?.reachable!==true||host.hostCommand?.version!==1||host.hostCommand?.available!==true)
          fail('这台服务器尚未启用或尚未确认管理员非交互命令，未提交命令；请联系管理员。已有 ROOT 终端不受影响。');
        if(!training.length)fail('Put the host command argv after --');
        const timeout=options.timeout===undefined?300:Number(options.timeout);
        if(options.timeout!==undefined&&!/^\d+$/.test(options.timeout)||!Number.isInteger(timeout)||timeout<1||timeout>86400)fail('--timeout must be an integer from 1 to 86400 seconds');
        if(options.cwd&&(!options.cwd.startsWith('/')||options.cwd.includes('\0')||options.cwd.length>1024))fail('--cwd must be an absolute path');
        const key=options.key||randomUUID();
        if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(key))fail('--key must be a UUID');
        process.stderr.write(`Host command key: ${key} · server: ${machine}\n`);
        request={machine,key,argv:training,timeoutSec:timeout,...(options.cwd?{cwd:options.cwd}:{})};
        try{result=(await call('host.exec',request)).result;}
        catch(error){fail(`${error.message}\nCommand state is unconfirmed, not canceled. Inspect: gpuctl exec status ${key} --machine ${machine}; retry submission only with the SAME --key ${key}.`);}
      }else{
        if(training.length||['key','cwd','timeout','detach'].some(key=>Object.hasOwn(options,key)))fail('exec status/cancel accepts only HANDLE and --machine');
        const id=positionals[2];if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))fail('Command handle must be a UUID');
        result=(await call('host.'+action,{machine,id})).result;
      }
      const handle=result.id;
      if(action==='exec'&&!options.detach){
        try{
          while(!terminal.has(result.state)&&result.state!=='UNKNOWN'){
            await new Promise(resolve=>setTimeout(resolve,500));
            result=(await call('host.status',{machine,id:handle})).result;
          }
        }catch(error){fail(`${error.message}\nCommand may still be running; no cancellation was sent. Inspect: gpuctl exec status ${handle} --machine ${machine}`);}
      }
      result={...result,machine};
      if(terminal.has(result.state))process.exitCode=result.state==='TIMED_OUT'?124:result.state==='CANCELED'?130:Number.isInteger(result.exitCode)?Math.min(255,Math.max(0,result.exitCode)):result.signal?Math.min(255,128+result.signal):result.state==='SUCCEEDED'?0:1;
      else if(result.state==='UNKNOWN')process.exitCode=3;
    }else if(command==='project'&&['label','group','catalog','archive','unarchive','retire-plan','retire','retire-status'].includes(positionals[1])){
      const action=positionals[1],common=['machines','datasets','url','session-file','json'],extra={label:['project','display-name','revision'],group:['display-name','revision','members','primary'],catalog:['full'],archive:['project','revision'],unarchive:['project','revision'],'retire-plan':['project'],retire:['project','key','revision','manifest-sha256'],'retire-status':['project']}[action];
      if(training.length||options.datasets.length||options.machines.length>1||Object.keys(options).some(k=>![...common,...extra].includes(k)))fail('Project lifecycle accepts only its own documented options');
      const numeric=()=>{if(!/^\d+$/.test(options.revision||''))fail('Use the current nonnegative --revision');const value=Number(options.revision);if(!Number.isSafeInteger(value))fail('Revision is out of range');return value;};
      if(action==='catalog'){
        if(positionals.length!==2||options.machines.length)fail('Usage: project catalog [--full]');
        result=(await call('projects.catalog',{includeArchived:options.full===true})).result;
      }else if(action==='group'){
        if(positionals.length!==3||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(positionals[2]))fail('Usage: project group UUID [--display-name NAME --members SERVER/PROJECT,... --revision N]');
        const id=positionals[2];
        if(options['display-name']===undefined){if(['members','revision','primary'].some(k=>options[k]!==undefined))fail('Group read accepts only its UUID');result=(await call('projects.group.get',{id})).result;}
        else{
          const ref=value=>{const parts=String(value).split('/');if(parts.length!==2)fail('Each member must be SERVER/PROJECT');return {machine:machineName(parts[0]),project:projectSlug(parts[1])};};
          if(options.members===undefined)fail('Specify exact --members SERVER/PROJECT,... (none to detach all)');
          result=(await call('projects.group.set',{id,displayName:options['display-name'],revision:numeric(),members:options.members==='none'?[]:options.members.split(',').map(ref),...(options.primary?{primary:ref(options.primary)}:{})})).result;
        }
      }else{
        if(positionals.length>3)fail('Specify one exact project or original retirement UUID');
        const machine=defaultMachine(),project=projectSlug(action==='retire-status'?options.project:positionals[2]||options.project||selectedProject(machine)),ref={machine,project};
        if(action==='label'){
          result=(await call('projects.label.get',ref)).result;
          if(options['display-name']!==undefined)result=(await call('projects.label.set',{...ref,displayName:options['display-name'],revision:options.revision===undefined?result.revision:numeric()})).result;
        }else if(['archive','unarchive'].includes(action)){
          const status=(await call('projects.status',ref)).result;if(!Number.isSafeInteger(status.lifecycle?.revision))fail('Node lifecycle capability is unconfirmed; no legacy fallback');
          result=(await call('projects.'+action,{...ref,revision:options.revision===undefined?status.lifecycle.revision:numeric()})).result;
        }else if(action==='retire-plan')result=(await call('projects.retire.plan',ref)).result;
        else if(action==='retire-status'){
          if(positionals.length!==3||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(positionals[2]))fail('Use the original full retirement UUID');
          result=(await call('projects.retire.status',{...ref,key:positionals[2]})).result;
        }else{
          if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(options.key||'')||!/^[a-f0-9]{64}$/.test(options['manifest-sha256']||''))fail('Retire requires explicit --key UUID, --revision and --manifest-sha256 from its plan');
          process.stderr.write(`Retirement key: ${options.key}\nIf unconfirmed, inspect project retire-status ${options.key} --project ${project}\n`);
          result=(await call('projects.retire',{...ref,key:options.key,revision:numeric(),manifestSha256:options['manifest-sha256']})).result;
        }
      }
    }else if(command==='project'&&['copy','copy-status','copy-cancel','copy-retry'].includes(positionals[1])){
      const action=positionals[1],allowed=['machines','datasets','url','session-file','json',...(action==='copy'?['from','to','release','key']:action==='copy-retry'?['key']:[])];
      if(training.length||options.datasets.length||options.machines.length||positionals.length!==3||Object.keys(options).some(k=>!allowed.includes(k)))fail('Usage: project copy NAME --from SOURCE --to TARGET --release HASH | project copy-status|copy-cancel COPY_ID | project copy-retry COPY_ID [--key UUID]');
      const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
      if(action==='copy'){
        const from=machineName(options.from),machine=machineName(options.to),project=projectSlug(positionals[2]),key=options.key||randomUUID();
        if(from===machine||![from,machine].every(id=>state.machines.some(m=>m.id===id))||!uuid.test(key)||!/^[a-f0-9]{64}$/.test(options.release||''))fail('Specify authorized, different --from/--to, a full --release hash and a UUID --key');
        process.stderr.write('项目复制重试键：'+key+'（响应不明时保留，不要换键）\n');
        result=(await call('projects.replicate',{from,machine,project,release:options.release,key})).result;
      }else{
        if(!uuid.test(positionals[2]))fail('Use the complete project copy UUID');
        if(action==='copy-retry'){
          const key=options.key||randomUUID();if(!uuid.test(key))fail('Use a UUID --key for the controlled retry');
          process.stderr.write('项目复制显式重试键：'+key+'（响应不明时复用 --key，不要换键）\n');
          result=(await call('projects.replication.retry',{id:positionals[2],key})).result;
        }else result=(await call('projects.replication.'+(action==='copy-status'?'status':'cancel'),{id:positionals[2]})).result;
      }
      if(['FAILED','CANCELED'].includes(result.state))process.stderr.write('修复原因后可用 gpuctl project copy-retry '+result.id+'；旧操作停止和清理未确认时不会重试。\n');
      if(['FAILED','CANCELED'].includes(result.state))process.exitCode=1;else if(result.state==='UNKNOWN')process.exitCode=3;
    }else if(command==='project'&&['import','import-status','import-cancel','uploads','upload-cancel'].includes(positionals[1])){
      const action=positionals[1],allowed=['machines','datasets','url','session-file','json','project',...(action==='import'?['key']:[])];
      if(training.length||options.datasets.length||options.machines.length>1||Object.keys(options).some(k=>!allowed.includes(k)))fail('Project import accepts one authorized server and your selected project; no host/root or training options');
      const machine=defaultMachine(),project=projectSlug(options.project||selectedProject(machine));
      if(!state.machines.some(m=>m.id===machine))fail('Select an authorized server explicitly');
      const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
      let importRequest=null;
      if(action==='import'){
        if(positionals.length<3||positionals.length>4)fail('Usage: project import SOURCE [DEST] [--key UUID]; both paths are relative, destination must be new');
        const sourcePath=positionals[2],destinationPath=positionals[3]||sourcePath.split('/').at(-1);
        for(const value of [sourcePath,destinationPath])if(typeof value!=='string'||value.length>1024||value.includes('\\')||/[\p{Cc}\p{Cf}]/u.test(value)||value.split('/').some(p=>!p||p==='.'||p==='..'||p.length>255))fail('Use relative directories in your personal data workspace and project draft, never host paths');
        const key=options.key||randomUUID();if(!uuid.test(key))fail('Import key must be a full UUID');
        process.stderr.write(`Import key: ${key}\nIf the response is lost: gpuctl project import-status ${key}\n`);
        importRequest={machine,project,key,sourcePath,destinationPath};
        result=(await call('projects.local-import.begin',importRequest)).result;
      }else if(action==='uploads'){
        if(positionals.length!==2)fail('Usage: project uploads');
        result=(await call('files.upload.list',{machine,project,area:'code'})).result;
      }else{
        if(positionals.length!==3||!uuid.test(positionals[2]))fail('Use the original full operation UUID');
        const operation=action==='upload-cancel'?'files.upload.cancel':'projects.local-import.'+(action==='import-status'?'status':'cancel');
        result=(await call(operation,{machine,project,...(action==='upload-cancel'?{area:'code',uploadId:positionals[2]}:{key:positionals[2]})})).result;
      }
      if(action.startsWith('import')){
        const expected=action==='import'?importRequest.key:positionals[2];
        if(result?.protocol!=='project-local-import-v1'||result.project!==project||result.key!==expected||!uuid.test(result.key)||!['IMPORTING','COMMITTING','IMPORTED','FAILED','CANCELED','UNKNOWN'].includes(result.state)||result.draftChanged!==(result.state==='IMPORTED'))fail('Node did not confirm the fixed local import protocol; keep the printed operation ID and inspect status');
        if(importRequest&&(result.sourcePath!==importRequest.sourcePath||result.destinationPath!==importRequest.destinationPath))fail('Node import paths differ from the fixed request; keep the original key for inspection');
      }else if(action==='uploads'){
        if(result?.protocol!==1||result.project!==project||!Array.isArray(result.uploads)||result.uploads.length>64)fail('Node did not confirm pending upload discovery');
      }else if(result?.protocol!==1||result.uploadId!==positionals[2]||!['CANCELED','ABSENT'].includes(result.state))fail('Node did not confirm exact upload cancellation');
      result={...result,machine};
      if(result.state==='FAILED'||result.state==='CANCELED'&&action!=='import-cancel'&&action!=='upload-cancel')process.exitCode=1;else if(result.state==='UNKNOWN')process.exitCode=3;
    }else if(command==='project'&&['list','quota','create','use','status','publish'].includes(positionals[1])){
      if(options.legacy)fail('Project commands do not accept --legacy');
      const action=positionals[1],machine=defaultMachine();
      if(!state.machines.some(m=>m.id===machine))fail('这台机器未授权或不存在');
      if(['list','quota'].includes(action)){
        if(positionals.length!==2||options.project||options['env-mode'])fail('Usage: project list|quota [--machine SERVER]');
        result=(await call('projects.'+action,{machine})).result;
      }else{
        if(positionals.length>3)fail('Usage: project create|use NAME | project status|publish [NAME]');
        const project=projectSlug(positionals[2]||options.project||(['status','publish'].includes(action)?selectedProject(machine):null));
        if(positionals[2]&&options.project&&positionals[2]!==options.project)fail('Conflicting project names');
        if(options.key)fail('--key is for training submissions; publication is tracked per project with project status');
        result=(await call(`projects.${action==='use'?'status':action}`,{machine,project,...(action==='create'?{environmentMode:'oci'}:{})})).result;
        if(action==='create'&&(result?.project!==project||result.environmentMode!=='oci'))fail('Node did not confirm the personal container project. Inspect the original project; no fallback or replacement was accepted.');
        if(action==='create'||action==='use'){
          session.projectsByMachine={...session.projectsByMachine,[machine]:project};await saveSession();
          result={...result,machine,selectedProject:project};
        }
      }
    }else if(command==='terminal'&&['status','close'].includes(positionals[1])){
      const allowed=['machines','datasets','url','session-file','json','root','project','legacy','data-workspace'];
      if(positionals.length!==3||training.length||options.datasets.length||Object.keys(options).some(k=>!allowed.includes(k)))fail('Usage: terminal status|close SESSION [--machine SERVER] [--project NAME | --root | --data-workspace]');
      const id=positionals[2],machine=defaultMachine(),hostAdmin=options.root===true;
      if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))fail('Terminal requires the complete original session UUID');
      if(!state.machines.some(m=>m.id===machine))fail('这台机器未授权或不存在');
      if(options['data-workspace']&&(hostAdmin||options.project)||hostAdmin&&options.project)fail('Terminal scopes cannot be combined');
      const context=options['data-workspace']?{dataWorkspace:true}:hostAdmin?{}:projectArgs(machine);
      result=(await call('terminal.'+positionals[1],{machine,id,hostAdmin,...context})).result;
      if(result?.protocol!=='terminal-session-status-v1'||result.id!==id)fail('Original terminal status was not confirmed; upgrade the matching node. No replacement was started.');
      if(positionals[1]==='close'&&(result.closed!==true||result.state!=='STOPPED'||result.metadataOnly!==true))fail('Ended-session cleanup was not confirmed; query the same session ID.');
    }else if(command==='shell'&&positionals.length===2){
      if(!process.stdin.isTTY)fail('交互终端需要 TTY；非交互任务使用 gpuctl run');
      const machine=positionals[1],hostAdmin=options.root===true;
      if(!state.machines.some(m=>m.id===machine))fail('这台机器未授权或不存在');
      if(hostAdmin&&(options.project||options.job))fail('Host root terminal does not accept --project or --job');
      if(options.takeover&&!options.reconnect)fail('--takeover requires --reconnect SESSION');
      if(options.reconnect&&!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(options.reconnect))fail('Reconnect requires a complete terminal UUID');
      const context=dataTerminal?{dataWorkspace:true}:hostAdmin?{}:projectArgs(machine);
      if(options.job){
        const job=state.jobs.find(job=>job.id===options.job&&job.userId===session.principal.userId);
        if(!job?.interactive||job.machine!==machine||dataTerminal||hostAdmin)fail('请选择本账号在这台服务器上的 GPU 交互任务。');
        if(job.state!=='RUNNING')fail('GPU 交互任务尚未运行；使用 gpuctl jobs 查看排队状态。');
        context.project=job.project;options.reconnect=job.id;
      }
      const key=randomUUID(),clientId=randomUUID(),id=options.reconnect||key,openMode=options.reconnect?'reconnect':'new';
      const scope=dataTerminal?['--data-workspace']:hostAdmin?['--root']:context.project?['--project',context.project]:['--legacy'];
      const commandText=parts=>parts.map(value=>/^[A-Za-z0-9_.:-]+$/.test(value)?value:"'"+value.replaceAll("'","'\\''")+"'").join(' ');
      const statusCommand=commandText(['gpuctl','terminal','status',id,'--machine',machine,...scope]);
      const reconnectCommand=commandText(['gpuctl',...(dataTerminal?['data','shell']:['ssh']),'--machine',machine,
        ...(dataTerminal?[]:scope),'--reconnect',id]);
      const terminal={id,machine,project:context.project||null,dataWorkspace:dataTerminal,hostAdmin,mode:openMode,state:'UNKNOWN',statusCommand};
      const unconfirmed=error=>Object.assign(Error(`${error.message}\n终端状态未确认，未重开或重放输入。只读查询原会话：${statusCommand}`),{terminal,status:error.status,code:error.code});
      // Print and durably save the original identity before dispatch. Writer
      // credentials remain only in this connection's memory.
      await new Promise((resolve,reject)=>process.stderr.write('Terminal: '+maintenanceJSON(terminal)+'\n',error=>error?reject(error):resolve()));
      let opened;
      try{
        const latest=JSON.parse(await readFile(sessionFile,'utf8'));
        if(latest.url!==base.origin||latest.token!==session.token||latest.principal?.userId!==session.principal?.userId)
          fail('登录缓存已改变，未打开终端；请核对当前账号。');
        const saved=latest.terminalSessions?.[id];
        if(saved&&(saved.userId!==session.principal.userId||['machine','project','hostAdmin','dataWorkspace'].some(name=>saved[name]!==terminal[name])))
          fail('原终端记录的账号或范围不匹配，未打开终端；请使用原服务器和项目查询。');
        const next={...latest,terminalSessions:{...latest.terminalSessions,[id]:{...terminal,userId:session.principal.userId}}};
        await saveDatasetUploadSession(sessionFile,next);session=next;
        opened=(await call('terminal.open',{machine,key,clientId,mode:openMode,...(options.reconnect?{id,takeover:options.takeover===true}:{}),hostAdmin,...context})).result;
        const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
        if(opened?.id!==id||opened.clientId!==clientId||opened.mode!==openMode||opened.hostAdmin!==hostAdmin||
          !uuid.test(opened.writerToken||'')||!Number.isFinite(opened.leaseExpiresAt)||opened.leaseExpiresAt<=Date.now()/1000||opened.leaseExpiresAt>=253402300800||
          opened.machine!==undefined&&opened.machine!==machine||opened.project!==undefined&&opened.project!==context.project||
          opened.dataWorkspace!==undefined&&opened.dataWorkspace!==dataTerminal)
          fail('终端身份或单写租约未获确认，未发送输入；请核对原会话和匹配节点协议。');
      }catch(error){throw unconfirmed(error);}
      let input=Buffer.alloc(0),offset=0,done=false,closed=false,delay=250,lastSize='';
      const sessionArgs={machine,id:opened.id,clientId,writerToken:opened.writerToken,hostAdmin,...context};
      process.stderr.write(`\r\n${machine} · ${dataTerminal?'个人数据 /data2':hostAdmin?'ROOT 宿主机':context.project?'项目 '+context.project:'个人工作区'} · ${opened.id}（Ctrl+] 仅断开；exit 结束此会话）\r\n`);
      process.stdin.setRawMode(true);process.stdin.resume();
      const listener=chunk=>{if(chunk.includes(29)){done=true;return;}input=Buffer.concat([input,chunk]);if(input.length>262144)process.stdin.pause();};process.stdin.on('data',listener);
      try{while(!done){const sent=input.subarray(0,8192);input=input.subarray(sent.length);if(input.length<131072)process.stdin.resume();const size={cols:process.stdout.columns||110,rows:process.stdout.rows||32},sizeKey=JSON.stringify(size);const response=(await call('terminal.exchange',{...sessionArgs,offset,input:sent.toString('base64'),...(sizeKey===lastSize?{}:{cols:size.cols,rows:size.rows})})).result;lastSize=sizeKey;offset=response.offset;if(response.data)process.stdout.write(Buffer.from(response.data,'base64'));if(response.exited){await call('terminal.close',sessionArgs);closed=true;break;}await new Promise(r=>setTimeout(r,delay));}}
      catch(error){throw unconfirmed(error);}
      finally{process.stdin.off('data',listener);process.stdin.setRawMode(false);process.stdin.pause();if(!closed)try{await call('terminal.detach',sessionArgs);}catch{process.stderr.write('\r\n写入权释放未确认；等待 30 秒或明确接管后再重连。\r\n');}process.stderr.write(`\r\n${closed?'此终端已结束。':`已断开。只读查询：${statusCommand}\r\n重连：${reconnectCommand}`}\r\n`);}return;
    }else if(command==='invites'&&positionals[1]==='list'&&positionals.length===2)result=(await call('invites.list')).result;
    else if(command==='invites'&&['rotate','disable'].includes(positionals[1])&&['admin','member'].includes(positionals[2])&&positionals.length===3)result=(await call(`invites.${positionals[1]}`,{role:positionals[2]})).result;
    else if(command==='users'&&positionals.length===1)result=state.users;
    else if(command==='state'&&positionals.length===1)result=state;
    else if(command==='logout'&&positionals.length===1){result=(await call('logout')).result;await unlink(sessionFile).catch(e=>{if(e.code!=='ENOENT')throw e;});}
    else if(command==='user'&&positionals[1]==='role'&&positionals.length===4)result=(await call('users.role',{userId:find(positionals[2]),role:positionals[3]})).result;
    else if(command==='user'&&positionals.length===3){
      const [_,action,username]=positionals;
      if(action==='add')result=(await call('users.create',{username,password:await secret(),role:options.role||'member'})).result;
      else if(action==='reset-password')result=(await call('users.reset',{userId:find(username),password:await secret()})).result;
      else if(action==='enable'||action==='disable')result=(await call('users.enabled',{userId:find(username),enabled:action==='enable'})).result;
      else if(action==='delete')result=(await call('users.delete',{userId:find(username)})).result;
      else fail('Unknown user command');
    }else if(command==='data'&&positionals[1]==='label'){
      const allowed=['machines','datasets','url','session-file','json','display-name','revision','owner-id'];
      if(positionals.length!==3||training.length||options.datasets.length||Object.keys(options).some(k=>!allowed.includes(k)))fail('Usage: data label DATASET_ID [--display-name TEXT] [--machine SERVER] [--revision N]');
      const machine=defaultMachine(),dataset=positionals[2],label=options['display-name'];
      if(machine==='auto'||!state.machines.some(m=>m.id===machine)||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(dataset))fail('Select an authorized server and an exact dataset ID, not a version or display label');
      if(options['owner-id']!==undefined&&(session.principal.role!=='admin'||!/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/.test(options['owner-id'])))fail('Only administrators may specify a valid --owner-id');
      if(label!==undefined&&(typeof label!=='string'||!label.trim()||[...label.trim()].length>80||/[\p{Cc}\p{Cf}]/u.test(label)))fail('Dataset display names must be 1–80 visible characters');
      if(options.revision!==undefined&&(label===undefined||!/^\d+$/.test(options.revision)||!Number.isSafeInteger(Number(options.revision))))fail('--revision requires --display-name and a nonnegative integer');
      const context={machine,dataset,...(options['owner-id']?{ownerId:options['owner-id']}:{})};
      const current=(await call('datasets.label.get',context)).result;
      if(label===undefined)result=current;
      else{
        if(!Number.isSafeInteger(current.revision)||current.revision<0||current.scope!=='personal'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(current.dataset||''))fail('Dataset label revision is unconfirmed; no change was sent');
        if(options.revision!==undefined&&Number(options.revision)!==current.revision)fail('Dataset label changed; read it again before replacing. No automatic overwrite was sent');
        result=(await call('datasets.label.set',{...context,dataset:current.dataset,displayName:label.trim(),revision:current.revision})).result;
      }
    }else if(command==='data'&&positionals[1]==='cloud'){
      if(training.length)fail('Cloud files do not accept extra commands');
      const machine=defaultMachine();if(machine==='auto'||!state.machines.some(m=>m.id===machine))fail('Select an authorized server explicitly');
      result=await runCloudFiles({positionals,options,machine,call});
    }else if(command==='data'&&['import','imports','import-status','import-resume','import-cancel','import-discard'].includes(positionals[1])){
      if(training.length)fail('导入不接受额外命令。');
      result=await runCloudImport({action:positionals[1],positionals,options,machine:defaultMachine(),call});
    }else if(command==='data'&&['copy','copy-status','copy-resume','copy-cancel'].includes(positionals[1])){
      const action=positionals[1],allowed=['machines','datasets','url','session-file','json',...(action==='copy'?['from','to','source-root','key']:[])];
      if(training.length||options.datasets.length||Object.keys(options).some(k=>!allowed.includes(k)))fail('Invalid data copy options');
      if(action==='copy'){
        if(positionals.length!==4||!options.from||!options.to)fail('Usage: data copy SOURCE_DIR DEST_DIR --from SERVER --to SERVER [--source-root hdd|mine] [--key UUID]');
        const key=options.key||randomUUID();
        process.stderr.write(`Copy key: ${key}\n`);
        result=(await call('data.copy.start',{machine:machineName(options.to),from:machineName(options.from),scope:options['source-root']||'mine',path:positionals[2],destination:positionals[3],key})).result;
      }else{
        if(positionals.length!==3)fail('Usage: data copy-status|copy-resume|copy-cancel KEY --machine TARGET');
        result=(await call('data.copy.'+action.slice(5),{machine:defaultMachine(),key:positionals[2]})).result;
      }
    }else if(command==='data'&&['put','files','workspace-status'].includes(positionals[1])){
      const action=positionals[1],allowed=['machines','datasets','url','session-file','json',...(action==='put'?['overwrite','via']:[])];
      if(training.length||options.datasets.length||Object.keys(options).some(k=>!allowed.includes(k)))fail('Personal data commands do not accept project, root or training options');
      const machine=defaultMachine();if(machine==='auto'||!state.machines.some(m=>m.id===machine))fail('Select an authorized server explicitly');
      if(action==='put'){
        if(positionals.length<3||positionals.length>4)fail('Usage: data put LOCAL_FILE [REMOTE_FILE] [--overwrite]');
        result=await putWorkspaceData(call,machine,positionals[2],positionals[3]||basename(positionals[2]),options.overwrite,{via:options.via||'auto'});
      }else if(action==='files'){
        if(positionals.length>3)fail('Usage: data files [RELATIVE_DIRECTORY]');
        result=(await call('datasets.workspace.list',{machine,path:workspaceDataPath(positionals[2]||'.',{directory:true})})).result;
      }else{
        if(positionals.length!==2)fail('Usage: data workspace-status');
        result={...(await call('datasets.workspace.status',{machine})).result,machine};
      }
    }else if(command==='data'&&positionals[1]==='upload'){
      if(positionals.length!==3||training.length||options.datasets.length||Object.keys(options).some(k=>!['machines','datasets','url','session-file','json','name','via'].includes(k)))fail('Usage: data upload ARCHIVE_OR_DIRECTORY --name NAME [--machine SERVER] [--via auto|direct|relay]');
      if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(options.name||''))fail('Dataset name must be 1–40 ASCII letters, digits, _ or -, beginning with a letter or digit');
      const machine=defaultMachine();if(machine==='auto'||!state.machines.some(m=>m.id===machine))fail('Select an authorized server explicitly');
      let last=0,phase='';const progress=(next,value)=>{if(next==='HANDLE'){process.stderr.write(`Upload: ${value.uploadId} · ${value.machine}\n`);return;}if(next==='ROUTE'){process.stderr.write(value.kind==='campus-direct'?'传输路径：直连上传节点（文件不经平台中转）\n':value.kind==='tail-upload'?'传输路径：Tail 备用上传（不改变默认路由；中继可能影响速度）\n':`传输路径：VPS 中转${value.explicit?'（已明确选择）':'（小文件通道）'}\n`);return;}const now=Date.now();if(next!==phase||now-last>1000){phase=next;last=now;process.stderr.write(`${next}${value.bytes!==undefined?' · '+value.bytes+(value.totalBytes!==undefined?' / '+value.totalBytes:'')+' bytes':''}${value.path?' · '+value.path:''}\n`);}};
      const saveUploadValue=async(field,key,value)=>{const next={...session,[field]:{...session[field],[key]:value}};await saveDatasetUploadSession(sessionFile,next);session=next;};
      const keyStore={get:key=>session.datasetUploadKeys?.[key],set:(key,value)=>saveUploadValue('datasetUploadKeys',key,value),getIntent:key=>session.datasetUploadIntents?.[key],setIntent:(key,value)=>saveUploadValue('datasetUploadIntents',key,value),getHandle:key=>session.datasetUploadHandles?.[key],setHandle:(key,value)=>saveUploadValue('datasetUploadHandles',key,value)};
      result=await uploadLocalDataset(call,{machine,name:options.name,userId:session.principal.userId,directory:positionals[2],progress,keyStore,admission:state.datasetUploadAdmission,via:options.via||'auto'});
    }else if(command==='data'&&['upload-status','upload-discard'].includes(positionals[1])){
      if(positionals.length!==3||training.length||options.datasets.length||Object.keys(options).some(k=>!['machines','datasets','url','session-file','json'].includes(k)))fail('Usage: data upload-status|upload-discard UPLOAD_ID [--machine SERVER]');
      const machine=defaultMachine();if(machine==='auto'||!state.machines.some(m=>m.id===machine))fail('Select an authorized server explicitly');
      result={...(await call('datasets.upload.'+(positionals[1]==='upload-status'?'status':'discard'),{machine,uploadId:positionals[2]})).result,machine};if(result.state==='FAILED')process.exitCode=1;
    }else if(command==='data'&&['delete','delete-status','retire-status','retire-restore','retire-continue','retire-cancel','retire-discard-registration'].includes(positionals[1])){
      const action=positionals[1],restore=action==='retire-restore',discard=action==='retire-discard-registration';
      const allowed=['machines','datasets','url','session-file','json',...(action==='delete'?['key']:discard?['key','name']:[])];
      if(positionals.length!==3||training.length||options.datasets.length||Object.keys(options).some(k=>!allowed.includes(k)))fail('Usage: data delete NAME@VERSION --key UUID | delete-status KEY | retire-status OPERATION_ID | retire-restore OPERATION_ID --machine SERVER');
      if(action==='delete'){
        if(options.machines.length)fail('彻底删除覆盖所有服务器，不接受 --machine。');
        const [dataset,version,...extra]=positionals[2].split('@'),key=options.key||randomUUID();
        if(extra.length||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(dataset)||!/^[a-f0-9]{64}$/.test(version||'')||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(key))fail('需要 NAME@完整版本 和 UUID --key。');
        process.stderr.write(`Deletion key: ${key}\n`);
        try{result=(await call('datasets.delete',{dataset,version,key})).result;}
        catch(error){fail(`${error.message}\n删除结果未确认，不会重投。查询：gpuctl data delete-status ${key}`);}
      }else{
        const operationId=positionals[2];
        if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(operationId))fail('需要完整 UUID 删除编号。');
        if(discard){
          if(session.principal.role!=='admin')fail('只有管理员可丢弃从未安装的登记意图。');
          if(options.machines.length!==1||options.machines[0].includes('='))fail('丢弃登记意图需明确指定一个 --machine SERVER。');
          const machine=machineName(options.machines[0]),key=options.key;
          if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(machine)
            ||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(key||'')
            ||options.name!==undefined&&!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(options.name))fail('需要有效服务器、固定 UUID --key 和可选数据集 --name。');
          const args={operationId,machine,key,...(options.name!==undefined?{dataset:options.name}:{})};
          try{result=(await call('datasets.delete.registration.discard',args)).result;}
          catch(error){fail(`${error.message}\n丢弃结果未确认；核对后只重试同一条命令、同一个 --key ${key}。`);}
        }else if(['retire-continue','retire-cancel'].includes(action)){
          if(session.principal.role!=='admin')fail('只有管理员可继续或取消删除。');
          if(options.machines.length)fail('继续或取消覆盖原任务，不接受 --machine。');
          try{result=(await call('datasets.delete.'+(action==='retire-continue'?'continue':'cancel'),{operationId})).result;}
          catch(error){fail(`${error.message}\n只查询原编号：gpuctl data retire-status ${operationId}`);}
        }else if(restore){
          if(session.principal.role!=='admin')fail('只有管理员可恢复保留的数据。');
          if(options.machines.length!==1||options.machines[0].includes('='))fail('恢复需明确指定一个 --machine SERVER。');
          const machine=machineName(options.machines[0]);
          if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(machine))fail('服务器 ID 无效。');
          try{result=(await call('datasets.delete.restore',{operationId,machine})).result;}
          catch(error){fail(`${error.message}\n恢复结果未确认。只查询：gpuctl data retire-status ${operationId}`);}
        }else{
          if(options.machines.length)fail('删除查询不接受 --machine。');
          result=(await call('datasets.delete.status',action==='delete-status'?{key:operationId}:{operationId})).result;
        }
      }
      if(result.state==='UNKNOWN')process.exitCode=3;
      else if(['FAILED','BLOCKED'].includes(result.state))process.exitCode=1;
    }else if(command==='data'&&positionals[1]==='archive-enroll'){
      if(positionals.length!==3||training.length||options.datasets.length||Object.keys(options).some(k=>!['machines','datasets','url','session-file','json','owner-id','key'].includes(k)))fail('Usage: data archive-enroll NAME@VERSION --machine HOT_MACHINE --owner-id ID --key UUID');
      const [dataset,version,...extra]=positionals[2].split('@'),machine=defaultMachine();
      if(session.principal.role!=='admin'||!/^(builtin-admin|demo-user-[0-9]+)$/.test(options['owner-id']||''))fail('An administrator and explicit immutable --owner-id are required');
      if(extra.length||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(dataset)||!/^[a-f0-9]{64}$/.test(version||'')||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(options.key||''))fail('Use NAME@FULL_VERSION_HASH and a persistent UUID --key');
      if(machine==='auto'||options.machines.length!==1||!state.machines.some(m=>m.id===machine))fail('Select one explicit hot machine for enrollment');
      result=(await call('datasets.archive.enroll',{machine,dataset,version,ownerId:options['owner-id'],key:options.key})).result;
    }else if(command==='data'&&positionals[1]==='storage'){
      if(session.principal.role!=='admin')fail('Storage management requires an administrator account');
      if(training.length||options.datasets.length||Object.keys(options).some(k=>!['machines','datasets','url','session-file','json'].includes(k)))fail('Storage commands accept only one --machine SERVER and --json');
      const action=positionals[2]||'status',machine=defaultMachine();
      if(machine==='auto'||!state.machines.some(m=>m.id===machine))fail('Select an authorized server explicitly');
      if(!['status','plan','pin','unpin'].includes(action))fail('Usage: data storage status [NAME@VERSION] | plan | pin|unpin NAME@VERSION LABEL');
      const expected=action==='status'?[2,3,4]:action==='plan'?[3]:[5];
      if(!expected.includes(positionals.length))fail('Invalid number of storage command arguments');
      let ref={};
      if(positionals[3]){
        const parts=positionals[3].split('@');
        if(parts.length!==2||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(parts[0])||!/^[a-f0-9]{64}$/.test(parts[1]))fail('Use NAME@FULL_VERSION_HASH');
        ref={dataset:parts[0],version:parts[1]};
      }
      if(['pin','unpin'].includes(action)){
        const pinId=positionals[4];
        if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(pinId)||pinId.startsWith('authority-'))fail('Use a manual pin label; authority retention cannot be removed here');
        ref.pinId=pinId;
      }
      result={...(await call('datasets.storage.'+action,{machine,...ref})).result,machine};
    }else if(command==='data'&&['list','prepare','status','unregister','archive-retry'].includes(positionals[1])){
      if(positionals.length!==(positionals[1]==='list'?2:3))fail('Usage: data list | data prepare NAME@VERSION | data status NAME@VERSION|OPERATION_ID | data unregister NAME[@VERSION]');
      if(training.length||options.datasets.length||['as','project','release','job','root','legacy','cards','min-vram','name','key','total','role','full'].some(key=>Object.hasOwn(options,key)))fail('data commands accept only the dataset reference and one --machine SERVER');
      const action=positionals[1],machine=defaultMachine(),byOperation=action==='status'&&/^[a-f0-9]{64}$/.test(positionals[2]||'');
      if(machine==='auto'||!state.machines.some(m=>m.id===machine))fail('Select an authorized server explicitly');
      let reference={};
      if(byOperation)reference={operationId:positionals[2]};
      else if(action!=='list'){
        const ref=positionals[2].split('@');
        if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(ref[0])||ref.length>2||
          (ref.length===2&&!/^[a-f0-9]{64}$/.test(ref[1]))||(action!=='unregister'&&ref.length!==2))fail('Use NAME@FULL_VERSION_HASH; only unregister also accepts a bare NAME');
        reference={dataset:ref[0],...(ref.length===2?{version:ref[1]}:{})};
      }
      if(action==='unregister'&&session.principal.role!=='admin'&&!reference.version)fail('成员删除必须指定本人个人数据的完整版本。');
      try{result=(await call(action==='archive-retry'?'datasets.archive.retry':'datasets.'+action,{machine,...reference})).result;}
      catch(error){if(action==='unregister')fail(`${error.message}\nUnregister outcome is unconfirmed; a background worker may still run. Inspect node operations before retrying.`);throw error;}
      if(action==='unregister'||byOperation){result={...result,machine};if(result.state==='FAILED')process.exitCode=1;else if(result.state==='UNKNOWN')process.exitCode=3;}
    }else if(command==='run'&&positionals.length===2){
      if(options.as)fail('--as cannot be used for real execution');
      const automatic=positionals[1]==='auto';
      if(options.candidates!==undefined&&!automatic)fail('--candidates requires --machine auto');
      if(options.interactive){
        if(training.length||options.release||options.legacy)fail('--interactive 使用项目工作区，不接受命令、固定版本或旧工作区。');
        training=['/bin/bash','--noprofile','--norc','-i'];
      }
      if(!training.length)fail('Put the training command after --');
      const developmentMachine=automatic?selectedMachine():positionals[1],context=projectArgs(developmentMachine);
      if(automatic&&!context.project)fail('自动选机需要项目工作区。');
      const candidates=options.candidates?.split(',').map(machineName);
      if(candidates&&(!candidates.length||new Set(candidates).size!==candidates.length||candidates.some(id=>!state.machines.some(m=>m.id===id))))fail('--candidates must list unique authorized server IDs separated by commas');
      if(options.release&&!context.project)fail('--release requires a selected project');
      if(options.sync&&!context.project)fail('run --sync requires a selected project; use gpuctl project create/use first');
      const key=options.key||randomUUID();process.stderr.write(`Submission key: ${key}\n`);
      if(options.sync&&!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(key))fail('--key must be a UUID');
      if(options.datasets.length||options['data-read']||options.release)fail('训练直接读取 /data 下的本机目录；不再使用 --data、--data-read 或 --release。');
      const indices=options.gpu?.split(',').map(n=>/^\d+$/.test(n)?Number(n):NaN),cards=Number(options.cards||indices?.length||1);
      const elastic=elasticKeys.some(k=>Object.hasOwn(options,k))?elasticAllocation({minCards:Number(options['min-cards']),globalBatch:Number(options['global-batch']),microBatch:Number(options['micro-batch']),autoExpand:options['auto-expand']===true},cards,scheduling).elastic:null;
      const placement=placementKeys.some(k=>Object.hasOwn(options,k))?gpuPlacement({gpuIndices:indices,shared:options.share===true,...(options['vram-mib']?{vramMiB:Number(options['vram-mib'])}:{}),hami:options.hami===true,...(options['sm-percent']?{smPercent:Number(options['sm-percent'])}:{})},cards,elastic,scheduling,options.priority):null;
      if(options.description!==undefined&&state.taskMetadata?.version!==1)fail('当前后台尚未支持任务描述；不会忽略你填写的内容。');
      if(!context.project)fail('请先选择项目工作区。');
      if(options.sync){
        if(automatic)fail('先 push 到目标机器，再自动选机；run --sync 需要指定机器。');
        await uploadCodeFiles(call,{machine:developmentMachine,context:{project:context.project,area:'code'},local:options['sync-dir']||process.cwd(),remote:'.',verifyTree:true});
      }
      process.stderr.write(`Project: ${context.project} · 持久工作区\n`);
      if(options.interactive)context.interactive=true;
      if(memoryLimitGiB!==undefined)context.memoryLimitGiB=memoryLimitGiB;
      result=(await call('jobs.submit',{machine:positionals[1],...(automatic?{machineSelection:{mode:'auto',...(candidates?{candidates}:{})}}:{}),cards,minVramGiB:Number(options['min-vram']||0),name:options.name||'train',...(options.description!==undefined?{description:taskDescription(options.description)}:{}),argv:training,key,...(options.priority?{priority:options.priority}:{}),...(scheduling?{scheduling}:{}),...(elastic?{elastic}:{}),...(placement?{placement}:{}),...context})).result;
    }else if(command==='jobs'&&positionals.length===1)result=state.jobs;
    else if(command==='priority'&&positionals.length===3){
      if(!['idle','normal','high','P0','P1','P2','P3','P4'].includes(positionals[2]))fail('Queue rank must be P0..P4 (or idle, normal, high); yielding/restart stay unchanged');
      if(options.key||training.length)fail('priority does not accept a submission key or command argv');
      result=(await call('jobs.priority',{jobId:positionals[1],priority:positionals[2]})).result;
    }
    else if(command==='reconcile-resources'){
      if(positionals.length!==2||training.length||options.machines.length||options.datasets.length||Object.keys(options).some(k=>!['machines','datasets','json','url','session-file'].includes(k)))fail('Usage: reconcile-resources JOB [--json]; no paths, machine or execution options');
      result=(await call('jobs.reconcile-resources',{jobId:positionals[1]})).result;
    }
    else if(command==='completion'){
      if(positionals.length!==2||training.length||options.machines.length||options.datasets.length||Object.keys(options).some(k=>!['machines','datasets','json','url','session-file'].includes(k)))fail('Usage: completion JOB [--json]; no paths, machine or execution options');
      result=(await call('jobs.completion',{jobId:positionals[1]})).result;
      if(result.completed!==true)process.exitCode=2;
    }
    else if(command==='diagnostics'){
      if(positionals.length!==2||training.length||options.machines.length||options.datasets.length||Object.keys(options).some(k=>!['machines','datasets','json','url','session-file'].includes(k)))fail('Usage: diagnostics JOB [--json]; no paths, machine or execution options');
      result=(await call('jobs.diagnostics',{jobId:positionals[1]})).result;
    }
    else if(command==='watch'&&positionals.length===2){
      const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
      try{process.exitCode=await watchJob(call,positionals[1],{interval:options.interval===undefined?5:Number(options.interval),json:options.json===true,signal:controller.signal});}
      finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);}return;
    }
    else if(command==='notify'&&positionals.length===3)result=(await call('notifications.job',{jobId:positionals[1],...(positionals[2]==='status'?{}:{enabled:positionals[2]==='on'})})).result;
    else if(command==='notes'&&positionals.length===1){
      result=(await call('community.notes.list',{})).result;
    }else if(command==='note'&&positionals.length===2){
      if(Boolean(options.general)===Boolean(options.job))fail('Choose --job JOB_ID or --general for a note');
      const key=options.key||randomUUID();process.stderr.write(`Note key: ${key}; reuse --key after an uncertain response.\n`);
      result=(await call('community.notes.create',{body:positionals[1],key,...(options.job?{jobId:options.job}:{})})).result;
    }else if(command==='note-delete'&&positionals.length===2){
      const {note}=(await call('community.notes.get',{id:positionals[1]})).result;
      result=(await call('community.notes.delete',{id:note.id,revision:note.revision})).result;
    }
    else if(['logs','cancel'].includes(command)&&positionals.length===2)result=(await call(command==='logs'?'jobs.logs':'jobs.cancel',{jobId:positionals[1]})).result;
    else if(command==='files'&&positionals.length<=3)result=(await call('files.list',{machine:positionals[1],path:positionals[2]||'.',...fileArgs(positionals[1])})).result;
    else if(['upload','upload-status'].includes(command)&&positionals.length>=3&&positionals.length<=4){
      if(options.job)fail('Job outputs cannot be uploaded; upload project code without --job');
      const machine=positionals[1],context=fileArgs(machine);
      result=await uploadCodeFiles(call,{machine,context,local:positionals[2],remote:positionals[3]||basename(positionals[2]),inspectOnly:command==='upload-status'});
    }else if(command==='download'&&positionals.length===4){
      const context=fileArgs(positionals[1]);
      result=await downloadFile(call,{machine:positionals[1],context,path:positionals[2],destination:positionals[3],origin:base.origin,userId:session.principal.userId});
    }else if(command==='grant'&&positionals.length===2){
      const userId=find(positionals[1]),policyVersion=state.users.find(u=>u.id===userId).policyVersion;
      if(options.full){result=(await call('policy.full',{userId,policyVersion})).result;}
      else{
      const limits={};for(const spec of options.machines){const pair=spec.split('=');if(pair.length!==2||!/^\d+$/.test(pair[1])||Object.hasOwn(limits,pair[0]))fail('Expected unique --machine NAME=CARDS');limits[pair[0]]=Number(pair[1]);}
      if(!/^\d+$/.test(options.total||''))fail('--total must be an integer');
      result=(await call('policy.save',{userId,limits,total:Number(options.total),...(state.demo?{}:{policyVersion})})).result;
      }
    }else if(command==='request'&&positionals.length===2){
      if(!/^\d+$/.test(options.cards||''))fail('--cards must be an integer');
      result=(await call('request',{userId:own(),machine:positionals[1],cards:Number(options.cards)})).result;
    }else if(command==='release'&&positionals.length===2)result=(await call('release',{userId:own(),jobId:positionals[1]})).result;
    else fail('Unknown command. Use --help.');
  }
  // JSON escapes are lossless for callers while also safe to print in a terminal.
  if(options.json){console.log((command==='community'?communityJSON:maintenanceJSON)({ok:true,...mode,data:result}));return;}
  // Explicit log/host-command streams remain raw; historical maintenance and
  // community have their own safe formatters. Never alter arguments or storage.
  if(!['logs','exec','maintenance','community'].includes(command))result=terminalMetadata(result);
  if(command==='community'){console.log(formatCommunityResult(result));return;}
  if(command==='login'){console.log(`已登录：${result.principal.username}`);return;}
  if(command==='profile'){console.log(`姓名／显示名：${result.name}\n登录用户名：${result.username}`);return;}
  if(command==='task-label'){
    if(result.available!==true)console.log('节点尚未确认安全编辑能力；未修改任务。');
    else console.log(`${result.nodeJobId} · ${result.name}\n描述：${result.description||'未填写描述'}\n显示版本：${result.revision}\n仅展示信息；原命令、任务身份和运行状态不变。`);
    return;
  }
  if(command==='queue'){if(result.stale)console.log('监控已过期；以下是平台记录与上次核对状态，不代表空闲。');for(const h of result.hosts){console.log(`${h.machine} · ${h.reachable?'可采集':'监控不可用'} · ${h.checkedAt||'暂无采集时间'}`);for(const t of h.tasks)console.log(`  ${t.id} · ${t.state} · ${t.name}\n  提交者：${t.submitter?.name||'未知'}${t.submitter?.username&&t.submitter.username!==t.submitter.name?'（'+t.submitter.username+'）':''}\n  描述：${t.description||'未填写描述'}\n  分配 GPU：${t.assignedGpuIndices?.join(', ')||'—'}`);if(!h.tasks.length)console.log('  暂无任务记录。');}return;}
  if(command==='logout'){console.log('已退出登录。');return;}
  if(command==='sync'){
    if(['status','cancel'].includes(positionals[1]))console.log(`代码同步：${result.state}\n${result.machine} / ${result.project}\n原编号：${result.key}${result.state==='CANCELED'?'\n已保留部分代码和原回执；该编号不能再续传。':''}`);
    else if(result.state==='PREVIEW')console.log(`同步预览：${result.source?.commit||result.source?.machine||'Git'} → ${result.target}\n${result.project||result.name} · ${result.bytes} B · ${result.entries} 项\n未写入目标。去掉 --dry-run 执行，重复原命令可续传。`);
    else if(result.state==='CODE_READY')console.log(`代码已校验：${result.machine} / ${result.project}\n在目标准备项目环境，再 project publish，等 READY 后训练。环境未复制。`);
    else console.log(`数据已就绪：${result.machine}\n${result.dataset}@${result.version}\n训练使用 --data ${result.dataset}@${result.version}`);
    return;
  }
  if(command==='use'){console.log(`当前服务器：${result.selected}\n${result.project?'当前项目：'+result.project:'未选择项目；可用 gpuctl project create NAME 或 project use NAME'}`);return;}
  if(command==='project'&&positionals[1]==='quota'){
    if(!result.enabled)console.log(result.reason==='OWNER_NOT_ACTIVATED'?'你的工作区尚未纳入磁盘硬配额；不是零用量，也不代表无限容量。':'这台服务器尚未启用个人磁盘硬配额；不是零用量，也不代表无限容量。');
    else for(const row of result.volumes)console.log(`${row.volume} · 内核项目配额\n  已用 ${row.usedBytes} / ${row.bytes} B；剩余 ${row.remainingBytes} B\n  文件／目录 ${row.usedInodes} / ${row.inodes}；剩余 ${row.remainingInodes}`);
    return;
  }
  if(command==='project'&&['import','import-status','import-cancel'].includes(positionals[1])){
    console.log(`${result.state} · ${result.key} · ${result.machine} / ${result.project}\n${result.phase||'待确认'} · ${result.files||0} 文件 · ${result.bytes||0} B${result.error?'\n'+result.error:''}\n查看：gpuctl project import-status ${result.key}${result.state==='IMPORTED'?'\n项目文件已导入；核对内容和依赖后可直接 run，无需发布。':''}`);return;
  }
  if(command==='project'&&positionals[1]==='uploads'){
    for(const row of result.uploads||[])console.log(`${row.uploadId} · ${row.state} · ${row.receivedBytes} / ${row.totalSize} B · ${row.path}${row.cancelable?'\n  取消：gpuctl project upload-cancel '+row.uploadId:'\n  提交结果未确认，保留原操作进行检查。'}`);
    if(!result.uploads?.length)console.log('没有未完成的项目上传。');return;
  }
  if(command==='project'&&positionals[1]==='upload-cancel'){console.log(`${result.state} · ${result.uploadId}\n仅处理未提交的临时上传；不会删除项目代码或已发布版本。`);return;}
  if(command==='data'&&positionals[1]==='put'){console.log(`已上传 ${result.bytes} 字节 → ${result.machine}:${result.path}\n未自动解压或发布。进入个人数据终端：gpuctl data shell`);return;}
  if(command==='data'&&['publish','workspace-status'].includes(positionals[1])){console.log(`${result.state} · ${result.machine}${result.error?'\n'+result.error:''}${result.operationId?'\n查看：gpuctl data workspace-status '+result.operationId+' --machine '+result.machine:''}${result.state==='READY'?'\n数据集：'+result.dataset+'@'+result.version+'\n训练只读路径：/data2/'+result.dataset:''}`);return;}
  if(command==='data'&&positionals[1]==='upload'){console.log(`数据集已就绪：${result.machine}\n${result.dataset}@${result.version}\n训练只读路径：/data2/${result.dataset}\n可在 run 中使用 --data ${result.dataset}@${result.version}`);return;}
  if(command==='data'&&['upload-status','upload-discard'].includes(positionals[1])){console.log(`${result.state} · ${result.uploadId} · ${result.machine}${result.error?'\n'+result.error:''}${result.state==='READY'?'\n'+result.dataset+'@'+result.version+'\n训练只读路径：/data2/'+result.dataset:''}`);return;}
  if(command==='data'&&(positionals[1]==='unregister'||/^[a-f0-9]{64}$/.test(positionals[2]||''))){
    if(result.state==='UNREGISTERED')console.log(`${result.unregistered?'已注销所选本地数据集范围':'所选注册已不存在'}：${result.dataset}${result.version?'@'+result.version:''}${result.recoveryId?'\n恢复记录：'+result.recoveryId:''}`);
    else console.log(`${result.state==='UNREGISTERING'?'已受理注销，尚未完成':result.state} · ${result.operationId}${result.error?'\n'+result.error:''}\n查看：gpuctl data status ${result.operationId} --machine ${result.machine}`);
    return;
  }
  if(command==='run'){console.log(`已提交 ${result.id}\n${result.machine} · ${allocationLabel(result)} GPU · ${result.state}\n查看日志：gpuctl logs ${result.id}`);return;}
  if(command==='transfer'){
    if(result.transfers){console.log(result.transfers.map(transferText).join('\n')||'暂无传输。');if(result.nextCursor)console.log('下一页：gpuctl transfer list --cursor '+result.nextCursor);}
    else if(result.transferId)console.log(`传输 ${result.transferId} · ${result.state}\n${result.downloaded||result.dataset+'@'+result.version}`);
    else console.log(transferText(result));return;
  }
  if(command==='exec'){
    if(result.stdout)process.stdout.write(result.stdout);
    if(result.stderr)process.stderr.write(result.stderr);
    process.stderr.write(`\nHost command ${result.id} · ${result.machine} · ${result.state}${result.exitCode!==null&&result.exitCode!==undefined?' · exit '+result.exitCode:''}\n`);
    if(result.truncated?.stdout||result.truncated?.stderr)process.stderr.write('Output was truncated at 65536 bytes per stream.\n');
    if(!['SUCCEEDED','FAILED','CANCELED','TIMED_OUT'].includes(result.state))process.stderr.write(`Inspect: gpuctl exec status ${result.id} --machine ${result.machine}\nCancel: gpuctl exec cancel ${result.id} --machine ${result.machine}\n`);
    if(result.error)process.stderr.write(result.error+'\n');return;
  }
  if(command==='notes'){for(const n of result.notes)console.log(`${n.id} · ${n.author.username} · ${n.jobId||'非任务留言'}\n${n.body}\n`);if(!result.notes.length)console.log('暂无留言。');if(result.nextCursor)console.log('更多留言可通过 API before='+result.nextCursor+' 查询。');return;}
  if(command==='note'||command==='note-delete'){console.log(result.deleted?`留言 ${result.id} 已删除。`:`留言 ${result.note?.id||result.id} 已保存。`);return;}
  if(command==='priority'){console.log(`任务 ${result.id}：优先级 ${result.priority||'normal'}${result.priorityPending?'（等待节点确认）':''}`);return;}
  if(command==='notify'){console.log(`Telegram：${result.configured?'收件人已配置':'收件人尚未配置'} · ${result.degraded?'通知存储暂不可用':result.enabled?'通知已开启':'通知关闭'} · 待发 ${result.pending??'未知'} · 失败 ${result.failed??'未知'}`);return;}
  if(command==='logs'){process.stdout.write(result.text+(result.text.endsWith('\n')?'':'\n'));return;}
  if(command==='cancel'){console.log(`任务 ${result.id}：${result.state}${result.cancelRequested?'（已请求取消，等待节点确认）':''}`);return;}
  if(command==='upload'){console.log(`已上传 ${result.uploaded} 个文件到 ${result.machine} 的${result.project?'项目 '+result.project+' 草稿':'个人工作区'}。${result.skipped?'跳过 '+result.skipped+' 项。':''}`);return;}
  if(command==='upload-status'){console.log(result.files.map(file=>`${file.path}: ${file.state} ${file.receivedBytes??0}/${file.totalSize??'?'} B${file.uploadId?' · '+file.uploadId:''}`).join('\n')||'没有可查询的文件。');return;}
  if(command==='download'){console.log(`已下载：${result.downloaded}（${result.bytes} 字节）`);return;}
  if(command==='jobs'){console.log(result.length?[...result].slice(-50).reverse().map(j=>`${j.id}  ${j.state}${j.preempted?'（让位中断，不会自动重跑）':''}\n  ${j.machine} · ${allocationLabel(j)} · ${j.name||'train'} · 优先级 ${['idle','normal','high'].includes(j.priority)?j.priority:'旧策略／未核验'}${j.schedulerState?' · 调度 '+j.schedulerState:''}${j.queueReason?'\n  排队原因：'+j.queueReason:''}\n  ${progressText(j.progress)}${jobTimingText(j)?'\n  '+jobTimingText(j):''}`).join('\n'):'暂无任务。');if(result.length>50)console.log('仅显示最近 50 条；完整记录：gpuctl jobs --json');return;}
  if(command==='files'){console.log(result.entries.map(f=>`${f.type==='directory'?'[目录]':'[文件]'} ${f.name}${f.type==='file'?'  '+f.size+' B':''}`).join('\n')||'目录为空。');return;}
  if(command==='maintenance'){
    const v=maintenanceVisible;
    if(result.version===1&&Object.hasOwn(result,'global')){
      console.log('维护状态 · revision '+result.revision);
      const entries=[...(result.global?[['全平台',result.global]]:[]),...Object.entries(result.machines)];
      console.log(entries.length?entries.map(([scope,entry])=>v(scope)+'：'+v(entry.reason)).join('\n'):'当前可见范围未设置维护。');
      console.log('维护只封锁新操作，不自动结束已有任务；恢复必须管理员明确操作。');return;
    }
    console.log('历史运维记录（只读；维护申请已停用）');
    if(result.items){console.log(result.items.map(r=>`${v(r.id)}  ${v(r.state)}${r.state==='PENDING'?'（未执行，不能再审批）':''}  v${r.revision}\n  ${v(r.machine)} · ${v(r.owner.username)} · ${v(r.title)}`).join('\n')||'暂无历史记录。');if(result.nextCursor)console.log('下一页：gpuctl maintenance list --cursor '+v(result.nextCursor));return;}
    const r=result;console.log(`${v(r.id)} · ${v(r.state)}${r.state==='PENDING'?'（未执行，不能再审批）':''} · v${r.revision}\n${v(r.machine)} · ${v(r.owner.username)} · ${v(r.title)}\n原因：${v(r.reason)}\n目录：${v(r.cwd)} · 超时 ${r.timeoutSec}s\n脚本 SHA256：${v(r.scriptSha256)}\n历史脚本（仅供查阅；不可见字符以 Unicode 转义显示）：\n${v(r.script,true)}`);
    if(r.decision?.reason)console.log('退回理由：'+v(r.decision.reason));if(r.error)console.log(v(r.error));
    if(r.result){console.log(`上次节点回执：${v(r.result.state)} · exit=${r.result.exitCode??'未确认'} · ${v(r.result.checkedAt)}`);process.stdout.write(v(r.result.stdout,true));process.stderr.write(v(r.result.stderr,true));if(r.result.truncated?.stdout||r.result.truncated?.stderr)console.log('\n输出已截断（每路最多 64 KiB）。');}
    return;
  }
  if(command==='users'){console.log(result.map(u=>`${u.username}  ${u.role==='admin'?'管理员':'普通用户'}  ${u.enabled?'启用':'暂停'}  总额度 ${u.total} 张\n  ${Object.entries(u.limits).map(([m,n])=>`${m}: ${n}`).join('，')||'尚未授权机器'}`).join('\n'));return;}
  console.log(JSON.stringify(result,null,2));
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===realpathSync(process.argv[1])){
  main().catch(error=>{console.error(wantsJSON?maintenanceJSON({ok:false,error:error.message,...(error.terminal?{terminal:error.terminal,...terminalErrorMetadata(error)}:{})}):`Error: ${maintenanceVisible(error.message)}`);process.exitCode=1;});
}
