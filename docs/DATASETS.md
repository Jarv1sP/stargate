# 固定版本数据集：缓存与仓库直读

服务器已有的共享目录不必走本页的复制流程。配置共享读取后，新开发终端和训练默认只读挂载原目录，例如 `/datasets/imagenet`；所有任务使用同一份数据，无需上传、发布或 `data prepare`。项目状态会显示实际读取路径。原目录由服务器上的维护者管理，容器只读不会把它变成不可变快照；需要独立固定快照、缓存加速或跨机副本时，再显式使用下述流程。

已有的 `--data-read warehouse` 读取已入库且本机仓库 `READY` 的固定版本，跳过仓库到训练缓存的复制，不跳过原目录入库。未指定该参数的固定版本训练仍默认使用缓存；新增共享原目录挂载不改变这个默认值，也不修复入库复制任务本身的忙、超时或重试问题。

本页描述仓库中的数据集接口与部署步骤，不代表某台服务器已经完成配置。所有已登录且启用的成员可浏览数据仓库目录；使用固定版本仍须读取授权、机器授权及对应读取位置的 `READY`。源码测试通过不能替代真实节点的挂载、只读和断网验收。

固定版本目录预览使用独立只读 `datasets.files.list {dataset,version,path?,cursor?}`，详见
[目录契约](DATASET_FILES.md)。只有本人内容 ACL 与真实节点能力均确认才能读；未知节点
返回 unavailable 而非空树。页读取持整页版本锁但不建立持久下载租约，不提供文件正文。

个人工作区的旧发布接口 `data workspace-status OPERATION_ID` 返回该次发布的阶段 `SCANNING / REGISTERING / REGISTERED / ARCHIVE_INTENT / MATERIALIZING / COMPLETED`。登记成功后即保留完整数据集与版本编号，后续失败不会丢失它们。锁等待失败另有 `failureKind:CACHE_BUSY` 和 `lockWait`：`scope` 区分全缓存锁与单版本锁，`limit` 区分单次等待上限和累计争用预算，`timeoutSeconds` 是这次取锁允许等待的时长；它们不证明谁持锁、磁盘已满或数据 READY。旧回执没有这些字段时阶段仍未知。

查询原编号或重复同一发布 key 不会重启 FAILED worker。确认 FAILED 后，旧接口仍开放的部署可显式以相同目录、相同名称、新发布 key 重新发布；源内容未变时沿用同一内容版本，并核验已有片段后继续。保留原失败回执与源文件；不通过换名称绕过争用或容量保护。已切换集中机械仓库的部署使用新的仓库发布入口，不能借旧接口绕过存储策略。上述诊断须更新节点 `data-workspace.py` 与 `dataset-cache.py` 后才可用。

## 数据整理约定

把同一来源、同一用途的样本整理成完整、可复用的集合。同一集合更新时保留名称，用新的内容版本区分，不为每次实验另建一份数据集。

- 显示名称说明内容和用途，不只用纯数字、随机字符或临时任务编号；例如「人体姿态训练集」。
- 不要故意登记没有独立复用用途的零散临时小数据集；主体或分片属于同一集合时尽量合并，由训练程序按需选取子集。
- 预训练权重、tokenizer 和模型配置放个人项目的 `weights/`、`models/` 或 `tokenizers/`，随项目发布；新训练产物写 `/outputs`，不登记为数据集。

以上是整理和显示命名约定，不改变上传名称的接口规则。平台生成的内部数据集 ID 和完整 64 位版本哈希保持不可变；个人显示名用 `gpuctl data label DATASET_ID --display-name "人体姿态训练集"` 设置，不做全局重命名，也不改变读取授权。训练继续使用原始 `NAME@VERSION`。

## 用户最短流程

先手选已获授权的机器。普通成员可以上传自己电脑上的目录，不需要管理员代为登记，也不需要加入节点管理网络：

```sh
gpuctl use gpu-1
gpuctl data upload ./my-data --name my-data
```

名称使用 1–40 位字母、数字、下划线或连字符，以字母或数字开头。上传只写自己的数据，不提供宿主机路径注册、共享授权或管理员权限。平台返回个人隔离的数据集 ID（形如 `u-用户标识-my-data`）、完整版本及准确训练路径；请复制返回值，不要把输入的短名称直接当作训练挂载名称。另一用户可使用相同短名称，但不是同一份数据。

CLI 先逐块计算文件 SHA256，再分块传输清单和文件，最后等待服务器完整校验与原子发布。正常输出“数据集已就绪”或 JSON `READY` 才代表成功；准备、上传和校验均不申请 GPU。项目代码和环境仍需单独发布 READY。

网络中断后运行**同一机器、同一名称、同一目录**的上传命令，客户端重新检查内容，并按服务器确认的文件偏移继续，不重写已有字节。上传期间不要改动目录；CLI 在扫描结束及请求发布前核对目录条目名称和文件身份，不只依赖目录时间戳；检测到变化不请求发布。这是变化检查，不是对外部写入的原子文件系统快照。内容确实改变时，会作为新内容版本处理，不覆盖旧 READY 版本。

需要单独查看或放弃未完成上传时，使用上传输出中的真实编号：

```sh
gpuctl data upload-status UPLOAD_ID --machine gpu-1
gpuctl data upload-discard UPLOAD_ID --machine gpu-1
```

取消仅处理自己的未完成上传；`DISCARDING` 是后台处理中，只有 `DISCARDED` 才确认结束，READY 数据不能由这个命令删除。取消完成后可重新运行上传命令开始一份新上传。重试标识保存在现有客户端会话缓存；浏览器仅保存本机续传标识，不保存数据文件或密码。丢失响应不代表服务器停止，先查询原上传；退出客户端不会停止已经开始的服务器校验。

每份清单仍支持最多 **500,000 个文件和目录条目、64 MiB 清单 JSON**，两项上限同时适用；清单块和 VPS 中转的文件块不超过 1 MiB。校内直传的文件块可按新版票据协商到 16 MiB，旧客户端仍兼容；CLI 从 1 MiB 起步，按已确认的传输速度调节，不自动重发未知写入结果。详见[校内直传](DIRECT_UPLOAD.md)。目录层级、空文件和 CLI 选择中的空目录会保留。拒绝软链接、特殊文件、多硬链接文件、路径穿越和已知凭据/环境目录。节点还检查上传容量、账号保留容量和未完成数量；遇到限额错误，应取消不再需要的未完成上传或联系管理员，不能通过换名称绕过。

个人上传的默认额度是：单份文件内容 **1 TiB**、每个账号在每个节点合计 **2 TiB 存储预算**、最多 **4 个未完成上传**、**256 个保留上传记录**、**200 万个保留文件和目录条目**、**1,024 个历史上传会话**。存储预算还计入清单和每个条目的保守元数据开销，因此不等于文件净大小；取消或管理员注销后释放保留额度，但历史会话需管理员审核归档。管理员可在节点 `datasets.uploads` 配置中调整 `maxUploadBytes`、`maxUserBytes`、`maxActiveUploads`、`maxUserUploads`、`maxUserEntries`、`maxUserSessions`。这些不是覆盖项目、结果和所有宿主文件的硬磁盘配额；节点仍检查实际可用空间、inode 与安全余量。

实验室也可采用**共享容量、不限制每个人的存储份额**：管理员显式设置 `datasets.uploads.maxUserBytes: 0`，即可关闭个人上传及链接导入的累计字节预算。全节点的真实可用空间、安全余量、并发空间预留仍强制检查；单次上传大小、清单/条目和并发上限保留。此设置不启用或撤销已有的内核硬配额，也不意味着容量无限。管理员应为共享数据卷保留恢复空间；正在运行的程序直接写文件不受上传入口检查控制。

`gpuctl data upload` 和新版网页目录上传优先使用管理员启用的受限直传入口，清单和文件字节直接到节点，门户仅处理身份、授权与发布控制。没有入口时，小目录可用 VPS 中转；超过 256 MiB 必须明确加 `--via relay`（网页需确认）才使用中转带宽。选择直传后连接失败不会自动改走 VPS。`data put` 与个人数据空间的单文件上传仍是门户中转；不要将目录直传理解成所有文件接口均已绕过 VPS。部署与验收见 [校内直传](DIRECT_UPLOAD.md)。大量小文件仍有逐文件请求成本。

启用机械仓库入库后，新版 CLI／网页仅对没有旧续传标识的新目录上传，先保存本地固定意图，再由门户持久分配新的服务器上传 UUID，最后准入固定 HDD；不等待无关旧节点在线。分配丢响应时只查原意图，不能换编号或自动重开；原有上传编号、浏览器 handle 和旧传输记录仍走原位置核实与恢复，离线不当作不存在，全节点都确认不存在的旧裸编号也不能新建。新上传命令仍是 `gpuctl data upload`；新建 `transfer upload`／`transfers.create kind=upload` 在此策略启用时关闭，已有传输可沿原编号恢复。入口能力不证明磁盘、容量或直传网络已可用，最终仍须节点准入与完整 READY 校验。

管理员受保护入库配置的 `allowDuringMaintenance:true` 只允许上述服务端签发、绑定当前固定 HDD 的上传控制与数据写入；仍核对账号、所选训练机器权限和容量。它不清除维护状态，也不恢复训练、终端、项目、SSD／旧编号新建、通用传输或缓存准备；未明确启用时仍受维护阻止。

已有节点的 READY 数据，在管理员核验并开启私网传输后可按需复制到另一台已授权机器，文件字节走节点间固定 TLS 通道，不经过 VPS；没有启用该能力时不会静默改走公网中转。上传不主动向所有机器复制，也不构成备份，请保留原始数据。

对于管理员已经分配的数据，在同一机器创建/选择项目后准备本地副本：

```sh
gpuctl use gpu-1
gpuctl project use my-project
gpuctl data list
gpuctl data prepare NAME@VERSION
gpuctl data status NAME@VERSION
```

把 `NAME@VERSION` 整段替换为目录里显示的名称与**完整 64 位小写十六进制版本**，不是 `latest`、短哈希或宿主机路径。项目须已完成上传代码、安装依赖、发布；完整新建流程见 [项目手册](PROJECTS.md)。项目版本为 `READY` 后提交：

```sh
gpuctl run -g 1 --data NAME@VERSION -- python train.py --data /data2/NAME --output /outputs
```

`--` 前的 `--data` 是平台的数据集选择，后面的 `--data /data2/NAME` 是示例训练程序参数；如果你的程序使用其他参数名，应按程序修改。当前客户端使用 `-g 1`，不要合写成 `-g1`。

新版网页与 `gpuctl run` 会请求先准备所选机器上有可用来源的数据：本机批准的登记来源，或已启用私网传输、本人同时获准访问源与目标机器的 READY 固定版本。尚未就绪时，训练记录处于 `PREPARING_DATA`，节点在后台准备，未申请 GPU；全部数据 READY 后才进入 GPU 排队，届时仍会重新检查授权与配额。取消等待中的训练不会自动取消可能被其他训练共用的数据准备。没有读取授权、可用来源或状态无法确认时仍拒绝提交，不能靠“自动准备”任意读取别处文件。已失败的准备不会因提交训练而无限重试；应先在数据集页或 `data prepare` 明确重试，确认进入准备中或 READY 后再提交训练。只查看或单独执行 `data prepare` 不会自动创建训练。

关闭网页或客户端不影响已开始的后台准备。只准备完数据还不够：所选节点的项目代码与环境版本仍须发布 READY；代码/环境发布不等于数据本地就绪。`data prepare` 只处理数据集；需要跨机复用代码和容器环境时，使用[项目手册](PROJECTS.md)中的固定版本复制或显式自动选机流程。

训练读取的是所选节点的本地副本，挂载为 `/data2/NAME`，只能读。项目训练输出、缓存索引和模型写 `/outputs`，代码 `/workspace` 与项目环境只读，不能写回数据集。未迁移的旧个人工作区任务仍按旧方式写 `/workspace`。普通无 GPU 终端不会自动挂载训练的数据集。

多个数据集可重复写 `--data NAME@VERSION`，门户每个任务最多接受 8 个；同一次任务不能挂载同一名称的两个版本。默认仍使用本人选择的机器，不会暗中换节点。需要自动选机时，显式使用 `gpuctl run --machine auto` 并指定候选机器与固定项目版本；平台只在满足授权、资源及项目/数据准备要求的候选中选择，详见[项目手册](PROJECTS.md)。不是把 `auto` 作为训练命令，也不自动跨机组合 GPU。旧 API 客户端未明确发送 `prepareData:true` 时，仍按原方式要求全部数据已就绪；历史任务不因新功能改变执行方式。

## 网页流程

左侧只使用“数据集”这一个入口。页面上方是统一版本目录，下方“添加数据”按来源展开；个人文件和训练固定版本是同一条流程的不同阶段，不是两个可互换的数据副本。

### 所属用户

单人授权显示“所属用户：用户名”，多人授权显示“共享授权用户”，指当前授权用户而非创建者。用户名来自门户账号表，不根据数据集 ID 或目录名推断。账号已删除、旧节点没有完整归属信息时显示未知；合并版本若各节点授权不同，显示“各机授权不同”，并保留每个位置的归属说明，不把多机名单合并成同一归属。

目录元数据对所有已登录且启用的成员可见，包括暂未分配机器的账号。可看名称、版本、大小、所属用户和副本位置，不因此获得文件、清单、私有来源或训练权限。“仅浏览”的版本不能准备或用于训练；它在别人的机器上 `READY` 只说明存在完整副本。数据读取、下载、准备、个人显示名修改及训练仍独立鉴权，管理员删除入口仍只对管理员开放。此改动不重写节点 `owners`，也不开放匿名目录。

API 的 `datasets.list` 每条数据集、`datasets.catalog` 每个版本及其 `locations` 提供只读 `ownerLabel` 字段；不返回整张用户表或内部 owner IDs。节点返回的授权名单超出展示上限时显示未知，不显示截断名单。

数据集可以有便于辨认的显示名称；显示名称不改变数据集 ID、固定版本或读取权限。训练命令仍使用目录返回的原始 `NAME@VERSION`，不要把中文显示名称代入。

个人上传与服务器整理发布的内部 ID 分别为 `u-<账号隔离编号>-<上传名称>`、`w-<账号隔离编号>-<发布名称>`。列表默认显示你填写的名称，完整 ID 留在次级信息和详情供复制；已有个人显示名优先。隔离编号防止不同账号的同名数据相互覆盖，不用于推断所属用户，也不改变数据集使用权限。

1. 打开目录即可查看已登记数据；有机器授权时选择**本次使用的服务器**，点击“加载 / 刷新”。目录按数据集 ID 与完整版本整理副本位置；短名称相同但 ID 或版本不同的内容不会混为一份。每个位置分别判断本人使用权，未授权版本只供浏览。某台机器不可读取时明确显示部分结果，不能据此认定该机器没有数据。
2. 需要新数据时展开**添加数据**，选择一种来源：
   - **已整理的本机目录**：填写名称、选择电脑上的目录，点击“上传 / 继续”，直接传输、校验并发布。浏览器逐块读取，目录选择不包含空目录；需要保留空目录时使用 CLI。
   - **链接 / 云盘导入**：导入到当前服务器的个人 `/data2`，完成后点击“下一步：手动整理与发布”。普通 HTTPS 直链与云盘分享按各自后端能力处理；单实例阿里云盘接入尚未完成真实分享下载验收，入口存在不代表授权或下载已可用。
   - **文件与手动整理**：上传压缩包或文件，也可处理已通过链接导入的文件。用个人数据终端手动解压、整理，结束此机全部数据终端，再发布整理好的子目录。**不会自动解压、执行压缩包或自动发布。**
3. 对本机尚未就绪、但目录已确认有可用来源的版本，可点击“准备到本机”单独准备，或点击**准备后训练**。启用私网传输且权限满足时，平台复用持久传输任务，将其他节点的固定版本复制到当前机器；文件字节不走 VPS。没有可用通道时只显示位置，不承诺可复制。失败版本先明确重试。提交后等待数据完成，不提前占 GPU；用 `gpuctl data status NAME@VERSION` 或“传输”页查看结果。
4. 当前服务器显示**本机已就绪**时，点击“用于训练”；否则仅有批准来源或已确认正在准备的版本能选择“准备后训练”。检查工作台里的机器与完整固定版本。仅其他位置已就绪不会解锁当前机器的训练按钮。
5. 选择同机 READY 项目版本，填写训练命令，例如 `python train.py --data /data2/NAME --output /outputs`，再提交；程序参数按实际代码调整。

容量栏显示所选机器数据文件系统的可用空间、总容量、安全预留及扣除预留后的空间，是共享磁盘的即时读数，**不是个人硬磁盘配额**。无法读取时显示“容量暂未确认”，不会按零使用或无限空间处理；最终上传/发布仍须通过节点容量检查。发布会复制原始目录，需要同时容纳原文件和固定版本；已下载不等于已发布。

切换添加方式保留当前页面草稿；账号切换会清空旧身份的表单和视图、停止旧身份的后续传输。不同服务器的个人 `/data2` 不会自动同步。

“暂停传输”保留已经上传的部分，“取消未完成上传”用于放弃该次上传。关闭或刷新页面会停止电脑向服务器传输；服务器已经开始的清单校验和完整校验会继续。再次打开后，选择相同机器、名称和目录可检查状态并续传；浏览器出于安全限制不会自动恢复本机目录选择。退出或切换账号立即停止旧账号的后续传输，不会用新账号继续。

“用于训练”只是填入训练表单，不代表已申请 GPU 或已开始任务。换机器后应重新核对该机器的版本状态。机器授权与数据集所有者授权分别检查；能看机器资源不等于能读取它的全部数据。

管理员可以查看和维护所有数据集，但以个人身份提交训练时也必须列入该版本的 `owners`。管理可见不等于个人训练已获授权；管理员应先在可信管理入口明确授予自己的数据读取权限。

## 状态意味着什么

| 状态 | 可以训练吗 | 含义与处理 |
|---|---|---|
| `REGISTERED` | 否 | 已登记固定清单，尚无可用本地副本；请求准备 |
| `REGISTERING` | 否 | 管理员后台正在生成清单；目录扫描可能耗时 |
| `PREPARING` | 否 | 节点后台准备任务仍在执行 |
| `STAGING` | 否 | 存在未发布副本；可能正在传输，也可能是中断后待续传，不能单凭它断言任务仍活着 |
| `READY` | 是，仍需配额及调度许可 | 本地完整清单与文件 SHA256 验证通过，已经原子发布 |
| `FAILED` | 否 | 后台准备失败；查看错误，修复容量、源可达性或授权后重试 |
| 无法读取／忙／未知 | 否 | 没有确认就绪；不要当作空数据集或成功 |

目录状态与后台准备任务状态不是同一个对象；训练记录的 `PREPARING_DATA` 也不代表数据已经 READY 或 GPU 已排队。后台失败不会把半份文件标为 `READY`。遇到一直“准备中”、失败后网页无法重试或状态不刷新，先用 `data status` 查结果，再联系管理员；不要通过修改目录、伪造 `READY` 标记或提前运行训练绕过校验。

## 存储布局与旧数据

默认缓存根为 `/data2/datasets`。可信节点配置可用 `datasets.root` 与显式 `datasets.mountPoint` 指定另一块已核验的数据盘；这不改变作业内的 `/data2/NAME`。数据根必须位于明确的、可写的本地数据文件系统，不能只是系统盘上的同名目录。每次操作检查挂载、设备与目录身份；缺失、只读、被替换或变成系统盘时拒绝操作。更换物理根是独立维护操作，不能移动活跃训练或用软链接绕过检查。

```text
/data2/datasets/                   缓存服务持有，0700
  .registry/                      授权与内容清单，不向普通用户暴露源路径
  .staging/NAME/VERSION/           未就绪版本与续传围栏
  ready/NAME/VERSION/data/         校验后的本地只读内容
  .leases/                        持久作业租约
  .tiers/                         版本保护角色、最近使用、固定保留与恢复回执
  .retirements/                   版本删除的持久围栏
  .reopens/                       清除后显式新登记的固定代次证明
  .locks/                         全局短锁与逐版本锁
  .trash/                         已安全移出目录、等待清理的对象
```

作业内的 `/data2/NAME` 只映射 `ready/NAME/VERSION/data`，不会映射整个宿主机 `/data2`、注册目录或所有数据集。

旧 TB 级目录保留原位置、原数据与原所有权，不会因为部署、注册或改用统一入口就被自动搬走、删除或批量复制。管理员应只登记明确批准的数据集范围；**登记不等于本机 `READY`**。首次准备某个版本时，才按需复制到该节点缓存；已有本地版本可重复使用。

`register_source` 为生成内容版本会读取所登记范围内的全部文件并计算哈希。它不是零开销的路径登记，更不应对整块旧数据盘自动运行。先用小样本验收，再由管理员安排实际数据集的登记窗口。源内容变更应登记新版本，不能覆盖已有版本。

## HDD 长期版本与本地热缓存

本节描述 0.4.3 的可选流程与启用条件，**不代表某个部署已启用自动归档或回收**。归档与 GC 分别默认关闭：先部署配套程序，再配置可信来源、验收完整恢复与读取生命周期，最后单独启用回收。仓库提供可选的 `gpuq-storage-gc.service/.timer`，安装/升级不自动启用。用户仍手选上传和训练机器，使用返回的数据集 ID、完整内容版本和 `/data2/NAME`；平台不会默默更换训练机，也不要求用户知道宿主 HDD/NVMe 路径。

### 启用后的新上传与发布

管理员同时启用节点 `storageArchive` 和门户可信归档策略后，新上传或数据草稿发布的单 owner、固定 READY 版本才产生持久归档事件。后台通过已配置的节点间 LAN 通道复制到固定 HDD 权威机器，完整校验并永久保护原件，再按目标机器签发服务端私有恢复授权、认证本地缓存。文件字节不经 VPS；权限仍按该数据的 owner 检查，读取自己的归档不要求取得 HDD 机器的 GPU 训练额度。

上传的本机 `READY` 与长期保存状态分开显示。归档完成前，本地上传仍受保护，失败不删除它；只有完整认证成功才可成为 `cache`。归档成功也不会立即清掉 NVMe，之后仅在明确启用 GC 且达到水位时选取安全候选。**HDD 上唯一的长期原件不是独立备份**；介质损坏仍可能导致数据丢失，训练结果与 checkpoint 不在这条自动归档流程中。

旧登记、启用前的上传、共享/多 owner 数据不会被扫描补归档或自动改成 cache。重新登记也不能覆盖已有私有 grant；身份、策略或授权冲突保留原件并要求核查。

管理员更换默认仓库时，已认证的历史原件仍显示其原来源机器，不会被冒标为新仓库。旧待处理归档不会自动转移或重跑；读取与释放仍需核实真实副本、权限和保护状态。跨仓库的旧原件退役须另有完整迁移证明，不能仅靠修改默认机器完成。

失败或受阻时，先查看数据集的长期保存状态。确认已处理容量、来源或授权问题后，明确重试同一归档：

```sh
gpuctl data archive-retry NAME@FULL_VERSION_HASH --machine gpu-1 --json
```

重试会复核当前 owner 与原上传机器权限，继续原持久意图，不用新任务绕过未知状态或永久取消围栏。后台归档传输不能通过普通 `transfer resume` 直接恢复；已永久取消的归档需要管理员核查。超时或 `UNKNOWN` 不代表 worker 已停止，不要反复上传制造替代任务。

- **受保护版本 `protected`**：原件、唯一上传及没有角色记录的旧登记默认受保护，不进入分层 GC。不会因配置了 `sourceId`、成功复制过一次或闲置时间长就变成可清理副本。
- **可重取副本 `cache`**：仅可信后台流程（或明确的管理认证）完成权威版本全量校验、固定来源身份及 ACL、持久保护源版本，并验证适配器具备实际恢复能力后，才可签发恢复回执并标记。源与目标的读取所有者必须一致。普通请求不能提供证明、角色、源路径、主机地址或授权令牌。
- **回收与重取**：按持久最近使用记录选择候选，必须同时满足完整有效回执、当前来源可用、无租约、无 pin、无未知/损坏状态。回收持有逐版本锁，并在与租约取得相同的全局短锁内复查保护状态、隔离副本；保留登记和恢复回执。再次 `data prepare` 从回执固定的权威版本恢复，校验后原子 READY；不会退回过时的 `sourceId`，也不会因为历史复制成功就误报本机就绪。
- **数据范围**：仅处理显式登记的数据集版本，不扫描或清理个人工作区、数据草稿、项目/环境、`/outputs`、旧宿主目录。结果归档与独立备份仍是另一项能力，不能把模型或 checkpoint 当可重取缓存。

首次权威认证需要完整清单与文件哈希校验；之后的回收前检查只核有界元数据、挂载/目录身份、授权、持久保留及来源存活，不会每次重扫几十万文件。恢复发布仍做完整校验。该机制依赖受信服务与只读版本约束，不代替介质巡检、独立备份或高可用；同一物理盘上的两份目录不算备份。

节点可信配置的 `storageTier` 默认 `enabled:false`，缺省高/低水位为 `0.8/0.7`；启用必须显式给出正整数 `budgetBytes`，并同时遵守实际文件系统可用空间和现有 staging 预留。预算不是文件系统硬配额。无法满足空间检查就明确拒绝准备，不能删除原件或活跃任务来腾空间。不按天数让租约过期，重启、失联和 `UNKNOWN` 都不能作为释放证明。

启用后，`budgetBytes` 也是新数据副本的准入上限，而不只是定时回收水位。服务端同时计算 READY 副本、整个待准备版本（已写入部分仍占预算）与上传预留，并留出清单、目录和文件的保守开销。同一传输重连不会再计一次全部有效载荷；不同客户端的准备在短锁内重新检查，不能一起花掉同一份剩余容量。发现损坏或无登记的缓存状态会拒绝新增副本，不删除未知文件。实际可用字节和 inode 仍在准备及写入时复核；预算充足不代表共享卷有空闲空间。

私有上传预占记录的 `bytes/inodes` 仍只表示物理待写空间；独立 `budgetBytes` 表示逻辑承诺。seal 在同一缓存锁内把该逻辑承诺交给完整 staging，成功后总承诺仍等于 begin 已接受的预留；交接中断只会保守多计，不提前释放尚未建立的副本。新版读取旧记录时缺省按 `bytes` 保守核算，不猜测退还预算。发布必须配套更新节点缓存、上传、tier、执行器和传输 helper，确认没有活动数据写入者后冷重载常驻 transfer-peer/direct-upload；旧缓存 helper 拒绝新预占字段，不能在新记录写入后混用或盲回滚旧 helper。此要求不授权停止训练、开启 timer 或修改磁盘配置。

缓存与个人工作区位于同一物理卷时，最低空闲空间采用 `datasets.reserveBytes` 和 `workspaceReserveBytes` 中较大的值，绑定挂载或路径别名不会让预留失效。不同物理卷分别计算，不能把机械盘和固态盘的容量相加。未启用 `storageTier` 的权威仓库只遵守该卷的空间/inode 预留，不套用固态缓存预算。

可信后台准备任务会在需要时先执行一次有界回收，最多回收 16 个合格的闲置副本，保留当前固定目标；已 READY 的同一请求直接复用，不触发整库回收。单个版本连保守开销都超过预算时，在回收前直接拒绝。没有有效恢复证明、来源不在线、仍有租约或固定保留的版本不能为它让位；回收后还必须再次通过实时准入，不能以预计释放量承诺成功。任务结束仅释放已核实的租约，使闲置副本成为未来候选，不每次删除所有热缓存。

超大数据先保留在权威仓库，暂不准备到固态；本功能没有自动分片、按样本流式迁移或直接挂载机械仓库训练的承诺。个人工作区、模型与输出不属于数据缓存回收范围，也没有因此获得文件系统硬限额；成员仍应避免自行写满共享卷。

可选 timer 通过节点服务账号的私有 `node-executor.py --storage-collect` 入口定期检查空间压力：启动后约 15 分钟首次检查，之后每小时检查，另有最多 5 分钟随机延迟。每次最多回收 16 个已重新验证的合格版本；没有压力就不删除，不按年龄到期清理。配置未明确启用时，即使手工启动这个 service 也返回 `DISABLED`。该入口不在门户/RPC/peer 白名单；生产启用须另行完成并记录配置、权威源和旧读取保护验收，不能仅启用 timer 就跳过这些前提。

### 管理员：查看与固定保留

以下是已实现的管理接口；服务端重新检查管理员身份。`status` 和 `plan` 都不删除数据，CLI 不提供开启 GC、`collect`、角色修改或权威回执上传命令。

```sh
gpuctl data storage status --machine gpu-1 --json
gpuctl data storage status NAME@FULL_VERSION_HASH --machine gpu-1 --json
gpuctl data storage plan --machine gpu-1 --json
gpuctl data storage pin NAME@FULL_VERSION_HASH manual-training --machine gpu-1
gpuctl data storage unpin NAME@FULL_VERSION_HASH manual-training --machine gpu-1
```

状态可显示策略、水位、预算、容量及指定版本的角色、最近使用时间、pin/lease 数量、当前恢复验证结果，不返回私有源路径或令牌。`plan` 只是当时的预览，不是删除承诺；实际回收必须重新核验。管理员在平台外启动使用该版本的训练前，应先 pin，确认所有读取进程结束后才 unpin；解除 manual pin 不会解除作业租约。

网页的缓存预算位于数据集页的管理员区域，展开后加载，也可明确刷新；离开页面不会继续轮询四台机器。版本详情中的“固定缓存”只管理当前账号创建的手动标记。操作回包丢失时保留原标记并先查询确认，刷新页面不会自动再创建；状态未知时不要用总 pin 数量猜测操作成功。更换账号不会继承另一账号的解除权限。

`authority-` 是权威来源的保留前缀，不能通过普通 pin/unpin 接口修改。权威版本被永久固定时，普通接口也不能删除、注销、更换来源或改变 owners；退役/撤销须先由可信维护流程核对所有依赖副本，当前没有通用自动退役入口。不要手工删除 pin 文件来绕过保护。

### 来源读取与启用门槛

节点间 `transfer copy` 在首次读取前持久记录源保护意图并取得 `transfer:UUID` 租约，每次 peer 读取核验对应租约。完成或取消时，只有可信目标确认 worker 停止并写入永久禁止恢复的围栏，源才撤销票据和释放租约；暂停、失败、超时、重启或未知状态继续保护来源。这里描述协议能力，**不表示某个部署的 peer 已配置或已启用**。

配套新版 `transfer download` 在首个文件读取前取得独立 `download:UUID` 持久租约，整个下载、断点续传期间保留；完成或明确取消通过受信控制入口写永久围栏并释放，未知状态不按时间过期。节点单次读取仍持版本锁，并验证精确 owner、版本及下载租约，客户端不能传入 `leaseId` 或布尔标记冒用。旧门户/旧快照入口没有这种整次保护：启用 GC 且版本为 `cache` 时，旧 `sync data` 读取明确拒绝，应从受保护原件读取或使用配套新版传输任务。GC 关闭时及受保护原件上的旧读取保持兼容，项目代码快照不受影响。

“准备后训练”在数据准备完成后取得持久准备 hold，再交接到实际训练租约；准备就绪到训练启动之间不会留下无保护窗口。取消未派发准备须证明没有原生训练派发；已派发任务仅在真实训练终态且 worker 全部停止后释放。失联、重启或 `UNKNOWN` 都继续保留，不会为了回收空间终止训练。

外部 NFS/rsync 仍不受此快照入口或新 TLS 租约自动保护。启用相关源的 GC 前，必须停止/迁移旧外部读取，或由管理员明确固定其源版本；不能仅凭一次请求成功就认为整次复制已受保护。

远端权威只通过管理员预配置的节点和证书指纹建立固定 TLS 通道，授权绑定源/目标机器、数据集与版本；私有 grant 留在服务端。来源离线、证书/挂载身份变化、ACL 或回执不符时不授权回收，恢复失败保留中间状态且不发布 READY。不从用户请求或未知回执解析任意 endpoint。

## 管理员：本地目录与可信配置

以下均为宿主机管理员操作，不是普通 `gpuctl` 用户接口。命令在已检查的节点上显式执行；文档本身不会创建目录、挂载网络盘或重启服务。

先只读预览 `/data2`，再准备服务私有缓存目录：

```sh
sudo python3 deploy/prepare-data-root.py --service-user CACHE_SERVICE_USER
sudo python3 deploy/prepare-data-root.py --service-user CACHE_SERVICE_USER --apply
```

`CACHE_SERVICE_USER` 必须是实际执行缓存操作的服务账号。若 `/data2` 由已确认的非 root 管理员 UID 持有，只有经过核实才添加 `--trusted-parent-uid UID`；不能借此信任普通用户。工具只创建缺失的 `/data2/datasets`，不递归 `chown` 或修复已有目录。已有权限不匹配时停止并人工核查。

若还没有合格的 `/data2` 挂载，应先按 [部署手册](DEPLOYMENT.md) 与 `deploy/storage-layout.py --help` 预览存储映射。不得用创建一个空 `/data2` 目录来掩盖数据盘未挂载。

独立管理 CLI 从 root 所有、仅 root 可读的配置文件读取来源，例如 `/etc/gpuq/datasets.json`：

```json
{
  "root": "/data2/datasets",
  "serviceUid": 1000,
  "serviceGid": 1000,
  "reserveBytes": 10737418240,
  "sources": {
    "tiny-local": "/data2/imports/tiny"
  }
}
```

这里只是格式示例。UID/GID、源路径与账号必须按节点核实；配置文件应 root-owned、mode `0600`。CLI 先核验配置，再按 `serviceUid/serviceGid` 降权；服务账号必须有源的读取权限。普通用户不能提交或修改这份配置，也不能把任意宿主机路径转换为来源。

节点执行器使用节点私有配置中的 `datasets` 对象，格式略有不同：

```json
{
  "datasets": {
    "root": "/data2/datasets",
    "mountPoint": "/data2",
    "reserveBytes": 10737418240,
    "sources": {
      "tiny-local": "/data2/imports/tiny"
    }
  }
}
```

节点执行器已以服务账号运行，这个对象不接受 `serviceUid/serviceGid`。管理 CLI 与执行器必须使用一致的缓存根、来源编号和实际来源映射；只在 CLI 配置里加入来源，并不会自动更新节点执行器的配置。

### 已有执行节点增量升级

已安装执行器且完成数据盘准备时，可将本版本的部署文件暂存到节点，使用原服务用户预览后更新，不必重新安装 GPUQ：

```sh
python3 deploy/upgrade-datasets.py --directory ~/.local/libexec/gpuq-console
python3 deploy/upgrade-datasets.py --directory ~/.local/libexec/gpuq-console --apply
```

`--directory` 必须改为实际执行器目录。工具备份原配置与程序，保留工作区、调度数据库、网络助手及个人环境路径，不重启 GPUQ、不覆盖终端助手。早期配置缺少 `conda` 时只从旧 runner 的固定只读挂载提取原路径；缺少 `hostRoot` 时仅已识别旧版本可自动保留既有管理员能力，未知版本必须先人工审核并显式配置，不能借升级自动授予 root。

## 管理员：登记与准备小样本

先确认 `/data2/imports/tiny` 是专用小样本，而不是整个旧 TB 数据目录。`owners` 填平台不可变用户 ID，不能填显示名、Unix UID 或共享服务器用户名；可通过管理员的 `gpuctl users --json` 查找。下面的 `demo-user-1` 是示例，必须替换为实际获准用户。

```sh
sudo python3 deploy/dataset-cache.py --config /etc/gpuq/datasets.json <<'JSON'
{"op":"register_source","dataset":"tiny","sourceId":"tiny-local","owners":["demo-user-1"]}
JSON
```

成功输出 `{"ok":true,"result":{...}}`，其中 `version` 是完整内容哈希。CLI 只读取 JSON 中的固定操作，不执行用户提供的 shell/rsync 命令。注册不会自动复制源。之后可由已授权用户运行 `gpuctl data prepare tiny@VERSION`，或管理员在本机调用：

```sh
sudo python3 deploy/dataset-cache.py --config /etc/gpuq/datasets.json <<'JSON'
{"op":"materialize","dataset":"tiny","version":"替换为注册结果的完整64位版本"}
JSON
```

这个占位字符串必须替换，不能原样执行。独立 CLI 的 `materialize` 会同步等待复制与校验；门户的 `datasets.prepare` 由节点后台任务执行，及时返回操作编号。

来源必须是明确批准的独立目录。拒绝宽泛系统/家目录、穿越、软链接、特殊文件和多硬链接文件；凭据与环境目录不属于数据集。版本内容只包含清单列出的文件和目录，后来新增的源文件不会混入旧版本。

数据集与来源编号使用 1–64 位 ASCII 字母、数字、下划线或连字符，并以字母或数字开头；这不限制平台用户使用中文显示名。当前单份清单最多 500,000 个文件与目录条目，清单/元数据 JSON 上限仍为 64 MiB；两个上限均须满足。超过时需要管理员按合理范围分组，不能承诺任意规模目录都能一次登记。节点数据集后台任务单独限 2 GiB 主存、1 核 CPU 额度；这不改变训练、终端或其他服务的额度，也不保证任意文件名长度/目录形状都能装入上限。

## 管理员：清缓存与注销登记

**节点更新前，按机器删除只在确定还有其他完整副本时允许。** 门户在本次请求内实时读取清单中的节点目录：其他机器必须确认同一数据集的确切完整版本已就绪；归档原件也必须在另一台已登记机器上被本次读取证实完整。历史归档记录、登记来源、准备中、未知或读取失败都不是完整副本的证明。任一读取失败返回 `409 LAST_COPY_UNPROVEN`，不派发删除；整集中的每个版本都必须通过。

旧节点的 `unregister` 会立即清理副本内容，只保留登记恢复元数据，**不能保证原数据可恢复**。网页确认框只列出实际保留的数据库原件或其他完整副本，不默认承诺数据库已经保存它；唯一副本或保留状态不明时禁用删除。最终仍由门户复核，拒绝的原文会留在页面，不自动重试。

门户在派发前把目标机器、登记名、完整版本、原操作编号、门户发起时间和目录提供的登记身份写入现有 SQLite。已派发或结果未确认的副本不计作保留，重启及部署切换不清除这项保护；同机未决删除也不能再次派发。管理员刷新目录会核对排除记录：原编号返回 `UNREGISTERED`，或返回 `FAILED` 且之后的新读取仍确认完整副本，可以解除排除。新的完整读取若明确显示目标机器上该确切版本已不存在，也可解除，不依赖旧编号是否可查；机器被移出清单、读取失败或 `UNKNOWN` 都不算不存在。

缺编号的记录还有一个严格的宽限期出口：门户发起时间之后至少 **25 小时**（[旧节点 worker](../deploy/node-executor.py) 的 `RuntimeMaxSec=86400s` 加 1 小时余量），再开始的新完整读取仍报告 `READY`，且登记名、版本和读取中可比较的 owners、字节数、文件数与派发前一致，才可解除。计时只用门户时钟；期限前开始的读取、登记身份缺失或变化都不能解除。worker 可能先清理旧 trash 再移动当前副本，因此几分钟后仍为 READY 不能证明删除没有执行。测试解析实际 worker 的硬上限，并要求门户常量至少覆盖上限加 3600 秒；有原编号的记录不按时间解除。未决提示为「这台服务器上的删除结果待确认」，原因与宽限期放进 ⓘ。

租约、固定保留等旧节点拒绝发生在异步 worker 中，首次响应已给出原 `operationId`，之后以该编号的 `FAILED` 和新读取中的 READY 确认副本保留。同步响应丢失或 bridge 错误不能证明未受理，不能凭 HTTP 状态或错误文字删除排除记录。解除排除只恢复副本的保留计数，不把未知的删除回执改成成功；放弃网页本地记录不会直接清除服务端保护，也不会自动重发删除。

`evict` 只清理指定版本的本地 READY/staging 副本，保留登记以便重新准备，仅限管理员。`unregister` 在清理可重建的目标副本后移出登记，支持单版本或整个数据集；**两者都不删除、不改写批准的原始来源，也不停止训练**。整个数据集仅管理员可注销；具备个人来源证明的本人版本可由成员注销，须指定完整版本并等待节点安全删除能力就绪。任何身份都不能直接清除最后一份完整数据。机器仍须明确选择，名称必须是目录中的数据集 ID，不能传宿主机路径、来源路径或 `force`。

```sh
gpuctl use gpu-1
gpuctl data unregister NAME@FULL_VERSION_HASH
gpuctl data unregister NAME
gpuctl data status OPERATION_ID
```

上面两条注销命令是两种范围的示例，应按需选择一条：带完整版本只注销该版本；裸名称注销该机该数据集的全部登记版本与残留副本，不影响其他机器、其他数据集或其他版本的数据授权。提交返回 `UNREGISTERING` 和 64 位 `operationId`，表示**已受理、尚未完成**；不会在短请求内同步等待大副本删除。用返回的真实编号查询，只有后台收据 `UNREGISTERED` 才确认该次操作结束；`unregistered:false` 表示目标登记已不存在。收据是历史操作结果，之后重新登记应另查 `data list`。

`FAILED` 表示后台失败；`UNKNOWN` 或网络超时表示结果未确认，不代表 worker 已停止。客户端不会自动重投或取消。保留操作编号，先查询原操作；若提交响应丢失，管理员应先核对节点执行器工作区的 `dataset-ops/` 操作记录及缓存 `.trash/unregister-*/REMOVAL.json`，不能因超时就声称已删除或盲目重复操作。查明失败原因后才能重试；新的显式注销请求会产生新的操作编号。成员仅可查询本人发起的个人版本注销收据，不能查询他人的后台操作。

任一目标版本存在作业/传输租约、固定保留 pin、租约损坏或准备/发布持有版本锁时，注销失败关闭，不释放租约、不杀训练。整集操作先检查全部目标，再开始移动；清理阶段继续持有逐版本锁，完成前再次核对登记，避免覆盖并发新增版本或所有者修改。可信外部 rsync 不由本接口停止：管理员必须先确认所有外部写入者已退出并关闭文件。新的持久 TLS 传输具有源租约，但旧快照读取与 LAN/NFS 外部读取不能据此推断已受保护；仍须先确认这些来源读取结束，不能只看本机训练租约便认定可清理。

清理失败时保留登记与恢复日志，可能已有本地副本被安全隔离；不能把“登记仍在”当成 READY。成功后，恢复包位于缓存根下 `.trash/unregister-<编号>/`，包含 `REMOVAL.json` 和 `registration/`。整集保留完整登记目录；单版本保留其原始版本 JSON 及 `dataset.json` 所有者快照。恢复包不是原数据备份，已清理的副本须从原始来源重新准备。不要自动覆盖后来新增的登记/授权；恢复前先比对恢复包与当前目录。

配套新版门户和节点后，管理员也可用同一裸名称命令注销**已确认没有版本的个人空登记**。节点核对唯一所有者与个人命名空间、登记身份，以及载荷、租约、来源证明、删除围栏和上传意图均不再使用它；任何版本、未知依赖或本登记的未完成上传都拒绝。其他数据集的容量预留仅在服务私有会话、所有者、原上传编号、预留文件哈希与完整字节／inode 预算全部吻合时排除；未知、孤儿、临时写入及不安全文件仍阻止注销。每个最终移动检查点重新核验，不要求无关上传停止，也不删除其预留或历史。残留的完全默认存储记录不会清除，原字节和身份写入私有删除审计；有保留卡位或恢复来源的记录仍不能按空登记处理。此例外不允许删除最后一份实际数据，旧节点仍拒绝。

不经过门户时，管理员也可在节点使用下面的 root-only CLI；它同步等待结束，大规模清理可能很久，不应套用执行桥的短超时。配置仍须 root-owned、0600，操作按配置降至缓存服务账号执行。

```sh
sudo python3 deploy/dataset-cache.py --config /etc/gpuq/datasets.json <<'JSON'
{"op":"unregister","dataset":"tiny","version":"替换为完整64位小写版本"}
JSON
```

整集注销省略 `version` 或显式设为 `null`。该入口只处理所选缓存根，不能代替清理其他机器、修改来源配置或删除原始数据。

节点仍有未释放的 `PURGED` 删除围栏时，整集注销会拒绝，保留 `dataset.json` 中的所有者，避免恢复原完整来源后无法释放这个名称。先按原删除任务恢复来源并释放该节点名称，或明确重新登记为新代次，再注销整个数据集；不能手动删除所有者元数据或墓碑。

## 已有可信清单与跨节点来源

跨节点复用时，由管理员从已登记源导出 `export_manifest` 的 `result.manifest`，通过可信管理通路在目标节点调用 `register_manifest`，明确该节点上的 `owners`。导入只接受结构化文件清单，不接受来源 hostpath；目标重算内容版本，必须与来源的完整版本一致。

目标节点已有管理员批准的只读来源时，用 `attach_source` 绑定它，不重新扫描整棵网络源：

```sh
sudo python3 deploy/dataset-cache.py --config /etc/gpuq/datasets.json <<'JSON'
{"op":"attach_source","dataset":"tiny","version":"替换为完整64位版本","sourceId":"tiny-lan"}
JSON
```

`tiny-lan` 必须预先存在于可信 `sources` 映射。普通用户不能调用绑定接口，配置外的来源编号会被拒绝。`attach_source` 并不证明网络内容正确；准备只读取清单指定的文件，对续传前缀与单文件变化做检查，最终在本地全树 SHA256 验证通过才发布。它不在网络源上反复做 TB 级全量哈希。

当前复制库也提供 `plan`、1 MiB 有界 `put_chunk`、已发布版本的 `read_chunk` 和 `publish`。断点计划包含已写偏移与前缀 SHA256；重试不能覆盖不同内容。管理员限定的 `prepare_transfer` 可返回 staging 目标供可信传输器使用，但它**不会自行启动 rsync，也不是给普通用户的任意目标传输服务**。任何外部写入者必须退出并关闭文件后，才能调用 `publish`。

## LAN / NFS 只做来源，不做训练盘

采用千兆硬件时，优先让已批准节点通过内网读取只读来源，按需准备本地副本。训练阶段不持续从远端读数据，也不会把普通用户电脑上传的大数据绕经 VPS 当作高速分发。

`deploy/dataset-nfs.py` 的管理模型是：源节点只发布固定的 `/data2/datasets/ready`，目标节点只读挂到 `/data2/library`。这是一个固定源节点的来源挂载，不是多源发现、任意 NFS 导出或自动选择共享服务器。相应来源路径为 `/data2/library/NAME/VERSION/data`，没有额外节点名层级。

在源节点预览、核实后显式应用；`PEER_RFC1918_IP` 是获准复制节点的真实私网 IPv4，可重复 `--peer` 列出多个节点，不能原样使用占位符：

```sh
sudo python3 deploy/dataset-nfs.py server --peer PEER_RFC1918_IP --service-user CACHE_SERVICE_USER
sudo python3 deploy/dataset-nfs.py server --peer PEER_RFC1918_IP --service-user CACHE_SERVICE_USER --apply
```

在复制节点预览、核实后应用，`SOURCE_RFC1918_IP` 为该固定源节点的真实私网 IPv4：

```sh
sudo python3 deploy/dataset-nfs.py client --server SOURCE_RFC1918_IP
sudo python3 deploy/dataset-nfs.py client --server SOURCE_RFC1918_IP --apply
```

按实际父目录所有者核实后，必要时才添加 `--trusted-parent-uid UID`。工具使用专用 `/etc/exports.d/gpuq-datasets.exports` 和 `/etc/systemd/system/data2-library.mount`；拒绝接管其他有效导出、竞争的 NFSv4 根、不同内容的同名配置或被覆盖的非空客户端目录。服务器来源为只读、`root_squash`；客户端固定 NFSv4.2/TCP、只读并设置 `nosuid,nodev,noexec`，不修改服务器全局协议选项。

这些命令需要实际节点具备 NFS 依赖与经管理员批准的内网访问条件；预览和本地测试不能证明线上 NFS 已安装、已导出或已挂载。普通用户的 `data prepare` 不能安装 NFS、修改导出、建立挂载或开放端口。

服务器与客户端缓存服务的 UID/GID 必须一致。`root_squash` 下客户端 root 访问私有目录被拒绝并不意味着源故障，应以缓存服务身份验收。不要为方便访问而把整个缓存目录放宽为公共可写。NFS 主机级来源信任不替代平台逐用户数据授权；限定私网 peer，禁止面向公网开放。

来源挂载使用 `hard`：源服务器失联时，正在复制的内核读取可能等待恢复，网页或后台任务超时不等于读取会立即终止。已经准备好的训练只读本机副本，不依赖来源持续在线。此 NFS 路径没有覆盖整次复制的来源租约，不受新的 TLS 传输租约自动保护；管理员不得在其他节点正在复制时清理发布源版本。若源缺失或变化，接收端会拒绝发布 `READY`，但本次准备仍可能失败。

当前工具没有自动卸载或整体回滚子命令。需要停用来源时，先禁止新的相关准备并确认正在读取该源的后台任务已经结束；再人工停止/禁用**该专用** `data2-library.mount`，核对挂载已卸载后才移除对应的受管 unit 文件。忙挂载不应强制或懒卸载。服务器侧逐一撤销确切的 `peer:/data2/datasets/ready` 导出，例如管理员核实后使用 `exportfs -u PEER_RFC1918_IP:/data2/datasets/ready`，再处理专用配置；不要运行全局 `exportfs -ua` 或用 `exportfs -ra` 代替定向回滚。

回滚来源配置不删除 `/data2/library` 下的源数据、不删除 `ready` 内容或租约，也不停止已经只读使用本地副本的训练。不要在仍挂载 NFS 时对挂载目录递归清理；旧 GPUQ/Slurm 调度切换是另一项需排空节点的维护，不属于 NFS 回滚。

## 安全、容量与恢复

- 缓存根、注册清单和租约由缓存服务私有持有；普通请求只引用名称、版本、已登记的相对文件名，不能指定 hostpath、来源主机、Unix 身份或外部命令。
- 清单完整校验、只读数据与同文件系统的原子无覆盖发布共同构成 `READY`。staging 中残留的 `READY.json` 不是已发布版本。
- 默认保留 10 GiB 空间，并计算未完成传输的保守空间预留；空间不足时拒绝继续，不覆盖已有字节或把半份数据发布。
- 作业在使用数据前取得持久租约。租约不因重启或时间流逝自动失效；只在可信执行层确认作业及其子进程都结束后释放。`UNKNOWN` 不等于可以清理。
- `evict` 仅限管理员，没有任何租约或 pin 时才可清理本地版本；保留注册清单以便以后重新准备。它不是原始数据删除器。分层 GC 另须经过权威恢复验证且默认关闭，没有后台按年龄自动清缓存。
- 数据损坏、坏元数据、失联、挂载不明、校验错误或锁忙都失败关闭。不要删除 lease、补写 READY 或把只读源改成可写来“修好”状态。
- 缓存目录的只读 mode 不是对服务账号/root 的不可变存储保证；真正对训练进程的只读边界由执行器的只读挂载实施。共享管理账号、root 和来源维护者仍属于高信任主体。

管理员可用独立 CLI 的 `verify` 做完整本地校验，用 `status` 做不扫描数据内容的状态查询。`release_lease` 是可信调度维护接口，不是普通用户的“解锁”按钮。中断传输通常保留 staging 可续传；若围栏损坏，保留现场并核查，再决定是否管理员清理该未就绪副本。

## 不同阶段，不要混为一谈

| 组件 | 负责什么 | 不代表什么 |
|---|---|---|
| 数据集缓存与门户/CLI 接口 | 固定版本、授权、准备、校验、本地只读挂载、租约 | 自动同步代码/项目/环境，或自动迁移旧 TB 数据 |
| 项目工作区与发布接口 | 同机独立草稿、私人 venv、固定代码/环境版本、每任务输出 | 完整基础镜像、自动跨机发布、checkpoint 自动备份 |
| 管理员配置的只读 LAN/NFS 来源 | 让节点从内网复制已批准版本 | NFS 直接承担训练 I/O，或普通用户获得 NFS/宿主机管理权限 |
| 当前 GPUQ 执行链 | 用户选服务器、该节点排队与整卡分配、沙箱训练 | 自动换服务器，或已经切换为 Slurm |
| `deploy/slurm_backend.py` 与 Pyxis/Enroot 方案 | 已有测试覆盖的适配基础与后续迁移设计 | Slurm/Pyxis/Enroot 已上线、旧高级功能全部兼容或两套调度同时抢卡 |

Slurm 源码适配尚未接入生产执行器。后续仍需逐节点排空、身份与 UID/GID 映射、调度/环境验收和可回滚切换；不能因为源码或数据缓存已就绪就宣称迁移完成。

## 本地验收与节点上线门槛

```sh
python3 tests/dataset-cache.test.py
python3 tests/prepare-data-root.test.py
```

本地测试不连接真实设备。节点上线仍必须用小样本验证：授权与未授权两种身份、断点续传、错误哈希不发布、可用空间不足、`/data2` 挂载缺失、进程内只读挂载、运行中租约禁止清理，以及取消/完成后确认子进程已退出再释放租约。跨节点另验只读来源、服务 UID/GID、来源断开时失败关闭；既有本地 `READY` 副本应不依赖原网络源持续在线。


## 删除个人数据版本与完整保留

成员只能删除具有新版版本来源证明的本人上传、本人工作区发布或本人副本。单一 owner、个人名称、旧记录或归档 `RETIRED` 不能替代证明；多人共享、管理员登记、旧数据和未知来源只能由管理员删除。节点和门户分别核对登录身份，客户端不能指定 owner、角色、路径或删除期限。

`gpuctl data unregister NAME@FULL_VERSION_HASH --machine SERVER` 删除这台服务器上的一个登记版本。成员必须指定完整版本；裸 `NAME` 仍仅管理员可用。原件 authority pin、训练/传输租约、其他 pin 或未确认的写入会阻止删除。新版节点只清除可从实际完整来源重新准备的缓存；若将删掉最后一份完整数据，会拒绝并提示“这是最后一份数据，请用彻底删除（7 天内可恢复）”。管理员不能绕过新版节点的保护。

节点更新前，管理员按机器删除先用 PR-M2 门户守卫证明另有完整副本；未知、离线或已派发/结果未知的副本不算保留，无法证明时409 `LAST_COPY_UNPROVEN`。实时读取与原请求派发在同一跨机器版本锁内；排除跨重启持久化，解除排除完全复用[共享守卫规则](#管理员清缓存与注销登记)，不另加超时或回执策略。节点更新后启用节点最后副本保护、成员删除和彻底删除。成员删除、彻底删除和隔离恢复在能力未确认时409零写。能力查询失败不是数据或依赖不存在的证据。
```sh
gpuctl data delete NAME@FULL_VERSION_HASH --key UUID
gpuctl data delete-status UUID
gpuctl data retire-status OPERATION_ID
gpuctl data retire-restore OPERATION_ID --machine SERVER
gpuctl data retire-continue OPERATION_ID
gpuctl data retire-cancel OPERATION_ID
gpuctl data retire-discard-registration OPERATION_ID --machine SERVER --key UUID [--name PHYSICAL_NAME]
```

彻底删除覆盖可信清单中全部服务器及数据库原件，门户先保存 key、任务和每个物理版本的子编号。查询可以用提交前打印的 key，首次回包丢失也不需要另建任务。相同 key、身份和版本返回原任务；换目标或账号拒绝。所有节点必须确认 `datasetDelete:1`，离线、旧节点、未知物理别名、在途归档/传输或任何依赖未确认都会停止。新门户先上线且节点未更新时，能力为 0，拒绝彻底删除；前端不得显示可用的彻底删除操作。

完整数据保留至少 7 天（节点可信配置 `datasets.retireRetentionDays`，7–365，默认 7）。每台完整副本都移入同一文件系统的私有隔离区，登记、tier、来源和事务一起保留，逐次 no-replace rename 并 fsync。它不会立即释放磁盘或退回上传配额。只有原有本机 storage 收集入口已明确开启，全部步骤隔离已提交、日志/身份/文件/期限均确认，并且内核 NTP 已同步（STA_UNSYNC 未置位）后才会清理；墙钟跳到期限后不能单独触发清除，未完成的整体任务不清除。本 PR 不开启 timer。节点部分另约发布窗口。

状态为 `PLANNED`、`RUNNING`、`REMOVING_CACHES`、`RETIRING_ORIGINAL`、`DELETED`，或 `BLOCKED`、`FAILED`、`UNKNOWN`、`WAITING_CONTINUE`、`CANCELING`、`CANCELED`。`DELETED` 表示当前逻辑版本及固定授权依赖已经隔离，其他名称下的副本不受影响（transfers 产生的独立副本）。`DELETED` 要求逐个核对节点当前代次的完整隔离回执，不表示物理字节已立即抹除；期限后实际清理已确认时，步骤显示 `PURGED`。历史隔离回执不能掩盖后来恢复、节点离线或回执改变。RUNNING 没有30秒完成截止；已确认上一阶段完成可继续派发尚未派发的下一阶段，这不是重投。不会自动重投未知或失败阶段。管理员显式 `retire-continue` 先查原编号；仅在原 worker 明确 STOPPED 且原阶段 FAILED 或没有结果时，才审计并重派同一个固定阶段，每次 attempt 去重并按 journal 续做。继续始终沿用原发起人的授权；原成员403拒绝不能升级为管理员删除。门户重启后等待管理员继续，不伪装成无人推进的 RUNNING。`retire-cancel` 只回滚：未移动的直接解除围栏，部分移动还原已移动项，完整隔离恢复；不调用 isolate，不新撤销授权，失败可按相同条件重试。已撤销 grant 保持撤销。取消不杀进程或训练，未知终止状态拒绝恢复。节点写入之前的权限拒绝原子释放门户围栏。原件栅栏先于其他节点写入，阻止新授权、恢复、租约、发布和重建；原件直到全部固定依赖已确认隔离后才撤销 grant 并隔离；目标节点自己枚举 grant 的全部物理别名，每个都必须 ISOLATED，门户遗漏一个也会拒绝撤销。门户与节点最低保留截止允许5分钟时差，超出时为待确认，保留管理员继续或取消出口。无数据库原件时，也保留至少最后一份完整副本。

只有管理员可用上面的 `retire-restore` 命令恢复已确认的完整隔离副本。恢复先核对全部哈希、期限、原事务及无占名/租约；新登记使用新代次，旧 grant/token 永久不可复活。恢复原完整来源时，会一起恢复同一任务全部步骤：真实完整副本还原，被驱逐的登记和空命名空间释放栅栏；已 PURGED 的副本只凭精确源恢复回执释放名称，不声称字节还在。已到期但尚未清除的副本也仅凭此源证明还原。成功阶段只查询，失败阶段只有管理员确认停止后才能显式重试；明确拒绝（包括到期）为 FAILED 并显示原因。已经 RESTORING 的事务允许跨过原截止时间完成。管理员取消已由节点证明从未提交收集许可的部分任务时，也可恢复期限之后仍实际保留的完整数据；损坏或回执不明的提交不能作为这个证明。未确认/中断事务先由管理员核对固定节点编号和真实 worker 终止状态，不能根据目录缺失、已读或时间猜成功。

存在同一服务器上的多个实际完整别名时，门户恢复命令拒绝猜选。管理员先核对任务步骤及节点私有日志，再按固定节点事务恢复；查询确认已恢复后，仅解除该物理版本属于本任务的门户栅栏，不自动释放其他空命名空间或重放后续步骤。中断隔离保留原身份、快照、动作和日志；管理员显式继续或取消时先核对真实 worker 终止。退役 worker 不再设置24小时 RuntimeMaxSec，普通缓存 worker 的原限时保持。

外部 `storage.archive.retire` 的意图退役保持其原有严格模式；`authority-target-v1` / `authority-source-v1` 则是有完整替代来源的旧原件退役，保持所有外部锁、永久墓碑及 API 条件。只有它的实际 `REVOKED` 私有日志、严格包含校验和仍有效的完整 protected 替代源，才能在持锁重新核对后作为普通注销的可重建来源。删除任务单独记录“归档意图退役（外部原语，模式 same-HDD / queued-ingest-v1）”或“外部替代退役”；这两个结果都不等于版本 `DELETED`。模式标签只读取外部意图已有的固定元数据；旧记录缺少这些字段时显示“模式待确认”，不补造证明，也不代替本任务的栅栏和完整隔离。

### 清除后重新上传或登记

后台 prepare、旧复制和归档不会自动重建已删除代次。实际确认 PURGED 后，有权用户可以显式重新上传同名同字节，或从自己的工作区再次发布；管理员也可在本机用受信配置重新登记来源/清单。节点核对原清除日志、所有者和当前目录为空，先持久化新登记 inode 与来源意图，再 no-replace 安装；重试只完成这一新意图，不采用别人的登记。旧 grant、token、复制和归档授权仍永久失效。

`RUNNING` 仅表示门户正在推进原删除任务。门户停止推进后，即使节点已确认隔离或原 worker 仍在运行，也显示 `WAITING_CONTINUE`；worker 仍在运行时先等待，确认停止后管理员才能明确继续原步骤或取消。只查询状态不会派发任务，也不需要重启门户才能得到继续入口。

准备阶段已选出原件，不表示全部依赖位置和空副本计划已确认。若此时检查中断，管理员应先解决原拒绝原因，再用原 `retire-continue OPERATION_ID` 完成检查；它沿用原 key 和每个已保存的节点子编号，不创建新的删除任务。查询状态不会补做检查。已授权或已派发阶段的旧任务保留原快照，不因缺少新增检查标记而重新准备或重放写入。

继续请求在原 worker 已停止并通过当前授权核验后，先保存 `RUNNING`、清除上一轮错误，再启动后台检查。此时不要把旧 `UNKNOWN` 当成本轮结果或退出登录；保持当前登录，按原编号查询到新的完成或停止结果。登录失效仍会停止推进，不绕过认证；查询超时不自动重发继续请求。

门户凭精确新登记证明释放这个位置的旧围栏。要重新使用同一任务的其他位置，先让新的原源达到 READY，再由管理员用原 `retire-restore OPERATION_ID --machine SOURCE` 核对这个新源；它会还原仍保留的副本、凭源证明释放已清除或空的命名空间。然后可以重新准备、复制或创建新的删除任务；旧删除编号不可继续执行。新源不完整、证据改变、占名或权限改变均拒绝，不会复活旧授权。

登记意图按删除 operationId 分代保存，旧代次不能阻止下一次删除、清除和显式登记。若容量等错误使新登记的准备 inode 从未安装，管理员可用 `retire-discard-registration` 撤回这份意图；必须指定原删除任务、服务器和固定 UUID key，物理别名使用 `--name`。门户和节点均先保存固定请求与审计，只有当前 PURGED 代次、无登记、READY、STAGING、来源记录、租约及固定保留时，才把这一份未安装元数据移入审计区。它不删除数据载荷，不移除删除墓碑，也不采用其他人的登记。成功为 `DISCARDED`；回执丢失先核对原任务，必要时只重试相同命令和 key。已经安装、意图改变或权限不明均拒绝。

取消以实际 journal 为准：ISOLATED 已落盘而节点投影中断时只补投影并恢复，不再次隔离；个人来源记录随第一次回滚一起还原。终态删除的门户墓碑不挡整数据集的普通注销，精确版本的后台重建仍受节点墓碑保护。原 worker 仍在进行时，继续和恢复保持等待且不派发；取消等待保持 CANCELING。完整副本确未提交收集许可时，源恢复也可还原过期但仍保留的字节，未知或损坏的提交不算未提交。

普通注销后留下的旧缓存授权不是可忽略的别名。仅当完整 `REMOVAL` 已确认注销、归档登记的 inode 与不可变清单及所有者仍匹配、固定 authority 适配器确认同一 grant，且没有载荷、租约、来源或固定保留时，节点才允许把它作为“已无数据的授权别名”纳入原删除任务。该步骤只保存证明并建立持久版本围栏，不删除注销审计或 tier，不复原旧缓存。全部物理别名仍须逐一确认隔离，原件才能撤销授权；未知或改变的旧元数据继续阻止删除。后续准备、发布、租约及恢复不能越过围栏；取消或恢复原源也不复活旧 grant，只有明确的新登记代次可重新使用名称。

门户先完整核对该节点返回的物理位置，按每个实际名称汇总固定 grant 引用。已无登记的别名计划携带既定完整来源的私有授权及仅属于该名称的全部引用；仍有登记的计划只由节点读取本地证明，不使用外供所有者。同一 grant 的多个别名分别核对，同一节点的不同 grant 不混用。检查或回包中断仍沿用原任务及子编号，查询不会补做计划；已有计划的固定引用改变时停止，不用空引用绕过旧授权。


### 网页：彻底删除对话框与原编号恢复

数据集详情的入口由房间控制器提供。主界面调用 `datasetRemoveUI(store, section, toast, {reload, catalog: () => currentCatalog, management: false})`，返回 `canOpenFullDelete(dataset, version)` 和 `openFullDelete(dataset, version)`，只挂载独立对话框，不改变数据集布局，也不读取管理目录或显示管理员操作。catalog getter 必须返回当前账号的最新目录，切换账号或尚未读取时返回 null；所有服务器名称来自目录和任务步骤。只有 `datasetDelete === 1` 且这个版本至少一个 location 的 `deletionPermissions.memberAllowed === true` 才显示主界面入口，管理员在主界面也遵循此条件。旧节点缺字段或 false 时不显示入口，不从用户名或所属用户文字推断权限。

后台数据与存储区调用同一工厂，传 `{reload, catalog: () => adminCatalog, readCatalog: () => freshAdminAllNodeListings, management: true}`。`readCatalog` 必须重新读取全部服务器，供按机器删除核对真实登记名和其他完整副本；缓存的 catalog getter 不能替代此读取。后台管理员在能力为 1 时不受 `memberAllowed` 限制，继续、取消和恢复也只出现在后台。省略 management 时暂保留旧数据集页的管理入口，迁移完成的调用方应显式传入该参数。

输入准确的数据集名称后，网页先在当前账号的本地记录里保存固定 UUID key 和原 dataset/version，再发送 `datasets.delete`。无法保存时不派发。重复打开同一目标使用原记录；丢回执先 `datasets.delete.status {key}`，不换 key、不自动再次删除，包括 404。刷新后本地终态也先显示待确认，只有匹配原 key、任务编号和目标的服务器回执恢复当前事实。主界面和后台共用按账号的记录，保存一条任务时保留其他任务的 key。`fullDelete.records` 是本地恢复引用，`fullDelete.openFullDeleteRecord(key)` 可供任务记录入口调用；它只读取当前账号的记录，不授予跨账号访问权。

有 operationId 时直接显示短请求编号，可复制完整编号；没有编号时不渲染此行。步骤角色只依据目录事实：`ARCHIVED + originalRetained + archiveMachine` 证明的服务器显示「隔离原件（可恢复）」，已知普通缓存显示「移除缓存」。角色未知但步骤 complete 为真时显示「隔离完整副本（可恢复）」，其余显示「检查并移除」，不把 complete 推断成原件。成员删除完成后显示联系管理员恢复和真实保留期限；只有 BLOCKED、UNKNOWN、WAITING_CONTINUE 才提示需要管理员处理。

任务显示当前步骤、原服务器 ID 和服务器原因，不画百分比。UNKNOWN 只提供重新查询；DELETED 显示服务器的 retainUntil，并注明「其他名称下的副本不受影响」，不声称磁盘空间已释放。403 和能力未开通的 409 保留后台原文。成员看到需继续、取消或恢复的任务时显示「需要管理员处理」，不渲染管理按钮。管理员继续沿用原 operationId；取消先确认停止后续删除并还原数据、不强制中断已执行步骤；恢复由管理员选择任务中已确认完整的保留副本，回执可能使用真实物理别名且不带 key，网页核对绑定后再查询原任务。所有未知写结果都不自动重放。

上传首次初始化回执丢失时保留服务器签发的原 UUID。重复原上传命令先查询该编号；只有固定仓库按本人账号、原准入和完整清单返回 `NOT_INITIALIZED` 的只读证明，且当前策略未变，才使用同一编号恢复初始化。普通 400/404、503、ENOENT、损坏或缺失控制记录都不是该证明，不能授权换编号或自动重发。


## Single-archive campus intake (protocol 1)

A node declares `archive:{protocol:1,formats:["zip","tar","tar.gz"],maxBytes}` on its authenticated upload-routes response only after the complete archive-intake runtime is installed and the trusted fixed-HDD configuration explicitly enables `datasets.archiveUpload.enabled`. Portal projects this declaration as `datasetUploadAdmission.archive`; absent or malformed capability preserves the directory uploader. `.tgz` is an alias of declared `tar.gz`. Existing directory UUIDs retain their original specification when the new capability is enabled; fresh directory admissions are refused.

`datasets.upload.admission.create` binds the original key and node upload UUID to the single archive specification `{protocol:1,fileName,format,bytes,sha256}`, alongside the transport-manifest hash/length, one entry and compressed byte count. Only the declared campus-direct route can issue this archive's ticket or accept its raw bytes. Client disconnects query the original UUID and confirmed offset; neither relay nor a new key is selected automatically.

The intake reports `phase:UPLOADING|EXTRACTING|VERIFYING|READY|FAILED`, with `reasonCode` on failure and the ordinary immutable dataset/version fields only after registration. The compressed file is never itself a registered dataset. The worker verifies the compressed hash, performs a bounded inspection, checks available warehouse bytes/inodes and retained-principal quotas, safely extracts into its own new scratch tree, hashes every extracted file, then uses the existing fenced registration and atomic publication path. Only confirmed READY means the unpacked version is available.

Absolute/traversal paths, all symlinks/hardlinks, devices and special files, conflicting entries, encrypted or unsupported-compression ZIPs, and malformed archives are refused. Trusted limits `archiveUpload.maxExpandedBytes` (defaults to the upload byte limit) and `archiveUpload.maxEntries` (defaults to the dataset entry limit) cannot exceed those existing limits. Metadata and decompression buffers are bounded; ZIP supports stored and deflate entries. Errors include `ARCHIVE_FORMAT_UNSUPPORTED`, `ARCHIVE_UNSAFE_PATH`, `ARCHIVE_TOO_LARGE`, `ARCHIVE_CORRUPT`, `ARCHIVE_EMPTY`, `ARCHIVE_PUBLISH_FAILED`, and `CAMPUS_ROUTE_UNAVAILABLE`.

Deployment is a paired Portal/CLI and immutable node-runtime release. Preserve each live runtime's other patches; enable the capability only on a fixed HDD warehouse after a no-training/no-upload or approved maintenance window. Adding this code to GitHub alone does not declare a live capability.
