# STARGATE 管理说明

管理员负责账号、机器接入、配额和平台维护。成员使用说明见 [使用指南](docs/USER_GUIDE.md)，开发和发布统一遵守 [AGENTS.md](AGENTS.md)。

部署使用 [deploy/Dockerfile](deploy/Dockerfile) 的 Portal 和 [节点构建说明](docs/NODE_RELEASE_BUILD.md)；域名、真实机器清单、认证配置、私有输入和数据库保存在仓库外。只读示例清单位于 [dist/machines.js](dist/machines.js)。

平台账号和 GPU 配额不自动授予基础设施管理权限。系统盘隔离、资源底线及回收站规则以 AGENTS.md 为准；不得依据旧管理员手册授予额外系统盘权限。

测试入口见 [TESTING.md](TESTING.md)。发布与节点安装由指定人员执行，具体发布候选及回退点留在私有操作记录中，公开文档不包含现场地址、凭据、主机指纹或用户数据。

平台功能与存储模型统一以 [功能清单](docs/FEATURES.md) 为准。
