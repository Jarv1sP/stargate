# 节点发布包（仅离线准备）

在精简线仓库执行，机器 ID 由清单传入；输出目录必须不存在：

```sh
python3 -I -B scripts/build-node-release.py --output /tmp/node-release-review \
  --machine node-a --machine node-b --machine node-c --machine node-d
```

每个机器目录包含一份共同 `node/`、`gpuq.pyz`、六类 `profiles/<profile>/node-config.template.json` 和 `manifest.json`。脚本只取 Git 跟踪的 Python 源码及 `gpuq-network`/`gpuq-ray`，不会打包私有配置、密钥、数据库、缓存或 pyc。node 文件只读；pyz 使用固定时间戳，四包源码和 pyz 的 SHA 完全相同。

manifest 列出共同 node 文件 SHA、实际 pyz 成员 SHA、固定入口和服务命令、模板 SHA、私有配置摘要及回退对象的空占位。`{release}` 是将来安装目录的占位符。脚本不执行这些命令，`scopeReview=pending`、`binding=not-wired`；没有 SSH、systemd、安装或切换步骤。

模板中的 null 待 m2 从各机**各身份现有完整配置**填入；不复制其他机器的路径、卡数、内存池、存储角色或管理员权限。模板不代表该机有对应 SSH 身份；缺少的 R6t/1zz 绑定不新建，三机训练身份的映射等待 C4 scope 比对结论。实际配置文件仍用 `node-config.json`，不由运行时合并模板。

C4 scope 比对及总控审核通过后，m2 才能填入脱敏配置摘要和回退对象，并按既有安装门禁接线。collector、rsync 和历史 GC/unit 的实际消费者由 m2 按 C4 §6.1 核对，当前构建不改它们。
