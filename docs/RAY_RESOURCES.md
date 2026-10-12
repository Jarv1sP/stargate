# Ray 与任务资源预算

本页适用于启用完整 Ray 资源适配的节点。每台节点须验证实际内核配额；只通过本地单元测试，不能代替真实多卡作业验收。

安装器默认 `--runtime-profile common-p0`，提供终端隔离、诊断与项目工具，不启用本页资源预算，也不要求新增 CPU 委派。仅在节点已获批准且内核检查通过后，显式选择 `--runtime-profile ray-p0` 才安装完整 Ray runner 和适配器。不同节点可选择不同档位，不能把一台的验证结果当成所有节点已启用。

## 预算发现

普通训练仍使用原命令。启用共享内存池的节点不按 GPU 张数切分内存：单卡、多卡和开发终端共用节点的工作负载内存池，用多少占多少。`gpuctl run --memory-limit-gib 60 ...` 可主动限制本任务；不填则最高可用到池上限，但不代表预留或当前可用量。池满时仍可能触发 OOM，不能保证所有任务同时用满。

CPU 仍为每卡 4 核**时间额度**，开发终端 2 核；每任务最多 2048 个 Linux tasks。旧节点未配置共享池时保留原 32 GiB/卡、终端 8 GiB 的限制，不能仅靠升级客户端获得共享内存。CPU quota 不是独占核心或 CPU affinity，`os.cpu_count()`、`/proc/meminfo` 仍可能显示宿主硬件。

### 部署共享池

先将 `deploy/gpuq-workloads.slice` 安装到服务用户的 systemd 单元目录，将 `deploy/gpuq-workloads-service.conf` 安装为 `gpuq-.service.d/shared-memory.conf`。将 `deploy/gpuq-control-service.conf` 分别安装为 `gpuq-diag-.service.d/shared-memory.conf`、`gpuq-diagnostics-gc.service.d/shared-memory.conf`、`gpuq-storage-gc.service.d/shared-memory.conf`；核对本机其他同前缀控制服务也留在池外，再执行用户级 daemon-reload。调度器 `gpuq.service` 不匹配该前缀。普通终端由节点显式选择该 slice，宿主 root 终端不加入。池默认上限为物理内存 90%；这是任务池的总限制，不是每个任务各自预留 90%。

节点 `memoryPool` 配置包含实际池 `cgroup` 路径和允许的最高整数 `maxBytes`。启动时核对任务确在池内、池有有限且不高于配置的硬上限；未正确安装时拒绝新任务，不静默取消保护。滚动部署可以暂时收紧池总上限，不把临时值固化成每个新任务的永久限制；后续扩回池容量无需重启这些任务。每任务的有限上限保留给 OCI 与资源发现，上级池限制所有任务合计。Ray 的逻辑预算同样不是预留，多个 Ray 集群应自行设置较小的任务上限。

已有运行任务不能通过修改 Slice 原地迁移。滚动部署必须核对旧任务的有限上限，为池外旧任务扣留相应容量，再启用新节点配置；不要直接给混合版本主机套用 90% 示例。不停止或重启旧任务，不把配置完成冒称旧任务已经迁入；无有限上限的旧任务需要先单独处理。全部旧任务结束后再恢复完整池容量。

回滚时先恢复新任务的运行器/配置入口；已有池内任务仍须保留原 slice 和限制直到结束。不要停止或删除仍有任务的 slice，也不要把池上限调到当前占用以下，否则可能触发 OOM。

任务可读取只读 `/run/gpuq/resources.json`，或以下环境变量：

| 字段 | 环境变量 | 含义 |
| --- | --- | --- |
| `cpuLimit` | `GPUQ_CPU_LIMIT` | 实际 CPU quota、上级限额与 affinity 数量的最小值 |
| `memoryLimitBytes` | `GPUQ_MEMORY_LIMIT_BYTES` | 实际内存硬上限、上级上限与宿主物理内存的最小值 |
| `pidsLimit` | `GPUQ_PIDS_LIMIT` | 实际任务数上限，包含线程 |
| `gpuCount` | `GPUQ_GPU_COUNT` | 调度器本次分配的 GPU 数量 |
| `gpuUuids` | — | 本次分配的 GPU UUID |

`GPUQ_RESOURCES_FILE` 指向上述 JSON。预算是启动时快照，不代表上级共享资源已独占预留。runner 在用户代码执行前设置并读回限制；缺失或大于请求的硬限制会拒绝启动。

沙箱 `/sys/fs/cgroup` 只读映射当前任务的真实 cgroup，不再映射宿主层级根。因此读取根 `cpu.max`、`memory.max/current/stat` 的 Ray 能识别任务本身限制。上级更紧的限制已计入 JSON，显式适配器使用这一更保守预算；只读 leaf 文件本身仍如实反映内核 leaf 限制。不要给 Ray 写 cgroup 的权限，也不要开启要求 cgroup 写权限的 `enable_resource_isolation`。

## 安装前的 CPU 委派检查

`CPUQuota=` 出现在 systemd 配置中，不等于内核已经执行。Ubuntu 22.04 / systemd 249 的 `user@.service` 可能仅委派 `memory pids`，此时用户任务没有 `cpu.max`。安装程序选择 `--runtime-profile ray-p0` 时，在替换 runner 前运行一个非 GPU、最多 10 秒、1 核 / 128 MiB / 32 tasks 的探针；缺少真实限制就停止，保留现有 runner 和调度器。

安装时显式添加 `--configure-cpu-delegation` 才会请求管理员权限，为当前服务 UID 的 `user@UID.service` 写独立 drop-in，保留现有委派项并补 `cpu memory pids`，备份之前的同名文件，然后仅执行系统级 `daemon-reload`。它不扩大控制台 sudo 权限，不重启服务，也**不会自动 reexec 活跃用户管理器**。可独立运行服务用户检查：

```sh
python3 deploy/cpu-delegation.py --check
```

systemd 249 的活跃 user manager 缓存可用控制器；普通 `--user daemon-reload` 不刷新该缓存。经管理员确认维护窗口后，最小原位流程是：保存相关 unit 的 PID / InvocationID、现有 drop-in 和 CPUWeight；加载仅特定 UID 的委派文件；系统管理器以原 CPUWeight（未设置时等价 100）执行 `set-property --runtime user@UID.service CPUWeight=...` 触发祖先控制器配置；确认该 user@ cgroup 的 `cgroup.controllers` 已含 `cpu`；再由服务用户执行 `systemctl --user daemon-reexec`，最后运行上述探针并对比 PID / InvocationID。不要执行 `restart user@...`、GPUQ 重启或手写 cgroup 文件。reexec 不是服务重启，但旧服务原来未执行的 CPUQuota 可能开始生效，故不能未经确认批量推广。

每台节点都应独立验证；无 GPU 限额探针通过不代替下方真实八卡验收。依据：[systemd 249.11 管理器重新加载实现](https://github.com/systemd/systemd-stable/blob/v249.11/src/core/manager.c)、[控制器初始化及实现](https://github.com/systemd/systemd/blob/v249/src/core/cgroup.c)、[daemon-reexec 官方语义](https://github.com/systemd/systemd/blob/v249/man/systemctl.xml)。

## 可选 Ray 适配器

任务内可执行：

```sh
gpuq-ray resources
gpuq-ray init-kwargs
gpuq-ray exec python train.py
gpuq-ray start --block
```

`exec` 保持原 Python 程序与参数，不修改 `ray.init`，只对这个进程树设置 Ray RPC/worker 线程池为 2、关闭预启动空闲 worker，BLAS/OpenMP 线程为 1，并清除宿主 CPU 检测绕过、外部集群地址和资源覆盖变量。项目 Python/环境选择不变；普通命令没有这些线程配置。应用可根据其 actor CPU 配额进一步调整计算线程。

需要明确资源数量时，在通过 `gpuq-ray exec` 启动的程序内使用：

```python
import json, subprocess, ray
options = json.loads(subprocess.check_output(["gpuq-ray", "init-kwargs"], text=True))
ray.init(**options)
```

适配器明确传入 `num_cpus`、`num_gpus`、`object_store_memory` 与 Ray 既有私有参数 `_memory`。对象存储默认 `min(20% 内存, 8 GiB)`，另留 `max(10% 内存, 512 MiB)` 给运行时，剩余是逻辑 worker memory；不关闭 Ray 内存监控。`start` 对应本机 head，只接受 `--block`、`--verbose`，不能用重复/缩写参数改写预算。CLI `--memory` 和 Python `_memory` 属于 Ray 私有兼容接口，升级 Ray 后需重新验证。线程环境项按 Ray 2.58.0 官方源码核验；未在旧版本编译的环境项会被忽略。

Python 参数和 CLI 的 CPU 数量均使用真实 `cpuLimit` **向下取整后的整数**；不足 1 核拒绝启用 Ray 配置，不会向上补额度。只读预算 JSON 仍保留真实的分数 CPU quota。Ray 2.58 可能把 `num_cpus=32.0` 直接转成 raylet 的 int32 `maximum_startup_concurrency` 参数而启动失败，因此即使整核额度也必须输出整数 `32`，不是浮点 `32.0`。

Ray 资源是逻辑调度额度，不能替代内核限制。actor 应显式声明 `num_cpus` 和 `num_gpus`；默认 actor 不持续占 CPU 调度额度，仍可能无限制造进程。GPU 检测也不要只依赖 NVML 宿主设备数量，显式参数使用实际 `gpuCount`。适配器不改变原有 CUDA 可见性规则。

诊断可用时，默认 Ray 临时目录为 `/run/gpuq/runtime/ray`，只映射当前任务当前 attempt 的私有目录；输出和报告不暴露其他任务。`gpuq-ray exec` 恢复这一受管默认；用户随后显式设置其他 `RAY_TMPDIR` 或 `_temp_dir` 会脱离受管日志采集，不会扫描任意宿主 `/tmp`。

持久诊断不应接收大体积 object spill。Ray 2.58 适配器的 Python 参数 `object_spilling_directory`、CLI `--object-spilling-directory` 和环境默认 `RAY_object_spilling_directory` 均指向 `/tmp/gpuq-ray-spill`；启用受管 runtime 的普通命令也得到这一环境默认。这里是既有任务私有 tmpfs，仍受同一内存额度限制、退出自动回收，不是新的持久磁盘配额。显式应用配置可以覆盖环境默认，因此不能把它当作防止任意用户写满工作区的安全边界；受管原始 runtime 也需要独立结束后清理策略。

## 验证边界

`python3 tests/job-resources.test.py` 是不使用 GPU/网络/systemd 的隔离回归。`tests/ray-eight-gpu-probe.py` 是手动验收 payload，**不能在宿主直接运行、不能加入 CI**。由管理者在确认空闲并获准的八卡机器上，经正常队列提交 `gpuq-ray exec python -c <payload>`，复用目标只读 release 环境；它检查自动检测、显式预算、8 个独立 actor 的小 CUDA 运算与 PID/OOM 事件，并写任务独立输出。任务退出后还需外部核验 GPU 与进程已释放。

官方依据：[Ray 逻辑资源](https://docs.ray.io/en/latest/ray-core/scheduling/resources.html)、[Ray 2.58.0 容器资源检测](https://github.com/ray-project/ray/blob/ray-2.58.0/python/ray/_private/utils.py)、[Ray 2.58.0 线程配置](https://github.com/ray-project/ray/blob/ray-2.58.0/src/ray/common/ray_config_def.h)、[Linux cgroup v2 限额与 PID 控制](https://docs.kernel.org/admin-guide/cgroup-v2.html)。
