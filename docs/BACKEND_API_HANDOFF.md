# 后端接口交接

`projects.status` 可选返回 `sharedData:{protocol:"shared-data-directories-v1",available:true,directories:[{name,path,readOnly:true,state:"READABLE"|"UNAVAILABLE"}]}`。只提供容器中的 `/datasets/名称`，不返回宿主路径。该字段说明新开发会话和训练的默认共享只读挂载，不是要求用户上传或准备的数据集；不增加提交参数或复制入口。节点须确认所选 runner 支持此能力，旧节点没有字段时不猜测已经挂载。

## 显卡故障与部分采集

`gpuq.health:"degraded"` 可附固定诊断 `healthIssue:{kind:"managed-gpu-missing",indices:[1]}` 或 `{kind:"scheduler-degraded"}`。只有明确的调度器受管 GPU 缺失错误映射为前者；卡号有界且去重，不转发原始错误、UUID、路径或命令。已授权成员与管理员均可看到固定诊断，未授权、过期和失联状态不沿用旧故障结论。配套节点 `deploy/node-probe.py` 位于采集 SSH 强制命令，不属于数据存储 helper 更新；未部署时仅显示通用调度异常。

部分采集保留每张实际观测卡的指标与进程，缺失卡保持未知。整机占用合计仍待确认，未检测到进程不代表可调度；本变更不修改受管 UUID、故障隔离、任务准入、运行任务或重启策略。

面向前端开发者，汇总现有终端、数据上传和云文件接口。这里定义的是兼容契约，不表示每台节点已启用所有能力；部署代码、入口可达和业务验收是三件不同的事。详细说明见 [独立终端](TERMINAL_SESSIONS.md)、[校内直传](DIRECT_UPLOAD.md) 和 [私人云文件](CLOUD_FILES.md)。

目录上传还可启用独立的[机械仓库入库契约](DATASET_INGRESS.md)：`machine` 保留训练选择，placement-aware 回包明确给出 `requestedMachine/storageMachine/storageTier`。直传探测按真实 `storageMachine` 校验；会话 routes 请求须带原 `uploadId`，不要按当前策略重新选仓库。此能力默认关闭，工作区文件与旧导入不随它迁移。

仓库优先展示的源码候选接口为 `datasets.overview {}`，见[仓库与缓存总览契约](DATASET_STORAGE_OVERVIEW.md)。明确区分仓库原件、训练缓存逻辑大小、缓存预算、全部账号受管项目实际分配字节 `projectBytes` 与整卷真实容量；未知为 `null`、`projectUsageComplete:false`，不拿缓存卷推测机械仓库。`volume.collectedAt` 与 `projectCollectedAt` 各自是最后真实成功采集时间，失败可保留时间但不返回旧字节当新鲜事实。`originals[].warehouseReady` 只来自节点固定版本实态。新只读 `datasets.files.list {dataset,version,path?,cursor?}` 见[目录预览契约](DATASET_FILES.md)，每页 200 条／64 KiB，whole-page 版本锁、不建持久租约。`filePreviewAvailable` 仅在本账号有确认 READY 源及真实节点能力时 true，目录仍逐次验 ACL；`fileContentPreviewAvailable:false`。旧节点明确 unavailable，不假空树。此契约不表示生产节点已安装，迁移围栏／执行器 SHA 需维护负责人协调独立目录部署，不能原位覆盖旧 reader。

## 通用调用

使用已有的已认证 `POST /api/call`：

```json
{"operation":"terminal.open","args":{"machine":"SERVER_ID","mode":"new","key":"NEW_UUID","clientId":"CLIENT_UUID"}}
```

示例中的 ID 均须替换为实际值。浏览器沿用门户的 HttpOnly 会话 Cookie 和同源请求；CLI 沿用 Bearer 会话。不要另造登录、CSRF 或节点鉴权流程。

- 成功响应取 `result`；`principal` 是当前登录身份。部分操作附带 `state`，但 `terminal.exchange` 不返回完整仪表盘，不能要求每次响应都有 `state`。注销后 `principal=null` 是正常结果。
- HTTP 非成功响应按 `error` 展示，不能把请求已送出或 HTTP 200 当作后台任务完成。
- owner、账号角色和节点执行凭据由后端确定。不要在 `args` 中添加 `userId`、`username`、角色或宿主机绝对路径。
- 写请求的响应丢失，意味着结果未确认。不要自动重发终端输入、换一个 UUID 重启云任务，或把文件块改走另一条路径；先查原 ID 和服务端确认的状态／偏移。
- 执行桥暂时断开返回 HTTP 503，等待超时为 504，响应损坏为 502，不应显示成参数错误或任务失败。CLI 对明确只读查询（含 `host.status`）采用有界退避，最多 8 次请求、65 秒总期限，并保持原机器和任务 ID；`host.exec`、`host.cancel` 与终端输入绝不因此自动重发。查询失败不代表后台命令停止，应重新查询原句柄。

### 任务显示名与节点标签

队列、显卡进程详情和任务列表的 `name/description/submitter` 是显示信息，不是执行身份。节点采集白名单保留有界纯文本 `display_metadata`；平台关联任务仅在同机器、精确原生任务 ID、关联无歧义且登录用户名一致时采用它。管理员查询未关联平台的原生任务时，只有新鲜、已连接的节点和唯一任务 ID 才采用合法标签的 `name/description`，署名仍保留原生任务 owner，不从标签推断平台账号。普通成员对这些任务仍只收到脱敏占用。重复 ID、模糊关联、旧节点或非法标签回退原显示；UNKNOWN 状态保持未知，不新增 argv、路径、日志或操作权限。

已通过原生 GPUQ 身份围栏 `set-display` 修改的同账号标签不会被常规 reconcile 改回提交时名字。节点返回 `displaySync.state:"PRESERVED"` 和允许的标签，门户保存其显示缓存，让任务列表与队列一致；原 `job.name`、不可变 spec、提交 key/digest、优先级、资源和结果路径均不改变。原回填接口需配套采集和任务显示 helper；它本身不提供显式编辑或项目整理。新版显式编辑另按下方「已有任务显示名与描述编辑」的能力与 CAS 约定启用；项目归组和退役仍是独立接口。

提交被明确拒绝时，`MAINTENANCE_ACTIVE`（包括维护期 HTTP 503）和持久化前的 `SUBMISSION_REJECTED` 随 JSON 错误回包返回；网页显示「未提交」及原因，不提供原样重试恢复。非 JSON 502/503/504 只表示服务暂时不可用，不能证明提交失败；丢回执、未知 5xx 仍沿原 key 核对，不自动重发。

## 项目展示与生命周期

### 训练存储（2026-10-08 定稿，前端预接；不表示节点已上线）

`datasets.training.capabilities {machine,dataset,version}` 返回 `{protocol:1,machine,dataset,version,warehouse:{available,reason}}`。仅确证受信本机 READY 固定版本可用时提供仓库直读；旧协议、未知或拒绝不开放。`jobs.submit.datasetReadMode:"warehouse"` 不复制缓存或回退；默认缓存省略该参数，保持旧提交键兼容。AUTO 未确定机器时不借用开发源的能力。

HTTP 409/503 的 `SUBMISSION_REJECTED` 可附 `storage:{protocol:1,reasonCode,requiredBytes,availableBytes,volumes}`。只有 `TRAINING_STORAGE_INSUFFICIENT` 和两个可信顶层字节数才显示需要／可用；数字为 null、`TRAINING_STORAGE_UNKNOWN`、多卷／文件数／预算冲突保留原错误。明确拒绝不换机、不自动重试；更早的丢回执仍按原 key 核对。

AUTO 成功回执的 `machine` 是固定最终目标；`selectionSummary:{protocol:1,selectedMachine,storageExcluded:[{machine,reason}]}` 说明提交时采样。仅新协议且 selectedMachine 与实际 machine 匹配时显示「已分配到 X」；`reason:"storage-fit-and-resource-rank"` 且 `storageVerified:true` 时，选择原因放在ⓘ。`storage-insufficient`／`storage-unverified` 分别为「空间不足」／「空间未核实」，仍放在同一ⓘ提示，不承诺未来资源或重新改派。

所有操作绑定登录账号，不接受 owner/userId/宿主路径。内部 `project`、release、run 与
结果目录不改名；`displayName` 为纯文本，默认原 ID，写入有 revision CAS。

| 操作 | args | result / 边界 |
| --- | --- | --- |
| `projects.label.get` / `.set` | `machine,project`；set 加 `displayName,revision` | 当前显示名与 revision；同账号同实例 |
| `projects.group.get` / `.set` | 固定 UUID `id`；set 加 `displayName,revision,members:[{machine,project}],primary` | 同账号逻辑分组，primary 可空且须为成员；最多 32 实例，空 members 解除归组 |
| `projects.catalog` | 可选布尔 `includeArchived` | `groups,partial,errors,historyMapping`；离线节点不猜空列表 |
| `projects.archive` / `.unarchive` | `machine,project,revision` | 节点 lifecycle 状态；停止新工作但保留旧任务和结果 |
| `projects.retire.plan` | `machine,project` | `ELIGIBLE/BLOCKED`、阻塞原因、目录摘要、生命周期 revision、计数；不移动内容 |
| `projects.retire` | `machine,project,key,revision,manifestSha256` | 固定 UUID、完整 plan CAS；`RETIRING/RETIRED`，内容保留 |
| `projects.retire.status` | `machine,project,key` | 仅原请求；未知维持围栏，不换 UUID |

`projects.list/status/create` 增加 `displayName,displayNameRevision,logicalProjectId,logicalProjectName`；
有组时增加其 revision 与主实例。节点项目状态增加 `lifecycle:{protocol,state,revision}`，state 为
ACTIVE/ARCHIVED；软退役回执为 RETIRING/RETIRED。metadata 不能冒充权限或训练身份。
archive 前要求写入者全部确证停止；retire 还要求 Portal 和节点都无任何任务历史，完整目录
no-follow CAS、一致原子 no-replace 与永久 slug tombstone。未知、历史输出、活动源 reader、
128 同机导入双围栏均拒绝。归档中的旧已确认提交不改 spec、优先级或 GPUQ 身份。
维护模式允许只读 label/group/catalog/retire.plan/status，不允许整理写入。需同步部署实际桥
白名单和 `project-lifecycle.py/project-store.py/project-ops.py`、相关 reader/执行器；无旧节点降级。

### 未完成代码同步的显式取消

`projects.sync.status {machine,project,key}`（不带 path）只观察原请求，增加
`cancelProtocol:1,snapshotId,revision`；revision 是完整原始收据的规范 JSON SHA256。
`projects.sync.cancel {machine,project,key,snapshotId,source,manifestSha256,revision}`
绑定同账号同项目和原来源，不要求源节点仍在线，不接受客户端 owner、force、路径或角色。
节点在项目写锁及发布锁内核对完整身份和 fresh idle；上传、终端、复制、发布状态未知，
或已有任何任务／run claim／输出时拒绝，不停止任何进程。

取消只写永久服务私有证明，不改原收据、清单、索引、代码或环境。确认响应为
`state:CANCELED,preservesBytes:true`，同 UUID 的 begin/manifest/seal/chunk/finish 永久拒绝。
ProjectOps 只认可绑定完整原收据摘要及快照 inode 的证明；单独写 CANCELED 状态不能解除
保护。状态响应不确认或丢失时沿原编号查询，不自动重派取消。维护期允许该状态和取消，
其他同步写操作仍拒绝；取消后是否可退役继续按完整生命周期保护判断。

需要配套 `snapshot-sync.py/project-ops.py/project-lifecycle.py`、Portal/CLI 以及实际桥中
唯一新增的 `projects.sync.cancel` 固定白名单；保留既有 legacy-upload 取消补丁和全部私有
路由。已写取消证明后不能回滚到不识别证明的旧同步 helper，否则会丢失旧编号写入围栏。
先停新入口／核查已取消身份并保留支持该证明的版本；不能通过删证明或回滚数据库恢复。

## 个人容器项目：创建与固定发布

项目沿用同一个 `/api/call`，详细工作流见 [项目与环境](PROJECTS.md)。创建个人容器项目的请求是：

```json
{"operation":"projects.create","args":{"machine":"SERVER_ID","project":"experiment-a","environmentMode":"oci"}}
```

`project` 须匹配 `^[a-z][a-z0-9_-]{0,47}$`。新项目固定为个人 OCI；`environmentMode` 可省略或兼容显式 `"oci"`，shared/isolated 在门户派发前拒绝，不能通过旧客户端绕过。既有项目与历史版本仍可查询，不自动转换或重建环境；管理员 ROOT 入口独立不变。同名项目不能改换模式，失败时不自动降级或创建替代项目。创建成功须确认准确 `result.project` 与 `result.environmentMode === "oci"`，不能把 HTTP 200 当作容器模式已确认。

| 操作 | `args` | 成功的 `result` |
| --- | --- | --- |
| `projects.list` | `machine` | `{projects: [...]}`，每项为项目状态 |
| `projects.create` | `machine`、`project`，可选 `environmentMode` | 项目状态，创建时通常为 `DRAFT` |
| `projects.status` | `machine`、`project` | 项目状态及适用时的发布回执／进度 |
| `projects.publish` | `machine`、`project`、本次发布 UUID `key` | 后台发布状态，不占 GPU，不等于发布完成 |
| `projects.local-import.begin` | `machine,project,key,sourcePath,destinationPath` | 本人同机数据区→草稿新目录；字节不经门户 |
| `projects.local-import.status` / `.cancel` | `machine,project,key` | 原固定操作状态／取消请求 |

项目状态包含 `project`、`environmentMode`、`state`、`createdAt`、`releases`、`latestReadyRelease`、`offlineAssetsPath`。`releases` 项包含 `release`（64 位小写十六进制）、`state="READY"`、`createdAt`、`bytes`、`entries`。顶层状态可能是 `DRAFT`、`SYNCING`、`PUBLISHING`、`READY`、`FAILED` 或 `UNKNOWN`；失败详情和进度仅在返回时展示，不能因存在旧 READY 版本就宣称新发布完成。

发布前必须显式结束该项目的全部开发终端，`detach` 不算结束。每次明确发布生成一个 `key`，受理后用 `projects.status` 读取进度；状态查询只传 `machine`、`project`，不传 `key`、不循环调用 publish。保留原 `key`，仅当 `publication.id` 与它一致、`publication.state="READY"` 且 `publication.release` 出现在 READY 版本清单中，才确认本次发布成功；训练固定该 release。响应丢失先查询状态，若需确认原请求仍使用同一个 key，不换新 key 重复发布。`UNKNOWN` 或缺少对应回执时不能猜测成功。

账号须仍启用且具有所选机器的有效授权，节点还须显式启用个人 OCI 并允许该账号；管理员角色不自动绕过这些检查。当前真实正式验收范围是一个 RTX 3090 节点上的受控账号，不代表已向全部账号和节点开放。owner 由后端登录身份确定，HTTP 不接受客户端指定 `owner`、`userId`、角色、镜像或引擎参数。进入容器用下述 `terminal.open` 加 `project`，不加 `hostAdmin`；容器内 root 不等于宿主机 root，开发终端没有 GPU。

### 同机项目导入协议

`key` 是固定 UUID；SOURCE 仅当前账号个人数据工作区的相对目录，DEST 仅本人项目草稿的新目录、父目录预先存在。先结束两端全部终端，并完成或正规取消 pending uploads。维护状态阻止 begin、允许 status/cancel；每次重验当前账号和机器授权，不接受 owner/userId/hostAdmin 或任意宿主路径。旧 `/data1/...` 需先明确整理到本人个人数据区，不支持直接导入。

返回 `protocol:"project-local-import-v1",key,project,state,phase,sourcePath,destinationPath,files,bytes,draftChanged`，完成另有 `manifestSha256`，失败/未知可有 `error`。状态 IMPORTING/COMMITTING/IMPORTED/FAILED/CANCELED/UNKNOWN；阶段 SCANNING/COPYING/VERIFYING/COMMITTING/IMPORTED/STOPPED/CANCELED。仅 IMPORTED 且 draftChanged=true 证明新草稿目录完成，不是环境 READY 或 GPU 分配。项目 status/list 在 `localImport` 附回执，未确认时顶层显示 IMPORTING/COMMITTING/UNKNOWN。

两端持久围栏早于 systemd launch。完整 SHA、源 CAS 后使用 Linux `renameat2(RENAME_NOREPLACE)` 原子提交；能力缺失拒绝受理，不降级为检查后 rename。cancel 确认整组停止后只清理尚未提交的私人 staging；COMMITTING/提交回执不明仍保留围栏。通用传输仅重试 status，不重放 begin/cancel。配套门户、VPS 执行桥、项目/个人数据 helper 和 runtime 依赖清单应一起发布。执行桥仅新增固定的 `files.upload.list/cancel` 与 `projects.local-import.begin/status/cancel`；它不代替门户当前账号授权或节点 owner 检查，不开放任意操作、宿主路径或 shell。

## 自动选机与不可变项目复制

`jobs.submit` 的原显式 `machine` 行为与提交摘要保持不变。自动选机改用 `machine:"auto"`（也可省略 machine），并传 `machineSelection:{mode:"auto",candidates?:["SERVER_ID",...]}`；必须同时带固定 `project` 和完整 `release`。候选列表可省略，但不接受空列表、重复或未知机器。其余卡数、显存、数据集、调度字段沿用原接口，不接受客户端指定来源路径、镜像或用户身份。

后端只读筛选机器后，将唯一实际 `machine`、原提交 `digest`、`machineSelection` 和 `projectPreparation:{from,project,release,state,operationId?}` 随任务落库。项目／数据准备阶段为 `PREPARING_DATA`，不占 GPU 额度；后续逐阶段重新检查权限、维护、固定版本和额度。超时、刷新或重启只能观察这个目标和原操作，不能换机器或新建提交键。UI 展示实际 `machine`，用 `projectPreparation.state` 与 `dataPreparation` 显示进度；不把准备中的任务误画成已拿到显卡。

### 项目／缓存容量准入与仓库只读训练

配套新版 AUTO 候选须先通过 `training-storage-plan-v1` 的真实节点只读核验：固定项目代码与展开镜像、数据版本清单、卷 byte/inode 可用、管理员预留、已有传输预约、缓存预算和已启用内核配额。相同物理卷只算一份可用容量，不减去界面上的 `projectBytes` 再扣一次；查询未知、旧协议或不足均排除。明确服务器则返回错误，不改选、自动删除或使用系统盘。准备前与首次派发前重新核对；慢 RPC 不占全局写队列，取消、撤权、维护或规格变化使旧结果失效。

计划是内部时点准入，不返回客户端或写入 native spec，不预占未来 checkpoint/输出。节点实际写入与启动仍保留独立的实时卷守卫。旧已尝试任务和没有新计划标记的历史任务不追溯改变同步或取消规则。

`jobs.submit` 可选 `datasetReadMode:"warehouse"`；省略或 `"cache"` 保留原摘要和 node spec。warehouse 需要固定个人项目、明确数据版本及正常 owner-only 读取权限；只有所选机器本地 authority 仓库的固定 READY 版本可用。内核只读挂载仍为 `/data2/<logical dataset>`，持久读取租约固定 mode、机器、authority 与源根身份，注销／回收围栏仍有效。节点离线、非仓库节点、未确认或缺权限时拒绝，不回落缓存／其他节点。AUTO + warehouse 只在本地拥有全部仓库版本的合法候选中选机。CLI 对应 `--data-read warehouse`；前端能力未实机确认前不开放切换。

只读内部 `datasets.training.status` 与 `storage.training.plan` 仅走正常训练执行桥，不扩展元数据或上传 forced key。客户端不提交 `projectFootprint`、`datasetFootprints`、物理路径、authority、容量计划或 hostAdmin；前端仍仅提交原固定项目和数据声明。

缺失缓存的准备也必须配套新的私有 `storage.training.prepare` 执行路径：Portal 在原作业／传输记录中先保存完整 spec、容量请求和原准备编号，节点按同一固定账号、版本、源／目标及不可变运行时执行。旧记录不自动升级；丢回执只查原操作，取消仍须证明原 worker 停止，UNKNOWN 保留原保护。分离运行时和执行桥的完整配套未确认前不能开放新训练准备，不能回退旧 worker、自动回收缓存或生成第二条传输。该内部上下文不接受客户端选择，也不投影到公开作业／传输响应。

前端预检使用认证只读 `datasets.training.capabilities {machine,dataset,version}`，只能传这三个固定字段。返回 `{protocol:1,machine,dataset,version,warehouse:{available,reason}}`；`reason` 为 `null`、`maintenance`、`offline`、`protocol-unavailable`、`unverified`、`forbidden`、`machine-not-warehouse` 或 `not-ready`。这不是容量预留或训练授权，提交时仍重核全部条件；维护或旧／未知节点不开放仓库直读。查询走有界独立数据读取 lane，不等待全局写队列，前后重新验证登录与授权，不泄露物理源。

已确认容量不足的提交返回 HTTP409、`code:"SUBMISSION_REJECTED"`；容量／协议无法确认返回503、同一 code。可附 `storage:{protocol:1,reasonCode:"TRAINING_STORAGE_INSUFFICIENT"|"TRAINING_STORAGE_UNKNOWN",requiredBytes,availableBytes,volumes}`。顶层数字仅在唯一确认的物理字节不足时为非负整数，否则为 null；UNKNOWN 为全 null 和空 volumes。已确认行仅含 `roles:["project"|"cache"]`、`requiredBytes/availableBytes/requiredInodes/availableInodes`；available 已扣预留和在途承诺。文件数、预算或多项限制不足时显示错误原文，不拿磁盘物理 free 伪造统一可用数字。不会返回内部计划、owner、路径或设备身份。

AUTO 成功回执的 `machine` 是已持久保存的最终目标，另附 `selectionSummary:{protocol:1,selectedMachine,reason:"storage-fit-and-resource-rank",storageVerified,gpuPoolAvailable,queuedJobs,localProject,localDatasetCount,observedAt,storageExcluded:[{machine,reason:"storage-insufficient"|"storage-unverified"}]}`。它只解释本次选择时的授权候选、容量与资源快照，不承诺未来卡位或磁盘；没有合适目标则拒绝，不创建任务，排队后不自动改派。

结果继续用本人认证的 `files.list/get {machine:job.machine,project:job.project,area:"output",runId:job.id,path,...}` 或 `gpuctl pull REMOTE_FILE LOCAL_FILE --machine MACHINE --project PROJECT --job JOB_UUID`，不能使用开发机代替实际执行机。页面可按终态提醒保存结果，`jobs.completion` 可另核实成功证明；当前没有可靠结果总大小或“已下载”历史，不虚构这些字段，也不自动清除输出。

个人累计用卡额度只约束普通成员；当前启用的管理员对共享、独占、手选和 AUTO 一致豁免。单任务物理卡数、显存、能力、owner-only 数据授权、优先级和显式让位规则不变，资源不足交给节点排队；不清除既有任务或租约，也不更改成员原始额度。全平台 5000 条历史和每人 10 个准备中任务的上限保留。新任务内部 `dispatchPending:true` 随记录持久化（不下发到节点或返回客户端）；首次 sync 在串行队列内重验当前角色/启用状态、机器和个人额度及管理员专属优先级，先持久化标记为 false 再开始远程调用，等待回包不占用串行队列。降级后未派发任务不沿用管理员豁免；已尝试派发、旧无标记或回执未知任务继续原同步路径，不凭角色变化停止训练或释放资源。该标记不是节点成功证明。

后台任务核对每台机器保留一个首次派发／取消通道和一个既有任务观察通道，最多两个在途操作，同一任务始终只有一个。新任务能加入正在进行的核对，不等待其他机器或旧任务列表全部查完；既有任务仍按原顺序获得独立观察通道。每轮同一阶段只尝试一次，首次回包丢失不会在该轮立即重新 sync。取消先等待该任务自身在途操作结束，不并发取消与 sync；UNKNOWN 仍保留额度和原编号。此调度不绕过全局持久写队列、当前授权、维护门禁或节点排队，也不保证节点／网络故障时的启动时间。

界面按当前账号的 `enabled:true` 与 `role:admin` 显示「请求卡数／免个人额度」，保留进行中和排队的真实请求统计，但不把清单派生的 `total` 或 `limits` 画成管理员累计额度上限，也不以 `total-used` 禁用管理员提交。单次 `cards.max` 仍来自目标机器物理卡数；成员继续显示占用／额度上限。工作台、提交预检、总控、算力摘要和个人账号页口径一致。

手动项目副本使用正常认证接口 `projects.replicate {from,machine,project,release,key}`，查询／取消为 `projects.replication.status {id}` 和 `projects.replication.cancel {id}`。只允许账号自身、两端机器均仍授权的固定 OCI 版本。响应包含 `id,state,from,machine,project,release,bytes?,totalBytes?,error?,developmentChanged:false`；状态包括 PREPARING、DISPATCHING、RUNNING、UNKNOWN、SUCCEEDED、FAILED、CANCELING、CANCELED。UNKNOWN 不证明未启动，不能换 key 重发。内部传输票据不会返回前端。

明确失败或取消后，用户可选择 `projects.replication.retry {id,key}`，`key` 是新的重试 UUID；响应不确定时沿用这个 key。只有旧操作两端已停止、临时运输数据已清理、源票据已撤销且权限仍有效才接受；返回新复制及 `retryOf`，原失败记录不改写。不要让页面刷新自动调用 retry，也不要自动重提旧训练。后台发现撤权或取消时，先阻断源票据读取，再等目标停止和清理；目标暂时失联时继续保留收尾状态与临时文件。

项目复制只复制不可变代码和镜像，不迁移正在运行的容器、草稿、开发 HOME 或训练结果。数据集使用原数据复制服务。部署方需同时启用门户模块、节点 portable-project 能力与固定 TLS peer，配置缺失时拒绝自动选机，不回退为未隔离执行。

## 终态训练的只读节点观察

`jobs.watch {jobId}` 对已保存终态保留原 `state`、时间、取消与资源字段，额外返回 `nativeObservation`；`jobs.diagnostics {jobId}` 在原诊断包外增加 `portalTerminal` 与同一观察。观察为 `readOnly=true`、`status=CONFIRMED|UNKNOWN`，确认时含节点 `state`、`nativeVersion`、`observedAt`、`latestAttempt`、`latestRetry`、`retryDetected` 和 `manualRecovery`。`retryDetected` 只在原节点 ID、不可变规格、submit key、同快照版本及该节点任务的最新 `JOB_RETRIED` 事件均核对、且事件晚于原 attempt 的节点结束时间时为 true；排队重试可以尚无新 attempt。

这些字段仅证明观察时刻，不是持续一致或重新执行授权。缺少旧节点能力、身份／事件／时间基线不全或查询失败不得推断任务复活；UNKNOWN 不覆盖原历史。不要用 `nativeObservation.state` 改写主 `state`、发起取消／提交、清除 `cancelRequested`、重新占用额度或重开已释放 hold。`manualRecovery.reason=HOST_RETRY_REQUIRES_EXPLICIT_RECOVERY` 表示已观察到宿主重试，`TERMINAL_DIVERGENCE_UNCONFIRMED` 表示状态差异但重试证据不足。普通请求不接受 node ID、spec、retry event、角色或宿主路径；内部只读证明不能由客户端提供。CLI `watch` 仍按门户原终态退出，并明确显示它与节点观察的区别。

### 下游任务的完成核验

`jobs.completion {jobId}`（CLI：`gpuctl completion JOB_ID --json`）提供同一不可变任务的最新成功证明，不修改 `state/jobs` 的原终态。返回 `protocol:"job-completion-v1"`、`completed`、`state:SUCCEEDED|UNCONFIRMED`，以及 `jobId,userId,machine,nodeJobId,project,release,specSha256,portalHistory,nativeObservation`；成功另含 `completedAttempt,observedAt,nativeVersion`。CLI 已核实成功退出 0，未确认退出 2，请求错误退出 1。

原生手动重试成功后，历史终态不再自动同步，可能仍保留数据租约。此时 `completion` 仍为未确认，不能仅凭日志中的成功忽略资源保护。本人或管理员可显式执行 `gpuctl reconcile-resources JOB_ID --json`（`jobs.reconcile-resources {jobId}`）：只对账已有历史终态任务，不提交、重跑或取消任务，不修改原失败历史、取消标记和配额。服务端固定原生任务 ID、最新 attempt ID/序号和原生版本；节点在 job 锁内重读并核对完整规格、终止状态、全部消费者及代际，再正常收尾数据租约。缺失身份、运行中、未知或并发重试均拒绝；不得通过删除收据代替释放。成功回包 `protocol:job-resource-reconciliation-v1, resourcesReleased:true, reconciledNative, portalHistory, completion`，其中 `completion` 是收尾后的另一次只读核验，不保证后来新重试也已完成。该命令是显式变更，不自动重试；丢失响应可先用 `completion` 查询，再按原任务重新对账。

`completed:true` 必须同时满足：固定节点/账号/submit key/不可变 spec 匹配；最新 attempt 为 `EXITED_SUCCESS`、exit 0、开始结束时间有效；native watch 已确认 GPU 消费者结束及数据租约收尾；较旧失败之后须有可信重试事件及更高 attempt。门户取消标记、缺少身份或事件基线、节点失联和清理中均返回未确认。仅当前获授权的本人/管理员可读，不接受客户端提交证据；不重放训练、占用额度、释放租约或覆盖失败历史。

下游准入应查询此接口，并核对预期 `jobId/project/release/completedAttempt`，不要将旧 `state/jobs` 的 FAILED 直接当作重试结果，也不要仅凭日志里的成功字样放行。该结果是通过认证 HTTPS 查询得到的时点证据，`specSha256` 只是不可变规格摘要，不是离线数字签名；不证明科学结果质量，后续再次重试可能产生更新状态。

## 已有任务的显示信息

`tasks.display.get {machine,nodeJobId}` 读取固定原生任务的名称、描述和显示版本；`tasks.display.set {machine,nodeJobId,name,description,revision}` 仅修改这两项展示文本。`nodeJobId` 是原 `J` 加 12 位十六进制编号，不是门户 UUID。客户端不能传 owner、提交键、submitter、规格、命令或角色。成员仅可操作本人已关联任务；当前启用管理员可管理未关联的原生任务，但显示文本不建立账号归属或操作权限。

成功回包为 `protocol:"task-display-edit-v1",nodeJobId,available,name,description,revision`；`revision` 是读取时的 64 位显示内容哈希，写入必须显式沿用它。节点以固定 native ID、原提交键、owner、内部 rawname 及当前显示哈希在同一 SQLite 事务内比较，过期版本拒绝，不覆盖他人修改。原 `job.name/spec/argv/env`、attempt、租约、优先级、状态及历史记录不改。名称最多 64 字／256 字节，描述最多 2000 字／6 KiB，控制字符拒绝；保留原提交者信息，不开放作者编辑。

节点实际 GPUQ 必须确认 `job-display-cas-v1`，并与匹配的执行器及 helper 一起公布 `console-task-display-edit-v1`。旧节点、失联或过期采集的 get 返回 `available:false`，set 拒绝且零派发，不猜测可编辑。展示在已确认回包后可用最多三分钟、最多 256 项的只读投影补偿采集延迟，新的采集会取代它；这不是授权、运行或空闲证明。原队列对账保留有效的人工标签，不用原名称覆盖它。

丢失写回包应查询同一 `machine/nodeJobId`，人工比较原显示版本和内容；不自动重试 set 或换任务编号。CLI：`gpuctl task-label get SERVER NODE_JOB_ID --json`，再 `gpuctl task-label set SERVER NODE_JOB_ID --revision HASH --name TEXT --description TEXT`；空描述可明确传 `--description ""`。门户、客户端、固定执行桥、节点 helper 和运行中的 GPUQ 必须配套，源码合并不等于节点已经启用，发布该能力需要另行核验原生服务加载版本，不能以 Portal-only 更新冒称完成。

## 终端：新建与重连分开

所有操作均包含 `machine`。可选上下文为 `project`、`dataWorkspace`、`hostAdmin`；重连及后续操作必须保持原上下文。项目、个人数据终端和宿主机 root 入口不能混用。宿主机 root 仍受管理员身份、机器授权和节点配置约束，不等于个人容器内的 root。

| 操作 | 必需字段（除 `machine` 外） | 行为 |
| --- | --- | --- |
| `terminal.open`，`mode="new"` | 新 UUID `key`、`clientId` | 新建独立 PTY；不携带旧 `id`／`writerToken` |
| `terminal.open`，`mode="reconnect"` | 原 `id`、新连接 UUID `key`、`clientId` | 附着原会话，不替换不可达的终端 |
| `terminal.exchange` | `id`、`clientId`、`writerToken` | 读取输出，可带输入和窗口尺寸 |
| `terminal.detach` | `id`、`clientId`、`writerToken` | 释放写入权，保留终端及命令 |
| `terminal.close` | `id`、`clientId`、`writerToken` | 显式结束这一会话，不影响其他会话 |
| `terminal.status` | 原 `id` 与原上下文 | 只读核验原会话，不附着、不输入、不续租 |
| `terminal.close`，已停止记录收口 | 原 `id` 与原上下文；不带 `clientId`／`writerToken` | 仅本人、失效租约和一致停止证据可收口；不停止任何 unit |

`open.result` 返回 `id`、`hostAdmin`、`clientId`、`writerToken`、`leaseExpiresAt`、`mode`。将写入凭据保存在当前连接内存中，不放进多客户端共用的账号缓存、URL 或日志。保存会话 ID 供用户明确重连。

`exchange.args` 可包含：`input`（Base64，长度上限 12,000 字符）、`offset`、`rows`、`cols`。响应沿用 `data`（Base64）、`offset`、`exited`；按返回偏移读取，不从本地猜测偏移。逐条等待输入请求完成；门户按会话 FIFO 排序，单会话最多 4 个待处理请求、全局最多 24 个，超限返回 429。

单写租约为 30 秒，正常 exchange 续约。租约过期不会杀掉 PTY，但旧凭据不能继续输入或关闭它。另一客户端持有写入权时，普通重连拒绝；只有用户明确确认后才传 `takeover: true`。接管会换写入凭据，不能撤回已经被接受的命令。

网络错误／切换页面不应触发 `close`，也不应自动新建替代终端。明确“断开”使用 `detach`；显式“结束终端”才使用 `close`。持久 SSH 通道是后端内部优化，不新增浏览器流协议，也不改变上述字段或旧节点兼容路径。

`status.result` 使用 `protocol:"terminal-session-status-v1"`，包含原 `id`、`state:ALIVE|STOPPED|UNKNOWN`、`evidence`、`attachmentState`、`writerLeaseExpired`、`canCloseStopped`；不包含写入凭据、真实 cgroup 路径或宿主机文件路径。单位完整身份（含 InvocationID）、PID、cgroup、socket、spec/租约元数据前后不一致，或检查超时，均保持 `UNKNOWN`。无凭据 `close` 在原 ID 锁内重新核验两轮停止证据及元数据 identity，仅更新该 session receipt，返回同一协议、原 `id`、`closed:true,state:"STOPPED",metadataOnly:true`。其归属 tombstone 与项目围栏保留；正常新建不能复用 ID。活跃/未知/租约未过期/旧协议均拒绝，活跃终端的原单写关闭要求不变。执行桥新增的唯一固定操作为 `terminal.status`，不得使用终端通配授权。

## 项目文件上传的确认与恢复

`files.get` 和 `files.list` 为有界远端读取：使用既有全局 4 / 单节点 2 的读取准入，35 秒截止，调用前后重新核验会话及权限；截止后保留在途容量直到桥调用实际结束，不加入串行写队列。客户端只对读取执行有界重试，不重放写入。

新版 `files.get` 接受可选的 64 位小写十六进制 `fingerprint`，返回 `protocol:2,path,size,offset,data,eof,fingerprint`。指纹固定原账号、项目/任务、相对路径及源 stat 身份；每块读取前后核验，变化或请求指纹不符即拒绝。旧返回字段仍保留。CLI 的私人本地回执绑定精确来源和已落盘前缀，已有无回执文件拒绝采用；旧节点下载可用但不可自动恢复。节点 executor、门户和 CLI 配套发布才具备完整恢复契约。

项目锁竞争最多等待两秒取得原锁，超时返回可识别 busy；不重试操作体，也不改变 service-owned、单链接、私人权限或 no-follow 条件。`datasets.prepare` 内部目录鉴权使用数据库当前角色，个人数据传输仍使用 owner-only member 身份，管理员不因此获得其他账号材料。

`datasets.workspace.status` 的个人发布回执可含 `phase`（`SCANNING/REGISTERING/REGISTERED/ARCHIVE_INTENT/MATERIALIZING/COMPLETED`）。已确认登记的 `dataset/version/files/bytes` 在后续失败中保持；登记前不推断版本已存在。取锁失败可含 `failureKind:CACHE_BUSY` 与 `lockWait:{scope:CACHE|VERSION,limit:SINGLE_WAIT|TOTAL_BUDGET,timeoutSeconds:number}`，只解释已耗尽的等待边界，不返回锁路径或持锁者。旧回执无字段仍按未知；只读查询和重复原 key 不重新派发。明确 FAILED 后的受支持显式发布使用新 key、原目录和原名称，未变内容复用相同版本与已校验片段；集中仓库的旧发布禁用策略保持。

`files.upload.status {machine,project,area:"code",path,totalSize,sha256,uploadId?}` 仅查询当前账号的精确项目文件；首次可省略 `uploadId`，发现同路径、同大小、同完整 SHA 的现存上传。返回 `protocol:2` 及 `ABSENT / UPLOADING / COMPLETE / CONFLICT`；已知上传含原 `uploadId`、`receivedBytes`。`UPLOADING` 还必须有 `resumable:true` 才能续传。维护期间仍可查状态，不能借它写文件、发布或提交任务。

项目 `files.put` 的固定身份由账号、项目、路径、总长度、SHA256、uploadId 共同绑定。中间块重复发送同 offset/bytes 不会追加；最终提交保留完成回执，查询和原最终块恢复会核验目标内容及身份。已提交的目标被他人编辑或替换会拒绝恢复，不回滚或覆盖新内容。rename 已完成但最终回执尚未写入时，保留的 COMMITTING 意图用于核验结果，此时状态为 `COMPLETE,completionPending:true`；客户端须保持原 ID，在 `offset=totalSize` 发送空的 final 块收尾后才可发布，查询本身不写入。不能仅凭项目旧 READY 版本推断这次上传成功。

客户端先查状态，再继续原上传；遇未知 ACK 最多进行三轮有界恢复，且每轮先查询已确认偏移，不换 uploadId 或路径。旧格式未完成记录没有目标变化围栏，同内容返回 `legacy:true,resumable:false`，不同内容返回 `CONFLICT`，需人工核对，不自动清理或从零重开。传统非项目 `files.put` 不增加重放。完成后的恢复只校验目标并收尾回执，不再次 rename；尚未提交的首次上传／续传仍按显式 push 的替换语义执行，上传期间禁止同路径并发终端编辑，不能把平台锁或 stat 检查称为对外部写入的原子 CAS。配套新版不再以单文件 4 GiB 拒绝；超过该阈值只返回非阻断警告。完成状态的完整 hash 核验可能占用一次文件读取时间；超时只是未确认，不表示文件不存在。

CLI `gpuctl push-status LOCAL [REMOTE] --project PROJECT --machine MACHINE --json` 只读；`gpuctl push` 能恢复同内容的已确认上传。此功能不改变项目字节当前经门户中转的路径，也不冒称项目包走了数据集直传。

无需本机源的清理：`files.upload.list {machine,project,area:"code"}` 返回 `protocol:1,project,uploads`，每项 path/uploadId/totalSize/sha256/state/receivedBytes/cancelable/legacy，最多 64 个私人待上传对象。`files.upload.cancel {machine,project,area:"code",uploadId}` 只选精确 UUID，返回 `protocol:1,state:"CANCELED"|"ABSENT",uploadId`；ABSENT 不是删除完成证明。正规 UPLOADING/CANCELING 且原目标围栏匹配时，先持久 CANCELING，再清理未提交 staging 并保留幂等取消回执，目标变化仍拒绝。新版节点仅允许严格四字段旧记录且 service-owned 单链接片段明确小于 totalSize、无同 UUID 完成回执的软取消：在原 store lock 内先永久封住原 UUID，再用 renameat2 no-replace 将原登记与片段全部保留到私人回收区，不碰目标草稿或版本。部分移动后仍保留原 pending metadata 围栏，同 UUID 可显式继续取消；全尺寸、缺片段、COMMITTING、未知身份或碰撞仍拒绝。取消中 status 可返回 CANCELING，已确认软取消返回 CANCELED，两者都不标为可续传，原已取消 UUID 不能 files.put。list/status 可读重试，cancel 不自动重放；维护期间允许查询/停止，不允许继续上传。

## 数据集上传：控制面与文件字节分开

旧版本首次归档的管理入口是 `datasets.archive.enroll {machine,dataset,version,ownerId,key}`：`machine` 为已授权的本地训练节点，`version` 为完整哈希，`ownerId` 为不可变账号 ID，`key` 为本次 UUID。仅当前启用的管理员可调用；重复请求沿用同一 key，不在列表刷新时自动调用。只有指定 HDD 已有同名同版单 owner 的受保护 READY 原件才接受，返回归档阶段而非立即完成。阶段查询继续使用现有归档状态；`archive-retry` 不能代替首次纳管。此管理入口不放在普通用户操作栏。

若 HDD 尚无这版原件，管理员可在同一首次纳管请求中显式增加 `copyIfMissing:true`。服务只接受配置 HDD 的精确 `ABSENT` 证明；超时、撤权、孤立文件或未知状态都不触发复制。成功受理返回 `QUEUED`，固定登记身份和复制 key 后，复用受信节点传输队列异步建立原件，再完整校验、签发恢复授权并认证本机缓存，最终才是 `ARCHIVED`。受理不是备份完成；在此之前本机副本保持保护。刷新、门户重启、丢响应仍使用原意图及 key，不另建副本；失败需显式重试，取消不自动复活。旧请求不带该字段时保留“原件必须已存在”的行为；同一 key 不能切换复制意图。数据走既有节点传输，不经过 VPS。此字段不开放用户指定来源、URL、凭据或恢复证明。

归档复制期间的内部 `storage.archive.enrollment-check` 不再在全局缓存锁内解析大清单。首次完整校验在锁外执行，前后以单 owner、登记文件、READY 元信息和只读数据根的精确身份复核；重复请求可复用服务私有目录内最多 256 槽的校验摘要，但仍实时检查权限、保护角色、pin 和 staging。替换、注销、权限变更或未知 I/O 不会由旧摘要覆盖；摘要不是租约、恢复授权或 ARCHIVED 证明，完整内容校验仍由封存流程完成。

这项优化仅涉及 `deploy/storage-archive.py` 的内部检查及私有摘要目录。经过生产变体核对后可对该文件做精确原子热更新，新 RPC 使用新实现，不要求中断既有复制或重启 peer、训练、门户。它不改变单块 TLS 连接、目标落盘持久化或当前传输状态，不应把元信息基准的提速直接当作端到端吞吐提升。基准入口为 `tests/archive-enrollment-performance.bench.py`（支持 164,690 / 450,000 条目；临时元信息 fixture，不包含真实文件复制）。

`datasets.archive.retire {machine,dataset,version,ownerId,eventId,recoveryId}` 也是当前管理员专用入口，接受固定 HDD 同机 ingest（无 transfer、未确认归档）或完全未派发的 `QUEUED` ingest。后者必须 transferId/sourceDataset/grantId 均为 null、retryRequested 非 true、没有同 copyKey 的任何传输记录且不是 laneOwner；RPC 前保存持久 retirementIntent 并阻止该行的 dispatch/reconcile，前后复核登记上下文与准入条件。回包丢失或重启只保留待确认 fence，同请求可继续，不推断成功或启动传输。`recoveryId` 是正常注销的 `unregister-` 加 32 位小写十六进制回执，不接收客户端的 mode、grant、证明、路径或角色。后台私有 `storage.archive.retire` 复核原登记身份、完整清单、单 owner、已提交注销与无现存保护，再持久化该事件的 `RETIRED` 墓碑；旧 HDD 协议还检查 worker 从未创建且确认停止，QUEUED 内部模式只证明本来源注销。门户返回 `phase=FAILED` 并保留不可重试的 retired 原因；重复同一回执幂等，换回执、已派发跨机、已 seal 或 UNKNOWN 均拒绝，不清除其他 lane。私有 RPC 不向浏览器公开。

`datasets.archive.cancel-intent {archiveId,revision}` 仅当前启用的管理员可用，是未开始的
`BLOCKED` ingest 请求的控制面取消，不删除数据或伪造节点 ACK。`archiveId` 是原 64 位
ID，`revision` 是持久 `storage_archives.data` 完整 UTF-8 JSON 字节的 SHA-256；必须先核对
原记录，不接受 owner、路径、授权、mode 或客户端证明。仅 sourceDataset/transferId/grantId
明确为 null、未 retry/ACK、没有同 copyKey 的任何传输记录、未持有 lane 且无未释放依赖时
受理。全行 CAS、持久 lane/传输复核、永久 retired 墓碑和审计在同一 SQLite 事务完成；
lane 准入也在写事务内重读墓碑，旧 worker 或延迟 copy 准入不能复活原请求。
回包为 `state:CANCELED, controlOnly:true, dataDeleted:false`，丢回执或重启只沿相同
ID/revision 核对。维护状态仍保持；物理原件、副本、租约与 pin 不因此解除，后续数据删除
仍须全部节点的正常计划、围栏、隔离和回执。此接口不增加普通用户按钮或节点 RPC。

个人显示名使用 `datasets.label.get {machine,dataset}` 读取，`datasets.label.set {machine,dataset,displayName,revision}` 修改。名称为 1–80 个可见字符，允许中文，拒绝控制字符；`revision` 必须沿用最近查询值，409 冲突后请用户刷新决定，不自动覆盖。响应有规范逻辑 `dataset`、原 `name`、可空的 `displayName`、`revision`、`ownerId` 和 `scope:"personal"`。管理员代管时可显式增加 `ownerId`，普通成员不能指定他人。该名称仅作用于这位用户的显示视图，不重命名节点登记、版本或训练挂载路径，也不改变共享数据权限。

未设置个人显示名时，`name` 对严格节点生成格式 `^[uw]-[a-f0-9]{16}-([A-Za-z0-9][A-Za-z0-9_-]{0,39})$` 返回末尾的原上传／发布名称；其他 ID 原样返回。`dataset`、owner、revision 及 `displayName:null` 不变，不新建 label 行。网页兼容旧门户的原 ID 默认回包，但不会用前缀建立授权、逻辑别名或合并同名数据。

门户控制面顺序：

启用机械仓库策略后的新版客户端，新上传必须 allocation-first：只有本地没有旧 UUID／handle 时，先持久保存固定 intent UUID，调用 `datasets.upload.admission.create {machine,key,name,manifestBytes,manifestSha256,totalBytes,entries}`。门户在同一事务内持久绑定 owner、intent、随机服务器 `uploadId`、原 `requestedMachine`、固定 HDD `storageMachine`、authority 和完整 specification；回包 `protocol:"dataset-upload-admission-v1"`、原 `key`、`uploadId`、`requestedMachine/storageMachine/storageTier:"hdd"`、`specification`、`state:"ISSUED"|"BOUND"`。客户端保存回包后，以下 begin 的 `key` 使用该服务器 `uploadId`，`machine` 仍是原训练选择。分配丢 ACK 只调用 `datasets.upload.admission.status {machine,key}` 查询原映射（零节点 RPC），不存在或未知就停止，不换 key；`BOUND` 表示固定派发意图，不是节点成功证明。此路径不扫描无关旧节点；节点私有准入仅接受受信桥的完整固定 tuple，拒绝 legacy 会话和身份变更，未知能力或失败不回退旧 begin。

已有本地 UUID／handle 不自动 allocation 或重绑，仍按原 begin/status、全节点定位及原位置恢复；超时或离线不是 ABSENT，全节点确认 ABSENT 后也拒绝用旧裸 key 新建。策略启用时，新 `transfers.create kind=upload`／`transfer upload` 关闭，已持久传输仍按原 key/编号恢复。`state.datasetUploadAdmission {protocol:1,available}` 只说明门户策略/API，不能代替节点准入、容量、挂载或直传可达证明。

管理员可在独立 ingress 策略配置 `warehouses`，新 admission 按完整清单实际空间需求选择首个合格仓库，再原子固定 UUID、仓库及 authority；不新增用户选盘参数。容量告警本身不拒绝上传，实际不足、不可写或未知拒绝。`datasetUploadAdmission.targetMachine` 只是默认仓库预览；确定的写入位置始终使用 admission 的 `storageMachine`，续传、取消、签票都不能重新选择。新池上传 READY 事件与原 intent 匹配后在所属仓库核验，缓存认证沿固定 transfer 来源；旧 outbox、归档策略、journal 和 pins 不重写。配置及兼容边界见 [DATASET_INGRESS.md](DATASET_INGRESS.md)。

准入恢复的窄例外：`admission.status` 在授权有效、原映射不存在且无同 intent 在途检查时，返回 `404` 与 `code:"DATASET_ADMISSION_ABSENT"`。只有下一次用户明确发起相同规格上传时，客户端才可沿原 key 再调一次 create；初次失败只核对状态，保留容量/不可达原因。普通网关 404、超时、未知和已有 UUID 不自动重派。停用入口池不撤销 BOUND/ARCHIVED 的持久来源身份与历史别名。

仅管理员受保护入库配置 `allowDuringMaintenance:true` 可在维护期间放行当前服务端 admission 绑定的固定 HDD 上传；仍逐次复核 owner、机器权限、authority、spec 和节点容量，不接受客户端传该开关。此例外不修改 operational maintenance revision/global 状态，不放行训练、终端、项目、SSD／legacy 新建、通用传输或缓存准备，不能宣称全平台恢复。

1. `datasets.upload.begin`：`machine`、`name`、UUID `key`、`manifestBytes`、`manifestSha256`、`totalBytes`、`entries`；仅用户明确同意大文件中转时增加 `allowRelay: true`。
2. 从 `result` 保存 `uploadId`、`state`、`manifestOffset`、`chunkBytes` 和 `uploadTransport`。后者包含 `protocol`、`directAvailable`、`reason`、`relayLimitBytes`、`relayAllowed`。能力存在不代表当前电脑一定能连到节点。
3. 可直传时调用 `datasets.upload.direct-ticket`，参数为 `machine`、`uploadId`；使用它返回的授权入口。
4. 清单传完后通过门户 `datasets.upload.seal`；文件传完后通过门户 `datasets.upload.commit`。二者均传 `machine`、`uploadId`。
5. 用 `datasets.upload.status` 查询同一上传；可增加相对 `path` 查询文件。`SEALING`／`PUBLISHING` 是处理中，只有 `READY` 且数据集、版本和校验结果有效才表示可用于训练。

清单格式沿用 `schema: 1`、`directories`、`files`；文件条目包含 `path`、`size`、`sha256`。清单最多 64 MiB、目录及文件合计最多 500,000 项。路径必须是安全相对路径，遵守现有客户端的链接、文件身份和变动检查。

### 直传数据面

票据返回 `available`、`protocol="dataset-upload-v1"`、`endpoint`、`ticket`、`expiresAt`、`certificateSha256`、`chunkBytes`，新版另含可选的 `maxChunkBytes`。仅使用本次授权的 `endpoint`，不硬编码某台节点、IP 或门户地址。

| 节点请求 | 数据 |
| --- | --- |
| `POST /v1/uploads/<uploadId>/manifest?offset=<offset>` | 原始清单块 |
| `POST /v1/uploads/<uploadId>/chunk?offset=<offset>&path=<encodedRelativePath>` | 原始文件块 |
| `GET /v1/uploads/<uploadId>/status[?path=<encodedRelativePath>]` | 已确认的状态／偏移 |

设置 `Authorization: Bearer <ticket>`，POST 使用 `application/octet-stream`。清单块仍不超过 `chunkBytes`（1 MiB）；文件块可采用票据的 `maxChunkBytes`（仅允许 1 或 16 MiB），缺省回到 1 MiB。旧客户端继续发送 1 MiB 块，不需改变接口。节点在读取请求体前验证票据及其限额，确认仍意味着本块已持久写入，不能通过去掉落盘保证换取速度。

客户端应从 1 MiB 文件块起步：确认耗时低于 500 ms 后可升到已授权上限，耗时超过 8 秒则降回 1 MiB，避免慢网络被迫用大块。清单、VPS 中转及哈希扫描的块大小不变。续期授权可能降低限额；尚未发送的大块不能越过新限额，未知响应不自动重发或改走中转。网页可仍用原有 1 MiB 实现，不应仅凭后端升级就宣称网页已提速。

节点成功响应为 `{ok:true,result:...}`，不同于门户响应；manifest／chunk 的 `result.offset` 必须确认整块已写入。文件 status 的 `result.file` 包含路径、大小、SHA256、偏移及完成标记。

浏览器使用正常受信任 HTTPS、`credentials: "omit"`，不发送门户 Cookie。部署方须配置精确允许的门户 origin；遵循 Authorization／Content-Type 的 CORS 预检和需要时的私有网络预检，不用通配符或跳过证书检查。CLI 的门户签发证书固定实现不能直接代替浏览器证书信任。

票据有效期 5 分钟。过期／撤销后回门户查询并重新授权；续传仍用同一个 `uploadId` 和节点确认的偏移。不要从“请求发出”推断写入完成。节点禁用、配置变更和撤销会拒绝旧票据；账号权限变更不应被描述为所有已签票据立即失效。

### 中转边界

固定候选选路沿用 [校内直传](DIRECT_UPLOAD.md) 的 `routeSelection`／`datasets.upload.routes` 协议。全部匿名探测失败时，共享客户端选择器按已批准 `routeId` 输出静态失败分类；CLI 区分连接、超时、TLS／证书固定和回复中的节点／版本不匹配，浏览器无法确认网络原因时保留泛化失败。分类不回显入口 URL、原始异常、响应正文或实际节点身份，也不新增后端 API 字段、请求或票据权限。节点本地监听可用不能代替客户端入口可达；不得以升级客户端诊断冒称已修复网络。发布这项诊断须重建 CLI，并配套发布共享静态模块 `upload-routes.js`；无需更新节点服务。

沿用 `auto`／`direct`／`relay` 路由选择。`auto` 优先已授权直传；明确无直传入口时，最多 256 MiB 可走门户中转，大于该值必须用户明确同意。直传认证、TLS、网络或响应不确定时，不自动重发到 VPS；`direct` 从不允许中转。显式中转的 manifest／chunk 使用门户 `datasets.upload.manifest`／`datasets.upload.chunk` 的规范 Base64 `data`，不是 raw HTTP。

个人可写数据空间的 `datasets.workspace.put` 是另一套现有操作，当前仍是门户中转，不受数据集直传票据授权。不要仅改按钮文案就声称它已直传，也不要把 dataset 票据用于任意个人文件路径。大于 256 MiB 的 `data put` 同样要求显式中转同意。

## 数据仓库：目录发现不授予数据使用权

`datasets.catalog` 对所有启用的登录成员返回全节点白名单元数据；零机器额度时可省略 `machine` 或传 `null`，仅浏览。提供机器时必须是清单内 ID，不能传任意地址。`datasets.capacity`、上传及其他执行接口继续要求机器授权。

版本和每个 `locations` 条目均返回显式 `canUse`。界面不能单凭 `state: READY` 解锁训练；`canPrepare`、复制来源和本机就绪用于执行时都须来自本人有权使用的位置。私有本机 READY 与本人远端 READY 并列时，不可误称本人本机已就绪。后端的准备、标签修改、提交及自动选机也独立检查使用权限。

内部发现只能执行固定 `datasets.list` 元数据读取。响应不转发 owner IDs、文件清单、宿主路径、恢复票据或他人的错误/操作编号，节点 `owners` 不改。未知旧节点授权只按本人受限列表中的精确数据集和完整版本确认，不默认允许。客户端不得提供内部身份或 `hostAdmin`，不因目录可见获得管理权限。

目录发现兼容尚未提供 `datasetDelete:1` 的节点，不要求部署新删除协议。删除能力仍须全节点确认且账号已有机器授权；零额度成员的目录返回 `datasetDelete:0`。新节点的 `deletionPermissions.memberAllowed` 只采用本人受限列表对同机、同数据集、同完整版本返回的许可，不继承内部发现身份的权限；证明失败只关闭删除许可，不把已确认的目录元数据隐藏。

## 已被新版替代的旧归档原件（管理员）

切换可信配置的默认仓库机器，不会迁移或重标旧归档。相同受信 `authority` 下，原记录的完整 `policyKey`、已知源机器与固定引用匹配时，历史来源仍可展示并按数据归属读取；`archiveMachine` 始终是该记录自身的来源。别名按来源机器隔离，不会给其他账号的同名数据套用当前用户的标签。节点当前状态和恢复证明仍须独立核实，历史 `ARCHIVED` 不证明新仓库已有完整原件。

新登记、复制认证和后台派发仅使用当前策略。旧待处理记录不会因改默认机器而自动重派、重试或改写，未知旧 lane 仍保留。显式退役仍绑定原 journal 身份、正常注销回执和原来源机器；旧版与替代版必须在同一 authority 源上认证，跨来源替代在任何节点调用之前拒绝。它不是跨仓库迁移协议，不能用新仓库的 grant 绕过旧原件保护。

`datasets.archive.retire-authority` 是当前管理员的显式维护操作，不是普通删除或解除固定按钮。参数：

```json
{"machine":"<旧缓存节点>","dataset":"<旧缓存ID>","version":"<旧完整版本>","ownerId":"<所属账号>","recoveryId":"unregister-<旧缓存正常注销回执>","replacement":{"machine":"<新缓存节点>","dataset":"<新数据集ID>","version":"<新完整版本>"},"key":"<固定UUID>"}
```

服务端只接受已确认归档的同一账号旧版及已独立完成认证的新版本，不接受客户端传 grant、清单证明、路径或任意节点。新原件必须实际保留在指定 HDD、处于保护状态，完整清单包含旧版每个文件的路径、大小、SHA256 及目录；`QUEUED`、复制完成或只有 `READY` 都不能替代归档证明。旧缓存必须已经通过正常注销流程移除，其他引用、租约、固定标记、活跃或未知 worker 会阻止退役。

处理顺序为持久化门户退役意图、验证旧缓存 `REMOVAL`、永久封住旧恢复授权、验证新原件、封住旧原件的再授权与读取、移除一个精确匹配的 authority 标记，最后调用正常异步注销。只针对这一旧版本；不会取消训练、移除其他标记或自动删除新副本。后台注销还绑定原登记的文件身份与单一 owner，防止同名版本被重建或共享后误删。

重复相同 `key` 查询并推进原操作，超时不换 key。待确认响应保留 `phase: ARCHIVED` 但 `originalRetained: false`，并包含 `retirement.state`（如 `FENCING`、`UNREGISTERING`、`FAILED`、`UNKNOWN`）；这不是已退役。只有正常注销回执确认 `UNREGISTERED` 后才成为不可归档重试的 `phase: FAILED` / `authority-retired` 历史记录。若注销明确 `FAILED` 且 worker 已确认停止，管理员可在完全相同请求中另加 `retryKey: <新固定UUID>` 明确重试这一注销步骤；新 attempt 在派发前落盘，回包丢失沿用该 retryKey。`UNKNOWN`、仍运行、换旧 key 或换 replacement 都不能重试删除。

发布此接口须先部署匹配的 `dataset-cache.py`、`storage-authority.py`、`storage-retirement.py`、`storage-archive.py`、`node-executor.py` 和 runtime 清单，再发布门户 `storage-archive.mjs` / `execution.mjs`。已有私有 `storage.archive.retire` RPC 复用，不新增公开 peer 写入口或 VPS worker 权限。源节点常驻 transfer-peer 持有旧模块实例：必须确认无活动传输/恢复/认证 worker 后，逐节点更新常驻服务并验证带认证的 `retirement-guard` 能力；仅替换磁盘上的 Python 文件不算完成。旧 peer 不提供该能力时操作拒绝，保护不变。不能在旧消费者仍运行时启用退役。

回滚前先禁止新的退役请求。若已写入任何 source/target tombstone，必须保留识别这些围栏的新 native 代码及所有退役 journal；不能回滚到会忽略围栏的旧 peer，也不能删除 tombstone 或把旧数据重新登记来“恢复”。门户可停用新入口，未完成的同一意图保留待人工核验，正常数据和训练服务无需重启。

## 管理员手动缓存标记

`datasets.storage.status` 可带 `{machine,dataset,version,pinId}` 查询精确标记，必须同时给完整版本；返回 `version.manualPinProtocol:1` 和 `version.manualPin:{pinId,owner,present}`。`owner` 由当前认证主体确定，不能从浏览器传入。查询不创建标记；其他账号的标记和 `authority-` 标记拒绝访问。`pin/unpin` 在节点锁内再次核验归属，不因调用者是管理员就删除他人的标记。

前端按账号、机器、物理数据集名及完整版本持久保存操作身份；回包丢失后只读核对原 `pinId`，不重新生成 UUID。节点未提供精确能力或查询未知时禁用相应写操作，总 `pinCount` 不是本人标记的证明。预算查询只在数据集页展开或明确刷新时发起，不随全站状态刷新轮询。

## 项目容量警告（需 CLI 与节点配套发布）

项目发布、本地导入和代码同步取消固定 50 GiB 字节配额，单文件上传／Git 同步取消 4 GiB 配额，固定 OCI 镜像及 portable bundle 取消 100 GiB 镜像配额。所有字节总量／偏移仍须是 0–`Number.MAX_SAFE_INTEGER` 的精确整数；这只是协议数字边界，不是可分配容量。条目数量、清单大小、片段大小、磁盘真实余量、已配置的内核配额、挂载／所有权／来源身份和 SHA256 检查保留；不因超出警告而换 key、迁移权重到数据集、降低校验或重放终端。

- `projects.publish` 的 READY 结果、`projects.local-import.status`（扫描总量已知后）、`projects.sync.*` 汇总和 `projects.copy.status`（固定 import 载荷总量已知后）提供 `warnings`。超过默认 50 GiB 返回 `{code:"LARGE_PROJECT",bytes,warningBytes,blocking:false}`；未超量为 `[]`。本地导入的 bytes 包含既有草稿加新复制字节，不表示 HOME／全部历史版本或整个磁盘用量。
- 项目 `files.put`／`files.upload.status` 按固定 `totalSize` 提供同形状的 `LARGE_FILE`，默认警告阈值 4 GiB。CLI `push` 在完整散列前也打印该警告，仍查询原上传并验证完整回执。警告不说明完成、剩余空间充足或有权写入。
- 后端字节警告不能解除旧网页 100 MiB 文件选择限制；网页入口须由前端配套。现有可选内核 byte/inode 硬配额不在此源码改动中自动修改，实际配置由部署维护者核对。未启用配额仍不等于无限物理空间。

新的内容版本仍复制代码／权重到独立不可变 release；相同内容摘要复用既有 release，不自动删除旧版本，未新增跨版本去重。预留空间检查据实际复制字节判定。不得以容量限制已取消推断旧归档可删除。

## 云端文件：服务器文件，不是电脑上传

`cloud.files.*` 处理选定节点上当前用户的个人数据文件；成员不会得到后台云账号、CD2 令牌或私人云盘浏览权限。

| 操作 | 参数（均包含 `machine`） |
| --- | --- |
| `cloud.files.info`／`list` | 无额外参数 |
| `cloud.files.upload` | UUID `key`、个人数据空间相对 `path` |
| `cloud.files.verify` | UUID `key`、`fileId` |
| `cloud.files.download` | UUID `key`、`fileId`、新目标相对 `path` |
| `cloud.files.status`／`cancel` | `operationId` |

先用 `info.result.enabled` 判断该节点是否启用。`list.result` 为 `files`、`total`、`limit`；操作响应沿用 `operationId`、`action`、`fileId`（适用时）、`path`、`state`、`phase`、`bytes`、`totalBytes`、`sha256`、`error`／`errorCode`、`canResume`、`vpsRelay` 等已有字段。`QUEUED`／`RUNNING` 不是完成，`VERIFYING` 也不是可靠副本；显示真实状态，只有 `VERIFIED` 后才允许按现有规则取回。

后台节点与云盘直接传文件，门户负责鉴权及元数据。不能把这组接口绑定电脑文件选择器后称为“电脑直传云盘”；电脑文件必须先通过可达的节点直传、服务器拉取链接或明确中转进入个人数据空间。上传回执丢失先查原操作 ID，不换 `key` 重传；下载续传复用原键和目标身份，由服务端核验前缀，不覆盖现有文件。

另有 `cloud.inspect` 和 `cloud.import.start/status/list/cancel/resume/discard` 用于已批准来源的节点直接取件。HTTPS 来源和阿里云盘分享解析是不同能力；后台已登录、`aliyunConnected` 或 `nodeDirect` 字段不能证明分享链接能够下载。

## 验收范围与未开放边界

截至 2026-10-05，受限测试节点完成普通成员的真实 4 MiB 校园直传、1 MiB ACK 后断线续传、发布后独立全文 SHA256 校验，以及可信证书、允许 origin／外部 origin 拒绝检查；私人云文件也完成普通成员 4 MiB 上传、核验、取回和独立读回。它们不是全节点、全校园来源、校外可达或 TB 级性能验收。

- **网页接入须单独验收**：已有目录上传仍可能选择门户中转。按真实请求路径呈现路线，不能因 CLI／节点验收通过就标记所有网页上传已绕过 VPS。
- **公网阿里分享尚不可宣称可用**：当前 CD2 分享接入能力未开放，原生分享下载链接请求实测返回 HTTP 410；保留已有节点云文件功能，不用反复重试或扩大后台权限伪造成功。
- **能力按节点和入口判断**：个人容器、持久终端和直传是独立的启用范围，不从管理员角色或仓库源码推断已全面部署。
- **证书与网络是部署责任**：入口范围、证书更新和客户端真实可达性须持续核验；默认不承诺自动续签或任意校园 NAT 穿透。

前端实现完后至少验收：零授权拒绝、独立终端与显式接管、断线不重放、跨账号拒绝、真实 raw 文件路径、续传偏移、最终校验及无直达入口的大文件拒绝。不得只用健康页或文案截图代替业务测试。


## 版本删除（PR-N，节点与门户分阶段发布）

- `datasets.unregister {machine,dataset,version?}`：新节点校验个人来源和最后副本；成员必须指定完整 version，旧/共享/来源不明仅管理员。管理员在新旧节点上都复用 PR-M2 的 `createDatasetRemovalGuard(service,principal).withProtectedRemoval(...)`：跨机器 dataset/version 锁覆盖实时核验和 bridge 派发，必须证明另有完整副本，否则409 `LAST_COPY_UNPROVEN`。旧能力仅管理员可用，请求形状仍为 `{...reference,userId,hostAdmin:true}`；cap1 加私有 `protocol:'dataset-delete-node-v1'`，管理员另带守卫实际证明的完整版本集合 `portalProvedOtherCopy`。节点只对 hostAdmin 接受这份精确证明，版本不在集合中、租约、pin、数据库原件均拒绝；旧 executor/worker 拒绝 v1 请求和任务类型，能力读取之后回滚也不能执行旧清除。客户端不能传协议或证明。已派发或未知目标排除及解除规则完全沿用 M2，见 [DATASETS.md「管理员：清缓存与注销登记」](DATASETS.md#管理员清缓存与注销登记)。门户围栏在车道之前检查；车道内再次出现明确零派发拒绝时，只清本次 request_id 的空编号排除。能力或清单查询失败不能证明不存在。
  配套升级 executor/cache 后，管理员可沿相同入口注销单 owner、正确个人命名空间且 **0 个版本** 的空登记。门户完整清单读取仅允许私有空版本集合；节点自己核实并绑定 registry、无载荷/租约/来源/退役围栏、已 DISCARDED 上传、无预留或绑定及默认孤立 tier 的完整身份，在后台每个最终移动检查点重核。非默认 tier、未知依赖或任何版本均拒绝，默认 tier 与原上传回执原样保留。全局上传预留不含数据集身份，存在时保守拒绝；旧节点也拒绝空证明，不回退裸删除。客户端字段、成员权限及正常版本最后副本保护不变；cap1 本身不能替代这两个 helper 的配套发布核对。
- `datasets.delete {dataset,version,key}`：key 为 UUID；客户端不传 machine、owner、角色、依赖或期限。服务从完整可信节点清单、可信副本/归档记录及实际 authority grant 枚举所有物理名称。所有节点 cap1 后先持久化任务/子 UUID；所有计划均确认调用者权限后，原子建立门户围栏，再派发节点围栏。节点写入之前 BLOCKED 原子释放本任务的门户围栏。相同 key 不重复执行。零授权、跨账号、旧能力、未知依赖均拒绝/停止。
- `datasets.delete.status {key}` **或** `{operationId}`：只查询固定原节点编号，可补确认迟到回执，永不派发下一步。查询维护期间可用。返回 `operationId,key,dataset,version,state,steps,events,createdAt,updatedAt,retainUntil?`；不返回 owner ID、路径、inode、grant/token 或私有证明。状态 `PLANNED/RUNNING/REMOVING_CACHES/RETIRING_ORIGINAL/DELETED/BLOCKED/FAILED/UNKNOWN/WAITING_CONTINUE/CANCELING/CANCELED`。`DELETED` 严格要求每个物理命名空间的当前本代次 `ISOLATED` 回执和至少一份完整数据保留；期限后允许实际固定 `PURGED` 回执，步骤据实显示。历史 phase 文件不能代替当前回执；实际恢复转 `BLOCKED` 并确认对应步骤 `RESTORED`，离线/缺失/错代次转 `UNKNOWN`，不接受外部 `REVOKED/RETIRED` 代替。
- `datasets.delete.restore {operationId,machine}`：仅管理员（CLI 或网页确认后），完整可信清单先重查 cap1。恢复原源时，同一任务全部步骤一起恢复；完整/被驱逐副本还原登记和实际保留数据，PURGED 副本凭精确源恢复回执释放围栏，不声称已清除的字节又存在。尚未清除但已到期的副本也仅在固定原源已恢复后才能还原。返回 `RESTORED`、明确拒绝的 `FAILED` 或 `UNKNOWN`；失败的固定恢复阶段可按下面的管理员重试规则重试，已确认成功只查询。普通到期恢复、占名或证据不明失败关闭。网页入口绑定任务中已确认的完整保留副本，未知回执只查询原任务。
- `datasets.delete.continue {operationId}`：仅管理员。沿用原发起人的身份、角色和当前授权；原403拒绝任务不可升级成管理员删除，管理员必须自己新建任务。先查原编号，只有原阶段 FAILED 或无结果且 systemd 明确 STOPPED，才可显式重派同一固定阶段；请求使用新的私有 attempt key 去重，节点保存每次尝试和原失败回执，journal 续做原事务。RUNNING/UNKNOWN 不重派，成功阶段不重派。恢复、取消或重新登记过的任务不能继续删除。门户重启后未完成推进显示 `WAITING_CONTINUE`、“等待继续（门户已重启）”及 `canContinue:true`；查询本身不启动任何步骤。
  正常受理继续时，先持久化 `RUNNING` 并移除上一轮 error，再启动后台 observe/检查；保存失败零启动，原 worker 仍在运行则保持等待。客户端保持本次登录，沿原编号查询新的完成或停止结果，不因上一轮 `UNKNOWN` 或仅 updatedAt 改变而退出登录。后台仍逐次重核当前认证和原发起人权限；退出登录、撤权或超时不会授权重放。
- `datasets.delete.cancel {operationId}`：仅管理员，维护期也可用。停止门户推进并确认旧 worker STOPPED；没有 journal 或确无移动的步骤直接解除围栏，部分移动只按固定 inode 回滚，完整隔离恢复。取消永远不调用 isolate、不继续撤销 grant；已撤销授权保持撤销，数据使用新登记。取消 FAILED 后可显式重试原 cancel 阶段，条件同上。`CANCELED` 转换、查询及重复取消都幂等修补门户围栏，避免最后回执与门户重启间留下残留。结果 `CANCELING/CANCELED/FAILED/UNKNOWN`，未知终止状态仍拒绝。
- `datasets.delete.registration.discard {operationId,machine,key,dataset?}`：管理员 CLI 专用，完整清单 cap1 门控。dataset 缺省使用任务名称；若指定则只能匹配任务在该机器的固定物理步骤，不接受路径、owner、角色或代次覆盖。固定 key 与审计在私有 RPC 前持久化，成功返回 `DISCARDED`，回执未知为 `UNKNOWN`，只允许显式沿用同一 key 续做元数据撤回。节点从子 operationId 推导数据和版本，只在当前 PURGED 代次、准备 inode 从未安装且无活数据/保护时移动意图到私有审计区。不会删除载荷或解除墓碑；成员、旧能力、错误绑定或审计失败均零派发。
- `datasets.catalog/capacity`：`datasetDelete:1` 仅在完整可信清单每个节点的私有能力回执全部确认后投影；否则 0。新节点 list 提供安全的 `deletionPermissions`，`memberAllowed:false` 时界面隐藏成员删除，并在 ⓘ 中提示“这份数据只能由管理员删除”；旧节点缺字段按不可用处理，不从 owners 猜权限。
- 私有桥 `storage.dataset-delete.{capabilities,locations,registration,registration-discard,plan,fence,isolate,status,restore,release-absence,cancel,commit}` 不接受公共/peer/upload ticket 请求。UID/hostAdmin 来自当前登录身份。限额退役 worker 没有24小时 RuntimeMaxSec；普通 dataset worker 原限时保持。phase launch 固定且先持久化，管理员重试用私有 retryKey 保存 attempt 审计，绝不改变目标、原身份或恢复源。节点先读 systemd 活动再读结果；`stoppedPhases` 明确列出已停止阶段，`runningPhases` 即使回执已落盘也保留实际仍运行的 worker；门户继续/恢复/取消仍先等待它退出。RUNNING 查询不等待载荷锁。`registration` 只读新登记证明；清除后由有权用户显式重新上传/工作区发布或管理员本机重新登记才创建新的 inode 和来源，旧后台导入、prepare、复制、归档不能越过 PURGED 墓碑。门户仅匹配原节点任务/快照/代次和当前账号权限后解除这个位置的旧围栏。其他位置需要管理员对原任务的完整新源执行 restore 来恢复或释放；新源未 READY、证明改变或权限改变均拒绝。旧 grant/token 永久不复活。

DELETED 只覆盖当前逻辑版本及固定授权依赖；其他名称下的副本不受影响（transfers 产生的独立副本）。已登记但被驱逐的步骤和空命名空间，恢复原完整来源后都释放本任务墓碑。RESTORING 可在截止后完成；全任务隔离确认才为节点到期清理提交许可，部分任务不因7天到期丢恢复材料。物理清除还要求内核 NTP 已同步（STA_UNSYNC 未置位），墙钟过期单独不足；本实现不采用单调时长替代。跨节点最低保留截止允许5分钟时差，否则显示待确认并保留继续/取消出口。

第四轮恢复边界：已完成的隔离 journal 只补投影后恢复，取消不再次隔离；首次回滚保留个人来源证明。正在运行的原 worker 保持“仍在进行”的等待，`canContinue:false`；CANCELING 不允许继续。终态门户墓碑只拦精确版本的后台重建，不永久阻断整数据集的普通注销。未提交收集许可的完整 peer 可从保留字节恢复，缺失或损坏的提交回执不能被推断为未提交。

已完成普通注销的 cache 别名仍参与固定授权依赖枚举。节点私有 `completed-removal-alias-v1` 证明绑定完整 `REMOVAL`、归档登记 inode/清单、所有者、tier 与配置适配器的精确 grant；要求没有载荷、租约、来源或 pins。它沿用 `dataset-version-absence-v1` 的 plan/fence/isolate，不新增公开证明字段、操作或忽略依赖的参数，审计与 tier 保持原地。初次验证清单后，以完整文件身份和小证明 CAS 核对后续阶段，不反复解析大清单。缺失、漂移或未知状态失败关闭；取消和源恢复仅释放已证明的名称围栏，不重新签发旧 grant，新登记重置旧 recovery。

门户内部按 `locations` 对每个物理名称证明的固定引用集合规划：无登记别名的 `plan` 携带已选择完整来源的 authorization 与仅该名称的全部 references；有登记别名不携带这些外供字段，沿用实际本地快照。完整校验位置后才规划，不按第一条位置提前写部分引用；重复位置不重复计划，外来或非法引用失败关闭。源 grant 顺序保持，同一原子 UUID 已有计划的引用不能改变。公开参数、只读 status 和显式原任务 continue 的行为不变，不需要节点降低 absence 检查或重新加载服务。

版本删除的源撤销只写 `AuthorityStore` 的永久 grant 撤销记录，目标版本围栏不等于外部 `StorageRetirement.target` 的 installed-authority 墓碑。因此目标可以继续只读核对固定本地 receipt、完成 commit 和历史 status，但源的 guard/manifest/get 永久拒绝旧 token。已有 installed-authority 墓碑依然拒绝本地投影，本接口不绕过或删改它；源恢复也不清除旧 grant 撤销记录。

外部替代退役不被重写：其锁、权限、永久 reference/grant fence 和 API 契约原样保留。本功能仅处理没有替代的版本删除；外部严格完整替代证明只是普通注销“不是最后一份”的实际可重建依据，并在日志单独标为“外部替代退役”。来源不明单 owner 仅管理员。保留期间计费不因目录移动释放；到期清理仅接原本明确启用的 storage 收集服务，本 PR 不开 timer、不部署节点。前端由后续 m4 接口整合。

### 缺失缓存父目录的目录展示

`datasets.list` 对已通过登记与当前 ACL 校验、但缺少必需 READY/staging 父目录的固定版本返回
`state:"UNKNOWN",canPrepare:false,deletionBlocked:true,errorCode:"CACHE_METADATA_INCOMPLETE"`
和固定错误提示。其他健康版本继续返回；未知行没有供后台状态使用的可信快照，
不会加入恢复／删除权限或变成 READY。不会由列表重建父目录。此展示处理只捕获
专门的父目录缺失错误；损坏登记、权限撤销、unsafe link 和 I/O 错误保持原拒绝。
`status/prepare/lease/unregister` 与一般目录存在检查不使用这个展示降级，
缺父目录仍拒绝，不能把 UNKNOWN 当作安全不存在或准备／删除授权。

## 个人与按成员的项目空间（只读，节点需配套更新）

`storage.usage.mine {}` 只返回当前会话账号；`storage.usage.users {}` 仅管理员可调用。
两项均可在维护期间读取，不接受 machine、userId、hostAdmin、path 或其他额外参数。
没有新增数据库表、schema、写入操作或磁盘额度限制。

```js
// storage.usage.mine
{protocol:1, checkedAt:"UTC ISO8601", machines:[{
  machine:"清单 ID", available:true, collectedAt:"UTC ISO8601 或 null",
  complete:true, projectBytes:8192, projects:[{project:"项目 ID", name:"项目名称", bytes:4096}]
}]}
// storage.usage.users（含已停用账号的现有数据；label 为账号显示名）
{protocol:1, checkedAt:"UTC ISO8601", users:[{
  userId:"账号 ID", label:"显示名", machines:[/* 同上 */]
}]}
```

旧节点没有拆分协议、未配置执行桥或读取失败时，该机器为
`{machine,available:false,reason,collectedAt:null,complete:false,projectBytes:null,projects:[]}`。
节点支持协议但采样不完整时为 `available:true,complete:false,projectBytes:null`；
个别项目无法确定时其 bytes 为 null。只有完整采样证实该账号不存在项目时才返回 0。
checkedAt 是门户查询时间；collectedAt 是独立的项目采集时间，不用磁盘容量时间代替。

节点只追加 `datasets.capacity.storageOverview.cache.projectUsage`：
`{protocol:1,complete,owners:[{owner,complete,projectBytes}],projects:[{owner,project,name,bytes}]}`。
owner 是节点固定目录的 SHA-256 身份（旧 users 目录为 32 位前缀），不是可见用户名；
Portal 从会话账号计算身份，严格筛选后才返回。现有 projectBytes、projectUsageComplete、
projectCollectedAt 等字段与总量口径保留；现有成员 capacity 和 overview 不透出拆分身份。

拆分与原总量使用同一次 0.5 秒／100000 项有界采样和 300 秒私有观测缓存。
计入项目草稿、发布、HOME、环境、结果等受管目录的实际分配块，按设备与 inode 去重；
账号目录公共块计入账号合计，不重复算进每个项目。跨项目硬链接、OCI 共享层、
未能关联到项目的旧用户文件不分摊，相关账号合计或项目返回 null／false。
固定项目目录里的有效 project.json 证明所属；name 当前为该项目 ID。
读取不修改项目、上传、租约或配额，仅沿用现有采样器的私有观测缓存。

Portal 只调用现有字面量 `datasets.capacity`，并行、有 5 秒读取上限，缓存最多 300 秒；
超时不会反复创建未结束的节点读取。节点未安装这一增量时 Portal 返回 available:false。
本 PR 不部署节点，需后端在下一次 5090 独立运行时安装时一起带上 storage-observation.py。
