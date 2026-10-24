# 节点发布包与安装

在完整 Git 源码目录备好 Node24 和 npm 依赖，再构建机器包；机器 ID 由清单传入，输出目录必须不存在：

```sh
npm ci --ignore-scripts
python3 -I -B scripts/build-node-release.py --output /tmp/node-release-review \
  --machine node-a --machine node-b --machine node-c --machine node-d
```

每个机器目录包含共同 `node/`、`gpuq.pyz`、六类 `profiles/<profile>/node-config.template.json` 和 `manifest.json`。只打包 Git 跟踪的 `.py`、`.mjs` 及 `gpuq-network`/`gpuq-ray`；云文件 worker 由 Node/esbuild 打包。私有配置、密钥、数据库、缓存和 pyc 不进入包。node 文件只读，pyz 使用固定时间戳。

manifest 记录源码提交与 dirty 状态、node 文件路径和大小、pyz 路径和大小、profile 配置路径及固定入口/服务命令。`{release}` 表示安装目录；脚本只生成这些材料，不执行 SSH、systemd、安装或切换。

模板只描述配置结构，null 不代表可用配置。安装者在本机私有 JSON 中提供各固定 profile 的完整配置，保留实际路径、资源与服务配置；运行时不合并模板。安装器逐版保存服务/入口的回退材料，不复制用户数据。

调用者按路径和大小交接，经配置好的 TLS 通道接收，在同盘临时目录完整落盘后原子改名；断线沿用原操作和偏移。构建脚本不连接服务器，安装与切换统一使用下面的本机入口。

节点状态采样使用 GPUQ 现有查询上限 1000，从返回的活跃作业中保留全部运行中、启动中和让位中作业，以及按优先级/FIFO 排序的前 100 个 `PENDING`；快照 `limit` 为 100 加非 `PENDING` 数量，门户保留该列表，避免排队作业挤掉 GPU 进程对应的任务信息。

现有 `7IM` 的每小时 `--storage-collect` 服务以 nice19/idle I/O 清理暂存并统计存储，原子保存数据盘 `samples/storage-areas.json`（含 `checkedAt`）。项目用量请求只读缓存并返回 `areasCheckedAt`，缺失或损坏时保留项目列表、用量显示未知；部分可读保留大小下限。该服务与容器服务使用安装器配置的同一账户，复用已有 Podman 用户命名空间，不新增服务。
升级后先手动触发一次配置中的 storage-collect 服务，生成首份采样；无需等到下一个小时。该步骤由节点安装者执行。

项目采样另带 `environment:{size,complete}`，按同一 owner 内的 `io.gpuq.project` 标签归属，无标签时匹配项目 `oci.json` 的容器名；只计各容器自身的 UpperDir，rootfs 型任务容器跳过，共用镜像与未归属层保留在既有 `areas.environments`。项目文件和可写层均在已有 owner 的 Podman 用户命名空间计量，不初始化运行时；缓存未含 environment 时返回 null，部分读取保留大小下限。

## 安装

调用者负责 SSH/传输；节点本机用 Python 3.10 以管理员权限运行 `python3 deploy/node/install.py <单机包目录或tar包> --config <本机私有JSON>`。
自动安装由强制 SSH 命令调用 `deploy/node/receive.py`：stdin 为未压缩 tar，根目录包含 `install.py` 和 `package/` 单机包；在 `/var/tmp` 临时解包后调用安装器，输出其 JSON/退出码，临时文件自动清理；默认私有配置 `/etc/gpuq-console/node-install.json`，可由节点安装者通过 `--config` 指定。
私有配置结构见 [config.example.json](../deploy/node/config.example.json)：account、releaseRoot、dataMountPoints、gpuq、profiles、authorizedKeys（每条显式写 profile）、services；数据盘列表由顶层统一填入各 profile，真实值只留节点。
安装器写 policy.json、完整 profile 配置和服务/定时器；已有 ExecStart drop-in 可在对应 service 的 dropin 字段指定，无指纹或历史内容核对。
安装器只为 account 对应的 `user@UID.service` 配置 cpu/cpuset/io/memory/pids 委托并 daemon-reload，不重启已在运行的用户管理器；任务仅在当前 cgroup 已有 cpuset 控制器时绑定 CPU，缺少时保留线程默认值并正常启动，失败时委托文件随其他绑定恢复。
每版使用独立的真实 pyz 路径；current 原子切换后只重启受管服务，独立任务单元、旧发布目录和数据库保留；仅新库初始化。
健康仅看服务 active 和 GPU 可读；失败时即使新单元损坏或停止失败，也先恢复旧文件和指针，再重启原先活跃的服务。`python3 deploy/node/install.py --config <私有JSON> --rollback` 回上一版，不回滚用户数据。
灰测的 `deploy/gray-local/node-setup.sh` 生成模拟配置并调用同一安装器；私有配置保持 0600，模拟 CDI 规范为 0644，供非 root 任务读取，不另写安装流程。

## 一次性收回已删除项目的输出

节点安装者在本机以现有节点服务账户、同一份私有 profile 配置运行发布目录里的 `node-executor.py`（沿用该服务的配置环境，不连接其他节点）。命令不接 RPC，也不挂定时器。

```sh
# 为这次操作生成一个 UUID，预览和执行都沿用它；ACTOR 填实际操作人的平台用户 ID。
python3 node/node-executor.py --trash-orphan-outputs --key UUID --actor ACTOR
python3 node/node-executor.py --trash-orphan-outputs --key UUID --actor ACTOR --execute
```

默认只列出任务编号、ownerId、项目、路径和大小；`--execute` 也先输出本次清单，再用现有 Trash 移动并返回结果。只选择本机调度器已结束、job 记录有项目且该 owner 下项目已不存在的输出；无项目、排队、运行中、状态未知及无 job 记录的输出（例如开发终端输出）不动。任务记录或项目列表有任何读取不完整时，返回 `SKIPPED`、非零退出码，整次不移动。大小不全以 `complete:false` 标明，完全读不到时为 null。

清单是执行时的当前结果，不保存摘要或放行凭据；两次命令之间有变化时以执行清单为准。原操作 key 派生输出条目的 key，重试不重复入站；按返回的条目 key 用现有项目回收站恢复，7 天后由既有 storage-collect 清理，管理员可提前清空。安装器不会自动执行本命令。
