import {DatabaseSync} from 'node:sqlite';
import {readFileSync,statSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {LoginSessions} from '../login-sessions.mjs';

const fail=(message,status=403)=>{throw Object.assign(Error(message),{status});};
const publicUser=row=>row?{id:row.id,username:row.username,name:row.name,role:row.role,enabled:!!row.enabled}:null;

export function identityConfig(accountsPath){
  const explicit=process.env.TEAM_IDENTITY_CONFIG;
  const path=explicit||join(dirname(accountsPath),'amax-identity.json');
  try{return JSON.parse(readFileSync(path,'utf8'));}
  catch(error){if(!explicit&&error.code==='ENOENT')return null;throw error;}
}

// This is a short-lived read model from the independent identity service. It
// contains no passwords and does not call any other business application's API.
export class CentralAccounts{
  constructor(path,config){
    this.config=config;this.central=true;
    statSync(path);
    this.db=new DatabaseSync(path,{open:true});
    this.db.exec('PRAGMA busy_timeout=5000');
    if(this.db.prepare("SELECT value FROM account_metadata WHERE key='authority'").get()?.value!=='authentik')fail('请先配置统一身份服务的账号视图。',503);
    this.sessions=new LoginSessions(this.db,id=>this.get(id),{identityApp:'amax'});
  }
  list(){return this.db.prepare('SELECT id,username,name,role,enabled FROM accounts ORDER BY rowid').all().map(publicUser);}
  get(id){return publicUser(this.db.prepare('SELECT id,username,name,role,enabled FROM accounts WHERE id=?').get(id));}
  byName(username){return publicUser(this.db.prepare('SELECT id,username,name,role,enabled FROM accounts WHERE username=?').get(username));}
  importLegacy(){}
  async authenticate(username,password,issueSession=false){
    if(typeof username!=='string'||typeof password!=='string'||username.length>64||password.length>128)fail('用户名或密码错误。',401);
    let response;
    try{
      response=await fetch(new URL('/internal/clients/amax/login',this.config.portalOrigin),{
        method:'POST',redirect:'error',signal:AbortSignal.timeout(12000),
        headers:{'Content-Type':'application/json',Authorization:'Bearer '+this.config.bridgeKey},
        body:JSON.stringify({username,password}),
      });
    }catch{fail('账号服务暂时无法连接，请稍后重试。',503);}
    if(!response.ok)fail(response.status===429?'登录尝试过多，请稍后重试。':'登录未通过，请检查账号、密码及平台权限。',response.status===429?429:401);
    const result=await response.json(),user=this.get(result.id);
    if(!user?.enabled)fail('账号资料尚未更新，请稍后重新登录。',503);
    const current=this.db.prepare('SELECT epoch FROM identity_users WHERE id=?').get(user.id);
    if(!current||current.epoch!==result.epoch)fail('账号状态已改变，请重新登录。',401);
    return issueSession?{user,token:this.sessions.issue({userId:user.id,username:user.username,role:user.role})}:user;
  }
  oidcSession(claims){
    const user=this.get(claims.team_id);
    const identity=user&&this.db.prepare('SELECT provider_pk FROM identity_users WHERE id=?').get(user.id);
    if(!user?.enabled||identity?.provider_pk!==Number(claims.portal_pk))fail('账号尚未同步或无权进入平台，请稍后重试。',403);
    return this.sessions.issue({userId:user.id,username:user.username,role:user.role});
  }
  managed(){fail('账号资料、密码和平台权限请前往统一门户的账号中心管理。',409);}
  create(){return this.managed();} rename(){return this.managed();} reset(){return this.managed();}
  change(){return this.managed();} rotateInvite(){return this.managed();} disableInvite(){return this.managed();}
  invitations(){return [];} currentInvite(){return null;}
  close(){this.db.close();}
}
