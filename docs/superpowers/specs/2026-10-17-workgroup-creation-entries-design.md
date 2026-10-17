# Workgroup Creation Entry Wiring Design

## Goal
补齐 DS Bot 原生“创建工作群聊”入口：新建聊天菜单、设置 → 群聊、命令面板三处各有一个入口，且都调用现有 `workgroups.create`；普通群创建流程保持不变。

## Scope
- 修改入口链路，使菜单、设置页和命令面板都能接收同一份 `workgroups` 动作对象。
- 三处工作群入口共享 `index.js` 中的 `workgroupActions.create`，不复制创建、会话注册或 Hub 调用逻辑。
- provider 始终提供动作对象：Hub 未配置、未连通或仍在 bootstrap 时，入口仍然显示；点击后由现有错误路径显示 Host 返回的稳定原因，而不是把入口隐藏。
- 为三处入口的可见性、顺序、动作接线和普通群入口保留增加回归断言。
- 不调整工作群视图、Hub 协议或普通群创建流程。

## Design
`index.js` 的 provider 不再根据 `workgroupHub.available` 返回 `undefined`，而是始终向 `overlays.js` 提供 `workgroups`。`overlays.js` 将该值传给 `NewChat`、`SettingsDialog` 和 `CommandPalette`。

- `NewChat` 在工作群入口紧接本地 `Create group chat` 之后渲染。
- `SettingsDialog` 将 `workgroups` 传给 `GroupsPage`，工作群按钮紧接本地群按钮。
- `CommandPalette` 在 `cmd:group` 之后增加 `cmd:workgroup` 命令，点击调用 `workgroups.create()`。

三个入口共享同一个动作对象，因此创建后的 `enterWorkgroup`、Session 命名空间、Hub watch 和错误处理只有一个实现。入口只负责触发动作，不创建本地 room。

## Verification
- 静态回归检查：三处入口都存在、顺序紧邻本地群入口、都调用 `workgroups.create`；provider 始终提供动作对象；普通群入口仍使用原流程。
- 构建 DS Bot client bundle，确保源码变更进入发布产物，并运行 `build-client.mjs --check`。
- 运行 `integrations/workgroup/tests/a04-workgroup-entry-wiring.spec.ts`、`bot-entry.spec.ts`、`a11-hub-provider.spec.ts`、`a14-hub-settings.spec.ts`。

## Risks
- 当前工作区已有大量未提交改动；本任务只触碰入口链路文件和对应测试，不覆盖其他改动。
- 视觉逐像素验收不属于本次入口接线范围。
- Hub 未就绪时的用户提示取决于 Host 返回的稳定错误文案，本次没有新增 Hub 配置页面。
