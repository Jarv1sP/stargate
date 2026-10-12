# 项目工作区

配套门户和节点升级后使用。文件不随任务结束或断开连接删除；GPU 单独申请和释放。不自动跨服务器移动文件。

## 开发与运行

```sh
gpuctl use gpu-1
gpuctl project create experiment-a
gpuctl push .
gpuctl ssh
# 在容器里安装依赖、编辑文件
python -m pip install -r requirements.txt
exit

# 直接运行，无需 project publish
gpuctl run -g 1 -- python train.py
# 上传本地代码后直接运行，不生成版本
gpuctl run --sync -g 1 -- python test.py
```

网页提交也默认运行当前工作区。

上传中断后重复原 `push`：先核对原上传 ID、路径、文件大小与 SHA-256，从服务器已确认的字节继续。旧记录缺少恢复证明或提交结果未确认时停止，不自动替换未完成上传。

## 连续使用 GPU

```sh
gpuctl run -g 1 --interactive
gpuctl jobs
# 等任务 RUNNING 后连接；JOB_ID 是上一步返回的编号
gpuctl ssh --job JOB_ID
```

同一个 shell 可以连续测试、调试和训练，不必每条命令重新提交。网络断开后用同一 `ssh --job JOB_ID` 重连。断开不释放 GPU；输入 `exit` 或执行 `gpuctl cancel JOB_ID` 才结束本次占用。文件和已安装的环境保留。

交互终端不会自动重放手动命令，不支持自动恢复或自动扩卡；需要这些能力时，用普通 `run -- 训练命令` 并接入 checkpoint。

这是 HTTPS 交互终端，不是宿主 SSH/root，也不表示支持 VS Code Remote SSH 或 SFTP。CPU 开发终端仍不占 GPU。

## 路径

| 路径 | 用法 |
| --- | --- |
| `/workspace` | 项目代码，可读写；多个任务共用 |
| `/data/hdd`、`/data/ssd` | 配置的本机共享数据目录，只读；不复制、不准备缓存 |
| `/data/mine` | 个人可写数据目录，用于下载和预处理；任务间保留 |
| `/home/gpuq`（`$HOME`） | 持久缓存、用户配置 |
| `/outputs` | 持久输出；是否按实验建子目录由你决定 |
| 容器内 Python/Conda、系统包 | 终端与训练共用安装结果 |

并发任务写同一文件仍可能互相覆盖，像普通 SSH 一样由你组织目录。平台不强制每个任务另建输出目录，也不因启动任务复制数据集。

`gpuctl pull --job JOB_ID model.pt ./model.pt` 读取该项目当前 `/outputs/model.pt`，不是输出快照；旧任务仍读取原来独立的输出目录。

## 停止、历史与跨机

`gpuctl cancel JOB_ID` 只停止这一项任务。取消、抢占或崩溃不会回滚已写文件，也不保证保存内存中的训练状态；恢复仍需要程序写 checkpoint。

工作区在哪台机器，就在那台运行。自动选机只选已有同名工作区的机器；代码和数据应先显式同步。开始训练不会自动复制、发布或准备缓存。
