# STARGATE

STARGATE 是团队共用的 GPU 研究工作台：VPS 管账号、权限、额度、选服务器、全局任务列表和入口；各 GPU 服务器管排卡、起停容器和资源限制。网页与 `gpuctl` 使用同一账号。

本项目独立于 SpaceX、Tesla、Elon Musk、OpenAI 的 Stargate 计划和 MGM《星际之门》。品牌参考不表示隶属、合作或背书。

## 开始使用

按[使用指南](docs/USER_GUIDE.md)安装客户端、注册并登录；管理员分配用卡额度后：

```sh
gpuctl login USERNAME
gpuctl use SERVER
gpuctl project create my-project
gpuctl push .
gpuctl ssh
```

在项目容器里安装依赖，再从本机另一个终端提交：

```sh
gpuctl run -g 1 -- python train.py --data /datasets/images --output /outputs
gpuctl logs JOB_ID
gpuctl pull --job JOB_ID model.pt ./model.pt
```

SSD 工作区挂在 `/workspace`，HDD 共用数据集挂在 `/datasets`，每个任务的输出独立挂在 `/outputs`。代码用容器里的 git 管理；上传与训练直接使用当前目录。登录的团队成员可以协作操作项目、任务和数据，删除进入 7 天回收站。

## 文档

- [功能清单](docs/FEATURES.md)：唯一的功能与存储模型清单。
- [使用指南](docs/USER_GUIDE.md)：网页七章指南与实际操作步骤。
- [项目入口](docs/PROJECTS.md)和[数据集入口](docs/DATASETS.md)：对应指南章节。
- [节点包构建](docs/NODE_RELEASE_BUILD.md)：本机离线准备安装材料。
- [开发规范](AGENTS.md)：开发规则；[CLAUDE](CLAUDE.md)引用同一份正文。
- [维护手册](docs/MAINTAINING.md)：修 bug、PR 灰测、合并、自动上线与回退。
- [测试](TESTING.md)与[第三方声明](THIRD_PARTY_NOTICES.md)：验证入口、依赖与许可。

原创包元信息标记 MIT；GPUQ 源来自既有 source zipapp 整理，第三方版权和许可独立保留。
