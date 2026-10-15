# 节点发布包与安装

在完整 Git 源码目录备好 Node24 和 npm 依赖，再构建机器包；机器 ID 由清单传入，输出目录必须不存在：

```sh
npm ci --ignore-scripts
python3 -I -B scripts/build-node-release.py --output /tmp/node-release-review \
  --machine node-a --machine node-b --machine node-c --machine node-d
```

每个机器目录包含共同 `node/`、`gpuq.pyz`、六类 `profiles/<profile>/node-config.template.json` 和 `manifest.json`。只打包 Git 跟踪的 `.py`、`.mjs` 及 `gpuq-network`/`gpuq-ray`；云文件 worker 由 Node/esbuild 打包。私有配置、密钥、数据库、缓存和 pyc 不进入包。node 文件只读，pyz 使用固定时间戳。

manifest 记录源码提交与 dirty 状态、node 文件路径和大小、pyz 路径和大小、profile 配置路径及固定入口/服务命令。`{release}` 表示安装目录；脚本只生成这些材料，不执行 SSH、systemd、安装或切换。

模板只描述配置结构，null 不代表可用配置。安装者在本机私有 JSON 中提供各固定 profile 的完整配置，保留实际路径、资源与服务配置；运行时不合并模板。安装器逐版保存服务/入口的回退材料，不复制用户数据。

调用者按路径和大小交接，经配置好的 TLS 通道接收，在同盘临时目录完整落盘后原子改名；断线沿用原操作和偏移。构建脚本不连接服务器，安装与切换统一使用下面的本机入口。

## 安装

调用者负责 SSH/传输；节点本机用 Python 3.10 以管理员权限运行 `python3 deploy/node/install.py <单机包目录或tar包> --config <本机私有JSON>`。
私有配置结构见 [config.example.json](../deploy/node/config.example.json)：account、releaseRoot、dataMountPoints、gpuq、profiles、authorizedKeys（每条显式写 profile）、services；数据盘列表由顶层统一填入各 profile，真实值只留节点。
安装器写 policy.json、完整 profile 配置和服务/定时器；已有 ExecStart drop-in 可在对应 service 的 dropin 字段指定，无指纹或历史内容核对。
每版使用独立的真实 pyz 路径；current 原子切换后只重启受管服务，独立任务单元、旧发布目录和数据库保留；仅新库初始化。
健康仅看服务 active 和 GPU 可读，失败自动恢复旧指针、服务文件/状态；`python3 deploy/node/install.py --config <私有JSON> --rollback` 回上一版，不回滚用户数据。
灰测的 `deploy/gray-local/node-setup.sh` 生成模拟配置并调用同一安装器，不另写安装流程。
