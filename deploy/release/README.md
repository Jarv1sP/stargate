# 自动上线

`gray` 在本仓库 main 上成功后，`deploy.yml` 检出对应提交，先运行
`npm ci`、`npm run build:release`，再按原 Dockerfile 构建。镜像经
`docker save | gzip | ssh` 交给 VPS，不在 VPS 构建门户镜像。
提交信息含 `【手动】` 时不自动上线。

production environment 只允许 main，提供一个 secret `DEPLOY_SSH_KEY`，
以及变量 `DEPLOY_HOST`、`DEPLOY_KNOWN_HOSTS`。部署密钥不提供交互 shell、
PTY、端口转发或 agent 转发。GitHub environment 和 Actions 记录此次发布；
VPS 的 `deployed-sha` 记录实际生效提交。所有实际地址、机器清单和凭据留在私有配置中。

## VPS 一次性接线

由平台所有者在现有管理员 SSH 通道下完成，目录权限为 root/0700：

1. 在 `/opt/stargate-release/repository` clone 此公开仓库，remote 为 origin。
2. 将获批的 `entry.py` 安装为 `/opt/stargate-release/entry.py`。
3. 将现役容器的 `/app/dist/machines.js` 保存在
   `/opt/stargate-release/private/machines.js`，权限 0600。新容器只读挂载此文件，
   不用公开仓库的示例清单替换生产配置。
4. `/opt/stargate-release/deployed-sha` 初始写入现役门户的提交；这不表示节点已经更新。
5. 为新生成的专用 ed25519 公钥追加 authorized_keys 条目：

   ```text
   command="/usr/bin/python3 -I -B /opt/stargate-release/entry.py",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-user-rc ssh-ed25519 PUBLIC_KEY
   ```

entry 只接受一个完整提交参数，从 GitHub fetch 后确认它属于 main，读取 stdin
执行 docker load，再运行该提交的部署代码。入口用文件锁串行处理；不执行调用者的 shell 命令。

## 切换

沿用 portal-rollout 的 hold/activate 和临时 relay：短暂排队请求、排空已派发的
业务请求、停旧、起新、检查健康与 CLI，再放行。静态下载与业务请求分计，业务请求不重放。
512MiB、200MiB 和持续 swap 上涨底线保留，同一时间只有一个 Portal 容器运行。
新门户启动或健康失败时停止新版、恢复原容器和入口，job 失败；成功才更新 deployed-sha。
日志只报告发布提交、结果、耗时和最低可用内存，不打印容器环境或凭据。

`node/` 或 `gpuq/` 相对 deployed-sha 有变化时，目前在切换门户之前明确失败并提示
“节点有改动，需要安装”。待 `deploy/node/install.py` 入 main 后再接逐台安装，
本版不自行安装节点。私有配置、节点密钥和用户数据不进入镜像或仓库。

日常维护按 [维护手册](../../docs/MAINTAINING.md)；出现回归通过 Revert PR 重新上线。
