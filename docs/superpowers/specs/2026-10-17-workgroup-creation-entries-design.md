# Workgroup Creation Entry Wiring Design

## Goal
补齐 DS Bot 原生“创建工作群聊”入口：保留新建聊天菜单中的入口，并在“设置 → 群聊”页面增加同名入口；两个入口都调用现有 `workgroups.create`，普通群创建流程保持不变。

## Scope
- 修改设置页入口链路，使其能够接收当前可用的 `workgroups` 动作。
- 设置页工作群入口只在 Hub 可用时显示；不可用时不显示。
- 复用 `index.js` 中已有的 `workgroupActions.create`，不复制创建、会话注册或 Hub 调用逻辑。
- 为入口可见性、动作接线和普通群入口保留增加回归断言。
- 不新增命令面板专用工作群命令，不调整工作群视图、Hub 协议或普通群创建流程。

## Design
`overlays.js` 已通过 `useWorkgroups` 获取响应式工作群动作。它将该值同时传给 `NewChat` 与 `SettingsDialog`。`SettingsDialog` 将 `workgroups` 传给 `GroupsPage`。`GroupsPage` 在设置页顶部保留现有本地群按钮，并在其后按 Hub 可用性渲染“创建工作群聊”按钮；按钮点击调用 `workgroups.create`，错误交给设置页现有 `run` 错误处理。

两个入口共享同一个动作对象，因此创建后的 `enterWorkgroup`、Session 命名空间、Hub watch 和错误处理只有一个实现。设置页按钮只负责触发动作，不创建本地 room。

## Verification
- 静态回归检查：设置页存在工作群入口，入口受 `workgroups` 条件控制，点击调用 `workgroups.create`，普通群入口仍使用 `setCreating(true)`。
- 构建 DS Bot client bundle，确保源码变更进入发布产物。
- 运行 `integrations/workgroup/tests/bot-entry.spec.ts`；已有失败项需单独记录，不将其误报为本次入口接线失败。

## Risks
- 当前工作区已有大量未提交改动；本任务只触碰入口链路文件和对应测试，不覆盖其他改动。
- 视觉逐像素验收不属于本次入口接线范围。
