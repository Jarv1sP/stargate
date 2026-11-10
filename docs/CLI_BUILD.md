# CLI 构建与内嵌原生助手

使用 Node 24、npm 依赖和 Go 构建独立客户端：

```sh
npm run build:release
node build/gpuctl.mjs --help
```

`build:native` 从 `native/campus-http` 编译 Linux、macOS、Windows 各自的
x64/arm64 助手，写入 `build/campus-native/embedded-artifacts.private.json`。
`build:client` 使用 esbuild 打包实际 CLI 导入图，将六个平台的助手分别 gzip
压缩后内嵌到单个 `build/gpuctl.mjs`，不需要下载配套文件或安装解压工具。
独立客户端首次提取所需平台的助手时才用 Node 内置 zlib 解压；帮助命令不解压。
助手原字节、发布版本、缓存路径和已有缓存复用方式不变。

`npm run build` 重建 vendor 和 CLI，使用已有的原生输入；完整发布使用
`build:release` 重新编译六个平台。直接运行源码 CLI 仍读取原生构建输入。
生成文件不提交仓库。回归见 `tests/native-build-entry.test.mjs`，覆盖六个平台
提取字节、缓存版本及帮助命令不解压；下载流和源站替换见
`tests/client-bundle-stream.test.mjs`。

测量已构建 CLI 的单进程峰值 RSS（单位 KiB）：

```sh
node --import 'data:text/javascript,process.on("exit",()=>console.error(JSON.stringify({maxRssKiB:process.resourceUsage().maxRSS})))' build/gpuctl.mjs --help
```

前后对比应使用同一 Node、操作系统、CLI 源码和原生输入，各启动三个新进程，
记录每次峰值和中位数；不要将构建进程内存算进 CLI。
