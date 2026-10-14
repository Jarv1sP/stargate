# 使用指南

用 `gpuctl` 完成一次训练：登录 → 建项目、push 代码 → run → 查看结果。代码、环境和输出持续保留，不要求发布项目。

日常使用持久项目工作区和本机数据目录。共享数据只读，个人数据可写，GPU 按任务申请。

数据已在本机就直接读；跨机传输单独操作。网页与 CLI 共用账号、项目和任务。

指南描述操作方法，不是功能开通清单。只有当前门户与节点确认支持的入口才可使用；能力未确认时不改走旧工作区、其他存储盘或中转路线。

## 首次使用 {#start}

### 1 安装客户端

仅使用网页无需安装客户端或 Node.js。使用命令行时，自己的电脑需要 Node.js 22.13 或更高版本。Windows 可直接使用 PowerShell，不需要 WSL：

```powershell local
node --version
$installer = Invoke-WebRequest 'https://gpu.example.com/install.ps1' -UseBasicParsing -MaximumRedirection 0
& ([scriptblock]::Create($installer.Content))
```

Linux、macOS 或 WSL，在该系统的终端安装：

```sh local
node --version
curl -fsSL https://gpu.example.com/install.sh | sh
```

安装只写用户目录，不需要管理员权限或修改 PowerShell 执行策略。重新打开终端后使用；更新仍运行同一安装命令。Windows 与 WSL 分别安装、分别登录。

### 检查研究工具包装器

如通过研究工具包装器启动，包装器由其维护者修改，转调上面安装的官方入口并原样传递参数及退出码。Linux、macOS、WSL 的包装器脚本末尾用 `exec "$HOME/.local/bin/gpuctl" "$@"`；PowerShell 包装器脚本末尾用 `& "$env:LOCALAPPDATA\GPUQConsole\bin\gpuctl.cmd" @args`，紧接 `exit $LASTEXITCODE`。为什么：更新官方客户端不会替换包装器另存的旧脚本，丢掉退出码还会把失败当成成功。

若旧提示让你运行 `client-info --json`，而当前客户端返回未知命令，直接检查包装器和官方启动器，找到本次实际执行的 `gpuctl.mjs` 完整路径。为什么：安装完成或版本文字不能证明包装器实际启动的文件已更新。

读取[官方客户端](https://gpu.example.com/gpuctl.mjs)响应头的 `ETag`，去掉双引号就是该门户解码后脚本的 SHA256；将 `ACTUAL_GPUCTL_MJS` 换成上一步找到的完整路径，Linux／WSL 用 `sha256sum "ACTUAL_GPUCTL_MJS"`，macOS 用 `shasum -a 256 "ACTUAL_GPUCTL_MJS"`，Windows 用 `Get-FileHash -LiteralPath "ACTUAL_GPUCTL_MJS" -Algorithm SHA256` 核对。为什么：应比较实际执行的脚本与同一门户的官方字节，包装器、其他副本或压缩响应的哈希不能代替它。

### 2 登录并选机器

管理员提供注册码后，在网页注册账号。新账号的用卡额度为 0；管理员授权机器和卡数后才能训练。不需要安装 Tailscale 或持有服务器 SSH 密钥。

```sh local
gpuctl login USERNAME --url https://gpu.example.com
gpuctl state
gpuctl use MACHINE_ID
```

`USERNAME` 换成自己的账号，密码按提示输入，不写在命令里。将 `https://gpu.example.com` 换成平台地址；`MACHINE_ID` 用 `state` 中已授权的真实机器 ID。

`use` 记住开发服务器；切换不会自动搬运代码、环境、数据或结果。WSL 中的会话独立，不复制 Windows 的登录缓存。

### 3 跑完一次训练

1. [项目开发](/guide/development)：创建或选用项目，push 代码，进入终端安装依赖，再用 `exit` 结束。
2. [数据集](/guide/data)：查看现有数据，或校内直传；保存返回的数据集 ID 和完整版本，准备训练缓存。
3. [提交训练](/guide/training)：直接 `run`，或申请 GPU 交互终端后连续运行多个命令。
4. [日志与结果](/guide/results)：logs、watch；确认完成后 files、pull。需要中止时单独 cancel。

! 每一步确认后再继续；`UNKNOWN` 先查原编号，不重建任务。


### 网页入口

- 我的工作台：选机器、创建项目、开发终端和运行训练。
- 算力总览：逐卡占用和采集时间；未知或过期不代表空闲。
- 数据集：上传到集中仓库、查看版本、准备训练缓存。
- 传输任务（管理员启用后）：固定数据集复制、核对进度、终止和恢复。
- 协作区：公告、交流和任务留言。

### 姓名与描述（需任务信息新版）

只有门户和客户端支持任务信息新版时，才有「设置姓名」「任务描述」和全队列查询。没有这些入口可先用 `gpuctl state`、`gpuctl jobs`，请管理员升级；不要把指南更新当作功能已经上线。

```sh local
gpuctl profile --display-name "张三"
```

注册时也可填写姓名。未设置时显示用户名，登录账号和权限不变。新任务保存提交时姓名，旧任务没有姓名快照时使用现有姓名；描述由自己填写，同机器授权成员可见，不要填写密码或令牌。

## 项目开发 {#development}

### 1 建项目、上传代码和安装依赖

给项目／容器起能说明研究内容和用途的名字。同一个逻辑项目复用一个工作区，不为每次实验新建容器；实验目录、配置、代码版本和输出路径由你组织。

先选已授权的开发服务器，在自己电脑的代码目录执行：

```sh local
gpuctl project create my-project
```

已有项目用 `gpuctl project use my-project`。项目在所选机器运行，不自动迁移环境。

```sh local
gpuctl push .
gpuctl ssh
```

### 2 安装依赖并结束终端

进入项目终端后执行：

```sh project
python -m pip install -r requirements.txt
python -m pip check
exit
```

新项目默认是个人容器，代码在 `/workspace`。在自己的容器内安装依赖，不修改宿主机或别人的环境；不需要选择共享、隔离等环境模式。项目名以小写字母开头，可含数字、下划线和连字符，最长 48 字符。

### 整理已有项目

工作台选择项目后，展开「整理项目」可改显示名称、加入跨机项目组，或归档。显示名称和分组不移动代码、环境或结果；同组的各机器实例仍独立运行。名称有版本核对，冲突时先「读取最新名称」，再确认修改。

归档隐藏旧项目并暂停新上传、终端、发布和训练，历史任务与结果保留；勾选「显示归档项目」可恢复。命令行对应 `gpuctl project label --display-name "实验名称"`、`gpuctl project catalog --full`、`gpuctl project archive` 和 `gpuctl project unarchive`。

「检查安全退役」核对当前活动或未确认的任务、终端、上传和其他读写者；已确认结束的历史本身不阻止退役。普通退役在本人回收站保留 7 天，可恢复；本人明确选择「彻底删除」或已获批的低空间回收另行处理，内部项目名不复用。回执丢失查询原 UUID。为什么：历史记录不等于活动引用，普通恢复期和主动 purge 要分清；数据集唯一原件不属于项目回收例外。

### 个人容器

网页从「我的项目」进入个人容器，或直接「新建项目」；页面显示实际开发位置。切换顶栏服务器不会搬迁当前容器、文件或开发终端。

网页「新建项目」和 `gpuctl project create system-project` 都创建个人容器。机器授权或容器能力尚未确认时会明确拒绝，不会换成另一种环境；先联系管理员核对。

- 用「新建开发终端」进入；容器内 root 不是服务器 root，可安装自己的 Python 包和系统依赖。
- 多个终端与训练共用代码、环境和 HOME；新任务的 `/outputs` 按任务隔离，旧共享输出保留。为什么：修改工作区或依赖可能影响并发程序，独立输出防止不同任务覆盖彼此结果。
- GPU 仍由调度器分配；开发终端不占卡，需要连续调试时申请 GPU 交互终端。

### 工作区与依赖

继续使用同一个项目，安装依赖后直接[运行](/guide/training)，无需新建容器、退出终端或发布。

开发终端不占卡，`run` 经平台排队分配 GPU。同一项目可以有多个独立终端，共用文件和安装环境。网络报错按[常见问题](/guide/troubleshooting)检查。

管理员开通磁盘硬配额后，可用 `gpuctl project quota --machine MACHINE_ID` 查看本人实际 byte/inode 用量、上限和剩余。这里的 inode 是文件和目录的计数，不是用卡额度。显示“未启用”或查询失败不代表零用量或无限容量；数据目录与工作区在同一个物理卷时共用该卷的个人硬上限。

项目终端的 `$HOME` 是可写的 `/home/gpuq`，缓存、环境与容器可写层使用工作区磁盘，不是额外免费空间。大包构建可把临时文件放到私人 HOME，安装完成后清理不再需要的内容：

```sh project
mkdir -p "$HOME/.cache/build-tmp"
TMPDIR="$HOME/.cache/build-tmp" python -m pip install -r requirements.txt
```

继续已有项目用 `gpuctl project use my-project`；查看项目用 `gpuctl project list`。`push .` 跳过常见环境和秘密文件，但不能识别所有敏感内容，上传前自己检查；不会删除服务器多出来的旧文件，也不会登记或发布数据集、替你迁移本机环境。它不会自动排除数据目录，不要把数据集混进代码目录。

个人预训练权重、tokenizer 和模型配置可放 `/workspace/weights`、`/workspace/models`、`/workspace/tokenizers`，训练直接读取，不用每次从电脑重新上传或在服务器内部复制快照。新 checkpoint 可写本任务的 `/outputs`，不要覆盖输入权重。

### 终端断开与重连

终端请求前会打印原 UUID 和状态查询命令，并在本地登录缓存中保存账号与范围，不保存写入凭据。创建或重连报错、503 或结果未确认时，先运行打印的 `gpuctl terminal status ...`；不要另开终端。需要继续时用 `gpuctl ssh --reconnect 原UUID`，并保持原机器和项目；`Ctrl+]` 只断开，`exit` 才结束。

项目文件上传中断时，保留原文件和远端文件名，重复同一条 `gpuctl push` 会先核对上传身份并从已确认的字节继续；不会自动发布或提交训练。只检查、不继续传输可用 `gpuctl push-status 本机文件 远端文件名 --json`。`COMPLETE` 表示该文件已完整校验；若同时有 `completionPending:true`，再运行原 `push` 完成回执收尾，不会重传内容。项目中某个旧版本 `READY` 不代表本次上传完成。

如果提示目标被修改、上传身份冲突或旧上传缺少安全恢复记录，停止重试并联系管理员；不要换名字绕过。上传期间不要在个人终端或容器内同时修改同一路径：目标变化检测不等于对终端写入加锁，正常 `push` 本身会替换目标文件。配套新 CLI 和节点允许超过 4 GiB 的项目文件并提示容量警告，完整恢复核验需要读取一次目标文件，大文件或慢盘可能需要等待；数据集仍用数据上传流程。

文件已在该服务器个人数据区时，可用 `gpuctl project import 源目录 新目标目录` 直接复制到本项目草稿，不绕门户传字节。两个路径相对，目标须新建、父目录已存在；先结束项目和个人数据终端。`gpuctl project import-status UUID` 等到 `IMPORTED` 后编辑依赖并直接运行。任意宿主路径和只读数据集不支持。停止用 `project import-cancel UUID`；UNKNOWN 保留原 UUID，不换新操作。

旧上传卡住且本机原文件找不到时，`gpuctl project uploads` 查看 UUID，再 `gpuctl project upload-cancel UUID`。只清理确认尚未提交的临时上传，不删除项目代码；提交结果不明或目标变化时仍需按原操作核查。

`gpuctl project uploads --path 相对文件路径` 精确定位该文件的旧上传回执，`gpuctl project uploads --count` 请求旧回执的完整计数，也可组合这两个选项；翻页沿返回的 `staleReceiptPage.nextCursor` 传 `--cursor`，保持原机器、项目和筛选条件。节点未确认过滤、分页或计数能力时会拒绝对应查询，不加选项的原命令仍可用。为什么：默认页可能截断，不能把当前页数量当成全部回执，也不能绕过原 UUID 的恢复核验。


每次 `gpuctl ssh` 都会**新建独立终端**。它走 HTTPS，不是原生 SSH，不能直接填入 VS Code Remote-SSH、SFTP 或 rsync。

- `exit` 或网页「结束终端」：结束会话；`exit` 结束的终端不能重连。
- `Ctrl+]` 或网页「断开」：只断开连接，会话继续运行。
- 重连原会话：使用原服务器、项目及会话 ID；另一客户端仍在操作时，明确协调后才用 `--takeover`。

```sh local
gpuctl ssh --reconnect SESSION_ID
```

连接中断或输入回执丢失时，网页显示「输入未确认，未自动重发」，暂停输入，直到你明确重连。先检查输出再决定下一条命令；接管会让另一处失去输入权，已发出的命令不能撤回。连接过期时也要重连，不会新建替代终端。

开发终端**没有 GPU**，限 2 核 CPU 额度，内存按需共享；断开或无输入不自动结束。CUDA 检查使用 GPU 交互终端或训练任务。容器内可安装自己的依赖，不修改宿主系统。

每个任务默认有内存上限，也受节点共享池总量约束；可用 `gpuctl run --memory-limit-gib 60 -- python train.py` 显式申请上限。已有任务不会因升级自动迁入新资源配置，以节点部署为准。

## 提交训练 {#training}

### 1 直接使用当前工作区

```sh local
gpuctl run -g 1 -- python train.py --output /outputs
```

无需发布或关闭开发终端。代码、已安装环境和 HOME 跨任务保留；新任务的 `/outputs` 分别持久保存。`--` 后是程序参数，`--output` 按自己的程序调整；也可把结果写到 `/workspace` 自选目录。数据直接使用 [本机目录](/guide/data)，把路径传给训练程序。

需要固定代码和环境时，仍可使用 `--release 完整版本`；旧 `--data 名称@完整版本 --data-read warehouse` 保留固定数据挂载。默认工作区可变，不等同于固定发布。响应丢失时沿用原提交 key 查询，不能换版本或换 key 重投。

尚未初始化开发环境或需显式恢复环境的个人 OCI 项目，先用 `gpuctl project status` 核对固定 READY 镜像，再用 `gpuctl project publish --inherit-release READY_HASH`（完整版本，或用 `latest` 取最新 READY）；节点须已确认 OCI 继承能力，旧开发 head 及容器保留为回退快照，活跃或未确认的开发容器须先核实并结束原终端；不加此参数的发布行为不变。为什么：继承会切换开发环境，固定已确认的镜像并保留旧 head 才能防止误切和环境丢失，普通工作区训练仍无需发布。

新任务分别使用自己的 `/outputs`；若主动写到共享的 `/workspace`，再自行区分结果目录。为什么：默认任务输出已隔离，共享代码目录仍可能发生同名文件覆盖。

### 2 申请一次 GPU，连续使用

```sh local
gpuctl run -g 1 --interactive
gpuctl jobs
# RUNNING 后，使用返回的原任务 ID
gpuctl ssh --job JOB_ID
```

网页勾选「GPU 交互终端」，任务运行后点「连接 GPU 终端」。同一 shell 内连续运行多个脚本，无需每次重新提交。断开后进程和 GPU 占用保留，原 `ssh --job JOB_ID` 可重连；`exit` 或 `gpuctl cancel JOB_ID` 才释放 GPU，文件仍保留。它是 HTTPS 终端，不是宿主 root 或原生 SSH。

交互终端不会自动重放手动命令，不支持自动恢复和自动扩卡；需要这些功能请直接提交训练命令并接入 checkpoint。

默认直接使用当前工作区，不选择旧发布版本：

```sh local
gpuctl run -g 1 -- python train.py --output /outputs
gpuctl jobs
```

### 自动选机

只在已有同名工作区的候选服务器中选卡，不复制工作区或数据。请先确认这些机器上的代码和输入一致；需要固定数据位置时直接指定服务器。

```sh local
gpuctl run auto --candidates gpu-1,gpu-2 --project vision -g 1 -- python train.py
```

### 同步本地代码后运行

先选好服务器和项目、准备依赖，再在电脑代码目录执行同步并运行；不要求退出开发终端。

```sh local
gpuctl run --sync -g 1 -- python train.py --output /outputs
```

也可以明确指定本地目录；Windows PowerShell 和命令提示符均用双引号包住含空格的路径，无需 Bash、rsync 或 WSL：

```powershell local
gpuctl run --sync --sync-dir "C:\研究代码\我的项目" --project my-project -g 1 -- python train.py --output /outputs
```

`--sync` 复用 `push` 的分块上传与 SHA256 校验，上传成功后直接运行工作区，不发布镜像或复制代码快照。上传失败、本地文件中途变化或校验不一致时不提交训练。不替你安装依赖、删除远端文件或自动切机。

这不是镜像同步或删除同步：已匹配文件核验后复用，远端多余文件保留；空目录或全部被排除时不提交。不要把数据集混进代码目录。`--sync` 不能与 `--release`、`--legacy` 或管理员宿主模式合用。

若提交请求断线，先用 `gpuctl jobs` 核对输出的 Submission key，不换新键重复提交。

训练不创建数据准备任务。输入路径由训练命令指定；取消训练不取消独立的数据传输。

基础 `run -g 1` 默认使用兼容预设 `normal`：节点确认新版策略时为 P2、`yield=never`、`mode=queue`、不自动重跑，只可让明确同意中断的低档 `idle` 任务让位；节点未确认时显示旧策略／未核验。需要明确的让位与恢复约定，使用[自定义调度](/guide/queue)。

`-g` 是申请卡数，`--` 后是程序参数。`--output` 按训练程序修改；代码和环境可写，输出目录自行组织。改好代码可直接再运行；关闭网页或电脑不会停止服务器训练。

任务信息新版可填写任务名与自写描述，描述最多 2000 字／6000 bytes：

```sh local
gpuctl run -g 1 --name baseline --description "验证新数据集，预计两小时" -- python train.py
```

旧客户端不填描述仍能提交，旧任务显示「未填写描述」，不会拿训练命令代替描述。

### 同机多卡

```sh local
gpuctl run -g 4 --min-vram 24 -- python -m torch.distributed.run --standalone --nproc-per-node=4 train.py --output /outputs
```

程序本身须支持多卡。平台只在已选服务器分配卡，不改写单卡程序、不把显存合并成一张大卡，也不自动跨服务器训练。

### 弹性卡数与自动扩卡

```sh local
gpuctl run -g 8 --min-cards 1 --global-batch 256 --micro-batch 8 -- python train.py
```

`-g` 是最大卡数，`--min-cards` 是最少启动卡数；按当前最多的合法空卡启动。合法条件是 global batch 能被「实际卡数 × 每卡 micro batch」整除，梯度累积次数也必须是整数。例中合法卡数为 1、2、4、8；空闲 3 张时启动 2 张。普通成员的个人额度仍按最大卡数占用；管理员免个人累计额度，但最大卡数也不能超过单机物理容量。

自动扩卡还需要保存让位和恢复：

```sh local
gpuctl run -g 8 --min-cards 1 --global-batch 256 --micro-batch 8 --auto-expand --rank P1 --yield save --checkpointable --restart-policy on-preempt -- python train.py
```

新空卡出现后先保存、结束旧训练尝试，再从 checkpoint 以更大合法卡数启动，不是热挂显卡。程序要按 `GPUQ_WORLD_SIZE` 的实际卡数启动 DDP，用 `gpuq.elastic.plan_elastic_batch()` 计算累积；不能把 worker 数固定成最大卡数。固定 global batch 时 LR 不自动改变；平台不替代码实现梯度累积、保存或恢复。排队任务优先于扩卡，保存失败不强杀。

### 固定显卡与轻任务共享

先在算力总览观察空位和显存，再选物理卡号：

```sh local
gpuctl run --gpu 0,2 -- python train.py
gpuctl run --gpu 3 --share --vram-mib 4096 -- python small.py
```

固定选卡绑定物理 UUID；共享是新任务自己选择同卡运行，可与外部或普通托管任务共存，仅需新提交者同意。普通成员的共享任务占 1 张额度；管理员的共享和独占任务均免个人累计用卡额度，但仍须满足节点显存预算、能力与调度检查。共享不支持弹性、自动让位、自动恢复或主动抢占；不启用 HAMi 的共享预算只是提交前估算，没有硬显存隔离，可能互相影响或 OOM。

长训练先选择下面一种方式，不能把共享和自动恢复同时打开：

- 整卡任务：不与其他平台任务共享分配；程序适配后，可由平台保存让位、自动恢复。
- 普通共享：允许同卡运行；程序可以自行周期保存，但平台不自动让位或恢复。
- HAMi 共享：在节点验收的范围内增加显存限制；同样不支持平台自动让位或恢复。

需要共享跑长训练时，使用 `--yield never --restart-policy never`，可以保留 `--checkpointable`，并由程序定期把完整检查点写到 `/outputs`。这不代表平台会自动恢复；中断后要用自己的恢复参数重新提交。确实需要平台保存让位和自动恢复时，改用整卡任务并接入 checkpoint 适配器。提高排队等级或启用 HAMi 不会解除这一兼容限制。

节点确实支持 HAMi 时可用：

```sh local
gpuctl run --gpu 3 --share --vram-mib 4096 --hami -- python small.py
```

`--hami` 的显存限制与 `--sm-percent` 的算力比例限制是两项不同能力。只有节点确认支持并验收算力限流后，才能额外使用例如 `--sm-percent 50`；缺少能力时平台会拒绝，不能仅根据已安装 HAMi 就假定两项都可用。

HAMi 只限制这项任务，不限制同卡外部进程，也不保证性能比例；SM 限额需节点额外支持。能力或库缺失会拒绝，不会静默降级。网页有对应的弹性、固定和共享选项。

### 停止一项训练

! 取消不会保存，也不会自动恢复。

```sh local
gpuctl cancel JOB_ID
```

确认进程已停止、扩卡占用已清理后才释放额度；`UNKNOWN` 不等于已停止。取消不是保存 checkpoint，不自动恢复，也不删除已写出的结果。`watch` 中按 Ctrl+C 只退出查看，不会取消任务。

## 数据集 {#data}

容器启动后直接看到本机目录，不选数据集版本，不先复制到 SSD，也不等待缓存服务。

| 容器路径 | 用法 |
| --- | --- |
| `/data/hdd` | 本机共享机械盘数据，只读 |
| `/data/ssd` | 本机共享 SSD 数据，只读（配置了才有） |
| `/data/mine` | 本人的可写数据目录，跨任务保留 |
| `/workspace` | 项目代码及自行组织的工作文件，跨任务保留 |
| `/outputs` | 本任务的持久输出目录；开发终端可查看项目各任务输出 |

实际共享目录名以项目显示为准；每个名字都是本机挂载，不跨网络读取其他机器的目录。同一份共享数据可被多个任务同时读取，不产生任务副本。

```sh local
gpuctl ssh
```

在容器内查看、处理数据或下载新数据：

```sh container
ls /data
mkdir -p /data/mine/processed
python preprocess.py --input /data/hdd/imagenet --output /data/mine/processed
```

上传单文件到个人数据目录（明确使用 HTTPS 门户中转）：

```sh local
gpuctl data put ./labels.json labels.json --via relay
gpuctl run -g 1 -- python train.py --data /data/hdd/imagenet --output /outputs/run-01
```

下载本人数据先用 `gpuctl data files 相对目录` 找到文件，再用 `gpuctl data get 相对文件路径 新本机文件 --machine MACHINE_ID`；远端路径相对所选机器的个人数据目录，不带项目或 ROOT 参数，本机目标须不存在。历史恢复文件按原 manifest／SHA 核验，原清单缺 SHA 时会标为未核验。为什么：本人数据读取不应越到项目、宿主或他人目录，也不能覆盖本机文件或把缺失校验证据当成成功。

读取共享数据不做剩余空间检查；写入只取决于实际目标盘。SSD 空间不足不会因为读 HDD 而触发复制或缓存准入。完全耗尽的工作盘仍可能无法写日志或创建必要的运行文件。

跨机复制与训练分开：先完成目标机的数据传输，再在目标机运行。不会因为开始训练而自动搬运数据，也不会把另一台机器的目录远程挂进来。

```sh local
gpuctl data copy imagenet datasets/imagenet --from gpu-1 --to gpu-2 --source-root hdd
gpuctl data copy-status COPY_KEY --machine gpu-2
# 中断后沿原编号续传；不换编号、不重新上传
gpuctl data copy-resume COPY_KEY --machine gpu-2
```

来源是源机的 `/data/hdd/imagenet`，目标是目标机的 `/data/mine/datasets/imagenet`；`--source-root mine` 表示本人的数据目录。任务在服务器后台运行，关闭客户端不停止复制。`copy-cancel` 停止原传输并保留断点，之后仍可 `copy-resume`。只有 `SUCCEEDED` 才表示复制完成；不删除源文件或目标额外文件。节点间通道由管理员配置，不需要你提供 SSH 密钥。

## 日志与结果 {#results}

### 1 下载结果

```sh local
gpuctl completion JOB_ID --json
```

`completion` 用来查看是否完成，不是读取结果的前置条件。失败或取消任务留下的结果也可下载。

先从 `jobs` 核对实际执行机器，选回同一项目。`JOB_ID` 读取该任务的输出；升级前共用目录的旧任务仍读原位置，不能当作某个任务的独占目录删除。文件名从第一条命令的输出复制：

```sh local
gpuctl use MACHINE_ID
gpuctl project use my-project
gpuctl files --job JOB_ID
gpuctl pull --job JOB_ID model.pt ./model.pt
```

`gpuctl files --job JOB_ID --limit 100` 按页列出结果（每页 1–1000 条）；返回 `nextCursor` 后用 `gpuctl files --job JOB_ID --limit 100 --cursor CURSOR` 翻页，保持原机器、项目和目录。节点未确认分页时会拒绝，不能把当前页当完整目录。为什么：漏页会误判结果缺失，游标只对应原查询目录。

`pull` 使用门户 HTTPS，可下载单文件或整个目录：`gpuctl pull --job JOB_ID results ./results`。目录逐文件读取，不创建归档或服务器副本；它不是某一时刻的固定快照，下载期间不要修改源文件。

中断后重复原命令，保留原目标及 `.gpuctl-directory.json`、`*.gpuctl-download.json` 回执；成功文件只复核，不重新下载，未完成文件从原偏移继续。账号、来源或本地内容变化会拒绝续传，不覆盖已有数据。没有匹配回执的本地目录不能被自动采用。

### 2 查看日志、进度和错误

```sh local
gpuctl jobs
gpuctl watch JOB_ID
gpuctl logs JOB_ID
gpuctl diagnostics JOB_ID --json
```

`watch` 默认每 5 秒核对，`--interval 1` 可调整；Ctrl+C 只停止查看。完成、失败、取消或状态未知时反馈并退出，断开连接后可再次 `watch`；不会取消、恢复或重试训练。

若曾由管理员在节点上用原生 `gpu retry` 重试同一任务，门户历史终态不会被自动改写。`watch` 与 `diagnostics` 可另外返回该节点的只读观察及已确认重试事件；缺少身份或事件证据时显示未确认。`watch` 会明确区分“门户历史结果”和“节点只读观察”，退出码仍按原门户终态，不代表新一次运行已结束；此查询不会清除取消标记、重新申请数据保护或批准重试。需要恢复执行时请管理员核对原 UUID 的当前状态与保护边界，不要反复重试或另建任务绕过。

若原生重试已经成功，但后续任务仍被门户旧 FAILED 记录挡住，用 `gpuctl completion JOB_ID --json` 核验同一任务的最新完成状态。只有返回 `completed:true` 且任务 ID、项目符合预期才可作为完成依据；历史固定版本任务还需核对发布版本；旧失败历史保留，不需要重复训练。该命令成功核实退出 0、未确认退出 2、请求错误退出 1，不替代结果质量检查。

网页核实本人任务成功后显示「拉取结果」，并提醒及时下载到自己的电脑。没有该入口不等于文件被删；状态未确认、失败或取消的任务仍可从已有「输出」入口查看保留文件。平台不会因显示提醒自动备份或清理结果。

如果最新尝试已成功，但数据资源尚未收尾，可显式运行 `gpuctl reconcile-resources JOB_ID --json`，再用 `completion` 核验。它只在节点确认该次尝试及全部相关进程已停止后释放数据租约，不重跑、不取消训练，也不改写旧失败历史；运行中或身份变化时会拒绝，不要手工删除租约或收据。

网页任务表可显示轮次、步数和训练上报 ETA。准确进度需要程序接入 `gpuq.progress.ProgressReporter`；未适配显示「进度未上报」，仍可看日志。训练上报 100% 或异常，不代表平台已确认任务结束。`RUNNING` 不保证每个 worker 都健康；先看最近 200 行主日志，再看 worker 诊断、退出原因和历史分配。

任务详情和 CLI 区分「节点运行结束」与「门户确认终态」：前者来自最近一次调度运行记录，后者可能因离线或稍后对账而延迟。原始 JSON 的 `workerFinishedAt` 与 `terminalObservedAt` 分别对应两者；旧字段 `finishedAt` 保留门户确认时间的兼容含义，不应用来计算实际训练时长。节点结束证据缺失时显示未确认；不因诊断包不完整就编造退出原因，也不改写原任务历史。

查看 JSON 时，本次尝试的退出码是 `latestAttempt.exitCode`，调度运行时间是 `latestAttempt.startedAt` / `latestAttempt.finishedAt`（Unix 秒）；`workerStartedAt` / `workerFinishedAt` 使用 ISO 日期时间。不要到顶层查不存在的同名字段；缺值表示未确认，不猜成退出码 0 或时间 0。

任务信息新版还可查询同机成员的公开姓名、任务名和描述：

```sh local
gpuctl queue
gpuctl queue --machine MACHINE_ID
```

旧门户先用 `state/jobs`；没有平台记录或进程归属证明时，不猜外部任务的姓名。其他人的命令、日志、结果和操作权限不会开放，采集过期也不能当作空闲。

在服务器 SSH 终端用 `gpu q` 查看原生队列。需门户、节点桥和 GPUQ 显示协议都升级后，才显示门户提交的真实姓名与任务名；仍显示 `portal-*` 就请管理员核对配套版本。已有排队／运行任务会按原提交键自动补齐显示，不重提交或重启训练；本机直接提交的原生任务仍使用自己的 name/owner。

### 修改已有任务的名称与描述（需节点安全编辑能力）

本人任务详情中的「显示名称与描述」先读取当前内容，再保存；管理员也可在后台队列中编辑原生任务。只改展示文本，不改训练命令、分配、运行状态或原提交者。命令行先复制 `queue --json` 中的完整 `nodeJobId`：

```sh local
gpuctl task-label get MACHINE_ID NODE_JOB_ID --json
gpuctl task-label set MACHINE_ID NODE_JOB_ID --revision HASH --name "中文实验名" --description "本次训练说明"
```

`HASH` 用第一条命令返回的显示版本；清空描述可传 `--description ""`。多人同时修改时，过期版本会被拒绝，重新读取后再决定。写入超时先查询同一编号，不自动重发；提示节点未确认编辑能力时不能修改，请管理员核对配套版本。

### Telegram 通知（可选）

先请管理员为你的账号配置 Telegram 收件人，再订阅自己的未结束任务：

```sh local
gpuctl notify JOB_ID on
gpuctl notify JOB_ID status
```

网页任务表也有开关，默认关闭。可接收完成、失败、训练上报警告／异常和停滞反馈；`status` 看待发与失败数量。通知失败不改变训练状态，通知可能延迟或重复，实际结果以平台为准。

只在想关闭通知时执行 `gpuctl notify JOB_ID off`，不是订阅后的必做步骤。

### 给任务留言

```sh local
gpuctl notes
gpuctl note --job JOB_ID "预计今晚结束"
gpuctl note --general "本周维护安排"
```

网页打开「协作区 → 聊天」，展开聊天里的“任务留言”，有相同入口。任务留言只能关联自己的未结束平台任务，平台确认完成、失败或取消后自动清理正文；排队、让位中、状态未知时保留。非任务留言保留到手动删除。作者可用 `gpuctl note-delete NOTE_ID` 删除自己的留言，管理员可删除他人留言。留言对登录成员可见，每条最多 2000 字符；普通聊天消息不跟随训练结束自动清理。

## 排队与协作 {#queue}

### 等级、被抢占和恢复分别设置

网页展开「提交训练 → 自定义 GPUQ 调度」。P0–P4 越大越优先，普通成员可提交 P0–P2，P3/P4 由管理员使用。低等级不等于同意被中断：

```sh local
gpuctl run --rank P1 --yield never -g 1 -- python train.py
gpuctl run --rank P1 --yield now -g 1 -- python disposable.py
gpuctl run --rank P1 --yield save --checkpointable --restart-policy on-preempt -g 2 -- python train.py
```

- `never`：不自动让位。
- `now`：允许立即中断，不保存；默认不自动重跑。
- `save`：当前轮次保存成功后，整个多卡任务让位。
- `--restart-policy on-preempt`：只适用于已适配保存的 `save` 任务，被抢占后排队恢复；手动取消或失败不自动重跑。

`--checkpointable` 是确认已适配，不会改写代码。训练每轮结束调用 `gpuq.checkpoint.checkpoint_at_epoch_end`，启动时读取 `resume_checkpoint_path()`；保存和恢复 model、optimizer、scheduler、进度及各 rank RNG，DDP 所有 rank 协同，保留适配器退出码 75。已启用控制通道的训练内可直接导入 SDK，开发终端没有此通道；保存失败／超时不强杀，恢复文件缺失不从头冒充恢复。

### 请求抢占模式

```sh local
gpuctl run --rank P2 --mode preempt1 -g 1 -- python urgent.py
gpuctl run --rank P2 --mode preempt2 -g 1 -- python urgent.py
```

模式 1 只选择明确愿意让位且能保存的低等级任务；模式 2 对 `now` 任务立即让位，对 `save` 任务仍先保存，不越过对方约定。默认 `queue` 也按被抢占任务自己的 now/save 约定调度，不代表占满后永远不能抢占；默认模式、请求模式与自己的被抢占方式是不同选项。

同等级不互抢，`never`、旧 `legacy`、共享和外部进程不被这些新模式强杀。请求的卡数、普通成员个人额度和节点能力仍要满足，缺能力会拒绝，不会自动换机或降级。管理员的额度豁免不会改变上述让位规则。旧 `--priority idle|normal|high` 仍兼容，但不能与上述自定义选项混用；其中 `idle` 允许结束任务，不自动保存或重跑。

管理员可修改已核验待启动任务的排队等级：`gpuctl priority JOB_ID P1`。只改排序，不改让位和恢复，不作用于已运行任务。

### 额度和团队交流

普通成员的排队、启动、运行和状态待确认任务都会计入额度；弹性任务按最大卡数占用。每台机器的卡数上限与所有机器合计上限同时生效；合计上限不会自动替你挑机器。额度不保证立即有空卡，有额度也可能等卡。不要用瞬时 0% 利用率判断显卡空闲。

管理员可访问全部机器；共享和独占任务均免个人累计用卡额度，无需执行 `grant --full`，也不受升为管理员前保存的个人额度限制。单个任务仍不能超过所选机器的物理卡数，不豁免实际显存、节点授权和调度约束。资源不足时正常排队，不会因为管理员身份抢停其他训练；已有显式让位模式仍按其独立规则执行。手选、自动选机、准备完成和首次派发采用同一额度规则。

准备项目或数据时尚不占 GPU 额度；准备完成和首次派发前会重新检查当前角色与授权。降为普通成员后，新提交及尚未派发的任务重新受个人额度约束；不会仅因降级停止已经派发或运行中的训练，结果未知的任务也不会假装释放。成员原有额度保留，不会被管理员的全部机器视图覆盖。

协作区只有“帖子”和“聊天”两个入口；桌面并排显示，手机用标签切换。帖子用于公告和问题反馈，聊天用于即时交流；留言不会自动改变配额、队列或取消任务。反馈问题注明机器、任务 ID、时间和复现步骤，不要粘贴密码、令牌、私钥或私密训练数据。

管理员在协作区点「发布公告」，填写标题、正文，选择全部成员、指定成员（可多选）、管理员或普通成员。默认置顶并在接收者登录网站后弹出；取消「打开网站时弹出大公告」则只保留公告帖子。指定成员之外的普通用户不能查看正文或回复；管理员可管理全部公告，但不属于接收范围时不会弹窗。

弹窗点「我知道了」后，同一账号在其他浏览器也不再弹这一版；公告更新后重新提醒。「稍后再看」只关闭当前页面的提醒，刷新后仍会出现。「全部公告」可重新查看。旧公告不会自动变成弹窗，管理员编辑时可开启。

「布局与颜色」可选标准、居中或紧凑布局，调整背景、文字和强调色，编辑时即时预览。CLI 发布/编辑公告也可用 `--layout centered --background '#112233' --text-color '#ffffff' --accent '#ff8800'`。

新版 CLI 在执行已登录命令前，将未读重要公告完整显示到 stderr，直到明确确认；`--json` 的 stdout 保持原格式，自动化调用请同时读取 stderr。`gpuctl community announcements` 查看待确认公告；阅读后执行 `gpuctl community ack ID --revision N`。确认与网页共用同一账号回执，不会自动确认，也不自动执行公告里的内容。已安装的旧 CLI 需更新才能显示提醒。

## 常见问题 {#troubleshooting}

### 管理员接管已有目录

节点管理员先配置允许的目标账号和来源目录；`OWNER` 是目标账号 ID，不是执行者。使用同一 UUID：

```sh local
gpuctl admin adopt plan UUID project OWNER NAME /SOURCE --machine SERVER
gpuctl admin adopt status UUID --machine SERVER --limit 100
# 核对计划后再明确执行；dataset 类型同样先 plan
gpuctl admin adopt start UUID --machine SERVER
```

`status` 只查询，不启动或恢复工作；下一页传 `--cursor` 返回值。维护期间可查询，但不能 plan/start。不替换原 UUID 重发。

### 旧客户端提示校园端点或票据错误

新版 `push/pull` 使用门户 HTTPS，不需要单独连通校园文件端口。遇到 `PROBE_FAILED`、`CAMPUS_ADDRESS_REQUIRED`、`file-grant` 或 `CLIENT_UPGRADE_REQUIRED`，先更新官方客户端，并检查自己的启动脚本是否仍指向旧文件。

保留原文件、编号和断点记录；旧协议编号不能直接冒认为新版传输。查询原操作状态后再决定下一步，不强行重放旧票据。`UNKNOWN` 仅表示结果未确认，不代表已失败或停止。

### 页面提示维护中

维护横幅会显示全平台或指定机器的原因。维护期间暂停新训练、个人终端新建/重连与输入、文件上传/写入、发布、数据准备、传输启动/续传和自动归档推进；仍可看历史、日志、状态，取消任务/传输，以及关闭或断开终端。已有上传与停止尚未确认的保护不会被自动删除。网页与 CLI 使用同一维护限制。

维护状态重启后仍保留，只有管理员明确恢复才解除。开启维护**不会自动结束已有任务、终端或节点后台服务**，也不等于服务器已停止；实际诊断维修由管理员另行安排。解除后，未取消的准备/等待任务可继续；已取消或其他已结束的任务不会自动重跑。已运行的训练通过原调度系统停止后，仍须等待平台确认停止。管理员独立 ROOT 运维入口保留，个人开发入口不豁免。

`gpuctl maintenance status` 可查看当前状态。管理员先读取其中的版本号，再执行 `gpuctl maintenance on all --reason "存储诊断维修" --revision N`；完成后先再次读取版本号，再用 `gpuctl maintenance off all --revision N` 明确恢复。`N` 是刚读取的数字，不是固定值；`all` 可替换成具体机器 ID。解除全平台维护不会解除另外设置的单机维护。旧的维护申请/审批流程仍停用。

### 报错了，先确认是哪一步

- **历史显示 `FAILED`，最新尝试却成功了**：失败记录会保留，不代表必须重跑。用 `gpuctl completion JOB_ID --json` 核对；只有 `completed:true` 且任务、项目符合预期（历史固定版本还需核对发布版本），才按最新完成状态处理，结果质量仍要自己检查。
- **提示“节点能力未确认”（503）**：平台暂时不能确认所需功能，不等于训练程序已经运行并失败。先用 `gpuctl jobs` 查已有任务；回复不明时保留原任务编号和 `Submission key`，不要另建一份训练。持续无法确认时联系管理员检查节点。
- **磁盘还有空位，却拒绝上传或发布**：可用空间还须满足本次写入或复制，并留下节点配置的安全预留；这不是个人容量额度用完。按报错中的可用、预留和本次需要的字节数核对，再联系管理员处理，不要删别人的文件或正在使用的数据。

### 提交超时、任务 UNKNOWN 或无法取消

先查 `jobs/watch`、日志和诊断。`UNKNOWN` 不表示已结束，额度仍保留；不要重复建任务或删目录。提交重试用原输出的 `Submission key`，加原 `--key UUID` 和原参数；只有原提交显式指定了 `--release` 时才保留同一个完整版本，不能换策略重试。仍无法确认就把任务 ID 交给管理员。

### 已确认的 CacheBusy 失败

先用 `gpuctl diagnostics JOB_ID --json` 核对原任务；只有返回 `DATASET_CACHE_BUSY`，且确认同一尝试在训练启动前等待缓存锁超时、已经失败并停止、数据已就绪时，才重复原 run 命令并去掉旧 `--key`（或换新 UUID）显式新建一次训练，保留原项目、原来指定的 release／数据版本和训练参数。原 key 幂等返回原 FAILED，不会启动新训练；原失败历史不会消失；默认或显式 `--restart-policy never` 不自动重跑。为什么：已登记的失败只能由成员明确新建训练，查询或重放原提交不会变成一次新执行。

UNKNOWN、运行中或节点重试未核实都只查询原 UUID，不要换 key；未给出上述诊断证据的其他错误交管理员核实。为什么：未确认结果可能仍有活动进程，换 key 会重复启动训练。

### 这些状态不能互相代替

- **上传 `READY` 不等于可以立即训练**：它表示数据已完整存入仓库；所选机器的本地训练缓存也须准备到 `READY`。两者都不等于独立备份，未确认仓库数据与恢复证明时不要清掉旧源。
- **取消不等于稍后自动恢复**：训练不会自动保存 checkpoint 或重跑；传输保留已写出的内容，但不自动继续。后台归档不是普通传输，已经永久取消的归档要由管理员核查，不能用普通 `transfer resume` 绕过。
- **终端断开不等于 `STOPPED`**：在原服务器和项目用 `gpuctl ssh --reconnect SESSION_ID` 接回；要另开独立会话，选「新建终端」或运行 `gpuctl ssh`，不是接管别人正在用的会话。同项目可同时打开多个终端，共用文件和环境，新工作区不要求先结束终端再运行；用 `gpuctl terminal status SESSION_ID` 查询，`UNKNOWN` 不能当成已结束。个人容器内 root 只管理自己的容器，管理员 ROOT 运维是另一个入口。
- **HAMi 显存限制不等于 SM 限额**：显存和计算份额是两项能力。`--hami` 可用不代表 `--sm-percent 50` 已开通；未确认支持时会拒绝，也不保证“半张卡”的性能。
- **项目分组不等于搬家**：同组只是把不同服务器的实例关联展示，代码、环境和结果仍留在原实例。归档保留历史，不做物理合并；旧环境不会因分组或归档自动变成个人容器。

### 模型加载失败

新工作区的终端和训练共用 HOME、依赖和项目文件，无需发布。检查模型路径、依赖版本和文件是否完整，不要给系统目录批量改权限。只有历史固定版本任务仍使用原独立 HOME 和发布快照。

项目网络检查与一次性代理：

```sh project
gpuq-network show
gpuq-network check https://pypi.org/simple/
gpuq-network exec --proxy http://PROXY_HOST:PORT -- python -m pip install -r requirements.txt
```

这些命令在项目开发终端执行。代理地址由管理员提供，不直接照抄宿主机 `127.0.0.1`，不要把含密码代理写进项目或反馈。

### 同步代码到另一台机器

来源、目标和版本由自己选择，先预览：

```sh local
gpuctl sync git ./my-repo --ref HEAD --to TARGET --project new-project --dry-run
gpuctl sync code --from SOURCE --to TARGET --project my-project --release FULL_HASH --target-project new-project --dry-run
```

将 `SOURCE/TARGET` 换成获授权机器 ID，去掉 `--dry-run` 才传输。Git 来源只导出指定固定提交的受检文件，不要求工作区干净或 `check-attr --source`；未提交改动不会混入。为什么：实际同步读取固定 Git 对象，旧工具门槛没有调用方。已有节点代码只复制固定 release。目标须是新项目，重复同一命令可续传，不覆盖旧项目、不删除目标其他内容。

代码显示 `CODE_READY` 后，在目标 `use`、`project use`、`ssh` 准备依赖，然后直接 `run`，不用发布。代码同步不迁移 Conda/venv 或结果；历史固定版本仍可用 `project copy`。数据集在目标机器用 `data prepare` 显式准备，不通过代码同步搬运。

### 缺少系统依赖

新项目统一使用个人容器，可以安装 Python 包、编译依赖和安装容器内系统包；容器内 root 不会修改宿主机。机器未确认个人容器能力时，在“协作区 → 帖子”反馈错误，请管理员核对，不改选共享环境绕过。环境、代码、模型和输出都会占用工作区磁盘；节点有安全预留，但个人硬限额是否开启以实际配置为准。

旧维护申请流程已停用，不能提交脚本申请 root，也不需要为普通开发和训练申请审批；已有申请只保留历史查看。原有系统账号、原生 SSH、Tailscale 是独立入口，平台注册不授予这些权限。

### 登录过期或换账号

登录会话保存在门户数据库；保留原数据库时，重启／更新门户不需要重新登录。默认 30 天未使用才过期，正常使用自动续期；浏览器凭据缓存一年，CLI 缓存保留到主动退出，不保存明文密码。

首次从旧版升级需重新登录一次，旧内存会话无法恢复。主动退出只撤销当前登录；管理员改密码、停用账号或改角色会撤销该账号所有登录。浏览器清理 Cookie、凭据缓存满一年，或更换平台地址，也需要重新登录。

确实过期时用 `gpuctl login USERNAME`，主动退出用 `gpuctl logout`；换账号后重新选服务器和项目。登录失效不会停止已经提交的训练。


### 删除数据版本

你只能删除有个人来源证明的本人上传、工作区发布或副本；旧数据、共享数据和管理员登记请联系管理员。新节点尚未开通删除能力时，彻底删除暂不可用。

从一台服务器删除可重新准备的缓存：`gpuctl data unregister NAME@完整版本 --machine SERVER`。新版节点拒绝直接清除最后一份数据；仓库数据、正在训练或有固定保留的数据也不能用这个入口。节点未更新时仅管理员保留原按机器删除入口，门户先确认另有完整副本；无法确认时拒绝删除。

网页数据集详情的「删除数据集…」中，可选「仅移除服务器缓存…」，再选择服务器并确认保留副本。只有节点明确允许本人删除、并且已确认支持安全删除时才出现；管理员在主界面也遵守相同个人规则。回执丢失时保留「缓存移除记录」，只查询原操作编号；没有编号请联系管理员从服务器记录中找到，不要重复移除。

网页在数据集详情中提供「彻底删除」，需要输入数据集名称确认。节点开启能力且证明这是你可删除的版本时才显示入口；删除结果未确认时，只用原编号重新查询。页面按步骤显示结果，删除完成后列出可恢复至的时间。继续、取消和恢复需要管理员处理。

彻底删除全部服务器和数据库里的这一版本：`gpuctl data delete NAME@完整版本 --key UUID`。先保留输出的 key，用 `gpuctl data delete-status UUID` 查询；超时或“结果未确认”不要换编号重投。其他名称下的独立副本不受影响。完整副本隔离保留至少 7 天，仍占空间；期限内只有管理员可恢复，到期且收集服务已开启并确认隔离和时钟后才会清除。恢复命令是 `gpuctl data retire-restore OPERATION_ID --machine SERVER`，旧授权不会恢复。管理员也可用原任务编号显式 `retire-continue` 或 `retire-cancel`；继续只在原进程确定停止后重试原失败阶段；取消只还原数据，不继续删除、不杀训练。恢复原源时会同时处理这一任务的全部副本。实际清除后可以重新上传同名数据；管理员确认新的原源 READY 后，可用原恢复命令释放其余位置，旧授权不会复活。

新登记在安装前失败且不再重试时，管理员可用 `gpuctl data retire-discard-registration OPERATION_ID --machine SERVER --key UUID` 撤回这份准备意图；物理别名另加 `--name NAME`。它不删除数据，不解除删除墓碑，已经安装的登记不能撤回。保留 key，回执不明只沿用相同命令和 key 核对；登记意图分代保存，后续可以再次删除、清除并重新上传。
