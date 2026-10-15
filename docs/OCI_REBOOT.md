# Podman 重启恢复

## 原因与处理

个人 OCI 的 Podman `runroot` 与 `tmpdir` 位于数据盘。主机重启后，这两个目录仍保留上次启动的 `tmp/alive` 标记，Podman 因此拒绝启动，报 `current system boot ID differs from cached boot ID`。这是运行态清理问题，不是项目镜像或代码损坏。

初始化沿用 Podman 的启动标记，只有标记属于上一次主机启动时，才在账号级锁内清理并重建该账号的 `run`、`tmp`。持久 `graph`、项目 `oci.json`、代码、依赖、HOME、数据集和结果不进入清理范围。同次启动，以及标记缺失或为空时，保留现有运行态并交由 Podman 正常初始化。没有新增镜像哈希、登记比对或容器清单扫描。

修复由指定节点安装者按正常发布流程安装；贡献者通过 PR 交付，不直接清理线上目录或运行 `podman system reset`。

## 验证

离线回归使用临时目录，覆盖上一轮运行态恢复、原容器与文件保留、同次启动、空/缺失标记、账号隔离和并发初始化：

```sh
python3 -I -B tests/oci-reboot.test.py
python3 -I -B tests/project-security.test.py
```

真实 Podman 灰测必须在隔离容器/虚拟机的专用临时非 root 用户中运行，另提供独立、可写的 `/grey` 测试挂载，不能指向生产数据或使用生产服务账号。测试调用 `podman system migrate`，其 pause 进程按系统用户共享，不随测试目录隔离。需要支持启动 ID 检查的 Podman 5、crun、rootless user namespace 和镜像拉取网络：

```sh
python3 -I -B tests/oci-reboot-smoke.py
```

灰测复现旧启动标记报错，执行两轮恢复，每轮再连续启动三次；核对原容器、可写层内依赖、工作区代码和 HOME 文件。结束时移除本次测试容器、临时目录及该临时用户的 pause 进程。它模拟重启残留，不重启生产服务器，也不替代安装后的实际终端验收。

2026-10-15：本机 WSL 的独立 Docker 测试容器中，以非 root 用户运行 Podman 5.8.7，以上两轮恢复和六次重复启动全部通过。测试环境提供 `/dev/fuse`、`/dev/net/tun`、crun 和 slirp4netns，未使用 privileged 容器；线上节点尚未安装此修复。

Podman 上游说明：[运行态目录](https://portal.example.invalid/en/latest/markdown/podman.1.html#tmpdir-path)、[启动标记检查](https://github.com/podman-container-tools/podman/blob/main/libpod/runtime_linux.go)。
