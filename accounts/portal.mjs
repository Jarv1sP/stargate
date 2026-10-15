import {createDecipheriv} from 'node:crypto';
import {TeamAccounts} from './index.mjs';

export function installTeamAccounts(service,path){
  const accounts=service.accounts=new TeamAccounts(path);
  const exists=table=>service.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  const invite=exists('invites_v2')?service.db.prepare("SELECT * FROM invites_v2 WHERE role='member'").get():null;
  let inviteCode;
  if(invite?.enabled&&invite.code_cipher){
    const data=Buffer.from(invite.code_cipher,'base64'),decipher=createDecipheriv('aes-256-gcm',service.inviteKey,data.subarray(0,12));
    decipher.setAAD(Buffer.from('amax-invite-v1'));decipher.setAuthTag(data.subarray(12,28));
    inviteCode=Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString('utf8');
  }
  if(!accounts.db.prepare("SELECT 1 FROM account_metadata WHERE key='initialized'").get()&&!service.store.users.length)
    throw Error('请先初始化公共账号库，或提供首次管理员配置。');
  accounts.importLegacy({users:service.store.users,credentials:service.legacyCredentials||new Map(),
    sessions:exists('login_sessions_v2')?service.db.prepare('SELECT * FROM login_sessions_v2').all():[],invite,inviteCode});
  service.db.exec('DROP TABLE IF EXISTS invites_v2; DROP TABLE IF EXISTS login_sessions_v2;');
  // Earlier platform snapshots may still sit in the same business database.
  // Keep their archived jobs, but remove inactive copies of authentication data.
  if(exists('portal_state'))service.db.exec("UPDATE portal_state SET data=json_remove(data,'$.credentials') WHERE json_valid(data)");
  service.db.exec('DROP TABLE IF EXISTS invites; DROP TABLE IF EXISTS login_sessions;');
  delete service.legacyCredentials;delete service.credentials;
  service.loginSessions=accounts.sessions;
  service.refreshAccounts=()=>{
    const profiles=new Map(service.store.users.map(user=>[user.id,user]));
    service.store.users=accounts.list().map(user=>Object.assign(profiles.get(user.id)||{limits:{},total:0,policyVersion:0},user));
  };
  service.refreshAccounts();service.save();
}

export async function accountOperation(service,token,operation,args){
  const principal=service.principal(token),accounts=service.accounts;
  if(operation==='logout'){accounts.sessions.revoke(token);service.audit(principal.username,'logout',null,'ok');return {result:{loggedOut:true},principal:null};}
  if(operation!=='profile.update'&&principal.role!=='admin')throw Object.assign(Error('此操作需要管理员权限。'),{status:403});
  const authorize=()=>{if(service.principal(token).role!=='admin')throw Object.assign(Error('此操作需要管理员权限。'),{status:403});};
  let result;
  switch(operation){
    case 'profile.update':result=accounts.rename(principal.userId,args.name);break;
    case 'users.create':result=await accounts.create(args,undefined,authorize);break;
    case 'users.reset':result=await accounts.reset(args.userId,args.password,authorize);break;
    case 'users.enabled':result=accounts.change(args.userId,'enabled',args.enabled,principal.userId);break;
    case 'users.role':result=accounts.change(args.userId,'role',args.role,principal.userId);break;
    case 'users.delete':{
      const user=accounts.get(args.userId);
      if(!user)throw Error('用户不存在。');
      if(user.enabled||service.store.jobs.some(job=>job.userId===user.id&&!['SUCCEEDED','FAILED','CANCELED'].includes(job.state)))throw Error('只能删除已暂停且没有待完成任务的非当前账号。历史任务和文件保留。');
      result=accounts.change(args.userId,'delete',null,principal.userId);break;
    }
    case 'invites.list':return {result:{invitations:accounts.invitations(),code:accounts.currentInvite()},principal};
    case 'invites.rotate':case 'invites.disable':
      if(args.role!=='member')throw Error('只开放普通用户邀请码；管理员权限不能通过注册获得。');
      result=operation==='invites.rotate'?accounts.rotateInvite():accounts.disableInvite();break;
    default:throw Error('未知账号操作。');
  }
  service.refreshAccounts();service.save();service.audit(principal.username,operation,args.userId,'ok');
  return {result,state:service.state(principal),principal};
}
