import {DatabaseSync} from 'node:sqlite';
import {mkdir,readFile,writeFile,chmod} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createHash,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {DemoService,credential} from './dist/service.js';
import {readGPUQStatus,visibleGPUQStatus} from './gpuq-status.mjs';
import {installExecution,executionCall,displayReadService,publicJob,usage,priorityCapable,priorityRankCapable} from './execution.mjs';
import {authorizationPolicy,MACHINES,validUsername} from './dist/model.js';
import {installCommunity,communityCall,maintainTaskNotes} from './community.mjs';
import {installMaintenanceState,installMaintenance,maintenanceCall} from './maintenance.mjs';
import {installJobNotifications} from './job-notifications.mjs';
import {installTransfers,transferCall} from './transfers.mjs';
import {installCloudImports,cloudImportCall} from './cloud-import.mjs';
import {LoginSessions} from './login-sessions.mjs';
import {installStorageArchive} from './storage-archive.mjs';
import {installOciCohort} from './oci-cohort.mjs';
import {installProjectReplication,projectReplicationCall} from './project-replication.mjs';
import {installDatasetLabels,datasetLabelCall} from './dataset-labels.mjs';
import {installProjectCatalog} from './project-catalog.mjs';
import {installDatasetDeletion} from './dataset-deletion.mjs';
import {installTaskDisplay,taskDisplayCall} from './task-display.mjs';
import {installDatasetIngress,datasetUploadAdmissionView} from './dataset-ingress.mjs';
import {installDatasetCacheActions} from './dataset-cache-actions.mjs';
import {storageUsageCall} from './storage-usage.mjs';

// One process owns this database. Serial transactions keep account changes atomic.
// Reservations are durable before the separate restricted executor dispatches GPUQ.
export class PortalService extends DemoService{
  static async open(path,bootstrapPath,statusPath,bridge,notificationConfig,storageArchiveConfig,ociCohortMachines=[],datasetIngressConfig){
    await mkdir(dirname(path),{recursive:true,mode:0o700});
    const service=new PortalService();service.production=true;service.tail=Promise.resolve();service.pending=0;
    service.terminalLanes=new Map();service.terminalPending=0;
    service.cloudPending=0;service.cloudUsers=new Map();service.cloudKeys=new Set();
    service.datasetReadPending=0;
    service.remoteReadPending=0;service.remoteReadMachines=new Map();
    service.db=new DatabaseSync(path);await chmod(path,0o600);
    service.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS portal_state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, time TEXT NOT NULL, actor TEXT NOT NULL, operation TEXT NOT NULL, subject TEXT, outcome TEXT NOT NULL);');
    service.db.exec("CREATE TABLE IF NOT EXISTS invites (role TEXT PRIMARY KEY CHECK(role IN ('admin','member')), digest TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0, max_uses INTEGER, created_at TEXT NOT NULL);");
    installMaintenanceState(service);installCommunity(service);installDatasetLabels(service);installProjectCatalog(service);installTaskDisplay(service);
    if(!service.db.prepare('PRAGMA table_info(invites)').all().some(c=>c.name==='code_cipher'))service.db.exec('ALTER TABLE invites ADD COLUMN code_cipher TEXT');
    const keyPath=path+'.invite-key';
    try{service.inviteKey=await readFile(keyPath);}catch(e){
      if(e.code!=='ENOENT')throw e;
      if(service.db.prepare('SELECT 1 FROM invites WHERE code_cipher IS NOT NULL LIMIT 1').get())throw Error('Invitation encryption key missing; restore it from the private backup.');
      for(const table of ['cloud_secrets','cloud_imports'])if(service.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)&&service.db.prepare('SELECT 1 FROM '+table+' LIMIT 1').get())throw Error('Cloud encryption key missing; restore the original private key backup.');
      await writeFile(keyPath,randomBytes(32),{mode:0o600,flag:'wx'});service.inviteKey=await readFile(keyPath);
    }
    if(service.inviteKey.length!==32)throw Error('Invalid invitation encryption key');await chmod(keyPath,0o600);
    installCloudImports(service);
    const saved=service.db.prepare('SELECT data FROM portal_state WHERE id=1').get();
    if(saved)service.restore(JSON.parse(saved.data));
    else{
      if(!bootstrapPath)throw Error('Initial administrator credentials are required.');
      const initial=JSON.parse(await readFile(bootstrapPath,'utf8'));
      if(initial.username!=='admin'||typeof initial.password!=='string'||initial.password.length<20)throw Error('Bootstrap requires admin and a generated password of at least 20 characters.');
      service.store.users=[{id:'builtin-admin',name:'管理员',username:'admin',role:'admin',enabled:true,limits:{},total:0}];service.store.jobs=[];service.store.sequence=0;
      service.credentials=new Map([['admin',await credential(initial.password,600000)]]);service.save();
    }
    // Public registration never grants administrative authority.
    service.db.prepare("UPDATE invites SET enabled=0 WHERE role='admin'").run();
    for(const user of service.store.users)user.policyVersion??=0;
    service.loginSessions=new LoginSessions(service.db,id=>service.store.users.find(user=>user.id===id),{initialPrune:!service.globalMaintenanceActive()});
    service.statusPath=statusPath;await service.refreshGPUQ();installExecution(service,bridge);installMaintenance(service);installJobNotifications(service,notificationConfig);
    installOciCohort(service,ociCohortMachines);
    installProjectReplication(service);
    maintainTaskNotes(service);
    installTransfers(service);
    installStorageArchive(service,storageArchiveConfig);
    installDatasetIngress(service,datasetIngressConfig);
    installDatasetDeletion(service);
    installDatasetCacheActions(service);
    service.dummy=await credential(crypto.randomUUID(),600000);return service;
  }
  export(){return {schema:1,users:this.store.users,jobs:this.store.jobs,sequence:this.store.sequence,credentials:[...this.credentials].map(([name,r])=>[name,{salt:Buffer.from(r.salt).toString('base64'),hash:Buffer.from(r.hash).toString('base64'),iterations:r.iterations||210000}])};}
  restore(data){if(data.schema!==1)throw Error('Unsupported database version.');this.store.users=data.users;this.store.jobs=data.jobs;this.store.sequence=data.sequence;this.credentials=new Map(data.credentials.map(([name,r])=>[name,{salt:new Uint8Array(Buffer.from(r.salt,'base64')),hash:new Uint8Array(Buffer.from(r.hash,'base64')),iterations:r.iterations}]));}
  save(){this.db.prepare('INSERT INTO portal_state(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(this.export()));}
  issueSession(principal){
    const admission=this.loginAdmissions?.get(principal.username);
    // Password hashing awaits; a reset or revoke may have completed meanwhile.
    admission?.check();
    const token=this.loginSessions?this.loginSessions.issue(principal):super.issueSession(principal);
    if(admission)admission.issued=token;
    return token;
  }
  principal(token){return this.loginSessions?this.loginSessions.principal(token):super.principal(token);}
  revokeSession(token){if(this.loginSessions)this.loginSessions.revoke(token);else super.revokeSession(token);}
  invalidate(username){if(this.loginSessions)this.loginSessions.invalidate(username);else super.invalidate(username);}
  audit(actor,operation,subject,outcome){this.db.prepare('INSERT INTO audit(time,actor,operation,subject,outcome) VALUES(?,?,?,?,?)').run(new Date().toISOString(),String(actor).slice(0,64),String(operation).slice(0,64),subject?String(subject).slice(0,64):null,outcome);}
  enqueue(fn){
    if(this.pending>=24){const e=Error('服务忙，请稍后重试。');e.status=429;return Promise.reject(e);}
    this.pending++;const run=this.tail.then(fn);this.tail=run.catch(()=>{}).finally(()=>this.pending--);return run;
  }
  async remoteRead(token,operation,args){
    if(!args||typeof args!=='object'||Array.isArray(args))throw Error('参数格式错误。');
    const request=structuredClone(args);
    const principal={...this.terminalPrincipal(token,request)};
    if(operation==='host.status'&&principal.role!=='admin')throw Object.assign(Error('宿主机命令仅管理员可用。'),{status:403});
    const check=()=>{
      const current=this.terminalPrincipal(token,request);
      if(current.userId!==principal.userId||current.username!==principal.username||current.role!==principal.role)
        throw Object.assign(Error('登录身份已改变。'),{status:403});
      this.assertMaintenanceAllowed?.(operation,request,current);
    };
    this.remoteReadMachines??=new Map();this.remoteReadPending??=0;
    const count=this.remoteReadMachines.get(request.machine)||0;
    if(this.remoteReadPending>=4||count>=2)throw Object.assign(Error('节点状态查询繁忙，请稍后重试。'),{status:429});
    this.remoteReadPending++;this.remoteReadMachines.set(request.machine,count+1);
    const work=Promise.resolve().then(()=>{check();return executionCall(this,principal,operation,request);});
    const release=()=>{
      this.remoteReadPending--;
      const remaining=this.remoteReadMachines.get(request.machine)-1;
      if(remaining)this.remoteReadMachines.set(request.machine,remaining);else this.remoteReadMachines.delete(request.machine);
    };
    // Keep admission charged until the actual I/O settles, even if the caller
    // times out. An unresponsive dependency cannot create unlimited background
    // reads. bridgeClient separately closes its owned socket at a hard deadline.
    work.then(release,release);
    let timer;
    try{
      const result=await Promise.race([work,new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(Object.assign(Error('节点状态查询超时；原操作未被重派，请稍后查询。'),{status:504,code:'NODE_READ_TIMEOUT'})),35000);
      })]);
      check();
      return {result,principal:{...principal}};
    }catch(error){check();throw error;
    }finally{clearTimeout(timer);}
  }
  async jobRead(token,operation,args,options={}){
    if(!['jobs.logs','jobs.watch','jobs.completion','jobs.diagnostics'].includes(operation))throw Error('Invalid job read operation');
    if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>key!=='jobId'))
      throw Object.assign(Error('任务查询仅接受任务 ID。'),{status:400});
    const request=structuredClone(args),admitted=this.principal(token),policy=authorizationPolicy(this.store.get(admitted.userId));
    const job=this.store.jobs.find(value=>value.id===request.jobId);
    const identity=value=>JSON.stringify([value.id,value.userId,value.machine,value.spec]);
    const binding=job&&identity(job),nativeId=job?.nodeJobId;
    const controller=new AbortController(),deadline=Date.now()+40000;
    const check=()=>{
      if(this.closing)throw Object.assign(Error('服务正在关闭。'),{status:503});
      const current=this.principal(token),user=this.store.get(current.userId),live=this.store.jobs.find(value=>value.id===request.jobId);
      if(current.userId!==admitted.userId||current.username!==admitted.username||current.role!==admitted.role||
        !user.enabled||authorizationPolicy(user)!==policy||!live||current.role!=='admin'&&live.userId!==current.userId||
        identity(live)!==binding||nativeId&&live.nodeJobId!==nativeId||live.machine&&!user.limits[live.machine])
        throw Object.assign(Error('账号或任务授权已改变，请重新查询。'),{status:403});
      this.assertMaintenanceAllowed?.(operation,request,current);
      controller.signal.throwIfAborted();
      return current;
    };
    check();this.jobReadPending??=0;this.jobReadMachines??=new Map();
    const machine=job.machine,count=this.jobReadMachines.get(machine)||0;
    if(this.jobReadPending>=8||count>=4)throw Object.assign(Error('任务查询繁忙，请稍后重试。'),{status:429});
    this.jobReadPending++;this.jobReadMachines.set(machine,count+1);
    const abort=()=>controller.abort(options.signal.reason);
    options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
    const work=Promise.resolve().then(()=>{check();return executionCall(this,admitted,operation,request,{check,signal:controller.signal,deadline});});
    const release=()=>{
      this.jobReadPending--;const remaining=this.jobReadMachines.get(machine)-1;
      if(remaining)this.jobReadMachines.set(machine,remaining);else this.jobReadMachines.delete(machine);
    };
    work.then(release,release);
    let timer;
    try{
      const result=await Promise.race([work,new Promise((_,reject)=>{
        timer=setTimeout(()=>{const error=Object.assign(Error('任务查询超时，请查询原任务。'),{status:504,code:'NODE_READ_TIMEOUT'});controller.abort(error);reject(error);},40000);
      })]);
      return {result,principal:{...check()}};
    }catch(error){check();throw error;}
    finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);}
  }
  terminalPrincipal(token,args){
    if(this.closing)throw Object.assign(Error('服务正在关闭。'),{status:503});
    const {username,role,userId}=this.principal(token);
    const current=this.store.users.find(user=>user.id===userId);
    if(!current?.enabled||current.username!==username||(current.role||'member')!==role)
      throw Object.assign(Error('终端账号权限已改变，请重新登录。'),{status:403});
    const user=this.store.get(userId);
    if(!MACHINES.some(machine=>machine.id===args.machine)||!user.limits[args.machine])
      throw Object.assign(Error('这台机器未授权。'),{status:403});
    if(args.hostAdmin&&role!=='admin')throw Object.assign(Error('宿主机 root 终端仅管理员可用。'),{status:403});
    return {username,role,userId};
  }
  async terminalExchange(token,args){
    if(!args||typeof args!=='object'||Array.isArray(args))throw Error('参数格式错误。');
    // Only streaming exchanges bypass the durable mutation queue. The node
    // still validates ownership and fences every request with its writer lease.
    args={...args};const admitted=this.terminalPrincipal(token,args);
    const key=JSON.stringify([args.machine,args.id]);
    const lane=this.terminalLanes.get(key)||{tail:Promise.resolve(),pending:0};
    if(this.terminalPending>=24||lane.pending>=4)
      throw Object.assign(Error('终端请求过多，请等待当前请求完成。'),{status:429});
    this.terminalLanes.set(key,lane);this.terminalPending++;lane.pending++;
    const run=lane.tail.then(async()=>{
      const principal=this.terminalPrincipal(token,args);
      if(principal.userId!==admitted.userId||principal.role!==admitted.role||principal.username!==admitted.username)
        throw Object.assign(Error('终端登录身份已改变。'),{status:403});
      // executionCall retains the complete trusted field/context validation and
      // dispatches exactly once. Never retry input after an ambiguous failure.
      let result,current;
      try{result=await executionCall(this,principal,'terminal.exchange',args);}finally{
        // Recheck failed responses too: node errors can contain private context.
        current=this.terminalPrincipal(token,args);
        if(current.userId!==principal.userId||current.role!==principal.role||current.username!==principal.username)
          throw Object.assign(Error('终端登录身份已改变。'),{status:403});
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
      const current=this.principal(token),user=this.store.users.find(u=>u.id===current.userId);
      if(!user?.enabled||current.userId!==admitted.userId||current.role!==admitted.role||current.username!==admitted.username||(user.role||'member')!==current.role)
        throw Object.assign(Error('账号权限已改变，请重新登录。'),{status:403});
      if(args.machine&&(!MACHINES.some(m=>m.id===args.machine)||!this.store.get(current.userId).limits[args.machine]))
        throw Object.assign(Error('这台机器未授权。'),{status:403});
      return current;
    };
    check();
    const count=this.cloudUsers.get(admitted.userId)||0;
    const key=operation.startsWith('cloud.import.')&&(args.key||args.operationId)?JSON.stringify([admitted.userId,args.machine,args.key||args.operationId]):null;
    if(this.cloudPending>=8||count>=2||key&&this.cloudKeys.has(key))throw Object.assign(Error('导入请求正在处理，请稍后刷新或重试。'),{status:429});
    this.cloudPending++;this.cloudUsers.set(admitted.userId,count+1);if(key)this.cloudKeys.add(key);
    try{
      let result;try{result=await cloudImportCall(this,admitted,operation,args,check);}finally{check();}
      return {result,principal:check()};
    }finally{
      this.cloudPending--;const remaining=this.cloudUsers.get(admitted.userId)-1;
      if(remaining)this.cloudUsers.set(admitted.userId,remaining);else this.cloudUsers.delete(admitted.userId);
      if(key)this.cloudKeys.delete(key);
    }
  }
  async datasetRead(token,operation,args){
    if(!args||typeof args!=='object'||Array.isArray(args))throw Error('参数格式错误。');
    args=structuredClone(args);
    const admitted=this.principal(token),policy=authorizationPolicy(this.store.get(admitted.userId));
    const check=()=>{
      if(this.closing)throw Object.assign(Error('服务正在关闭。'),{status:503});
      const current=this.principal(token);
      if(current.userId!==admitted.userId||current.role!==admitted.role||current.username!==admitted.username||authorizationPolicy(this.store.get(current.userId))!==policy)
        throw Object.assign(Error('账号授权已改变，请重新加载数据集。'),{status:403});
      return current;
    };
    check();
    if(this.datasetReadPending>=4)throw Object.assign(Error('数据目录正在读取，请稍后刷新。'),{status:429});
    this.datasetReadPending++;
    try{let result;try{
      this.assertMaintenanceAllowed?.(operation,args,admitted);
      result=operation.startsWith('datasets.cache.')
        ?await this.datasetCacheActionsCall(admitted,operation,args,check)
        :await executionCall(this,admitted,operation,args);
    }finally{check();}return {result,principal:check()};}
    finally{this.datasetReadPending--;}
  }
  async login(username,password){
    // Authentication must not wait behind remote writes or scheduler dispatch.
    // Bound expensive password work independently; same-account attempts remain
    // serial so the inherited failure counter cannot lose concurrent updates.
    username=String(username??'').trim();
    if(username.length>24||typeof password!=='string'||password.length>128)
      throw Error('用户名或密码错误。');
    if(this.closing)throw Object.assign(Error('服务正在关闭。'),{status:503});
    this.loginPending??=0;this.loginAdmissions??=new Map();
    if(this.loginPending>=2||this.loginAdmissions.has(username))
      throw Object.assign(Error('登录验证繁忙，请稍后重试。'),{status:429});
    this.loginPending++;
    const record=this.credentials.get(username);
    const admitted=this.store.users.find(user=>user.username===username);
    const identity=admitted?{id:admitted.id,role:admitted.role||'member'}:null;
    const check=()=>{
      if(this.closing)throw Object.assign(Error('服务正在关闭。'),{status:503});
      const current=this.store.users.find(user=>user.username===username);
      if(this.credentials.get(username)!==record||
         (identity&&(!current?.enabled||current.id!==identity.id||(current.role||'member')!==identity.role)))
        throw Object.assign(Error('账号权限或密码已改变，请重新登录。'),{status:403});
    };
    const admission={check,issued:null};this.loginAdmissions.set(username,admission);
    try{
      await this.refreshGPUQ();check();
      const result=await super.login(username,password);
      check();this.audit(username,'login',null,'ok');return result;
    }catch(e){
      if(admission.issued&&!this.closing)this.revokeSession(admission.issued);
      if(!this.closing)this.audit(username,'login',null,'denied');
      throw e;
    }finally{this.loginPending--;this.loginAdmissions.delete(username);}
  }
  invitations(){return ['member'].map(role=>{
    const row=this.db.prepare('SELECT role,enabled,uses,max_uses,created_at FROM invites WHERE role=?').get(role);
    return row?{role,enabled:!!row.enabled,uses:row.uses,maxUses:row.max_uses,createdAt:row.created_at,available:!!row.enabled&&(row.max_uses===null||row.uses<row.max_uses)}:{role,enabled:false,uses:0,maxUses:role==='admin'?1:null,createdAt:null,available:false};
  });}
  // Immutable storage-format identifier: keep existing encrypted invitations valid.
  sealInvite(code){const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.inviteKey,nonce);cipher.setAAD(Buffer.from('amax-invite-v1'));const data=Buffer.concat([cipher.update(code,'utf8'),cipher.final()]);return Buffer.concat([nonce,cipher.getAuthTag(),data]).toString('base64');}
  currentInvite(){const row=this.db.prepare("SELECT enabled,code_cipher FROM invites WHERE role='member'").get();if(!row?.enabled||!row.code_cipher)return null;const data=Buffer.from(row.code_cipher,'base64'),decipher=createDecipheriv('aes-256-gcm',this.inviteKey,data.subarray(0,12));decipher.setAAD(Buffer.from('amax-invite-v1'));decipher.setAuthTag(data.subarray(12,28));return Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString('utf8');}
  register(args){return this.enqueue(async()=>{
    const before=structuredClone(this.export());let transaction=false;
    try{
      if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['username','password','invite','client','name'].includes(k)))throw Error('注册参数无效；角色由邀请码决定。');
      const {password,invite}=args,username=String(args.username??'').trim();
      if(!validUsername(username))throw Error('用户名须为 2–24 位，使用汉字或小写字母开头，可含数字、下划线和短横线。');
      if(typeof password!=='string'||password.length<8||password.length>128)throw Error('密码需为 8–128 个字符。');
      if(typeof invite!=='string'||invite.length>128){const e=Error('邀请码无效、已停用或已用完。');e.status=403;throw e;}
      const digest=createHash('sha256').update(invite.trim()).digest('hex');
      const code=this.db.prepare("SELECT * FROM invites WHERE role='member' AND digest=? AND enabled=1 AND (max_uses IS NULL OR uses<max_uses)").get(digest);
      if(!code){const e=Error('邀请码无效、已停用或已用完。');e.status=403;throw e;}
      if(this.store.users.some(u=>u.username===username))throw Error('这个用户名已存在，请换一个。');
      if(this.store.users.length>=1000)throw Error('注册名额已满，请联系管理员。');
      const record=await credential(password,600000);
      this.db.exec('BEGIN IMMEDIATE');transaction=true;
      const update=this.db.prepare('UPDATE invites SET uses=uses+1 WHERE role=? AND digest=? AND enabled=1 AND (max_uses IS NULL OR uses<max_uses)').run(code.role,digest);
      if(update.changes!==1)throw Error('邀请码已失效，请联系管理员。');
      const user=this.store.create(args.name??username,username);this.store.setRole(user.id,'member');this.store.users.find(u=>u.id===user.id).policyVersion=0;this.credentials.set(username,record);
      this.save();this.audit(username,'register',code.role,'ok');this.db.exec('COMMIT');transaction=false;
      this.syncOciAccountEvent();
      return {registered:true,username,role:code.role};
    }catch(e){if(transaction)this.db.exec('ROLLBACK');this.restore(before);this.audit('guest','register',null,'denied');throw e;}
  });}
  manageInvites(principal,operation,args){
    if(principal.role!=='admin'){const e=Error('此操作需要管理员权限。');e.status=403;throw e;}
    if(!args||typeof args!=='object'||Array.isArray(args))throw Error('参数格式错误。');
    if(operation==='invites.list')return {invitations:this.invitations(),code:this.currentInvite()};
    const {role}=args;if(role!=='member'||!['invites.rotate','invites.disable'].includes(operation))throw Error('只开放普通用户邀请码；管理员权限不能通过注册获得。');
    let result;this.db.exec('BEGIN IMMEDIATE');
    try{
      if(operation==='invites.rotate'){
        const code=`GPUQ-${role==='admin'?'A':'U'}-${randomBytes(24).toString('base64url')}`;
        const digest=createHash('sha256').update(code).digest('hex');
        this.db.prepare('INSERT INTO invites(role,digest,enabled,uses,max_uses,created_at) VALUES(?,?,1,0,?,?) ON CONFLICT(role) DO UPDATE SET digest=excluded.digest,enabled=1,uses=0,max_uses=excluded.max_uses,created_at=excluded.created_at').run(role,digest,role==='admin'?1:null,new Date().toISOString());
        this.db.prepare('UPDATE invites SET code_cipher=? WHERE role=?').run(this.sealInvite(code),role);
        result={role,code,invitations:this.invitations()};
      }else{this.db.prepare('UPDATE invites SET enabled=0 WHERE role=?').run(role);result={role,disabled:true,invitations:this.invitations()};}
      this.audit(principal.username,operation,role,'ok');this.db.exec('COMMIT');return result;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  invoke(token,operation,args={},options={}){
    if(['jobs.logs','jobs.watch','jobs.completion','jobs.diagnostics'].includes(operation))return this.jobRead(token,operation,args,options);
    if(operation==='datasets.upload.admission.status'){
      if(!args||typeof args!=='object'||Array.isArray(args))throw Error('参数格式错误。');
      const principal=this.principal(token);
      // Pure journal recovery must not queue behind an unconfirmed node begin.
      // It neither creates a mapping nor makes a bridge request.
      return executionCall(this,principal,operation,structuredClone(args)).then(result=>{
        const current=this.principal(token);
        if(current.userId!==principal.userId||current.username!==principal.username||current.role!==principal.role)
          throw Object.assign(Error('登录身份已改变。'),{status:403});
        return {result,principal:{...current}};
      });
    }
    if(operation==='tasks.display.get'||operation==='tasks.display.set')return taskDisplayCall(this,token,operation,args).then(result=>({result,principal:this.principal(token)}));
    if(['host.status','files.upload.status','files.get','files.list',
      'projects.list','projects.quota','projects.status','projects.local-import.status','projects.retire.plan','projects.retire.status'
    ].includes(operation))return this.remoteRead(token,operation,args);
    if(operation==='projects.replicate'||operation==='projects.replication.status'||operation==='projects.replication.cancel'||operation==='projects.replication.retry'){
      const principal=this.principal(token);
      return projectReplicationCall(this,principal,operation,args,()=>this.principal(token)).then(result=>{
        this.principal(token);
        return {result,principal:{username:principal.username,role:principal.role,userId:principal.userId}};
      });
    }
    if(operation==='datasets.label.get'||operation==='datasets.label.set'){
      const principal=this.principal(token);
      if(this.datasetReadPending>=4)return Promise.reject(Object.assign(Error('数据目录正在读取，请稍后刷新。'),{status:429}));
      this.datasetReadPending++;
      return datasetLabelCall(this,principal,operation,args,()=>this.principal(token))
        .then(result=>({result,principal:this.principal(token)})).finally(()=>this.datasetReadPending--);
    }
    if(operation==='terminal.exchange')return this.terminalExchange(token,args);
    if(['datasets.delete','datasets.delete.status','datasets.delete.restore','datasets.delete.continue','datasets.delete.cancel'].includes(operation)){
      if(!args||typeof args!=='object'||Array.isArray(args))throw Error('参数格式错误。');
      const principal=this.principal(token);
      const check=()=>{const current=this.principal(token);if(current.userId!==principal.userId||current.username!==principal.username||current.role!==principal.role)throw Object.assign(Error('登录身份已改变。'),{status:403});};
      return this.datasetDeletionCall(principal,operation,structuredClone(args),check).then(result=>{check();return {result,principal:{...principal}};});
    }
    if(['storage.usage.mine','storage.usage.users'].includes(operation)){
      const principal=this.principal(token),policy=authorizationPolicy(this.store.get(principal.userId));
      const check=()=>{
        const current=this.principal(token);
        if(this.closing||current.userId!==principal.userId||current.role!==principal.role||current.username!==principal.username
          ||authorizationPolicy(this.store.get(current.userId))!==policy)
          throw Object.assign(Error('账号授权已改变，请刷新后重试。'),{status:403});
        return current;
      };
      this.assertMaintenanceAllowed?.(operation,args,principal);
      if(this.datasetReadPending>=4)throw Object.assign(Error('空间统计正在读取，请稍后刷新。'),{status:429});
      this.datasetReadPending++;
      return storageUsageCall(displayReadService(this,operation),principal,operation,args).then(result=>({result,principal:check()}))
        .finally(()=>this.datasetReadPending--);
    }
    if(['datasets.catalog','datasets.capacity','datasets.overview','datasets.files.list','datasets.training.capabilities','datasets.list','datasets.status','datasets.prepare',
      'datasets.cache.capabilities','datasets.cache.prepare','datasets.cache.release','datasets.cache.status','datasets.cache.cancel'].includes(operation))return this.datasetRead(token,operation,args);
    if(typeof operation==='string'&&operation.startsWith('transfers.')){
      const principal=this.principal(token);
      return transferCall(this,principal,operation,args,()=>this.principal(token)).then(result=>({result,principal:{username:principal.username,role:principal.role,userId:principal.userId}}));
    }
    // Remote cloud/DNS requests do not hold the account and scheduler queue.
    if(typeof operation==='string'&&operation.startsWith('cloud.')&&!operation.startsWith('cloud.auth.'))return this.cloudExchange(token,operation,args);
    return this.enqueue(async()=>{
    const principal=this.principal(token),actor=principal.username;
    if(!args||typeof args!=='object'||Array.isArray(args))throw Error('参数格式错误。');
    if(typeof operation==='string'&&operation.startsWith('cloud.auth.'))return {result:await cloudImportCall(this,principal,operation,args,()=>{if(this.closing)throw Object.assign(Error('服务正在关闭。'),{status:503});this.principal(token);}),principal:{username:principal.username,role:principal.role,userId:principal.userId}};
    if(typeof operation==='string'&&operation.startsWith('maintenance.'))return {result:await maintenanceCall(this,principal,operation,args),...(operation==='maintenance.set'?{state:this.state(principal)}:{}),principal:{username:principal.username,role:principal.role,userId:principal.userId}};
    if(operation==='notifications.job')return {result:this.configureJobNotification(principal,args),state:this.state(principal)};
    if(typeof operation==='string'&&operation.startsWith('community.'))return {result:communityCall(this,principal,operation,args),principal:{username:principal.username,role:principal.role,userId:principal.userId}};
    // Execution writes its durable reservation before external side effects. Never
    // restore an older snapshot after a dispatch timeout (that would lose quota).
    if(typeof operation==='string'&&(operation.startsWith('jobs.')||operation.startsWith('host.')||operation.startsWith('files.')||operation.startsWith('terminal.')||operation.startsWith('datasets.')||operation.startsWith('projects.'))){
      const result=await executionCall(this,principal,operation,args);
      // A data chunk does not change the dashboard; avoid rebuilding and sending
      // its full GPU/account snapshot for every 1 MiB read.
      if(operation==='datasets.workspace.get')return {result,principal:{username:principal.username,role:principal.role,userId:principal.userId}};
      return {result,state:this.state(principal),principal:{username:principal.username,role:principal.role,userId:principal.userId}};
    }
    const before=structuredClone(this.export()),sessions=new Map(this.sessions);
    try{
      if(operation==='users.delete'){
        if(principal.role!=='admin')throw Object.assign(Error('此操作需要管理员权限。'),{status:403});
        const user=this.store.get(args.userId);
    if(user.id===principal.userId||user.enabled||this.store.jobs.some(job=>job.userId===user.id&&!['SUCCEEDED','FAILED','CANCELED'].includes(job.state)))throw Error('只能删除已暂停且没有待完成任务的非当前账号。历史任务和文件保留。');
    if(this.db.prepare("SELECT 1 FROM transfers WHERE owner_id=? AND state NOT IN ('SUCCEEDED','FAILED','PAUSED','CANCELED') LIMIT 1").get(user.id))throw Error('请先确认这个账号的传输已结束，再删除账号。');
        if(user.role==='admin'&&!this.store.users.some(u=>u.id!==user.id&&u.enabled&&u.role==='admin'))throw Error('不能删除最后一名可登录管理员。');
        this.db.exec('BEGIN IMMEDIATE');
        try{this.invalidate(user.username);this.credentials.delete(user.username);this.store.users=this.store.users.filter(u=>u.id!==user.id);this.save();this.audit(actor,operation,user.id,'ok');this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
        this.syncOciAccountEvent();return {result:{deleted:true},state:this.state(principal)};
      }
      if(typeof operation==='string'&&operation.startsWith('invites.'))return {result:this.manageInvites(principal,operation,args),state:this.state(principal),principal:{username:principal.username,role:principal.role,userId:principal.userId}};
      if(operation==='request'||operation==='release'){const e=Error('真实 GPUQ 提交尚未开放；不会模拟占卡或启动训练。');e.status=503;throw e;}
      if(operation==='state')await this.refreshGPUQ();
      if(operation==='policy.full'){
        if(principal.role!=='admin')throw Object.assign(Error('此操作需要管理员权限。'),{status:403});
        args={userId:args.userId,policyVersion:args.policyVersion,limits:Object.fromEntries(MACHINES.map(m=>[m.id,m.cards])),total:MACHINES.reduce((n,m)=>n+m.cards,0)};operation='policy.save';
      }
      if(operation==='policy.save'){
        if(principal.role!=='admin')throw Object.assign(Error('此操作需要管理员权限。'),{status:403});
        const user=this.store.users.find(u=>u.id===args.userId);if(!user)throw Error('用户不存在。');
        if(args.policyVersion!==user.policyVersion)throw Object.assign(Error('权限已被其他窗口修改，请刷新后重试。'),{status:409});
        // Do not silently kill running experiments when lowering a policy.
        if(user.role!=='admin'&&(args.total<usage(this.store.jobs,user.id)||Object.entries(user.limits).some(([m])=>(args.limits?.[m]||0)<usage(this.store.jobs,user.id,m))))throw Object.assign(Error('新额度低于当前预留用卡数。请先取消相应任务并等待释放。'),{status:409});
      }
      const result=await super.invoke(token,operation,args);
      if(operation==='policy.save'){const u=this.store.users.find(u=>u.id===args.userId);u.policyVersion++;u.approvedBy=actor;u.approvedAt=new Date().toISOString();result.result=this.store.get(u.id);result.state=this.state(principal);}
      if(operation==='users.create'){this.store.users.find(u=>u.id===result.result.id).policyVersion=0;result.state=this.state(principal);}
      this.db.exec('BEGIN IMMEDIATE');
      try{if(operation!=='state'&&operation!=='logout')this.save();if(operation!=='state')this.audit(actor,operation,args?.userId||args?.jobId,'ok');this.db.exec('COMMIT');}
      catch(e){this.db.exec('ROLLBACK');throw e;}
      if(['policy.save','users.create','users.enabled','users.role'].includes(operation))this.syncOciAccountEvent();
      return {...result,principal:operation==='logout'?null:{username:principal.username,role:principal.role,userId:principal.userId}};
    }catch(e){this.restore(before);this.sessions=sessions;this.audit(actor,operation,args?.userId||args?.jobId,'denied');throw e;}
  });}
  async refreshGPUQ(){this.gpuq=await readGPUQStatus(this.statusPath);}
  state(principal){
    const state=super.state(principal);
    const snapshot=this.taskDisplaySnapshot(this.gpuq||{checkedAt:null,stale:true,hosts:[]});
    state.jobs=state.jobs.map(j=>this.taskDisplayJob(j));
    const gpuq=visibleGPUQStatus(snapshot,principal,this.store.get(principal.userId).limits,{jobs:this.store.jobs.map(j=>this.taskDisplayJob(j)),users:this.store.users});
    const capabilities=Object.fromEntries(gpuq.hosts.map(h=>[h.id,!gpuq.stale&&priorityCapable(h)===true]));
    return {...state,taskMetadata:{version:1},maintenance:{version:1,retired:true,readOnly:true},operationalMaintenance:this.operationalMaintenance?.(principal),jobs:state.jobs.map(j=>({...publicJob(j,this.store.users),notifications:this.jobNotificationState(j,principal.userId),canSetPriority:principal.role==='admin'&&!gpuq.stale&&priorityRankCapable(gpuq.hosts.find(h=>h.id===j.machine))===true&&j.state==='PENDING'&&!j.cancelRequested&&j.priorityMutable===true&&(j.spec?.preemptIdleOnly===true||!!j.spec?.scheduling)})),
      demo:false,mode:'persistent',gpuqConnected:gpuq.hosts.some(h=>h.gpuq.connected),jobsSimulated:false,executionEnabled:this.executionEnabled===true,
      execution:{priorityCapabilities:capabilities},gpuq,transfers:{version:1},
      // Protocol availability is a Portal policy fact, not a node/mount or
      // free-space admission proof. The private HDD RPC still verifies those.
      datasetUploadAdmission:datasetUploadAdmissionView(this.datasetIngressPolicy,this.datasetArchiveCapability),
      ...(principal.role==='admin'?{invitations:this.invitations()}:{})};
  }
  close(){this.closing=true;for(const admission of this.loginAdmissions?.values()||[])if(admission.issued)this.revokeSession(admission.issued);this.cloudProvider?.clear();clearInterval(this.executionTimer);clearInterval(this.notificationTimer);clearInterval(this.maintenanceTimer);clearInterval(this.transferTimer);clearInterval(this.storageArchiveTimer);clearInterval(this.projectCopyTimer);this.db.close();}
}
