# Implementation Plan

> **计划状态：待用户审批。** 本文件是已确认 Mini Plan 的正式执行版本。创建本计划不代表开始 Coding；未收到明确批准前不得修改任何实现文件。
>
> **来源：** 当前会话确认的需求、只读代码调查、Impact Map 与 Mini Plan；项目实施依据包括 `技术实施任务书.docx`、`TASK_BOARD.md`、`ACCEPTANCE.md`、`REQUIREMENTS_GAP_FILL.md` 和 `TECH_DESIGN_GAP_FILL.md`。
>
> **执行约束：** 获批后按步骤顺序实施。若发现需要扩大范围、改动服务端协议/schema 或本计划描述与实际实现不符，先暂停并按“Plan Adjustment”记录，等待用户确认。

## 1. Goal

### 本次修改目标

让用户从 DSH 唯一新增的一级 **Bot** 入口进入后，能够完成可用的 Workgroup 流程：配置并登录 Hub、注册/邀请成员、发现与重新打开工作群、使用工作群消息/成员/引用/附件功能、实时看到 presence 与消息/任务状态，并由任务所有人本人批准后在其本机原生 Bot Task Session 中执行获批任务。

执行必须复用当前已有的 Hub 客户端、实时 Bridge、服务端 API、签名与路径策略、原生 Task Session、工具 guard、派发/取消/复核 helper；不能把“helper 存在”或“单测通过”记作真实产品路径已接通。

### 不包含

- 不增加第二个 DSH 一级导航，不移动 Plugins，也不提升 Chief、Bots、普通群或工作群为一级导航。
- 不修改原 DS Bot 本地普通群创建、存储、离线运行行为。
- 不重写 DSH Agent Loop，不用普通 Agent 代替既有原生 Bot，不把跨用户任务放入私人 Session。
- 不新增第三个服务/进程，不把 DSH、DS Bot 或模型凭据移入 Hub。
- 当前 Mini Plan 的目标是复用已有服务端协议和 schema；若实际实现必须修改 `server/` API、协议或数据库迁移，须先提交 Plan Adjustment 并获批。
- 不因代码补齐而宣称完成双机 N 级、真实模型 L 级或 Windows/macOS 发布 P 级验收；条件不具备时继续记录 `BLOCKED` / `NO-GO`。
- 不做无关重构、全面视觉重设计或清理上游代码；工作群同类组件的视觉一致性只按既定验收要求检查并登记差异。

### 成功标准

| ID | 标准 | 证据要求 |
|---|---|---|
| S1 | 真实产品仍只有一个 Bot 一级入口，位于 Plugins 正下方；Bot 内原“创建群聊”仍创建本地普通群，工作群是独立 Hub 实体 | 既有真实产品 UI 检查 + 普通群回归 |
| S2 | 用户在 Bot 内配置 Hub、注册/登录/恢复会话、查看账号 ID 与邀请，并可发现、创建、接受邀请和重新打开工作群 | Host/Client 测试 + 本项目应用浏览器路径 |
| S3 | 工作群设置、成员、远程 Bot、消息、附件与引用均使用 Hub 数据/权限；不得误调本地群操作或读取他人私人 Session | 聚焦测试 + 浏览器操作验证 + 负向授权用例 |
| S4 | Hub 实时消息、成员与 presence 变化可更新当前工作群视图；断线恢复仍依赖已有 ACK/补拉和 Hub 重读 | Remote Events/Bridge 测试 + 实时 Hub 用例 |
| S5 | 只有任务 owner 能决定任务；正确批准后只在其本机以已选原生 Bot 和隔离 Task Session 执行，并执行签名、范围、工具、路径、网络、撤销、成果复核限制 | Host 运行路径测试；真实模型及本人审批按可用条件单独标记 L 级 |
| S6 | 构建、typecheck、lint 与聚焦测试没有新增回归；文档记录实际命令、输出、证据等级和遗留阻塞 | 实际命令输出，不以历史基线冒充本轮结果 |

---

## 2. Current Understanding

### 当前实现方式

DSH 的 Web/Desktop 默认 profile 已装载 `@deepseek-ai/dsh-bot`。Bot 一级入口在 `application/packages/bundle/ds-bot/src/client/index.js` 中注册，使用 `id: 'conversation'` 和 `order: 1`；团队样式由 Bot 面板激活状态门控。因此本次不修改 Bot 一级导航。

Bot 内“新建”菜单在原本地“Create group chat”紧下有“Create workgroup chat”。该入口要求 `workgroups` 非空，调用 Host `hub-create-room` 创建 `kind: 'workgroup'` 的 Hub room，再由 `workgroup-entry.js` 创建 `wg:<roomId>` Session 并导航到已注册的 `WorkgroupPane`。

Host `src/host/workgroup-hub.js` 持有 Hub token、HTTP 客户端和 WSS Bridge；Browser half 通过 `POST /api/bot` 调用 Host，当前没有把凭据返回给渲染端。`hub-client.mjs` 已实现 URL 解析、注册、登录、token 持久化、刷新、退出、身份查询和二进制请求；`client/index.mjs` 已实现 Hub room、邀请、消息、附件、任务和目录等部分能力。

服务端现有 API/数据已覆盖本计划所需的主要基础能力：room kind、房间列表/改名/邀请/成员管理、消息 replies/mentions/attachments、presence、附件 ACL、任务 decision/grants、群记忆配额。当前计划不包含服务端 migration 或新增部署进程。

### 数据流 / 调用链

```text
Web/Desktop profile
  → @deepseek-ai/dsh-bot 单一 Host + Browser bundle
  → Bot 内 Hub 设置/会话/工作群入口
  → Browser workgroupHub adapter
  → POST /api/bot
  → Host workgroup-hub.js：HubClient + WorkgroupClient + Bridge
  → server/ HTTP/WSS + SQLite
  → Host 转发安全筛选后的 Workgroup event
  → DSH Remote Events / Client handler
  → 当前 wg:<roomId> Session 对应的 WorkgroupPane / WorkgroupView
```

任务执行路径必须保持：

```text
本人审批
  → /tasks/:taskId/decision（带 expectedVersion 与批准 scope）
  → 短期签名 grant
  → 本地验签、设备/nonce/任务/目录检查
  → 现有 BotAdapter 三模式选择 + 原生隔离 Task Session
  → 每次工具调用经过 task-grants guard
  → 脱敏进度 → owner 复核 → DLP/受控分享
```

### 数据与状态归属

| 状态/数据 | 当前所有者 | 本计划约束 |
|---|---|---|
| Hub 地址 | 当前由 Host 安装时从 `config.hubUrl` / `WORKGROUP_HUB_URL` / `HUB_PUBLIC_URL` 解析 | 如加入 Bot 内设置，只持久化地址；变更地址须先终止旧 Hub 会话，避免跨 Hub 复用 token |
| Hub 认证凭据 | Host 使用 `hubStatePath(dshHome)` 保存于本地用户数据目录 | 密码和 bootstrap secret 只用于一次请求，不写配置、浏览器持久存储或日志 |
| 本地 Bot/普通群 | DS Bot 的 `state.json` 与原生 DSH Session | 不接受 Hub room 的 ID、成员或设置写入本地群 store |
| Hub room/message/task/artifact | `server/` 数据库与 Hub artifact store | 仍按服务端成员、owner、recipient ACL 决策；客户端状态不作为授权依据 |
| 在线状态 | Hub `realtime.connections` 活跃连接计算 | 只消费同群事件/成员读取，不显示精确时间戳；Bot 状态不等同人类 presence |
| Task Session/grant | DS Bot `task-sessions.js` / `task-grants.js` 持久化 | 复用原生身份绑定与执行 guard，不使用瞬时映射作为身份事实 |

### 已确认的影响范围与不一致记录

- Bot 入口和工作群 pane 的注册路径已有当前代码及测试；`TASK_BOARD.md` 中“Bot 入口修复”属于已完成项。
- `TECH_DESIGN_GAP_FILL.md` / `REQUIREMENTS_GAP_FILL.md` 中“没有 `workgroupHub` provider、WorkgroupView 未挂载”的段落是 2026-10-15 调查快照，与当前代码和 `a11-hub-provider.spec.ts`、`a02-workgroup-view.spec.ts` 不一致。不得重新实现这些已完成部分。
- 当前 Browser `workgroupHub` 没有 `dissolve()` / `uploadArtifact()`，而 pane 已调用它们；Host 有部分相应 endpoint。
- WorkgroupView 复用的 `GroupSettingsForm` 仍含本地 Bot 群字段/本地 actions；Hub 人类成员不能按 `roster.byId` 使用。
- Bridge 回调 `rt.onWorkgroupEvent` 在当前源码无生产消费者；presence reducer 已有纯函数，但未接入实时状态。
- 工作群审批卡当前使用错误的 `/tasks/:taskId/approve` 路径且未提供版本/scope；服务端权威路径是 `/tasks/:taskId/decision`。派发 helper 与 Task Session/guard 已存在，但没有 Host 生产编排调用链。
- 当前验收文档记录了已有测试基线与 BLOCKED 条目。本计划执行时需重跑相关命令并报告真实输出；不得把文档中的旧数字作为本轮结果。

---

## 3. Implementation Steps

### Step 1 — Bot 内 Hub 配置、认证与 Workgroup 发现

#### Target

- Hub 配置、认证与列表 API：
  - `application/integrations/workgroup/protocol/hub-client.mjs`
  - `application/integrations/workgroup/client/index.mjs`
  - `application/integrations/workgroup/package.json`
- Host/Browser 接线：
  - `application/packages/bundle/ds-bot/src/host/workgroup-hub.js`
  - `application/packages/bundle/ds-bot/src/host/channel.js`
  - `application/packages/bundle/ds-bot/src/client/workgroup-hub.js`
  - `application/packages/bundle/ds-bot/src/client/index.js`
  - `application/packages/bundle/ds-bot/src/client/overlays.js`
  - `application/packages/bundle/ds-bot/src/client/settings.js`
  - `application/packages/bundle/ds-bot/src/client/sidebar.js`
  - `application/packages/bundle/ds-bot/src/client/new-chat.js`
  - `application/packages/bundle/ds-bot/src/client/i18n.js`
- 测试：
  - Modify: `application/integrations/workgroup/tests/a11-hub-provider.spec.ts`
  - Modify: `application/integrations/workgroup/tests/a12-hub-provider-e2e.host.spec.ts`
  - Add: `application/integrations/workgroup/tests/a13-workgroup-account-ui.spec.ts`

#### Current Behavior

Host 仅在安装时读取 Hub URL；Browser 有 `signIn`、`signOut`、`resume`、`invitations`、`respondToInvitation` 等 adapter 方法，但没有对应的账号/注册/登录设置界面和完整 Host register/configure endpoint。菜单把“已配置”视为可创建，未登录也会显示创建项。Hub 客户端没有可供 Bot sidebar 使用的已加入 room 列表入口。

#### Change

1. 增加 Host 管理 Hub URL 的调用路径和本地配置读取/写入。配置文件仅存 Hub URL，不含密码、bootstrap secret 或 token；复用 `apiRootOf` / `resolveHubUrl` 验证 URL。用户变更 URL 前必须先退出旧 Hub；旧 Bridge 停止、旧 session 清理后才允许切换，禁止把旧 Hub 的 refresh token 发往新地址。
2. 增加 Host `hub-configure`、`hub-register`、`hub-sign-in`、`hub-sign-out`、`hub-resume`、`hub-list-rooms`、`hub-invitations`、`hub-respond-invitation` 等 endpoint，并在 `createWorkgroupHub()` 暴露对应的方法。注册/登录只经 Host `HubClient` 发送；密码和 bootstrap secret 只在一次调用期间存在。
3. 为 `@deepseek-ai/dsh-workgroup/client` 增加已加入 Hub rooms 的读取方法，使用现有 `GET /rooms`，不新增服务端 schema/API。
4. 在现有 Bot Settings 内提供 Hub 地址、注册/登录/退出、账号 ID/handle 复制、邀请收件箱操作；在 Bot 内侧栏列出 Hub rooms，调用 `enterWorkgroup()` 打开 `wg:<roomId>`。
5. 工作群创建项只在 Hub URL 有效且当前用户已登录时可执行；原本地群入口及其创建函数不变。账号、邀请和房间列表均留在唯一 Bot 一级入口内部。

#### Reason

用户必须能在产品入口内完成 Hub 接入并找到既有工作群，否则存在的 Host/adapter 方法对员工不可用。登录状态不是配置状态；未登录时把创建菜单呈现为可用会导致必然失败。

#### Risk

- Hub URL 与认证 session 必须保持绑定；切换 URL 时不可重用旧 token。
- bootstrap secret/password 不得写入磁盘或日志；Renderer 只可获得身份字段，不可获得 token。
- Web/Desktop 的 Host 数据目录仍按当前应用独立数据根使用，不写官方 DSH 用户目录。
- 不改 Bot 一级导航顺序和普通本地群流程。

#### Verification

- 更新 `a11-hub-provider.spec.ts`：未配置 Hub、配置但未登录、登录、恢复、退出、URL 切换、注册 secret 不进入 view/session config、创建项仅登录后可用。
- 更新 `a12-hub-provider-e2e.host.spec.ts`：真实 Hub 下通过 Host API 注册/登录、列出房间、读取邀请、接受邀请并重新列出 room。
- 新增 `a13-workgroup-account-ui.spec.ts`：用真实 client apply harness 断言账号控件/邀请/room 列表在 Bot 内注册、不新增 `sidebar.panellist` 项。
- 真实产品浏览器路径检查：Bot 唯一入口不变；登录 Hub 后可创建/接受/重新打开工作群；本地“Create group chat”仍走 `create-room`，不走 Hub endpoint。

---

### Step 2 — 工作群成员、设置、附件、mention 与引用调用链

#### Target

- Hub client/Host/Browser 调用：
  - `application/integrations/workgroup/client/index.mjs`
  - `application/packages/bundle/ds-bot/src/host/workgroup-hub.js`
  - `application/packages/bundle/ds-bot/src/host/channel.js`
  - `application/packages/bundle/ds-bot/src/client/workgroup-hub.js`
  - `application/packages/bundle/ds-bot/src/client/workgroup-pane.js`
- 工作群呈现与局部交互：
  - `application/packages/bundle/ds-bot/src/client/workgroup.js`
  - `application/packages/bundle/ds-bot/src/client/group-settings.js`
  - `application/packages/bundle/ds-bot/src/client/workgroup-style.js`
  - `application/packages/bundle/ds-bot/src/client/workgroup-mentions.js`
  - `application/packages/bundle/ds-bot/src/client/composer.js`
  - `application/packages/bundle/ds-bot/src/client/at-menu.js`
  - `application/packages/bundle/ds-bot/src/client/i18n.js`
- 测试：
  - Modify: `application/integrations/workgroup/tests/bot-entry.spec.ts`
  - Modify: `application/integrations/workgroup/tests/a02-workgroup-view.spec.ts`
  - Modify: `application/integrations/workgroup/tests/e-attachments.host.spec.ts`
  - Modify: `application/tests/app-a03-ui-check.mjs`

#### Current Behavior

Pane 调用未由 Browser adapter 暴露的 `dissolve()`、`uploadArtifact()`；下载与附件呈现路径缺失，上传的 `recipients: []` 只允许上传者下载。工作群设置直接复用面向 Bot IDs 的本地 `GroupSettingsForm`，会尝试本地改名/成员/工作目录/权限/固定隐藏。Hub room 的 human member 与已发布 Bot 数据未转换为工作群组件所需的成员模型。工作群 composer 不是原生 Bot composer，不能打开“+ Reference a chat”。

#### Change

1. 在 workgroup adapter/Host/browser 中补齐现有 Hub 能力的 thin wrapper：房间列表/改名、邀请/接收邀请、角色/移除、解散、上传、列出/下载附件、远程 Bot 目录；请求仍经 `POST /api/bot` 到 Host，浏览器不直接持有 Hub credential。
2. 为 `GroupSettingsForm` 保留本地群原样分支；工作群使用 Hub actions 和 Hub room 语义，只提供现有服务端支持的改名、成员角色、邀请/接受/移除、离开/解散。隐藏/固定、Bot reply mode、工作目录、local permissions 等只属于本地 Bot 群的字段不能写入 Hub room，也不能调用 `update-room`。
3. 把 Hub human member 规范化为 `userId/displayName/userHandle/role/online`，把公开 Bot directory 规范化为 `botId/ownerUserId/displayName/ownerDisplayName`。mention 候选必须来自当前 Hub room 成员及其已发布 Bot；保持稳定 ID，非成员和未发布 Bot 不显示、不发送。
4. 附件流程由用户选择文件和明确接收人，Host 使用现有二进制 upload endpoint；工作群消息仅保存 artifact ID。视图读取消息 attachment metadata 并通过 Host 下载 endpoint 取 bytes；Hub 继续按成员和 artifact ACL 逐请求授权。失败/无权限以可见状态呈现，不默认扩大 ACL。
5. 在工作群输入区提供“+ Reference a chat”行为，沿用 DS Bot 原有引用入口/展示交互；选择范围只包含当前用户有权读取的本地会话，传送的是用户明确选择的引用内容，不把私人 Session ID 当作他人访问授权。默认拒绝引用他人私人 Session。Hub 的既有 `replyToMessageId` 仅用于回复工作群消息，不与跨会话引用混用。
6. 保留 DS Bot 原有 `.bt-*` 设计 token、表单 primitives 和 `RoomAvatar`；不创建一套通用群聊产品 UI。

#### Reason

现有 Workgroup UI 结构已在，但部分按钮调用不存在的方法或错误地调用本地 Bot 群 store。修正调用所有者后，才能使工作群与本地群隔离、功能可操作且 ACL 不被绕过。

#### Risk

- Artifact 默认 ACL 是 uploader-only；UI 必须要求显式 recipients，不能因为消息发到 room 就推断所有成员获准下载。
- 他人私人聊天/Session 不得通过 host ID、隐藏菜单或 prompt 获得读取权；引用内容必须是当前用户明确允许分享的数据。
- 本地群的群设置、成员管理、创建逻辑和历史不得改变。
- 如果消息的附件或引用要求改变服务端现有 fields/schema，则暂停并先做 Plan Adjustment；当前目标优先用已有字段/API。

#### Verification

- 聚焦测试断言本地群设置仍调用本地 actions，工作群设置调用 Hub endpoint；Hub human users 不依赖 `roster.byId`。
- 真实 Hub 附件测试：授权 recipient 下载成功；非 recipient、非成员和被移除成员下载失败；消息附件只关联同 room artifact。
- mention 测试：成员和已发布远程 Bot 使用稳定 ID；非成员/未发布 Bot 被拒绝；远程 @ 只产生待审批任务，不触发执行。
- reply/reference 测试：工作群消息 `replyToMessageId` 正确；当前用户有权读取的会话可按用户操作引用；他人私人会话默认拒绝；不发送可用于跨用户读取的裸 Session ID。
- 浏览器检查原本地群流程不变；工作群设置/邀请/附件/引用在同尺寸和主题下与原版复用组件一致，差异逐项记录。

---

### Step 3 — DSH Remote Events 接线与 presence/room 状态消费

#### Target

- Remote Event allowlist/type projection：
  - `application/packages/api/remotes/src/remote-events.ts`
  - `application/packages/api/remotes/src/types.ts`
  - `application/packages/api/remotes/tests/remote-events.host.spec.ts`
- Host/Client Workgroup 事件路径：
  - `application/packages/bundle/ds-bot/src/host/workgroup-hub.js`
  - `application/packages/bundle/ds-bot/src/client/index.js`
  - `application/packages/bundle/ds-bot/src/client/workgroup-hub.js`
  - `application/packages/bundle/ds-bot/src/client/workgroup-pane.js`
  - `application/integrations/workgroup/client/index.mjs`
  - `application/packages/bundle/ds-bot/src/client/workgroup-presence.js`
- 测试：
  - Modify: `application/integrations/workgroup/tests/a02-workgroup-view.spec.ts`
  - Modify: `application/integrations/workgroup/tests/m3-presence-e2e.host.spec.ts`
  - Modify: `application/packages/bundle/ds-bot/test/workgroup-presence.test.js`
  - Add: `application/integrations/workgroup/tests/a14-workgroup-events.host.spec.ts`

#### Current Behavior

`createBridge({ onEvent })` 调用 `rt.onWorkgroupEvent?.(event)`，当前没有生产消费者。Server 会推送 `presence.changed`、消息、成员和任务事件；Browser reducer 对 message/member/task 有部分支持，`applyPresence()` 只有纯函数测试，没有用于 WorkgroupPane 的状态更新。Pane 目前用轮询作为主要更新方式。

#### Change

1. Host `workgroup-hub.js` 收到 Bridge event 后只向 DSH Context 发出允许的 JSON-safe Workgroup notification，不透传 token、scope、grant、Hub error body 或无关字段。
2. 在 `application/packages/api/remotes/src/remote-events.ts` allowlist 中增加一个 typed Workgroup notification；Client `ds-bot` 通过已有 `$on` Remote Events service 订阅，不建立第二条 websocket 或独立进程。
3. Browser handler 只把当前已打开 `roomId` 的事件应用到对应 pane；`message.created` 按 `roomSeq` 去重排序，`member.changed` / `task.*` 对 Hub 重读，`presence.changed` 调用 `applyPresence()` 更新既有 member row。跨房间事件忽略；移除成员的迟到事件不得把成员重新插入。
4. Bridge 的 ACK、重连和 message sequence 补拉继续作为数据恢复依据；无法实时转发时显示 Hub offline/reconnecting 状态，并在连接恢复后重读 room 状态。

#### Reason

当前 Bridge 已收到事件却没有 UI 消费者；存在的 presence reducer 和 Remote Events 框架尚未用于 Workgroup。接线后才能实现实时 presence/message 更新，避免轮询成为唯一刷新机制。

#### Risk

- Remote Events 需要在正确的应用 Host/Client profile 中注册；普通 DS Bot 插件/无 Remote service 的测试 harness 不得因此无法加载。
- forwarded event 只用于展示/刷新，不得单独触发未批准任务执行；任务执行必须由 Step 4 的 owner-approved Host path 再次验证。
- 用户被移除后，后续房间事件不得再作为授权依据；server 的 subscription ACL 仍是安全权威。

#### Verification

- `remote-events.host.spec.ts` 覆盖 Workgroup 事件登记、序列化、Client `$on` 订阅和 dispose 后停止交付。
- `a14-workgroup-events.host.spec.ts` 使用真实 Hub/Bridge 验证 message、member、presence、task event 从 Host 到 Browser pane 可消费；重复事件不重复显示，其他 room event 不改当前 room。
- `m3-presence-e2e.host.spec.ts` 保持 Server 活跃连接/同群可见性测试；DS Bot `workgroup-presence.test.js` 覆盖 online/offline、迟到移除成员和保留未变更成员 identity。
- Hub 断开后本地 DSH、私人 Session 与普通本地群仍可用；恢复后工作群从 Hub 重读。

---

### Step 4 — 本人审批到原生 Task Session 的生产执行链

#### Target

- Helper 使用与包导出：
  - `application/integrations/workgroup/package.json`
  - 复用 `application/integrations/workgroup/client/approvals.mjs`
  - 复用 `application/integrations/workgroup/bot-adapter/flows.mjs`
  - 复用 `application/integrations/workgroup/bot-adapter/cancellation.mjs`
  - 复用 `application/integrations/workgroup/policy/dispatch.mjs`
  - 复用 `application/integrations/workgroup/policy/grant-signature.mjs`
  - 复用 `application/integrations/workgroup/client/review.mjs`
- DS Bot production Host/UI 接线：
  - `application/packages/bundle/ds-bot/src/host/workgroup-hub.js`
  - `application/packages/bundle/ds-bot/src/host/channel.js`
  - `application/packages/bundle/ds-bot/src/host/task-sessions.js`（仅在现有接口不足时修改；先复用现有 durable binding）
  - `application/packages/bundle/ds-bot/src/host/task-grants.js`（仅在现有 guard 接线不足时修改；不削弱 guard）
  - `application/packages/bundle/ds-bot/src/client/workgroup-hub.js`
  - `application/packages/bundle/ds-bot/src/client/workgroup-pane.js`
  - `application/packages/bundle/ds-bot/src/client/workgroup.js`
- 测试：
  - Modify: `application/integrations/workgroup/tests/a06-approvals.spec.ts`
  - Modify: `application/integrations/workgroup/tests/a07-dispatch.spec.ts`
  - Modify: `application/integrations/workgroup/tests/a08-flows.spec.ts`
  - Add: `application/integrations/workgroup/tests/a15-workgroup-native-dispatch.host.spec.ts`

#### Current Behavior

工作群只显示待审批 task strip，未按 `ownerUserId` 过滤；只有 approve/reject 按钮，没有分派模式和批准范围。Browser adapter 的 `answerTask()` 发送 `/tasks/:taskId/approve`，但服务端权威接口是 `/tasks/:taskId/decision`，需 `expectedVersion`、assignment mode、Bot ID 和 scope。Server approval/grants、Task Session、工具 guard、签名验权、`acceptDispatch()`、`runDispatch()`、取消和复核 helper 分别存在，但生产 Bridge event/approval action 没有调用它们形成完整路径。

#### Change

1. 使用现有 `createApprovalClient` (`/tasks/:taskId/decision`) 作为决定 API；错误 endpoint `/approve` 不再使用。本人审批卡只在 `task.ownerUserId === current identity.userId` 且 task state 为 `PENDING_APPROVAL` 时显示；批准需带 UI 当前 task version 与范围。
2. 在工作群审批 UI 中提供现有 `existing_bot`、`chief_auto`、`create_bot` 选项；从 owner 的 Bot directory 获取合法 Bot；收集经本人确认的工作目录、工具、允许 network hosts、到期时间和结果接收者。缺失/无效范围不自动补默认值。
3. owner 在认证客户端批准后，Host 从当前认证身份获取 task scope，使用现有 grant mint、公开签名 key、`verifyGrant`、`acceptDispatch` 校验 grant 签名/nonce/device/task/version/目录；任何本机拒绝都发生在消费 nonce 之前。
4. 用现有 `runDispatch()` 的统一入口实现三种模式。执行器通过现有 `task-session-open`、`task-grant-set` 生成持久映射和工具限制；使用 DSH 原生 session controller 在已绑定 Bot 身份的隔离 Task Session 启动执行，不调用 Bot 私人 Session，不把请求发给普通 Agent。
5. 运行前后把 task version、owner、grant、Bot ID 三方绑定；所有 tool call 继续通过 `task-grants.js` 的 allowlist、realpath、egress、expiry、revocation guard。撤销/取消进入现有 cancellation registry，停止 Agent 回合并等待已登记进程退出；未确认时报告 `UNCONFIRMED`，不可回报成功。
6. 将 owner 的脱敏进度、review-required、keep/reject/share 状态接回工作群视图；发布前复用 `assertContentPolicy` /受控 artifact ACL，分享必须显式列出接收者并由 Hub 验证。
7. 将审批 helper 通过 `@deepseek-ai/dsh-workgroup/client/approvals` package export 提供给 Host，或采用等价的现有包边界内导入；不从 DS Bot 目录跨界相对 import integrations 源码。

#### Reason

当前安全和运行能力存在于 helper、Host task endpoint 与 Server API 的分散部件中；界面路径既调用错误审批 endpoint，又没有生产派发调用。只有将所有现有校验按顺序接入 owner action，才能从待审批状态安全到原生 Bot 执行。

#### Risk

- Task 执行是 P0 安全边界；不能因进度展示、Hub event 或 UI 状态直接运行任务。必须在 owner action 与 Host execute entry 重新验证授权。
- `chief_auto`/`create_bot` 是授权行为，Bot 选择或创建必须落在 owner 的本地队伍和批准范围内。
- 模型链路、真实 B 本人确认、Windows 孙进程和双机运行环境可能不可用；测试必须标清 M/L/N/P，不伪造真实模型/人工确认。
- 若出现 helper 契约不足、需要改 Server grant/approval schema 或需要超出当前 host task grant 的权限，立即暂停并请求 Plan Adjustment。

#### Verification

- 审批单测：只有 owner 的 pending task 显示；requester/admin/第三方无法批准；expectedVersion 过期拒绝；approved scope 被服务端原样记录；批准不等于凭据可直接执行。
- Dispatch 用例：三种模式 converge 到一个 runner；错误 Bot ID、错设备、坏签名、重放、过期、撤销、无效目录/符号链接越界、工具/host 越界全部拒绝且按契约不消费 grant。
- 新增 Host production path 测试：真实 Hub + DS Bot Host runtime 从 owner decision 走 grant→verify→accept→isolated Task Session→tool guard→progress→review；测试中使用明确标注的 stub/mock model 时仅记 M，不代替真实模型 L 级。
- 真实模型链路仅在有效 `DEEPSEEK_BASE_URL`/`DEEPSEEK_API_KEY` 可用且用户批准后运行；否则保留 `BLOCKED`，不输出凭据。
- 取消测试覆盖未授权重试、进行中回合取消、已登记子进程等待退出及不能确认时返回 `UNCONFIRMED`。

---

### Step 5 — 真实产品 UI 回归、文档和执行证据回写

#### Target

- 浏览器验证：`application/tests/app-a03-ui-check.mjs`
- DS Bot 包说明：`application/packages/bundle/ds-bot/README.md`
- 现有 Workgroup 交付记录：
  - `application/docs/workgroup-ai/A03_A04_WORKGROUP_UI.md`
  - `application/docs/workgroup-ai/A06_APPROVALS.md`
  - `application/docs/workgroup-ai/A07_DISPATCH.md`
  - `application/docs/workgroup-ai/A08_FLOWS_CANCELLATION.md`
- 当前项目任务和验收记录：`TASK_BOARD.md`、`ACCEPTANCE.md`
- 文件修改表、Execution Log 与最终状态：本计划文件

#### Current Behavior

现有 `app-a03-ui-check.mjs` 检查 Bot/menu 与 bundle 标记，但工作群真实内容的操作矩阵、像素比较、Host/Client event、approval/dispatch 生产路径未全部在真实产品浏览器中验证。当前文档混有 10-15 旧快照、新旧状态以及 10-16 测试基线；部分证据仍为 BLOCKED。

#### Change

1. 扩展真实产品 UI 检查，使其操作本项目产品的 Hub 账号、工作群创建/列表/打开/消息/成员/附件/审批状态；截图在相同尺寸、主题、缩放下与原版群组件比较，差异逐条登记。
2. 按代码事实更新 Bot/Workgroup README 与 A03/A06/A07/A08 交付说明、`TASK_BOARD.md`、`ACCEPTANCE.md`。旧快照标明历史，不覆盖需求；只有有本轮命令输出/日志/截图的行才更新 PASS。
3. 记录任务 ID、路径、前置条件、改动摘要、实际命令、结果与证据等级、未解决风险。L/N/P 条件无法取得时保留 BLOCKED/NO-GO。
4. 每个实施步骤完成后更新本计划的 Changed Files Tracking 与 Execution Log；若新增计划外文件，先按 Plan Adjustment 流程停下并等待审批。

#### Reason

源码/helper/单测通过不等于用户真实路径可用。历史文档对 Bot 入口和 Workgroup pane 有过时判断；最终记录必须反映当前代码与实际运行证据。

#### Risk

- 真实 Hub/浏览器模型 credentials、本人 B、第二台电脑或跨平台签名环境可能不可用；不能用 mock 或静态检查冒充 L/N/P。
- DS Bot lint 在当前 ACCEPTANCE 基线有既有 error；如复现需与基线对照，不能顺手重构无关文件。
- UI 检查必须打开本项目应用，不安装本项目插件到其他本机 DSH 产品。

#### Verification

- 真实产品浏览器：Plugins/Bot 唯一一级导航与切换无残留；普通本地群工作；Workgroup 所有可达 UI 经 Hub；比较消息、成员、输入、设置的视觉一致性。
- 运行所有当前新增/受影响的 Workgroup 集成测试，以及 DS Bot 包单测和 Browser bundle freshness check；记录既有失败与新增差异。
- 更新 `TASK_BOARD.md`/`ACCEPTANCE.md` 后，检查每项均为已验证、条件阻塞（含所需条件）或明确非目标；保留 `NO-GO` 直至所有发布阻断条件达到对应证据级别。

---

## 4. Changed Files Tracking

> 下表在 Phase 1 先登记计划范围。获批执行后，每实际修改一个文件即更新状态/理由；若出现未登记文件，先暂停并进行 Plan Adjustment。`Action` 只使用 `Add`、`Modify`、`Delete`。

| File | Action | Reason |
| ---- | ------ | ------ |
| `docs/plans/2026-10-16-workgroup-bot-entry-gaps-implementation-plan.md` | Add | 本阶段创建正式执行计划；执行期间继续维护追踪表和日志 |
| `application/integrations/workgroup/protocol/hub-client.mjs` | Modify | 验证并持久化非秘密 Hub URL 配置，绑定当前 Hub session |
| `application/integrations/workgroup/client/index.mjs` | Modify | 补充 Workgroup room discovery/管理/附件所需的 Hub client facade |
| `application/integrations/workgroup/package.json` | Modify | 在 package boundary 中暴露 Host 使用的 approval helper（如按计划复用） |
| `application/integrations/workgroup/tests/a11-hub-provider.spec.ts` | Modify | 验证 Host provider、认证状态、URL 和 view 不泄露凭据 |
| `application/integrations/workgroup/tests/a12-hub-provider-e2e.host.spec.ts` | Modify | 真实 Hub 上验证账号、room discovery 和邀请/接受流程 |
| `application/integrations/workgroup/tests/a13-workgroup-account-ui.spec.ts` | Add | 验证账号/Hub/invitation/room UI 只在 Bot 内注册 |
| `application/integrations/workgroup/tests/a02-workgroup-view.spec.ts` | Modify | 验证 WorkgroupPane 与 adapter 的生产注册/事件消费 |
| `application/integrations/workgroup/tests/bot-entry.spec.ts` | Modify | 保证唯一 Bot 入口及本地群/工作群菜单不回归 |
| `application/integrations/workgroup/tests/e-attachments.host.spec.ts` | Modify | 验证附件接收人 ACL 与工作群消息附件端到端路径 |
| `application/integrations/workgroup/tests/m3-presence-e2e.host.spec.ts` | Modify | 验证 Hub presence 数据和实时变化 |
| `application/integrations/workgroup/tests/a14-workgroup-events.host.spec.ts` | Add | 验证 Bridge/Remote Event/Browser reducer 的 Workgroup 事件路径 |
| `application/integrations/workgroup/tests/a06-approvals.spec.ts` | Modify | 补齐产品 decision endpoint 和本人/scope 的集成断言 |
| `application/integrations/workgroup/tests/a07-dispatch.spec.ts` | Modify | 验证 production Host 使用签名、nonce、device 与目录策略 |
| `application/integrations/workgroup/tests/a08-flows.spec.ts` | Modify | 验证原生 Bot runner 与三种分派的生产调用适配 |
| `application/integrations/workgroup/tests/a15-workgroup-native-dispatch.host.spec.ts` | Add | 验证 Hub owner decision 到原生隔离 Task Session 的 Host 集成链 |
| `application/packages/api/remotes/src/remote-events.ts` | Modify | 在 DSH allowlist 声明安全筛选后的 Workgroup notification |
| `application/packages/api/remotes/src/types.ts` | Modify | 保持 Remote Event key 的类型投影与 allowlist 一致 |
| `application/packages/api/remotes/tests/remote-events.host.spec.ts` | Modify | 覆盖 Workgroup event forwarding、订阅和 teardown |
| `application/packages/bundle/ds-bot/src/host/workgroup-hub.js` | Modify | 接入配置、账户、room、event 与批准后派发 orchestration |
| `application/packages/bundle/ds-bot/src/host/channel.js` | Modify | 添加受控 Hub/Task Host endpoint 路由，维持现有 read-only/锁规则 |
| `application/packages/bundle/ds-bot/src/client/workgroup-hub.js` | Modify | 暴露与 Hub/Host 已实现 endpoint 对齐的 browser facade |
| `application/packages/bundle/ds-bot/src/client/index.js` | Modify | 注入 Workgroup event handler 与账户/Hub reactive state，不增加一级入口 |
| `application/packages/bundle/ds-bot/src/client/overlays.js` | Modify | 向现有 Bot 设置/新建 UI 传入 Hub state 和 actions |
| `application/packages/bundle/ds-bot/src/client/settings.js` | Modify | 在原 Bot Settings 内提供 Hub/account/invitation UI |
| `application/packages/bundle/ds-bot/src/client/sidebar.js` | Modify | 在 Bot 内列出并重新打开 Hub Workgroups，保留本地列表 |
| `application/packages/bundle/ds-bot/src/client/new-chat.js` | Modify | 仅在有效登录状态下启用工作群创建项；保持本地群入口逻辑不变 |
| `application/packages/bundle/ds-bot/src/client/i18n.js` | Modify | 为新增 Bot 内可见文案增加现有 locale 字典项 |
| `application/packages/bundle/ds-bot/src/client/workgroup-pane.js` | Modify | 接入解散/附件/实时事件/审批/派发/取消数据流 |
| `application/packages/bundle/ds-bot/src/client/workgroup.js` | Modify | 展示 Hub 人类成员、远程 Bot、附件、引用和 owner-only 任务卡 |
| `application/packages/bundle/ds-bot/src/client/group-settings.js` | Modify | 区分本地群与 Workgroup 操作，禁止把 Hub room 写入本地 store |
| `application/packages/bundle/ds-bot/src/client/workgroup-style.js` | Modify | 为新增 Workgroup 控件复用 Bot 设计 tokens 并支持验收布局 |
| `application/packages/bundle/ds-bot/src/client/workgroup-mentions.js` | Modify | 规范化远程 Bot/member mention stable IDs |
| `application/packages/bundle/ds-bot/src/client/composer.js` | Modify | 在 Workgroup composer 提供经授权的数据引用入口 |
| `application/packages/bundle/ds-bot/src/client/at-menu.js` | Modify | 复用现有引用插入/序列化规则并限制 Workgroup 可引用来源 |
| `application/packages/bundle/ds-bot/src/client/workgroup-presence.js` | Modify | 将 `presence.changed` reducer 接入 Workgroup room state |
| `application/packages/bundle/ds-bot/test/workgroup-presence.test.js` | Modify | 覆盖实时 presence 更新与迟到事件边界 |
| `application/tests/app-a03-ui-check.mjs` | Modify | 扩展真实产品浏览器检查至 Hub Workgroup 操作和导航回归 |
| `application/packages/bundle/ds-bot/README.md` | Modify | 记录 Hub/Workgroup 用户流程及已知阻塞/限制 |
| `application/docs/workgroup-ai/A03_A04_WORKGROUP_UI.md` | Modify | 回写当前 Workgroup UI 真实挂载、交互和视觉证据 |
| `application/docs/workgroup-ai/A06_APPROVALS.md` | Modify | 回写 owner-only UI 到 Hub decision 的生产接线证据 |
| `application/docs/workgroup-ai/A07_DISPATCH.md` | Modify | 回写 Host 生产验签/接受派发路径与边界证据 |
| `application/docs/workgroup-ai/A08_FLOWS_CANCELLATION.md` | Modify | 回写原生执行、取消和未确认结果的生产路径 |
| `TASK_BOARD.md` | Modify | 按实际测试更新 Workgroup 任务状态与执行证据 |
| `ACCEPTANCE.md` | Modify | 更新本轮基线、L/N/P 状态及 BLOCKED/NO-GO，不覆盖未验证项 |

---

## 5. Verification Checklist

### 主流程验证

- [ ] 使用本项目 Web/Desktop profile 打开唯一 Bot 入口；Bot 菜单在 Plugins 正下方，原“创建群聊”保持本地行为。
- [ ] Bot 内设置 Hub 地址并注册/登录；状态返回不包含 password/bootstrap secret/access token/refresh token。
- [ ] 创建 Workgroup、邀请另一用户、接受邀请；Workgroup 列表可再次打开已存在的 `wg:<roomId>`。
- [ ] 发送、接收消息与 mention；附件经显式 recipients 授权后可下载；回复/引用仅按授权数据工作。
- [ ] B 的认证客户端显示并批准自己的任务；以 native isolated Task Session 运行为获批 Bot，按批准范围发布脱敏进度并受控分享结果。

### 关联流程验证

- [ ] DSH 会话、插件、设置、Bot 私聊、普通群在 Bot/非 Bot 页面切换后不残留 UI 覆盖。
- [ ] Workgroup 群设置调用 Hub endpoint；原本地 GroupSettingsForm 行为不变。
- [ ] Bridge message/member/task/presence event 更新 WorkgroupPane；断线补拉和 Hub 重读修复状态。
- [ ] `existing_bot`、`chief_auto`、`create_bot` 三种分派走同一安全 runner；owner review/share 调用现有 review helper。

### 边界情况验证

- [ ] Hub 未配置、配置未登录、登录过期、Hub 不可达、用户退出、Hub URL 切换；本地 DSH/Bot/普通群始终可用。
- [ ] 邀请拒绝/过期、成员被移除、同一事件重放、跨 room 事件、Hub 多设备在线/全部离线。
- [ ] 非 owner 不能审批或查看 owner scope；旧 expectedVersion、错设备/错 Bot、坏签名、重放、过期/撤销 grant 均拒绝。
- [ ] 缺失/无效/越界/symlink 目录、未批准工具/出站 host、附件非接收人下载、未授权私人会话引用均拒绝；无静默 fallback。
- [ ] 子进程未确认退出时明确报 `UNCONFIRMED`，不得报告任务安全结束。

### Test

- [ ] `cd application && npx vitest run integrations/workgroup/tests/a11-hub-provider.spec.ts integrations/workgroup/tests/a12-hub-provider-e2e.host.spec.ts integrations/workgroup/tests/a13-workgroup-account-ui.spec.ts integrations/workgroup/tests/a02-workgroup-view.spec.ts integrations/workgroup/tests/e-attachments.host.spec.ts integrations/workgroup/tests/m3-presence-e2e.host.spec.ts integrations/workgroup/tests/a14-workgroup-events.host.spec.ts integrations/workgroup/tests/a06-approvals.spec.ts integrations/workgroup/tests/a07-dispatch.spec.ts integrations/workgroup/tests/a08-flows.spec.ts integrations/workgroup/tests/a15-workgroup-native-dispatch.host.spec.ts`：新增/受影响聚焦测试通过；记录现有基线失败，不把既有失败归因于本次改动。
- [ ] `cd application/packages/api/remotes && pnpm exec vitest run tests/remote-events.host.spec.ts`：Remote Event forwarding 与 disposal 用例通过。
- [ ] `cd application/packages/bundle/ds-bot && node --import ./test/harness-resolve.mjs --test "test/*.test.js"`：DS Bot 测试无新增失败；已知 `dsh-update.test.js` 基线失败须单独注明。
- [ ] `cd application && npx vitest run integrations/workgroup/tests/`：运行完整 Workgroup 集成车道，对照既有 `f13-child-process.host.spec.ts` 超时基线并说明任何差异。
- [ ] `server/` 无源码/schema 修改时，不把旧服务端数字称为本轮测试结果；如因 Plan Adjustment 修改 server，按新范围运行 `cd server && node --test "tests/*.test.js"`。

### Build

- [ ] `cd application/packages/bundle/ds-bot && node scripts/build-client.mjs --check`：Client bundle 与源码一致。
- [ ] `cd application && pnpm run build`：目标应用构建/gates 成功；如出现既有基线问题，逐项记录，不隐藏失败。
- [ ] 用本项目 profile 实际启动 Web；在可用 Desktop 环境时用本项目 Desktop profile 验证同一接线；不得安装本项目插件到其他本机 DSH 产品。

### Lint

- [ ] `cd application && pnpm run lint` 与 `cd application/packages/bundle/ds-bot && node scripts/lint.mjs`：修改文件无新增 lint 问题。当前 `ACCEPTANCE.md` 记录 ds-bot lint 有一个 `scripts/build-lib.mjs` 既有 error；重跑时需与基线区分。

### Typecheck

- [ ] `cd application && pnpm run typecheck`：Remote Events 类型、事件 payload、Host/Client build faces 通过；不通过时只修复本计划新增类型/调用，不顺手重构其它包。

### 浏览器 / 证据等级

- [ ] 扩展并运行 `application/tests/app-a03-ui-check.mjs`，针对本项目应用与真实 Hub 完成 Bot 导航、工作群创建/重新打开、成员/消息/附件/审批以及切回本地群回归；截图对同尺寸/主题/缩放比较并记录差异。
- [ ] 若有效模型凭据、真实 B 本人、第二台电脑或签名发布环境不可用，分别保留 L/N/P 为 `BLOCKED`，写明所需条件；M/S 测试不得替代这些等级。

---

## Execution Log

- Phase 1 completed: created this plan document only.
- Coding status: **Not started; waiting for explicit user approval of this plan.**
- No implementation files have been changed and no tests/build/lint/typecheck have been run for this plan.
