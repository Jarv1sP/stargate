import {communityHelp} from './community-cli.mjs';

// Help is a discovery surface, not a list of every historical parser branch.
// Runtime authority remains with the authenticated Portal and node capability
// checks. Do not advertise pilot integrations or unverified scheduling limits.
const daily=`STARGATE / GPUQ — 个人项目、数据仓库、训练

1. 登录并选择已授权的服务器
gpuctl login
gpuctl state
gpuctl use MACHINE_ID

2. 创建个人项目，上传代码，在容器内安装依赖
gpuctl project create my-project
gpuctl project use my-project
gpuctl push .
gpuctl ssh
开发终端没有 GPU。exit 结束终端；Ctrl+] 只断开。
gpuctl ssh --reconnect SESSION_ID  明确重连原会话

3. 直接运行持久工作区，无需发布
gpuctl project status
gpuctl run -g 1 -- python train.py --output /outputs
gpuctl run --sync -g 1 -- python train.py  上传后直接运行
gpuctl run -g 1 --interactive             申请 GPU 交互会话
gpuctl ssh --job JOB_ID                  RUNNING 后连接或重连
GPU 会话断开仍占卡，exit 或 cancel 才释放；文件和环境保留。
gpuctl jobs / logs JOB / cancel JOB
gpuctl watch JOB
gpuctl diagnostics JOB --json
gpuctl files --job JOB_ID
gpuctl pull --job JOB_ID model.pt ./model.pt

4. 完整数据先入仓库，再准备训练缓存
gpuctl data upload FILE.tar.gz --name NAME --via direct
gpuctl data upload-status UPLOAD_ID
gpuctl data list
gpuctl data prepare NAME@VERSION
gpuctl data status OPERATION_ID
gpuctl data status NAME@VERSION
gpuctl run -g 1 --data NAME@VERSION -- python train.py --data /data2/NAME --output /outputs

代码、个人权重和结果属于项目；数据集只放完整训练/评测样本。
直传入口须由平台明确提供且实际可达；失败不自动改走 VPS。
数据集入库和准备须确认对应版本 READY；工作区无需发布，UNKNOWN 不等于已停止。
能力以当前服务回包为准，不从客户端版本推断已开通。
gpuctl help admin       管理员操作与兼容记录
gpuctl help community   帖子、公告与聊天
完整用户指南：平台地址 /guide
全局：--url HTTPS_ORIGIN --json --session-file PATH
密码：交互隐藏输入；脚本使用 --password-stdin，不把密码放参数。
凭据保存在个人 session.json（0600）；用户不需要 Tail 或节点密钥。`;

const admin=`STARGATE / GPUQ — 管理员操作

管理员日常使用同一个个人项目流程；宿主运维是独立高信任入口。
以下命令仍须当前角色、机器授权和节点能力，帮助文本不授予权限。

账号与额度
gpuctl users
gpuctl user enable|disable USERNAME
gpuctl user reset-password USERNAME
gpuctl user role USERNAME admin|member
gpuctl invites list
gpuctl invites rotate member
gpuctl grant USERNAME --machine MACHINE_ID=2 --total 2
grant 替换完整机器策略。管理员免个人卡数额度，物理资源仍排队。

维护与宿主运维
gpuctl maintenance status
gpuctl maintenance on all --reason TEXT --revision N
gpuctl maintenance off SERVER --revision N
维护不自动停止已有任务；读取最新 revision 后再明确修改。
gpuctl ssh --root
gpuctl exec -- id
gpuctl exec --detach -- COMMAND ARGS
gpuctl exec status HANDLE
gpuctl exec cancel HANDLE
宿主 root 可以绕过平台限制，不属于普通容器权限。

数据缓存与删除
gpuctl data storage status [NAME@VERSION]
gpuctl data storage plan
gpuctl data unregister NAME[@VERSION] --machine SERVER
plan 仅预览；unregister 使用实时授权和最后副本保护，不删除唯一原件。
gpuctl data delete NAME@VERSION --key UUID
gpuctl data delete-status UUID
gpuctl data retire-continue OPERATION_ID
gpuctl data retire-cancel OPERATION_ID
gpuctl data retire-restore OPERATION_ID --machine SERVER
按原 key / 编号核对。UNKNOWN 不重放写操作、不清数据保护。

历史项目与记录
gpuctl project catalog --full
gpuctl project archive|unarchive NAME
gpuctl project retire-plan NAME
gpuctl project retire-status UUID --project NAME
gpuctl completion JOB --json
gpuctl reconcile-resources JOB --json
旧环境和上传记录可查询；不作为新项目、新数据入口推荐。
合并源码不等于门户、节点及驻留服务已经配套上线。`;

export function cliHelp(topic='daily'){
  if(topic==='daily')return daily;
  if(topic==='admin')return admin;
  if(topic==='community')return `STARGATE / GPUQ — 协作\n\n${communityHelp}`;
  throw Error('Usage: gpuctl help [daily|admin|community]');
}
