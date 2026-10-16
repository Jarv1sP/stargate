# 测试与发布构建

测试范围以 [功能清单](docs/FEATURES.md) 为准，运行入口由 package.json 和 scripts/ 维护。为什么：回归保护当前功能，避免把旧流程当成需求重新加回。

## 本地验证

使用 Node 24、Git ≥2.43、Go 1.27、Python 3.12；节点与 GPUQ 另用系统 Python 3.10 跑全部测试，不替换系统 Python。为什么：与开发、构建及节点运行环境保持一致。

```sh
npm ci --ignore-scripts
npm run build:release
npm test
npm run test:ui
npm run test:python
cd native/campus-http && go test ./...
```

`build/` 不进 Git；`build:release` 从当前源码生成四平台 Go helper，再构建 CLI 和 vendor。test-entry 每次也从当前源码构建测试所需产物；独立 CLI 行为测试默认用 cli.mjs。`npm run cli` 先生成 helper，再直接运行源码。为什么：不能拿旧 helper 验新代码或发布，否则校园直连可能返回 INVALID_GRANT。

全量及浏览器测试串行运行，外层使用 3GiB systemd scope。启动前可用内存须 ≥3000MiB、swap 已用 ≤12GiB。为什么：WSL 和 VPS 曾因测试/构建内存耗尽卡死，串行和上限能保护共享环境。

仅使用合成机器清单和临时数据；test-entry 临时提供公开机器清单，测试结束清理自有夹具。为什么：测试不能读写成员数据，也不能把真实配置或凭据写进仓库。

## 必须覆盖的保留行为

- 团队共享项目、容器 git、可写 /workspace、训练只读 /datasets 和独立 /outputs；系统盘及容器控制面隔离，标准 NVIDIA CDI 驱动例外。为什么：提供共同工作区，同时守住系统盘。
- 手选/AUTO、GPU/RAM 配额、64GiB 磁盘余量、参数及请求体资源边界。为什么：防止一个任务耗尽整台机器的资源。
- TLS、文件大小、原 UUID/key 与偏移续传、原子落盘、丢 ACK 恢复；终端未知输入不重放，撤销登录后停止请求。为什么：传输要能续，写入不能重复，退出后不能继续操作。
- `tests/campus-login-session.test.mjs` 用分离的业务库、账号库验证直传读写、门户重启及登录续期，并覆盖统一身份的停用、撤权、密码版本、应用隔离和目录过期；不连接实际校园节点。
- 项目、数据集、输出的 7 天回收站及恢复；管理员立即清空与操作记录。为什么：误删可恢复、永久清理可追溯。
- 真实未知、登录失效、维护和错误态；成员/管理员 1440/390/320、键盘、触控和减少动态。为什么：错误不能伪装成功，桌面和手机都要能完成原有操作。

## 发布构建与验收

本地用 `npm run build:release`（包含四平台 Go helper）验证构建；发布镜像只在 CI 从同一提交运行 `build:release` 后按 `deploy/Dockerfile` 构建，不从 Git 恢复旧产物。为什么：Portal、CLI 与 helper 必须来自同一发布树，服务器不承担构建负载。

PR 和 main 都自动跑灰测，灰测不过不能合并、不上线；合并到 main 后自动部署门户、CLI 和节点，上线失败保持上一版。具体操作见 [维护手册](docs/MAINTAINING.md)。为什么：2026-10-15 用户定管理员自助修复、合并即上线，失败候选不能影响现役功能。

记录确切提交、各套测试数、首轮失败、修复、跳过和未测范围。为什么：没跑的项目不能写成通过，方便复核和定位回归。

本地 friction e2e 覆盖真实 Portal/SQLite、CLI 和节点文件字节；灰测在隔离环境覆盖整套功能，OCI/GPU 夹具不能当作真实 GPU 通过。涉及真 GPU、校园直连或 Windows 真机的改动，在 PR 写明对应验证，不在生产上跑整套功能验收。为什么：灰测保护用户正在使用的功能，实际设备和链路的验证范围也必须如实记录。

本地验证不连接生产、不触发安装或部署，不中断成员正在运行的任务；正式上线只由 main 的自动流程执行。为什么：正式服务和训练应持续可用，线上代码必须能追溯到公开 main。
