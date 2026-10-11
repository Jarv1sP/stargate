# 从零部署 GPUQ Console

本文面向新的实验室。已有服务请先备份、比较差异，不把示例覆盖到正在使用的 Tail 策略、GPUQ 数据库或反向代理。**所有命令里的域名、IP、账号和路径都是示例。**

本文统一使用厂商无关的 `gpuq-console` 服务/目录前缀、`gpuops` 系统服务用户和 `/srv/gpu-workspaces` 工作区。已有安装不自动改名或搬迁，升级前先读[名称更新与兼容](MIGRATION.md)。

## 1. 准备条件

- 一台有公网域名的 Linux VPS；公网开放 TCP 80/443，管理 SSH 仅允许可信来源。建议至少 1 GiB 内存。
- VPS 安装 Docker Engine / Compose v2+、Git、Node.js 24、Python 3.10+、OpenSSH client、sqlite3。
- GPU 节点：Linux、Python 3.10+、systemd 用户服务/cgroup v2、NVIDIA 驱动、OpenSSH server、bubblewrap（`bwrap --help` 包含 `--bind-fd`）、slirp4netns、curl。
- GPU 节点允许用户命名空间。某些 Ubuntu/AppArmor 策略会限制它；使用发行版支持的规则授权相关程序，不全局关闭系统安全机制。
- 每台节点准备一个可信的非 root 服务用户（示例 `gpuops`）和只读基础 Python/Conda（示例 `/opt/conda`），其中 PyTorch/CUDA 与驱动兼容。不要给新平台普通用户发这个系统账号的密码。
- 给域名 `gpu.example.com` 设置指向 VPS 的 A/AAAA；不要保留指向错误主机的 AAAA。Caddy 负责自动申请/续签证书。

## 2. Tail 管理网络

### 已有 Tail / Headscale（推荐复用）

把 VPS 与 GPU 节点加入现有网络；保留其他设备和策略。VPS 用 `tag:portal`，GPU 节点用 `tag:server`。**合并** [policy.hujson](../deploy/policy.hujson) 中的必要规则，让 portal→server TCP22；管理者可单独用 `tag:owner`。实际所有者名称以自己的控制面为准。

本平台使用普通 OpenSSH，不需要 Tailscale SSH；如果节点已启用 Tailscale SSH，需在已有管理通道确认 OpenSSH 可用后关闭该功能，不能在唯一远程连接上冒险切换。只打管理隧道，不宣告 exit node、不修改默认路由或 DNS。

### 可选：自己新建 Headscale

仓库提供 Headscale 0.29.3 的独立示例，参考 [官方配置](https://github.com/juanfont/headscale/blob/v0.29.3/config-example.yaml) 与 [策略文档](https://headscale.net/development/ref/policy/)。在同一 VPS 使用时增加 `tail.example.com` DNS。先完成下面第 3 节生成配置；启动前用自己的身份修改 `tagOwners`。

```sh
docker compose --profile headscale up -d headscale caddy
docker compose exec headscale headscale users create owner
docker compose exec headscale headscale users list
```

客户端安装官方 Tailscale 后运行（VPS 示范）：

```sh
sudo tailscale up --login-server=https://tail.example.com --hostname=gpu-portal --accept-dns=false --advertise-tags=tag:portal
```

在管理端按客户端返回的登记提示批准，`--user` 使用上一步真实用户 ID/名称。0.29 系列示例：

```sh
docker compose exec headscale headscale auth register --auth-id 登记请求ID --user 用户ID
```

GPU 节点同理，改为自己的 hostname 与 `tag:server`。登记是一次性受控操作，不把长期可复用授权密钥写 README 或 shell 历史。手机等个人设备不是部署必需。

若策略引用用户尚不存在导致服务拒绝启动，首次启动先把策略保存为 `{"acls":[]}`（默认拒绝），创建 owner 后再恢复此仓库策略并重启 Headscale；不要临时 `*:*` 全放通。已有网络绝不执行这种初始化。

已有独立 Headscale 时不启用该 Compose profile，可删除 Caddyfile 第二个域名块；它不影响已有控制面。

## 3. 配置 VPS 源码

以 VPS 管理员操作：

```sh
sudo git clone https://github.com/Jarv1sP/stargate.git /opt/gpuq-console
cd /opt/gpuq-console
sudo cp config/inventory.example.json inventory.json
sudoedit inventory.json
sudo node scripts/configure.mjs inventory.json
sudo python3 scripts/build-gpuq.py
sudo python3 deploy/init-vps.py
```

填入 `publicOrigin`、`headscaleOrigin`、真实 `vpsTailIP`，以及每台 GPU 节点的稳定 ID、Tail IP、SSH 服务用户、卡数/型号/显存、工作区/GPUQ/Python 目录。不要用中文作系统服务用户；门户用户名可以是中文。`memory` 用例如 `24 GB`。

`configure` 生成机器容量表和私有 `.env`/Headscale 配置；`init-vps` 建目录、初始管理员密码、两把独立 Ed25519 密钥、systemd 单元，但不启动服务、不修改 ACL、不进入节点。

生产门户的 `/machines.js` 只向有效登录会话返回容量表，缓存为 `private, no-store`；未登录的 GET/HEAD 返回空正文 401。登录、注册和使用指南不需要这份清单；登录前的维护提示只显示全平台原因原文。生成和镜像构建流程不变。

`init-vps` 会把安装根目录规范为 `root:root / 0755`，私有清单与管理密钥保持 `root:root / 0600`，数据目录保持应用的 UID/GID 1000；不递归修改已有数据库、邀请码密钥或工作区。若通过压缩包交付，不要直接将带有本机 UID/目录权限的归档解压覆盖生产根目录：用 GNU tar 的 `--no-same-owner --no-overwrite-dir` 解压到独立暂存目录，核对后只安装允许更新的软件文件，排除数据、清单、密钥及根目录元数据。更新后重新检查目标目录的属主和可遍历权限，不能靠扩大服务 capability 绕过权限错误。

私钥在 `collector/id_ed25519`、`executor/id_ed25519`，**永远留在 VPS**。只复制 `.pub` 到对应 GPU 节点。

## 4. 准备 GPU 节点

安装系统依赖，确认驱动和现有实验正常；以 `gpuops` 登录，准备源码（相同版本）、自己的 `inventory.json` 以及 VPS 两个公钥。各节点只需这个清单中的自身条目和 VPS Tail IP，也可使用完整私有清单。不要复制 VPS 私钥或数据库。

首次建目录的例子，须与自己的 inventory 一致：

```sh
sudo install -d -o gpuops -g gpuops -m 700 /srv/gpuq /srv/gpu-workspaces
sudo loginctl enable-linger gpuops
python3 scripts/build-gpuq.py
python3 deploy/install-node.py --inventory inventory.json --node gpu-1 --collector-key collector.pub --executor-key executor.pub --initialize-gpuq
```

安装器在服务用户下运行，不能 `sudo python3 install-node.py`。用户 systemd 要可用：`systemctl --user status`；若第一次启用 linger 后仍无用户总线，重新登录该服务用户。

安装前会运行短暂的非 GPU 任务，读回真实 CPU / 内存 / PID 限额。若 CPU 未委派，可经管理员确认给安装命令添加 `--configure-cpu-delegation`：只为当前服务 UID 写独立、带备份的 systemd drop-in，保留原委派项并添加 CPU，不添加控制台 sudo 权限。活跃用户管理器不会被自动重启或 reexec；探针仍失败时停止替换节点程序，按 [CPU 委派与 Ray 资源说明](RAY_RESOURCES.md#安装前的-cpu-委派检查) 在维护窗口确认后完成原位刷新，再重跑安装。

- **已有 GPUQ**：不传 `--initialize-gpuq`，`gpuqRoot` 指向现有 config 所在目录，保留已有 `~/bin/gpu`。安装器不会迁移数据库、升级或重启原 GPUQ。
- **新 GPUQ**：显式初始化后以观察模式启动，保守检查 `nvidia-smi`、`~/bin/gpu health`、`~/bin/gpu status`；确认 GPU UUID 和现有占用后执行 `~/bin/gpu set-mode --active`。它不会为了接入而杀已有实验。
- **可选最高权限**：同一安装命令增加 `--enable-host-root` 才安装固定 root 入口与 sudoers。这让门户 admin 获得真实宿主机 root，应只给完全受信任的人。以后重新部署仍需显式传该开关，否则节点配置关闭此能力。

节点程序在 `~/.local/libexec/gpuq-console`，状态/数据放自己的工作区根。授权公钥带 `restrict`、VPS Tail 源地址和强制命令；不会覆盖已有 authorized_keys。修改 VPS Tail IP 后需审查并更新这些限制。

## 5. 固定 SSH 主机指纹

在每台节点可信终端查看：

```sh
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

在 VPS 获取候选公钥，与刚才指纹**逐一核对**后加入两份 known_hosts；`ssh-keyscan` 本身不验证身份：

```sh
ssh-keyscan -t ed25519 100.64.10.11 > /tmp/gpu-1.hostkey
ssh-keygen -lf /tmp/gpu-1.hostkey
# 确认与节点输出完全相同后：
sudo sh -c 'cat /tmp/gpu-1.hostkey >> /opt/gpuq-console/collector/known_hosts'
sudo sh -c 'cat /tmp/gpu-1.hostkey >> /opt/gpuq-console/executor/known_hosts'
```

对每台重复。不得把 `StrictHostKeyChecking` 改为 no。端口按当前脚本固定22；非标准端口需要先适配清单/桥并测试，不能只改 SSH alias。

## 6. 启动后台与网页

```sh
sudo systemctl enable --now gpuq-console-executor.service
sudo systemctl start gpuq-console-collect.service
sudo systemctl enable --now gpuq-console-collect.timer gpuq-console-backup.timer
sudo cat /opt/gpuq-console/status/snapshot.json
sudo docker compose up -d --build gpuq-console caddy
sudo docker compose logs --tail 50 gpuq-console caddy
```

所有节点应 `reachable:true` 且 `gpuq.connected:true`。只读状态失败时别先开放公网 SSH；先核验 Tail ACL、指纹、强制命令、服务用户总线与路径。

执行桥的 `/run/gpuq-console-executor` 目录被门户绑定到 `/executor`，单元必须保留 `RuntimeDirectoryPreserve=yes`：单独的 stop/start 也不能删除并重建该目录（`restart` 取值不足以覆盖这种操作）。已有部署应先审查并更新对应执行桥单元、执行 `daemon-reload`；保留原服务名与路径，不要为此重跑首次安装器。若运行中的容器已绑定旧目录，仅修改单元不能修复：在受控维护窗口以原镜像、原数据挂载重建门户，核验宿主机与容器目录身份及登录后的只读节点请求，不能仅凭 `/healthz` 判定恢复；不回滚数据库。`/run` 在重启后仍会清空，开机时须先准备执行桥目录再创建门户容器。

门户反向代理示例仅对 Portal 的 HTTP 上游关闭空闲连接复用，避免 Node 短空闲超时或发布切换后复用失效连接；不修改 Headscale 等其他站点。此设置不关闭浏览器 HTTPS，也不等于零停机发布。单实例容器重建仍有短暂未就绪窗口，应合并发布并预留维护时段，不在使用者持续上传期间反复重建。只读客户端采用最多 65 秒的有界退避；通用写请求不会因为 502/503 自动重放。上传、发布或提交响应未知时按原操作身份查询，不能换键重新提交。

访问自己的域名。初始管理员用户名 `admin`，随机密码只在 VPS 的 `data/bootstrap.json`，用 `sudo cat` 在可信终端读取；不要截图公开。数据库已存在时不会被 bootstrap 重置。首次登录更改密码，将私有密码安全保存，并删除不再需要的 bootstrap 明文（数据库备份不含明文密码）。

在“用户授权 → 注册邀请”生成普通注册码；管理员以后可随时查看当前码或刷新换新。新用户自行注册后自动进入零额度资源页，管理员的“待处理”列表自动出现该账号，批准机器和卡数后即可使用。

管理员也建议使用个人账号：普通注册、由初始 admin 提升角色，再用个人账号登录验证完整权限。确认无未完成任务后暂停并删除初始 admin；系统保护最后一名可登录管理员，不能删除当前自己。删除不抹除历史作业和个人工作区。

注册一个普通测试账号、批准额度，执行 [完整验收](TESTING.md)。普通用户从自己的门户下载 CLI，下载内容自动带本站地址；直接从 GitHub 源码运行时首次用 `node cli.mjs --url https://gpu.example.com login`。

## 7. 备份、升级与回退

门户的持久准入维护状态位于同一 SQLite 的 `operational_maintenance` 表，与已停用的 `maintenance_requests` 申请记录独立。管理员通过网页或 `maintenance.set`（范围、原因、revision CAS）明确启用/解除，重启、任务结束或刷新页面不会自动解除；保留完整数据库备份，不能用旧账号快照覆盖维护决定。维护封锁新派发、个人终端输入和数据写入，允许只读查询、取消及终态租约收尾；后台准备/归档也在实际派发前检查。它不停止已运行训练、已有节点复制/导入 worker、直传已发行票据、GC timer 或原生 SSH，因此迁盘前仍必须由管理员完成相应节点的停止与静默核验，不能把横幅当作已静默证明。独立管理员 ROOT 运维入口仍需门户可信身份及节点既有授权检查。

`backup.sh` 用 SQLite 在线备份并验证完整性，同时备份数据库旁的注册码加密密钥 `portal.sqlite.invite-key`，每日 timer、默认保留14天。恢复时数据库与密钥必须匹配；有注册码密文但密钥丢失时，服务拒绝自动生成新密钥覆盖。另备份私有 inventory/.env、Headscale 数据与密钥、节点 GPUQ 数据库、个人工作区；只有门户 SQLite 不够恢复模型和数据集。备份放离机的私有存储，定期演练恢复。

节点文件可另行配置 [独立磁盘备份](STORAGE_BACKUP.md)。该可选助手不随升级启用，也不替代数据库在线备份；必须逐机确认来源、独立物理盘、口令留存和真实恢复结果。

升级不要对运行目录无脑 `git pull && up`：

1. 记录 Git commit、镜像 ID；运行数据库备份；保留旧节点桥与 GPUQ 版本。
2. 在独立目录检出新版，运行测试、生成自己的容量配置；比较数据库兼容性与 release notes。
3. 只替换经审查的 Portal/节点桥。GPUQ 有在跑任务时不要更换其 archive 路径或重启用户服务。
4. 重建/重启门户不会杀现有训练，但短暂影响登录和控制；确认状态恢复、不重复提交，再结束维护。
5. 回退镜像前核对数据库 schema，不能把旧快照直接盖回仍有新任务的状态库。需要还原数据库时先停控制入口并逐节点核对真实作业。

新加机器先部署节点、校验指纹，再更新清单并生成容量表。更改现有 machine ID 等同迁移身份，有未完成任务时不要改。删机器先清空任务/授权，再迁移数据，不直接删数据库记录。

### 仅更新 Portal 前端

前端 PR 测试通过且收到明确批准后，在 VPS 的独立源码目录构建唯一标签的新镜像。先记录正在运行的 revision、镜像 ID 和 Compose 项目，将当前镜像另打回退标签并保留。沿用已核对的原 Compose 文件、环境文件和数据挂载；前端发布要求数据库 schema 兼容。

下面的 `PORTAL_*` 变量由执行者填写为已确认的原部署路径、项目名和本次唯一镜像标签；覆盖文件放在独立发布目录。先完成构建和无数据库的模块加载冒烟，再切换服务：

```sh
(
set -eu
PORTAL_CONTAINER_ID="$(docker compose --env-file "$PORTAL_ENV_FILE" -p "$PORTAL_COMPOSE_PROJECT" -f "$PORTAL_COMPOSE_FILE" ps -q gpuq-console)"
PORTAL_PREVIOUS_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$PORTAL_CONTAINER_ID")"
docker image tag "$PORTAL_PREVIOUS_IMAGE_ID" "$PORTAL_ROLLBACK_IMAGE"
docker build -f "$PORTAL_SOURCE_DIR/deploy/Dockerfile" -t "$PORTAL_NEW_IMAGE" "$PORTAL_SOURCE_DIR"
docker run --rm --network=none --read-only --entrypoint=node "$PORTAL_NEW_IMAGE" --input-type=module -e "await import('./portal-server.mjs')"

cat > "$PORTAL_IMAGE_OVERRIDE" <<'YAML'
services:
  gpuq-console:
    image: ${PORTAL_RELEASE_IMAGE:?}
YAML
PORTAL_RELEASE_IMAGE="$PORTAL_NEW_IMAGE" docker compose --env-file "$PORTAL_ENV_FILE" -p "$PORTAL_COMPOSE_PROJECT" -f "$PORTAL_COMPOSE_FILE" -f "$PORTAL_IMAGE_OVERRIDE" up -d --no-deps --no-build --pull never gpuq-console
)
```

构建或冒烟失败就保留当前容器。切换后验收实际域名的登录页、控制台、同源 CSS/JS/WOFF2 和 `/healthz`；确认原执行桥挂载及只读状态仍可用。失败时用保留的镜像单命令回退，保留当前数据库和数据卷：

```sh
PORTAL_RELEASE_IMAGE="$PORTAL_ROLLBACK_IMAGE" docker compose --env-file "$PORTAL_ENV_FILE" -p "$PORTAL_COMPOSE_PROJECT" -f "$PORTAL_COMPOSE_FILE" -f "$PORTAL_IMAGE_OVERRIDE" up -d --no-deps --no-build --pull never gpuq-console
```

发布和回退都只选 `gpuq-console`，保持 caddy、headscale、执行桥、节点服务与运行中训练不变。不执行迁移、初始化或卷删除。缺少已确认的部署访问或路径时，停止并向审核者报告。

### 原生队列人名与任务名（schema 13）

此更新不是只换前端：需新 Portal 镜像、完整节点 runtime（task-display.py / node-executor / node-probe）和原生 GPUQ。schema 12→13 仅增加默认空对象的 jobs.display_json，原 name/owner/submit_key/digest/argv/状态/lease 不改；显示更新按原提交键、内部 owner、内部 name 三重核对。旧任务缺字段时保持原显示，升级后由门户对未结束任务定期回填，不按 GPU 或短前缀猜身份。

原生 schema 必须按[调度器维护方案](PRIORITY_RELEASE_PLAN.md)在核准窗口备份、停止仅 gpuq.service、以原 UID/配置执行新 archive 的 `_init`、核对 schema/完整性并恢复 daemon；不要直接写线上 SQL，也不要把旧数据库覆盖回去。运行中的训练 unit 是否独立必须先核验，不能据源码测试宣称实机无中断。旧 schema 的 daemon 不能直接打开 schema13；回退需单独评审。该维护未因本 PR 自动获准。

只有 native 的 job-display-v1 与节点完整助手同时被 probe 确认，才宣告 console-task-display-v1；旧或未升级节点仍用原请求，不因多了 metadata 破坏提交。显示失败是独立 UNAVAILABLE 回执，不改变训练状态、用卡配额，也不阻挡取消。显示回填仅随 sync 进行，节点取消、优先级和日志请求均不执行可选的显示同步；快照能力尚未刷新但助手已缺失或损坏时，执行状态仍照常核验。助手可用时，新提交／同步仍严格拒绝不匹配的任务名或提交人，且显示更新绝不修改不可变任务 spec。

### 已有节点加入项目工作流

此升级入口只用于已完成公共 P0 终端与诊断安装的节点，不负责首次安装或修复 P0 协议。先把新版源码放在节点服务用户拥有的独立目录，以该服务用户明确选择已有运行档位并检查（不是 root）：

```sh
python3 deploy/upgrade-projects.py --directory "$HOME/.local/libexec/gpuq-console" --runtime-profile common-p0
# 检查通过后才应用
python3 deploy/upgrade-projects.py --directory "$HOME/.local/libexec/gpuq-console" --runtime-profile common-p0 --apply
```

已经使用完整 Ray P0 的节点须把两条命令中的档位改为 `--runtime-profile ray-p0`；参数没有默认值，项目升级不能把已安装的 Ray runner 降级成公共档。Ray 档在任何备份或程序写入前运行有时限、无 GPU 的 CPU/内存/PID 内核限制检查；失败立即停止。升级器不接受 `--configure-cpu-delegation`，不会调用 sudo、设置委派或刷新用户管理器；需要管理员处理的前置问题见 [RAY_RESOURCES.md](RAY_RESOURCES.md)。公共档不运行该 CPU 探针。

升级器只读检查现有独立终端写入租约接口、终端返回协议、诊断采集与回收接口，以及同程序目录的诊断 GC service/timer 已安装、启用且运行。缺失或不兼容时，先按经审查的 `deploy/install-node.py` 完成配套 P0 安装。三条安装/升级路径统一使用 `deploy/node-runtime.json`，配套更新运行时助手、runner 和节点入口；不会修改 systemd 单元、启动宿主机命令或赋予额外权限。

旧部署若使用不同程序目录，替换 `--directory`，诊断 GC service 必须已指向这个目录；不要为升级改名或迁移工作区。Ray 档另配套安装 `job-resources.py` 和 `gpuq-ray`。全部源码先校验并固定字节，依赖（含 scheduling-policy、project-store、training-control）先复制，runner 随后，dispatcher/probe 最后更新。任一依赖缺失或语法错误会在写入前停止；不要手工只复制 node-executor。原文件和配置保留私有备份；项目升级保持配置原字节，数据升级沿用原有 datasets/conda 增补，默认保留已有 common/Ray 档。GPUQ 数据库、旧工作区和运行任务保持不变，不重启节点服务。

这是逐文件原子替换，不是整个运行时同时切换。升级前暂停新训练派发和新节点操作，禁止并发升级；已经运行的训练继续。全部入口复制完成后，先执行下面的部署检查及只读节点 probe，再恢复入口。PR #5 的保存/恢复策略依赖 PR #4 训练控制协议；此修复分支已合入该协议，维护者应先审阅该依赖。

```sh
python3 tests/node-runtime-deployment.test.py
python3 scripts/test-python.py
npm ci --ignore-scripts
npm test
```

部署测试使用临时节点、真实安装/升级复制和独立 Python 进程导入入口；只模拟外部 mount/systemd/CPU 检查，不使用生产 GPU。`--reproduce-pr5` 是可选的旧故障复现，需要本地保留旧提交 834d4d6；常规测试不依赖该 Git 历史。真实节点还需在本机按实际程序目录验证入口与只读 probe，无误后恢复派发。

所有目标节点完成后，再部署同版 VPS 执行桥与 Portal 镜像；前端、CLI、执行桥、节点四层必须匹配。门户控制服务重建会短暂中断请求，不表示可以停止节点实验。新版登录随原 SQLite 数据库持久化，保留私有数据卷就不因重启注销；首次从内存会话旧版升级仍需重新登录一次，不删除或初始化旧数据库。上线后按项目验收清单验证上传、开发终端、发布、单卡训练与结果下载。

回退项目功能前先停止新提交、等待项目任务和开发终端结束，再恢复备份助手及旧门户镜像。保留项目文件、结果和新数据库记录，不把旧数据库覆盖回去；代码回退不等于删除数据。

## 8. 0.4.3：分步启用归档与水位回收

自动归档和 GC 都默认关闭。此处是部署条件，不是某个实例已上线的证明；不能仅升级客户端或节点脚本就启用。已有数据根、旧目录、用户/配额和运行训练保持不变，根目录迁移必须另开维护流程。

1. 冻结完整源码和镜像清单，在隔离 Linux 环境运行配套 Python 全套及运行时部署测试；macOS 测试不能替代 Linux 挂载、systemd 和权限验收。节点必须使用同版 `node-runtime.json` 的完整档位，以 `node_runtime.runtime_plan` 输出的完整文件清单为准，不沿用旧版文件数量或手工遗漏可选功能控制器。门户镜像含 `storage-archive.mjs`，执行桥只接受明确允许的内部归档/租约/下载操作。先逐节点发布，再更新门户与桥，归档/GC 仍关闭。
2. 核实 HDD 权威原件根、固定 peer 证书与物理 LAN、容量、来源 ACL 和私有 grant 目录。在节点配置合并 `storageArchive: {"enabled":true,"machine":"gpu-archive","authority":"hdd"}`，其中 machine 必须替换为清单内真实权威节点，authority 与既有受信适配器名称一致。来源与目标使用相同固定策略；所有节点 `storageTier.enabled` 仍为 `false`。不让用户输入路径、端点、凭据或 cache 角色。
3. 门户以只读配置文件设置同一策略，通过 `GPUQ_STORAGE_ARCHIVE_CONFIG` 指定容器内文件。缺省不配置就是关闭；策略启用后需重建/重启门户以加载，先核对完整合并差异和可恢复备份，不覆盖现有账号、额度、工作区或数据库。
4. 用新单 owner 小样本完成真实上传/发布→HDD 固定原件→本地认证→租约防删→显式驱逐→恢复全量哈希→整次下载的验收；确认没有权威机器 GPU 额度的成员也只能读自己的原件。旧数据不会自动追溯归档，多 owner/未知状态保留保护。
5. 只有通过验收的 NVMe 节点才设置 `storageTier.enabled:true`、明确正整数 `budgetBytes` 和高/低水位 `0.8/0.7`。先查看 `data storage plan` 并做受控回收验收，再单独安装/启用可选小时 timer；HDD 原件节点保持 GC 关闭。已有安装目录与模板不同时，只改经核实的 service 程序路径，不改数据根。

归档与回收配置必须独立备份并保留完整原字节、属主/权限，写入前复核旧哈希和挂载身份；并发变更或未知状态停止。出问题先关闭 GC/timer，再关闭新归档调度，保留原件、grant、租约与持久记录供核查；这不是清除正在执行的任务，也不授权恢复旧数据库覆盖新状态。HDD 唯一原件不是异地/离机备份，结果自动归档与数据根迁移不在本次启用范围。

### 可选的平台根身份守卫

安装 `platform-root-guard.py` 不等于启用守卫；没有 `/etc/gpuq-platform-root` 目录时保留旧行为。管理员须在独立维护流程中核验平台根、挂载、文件系统 UUID 和目录身份，再设置 root 所有且普通用户不可写的启用目录与 `pin.json`。schema 1 固定显式 bind mount，schema 2 的 `direct-directory` 固定直接位于数据卷上的目录，不会在 bind 消失后自动切换模式。启用后缺失、损坏或不匹配的 pin 均拒绝平台入口，不回落为旧行为。

守卫不替代 root 所有、权限为 `000` 的底层挂载目录、服务挂载依赖和迁移停写验收，也不限制原生 SSH 或宿主机其他程序的写入；不能据此承诺全主机不会向系统盘落盘。

### 可选的工作区磁盘预留

节点 `node-config.json` 可设置顶层 `workspaceReserveBytes`（非负整数字节数，例如 `274877906944` 为 256 GiB）。未配置时保留原有工作区写入 10 GiB 预留，也不增加训练/终端启动的磁盘门槛。该字段只由管理员配置，不接受客户端覆盖；`0` 表示不留额外余量，但仍检查本次已知写入大小。数据集使用独立的 `datasets.reserveBytes`，缓存软预算使用 `storageTier.budgetBytes`，三者不是分区或可用容量相加。

工作区上传、项目发布和代码快照导入使用同一预留；显式配置后，快照索引/清单增长以及普通终端新建、新训练提交、排队任务实际启动也检查当前平台根的普通用户可用空间。检查以不跟随符号链接的目录描述符和平台根身份守卫为准；已缓存快照的读取、终端重连/日志/取消和已有训练状态查询不因空间不足而被拦截，宿主机 root 管理终端不受这项启动限制。配置需与同版完整节点运行时一起校验，不要只替换单文件。

这是**入口预留，不是硬配额**：并发写入与已运行终端/训练仍可继续消耗空间，不会被该检查主动杀停，也不为任务预占全部未来 checkpoint/输出容量。已知上传块/项目副本计入本次空间需求，快照索引仅作保守元数据估算；取消和必要收尾元数据仍允许写入。应结合容量告警、数据集回收和运维预留，不以它承诺磁盘永不写满。

## 9. 可选能力：云文件、个人容器与内核配额

### 私人云文件

部署匹配的门户、CLI、执行桥和完整节点档位后，网页入口是“数据 → 云端副本”，CLI 是 `gpuctl data cloud`。节点缺省关闭；仅在一个指定存储节点启用云账号，其余节点继续使用已有 LAN 数据通道，不重复安装 CD2 或复制令牌。构建 `npm run build:cloud-worker` 的单文件产物，与固定的 Node.js 运行时一并部署；CD2 只监听该节点 loopback，使用专门的目录限制授权。完整字段、权限、容量账本和验收清单见 [私人云文件](CLOUD_FILES.md)。

先完成真实小文件保存 → 云端确认 → 取回 → SHA256，以及跨用户拒绝、取消、响应丢失后的原编号查询、断点前缀验证和已有文件保护，再启用门户策略。云传输的是服务器个人数据空间里的文件：不因此开放浏览器访问 CD2，不向成员暴露令牌，也不能宣称电脑到服务器的大文件已绕过 VPS。取消或失败保留云端内容和容量预约；管理员核查后才能清理账本，不做失败即删。

### 个人 rootless OCI 与可选内核硬配额

#### 服务器已有数据的默认只读挂载

在节点配置中登记共享目录的引用，例如 `"sharedDataDirectories":{"imagenet":"/srv/data/imagenet"}`，并配套安装 `shared-data.py`、当前档位 runner 与 `project-ops.py`（已纳入 `node-runtime.json`）。该目录对本节点获授权的平台账号共享；只配置团队允许共读的数据目录。

新开发容器和训练会自动只读挂载到 `/datasets/imagenet`，不扫描哈希、不复制、不发布、不申请缓存容量，也不取得数据缓存锁。源文件保留原位置与权限。多个项目／账号／任务共享同一份原文件；既有会话需结束后新建才获得新增挂载。目录缺失或路径包含软链接时明确拒绝启动，不创建替代目录。该目录不是可回收缓存，平台不会清理它。原地数据由外部维护，不提供不可变版本或独立备份保证。

不要把受管 READY、staging 或缓存目录配置成共享原目录；这些目录仍须使用原版本读取保护，以免回收时删掉正在使用的数据。个人整理区的原始 `data` 目录可以共享，不复制其数据。

验收时在开发终端和训练容器各读一个已有样本，确认写入失败、宿主文件不变、没有新增数据副本。挂载属于节点部署；仅更新门户不会启用它。

`personalOci`、`storageQuota` 缺省均关闭。代码和模拟安装测试通过不等于实机容器、GPU 隔离或内核超限通过；原 shared/isolated 项目和旧工作区不自动转换。必须在独立维护窗口逐机验收，未通过节点保持关闭。

1. 先确认数据卷真实设备、UUID、文件系统、挂载点、平台根守卫与恢复备份。只启用明确账号的个人容器，不要求先改文件系统或启用磁盘硬配额。若另需硬配额，清空相关写入服务后再处理文件系统；XFS 需要干净重挂载启用项目配额，ext4 可能需要离线设置特性。应用安装器不会完成这些步骤，不得强制/懒卸载或在系统盘临时兜底。
2. 启用磁盘硬配额时，管理员离线核对非空目录归属，制定每个不可变 owner 在每个物理卷上的有限 byte/inode 限额及唯一 project ID。共享/未知数据不猜计费人。root 策略固定平台根、数据根、卷 UUID；如管理日志，另固定调度器 `database`、`controlRoot`、`logRoot`。
3. `deploy/configure-storage-quota.py` 默认只读出计划；显式执行要求 root、维护栅栏和批准的政策 SHA。它只安装有限内核限制及窄 root broker，不改挂载、不迁移目录、不启用节点标志。安装路径已存在时停止供检查，不盲目重放部分安装。
4. 分别安装并核验 root 所有的 Podman ≥ 4.1、crun、uidmap、slirp4netns，审查精确 GPU UUID 的 NVIDIA CDI 和基础镜像固定 digest。`deploy/configure-personal-oci.py` 默认只读计划；显式执行固定控制文件/空 hooks/CDI 与专用镜像策略，不安装包、拉镜像或启动服务。策略在 `/etc/gpuq-console/personal-oci-policy.json`，默认拒绝，仅允许选定基础镜像的完整 Docker digest，不修改系统 `/etc/containers/policy.json`。入口逐次核对策略属主、权限和 SHA，拉取保持 TLS 校验、匿名认证和一次尝试。其他 CDI、二进制或驱动变化均需重新核验，不回落到全部 GPU。
5. 测试账号和隔离配置中真实验证：开发无 GPU、容器 root 不能改宿主、退出/重连保持环境、发布固定镜像+代码、训练只见分配 UUID，CPU/内存/PID 和取消仍受控。启用磁盘硬配额时还须验证 byte/inode 超限得到 EDQUOT、不能改 project ID，日志与 OCI 可写层正确计费；不凭 statvfs 或单元测试认定硬配额有效。
6. 逐项通过后才合并开启政策，备份配置并复核 SHA。原生宿主 root/旧 sudo 仍可绕过，平台不是恶意公网 VM 级隔离；数据库和其他管理员数据另行备份/限额。失败先封锁新入口，停止测试单元，保留原件和内核归属；代码回退不解除配额、不覆盖旧数据库。

节点实际启用、测试证据和剩余限制应单独记录，不将本手册当作上线回执。

镜像认证使用个人私有目录内的匿名 JSON，不继承宿主登录信息、外部凭据助手或代理环境。Podman 5.x 会在主配置之外读取 `/etc/containers/registries.conf.d` 与私有 HOME 的 `.config/containers/registries.conf.d`；入口逐次核对它们为空或安全不存在。目录非空、链接、归属或身份变化会拒绝，须管理员独立评审，不会自动删除原配置。基础镜像拉取仅一次并验证 TLS；这不代替真实出口、rootless 重执行和容器业务验收。

#### 小范围启用，不自动迁移旧工作区

节点可在完整 `personalOci` 政策中添加 `owners: ["demo-user-N"]`，只允许列出的不可变账号 ID 使用个人容器；即使 `storageQuota: {"enabled": false}`，这些账号也能使用已验收的容器。此模式仍有独立工作区、rootless UID、CPU/内存/PID 限额与精确 GPU 分配，但没有磁盘硬限额，界面和运维记录不得说有。未列出的账号在任何工作区写入前被拒绝；原 shared/isolated 项目不自动迁移。

`storageQuota: {"enabled": true, "owners": ["demo-user-N"]}` 单独控制磁盘内核配额。省略 `personalOci.owners` 的旧安装仍要求本人已启用硬配额，不自动扩大范围。两种名单均须非空、无重复且由管理员配置，不接受 RPC 或显示用户名覆盖。

仅新增列表不是迁移：选中账号每个已有个人根仍须通过离线归属及 inode CAS；含旧 venv 软链接等未通过的目录会拒绝写入，不自动修改文件。若希望保留旧环境，应先保留该账号未激活，另用已核验的新账号/全新空工作区灰度；不要把旧根整体改 ID 或把 OCI 子目录挂载绕过平台根守卫。涉及已激活用户的数据集 staging 必须有唯一、已激活的登记计费 owner；共享/混合授权不猜归属，已有只读 READY 数据集不因此重写或重新计费。

容器开启前必须实测开发无 GPU、训练精确 UUID、安装/退出/重连/发布、预算与取消。仅在同时启用磁盘硬配额时另验指定卷的 project quota、有限 root 政策/broker 与 byte/inode EDQUOT。名单不是安装器，也不解除宿主 root 的运维信任边界；涉及存储归属迁移仍须停止相关写入者。

#### 已有目录与配额变更

首次安装之后，管理员使用 `deploy/manage-storage-quota.py`，不重跑首次安装器。默认只读输出 `{plan, planSHA256}`；执行只接受 root 所有、不可被普通用户写入的已保存计划和其中的 `planSHA256`。计划包含原政策的完整字节/目录身份、内核计数、维护栅栏、物理根守卫和脚本 SHA；执行前再次核对。先保留维护状态，停止调度器、终端、传输等 service UID 或 rootless subuid 进程。工具不停止服务、不重挂载、不改分区、不启用标志。

- 新增用户或改限额：`policy --candidate /root/quota-next.json`。候选必须从当前 root 政策完整合并，只新增 owner、为原 owner 增加已配置卷或调整有限 byte/inode 限额；根、卷、服务 UID 与既有 project ID 不变，不支持删 owner、回收 ID 或减少到实际用量以下。新 ID 必须在所有已配置卷均为空闲。
- 迁移已有个人目录：`migrate --owner demo-user-N --path <政策中的个人根>`。支持私有工作区、项目、OCI、个人数据及单 owner 的登记 staging 根；项目上传桶另需 `--project NAME`。计划扫描不读取文件内容。软链接、外部硬链接、特殊文件、跨挂载、未知属主或已有别人的 project ID 均拒绝，要求管理员单独整理，不猜归属。内部硬链接保留，执行仅设置 project ID/目录继承，不改文件、chmod、chown 或删除内容；现有 rootless 映射 UID 内容需另行审查，不能当作 service UID 目录批量迁移。
- 执行：`policy|migrate --execute --plan /root/quota-plan.json --approved-plan-sha256 <planSHA256>`。每次计划在 root 控制目录使用独占 intent，先保存原政策；中途失败保留原件、政策备份、已改变的内核归属和失败回执，不自动回滚或重放。检查后需要新计划，若内核与政策已不一致，先由管理员明确修复，工具不会静默改成“可用”。
- 用量：成员使用 `gpuctl project quota --machine SERVER`（或 `--json`）。返回经认证的本人、该物理卷的内核 byte/inode 已用、硬上限与剩余，不统计应用文件数来假冒内核配额。未启用返回“未启用”，查询失败/未知不是零用量。管理员本机只读可用 `manage-storage-quota.py status --owner demo-user-N`。GPU 用卡额度与磁盘配额是不同政策；注册用户不会因此自动得到不限量磁盘。

不要将该工具的纯本地测试等同于真实 EDQUOT、容器隔离或四节点上线。政策与 kernel 限制变更不具备跨卷事务；维护栅栏和保留失败 intent 是部分失败时的边界。宿主 root 和已有原生 SSH 管理权限仍属于可信运维，不受这些平台入口约束。

## 10. 常见阻塞

- 终端打不开：`bwrap --help` 是否支持 bind-fd、用户命名空间策略、slirp4netns、服务用户 linger、基础 Python 路径。
- 单卡正常多卡失败：先查训练程序、驱动/框架兼容与 NCCL，不能通过给普通用户全宿主机权限绕过。
- 日志/状态 UNKNOWN：保留额度，查节点 SSH 和 GPUQ；不要手工清空预留。
- 证书失败：DNS A/AAAA、80/443、防火墙、Caddy 持久卷；不关 TLS 校验。
- 开源示例和既有部署路径不同是正常的；以自己的 `inventory.json` 为准，不能照抄他人地址。
