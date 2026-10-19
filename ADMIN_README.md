# STARGATE 管理说明

管理员负责机器接入、成员卡数额度、维护模式和云盘连接；账号、角色和停用在统一门户管理。网页管理台只有成员与额度、维护模式、云盘连接三块。成员使用说明见 [使用指南](docs/USER_GUIDE.md)，开发和发布统一遵守 [AGENTS.md](AGENTS.md)。

部署使用 [deploy/Dockerfile](deploy/Dockerfile) 的 Portal 和 [节点构建说明](docs/NODE_RELEASE_BUILD.md)；域名、真实机器清单、认证配置、私有输入和数据库保存在仓库外。只读示例清单位于 [dist/machines.js](dist/machines.js)。

平台账号和 GPU 配额不自动授予基础设施管理权限。系统盘隔离、资源底线及回收站规则以 AGENTS.md 为准；不得依据旧管理员手册授予额外系统盘权限。

测试入口见 [TESTING.md](TESTING.md)，维护流程见 [维护手册](docs/MAINTAINING.md)。PR 和 main 自动跑灰测，通过后由合并 main 的自动流程部署门户、CLI 和节点；上线失败保持上一版。公开文档不包含现场地址、凭据、主机指纹或用户数据。

平台功能与存储模型统一以 [功能清单](docs/FEATURES.md) 为准。
