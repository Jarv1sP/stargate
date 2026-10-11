# 测试与发布检查

`shared-data.test.py` 验证已有共享目录默认用于开发和训练、100 个读者共用源 inode、不复制／改权限／检查数据写入预留、缺失目录和旧运行器不虚报可用、OCI 挂载保持只读、现有受管缓存读取保护不绕过。可用时还运行实际 bubblewrap 命名空间，读取原样本并验证写入得到 EROFS；缺少运行器或内核不允许用户命名空间时明确 skip。它不是真实 Podman/GPU 或生产数据验收。个人容器页面既有 smoke 增加成员／管理员三宽读取路径显示。

可选的真实训练适配器测试：在已安装 PyTorch 和 NumPy 的本地环境运行
`python3 tests/elastic-ddp-smoke.py`。只用 CPU/Gloo 和临时目录，不提交 GPUQ
任务、不连接服务器。覆盖 1→3 与 2→3 rank 扩容：global batch=12、micro batch=2，
梯度累计分别为 6/3→2；实际 checkpoint 退出码为 75，恢复模型、优化器、scheduler、
已存在 rank 的 Python/NumPy/PyTorch RNG 与 epoch，LR 保持不变；最终参数和动量与固定
global batch 的单进程参考在 FP64 容差 1e-12 内一致。另测三 rank 保存失败共识，
不能产生 ACK、checkpoint 或恢复成功结果。新增 rank 没有旧 RNG 状态，按 rank 确定性
初始化；这里不承诺随机增强、Dropout、CUDA/NCCL 或真实抢占调度的逐位复现。

## 每个 PR 的离线自动测试

训练存储准入由 `training-storage.test.js/.py`、`personal-oci-inodes.test.py`、
`training-storage-dispatch.test.js` 与 AUTO 回归覆盖真实 byte/inode、展开镜像、
同卷去重、预留／在途占用、旧／未知能力、固定目标及准备／派发前重新验证。
`training-dataset-capabilities.test.js`、`training-datasets.test.js` 和
`dataset-training-source.test.py` 分别验证公开只读投影、固定本机仓库版本和持久
source-mode租约；无缓存或其他机器回退。`training-storage-http.test.js` 用隔离
SQLite及真实loopback HTTP核对独立读取lane、维护、鉴权、409/503安全数字投影和
拒绝时零任务／零准备／零GPU派发；这是离线契约，不冒充生产节点或八卡训练验收。
旧目录HTTP夹具的维护请求须使用真实 `scope:"all",revision:0` 并检查200，不能因
忽略错误的 `scope:"global"` 请求而虚称验证了维护期间读取。

`dataset-files.test.js`、`dataset-files-http.test.js`、`dataset-files.test.py` 和
`dataset-files-bridge.test.py` 验证固定版本目录页：member 内容 ACL 与管理员元数据可见性
分离、零额度／仓库源授权、旧节点明确 unavailable、200 项／64 KiB 上限、原源分页、
撤权／丢回执／malformed response、no-follow 单链接和整页版本锁、不创建持久下载租约。
独立 `--dataset-files-rpc` 只接受三个 literal metadata RPC，上传／终端／写操作拒绝。
总览新增的项目实际字节、last-success 时间与动态目录能力有正反投影测试；旧节点不假 0。
`storage-project-observation.test.py` 单独验证有界真实采样、inode 去重、挂载／根身份变化、
缓存与未知。所有文件、配置、锁和服务夹具仅在一次性本地目录，不访问生产。

开发首轮 Node 的真实 Python 桥夹具误用了 macOS `/var` symlink 临时根；按既有 no-follow
边界设 `TMPDIR=/private/tmp` 并使用真实 Python 3.12 后重跑，无保护放宽。Portal image
静态 COPY 验证还要求新增源码先加入 Git index，不能把未跟踪文件视为镜像来源。全
浏览器旧主线首轮停在 cloud-files 夹具，整合已有主线夹具修正后另验；不据此改运行时权限。

`storage-archive-intent-cancel.test.js` 用独立 SQLite 验证原 ID/完整 JSON 字节 CAS、
当前管理员、BLOCKED 严格准入、未知/已派发/持久 lane/传输保护拒绝、审计失败和撤权
回滚、丢回执重启、旧 worker 与延迟 copy 准入零派发。正常删除图仍要求四节点真实
计划和隔离，不把控制面取消当作数据删除；真实 loopback HTTP 另核对登录、维护保留
和同编号恢复，不连接生产。首轮三个失败是夹具把已 BLOCKED 的静默跳过误当异常、
遗漏中文撤权报错和误认为不存在副本可省略隔离；改为显式旧 QUEUED worker、确切
撤权契约和四节点完整隔离断言，没有放宽运行时保护。另一个 HTTP 启动失败来自
新工作树尚未安装 qrcode 依赖，完成规定依赖和客户端构建后通过。

```sh
npm ci --ignore-scripts
npm test
npm run test:python
npx playwright install --with-deps chromium
for test in tests/*-smoke.mjs tests/*-browser.mjs; do
  node "$test" || exit $?
done
python3 scripts/build-gpuq.py
python3 build/gpuq.pyz --help
python3 -m compileall -q deploy gpuq scripts
python3 scripts/check-public-tree.py
docker build -f deploy/Dockerfile -t gpuq-console:test .
```

仓库默认机器切换用 `storage-archive-policy-cutover.test.js` 和 `archive-source-alias-consumers.test.js` 的真实 SQLite/Portal 数据读取夹具验收：旧 journal 不改写、原来源/别名隔离、跨账号与未知事实不授予权限、旧派发/重试零 RPC、同源显式退役及丢回执恢复、跨 authority 替代在 RPC 前拒绝。节点 grant、真实迁移及生产配置切换仍须单独验收，测试不会连接生产或移动用户数据。

覆盖账号/中文名、密码和会话、邀请码、角色、乐观授权写入、并发配额、幂等提交、超时保留、所有权、root 拒绝、API/CLI、上传越界/软链接、部署清单验证。不访问生产节点、不使用真实账号密码，不因 PR 启动真实训练。

浏览器测试启动临时本地后台和独立数据库，验证注册自动登录、初始零额度、管理员自动发现待处理用户、授权后用户自动更新、编辑草稿不被刷新覆盖、注册码再次可读、引导 admin 退役与移动端布局。不会连接真实执行桥或 GPU；可选 `CHROME_PATH` 使用本地 Chrome，`UI_SCREENSHOTS` 指定私有截图目录。

`ui-smoke.mjs` 分别核验额度编辑器唯一的保存／批准主操作、账号创建入口及未保存草稿保护、邀请面板唯一的生成／换新操作和注册码持久性；不以整个成员页的 `.primary` 数量替代业务条件，以免合法的新入口使组合基线误报。

`starbase-ui-smoke.mjs` 保留成员／管理员四种宽度的全部 48 项反馈几何检查。
有限动画按真实 `playState/pending` 有界等待，不永久等待已结束 CSS transition 的旧
`finished` Promise；不会取消、强制结束动画或禁用动态。可见的暂停动画必须超时拒绝，
仅显式 hidden/inert 且实际不渲染的子树可排除。`animation-settle-browser.mjs` 用真实
浏览器时间线分别验证自然结束、旧 Promise 不结束、可见暂停／可见 inert 拒绝、隐藏与
重新显示、无限遥测继续运行；总控既有 CI 入口会先运行这些正反例，不连接生产或改变运行时 CSS。
总控夹具还为管理员存储总览提供精确的只读 status／dry-run plan 回包，断言每台各一次、
仅可信管理员身份进入假桥且无保留／清理写入；所有浏览器错误仍必须为零。

仓库与外壳几何夹具在启用传输协议时提供真实的 `transfers.list` 空目录契约：
仅初始 `cursor:0`，总控读者可显式附 `limit:50`，响应为
`{transfers:[],nextCursor:null}`；身份仍来自已登录会话，不接受客户端指定 owner。
首轮离线失败是夹具漏接该只读查询；补齐后仍拒绝其他未知／写操作，并保留全部
角色、布局、无越权与零浏览器错误断言。此修正不改运行时接口、权限或轮询。

`admin-quota-ui-smoke.mjs` 单独验证管理员请求超过物理清单总数时仍免个人累计额度，工作台、预检、总控与账号页口径一致，单请求卡数仍按物理容量且成员额度不变；只读合成忙碌节点，不派发 GPU 作业。首次派发的当前角色、停用／授权变更、持久化失败、丢回执和慢桥队列由 `admin-quota-dispatch.test.js` 的独立 SQLite 夹具覆盖；旧无标记或已尝试任务不得因此重派或释放。

`execution-fair-reconcile.test.js` 使用独立 SQLite 和手动挂起的执行桥回包，不使用真实节点。验证同机／跨机旧查询仍未返回时，后来提交的任务已按原身份首次派发；每机最多两个在途、每任务一个、旧观察与新任务均可推进。取消不与本任务 sync 并发，UNKNOWN 保留额度；轮中新增、授权改变、丢回执、准备完成、旧 policyRevision 回包和关闭均保持原保护。失败断言先解除夹具的全部等待，避免测试自己留下后台请求。真实短作业并行、HAMi 内存隔离与取消隔离仍须另做实机验收，不能用这组离线结果代替。

`project-sync-cancel.test.py` 使用独立临时项目验证原 UUID/source/snapshot/manifest/revision
CAS、永久旧编号写入围栏、原收据与全部已复制字节不变、丢回执只读恢复、同项目写锁竞争、
未知 unit/PID/cgroup 和全部历史／上传／终端保护。Linux 额外运行真实 no-replace 软退役，
Mac 对该一项保留明确 skip；不接触生产路径、服务、GPU 或用户数据。
`project-sync-cancel-api.test.js` 和 `project-sync-cancel-cli.test.js` 覆盖当前授权、零权限、
固定来源、旧能力拒绝、维护准入及 mutation 不重放；`project-sync-cancel-bridge.test.py`
隔离加载实际固定桥，确认仅一个 literal 新 RPC 原样转发身份、邻近未知操作拒绝且超时不重试。

数据集回归另覆盖固定版本、身份/机器授权、准备不预留显卡、只选择同机全部 READY 的副本、失败重试与断点继续、租约清理的保守边界、挂载缺失拒绝写系统盘、旧节点环境/管理员终端兼容升级。数据页浏览器测试使用假的执行桥，不触发真实训练；验证准备、失败、重试、READY 后填入训练，以及移动端和在线手册入口。

`warehouse-direct-listener.test.py` 用一次性双 root 与 loopback TLS 核对实际 daemon
分支传入固定 HDD factory view，而非训练 SSD；能力探测、浏览器预检与短期票据
写入都重验 HDD。HDD 挂载丢失后不声称就绪、不继续写字节、不回退 SSD；错误
Origin、缺票据和管理员本地配置漂移仍拒绝。测试只改网络 bind 为 loopback，保留
真实配置验证、证书指纹、原授权与磁盘检查。首轮夹具误把上传器初始化的私有
控制目录视为未授权请求创建；改为比较请求前后的完整树，未放宽零新增文件断言。
这组离线测试不等于生产监听器已启动，也不解除维护或调度暂停。

同机机械原件／固态缓存投影用真实双 root 节点契约的离线夹具验证：只采用服务端
`logicalDataset` 持久绑定与完整相同 ACL 消除重复缓存行，不猜名称前缀；仓库原件
READY 与 SSD READY 分离，固定 `storageReference` 仅在服务端解析进入 runner 和准备
保活，公开命令及挂载名仍是逻辑数据集。错误 hash、路径、额外字段、缺失绑定、撤权
及原件准备失败均不回退 HDD 训练或另选来源。跨机复制仍使用原件逻辑引用，普通
上传不因此新增盘位／root 选择。`warehouse-logical-cache-ui-smoke.mjs` 在独立 loopback
门户、1440/390 原生浏览器验证一条逻辑记录、原件不冒充缓存就绪、自动准备入口、固定准备调用及原命令；
不连接生产、不搬运数据、不运行 GPU，不替代实际 SSD/HDD 发布与校验。

成员指南收敛为个人容器开发、集中仓库入库和 `data prepare` 准备训练缓存。
内容测试明确核对成员用词统一为仓库／缓存、上传位置与训练目标可不同、仓库不可达不改存训练缓存、上传 READY
不冒充训练缓存 READY，以及模型和结果继续属于个人项目；不再推荐旧环境模式、
个人数据终端发布或手工跨机长期复制。指南浏览器夹具保留全部七章导航、精确复制、
键盘、无脚本、320/390/1440 布局和对比度检查，只改对应新流程的严格文字契约。
首次定向运行因独立工作树尚未构建 standalone client 而有一个启动失败；按规定
构建客户端后重跑全部 29 条指南测试通过，不修改运行时或放宽权限检查。
全量 Node 首轮未传入标准 Python3.12/TMPDIR，7 个真实节点夹具因 macOS `/var`
软链接路径被 no-follow 拒绝；原结果保留，以规定运行时和 `/private/tmp` 重跑全量，
得到 1671 pass、2 个既有 skip、0 fail；没有修改节点代码、文件保护或断言来适配错误环境。

`dataset-lock-wait.test.py` 验证真实全缓存／版本锁竞争分别给出单次或累计等待边界，不泄漏私人锁路径；`data-workspace.test.py` 验证登记前失败不虚构版本、复制途中失败保留原版本与真实片段、重复 FAILED key 不重派、显式新发布 key 沿同一内容版本核验并完成、历史失败不被改写，以及跨账号和普通扫描错误不伪装为锁竞争。阶段诊断不扩大旧发布接口的存储策略或部署范围。

`dataset-deletion-continue-running.test.js` 使用独立 SQLite、真实挂起的 locations 回包及 loopback HTTP 登录，验证继续前持久 RUNNING/清旧 error、同编号查询不重放、重复继续零派发、持久化失败零启动和 worker 等待后的认证重核。真实 logout 在回包等待期间仍阻止全部写入；保持登录直到 DELETED 后再退出不改变原结果。假桥不连接节点，也不放宽认证或删除证明。

`dataset-empty-registration-api.test.js` 与 `dataset-empty-registration.test.py` 专测管理员正常注销个人 0 版本登记：完整清单与节点强证明、原 worker/回执、默认 tier 与上传历史保留、丢回执沿原编号查询，以及新版本/owner/依赖变化、软硬链接、未知上传预留、成员/旧能力/单版本/伪造字段的零派发。Python 夹具使用真实缓存和后台 worker，只替换 systemd 启动与活动探测，不连接节点或调用 GPU；既有 unregister、last-copy 与 delete-retry 仍需回归，不能把空登记分支用作任意版本的最后副本例外。

预留反向证明额外覆盖同账号及他人可信无关上传的完整／sealed 预算保留、目标与孤儿拒绝、所有者哈希／原 UUID／资源公式错误、缺失／畸形／软硬链接／临时写入、重复身份与扫描成员变化，以及准入后新增依赖在最终移动前拒绝。无关上传进度不冻结为静态 CAS 依赖，但每个移动检查点重新验证；用真实 Linux 夹具核对原子登记移动与原预留字节不变，不以 Mac 流程测试冒称节点已部署。

项目回归覆盖手选服务器、拒绝新 `auto`、按机记忆项目、跨用户/项目拒绝、未 READY 不预留显卡、固定版本幂等、旧 job spec 不变、终端项目上下文、上传 SHA256/原子替换/中断重传/文件变更、秘密目录默认跳过，以及独立输出归属。发布安全还检查未知终端停止状态保留指针、拒绝发布或覆盖旧终端，不能因服务管理器失联而放开写入。代码+venv 发布与 Slurm 后端迁移须分别验收。

逐卡监控的回归范围包括指标与计算进程解析、空列表和采集失败的区分、非法/缺失指标、过期快照、角色脱敏、未授权机器过滤、管理员原 GPUQ 队列展开及网页展示。普通用户 API 响应不得包含他人的程序、系统用户名、命令、项目路径或原 GPUQ 队列；不能只依赖界面隐藏。进程指标仅代表 CUDA 计算进程，不把图形进程缺席当作漏报结论。

`native-task-presentation-http-cli.test.js` 用独立 SQLite、合成新鲜节点快照、真实 HTTP 和下载版 CLI 验证原生任务展示：管理员只采用合法、有界的名称和说明，原生 owner 不变；成员仍脱敏，UNKNOWN 不变，过期快照不保留任务或猜测空闲。重复 ID、模糊平台关联、断连及非法标签的回退另由 `task-metadata.test.js` 覆盖。全程不派发节点命令，不修改任务身份、规格或资源。

已有任务标签编辑：`task-display-api.test.js` 覆盖原规格不变、跨账号与零授权拒绝、旧能力零派发、撤权、并发版本及丢回执；`task-display-http-cli.test.js` 验证真实 HTTP 下载客户端的显式 revision 和不重试写入。`node-task-display-edit.test.py` 使用真实临时 GPUQ SQLite 和原生 CLI 测原提交三围栏、原子 CAS、写后丢回包仅原编号读取及 sync 保留人工标签；`task-display-bridge.test.py` 隔离加载真实固定桥，未知操作不连 SSH、拒绝原样保留、失败写不重试。`node tests/task-display-ui-smoke.mjs` 仅本机假 API，父级 120 秒截止、独立 Node 512 MiB heap，实际键盘与 1440/390/320 控件几何、旧节点、丢回执及角色变化；`CHROME_PATH` 可指定浏览器，截图用私有 `UI_SCREENSHOTS`。该父级限制不是全平台内存限额或跨平台 cgroup 承诺，正式配套启用另须节点服务版本核验。

优先级界面回归使用本机静态资源与合成 API 响应，不连接真实执行桥。覆盖普通用户只有 normal/idle、未知节点能力禁止增强档位但保留训练草稿、管理员仅修改已确认队列、轮询保留优先级草稿及焦点、原优先级并发冲突、真实抢占标记、未知字段不冒充已知，以及 390px 布局。该浏览器测试只验证界面契约；后端权限、GPUQ 排序与让位策略须由独立单元测试和隔离节点验收覆盖，不能将合成响应当作实机通过。

同机项目导入回归包含固定 owner/project/UUID、当前授权和维护门禁、后台源/草稿双围栏、full SHA 与源 CAS、新目录不覆盖、秘密/软硬链接拒绝、终端/旧上传阻塞、未知启动/提交不解围栏、取消只清理私人 staging。`tests/project-local-import.test.py` 的 Mac 离线复制夹具仅测试流程；Linux 专用用例实际调用 renameat2，不能把 Mac fixture fallback 当生产原子能力证明。待上传 list/cancel 另测目标变化、COMMITTING/未知旧记录拒绝、取消回执后清理中断可恢复及跨账号隔离。`project-legacy-upload-cancel.test.py` 仅对明确未完成的四字段旧片段验证永久取消 fence 先于 no-replace quarantine、保留原字节、丢 ACK 和第二移动失败恢复、symlink/hardlink/重复 UUID/目的碰撞拒绝；Linux 额外实际调用 renameat2 并用独立进程争用原 store lock，Mac 仅用显式流程替代。Portal/CLI 不重放新建/取消，不读取本机源即可发现和取消旧操作。

`tests/project-import-bridge.test.py` 隔离加载完整的实际执行桥，通过真实 Handler 和固定 SSH 命令构造验证上述五个新操作、旧上传/发布兼容、未知机器/邻近操作零派发、原 owner 与操作编号不变、节点拒绝原样返回及超时不重放。仅替换 inventory 和最终 SSH transport，不连接生产或读取凭据。

## 固定仓库池回归

`dataset-warehouse-pool.test.js` 使用隔离 SQLite 和合成节点容量，验证完整清单开销与 inode、
非阻断低容量告警、真实不足/未知/身份错配零准入、当前权限、丢回执和重启不换仓、
移除仓库后的 ISSUED/BOUND 区别、READY outbox 原 intent 对应、固定来源认证，以及
旧 policy/journal 不被池配置重新解释。它不代表实际磁盘、跨机网络或正式直传已启用。
`dataset-replication.test.js` 另验证首次准备根据已认证实际副本解析原仓库，旧 UUID 不
重选源；原件证明缺失或冲突不猜测其他仓库，也不增加复制协议。
`transfers-dual-root.test.py` 在临时独立目录使用真实证书 pin 的本机 TLS 复制，覆盖手动
和训练准备落入缓存、旧 journal 续传仍入原根、根 inode／挂载变化拒绝、缺根不重建
或改写 journal、非 authority 来源和客户端自报目标根在新派发前拒绝。它不操作真实
节点、服务或 GPU，不代表生产盘速与跨机网络验收。

## 项目生命周期额外回归

`python3 tests/gpuq-native-release-gate.test.py` 用真实临时 SQLite 与有界本地文件验证固定 root 门禁：关闭状态两次物理扫描、原 unit/租约核验、全部 mutation RPC（含 observe/sync/fleet）及动作入口零派发、已有 pending action 不领取、DB/心跳不变、非法／过期／软硬链接／inode 变化保持关闭，显式移除后重新两次观察。文件夹具仅将临时 stat 的所有者表示为 root，不写 `/run`、不操作服务或 GPU；不能当作正式发布器或真实滚动升级通过。合同见 [NATIVE_RELEASE_GATE.md](NATIVE_RELEASE_GATE.md)。

项目生命周期离线夹具覆盖 owner/revision/UUID、名字与分组纯 metadata、跨机部分未知、
权限在 proof 期间撤销、归档保留旧结果、禁止新工作、未使用 READY 项目退役、任何 run/claim/output
阻塞、活动/未知终端与导入/上传/发布围栏、目录全量 CAS、私有软退役与永久 ID tombstone、
丢回执保持 RETIRING 原请求、真实执行桥五操作。Mac 原子流程 fixture 明确只测试流程；
Linux 专用 test 实际 renameat2 no-replace。生产绝不用测试 fallback，不因 UI 显示 ELIGIBLE
就认为目录已退役。网页另核对名称、归组、归档过滤、退役计划/原 UUID 查询及 1440/390/320。

## 上线前的实机验收

1. 用普通邀请码注册；未获批前提交和终端应拒绝，不能自选 admin。
2. 批准一台机器两张卡、总额两张；未批准机器拒绝，第三张拒绝。
3. CLI 登录、手选机器，创建/选择项目，上传代码，打开项目终端安装一个小包；确认依赖在私人 venv，不修改全局 Conda。`exit` 后发布，等待 READY。
4. 用固定版本运行最小 CUDA 程序、申请单卡；确认代码/环境只读、`/outputs` 可写且独立，不能打开其他 GPU；项目未 READY 或数据未准备时应在预留前拒绝。
5. 申请同机双卡，使用 torchrun/NCCL all-reduce 检查多卡通信；核查结果下载。
6. 启动一个可取消作业，等待 RUNNING 后取消；检查后代进程消失、卡数释放。
7. 用第二个普通账号尝试读取/取消第一人的任务、读其文件、开 root：均拒绝。
8. 将测试用户升为管理员；验证每台已启用节点的 root `id -u` 为 0，结束终端。再降级应撤销旧登录、拒绝 root。
9. 重启仅门户服务，确认已有训练继续、幂等重试不新增任务、配额恢复。模拟桥超时须保持 UNKNOWN/预留而非重新派单。
10. 退出 API/CLI；旧 token 拒绝；确认临时 GPU 作业和终端都结束。
11. 从未加入 Tail 的用户设备通过 HTTPS 注册、登录网页及 CLI；确认不会自动登记 Tail 设备或创建可直接 SSH 登录的系统账号。`gpuctl ssh` 应打开平台工作区，而非绕过授权的原生 SSH。
12. 对照节点只读指标与最近采集时间，核验每张卡的利用率、显存、温度、功耗和计算进程；管理员可读原始进程详情和原队列，普通用户只收到获授权机器的匿名原始占用与平台任务的公开姓名、任务名、自填描述。不得泄露他人命令、日志或结果；外部／未确认进程不能猜归属。只查询，不干扰既有进程。
13. 在隔离测试环境注入缺失/过期快照及计算进程查询失败，确认页面显示未知或不完整而不是空闲；页面每 15 秒同步与节点约每分钟采样的说明一致。核验“我的工作台”“机器资源”“用户授权”和帮助入口职责分离。
14. 修改下一版草稿，确认既有发布与运行任务不变；新版本必须主动发布。切服务器不沿用旧项目，不自动复制或换机。旧个人工作区、旧训练日志与取消仍可用。
15. 中断项目上传，确认旧完整代码不被半文件覆盖、未完成上传不能发布，同路径重传可恢复。开发终端仍活跃或停止状态不明时发布应拒绝；完成/取消后只下载该用户、该项目、该任务产物。

不要拿忙碌服务器做驱动/内核破坏测试。测试目录与正式实验分开，不删除别人的数据。完整裸机部署、不同驱动和网络拓扑都需在部署者环境中重复验证，现有部署通过不代表所有组合都通过。

优先级升级的额外验收仅使用明确可丢弃的隔离任务：验证普通用户不能提交 high/修改他人优先级；管理员仅能调整仍在队列的新任务；normal/high 可让 idle 让位但绝不自动终止 normal、旧 P0 或未知进程；idle 让位结束后已有输出保留、不重排，进程清空确认前继续保留额度。中断节点连接或移除能力标记时，界面须显示未知、拒绝增强档位且不悄悄降级。重启/升级 GPUQ 需另行安排维护窗口，不能由文档或浏览器测试推定已获授权。

非交互管理员命令需在显式启用 hostRoot 的测试节点验证：普通用户/其他管理员不可读取或取消该句柄；argv 无隐式 shell；同键重试不重复执行；超时和取消待整个命令控制组清空；stdout/stderr 截断标记、退出码与断网后状态核对一致。不要用真实维护脚本验证该入口，先使用无副作用的短命令和独立可取消进程。

## 2026-09-29 已有部署验收范围

已在真实账号上完成普通注册→零权限→审批→CLI→个人终端/环境→单卡 CUDA→双卡 NCCL→下载→运行中取消→管理员→四台主机 root→退出。测试工作负载结束。公开仓库不包含此部署的账号、地址、任务日志、数据库或结果文件。

账号与界面收尾包含 33 项 Node 测试、10 项 Python 测试和上述双浏览器流程。正式站另外核验个人管理员登录、当前注册码保持不变且可读、旧 admin 删除、工作台/管理页分离，以及从正式站下载的 CLI 登录、选机和退出。

随后名称通用化与逐卡监控修复通过 40 项 Node、49 项 Python 测试及增强的双浏览器验收。正式部署另外核对四台节点共 30 张卡、计算进程与新鲜采集时间、管理员网页、手机布局、当前邀请码不变、新 CLI 登录/选机/任务查询/退出及旧下载入口兼容；没有为监控验收重跑训练或重启 GPUQ。新部署权限、不同用户名/路径和旧协议兼容使用隔离测试，未替换现有节点的 GPUQ 核心。

源码通用化另用自动测试和隔离容器检查；不将“文档已写好”描述为“在每一种空白机器上部署过”。

数据层后续增量版本通过 56 项 Node、246 项 Python 测试，以及原界面和数据页的两个真实浏览器回归。既有部署四节点的 `/data2`、来源只读访问与小样本本地 READY 已核验；一台空闲 RTX 3090 上通过正式 CLI 完成准备→单卡 CUDA→内容哈希检查→只读写入拒绝→正常退出，节点租约和 GPU 进程已确认清理。未修改账号/配额、未停止既有实验。

以上不包含实际断电重启、TB 规模吞吐、来源断网、所有机型数据作业或长期负载验收。Slurm 适配器的自动测试及隔离编译成功不代表生产已切换 Slurm/Pyxis。

## 2026-09-29 项目隔离增量验收

新版门户和四台节点已部署，原节点配置、GPUQ 数据库和旧训练未迁移或重启。本地 118 项 Node、321 项 Python 回归通过；项目、数据集、账号/资源、原生 HttpOnly Cookie 并发四组真实浏览器回归通过。浏览器测试使用本地模拟执行桥，不冒充真实 GPU 验收。

四节点均以专用验收项目验证：完整 SHA256 上传、CPU 开发终端创建独立 venv、正常退出、代码与环境发布 READY。随后在一台空闲 RTX 3090 上，通过正式站下载的 CLI 和真实账号完成上传极小自建 wheel、在项目 venv 离线 pip 安装、重新发布、自动分配恰好一张 GPU、运行 CUDA、只读 code/env 写入收到 EROFS、下载任务独立 result.json。发布后的训练成功导入刚安装的依赖；计算结果与固定版本均核验一致。

正式网页另核对服务器/项目选择和 390px 布局；全体用户角色、启用状态和额度的指纹前后一致。测试作业 SUCCEEDED，未取消其他任务或使用忙碌节点显卡。旧工作区、幂等记录和取消协议兼容通过回归；本轮没有重新开展项目运行中取消、双卡 NCCL、节点重启或大型数据压力实测。

上述证明当前 GPUQ 后端上的同机项目工作流，不包括 Slurm/Pyxis/Enroot、硬磁盘配额、自动跨机项目/环境分发、结果自动归档或独立内容备份。私人验收日志、账号与主机清单不进入公开仓库。

上传和结果下载故障：`project-operation-lock.test.py` 使用真实 flock 竞争验证短等待、超时原片段保留、非竞争 IO 错误与不安全锁拒绝，并固定 machine-only quota 路由。`dataset-replication.test.js` 验证管理员当前角色与个人 owner-only 目录。`remote-read-lanes.test.js` 验证文件读取越过写入积压及在途撤权；`client-http.test.js` 固定读取重试的 offset/fingerprint。`node-files.test.py` 验证逐块源指纹、读取期间变化与非法偏移；`client-file-download.test.js` 验证断线恢复、来源/账号/项目错配、本地编辑、软链接、旧节点和失败保留。不访问生产节点，不声明已完成真实大文件性能或迁移验收。

`dataset-catalog-incomplete.test.py` 验证缺失 READY/staging 父目录时按固定版本展示 UNKNOWN，
仍核对登记和实时 ACL；健康版本继续返回，无父目录重建，无 prepare/delete/recovery 准入。
覆盖热摘要、跨账号与撤权并发、完整源不提升未知权限、损坏登记和 unsafe link 不降级，
并复核 status、prepare、lease、unregister 的严格保护保持。
`dataset-catalog-incomplete-node.test.py` 验证节点跳过未知行的删除、恢复和后台状态 overlay，
不给它套入 worker 的可信快照。全部使用临时合成数据，不连接生产或读取真实账号。
全量 Python 首轮两个旧断言要求列表对缺父目录整体报错；按明确的新展示契约改为
逐字段核对固定版本、UNKNOWN、禁止准备／删除、固定错误码与无路径泄露，
仍要求 status 抛出专门的缺失元数据错误并且零目录重建，其余损坏与不安全链接断言保留。

## 项目字节警告契约

项目容量变更将原硬大小拒绝改为可成功的非阻断警告；对应断言保留并加强为成功状态、固定大小、阈值、`blocking:false`、完整版本／SHA 和协议精确整数上界。使用很小的可配置警告阈值验证发布、本地导入、同步及真实不足空间拒绝，不生成 50 GiB 载荷。上传节点用大 `totalSize` 和一个小片段核对原 UUID／偏移与警告、非法数值零写入；CLI 用临时稀疏 4 GiB+1 文件完整散列并恢复匹配 COMPLETE 回执，验证警告不阻断、已完成不重传。portable／OCI 用可信身份的合成大载荷清单验证旧 50/100 GiB 边界允许且数字溢出、错 owner／路径／镜像／清单依然拒绝。测试不表示实际大镜像转移性能已验收。

`dataset-lock-wait.test.py` 验证真实全缓存／版本锁竞争分别给出单次或累计等待边界，不泄漏私人锁路径；`data-workspace.test.py` 验证登记前失败不虚构版本、复制途中失败保留原版本与真实片段、重复 FAILED key 不重派、显式新发布 key 沿同一内容版本核验并完成、历史失败不被改写，以及跨账号和普通扫描错误不伪装为锁竞争。阶段诊断不扩大旧发布接口的存储策略或部署范围。
