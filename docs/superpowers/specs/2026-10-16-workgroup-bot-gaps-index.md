# Workgroup Bot 功能补齐需求拆解索引

> 状态：需求与实施拆解基线。本文档及同批四份专项文档只完成需求落地，不执行源码修改、测试、构建、部署或提交。
>
> 关联专项：
> - [Bot 入口与 Hub Provider 契约](./2026-10-16-bot-entry-hub-provider-spec.md)
> - [工作群协作 UI 与实时链路](./2026-10-16-workgroup-collaboration-realtime-spec.md)
> - [审批到原生 Bot 执行](./2026-10-16-workgroup-approval-native-execution-spec.md)
> - [验证与证据矩阵](./2026-10-16-workgroup-verification-evidence-matrix.md)

## 1. 目标与边界

本次需求的目标是核实并补齐实施书中“Bot 一级入口 + 工作群全部功能”的真实产品链路，使用户可以从 Bot 入口配置或恢复 Hub、发现和进入工作群、发送消息并 @ 成员或远程 Bot、上传受 ACL 保护的附件、处理 owner-only 审批，并在任务获批后使用任务所有者本机已有的原生 Bot 和隔离 Task Session 完成执行、进度回写、复核与受控分享。

本批文档把工作拆为四个可独立评审的闭环：

| 工作流 | 目标 | 当前结论 | 先决条件 |
|---|---|---|---|
| W1 | Bot 入口、Hub Provider、准入和身份 | Bot 入口已实现；Provider 契约和准入 UI 未闭合 | 无 |
| W2 | 工作群 UI、消息、附件、成员、实时事件 | 组件级实现存在；生产事件和若干 adapter 未接通 | W1 的登录与房间发现 |
| W3 | 审批、授权、原生 Bot 执行、复核分享 | helper 和服务端规则存在；生产触发链未闭合 | W1、W2 |
| W4 | 测试、真实产品证据和文档基线 | S/M 有部分证据；L/N/P 尚未闭合 | W1、W2、W3 |

只允许在现有两个运行边界内工作：`application/` 和 `server/`。不新增第三个项目、协议项目或独立进程，不重写 DSH Agent Loop。

## 2. 当前事实基线

### 2.1 已确认存在

- `application/packages/bundle/ds-bot/src/client/index.js` 注册单一一级 Bot 入口。
- 入口使用 `id: 'conversation'`，`order: 1`，位于 Plugins 的 `0` 和 Schedules 的 `10` 之间。
- Bot panel 激活后才替换 Bot shell 和 Conversation surface。
- `new-chat.js` 同时保留本地 `Create group chat`，并在可用时提供 `Create workgroup chat`。
- 工作群 Session 使用 `wg:<roomId>`，本地群继续使用本地状态和普通 Session ID。
- `workgroup-pane.js`、`workgroup.js`、`workgroup-style.js` 和 `workgroup-entry.js` 已形成组件级工作群视图。
- Host 侧已经有 Hub URL 解析、Hub session 持久化、登录/恢复、Bridge 启动和多类 Hub endpoint 分支。
- `server/` 已有房间、成员、邀请、消息、附件、任务、审批、记忆、presence、认证、WSS 和持久化限速能力。
- `bridge/index.mjs` 已有 ACK、重连、catch-up 和去重 helper。
- `approvals.mjs`、`policy/dispatch.mjs`、`bot-adapter/flows.mjs`、`task-sessions.js`、`task-grants.js` 已提供部分审批、授权、原生 Task Session 和工具保护基础。

### 2.2 已确认未闭合

- Browser Provider 没有完整暴露 `configured`、`configure()`、`register()`、`rooms()`、`dissolve()`、`uploadArtifact()`。
- `available` 没有同时要求 Hub 已配置且已登录，未登录时可能显示创建工作群入口。
- 当前没有可达的 Hub URL 配置、注册 key、注册、登录/恢复、房间发现和全局账号入口。
- `workgroup-hub.js` 的 `hub-send` 没有把 `mentions` 和 `attachments` 透传到 Hub。
- Host 将 Bridge 事件转给可选的 `rt.onWorkgroupEvent`，但没有找到生产消费者。
- `reduceWorkgroup()` 未成为生产状态源，且没有处理 `presence.changed`。
- 远程 Bot 目录 helper 存在，但没有确认其结果进入工作群 roster 和 mention picker。
- 工作群设置仍复用本地群 action 形状，成员邀请、角色、移除、离开和重命名未完整切换到 Hub action。
- Host `hub-approve-task` 使用 `/tasks/:taskId/approve`，而服务端实际提供的是 `/tasks/:taskId/decision`。
- 审批卡片没有证明按 `ownerUserId/selfUserId` 过滤，也没有提供完整授权范围和 assignment mode 选择。
- 从审批到 grant、原生 Bot、Task Session、进度、取消、review 和受控分享的生产链未找到完整消费者。
- 原版 `+ Reference a chat` 在工作群中没有得到完整接入证据。

### 2.3 当前证据和限制

已运行的聚焦结果：

- `a02-workgroup-view.spec.ts`：6 passed。
- `bot-entry.spec.ts`：16 passed。
- `a11-hub-provider.spec.ts`：10 个测试中 2 failed，失败原因分别是 `configured` 未暴露和 `configure()` 不存在。
- 聚焦总计：30 passed，2 failed。
- Harness 还输出了 `HTTP 503`、`registerSource` 相关 `TypeError` 和 `vite-tsconfig-paths` 弃用警告，这些不能被写成干净的真实产品证据。
- `application/packages/bundle/ds-bot/client.js` 与 `lib/client.js` 当前字节比较结果为 0；源码再次修改后必须重建并重新比较。

当前不能声称：

- L 级真实模型执行已通过。
- N 级双机协作已通过。
- P 级全部平台打包已通过。
- helper、源代码字符串断言或单元测试已经证明真实产品链路可用。

## 3. 需求编号与专项映射

| 编号 | 需求 | 归属专项 | 完成判定 |
|---|---|---|---|
| A0 | 工作群视图可从 `wg:<roomId>` Session 真实打开 | W1/W2 | 真实浏览器进入并渲染，普通会话不受影响 |
| A1 | 工作群样式和 Bot 主题一致 | W2/W4 | 视觉验证通过，不能只以 CSS 文件存在为证据 |
| A2 | 人类成员和远程 Bot 可 @，mention 只生成待审批任务 | W2/W3 | 消息携带稳定 ID，服务端任务为 `PENDING_APPROVAL`，未批准前无执行 |
| A3 | 附件上传、引用、下载 ACL | W2/W4 | 非接收人、跨房间和已移除成员无法下载 |
| A4 | `+ Reference a chat` 权限受控 | W2/W4 | 可引用有权读取的数据，私有数据未经授权不可引用 |
| A5 | 工作群设置和成员管理 | W2 | 全部 action 走 Hub，不调用本地房间 action |
| A6 | 脱敏进度、取消和终止 | W3/W4 | 仅公开允许字段，取消能够阻断后续执行 |
| A7 | Hub 连接和人类在线状态 | W2/W4 | 活跃连接推导，成员可见，断线回落离线 |
| A8 | 原版能力对照矩阵 | W4 | 每项标注继承、差异或未继承，并有证据 |
| A9 | 视觉一致性验证 | W4 | 同尺寸、主题、缩放下完成截图或等价记录 |
| B1-B7 | 注册准入、配置、限速、可信代理和账号自展示 | W1/W4 | 服务端与 Host/UI 口径一致，凭据不回传浏览器 |
| C1-C6 | 活跃连接 presence、成员可见性和在线显示 | W2/W4 | 事件、reducer、UI 和重连回落均通过 |
| D1-D6 | 群记忆配额、软淘汰、审计和既有能力保持 | W4 | 配置、淘汰、ACL、审计和回归测试均有证据 |
| E1-E5 | 派发凭据、进程、网络、DLP、全端点限速 | W3/W4 | 以安全测试和真实执行证据为准，不能由 helper 存在推断完成 |
| F | 真实模型执行链 | W3/W4 | L 级提交、审批、执行、进度、复核和分享完整闭环 |
| G1-G4 | 配置、部署口径和文档状态一致 | W4 | 文档状态可以由当前代码和命令复现 |
| H1-H3 | Windows 路径、Session Log、门禁覆盖 | W4 | 各自有聚焦验证结果 |
| I | 明确延后项 | W4 | macOS、双机和明确暂不需要的 Windows 安装包不被误标完成 |

## 4. 直接影响范围

### 4.1 可能直接修改

- `application/packages/bundle/ds-bot/src/client/workgroup-hub.js`
- `application/packages/bundle/ds-bot/src/host/workgroup-hub.js`
- `application/integrations/workgroup/protocol/hub-client.mjs`
- `application/integrations/workgroup/client/index.mjs`
- `application/integrations/workgroup/bridge/index.mjs`
- `application/integrations/workgroup/client/approvals.mjs`
- `application/integrations/workgroup/policy/dispatch.mjs`
- `application/integrations/workgroup/bot-adapter/flows.mjs`
- `application/packages/bundle/ds-bot/src/client/settings.js`
- `application/packages/bundle/ds-bot/src/client/sidebar.js`
- `application/packages/bundle/ds-bot/src/client/new-chat.js`
- `application/packages/bundle/ds-bot/src/client/workgroup-pane.js`
- `application/packages/bundle/ds-bot/src/client/workgroup.js`
- `application/packages/bundle/ds-bot/src/client/group-settings.js`
- `application/packages/bundle/ds-bot/src/client/workgroup-presence.js`
- `application/packages/bundle/ds-bot/src/host/task-sessions.js`
- `application/packages/bundle/ds-bot/src/host/task-grants.js`
- `application/packages/bundle/ds-bot/src/host/channel.js`
- 对应的 focused tests 和重新生成的 `client.js`、`lib/client.js`。

### 4.2 先验证、无充分证据不改

- `server/src/api/rooms.js`
- `server/src/api/messages.js`
- `server/src/api/tasks.js`
- `server/src/api/memory.js`
- `server/src/api/identity.js`
- `server/src/realtime/events.js`
- `server/src/realtime/hub.js`
- `server/src/security/ratelimit-store.js`
- `server/src/config/index.js`

服务端已有大量实现，第一步应先确认其契约与应用端调用是否一致；不要为修复 adapter 不匹配而新增重复路由。

### 4.3 明确不改

- Bot 一级入口的 `conversation` 语义和 `order: 1`。
- 本地群的 `state.json`、普通 Session ID、本地 roster 和本地 action。
- DSH 原生 Agent Loop。
- 现有两个运行边界之外的第三项目、协议或进程。
- 未经证据支持的无关 UI 重构、格式化或第三方插件改造。

## 5. 实施顺序与停止条件

1. **W1 Provider 与准入**：先让配置、注册、登录、恢复、房间发现和身份状态可用。若 W1 未通过，不进入真实工作群执行验证。
2. **W2 协作与实时**：修复消息参数、附件、目录、设置 action 和 Bridge 事件。若事件消费未闭合，不把轮询或静态测试写成实时协作完成。
3. **W3 审批与执行**：修正决策接口，接通 owner-only scope、grant、Task Session、原生 Bot、进度和 review。若不能证明任务在 owner 机器上隔离执行，保持 NO-GO。
4. **W4 证据与文档**：重跑 S/M/L/N/P 对应检查，按证据更新任务板和 Gap 文档。任何失败或阻塞必须保留原状态和原因。

每个工作流完成后应有独立测试和 review 记录；当前文档阶段不执行这些步骤。

## 6. 文档状态规则

- 本批五份文档是新增需求与设计基线，不覆盖既有 `REQUIREMENTS_GAP_FILL.md`、`TECH_DESIGN_GAP_FILL.md`、`TASK_BOARD.md`。
- 既有文档只有在代码事实和新证据建立后才更新。
- `PASS` 只能表示对应证据等级的检查通过；S/M 不得替代 L/N/P。
- “helper 存在”“接口分支存在”“测试 mock 通过”只能记为组件或测试证据。
- 所有凭据只以配置键名或占位符描述，不在文档记录真实值。
