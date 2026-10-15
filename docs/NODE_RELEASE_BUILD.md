# 节点发布包（仅离线准备）

在完整 Git 源码目录备好 Node24 和 npm 依赖，再构建机器包；机器 ID 由清单传入，输出目录必须不存在：

```sh
npm ci --ignore-scripts
python3 -I -B scripts/build-node-release.py --output /tmp/node-release-review \
  --machine node-a --machine node-b --machine node-c --machine node-d
```

每个机器目录包含共同 `node/`、`gpuq.pyz`、六类 `profiles/<profile>/node-config.template.json` 和 `manifest.json`。只打包 Git 跟踪的 `.py`、`.mjs` 及 `gpuq-network`/`gpuq-ray`；云文件 worker 由 Node/esbuild 打包。私有配置、密钥、数据库、缓存和 pyc 不进入包。node 文件只读，pyz 使用固定时间戳。

manifest 记录源码提交与 dirty 状态、node 文件路径和大小、pyz 路径和大小、profile 配置路径及固定入口/服务命令。`{release}` 表示安装目录；脚本只生成这些材料，不执行 SSH、systemd、安装或切换。

模板只描述配置结构，null 不代表可用配置。m2 在私有安装目录提供各机各 profile 的完整 `node-config.json`，保留实际路径、资源与服务配置；运行时不合并模板。真实旧版目录与入口的回退信息由 m2 的私有记录管理。

m4/m2 按路径和大小交接，经配置好的 TLS 通道接收，在同盘临时目录完整落盘后原子改名；断线沿用原操作和偏移。实际安装与切换按指定发布者/安装者的窗口执行，不由此构建脚本完成。
