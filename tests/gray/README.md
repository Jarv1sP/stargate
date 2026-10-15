# 当前 main 本地灰度

测试对象为 `origin/main`，cpu 级别。结果以本轮报告为准。所有修改仅为灰度栈、剧本与入口；平台代码未改。

## 贡献者用法

需要 Linux/WSL2、本地 Docker Compose、Node24、Python3、Git、openssl 和可下载公开依赖的网络；full 的网页检查还需要 Playwright Chromium。首次运行先执行 `npm ci --ignore-scripts`，未安装浏览器时按 Playwright 的项目安装方式准备 Chromium。

修 bug 后在仓库里运行（默认测试已提交的 HEAD，工作树须干净）：

```sh
npm run gray -- --worktree . --level fast
```

需要包含本地未提交修改时：

```sh
npm run gray -- --worktree . --allow-dirty --level fast
```

`--allow-dirty` 包含当前已跟踪内容及未被 Git 忽略的新文件；报告明确标记 dirty，不能把它当成对应 HEAD 的发布结果。忽略文件和未跟踪的 node_modules 不导出；依赖会在导出目录重新安装。fast 运行 G01–G09：账号/登录/资源、项目/Git/终端、数据集、三种训练和 SDK checkpoint、输出、取消和优先级。本机实测约 10 分钟：WSL2、13 核、约 10 GiB 内存，缓存已存在时总耗时 10 分 22 秒（含构建和拆除，期间并行运行常规回归）。首次下载依赖会更久。

完整验收当前 main，或选择要测试的提交：

```sh
npm run gray -- --level full
npm run gray -- --commit <被测提交> --level full
```

默认使用 `origin/main`，运行前自行更新远端引用。`--commit` 从脚本所在的可信仓库取提交，允许已 fetch 的 PR/fix 提交；`--worktree` 从指定工作树取代码，两者不能同时使用。无论被测代码来自哪里，栈、剧本和豁免都从运行脚本所在仓库读取；用可信映射核对被测提交的 FEATURES.md。
当前 shell 的 docker 组未生效时用 `sg docker -c 'npm run gray -- --level full'`，不用 sudo。
可加 `--tier cpu`、`--only G04,G05`。full 为 G01–G15；单步会建立必要成员/项目，输出协作仍要求本轮 G07 产生输出。
只搭栈用 `sh scripts/gray-local/run.sh --only none --keep`；失败自动拆除，只有成功且指定 `--keep` 才保留。

**节点容器是特权容器，只对自己读过代码的提交在本机运行。** 可信剧本不能把被测代码变成安全的陌生代码；不要在有生产访问能力的机器上测试陌生提交。

每轮产物在 `out/gray/<时间>/`：`stack.json`、构建日志、`report.json`、`summary.md`、`isolation.json`、终端停止观察、诊断、CLI 日志和 `screens/`。密码、会话、证书和密钥只在忽略的 out/ 或临时卷里，不能提交。
`report.json` 逐步记录断言、调用的 operation、错误和豁免。passed 不把失败子检查吞掉；G12 的 passed 只说明所有预定豁免有效，不代表传输功能通过。
本地进度与首轮失败记录在 `out/gray-notes/progress.md` 和各里程碑日志。

## 栈与隔离

| 服务 | 内部地址 | 内存上限与用途 |
| --- | --- | --- |
| gray-portal | 172.30.77.5 | 512 MiB；候选原 Dockerfile，uid1000，只读根，cap_drop ALL |
| gray-bridge | 172.30.77.10 | 256 MiB；Unix socket → 固定 SSH forced command，不重试写请求 |
| gray-collector | 共用 bridge 网络命名空间 | 256 MiB；20秒采集一次，原子替换快照 |
| gray-node-1 | 172.30.77.21 | 4 GiB；Fedora42/systemd/rootless OCI，外层容器为模拟节点所需的 privileged |
| gray-registry | 172.30.77.30 | 256 MiB；本轮 CA 签发的 TLS registry |
| gray-git | 172.30.77.40 | 256 MiB；只读夹具裸仓库的 HTTP 服务 |
| gray-init | 无网络 | 256 MiB；一次性设置门户卷属主 |

`gray` 网络为 internal。节点、桥、采集器、Git 和 registry 不发布宿主端口。门户另接 host-access，仅发布到 `127.0.0.1`；门户本身有出网能力，不能把 internal 网络描述成整个栈完全无出网能力。
构建阶段需要下载公开镜像与锁定依赖。运行期不配置任何生产地址、云盘、通知收件人或生产凭据；节点请求只有本地 Git/registry/SSH。容器网络诊断使用候选自己的公网探测目标，隔离栈可能返回不可达。

每次搭栈自动运行 `inspect-stack.mjs`：检查 internal、发布地址、网络成员、内存和门户权限，观察节点当前已建立 IPv4 连接与路由，并写 `isolation.json`。保留栈时可再次运行：

```sh
node scripts/gray-local/inspect-stack.mjs out/gray/<时间>/stack.json
```

Playwright 只允许本轮门户源，任何外部请求都会记录并让 G14 失败。`browser-observations.json` 保存外部请求和脚本错误列表。上述是配置和当前连接观察，不是对所有未来网络行为的保证。

## 灰度节点配置

| 字段 | 值与原因 |
| --- | --- |
| machine/cards | gray-node-1 / 2；唯一灰度节点、两张模拟卡 |
| root | /data1/stargate/state；平台元数据放模拟 SSD 数据卷 |
| datasetsRoot | /data2/datasets；公共数据集放模拟 HDD 数据卷 |
| workspacesRoot | /data1/stargate/workspaces；工作区和 OCI 引擎均放数据卷 |
| dataMountPoints | /data1、/data2；保持候选的真实挂载点与设备隔离检查 |
| database | /srv/gpuq/state/gpuq.db；节点内部调度数据库 |
| gpu | /home/gpuops/bin/gpu；固定用户的 GPUQ 包装入口 |
| gpuqArchive | /srv/gpuq/current/gpuq.pyz；候选发布包自己的调度器 |
| controlRoot | /data1/stargate/gpuq-control；任务需要挂入此目录，必须在数据盘上 |
| jobMemoryGiBPerCard | 2；两卡任务上限与节点 4 GiB 容器限制相配 |
| memoryPool | null；不配置独立内存池 |
| personalOci.baseImage | 172.30.77.30:5000/gray/python:3；仅从内部 TLS registry 拉取 |
| personalOci.cdiSpec | /etc/gpuq-console/cdi/gpuq-nvidia.json；只列两张模拟卡 |
| directUpload | null；暂不配置额外直传守护进程 |
| transferPeer/transferPeers | null；单节点不配置跨服务器传输 |
| cloudFiles | null；本地无云盘账号和外网 |
| proxy/noProxy | 不设置；灰度节点不出网，不使用生产代理 |

## 模拟 GPU 与未测范围

节点使用假 nvidia-smi、假 /proc/driver/nvidia、major195设备和仅两卡的 CDI。基础镜像内置同一份模拟卡 JSON，CDI 只挂驱动工具及分配设备，不挂系统配置目录。训练夹具为纯 Python，数据集为固定种子的600张28×28 PGM图与标签，另加追加文件；仅核对文件数、总字节数和上传下载字节，不新增内容哈希。

此环境不能证明真 GPU/CUDA、真实显存/OOM、多卡 NCCL、真实 GPU 进程释放、使用个人凭据的远端 Git pull/push、生产六个 profile 分工、外网导入、校园网直连、Windows/macOS真机、规模和长期运行。统一使用7IM；其他 profile 未测。manifest 的后台 storage-collect 未安装，7天自动清理未测；立即删除/恢复通过真实回收站测试。
安装和覆盖更新脚本要求 HTTPS，而任务指定本地门户为 HTTP；只核对安装入口和候选 CLI 构建运行，不修改安装器、不安装到宿主。通知只检查未配置状态，外部投递未测。
SDK进度/checkpoint、训练输出和训练中重启等被候选执行失败阻断时，写失败或前置失败，不能豁免成通过。

## 功能与剧本

`features.json` 逐字收录 FEATURES 一到十节28条列表项。25条关联步骤、3条整项豁免；组合条目的外部部分另有明确子项豁免。关联步骤不等于整条功能通过，应结合断言和失败原因阅读。

| 步骤 | 主要操作与验证范围 |
| --- | --- |
| G01–G03 | login/register、users.*、invites.*、policy.*、profile.update/logout、state、projects.list；登录墙、管理权限和资源 |
| G04 | projects.*、data.upload.*、files.*；克隆、文件续传、项目标签分组归档及回收站 |
| G05 | terminal.*、projects.status、jobs.submit/cancel/watch；Git、重连、B接管、网络诊断与GPU终端 |
| G06 | data.upload.*、datasets.list/delete、files.*、projects.retire.*；数据集全链路 |
| G07–G09 | jobs.*、tasks.display.*、community.notes.*、files.*、outputs.delete；三种提交、诊断、SDK、输出、取消和优先级 |
| G10 | B 对 A 的 projects/terminal/jobs/datasets/files/outputs 操作及回收站；未登录和管理权限拒绝 |
| G11 | community.*、notifications.job、maintenance.*；协作、公告、维护期间读写 |
| G12 | 无外网/单节点豁免，不伪造传输成功 |
| G13 | compose重启门户/桥、节点用户GPUQ停止恢复；原编号查询与节点提交数 |
| G14 | 真实浏览器登录、主要页面与终端、公告、指南；1440/390/320截图和横向溢出 |
| G15 | 候选CLI构建、登录、状态、项目、提交、日志、PTY终端、公告提醒确认与帮助 |

`node scripts/gray-local/check-features.mjs` 检查漏项、原文变化、未知步骤和过期豁免；也由 `npm test` 运行。豁免负责人均为 TODO-维护者，到期2026-12-31；只在对应cpu/单节点配置生效。

## 构建与回归

宿主使用 Node24 / Python3.10；节点 Fedora42 安装 Python3.10，/usr/bin/python3 指向 3.10，启动时强制检查，实际版本写入 stack.json 和报告。Git2.34 低于规范。原候选缺少 build/campus-native/embedded-artifacts.private.json，直接 npm test/test:ui 会在前置构建失败。灰度用256 MiB、无网络的临时Go容器运行候选原build-campus-native.mjs生成helper，再用候选原Dockerfile构建门户；不装宿主Go或读取私有部署产物。
节点发布包在候选 git archive 的导出目录生成。构建器打印的 sourceRevision/gpuqSHA256 原样保存在 node-release.json；真正候选提交另存 stack.json，因为导出目录的临时Git提交编号不同。

补齐公开构建产物后的基线和每轮结果写入本地 out/gray-notes 与 PR 描述，不改基线用例。

## 拆除

正常或失败退出均自动 `compose down -v --remove-orphans`。手动保留的栈执行：

```sh
sh scripts/gray-local/teardown.sh out/gray/<时间>
```

拆除脚本核对 stargate-gray 容器、卷、网络为空，并比较本轮前后的 losetup。只操作当前灰度项目；不删除其他工作树或 Docker 对象。构建镜像与 out/ 日志保留用于复查，不属于运行中的容器/卷/网络。

## 灰测发现的问题

第一阶段对旧被测提交的结果保留在本地 out/gray-notes 和报告目录，不作为当前 main 的结论。维护方已修复 GPU 设备检查、终端关闭和 GPUQ 重新派发问题；当前 main 的复测结果写入 PR 描述。

第二阶段发现并修正的均为灰度栈/剧本问题：训练控制目录改放数据盘；终端 UUID 解析去除 ANSI 显示控制码；SDK 进度读取门户 camelCase 字段；任务初次派发等待真实日志；识别门户的“正在确认”状态；团队任务失败也执行取消收尾。平台代码未改，没有新增豁免。首失败与分类依据保留在本地报告，双轮复测结果写入 PR 描述。

## 发布门禁（建议）

发布者在部署前，在一台能跑 Docker 的电脑上执行：

```sh
npm run gray -- --commit <要发布的提交> --level full
```

报告必须 failed 0、skipped 0、incomplete 0，才能部署；将本轮 `summary.md` 附在发布记录里。cpu 级别不能证明真 GPU/CUDA，上线后仍须按维护者现有流程做真机冒烟。这是建议，最终规则由仓库所有者决定；本 PR 不修改 AGENTS.md §六、§九，也不实施部署。

## CI 草案

`deploy/gray-local/gray-cpu.workflow.yml` 是提案，未放入 `.github/`，也未在 GitHub runner 验证。维护者决定是否复制到 `.github/workflows/`，并手动触发一次验证。它用 base 分支的栈、剧本、豁免运行 PR 提交的 fast，上传报告；手动触发使用所选分支的提交。CPU CI 不能替代 full 发布门禁或真 GPU 冒烟。
