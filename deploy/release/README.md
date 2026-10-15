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

沿用 portal-rollout 的 hold/activate 和临时 relay：新请求排队，普通在途请求最多等
30 秒，之后停旧、起新、检查健康与 CLI，再放行。终端交换、日志、watch/长轮询和
静态下载不阻塞切换，停旧时断开，由客户端重连。已发出的写请求不自动重放；
结果未知时按原 key 查询或续传，终端输入未知时不重放。
`drain.json` 和最终 `result.json` 记录等待耗时、剩余请求分类计数及排队数量，
不记录请求参数。首次更新旧 supervisor 时，旧版未分类的请求记录为 unclassifiedBusiness。
切换的 stop/start 另保留 15 秒预算。创建前清理同名的已停止 staged 容器，
发布失败后清理本次已停止的候选；不删除正在运行的门户。
512MiB、200MiB 和持续 swap 上涨底线保留，同一时间只有一个 Portal 容器运行。
新门户启动或健康失败时停止新版、恢复原容器和入口，job 失败；成功才更新 deployed-sha。
日志只报告发布提交、结果、耗时、请求分类计数和最低可用内存，不打印容器环境或凭据。

每次新建候选门户使用独立的激活标记；同一提交再次发布仍等待 hold/activate
交接，已有容器重启则沿用其保存的标记恢复。镜像标签和发布记录仍使用源码提交。

`node/` 或 `gpuq/` 相对上次成功发布有变化时，runner 构建所有节点模板包，
并携带该提交的 `deploy/node/install.py`。VPS 依次通过专用 SSH 密钥向各节点
发送一个 tar：根下 `install.py` 和 `package/`（该机模板包内容）。
节点的强制入口 `receive.py` 用节点本机私有配置调用
`install.py package --config <本机私有配置>`；退出码为 0 才安装下一台。
全部成功后才切门户。某台失败就停止，门户保留原版，之前成功的节点不回滚。

### 节点一次性接线

仅在共同安装器和节点受限入口就绪后启用，由指定节点安装者接线：

- VPS 的 `/opt/stargate-release/node-release-ed25519` 为独立发布私钥，仅在 VPS 保存。
- 公钥放到各节点管理块之外，绑定
  `restrict,command="sudo -n /usr/local/sbin/stargate-node-receive"`；
  sudoers 只允许这个接收命令，不提供宿主 shell。
- `/opt/stargate-release/nodes.json` 提供机器 ID 与 SSH 目标别名，例如：

  ```json
  [{"machine":"gpu-1","destination":"node-release-1"}]
  ```

- `/opt/stargate-release/node-ssh.conf` 只配置这些目标的地址、账号、现有 known_hosts
  和既有跳转路径。最终节点仅使用专用发布密钥；需要经跳板时，ProxyCommand
  复用原管理员 SSH 配置和已有跳转密钥，不给发布 key 开转发。
- 两份配置权限 root/0600，真实地址、私有配置、节点密钥和用户数据不进入仓库或镜像。
  VPS 沿用现有 SSH 网络路径，不扫描主机指纹、不改网络或 authorized_keys 管理块。

日常维护按 [维护手册](../../docs/MAINTAINING.md)；出现回归通过 Revert PR 重新上线。
