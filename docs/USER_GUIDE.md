# 使用指南

登录 → 创建或选择项目 → 上传代码和数据 → 提交训练 → 查看日志与结果。完整功能以[功能清单](https://github.com/Jarv1sP/stargate/blob/main/docs/FEATURES.md)为准。

项目工作区在 SSD `/workspace`，共用数据集在 HDD `/datasets`，每个任务有独立的 `/outputs`。代码用 git 管理，训练直接使用当前工作区；网页与 CLI 共用账号、项目、任务和数据。

## 首次使用 {#start}

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

管理员提供邀请码后，在网页注册，或用 `gpuctl register USERNAME --url https://gpu.example.com` 按提示输入邀请码和密码。新成员由管理员分配用卡额度后训练。

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

网页入口包括工作台、算力总览、数据集、传输与协作区。算力总览显示逐卡型号、使用率、显存、温度、使用者和采集时间；未知或过期读数不表示空闲。

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

`gpuctl project quota` 查看当前工作区的实际用量和可用容量。HOME、缓存、容器可写层都占磁盘；读数未知不表示用量为零。包构建可临时设置 `TMPDIR="$HOME/.cache/build-tmp"`，先创建该目录，完成后清理不用的文件。

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

需要一次申请 GPU 后连续调试：

```sh local
gpuctl run -g 1 --interactive
gpuctl jobs
# RUNNING 后使用返回的原任务 ID
gpuctl ssh --job JOB_ID
```

同一个 GPU shell 可运行多个脚本。断开保留进程和 GPU，原 `ssh --job JOB_ID` 可重连；`exit` 或 `cancel` 结束任务并释放卡。手动命令不自动恢复或扩卡。

### 自动选服务器与上传后运行

```sh local
gpuctl run --machine auto --candidates SERVER_A,SERVER_B --project my-project -g 1 -- python train.py
gpuctl run --sync -g 1 -- python train.py --output /outputs
```

AUTO 在已有工作区的候选中按资源和队列选机，不搬运代码或数据；输入由本机 `/datasets` 提供。`--sync` 先上传本机代码再提交，失败不提交，不替你安装依赖或删除远端多余文件；与 AUTO 同用时只选本次上传的工作区服务器。

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

### 浏览、上传与直接读取

数据集是 HDD 上的普通目录，团队共用；训练中 `/datasets` 只读，项目终端中可写。上传直接更新该目录，训练直接读取文件。

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

默认使用已配置的校园 HTTPS 直连，LAN 与校园入口间可自动换线。校外可明确选择下载 `--via portal`、上传 `--via relay` 经门户；客户端不会自动改走门户中转。

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

可用 `--project my-project` 选择工作区目标；分享有多个文件时按返回列表加 `--file-id FILE_ID`，提取码用 `--password-code`。过期直链可用 `import-resume IMPORT_ID --source-url HTTPS_LINK` 更新同一文件链接。导入不自动解压或执行文件；取消保留临时文件供继续，discard 清理记录而保留已完成目标。

### 云盘文件

管理员在网页连接云盘账号；成员浏览服务器可访问的云文件，下载到数据集或工作区，也可上传服务器上的文件：

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

排队、启动、运行和状态未知任务计入成员额度；弹性按最大卡数计入。单机与合计额度同时生效，有额度也可能等卡。管理员免个人累计额度，仍不能超过物理卡数、显存或内存资源；身份不改变任务约定的让位方式。

协作区提供帖子、评论、聊天、置顶与任务留言。CLI 入口为 `gpuctl help community`、`community posts`、`community show ID`、`community post --title TITLE --body-file FILE`、`community comment ID --body TEXT` 和 `community chat --body TEXT`。反馈附机器、任务编号、时间与复现步骤，不贴密码或私密数据。

管理员发布公告可选全部成员、指定成员、管理员或成员，控制置顶、登录弹窗、布局和颜色。接收者点「我知道了」后跨浏览器记住；「稍后再看」只关闭本次提醒，公告更新可重新提醒。

CLI 未读重要公告写入 stderr，`--json` 的 stdout 保持原格式。`gpuctl community announcements` 查看，阅读后用 `gpuctl community ack ID --revision N` 确认该版公告。此处 N 选择阅读的公告内容，不是文件上传或训练放行条件。

## 常见问题 {#troubleshooting}

### 请求超时、终端未知或传输中断

保留输出的任务/会话/传输编号，先查原操作。写请求恢复用原 key、原路径、大小及偏移，不把未知当作已失败或未执行；终端输入不重放。已明确结束的失败训练，需要重新运行时由成员显式新建任务，旧失败记录保留。

### 容量、模型和网络问题

上传必须容纳本次字节并留下 64GiB 安全余量；工作区、数据集各看实际目标盘。共用数据可直接读取，SSD 不会为读 HDD 自动复制缓存；读数未知不填零。模型报错检查 `/workspace` 或 `/datasets` 路径、依赖和文件大小。

在项目开发终端诊断网络，代理地址由管理员提供：

```sh project
gpuq-network show
gpuq-network check https://pypi.org/simple/
gpuq-network exec --proxy http://PROXY_HOST:PORT -- python -m pip install -r requirements.txt
```

容器内可安装 Python 或系统包；不要修改宿主系统盘，也不要把含密码代理写进项目或反馈。

### 维护与管理员操作

维护横幅显示全平台或单机原因，暂停新训练、终端输入和新的文件写入/传输；仍可查状态、历史、日志、取消和关闭终端。开启维护不结束已有训练或后台服务，恢复后已结束任务不自动重跑。

```sh local
gpuctl maintenance status
gpuctl maintenance on all --reason "存储诊断维修"
gpuctl maintenance off all
```

`all` 可换成单台服务器 ID，解除全平台维护不解除单机维护。账号、邀请码与卡数额度由管理员维护：

```sh local
gpuctl users
gpuctl user add USERNAME
gpuctl user enable USERNAME
gpuctl user disable USERNAME
gpuctl user role USERNAME member
gpuctl user reset-password USERNAME
gpuctl user delete USERNAME
gpuctl invites list
gpuctl invites rotate member
gpuctl invites disable member
gpuctl grant USERNAME --machine SERVER=2 --total 2
```

密码按交互提示输入。网页管理员区还有相同账号入口；请先确定要操作的成员，再停用或删除。

### 登录过期或换账号

登录失效时 `gpuctl login USERNAME`，主动退出用 `gpuctl logout`；换账号后重新选服务器和项目。登录失效不停止已有训练，客户端不保存明文密码。管理员改密码、停用或改角色会撤销该账号会话。
