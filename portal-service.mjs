import {selectFields} from './portal-request-validation.mjs';
import {DatabaseSync} from 'node:sqlite';
import {mkdir,readFile,writeFile,chmod} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomBytes} from 'node:crypto';
import {DemoService,credential} from './dist/service.js';
import {readGPUQStatus,visibleGPUQStatus,canViewMachineStatus} from './gpuq-status.mjs';
import {installExecution,executionCall,publicJob,usage,priorityCapable,priorityRankCapable,TERMINAL,pendingJobReason} from './execution.mjs';
import {MACHINES,validUsername} from './dist/model.js';
import {installCommunity,communityCall,maintainTaskNotes,announcementState,chatMentions,chatImageFile} from './community.mjs';
import {installWorkshop,workshopCall} from './workshop.mjs';
import {installMaintenanceState,installMaintenance,maintenanceCall} from './maintenance.mjs';
import {installFileCampus,fileTicket} from './campus-files.mjs';
import {installJobNotifications} from './job-notifications.mjs';
import {installTransfers,transferCall} from './transfers.mjs';
import {installCloudImports,cloudImportCall} from './cloud-import.mjs';
import {installTeamAccounts,accountOperation} from './accounts/portal.mjs';
import {installProjectCatalog} from './project-catalog.mjs';
import {installTaskDisplay,taskDisplayCall} from './task-display.mjs';

// Aggregate history is a presentation view; point queries use durable jobs.
const STATE_JOBS_BYTES=300000;
function stateCommand(argv){
  let remaining=200;
  const command=[];
  for(const argument of argv){
    if(command.length)remaining--;
    if(remaining<=0)break;
    let preview=argument.slice(0,remaining);
    if(/[\uD800-\uDBFF]$/.test(preview))preview=preview.slice(0,-1);
    command.push(preview);remaining-=preview.length;
  }
  const commandLength=argv.reduce((length,argument)=>length+argument.length,Math.max(0,argv.length-1));
  return {command,commandLength,commandTruncated:commandLength>200};
}
function compactTerminalStateJob(job,users){
  const view=publicJob(job,users);
  // The browser scopes its history by the original platform user ID and uses
  // project plus the selected AUTO destination for outputs and allocation.
  // Keep these public references, never reconstruct ownership from labels.
  return {id:view.id,userId:view.userId,name:view.name,machine:view.machine,cards:view.cards,state:view.state,
    ...(view.after?.length?{after:view.after}:{}),
    ...(view.project!==undefined?{project:view.project}:{}),
    ...(view.machineSelection!==undefined?{machineSelection:view.machineSelection}:{}),
    ...(view.selectionSummary!==undefined?{selectionSummary:view.selectionSummary}:{}),
    schedulerState:view.schedulerState??null,priority:view.priority??null,gpuMetrics:view.gpuMetrics??null,
    submitter:{name:view.submitter?.name??null,username:view.submitter?.username??null},
    createdAt:view.createdAt??null,startedAt:view.startedAt??view.workerStartedAt??null,
    finishedAt:view.finishedAt??view.terminalObservedAt??null,
    exitCode:view.exitCode??view.latestAttempt?.exitCode??null,
    reason:view.reason??view.latestAttempt?.failureReason??view.error??null};
}

// One process owns this database. Serial transactions keep account changes atomic.
// Reservations are durable before the separate restricted executor dispatches GPUQ.
export class PortalService extends DemoService{
  static async open(path,bootstrapPath,statusPath,bridge,notificationConfig,accountsPath=process.env.TEAM_ACCOUNTS_DATABASE||path+'.accounts.sqlite'){
    await mkdir(dirname(path),{recursive:true,mode:0o700});
    const service=new PortalService();service.production=true;service.tail=Promise.resolve();service.pending=0;service.storageSnapshots={};
    service.terminalLanes=new Map();service.terminalPending=0;
    service.db=new DatabaseSync(path);await chmod(path,0o600);
    service.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS portal_state_v2 (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, time TEXT NOT NULL, actor TEXT NOT NULL, operation TEXT NOT NULL, subject TEXT, outcome TEXT NOT NULL);');
    service.db.exec("CREATE TABLE IF NOT EXISTS invites_v2 (role TEXT PRIMARY KEY CHECK(role IN ('admin','member')), digest TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0, max_uses INTEGER, created_at TEXT NOT NULL,code_cipher TEXT);");
    installMaintenanceState(service);installCommunity(service);installWorkshop(service);installProjectCatalog(service);installTaskDisplay(service);
    const keyPath=path+'.invite-key';
    try{service.inviteKey=await readFile(keyPath);}catch(e){
      if(e.code!=='ENOENT')throw e;
      if(service.db.prepare('SELECT 1 FROM invites_v2 WHERE code_cipher IS NOT NULL LIMIT 1').get())throw Error('Invitation encryption key missing; restore it from the private backup.');
      for(const table of ['cloud_credentials','cloud_downloads'])if(service.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)&&service.db.prepare('SELECT 1 FROM '+table+' LIMIT 1').get())throw Error('Cloud encryption key missing; restore the original private key backup.');
      await writeFile(keyPath,randomBytes(32),{mode:0o600,flag:'wx'});service.inviteKey=await readFile(keyPath);
    }
    if(service.inviteKey.length!==32)throw Error('Invalid invitation encryption key');await chmod(keyPath,0o600);
    installCloudImports(service);
    const saved=service.db.prepare('SELECT data FROM portal_state_v2 WHERE id=1').get();
    if(saved)service.restore(JSON.parse(saved.data));
    else{
      const initial=bootstrapPath?JSON.parse(await readFile(bootstrapPath,'utf8')):null;
      if(!initial){service.store.users=[];service.store.jobs=[];service.store.sequence=0;}
      else {
      if(initial.username!=='admin'||typeof initial.password!=='string'||initial.password.length<20)throw Error('Bootstrap requires admin and a generated password of at least 20 characters.');
      service.store.users=[{id:'builtin-admin',name:'管理员',username:'admin',role:'admin',enabled:true,limits:{},total:0}];service.store.jobs=[];service.store.sequence=0;
      service.legacyCredentials=new Map([['admin',await credential(initial.password,600000)]]);
      }
    }
    installTeamAccounts(service,accountsPath);
    service.statusPath=statusPath;await service.refreshGPUQ();installExecution(service,bridge);installMaintenance(service);installJobNotifications(service,notificationConfig);
    maintainTaskNotes(service);
    installTransfers(service);installFileCampus(service);
    const now=Date.now();service.storageQueue=new Map();
    service.storageDue=new Map(MACHINES.map((machine,index)=>[machine.id,{
      usage:service.storageSnapshots[machine.id]?.scannedAt?Date.parse(service.storageSnapshots[machine.id].scannedAt)+1800000:now+index*1800000/MACHINES.length,
      quota:service.storageSnapshots[machine.id]?.quota?.checkedAt?Date.parse(service.storageSnapshots[machine.id].quota.checkedAt)+300000:now+index*300000/MACHINES.length
    }]));
    return service;
  }
  export(){return {schema:2,users:this.store.users.map(({id,limits,total,policyVersion,approvedBy,approvedAt})=>({id,limits,total,policyVersion,approvedBy,approvedAt})),jobs:this.store.jobs,sequence:this.store.sequence,storage:this.storageSnapshots};}
  restore(data){
    this.store.users=data.users;this.store.jobs=data.jobs;this.store.sequence=data.sequence;
    this.storageSnapshots=data.storage||{};
    if(data.credentials)this.legacyCredentials=new Map(data.credentials.map(([name,r])=>[name,{salt:new Uint8Array(Buffer.from(r.salt,'base64')),hash:new Uint8Array(Buffer.from(r.hash,'base64')),iterations:r.iterations}]));
    this.refreshAccounts?.();
  }
  save(){this.db.prepare('INSERT INTO portal_state_v2(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(this.export()));}
  storageSnapshot(machine){
    return structuredClone({machines:MACHINES.filter(row=>machine===undefined||row.id===machine).map(({id})=>{
      const row=this.storageSnapshots[id]||{},name=owner=>this.store.users.find(user=>user.id===owner)?.name??null;
      return {machine:id,checkedAt:row.checkedAt??null,refreshing:this.storageQueue.has(id)||this.storageCurrent?.machine===id,
        quota:{volumes:[],checkedAt:null,...row.quota},
        datasets:{datasets:[],complete:false,checkedAt:null,...row.datasets,datasets:(row.datasets?.datasets||[]).map(value=>{
          const owner=value.ownerId??(typeof value.uploadedBy==='string'?value.uploadedBy:value.uploadedBy?.userId);
          return {...value,ownerId:owner,ownerName:name(owner)??value.ownerName};
        })},
        projects:{projects:[],complete:false,checkedAt:null,...row.projects,projects:(row.projects?.projects||[]).map(value=>({
          ...this.projectPresentation(value.ownerId,id,value),ownerId:value.ownerId,ownerName:name(value.ownerId)
        }))}};
    })});
  }
  scheduleStorageRefresh(machine,delay=30000){
    if(!this.storageDue.has(machine))return;
    const now=Date.now(),queued=this.storageQueue.get(machine);
    this.storageQueue.set(machine,{at:queued?.at<=now?queued.at:now+delay,usage:true});
  }
  requestStorageRefresh(machine){
    if(!(this.storageCurrent?.machine===machine&&this.storageCurrent?.usage)&&!(Date.now()-Date.parse(this.storageSnapshots[machine]?.scannedAt)<300000)){
      this.scheduleStorageRefresh(machine,0);void this.refreshStorage().catch(()=>{});
    }
    return this.storageSnapshot(machine);
  }
  refreshStorage(periodic=false){
    const now=Date.now();
    if(periodic)for(const [machine,due] of this.storageDue){
      if(this.storageCurrent?.machine!==machine&&!this.storageQueue.has(machine)&&(due.usage<=now||due.quota<=now))this.storageQueue.set(machine,{at:now,usage:due.usage<=now});
    }
    if(this.storageWork)return this.storageWork;
    this.storageWork=(async()=>{
      while(!this.closing&&this.bridge){
        const next=[...this.storageQueue].find(([,row])=>row.at<=Date.now());if(!next)break;
        const [machine,request]=next;this.storageQueue.delete(machine);this.storageCurrent={machine,usage:request.usage};
        const row=this.storageSnapshots[machine]??={},due=this.storageDue.get(machine);
        const read=async(part,operation,args={})=>{
          if(this.closing)return false;
          try{const value=await this.bridge(machine,operation,args);row[part]={...value,checkedAt:new Date(Date.now()).toISOString()};return true;}
          catch{row[part]={...row[part],error:'暂时读不到，请稍后刷新。'};return false;}
        };
        await read('quota','projects.quota');due.quota=Date.now()+300000;
        if(request.usage&&!this.closing){
          const datasets=await read('datasets','datasets.list'),projects=await read('projects','projects.list',{includeUsage:true});
          row.scannedAt=new Date(Date.now()).toISOString();due.usage=Date.now()+1800000;
          if(datasets&&projects)row.checkedAt=row.scannedAt;
        }
        if(!this.closing)this.save();this.storageCurrent=null;
      }
    })().finally(()=>{this.storageCurrent=null;this.storageWork=null;});
    return this.storageWork;
  }
  issueSession(principal){return this.loginSessions.issue(principal);}
  principal(token){const principal=this.loginSessions.principal(token);this.refreshAccounts();return principal;}
  revokeSession(token){this.loginSessions.revoke(token);}
  invalidate(username){this.loginSessions.invalidate(username);}
  invitations(){return this.accounts.invitations();}
  audit(actor,operation,subject,outcome){this.db.prepare('INSERT INTO audit(time,actor,operation,subject,outcome) VALUES(?,?,?,?,?)').run(new Date().toISOString(),String(actor).slice(0,64),String(operation).slice(0,64),subject?String(subject).slice(0,64):null,outcome);}
  enqueue(fn){
    if(this.pending>=24){const e=Error('服务忙，请稍后重试。');e.status=429;return Promise.reject(e);}
    this.pending++;const run=this.tail.then(fn);this.tail=run.catch(()=>{}).finally(()=>this.pending--);return run;
  }
  async observeRead(token,operation,args,run,{signal,timeoutMs=35000,coalesce=true,group='remote',timeoutCode='NODE_READ_TIMEOUT',cancelCode='NODE_READ_CANCELLED'}={}){
    signal?.throwIfAborted();
    this.principal(token);
    const key=coalesce?JSON.stringify([token,operation,args]):Symbol();
    this.readObservations??=new Map();this.readQueues??=new Map();
    let entry=this.readObservations.get(key);
    if(!entry||entry.controller.signal.aborted){
      entry={controller:new AbortController(),users:0,settled:false};
      const queue=this.readQueues.get(group)||{next:0,lanes:Array.from({length:4},()=>Promise.resolve())};this.readQueues.set(group,queue);
      const deadline=Date.now()+timeoutMs,lane=queue.next++%4;
      const work=queue.lanes[lane].then(()=>{entry.controller.signal.throwIfAborted();return run({signal:entry.controller.signal,deadline});});
      entry.work=work;queue.lanes[lane]=work.catch(()=>{});this.readObservations.set(key,entry);
      const timer=setTimeout(()=>entry.controller.abort(Object.assign(Error('暂时无法读取。'),{status:504,code:timeoutCode})),timeoutMs);
      const release=()=>{entry.settled=true;clearTimeout(timer);if(this.readObservations.get(key)===entry)this.readObservations.delete(key);};
      work.then(release,release);
    }
    entry.users++;
    const active=signal?AbortSignal.any([signal,entry.controller.signal]):entry.controller.signal;
    let abort;
    try{return await Promise.race([entry.work,new Promise((_,reject)=>{
      abort=()=>reject(entry.controller.signal.aborted?entry.controller.signal.reason:Object.assign(Error('读取已取消。'),{status:499,code:cancelCode}));active.addEventListener('abort',abort,{once:true});if(active.aborted)abort();
    })]);}
    finally{active.removeEventListener('abort',abort);if(!--entry.users&&!entry.settled)entry.controller.abort(Object.assign(Error('读取已取消。'),{status:499}));}
  }
  async readState(token,args){
    // State uses the collector's local snapshot, never a live per-node RPC.
    // Do not wait behind an unrelated node operation on the mutation tail.
    if(!args||typeof args!=='object'||Array.isArray(args))throw Error('参数格式错误。');
    args=selectFields(args,['view','jobId','jobKey']);
    if(args.view!==undefined&&args.view!=='summary')
      throw Object.assign(Error('无效的状态查询视图。'),{status:400});
    if(this.closing)throw Object.assign(Error('服务正在关闭。'),{status:503});
    this.principal(token);
    const check=()=>{
      if(this.closing)throw Object.assign(Error('服务正在关闭。'),{status:503});
      const current=this.principal(token);

      return current;
    };
    if(args.view!=='summary'&&args.jobId===undefined&&args.jobKey===undefined){
      const refresh=this.refreshGPUQ().catch(()=>{});
      if(!(Date.now()-Date.parse(this.gpuq?.checkedAt)<15000)){
        let timer;
        try{await Promise.race([refresh,new Promise(resolve=>{timer=setTimeout(resolve,500);})]);}
        finally{clearTimeout(timer);}
      }
    }
    const current=check();
    const state=args.view==='summary'||args.jobId!==undefined||args.jobKey!==undefined?this.stateSummary(current):this.state(current);
    if(args.jobId!==undefined){
      const job=this.store.jobs.find(row=>row.id===args.jobId);
      if(!job)throw Object.assign(Error('任务不存在。'),{status:404});
      this.assertMachineStatusVisible(current,job.machine);
      state.jobs=[{id:job.id,machine:job.machine,project:job.project??job.spec?.project,ownerId:job.ownerId??job.userId,userId:job.userId}];
    }else if(args.jobKey!==undefined){
      state.jobs=this.store.jobs.filter(job=>job.key===args.jobKey&&(!job.machine||canViewMachineStatus(current,this.store.get(current.userId).limits,job.machine))).map(job=>({
        ...publicJob(this.taskDisplayJob(job),this.store.users),...stateCommand(job.spec.argv)
      }));
    }
    return {state,principal:{username:current.username,role:current.role,userId:current.userId}};
  }
  async remoteRead(token,operation,args,options={}){
    if(!args||typeof args!=='object'||Array.isArray(args))throw Error('参数格式错误。');
    const request=structuredClone(args);
    const principal={...this.principal(token)};
    const check=()=>{
      if(this.closing)throw Object.assign(Error('服务正在关闭，请稍后查询。'),{status:503});
      const current=this.principal(token);
      if(operation==='terminal.status')this.assertMachineStatusVisible(current,request.machine);
      if(request.area==='output'||request.runId){
        this.assertMachineStatusVisible(current,request.machine);
        const job=this.store.jobs.find(job=>job.id===request.runId);
        if(job)this.assertMachineStatusVisible(current,job.machine);
      }
      this.assertMaintenanceAllowed?.(operation,request,current);
    };
    try{
      const result=await this.observeRead(token,operation,request,async context=>{
        for(let attempt=0;;attempt++){
          check();try{return await executionCall(this,principal,operation,request,context);}
          catch(error){check();context.signal.throwIfAborted();
            if(attempt||![429,502,503,504].includes(error.status)||context.deadline-Date.now()<=250)throw error;
            await new Promise(resolve=>setTimeout(resolve,250));
          }
        }
      },options);
      check();
      return {result,principal:{...principal}};
    }catch(error){check();throw error;}
  }
  async jobRead(token,operation,args,options={}){
    if(!['jobs.logs','jobs.watch','jobs.completion','jobs.diagnostics'].includes(operation))throw Error('Invalid job read operation');
    if(!args||typeof args!=='object'||Array.isArray(args))
      throw Object.assign(Error('任务查询仅接受任务 ID。'),{status:400});
    const request=selectFields(args,['jobId',...(operation==='jobs.logs'?['download','attemptId','offset']:[])]),admitted=this.principal(token);
    const check=()=>{
      if(this.closing)throw Object.assign(Error('服务正在关闭。'),{status:503});
      const current=this.principal(token);
      const job=this.store.jobs.find(job=>job.id===request.jobId);
      if(job)this.assertMachineStatusVisible(current,job.machine);
      this.assertMaintenanceAllowed?.(operation,request,current);
      return current;
    };
    check();
    try{
      const result=await this.observeRead(token,operation,request,context=>{check();return executionCall(this,admitted,operation,request,{...context,check});},{...options,group:'job',timeoutMs:40000});
      return {result,principal:{...check()}};
    }catch(error){check();throw error;}
  }
  terminalPrincipal(token,args){
    if(this.closing)throw Object.assign(Error('服务正在关闭。'),{status:503});
    const {username,role,userId}=this.principal(token);
    if(!MACHINES.some(machine=>machine.id===args.machine))
      throw Object.assign(Error('请选择列表中的服务器。'),{status:400});
    this.assertMachineStatusVisible({username,role,userId},args.machine);
    return {username,role,userId};
  }
  async terminalExchange(token,args){
    if(!args||typeof args!=='object'||Array.isArray(args))throw Error('参数格式错误。');
    // Only streaming exchanges bypass the durable mutation queue. The node
    // authenticates the current PTY writer with its session token.
    args={...args};this.terminalPrincipal(token,args);
    const key=JSON.stringify([args.machine,args.id]);
    const lane=this.terminalLanes.get(key)||{tail:Promise.resolve(),pending:0};
    if(args.input&&(this.terminalPending>=24||lane.pending>=4))
      throw Object.assign(Error('终端输入正在处理，请等待当前输入完成。'),{status:429});
    this.terminalLanes.set(key,lane);this.terminalPending++;lane.pending++;
    const run=lane.tail.then(async()=>{
      const principal=this.terminalPrincipal(token,args);

      // executionCall retains the complete trusted field/context validation and
      // dispatches exactly once. Never retry input after an ambiguous failure.
      let result,current;
      try{result=await executionCall(this,principal,'terminal.exchange',args);}finally{
        // Recheck failed responses too: node errors can contain private context.
        current=this.terminalPrincipal(token,args);

      }
      // Do not send the entire GPU/account snapshot on every keystroke, or leak
      // a delayed terminal response after logout, suspension or grant revocation.
      return {result,principal:current};
    });
    lane.tail=run.catch(()=>{});
    try{return await run;}finally{
      this.terminalPending--;lane.pending--;
      if(!lane.pending)this.terminalLanes.delete(key);
    }
  }
  async cloudExchange(token,operation,args){
    if(!args||typeof args!=='object'||Array.isArray(args))throw Error('参数格式错误。');
    args=structuredClone(args);
    const admitted=this.principal(token);
    const check=()=>{
      if(this.closing)throw Object.assign(Error('服务正在关闭。'),{status:503});
      const current=this.principal(token);
      if(args.machine&&!MACHINES.some(m=>m.id===args.machine))
        throw Object.assign(Error('请选择列表中的服务器。'),{status:400});
      return current;
    };
    check();
    const coalesce=operation==='cloud.info'||operation==='cloud.inspect'||operation.endsWith('.list')||operation.endsWith('.status')||!!args.key;
    let result;try{result=await this.observeRead(token,operation,args,()=>{check();return cloudImportCall(this,admitted,operation,args,check);},{group:'cloud',coalesce});}finally{check();}
    return {result,principal:check()};
  }
  async login(username,password){
    if(this.closing)throw Object.assign(Error('服务正在关闭。'),{status:503});
    this.loginPending??=0;
    if(this.loginPending>=2)throw Object.assign(Error('登录验证繁忙，请稍后重试。'),{status:429});
    this.loginPending++;
    try{
      const {user,token}=await this.accounts.authenticate(username,password,true);
      if(this.closing){this.revokeSession(token);throw Object.assign(Error('服务正在关闭。'),{status:503});}
      const principal={userId:user.id,username:user.username,role:user.role};
      this.refreshAccounts();
      this.audit(user.username,'login',null,'ok');
      return {token,principal,state:this.state(principal)};
    }finally{this.loginPending--;}
  }
  register(args){return this.enqueue(async()=>{
    if(!args||typeof args!=='object'||Array.isArray(args))throw Error('注册参数无效。');
    if(typeof args.invite!=='string')throw Object.assign(Error('请输入团队邀请码。'),{status:403});
    const user=await this.accounts.create({...args,role:'member'},args.invite);
    this.refreshAccounts();this.save();this.audit(user.username,'register','member','ok');
    return {registered:true,username:user.username,role:'member'};
  });}
  async invoke(token,operation,args={},options={}){
    if(!args||typeof args!=='object'||Array.isArray(args))return Promise.reject(Object.assign(Error('参数格式错误。'),{status:400}));
    if(operation==='state')return this.readState(token,args);
    if(operation==='storage.snapshot'||operation==='storage.refresh'){
      const principal=this.principal(token);
      if(args.machine)this.assertMachineStatusVisible(principal,args.machine);
      const result=operation==='storage.snapshot'?this.storageSnapshot(args.machine):this.requestStorageRefresh(args.machine);
      result.machines=result.machines.filter(row=>canViewMachineStatus(principal,this.store.get(principal.userId).limits,row.machine));
      return {result,principal};
    }
    if(['jobs.logs','jobs.watch','jobs.completion','jobs.diagnostics'].includes(operation))return this.jobRead(token,operation,args,options);
    if(operation==='terminal.exchange')return this.terminalExchange(token,args);
    if(operation==='files.direct-ticket')return fileTicket(this,token,args);
    if(['tasks.display.get','tasks.display.set'].includes(operation))return taskDisplayCall(this,token,operation,args).then(result=>({result,principal:this.principal(token)}));
    if(operation.startsWith('transfers.')){
      const principal=this.principal(token),check=()=>this.principal(token);
      return transferCall(this,principal,operation,args,check).then(result=>({result,principal:check()}));
    }
    if(operation.startsWith('cloud.'))return this.cloudExchange(token,operation,args);
    const reads=new Set(['files.get','files.list','data.upload.status','datasets.list',
      'projects.list','projects.quota','projects.status','projects.retire.list','projects.retire.status','projects.catalog','projects.label.get','projects.group.get','terminal.status']);
    if(reads.has(operation))return this.remoteRead(token,operation,args,options);
    if(operation.startsWith('community.')){
      const run=()=>{const principal=this.principal(token);return {result:communityCall(this,principal,operation,args),principal};};
      return new Set(['community.info','community.posts.list','community.posts.get','community.comments.list','community.chat.list','community.chat.mentions','community.rooms.list','community.notes.list','community.announcements.pending']).has(operation)?run():this.enqueue(run);
    }
    if(operation.startsWith('workshop.')){
      const run=()=>{const principal=this.principal(token);return {result:workshopCall(this,principal,operation,args),principal};};
      return ['workshop.list','workshop.get','workshop.mine'].includes(operation)?run():this.enqueue(run);
    }
    if(operation.startsWith('maintenance.')){
      const principal=this.principal(token);return Promise.resolve(maintenanceCall(this,principal,operation,args)).then(result=>({result,principal:this.principal(token)}));
    }
    if(operation==='notifications.job'){
      const principal=this.principal(token);return Promise.resolve({result:this.configureJobNotification(principal,args),principal});
    }
    if(operation.startsWith('jobs.')||operation.startsWith('projects.')||operation.startsWith('files.')||operation.startsWith('terminal.')||operation.startsWith('data.upload.')||operation==='datasets.delete'||operation==='outputs.delete'){
      const run=async()=>{
        const check=()=>{
          const principal=this.principal(token);
          if(operation==='terminal.open')this.assertMachineStatusVisible(principal,args.machine);
          const job=args.jobId?this.store.jobs.find(job=>job.id===args.jobId):operation==='jobs.submit'&&args.key?this.store.jobs.find(job=>job.key===args.key):null;
          if(job)this.assertMachineStatusVisible(principal,job.machine);
          return principal;
        };
        const principal=check(),result=await executionCall(this,principal,operation,args);check();
        if(operation==='projects.create'||operation==='data.upload.finish'&&args.dataset&&result.state==='COMPLETE'||
          ['datasets.delete','projects.retire'].includes(operation)&&result.state==='TRASHED'||operation==='projects.retire.restore'&&result.state==='RESTORED')this.scheduleStorageRefresh(args.machine);
        return {result,...(operation==='jobs.submit'&&options.omitResponseState!==true?{state:this.state(principal)}:{}),principal};};
      return operation==='jobs.submit'?this.enqueue(run):run();
    }
    const accountFields={logout:[], 'profile.update':['name'],'users.create':['username','name','password','role'],
      'users.enabled':['userId','enabled'],'users.role':['userId','role'],'users.reset':['userId','password'],'users.delete':['userId'],
      'policy.full':['userId'],'policy.save':['userId','total','limits'],'invites.list':[],'invites.rotate':['role'],'invites.disable':['role']};
    if(!Object.hasOwn(accountFields,operation))return Promise.reject(Object.assign(Error('未知操作。'),{status:400}));
    args=selectFields(args,accountFields[operation]);
    if(operation!=='policy.full'&&operation!=='policy.save')return this.enqueue(()=>accountOperation(this,token,operation,args));
    return this.enqueue(async()=>{
    const principal=this.principal(token),actor=principal.username;
    const before=structuredClone(this.export()),sessions=new Map(this.sessions);
    try{
      if(operation==='policy.full'){
        if(principal.role!=='admin')throw Object.assign(Error('此操作需要管理员权限。'),{status:403});
        args={userId:args.userId,limits:Object.fromEntries(MACHINES.map(m=>[m.id,m.cards])),total:MACHINES.reduce((n,m)=>n+m.cards,0)};operation='policy.save';
      }
      if(operation==='policy.save'){
        if(principal.role!=='admin')throw Object.assign(Error('此操作需要管理员权限。'),{status:403});
        const user=this.store.users.find(u=>u.id===args.userId);if(!user)throw Error('用户不存在。');
        // Do not silently kill running experiments when lowering a policy.
        if(user.role!=='admin'&&(args.total<usage(this.store.jobs,user.id)||Object.entries(user.limits).some(([m])=>(args.limits?.[m]||0)<usage(this.store.jobs,user.id,m))))throw Object.assign(Error('新额度低于当前预留用卡数。请先取消相应任务并等待释放。'),{status:409});
      }
      const result=await super.invoke(token,operation,args);
      if(operation==='policy.save'){const u=this.store.users.find(u=>u.id===args.userId);u.policyVersion++;u.approvedBy=actor;u.approvedAt=new Date().toISOString();result.result=this.store.get(u.id);result.state=this.state(principal);}
      this.db.exec('BEGIN IMMEDIATE');
      try{if(operation!=='logout')this.save();this.audit(actor,operation,args?.userId||args?.jobId,'ok');this.db.exec('COMMIT');}
      catch(e){this.db.exec('ROLLBACK');throw e;}
      return {...result,principal:operation==='logout'?null:{username:principal.username,role:principal.role,userId:principal.userId}};
    }catch(e){this.restore(before);this.sessions=sessions;this.audit(actor,operation,args?.userId||args?.jobId,'denied');throw e;}
  });}
  async refreshGPUQ(){
    // Keep one actual file read in flight, even after the response deadline.
    // A stalled filesystem cannot accumulate unbounded background reads.
    if(!this.gpuqReadWork){
      const work=readGPUQStatus(this.statusPath,Date.now(),this.gpuq);this.gpuqReadWork=work;
      const release=()=>{if(this.gpuqReadWork===work)this.gpuqReadWork=null;};
      work.then(release,release);
    }
    let timer;
    try{
      this.gpuq=await Promise.race([this.gpuqReadWork,new Promise(resolve=>{
        timer=setTimeout(()=>resolve({checkedAt:this.gpuq?.checkedAt||null,stale:true,
          hosts:(this.gpuq?.hosts||[]).map(host=>({...host,samplingStale:true}))}),2000);
      })]);
    }finally{clearTimeout(timer);}
  }
  assertMachineStatusVisible(principal,machine){
    if(machine&&!canViewMachineStatus(principal,this.store.get(principal.userId).limits,machine))
      throw Object.assign(Error('没有这台服务器的查看权限，请联系管理员授权。'),{status:403});
  }
  stateSummary(principal){
    // Construct only preflight metadata. Calling state() then deleting jobs
    // would still clone and decorate the complete job/process history.
    const users=this.store.users.map(user=>this.store.get(user.id));
    const machines=MACHINES;
    const checked=Date.parse(this.gpuq?.checkedAt),age=Date.now()-checked;
    const fresh=this.gpuq?.stale===false&&Number.isFinite(age)&&age>=-30000&&age<=180000;
    return {summaryVersion:1,machines:structuredClone(machines),users,demo:false,mode:'persistent',
      gpuqConnected:fresh&&this.gpuq.hosts.some(host=>canViewMachineStatus(principal,this.store.get(principal.userId).limits,host.id)&&host.gpuq.connected),jobsSimulated:false,
      executionEnabled:this.executionEnabled===true,taskMetadata:{version:1},
      operationalMaintenance:this.operationalMaintenance?.(principal),
};
  }
  state(principal){
    const state={machines:MACHINES,users:this.store.users.map(user=>this.store.get(user.id))};
    const cached=this.gpuq||{checkedAt:null,stale:true,hosts:[]},age=Date.now()-Date.parse(cached.checkedAt);
    const stale=cached.stale!==false||!Number.isFinite(age)||age>180000||age< -30000;
    const snapshot=this.taskDisplaySnapshot({...cached,stale,hosts:stale?cached.hosts.map(host=>({...host,samplingStale:true})):cached.hosts});
    const limits=this.store.get(principal.userId).limits;
    const visible=this.store.jobs.filter(job=>!job.machine||canViewMachineStatus(principal,limits,job.machine)).map(j=>this.taskDisplayJob(j)),jobsTotal=visible.length;
    const gpuq=visibleGPUQStatus(snapshot,principal,this.store.get(principal.userId).limits,{jobs:this.store.jobs.map(j=>this.taskDisplayJob(j)),users:this.store.users});
    const capabilities=Object.fromEntries(gpuq.hosts.map(h=>[h.id,h.displayMasked!==true&&!gpuq.stale&&priorityCapable(h)===true]));
    const full=job=>({...publicJob(job,this.store.users),...stateCommand(job.spec.argv),queueReason:pendingJobReason(this,job),notifications:this.jobNotificationState(job,principal.userId),
      canSetPriority:job.state==='PENDING'&&!job.cancelRequested});
    const selected=new Map(visible.filter(job=>!TERMINAL.has(job.state)).map(job=>[job,full(job)]));
    // Full active records take precedence even when they alone exceed budget.
    let jobsBytes=2;
    for(const view of selected.values())jobsBytes+=Buffer.byteLength(JSON.stringify(view))+(jobsBytes>2?1:0);
    const terminal=visible.map((job,index)=>({job,index,time:Date.parse(job.finishedAt??job.terminalObservedAt)}))
      .filter(row=>TERMINAL.has(row.job.state)).sort((a,b)=>(Number.isFinite(b.time)?b.time:0)-(Number.isFinite(a.time)?a.time:0)||b.index-a.index);
    for(const {job} of terminal){
      const view=compactTerminalStateJob(job,this.store.users),bytes=Buffer.byteLength(JSON.stringify(view))+(selected.size?1:0);
      if(jobsBytes+bytes>STATE_JOBS_BYTES)break;
      selected.set(job,view);jobsBytes+=bytes;
    }
    // Preserve the legacy append order used by CLI jobs' final-50 display.
    const jobs=visible.filter(job=>selected.has(job)).map(job=>selected.get(job));
    // Clone only the bounded public projection, not every durable job/spec.
    return structuredClone({...state,jobs,jobsTotal,jobsReturned:jobs.length,jobsTruncated:jobs.length<jobsTotal,jobsCompacted:true,
      taskMetadata:{version:1},operationalMaintenance:this.operationalMaintenance?.(principal),
      demo:false,mode:'persistent',gpuqConnected:gpuq.hosts.some(h=>h.displayMasked!==true&&h.gpuq.connected),jobsSimulated:false,executionEnabled:this.executionEnabled===true,
      execution:{priorityCapabilities:capabilities},gpuq,transfers:{version:1},frontendWorkshop:{version:1},announcements:announcementState(this,principal),chatMentions:chatMentions(this,principal),
      ...(principal.role==='admin'?{invitations:this.invitations()}:{})});
  }
  communityImage(token,id){return chatImageFile(this,this.principal(token),id);}
  close(){this.closing=true;for(const admission of this.loginAdmissions?.values()||[])if(admission.issued)this.revokeSession(admission.issued);this.cloudProvider?.clear();clearInterval(this.executionTimer);clearInterval(this.notificationTimer);clearInterval(this.maintenanceTimer);clearInterval(this.transferTimer);this.accounts.close();this.db.close();}
}
