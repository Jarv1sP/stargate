import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {PortalService} from '../portal-service.mjs';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,createCipheriv,createHash} from 'node:crypto';
import {credential} from '../dist/service.js';
import {LoginSessions} from '../login-sessions.mjs';
import {TeamAccounts} from '../accounts/index.mjs';

const password='Shared-Test-Password-Only-2026';
function python(path,action,args={}){
  return new Promise((resolve,reject)=>{
    const script=`import sys,json\nsys.path.insert(0,sys.argv[1])\nfrom team_accounts import TeamAccounts\nx=json.load(sys.stdin); a=TeamAccounts(x['path'])\naction=x['action']; p=x['args']\nif action=='register': u,t=a.register(**p); print(json.dumps({'user':u,'token':t}))\nelif action=='login': u,t=a.login(**p); print(json.dumps({'user':u,'token':t}))\nelif action=='principal': print(json.dumps(a.principal(p['token'])))\nelif action=='logout': a.logout(p['token']); print('null')\nelif action=='backup':\n from team_accounts.backup import backup\n backup(x['path'],p['destination']); print('null')\n`;
    const child=spawn(process.env.PYTHON||'python3',['-c',script,fileURLToPath(new URL('../accounts',import.meta.url))]);
    let out='',error='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>error+=x);
    child.once('error',reject);child.once('close',code=>code?reject(Error(error)):resolve(JSON.parse(out)));
    child.stdin.end(JSON.stringify({path,action,args}));
  });
}
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'team-accounts-')),bootstrap=join(dir,'bootstrap'),accounts=join(dir,'shared.sqlite');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const portal=await PortalService.open(join(dir,'portal.sqlite'),bootstrap,undefined,undefined,undefined,accounts);
  clearInterval(portal.executionTimer);
  t.after(async()=>{portal.close();await rm(dir,{recursive:true,force:true});});
  return {portal,accounts};
}
test('Python registration and both login clients use one account, invite and session ledger',async t=>{
  const {portal,accounts}=await fixture(t),invite=portal.accounts.rotateInvite();
  const registered=await python(accounts,'register',{username:'alice',password,invite:invite.code});
  const login=await portal.login('alice',password);
  assert.equal(login.principal.userId,registered.user.id);
  assert.equal(portal.principal(registered.token).userId,registered.user.id);
  assert.equal((await python(accounts,'principal',{token:login.token})).id,registered.user.id);
  assert.equal(portal.accounts.invitations()[0].uses,1);
  await python(accounts,'logout',{token:login.token});
  assert.throws(()=>portal.principal(login.token),error=>error.status===401);
  await portal.accounts.reset(registered.user.id,password+'new');
  assert.equal(await python(accounts,'principal',{token:registered.token}),null);
  const fresh=await python(accounts,'login',{username:'alice',password:password+'new'});
  portal.accounts.change(registered.user.id,'enabled',false,'builtin-admin');
  assert.equal(await python(accounts,'principal',{token:fresh.token}),null);
});
test('two portal business stores share identities without copying passwords into either business state',async t=>{
  const {portal,accounts}=await fixture(t),secondPath=accounts+'.business';
  const second=await PortalService.open(secondPath,undefined,undefined,undefined,undefined,accounts);
  clearInterval(second.executionTimer);t.after(()=>second.close());
  const invite=portal.accounts.rotateInvite();
  await second.register({username:'bob',password,invite:invite.code});
  const login=await portal.login('bob',password);
  assert.equal(second.principal(login.token).username,'bob');
  for(const service of [portal,second]){
    const saved=JSON.parse(service.db.prepare('SELECT data FROM portal_state_v2 WHERE id=1').get().data);
    assert.equal(Object.hasOwn(saved,'credentials'),false);
    assert.ok(saved.users.every(user=>!Object.hasOwn(user,'username')&&!Object.hasOwn(user,'role')));
    assert.equal(service.db.prepare("SELECT 1 FROM sqlite_master WHERE name='login_sessions_v2'").get(),undefined);
  }
});
test('one remaining invite use cannot be consumed twice across Node and Python',async t=>{
  const {portal,accounts}=await fixture(t),invite=portal.accounts.rotateInvite();
  portal.accounts.db.prepare('UPDATE account_invites SET max_uses=1').run();
  const results=await Promise.allSettled([
    portal.register({username:'node-member',password,invite:invite.code}),
    python(accounts,'register',{username:'python-member',password,invite:invite.code}),
  ]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(portal.accounts.invitations()[0].uses,1);
  assert.equal(portal.accounts.list().length,2);
});
test('both clients apply the same Unicode password policy and UTF-8 hashing',async t=>{
  const {portal,accounts}=await fixture(t),invite=portal.accounts.rotateInvite();
  await assert.rejects(portal.register({username:'short-node',password:'🔒'.repeat(4),invite:invite.code}),/密码/);
  await assert.rejects(python(accounts,'register',{username:'short-python',password:'🔒'.repeat(4),invite:invite.code}),/密码/);
  await portal.register({username:'unicode',password:'🔒'.repeat(8),invite:invite.code});
  assert.equal((await python(accounts,'login',{username:'unicode',password:'🔒'.repeat(8)})).user.username,'unicode');
});
test('logout in the other application cancels an administrative write still awaiting password work',async t=>{
  const {portal,accounts}=await fixture(t),admin=await portal.login('admin',password);
  let started,release;const ready=new Promise(resolve=>started=resolve),held=new Promise(resolve=>release=resolve);
  const create=portal.accounts.create.bind(portal.accounts);
  portal.accounts.create=async(...args)=>{started();await held;return create(...args);};
  const pending=portal.invoke(admin.token,'users.create',{username:'not-created',password});
  const denied=assert.rejects(pending,error=>error.status===401);
  await ready;await python(accounts,'logout',{token:admin.token});release();await denied;
  assert.equal(portal.accounts.byName('not-created'),null);
});
test('online account backup restores passwords and the paired encrypted invitation key',async t=>{
  const {portal,accounts}=await fixture(t),invite=portal.accounts.rotateInvite(),destination=accounts+'.backup';
  await python(accounts,'backup',{destination});
  const restored=new TeamAccounts(join(destination,'shared.sqlite'));t.after(()=>restored.close());
  assert.equal(restored.currentInvite(),invite.code);
  assert.equal((await restored.authenticate('admin',password)).id,'builtin-admin');
});
test('legacy extraction retains the exact user IDs, password records, invitation and CLI sessions across restart',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'team-legacy-')),path=join(dir,'portal.sqlite'),shared=join(dir,'accounts.sqlite');
  const record=await credential(password,600000),key=randomBytes(32),code='Synthetic-Legacy-Team-Invite';
  await writeFile(path+'.invite-key',key);
  const user={id:'existing-team-123',username:'alice',name:'Alice',enabled:true,role:'member',limits:{'gpu-1':1},total:1,policyVersion:3};
  const old=new DatabaseSync(path);
  old.exec('CREATE TABLE portal_state_v2(id INTEGER PRIMARY KEY,data TEXT); CREATE TABLE invites_v2(role TEXT PRIMARY KEY,digest TEXT UNIQUE,enabled INTEGER,uses INTEGER,max_uses INTEGER,created_at TEXT,code_cipher TEXT)');
  old.prepare('INSERT INTO portal_state_v2 VALUES(1,?)').run(JSON.stringify({schema:1,users:[user],jobs:[],sequence:0,credentials:[['alice',{salt:Buffer.from(record.salt).toString('base64'),hash:Buffer.from(record.hash).toString('base64'),iterations:600000}]]}));
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from('amax-invite-v1'));
  const bytes=Buffer.concat([cipher.update(code,'utf8'),cipher.final()]),sealed=Buffer.concat([nonce,cipher.getAuthTag(),bytes]).toString('base64');
  old.prepare('INSERT INTO invites_v2 VALUES(?,?,1,7,NULL,?,?)').run('member',createHash('sha256').update(code).digest('hex'),'fixture',sealed);
  const token=new LoginSessions(old,()=>user).issue({userId:user.id,username:'alice',role:'member'});old.close();
  let service=await PortalService.open(path,undefined,undefined,undefined,undefined,shared);clearInterval(service.executionTimer);
  t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});
  assert.equal(service.principal(token).userId,user.id);
  assert.equal(service.accounts.currentInvite(),code);assert.equal(service.accounts.invitations()[0].uses,7);
  assert.equal((await service.login('alice',password)).principal.userId,user.id);
  assert.deepEqual(service.store.users[0].limits,user.limits);
  service.close();service=await PortalService.open(path,undefined,undefined,undefined,undefined,shared);clearInterval(service.executionTimer);
  assert.equal(service.principal(token).userId,user.id);
  assert.equal(service.accounts.list().length,1);
  assert.equal(Object.hasOwn(JSON.parse(service.db.prepare('SELECT data FROM portal_state_v2 WHERE id=1').get().data),'credentials'),false);
});
