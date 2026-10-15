# 开源依赖与出处

原创包元信息标记MIT，第三方保留原版权和许可证；分发时保留随附声明，升级按锁定版本重新核对。为什么：集成或改名不改变上游权利，声明不能随生成物清理一起丢失。

| 项目 | 实际用途/来源 | 原许可说明 |
| --- | --- | --- |
| xterm.js 6.0.0、addon-fit 0.11.0 | 浏览器终端；vendor JS/CSS及配套LICENSE | [MIT](https://github.com/xtermjs/xterm.js/blob/master/LICENSE) |
| Playwright | 离线浏览器验证依赖 | [Apache-2.0](https://github.com/microsoft/playwright/blob/main/LICENSE) |
| esbuild 0.28.2 | 单文件CLI构建 | [MIT](https://github.com/evanw/esbuild/blob/main/LICENSE.md) |
| node-qrcode 1.5.4 | 本地二维码生成 | [MIT](https://github.com/soldair/node-qrcode) |
| Node.js、内置SQLite | Portal/CLI及持久存储 | [Node许可](https://github.com/nodejs/node/blob/main/LICENSE)、[SQLite声明](https://www.sqlite.org/copyright.html) |
| Python | GPUQ与节点运行时，解释器另装 | [PSF等](https://docs.python.org/3/license.html) |
| Tailscale、Headscale | 独立安装的管理网络/可选控制面 | [Tailscale BSD-3-Clause](https://github.com/tailscale/tailscale/blob/main/LICENSE)、[Headscale BSD-3-Clause](https://github.com/juanfont/headscale/blob/main/LICENSE) |
| OpenSSH、Caddy | 受限管理连接与HTTPS服务 | [OpenSSH许可](https://www.openssh.com/openssh/portable.html)、[Caddy Apache-2.0](https://github.com/caddyserver/caddy/blob/master/LICENSE) |
| bubblewrap、slirp4netns | Linux隔离与用户态网络，系统依赖 | [LGPL-2.1](https://github.com/containers/bubblewrap/blob/main/LICENSE)、[GPL-2.0](https://github.com/rootless-containers/slirp4netns/blob/master/COPYING) |
| systemd、Docker/Compose | 资源/生命周期及可选容器部署 | [systemd许可](https://github.com/systemd/systemd/blob/main/LICENSES/README.md)、[Moby](https://github.com/moby/moby/blob/master/LICENSE)、[Compose](https://github.com/docker/compose/blob/main/LICENSE) |
| HAMi-core | 可选GPU共享适配，不含其二进制 | [Apache-2.0](https://github.com/Project-HAMi/HAMi-core/blob/master/LICENSE) |

具体依赖版本及声明以package-lock、随附LICENSE和对应上游版本为准；未实际导入的旧部署版本号不在本页重抄。为什么：锁文件、生成物和系统独立依赖有不同更新生命周期。

Aliyun接口兼容参考[OpenList AliyunDrive Share驱动](https://github.com/OpenListTeam/OpenList/tree/main/drivers/aliyundrive_share)，扫码流程参考[itxve/aliyundriver-refresh-token](https://github.com/itxve/aliyundriver-refresh-token)（原MIT声明，Copyright 2022 itxve）；本仓库不打包OpenList或复用其令牌服务。

GPUQ从实验室既有含源码zipapp整理，保留模块出处；不是将同名第三方项目改为原创，不据此承诺全部高级功能已完成门户授权集成。

Archivo、Geist、Geist Mono自托管WOFF2及SIL OFL 1.1文件保留在`dist/vendor/fonts/`，固定上游提交/下载/轴范围/SHA见该目录README；字标的Archivo轮廓沿用OFL。为什么：字体与改作字标都有独立许可，不能当原创MIT资产删掉配套声明。

训练框架、发行版、NVIDIA驱动/CUDA、模型及数据由部署者另装并遵循其原条款，不包含在本仓库原创MIT声明内。为什么：源码集成不等于取得外部软件或数据的再许可权。
