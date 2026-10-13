# 前端创意工坊

工坊分享前端主题／布局和功能组件，不是训练项目、数据集或服务器插件；复用当前账号和 API，不修改 GPUQ。仅后端状态声明 `frontendWorkshop.version=1` 时启用；旧门户显示未开放，不试探新接口。

## 怎么用

1. 登录后打开「创意工坊」，搜索作品并查看作者、版本、源码与权限。
2. 主题可以先预览；明确安装后才保存到账号。插件安装后显示在「工作台」。
3. 作者更新作品不会自动升级你的安装版本；更新时重新确认权限。
4. 可以停用单个作品；「恢复默认」移除本人全部安装，不删除作品、不取消训练。
5. 界面异常时，在站点地址后加 `?workshop=off` 重新打开，跳过主题与插件，再恢复默认。

发布时从示例开始，编辑或导入一个 JSON 文件。发布只保存作品，不自动安装／执行；更新沿用作品 ID。丢回包后用原 key 和原内容重试，避免重复版本。作者或管理员可下架；新打开的组件立即拒绝，其他账号已加载组件在下一次配置刷新时停用（正常活跃页面约 60–75 秒），历史版本保留。

发布的源码对其他登录成员可见，不要放入密码、令牌或私有数据。

## 本版支持什么

- 主题：已有颜色令牌、紧凑／舒适密度、普通／宽版、工坊小组件一／两列。不执行 JavaScript，不注入任意 CSS，不改变原有算力页结构。
- 插件：独立 HTML/CSS/JavaScript 工作台面板；读取算力概要、本人任务，导航，经确认取消本人任务。
- 一个账号一个主题、多个插件；安装配置保存在平台 SQLite，不只在当前浏览器。
- 单包最多 128 KiB。不支持 ZIP、外部依赖自动下载、任意原生页面替换或宿主机扩展。

## 作者接口

完整可修改示例在工坊页面；包格式由 `dist/workshop-package.js` 前后端共同校验。

主题使用 `{apiVersion:1,kind:"theme",name,description,theme:{tokens,density,width,columns}}`。令牌键例如 `--bg`、`--ink`，值为十六进制颜色；`density` 为 `compact/comfortable`，`width` 为 `wide/normal`，`columns` 为 `1/2`。

插件使用 `{apiVersion:1,kind:"plugin",name,description,permissions,html,css,script}`。三个源码字段均为字符串，通过 `stargate.call(method,args)` 调用接口；收到 `stargate:update` 事件可重新读取，不要高频轮询。

| 方法 | 参数 | 返回／行为 |
| --- | --- | --- |
| `resources.read` | `{}` | 已授权机器的 GPU 基本指标，未知不当作空闲 |
| `jobs.read` | `{}` | 本人任务的状态与进度，不含命令或凭据 |
| `ui.navigate` | `{page:"work"}` | 工作台、算力、存储、协作区或工坊 |
| `jobs.cancel` | `{jobId:"原任务ID"}` | 主页面确认后调用原取消 API，不自动重试 |

方法须在 `permissions` 中声明。安装不能越过账号本身的权限；没有通用 `api.call`、终端输入、管理员操作或完整前端 store。

## 插件边界

插件运行在无同源权限的 sandbox iframe，通过专用消息通道调用接口，不取得登录 token；账号切换或停用会关闭通道。取消训练须在主页面确认，主站脚本策略不放宽。

**只安装信任作者的插件。** 插件会得到你授权的数据；浏览器不能仅凭此处 CSP 可靠禁止 iframe 自导航产生的外部请求，脚本也可能消耗标签页资源。这里不是任意代码的完全安全或资源隔离保证。恢复入口能跳过插件；关闭网页不会停止服务器训练。

## 开发与验证

`workshop.mjs` 管版本和安装；`dist/workshop-ui.js` 管页面；`dist/workshop-runtime.js` 与 `workshop-frame.mjs` 管主题、组件与受限调用。`GET /workshop/frame/:id/:version` 仅向已安装该固定版本的认证账号提供运行页。

```sh
bash scripts/test-workshop.sh
```

测试用本地 Portal、SQLite 和真实浏览器，不连接生产。源码／本地通过不等于已部署；上线须另做明确灰测验收。
