import {JOB_TERMINAL} from './dist/job-progress.js';
import {occupiesGpu} from './dist/gpu-allocation.js';

export const JOB_HISTORY_DAYS=30,JOB_TRASH_DAYS=7;
const DAY=86400000;
export const liveJob=job=>!JOB_TERMINAL.has(job.state)||occupiesGpu(job);
const columns=`id,request_key,user_id,owner_id,machine,project,name,cards,node_job_id,state,
 created_at,finished_at,finished_ms,live,retain_until,trashed_at,data`;
const terminal="'SUCCEEDED','FAILED','CANCELED'";
const lookupKey=value=>typeof value==='string'?value:null;
const references='ordinal,'+columns.split(',').filter(name=>name.trim()!=='data').join(',')+',data IS NULL AS expired';
const expired=()=>Object.assign(Error('任务详细记录已按保留期限清理；训练输出未删除。'),{status:410,code:'JOB_HISTORY_EXPIRED'});

// Only live jobs are held by the scheduler. History and original submission
// keys stay in SQLite; a point read never fills a second unbounded cache.
export class PortalJobs{
  constructor(db,live=()=>[]){
    this.db=db;this.live=live;
    db.exec(`CREATE TABLE IF NOT EXISTS portal_jobs(
      ordinal INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,request_key TEXT,
      user_id TEXT,owner_id TEXT,machine TEXT,project TEXT,name TEXT,cards INTEGER,node_job_id TEXT,
      state TEXT NOT NULL,created_at TEXT,finished_at TEXT,finished_ms INTEGER,live INTEGER NOT NULL,
      retain_until INTEGER,trashed_at INTEGER,data TEXT);
      CREATE INDEX IF NOT EXISTS portal_jobs_history ON portal_jobs(live,trashed_at,finished_ms DESC,ordinal DESC);
      CREATE INDEX IF NOT EXISTS portal_jobs_native ON portal_jobs(machine,node_job_id);
      CREATE INDEX IF NOT EXISTS portal_jobs_key ON portal_jobs(request_key);
      CREATE INDEX IF NOT EXISTS portal_jobs_retention ON portal_jobs(live,retain_until);`);
    this.write=db.prepare(`INSERT INTO portal_jobs(${columns}) VALUES(${Array(17).fill('?').join(',')})
      ON CONFLICT(id) DO UPDATE SET request_key=excluded.request_key,user_id=excluded.user_id,
      owner_id=excluded.owner_id,machine=excluded.machine,project=excluded.project,name=excluded.name,
      cards=excluded.cards,node_job_id=excluded.node_job_id,state=excluded.state,
      created_at=excluded.created_at,finished_at=excluded.finished_at,finished_ms=excluded.finished_ms,
      live=excluded.live,retain_until=CASE WHEN excluded.live=1 THEN NULL WHEN portal_jobs.live=1
        THEN excluded.retain_until ELSE COALESCE(portal_jobs.retain_until,excluded.retain_until) END,
      trashed_at=CASE WHEN excluded.live=1 THEN NULL ELSE portal_jobs.trashed_at END,data=excluded.data`);
  }
  migrateRows(now){
    // JSON extraction is inside SQLite: never materialize the old monolithic
    // history in JavaScript, including during the first production startup.
    this.db.prepare(`INSERT INTO portal_jobs(ordinal,${columns})
        SELECT CAST(j.key AS INTEGER)+1,json_extract(j.value,'$.id'),json_extract(j.value,'$.key'),
          json_extract(j.value,'$.userId'),COALESCE(json_extract(j.value,'$.ownerId'),json_extract(j.value,'$.userId')),
          json_extract(j.value,'$.machine'),COALESCE(json_extract(j.value,'$.project'),json_extract(j.value,'$.spec.project')),
          COALESCE(json_extract(j.value,'$.nativeTaskDisplay.name'),json_extract(j.value,'$.name')),
          json_extract(j.value,'$.cards'),json_extract(j.value,'$.nodeJobId'),COALESCE(json_extract(j.value,'$.state'),'UNKNOWN'),
          json_extract(j.value,'$.createdAt'),COALESCE(json_extract(j.value,'$.finishedAt'),json_extract(j.value,'$.terminalObservedAt')),
          CAST(unixepoch(COALESCE(json_extract(j.value,'$.finishedAt'),json_extract(j.value,'$.terminalObservedAt')),'subsec')*1000 AS INTEGER),
          CASE WHEN COALESCE(json_extract(j.value,'$.state'),'UNKNOWN') NOT IN (${terminal}) OR
            (json_extract(j.value,'$.latestAttempt.state')='DRAINING' AND json_extract(j.value,'$.latestAttempt.finishedAt') IS NULL) THEN 1 ELSE 0 END,
          COALESCE(CAST(unixepoch(COALESCE(json_extract(j.value,'$.finishedAt'),json_extract(j.value,'$.terminalObservedAt')),'subsec')*1000 AS INTEGER),?)+?,
          NULL,j.value FROM portal_state_v2 p,json_each(p.data,'$.jobs') j WHERE p.id=1`).run(now,JOB_HISTORY_DAYS*DAY);
  }
  loadLive(){return this.db.prepare('SELECT data FROM portal_jobs WHERE live=1 ORDER BY ordinal').all().map(row=>JSON.parse(row.data));}
  put(job,now=Date.now()){
    const active=liveJob(job),finishedAt=job.finishedAt??job.terminalObservedAt??null,parsed=Date.parse(finishedAt);
    const finished=Number.isFinite(parsed)?parsed:null;
    this.write.run(job.id,job.key??null,job.userId??null,job.ownerId??job.userId??null,job.machine??null,
      job.project??job.spec?.project??null,job.nativeTaskDisplay?.name??job.name??null,job.cards??null,
      job.nodeJobId??null,job.state??'UNKNOWN',job.createdAt??null,finishedAt,finished,active?1:0,
      active?null:(finished??now)+JOB_HISTORY_DAYS*DAY,null,JSON.stringify(job));
  }
  get(id){
    const active=this.live().find(job=>job.id===id);if(active)return active;
    const row=this.db.prepare('SELECT data FROM portal_jobs WHERE id=?').get(lookupKey(id));
    return row?.data?JSON.parse(row.data):undefined;
  }
  byKey(key){
    const row=this.db.prepare('SELECT * FROM portal_jobs WHERE request_key=? ORDER BY ordinal LIMIT 1').get(lookupKey(key));
    return row?this.live().find(job=>job.id===row.id)??(row.data?JSON.parse(row.data):this.reference(row)):undefined;
  }
  *matchingKey(key){
    for(const row of this.db.prepare('SELECT * FROM portal_jobs WHERE request_key=? ORDER BY ordinal').iterate(lookupKey(key)))
      yield this.live().find(job=>job.id===row.id)??(row.data?JSON.parse(row.data):this.reference(row));
  }
  byNative(machine,id){
    const row=this.db.prepare('SELECT id,data FROM portal_jobs WHERE machine=? AND node_job_id=? ORDER BY ordinal LIMIT 1').get(lookupKey(machine),lookupKey(id));
    return row?this.live().find(job=>job.id===row.id)??(row.data?JSON.parse(row.data):undefined):undefined;
  }
  reference(row){
    return {id:row.id,key:row.request_key,userId:row.user_id,ownerId:row.owner_id,machine:row.machine,
      project:row.project,name:row.name,cards:row.cards,nodeJobId:row.node_job_id,state:row.state,
      createdAt:row.created_at,finishedAt:row.finished_at,historyExpired:row.expired===1||row.data===null,
      ...(row.trashed_at!==null?{historyTrashedAt:new Date(row.trashed_at).toISOString(),
        historyPurgeAt:new Date(row.trashed_at+JOB_TRASH_DAYS*DAY).toISOString()}:{}),ordinal:row.ordinal};
  }
  locator(id){
    const active=this.live().find(job=>job.id===id);if(active)return active;
    const row=this.db.prepare('SELECT '+references+' FROM portal_jobs WHERE id=?').get(lookupKey(id));
    return row?this.reference(row):undefined;
  }
  scope(machines){return {sql:`(machine IS NULL OR machine IN (${machines.map(()=>'?').join(',')||'NULL'}))`,args:machines};}
  historyCount(machines){const s=this.scope(machines);return this.db.prepare(`SELECT count(*) n FROM portal_jobs WHERE live=0 AND trashed_at IS NULL AND data IS NOT NULL AND ${s.sql}`).get(...s.args).n;}
  ordered(ids){return ids.length?this.db.prepare(`SELECT id FROM portal_jobs WHERE id IN (${ids.map(()=>'?').join(',')}) ORDER BY ordinal`).all(...ids).map(row=>row.id):[];}
  *history(machines){
    const s=this.scope(machines);
    for(const row of this.db.prepare(`SELECT data FROM portal_jobs WHERE live=0 AND trashed_at IS NULL AND data IS NOT NULL AND ${s.sql} ORDER BY finished_ms DESC,ordinal DESC`).iterate(...s.args))yield JSON.parse(row.data);
  }
  trash(machines,{before=null,limit=50}={}){
    const s=this.scope(machines);
    const rows=this.db.prepare(`SELECT ${references} FROM portal_jobs WHERE trashed_at IS NOT NULL AND data IS NOT NULL AND ${s.sql}
      ${before===null?'':'AND ordinal<?'} ORDER BY ordinal DESC LIMIT ?`).all(...s.args,...(before===null?[]:[before]),limit+1);
    const more=rows.length>limit;rows.length=Math.min(rows.length,limit);
    return {jobs:rows.map(row=>this.reference(row)),nextCursor:more?String(rows.at(-1).ordinal):null};
  }
  restore(id,now=Date.now()){
    const job=this.get(id);if(!job)throw expired();
    this.db.prepare('UPDATE portal_jobs SET trashed_at=NULL,retain_until=? WHERE id=? AND trashed_at IS NOT NULL AND data IS NOT NULL').run(now+JOB_HISTORY_DAYS*DAY,id);
    return job;
  }
  collect(now=Date.now()){
    const trashed=this.db.prepare('UPDATE portal_jobs SET trashed_at=? WHERE live=0 AND data IS NOT NULL AND trashed_at IS NULL AND retain_until<=?').run(now,now).changes;
    // Keep only small lookup fields for output paths, dependency outcomes and
    // original-key deduplication. No command or full history survives expiry.
    const purged=this.db.prepare('UPDATE portal_jobs SET data=NULL WHERE data IS NOT NULL AND trashed_at<=? AND live=0').run(now-JOB_TRASH_DAYS*DAY).changes;
    return {trashed,purged};
  }
}
