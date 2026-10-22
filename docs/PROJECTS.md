# 项目与代码

功能以[功能清单](FEATURES.md)为准，完整操作集中在[使用指南](USER_GUIDE.md)：

- [项目开发](USER_GUIDE.md#项目开发-development)：创建项目、可选 Git 仓库、跨服务器增量同步与容器复用、上传下载、容器终端、显示名、分组、归档和磁盘用量。
- [提交训练](USER_GUIDE.md#提交训练-training)：当前工作区、自动选机、GPU 交互终端和调度选项。
- [日志与结果](USER_GUIDE.md#日志与结果-results)：完整主日志下载与续传、按任务读取输出、容器内复用前序结果、删除与回收站恢复。
- [常见问题](USER_GUIDE.md#常见问题-troubleshooting)：原编号恢复、网络诊断和维护。

网页对应入口为[项目开发](/guide/development)和[提交训练](/guide/training)。

本页提供项目相关的仓库链接；完整操作步骤统一维护在使用指南。

服务器重启后，首次初始化个人 OCI 时会清理上一轮启动遗留的 Podman `run`、`tmp` 运行态，再由 Podman 恢复原容器。镜像、容器可写层、代码、依赖和 HOME 保留；同次启动不清理运行态。排查与灰测见 [Podman 重启恢复](OCI_REBOOT.md)。
