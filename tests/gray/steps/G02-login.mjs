import {registerMember,memberState} from '../lib/accounts.mjs';
export default {id:'G02',title:'登录、资料和退出（FEATURES 一/第一道墙）',level:'fast',async run(ctx){
  const machines=await ctx.client.raw('/machines.js',{method:'GET'});
  ctx.check('未登录不能下载机器表',machines.status===401&&!machines.text.includes('gray-node-1'));
  for(const operation of ['state','projects.list','datasets.list','files.list']){
    const error=await ctx.client.refused(null,operation,{machine:ctx.machine});ctx.check('未登录请求被拒：'+operation,error.status===401);
  }
  const a=await registerMember(ctx,'a');
  await ctx.client.call(a.token,'profile.update',{name:'灰度成员 A'});
  ctx.check('姓名更新',(await memberState(ctx,a)).users.find(u=>u.id===a.userId).name==='灰度成员 A');
  const old=a.token;await ctx.client.call(old,'logout');
  const error=await ctx.client.refused(old,'state');ctx.check('退出后旧会话失效',error.status===401);
  a.token=(await ctx.client.login(a.username,a.password)).token;
  ctx.check('A 可重新登录',!!a.token&&a.token!==old);
}};
