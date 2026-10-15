# GPUQ 当前入口

GPUQ 源码来自现役 a314 型协调器。节点使用系统 Python 3.10；任务环境来自 OCI 镜像。发布包由 `scripts/build-node-release.py` 读取当前源码构建，所有机器用同一份代码。

| 功能 | 入口 | 回归 |
|---|---|---|
| 调度、优先级/FIFO、抢占、指定 GPU、弹性、资源收尾 | `gpuq/coordinator.py`、`policy.py`、`sharing.py`、`hami.py` | `tests/gpuq-priority.test.py`、`gpuq-cancel-draining.test.py`、`gpuq-cgroup-descendants.test.py` |
| 原 key 提交、SQLite 事务、日志与分配历史 | `store.py`、`submission.py` | `tests/gpuq-allocation-history.test.py`、`gpuq-friction.test.py` |
| 标签与显示名、状态/日志查询、取消/重试 | `cli.py`、`job_display.py`、`protocol.py`、`rpc.py` | `tests/gpuq-job-display.test.py`、`gpuq-protocol.test.py` |
| SDK 进度、epoch checkpoint、重跑路径、batch 计算 | `progress.py`、`checkpoint.py`、`elastic.py` | `tests/gpuq-friction.test.py`、`gpuq-priority.test.py` |
| 多机队列、原编号等待与重试 | `cluster.py`、`cluster_node.py`、`fleet.py` | `tests/gpuq-friction.test.py`、`gpuq-generic.test.py` |
| 显式普通文件传输、dry-run、部分文件续传 | `sync.py`；平台目录传输仍为 `node/transfer-jobs.py` | `tests/gpuq-generic.test.py`、`gpuq-friction.test.py` |

组件忽略不认识的字段；当前操作读取真实 GPU/systemd/cgroup 状态。初始化直接创建当前数据库结构，已有当前格式数据库直接读取，不修改用户数据。

原 key 用于提交去重和传输锁命名；SQLite 事务及 GPU/显存预算维持任务与资源状态。进度只作观察，checkpoint 保存失败仍如实返回失败，不能把未知状态报成完成。`yield=legacy` 是当前可选的调度策略值，`compatible_world_sizes` 是 batch 数学函数，两者均非旧平台适配。

普通文件传输直接执行，支持显式 dry-run 和 partial 续传。任务通知走 Portal `notifications.job`/`job-notifications.mjs`，CLI 入口为 `gpuctl notify`。

## 更新时的运行中任务

`daemon.py` 停止时只关闭 RPC、线程、数据库与 daemon 锁；任务由 `backends.py` 启动为独立 systemd user unit。新 daemon 从同一数据库读取原 attempt 与租约，按当前 unit/cgroup 状态继续观察。

升级时把新 pyz 安装到新的发布目录，既有 `archive_path`/`gpuqArchive` 和启动入口定位新发布；运行中任务继续使用原路径。使用 HAMi 的节点也把既有 `hami/libvgpu.so` 独立复制到新 pyz 相邻目录，不改旧库。Python zipimport 后续导入仍会按路径重开 pyz，因此保留旧发布目录和任务的只读运行时副本，不覆盖其文件。只重启 GPUQ daemon，不停止任务 unit、容器、workload slice 或 user manager；同一数据库/socket 始终只有一个 daemon。所有节点按同样步骤升级，无需等待运行中任务结束；由指定安装者在总控批准后执行，并核对重启前后运行中任务的 unit 与 PID 不变。

本地 SQLite/SDK/字节回归不能代替真实 systemd、NVIDIA/HAMi、跨机网络和灰度安装；发布与回退仍由指定发布者、安装者执行。
