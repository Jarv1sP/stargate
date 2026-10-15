# 自动上线

`gray` 在本仓库 main 上成功后，`deploy.yml` 检出对应提交，先运行
`npm ci`、`npm run build:release`，再按原 Dockerfile 构建。镜像经
`docker save | gzip` 压缩，和本次的 `deploy/release/`、发布范围说明、
有改动的节点模板包一起放进一个 tar 流，经强制命令 SSH 交给 VPS。
VPS 不连接 GitHub，不构建镜像或节点包。
提交信息含 `【手动】` 时不自动上线。

production environment 只允许 main，提供一个 secret `DEPLOY_SSH_KEY`，
以及变量 `DEPLOY_HOST`、`DEPLOY_KNOWN_HOSTS`、`DEPLOY_INITIAL_SHA`
（首次启用时的现役提交）、`DEPLOY_MACHINES`（空格分隔的私有节点 ID）。部署密钥不提供交互 shell、
PTY、端口转发或 agent 转发。GitHub environment 和 Actions 记录此次发布；
VPS 的 `deployed-sha` 记录实际生效提交。所有实际地址、机器清单和凭据留在私有配置中。

## VPS 一次性接线

由平台所有者在现有管理员 SSH 通道下完成，目录权限为 root/0700：

1. 创建 `/opt/stargate-release/`，不需要 checkout 或 GitHub 访问权限。
2. 将获批的 `entry.py`、`resource_guard.py` 安装到该目录。
3. 将现役容器的 `/app/dist/machines.js` 保存在
   `/opt/stargate-release/private/machines.js`，属主 root、容器使用的 node 组，权限 0640。新容器只读挂载此文件，
   不用公开仓库的示例清单替换生产配置。
4. `/opt/stargate-release/deployed-sha` 初始写入现役门户的提交；这不表示节点已经更新。
5. 为新生成的专用 ed25519 公钥追加 authorized_keys 条目：

   ```text
   command="/usr/bin/python3 -I -B /opt/stargate-release/entry.py",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-user-rc ssh-ed25519 PUBLIC_KEY
   ```

entry 只接受一个完整提交参数，接收并解包 stdin，执行 docker load，
再运行随流带来的发布脚本。入口用文件锁串行处理；不执行调用者的 shell 命令。
只上线 main 由 Actions 的 workflow_run 条件和 production 的 main 分支规则保证。
Actions 根据最近成功的发布记录计算节点改动；首次使用 DEPLOY_INITIAL_SHA。
发布记录使用实际检出的提交，避免 workflow_run 的默认分支指针前进后记错版本。

## 切换

沿用 portal-rollout 的 hold/activate 和临时 relay：短暂排队请求、排空已派发的
业务请求、停旧、起新、检查健康与 CLI，再放行。静态下载与业务请求分计，业务请求不重放。
512MiB、200MiB 和持续 swap 上涨底线保留，同一时间只有一个 Portal 容器运行。
新门户启动或健康失败时停止新版、恢复原容器和入口，job 失败；成功才更新 deployed-sha。
日志只报告发布提交、结果、耗时和最低可用内存，不打印容器环境或凭据。

`node/` 或 `gpuq/` 相对上次成功发布有变化时，runner 先构建节点模板包一并传送，目前在切换门户之前明确失败并提示
“节点有改动，需要安装”。待 `deploy/node/install.py` 入 main 后再接逐台安装，
本版不自行安装节点。私有配置、节点密钥和用户数据不进入镜像或仓库。

日常维护按 [维护手册](../../docs/MAINTAINING.md)；出现回归通过 Revert PR 重新上线。
