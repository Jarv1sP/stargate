import {approvedMember} from '../lib/accounts.mjs';
export default {features:["服务器之间传输、电脑上传下载、校园网直连；列表、状态、取消、续传"],id:'G12',title:'传输和外网导入边界（FEATURES 七）',level:'full',async run(ctx){
  const member=await approvedMember(ctx,'a'),target={area:'dataset',dataset:ctx.name('bulk'),project:ctx.name('bulk-target')};
  for(const [operation,args] of [
    ['cloud.import.start',{key:ctx.key(),...target,url:'https://example.invalid/file',path:'file'}],
    ['cloud.files.download',{key:ctx.key(),...target,fileId:'file',path:'file',size:3}],
    ['transfers.create',{key:ctx.key(),kind:'copy',from:ctx.machine,reference:{project:target.project},name:ctx.name('copy')}],
  ]){
    const denied=await ctx.client.refused(member.token,operation,{machine:ctx.machine,...args});
    ctx.check(operation+' 拒绝项目工作区目标',denied.status===400&&/数据集/.test(denied.message));
  }
  for(const id of ['server-transfer','campus-direct','aliyun-import','https-import','cloud-browse','cloud-download','cloud-upload'])ctx.todo(id,'未测：本地栈无外网/单节点');
}};
