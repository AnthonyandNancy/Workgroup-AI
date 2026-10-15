# application/｜用户应用（独立发行）

**这个目录不是服务器发布目录。** 获取并 Fork DSH 完整源码后，将其原生 root（`apps/`、`packages/`、脚本、锁文件等）放在 `application/` 下保留工作区结构；把 Fork DS Bot 内置模块固化到 `packages/bundle/ds-bot/`（嵌套 upstream clone 保留在 `integrations/ds-bot/upstream/` 作为上游归属与差异证据），把工作群本地客户端与任务执行适配放在 `integrations/workgroup/`。

## 运行的内容

- 每个用户本地的 DSH Host：模型、Agent Loop、Session、工具、权限与执行。
- DeepSeek-Bot：原版 Chief、下属 Bot、私聊、普通群聊及全套 Bot UI。
- Workgroup：工作群 React UI、Hub Bridge、鉴权/审批 UI、隔离原生 Bot Task Session、执行层强制权限。

## 项目内文件归属

`docs/` 为应用的操作/开发规范；`tests/` 为 app UI 与真实 Host 集成回归；`integrations/workgroup/protocol/` 只生成/保留服务端契约的客户端视图，不定义新的服务器规则。

## 用户安装后的默认行为

首次启动有 Chief；DSH 一级导航“插件”正下方只有 Bot。进入 Bot 后才能看到原版内部功能，“创建群聊”下方增加“创建工作群聊”。未配置 Hub 时工作群提示配置，原版私聊和普通群仍可用。

## 起步门禁

必须先真实克隆并锁定上游，运行原版 Desktop/Web/DS Bot，再做最小 Fork。此交接包没有把空目录当成已内置的源码。
