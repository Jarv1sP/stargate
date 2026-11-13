# Portal 内存基准

灰测使用正式候选 Portal 镜像，在独立的 `--memory 512m --memory-swap 512m`
容器运行 `tests/fixtures/portal-memory.mjs`。数据库为合成数据，与灰测业务数据库隔离。
覆盖两种数据规模：四节点约 38 MB 存储快照；12,000 条近期已结束任务加 64 条未结束任务，约 49 MB。任务历史不得靠过期删除来通过内存测试。CLI 使用镜像的真实构建产物。

基准先在另一个进程生成数据库，再启动 Portal，避免把造数据的内存计入服务。
记录启动、三次保存、两轮四节点刷新、存储页面、HTML 和 CLI 下载后的 RSS、堆和外部内存，
以及操作系统记录的进程峰值 RSS。HTTP 下载直接消费数据流，不在客户端累积整份响应。
首次打开（包含现有状态转换）和后续重启各跑一次；两次峰值都必须 ≤300 MiB，
后续重启的空闲 RSS 必须 ≤200 MiB。报告在灰测产物的 `memory-first-open.log`
和 `memory-steady.log` 中，任务历史对应 `memory-history-first-open.log`、`memory-history-steady.log`。超出预算会使灰测失败。
这些预算以限额内的 Docker 测量为准；本机没有相同 cgroup 条件时只用于同环境前后对照，不据此声称容器验收通过。

另用真实 `portal-rollout.mjs` 启动监督进程和业务进程，二者共享一个 512 MiB cgroup；HTTP 测试客户端位于单独的临时容器，不计入门户内存。设置与生产一致的 `--max-old-space-size=384`，检验登录、资料保存、任务查询、原 key 查询、指南与 CLI 下载；首启迁移和重启各跑一次，整个门户 cgroup 峰值必须 ≤450 MiB，结果在 `memory-rollout-*.log`。

门户任务逐条保存在 `portal_jobs`。常驻集合只含未结束或仍占用资源的任务；历史逐条读取，普通状态仍采用字节窗口，点查、依赖和原 key 查询使用数据库索引。更新任务只写该任务，不再重写全部历史 JSON。迁移由 SQLite 在事务内提取旧记录，保留原编号、顺序、命令和额外字段，不在 JavaScript 中解析整块历史。

已结束记录保留 30 天，再进入 7 天记录回收站；恢复后重新保留 30 天。未上报结束时间的记录从首次持久化为结束态起算。清理明细后，最小索引仍用于原 key 防重、依赖结果和输出位置；不删除训练文件。回收与清理复用现有周期工作，每小时最多执行一次，维护模式下暂停。

存储读数按节点压缩写入 SQLite 的 `portal_storage`，常驻内存只保留采样时间。
账号和任务的 `save()` 不序列化存储读数。首次打开现有数据库时，在一个事务中移动
已保存的读数，每次只解析一个节点；失败则回滚。回滚旧版本后再次上线时，迁移会与已存读数合并：
新来的部分只有报错时保留已存数据和采样时间，checkedAt 更旧的读数不覆盖较新的读数。
刷新失败仍保留上次读数和原采样时间。
存储 HTTP 响应按授权节点依次读取，以有背压的 JSON 数据流发送；返回字段与普通本地调用相同。
CLI 下载保持流式读取。
完整下载按实际构建产物渲染后的字节数核对，不要求客户端大于某个固定体积。

本地已构建后可运行：

```sh
node tests/fixtures/portal-memory.mjs seed /tmp/portal-memory
node tests/fixtures/portal-memory.mjs measure /tmp/portal-memory
PORTAL_MEMORY_CASE=history node tests/fixtures/portal-memory.mjs seed /tmp/portal-history-memory
PORTAL_MEMORY_CASE=history node --max-old-space-size=384 tests/fixtures/portal-memory.mjs measure /tmp/portal-history-memory
```

分析堆时，使用新建的数据库目录，运行
`node --expose-gc tests/fixtures/portal-memory.mjs profile /tmp/portal-memory`。
用 Chrome DevTools 打开生成的 `idle.heapsnapshot`。
堆快照会主动 GC，并消耗额外内存，其 RSS 不作为限额验收数据。
数据库、堆快照和构建产物均不提交仓库。

## 迁移发布与回退

使用【手动】PR，开启维护后，通过维护手册中的受保护入口发布。发布器在旧门户停止写入后、候选启动前，使用 SQLite 备份接口保存 `portal-before-job-history.sqlite`（权限 0600，含已提交 WAL 内容）。迁移或启动验收失败时，先恢复数据库再启动旧门户；已经采用逐条任务存储后，不会在每次发布重复创建这份迁移备份。

首次上线成功后核对任务总数、未结束任务、原 key、输出定位、历史回收站及内存，再解除维护。备份属于私有回退材料，不放进公开 PR。成功接收了新写入后，不能直接用旧备份覆盖数据库；后续回退必须先安排数据回退方案。
