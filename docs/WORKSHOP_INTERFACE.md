# 工坊整站界面

插件作品增加可选 `presentation: "interface"`。安装后自动替换整个可见门户，
不是项目页里的小组件；未填写此字段的插件继续按小组件展示。
作品仍使用同一个 opaque-origin iframe、CSP 和已声明权限，不获得额外接口。

同一账号只安装一个整站界面。安装另一个会替换前一个，但保留原有主题及普通插件。
右下角「恢复平台界面」通过现有 `workshop.uninstall` 停用此作品；
「安全打开平台」进入 `?workshop=off#workshop`，即使作品报错也能恢复操作。
底层门户在整站界面运行时不可交互，停用、退出账号或销毁运行器时恢复。

## 仓浪模拟界面

从用户提供的离线演示目录生成安装即进入的作品：

```sh
node scripts/package-ceake-workshop.mjs SOURCE_DIRECTORY OUTPUT.json
WORKSHOP_ROOT=. node tests/ceake-workshop-package-smoke.mjs OUTPUT.json
```

生成物是零权限插件，包含本地压缩的界面脚本，不发起外部请求。
模拟数据仅在组件内存中存在；Notebook 同窗切换；日志/虚拟文件导出展示可复制文本。
它不是平台真实任务的操作界面，不修改训练、容器、资源或账号。
源 ZIP、PDF、参考截图及生成的作品包不随仓库提交。

发布到线上工坊前，必须先部署支持 `presentation` 的门户代码；
之后发布作品新版本并安装该版本，才能得到整站界面。

## 相关验证

- `node tests/workshop-api.test.js`：整站展示字段、按账号替换和普通插件/主题保留。
- `node tests/workshop-interface-ui-smoke.mjs`：真实 Portal/SQLite 的安装、整屏尺寸、
  模拟操作、刷新保持、恢复平台、其他账号隔离和安全模式。
- `tests/ceake-workshop-package-smoke.mjs`：完整仓浪演示包在实际 CSP/运行器下自动打开、
  日志、同窗 Notebook、模拟创建和退出。
- 既有 workshop frame、HTTP、runtime 浏览器测试覆盖原隔离与权限行为。
