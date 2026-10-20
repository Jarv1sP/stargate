# AISpace 参考主题

打开「工坊」→「AISpace 参考布局」→ 安装。仅改变本人界面，刷新后保留；
恢复入口见[使用指南](USER_GUIDE.md#workshop)。不会创建任务或改变训练。

## 实现

- `dist/themes/aispace.css`：蓝绿顶栏、浅色侧栏、紧凑表格与响应式布局。
- `dist/themes/aispace.js`：`mount({store})` 返回 `render` / `dispose`，只读当前 store，
  复用原任务按钮、筛选、日志、输出、诊断、留言和恢复操作，不新增接口。
- 工坊包 `theme.layout: "aispace"`；运行时设置 `body.dataset.workshopLayout`，
  发出 `stargate:theme-change`。默认主题恢复原标签、位置并移除附加元素。
- 内置主题由 `workshop.mjs` 首次启动写入；不会覆盖团队后续版本或恢复已下架作品。

参考为用户提供的七页使用说明 PDF，已核对任务表格及详情日志页。
按现平台字段映射，不引入旧审批、镜像保存、数据版本等流程；
不复刻 JupyterLab / WinSCP，不声称逐像素一致。私有参考文件与截图不入库。

## 验证

`node tests/workshop-ui-smoke.mjs` 验证真实门户的安装、刷新保留、账号隔离和恢复。
`node tests/aispace-theme-ui-smoke.mjs` 验证成员/管理员在 1440/390/320 宽度下
原任务操作、创建人、失败/未知状态、详情日志标签与布局恢复。
全部使用隔离数据库或模拟任务，不操作生产训练。
