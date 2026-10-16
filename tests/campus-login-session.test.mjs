import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';

async function fixture(t,{central=false}={}){
  const root=await mkdtemp(join(tmpdir(),'campus-login-')),database=join(root,'business.sqlite'),bootstrap=join(root,'bootstrap');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Synthetic-File-Login-Only-2026!'}));
  const bridge=async(machine,operation,args)=>{
    assert.equal(operation,'files.direct.prepare');
    return {available:true,grantId:args.uploadId??randomUUID(),ticket:randomBytes(32).toString('hex'),
      endpoint:'https://campus.invalid',certificateSha256:'a'.repeat(64),expiresAt:Date.now()/1000+300,
      chunkBytes:1024**2,file:{size:3}};
  };
  let service=await PortalService.open(database,bootstrap,undefined,bridge);
  clearInterval(service.executionTimer);
  t.after(async()=>{service.close();await rm(root,{recursive:true,force:true});});
  const user=service.accounts.byName('admin');
  if(central){
    service.accounts.db.exec(`CREATE TABLE identity_users(id TEXT PRIMARY KEY,epoch TEXT);
      CREATE TABLE identity_access(user_id TEXT,app_id TEXT,allowed INTEGER,expires REAL);
      CREATE TABLE identity_session_scopes(token_hash TEXT PRIMARY KEY,app_id TEXT,epoch TEXT);`);
    service.accounts.db.prepare('INSERT INTO account_metadata VALUES(?,?)').run('updated_at',String(Date.now()));
    service.accounts.db.prepare('INSERT INTO identity_users VALUES(?,?)').run(user.id,'version-1');
    service.accounts.db.prepare('INSERT INTO identity_access VALUES(?,?,1,NULL)').run(user.id,'amax');
    service.loginSessions.identityApp='amax';
  }
  const token=service.issueSession({userId:user.id,username:user.username,role:user.role});
  return {get service(){return service;},token,user,
    async grant(action){return (await service.invoke(token,'files.direct-ticket',{
      machine:MACHINES[0].id,project:'fixture',area:'code',path:'sample',action,
      ...(action==='put'?{uploadId:randomUUID(),totalSize:3}:{}),
    })).result;},
    async restart(){service.close();service=await PortalService.open(database,undefined,undefined,bridge);clearInterval(service.executionTimer);},
  };
}

for(const action of ['get','put']){
  test(`direct ${action} checks the separate login database and survives a portal restart`,async t=>{
    const f=await fixture(t),grant=await f.grant(action);
    assert.equal(f.service.db.prepare("SELECT 1 FROM sqlite_master WHERE name='login_sessions_v2'").get(),undefined);
    assert.equal(f.service.principal(f.token).userId,f.user.id);
    assert.deepEqual(f.service.checkFileTicket({ticket:grant.ticket}),{allowed:true,protocol:'campus-file'});
    await f.restart();
    assert.equal(f.service.checkFileTicket({ticket:grant.ticket}).allowed,true);
    f.service.revokeSession(f.token);
    assert.throws(()=>f.service.checkFileTicket({ticket:grant.ticket}),error=>error.status===401);
  });
}

for(const [label,change,status] of [
  ['expired login',db=>db.exec('UPDATE login_sessions_v2 SET expires_at=1'),401],
  ['disabled account',db=>db.exec('UPDATE accounts SET enabled=0'),403],
  ['changed role',db=>db.exec("UPDATE accounts SET role='member'"),403],
])test(`direct files reject ${label} even with a cached user profile`,async t=>{
  const f=await fixture(t),grant=await f.grant('get');
  change(f.service.accounts.db);
  assert.throws(()=>f.service.checkFileTicket({ticket:grant.ticket}),error=>error.status===status);
});

test('direct files use the same sliding login lifetime as control requests',async t=>{
  const f=await fixture(t),grant=await f.grant('put');
  f.service.accounts.db.prepare('UPDATE login_sessions_v2 SET touched_at=?,expires_at=?').run(Date.now()-7200000,Date.now()+60000);
  assert.equal(f.service.checkFileTicket({ticket:grant.ticket}).allowed,true);
  assert.ok(f.service.accounts.db.prepare('SELECT expires_at FROM login_sessions_v2').get().expires_at>Date.now()+86400000);
});

test('direct files accept a current central identity session',async t=>{
  const f=await fixture(t,{central:true}),grant=await f.grant('get');
  assert.equal(f.service.checkFileTicket({ticket:grant.ticket}).allowed,true);
});

for(const [label,change,status] of [
  ['application access revoked',db=>db.exec('UPDATE identity_access SET allowed=0'),403],
  ['application access expired',db=>db.exec('UPDATE identity_access SET expires=1'),403],
  ['password or global logout changed',db=>db.exec("UPDATE identity_users SET epoch='version-2'"),401],
  ['different application session',db=>db.exec("UPDATE identity_session_scopes SET app_id='mission'"),401],
  ['stale identity directory',db=>db.exec("UPDATE account_metadata SET value='1' WHERE key='updated_at'"),503],
])test(`direct files reject central identity with ${label}`,async t=>{
  const f=await fixture(t,{central:true}),grant=await f.grant('put');
  change(f.service.accounts.db);
  assert.throws(()=>f.service.checkFileTicket({ticket:grant.ticket}),error=>error.status===status);
});

test('unknown and expired file tickets and machine maintenance still stop direct files',async t=>{
  const f=await fixture(t),grant=await f.grant('get');
  assert.throws(()=>f.service.checkFileTicket({ticket:'unknown'}),error=>error.status===403);
  t.mock.method(f.service,'maintenanceFor',()=>({reason:'fixture'}));
  assert.throws(()=>f.service.checkFileTicket({ticket:grant.ticket}),error=>error.status===503);
  t.mock.restoreAll();
  for(const entry of f.service.fileTickets.values())entry.expiresAt=1;
  assert.throws(()=>f.service.checkFileTicket({ticket:grant.ticket}),error=>error.status===403);
});
