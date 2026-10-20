# 使用指南

登录 → 创建或选择项目 → 上传代码和数据 → 提交训练 → 查看日志与结果。完整功能以[功能清单](https://github.com/Jarv1sP/stargate/blob/main/docs/FEATURES.md)为准。

项目工作区在 `/workspace`，共用数据集在 `/datasets`，每个任务写入独立的 `/outputs`；通过可读写 `/job-outputs/任务ID` 直接复用本机任务输出。代码用 git 管理，训练直接使用当前工作区；网页与 CLI 共用账号、项目、任务和数据。

## 首次使用 {#start}

### 在统一门户登录

在 [www.j4rv1s.xyz](https://www.j4rv1s.xyz) 注册并登录，点击 AMAX 图标直接进入算力页。网页依次提供算力、项目、任务、数据和协作；头像菜单里查看我的额度、指南、账号资料和退出，管理员还可打开管理台。

### 安装与更新客户端

仅用网页无需安装。命令行客户端需要 Node.js 22.13 或更高版本；Windows 可直接使用 PowerShell：

```powershell local
node --version
$installer = Invoke-WebRequest 'https://gpu.example.com/install.ps1' -UseBasicParsing -MaximumRedirection 0
& ([scriptblock]::Create($installer.Content))
```

Linux、macOS 或 WSL：

```sh local
node --version
curl -fsSL https://gpu.example.com/install.sh | sh
```

将示例地址换成平台地址。安装只写用户目录，无需管理员权限；更新运行同一安装命令。Windows 与 WSL 分别安装和登录。

### 研究工具包装器

通过研究工具包装器启动时，包装器由其维护者修改，转调官方启动器并保留参数和退出码。Linux、macOS、WSL 的脚本末尾用 `exec "$HOME/.local/bin/gpuctl" "$@"`；PowerShell 用 `& "$env:LOCALAPPDATA\GPUQConsole\bin\gpuctl.cmd" @args`，紧接 `exit $LASTEXITCODE`。为什么：更新官方入口不会更新包装器另存的旧副本，丢掉退出码还会把失败当成功。

出现 `CLIENT_UPGRADE_REQUIRED` 时先更新官方客户端；仍提示升级，就检查包装器是否启动[官方客户端](https://gpu.example.com/gpuctl.mjs)。

### 注册、登录与选服务器

注册、登录、邀请码和密码在统一门户管理。新成员由计算平台管理员分配用卡额度后即可训练。CLI 仍用 `gpuctl login 用户名`，账号密码与统一门户相同。已登录后的普通查询和传输不按共享出口 IP 限流；登录、注册、找回密码的限制及请求体大小上限保留。

```sh local
gpuctl login USERNAME --url https://gpu.example.com
gpuctl state
gpuctl use MACHINE_ID
gpuctl profile --display-name "张三"
```

`MACHINE_ID` 使用平台列出的服务器 ID，密码按提示输入。无需 Tailscale 或服务器 SSH 密钥；`use` 记住服务器，切换不会搬运文件、环境或结果。

登录的团队成员可查看和操作所有人的项目、容器、任务、数据集及输出。CLI 操作别人的同名项目时用 `--owner USERNAME`；列表显示团队项目，账号管理与平台维护仅管理员可用。

### 跑完一次训练

1. [项目开发](/guide/development)：创建或选择项目，上传代码，在容器里安装依赖。
2. [数据集](/guide/data)：查看本机数据，或上传、导入、从另一台服务器复制。
3. [提交训练](/guide/training)：运行当前工作区，或申请 GPU 交互终端。
4. [日志与结果](/guide/results)：查看日志和进度、下载结果；需要停止时单独取消。

网页入口是算力、项目、任务、数据和协作。算力页点击右侧服务器切换，卡槽可切换显存占比或利用率；白色表示我的任务，灰色表示其他进程，斜纹表示未知。点击卡槽或逐卡信息打开详情，查看型号、利用率、显存、温度、功率、进程和提交者；页首汇总空闲、使用中和排队数量；这台的数据盘和排队任务在机箱下方，完整任务记录在「任务」页。只有一块数据盘时显示一块共用盘；总容量为零、读数缺失或过期时显示未知，不显示空间不足。

显卡详情里的平台任务会显示训练进度和预计剩余时间，需要训练代码用 SDK 上报进度，没接 SDK 的显示「进度未上报」；剩余时间优先用上报值，没报时按已用时间估算并标明，断点重跑时不估算，进度停滞或过期时只显示说明。

## 项目开发 {#development}

### 创建或选择项目

先选服务器；已有项目用 `project use`，新项目可带 Git 仓库地址：

```sh local
gpuctl project create my-project --repo https://github.com/ORG/REPO.git
gpuctl project status my-project
gpuctl project list
gpuctl project use my-project
gpuctl ssh
```

仓库地址可省略；创建时在容器内克隆到 `/workspace`，`project status` 显示克隆状态、仓库地址、分支和提交。私有仓库凭据在容器里自行配置，地址中不要写密码或令牌。项目名以小写字母开头，可含数字、下划线和连字符，最长 48 字符。

网页项目的「设置」先显示已有信息，Git 状态和跨机项目各自读取，互不等待。磁盘用量只读门户统计，显示「统计于 X 分钟前」；没有统计时显示未知。同项目 30 秒内重复打开复用已读结果，切换项目或点「刷新」重新读取；刷新用量仍只读统计，不现场扫描目录。

### git、依赖与文件上传

在项目终端中使用镜像自带的 git，管理代码并安装依赖：

```sh project
git status
git pull
python -m pip install -r requirements.txt
python -m pip check
exit
```

`git commit` 和 `git push` 使用自己的 GitHub 凭据。项目容器内 root 可安装容器依赖，不能操作宿主系统盘。多个终端和训练共用工作区、环境和 HOME；修改依赖可能影响同项目正在运行的程序。

在本机代码目录上传，或下载工作区文件：

```sh local
gpuctl push .
gpuctl files
gpuctl pull train.py ./train.py
```

`push` 会替换同路径文件，保留服务器多出的文件；常见环境和秘密目录会跳过，上传者仍需检查材料。输入权重、tokenizer 和配置可放 `/workspace/weights`、`models`、`tokenizers`；新 checkpoint 写本任务 `/outputs`。

传输采用 TLS、大小核对和原子提交。中断保留原文件、路径、大小和原 key，按输出的 `--key UUID` 重复原 `push` 从偏移续传；`gpuctl push-status 本机路径 远端路径 --key UUID --json` 只查原上传。不要用新 key 重投未知操作，也不要在续传期间修改同一路径。

`gpuctl project quota` 查看工作区盘和数据集盘的已用、可用、总量；加 `--project my-project` 查看该项目文件用量。同名项目用 `--owner USERNAME` 定位。项目大小不分摊共享容器镜像，盘已用包含同盘其他内容；“至少”表示部分目录读不到，“未知”不表示零。包构建可临时设置 `TMPDIR="$HOME/.cache/build-tmp"`，先创建该目录，完成后清理不用的文件。

### 跨服务器复制项目

```sh local
gpuctl project copy my-project --from SOURCE --to TARGET
gpuctl project copy my-project --from SOURCE --to TARGET --name my-project-copy --detach
gpuctl transfer status COPY_ID
gpuctl transfer resume COPY_ID
gpuctl transfer cancel COPY_ID
```

同步当前工作区、HOME 和容器内的依赖文件，保留执行权限及软链接。目标已有同一归属、同名项目的容器就复用并增量合并；只传输大小、修改时间、类型或权限等元数据有变化的文件，目标独有文件保留，源端删除文件也不会删除目标文件。目标没有容器时完整复制环境。`--name` 可选，用于指定另一个目标项目；指定已有项目也会合并，同路径文件以源端为准。源项目、数据集和历史任务输出仍留在原处，不创建发布版本。

同路径文件以源端内容更新，替换前的旧内容在同步完成、取消或安装失败后进入七天回收站。用 `gpuctl project trash list --machine TARGET` 查看备份编号，再用 `gpuctl project trash restore BACKUP_ID --kind output --machine TARGET` 恢复；旧文件包位于目标工作区 `.copy-backups/COPY_ID.tar`，成员按 `rootfs/`、`code/`、`home/` 区分。网络中断时保留传输字节、偏移和工作区中的旧文件包；续传再次覆盖同一路径时，该次旧内容追加在包内 `retries/尝试编号/` 下。安装或逻辑失败后两端临时文件会清理，按原 `COPY_ID` 续传时重新准备，已有回收站备份保留。无需停止或重建已有容器。断线查询原 `COPY_ID`，沿用 `--key COPY_ID` 或 `transfer resume COPY_ID` 续传。增量判断使用文件元数据，手动保持相同大小和修改时间的内容修改可能被跳过；源端仍需导出临时归档，但不将整个归档传过网络。

手动同步遇到目标正在运行的任务、终端或容器 git 命令时，等待它们正常结束后才合并。AUTO 作业无变化就直接执行；有变化且目标空闲就增量合并，目标忙则准备独立任务副本，不等待，也不修改运行中作业的文件。手动复制按目标项目串行；AUTO 遇到另一份复制占用该项目时直接用独立副本。副本使用自己的执行锁，不占用公共项目；作业成功、失败或取消后在后台清理副本容器、镜像、代码和 HOME，终态查询不等磁盘清理，任务输出保留。已交给调度器的副本不会因 `transfer cancel` 被删除；停止作业用 `gpuctl cancel JOB_ID`。所需文件先下载到临时位置，合并只在本地备份和应用期间短暂排他；项目 Git 查询有超时。完成、取消或安装失败后清理本次传输的临时文件和不再使用的镜像，覆盖前备份进七天回收站。源节点暂时断开不会挡住取消，源端临时文件待后续查询或取消时补清理。

这是文件合并：保留目标独有的依赖文件，同路径依赖及包管理器记录以源端为准，不自动合并两套包管理器数据库。

自动选机若选到项目所在节点以外的服务器，平台先按上述规则准备目标项目或独立任务副本，再提交 GPU 调度。目标代码、依赖和 HOME 的改动不自动回写源项目，新结果仍写本任务 `/outputs`。复制期间继续修改源文件会影响本次同步内容。

### 整理与删除项目

网页「整理项目」可改显示名、分组、归档或取消归档；显示名和分组不搬文件。CLI 对应：

```sh local
gpuctl project label my-project --display-name "实验名称"
gpuctl project group GROUP_UUID --display-name "研究组" --members SERVER_A/my-project,SERVER_B/my-project
gpuctl project catalog --full
gpuctl project archive my-project
gpuctl project unarchive my-project
gpuctl project delete my-project
```

`GROUP_UUID` 自行生成一次，后续使用同一编号；`--members none` 移出该组成员。归档隐藏项目，取消归档可重新显示，文件和历史结果保留。删除返回原 key，原子移动进 7 天回收站；可能影响使用该项目的任务。[恢复方法](/guide/results)对所有登录成员开放。

### 终端断开、重连与接管

每次 `gpuctl ssh` 新建独立终端，使用 HTTPS PTY；VS Code Remote-SSH、SFTP 和 rsync 不能直接连接它。终端不占 GPU，需要 GPU 时见[交互训练](/guide/training)。

```sh local
gpuctl terminal status SESSION_ID
gpuctl ssh --reconnect SESSION_ID
gpuctl ssh --reconnect SESSION_ID --takeover
gpuctl terminal close SESSION_ID
```

保持原服务器、项目和会话 ID。`Ctrl+]` 只断开，`exit` 或「结束终端」才结束；接管会让另一处失去输入权。输入结果未知时不自动重放，先重连查看输出，再决定下一条命令。为什么：终端命令没有幂等性，重放可能执行两遍。

## 提交训练 {#training}

### 当前工作区与 GPU 交互终端

```sh local
gpuctl run -g 1 --name baseline --description "验证新数据集" -- python train.py --data /datasets/images --output /outputs
gpuctl jobs
```

直接使用当前代码和环境，无需关闭开发终端。`--name` 最多 64 个字符，不能含换行或控制字符。`--` 后是程序参数；`--data`、`--output` 按自己的训练程序修改。`-g` 指定卡数，每个任务输出独立；写入共用 `/workspace` 时自行区分结果目录。

同一容器的后续任务和开发终端可直接读写 `/job-outputs/前序任务ID/相对路径`，支持复制和修改文件，无需下载再上传。例如前序任务写入 `/outputs/maps/map.osa`，后续任务直接以 `/job-outputs/前序任务ID/maps/map.osa` 为输入，也可将它复制到自己的 `/outputs` 后处理；本轮结果默认写自己的 `/outputs`。

需要一次申请 GPU 后连续调试：

```sh local
gpuctl run -g 1 --interactive
gpuctl jobs
# RUNNING 后使用返回的原任务 ID
gpuctl ssh --job JOB_ID
```

同一个 GPU shell 可运行多个脚本。断开保留进程和 GPU，原 `ssh --job JOB_ID` 可重连；`exit` 或 `cancel` 结束任务并释放卡。手动命令不自动恢复或扩卡。

### 依赖前一个作业

```sh local
gpuctl run --machine auto --after MOTHER_JOB_ID --rank P4 -g 8 -- python refine.py
gpuctl run --after CANARY_JOB_ID,SECOND_JOB_ID --after THIRD_JOB_ID -g 1 -- python batch.py
```

`JOB_ID` 用 `gpuctl jobs` 中的完整编号。可以提前提交整条链，全部依赖 `SUCCEEDED` 才运行。后续作业在依赖所在的同一台机器排队；AUTO 在这里直接用该机，不复制项目，显式指定别的机器会报错。依赖尚未取得节点编号时先等编号，取得后立即进入节点队列；等待期间不分配卡。节点在发现全部依赖成功的同一轮调度里，按后续作业自己的优先级分配空卡，不等门户刷新。

同一依赖链共用用卡预留：8 卡 A→8 卡 B→8 卡 C 共预留 8 卡；可能并行的分支分别预留，仍守账号总额度和单机额度。依赖失败、取消或终态失联时，后续作业自动取消、不运行，额度释放。`jobs`、`diagnostics` 和网页任务详情显示依赖关系及“等待依赖”；这次网页不增加依赖提交选项。

### 自动选服务器与上传后运行

```sh local
gpuctl run --machine auto --candidates SERVER_A,SERVER_B --project my-project -g 1 -- python train.py
gpuctl run --sync -g 1 -- python train.py --output /outputs
```

AUTO 按资源和队列选机，异机执行前自动同步当前项目代码、HOME 和容器依赖文件：目标无变化直接复用，有变化且空闲时增量更新；目标正被任务或终端使用时用独立任务副本，没有容器才首次完整复制。输入仍由目标节点 `/datasets` 提供。`--sync` 先上传本机代码到当前开发项目，再允许跨节点选机；上传失败不提交，远端多余文件保持原样。

Windows 路径用双引号，无需 WSL 或 rsync：

```powershell local
gpuctl run --sync --sync-dir "C:\研究代码\我的项目" --project my-project -g 1 -- python train.py
```

### 多卡、内存与弹性扩卡

```sh local
gpuctl run -g 4 --min-vram 24 -- python -m torch.distributed.run --standalone --nproc-per-node=4 train.py
gpuctl run -g 1 --memory-limit-gib 60 -- python train.py
gpuctl run -g 8 --min-cards 1 --global-batch 256 --micro-batch 8 -- python train.py
```

程序须支持多卡；平台在单台服务器分配，不把显存合并或自动做跨机训练。内存以任务上限和节点共享池为准。

弹性任务的 `-g` 是最大卡数，`--min-cards` 是最小卡数。global batch 须能被实际卡数乘每卡 micro batch 整除；例中的合法卡数为 1、2、4、8。成员额度按最大卡数占用。

```sh local
gpuctl run -g 8 --min-cards 1 --global-batch 256 --micro-batch 8 --auto-expand --rank P1 --yield save --checkpointable --restart-policy on-preempt -- python train.py
```

新空卡出现后保存并结束旧尝试，再从 checkpoint 以更大卡数启动。程序按 `GPUQ_WORLD_SIZE` 启动 DDP，用 `gpuq.elastic.plan_elastic_batch()` 算累积；平台不替程序实现保存、恢复或梯度累积，排队任务优先于扩卡。

### 固定 GPU 与共享

```sh local
gpuctl run --gpu 0,2 -- python train.py
gpuctl run --gpu 3 --share --vram-mib 4096 -- python small.py
gpuctl run --gpu 3 --share --vram-mib 4096 --hami -- python small.py
```

物理卡号从算力总览选择。共享由新任务选择同卡运行，会受其他程序影响；未启用 HAMi 时显存预算没有硬隔离。HAMi 显存限制与 `--sm-percent 50` 算力比例是不同能力，按节点实际支持使用，不能保证性能比例。

共享任务不做平台自动让位、自动恢复或扩卡。长共享训练用 `--yield never --restart-policy never`，自行周期保存；需要平台保存让位和恢复则使用整卡任务并接入 checkpoint。整卡、普通共享、HAMi 共享的恢复约定不能混用。

### 停止训练

```sh local
gpuctl cancel JOB_ID
```

取消不保存 checkpoint、不自动重跑，也不删除已有结果；`watch` 按 Ctrl+C 只停止查看。状态未知时查询原任务，不用新编号重复提交。训练与数据传输独立，取消训练不会取消另一个传输。

## 数据集 {#data}

### 存储页与容量

网页“数据”按服务器列卡片：工作区显示盘容量、团队项目与大小，数据集显示盘容量、目录名字、大小、上传人和修改时间。盘介质由节点实测，SSD、HDD、混合盘分别显示，检测不到则写“数据盘”；工作区和数据集在同一文件系统时只计一块盘，标为“<介质> · 工作区与数据集共用”。读不到的容量或项目大小显示未知。成员与管理员共用同一页；“打开”进入相应项目，数据集的上传、浏览、下载、删除及回收站入口都在。

数据页只读门户保存的最新统计，重启后仍保留，不在打开页面时扫描服务器。盘容量每 5 分钟更新，目录大小每 30 分钟错开逐台后台统计；标题显示“统计于 X 分钟前”，刷新期间显示“更新中”。点击服务器的“刷新”会安排后台更新，5 分钟内已扫过就直接使用缓存；上传完成、创建、删除或恢复后自动安排更新，连续操作合并等待约 30 秒。

部分目录读不到显示“至少 X”，完全读不到显示“未知”，完整空目录才显示 0；容量未知用斜纹空条，可用不足 64GiB 显示“空间不足”。

卡片后的“操作服务器”选择上传、文件浏览、回收站及“云盘与链接导入”的目标；点击卡片上的上传或回收站会自动选好对应服务器。跨服务器复制和传输记录仍在“传输与导入”。 点击数据集“浏览”，或在全局命令面板搜索并打开数据集，会选中相应服务器并展开文件列表；打开文件列表不重新扫描容量与目录大小。

### 浏览、上传与直接读取

数据集是数据盘上的普通目录，团队共用；训练中 `/datasets` 只读，项目终端中可写。上传直接更新该目录，训练直接读取文件。

```sh local
gpuctl data list
gpuctl data files images
gpuctl data upload ./images --name images
gpuctl data put ./labels.json images labels.json
gpuctl run -g 1 -- python train.py --data /datasets/images --output /outputs
```

目录上传可新建数据集，也可向已有目录添加文件。中断沿原 key、相对路径、大小和偏移续传，传完原子提交。文件名相同会影响共用内容，处理前与团队协调。

在项目终端处理数据：

```sh project
ls /datasets
python preprocess.py --input /datasets/images --output /workspace/processed
```

### 下载与跨服务器复制

```sh local
gpuctl data get images labels.json ./labels.json
gpuctl data download images ./images
gpuctl transfer copy images --from SERVER_A --to SERVER_B --name images
gpuctl transfer list
gpuctl transfer status TRANSFER_ID
gpuctl transfer watch TRANSFER_ID
gpuctl transfer cancel TRANSFER_ID
gpuctl transfer resume TRANSFER_ID
```

本机下载目标首次须不存在，续传保留原目标和本地断点记录。复制在后台运行，关闭客户端不停止；状态查询用原编号，恢复沿原路线和偏移。完成前到目标服务器查传输状态，再运行读取该目录的训练；不删除源文件。

数据集只走校园网直连，连不上请连上校园网再用原命令续传，不支持 `--via relay/portal`。项目文件和任务输出默认直连，暂时断线先退避重试约一分钟，仍失败就沿原 key 和已确认的偏移改经 VPS；上传 `--via relay`、下载 `--via portal` 可直接走 VPS，`--via direct` 固定直连。任务提交、查询和终端一直走门户。

只读查询和下载遇到“暂时无法读取”、429、502、503、504、连接重置或超时时，保留原请求及下载偏移，按指数退避重试，共用约一分钟的总时限；权限、路径或文件不存在的错误立即报告。`pull --job` 只读取该任务的寻址信息，不拉取完整状态。

Windows 和 WSL 的原生传输助手按 CLI 构建版本保存在用户临时目录 `stargate-campus/<版本>/`；Linux 使用 `stargate-campus-<uid>/<版本>/` 区分本机用户。后续命令直接复用，新版本首次写入时尽力清理旧版本与旧临时助手目录；删不掉不影响命令。 Windows 临时目录和架构保存在 `~/.config/gpuq-console/windows-bootstrap.json`，后续命令不再启动 PowerShell；缓存失效或助手解压失败时自动重新读取一次。只有这一步 PowerShell 最多等待 30 秒，其余本机命令仍为 8 秒。

### HTTPS 与阿里云盘分享导入

```sh local
gpuctl data import https://example.com/data.zip incoming/data.zip --dataset images
gpuctl data import https://www.alipan.com/s/SHARE_ID --dataset images
gpuctl data imports
gpuctl data import-status IMPORT_ID
gpuctl data import-resume IMPORT_ID
gpuctl data import-cancel IMPORT_ID
gpuctl data import-discard IMPORT_ID
```

可用 `--project my-project` 选择工作区目标；分享有多个文件时按返回列表加 `--file-id FILE_ID`，提取码用 `--password-code`。暂停或取消后用 `import-resume IMPORT_ID` 沿原编号和已传偏移继续，运行中或已完成的导入不会重复启动。过期直链可加 `--source-url HTTPS_LINK` 更新同一文件链接。续传后用 `import-status IMPORT_ID` 查看实际状态和已传字节。导入不自动解压或执行文件；取消保留临时文件供继续，discard 清理记录而保留已完成目标。

支持字节范围的下载源使用最多四路、每块 1 MiB 的并发读取，按原偏移顺序落盘；速度仍取决于源站和网络。连接失败只保留已经连续写入的偏移，按原编号续传；不支持字节范围的源保持单连接读取。

### 云盘文件

管理员在管理台的「云盘连接」扫码连接云盘账号；成员浏览服务器可访问的云文件，下载到数据集或工作区，也可上传服务器上的文件：

```sh local
gpuctl data cloud list
gpuctl data cloud download FILE_ID incoming/model.bin --dataset images
gpuctl data cloud upload weights/model.bin --project my-project
gpuctl data cloud status OPERATION_ID
gpuctl data cloud cancel OPERATION_ID
```

查询或取消使用返回的原操作编号；请求断线保留原 key，不新建另一次上传。

### 删除与恢复数据集

```sh local
gpuctl data delete images
```

删除进同盘 7 天回收站，记录操作人和到期时间，可能影响正在读取该目录的任务；所有登录成员都能恢复。[回收站操作](/guide/results)同样适用于项目和输出。立即清空只给管理员。

## 日志与结果 {#results}

### 日志、进度、诊断与完成情况

```sh local
gpuctl jobs
gpuctl queue
gpuctl watch JOB_ID
gpuctl logs JOB_ID
gpuctl diagnostics JOB_ID --json
gpuctl completion JOB_ID --json
gpuctl reconcile-resources JOB_ID --json
```

`watch` 默认每 5 秒查询，`--interval 1` 可调整；Ctrl+C 不取消任务。日志和诊断用于排查 CPU、内存、OOM 和 worker；`completion` 查完成情况，`reconcile-resources` 收尾已结束任务的资源，不重跑训练。进度需要代码接入 `gpuq.progress.ProgressReporter`；未上报不填假进度，上报 100% 也不等于进程已结束。

任务容器按实际分到的 GPU 绑定 CPU：每张卡固定分一段 NUMA 就近的可用逻辑核；无法读取 NUMA，或就近分配导致某张卡少于全机平均核数时，按 GPU 编号顺序均分。同一物理核的超线程放在同一段。例如 128 个可用逻辑核、8 张卡通常每卡 16 核，2 卡任务可见约 32 核；弹性任务按当前卡数，共享同一张卡的任务使用该卡同一段 CPU。原 CPU 时间配额不变，普通开发终端仍为 2 核配额、不绑定 CPU。节点未委托 cpuset 或无法查询 GPU 拓扑时省略绑核，仍注入线程默认值，任务照常启动。

`OMP_NUM_THREADS`、`MKL_NUM_THREADS`、`OPENBLAS_NUM_THREADS`、`NUMEXPR_NUM_THREADS`、`VECLIB_MAXIMUM_THREADS` 和 `TORCHINDUCTOR_COMPILE_THREADS` 默认取实际 CPU 配额向下取整与所绑 CPU 核数的较小值、至少 1；未绑核时按配额，开发终端通常为 2。工作区镜像已有的设置、显式传入的环境变量和脚本中的设置保留；主动使用 `gpuq-ray` 时各 worker 的计算线程固定为 1，避免并发 worker 再各开一整份线程池。可在普通任务的终端或启动命令里覆盖，例如：

```sh container
OMP_NUM_THREADS=4 OPENBLAS_NUM_THREADS=4 python train.py
python -c 'import os; print(sorted(os.sched_getaffinity(0)))'
env -u OMP_NUM_THREADS -u OMP_THREAD_LIMIT nproc
```

GNU `nproc` 会受 OMP 环境变量影响；上面的清变量命令查看实际亲和性的核数，`GPUQ_CPU_LIMIT` 查看时间配额。`gpuctl jobs` 和 `gpuctl diagnostics JOB_ID --json` 的 `gpuMetrics` 包含每张分配卡的利用率、当前显存和本次运行采到的显存峰值（MiB）。这些是整张卡的采样，共享卡会包含其他进程；峰值按每次运行重新记录，短于采样间隔的瞬时峰值可能未采到。未采到的为未知；任务结束或采样超过 30 秒后当前值为未知，已采到的峰值保留。

### 浏览、下载与删除输出

```sh local
gpuctl files --job JOB_ID --limit 100
gpuctl files --job JOB_ID --limit 100 --cursor CURSOR
gpuctl pull --job JOB_ID model.pt ./model.pt
gpuctl pull --job JOB_ID results ./results
gpuctl pull-status ./results
gpuctl files rm old-model.pt --job JOB_ID
gpuctl outputs delete --job JOB_ID
```

`CURSOR` 使用上一页返回的 `nextCursor`，每页 1–1000 条，保持原任务和目录。输出在实际执行服务器，每个任务独立；失败或取消后已有文件也可下载，查看完成情况不是下载前置条件。

新任务和新开发终端中的 `/job-outputs/任务ID/相对路径` 提供本机任务输出的可读写入口，沿用团队共享权限，包括失败或取消任务留下的文件；可直接读取、复制和修改，部署时原文件留在原处，不复制或迁移。后续新产生的任务目录也直接可见。部署前已运行的任务和终端保持原有挂载，不因升级重启。

目录下载逐文件读取，中断重复原命令，保留 `*.gpuctl-directory.json`、`*.gpuctl-download.json` 和临时文件；沿原大小和偏移完成。下载期间源文件可能变化；首次不覆盖本机已有目标。`files rm` 删一个文件或目录（目录加 `--recursive`），`outputs delete` 删该任务输出目录，均进回收站。

### 共用回收站

```sh local
gpuctl project trash list --machine SERVER
gpuctl project trash restore KEY --kind dataset --machine SERVER
gpuctl project trash purge KEY --kind dataset --machine SERVER
```

从列表复制原 `KEY` 和 `kind`，类型为 `project`、`dataset` 或 `output`。7 天内所有成员可恢复，到期自动清理；管理员可提前 purge，清除后不能恢复。恢复时若原路径已有新内容，先另存该内容再按原编号恢复。

### 改名、通知与留言

从 `queue --json` 取得完整 `nodeJobId`，改展示文本：

```sh local
gpuctl task-label get SERVER NODE_JOB_ID --json
gpuctl task-label set SERVER NODE_JOB_ID --name "中文实验名" --description "本次训练说明"
gpuctl notify JOB_ID on
gpuctl notify JOB_ID status
gpuctl notes
gpuctl note "预计今晚结束" --job JOB_ID
gpuctl note "本周维护安排" --general
gpuctl note-delete NOTE_ID
```

改名和描述不改变命令或分配。Telegram 通知按管理员配置的收件人发送，默认关闭，关闭用 `notify JOB_ID off`；通知失败不改变训练结果。任务留言关联任务，任务终态后清理正文；非任务留言保留到手动删除，登录成员可见。

## 排队与协作 {#queue}

### 等级、让位与 checkpoint 恢复

P0–P4 越大越优先，团队成员都可使用。低等级不等于同意中断：

网页普通/高/最低预设和 CLI `--priority normal|high|idle` 对应如下；未指定策略时默认 normal。

| 预设 | 排队等级 | 让位方式 |
| --- | --- | --- |
| normal（默认） | P2 | 不自动让位 |
| high | P4 | 不自动让位，可让 idle 任务让位 |
| idle | P0 | 可立即中断，不自动重排 |

`--rank` 使用显式调度策略；以上预设在首次派发时生效，已有排队或运行作业保持原策略。

```sh local
gpuctl run --rank P1 --yield never -g 1 -- python train.py
gpuctl run --rank P1 --yield now -g 1 -- python disposable.py
gpuctl run --rank P1 --yield save --checkpointable --restart-policy on-preempt -g 2 -- python train.py
gpuctl run --rank P2 --mode preempt1 -g 1 -- python urgent.py
gpuctl run --rank P2 --mode preempt2 -g 1 -- python urgent.py
gpuctl priority JOB_ID P1
```

`never` 不自动让位；`now` 可中断且不保存；`save` 保存成功后整项多卡任务让位。`on-preempt` 让已适配的 save 任务被抢占后排队恢复，手动取消或失败不自动重跑。`priority` 只改待启动任务的排序。

训练每轮结束调用 `gpuq.checkpoint.checkpoint_at_epoch_end`，启动读取 `resume_checkpoint_path()`；保存 model、optimizer、scheduler、进度和各 rank RNG，DDP 所有 rank 协同，保留退出码 75。`--checkpointable` 不替程序实现保存；保存失败或超时不强杀，缺恢复文件不从头冒充恢复。

模式 1 只让可保存的低等级任务让位；模式 2 对 now 任务立即让位，对 save 仍先保存。默认 queue 也遵守被抢占任务的 now/save 约定；同等级不互抢，never、共享和外部进程不被强杀。排队、让位、恢复与本次是否申请抢占是不同设置。

### 额度与协作区

排队、启动、运行和状态未知任务计入成员额度；弹性按最大卡数计入。每台最多用卡和同时最多用卡（所有服务器加起来）两条同时生效，有额度也可能等卡。管理员免个人累计额度，仍不能超过物理卡数、显存或内存资源；身份不改变任务约定的让位方式。

协作区提供帖子、评论、聊天、置顶与任务留言。聊天里回车发送、Shift+回车换行；输入 @ 选择成员，对方打开网站时会弹出「有人在聊天室 @ 了你」，列出最新几条：点「去聊天室」直接查看，点「我知道了」清掉提醒，点「稍后再看」本次不再弹、下次打开或有新 @ 时再弹；「协作」入口也会显示 @ 数，看到消息后自动消失；😊 按钮插入表情；图片可粘贴、拖入或点图片按钮选择，发送前在浏览器里压缩，和消息一样保留 30 天。CLI 入口为 `gpuctl help community`、`community posts`、`community show ID`、`community post --title TITLE --body-file FILE`、`community comment ID --body TEXT` 和 `community chat --body TEXT`。反馈附机器、任务编号、时间与复现步骤，不贴密码或私密数据。

管理员发布公告可选全部成员、指定成员、管理员或成员，控制置顶、登录弹窗、布局和颜色。接收者点「我知道了」后跨浏览器记住；「稍后再看」只关闭本次提醒，公告更新可重新提醒。

CLI 未读重要公告写入 stderr，`--json` 的 stdout 保持原格式。`gpuctl community announcements` 查看，阅读后用 `gpuctl community ack ID --revision N` 确认该版公告。此处 N 选择阅读的公告内容，不是文件上传或训练放行条件。

## 常见问题 {#troubleshooting}

### 请求超时、终端未知或传输中断

保留输出的任务/会话/传输编号，先查原操作。写请求恢复用原 key、原路径、大小及偏移，不把未知当作已失败或未执行；终端输入不重放。已明确结束的失败训练，需要重新运行时由成员显式新建任务，旧失败记录保留。

### 容量、模型和网络问题

上传必须容纳本次字节并留下 64GiB 安全余量；工作区、数据集各看实际目标盘。共用数据可直接读取，工作区不会为读取数据集自动复制缓存；读数未知不填零。模型报错检查 `/workspace` 或 `/datasets` 路径、依赖和文件大小。

在项目开发终端诊断网络，代理地址由管理员提供：

```sh project
gpuq-network show
gpuq-network check https://pypi.org/simple/
gpuq-network exec --proxy http://PROXY_HOST:PORT -- python -m pip install -r requirements.txt
```

容器内可安装 Python 或系统包；不要修改宿主系统盘，也不要把含密码代理写进项目或反馈。

### 维护与管理员操作

维护横幅显示全平台或单机原因，暂停新训练、终端输入和新的文件写入/传输；仍可查状态、历史、日志、取消和关闭终端。开启维护不结束已有训练或后台服务，恢复后已结束任务不自动重跑。

网页在头像菜单进入管理台，成员与额度、维护模式、云盘连接三块在同一页排列。成员表将待审批成员放在最前；「编辑」填写每台最多用卡和同时最多用卡（所有服务器加起来），「批准全部额度」授予各服务器最大额度；账号、角色和停用在统一门户管理。维护表每行对应全平台或一台服务器；开启时填写原因，解除时确认。云盘连接用阿里云盘 App 扫码授权，可重新授权或断开。操作成功后关闭弹层并刷新状态，失败时保留填写内容和错误信息。

```sh local
gpuctl maintenance status
gpuctl maintenance on all --reason "存储诊断维修"
gpuctl maintenance off all
```

`all` 可换成单台服务器 ID，解除全平台维护不解除单机维护。启用统一身份后，账号、密码、角色和邀请码在统一门户维护；计算平台管理员仍可查看成员和分配卡数额度：

```sh local
gpuctl users
gpuctl grant USERNAME --machine SERVER=2 --total 2
```

网页的统一账号入口前往门户个人中心；只有门户所有者能管理全局账号和委派应用负责人，AMAX 管理员不会自动取得这些权限。

### 登录过期或换账号

登录失效时 `gpuctl login USERNAME`，主动退出用 `gpuctl logout`；换账号后重新选服务器和项目。登录失效不停止已有训练，客户端不保存明文密码。管理员改密码、停用或改角色会撤销该账号会话。
