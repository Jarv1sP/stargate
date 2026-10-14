import {selectFields} from './portal-request-validation.mjs';
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute} from 'node:path';
import {JOB_TERMINAL,jobFeedbackText} from './dist/job-progress.js';

const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const CAPACITY=10000,MAX_KEYS=128,RETENTION=7*86400;
const ownerId=value=>typeof value==='string'&&/^(builtin-admin|demo-user-[0-9]+)$/.test(value);
const eventHash=JSON.stringify;

async function privateFile(path,limit){
  if(typeof path!=='string'||!isAbsolute(path))throw Error('Notification files require absolute paths');
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const info=await file.stat();
    if(!info.isFile()||info.mode&0o077||info.size>limit)throw Error('Notification file must be a private regular file within its size limit');
    const raw=await file.readFile('utf8');if(Buffer.byteLength(raw)>limit)throw Error('Notification file exceeds its size limit');return raw;
  }finally{await file.close();}
}

export async function loadTelegramNotifications(path,{fetchImpl=fetch}={}){
  if(!path)return null;
  let config;try{config=JSON.parse(await privateFile(path,65536));}catch{throw Error('Invalid private Telegram notification configuration');}
  if(!config||typeof config!=='object'||Array.isArray(config)||!config.chatByUserId||typeof config.chatByUserId!=='object'||Array.isArray(config.chatByUserId))throw Error('Invalid private Telegram notification configuration');
  const entries=Object.entries(config.chatByUserId);
  if(entries.length>10000||entries.some(([id,chat])=>!ownerId(id)||typeof chat!=='string'||!/^-[1-9][0-9]{0,18}$|^[1-9][0-9]{0,18}$/.test(chat)))throw Error('Invalid Telegram user destination mapping');
  const token=(await privateFile(config.tokenFile,512)).trim();
  if(!/^[0-9]{5,20}:[A-Za-z0-9_-]{20,100}$/.test(token))throw Error('Invalid Telegram bot credential');
  const chatByUserId=Object.fromEntries(entries);
  const send=async(chat,text)=>{
    try{
      const response=await fetchImpl('https://api.telegram.org/bot'+token+'/sendMessage',{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chat,text:text.slice(0,4000),link_preview_options:{is_disabled:true}})});
      let raw='';for await(const part of response.body){raw+=Buffer.from(part).toString('utf8');if(Buffer.byteLength(raw)>32768)throw Error('Notification response too large');}
      const result=JSON.parse(raw);
      if(response.ok&&result?.ok===true)return;
      const code=Number.isInteger(result?.error_code)?result.error_code:response.status;
      throw Object.assign(Error('Telegram delivery rejected'),{code,retryAfter:Number.isInteger(result?.parameters?.retry_after)?Math.min(86400,Math.max(1,result.parameters.retry_after)):null,permanent:[400,401,403,404].includes(code)});
    }catch(error){
      // The URL contains the token. Never propagate fetch messages, response
      // descriptions or headers into a log, database or client response.
      throw Object.assign(Error('Telegram notification delivery unavailable'),{code:Number.isInteger(error.code)?error.code:null,retryAfter:error.retryAfter||null,permanent:error.permanent===true});
    }
  };
  return {chatByUserId,send};
}

function notificationEvents(job){
  const events=[],attempt=job.latestAttempt?.id||job.nodeJobId||'unassigned';
  if(JOB_TERMINAL.has(job.state))events.push({key:eventHash(['terminal',job.state]),kind:'任务已完成／结束',terminal:true});
  const progress=job.progress,s=progress?.snapshot;
  if(!JOB_TERMINAL.has(job.state)&&progress?.reported&&s){
    if(['warning','error'].includes(s.severity))events.push({key:eventHash(['problem',attempt,s.severity,s.phase,s.message]),kind:'训练报告'+(s.severity==='error'?'异常':'警告')});
    if(progress.stale)events.push({key:eventHash(['stall',attempt,s.phase]),kind:'训练自报进度停滞'});
  }
  return events;
}

export function installJobNotifications(service,config,{clock=()=>Date.now()/1000,timer=true}={}){
  try{installNotificationStore(service,config,{clock,timer});}
  catch{
    // Optional notification storage cannot stop training observations or turn
    // a native FAILED result into a different lifecycle state.
    clearInterval(service.notificationTimer);
    service.jobNotificationState=(job,userId)=>({configured:!!config?.chatByUserId?.[userId],enabled:false,pending:null,failed:null,degraded:true});
    service.configureJobNotification=()=>fail('通知存储暂不可用；训练状态不受影响。',503);
    service.captureJobNotifications=()=>{};service.flushJobNotifications=async()=>{};
  }
}

function installNotificationStore(service,config,{clock,timer}){
  const db=service.db;
  db.exec(`CREATE TABLE IF NOT EXISTS job_notification_subscriptions_v2(job_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,enabled INTEGER NOT NULL,generation INTEGER NOT NULL DEFAULT 1,seen_keys TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE IF NOT EXISTS job_notification_outbox_v2(id INTEGER PRIMARY KEY,job_id TEXT NOT NULL,user_id TEXT NOT NULL,generation INTEGER NOT NULL,event_key TEXT NOT NULL,payload TEXT,state TEXT NOT NULL DEFAULT 'QUEUED',attempts INTEGER NOT NULL DEFAULT 0,next_at REAL NOT NULL,created_at REAL NOT NULL,error_code INTEGER,UNIQUE(job_id,generation,event_key));`);
  // A request may have reached Telegram just before a process stopped. Requeue
  // its durable receipt; Telegram has no idempotent sendMessage key.
  // Preserve an ambiguous durable delivery during a full maintenance restart.
  // The first normal flush after an explicit reopen performs the same recovery.
  if(!service.globalMaintenanceActive?.())db.prepare("UPDATE job_notification_outbox_v2 SET state='QUEUED' WHERE state='SENDING'").run();
  service.jobNotificationState=(job,userId)=>{
    try{
      const subscription=db.prepare('SELECT enabled FROM job_notification_subscriptions_v2 WHERE job_id=? AND user_id=?').get(job.id,userId);
      const counts=db.prepare("SELECT sum(state IN ('QUEUED','SENDING')) pending,sum(state='FAILED') failed FROM job_notification_outbox_v2 WHERE job_id=? AND user_id=?").get(job.id,userId);
      return {configured:!!config?.chatByUserId?.[userId],enabled:subscription?.enabled===1,pending:counts?.pending||0,failed:counts?.failed||0};
    }catch{return {configured:!!config?.chatByUserId?.[userId],enabled:false,pending:null,failed:null,degraded:true};}
  };
  service.configureJobNotification=(principal,args)=>{
    args=selectFields(args,['jobId','enabled']);
    if(Object.hasOwn(args,'enabled')&&typeof args.enabled!=='boolean')fail('通知参数无效。');
    const user=service.store.get(principal.userId),job=service.store.jobs.find(j=>j.id===args.jobId);
    if(!user.enabled)fail('请重新登录。',403);
    if(!job)fail('任务不存在。',404);
    if(!Object.hasOwn(args,'enabled'))return service.jobNotificationState(job,user.id);
    if(args.enabled&&(!config?.chatByUserId?.[user.id]||JOB_TERMINAL.has(job.state)))fail('请先由管理员配置你的 Telegram 收件人；只能开启待完成任务通知。',409);
    db.exec('BEGIN IMMEDIATE');
    try{
      db.prepare("INSERT INTO job_notification_subscriptions_v2(job_id,user_id,enabled) VALUES(?,?,?) ON CONFLICT(job_id) DO UPDATE SET user_id=excluded.user_id,enabled=excluded.enabled,generation=generation+(enabled<>excluded.enabled),seen_keys=CASE WHEN enabled=excluded.enabled THEN seen_keys ELSE '[]' END").run(job.id,user.id,args.enabled?1:0);
      if(!args.enabled)db.prepare("DELETE FROM job_notification_outbox_v2 WHERE job_id=? AND state IN ('QUEUED','SENDING')").run(job.id);
      service.audit(principal.username,'notifications.job',job.id,args.enabled?'enabled':'disabled');db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    return service.jobNotificationState(job,user.id);
  };
  service.captureJobNotifications=()=>{
    if(service.globalMaintenanceActive?.())return;
    const now=clock();
    db.prepare('DELETE FROM job_notification_outbox_v2 WHERE created_at<?').run(now-RETENTION);
    for(const sub of db.prepare('SELECT * FROM job_notification_subscriptions_v2').all()){
      const job=service.store.jobs.find(j=>j.id===sub.job_id),user=service.store.users.find(u=>u.id===sub.user_id);
      if(!job||!user?.enabled||!config?.chatByUserId?.[sub.user_id]||!sub.enabled){
        db.prepare("DELETE FROM job_notification_outbox_v2 WHERE job_id=? AND state IN ('QUEUED','SENDING')").run(sub.job_id);
        if(!job||!user)db.prepare('DELETE FROM job_notification_subscriptions_v2 WHERE job_id=?').run(sub.job_id);
        continue;
      }
      const seen=JSON.parse(sub.seen_keys);
      for(const event of notificationEvents(job)){
        // Leave one cursor slot for the final state even if a noisy long
        // training reports more distinct warnings than our bounded history.
        if(seen.includes(event.key)||seen.length>=(event.terminal?MAX_KEYS:MAX_KEYS-1)||db.prepare('SELECT count(*) n FROM job_notification_outbox_v2').get().n>=CAPACITY)continue;
        db.exec('SAVEPOINT job_notification_capture');
        try{
          db.prepare('INSERT OR IGNORE INTO job_notification_outbox_v2(job_id,user_id,generation,event_key,payload,next_at,created_at) VALUES(?,?,?,?,?,?,?)').run(job.id,user.id,sub.generation,event.key,(event.kind+'\n'+jobFeedbackText(job)).slice(0,4000),now,now);
          seen.push(event.key);db.prepare('UPDATE job_notification_subscriptions_v2 SET seen_keys=? WHERE job_id=?').run(JSON.stringify(seen),job.id);db.exec('RELEASE job_notification_capture');
        }catch(error){db.exec('ROLLBACK TO job_notification_capture; RELEASE job_notification_capture');throw error;}
      }
    }
  };
  // Removing configuration revokes undelivered messages locally. No token or
  // network is needed to clean old payloads or preserve retention bounds.
  try{service.captureJobNotifications();}catch{}
  let sending=false,pausedUntil=0;
  service.flushJobNotifications=async()=>{
    if(sending||service.closing||clock()<pausedUntil||service.globalMaintenanceActive?.())return;
    sending=true;
    try{
      await service.enqueue(()=>{
        if(service.closing||service.globalMaintenanceActive?.())return;
        // Only one flusher runs. An earlier receipt write may have failed
        // after delivery; retrying is at-least-once, never exactly-once.
        db.prepare("UPDATE job_notification_outbox_v2 SET state='QUEUED' WHERE state='SENDING'").run();
        service.captureJobNotifications();
      });
      if(!config)return;
      for(let count=0;count<20&&!service.closing&&!service.globalMaintenanceActive?.();count++){
        const row=await service.enqueue(()=>{
          if(service.closing||service.globalMaintenanceActive?.())return null;
          const candidate=db.prepare("SELECT * FROM job_notification_outbox_v2 WHERE state='QUEUED' AND next_at<=? ORDER BY id LIMIT 1").get(clock());
          if(candidate){
            const user=service.store.users.find(u=>u.id===candidate.user_id),job=service.store.jobs.find(j=>j.id===candidate.job_id);
            const subscription=db.prepare('SELECT enabled,generation FROM job_notification_subscriptions_v2 WHERE job_id=? AND user_id=?').get(candidate.job_id,candidate.user_id);
            if(!user?.enabled||!job||subscription?.enabled!==1||subscription.generation!==candidate.generation||!config.chatByUserId[candidate.user_id]){
              db.prepare('DELETE FROM job_notification_outbox_v2 WHERE id=?').run(candidate.id);return {discarded:true};
            }
            if(candidate.attempts>=10){
              db.prepare("UPDATE job_notification_outbox_v2 SET state='FAILED',payload=NULL WHERE id=?").run(candidate.id);return {discarded:true};
            }
          }
          if(candidate)db.prepare("UPDATE job_notification_outbox_v2 SET state='SENDING',attempts=attempts+1 WHERE id=?").run(candidate.id);
          return candidate;
        });
        if(!row)break;
        if(row.discarded)continue;
        let error;
        try{await config.send(config.chatByUserId[row.user_id],row.payload);}catch(value){error=value;}
        if(service.closing)return;
        await service.enqueue(()=>{
          if(service.closing)return;
          if(!error)db.prepare("UPDATE job_notification_outbox_v2 SET state='SENT',payload=NULL,error_code=NULL WHERE id=?").run(row.id);
          else{
            const permanent=error.permanent===true||row.attempts+1>=10;
            const backoff=Number.isFinite(error.retryAfter)?Math.min(86400,Math.max(1,error.retryAfter)):Math.min(3600,30*2**row.attempts);
            db.prepare('UPDATE job_notification_outbox_v2 SET state=?,payload=CASE WHEN ? THEN NULL ELSE payload END,next_at=?,error_code=? WHERE id=?').run(permanent?'FAILED':'QUEUED',permanent?1:0,clock()+backoff,Number.isInteger(error.code)?error.code:null,row.id);
            if(error.code===429)pausedUntil=clock()+backoff;
          }
        });
        if(clock()<pausedUntil)break;
      }
    }finally{sending=false;}
  };
  if(timer){service.notificationTimer=setInterval(()=>service.flushJobNotifications().catch(()=>{}),5000);service.notificationTimer.unref();}
}
