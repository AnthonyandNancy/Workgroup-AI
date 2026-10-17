# Workgroup AI｜V1 缺口补齐技术设计

> 阶段：**代码调查与技术方案设计**（2026-10-15）。Requirement 来源：`REQUIREMENTS_GAP_FILL.md`（第 5 版·定稿）。
> 本文回答"为了满足已确认需求，现有系统需要发生什么变化"，**不含实现代码**，止于接口与职责设计。
> 结论中的每条事实都有源码位置或实测支撑；推测项已显式标注。

---

# 当前系统

## 当前流程

### 流程 1：应用启动与 Bot 入口（真实存在，已验证）

```text
DSH 启动（Electron/Web + 本机 Host）
↓ 加载 profile 的 cordis.patch.yml
packages/bundle/ds-bot/cordis.patch.yml → 挂载 @deepseek-ai/dsh-bot（host half）
↓ 浏览器侧：package.json 的 dsh.client manifest → ./client 导出
client.js → apply(ctx)
↓ ctx.get('workgroupHub')
【事实 A】整个仓库没有任何 provide('workgroupHub') → 恒为 undefined
↓ hub === undefined
workgroups = undefined
↓
new-chat.js 菜单不 push「创建工作群聊」入口
↓
Bot 一级入口注册（id='conversation', order=1）→ 团队表面（shell + conversation 两组）
```

**证据**：`src/client/index.js:715`、`:732-743`、`src/client/new-chat.js:106-107`；全仓检索 `workgroupHub` 仅 3 处命中（客户端读取点 + 2 份构建产物），**无提供者**。

### 流程 2：普通群聊（真实存在，本地）

```text
用户点击团队列表的创建控件 → NewChat 菜单
↓ 选「Create group chat」
new-chat.js:77 → actions.createRoom([admin, ...picked], { admin, greet })
↓ host 通道 call('create-room')
channel.js:249 → rt.createRoom(...)
↓ host/roster.js:283 createRoom
createSession(title) 建宿主 Session（群本身的会话，用于接力）
↓ state.rooms[id] = { id, name, members, admin, mode, notice, createdAt, createdBy }
↓ rt.save() 持久化到 <WORKGROUP_HOME>/bot/state.json
actions.openSession(room.id)
↓
会话以本地 room.id 作为 SessionId → 渲染团队自己的群聊界面
（roster.roomsById[sessionId] 命中 → cells.js/header.js 等按群聊渲染）
```

**证据**：`src/client/new-chat.js:70-95`、`src/host/channel.js:249-255`、`src/host/roster.js:283-310`、`src/client/cells.js:199`、`src/client/cells.js:357-362`。

### 流程 3：工作群创建（代码存在，**生产路径不可达**）

```text
client/index.js:732  workgroups = hub === undefined ? undefined : { create: ... }
↓ （前提：hub 有值）
hub.createRoom(newWorkgroupName(), { kind: 'workgroup' })
↓ 期望：Hub POST /api/v1/rooms
【事实 B】server/src/api/rooms.js:71-78 只读 body.name，kind 被静默丢弃
【事实 C】rooms 表（db/migrations/0001_schema.sql:23-29）无 kind 列
↓
workgroupSessionId(created.id) = `wg:<roomId>`
↓
actions.openSession('wg:<roomId>') → ctx.uiWorkspace.openSession(target)
↓
【事实 D】没有任何代码把 'wg:' 会话映射到 WorkgroupView：
   - src/client/index.js 只导入 newWorkgroupName / workgroupSessionId
   - isWorkgroupSession / roomIdOfSession 定义在 workgroup.js:236-248，零调用点
   - WorkgroupView（workgroup.js:130）从未被 import
↓
会话 id 未知于 roster（byId 与 roomsById 均不命中）
→ index.js:491 / :936 的判定均不匹配
→ Conversation 渲染该会话为空会话
```

**结论**：工作群**整条链路在生产路径上不可达**。`workgroupHub` 无提供者（A）⇒ 菜单没有入口 ⇒ 即使有入口，`wg:` 会话也无渲染路径（D）。

### 流程 4：集成层（代码完备，**仅被测试引用**）

```text
integrations/workgroup/protocol/hub-client.mjs   Hub HTTP 客户端：注册/登录/刷新、请求封装、身份
integrations/workgroup/bridge/index.mjs          WSS：ACK、重连、roomSeq 补拉、幂等
integrations/workgroup/client/index.mjs          房间/成员/邀请/消息/任务/Bot 目录的读与写
integrations/workgroup/client/approvals.mjs      审批三元组与 scope
integrations/workgroup/client/review.mjs         脱敏进度、成果分享
integrations/workgroup/policy/dispatch.mjs       本地派发决策（目录 realpath、根边界、一次性 nonce）
integrations/workgroup/bot-adapter/flows.mjs     三种分派模式，三 id 一致性校验
integrations/workgroup/bot-adapter/cancellation.mjs  撤销与进程终止
```

**证据**：全仓检索 `integrations/workgroup/{client,bridge,protocol,policy,bot-adapter}` 的生产引用为 **0**；唯一引用者是 `integrations/workgroup/tests/*.spec.ts` 与 `integration/ds-bot/tests/apply-harness.mjs`（后者 `provide: () => noop`，即**不注入**任何服务）。

## 当前数据模型

### 服务端（SQLite，8 个迁移）

| 表 | 关键字段 | 与需求相关 |
|---|---|---|
| `users` | `id, user_handle, display_name, password_hash, status(active/disabled), created_at` | **无 role 列**；`publicUser` 已返回 `id/userHandle/displayName/status` → 支撑"我的账号"展示 |
| `devices` | `id, user_id, public_key, fingerprint, revoked_at, last_seen_at, created_at` | `last_seen_at` **仅登录/刷新时更新**；不能直接当"设备在线" |
| `rooms` | `id, name, owner_user_id, next_seq, created_at` | **无 kind**；`next_seq` 是 roomSeq 来源 |
| `room_members` | `room_id, user_id, role(owner/admin/member), joined_at, removed_at` | 已有房间级角色 |
| `messages` | `id, room_id, room_seq, sender_user_id, client_message_id, body, created_at, reply_to_message_id` | 已有幂等键（`UNIQUE(room_id, sender_user_id, client_message_id)`）与回复列；**无 mention 结构**、**无附件引用** |
| `group_memories` | `id, room_id, author_user_id, source_message_id, body, acl_json, revision, expires_at, deleted_at, created_at, updated_at` | 已有软删除与修订；**无配额计数** |
| `memory_revisions` | `memory_id, revision, editor_user_id, previous_body, new_body, changed_at` | 软淘汰轨迹的载体 |
| `audit_events` | `id, actor_user_id, actor_device_id, event_type, object_type, object_id, outcome, safe_details_json, occurred_at` | 已区分 33 类事件；**无淘汰类** |
| `tasks` / `approvals` / `task_events` / `artifacts` / `bot_directory` / `invitations` / `idempotency_keys` | — | 任务/审批/成果/设备目录能力齐备 |

**限速**：无表。`server/src/security/ratelimit.js` 是**纯内存 `Map`**，源码注释明确"a restart forgets the counters"；`server.js:39` 只构造 1 个实例（登录用），**注册路由无 limiter**。

**发布/订阅**：`src/realtime/hub.js` 的 `connections` 是**进程内存 Map**，每条记录 `{ id, socket, user, deviceId, rooms:Set, unacked:Map }`。事件白名单 `EVENT_TYPES`（`src/realtime/events.js:21-27`）共 12 类，**无任何 presence 事件**；`contracts/events.schema.json` 的 enum 同样不含。

### 客户端

| 数据 | 位置 | 说明 |
|---|---|---|
| `roster.byId` | 宿主 `state.json` → 客户端 roster | Bot 会话 |
| `roster.roomsById` | 同上 | **本地**群聊会话；`wg:` 会话不在此列 |
| `sessions.list` | DSH 会话列表 | 主视图判定读 `retainedBy.mainView > 0` |
| `surface` | localStorage | `mode`、`plain`、`panelActive` 三态，决定团队表面是否生效 |
| 工作群数据 | `integrations/workgroup/client/index.mjs` 的 props 流 | 视图层无状态、无 fetch（刻意设计） |

## 当前模块职责

| 模块 | 拥有什么状态 | 谁改它 | 谁读它 |
|---|---|---|---|
| `server/src/modules/rooms` | rooms/members/invitations | 自身 | `api/rooms.js`、`realtime`、`artifacts`、`memory`、`tasks` |
| `server/src/modules/messages` | messages/roomSeq | 自身（事务） | `api/messages.js`、`realtime`、`chat-index` |
| `server/src/modules/memory` | group_memories/revisions | 自身 | `api/memory.js` |
| `server/src/modules/tasks` | tasks/approvals/grants | `store.js`（状态机）+ `grants.js` | `api/tasks.js`、`api/grants.js`、`realtime` |
| `server/src/realtime` | 连接与订阅 | `hub.js` | `api/*`、`server.js` |
| `server/src/security/ratelimit.js` | 失败计数 | 登录路由 | 登录路由 |
| `ds-bot host/roster.js` | 本地 rooms/bots | 自身 | `channel.js`、`groups.js`、`cells.js` |
| `ds-bot client/index.js` | surface、UI 状态、actions | 自身 | 所有 client 模块 |
| `client/workgroup.js` | 无状态（纯渲染） | — | **无人调用** |

**同一规则被复制的地方**：房间成员校验（`rooms/store.js` 的 `requireMember`、`memory/store.js`、`artifacts/store.js`、`tasks` 各自实现）；权限"作者或管理员"判定在 memory 与 artifacts 各写一遍。

## 可复用能力

**服务端**
- 注册需密钥：`HUB_REGISTRATION=admin_secret` + `acceptsBootstrapSecret`（`timingSafeEqual`，失败响应与"关闭"不可区分）——**实测可用**
- 目录/协议版本协商：`GET /api/v1/auth/config` 返回 `protocol/hubVersion/registrationMode/handlePolicy`
- 消息幂等与补拉：`client_message_id` 唯一约束 + `?after=` + `roomSeq`
- 事件投递：WSS `hello/ack/error` + 未 ACK 集合 + 心跳清扫
- 软删除语义：`deleteMemory` 已实现"清空 body + 收窄 ACL + 修订留痕 + 审计"
- 审计：`audit()` 统一入口，33 类事件
- 迁移机制：8 个顺序迁移 + 事务 + WAL
- 部署自检：`hub deploy-check / verify / status / backup-drill`

**应用端**
- 工作群**读**能力全部就绪：`openRoom / invite / members / setRole / removeMember / leave / sendMessage / messagesAfter / head / publishedBots`
- Bridge：ACK、重连、`watch/unwatch`、roomSeq 补拉
- 派发策略：目录 realpath + 根边界 + 一次性 nonce + 三 id 一致性
- 视图渲染组件：`GroupSettingsForm`、`RoomAvatar`、`Card/Row/InlineText`
- 表面门控：`groupsFor({ mode, plain, panelActive })`，已实测"切页无残留"
- 会话视图扩展点：`uiConversation.views.register({ target, ... })` + `conversation.view` 列表槽
- 面板槽位：`main.conversation`、`conversation.session`、`conversation.composer`、`conversation.input.dock`

---

# Impact Map

## 直接影响

| 编号 | 模块 / 文件（现状） | 必须变化的原因 |
|---|---|---|
| I-1 | **不存在**：Hub 服务提供者（`workgroupHub`） | 没有它，`workgroups` 恒为 `undefined`，工作群入口永不出现 |
| I-2 | `packages/bundle/ds-bot/src/client/index.js`（`:715`、`:732-743`、surface 同步） | 需要把 `wg:` 会话接入渲染与面板判定 |
| I-3 | `packages/bundle/ds-bot/src/client/workgroup.js` | 目前只导出未挂载的视图；需补 @/附件/引用/在线状态/离线状态并接入 |
| I-4 | `packages/bundle/ds-bot/src/client/styles.js` | 工作群 25 处 `bt-wg-*` 类名**无任何 CSS 规则** |
| I-5 | `server/src/api/rooms.js` + `modules/rooms/store.js` | 需支持 `rooms.kind`（当前静默丢弃 `kind`） |
| I-6 | `server/db/migrations/`（新增 0009+） | 需新增：`rooms.kind`、限速持久化表、记忆配额相关 |
| I-7 | `server/src/api/identity.js`（register 路由） | 注册端点**无任何限速** |
| I-8 | `server/src/security/ratelimit.js` + `src/server.js` | 需持久化 + 可信代理来源识别（`trustProxy` 硬编码 `false`） |
| I-9 | `server/src/realtime/events.js` + `contracts/events.schema.json` | 需新增 presence 事件（当前 12 类白名单不含） |
| I-10 | `server/src/modules/memory/store.js` | 需新增配额与"淘汰最旧"（当前无上限） |
| I-11 | `packages/bundle/ds-bot/src/client/new-chat.js` | 入口门控依赖 `workgroups`（由 I-1 供给） |

## 上游

| 谁创建/触发 | 现状 | 影响 |
|---|---|---|
| **用户点击菜单**「创建工作群聊」 | 门控在 `workgroups !== undefined`，而该值为 `undefined` | 供给方 I-1 决定入口是否存在 |
| **Hub 创建房间** | `POST /rooms` 只读 `name`；`kind` 被丢 | 需接受 `kind` 并落库，否则客户端与 Hub 对"这是不是工作群"判断不一致 |
| **注册请求** | `POST /auth/register` 无 limiter | 加限速时必须同时覆盖"失败即计数"，与登录语义对齐 |
| **设备连接/断开** | `hub.admit/release` 维护 `connections` | 在线状态的唯一事实来源；新增事件需在此处产生 |
| **任务状态变化** | `tasks/store.js` 单一函数迁移状态 | 已有单一入口，无需改造 |
| **记忆写入** | `memory/store.js` 事务内 INSERT | 配额淘汰须在同一事务内，否则并发下会超限 |

**是否存在多个入口**：工作群创建目前只有 1 个（菜单）；房间创建有 1 个（`POST /rooms`）；记忆写入 1 个。**消息创建 1 个**（`POST /rooms/:id/messages`）。无多入口冲突风险。

## 下游

| 谁读 / 依赖 | 用途 | 本次影响 |
|---|---|---|
| `realtime/hub.js` 的订阅校验 | 房间事件可见性 | presence 事件必须复用同一 `subscribe` 成员校验，否则会越权广播 |
| `api/messages.js` + `messages/store.js` | 消息列表、head、条数 | @mention/附件/引用会改消息体与展示 |
| `api/memory.js` | 检索、纠错、删除 | 配额淘汰后检索必须不返回被淘汰项 |
| `api/artifacts.js` | 上传/下载/分享 | 工作群附件入口需要接上已有 ACL |
| `api/tasks.js` | 审批、进度、分享 | 工作群审批卡需要从 `tasks` 读取 |
| `client/approvals.mjs` | `isMineToDecide` | 只有 B 能看到审批卡（已有实现，缺挂载） |
| `client/review.mjs` | `publicProgress` / `NEVER_PUBLISHED` | 进度脱敏（已有实现，缺挂载） |
| `audit_events` 消费者 | 审计查询、保留策略 | 新增"配额淘汰"事件类型需进白名单与文档 |
| `run-gates` / hygiene / doc-standard | 门禁 | 新增文件需符合 README/doc 规范；`verify-third-party-notices` 未纳入 `run-gates.ts` |

## 横向

| 面 | 现状 | 本次影响 |
|---|---|---|
| 列表 | `GET /rooms`、roster 列表 | 需能区分工作群与本地群（不可混淆命名空间） |
| 详情 | `GET /rooms/:id`（含 members） | 在线状态将并入成员数据 |
| 创建 | `POST /rooms` | 需接受 `kind` |
| 编辑 | `PATCH /rooms/:id` | 群设置 |
| 审批 | `tasks` + `approvals` | 挂载到工作群视图 |
| 日志/审计 | `audit_events`（33 类） | 新增淘汰类；限速拒绝需留痕 |
| 通知 | `approval-notices.js`（客户端） | 已有，需与工作群联动 |
| 后台任务 | `cli/hub.js`（backup/restore/audit-prune） | 限速表需纳入备份与恢复 |
| 管理端 | **本地演示版** | `/admin` 只管理工作群；独立 `operators` 表、固定 admin、用户只读、消息正文只读；不做用户 CRUD/设备管理/审计 UI |
| 用户端 | Bot 内部 UI | 工作群在此展示 |

## 确认无需修改

- `tasks` 状态机（`store.js` 的迁移表）——需求未要求改变语义
- **凭据铸造/消费已按 WP-E1 扩展为非对称签名链**（`server/src/modules/tasks/signing.js` 新增；`grants.js` 的 mint 增加签名，consume **先验签、后消耗**）。原设计记的是"不改"，实现按需求升级；`nonce` 语义保留（防重放），签名是其上的授权证明，二者互补
- `policy/dispatch.mjs` 的目录校验顺序与拒绝语义——保留；本次新增的是**网络出站限制**（`policy/egress.mjs`，默认拒绝）。此外 `acceptDispatch` 增加了 `verifyGrant` 前置：位于本机可判定的检查之后、出示 nonce 之前，未签名或以伪签名出示一律拒绝且不消耗凭据
- `bridge/index.mjs` 的 ACK/重连/补拉——已满足"不丢不重"
- 上游 DSH 的会话、消息、编辑器组件——需求明确不得重做
- `bot-adapter/flows.mjs` 的三 id 一致性校验——已满足
- `GROUP_SETTINGS_FORM`、`RoomAvatar`、`Card/Row`——直接复用
- `users` 表结构——**不新增管理员角色**（需求已确认）
- 邀请"按 userId 精确匹配、无用户搜索"——口径甲下保持现状

---

# Requirement 对照

## 已满足（可直接复用，无需改动）

| 需求项 | 已有能力 | 证据 |
|---|---|---|
| 准入需 key | `admin_secret` + 常数时间比较 + 不可区分响应 | `config/index.js:236-243,309-317`；实测 `CONFIG OK` |
| 入群前互不可见 | 无用户查找端点（本就如此） | 全仓 `listUsers/allUsers` 零命中；`a05-workgroup.spec.ts` 注释明确断言 |
| 邀请按 ID 精确 | `createInvitation` 按 `id` 精确匹配，未注册即拒 | `rooms/store.js:237-239` |
| 本人账号信息可得 | `GET /auth/me` + `publicUser` 已含 `id/userHandle/displayName` | `identity.js:71-79,318` |
| 消息幂等 + 补拉 | `client_message_id` 唯一约束、`?after=`、`roomSeq` | `0001_schema.sql:56-57`；`A02` 实测序列 `[1..6]` 无重复 |
| 成员校验 | 每次读消息/记忆/附件/任务都查成员 | 各 store 的 `requireMember` |
| 只有本人能批 | `isMineToDecide` + Hub 侧校验 | `client/approvals.mjs:50`；`A06` 含管理员被拒用例 |
| 目录失败即拒绝、不回落 | realpath + 根边界 + 明确拒绝码 | `policy/dispatch.mjs` 的 `DISPATCH_REFUSALS` |
| 任务状态机与终态 | 迁移表 + 终态不可恢复 | `tasks/store.js:59-71` |
| 记忆软删除与修订轨迹 | 清空 body + ACL 收窄 + revisions + audit | `memory/store.js:224-255` |
| 审计留痕 | `audit()` 统一入口，33 类 | `src/` 各模块 |
| 切页无残留 | 表面门控 `groupsFor` | 实测三态（`F07_F08_F09` 记录） |
| Bridge 断线补偿 | ACK + 重连 + 补拉 | `A02`、`Q03` |

## 需要修改

| 需求项 | 现状 | 改动方向 |
|---|---|---|
| **工作群入口可达**（WP-A0 前提） | `workgroupHub` 无提供者 | 新增 Hub 服务提供者（宿主侧装配） |
| **工作群视图挂载**（WP-A0） | `WorkgroupView` 零引用 | 把 `wg:` 会话接入渲染路径（见"前端"） |
| **工作群样式**（WP-A1） | 25 处类名、0 条规则 | 依 bot-ui 原版 token 建样式层 |
| **在线状态**（WP-C） | 无事件、无字段 | 复用 `connections`，新增 presence 事件与契约 |
| **记忆配额**（WP-D） | 无上限配置 | 新增配置 + 事务内淘汰 |
| **限速持久化**（WP-B5） | 内存 Map，重启清零 | 落库 + 覆盖注册端点 |
| **反代来源识别**（WP-B6） | `trustProxy: false` 硬编码 | 新增显式可信代理配置 |
| **房间类型**（WP-A 依赖） | `rooms` 无 `kind` | 新增列 + API 接受 `kind` |
| **A-03 状态回写** | 文档记"部分 PASS" | 改为"未可用" |

## 需要新增

> 以下是**规划期快照**：记录的是写这份设计时"当前没有"的东西。其中多数已经实现（见各 WP 的
> 交付记录与 `TASK_BOARD.md` 的终值），保留原文是为了让"当时缺什么"与"后来补了什么"都可追溯，
> 不代表当下仍缺。凡实现与本节描述不同处，以代码与测试为准。

| 需求项 | 新增内容 |
|---|---|
| 工作群 @ 成员 / @ 远程 Bot | mention 的结构化表达；远程 @ 只生成待审批候选的路径 |
| 工作群附件入口 | 视图层上传/展示（Hub 侧 ACL 已有） |
| 工作群引用（+ Reference a chat） | 视图层入口 + 授权边界（Hub 侧 `reply_to_message_id` 已有） |
| Hub 连接状态显示 | 由 Bridge 的 `onStateChange` 驱动 |
| 注册端点限速 | 新增 limiter 实例 + 落库 |
| 全端点限速（心跳/消息/webhook） | 新增配额维度 |
| 记忆容量配置项 | 环境变量族（现无任何 `HUB_MAX_MEMORY_*`） |
| 配额淘汰审计类型 | 新事件类型（区分于作者/管理员删除） |
| presence 事件类型 | `EVENT_TYPES` + `events.schema.json` + 客户端 reducer |
| 网络出站限制（WP-E3） | 执行层新增（当前无） |
| 成果内容 DLP（WP-E4） | 发布前检查（当前只控制接收人） |
| 非对称签名链（WP-E1） | 当前是 nonce + 设备绑定 |
| Windows 孙进程终止（WP-E2） | 当前 SIGTERM + 确认，未覆盖 Windows 树 |
| **双机自测材料** | 文档类交付 |
| `verify-third-party-notices` 入门禁 | `run-gates.ts` 补条目 |
| Windows 大小写不敏感路径比较（H1） | `policy/dispatch.mjs` 的路径比较 |
| Session Log L 级实测（H2） | 验证类交付 |

## 冲突

**无需求冲突。** 五轮答复已收敛全部歧义（准入、邀请口径、淘汰语义、在线状态、可信代理、完成标准、延后项）。

发现的是**需求描述与代码现状的落差**（不是需求内部矛盾）：

| 落差 | 性质 | 处理 |
|---|---|---|
| 需求称"工作群视图已实现"（引自 TASK_BOARD A-03） | 文档与代码不符 | 已在本设计确认：**视图未挂载、无样式**；`REQUIREMENTS_GAP_FILL.md` 冲突 7 已请用户确认修正 → 设计按"未可用"处理 |
| 需求称 `kind: 'workgroup'` 已传给 Hub | 客户端确实传了，Hub 丢弃 | 按"需新增 `kind`"处理，不改变需求 |
| 需求"入群前互不可见"与"邀请需 ID" | 表面张力 | 用户已选口径甲，设计按"提供自身 ID 展示"落地 |

**结论：无需回到需求确认。** 唯一待确认项（冲突 7 的状态修正）已由用户答复覆盖（"按记录执行，可提出异议"）。

---

# 技术设计

## 数据

### 服务端（新增迁移 0009+）

**新增 1：`rooms.kind`**

- 归属：`rooms` 表（Hub 拥有房间）
- 定义：`kind TEXT NOT NULL DEFAULT 'ordinary' CHECK (kind IN ('ordinary','workgroup'))`
- 默认行为：历史行为 `ordinary`——**不改变任何既有房间语义**（本次之前创建的房间全部是普通房间？需注意：**现状所有房间都是"Hub 房间"，不存在本地房间**；`ordinary` 在此含义是"未标记为工作群的 Hub 房间"）
- 约束：创建时由 API 显式传入；`workgroup` 之外一律 `ordinary`
- 一致性：客户端**不自行推断**，以 Hub 返回的 `kind` 为权威（`workgroup.js:34` 的注释已确立此原则）
- 历史数据：默认值回填，无需专项迁移脚本

**新增 2：限速状态持久化**

- 归属：新增表（Hub 拥有）
- 记录：键（handle / 来源 / 端点类别）、失败时间窗、锁定到期、端点维度
- 约束：与内存计数**取更严者**（内存为快速路径，库为权威）
- 默认：沿用现有登录参数（`HUB_LOGIN_LOCKOUT_SECONDS=300` 等），新增键沿用同一配置族
- 一致性：写入与读取需在同一事务语义下；跨重启后计数不丢
- 注意：现有 `RateLimiter` 有 `maxKeys` 上限与窗口清理——落库版需保留"有界"，否则磁盘可被撑爆

**新增 3：记忆配额**

- 归属：`group_memories` + 配置项
- 需要：每房间当前条数（可用 `COUNT(*)` 或维护计数）
- 配置：`HUB_MAX_MEMORIES_PER_ROOM`（命名沿用现有 `HUB_MAX_*` 族）
- 淘汰：同事务内 `SELECT ... ORDER BY updated_at ASC LIMIT n` → 软淘汰 → 写 `memory_revisions` + `audit_events`
- 冲突情形：并发写入时以事务串行化（SQLite `BEGIN IMMEDIATE` 已保证单写者）
- 历史数据：不回溯淘汰（只在新写入触顶时生效）

**新增 4：presence 不落库**

- 在线状态**不持久化**（需求："精确、瞬时"）；Hub 重启即空，与设计一致
- 因此不需要表、不需要迁移

### 应用端

| 数据 | 归属 | 说明 |
|---|---|---|
| 工作群会话 id | `wg:<roomId>`（已有函数） | 命名空间隔离，已实现 |
| Hub 服务对象 | 宿主侧新增提供者 | 形状决定客户端可用能力 |
| 会话视图 | 客户端 | 需把 `wg:` 会话接到工作群视图（最终落点见下：`shell.overlay` + `wg:` 身份） |
| Hub 连接状态 | Bridge 的 `onStateChange` | 已有回调，缺消费方 |

### 是否存在真实方案分歧（已裁决）

**分歧点：`wg:` 会话如何渲染工作群视图。**

| | 方案 A：会话内容槽替换 | 方案 B：独立面板 |
|---|---|---|
| 思路 | 在 `conversation.content`（`scope: session-maybe`）层按 `isWorkgroupSession(sessionId)` 分流，命中则渲染 `WorkgroupView`，否则原样 | 注册一个新的 `main.conversation` occupant 或独立 `sidebar.panellist`，用面板切换承载 |
| 复用 | 完全复用 shell 的会话绑定、输入区、宽度控制、标题 | 需自建绑定 |
| 风险 | 与上游会话渲染耦合，需确认 `session-maybe` 下替换的最小侵入点 | 与已确立的"只有一个 Bot 入口、`main.conversation` 声明权归 ui-conversation"原则**冲突**（`F07_F08_F09` 明确记录该约束） |
| 结论 | ~~推荐 A~~ **实测不可行** | **采用变体 B′** |

→ **A 在实现阶段被实测否定，B 的同名冲突问题用 overlay 规避。** 原文「推荐 A」作废，理由与替代方案如下：

1. **A 不可行（实测）**：`ui-slots` 的 `registerFactory`（`packages/client/ui-slots/src/index.ts:1021-1034`）对同一个槽的二次定义直接抛 `already has a definition`，`conversation.content` 已被 ui-conversation 声明，无法再影射；`useFactorySlotRuntime` 的局部槽由出现点选定，也不可从外部替换。
2. **朴素 B 不可行**：`layout.selectPanel` 对未注册 panel 抛错，故不能注册 `main`；另立 `main.conversation` occupant 同样撞上第 1 条。
3. **采用 B′：`shell.overlay` + `wg:<roomId>` 身份**。`shell.overlay` 是 `{ kind: 'list', scope: 'root' }`，渲染进 `css.overlayLayer`（`position:absolute;inset:0;z-index:20;pointer-events:none`，`> *` 恢复 `pointer-events:auto`）；本插件自己的 `.bt-pane`（`styles.js:318`）为 `position:fixed;top:var(--dsh-frame-chrome-top,0px);right:0;bottom:0;z-index:45`，**高于** `.bt-panel` 的 `40`（`styles.js:340`），因此面板覆盖对话区，无需额外门控。分流依据是**身份**（`isWorkgroupSession(sessionId)`）而不是面板状态，符合"只有一个 Bot 入口"的约束。
4. **进入顺序是其中的硬约束**：`sessions.retain` → `manager.resolveTarget` 对未知 id 抛 `sessions.retain: unknown session`（`manager.ts:135-152`），而工作群由 Hub 拥有、本机从不创建该 Session。因此必须先 `sessions.create({ sessionId: 'wg:<roomId>' })` 再导航；Host 对磁盘无记录的同名 id 会沿用原 id（`agent.ts:459-505`），故 id 稳定。

## 核心流程

### 流程 1：创建工作群（目标形态）

```text
用户在 Bot 内点「创建工作群聊」
↓ 门控：workgroups !== undefined（依赖新增的 Hub 服务提供者）
往下走之前先鉴权：本地已有 Hub 会话（token）？否则提示先登录
↓
Hub：POST /api/v1/rooms { name, kind: 'workgroup' }
权限检查：requireAuth（Hub 侧）
校验：name 合法；kind 只能是 workgroup（普通群不由该路径创建）
持久化：INSERT rooms(id, name, owner_user_id, next_seq=1, kind, created_at)
       + INSERT room_members(owner)   ← 同一事务
审计：room.created（details 增加 kind）
↓
响应：{ room: { id, name, kind, ownerUserId, myRole: 'owner', createdAt } }
↓
客户端：workgroupSessionId(id) → openSession(`wg:<id>`)
↓ 表面：Bot 面板已是 active，进入会话内容分流 → 渲染 WorkgroupView
↓ Bridge：watch(roomId)，开始接收消息
↓
视图：openRoom(roomId) → room + members + messages + tasks
```

**规则归属**：`kind` 的权威与落库在 **Hub**；会话命名空间在**客户端**（纯函数）；成员校验在 **Hub**；渲染分流在**客户端**。

### 流程 2：邀请与成员可见性

```text
A 打开工作群 → 群设置 → 「我的账号」区（新增）显示自身 userId/handle 可复制
↓ 线下告知 B
B 持 key 注册（POST /auth/register + bootstrapSecret；受注册限速保护）
↓ Hub：校验 key（常数时间）→ 创建 user → 审计 user.created
B 把 userId 告知 A
↓
A 提交邀请：POST /rooms/:id/invitations { targetUserId, role }
权限检查：requireRoomAdmin（Hub）
校验：目标存在且 active、非成员、无未过期 pending
持久化：invitations INSERT（事务）+ 审计 invitation.created
↓ 事件：invitation.created → 推给目标用户（现有事件类型）
↓
B 接受：POST /invitations/:id/accept → room_members INSERT + 审计
↓ 事件：member.changed
↓
双方：GET /rooms/:id 可见彼此与成员列表（含在线状态）
```

**不可见性保证**：Hub **不提供**任何"列用户/查用户"端点（现状即如此，保持）；在线状态只对**同房间成员**返回。

### 流程 3：设备在线状态

```text
设备建立 WSS → hub.admit（已有）→ connections.set(id, { user, deviceId, rooms:Set })
↓ 判定：该 userId 在 connections 中是否存在任一条目
↓ 变化时（0→1 或 1→0）向该用户所属房间广播 presence 事件
权限检查：只推给 room 的当前成员（复用 subscribe 的成员校验路径）
↓
客户端 reducer：更新 members 的 online 字段
↓ Hub 重启/连接断开/令牌吊销：connections 清空 → 全部回落离线
```

**规则归属**：真值在 `realtime/hub.js` 的 `connections`（**单一事实来源**，不引入第二处）；可见性在房间成员校验层；呈现（不显示时间戳）在客户端。

### 流程 4：群记忆写入与配额淘汰

```text
写入群记忆：POST /rooms/:id/memories
鉴权：requireMember
事务开始（BEGIN IMMEDIATE）
↓ 若 count(room_id) >= 上限：
   选中 updated_at 最旧且未删除的条目（按确认口径：淘汰最旧）
   软淘汰：body=''、acl_json={scope:'author',deleted:true}
   + INSERT memory_revisions（记录淘汰前内容）
   + audit('memory.evicted', details={reason:'quota', roomId})
↓ INSERT 新记忆 + audit('memory.created')
事务提交
↓
检索：既有的可见性过滤已排除 deleted_at IS NOT NULL → 被淘汰条目对所有人不可检索
审计查询：轨迹可查，且能区分 memory.evicted / memory.deleted / memory.deleted_by_admin
```

**规则归属**：全部在 `memory/store.js` 事务内（**不放到 API 层**，否则并发下会超限）。

### 流程 5：注册与限速（含持久化与可信代理）

```text
客户端 POST /auth/register { userHandle, displayName, password, bootstrapSecret }
↓ 来源识别：由可信代理配置决定（未声明则用直连 IP）
↓ 限速检查（库 + 内存取更严）：按来源 + 端点类别
  超限 → 429 + Retry-After，且审计（可选）
↓ 准入校验：registrationAllowed（既有：closed / admin_secret + 常数时间 key）
  失败 → 与"注册关闭"相同响应（保持既有防探测）
↓ 密码策略校验 → 创建用户 → 审计 user.created
↓ 失败时：计入持久化计数（跨重启保留）
```

**规则归属**：准入判定在 `config.registration`（既有）；计数在新增的持久化限速模块；来源解析需在**请求进入时**完成（Fastify 的 `trustProxy` 配置层）。

## 状态

### 任务状态机（不变）

沿用 `tasks/store.js`：`PENDING_APPROVAL → APPROVED → QUEUED → RUNNING → REVIEW_REQUIRED → COMPLETED/SHARED`；终态 `COMPLETED/SHARED/REJECTED/EXPIRED/CANCELLED/FAILED` 不可恢复；禁止 `PENDING_APPROVAL → RUNNING`。**本次不改。**

### 设备在线状态（新增）

```text
离线
 ↓ 任一设备连接建立
在线
 ↓ 全部连接断开 / Hub 重启 / 令牌吊销 / 账号禁用
离线
```

- 转换入口：**唯一**——`realtime/hub.js` 的 `admit` / `release` / `revokeRoom` / `sweepDeadSockets`
- 终态：无（可反复转换）
- 回退：天然支持（重连即在线）
- 重复操作：同一设备重复连接 → 连接数增加，状态仍为在线（幂等）
- 并发：多设备同时连接/断开 → 以 `connections` 的实时聚合为准，不做缓存
- **不持久化**，因此无历史状态迁移问题

### 房间类型（新增）

```text
创建时确定：kind = 'workgroup'（经该路径创建）
```

- 不可在创建后改变（本次无需求要求改类型）
- 无状态转换，仅是分类

### 注册 key

```text
未配置 → Hub 拒绝启动（既有行为）
配置合法 → 生效
轮换：改环境变量 + 重启 → 旧值失效，已注册账号不受影响
```

- 校验入口：`config/index.js`（既有）
- 无中间态

## 模块职责

| 层 | 归属 | 变更 |
|---|---|---|
| **Hub 准入与限速** | `src/config`（key 校验）+ 新增限速模块 | 限速从"内存 + 仅登录"扩为"持久化 + 多端点" |
| **Hub 房间** | `src/modules/rooms` | 新增 `kind` 的定义与校验点（**只此一处**） |
| **Hub 消息** | `src/modules/messages` | 不改幂等逻辑；mention 若需结构化，落点在此 |
| **Hub 记忆** | `src/modules/memory` | 新增配额与淘汰，**全部在事务内** |
| **Hub 实时** | `src/realtime` | 新增 presence 事件产生点；**复用**既有成员校验 |
| **Hub 审计** | 各模块调用的 `audit()` | 新增事件类型 |
| **应用端 Hub 服务** | **新增**（宿主侧装配） | 唯一新模块；组合 `protocol + bridge + client + policy + bot-adapter` |
| **应用端会话渲染** | `packages/bundle/ds-bot/src/client` | 新增 `wg:` 分流；**不改**普通会话路径 |
| **应用端工作群视图** | `client/workgroup.js` | 从"未挂载"变为"已挂载"；补能力与样式 |
| **应用端样式** | `client/styles.js` | 新增工作群规则（复用原版 token） |

**避免规则散落**：`kind` 判断只在 Hub 落库 + 客户端纯函数（`isWorkgroup(room)`）两处，且后者以 Hub 返回值为准；成员校验复用既有 `requireMember`，**不新增第二套**。

## API

### 修改

| 端点 | 变化 | 输入 | 输出 | 权限 | 校验 | 幂等 | 错误语义 |
|---|---|---|---|---|---|---|---|
| `POST /api/v1/rooms` | 接受 `kind` | `{ name, kind? }` | `room` 增加 `kind` | requireAuth | `kind ∈ {ordinary?, workgroup}`；非法值拒绝 | 无（每次创建新房间） | 400 非法 kind |
| `GET /api/v1/rooms/:id` | 成员增加 `online` | — | `members[].online: boolean` | requireMember | — | 只读 | 404（非成员） |
| `GET /api/v1/rooms` | room 增加 `kind` | — | — | requireAuth | — | 只读 | — |
| `POST /api/v1/auth/register` | 增加限速 | 不变 | 不变 | 无（准入靠 key） | 既有 + 限速 | 无 | 429 + `Retry-After`；key 失败仍与"关闭"不可区分 |
| `POST /api/v1/auth/login` | 限速持久化 | 不变 | 不变 | — | 既有 | — | 429（既有语义保持） |
| `POST /api/v1/rooms/:id/memories` | 配额淘汰 | 不变 | 不变 | requireMember | 既有 + 配额 | 无 | 不变（淘汰对调用方透明） |

### 新增

| 端点 | 用途 | 输入 | 输出 | 权限 | 校验 | 幂等 |
|---|---|---|---|---|---|---|
| `GET /api/v1/auth/me`（**已有**，复用） | 展示自身账号供线下告知 | — | `id/userHandle/displayName` | requireAuth | — | 只读 |
| （无新增用户查询端点） | 需求明确不做 | — | — | — | — | — |

**不新增**：用户搜索、用户目录、presence 查询端点（在线状态随 `GET /rooms/:id` 返回，避免第二个事实来源）。

### WebSocket

| 事件 | 方向 | 变化 |
|---|---|---|
| `presence.changed` | Hub → 客户端 | **新增**；payload 含 `roomId, userId, online` |
| 订阅校验 | — | 复用既有 `subscribe`（重查成员）；非成员不收 |

契约同步：`server/contracts/events.schema.json` 的 enum 与 `realtime/events.js` 的 `EVENT_TYPES` **必须同时**加入，否则 `makeEvent` 会在发布时抛错（该文件注释记录了历史上正是这样产生 500 的）。

## 前端

### 页面入口

| 入口 | 现状 | 目标 |
|---|---|---|
| 「创建工作群聊」菜单项 | 依赖 `workgroups`（恒 `undefined`） | 由新增 Hub 服务提供者供给后出现 |
| `wg:` 会话 | 无渲染路径 | 命中分流 → 渲染 `WorkgroupView` |

### 页面状态

```text
未配置 Hub           → 菜单无工作群入口；普通群聊完全不受影响（既有行为保持）
已配置未登录         → 入口出现，提示先完成 Hub 登录
已登录 / 加载中      → loading（emptyWorkgroupState 已是显式形状）
已加载 / 空群        → empty（"No messages yet"已有 i18n）
已加载 / 有内容      → success
Hub 离线             → 离线/受限状态（由 Bridge onStateChange 驱动）
加载失败             → error（区分"非成员/不存在"与"网络失败"）
发送失败             → 消息行标记"未送达"（已有）
```

### 数据来源

- 房间/成员/消息/任务：`integrations/workgroup/client`（已有）
- 在线状态：`GET /rooms/:id` 的 `members[].online` + `presence.changed` 事件
- Hub 连接态：Bridge 的 `onStateChange`
- 视图层**不做 fetch**（刻意的既有约束，保持）

### 状态同步

- `reduceWorkgroup` 扩展：处理 `presence.changed`（更新成员 `online`）
- 成员变更：既有"re-read rather than patch"策略保持（`membersStale`）
- 未知事件类型：保持"忽略而非抛错"（既有约定）

### 列表 / 详情关系

- 工作群与本地群**不共用列表**：本地群在 roster 列表；工作群由 Hub 驱动
- 会话 id 命名空间隔离（`wg:`）保证二者永不相撞

### 权限表现

- 非成员：菜单/入口不可见；直接猜 roomId 访问 → Hub 404
- 非管理员：群设置只读；邀请/移除按钮不可用
- 非 B 本人：看不到审批卡（已有）
- 非群成员：不返回在线状态

### 组件复用

| 复用 | 来源 |
|---|---|
| 群设置表单 | `GroupSettingsForm`（已有导入） |
| 房间头像 | `RoomAvatar`（已有导入） |
| 卡片/行/内联文本 | `Card` / `Row` / `InlineText` |
| 颜色/间距/圆角 | `styles.js` 的既有 token 与 `.bt-*` 约定 |
| 会话外壳 | shell 的会话绑定与输入区（不进工作群视图的自定义 composer 以外的部分） |

### 新增界面元素（按 bot-ui 原版设计语言）

| 元素 | 说明 |
|---|---|
| 在线状态点 | 成员列表内，人类成员用；与 Bot 的 `state` 语义分离（不同标记） |
| Hub 状态条 | 群标题区，离线/受限时出现 |
| 「我的账号」区 | 群设置内，显示 `userHandle` 与 `userId`，可复制 |
| @ 菜单 | 复用团队既有 at-menu 机制（`at-menu.js`）还是群内独立，需在实现时确认最小侵入方式 |
| 附件入口 | 复用 composer 的附件能力 |
| 引用入口 | 复用 `reply_to_message_id` |

## 后端

### Controller / Service / Domain

| 层 | 职责 | 本次落点 |
|---|---|---|
| 路由（`api/*.js`） | 鉴权、输入校验、错误映射 | `rooms.js`（kind）、`identity.js`（限速） |
| 领域（`modules/*/store.js`） | 业务规则、事务、审计 | `rooms`（kind 落库）、`memory`（配额淘汰） |
| 实时（`realtime/*`） | 连接、订阅、事件投递 | presence 产生与广播 |
| 配置（`config/`） | 校验、默认值、冻结 | 新增内存配额、可信代理、限速参数 |
| 安全（`security/`） | 限速、来源识别 | 从内存扩为持久化 |

### 数据持久化

- 写操作一律走既有 `BEGIN IMMEDIATE` 事务模式
- 配额淘汰与记忆写入**同一事务**
- 限速落库需注意写放大：仅记录**失败**（与既有语义一致），并对写入做批量/延迟合并，避免每次登录失败都产生一次磁盘写竞争

### 事务边界

| 操作 | 边界 |
|---|---|
| 创建房间 | rooms + room_members + audit（既有，扩展 kind） |
| 接受邀请 | invitations + room_members + audit（既有） |
| 记忆写入/淘汰 | group_memories + memory_revisions + audit（**扩展**） |
| 凭据铸造/消费 | grants + dispatch_grants + audit（**扩展**：Ed25519 签名，`GET /dispatch/keys` 发布公钥，轮换经 `HUB_GRANT_SIGNING_KEY_PUBLIC_PREVIOUS`） |

### 并发与幂等

| 场景 | 处理 |
|---|---|
| 消息重复发送 | 既有 `UNIQUE(room_id, sender_user_id, client_message_id)` |
| 并发创建同名房间 | 允许（房间名不唯一，既有行为） |
| 并发记忆写入触发淘汰 | 事务串行化（SQLite 单写者） |
| 重复邀请同一人 | 既有：返回既有 pending 邀请（`store.js:250`） |
| 重复接受邀请 | 既有：`NO_SUCH_INVITATION` 语义 |
| presence 抖动 | 以 `connections` 实时聚合为准，不做去抖持久化 |

### 异常处理

- 错误码语义沿用既有（404 用于"非成员/不存在"以防探测）
- 注册 key 失败**不得**泄漏"key 错"与"关闭"的区别
- 限速触发返回 429 + `Retry-After`（既有登录语义）

### 后续事件

| 事件 | 触发 | 消费方 |
|---|---|---|
| `presence.changed` | 连接变化 | 同房间客户端 |
| `memory.evicted`（审计） | 配额淘汰 | 审计查询 |
| 既有 `message.created` / `task.*` / `member.changed` | 不变 | 不变 |

## 兼容 / 迁移

| 项 | 处理 |
|---|---|
| **历史数据（`rooms.kind`）** | 默认 `ordinary`；**不需要**数据回填脚本（新列带默认值）。注意：本次之前 Hub 上的房间都不是工作群，语义正确 |
| **老接口** | `POST /rooms` 增加可选 `kind`——不传即 `ordinary`，**保持向后兼容** |
| **老页面** | 本地群聊、DSH 会话、插件页、设置页**均不改动** |
| **老状态** | 任务状态机与审计事件不变；**凭据格式已变**（WP-E1 增加 `signature`/`keyId`，消费时必须携带），未配置签名私钥的 Hub **拒绝所有派发**——这是刻意的失败关闭，需写入交付文档与升级说明 |
| **限速内存态** | 首次引入持久化后，重启不再清零——**行为变更需写入交付文档**（原 `DEPLOYMENT.md` 的"限速不跨重启"条目要更新） |
| **`trustProxy`** | 默认仍为 `false`（安全默认）；仅显式配置后启用 → 未配置的部署**行为不变** |
| **客户端 bundle** | `client.js` 由构建产生；`build-client.mjs --check` 必须保持通过（既有硬规则） |
| **上游资产** | 许可证、NOTICE、注释不变 |
| **数据根** | `.workgroup-ai` 不变 |
| **门禁数字** | 以本次重跑为新基线（需求已确认） |

**无需处理**：无历史 `kind` 数据、无老版本客户端兼容问题（同版本发布）、无数据迁移脚本。

---

# 风险

**风险 1 · 工作群服务缺少生产装配（阻断级）**
- 原因：`workgroupHub` 无任何提供者；集成层（bridge/client/protocol/policy/bot-adapter）**只被测试引用**。整条链路在生产路径不可达
- 影响：WP-A 全部工作（挂载、样式、@、附件、引用、在线状态）都无法验证；WP-F 的真实模型执行也无法跑通
- 处理：把"新增 Hub 服务提供者 + 装配到插件/宿主"列为**第一优先任务**，先让它可加载（哪怕只有 `createRoom`/`watch`/`openRoom` 三个方法），再逐个补齐能力

**风险 2 · 会话渲染分流的侵入性（已实测裁决，见「方案分歧」）**
- 原因：`wg:` 会话要接入 shell 的会话渲染，而该处由上游 `ui-conversation` 拥有
- 影响：改错位置会破坏普通会话，或违反"只有一个 Bot 一级入口 / 不注册第二个 `main.conversation`"的既有约定
- 处理：**已实测否决 `conversation.content` 分流**——`registerFactory` 对同名槽的二次定义直接抛错，`layout.selectPanel` 拒绝未注册的 panel。最终落点为 `shell.overlay` + `wg:<roomId>` 会话身份（`.bt-pane` 的 `z-index:45` 高于 `.bt-panel` 的 `40`，覆盖层天然压住面板）。详见「是否存在真实方案分歧（已裁决）」

**风险 3 · 在线状态的双事实来源**
- 原因：`connections`（内存，权威）与 `devices.last_seen_at`（库，仅登录/刷新时更新）语义不同；若误用后者，会得到"登录过即在线"的错误结果
- 影响：显示错误的在线状态，且 Hub 重启后残留"在线"
- 处理：**只用 `connections`**；明确禁止读取 `last_seen_at` 作为在线依据；测试覆盖"Hub 重启后全部离线"

**风险 4 · presence 事件的越权广播**
- 原因：presence 是用户维度信息，而事件投递是房间维度
- 影响：非成员获知他人是否在线
- 处理：复用既有 `subscribe` 的成员校验路径；测试覆盖"非成员收不到"

**风险 5 · 限速持久化的写放大**
- 原因：现有实现是"失败计数 + 有界内存 + 定期清理"；落库后每次失败都可能触发磁盘写，与 SQLite 单写者叠加
- 影响：暴力破解场景下反而拖慢 Hub（自伤式 DoS）
- 处理：仅在**达到阈值**时落库，或采用批量合并写入；保留"有界"性质；基准测试（既有 `BENCHMARK.md` 与 Q-03 的压测方法可复用）

**风险 6 · 注册开放面扩大（key 的强度）**
- 原因：`admin_secret` 是跨网暴露下唯一准入闸门；配置校验**只有长度下限、无复杂度检查**（源码确认）
- 影响：弱 key 被猜到即任意注册
- 处理：部署文档强制要求强随机值并给出生成命令；不改变代码校验语义（需求未要求）；作为风险记录

**风险 7 · 记忆配额淘汰的可追溯性**
- 原因：淘汰与删除语义相近，若实现时把淘汰写成物理删除，会破坏既有可追溯承诺
- 影响：审计链断裂，违反 `ACCEPTANCE.md`
- 处理：复用既有软删除语义（清空 body + 收窄 ACL + revisions + audit）；审计区分三种删除来源；测试覆盖"淘汰后作者也不可检索、但审计可查"

**风险 8 · `rooms.kind` 的双向一致性**
- 原因：客户端传 `kind`，Hub 目前静默丢弃；若只改一侧，会出现"客户端认为是工作群、Hub 认为是普通房间"
- 影响：工作群行为（如成员可见性、在线状态）落到错误的房间类型上
- 处理：Hub 落库为唯一权威；客户端只读 Hub 返回值；测试覆盖"未传 kind → ordinary"与"传 workgroup → 落库"

**风险 9 · 门禁与文档规范的连带失败**
- 原因：新增文件（迁移、模块、客户端代码）需符合 `doc-standard`、`third-party-notices`、`client bundle 与源码一致`等门禁
- 影响：改动可能引入门禁回归（历史上前一轮返工正因漏跑车道）
- 处理：每步改完跑完整门禁（不止 `integrations` 车道）；`verify-third-party-notices` 明确纳入 `run-gates.ts`

**风险 10 · 安全剩余项的实现深度**
- 原因：非对称签名链（当前 nonce+设备绑定）、网络出站限制（当前无）、成果 DLP（当前只控接收人）、Windows 孙进程终止（当前未覆盖）都是新能力，且都触及执行边界
- 影响：做浅了会形成"看起来通过"的假象，违反"严禁虚构成功"
- 处理：每项先写负向用例（伪造/越界/未确认），再实现；无法确认的情况如实报告"未确认"

**风险 11 · 图谱外的既有失败与红鲱鱼**
- 原因：上游 DS Bot 有 1 项既有失败（`dsh-update.test.js`）；`TASK_BOARD` 中 F-13 行表述与 A-07/A-08 交付文档不一致
- 影响：容易被误当作本次引入的回归，或被错误的既有结论误导
- 处理：基线先重跑并记录；F-13 表述以交付文档为准回写

---

# 技术方案摘要

```text
核心设计：
- 工作群是 Hub 房间（kind='workgroup'），客户端以 wg:<roomId> 作为会话身份；
  Hub 是 kind 的唯一权威，客户端只读返回值
- 会话渲染采用「覆盖层 + 会话身份」：在 shell.overlay 注册 WorkgroupPane，以
  isWorkgroupSession(sessionId) 判定是否渲染——不注册第二个 main.conversation，
  不二次定义任何既有槽位，不破坏"只有一个 Bot 一级入口"的既有约定。
  进入前必须先 sessions.create({ sessionId: 'wg:<roomId>' })：
  sessions.retain 对未知 id 抛错，而工作群由 Hub 拥有、本机从不创建该 Session
- 在线状态以 realtime/hub.js 的 connections 为唯一事实来源，瞬时、不落库、
  只对同房间成员可见；禁止用 devices.last_seen_at 代替
- 配额淘汰、限速计数都放在既有的单一事实来源模块内（memory/store.js 事务内、
  新增限速模块），不新增第二处规则

主要变化：
- 新增：Hub 服务提供者（宿主侧装配）、rooms.kind、presence 事件、注册限速、
  限速持久化、可信代理配置、记忆配额配置、工作群样式层、@/附件/引用入口、
  「我的账号」展示、网络出站限制、成果 DLP、非对称签名链、Windows 孙进程终止
- 修改：client/index.js（wg: 分流与供给）、workgroup.js（挂载与能力）、
  styles.js（样式）、new-chat.js（门控）、api/rooms.js + rooms/store.js（kind）、
  api/identity.js（限速）、realtime（presence）、contracts（事件 enum）

复用：
- 服务端：admin_secret 准入、消息幂等与补拉、成员校验、软删除语义、审计入口、
  迁移机制、部署自检、任务状态机与凭据
- 应用端：集成层全部读能力（openRoom/invite/members/sendMessage/messagesAfter/
  head/publishedBots）、Bridge（ACK/重连/补拉/watch）、派发策略与目录校验、
  GroupSettingsForm/RoomAvatar/Card/Row、表面门控 groupsFor、会话视图扩展点

新增：
- 应用端：一类新模块 —— Hub 服务提供者（组合既有集成层，不重复实现协议）
- 服务端：迁移 0009+（rooms.kind、限速状态）、presence 事件、配额配置

关键影响：
- 工作群当前在生产路径完全不可达（无服务提供者 + wg: 无渲染路径 + 无样式）
  ——这是"看似已实现"与"实际不可用"的落差根源，必须最先解决
- rooms.kind 双侧一致性决定后续工作群行为是否落在正确的房间上
- presence 与限速都涉及"事实来源单一化"，是权限遗漏的高风险区
- 每次改动都要跑完整门禁（历史教训：漏跑 scripts 车道导致两个失败未被发现）

风险：
- 11 项，其中阻断级 1 项（Hub 服务缺装配）、高影响 3 项（渲染分流侵入性、
  在线状态双来源、presence 越权广播）
- 两项需持续守住的纪律：不物理删除记忆（可追溯性）、不虚构安全能力（负向用例先行）
```

---

## 附：本次调查的证据索引

**服务端**
- `src/config/index.js`（:157 loadConfig、:236-243 注册模式与 key 校验、:309-317 常数时间比较、:321 limits）
- `src/server.js`（:31 `trustProxy: false`、:39 唯一 limiter 实例、:79 health 关闭限速）
- `src/api/identity.js`（:112 register 无 limiter、:134 login 有限速、:71-79 publicUser、:350 auth/config、:345-375）
- `src/api/rooms.js`（:71-78 POST 只读 name、:113 members、:176-230 invitations）
- `src/modules/rooms/store.js`（:143 createRoom 无 kind、:237-239 邀请校验、:429 publicRoom、:439 publicMember）
- `src/modules/messages/store.js`（:76 sendMessage、:153 readMessages）
- `src/modules/memory/store.js`（:224-255 deleteMemory 软删、:271-288 listMemories、:298-314 searchMemories）
- `src/security/ratelimit.js`（:1-30 内存态自述、:36 类定义）
- `src/realtime/events.js`（:21-27 EVENT_TYPES 12 类、无 presence）
- `src/realtime/hub.js`（:45 connections、:99-110 连接记录、:130 subscribe、:151 revokeRoom、:225 publishToRoom）
- `db/migrations/0001_schema.sql`（:6-13 users 无 role、:14-21 devices、:23-29 rooms 无 kind、:30-37 room_members、:48-59 messages、:60-68 bot_directory、:116-138 memory 相关）
- `db/migrations/0008_message_replies.sql`（reply_to_message_id）
- `contracts/events.schema.json`（:11-15 enum 无 presence）
- `contracts/openapi.yaml`（端点清单）
- `deploy/DEPLOYMENT.md`（:31-32 不应对公网暴露、:299 与 :348-349 trustProxy 取舍）
- `package.json`（dependencies 仅 fastify + @fastify/websocket）
- `tests/a05-workgroup.spec.ts`（:28-30 注释明确"按 id 邀请、无用户搜索"）

**应用端**
- `packages/bundle/ds-bot/src/client/index.js`（:24 只导入 2 个符号、:55 BOT_PANEL_ID、:715 ctx.get('workgroupHub')、:726-743 workgroups、:775-786 registerBotPanel、:810 shadow、:857-910 slot 注册全景、:912-935 plain 判定、:970-1030 门控）
- `packages/bundle/ds-bot/src/client/workgroup.js`（:1-17 模块契约、:27-47 kind 与 memberSummary、:59-128 子组件、:130-198 WorkgroupView、:231-248 session id 三个纯函数）
- `packages/bundle/ds-bot/src/client/new-chat.js`（:10-13、:70-95、:106-107）
- `packages/bundle/ds-bot/src/client/overlays.js`（:43 NewChat 注入 workgroups）
- `packages/bundle/ds-bot/src/client/styles.js`（:20 SHELL_CSS、:788 CONVERSATION_CSS；无 .bt-wg）
- `packages/bundle/ds-bot/src/client/surface.js`（:9-30 groupsFor 三态）
- `packages/bundle/ds-bot/src/host/roster.js`（:36 createSession、:283-310 createRoom 本地群结构）
- `packages/bundle/ds-bot/src/host/channel.js`（:87 READS、:186-208 task 探针、:249-255 create-room）
- `packages/bundle/ds-bot/src/host/groups.js`（:121-128 群成员 Session、:199-235 roomTurn）
- `packages/bundle/ds-bot/src/host/store.js`（:292 roomOf、:324 groupOwners、:348 groupSessionsOf）
- `packages/bundle/ds-bot/index.js`（:38 inject 清单、:44 MODULES、:47 apply）
- `packages/bundle/ds-bot/cordis.patch.yml`（挂载行）
- `integrations/workgroup/protocol/hub-client.mjs`（:52 createHubClient、:155 identity）
- `integrations/workgroup/bridge/index.mjs`（:72 createBridge、:333 watch）
- `integrations/workgroup/client/index.mjs`（:38 createWorkgroupClient、:41-62 openRoom、:74 invite、:111 members、:147 sendMessage、:196 selfUserId、:216 reduceWorkgroup、:263 emptyWorkgroupState）
- `integrations/workgroup/policy/dispatch.mjs`（:22-40 拒绝码、:53+ resolveTaskDirectory）
- `integrations/workgroup/bot-adapter/flows.mjs`（:53 chooseBot、:140 runDispatch、:232 progressUpdate、:271-300 脱敏）
- `integrations/ds-bot/tests/apply-harness.mjs`（:97 fakeShell、:111-116 provide 为 noop）
- `packages/client/ui-conversation/src/client/apply.ts`（:329-334 main.conversation、:336-372 conversation.content 与 children、:382-390 conversation.session、:560-572 main 注册）
- `packages/client/ui-conversation/src/client/conversation/view-registry.ts`（:9-20 视图注册契约）
- `packages/client/ui-workspace/src/client/navigation.ts`（:44 openSession、:276 replaceMain）

**文档与证据**
- `docs/acceptance/{README,Q01,Q02,Q04}.md`
- `application/docs/workgroup-ai/{A03_A04_WORKGROUP_UI,A07_DISPATCH,A08_FLOWS_CANCELLATION,F07_F08_F09_NAVIGATION,F11,F12,F13,REWORK_BOT_ENTRY_AND_ENV,VERIFICATION_F01_F04}.md`
- `application/docs/workgroup-ai/evidence/f07-product/f07-product-ui.json`（真实产品路径 3 行导航）
- `application/tests/app-f07-ui-check.mjs`、`app-f08-functions-check.mjs`、`app-a03-ui-check.mjs`
- `application/integrations/workgroup/tests/bot-entry.spec.ts`（断言"视图模块存在"而非"被挂载"——这正是假 PASS 的来源）

**实测**
- `HUB_ADMIN_BOOTSTRAP_SECRET=abcd123456789012` → `CONFIG OK; registrationMode = admin_secret`；正确 key `true`、错误 key `false`
- 8 字符 key → `loadConfig` 抛 `must be at least 16 characters`
- 生产缺 `HUB_TOKEN_SIGNING_KEY` → 抛错
- `http://127.0.0.1:8317/v1/models` → 42 个模型含 `deepseek-v4.1-flash`；`/v1/chat/completions` → `pong`

## 2026-10-17 W3 实现事实（增量，覆盖此前"缺生产消费者"的描述）

- 新增 `application/packages/bundle/ds-bot/src/host/task-dispatch.js`：当前唯一的 approved-task 生产消费者。它订阅 Host Bridge 事件（`rt.onWorkgroupEvent`），并且只把事件当通知：owner、状态、版本、scope、Bot 与期限全部从 owner-scoped `GET /tasks/:taskId` 重新读取。
- 执行链复用既有实现：`policy/dispatch.mjs` 的 realpath/root/单次 nonce/撤销版本/强制验签，`bot-adapter/flows.mjs` 的三模式与三 id 绑定，`task-sessions.js` 的隔离 Session，`task-grants.js` 的逐次工具/路径/出站检查。没有新增执行进程，没有改写 DSH Agent Loop，没有用普通 Agent 冒充 Bot。
- Host `hub-approve-task` 统一经 `createApprovalClient().decide()` 组包（Browser/Host/integration 单点字段映射），并在转发前调用 `rt.cleanWorkDir` 校验工作目录；缺失、团队默认目录、不可解析或守卫不可用一律拒绝。
- `hub-review-task` 与浏览器 `reviewTask` 新增：`keep`/`reject`/`share` 与 Hub 三个既有路由一一对应，只有 `share` 携带 recipients。
- 删除 `task-session-open` 与 `task-grant-set` 两个 `/api/bot` 端点：它们能在没有 Hub 审批的情况下创建 Task Session 或按调用方给定参数签发本地 grant，与"先审批再执行"冲突。保留停止方向端点（`task-session-close`、`task-grant-revoke`）与只读探针。
- Host workgroup adapter 额外暴露 `rt.hubClient`，供审批消费器在 Host 内读取任务与 grant；浏览器仍只能经 `/api/bot` 的既有端点表，`server/contracts/` 未改。
- 组合验证：`a17-workgroup-loader-composition.spec.ts` 用 test-only `cordis.yml` + 真实 Loader + 25 个真实服务行加载真实 `@deepseek-ai/dsh-bot`，断言全部行激活、Bot 工具注册、`/api/bot` 的 `hub-view`/`hub-approve-task` 可达，并经真实 Bridge 投递 `task.approved`；Hub 详情为 `PENDING_APPROVAL` 时不产生 grant/consume/Session。
- 已验证的限制（未解决，不是 PASS）：
  - `task.approved` 仅送达已订阅该房间的 socket，owner 未打开工作群或重启后不会自动执行；Hub 没有 approved 待执行队列端点，新增它属于协议变更。
  - `chief_auto` 在 Host 没有 Chief 决策器，按 fail-closed 拒绝。
  - 取消事件在 owner Host 离线期间会丢失，只能靠 grant 到期兜底；无 Hub 侧对账。
  - 进度端点只发布 stage/state，失败原因留在 owner 本机。
  - 真实浏览器 `conversation` 面板与真实模型闭环属 L 级，本轮未执行。
