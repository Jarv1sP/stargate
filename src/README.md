# V2 源码入口

当前可运行链路：

`DataClient → JsonHttpTransport → createDataReadHandler → ResolveDataRead → LocalSourceReader`

`assembleDataRead` 只负责组装。认证、授权和来源读取适配器通过明确的接口注入，不启动服务、不创建数据库、不读取生产全局配置。

- `contracts/data-read.mjs`：唯一的数据读取请求／响应契约，供服务端和两种客户端共用。
- `domain/`：错误代码、数据来源的容器命名规则，无网络或文件系统依赖。
- `application/resolve-data-read.mjs`：访问授权与读取观察的调用顺序，无 SQL、SSH、HTTP 或旧服务依赖。
- `infrastructure/local-source-reader.mjs`：固定本节点身份后向目录查询接口取可信路径，只读检查真实目录，不准备缓存、不复制、不检查写入额度。
- `application/authenticate-session.mjs` 和 `data-read-access.mjs`：取得会话／授权事实，调用领域规则；不直接解析 Cookie 或 SQL。
- `application/login.mjs` 和 `session-lifecycle.mjs`：登录签发、续期和注销；密码、令牌和 SQLite 写入分别由专用适配器实现。并发限制要求权威进程共用一个 `Login` 实例。
- `contracts/session.mjs`、`api/session-handler.mjs`、`client/session-client.mjs`：网页／CLI 同一登录契约和 SDK，Cookie／Bearer 交付不同但业务用例相同。恢复时通过 current 接口查询实际身份，确认前不开放业务请求；该查询不暗中续期。`bootstrap/sqlite-session.mjs` 显式组装。
- `infrastructure/open-client-credentials.mjs`：显式创建私有的客户端凭据库，原始令牌按 origin 保存；条件删除防止旧进程注销清掉新登录。不保存密码／角色，不连接服务端数据库。文件权限适配器目前只验证 Linux/POSIX。
- `bootstrap/cli.mjs`：V2 独立命令外壳，调用同一 SDK；`node scripts/v2-client.mjs --help` 查看 login/current/read/logout 用法。必须指定候选 API 和凭据文件，不能据此认为线上已提供 V2 接口；已安装 gpuctl 不受影响。
- `domain/account-policy.mjs` 与账号用例：管理员创建、查询、改角色和启停；事务内核对会话、目标修订和最后管理员规则。`create-account.mjs` 与 `reset-password.mjs` 在密码计算前授权、计算后事务重验，账号／凭据／失效修订原子提交。调用方保留新账号 UUID，创建丢回执后按原 ID 查询，不换号重试。`bootstrap/sqlite-account.mjs` 组装同一 HTTP／SDK 链路。
- `application/list-accounts.mjs`：管理员分页查看用户名、姓名和当前角色／版本。网页／CLI 调用 `AccountClient.list`；独立 CLI 支持 `accounts --limit N --after ID`。分页不冻结跨请求快照，每页重新核对权限。
- `domain/compute-policy.mjs`、`application/compute-policy.mjs`：机器访问与单机／跨机额度配置；`ComputePolicyClient` 共用 HTTP 契约。仓储原子替换现有机器授权行，策略版本防止覆盖并发修改；未知容量／旧上限不猜测。`compute-policy-schema.mjs` 显式建表／扩列，尚未用于生产迁移，调度准入执行额度仍待接。
- `application/data-access.mjs`：管理员查询／替换私有来源的读者名单；`DataAccessClient` 使用同一 API。读者和 ACL 修订原子写入，不修改来源绑定、可见性、所有权或机器授权；共享来源不使用此接口假装取消共享。可见性修改与管理页面仍待接。
- `application/register-directory.mjs`：将操作者预配置的已有目录登记为可选择来源，不复制或探测全目录；权限与绑定在事务内确认，重复相同登记共用资源 ID，冲突不覆盖。`ConfiguredDirectories` 只接受可信配置，API／SDK 只接收机器和来源名。独立 CLI 的 `register-directory` 已接通；生产配置导入尚未完成。
- `infrastructure/http-source-reader.mjs` 与 `api/source-inspection-handler.mjs`：固定节点只读观察通道，独立服务凭据，不接受宿主路径、重定向或自动换机。`assembleSqliteDataRead` 注入该 reader 后在远端 I/O 前后核对用户权限。当前以本地真实 HTTP 节点验证，生产节点与托管版本 READY 证明尚未接入。
- `infrastructure/legacy-cache-reader.py`：窄兼容适配器复用现有发布元数据校验，通过 DatasetCache 的 `initialize=False` 只打开已有布局与锁；不调用工作区、配额、复制或准备。类型由配置固定，已通过本地子进程接入节点观察；旧授权迁移尚未完成，发布目录迁移完成后才退役此适配器。
- `bootstrap/node-source-reader.mjs`：组合原目录与 `ManagedSourceReader`；后者调用 Python 只读适配器，配置根目录不来自请求。内部协议只接收协调器确认的账号 ID，旧元数据 ACL 暂仍校验该账号。ACL 迁移和仓库 authority 根绑定未完成，不能据此替换生产托管路径。
- `application/register-managed-source.mjs`：管理员登记显式配置的固定版本，先以配置所有者检查节点，再原子记录资源与机器／类型位置，不存 READY 或伪造宿主路径。`ManagedRegistrationClient` 已接同一 API；旧 ACL 迁移尚未完成，登记不等于新的共享许可已同步旧发布目录。
- 节点可通过 `coordinatorVersions` 显式将某机器／类型／数据集／版本的授权交给 V2；默认仍保留旧 ACL。请求不能选择此模式，委托不跳过发布完整性检查或开放写操作。原有权限导入与正式入口切换尚待实现，不能直接全库启用。
- `ManagedSourceReader.exportAccess` 与 `domain/data-access-import.mjs`：导出旧 ACL 的绑定快照，按显式账号映射核对全部副本并提出读者导入方案；冲突／缺失／现有撤权不自动处理。
- `application/import-data-access.mjs` 和 `sqlite/data-access-imports.mjs`：提交前重新观察，事务内重建／比对方案，读者与回执原子写入；原请求恢复不重放历史写入。只是 V2 准备状态导入，不修改旧 ACL 或激活节点，正式切换尚待接。
- `DataAccessImportClient` 与 `bootstrap/sqlite-data-access-import.mjs`：同一管理接口供网页／CLI 核对、确认和查询。独立 CLI 支持 `access-import-plan`、`access-import`、`access-import-status`（参数见 `--help`）；null 回执仅代表尚未观察到，保留原 UUID 查询，不换号重提。
- `HttpSourceReader.exportAccess`：固定内部节点路由取得旧 ACL 快照，共用有界读取与独立协调器凭据，保留旧所有者检查。导入 API／浏览器／CLI 已通过隔离远端 HTTP 场景，真实服务器部署和正式切换仍待完成。
- `infrastructure/gpuq-policy.mjs`／`.py`：调用现役 GPUQ 纯策略计算排序、合法弹性 batch、扩容目标和抢占候选，不创建任务或执行动作。部署需保留 `gpuq/gpuq/` 模块目录；资源观察、配额、租约和执行适配尚待接入，计划不等于已经分配 GPU。
- `domain/training-request.mjs` 与 `sqlite/training-requests.mjs`：直接保存共享 training-submission 契约，规范化任务名与描述并保存真实提交者；回执不含执行参数，内部 submission 按任务 ID 读取不可变原请求。旧通用 preparedSpec 载荷拒绝用于派发，不隐式转换。RECORDED 不代表 GPUQ 已接受；公开提交接口尚未完成。
- `contracts/training-submission.mjs`：网页／CLI 共用训练输入结构，明确项目 release、容器命令、机器候选、资源与调度选项、逻辑数据来源。不接收宿主路径或执行身份；结构解析不代表项目存在、授权有效或 GPUQ 组合准入通过。
- `application/validate-training-resources.mjs`：将 V2 意图与可信节点池送到 GPUQ 原生纯资源校验。原 GPUQ 完整提交复用同一资源／环境函数，继续独立验证真实 cwd、可执行文件和 RPC 大小；该校验不占卡，也不代替项目、权限、配额或运行库检查。
- `domain/training-candidates.mjs` 与 `sqlite/training-catalog.mjs`：检查项目归属、归档、release 登记和机器授权，输出目录级候选及配置额度上界，不猜测空闲卡或节点文件就绪。正式项目登记、物理实例观察和实际用量检查尚待接入。
- `infrastructure/legacy-project-reader.py`：以无初始化方式读取已有项目 UUID、实例代次和固定 release 元数据；不创建生命周期目录／锁或验证运行环境，runtimeVerified 明确为 false。原生观察已测试，节点协议与项目登记事务尚待接入。
- `application/register-project-release.mjs` 与 `sqlite/project-registrations.mjs`：将账号／机器绑定的观察原子登记到项目目录，UUID 与 generation 防止静默换实例；重复登记不会产生第二个绑定。已通过隔离 HTTP 节点连接原生 reader，仍不代表可启动。
- `ExistingProjectReader`／`HttpProjectReader` 在进程／HTTP 输入边界使用 `contracts/project-inspection.mjs` 解析项目字段；`domain/project-observation.mjs` 只判断当前账号／请求匹配、项目是否可用及本步骤的运行确认，不再重复 UUID／哈希／枚举格式解析。inspect 读取元数据，verifyRuntime 检查已有环境引用；缺失基础环境不妨碍前者，后者失败且不自动恢复。节点配置独立于请求，不返回宿主路径；runtimeIdentityVerified 不代表训练准入或执行成功。
- `HttpProjectReader`／`assembleProjectInspection`：项目远端观察复用数据来源的 `NodeJsonTransport` 和节点认证，绑定账号／机器／版本。只完成隔离 HTTP 验证，实际节点部署与运行环境检查仍待接。
- `ProjectClient`／`assembleSqliteProjectRegistration`：网页和 CLI 共用项目登记与存量查询。CLI `register-project`、`project-registration` 参数见 `--help`，重试保留同一逻辑 ID 和引用；查询不联系节点、不提供新的运行证明，亦不启动训练。
- `ObserveTrainingCandidates`：将目录和已登记实例与远端元数据、运行环境引用逐一匹配，每次 I/O 后检查目录上下文；节点局部异常不阻断其他候选，权限／上下文变化使整次观察失效。运行引用通过不等于用户代码可执行、空闲卡或占用额度足够，不创建租约。
- `ResolveTrainingData`：复用数据直读用例，先检查整组来源授权，再观察已有目录／固定版本，结束后重查授权；同容器路径冲突直接拒绝。候选筛选只保留全部来源可读的机器，局部数据缺失／未授权不阻断其他机器，返回前重查成功候选的数据权限。不复制、准备缓存或取得挂载租约。
- `TrainingReadBudget`：每次训练候选观察独立创建，只重试明确暂时失败的 source inspection；每个来源最多 3 次，所有来源／节点共享 12 秒额外等待预算。每次前后重验数据权限与候选上下文；持续锁忙保留为 data-busy，不阻断其他节点。普通浏览、项目／GPU 查询和全部写入不自动重试。
- 数据锁忙／受监督读取超时保留为 `SOURCE_BUSY`／`SOURCE_READ_TIMEOUT`，经 Python、节点传输、统一 API 使用相同语义；来源登记和权限导入预检也复用错误映射，但不重放操作。`NodeJsonTransport` 仅分类确定的暂时错误、接受更短读取超时，本身始终单次发送；错误响应同样受字节上限限制，401／403 不因清理失败变成可重试网络错误。
- `GpuqPoolReader`：通过 GPUQ 现有 Unix socket 协议读取托管 UUID 与调度器算出的可调度 UUID；发布门关闭、观察模式或不健康时不报告可分配卡。不是从截断的任务清单推算占用，不返回任务详情，不代表个人剩余额度或取得租约。
- `HttpGpuPoolReader`／`assembleGpuPool`：复用节点认证及 NodeJsonTransport，固定内部 pool 路由只接受 machineId，不接受 socket 路径。共享契约核对节点身份、UUID 清单和派发状态。资源清单响应上限 2 MiB，其他节点接口默认仍为 8 KiB；不重试、不改投节点。
- `ObserveTrainingResources`：先用原生 GPUQ 规则校验请求意图，再按节点池大小和配置上限筛选合法卡数；不改写原 batch／弹性边界。候选筛选组合此用例，忙池仍可等待，exclusiveFreeFitGpuCount 只表示瞬时独占空闲卡适配，不含抢占、共享显存、用户已占额度或租约。
- `SqliteComputeClaims`／`computeBalance`：独立用户额度账本，同事务核对当前权限／限额、统计 HELD 记录并预留额度；按任务幂等，不是 GPU 租约。新账本默认未就绪，旧占用导入和切换完成前不能新预留。没有超时返还、公共释放或启用接口，未接正式派发；原回执恢复不代表重新获得执行权限。
- `trainingQuotaFit`：候选节点查询完成后，从同一读事务取得各机额度余额，与合法卡数求交集，返回 quotaFit。额度不足保留等待候选；未就绪／缺失余额不按无限额度处理。resourceFit 保留物理／配置观察，quotaFit 仍非派发许可，实际预留需使用原子 claim。
- `SqliteTrainingDispatches`：同一写事务预留额度并记录每任务唯一 PREPARED 派发编号，失败一起回滚；通过原编号恢复，不自动换机。仅内部持久意图，不发送节点请求；额度原回执不能绕过当前授权来新建派发，PREPARED 也不是执行许可。任务原载荷仍由不可变输入记录持有。
- `PrepareTrainingDispatch`：按任务 ID 读取统一原请求，观察候选，优先最大当前合法独占卡数，同卡数保持候选顺序；随后原子准备派发。没有适配或额度竞争返回 waiting，已存在／并发产生的派发恢复原编号，不重复观察或改投。waiting 是本次观察结果，不是持久队列终态；共享、抢占和实际节点执行仍待接。
- `SqliteTrainingQueue`：同事务记录原请求与唯一排队序号；P4→P0，同级 FIFO，可按优先级／序号翻页。pending 为内部工作器查询，不带命令／环境；从派发记录排除已准备任务，不复制执行状态。队列跨重启和退出登录保留，但后台执行授权及工作器尚未接入，发现记录不代表允许执行。
- `SqliteTaskAuthority`／`ResolveTaskData`：内部工作器从已入队原请求取得任务身份，不创建或延长登录会话；当前账号必须启用，数据来源／选定机器不能扩大，读数据时重查当前机器和数据权限。复用同一数据权限规则与直读用例；没有公开任务身份接口，项目／额度／派发与任务取消授权尚待衔接。
- `ObserveTaskCandidates`：从任务 ID 取得原请求，复用完整候选观察流程；任务目录与额度余额入口在各自事务中验证当前账号与固定任务范围，不伪造会话。项目、实例、运行环境、数据、资源池和余额均可在登出后观察；未执行额度预留、取消或节点派发。
- 队列 `cancel`：仅在没有派发记录时，同事务写取消回执并释放未发送的额度预留；任务身份与后续预留同时拒绝该任务，重复 enqueue 不复活。已有派发时拒绝队列取消，必须由后续节点生命周期取消流程处理；这里不能停止运行中的训练。新增取消表须由明确 schema 步骤安装，构造器不迁移。
- `PrepareTaskDispatch`：任务身份下复用相同候选选择／竞争恢复流程；任务派发仓储与会话派发共用原子额度／意图写入。写入时核对固定任务、当前账号、机器范围及卡数边界，不使用登录 token；仍只是 PREPARED，发送前必须重新确认项目、数据与节点执行条件。
- `AdvanceTrainingQueue`／`assembleTrainingQueue`：单次推进一页优先级队列，等待／已知任务级拒绝不阻断后续条目；统计未就绪或未知程序错误停止本次调用。返回逐任务观察结果及游标，不自动定时、重试或标记永久失败。组装层显式接收数据库和节点适配器，不迁移 schema 或启动服务；尚无节点发送。
- 派发 `beginSend`／`recordSendOutcome`：写入 SENDING 后仅一个调用者获得内部发送令牌；后续只能查原尝试，UNKNOWN 不重发、不释放额度，匹配迟到回执可转 ACCEPTED。普通回执不含发送令牌；ACCEPTED 仅表示节点接收，不表示训练运行或完成。尚未接网络发送、重启后节点核对与终态释放；扩展状态 schema 需显式升级。
- `ReconcileTrainingDispatch`：内部按原机器／派发 ID 查询接收记录，严格匹配任务、账号、机器、卡数及原请求摘要后确认；重启后不需要原发送令牌。空查询或离线不证明发送失败，不重发或释放额度。已接共享 HTTP 查询，节点映射仍需可信启动构建器写入，不提供公开状态写入口。
- 原生 GPUQ `submission_receipt`：按持久 submit_key 查询既有任务 ID、原生提交摘要与少量元数据；不重提任务、不返回 argv/env，维护门关闭时仍可只读查询。submit_digest 是原生执行请求摘要，不等于 V2 requestHash；两者的固定派发映射仍需节点登记层绑定。
- `SqliteNodeDispatchBindings`／`LookupNodeDispatch`：节点独立保存平台身份与原生提交身份的不可变映射，原生 submit_key 固定为派发 UUID；`GpuqReceiptReader` 只调用原生 submission_receipt，完整匹配后才投影平台接收回执。查询不补建映射、不扫描任务或重提。绑定写入口仅供可信启动构建器，尚未开放 HTTP 或接入实际启动。
- `HttpDispatchReceipts`／`assembleDispatchReceipt`：独立节点凭据、固定内部 receipt 路由，请求仅机器／派发 ID；原生回执经共享契约投影并校验后供协调器核对。数据库、socket 和服务生命周期由节点组装参数控制；没有公共写入证明、发送或重试入口。
- `GpuqLaunchSpec`：仅供节点可信启动构建器，将原生参数交给现有 validate_submission 规范化并复用 Store 摘要算法；检查 cwd／可执行路径和资源规则，但不执行命令、开数据库或提交任务。返回的 argv/env 是私有执行材料，不能直接暴露为公开接口或让用户指定宿主运行器。
- `ReserveTaskExpansion`：复用原生合法卡数校验后，在同事务预留额外额度并记录唯一扩卡编号。claims 的 gpu_count 保留初始派发选择，reserved_gpu_count 表示当前计费预留；未知扩卡不自动返还或叠加另一扩卡。尚未接原生 scale plan、确认／回退结算或公开接口，预留回执不是物理扩卡证明。
- 原生 `scale_up_receipt`：按 submit_key 与精确 plan_id 一次 SQL 读取计划／前后尝试状态及当前租约、预留数量。失败计划仍可能有新尝试持卡，不能只看终态就退还额度；该只读回执没有释放资源或创建扩卡计划的作用。
- `SqliteNodeExpansionBindings`／`LookupNodeExpansion`：固定平台 changeId 与原派发、原生 planId、来源尝试、前后卡数的关系，一计划不能绑定两个扩卡编号。复用原生回执桥精确查询，不找“最新计划”、不补建关联或退款；该映射写入仍由后续可信扩卡握手完成。
- `ReconcileTaskExpansion`：按原机器／changeId 核对完整身份，只将带完整前后尝试关联的 COMPLETED 回执记为 APPLIED；保留额度，之后才允许新的扩卡预留。失败、空查询和未知不构成退款依据，历史回执不能改绑或覆盖后续额度。远端扩卡查询及失败释放协议仍待接入。
- `HttpExpansionReceipts`：复用节点回执服务和传输，固定 expansion-receipt 路由只接受 machineId／changeId；与派发回执共用节点认证及原生查询器。严格区分 null、错误回包和不可用，不开放结果写入或原生计划 ID 覆盖入口；失败额度释放协议仍待实现。
- `PrepareNodeDispatch`：内部可信原生命令先经 GpuqLaunchSpec 完整校验，再检查本次初始卡数属于原生合法集合并绑定派发。gpuCount 是平台初始选择，nativeMaxGpus 是原生任务上限，回执按后者核对但仍返回前者；不冻结弹性配置，也不授予未经额度许可的扩卡。尚未构造容器命令或发送任务。
- 节点启动规格与映射同事务保存；规范化输出按键排序，等价环境字段顺序不造成冲突。`launch` 仅供节点执行器恢复私有参数，回执查询仍只读映射；只有映射、没有启动规格时返回缺失，不重建或猜命令。新表需显式 schema 安装，没有公开 host argv／env 接口。
- 原生 schema15 保存 authority、当前许可及不可变初始上限；旧任务默认 native，不自动纳管。external-v1 缺许可与零卡许可分别可查，标记不能降回 native，旧版读取规则拒绝新库。旧 v14 许可初始上限保留未知，不猜当前值就是初始值。
- 原生资源写事务按该任务租约、扩卡预留与拟新增 GPU 的并集检查许可。普通任务保持原行为，释放不受该限制；调度按合法卡数与许可求交集，许可不足局部等待，启动前再次检查，不制造全局故障。
- 原生 RPC `submit_managed` 原子写入任务、纳管标记及初始许可；`allocation_status` 按提交键只读查询，`set_allocation_grant` 按许可 ID／修订更新。初始提交重放不重置后续许可，更新不能降到现有租约／预留以下。维护期间查询可用、写入拒绝；平台握手与实际容器执行仍待接入。
- `GpuqManagedClient`：节点私有固定操作桥，仅提交受管任务、查许可和按修订更新许可；无普通提交回退或自动重试。编译计划发送时用同一原生摘要算法先核对绑定，再调用 RPC，错误规格不产生原生写入。原生拒绝与未知结果分离；底层独立调用保持兼容，错误文本不回传命令／环境。
- `SubmitNodeDispatch`：只接受固定节点／派发引用，先恢复原接收回执；未接受任务必须读取同时保存的计划／规格／绑定，裸规格或错误计划不能发送。将已准备的项目／原数据租约引用送到协调器授权，匹配许可后提交固定原生规格和初始额度，再核对原回执。没有新 argv/env 或隐式重试；跨机授权 RPC、HTTP 发送入口和后台 worker 尚待组装。
- 扩卡明确使用 `fromReservedGpuCount`（原预留额度）、`sourceGpuCount`（原生尝试实际卡数）和 `targetGpuCount`；额度差额按前者计算，原生计划的 from_gpu_count 按实际卡数核对。两种源值不能互相默认，旧实验记录需显式迁移并核实物理源值。
- `authorizeInitialAllocation` 仍只代表 SENDING 任务的当前 HELD 额度，不提供完整启动权限；`SqliteLaunchAuthorization` 在同一只读事务中复用它、任务／项目目录和数据权限，匹配原 release、实例代次及已准备输入后返回 launch-ready。没有另一份权限规则，不扫描数据、容量或复制内容；原目录无需租约，托管版本要求原租约引用，运行器实际打开时仍核对原对象。UNKNOWN 不凭未观察到记录重发或返还额度。
- `ProjectRunPreparer`：显式写入口，先只读确认已有项目，再按固定 UUID／generation／release 核对运行环境并复用原生运行目录声明。与 ExistingProjectReader 分离，不把查询变成创建操作；原 run-claim／output 退役保护继续生效。结果只证明项目运行准备，不是数据租约或容器启动证明。
- 原生 READY 数据读取租约不再经过复制预留／发布安全余量检查；只写必要租约元数据，不搬运数据。元数据真实 ENOSPC／inode／I/O 错误仍失败，权限、版本、READY 与退役检查不变；这不是保证完全写满的元数据盘还能启动任务。
- `LegacyDataLeaser`：原生已有版本的窄租约适配，仓库租约在写入锁内核对 protected 角色，缓存保持原权限。只返回租约标识和逻辑引用，不返回宿主路径、不提供复制／发布／释放。调用方须先验证任务归属；尚不继承只读元数据的 V2 委托权限。
- `ManagedDataLeaser`／`AcquireManagedTaskLease`：已有缓存／仓库版本经固定 Node→Python 写入口获取租约，任务层前后重核数据权限。租约委托使用独立 leaseVersions 配置，精确限定种类／数据集／版本，不能由请求指定，也不继承 coordinatorVersions。失败或撤权不自动释放已经落盘的保护；原目录挂载走另一条尚待实现的路径。
- 数据租约 `lookup` 与 `acquire` 共用原生权限／READY／来源保护检查，但 lookup 不写租约或刷新 last-used；任务层查询也前后重核权限。null 只表示没有观察到该账号／任务的匹配租约，不证明在途获取失败，不授权释放或复制。
- `HttpManagedDataLeaser`／`assembleManagedDataLease`：协调器按固定节点取得或查询数据租约，复用节点认证与有界 HTTP 通道。内部账号来自持久任务，根目录与精确版本委托来自节点配置；响应严格匹配原账号／任务／机器／来源，不含宿主路径。获取丢回执只查原引用，不自动重试、换机或释放。已接真实本地 HTTP 与原生缓存／仓库，未部署生产；原目录挂载与完整启动准入仍待接入。
- `TrainingDataMounts`：运行器进程内持有原目录和已有租约的真实目录 FD，复用原生目录打开及租约检查。原目录不初始化缓存、不复制或检查发布空间；托管版本只打开匹配账号／任务／原租约的 READY 数据，并核对打开后的目录身份。作用域结束只关 FD、不释放租约；容器运行时必须只读挂载，调用方必须先验证任务身份与来源授权。隔离 Linux 命名空间已验证读取与 EROFS，尚未接入完整任务运行器或生产。
- `TrainingRuntimeInputs`／原生 `ProjectStore.open_run`：同一进程内作用域管理精确项目运行目录和数据 FD。只打开已有运行声明，不补建或准备；项目共享生命周期锁覆盖使用阶段，code／env 要求封存只读、home／output 保留独立写入位置。任一阶段失败关闭本次句柄，保留输出、声明和租约；实际容器挂载、原生任务身份与停止后资源释放由完整运行器负责，尚未上线。
- 原生 `execution_snapshot`：按原提交键和精确尝试 ID，一次 SQL 观察任务／执行单元／实际租约／当前额度许可。指定尝试与最新尝试分开、原分配与实际租约分开；空结果不是释放证明，回包本身也不是启动许可。当前仅原生受信 socket，由 `NativeExecutionAuthority` 组合进程身份检查，不提供用户可写的执行证明。
- 原生 `job_observation`：按原提交键一次 SQL 观察任务、最新尝试、该尝试进度和事件游标，不等待 Coordinator 的慢工作锁。进度复用原生校验与展示格式，不返回宿主命令／路径字段，不继承旧轮次进度；观察不改任务、配额或租约。`GpuqJobObserver` 只调用此操作，没有旧全局查询回退。
- `SqliteTaskReads`／`ReadTrainingTask`：独立平台任务读取，按当前会话、归属和机器权限在节点 I/O 前后确认原派发，返回任务名、描述与提交者快照；显示信息与额度余额不是读取授权。`ObserveNodeJob` 匹配私有绑定后投影状态／进度，`HttpJobObserver` 只传输一次，不改投或代替接收核对写状态；受限重试由 TaskReadLane 管理。
- `TaskReadLane`：显式共享任务查询名额和截止时间，默认全局 8／每节点 4、总计 40 秒，适配器没有结束时不提前释放名额。协调器只重试一次已确认的暂时读取错误，节点本地不重试；原引用固定，重试前重查权限。任务 API 的 readOnly 上下文把断连传到节点和读取辅助进程，正常请求体结束不触发取消，写操作不接收该上下文。关闭辅助连接不等于原生 SQL 停止，原生 RPC 仍保留自己的执行中连接名额。
- `contracts/task-read.mjs`／`TaskClient`／`bootstrap/task-read.mjs`：公共任务查询与内部节点观察共用明确契约，网页和实验 CLI 使用同一 SDK。未查询、未观察到、不可用与已观察到分开，平台派发阶段不冒充原生执行状态；查询不会自动确认派发、取消训练或退还额度。完整网页页面仍待接。
- `job_diagnostics`／`task-diagnostics.mjs`：同一原生只读快照投影该任务的许可、租约、扩卡预留、活动计划和有界动作记录，再与独立的平台额度观察一起呈现。领域规则解释已记录证据，不根据退出码猜 OOM、不把空租约当释放证明。实时进程／节点容量／内核和 worker 采集／数据清理明确未知；旧持久诊断采集器尚未迁入新运行器。
- `attempt_log_reference`／`gpuq-job-logs.py`：原生只解析同任务下的固定轮次，文件 IO 由节点辅助进程完成。必须配置与原生日志目录一致的 `logRoot`；不推断宿主路径或创建日志。一次至多 64 KiB 原始字节，文件标识与偏移阻止可观察的替换／截短后静默拼接；路径不进入公共结构，日志内容按原字节保留。
- `contracts/task-logs.mjs`／`TaskLogReader`：同一授权与读取名额供状态和日志共用。查看器首次选定轮次后固定游标，增量解码 UTF-8，失败不推进，身份变化／关闭丢弃迟到结果。`TASK_LOG_CHANGED` 需要显式重新打开；这是追加日志查看，不是对任意原地改写的密码学验证。
- `NativeExecutionAuthority`／`TrainingRuntime`：固定节点私有派发绑定，核对原生摘要、当前尝试、实际 GPU 租约、额度许可、预留环境字段与控制目录；复用 GPUQ systemd 后端检查单元描述／InvocationID，再匹配本进程 PID、启动 tick、boot ID 和 cgroup。运行器只接受恢复的原计划，打开输入前后、进入引擎前及引擎实际放行命令前核对同一执行身份，失败关闭本次句柄、保留持久保护。默认 systemctl 使用当前系统用户的固定总线环境。单元／进程对应关系目前由受控夹具验证，实际部署、真实项目解释器／GPU 和停止后释放仍待完成。
- `TrainingCommand`：消费 `TrainingRuntime.open` 的已绑定资源，生成容器内 argv／工作目录／环境及本轮 checkpoint／SDK 挂载。复用 `training-control.open_attempt`，区分平台任务、派发和原生轮次，不再套用旧 submit_key=平台任务 ID 的查询；用户环境只进入容器，SDK 保留在 PYTHONPATH 前部。作用域只关闭自己的控制句柄，不释放数据／GPU／额度。CPU 命名空间已验证同一命令保存、进度和恢复，完整引擎启动及实际 GPU 验收仍待完成。
- `TrainingBudget`／`TrainingRuntime.run`：按已确认轮次的实际 GPU 数设置原 systemd 单元限额，复用 `job-resources` 的每卡 4 CPU／32 GiB、2048 进程规则及 cgroup 读取。设置成功后读取实际约束（含父级、亲和性和物理内存），提供仅本任务的只读 cgroup／JSON 视图；未确认限额不进入引擎。run 持有输入、预算和控制句柄直到引擎返回，启动前再核对当前轮次，保留原退出码且不自行释放持久资源。设置器／cgroup 数值目前为测试夹具，实际 systemd 限额与引擎仍待联调。
- `BwrapTrainingEngine`／`SlirpNetwork`：基础环境的实际执行器，消费已有输入／控制／预算句柄；只读挂载代码、环境和数据，可写 home／outputs。GPU 路径由既有 UUID 解析器提供，不按卡号猜设备。可信 bootstrap 在命名空间完成后握手，网络助手按内核归属进入正确的 user/net namespace；再次授权后才执行带用户环境的命令。pidfd 跟踪原命名空间进程，正常退出或异常都收尾自己的进程，不释放调度租约。需要 Linux pidfd/nsfs、bubblewrap 和 slirp4netns。真实 CPU／本机网络测试已通过；OCI、生产 wrapper、实际项目环境／GPU 仍待验收。
- `TrainingLaunchCompiler`／`PrepareNodeTraining`：把原请求、项目实例／环境与原数据租约编译成私有计划，宿主 argv 只含配置的运行器及计划引用；复用原生资源校验，不把用户容器命令当作宿主命令。原生 ASCII 名与中文展示名分开，展示元数据发送仍待接入。编译不创建租约或提供 launch-ready 许可。
- `SqliteNodeDispatchBindings.prepareTraining` 同事务保存计划、原生规格和映射；旧实验库通过 `createNodeRuntimePlansSchema` 显式升级。`NodeRuntimePlans` 只读恢复固定编号并核对 JSON 字节摘要、wrapper 与原生摘要，不补建或重提；计划不包含原生摘要，避免循环引用。恢复的计划供 `TrainingRuntime` 使用，节点服务及生产发布仍待完成。
- `scripts/v2-training-runner.py`／`bootstrap/training-runner.py`：固定节点入口只接收配置路径、dispatchId 与 planDigest，按已核对的环境选择基础或 OCI 执行器。配置与任务内容分开，不迁移数据库、不创建项目／租约、不接收临时宿主 argv；CLI 在 GPUQ 当前原生轮次之外拒绝执行。生产服务和真实 GPU 链路仍待接入／验收。
- `OciTrainingEngine`：复用已发布镜像、既有 owner graph、已打开挂载和共同控制／预算，不调用旧训练准备流程。编译器仅对 OCI 增加受控 `GPUQ_CONSOLE_OCI=1`，由原生启动器设置 Delegate；用户环境仍留在容器计划。按轮次命名容器，create 后再次授权再 start，以完整 CID／归属和实际退出记录处理结果；已有名称和未知创建回执不重建。仅对已确认归属的原 CID 收尾，必要时强制删除不完整的运行时，不删除绑定输出、镜像或其他容器。独立真实 Podman／systemd CPU 验收通过，但现有个人图存储策略、训练镜像、GPU 和完整原生提交链路仍需实测。
- 原生启动先记录 STARTING，再调用 systemd；execution_snapshot 只读单次数据库观察，不等待 Coordinator 的慢操作锁。真实单元回执后才记 RUNNING；运行器在两阶段之间仍需用实际单元和本进程身份核对。取消主进程退出后的子进程收尾已同步上游 PR 273；成员观察失败时保留原租约、隔离该尝试的整组 GPU，并延后原 TERM／KILL 动作，不阻断其他健康卡。身份／租约结构不能可靠区分时仍保持全局拒绝，不能据此放宽所有异常。

托管子进程测试需要真实 Python 3.12，可通过 `V2_PYTHON` 指定解释器；V2 测试还包含真实 Chromium 登记场景。运行目录需保留 `src/infrastructure/legacy-cache-reader.py` 与配套 `deploy/dataset-cache.py` 及其元数据依赖的相对布局；发布打包尚待完成。
- `infrastructure/sqlite/`：独立的会话、权限快照和来源查询。schema 初始化显式进行，查询类不会建表或迁移。
- `bootstrap/sqlite-data-read.mjs`：节点本地 SQLite 集成入口；VPS 必须选择远端来源适配器，不能把远端路径拿到 VPS 上检查。
- `api/data-read-handler.mjs`：认证、报文解析和错误映射；内部诊断留在服务端。
- `client/`：网页和 Node 共用的 SDK／HTTP 实现；`ClientSession` 是凭据和请求生命周期的唯一所有者，切换身份后拒绝旧请求结果。不重复业务规则，不自动回退或重试。

验证：`npm run test:v2` 和 `npm run test:v2:browser`。依赖方向也有测试，禁止新实现重新导入旧 `PortalService` 或演示服务。

实验任务查询（候选服务须已组装 `assembleSqliteTaskRead` 及节点观察接口，不是正式服务已上线的命令）：

```sh
node scripts/v2-client.mjs --url https://shadow.example --credentials /path/to/credentials.sqlite task --job <平台任务UUID>
node scripts/v2-client.mjs --url https://shadow.example --credentials /path/to/credentials.sqlite task-logs --job <平台任务UUID> --follow
node scripts/v2-client.mjs --url https://shadow.example --credentials /path/to/credentials.sqlite task-diagnostics --job <平台任务UUID>
```

先通过同一独立客户端登录，参数见 `--help`。结果为 JSON：`task` 是名称／描述／提交者与平台阶段，`observation.node` 是节点状态／进度。`unavailable` 或 `not-observed` 不代表训练失败；`dispatch.gpuCount` 是初始派发选择，当前尝试的分配记录看 `latestAttempt.assignedGpus`，后者也不证明资源已释放。

Ctrl-C 只中断本次查询，不终止训练。`TASK_READ_BUSY` 是查询名额暂满，`TASK_READ_TIMEOUT` 是观察超时；两者都不修改原任务。

日志默认从末尾看 64 KiB；`--start` 从头，`--bytes N` 控制分块，`--attempt ID` 指定轮次，`--json` 输出游标与字节结果。`--follow` 跟随首次成功读取的轮次，重启后需重新打开最新轮次；尚未产生日志时先用 `task` 查看状态。新日志接口需节点同时提供 `attempt-log-reference-v1` 并配置 `logRoot`，当前未部署到正式入口。

诊断默认给出中文说明；加 `--json` 查看原生记录与平台额度。它不会停止任务、修复记录或释放资源，缺失的内核／worker 证据仍是未知；需要节点提供 `job-diagnostics-v1`。

上述数据查询接口只返回读取位置的观察，不创建挂载或数据租约；执行链路另外管理它们。生产身份迁移、服务接入以及完整网页／CLI 外壳仍待完成，不能据此宣布整体重构已上线。

## 节点运行器（仅维护者，尚未部署）

配置格式见 [v2-runner.example.json](../deploy/v2-runner.example.json)。填写本节点已有的 V2 数据库、GPUQ socket／控制目录、项目根目录及数据来源；不复制生产数据库到影子库，不手工改任务记录。`leaseVersions` 默认空，仅在已批准的版本权限接管后配置；普通数据直读不需要填写它。

为 `TrainingLaunchCompiler` 配置固定前缀，使用该版本目录和实际 Python 3.12 的绝对路径：

```text
<python3.12> -I -B <release>/scripts/v2-training-runner.py --config <node-config.json>
```

编译器追加 `--dispatch-id` 和 `--plan-digest`，用户命令／环境留在私有计划里。GPUQ 负责启动这个前缀；它不是成员的训练提交命令，直接从 SSH 运行会因缺少当前原生执行身份被拒绝。OCI 使用 `runtimeConfig` 中节点既有的个人容器策略，不创建缺失的 owner graph 或拉取镜像；仅可显式恢复自己的临时 IPC 目录。安装流程、公开提交、真实个人图存储和 GPU 验收仍待完成。
