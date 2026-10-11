# 项目、环境与训练版本

项目的开发草稿属于「平台账号 + 指定服务器」。网页从「我的项目」选择个人容器，无需先选顶栏服务器；新建时只采用节点为本人确认的个人容器能力，并显示实际开发位置。切换顶栏服务器不搬迁或清空当前个人容器。共享/隔离环境和个人工作区仍明确选择服务器。已发布的个人容器项目可使用自动选机，或复制固定发布版本到另一台已授权服务器。浏览器和 CLI 共用账号权限，通过 HTTPS 操作，用户电脑不需要加入 Tailscale。

本页描述项目接口及操作约定，不代表任一现有部署已经升级；管理员需部署配套门户与节点版本后再开放。原 GPUQ 任务与旧工作区保留。Slurm/Pyxis/Enroot 的迁移不因项目接口加入而自动完成，当前不能据此宣称已经切换调度后端。

## 日常最短流程

安装并登录一次后：

```sh
gpuctl use gpu-1
gpuctl project create experiment-a
gpuctl push .
gpuctl ssh
```

新项目统一创建个人容器，不需要环境模式参数。开发终端进入容器代码目录，安装 Linux 端依赖：

```sh
python -m pip install -r requirements.txt
exit
```

回到自己电脑：

```sh
gpuctl project publish
gpuctl project status
# 核对需要的版本 READY 后
gpuctl run -g 2 -- python train.py --output /outputs
gpuctl logs 任务ID
gpuctl pull --job 任务ID model.pt ./model.pt
```

`--output` 属于示例程序参数，不是平台必需参数；按训练代码修改，最终产物应写到 `/outputs`。日后修改代码或依赖，只需更新草稿、重新发布，然后运行；不必重建项目或账号。

## 路径与隔离

| 作业内路径 | 开发终端 | 训练任务 |
|---|---|---|
| `/workspace` | 本项目草稿代码，可写 | 指定发布版本代码，只读 |
| 镜像内 Python/Conda | 本项目容器环境，可安装依赖 | 指定发布镜像中的环境 |
| `/home/gpuq` | 本项目个人目录 | 本次任务独立 HOME |
| `/outputs` | 开发 scratch，不是训练结果 | 本次任务独立可写结果目录 |
| `/data2/数据集名称` | 默认不挂载 | 显式授权、READY、租约保护的只读本地副本 |

新项目使用容器自己的 Python/Conda，不挂载或继承宿主基础 Conda。依赖安装应在开发终端完成，不在占用 GPU 的训练启动命令里临时安装。以下 venv 说明仅用于识别历史 shared/isolated 项目，不是新项目选项。

项目环境、HOME 缓存和输出使用平台工作区磁盘；沙箱 `/tmp` 与默认受管 Ray spill 使用 tmpfs，计入内存限制。项目训练的 `/workspace` 只读，需要较大磁盘临时空间时，可在训练程序启动时创建本次任务的 `$HOME/.cache/tmp`，并在程序内将 `TMPDIR` 指向它；只在提交命令的本机终端设置变量不会自动传入任务。开发终端也可用私人 HOME 作为 pip 构建临时目录。此设置不改变 Ray spill 的独立配置；磁盘入口预留不是硬配额，仍须关注剩余容量并清理不再需要的临时文件。

历史 isolated 项目不使用 `--system-site-packages`；shared 项目继承只读基础 Python 包。这是 Python 依赖继承差异，不表示不同账号共享可写代码或 HOME。公开新建入口不再接受 shared/isolated，旧客户端也不能绕过；底层兼容仅供已有资料与管理员迁移使用。

模式仅创建时设定。旧项目/旧版本缺少模式字段时继续按共享模式处理，历史版本哈希不改变；同名项目显式指定另一模式会报错，既不重装也不迁移。已有环境不自动重建，首次初始化失败留下的非空目录需先检查，或另建项目。旧节点不支持新选项时应升级配套节点，不能静默将 isolated 降级成 shared。`project status` 返回 `environmentMode` 和离线资源约定路径。这里的“完全隔离”只指不继承 Python site-packages，不是阻止用户代码显式访问只读基础路径的安全边界。

项目 venv 与代码被冻结到版本，不覆盖其他账号/项目的环境。venv 依赖同机基础 Python 和系统库；记录基础环境指纹不等于封装基础镜像全部字节，也不能保证宿主机升级后仍 bit-for-bit 可复现。该发布机制不是容器镜像，也不支持把 Mac venv 直接拿到 Linux 运行。

### 个人 OCI 环境

管理员完成 rootless OCI 验收并显式启用后，获准账号直接新建 `gpuctl project create system-env`。省略模式固定为 OCI；兼容显式 `--env-mode oci`，但无须使用。未启用节点或未获准账号会被拒绝，不会静默改用 venv。现有 shared/isolated 项目不转换、不重建旧环境；已有资料与历史结果保留，管理员宿主机 root 入口保持独立。

OCI 开发终端内是容器 root，可安装容器系统包（例如基础镜像支持时使用 apt），不是宿主机 root：没有宿主机 Docker/Podman socket、宿主目录、宿主网络或 GPU。代码仍在 `/workspace`，私人 HOME 在 `/home/gpuq`，开发 scratch 在 `/outputs`；使用镜像自己的 Python/Conda，不再挂载宿主 `/opt/conda` 或项目 venv。每个账号的镜像、构建临时数据与可写层独立存放在数据卷。

容器隔离与磁盘硬配额是两件事。面向不限定账号的启用方式要求已验收的内核硬配额，受管可写数据计入账号的硬上限。管理员也可通过明确的 `personalOci.owners` 名单进行有限范围验收，而暂不启用硬配额；此时容量入口检查不等于写入硬限制，名单内用户仍可能写满共享数据卷。必须先接受并管理这一存储风险，不能对用户宣称“已限制每人磁盘容量”。无论是否启用硬配额，容器、账号目录和调度器分配 GPU 的隔离要求都不降低。实际部署范围见 [后端验收记录](BACKEND_ACCEPTANCE.md)。

退出开发终端后再发布。发布将停止态开发容器提交成不可变镜像 ID，与代码快照共同绑定版本；重连开发终端沿用上次环境。未知容器状态/发布失败应保留现场核查，不自动创建替代环境。训练使用该发布镜像和只读代码，HOME/输出仍按任务隔离；训练临时镜像层不写回开发环境。GPU 只注入调度器本次分配的精确 UUID，开发终端不因安装 CUDA 获得 GPU。CPU、内存、PID 与取消继续由既有任务单元约束。

OCI 的 `/tmp` 默认属于容器可写层，和 venv 沙箱的 tmpfs 不同；启用硬配额时计入账号磁盘用量，未启用时没有个人磁盘硬上限。两者都应将需要持久保留的大文件写到明确的 HOME/输出位置。基础镜像只允许管理员固定的 digest，不接受客户端提交宿主路径、设备、特权参数或任意引擎配置。GPU 驱动或 CDI 描述变动后需管理员重新验收固定依赖，不能回落到全部 GPU。

开发环境重连前会提交上次停止的容器层，因此大环境可能需要较长时间和临时磁盘空间。受管镜像提交、拉取和导出使用账号数据卷内的私人临时目录，不把完整镜像层放在内存盘；终端仍保留原 CPU、内存与 PID 预算。失败时保留原容器和镜像身份，不会自动新建替代环境或删除已安装的依赖。

## 整理项目：名称、归组、归档与退役

网页在工作台的「整理项目」入口操作。显示名称可以中文；CLI 和历史链接继续使用
原内部项目 ID。一个逻辑项目可归组多台机器的实例并指定主实例，但不会搬移环境、
合并结果或让不同机器共享可写容器。查看跨机项目时，离线节点明确显示未确认。

```sh
gpuctl project label --display-name "机器人插入实验"
gpuctl project catalog --full
gpuctl project group GROUP_UUID --display-name "机器人实验" --members SERVER_A/project-a,SERVER_B/project-b --primary SERVER_A/project-a --revision 0
gpuctl project archive
gpuctl project unarchive
gpuctl project retire-plan
```

归档保留版本、任务和结果；原已确认提交的任务不被停止，新编辑、终端、发布和训练
被拒绝，恢复项目后可继续。状态未知的写入／同步／导入／发布必须先用原编号核对。
想暂时停止开发可归档；已结束的任务历史不会阻止退役。逻辑组成员可移除；空组用于解除最后成员，
CLI 用 `--members none`，仍须提供该组当前 revision。

未完成的代码同步可先查原同步编号，再显式取消：

```sh
gpuctl sync status ORIGINAL_UUID --to SERVER --project PROJECT
gpuctl sync cancel ORIGINAL_UUID --to SERVER --project PROJECT
```

取消固定原账号、目标项目、快照、来源与状态摘要；只允许没有任务历史和活动／未知
读写者的草稿。未结束的文件上传等仍需先按其原编号收尾，不会替你停止终端或训练。
确认 `CANCELED` 后，部分代码、原始清单和回执原样保留，但该同步编号永久不能续传。
仍可保留草稿整理代码，或读取新的退役计划后软退役；取消不是删除。丢失响应只查询
原同步编号，不换 key 重传。旧节点没有取消协议时明确拒绝，不能手动改成 `CODE_READY`。

软退役只被进行中或待确认的任务、活动读写者和复制租约阻止；已结束的作业和 run claim 保留为历史。
项目及输出移入保留区，不立即清除。读取 `retire-plan` 的摘要与 revision 后：

```sh
gpuctl project retire --key RETIREMENT_UUID --revision PLAN_REVISION --manifest-sha256 FULL_PLAN_SHA256
gpuctl project retire-status RETIREMENT_UUID --project ORIGINAL_PROJECT_ID
```

节点对完整目录做 CAS，再原子移到本人私有同盘回收区；字节保留，不永久清空，不复用
旧 ID。OCI 外部镜像存储也保留，不因项目整理删除。计划后内容变化、租约／读写者未确认
或系统不支持原子 no-replace 时拒绝。回执丢失查原 UUID；`RETIRING` 保留围栏，由运维
核查，不自动重发或新建替代项目。仅安装网页／CLI 不代表节点已部署配套生命周期 helper。

## 显式离线资源，不继承开发缓存

`/workspace/offline` 是代码树内可发布的普通目录，环境变量 `GPUQ_OFFLINE_ASSETS` 指向它；平台不会自动下载、联网安装、收集 HOME、读取开发登录 token 或复制隐藏缓存。开发 HOME 与每次训练 HOME 不同；训练不能依赖开发时的默认 Hugging Face、Torch 或 pip 缓存。只有明确放入代码树的文件随发布快照进入训练，请先检查其中没有凭据。个人模型权重、配置和 tokenizer 放在项目的 `weights/`、`models/`、`tokenizers/` 或 `offline/` 中，随项目版本使用；不为这些文件另建数据集。离线资源计入项目容量警告和文件数检查；训练、验证和测试样本才使用数据集渠道。训练新产出的权重写入 `/outputs`，不会自动修改已发布的代码版本。

需要离线安装依赖时，在有获准网络访问的**该服务器项目开发终端**中显式准备 Linux wheel；不会因本文自动执行下载：

```sh
mkdir -p /workspace/offline/wheels
python -m pip download --only-binary=:all: --dest /workspace/offline/wheels -r requirements.txt
python -m pip install --no-index --find-links=/workspace/offline/wheels -r requirements.txt
python -m pip check
```

请固定依赖版本；若使用完整带哈希的锁定文件，两条 pip 命令可再加 `--require-hashes`。缺少兼容 wheel 时立即失败，不在 GPU 任务启动时临时构建/下载。不要把 Mac wheel/venv 当 Linux 环境；若从外部准备文件，必须匹配目标 Linux、Python ABI 和 CUDA 依赖。安装与验证成功后结束项目终端、发布快照；训练直接使用已发布环境，不再运行 pip。

模型文件同样显式准备到 `/workspace/offline/models/模型名/`，需要配置、权重、tokenizer 等完整文件。可在获准联网的开发阶段用已安装模型工具下载到该目录，或将已取得且许可允许的文件上传到这里；不要把 `$HOME/.cache` 整目录复制进去。训练代码使用目录路径并禁用自动下载，例如已使用 Transformers 的项目：

```python
from transformers import AutoModel, AutoTokenizer
model_dir = "/workspace/offline/models/my-model"
tokenizer = AutoTokenizer.from_pretrained(model_dir, local_files_only=True)
model = AutoModel.from_pretrained(model_dir, local_files_only=True)
```

调用训练前可显式设置 `HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1`，但这是 Hugging Face 库的离线开关，不是全进程网络隔离。其他库也须传入明确本地路径并关闭各自下载行为。运行时新缓存写本任务 `/home/gpuq/.cache` 或 `/outputs`；快照内 offline 只读，不能用作需要写锁/临时文件的运行缓存。发布前在未登录、无开发缓存的新 HOME 下做一次小规模离线加载验证；平台不会把开发 token 带入训练来补救缺失资源。

## 命令与选择规则

网页上传项目代码时先查询同一路径、大小和完整 SHA 的上传记录，选择同一文件可接着上传原编号的已确认进度；刷新后需要重新选择本机文件。丢回执最多三轮查询原编号再续传，已完成不重传，尚未收口只提交原编号的空 final 块。旧记录、冲突或无法确认时保留原上传，不能从零另开；网页仍限单文件 100 MiB，较大文件用 CLI，传统个人工作区行为不变。

| 命令 | 行为 |
|---|---|
| `gpuctl project create NAME` | 在已开通机器创建并选中个人容器项目，可在容器内安装系统包 |
| `gpuctl project use NAME` | 核验项目存在后选中 |
| `gpuctl project list` | 查看当前机器的个人项目 |
| `gpuctl project status [NAME]` | 查看草稿/发布状态、READY 版本 |
| `gpuctl project publish [NAME]` | 后台冻结代码和环境，返回状态；不占 GPU |
| `gpuctl project import SOURCE [DEST]` | 同机个人数据目录复制到项目草稿的新目录；字节不经门户 |
| `gpuctl project import-status UUID` / `import-cancel UUID` | 查看本次导入／请求停止；未知结果仍保留围栏 |
| `gpuctl project uploads` / `upload-cancel UUID` | 查看／取消精确未完成上传；不删除草稿或发布版本 |
| `gpuctl files [目录]` | 浏览本项目代码 |
| `gpuctl files --job UUID [目录]` | 浏览本项目该任务输出 |
| `gpuctl pull --job UUID 远端文件 本地文件` | 下载指定任务产物 |

项目名只用小写 ASCII 字母、数字、下划线、连字符，以字母开头，长度 1–48。机器和项目选择保存在本机登录缓存中，按服务器分别记忆；切到没有选过项目的新服务器时不会沿用另一台的项目。可用 `--project NAME` 临时覆盖，不修改记忆。登录另一账号会清除旧身份的选择。

项目名也是已有环境、版本和训练结果的身份，不能通过移动项目目录改名；这会破坏绝对路径和原结果引用。显示名、逻辑归组、归档与安全退役见上节，均保留内部身份。原生 GPUQ 身份围栏修改任务显示名后，配套升级的门户会在队列与任务列表采用相同标签，仍保留原任务 ID 和执行规格；它不等于项目已经物理归并。需要整理旧项目时，不能靠新建重复容器或裸删目录替代生命周期接口。

普通 `run` 选择 `latestReadyRelease`，并核验该版本在 READY 清单中。顶层 `PUBLISHING` 不会阻止使用以前的 READY 版本，因此想运行新改动时务必先核对最新发布结果。`--release 完整64位哈希` 可显式固定版本。没有可用版本时清楚报错，普通 `run` 不会自动替用户发布、切机或占卡等发布。

发布回执同时绑定项目 UUID 和本机代际；同一账号重建同名项目不会继承旧失败、发布结果或迟到 worker 的写入。历史回执原样保留，旧代际可以核验的记录继续兼容；无法确认所属项目的旧记录只显示 `UNKNOWN`，核清前不允许编辑或发布。旧项目只在明确发布时补入持久 UUID，状态读取不改项目元数据。

### 上传锁与单文件下载恢复

项目操作取得原私人锁时最多等待两秒；竞争仍未结束会明确返回 busy。只重试取得锁，不重放写入，也不自动删除上传记录。上传丢回执继续查询原 uploadId，再按已确认偏移恢复；权限、所有者、软链接和发布检查不因锁竞争而放宽。

配套新版 CLI 与实际节点文件读取回包确认 `protocol:2` 时，`pull` 才支持断线后重复原命令续传；仅合并源码、更新 CLI 或门户不构成节点能力证明。本地目标旁的 `.gpuctl-download.json` 记录服务器、账号、机器、项目/任务、远端路径、源指纹和已落盘前缀 SHA256；恢复前核验本地文件与原源；完成前重新读取本地全文件核对实际落盘 SHA256，失败保留文件及回执。保持原目标和回执，不能改账号、项目、服务器或源文件后接着写。没有匹配回执的已有文件不会被覆盖；本地文件或源发生变化时保留片段并明确拒绝续传。旧节点仍可从头下载到新文件，但不提供此恢复能力。

`files.get`/`files.list` 使用有界读取通道，读取前后都检查当前会话、账号、机器权限和维护状态。临时 502/503 可在读取截止内重试同一偏移；写入和终端不会因此自动重放。每块来源身份使用 stat 指纹，不是整份远端文件内容哈希；单次中断发生在落盘与回执更新之间时可能拒绝恢复，须保留现场核查，不能自动截断或采用无回执片段。

## 同机导入已准备的代码和资源

已在服务器**本人个人数据区**准备好的普通目录，无需再经过自己电脑和门户逐块上传：

```sh
gpuctl use gpu-1
gpuctl project use experiment-a
# SOURCE 是个人数据终端 /data2 内的相对目录；DEST 是项目 /workspace 内的新目录
gpuctl project import staging/code incoming
gpuctl project import-status 上一步打印的UUID
```

源目录与项目必须在同一台已授权服务器、属于同一平台账号。目标须不存在，父目录须已在草稿中创建；不合并、不覆盖原目录。只有 `IMPORTED` 且 `draftChanged:true` 才确认导入完成，随后在项目终端调整代码或依赖，主动 `project publish`；不会发布环境、复制开发 HOME 或提交训练。既有 READY 版本、结果和固定版本任务不变。

先结束项目和个人数据区的全部终端，断开不等于结束。启动前持久围栏保护两端，后台扫描、复制、完整 SHA256 及源变化检查后原子提交。仅接受普通目录和单链接普通文件；软/硬链接、特殊文件、秘密与环境/缓存目录拒绝。代码执行位保留，其他权限标准化为私人目录/文件；项目条目限制、磁盘预留和已启用内核配额仍有效；项目字节量超过警告阈值不阻止导入。

**不接受任意宿主路径**，旧 `/data1/某用户/...` 不能直接传入。管理员须先核实所有权，将所需文件整理到该账号个人数据区；只读数据集、他人工作区和宿主目录不在允许范围。旧未完成项目上传可用 `project uploads` 发现 UUID，再 `project upload-cancel UUID`，不需要原本本机文件。配套节点可取消只含原四个身份字段、片段明确未达到声明大小且没有同编号完成回执的旧记录：先永久封住原 UUID，再将原登记和片段原子移入私人回收区，全部字节保留，不动完整草稿或发布版本。中断后只继续同一 UUID 的取消；原 UUID 不能继续上传。全尺寸、缺失片段、COMMITTING、目标变化或未知身份仍保留检查，不因旧格式自动放行。

响应丢失或 `UNKNOWN` 时只查原 UUID，不换 key 重发。`import-cancel` 仅在确认整组停止且未进入提交时清理本次私有临时目录，不动源数据；提交后回执不明仍保留围栏，不猜取消成功或重做。完成后源目录仍保留供用户自行管理。

## 可选的自动选机与固定版本复制

先在开发服务器创建、安装依赖并发布 **OCI 个人容器** 项目。保持当前 `gpuctl use` 和 `project use`，提交时只增加一个选项：

```sh
gpuctl run --machine auto -g 2 --min-vram 24 -- python train.py --output /outputs
# 只考虑指定机器，例如同一 GPU 型号的一组节点
gpuctl run --on auto --candidates gpu-2,gpu-3 -g 2 -- python train.py --output /outputs
```

后端先排除未授权、维护、离线、卡数／显存不足、调度能力不匹配的节点，再核对 OCI 镜像及 CPU 架构、可信复制通道和数据读取权限。优先选择个人余量足够、调度器报告有足够空闲卡的机器；空闲候选先比较排队量，再比较项目与数据就绪情况。已准备但尚未被采集的新提交也计入选机参考。全部忙时仍可固定一台排队；这些是选机快照，不保证准备结束时空卡仍空闲。特定 GPU 型号需求用候选机器限制，平台不推断程序对 CUDA、驱动或 GPU 架构的额外要求。

网页「提交训练」提供相同的自动选机和候选范围，开发服务器保持原选择；回执展示最终机器。固定卡号／同卡共享的网页操作仍要求手选服务器，避免把不同机器的相同卡号误认为同一块 GPU。

目标一经提交便固定：项目代码快照、容器镜像和需要的数据先在目标准备，期间状态为 `PREPARING_DATA`，不占 GPU 额度。门户重启、复制超时或服务器暂不可用不会重投任务或改派到另一台；不确定时复用原 `--key`。全部 READY 后重新检查权限和额度，再进入该机调度。取消训练不会破坏可被其他任务共用的项目／数据副本。

`--sync --machine auto` 仍先在当前开发服务器上传和发布；没有个人项目、没有固定 READY 版本、旧 shared/isolated 环境或复制能力未启用时，自动选机明确拒绝。源机器也需要本人授权。已有项目的草稿、开发终端和 HOME 不会被迁走或合并；复制目标上的同名不兼容项目会拒绝，不覆盖别人的或自己的开发内容。

也可先手动准备副本，再固定机器运行：

```sh
gpuctl project copy my-project --from gpu-1 --to gpu-2 --release FULL_HASH
gpuctl project copy-status COPY_ID
# 仅在确实要取消这笔复制时：
gpuctl project copy-cancel COPY_ID
# 已明确失败或取消，排查原因后才重试：
gpuctl project copy-retry COPY_ID
```

复制返回独立操作 ID、状态和进度；后台完成用 `SUCCEEDED` 表示。`copy-retry` 仅在旧操作两端确认停止并清理后才创建一次新复制，保留原失败记录；响应未确认时沿用客户端打印的重试键，不反复换键。运行中或 `UNKNOWN` 不能重试。代码与镜像走已配置的节点间 TLS 连接，VPS 只处理控制请求；同版本校验完成后才可运行。复制发布版本不等于同步开发容器，结果、训练 HOME 和 `/outputs` 仍留在实际执行节点。用 `gpuctl jobs` 看机器，再用 `gpuctl pull --machine TARGET --project my-project --job JOB_ID result.pt ./result.pt` 下载结果。

显式 `gpuctl run --sync -g 1 -- python train.py` 则先上传当前目录（或 `--sync-dir "本地目录"`）到所选个人项目，复用分块 SHA256 校验和发布 worker，等待本次发布的 UUID 回执 READY；再通过固定版本清单确认已上传文件的大小／SHA，最后固定该 release 提交。发布状态未知、失败、被其他发布替换、文件变化、校验不符或有界等待超时都不会提交旧版本。不会关闭终端或自动安装依赖；必须先准备好项目环境并退出项目终端。旧节点缺少 publicationProtocol 时在上传前拒绝，不静默兼容成“运行旧代码”。`--sync` 不能与 `--release/--legacy/--root/--as/--job` 混用。

该快捷入口不是增量或删除镜像：本地文件仍按原 push 流程上传，秘密／环境排除规则不变，远端额外文件保留，不迁移数据集或环境；空／全排除目录拒绝发布。Windows 原生命令行支持带空格、中文的 `--sync-dir` 双引号路径，不拼接宿主 shell。客户端退出不终止已受理的后台发布；最后提交回复丢失先查任务及原 Submission key，不换新 key 盲目重投。

任务提交会输出版本和 `Submission key`。请求超时重试时保留相同命令、`--key UUID` 与 `--release HASH`，避免后续发布改变“最新版本”。发布按项目维护后台状态，不使用训练提交 key；请求超时先 `project status`，仍在发布时等待，失败时查看原因再重新发布。

配套升级后，发布状态提供扫描、复制、校验、写入版本各阶段的已处理条目/字节；扫描未完成时总量可能未知，不显示虚构百分比或预计时间。失败详情给出项目相对路径、文件类型/权限/链接数及处理建议。网页按纯文本显示，CLI `project status --json` 保留结构化 `progress`、`errorDetails`；旧节点未返回时只显示已有状态。

## 上传、数据与千兆链路

项目代码上传按文件校验完整 SHA-256，再分块传输；每文件有独立上传 ID，服务端最终校验后才替换草稿文件。读取过程中检测到文件变化会报错，用户应停止本地写入后重传，不能静默发布混合版本。上传不自动触发项目发布。

项目模式跳过常见秘密和本地环境目录，并打印路径提示：`.git`、`.ssh`、`.aws`、`.azure`、`.venv`、`venv`、`node_modules`、`__pycache__`、`id_rsa`、`id_ed25519`、`.env`、`.env.*`（保留 `.env.example`）。不按扩展名宽泛排除所有 `.pem`，也不能自动识别所有敏感文件。上传者应先检查目录。软链接不跟随，旧模式的上传行为保持兼容。

项目代码和权重不再因单文件 4 GiB、项目合计 50 GiB 或转移镜像 100 GiB 而拒绝。单文件超过 4 GiB、发布／导入／同步／跨机复制的已知项目载荷超过 50 GiB 时警告，不要求确认或改变上传编号。仍保留实际磁盘安全余量、清单／条目边界和完整校验；数据集样本使用数据集入口，权重保留在项目。网页现有 100 MiB 选择限制仍需前端另行配套，本改动不表示所有旧客户端和节点已升级。配套新版的 `push` 重复原命令时，先核对原上传 ID、路径、文件大小与 SHA-256，再从服务器已确认的字节继续；不会凭客户端偏移覆盖旧操作。文件改变、目标冲突、旧记录缺少恢复证明或提交结果未确认时停止，不自动替换未完成上传；用 `push-status` 或 `project uploads` 查原编号，符合取消条件时再明确 `project upload-cancel`。旧完整代码直到新文件完整校验才被替换，仍有未完成上传时拒绝发布。项目发布与 `push` 也不自动删除远端草稿中本地已删掉的旧文件，可在开发终端明确删除后发布。

代码和小文件可以经 HTTPS 门户上传。TB 级公共数据由管理员登记本地源，通过批准的实验室链路准备各节点副本，训练读本机缓存；不要经 VPS 逐块上传公共大数据。千兆为每条链路共享的物理上限，不会因项目抽象变成多千兆。数据版本、失败重试、权限和缓存回收边界见 [DATASETS.md](DATASETS.md)。

结果存放在执行节点的对应任务目录；下载不是跨机归档，发布和下载流程不自动备份 checkpoint，也不自动删除旧发布版本或训练产物。未启用内核配额的节点仍只有容量入口预留；启用后，账号在每个批准数据卷上的受管可写目录共享 byte/inode 硬上限，超限写入由内核拒绝，不会删别人的数据或自动扩大配额。已存在非空未归属目录、共享/未知 owner 数据不会猜测计费人，需管理员离线核验归属。正确固定调度器数据库、attempt 根与日志根后，新平台作业的 stdout/stderr 日志也在执行前归入对应账号配额；未知或历史日志不会自动改归属。平台数据库及其他管理员控制数据仍需独立限额、轮转和备份。

管理员仍应配置容量告警和[独立备份](STORAGE_BACKUP.md)；是否覆盖结果取决于实际配置的来源目录，一次小文件恢复验收不等于全部应用可恢复，不能把同盘另一个目录当备份。

## 个人磁盘配额

网页工作台的「磁盘配额」在展开时查询当前账号在开发服务器上的个人用量，显示每个数据卷的已用容量和文件/目录数及上限；个人容器无需另选顶栏服务器。它与显卡额度无关。节点未启用硬配额时显示「未启用」，查询失败时显示「待确认」，都不当作零用量或无限容量。关闭面板或切换账号、项目后停止原查询。

## 旧接口保持

未选项目时，`ssh/push/files/run/pull` 保持原个人工作区。选中项目后临时加 `--legacy` 可继续处理旧代码和任务，不迁移或删除它们。旧上传仍使用原 offset/truncate 协议；项目上传独立使用 uploadId/totalSize/sha256/final。没有 project 字段的旧 job spec 不加字段，避免改变历史幂等摘要。

`--legacy` 不能同时指定项目、版本或项目输出任务 ID。旧任务日志/取消、机器额度、账号缓存、`AMAX_URL`/`AMAX_SESSION_FILE` 兼容不变。管理员 `ssh --root` 是显式宿主机维护入口，不受项目目录约束；不要把它当普通项目开发方式。
