import {compose,stackExec} from './stack.mjs';
import {waitFor} from './context.mjs';

async function member(ctx){
  if(!ctx.shared.identityMember)ctx.shared.identityMember=await ctx.client.login('member',ctx.admin.password);
  return ctx.shared.identityMember;
}

export async function identityAccounts(ctx){
  ctx.note('统一身份模式仅核对 G01 登录与权限；账号管理由身份服务负责。');
  await waitFor(async()=>{try{return (await ctx.client.raw('/healthz',{method:'GET'})).status;}catch{return 0;}},status=>status===200,{what:'统一身份门户启动'});
  const permissions=JSON.parse((await stackExec(ctx.stack,'gray-portal','node','--input-type=module','-e',`
    import fs from 'node:fs';
    const paths=['/accounts','/accounts/amax-identity.json',...['','-wal','-shm'].map(suffix=>'/accounts/identity.sqlite'+suffix)];
    console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),groups:[...process.getgroups(),process.getgid()],files:paths.map(path=>{
      const s=fs.statSync(path);let writable=false;
      if(!s.isDirectory())try{const fd=fs.openSync(path,'r+');fs.closeSync(fd);writable=true;}catch{}
      return {path,uid:s.uid,gid:s.gid,mode:s.mode&4095,readable:!!fs.readdirSync('/accounts'),writable};
    })}));`)).stdout);
  ctx.check('身份用户持有投影，门户通过组权限读写',permissions.uid===1000&&permissions.gid===1000&&permissions.groups.includes(2000)&&permissions.files.every(file=>
    file.uid===(file.path.includes('identity.sqlite')?2000:0)&&file.gid===2000&&
    file.mode===(file.path==='/accounts'?0o2770:file.path.includes('identity.sqlite')?0o660:0o640)&&file.readable&&
    file.writable===file.path.includes('identity.sqlite')),permissions);
  const registered=await ctx.client.raw('/api/register',{body:{username:'not-created',password:ctx.password()}});
  ctx.check('实际启用统一身份配置',registered.status===409&&registered.body?.url==='http://gray-identity:8090/register',registered.body);
  const admin=await ctx.client.login(ctx.admin.username,ctx.admin.password);
  ctx.check('管理员登录成功',!!admin.token&&admin.principal?.role==='admin');
  ctx.check('管理员会话可读业务库',!!(await ctx.client.call(admin.token,'state')).state);
  const login=await member(ctx);
  ctx.check('成员登录成功',!!login.token&&login.principal?.role==='member');
  const sessions=JSON.parse((await stackExec(ctx.stack,'gray-portal','node','--input-type=module','-e',`
    import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync('/accounts/identity.sqlite',{readOnly:true});
    console.log(JSON.stringify(db.prepare('SELECT count(*) n FROM login_sessions_v2 JOIN identity_session_scopes USING(token_hash)').get()));
    db.close();`)).stdout);
  ctx.check('真实登录会话写进共享身份库',sessions.n>=2,sessions);
  const error=await ctx.client.refused(login.token,'policy.save',{userId:login.principal.userId,total:1,limits:{[ctx.machine]:1}});
  ctx.check('账号维护仍限管理员',error.status===403);
  ctx.check('创建会话后门户仍健康',(await ctx.client.raw('/healthz',{method:'GET'})).status===200);
}

export async function identityLogin(ctx){
  ctx.note('统一身份模式核对 G02 匿名拒绝、错误密码、cookie/CLI 会话、退出与重启持久性；不模拟 OIDC 提供者。');
  ctx.check('未登录不能下载机器表',(await ctx.client.raw('/machines.js',{method:'GET'})).status===401);
  for(const operation of ['state','projects.list','datasets.list','files.list'])
    ctx.check('未登录请求被拒：'+operation,(await ctx.client.refused(null,operation,{machine:ctx.machine})).status===401);
  const wrong=await ctx.client.raw('/api/login',{body:{username:'member',password:'wrong-password'}});
  ctx.check('错误密码不能创建会话',wrong.status===401&&!wrong.body?.token);
  const browser=await ctx.client.raw('/api/login',{body:{username:'member',password:ctx.admin.password,client:'browser'}});
  ctx.check('网页使用统一登录入口',browser.status===409&&browser.body?.url==='/auth/login');
  const login=await member(ctx),old=login.token,cookie='__Host-amax_session='+old;
  ctx.check('同站 cookie 可读会话',!!(await ctx.client.call(null,'state',{}, {cookie})).state);
  await ctx.client.call(old,'logout');
  ctx.check('退出后旧令牌失效',(await ctx.client.refused(old,'state')).status===401);
  ctx.check('退出后旧 cookie 失效',(await ctx.client.refused(null,'state',{}, {cookie})).status===401);
  const next=await ctx.client.login('member',ctx.admin.password);
  ctx.check('重新登录获得新会话',!!next.token&&next.token!==old);
  await compose(ctx.stack,'restart','gray-portal');
  await waitFor(async()=>{try{return (await ctx.client.raw('/healthz',{method:'GET'})).status;}catch{return 0;}},status=>status===200,{what:'统一身份门户重启'});
  ctx.check('重启后会话仍可用',!!(await ctx.client.call(next.token,'state')).state);
}
