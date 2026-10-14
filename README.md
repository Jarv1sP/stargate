# STARGATE

STARGATE 是把项目、数据和 GPU 任务放在同一工作空间的研究计算工作台；网页与 `gpuctl` 共用账号和授权，GPUQ负责节点调度。

本项目独立于 SpaceX、Tesla、Elon Musk、OpenAI 的 Stargate 计划和 MGM《星际之门》。品牌参考不表示隶属、合作或背书。

## 使用

先按[使用指南](docs/USER_GUIDE.md)安装并登录；管理员开通机器与GPU额度后：

```sh
gpuctl login USERNAME
gpuctl use SERVER
gpuctl project create my-project
gpuctl push .
gpuctl ssh
```

在个人容器内安装依赖，再从本机另一个终端提交：

```sh
gpuctl run -g 1 -- python train.py --output /outputs
gpuctl logs JOB_ID
gpuctl pull --job JOB_ID model.pt ./model.pt
```

默认使用可变工作区，无需先发布；新任务输出独立，代码/环境/HOME共享。需要固定版本时显式 `--release`，固定数据 `--data` 仍保留原准备等待。为什么：新工作区减掉准备步骤，不能改变旧请求的实验身份或覆盖别的任务输出。

AUTO只在已有本人工作区的授权候选中选机；手动固定版本复制仍可用。`run --sync`先上传再提交，不自动发布。为什么：资源快照不是预约，已删除的自动项目复制不应由旧说明重新成为必经步骤。

## 文档与边界

- [USER_GUIDE](docs/USER_GUIDE.md)：成员操作，也是网页指南正文。
- [PROJECTS](docs/PROJECTS.md)：工作区、显式发布、原编号恢复、归档与回收站。
- [DATASETS](docs/DATASETS.md)：固定数据版本与来源/租约/恢复。
- [TESTING](TESTING.md)：保留行为的离线验证和实机验收边界。
- [AGENTS](AGENTS.md)：代理规则；[CLAUDE](CLAUDE.md)引用同一正文。
- [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)：依赖、字体与来源。

Portal管理账号、政策和回执，经受限桥交给节点执行；文件使用本次获授权的通道。成员只需平台HTTPS，`gpuctl ssh`是PTY而非原生SSH；宿主root另外鉴权。为什么：平台注册和容器权限不授予宿主或管理网络权限。

只把实际确认的状态作为依据；代码合入、节点加载和业务验收分别记录，未知不当空闲/零/成功。为什么：源码和健康页不能证明原任务或字节传输已经完成。

原创包元信息标记MIT；GPUQ源来自既有source zipapp整理，第三方版权和许可独立保留。分发说明见THIRD_PARTY_NOTICES。

平台功能与存储模型统一以 [功能清单](docs/FEATURES.md) 为准。
