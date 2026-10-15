# 公共团队账号

本目录是一份独立账号库及 Node/Python 客户端。计算平台和 mission 直接读写同一个 SQLite 文件；没有互调平台 API、双向同步或运行时密码副本。账号库只保存账号、密码记录、团队邀请码、会话和失败登录次数，不保存项目、额度、文件、任务或勋章。

计算平台管理员维护账号和邀请码；mission 内所有登录成员平等，计算平台的角色不会变成 mission 的管理员权限。

## 安装

Node 随 Portal 一起打包 `accounts/`。Python 从同一份源码安装：`python -m pip install ./accounts`。Python 包含公共 `schema.sql`，没有第三方运行依赖。

两容器挂载相同的独立数据目录，并设置：

```text
TEAM_ACCOUNTS_DATABASE=/accounts/accounts.sqlite
TEAM_SESSION_COOKIE_DOMAIN=example.test
```

`TEAM_SESSION_COOKIE_DOMAIN` 是两个站点共有的父域，不含协议或端口；生产只使用 HTTPS。两边共用 `team_session` HttpOnly/Secure cookie 和服务端会话表。CLI 继续使用同一会话 token；退出、停用、改角色和重置密码在两边生效。浏览器切换到新 cookie 名后需重新登录一次。

运行用户通过专用共享组访问账号目录（目录 2770，数据库及 `.key` 0660）；不能挂载另一平台的业务数据。账号目录、业务数据和备份禁止提交 Git。

## 首次提取和切换

1. 指定发布者暂停两个站点的登录写入，停止两个业务容器；保存原应用数据库、WAL/SHM、配套密钥、Compose 和镜像。
2. 先启动新 Portal：从原 `portal_state_v2` 一次提取完整用户 ID、PBKDF2 记录、邀请码和现有会话至公共库，保留所有业务用户 ID 与额度。之后 Portal 状态只保存业务资料；原邀请和会话表被移除，密码不再写进 Portal JSON。
3. mission 配置公共库后再启动。它以公共账号 ID 创建本地业务资料，不按同名自动合并旧用户。旧用户 ID 与任务、讨论、勋章归属保留；本地密码作废。已有业务数据的旧账号需由运维先提供明确映射，不能按用户名猜身份。
4. 验证两个入口、同一账号注册/登录、跨站会话、退出/停用/密码重置与业务页面，再恢复入口。mission 没有管理员设置。

首次迁移只允许一名发布者执行。已有公共账号库时不重复导入其他平台账号。公共库路径或密钥缺失时应修正挂载/恢复备份，不能新建一套账号继续运行。

## 备份和恢复

公共库与 `.key` 必须加入日常备份；原 Portal/mission 的备份任务不能覆盖它。在线一致性备份：

```sh
python -m team_accounts.backup /accounts/accounts.sqlite /backups/accounts-20260101
```

恢复或回退须先停两个容器，保留当前公共库及两个业务库，再恢复同一切换窗口的配套材料；不要将旧 WAL/SHM 混入恢复目录。首次迁移后不要单独启动旧认证版本继续写账号，否则会形成第二套真源。
