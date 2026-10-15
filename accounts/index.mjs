import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,readFileSync,writeFileSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash,randomBytes,randomUUID,pbkdf2,timingSafeEqual,createCipheriv,createDecipheriv} from 'node:crypto';
import {promisify} from 'node:util';
import {LoginSessions} from '../login-sessions.mjs';

const derive=promisify(pbkdf2),iterations=600000;
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const digest=value=>createHash('sha256').update(value).digest('hex');
const publicUser=row=>row?{id:row.id,username:row.username,name:row.name,role:row.role,enabled:!!row.enabled}:null;
const validUsername=value=>typeof value==='string'&&/^[a-z\u3400-\u9fff][a-z0-9_\u3400-\u9fff-]{1,23}$/u.test(value);
const name=value=>{value=String(value??'').trim();if(!value||[...value].length>40)fail('姓名需为 1–40 个字符。');return value;};
async function credential(password){
  if(typeof password!=='string'||[...password].length<8||[...password].length>128)fail('密码需为 8–128 个字符。');
  const salt=randomBytes(16);return {salt,hash:await derive(password,salt,iterations,32,'sha256'),iterations};
}

// Both applications use this independent database. It contains no platform jobs,
// files, quotas, tasks or medals, and never calls either application's API.
export class TeamAccounts{
  constructor(path){
    mkdirSync(dirname(path),{recursive:true,mode:0o770});
    this.db=new DatabaseSync(path);chmodSync(path,0o660);
    this.db.exec(readFileSync(new URL('./team_accounts/schema.sql',import.meta.url),'utf8'));
    const keyPath=path+'.key';
    try{this.key=readFileSync(keyPath);}catch(error){
      if(error.code!=='ENOENT')throw error;
      if(this.db.prepare('SELECT 1 FROM account_invites WHERE code_cipher IS NOT NULL LIMIT 1').get())fail('账号库的邀请码密钥缺失，请恢复配套密钥备份。');
      try{writeFileSync(keyPath,randomBytes(32),{flag:'wx',mode:0o660});}catch(writeError){if(writeError.code!=='EEXIST')throw writeError;}
      this.key=readFileSync(keyPath);
    }
    chmodSync(keyPath,0o660);
    if(this.key.length!==32)fail('账号库的邀请码密钥损坏，请恢复配套密钥备份。');
    this.sessions=new LoginSessions(this.db,id=>this.get(id));
  }
  transaction(run){this.db.exec('BEGIN IMMEDIATE');try{const result=run();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  list(){return this.db.prepare('SELECT id,username,name,role,enabled FROM accounts ORDER BY rowid').all().map(publicUser);}
  get(id){return publicUser(this.db.prepare('SELECT * FROM accounts WHERE id=?').get(id));}
  byName(username){return publicUser(this.db.prepare('SELECT * FROM accounts WHERE username=?').get(username));}
  insert(user,record){
    this.db.prepare('INSERT INTO accounts VALUES(?,?,?,?,?,?,?,?)').run(user.id,user.username,user.name,user.role||'member',Number(user.enabled),record.salt,record.hash,record.iterations||210000);
    return this.get(user.id);
  }
  // One-time extraction preserves all existing platform-user IDs, passwords and sessions.
  // Once extracted, the business database no longer saves authentication data.
  importLegacy({users,credentials,sessions=[],invite,inviteCode}){
    if(this.db.prepare("SELECT 1 FROM account_metadata WHERE key='initialized'").get())return;
    this.transaction(()=>{
      if(this.db.prepare("SELECT 1 FROM account_metadata WHERE key='initialized'").get())return;
      if(this.list().length)fail('公共账号库已有用户，请先完成账号迁移。');
      for(const user of users){const record=credentials.get(user.username);if(!record)fail('账号缺少密码记录，请恢复账号备份。');this.insert(user,record);}
      for(const row of sessions)this.db.prepare('INSERT INTO login_sessions_v2 VALUES(?,?,?,?,?,?,?)').run(row.token_hash,row.user_id,row.username,row.role,row.created_at,row.touched_at,row.expires_at);
      if(invite)this.db.prepare('INSERT INTO account_invites VALUES(?,?,?,?,?,?,?)').run('member',invite.digest,invite.enabled,invite.uses,invite.max_uses,invite.created_at,inviteCode?this.seal(inviteCode):null);
      this.db.prepare('INSERT INTO account_metadata VALUES(?,?)').run('initialized',new Date().toISOString());
    });
  }
  seal(code){const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,nonce);cipher.setAAD(Buffer.from('team-invite-v1'));const data=Buffer.concat([cipher.update(code,'utf8'),cipher.final()]);return Buffer.concat([nonce,cipher.getAuthTag(),data]).toString('base64');}
  currentInvite(){const row=this.db.prepare("SELECT enabled,code_cipher FROM account_invites WHERE role='member'").get();if(!row?.enabled||!row.code_cipher)return null;const data=Buffer.from(row.code_cipher,'base64'),decipher=createDecipheriv('aes-256-gcm',this.key,data.subarray(0,12));decipher.setAAD(Buffer.from('team-invite-v1'));decipher.setAuthTag(data.subarray(12,28));return Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString('utf8');}
  invitations(){const row=this.db.prepare("SELECT * FROM account_invites WHERE role='member'").get();return [{role:'member',enabled:!!row?.enabled,uses:row?.uses||0,maxUses:row?.max_uses??null,createdAt:row?.created_at??null,available:!!row?.enabled&&(row.max_uses===null||row.uses<row.max_uses)}];}
  rotateInvite(){const code='TEAM-'+randomBytes(24).toString('base64url');this.db.prepare("INSERT INTO account_invites VALUES('member',?,1,0,NULL,?,?) ON CONFLICT(role) DO UPDATE SET digest=excluded.digest,enabled=1,uses=0,max_uses=NULL,created_at=excluded.created_at,code_cipher=excluded.code_cipher").run(digest(code),new Date().toISOString(),this.seal(code));return {role:'member',code,invitations:this.invitations()};}
  disableInvite(){this.db.prepare("UPDATE account_invites SET enabled=0 WHERE role='member'").run();return {role:'member',disabled:true,invitations:this.invitations()};}
  async create({username,name:display,role='member',password},invite,authorize=()=>{}){
    username=String(username??'').trim();
    if(!validUsername(username))fail('用户名须为 2–24 位，使用汉字或小写字母开头，可含数字、下划线和短横线。');
    if(!['admin','member'].includes(role))fail('角色无效。');
    const record=await credential(password),user={id:randomUUID(),username,name:name(display??username),role,enabled:true};
    return this.transaction(()=>{
      authorize();
      if(this.byName(username))fail('这个用户名已存在，请换一个。');
      if(invite!==undefined){
        if(typeof invite!=='string'||invite.length>128)fail('邀请码无效、已停用或已用完。',403);
        const update=this.db.prepare("UPDATE account_invites SET uses=uses+1 WHERE role='member' AND digest=? AND enabled=1 AND (max_uses IS NULL OR uses<max_uses)").run(digest(invite.trim()));
        if(update.changes!==1)fail('邀请码无效、已停用或已用完。',403);
        user.role='member';
      }
      return this.insert(user,record);
    });
  }
  async authenticate(username,password,issueSession=false){
    username=String(username??'').trim();
    if(typeof password!=='string'||[...password].length>128||username.length>24)fail('用户名或密码错误。',401);
    const failed=this.db.prepare('SELECT * FROM account_failures WHERE username=?').get(username);
    if(failed?.attempts>=5&&failed.until_ms>Date.now())fail('尝试次数过多，请一分钟后重试。',429);
    const row=this.db.prepare('SELECT * FROM accounts WHERE username=?').get(username);
    const actual=await derive(password,row?.salt||Buffer.alloc(16),row?.iterations||iterations,32,'sha256');
    if(!row||!timingSafeEqual(actual,Buffer.from(row.password_hash))){
      this.db.prepare('INSERT INTO account_failures VALUES(?,1,?) ON CONFLICT(username) DO UPDATE SET attempts=CASE WHEN until_ms>? THEN attempts+1 ELSE 1 END,until_ms=CASE WHEN until_ms>? THEN until_ms ELSE excluded.until_ms END').run(username,Date.now()+60000,Date.now(),Date.now());
      fail('用户名或密码错误。',401);
    }
    return this.transaction(()=>{
      const current=this.db.prepare('SELECT * FROM accounts WHERE id=?').get(row.id);
      if(!current?.enabled)fail('账号已暂停，请联系管理员。',403);
      if(!Buffer.from(current.password_hash).equals(Buffer.from(row.password_hash)))fail('密码已改变，请重新登录。',403);
      this.db.prepare('DELETE FROM account_failures WHERE username=? OR until_ms<=?').run(username,Date.now());
      const user=publicUser(current);
      return issueSession?{user,token:this.sessions.issue({userId:user.id,username:user.username,role:user.role})}:user;
    });
  }
  rename(id,value){this.db.prepare('UPDATE accounts SET name=? WHERE id=?').run(name(value),id);return this.get(id);}
  async reset(id,password,authorize=()=>{}){const record=await credential(password);this.transaction(()=>{authorize();const user=this.get(id);if(!user)fail('用户不存在。');this.db.prepare('UPDATE accounts SET salt=?,password_hash=?,iterations=? WHERE id=?').run(record.salt,record.hash,record.iterations,id);this.sessions.invalidate(user.username);this.db.prepare('DELETE FROM account_failures WHERE username=?').run(user.username);});return {userId:id,reset:true};}
  change(id,field,value,actor){
    if(!['role','enabled','delete'].includes(field))fail('未知账号操作。');
    return this.transaction(()=>{
      const user=this.get(id);if(!user)fail('用户不存在。');
      if(field==='role'&&!['admin','member'].includes(value)||field==='enabled'&&typeof value!=='boolean')fail('账号设置无效。');
      if(id===actor&&(field==='role'||field==='delete'||field==='enabled'&&!value))fail('请使用其他管理员账号修改自己的权限。');
      if(user.role==='admin'&&user.enabled&&(field==='delete'||field==='role'&&value!=='admin'||field==='enabled'&&!value)&&!this.list().some(other=>other.id!==id&&other.enabled&&other.role==='admin'))fail('至少要留一个可以登录的管理员。');
      this.sessions.invalidate(user.username);
      if(field==='delete')this.db.prepare('DELETE FROM accounts WHERE id=?').run(id);
      else this.db.prepare(`UPDATE accounts SET ${field}=? WHERE id=?`).run(field==='enabled'?Number(value):value,id);
      return field==='delete'?{deleted:true}:this.get(id);
    });
  }
  close(){this.db.close();}
}
