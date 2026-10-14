# STARGATE 使用说明

网页与 gpuctl 共用平台账号。登录后选择服务器和项目；工作区、数据、任务及恢复操作见 [完整使用指南](docs/USER_GUIDE.md)。

```sh
gpuctl login USERNAME
gpuctl use SERVER
gpuctl project create my-project
gpuctl push .
gpuctl run -g 1 -- python train.py --output /outputs
gpuctl logs JOB_ID
gpuctl pull --job JOB_ID model.pt ./model.pt
```

项目、工作区与回收站见 [项目说明](docs/PROJECTS.md)，数据操作见 [数据集说明](docs/DATASETS.md)。团队权限及七天回收站的统一规范见 [AGENTS.md](AGENTS.md)；具体可用操作以本次发布代码及服务回包为准。

机器清单、域名、账号和部署输入由管理员在仓库外配置；仓库中的 gpu-1 等机器仅为公开示例。

平台功能与存储模型统一以 [功能清单](docs/FEATURES.md) 为准。
