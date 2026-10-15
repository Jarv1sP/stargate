export default {id:'G12',title:'传输和外网导入边界（FEATURES 七）',level:'full',async run(ctx){
  for(const id of ['server-transfer','campus-direct','aliyun-import','https-import','cloud-browse','cloud-download','cloud-upload'])ctx.todo(id,'未测：本地栈无外网/单节点');
}};
