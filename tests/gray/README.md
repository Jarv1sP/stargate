# Docker 灰测

改编自 javis6497 的 PR #294。在 runner 本机的独立 Docker 网络里运行门户、模拟 GPU 节点、仓库和 Git 服务，使用真实 API、正式构建的 CLI 和 Chromium 验证功能。不连接生产。

GitHub Actions 的 `gray` 检查在 PR、main push 和手动运行时测试 `github.sha`，运行全部 G01–G15。业务断言失败即判红；未覆盖功能和未测项如实列在报告里。

本机与 Actions 使用同一个入口，需要 Node24、Go1.27.1、Python3.12、Git≥2.43、Docker Compose 和 Playwright Chromium：

```sh
npm ci --ignore-scripts
npx playwright install --with-deps chromium
npm run gray -- --commit HEAD
```

只接受确切提交，默认 HEAD；本地未提交代码不参与测试。Docker 必须是本机 Unix socket；已有灰测栈时停止，不接管。构建和测试均在 runner 本机完成，没有镜像传输、远程 SSH 或 VPS 运行分支。

固定独立 Compose 项目 `stargate-gray`，全新命名卷与 internal 业务网，门户端口只绑定 `127.0.0.1`。模拟节点的特权仅供内部 systemd/Podman 使用，不挂宿主数据。候选本身仍使用正式 Dockerfile 和节点发布包。

每轮成功、失败或中断都拆除本轮容器、卷、网络和专属镜像标签，不保留调试栈，不运行全局 prune。报告位于 `out/gray/<本轮>/`；Actions 上传 summary.md、report.json、日志和截图，不上传生成的账号、密钥和数据库。

G01–G09 覆盖账号、权限、资源、项目、终端、数据集、训练、输出、取消与优先级；G10–G15 再覆盖团队操作、协作与维护、重启恢复、浏览器与 CLI。

CPU 模拟不覆盖真 GPU/CUDA/NCCL、真实外网云盘、Windows/macOS 真机、跨物理服务器传输与宿主安装更新。各步骤的 `features` 声明对应 FEATURES.md；未覆盖项只列在报告里，不伪报通过。
