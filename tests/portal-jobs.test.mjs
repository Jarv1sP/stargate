import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import test from 'node:test';
import {PortalJobs,liveJob} from '../portal-jobs.mjs';
import {migratePortalState} from '../portal-service.mjs';
import {openStorage} from '../portal-storage.mjs';

const DAY=86400000,NOW=Date.parse('2026-06-01T00:00:00Z');
const job=(id,state='SUCCEEDED',age=1)=>({id,key:'key-'+id,userId:'user',ownerId:'owner',machine:'gpu-1',
  project:'fixture',name:'task '+id,cards:1,nodeJobId:'native-'+id,state,createdAt:new Date(NOW-60*DAY).toISOString(),
  finishedAt:new Date(NOW-age*DAY).toISOString(),spec:{project:'fixture',argv:['python','train.py','秘密参数 '+id]}});
function fixture(t,jobs=[]){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec('CREATE TABLE portal_state_v2(id INTEGER PRIMARY KEY,data TEXT NOT NULL)');
  const header={schema:2,users:[{id:'user'}],sequence:42,jobs};
  db.prepare('INSERT INTO portal_state_v2 VALUES(1,?)').run(JSON.stringify(header));
  const live=[],rows=new PortalJobs(db,()=>live),service={db,jobRows:rows};openStorage(service);
  return {db,rows,live,header,migrate:now=>migratePortalState(service,now)};
}
test('migration preserves every payload, original key and order without parsing the old JSON in JS',t=>{
  const data=[job('a','RUNNING'),job('b'),job('c','PENDING')];data[1].futureField={keep:['unchanged']};
  const {db,rows,live,migrate}=fixture(t,data),parse=JSON.parse;
  try{JSON.parse=()=>{throw Error('whole history parsed in JS');};migrate(NOW);}finally{JSON.parse=parse;}
  assert.deepEqual(JSON.parse(db.prepare('SELECT data FROM portal_state_v2').get().data),{schema:3,users:[{id:'user'}],sequence:42});
  assert.deepEqual(rows.loadLive().map(j=>j.id),['a','c']);live.push(...rows.loadLive());
  assert.equal(rows.get('a'),live[0]);assert.deepEqual(rows.get('b'),data[1]);assert.equal(live.length,2);
  assert.deepEqual(rows.byKey('key-b'),data[1]);assert.deepEqual(rows.byNative('gpu-1','native-b'),data[1]);
  migrate(NOW);rows.put(job('d','RUNNING'),NOW);
  assert.deepEqual(db.prepare('SELECT id FROM portal_jobs ORDER BY ordinal').all().map(r=>r.id),['a','b','c','d']);
});
test('failed migration rolls back job rows and keeps the original state intact',t=>{
  const {db,rows,header,migrate}=fixture(t,[job('a'),job('a')]);
  assert.throws(()=>migrate(NOW),/UNIQUE/);
  assert.equal(db.prepare('SELECT count(*) n FROM portal_jobs').get().n,0);
  assert.deepEqual(JSON.parse(db.prepare('SELECT data FROM portal_state_v2').get().data),header);
  assert.equal(db.isTransaction,false);
});
test('storage conversion failure also rolls back jobs and the shared old header',t=>{
  const {db,rows,migrate}=fixture(t,[job('history')]);
  const state=JSON.parse(db.prepare('SELECT data FROM portal_state_v2').get().data);
  state.storage={'gpu-1':{checkedAt:new Date(NOW).toISOString(),datasets:{datasets:[]}}};
  db.prepare('UPDATE portal_state_v2 SET data=?').run(JSON.stringify(state));
  db.exec("CREATE TRIGGER fail_storage BEFORE INSERT ON portal_storage BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  assert.throws(()=>migrate(NOW),/fixture failure/);
  assert.deepEqual(JSON.parse(db.prepare('SELECT data FROM portal_state_v2').get().data),state);
  assert.equal(db.prepare('SELECT count(*) n FROM portal_jobs').get().n,0);assert.equal(rows.get('history'),undefined);
});
test('point update does not rewrite other history or fill a history cache',t=>{
  const {db,rows,live,migrate}=fixture(t,[job('history'),job('active','RUNNING')]);migrate(NOW);
  live.push(...rows.loadLive());db.exec("CREATE TRIGGER no_history_update BEFORE UPDATE ON portal_jobs WHEN OLD.id='history' BEGIN SELECT RAISE(ABORT,'history rewritten'); END");
  const active=rows.get('active');active.progress={epoch:2};rows.put(active,NOW);
  assert.deepEqual(JSON.parse(db.prepare("SELECT data FROM portal_jobs WHERE id='active'").get().data).progress,{epoch:2});
  for(let i=0;i<20;i++)assert.equal(rows.get('history').id,'history');
  assert.equal(live.length,1);assert.equal(rows.historyCount(['gpu-1']),1);
});
test('only ended records older than thirty days enter a seven-day record trash',t=>{
  const old=job('old','SUCCEEDED',31),recent=job('recent','FAILED',29),running=job('running','RUNNING',100);
  const draining={...job('draining','CANCELED',100),latestAttempt:{state:'DRAINING',finishedAt:null}};
  const unknown=job('unknown','UNKNOWN',100),missingTime=job('missing');delete missingTime.finishedAt;
  const {rows,migrate}=fixture(t,[old,recent,running,draining,unknown,missingTime]);migrate(NOW);
  assert.ok(liveJob(draining));assert.ok(liveJob(unknown));
  assert.deepEqual(rows.collect(NOW),{trashed:1,purged:0});
  assert.deepEqual(rows.trash(['gpu-1']).jobs.map(j=>j.id),['old']);
  assert.equal(rows.trash(['gpu-2']).jobs.length,0);
  assert.deepEqual(rows.get('old'),old);assert.equal(rows.historyCount(['gpu-1']),2);
  // The previously recent record is now over thirty days; the original trash
  // record still has almost one millisecond of its recovery window left.
  assert.deepEqual(rows.collect(NOW+7*DAY-1),{trashed:1,purged:0});
});
test('restore changes only retention, is retry-safe and never requeues a job',t=>{
  const original=job('old','SUCCEEDED',31),{db,rows,migrate}=fixture(t,[original]);migrate(NOW);rows.collect(NOW);
  assert.deepEqual(rows.restore('old',NOW+DAY),original);
  const until=db.prepare('SELECT retain_until FROM portal_jobs').get().retain_until;
  rows.restore('old',NOW+2*DAY);assert.equal(db.prepare('SELECT retain_until FROM portal_jobs').get().retain_until,until);
  assert.equal(rows.trash(['gpu-1']).jobs.length,0);assert.equal(rows.historyCount(['gpu-1']),1);
  assert.deepEqual(rows.loadLive(),[]);assert.deepEqual(rows.collect(NOW+3*DAY),{trashed:0,purged:0});
});
test('purge removes detail but preserves original-key, dependency and output references',t=>{
  const original=job('old','SUCCEEDED',31),{db,rows,migrate}=fixture(t,[original]);migrate(NOW);rows.collect(NOW);
  assert.deepEqual(rows.collect(NOW+7*DAY),{trashed:0,purged:1});
  assert.equal(rows.get('old'),undefined);assert.equal(db.prepare('SELECT data FROM portal_jobs').get().data,null);
  const ref=rows.locator('old');assert.equal(ref.state,'SUCCEEDED');assert.equal(ref.nodeJobId,'native-old');
  assert.equal(ref.project,'fixture');assert.equal(ref.ownerId,'owner');assert.equal(ref.historyExpired,true);
  assert.equal(rows.byKey('key-old').id,'old');assert.equal(rows.historyCount(['gpu-1']),0);
  assert.equal(JSON.stringify(ref).includes('秘密参数'),false);
  assert.throws(()=>rows.restore('old',NOW+8*DAY),e=>e.code==='JOB_HISTORY_EXPIRED');
  assert.deepEqual(rows.collect(NOW+8*DAY),{trashed:0,purged:0});
});
