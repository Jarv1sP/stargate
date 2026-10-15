import {approvedMember,adminSession} from '../lib/accounts.mjs';
import {project,call,submit,waitJob,terminalStates} from '../lib/exec.mjs';
import {sections} from '../lib/sections.mjs';
export default {features:["任务显示名、留言、通知", "帖子、评论、聊天、置顶、任务留言", "公告：定向发送、弹窗、外观、CLI 未读提醒和已读确认", "平台/单台服务器维护模式"],id:'G11',title:'协作、定向公告及维护（FEATURES 八、九）',level:'full',async run(ctx){
  const {name,member:a}=await project(ctx),b=await approvedMember(ctx,'b'),admin=await adminSession(ctx);
  await sections(ctx,[['协作和公告',async()=>{
    const post=(await call(ctx,a,'community.posts.create',{key:ctx.key(),kind:'discussion',title:'灰度协作',body:'讨论内容'})).post;
    const comment=(await call(ctx,b,'community.comments.create',{key:ctx.key(),postId:post.id,body:'成员B评论'})).comment;
    ctx.check('帖子与评论可读',(await call(ctx,a,'community.posts.get',{id:post.id})).post.title==='灰度协作'&&(await call(ctx,a,'community.comments.list',{postId:post.id})).comments.some(c=>c.id===comment.id));
    const message=(await call(ctx,a,'community.chat.send',{key:ctx.key(),body:'灰度聊天'})).message;
    ctx.check('B看到聊天',(await call(ctx,b,'community.chat.list')).messages.some(m=>m.id===message.id));
    const note=(await call(ctx,b,'community.notes.create',{key:ctx.key(),body:'团队留言'})).note;
    ctx.check('A看到留言',(await call(ctx,a,'community.notes.list')).notes.some(n=>n.id===note.id));
    const announcement=(await call(ctx,admin,'community.posts.create',{key:ctx.key(),kind:'announcement',title:'只给 A 的灰度公告',body:'请确认已读',pinned:true,popup:true,audience:{type:'users',userIds:[a.userId]}})).post;
    ctx.check('公告置顶和弹窗配置',announcement.pinned&&announcement.popup&&!!announcement.appearance);
    ctx.check('A收到定向弹窗公告',(await call(ctx,a,'community.announcements.pending')).posts.some(p=>p.id===announcement.id&&p.popup));
    ctx.check('B不收到A公告',!(await call(ctx,b,'community.posts.list')).posts.some(p=>p.id===announcement.id)&&!(await call(ctx,b,'community.announcements.pending')).posts.some(p=>p.id===announcement.id));
    const ack=await call(ctx,a,'community.announcements.ack',{id:announcement.id,revision:announcement.revision});
    ctx.check('A已读确认',ack.acknowledged===true&&!(await call(ctx,a,'community.announcements.pending')).posts.some(p=>p.id===announcement.id));
  }],['活动任务留言和通知状态',async()=>{
    const job=await submit(ctx,a,name,['python','-u','sleeper.py']);
    try{
      const note=(await call(ctx,b,'community.notes.create',{key:ctx.key(),jobId:job.id,body:'B给A任务留言'})).note;
      ctx.check('任务留言绑定原编号',note.jobId===job.id);
      const notify=await call(ctx,a,'notifications.job',{jobId:job.id});ctx.check('未配置外部通知如实显示',notify.configured===false);
      ctx.todo('external-notifications','外部通知投递未测，本地没有收件人配置和外网');
    }finally{await call(ctx,a,'jobs.cancel',{jobId:job.id});await waitJob(ctx,a,job.id,terminalStates);}
  }],...['all',ctx.machine].map(scope=>['维护 '+scope,async()=>{
    await call(ctx,admin,'maintenance.set',{scope,enabled:true,reason:'灰度维护'});
    try{
      const denied=await ctx.client.refused(a.token,'projects.label.set',{machine:ctx.machine,project:name,displayName:'维护期间写入'});
      ctx.check('维护拒绝成员写入',denied.status===503&&denied.code==='MAINTENANCE_ACTIVE');
      ctx.check('维护保留只读',(await call(ctx,a,'projects.list',{machine:ctx.machine})).projects.some(p=>p.project===name));
    }finally{await call(ctx,admin,'maintenance.set',{scope,enabled:false});}
    await call(ctx,a,'projects.label.set',{machine:ctx.machine,project:name,displayName:'维护后恢复'});
    ctx.check('解除维护恢复写入',(await call(ctx,a,'projects.label.get',{machine:ctx.machine,project:name})).displayName==='维护后恢复');
  }])]);
}};
