# VPS 执行桥与状态采集

`direct-storage-bridge.py` 和 `collect-status.py` 收录 VPS 执行桥与采集器源码，灰测直接运行这两个程序。执行桥通过 `ssh-transport.py` 调用节点既有的 SSH forced command；它没有公开监听端口，也不执行宿主 shell。采集器用独立的只读 SSH 身份调用 `status`，写入门户读取的快照。

## 私有配置

按 `config.example.json` 在 VPS 本地填写 `/etc/stargate/vps.json`，设为 `0600`。可用 `STARGATE_VPS_CONFIG` 指定其他位置。这个文件、SSH 私钥和 `known_hosts` 都不进仓库。

- `transport.credentialDirectory`：执行身份的凭据目录，包含 `id_ed25519` 和 `known_hosts`；`transport.hosts` 按机器 ID 配置固定的 `user`、`address`。
- `bridge.runtimeDirectory`：SSH 连接复用的私有运行目录；`socket`、`socketUid`、`socketGid` 对应门户挂载的 Unix socket 及其属主。
- `collector.credentialDirectory`、`collector.hosts`：采集身份的独立凭据和机器清单。
- `collector.target`、`targetUid`、`targetGid`：快照文件位置及其属主。父目录须已存在，且门户用户能读取。发布通过同目录临时文件、`fsync`、原子改名完成。

节点需要跳板时，分别设置 `transport.sshConfig`、`collector.sshConfig` 为 VPS 本地管理员维护的 SSH 配置文件，在对应 Host 中配置 ProxyCommand 或 ProxyJump；不设置仍使用 `/dev/null`。最终节点继续使用原执行/采集密钥和 known_hosts，跳板使用独立、仅允许转发到目标 SSH 端口的身份，不转发 agent。地址和密钥路径只放私有配置，不从 RPC 请求读取。自动发布另沿用 `node-ssh.conf`，新增节点须同时登记 `nodes.json` 和 production 的 `DEPLOY_MACHINES`。

SSH 保留现有服务器证书校验和固定密钥，不自动重派已经发送的请求或终端输入。传输里的哈希仅用于生成短 Unix socket 文件名，不读取或比较用户文件。

## 现有 systemd 服务

`systemd/` 提供 `stargate-direct-node.service`、`amax-console-collect.service` 和 `amax-console-collect.timer` 的模板，沿用这三个服务名，不新增服务。模板假定源码位于 `/opt/stargate/current/deploy/vps/`；私有配置、运行目录、快照目录、门户挂载和组号需由发布配置对齐。采集器是 oneshot，timer 保持开机 20 秒启动、每轮结束 60 秒后再启动、5 秒精度。

共享 socket 父目录由 `ExecStartPre` 创建，不放进某个桥的 `RuntimeDirectory`，避免停止一个桥时删除其他桥的 socket；私有 SSH 复用目录仍由对应桥单独管理。

自动发布对这些宿主服务的安装接线由发布程序负责。本目录不包含 SSH 凭据，也不连接或更改线上机器。

## 灰测

灰测桥镜像直接复制候选提交的 `deploy/vps/`。`deploy/gray-local/bridge-entrypoint.sh` 只生成隔离栈自己的密钥、主机清单和私有配置，再启动同一执行桥；采集容器每轮执行同一采集脚本，间隔 60 秒。采集失败保留上一份有效采样并标记 `samplingStale`，首次无法连接时显示不可达。

本地回归：`python3 tests/vps-runtime.test.py`；完整灰测：`npm run gray`。灰测只连接隔离栈里的模拟节点。
