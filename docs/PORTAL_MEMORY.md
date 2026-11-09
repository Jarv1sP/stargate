# Portal 内存基准

灰测使用正式候选 Portal 镜像，在独立的 `--memory 512m --memory-swap 512m`
容器运行 `tests/fixtures/portal-memory.mjs`。数据库为合成数据，与灰测业务数据库隔离。
四节点的存储快照约 38 MB，包含项目、数据集和磁盘目录构成；CLI 使用镜像的真实构建产物。

基准先在另一个进程生成数据库，再启动 Portal，避免把造数据的内存计入服务。
记录启动、三次保存、两轮四节点刷新、存储页面、HTML 和 CLI 下载后的 RSS、堆和外部内存，
以及操作系统记录的进程峰值 RSS。HTTP 下载直接消费数据流，不在客户端累积整份响应。
报告在灰测产物的 `memory.log` 中。

本地已构建后可运行：

```sh
node tests/fixtures/portal-memory.mjs seed /tmp/portal-memory
node tests/fixtures/portal-memory.mjs measure /tmp/portal-memory
```

分析堆时，使用新建的数据库目录，运行
`node --expose-gc tests/fixtures/portal-memory.mjs profile /tmp/portal-memory`。
用 Chrome DevTools 打开生成的 `idle.heapsnapshot`。
堆快照会主动 GC，并消耗额外内存，其 RSS 不作为限额验收数据。
数据库、堆快照和构建产物均不提交仓库。
