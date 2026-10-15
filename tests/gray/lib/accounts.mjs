// Shared account setup. Steps call these so that `--only Gxx` still works:
// whatever an earlier step already created in this run is reused.
export async function adminSession(ctx){
  if(!ctx.shared.admin){
    const login=await ctx.client.login(ctx.admin.username,ctx.admin.password);
    ctx.shared.admin={token:login.token,username:ctx.admin.username};
  }
  return ctx.shared.admin;
}

export async function adminState(ctx){
  const admin=await adminSession(ctx);
  return (await ctx.client.call(admin.token,'state')).state;
}

export async function inviteCode(ctx){
  if(!ctx.shared.invite){
    const admin=await adminSession(ctx);
    ctx.shared.invite=(await ctx.client.call(admin.token,'invites.rotate',{role:'member'})).result.code;
  }
  return ctx.shared.invite;
}

export async function registerMember(ctx,label){
  ctx.shared.members??={};
  if(ctx.shared.members[label])return ctx.shared.members[label];
  const username=ctx.name(label),password=ctx.password();
  const registered=await ctx.client.register({username,password,invite:await inviteCode(ctx)});
  const login=await ctx.client.login(username,password);
  const member={label,username,password,token:login.token,userId:login.principal?.userId,registered};
  ctx.shared.members[label]=member;
  return member;
}

// Machine-limited approval through the admin API (policy.save replaces the
// whole policy and needs the current policyVersion).
export async function approve(ctx,member,limits,total){
  const admin=await adminSession(ctx);
  const user=(await adminState(ctx)).users.find(u=>u.username===member.username);
  if(!user)throw Error(`admin cannot see ${member.username}`);
  member.userId??=user.id;
  await ctx.client.call(admin.token,'policy.save',{userId:user.id,limits,total});
  member.approved={limits,total};
  return user.id;
}

export async function approvedMember(ctx,label,cards=2){
  // Never ask for more cards than the gray machine has (a 1-GPU gpu-tier node).
  const machine=(await adminState(ctx)).machines?.find(m=>m.id===ctx.machine);
  if(machine)cards=Math.min(cards,machine.cards);
  const member=await registerMember(ctx,label);
  if(!member.approved)await approve(ctx,member,{[ctx.machine]:cards},cards);
  return member;
}

export async function memberState(ctx,member){
  return (await ctx.client.call(member.token,'state')).state;
}
