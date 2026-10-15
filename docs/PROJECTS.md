# 项目、环境与训练版本

项目属于平台账号、指定服务器和内部项目 ID；显示名、逻辑分组不改变这些身份。网页与 CLI 共用 HTTPS 账号权限，不因注册取得宿主 SSH、Tailscale 或 root。

## 默认工作区

```sh
gpuctl use SERVER
gpuctl project create experiment-a
gpuctl push .
gpuctl ssh
# 在个人容器里安装依赖
python -m pip install -r requirements.txt
```

在本机另一个终端直接提交，无需关闭开发终端或发布：

```sh
gpuctl run -g 1 -- python train.py --output /outputs
gpuctl logs JOB_ID
gpuctl pull --job JOB_ID model.pt ./model.pt
```

新项目使用节点已启用的个人 OCI 容器；能力或授权不足时明确拒绝，不自动改成 venv。为什么：静默换环境会改变依赖与隔离契约。

服务器重启后，首次初始化个人 OCI 时会清理上一轮启动遗留的 Podman `run`、`tmp` 运行态，再由 Podman 恢复原容器。镜像、容器可写层、代码、依赖和 HOME 保留；同次启动不清理运行态。排查与灰测见 [Podman 重启恢复](OCI_REBOOT.md)。

默认工作区的代码、镜像环境和 HOME 可变且跨任务共享；新任务 `/outputs` 独立，旧共享输出及历史任务路径保留。为什么：共享环境会影响并发程序，按任务输出避免互相覆盖，也不能借升级删掉旧结果。

| 路径 | 默认工作区任务 | 显式 `--release` 任务 |
| --- | --- | --- |
| `/workspace` | 当前项目代码，可写 | 指定发布快照，只读 |
| 镜像内 Python/Conda | 当前项目容器环境 | 指定发布镜像 |
| `/home/gpuq` | 项目共享 HOME | 本次任务独立 HOME |
| `/outputs` | 新任务独立结果 | 本次任务独立结果 |
| `/data2/NAME` | 显式固定数据引用的挂载 | 显式固定数据引用的挂载 |

`--output` 是示例程序的参数，平台不自动重定向程序写入。写到共享 `/workspace` 时自行区分目录。为什么：只有写入任务结果路径的文件才自然拥有该任务的输出边界。

## 依赖、离线材料与临时文件

容器内 root 可安装自己的包，不是宿主 root；开发终端不占 GPU。为什么：开发权限不能扩成宿主或未获分配的 GPU 权限。

个人模型、tokenizer、配置可放 `weights/`、`models/`、`tokenizers/`、`offline/`；训练样本使用数据入口。为什么：输入权重与数据集有不同版本和删除生命周期，不能用新 checkpoint 覆盖输入。

默认工作区可读取其共享 HOME；显式发布只固定代码、环境及代码树内材料，不自动收集开发 HOME、登录 token 或隐藏缓存。为什么：固定发布必须显式包含依赖，不能把秘密或可变缓存误当可复现输入。

```sh
mkdir -p "$HOME/.cache/build-tmp"
TMPDIR="$HOME/.cache/build-tmp" python -m pip install -r requirements.txt
```

环境、HOME、输出和容器可写层均占实际磁盘。历史 venv 沙箱的 `/tmp` 与受管 Ray spill 可用 tmpfs，OCI 的 `/tmp` 属容器可写层；临时空间按实际环境判断。为什么：磁盘临时文件和计入内存的 tmpfs 不能用同一容量假设。

旧 shared/isolated 仅用于已有项目兼容，不是新建选项；不自动转换模式或重建未知环境。venv 固定不等于封装宿主全部系统库，也不能将 Mac venv 当成 Linux 环境。为什么：依赖继承、基础系统和 CPU 架构仍影响运行，发布哈希不能证明跨平台等价。

## 上传、导入与手动代码同步

`push` 上传代码，不发布、不提交训练、不删除远端额外文件。文件用原 uploadId、路径、大小、SHA 与已确认偏移恢复；冲突或旧记录缺证明时停在原操作。为什么：换名、换 key 或猜偏移会覆盖未知内容或制造第二次操作。

`push-status`、`project uploads` 查原上传；`project upload-cancel UUID` 只取消可证明尚未提交的原临时上传，不删完整代码。为什么：取消上传不等于删除项目或撤回已完成替换。

代码扫描跳过常见秘密/环境目录并保留执行位，但不能识别所有敏感内容；上传者检查材料。为什么：排除列表不是秘密检测器，权限位也是可执行代码的一部分。

```sh
gpuctl sync git ./my-repo --ref HEAD --to TARGET --project new-project --dry-run
gpuctl sync code --from SOURCE --to TARGET --project my-project --release FULL_HASH --target-project new-project --dry-run
```

去掉 `--dry-run` 才传输。Git 只导出固定提交对象并校验内容，不要求工作区干净或 `check-attr --source`；节点来源固定 release。目标须新项目，重复原命令可续传；环境、HOME、结果不随代码迁移。为什么：固定来源可以复核，未提交改动及无关文件不能混入快照。

代码 `CODE_READY` 后在目标准备依赖，再直接 `run`。原同步查询/取消使用 `sync status|cancel UUID --to TARGET --project NAME`；取消仍须没有任务历史、输出和活动/未知读写者，永久封住原同步编号并保留字节。为什么：同步取消是旧草稿专用契约，不能套用普通项目退役的历史放行规则。

默认的 `run --sync` 只在指定机器先上传当前目录，再提交工作区；不自动发布、安装依赖或删除远端文件，当前不与 AUTO 混用。为什么：实际 CLI 没有旧“等待发布 READY 后提交”的步骤，不能据此承诺运行不可变版本。

服务器已有个人数据区代码可 `project import SOURCE NEW_DEST`，用 `import-status UUID` 确认 `IMPORTED`。仅同账号、同机器的受管相对路径，目标须不存在；启动前结束两端开发/数据终端。为什么：新目录原子提交和停止写入共同保护原文件，任意宿主路径不在授权范围。

导入不自动发布或提交任务；`import-cancel UUID` 只在停止及未提交可证时取消，源目录保留。为什么：原回执未知不能当成未执行，取消不能破坏来源。

## 显式固定发布与数据

需要固定代码和环境时，先结束项目开发终端，再发起本次发布并查询原 publication ID：

```sh
gpuctl project publish
gpuctl project status
gpuctl run -g 1 --release FULL_HASH --data NAME@DATA_HASH -- python train.py --data /data2/NAME --output /outputs
```

只认本次发布的 READY 和完整 release；旧 READY 不证明本次成功，断开终端不等于结束写入者。为什么：读到正在修改的目录或旧发布会破坏固定版本身份。

显式 release/data 继续使用原版本、摘要和提交 key；数据未就绪仍走原准备等待及租约收尾，仓库直读可用 `--data-read warehouse`。为什么：已有旧 SDK 和等待中请求仍依赖这份契约，删除旧自动项目复制不等于删除固定数据准备。

发布扫描、复制、校验、写入各阶段按真实 progress/errorDetails 展示；总量未知不编百分比。为什么：扫描未完成时无法给出可信总量，失败原因必须对应本次发布。

发布版本的权重随快照固定，开发 HOME 不自动进入固定训练；新 checkpoint 写任务 `/outputs`。为什么：输入、秘密和输出必须保持各自边界。

## AUTO 与手动跨机复制

```sh
gpuctl run --machine auto -g 2 --min-vram 24 -- python train.py --output /outputs
gpuctl run --on auto --candidates SERVER_A,SERVER_B -g 2 -- python train.py
```

AUTO 只在已有本人项目工作区、有权且兼容的候选中按额度、可用卡和队列排名；不自动创建工作区或复制项目。不足时保留选定节点正常排队，回执说明最终机器。为什么：资源快照不是预约，自动选机不能偷偷搬数据或改派已受理任务。

固定 GPU 索引/同卡共享使用明确机器；型号需求用候选范围。为什么：不同机器相同卡号不是同一 GPU，平台不推断程序的驱动或架构要求。

手动复制固定 OCI 代码与镜像仍保留：

```sh
gpuctl project copy NAME --from SOURCE --to TARGET --release FULL_HASH
gpuctl project copy-status COPY_ID
gpuctl project copy-cancel COPY_ID
gpuctl project copy-retry COPY_ID
```

两端授权、受信 TLS、固定版本和目标不冲突仍需满足；不迁移草稿、开发 HOME、运行容器或结果。`UNKNOWN` 不重建；retry 须确认原两端停止和清理。为什么：手动复制有独立回执与来源保护，不能用重试覆盖未知写入。

## 整理、归档与回收站

`project label/group/catalog` 管理显示名和逻辑组，revision 冲突后重读；不改内部 ID、不搬文件。为什么：其他机器实例、历史任务和成员脚本依赖原身份。

`project archive/unarchive` 暂停/恢复新使用，保留现有训练和文件。`retire-plan` 核活动/未知任务、终端、上传及其他消费者；已确认结束的历史本身不阻止退役。为什么：历史记录不是当前活动引用，二者不能混为一谈。

```sh
gpuctl project retire-plan
gpuctl project retire --key RETIREMENT_UUID --revision PLAN_REVISION --manifest-sha256 FULL_PLAN_SHA256
gpuctl project retire-status RETIREMENT_UUID --project NAME
gpuctl project trash list --projects --machine SERVER
gpuctl project trash restore --project NAME --machine SERVER --key RETIREMENT_UUID
gpuctl project trash purge --project NAME --machine SERVER --key RETIREMENT_UUID
```

退役按当前计划 CAS 后移入本人私有回收站，内部名保留墓碑；回执丢失查原 UUID。为什么：计划后内容改变或原子提交未知时，不能重投或新建替代项目。

普通项目/发布退役保留 7 天；owner 明确 purge 和已获批的低于 256GiB 回收是例外，仍检查活动引用，数据集唯一原件不在例外内。为什么：2026-10-12 用户明确要求“回收站也有完全清除”，主动彻底删除与普通恢复期必须分清。

`RESTORED`、`PURGING`、`PURGED` 按原回收编号查询；正在 purge 或已清除不能恢复，不绕正式入口手删目录/共享镜像。为什么：后台清理与恢复相斥，共享层和其他账号数据不属于当前项目。

## 资源、传输与结果

任务 GPU 仍由调度器按精确 UUID 分配；CPU、RAM、PID 及个人 byte/inode 配额按节点实际策略。未知用量不当零，“未启用硬配额”不代表磁盘无限。为什么：配额类型和资源快照不同，显示错误会误导提交与清理。

`--memory-limit-gib` 可显式申请任务内存，默认值与共享池限额以本次节点策略为准；已有 attempt 不因升级自动迁入新配置。为什么：父 cgroup 可能给出更严限额，不能用新版默认值推算既跑任务的实际预算。

单文件超过 4GiB、已知项目载荷超过 50GiB 时警告，实际磁盘底线、清单边界与完整校验仍在；大数据使用受管本机目录或固定数据集。为什么：取消旧字节门槛不等于取消容量、路径或内容保护。

结果位于执行机对应任务，按 `--job JOB_ID` 下载；旧共享输出及历史路径继续只读兼容。发布、下载不自动备份或清理结果；独立备份范围须实际验证。为什么：一次下载、同盘副本或小文件恢复不能证明所有 checkpoint 已有可恢复备份。

## 已有客户端与历史记录

旧无 project 的任务规格、固定 release/data、上传恢复与日志/取消沿原协议处理，不能给历史请求补字段改变幂等摘要。为什么：新 CLI 的工作区入口不等于旧 SDK 请求和已记录任务已经退役。

临时 `--legacy`、旧账号缓存及 `AMAX_URL/AMAX_SESSION_FILE` 按实际 CLI 支持使用；不把新项目流程说成旧任务迁移。管理员 `ssh --root` 是显式宿主运维入口。为什么：项目权限、历史协议和宿主权限是三个不同边界。
