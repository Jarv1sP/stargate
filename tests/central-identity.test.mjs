import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {LoginSessions} from '../login-sessions.mjs';
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 const now=()=>1800000000000;
 db.exec(`CREATE TABLE account_metadata(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE identity_users(id TEXT PRIMARY KEY,epoch TEXT);CREATE TABLE identity_access(user_id TEXT,app_id TEXT,allowed INTEGER,expires REAL);CREATE TABLE identity_session_scopes(token_hash TEXT PRIMARY KEY,app_id TEXT,epoch TEXT);`);
 db.prepare('INSERT INTO account_metadata VALUES(?,?)').run('updated_at',String(now()));
 db.prepare('INSERT INTO identity_users VALUES(?,?)').run('member','version-1');
 for(const id of ['amax','mission'])db.prepare('INSERT INTO identity_access VALUES(?,?,1,NULL)').run('member',id);
 const user={id:'member',username:'member',role:'member',enabled:true};
 const amax=new LoginSessions(db,()=>user,{now,identityApp:'amax'}),mission=new LoginSessions(db,()=>user,{now,identityApp:'mission'});
 const issue=()=>amax.issue({userId:user.id,username:user.username,role:user.role});
 return {db,user,amax,mission,issue,now};
}
test('an application session cannot authenticate to another application',t=>{const f=fixture(t),token=f.issue();assert.equal(f.amax.principal(token).userId,'member');assert.throws(()=>f.mission.principal(token),e=>e.status===401);});
test('revocation, grant expiry and password changes invalidate existing sessions',t=>{
 const f=fixture(t),token=f.issue();f.db.exec("UPDATE identity_access SET allowed=0 WHERE app_id='amax'");assert.throws(()=>f.amax.principal(token),e=>e.status===403);
 f.db.exec("UPDATE identity_access SET allowed=1,expires=1 WHERE app_id='amax'");assert.throws(()=>f.amax.principal(token),e=>e.status===403);
 f.db.exec("UPDATE identity_access SET expires=NULL;UPDATE identity_users SET epoch='version-2'");assert.throws(()=>f.amax.principal(token),e=>e.status===401);
 const next=f.issue();f.user.enabled=false;assert.throws(()=>f.amax.principal(next),e=>e.status===403);
});
test('unavailable or invalid directory snapshots never permit a session',t=>{
 const f=fixture(t),token=f.issue();for(const value of [String(f.now()-60001),'NaN',String(f.now()+60000)]){
 f.db.prepare("UPDATE account_metadata SET value=? WHERE key='updated_at'").run(value);assert.throws(()=>f.amax.principal(token),e=>e.status===503);assert.throws(()=>f.issue(),e=>e.status===503);
 }
});
