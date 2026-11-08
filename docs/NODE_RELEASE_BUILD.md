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

## 项目编号记账

数据盘必须开启文件系统的项目配额：ext4 在卸载状态下执行 `tune2fs -O project` 和 `tune2fs -Q prjquota`，挂载选项不变；XFS 用 `prjquota` 挂载。只记账，不设任何限额。未开启的盘在用量里显示“未知”，不显示 0。

每个可记账对象有一个固定编号，登记在 `<root>/quota/ids.json`（服务账户所有，0600，flock 串行分配，从 1000 起只增不复用）。节点在新建时打标（`node/quota-ids.py`，目录设继承标志，文件只设编号）：新项目目录、任务输出目录、个人引擎目录 `.oci/<owner>`、新数据集目录（所有上传、导入、云盘下载、服务器间接收都经 `dataset_root(create=True)`）、复制暂存 `.copies/<key>`（目标项目号）与 `.copy-exports/<key>`（源项目号）。开发容器在 `podman create` 之后、首次启动之前打层：层目录 `graph/overlay/<layerId>/` 本身保留镜像号、不设继承（Podman 删除容器时会把它整体改名进 `overlay/tempdirs`），其下 diff、work、merged 等整层用项目·环境号。每次进入开发容器前读一次 diff/work 的编号，不一致就补打，只修复、不拒绝。打标失败（例如盘未开启）只在 stderr 记一行，用户操作照常完成，相应字节计入“未登记”。

新建数据集的原子发布使用 `<root>/quota/datasets.lock`（容器不可见），沿用项目锁的有界等待；已有数据集不加此锁。容器内对 `/datasets` 的 flock 不影响平台发布新数据集。

继承目录之间改名时编号不同会得到 EXDEV，所以根目录、`workspacesRoot`、`workspacesRoot/<owner>`、`.oci`、各 `.trash`、`root/outputs`、`.copies`、`.copy-exports`、`datasetsRoot`、数据盘挂载点和容器层目录本身都不设继承标志。

安装器把 `node/quota-sample.py` 与 `node/quota-ids.py` 复制为 root 所有的 `/usr/local/libexec/stargate/` 下的副本，并写系统级 `stargate-quota-sample.service`/`.timer`（开机 30 秒后、之后每 60 秒，Nice=19、idle I/O，以 root 只读运行）。它对每块数据盘（同一设备的多个挂载点只算一次）用 `quotactl(Q_GETNEXTQUOTA, PRJQUOTA)` 读出各编号的字节与 inode，原子写入 `<root>/samples/quota.json`（0600，属主为服务账户）。该单元与其他单元一起纳入安装、停止、健康和回退流程，健康判断不变。

`projects.list {includeUsage:true}` 只读样本和登记表：项目行的 `size`、`outputs.size`、`environment.size` 来自编号字节，`complete` 表示该盘有样本且开启记账；顶层 `disks` 按盘列出完整构成（项目、个人镜像、数据集、平台运行数据、外部目录、未归属输出、未登记、文件系统开销，相加等于 `usedBytes`），`checkedAt` 为样本时间，无样本为 null。采样前记录登记表的 `next`，输出和环境的编号在样本缺席且小于 `next` 时用量为 0；项目文件和数据集缺席仍为未知，之后新分配的编号也保持未知。没有 `quota/migrated.json` 时，项目输出与环境显示未知。`projects.quota` 只返回盘容量。`datasets.list` 对已登记的数据集读样本，未登记的仍现场测量。

现有 `7IM` 的每小时 `--storage-collect` 以 nice19/idle I/O 清空过期回收站和暂存，测量各 `.trash` 大小并统计每个项目的任务输出数，原子写入 `<root>/samples/storage-usage.json`；它不再测量项目、输出或环境。回收站条目里容器用户（子 UID）所有的文件，由该账户在已有 Podman 用户命名空间里删除；单条失败只跳过该条，后续条目和统计照常进行。

### 迁移现有数据

开启项目配额并装好新版后，节点维护者以 root 执行（低优先级、幂等，可重复执行，重复执行沿用已分配的编号）：

```sh
python3 -I -B deploy/node/quota-migrate.py --config /etc/gpuq-console/node-install.json --dry-run
python3 -I -B deploy/node/quota-migrate.py --config /etc/gpuq-console/node-install.json
```

`--dry-run` 只打印计划、各盘当前未登记字节和无法判断归属的回收站条目。默认执行全部，也可分组：

- 维护窗口内无任务、终端或 Git 命令时运行 `--only platform`：平台运行数据、个人镜像与容器层、项目、输出、复制暂存和项目/输出回收站，不登记数据集编号。成功后写服务账户所有的 `quota/migrated.json`。
- 恢复平台后运行 `--only datasets`，给活数据集及数据集回收站条目打标，逐条登记编号。编号不同的目录先只设编号、关闭继承；已经是目标编号且继承的目录始终保留继承。处理普通文件后设目录继承，重新发现期间新建的子目录，优先处理新名字并复查被替换的文件，最后重建特殊 inode；首次打标时，子目录只在遍历到时才设置继承，避免尚未访问的目录长期拒绝既有上传提交。数据集之间、项目之间跨编号移动时，`mv` / `shutil.move` 会变为复制后删除，大文件需要额外时间与空间；打标期间，从未走到的目录往已走过的目录移动，可能暂时 EXDEV；设置目录继承与第二遍补打之间也有 EXDEV 窗口，可沿原上传编号重试。
- `--only external` 可在后台运行：外部目录整棵树只设编号、清除继承标志，之后新建文件计入“未登记”，不会给移入外部目录的操作增加编号限制。

路径启动时全部解析为已存在的真实路径；计划若要给受保护根设置继承，工具提示调整配置并拒绝执行。外部目录是不属于平台的数据盘目录与文件（`lost+found`、符号链接和挂载别名除外）。外部阶段给编号 0 的硬链接打号，外部目录之间共享的硬链接归先到的外部编号；数据集可收回登记为外部编号的 nlink>1 inode，对其他数据集、项目等非 0 编号仍跳过并计数，所以 external 和 datasets 的运行顺序不影响数据集归属。datasets/external 都在每条打标前才分配编号，未走到的活数据集继续现场测量；正在 walk 的数据集暂时显示部分大小，遍历完成后才是完整占用。项目、输出、容器层子项、数据集和回收站树里的符号链接、0:0 whiteout、FIFO 以新 inode 原位重建，保留属主、时间和全部 xattr（包括 overlay 属性）；socket 保留并报告数量。替换特殊 inode 前复读 inode/device/ctime；原名已变化就跳过并计数。重跑仅在平台和数据集树内清理 `.quota-<32 hex>` 特殊临时 inode（符号链接、FIFO、0:0 字符设备），层根和回收站等工具暂存位置的目录还须为 root 所有、权限 0700 且只含特殊 inode；同名普通文件及用户目录保留，外部树不清理。SIGTERM/SIGHUP 通过正常退出展开 finally 清理。层根始终保持镜像编号、不继承，根下的特殊项只通过临时继承子目录重建。单个容器层在清单生成后消失会跳过并计数。平台迁移前应停止服务账户的 podman 进程，确保各挂载空间都没有活 overlay。工具每次运行只扫描一次服务账户的非 init 挂载空间，匹配绝对或相对 upperdir 及 merged 挂载点；所有活层都在引擎树中剪枝并计数，归属无法识别或容器列表失败也一样。有活 overlay 就跳过并报告，暂不发布平台迁移标记；停止相关 podman 后可重跑。报告按组列计数，选中而没有条目的组也打印“无条目”。未访问目录在遍历中被改名或移走时，单独报告并提示重跑相应组；最后输出各盘未登记字节，以及前 20 个仍为编号 0 或未完成继承的大目录，已打号的项目/数据集祖先也会继续检查。默认从 `/usr/local/libexec/stargate/` 读取 root 所有的辅助文件，可用 `--node-dir` 指定。


**platform 前停止 OCI 挂载空间（仅维护窗口，无任务、终端或 Git 命令）：**

先以服务账户、各个人引擎已有的参数和环境运行 `podman system migrate`。任务取消后可能留下失效的 conmon 状态，使 `podman stop --all`、`podman system migrate` 报 `conmon exited prematurely`；仅结束 pause 也可能留下其他挂载空间持有者。下面的 root 本机命令先尝试各引擎的 `system migrate`，再结束服务账户中持有该 OCI overlay 的非 init 进程（包括 pause），清理 pause.pid 并等待挂载空间退出。它不清空容器或用户数据：

```sh
python3 -I -B - /etc/gpuq-console/node-install.json <<'PY'
import contextlib, errno, json, os, pwd, signal, subprocess, sys, time
from pathlib import Path
cfg=json.loads(Path(sys.argv[1]).resolve(strict=True).read_text())
account=pwd.getpwnam(cfg['account']);uid=account.pw_uid
ws=Path(next(iter(cfg['profiles'].values()))['workspacesRoot']).resolve(strict=True)
program=Path(cfg['releaseRoot']).resolve(strict=True)/'current/node/personal-oci.py'
stop="""import importlib.util,subprocess,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('oci',sys.argv[1]);oci=importlib.util.module_from_spec(s);s.loader.exec_module(oci)
folder=Path(sys.argv[2])
raise SystemExit(subprocess.run(oci.engine_command({},folder,'system','migrate'),env=oci.engine_environment(folder)).returncode)
"""
for folder in sorted((ws/'.oci').iterdir()) if (ws/'.oci').exists() else []:
    if not (folder/'graph').is_dir():continue
    try:result=subprocess.run(['/usr/sbin/runuser','-u',account.pw_name,'--','/usr/bin/env',
        'HOME='+account.pw_dir,'XDG_RUNTIME_DIR=/run/user/'+str(uid),'PATH=/usr/bin:/bin',
        '/usr/bin/python3','-I','-B','-c',stop,str(program),str(folder)],timeout=120)
    except subprocess.TimeoutExpired:
        print('停止命令超时，继续结束挂载空间持有者：',folder,file=sys.stderr);continue
    if result.returncode:print('继续结束挂载空间持有者：',folder,file=sys.stderr)
init=os.stat('/proc/1/ns/mnt').st_ino;engine=str(ws/'.oci')+'/';victims=[]
for process in Path('/proc').iterdir():
    if not process.name.isdigit():continue
    try:
        owner=next((line.split()[1] for line in (process/'status').read_text().splitlines() if line.startswith('Uid:')),None)
        if owner!=str(uid) or os.stat(process/'ns/mnt').st_ino==init:continue
        if not any(' - overlay ' in line and engine in line for line in (process/'mountinfo').read_text().splitlines()):continue
        victims.append((int(process.name),(process/'comm').read_text().strip()))
    except OSError as error:
        if error.errno not in (errno.ENOENT,errno.ESRCH,errno.EINVAL):raise
for pid,_ in victims:
    with contextlib.suppress(ProcessLookupError):os.kill(pid,signal.SIGKILL)
(Path('/run/user')/str(uid)/'libpod/tmp/pause.pid').unlink(missing_ok=True)
deadline=time.monotonic()+15
while any((Path('/proc')/str(pid)/'ns/mnt').exists() for pid,_ in victims):
    if time.monotonic()>deadline:raise TimeoutError('挂载空间持有者尚未退出：'+str(victims))
    time.sleep(.05)
print('已结束：',victims)
PY
python3 -I -B deploy/node/quota-migrate.py --config /etc/gpuq-console/node-install.json --only platform
```

重跑报告须为“活 overlay 层跳过 0”，且无平台错误或待重跑目录，才会写出 `quota/migrated.json`；仍有活层时按报告继续结束持有者，再重跑 platform。恢复平台后再在线运行 datasets、external 两组。

任务启动前，宿主 runner 在 attempt 控制目录的同级私有文件中保存该次 payload 的确切删除命令，不放进容器可写挂载。正常结束、被杀、启动失败都由 GPUQ 现有 attempt 清理动作按原名字删除容器记录；不扫描其他容器，开发容器和项目文件保留。清理失败沿既有动作重试，单元已卸载也继续清理。

复制的逐文件上传键只由原传输 UUID 和路径确定，不读取或转换旧 `uploadKeys` / `.upload-keys`。旧 FAILED 复制主动续传时会用新键重传原文件；未续传的旧终态记录保持原样。遗留小上传 JSON 和锁文件由安装者一次列清单、经总控批准后处理，不新增迁移或过期回收。

## 安装

调用者负责 SSH/传输；节点本机用 Python 3.10 以管理员权限运行 `python3 deploy/node/install.py <单机包目录或tar包> --config <本机私有JSON>`。
自动安装由强制 SSH 命令调用 `deploy/node/receive.py`：stdin 为未压缩 tar，根目录包含 `install.py` 和 `package/` 单机包；在 `/var/tmp` 临时解包后调用安装器，输出其 JSON/退出码，临时文件自动清理；默认私有配置 `/etc/gpuq-console/node-install.json`，可由节点安装者通过 `--config` 指定。
私有配置结构见 [config.example.json](../deploy/node/config.example.json)：account、releaseRoot、dataMountPoints、gpuq、profiles、authorizedKeys（每条显式写 profile）、services；数据盘列表由顶层统一填入各 profile，真实值只留节点。
安装器写 policy.json、完整 profile 配置和服务/定时器；已有 ExecStart drop-in 可在对应 service 的 dropin 字段指定，无指纹或历史内容核对。
安装器只为 account 对应的 `user@UID.service` 配置 cpu/cpuset/io/memory/pids 委托并 daemon-reload，不重启已在运行的用户管理器。任务和开发终端共享可用 CPU；GPU 不参与 CPU 或内存额度计算。配置了 `memoryPool` 时，安装器同步共享 slice 的总上限和任务归属，在重新启动调度器前放宽现役任务的内核限制，并把未结束平台任务的执行器引用更新到 `current/node/oci-runner.py`，确保排队和重排不会带回旧资源限制。只改平台包装入口，原任务编号、排位、状态、提交键和用户训练命令不变，运行中进程继续使用已加载的执行器。已有线程池和启动时资源快照由应用在下次启动时更新；回退指针也供待启动任务使用，不主动收紧已放宽的运行中任务，以免触发 OOM。
平台包装入口按平台标记和发布目录识别，解释器路径保持不变；GPUQ 将 Python 符号链接解析为实际路径，不影响排队入口更新。
每版使用独立的真实 pyz 路径；current 原子切换后只重启受管服务，独立任务单元、旧发布目录和数据库保留；仅新库初始化。
健康仅看服务 active 和 GPU 可读；失败时即使新单元损坏或停止失败，也先恢复旧文件和指针，再重启原先活跃的服务。`python3 deploy/node/install.py --config <私有JSON> --rollback` 回上一版，不回滚用户数据。
灰测的 `deploy/gray-local/node-setup.sh` 生成模拟配置并调用同一安装器；私有配置保持 0600，模拟 CDI 规范为 0644，供非 root 任务读取，不另写安装流程。灰测节点的 /data1、/data2 是开启项目配额的回环 ext4/XFS，G16 在其上核对打标、采样、容器层、清空带容器的项目和迁移工具。
灰测节点启用共享内存池，覆盖 slice 配置、在线上限更新和真实任务启动；共享 slice 沿用内核默认的 `memory.oom.group=0`，不使用不存在的 systemd `MemoryOOMGroup` 属性。
放宽运行中容器的 cpuset 时写入父级完整有效 CPU 集合，不向已有进程的集合写空值；部分内核会以 ENOSPC 拒绝后者，该错误不表示数据盘已满。
