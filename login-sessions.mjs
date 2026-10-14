import {SHA256} from './portal-request-validation.mjs';
import {createHash,randomBytes} from 'node:crypto';

// The cookie is a credential cache, not the authorization lifetime.
// SQLite enforces the shorter sliding idle deadline for BOTH clients.
export const LOGIN_POLICY=Object.freeze({
  idleMs:30*86400_000,touchMs:3600_000,cookieSeconds:365*86400,
  perUser:128,total:100000,
});
const denied=(message='请先登录，或重新登录。',status=401)=>{throw Object.assign(Error(message),{status});};
const tokenHash=token=>typeof token==='string'&&SHA256.test(token)?createHash('sha256').update(token).digest('hex'):null;

export class LoginSessions{
  constructor(db,userById,{now=()=>Date.now(),initialPrune=true}={}){
    this.db=db;this.userById=userById;this.now=now;
    db.exec(`CREATE TABLE IF NOT EXISTS login_sessions_v2(
      token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,username TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','member')),created_at INTEGER NOT NULL,
      touched_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS login_sessions_v2_owner ON login_sessions_v2(user_id);
      CREATE INDEX IF NOT EXISTS login_sessions_v2_expiry ON login_sessions_v2(expires_at);`);
    // A globally held startup keeps the exact durable ledger. Authentication
    // still checks expiry/role/owner before renewal, and issue still prunes.
    if(initialPrune!==false)this.prune();
  }
  prune(){this.db.prepare('DELETE FROM login_sessions_v2 WHERE expires_at<=?').run(this.now());}
  issue(principal){
    this.prune();
    if(this.db.prepare('SELECT count(*) n FROM login_sessions_v2 WHERE user_id=?').get(principal.userId).n>=LOGIN_POLICY.perUser||
       this.db.prepare('SELECT count(*) n FROM login_sessions_v2').get().n>=LOGIN_POLICY.total)
      denied('登录会话过多，请退出旧设备或联系管理员。',429);
    const token=randomBytes(32).toString('hex'),time=this.now();
    this.db.prepare('INSERT INTO login_sessions_v2 VALUES(?,?,?,?,?,?,?)').run(
      tokenHash(token),principal.userId,principal.username,principal.role,time,time,time+LOGIN_POLICY.idleMs);
    return token;
  }
  principal(token){
    const hash=tokenHash(token),time=this.now();
    const row=hash?this.db.prepare('SELECT * FROM login_sessions_v2 WHERE token_hash=?').get(hash):null;
    if(!row||row.expires_at<=time){if(row)this.revoke(token);denied();}
    const user=this.userById(row.user_id);
    if(!user?.enabled||user.username!==row.username||(user.role||'member')!==row.role){
      this.revoke(token);denied('账号权限已改变，请重新登录。',403);
    }
    let expires=row.expires_at;
    // Check expiry BEFORE renewal. Avoid a disk write on every keystroke/poll.
    if(time-row.touched_at>=LOGIN_POLICY.touchMs){
      expires=time+LOGIN_POLICY.idleMs;
      this.db.prepare('UPDATE login_sessions_v2 SET touched_at=?,expires_at=? WHERE token_hash=?').run(time,expires,hash);
    }
    return {userId:row.user_id,username:row.username,role:row.role,expires};
  }
  revoke(token){const hash=tokenHash(token);if(hash)this.db.prepare('DELETE FROM login_sessions_v2 WHERE token_hash=?').run(hash);}
  invalidate(username){this.db.prepare('DELETE FROM login_sessions_v2 WHERE username=?').run(username);}
}
