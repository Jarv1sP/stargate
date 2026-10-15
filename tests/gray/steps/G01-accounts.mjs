import {adminSession,adminState,registerMember,approve} from '../lib/accounts.mjs';
export default {features:["注册（邀请码）、登录、退出、改姓名", "管理员：新建/启用/停用/删除成员、改角色、重置密码、查看和轮换邀请码、分配卡数额度"],id:'G01',title:'账号与成员管理（FEATURES 一）',level:'fast',async run(ctx){
  const admin=await adminSession(ctx),api=(operation,args={})=>ctx.client.call(admin.token,operation,args);
  const before=(await api('invites.list')).result;
  const invite=(await api('invites.rotate',{role:'member'})).result.code;ctx.shared.invite=invite;
  ctx.check('邀请码可查看与轮换',typeof invite==='string'&&invite!==before.code&&(await api('invites.list')).result.code===invite);
  const a=await registerMember(ctx,'a'),b=await registerMember(ctx,'b');
  ctx.check('邀请码注册 A、B 成员',a.registered.role==='member'&&b.registered.role==='member');
  await approve(ctx,a,{[ctx.machine]:2},2);await approve(ctx,b,{[ctx.machine]:2},2);
  const password=ctx.password(),username=ctx.name('c');
  const c=(await api('users.create',{username,name:'成员 C',password,role:'member'})).result;
  ctx.check('管理员新建 C',!!c.id);
  await api('users.enabled',{userId:c.id,enabled:false});
  const disabled=await ctx.client.raw('/api/login',{body:{username,password}});
  ctx.check('停用 C 后登录被拒',disabled.status===400&&disabled.body?.error==='账号已暂停，请联系管理员。'&&!disabled.body?.token,{status:disabled.status,error:disabled.body?.error});
  await api('users.enabled',{userId:c.id,enabled:true});
  ctx.check('启用 C 后可登录',!!(await ctx.client.login(username,password)).token);
  await api('users.role',{userId:c.id,role:'admin'});
  ctx.check('C 改为管理员',(await adminState(ctx)).users.find(u=>u.id===c.id).role==='admin');
  await api('users.role',{userId:c.id,role:'member'});
  const replacement=ctx.password();await api('users.reset',{userId:c.id,password:replacement});
  const old=await ctx.client.raw('/api/login',{body:{username,password}});
  ctx.check('旧密码失效',old.status===400&&old.body?.error==='用户名或密码错误。'&&!old.body?.token,{status:old.status,error:old.body?.error});
  ctx.check('新密码可登录',!!(await ctx.client.login(username,replacement)).token);
  await api('policy.save',{userId:c.id,total:1,limits:{[ctx.machine]:1}});
  const policy=(await adminState(ctx)).users.find(u=>u.id===c.id);
  ctx.check('卡数额度写入',policy.total===1&&policy.limits[ctx.machine]===1);
  const denied=[['invites.list',{}],['invites.rotate',{role:'member'}],['users.create',{username:ctx.name('denied'),password:ctx.password(),name:'拒绝',role:'member'}],
    ['users.enabled',{userId:c.id,enabled:false}],['users.role',{userId:c.id,role:'admin'}],['users.reset',{userId:c.id,password:ctx.password()}],
    ['policy.save',{userId:c.id,total:2,limits:{[ctx.machine]:2}}],['users.delete',{userId:c.id}]];
  for(const [operation,args] of denied){const error=await ctx.client.refused(a.token,operation,args);ctx.check('成员被拒：'+operation,error.status===403);}
  await api('users.enabled',{userId:c.id,enabled:false});await api('users.delete',{userId:c.id});
  ctx.check('C 已删除',!(await adminState(ctx)).users.some(u=>u.id===c.id));
}};
