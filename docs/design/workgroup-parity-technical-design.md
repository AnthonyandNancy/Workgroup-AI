# 工作群复刻原版群聊：技术拆解与技术设计

> **本文件已被 `workgroup-parity-technical-design-v2.md` 取代，仅作历史调查记录保留。**
> 主要差异：v1 假设「主持管理员应答 = 生成待审批任务」；需求 R14a / D2 裁决后，v2 改为「消息直接进入该 Bot 在本群的长期会话」，并相应新增 `host/workgroup-turns` 与 `state.workgroupRooms`。
> 请以 v2 为实现依据。

| 字段 | 内容 |
|---|---|
| 文档状态 | 已被 v2 取代（历史记录） |
| 需求来源 | `docs/requirements/workgroup-parity-requirement.md` |
| 调查范围 | `application/packages/bundle/ds-bot`、`application/integrations/workgroup`、`server/` |
| 代码阶段 | 仅调查与设计，未进入 Coding |
| 证据等级 | 当前仓库源码级调查；真实 UI 点击和像素对照尚未执行 |

---

# 当前系统

## 当前流程

### 原版普通群聊

```text
Bot 新建菜单
↓
NewGroupForm：选择管理员、Bot 成员、名称
↓
DS Bot host roster.createRoom
↓
创建本地 room 与本地 DSH Session
↓
DSH conversation shell 渲染群聊
├── cells.js 的 Bot 消息
├── composer.js 的输入区与 `+` 菜单
├── sidebar.js 的 RoomRow
├── details-drawer.js 的群概览与成员
└── group-settings.js 的群设置
↓
host groups.js 执行轮次、@、群工具、停止成员工作
↓
本地 state 持久化
```

当前原版群聊的“消息区、输入区、设置、详情、侧栏”不是一个单独的群聊页面，而是分散在 DS Bot 与 DSH shell 的多个注册面中：

- 消息节点通过 `conversation.chat.node` 注册；
- 输入区通过 `conversation.input.*` 与 `conversation.composer` 扩展；
- 侧栏通过单 owner 的 `sidebar.workspaces` 注册；
- 群聊主体依赖 DSH `conversation.content` 的单一组件工厂。

### 当前工作群

当前已经有三个可用入口，且都已接入同一个 `workgroups.create`：

1. Bot 新建菜单：`new-chat.js`；
2. Bot 设置 → Group chats：`settings.js`；
3. 命令面板：`palette.js`。

```text
三个入口
↓
workgroups.create
↓
Host 调用 Hub POST /rooms，自动生成日期名称
↓
enterWorkgroup 创建 `wg:<roomId>` DSH Session
↓
WorkgroupPane 通过 shell.overlay 覆盖会话区域
↓
每 4 秒 openRoom + Bridge 事件刷新
↓
自有 WorkgroupView
├── 自有 message thread
├── 自有 composer
├── 自有成员胶囊列表
├── 自有审批/任务条
└── 自有 WorkgroupSettings
```

三个入口进入后已经显示工作群内容，而不是本地普通群聊内容；当前缺的不是入口本身，而是入口触发的创建表单、工作群侧栏行、原群聊式内容和完整工作群能力。

当前工作群没有进入 DS Bot 原群聊的侧栏会话列表；没有原群聊式详情抽屉；没有原群聊式创建表单；没有入站邀请处理界面；没有 Bot 发布、拉入或移出流程。

### Hub

```text
用户创建 room
↓
room_members 记录真人与角色
↓
消息、任务、审批、成果、群记忆、审计分别由对应模块持久化
↓
WSS wg.v1 推送房间事件
↓
Host 持有 Hub 连接，浏览器通过 Host 的 `/api/bot` 通道调用
```

Hub 管理端是 `server/` 内置的 `/admin/` Web 后台；群主解散和 Hub 管理端解散走不同路由，目前未共享完整的解散副作用。

---

## 当前数据模型

### 原版群聊本地模型

| 对象 | 当前字段/行为 |
|---|---|
| 本地 room | `id`、`name`、`named`、`members`、`admin`、`mode`、`notice`、`workDir`、`permission`、`pinned`、`hidden`、`createdAt`、`createdBy` |
| 本地 room log | 有序消息日志，包含发送者、文本、图片、时间、seq |
| 本地成员 | 本机 Bot；每个 Bot 有 Session、角色、模型、权限和工作目录 |
| 本地群设置 | 名称、公告、谁应答、工作目录、共享权限、成员与 Bot 管理员、侧栏置顶/隐藏、删除/归档 |
| 本地详情 | 群公告、成员、成员工作状态、停止成员工作、谁应答、权限、用量 |

### Hub 当前模型

| 对象 | 当前字段/行为 |
|---|---|
| `rooms` | `id`、`name`、`owner_user_id`、`kind`、`next_seq`、`created_at`、`dissolved_at`、`dissolved_by` |
| `room_members` | `room_id`、真人 `user_id`、`role`、`joined_at`、`removed_at` |
| `invitations` | 真人邀请：邀请人、被邀请人、角色、状态、过期时间 |
| `bot_directory` | Bot 所有者、`bot_id`、显示名、`visibility`、`state`、心跳时间；没有房间成员关系 |
| `messages` | 房间、`room_seq`、真人发送者、正文、回复目标、mentions、附件 |
| `tasks` | 请求人、所有者、目标 Bot、状态、版本、审批范围、执行 Bot |
| `approvals` / `grants` | 审批记录、短期执行授权 |
| `task_events` | 任务事件与脱敏公开载荷；没有房间级读取接口 |
| `artifacts` | 任务/房间附件、内容哈希、ACL |
| `group_memories` | 来源、作者、ACL、修订、有效期、删除 |
| `audit_events` | 管理、房间、Bot、任务、审批等审计 |
| 当前工作群客户端状态 | `room`、`members`、`messages`、`tasks`、`head`、`loading`；没有 `notice`、`bots` 明确成员、`dissolvedAt`、入站邀请、Bot 邀请 |

### 当前模型的关键缺口

1. `rooms` 没有公告字段。
2. 没有 `room_bots`，Bot 不是房间成员；`openRoom` 从每个真人成员已公开的 Bot 目录自动推导 Bot 列表。
3. 没有 Bot 邀请/所有者授权记录。
4. 没有“Bot 所有者退出/被移除后，其 Bot 如何处理”的数据关系。
5. 没有房间级任务事件读取接口；任务卡片只能显示当前状态，不能按原群聊式时间线展示历史进度。
6. 部分房间修改接口没有检查 `dissolved_at`，解散后仍可能改名、邀请、改角色或移除成员。
7. Hub 管理端解散没有执行未完成任务取消。

---

## 当前模块职责

| 模块 | 当前职责 | 问题/边界 |
|---|---|---|
| DS Bot 原群聊客户端 | 群消息、composer、设置、详情、侧栏、创建表单 | 依赖 DSH shell 单 owner 面；当前已经存在少量 workgroup 分支 |
| DS Bot host `groups.js` / `roster.js` | 本地 room、轮次、@、群工具、成员工作 | 只服务本地群，不能直接承载 Hub 数据 |
| 当前工作群 client | 自有消息/成员/审批/设置视图 | 与要求的结构级一致差距最大 |
| 当前工作群 host bridge | Hub 连接、配置、Host 端 endpoint | 已具备主要传输；缺少 Bot 发布、Bot 成员、通知等 endpoint |
| Workgroup integration client/bridge | Hub API、WSS、状态 reducer | 没有 Bot 成员、公告、解散、Bot 邀请事件 |
| DSH shell | 会话布局、sidebar 单 owner、overlay list、conversation factory | 限制了工作群 UI 的挂载方式 |
| Hub rooms 模块 | 房间、真人成员、邀请、改名、解散 | 缺公告、Bot 成员、live guard 完整性 |
| Hub bots 模块 | 目录、可见性、心跳 | 目录不是房间成员；产品侧没有自动发布本地 Bot |
| Hub tasks 模块 | 任务状态、审批、授权、进度 | 目标 Bot 只按目录可见性校验，不按房间 Bot 成员校验 |
| Hub admin 模块 | 运营管理、房间解散 | 解散路径与群主路径副作用不一致 |

### 规则重复/分散点

- Bot 可见性规则在 `bot_directory.isVisibleTo`、`openRoom` 的目录过滤、任务创建的目标 Bot 校验中各有一份相关判断；没有统一的“Bot 是否属于本房间”规则。
- 解散副作用分散在群主路由和 Hub 管理端路由；一个取消任务，一个没有。
- 当前工作群组件注释声称复用原版设置，但实际使用自有 `WorkgroupSettings`；视觉和交互无法靠现有实现自然收敛。
- 当前原群聊相关文件中已有工作群分支（例如群设置的 `kind === 'workgroup'`、侧栏的 workgroup session 例外）；已确认允许执行独立清理任务，将这些分支迁入工作群复制件/集成层，清理后的原群聊基线作为复制源。

---

## 可复用能力

可以直接复用或作为稳定基础的能力：

1. `wg:<roomId>` 会话身份与 Host/Browser 的识别规则。
2. Host 持有 Hub 连接、Browser 通过 `/api/bot` 访问的安全边界。
3. Hub 的房间、真人成员、邀请、消息、回复、mentions、附件、任务、审批、授权、成果、群记忆和审计能力。
4. 任务 owner-only 审批、短期授权、撤销后重新鉴权等安全机制。
5. 现有 `bot_directory` 的发布、可见性、心跳与 presence 规则。
6. 现有 Hub 管理端 `/admin/` 页面和服务端操作员鉴权。
7. 原群聊的 CSS 变量、图标、头像、卡片、按钮、动画和可访问性规则；这些可以作为复制的视觉基础，但不直接修改原群聊组件。
8. 原群聊的 `RoomAvatar`、`BotMark`、`Card`、`Row`、`InlineText` 等基础展示能力；工作群复制件可以选择复用这些非群聊专属原语。

---

# Impact Map

## 直接影响

| 模块 | 必然变化 |
|---|---|
| 原群聊清理 | 将历史 workgroup 分支从原群聊相关文件移入工作群复制件/集成层；原群聊本地行为不变 |
| 工作群客户端 UI | 用复制原群聊形成的新工作群 UI 替换当前自有主界面、设置、详情、成员和输入区 |
| 工作群侧栏/会话列表 | 增加工作群行、邀请入口、未读/审批提示；当前工作群没有原群聊式侧栏 |
| 工作群创建流程 | 三个已有入口继续使用；从自动日期名称改为打开复制原群聊式创建表单 |
| 工作群状态 reducer | 增加 notice、bots、bot invitations、dissolve、task activity 等 |
| Host workgroup bridge | 增加 Bot 发布、Bot 成员、公告、邀请、任务事件等 endpoint |
| Hub rooms 模块 | 增加 notice、Bot 成员、Bot 邀请、live guard、统一解散 |
| Hub bots 模块 | 与房间 Bot 成员关系对接；支持产品侧发布本地 Bot |
| Hub tasks 模块 | 目标 Bot 校验改为房间 Bot 成员规则；Bot 移除/成员移除时取消任务 |
| Hub admin 模块 | 解散走统一服务；管理后台展示一致状态 |
| DB | 新增 room notice、room_bots、room_bot_invitations；迁移既有工作群 Bot 可见性 |
| Contracts/events | 新增公告、Bot 成员、Bot 邀请、解散和任务活动事件/字段 |

## 上游

- 三个工作群入口均已存在：Bot 新建菜单、Bot 设置 → Group chats、命令面板；进入后已显示工作群内容。
- 原群聊清理任务先恢复原群聊基线，再作为工作群 UI 的复制源。
- Host 的本地 Bot roster 是 Bot 发布和 Bot 成员选择的来源。
- Hub 鉴权、设备会话和现有 Bot 目录是 Bot 授权的上游。
- 创建者身份和真人邀请关系决定工作群成员。
- 原有 `wg:` Session 创建/导航逻辑继续作为打开工作群的入口。

## 下游

- 工作群侧栏列表和工作群行打开 `wg:` Session。
- 工作群消息、@、回复、附件和任务卡依赖房间与 Bot 成员状态。
- 审批卡依赖任务、Bot 所有者和授权范围。
- 群详情、设置、群记忆、用量和成员工作状态读取同一房间快照。
- Hub 管理端列表/详情/消息和解散操作读取同一房间状态。
- 审计、事件和通知读取解散、Bot 成员、公告和任务变化。

## 横向

同一工作群对象会同时出现在：

- 创建表单；
- 侧栏列表；
- 群会话；
- 群设置；
- 群详情；
- 成员/Bot 选择器；
- 邀请收件箱；
- 任务/审批卡；
- 群记忆；
- Hub 管理端；
- 审计；
- 离线/重连状态。

所有入口必须读取同一 Hub 房间事实，不能由客户端各自维护一份房间成员或 Bot 成员状态。

## 确认无需修改

- 原版普通群聊的行为、数据、历史、本地 Session 和保存位置；允许先做一次只移除历史 workgroup 分支的清理，不改变本地行为。
- DSH 一级导航结构：不新增工作群一级导航。
- 私人聊天、Chief、下属 Bot 的模型/权限/工作目录执行机制。
- Hub 的独立部署方式、操作员鉴权和 `/admin/` 架构。
- 现有任务审批、授权、撤销和 task session 隔离的核心执行逻辑；只改房间/Bot 边界和成员变化后的取消联动。
- 现有消息文本、回复、mentions 和附件主存储模型；公告和 Bot 成员是新增房间关系，不改变消息格式。
- 群记忆服务端读写能力；主要缺客户端入口。

---

# Requirement 对照

## 已满足

| Requirement | 当前能力 | 结论 |
|---|---|---|
| 工作群是独立实体 | `rooms.kind = workgroup`、`wg:<roomId>` | 可复用 |
| 工作群基础消息 | Hub messages、roomSeq、回复、mentions、附件 | 可复用，客户端需换成复制原群聊的展示 |
| 远程 Bot 审批 | 三种派发、owner-only decision、grant/revoke | 可复用 |
| 群记忆服务端 | 创建、检索、修订、删除、ACL | 可复用，客户端需接入 |
| 群主/Hub 可解散，管理员不可 | 群主路由与服务端权限已限制 owner；Hub 管理端可解散 | 权限结论可复用；副作用需统一 |
| 消息幂等/顺序 | clientMessageId、roomSeq、补拉 | 可复用 |
| 非成员不可见 | 404 语义、成员校验 | 可复用 |
| 工作群与本地群隔离 | `wg:` 命名空间、独立 overlay | 可复用 |
| 三个工作群入口 | 新建菜单、Group chats 设置、命令面板均已存在并进入工作群内容 | 保留，不新增入口 |

## 需要修改

| Requirement | 需要变化 |
|---|---|
| 基础界面一模一样 | 工作群 UI 必须从原群聊代码复制，不能继续用当前自定义主界面 |
| 创建表单 | 三个已有入口改为打开复制原群聊的创建表单；增加名称、Bot 选择、邀请流程；不能自动日期名称 |
| 侧栏群行 | 增加工作群行、置顶/隐藏、未读、审批提示 |
| 群设置 | 公告、成员/Bot 管理、侧栏、解散；安全冲突项按工作群模型替换 |
| 群详情 | 群公告、成员、成员工作状态、停止成员工作、任务活动、群记忆 |
| 输入区 `+` | 文件、引用会话、定时任务；工作群权限适配 |
| 图片/附件 | 复制原群聊图片/附件展示，Hub ACL 不变 |
| Bot 成员列表 | 从自动派生列表改为明确房间 Bot 成员 |
| @ 候选 | 只列出房间 Bot 成员，不再列出所有可见 Bot |
| 任务目标校验 | 改为“目标 Bot 在房间 Bot 成员中” |
| 公告 | 服务端新增字段、接口和事件 |
| 解散 | 统一群主/Hub 管理端副作用；增加 dissolved live guard |
| 客户端事件 | 增加 notice、bot、invitation、dissolve、task activity 处理 |
| 工作群列表 | 使用 `/rooms` 列表；当前没有工作群侧栏列表 |

## 需要新增

1. 工作群 UI 复制模块：复制原群聊的创建、会话、输入区、成员、设置、详情和侧栏群行。
2. 工作群 roster/sidebar 状态：工作群列表、邀请、未读、置顶/隐藏、审批提示。
3. 入站真人邀请 UI 与 Bot 邀请 UI。
4. Host 本地 Bot 发布器：把本地 Bot 注册到 Hub directory 并维持心跳。
5. `room_bots` 与 `room_bot_invitations` 数据模型及 API。
6. `rooms.notice` 字段、更新接口和 `room.notice_changed` 事件。
7. 房间级任务事件读取接口，用于复制群聊中的任务活动时间线。
8. 统一房间 live guard、统一解散服务。
9. 工作群列表 summary 字段：成员数、Bot 数、最后消息时间/摘要、待审批数。
10. 复制 UI 的视觉/交互一致性测试与真实按钮回归。

## 冲突

**无未决需求冲突。本轮已确认以下裁决。**

### 已裁决 1：允许原群聊清理任务

- 允许做一次单独的原群聊清理任务，把历史遗留的 workgroup 分支从原群聊相关文件中移出。
- 清理目标：
  - 群设置中的 `room.kind === 'workgroup'` 分支；
  - 侧栏中的 workgroup session 例外；
  - 其他为了让工作群共享原群聊文件而加入的分支。
- 这些分支迁入工作群复制件或工作群集成层；原群聊本地行为、数据、样式和测试不得改变。
- 清理任务会修改现有原群聊文件，但这是为了恢复“原群聊代码基线”，属于已批准的独立前置任务，不与工作群功能混在同一提交。
- 清理后的原群聊代码作为工作群 UI 的复制源。

### 已裁决 2：允许扩大复制范围

- 三个工作群入口已经存在并已进入工作群内容，不需要新增入口：
  1. Bot 新建菜单；
  2. Bot 设置 → Group chats；
  3. 命令面板。
- `sidebar.workspaces` 是 single owner，`TeamSidebar` 没有追加工作群行的子 slot；因此允许扩大复制范围，复制 TeamSidebar/侧栏容器来承载本地实体和工作群实体。
- 复制范围可以覆盖原群聊的创建、会话、composer、设置、详情、侧栏群行及必要的 shell 包装；以“不改原群聊代码、工作群独立演进”为边界，不为减少复制量而牺牲原群聊一致性。
- 复制侧栏仍必须完整保留本地 Bot、Agent、本地群行为。

### 已裁决 3：原群聊 Bot 自由发言与工作群远程 Bot 模型

- 原群聊 Bot 在同一台机器上，能在群里产生自由文本消息。
- 工作群 Bot 属于其他用户，只允许在审批后的任务中执行；工作群不能把远程 Bot 的自由发言当作原始消息。
- 工作群 Bot 的参与表现为**任务活动卡片/脱敏进度/成果**，使用原群聊 Bot 消息和卡片的视觉语言，而不是伪造一条 Bot 消息。

### 已裁决 4：原群聊管理员、目录、权限与工作群角色/任务范围

- 原群聊管理员是 Bot；“谁应答”、群工作目录、群权限都是本地群设置。
- 工作群管理员是人类；目录和工具范围由 Bot 所有者在任务审批时确定。
- 这些不是缺失，而是需求已裁决的工作群模型差异；复制设置界面必须用明确替代区呈现，不能保留会误导的无效控制。

---

# 技术设计

## 设计决策

### 决策 1：先清理原群聊历史 workgroup 分支，再复制基线

已确认允许单独执行原群聊清理任务：

- 把当前原群聊相关文件中的 workgroup 分支迁入工作群复制件或工作群集成层；
- 恢复原群聊文件为其本地群语义；
- 原群聊本地行为、数据、样式和测试保持不变；
- 清理完成后的原群聊代码作为工作群复制源，而不是继续从含 workgroup 分支的版本复制。

### 决策 2：工作群 UI 采用独立复制件，不直接改原群聊组件

复制范围：

- 原群聊创建表单；
- 群消息区与 Bot/用户消息呈现；
- composer、`+` 菜单、提及选择器、附件/图片；
- 群设置；
- 群详情、成员行、成员工作状态、审批卡；
- 原群聊式群会话行和侧栏容器；
- 原群聊相关 CSS/动画/可访问性规则。

复制件拥有自己的组件、样式和数据适配层；原群聊组件不被工作群分支继续侵入。工作群专属元素（Hub 状态、任务活动、Bot 邀请、群记忆、在线状态）只在复制件内新增。

### 决策 3：工作群继续使用 `wg:<roomId>` Session 与 overlay 挂载

- `conversation.content` 是单一组件工厂，且工作群消息不是本地 DSH Session 事件；强行塞入普通 conversation 会引入第二事实来源。
- 保留 `wg:` Session 和 `shell.overlay` 作为挂载点。
- overlay 内部使用复制原群聊的完整会话面，而不是当前自定义 thread/composer。
- 工作群专属活动（任务卡、Hub 状态、审批）以复制件内的增量组件呈现。

### 决策 4：复制侧栏容器，承载本地实体与工作群实体

已确认允许为正确承载工作群而扩大复制范围。因为 `sidebar.workspaces` 是 single owner，且原 `TeamSidebar` 没有追加行 slot：

- 工作群 UI 模块提供一份复制的 TeamSidebar 容器；
- 它继续渲染本地 Bot、Agent、本地群，保持原行为；
- 追加工作群行、邀请行/徽标和 Hub 状态；
- 原 `TeamSidebar` 文件不修改；复制件单独演进。

这是本方案最大的代码复制范围之一，也是“工作群行与原群聊一模一样”的必要代价。

### 决策 5：工作群 Bot 采用“目录发现 + 房间成员关系”

- `bot_directory` 继续负责 Bot 是否存在、是否可见、是否在线。
- `room_bots` 负责 Bot 是否属于当前工作群。
- @、任务目标、任务卡、成员列表都以 `room_bots` 为准；不再以“共享任意房间”的目录可见性代替房间成员关系。
- 拉入本人 Bot 可直接建立 `room_bots`。
- 拉入他人 Bot 走 Bot 邀请/所有者接受；所有者接受前不建立房间关系。

### 决策 6：公告属于房间设置，不属于消息

- `rooms.notice` 保存公告文本；
- 仅 owner/admin 可改；
- 修改后广播 `room.notice_changed`；
- 公告在复制后的群设置/群详情/消息头部按原群聊位置呈现。

### 决策 7：房间生命周期由一个 live guard 守护

所有会改变房间、成员、Bot 成员、邀请的入口统一检查房间是否已解散：

- 改名/公告；
- 真人邀请、接受邀请、撤销邀请；
- 角色变更、移除成员、离开；
- Bot 加入、Bot 邀请、Bot 移除；
- 发消息、创建任务、审批/取消/分享。

已解散房间只读。不能只靠客户端隐藏按钮。

### 决策 8：解散由一个统一服务完成

群主路由、Hub 管理端路由必须调用同一个解散域服务。该服务统一：

```text
校验 actor / operator 权限
↓
标记 room dissolved
↓
撤销真人邀请与 Bot 邀请
↓
取消未完成任务
↓
撤销执行授权
↓
写审计
↓
提交事务
↓
发布 room.dissolved
```

管理端和群主端只在 actor 形状上不同，不拥有两套副作用。

### 决策 9：任务活动采用独立活动流，不伪造消息

工作群 Bot 的执行进度和结果不写入 `messages`，避免污染消息顺序、回复和幂等。客户端通过：

- 现有任务事件实时推送；
- 新增房间级任务事件读取接口；

把任务活动投影成复制件中的活动卡。活动卡按时间与消息合并展示，使用原群聊 Bot 消息/卡片的视觉语言。审批动作仍在群详情/审批区域由 owner 操作。

### 决策 10：本地偏好保持本地，不进 Hub

置顶、隐藏、未读水位属于每台设备的 UI 偏好，沿用原群聊本地偏好语义，不因工作群而强制跨设备同步。Hub 不新增这类字段。

### 决策 11：Host 负责发布本地 Bot 到 Hub

当前产品代码没有把本地 Bot 发布到 Hub 的产品链路，只有测试直接调用 `POST /bots`。工作群要能选择自己的 Bot、审批时选择已有 Bot、被 @ 时解析 Bot，Host 必须新增：

- 本地 Bot 目录同步；
- 心跳/状态同步；
- Bot 重命名、删除后的更新/撤下；
- 不发送模型、Session、工作目录、能力等私有字段。

`bot_directory.visibility` 继续决定其他成员是否能在目录中看见并请求该 Bot；房间成员关系本身不改变目录的全局隐私设置。

---

## 数据

### 客户端数据

新增工作群客户端读模型：

```text
WorkgroupRoomView
├── room: id, name, notice, ownerUserId, myRole, createdAt, dissolvedAt
├── humans: userId, displayName, role, online
├── bots: ownerUserId, botId, displayName, presence, state, addedAt
├── messages: id, roomSeq, sender, body, reply, mentions, attachments, failed
├── activities: task events / progress / result cards
├── tasks: id, state, owner, requester, targetBot, updatedAt
├── invitations: 真人邀请
├── botInvitations: Bot 邀请
└── connection: online / reconnecting / offline
```

新增工作群列表读模型：

```text
WorkgroupRoster
├── rooms: summary[]
├── incomingInvitations: 真人邀请
├── incomingBotInvitations: Bot 邀请
├── hubState
└── local UI preferences: pinned, hidden, lastReadSeq
```

本地 UI 偏好单独存储，以 `wg:<roomId>` 或 Hub roomId 为 key；不写本地 room store，不把工作群伪装成本地群。

### Hub 数据

#### 复用

- `rooms` 基础字段、`kind`、`dissolved_at`；
- `room_members` 真人成员；
- `invitations` 真人邀请；
- `messages`、`tasks`、`approvals`、grants、`task_events`、`artifacts`、`group_memories`、`audit_events`；
- `bot_directory` 目录、可见性和 presence。

#### 新增

| 数据 | 目的 | 关键约束 |
|---|---|---|
| `rooms.notice` | 群公告 | 默认空字符串；长度约束与本地群一致（2000） |
| `room_bots` | 明确 Bot 房间成员 | 唯一 `(room_id, owner_user_id, bot_id)`；`removed_at` 支持软移除；所有者必须在房间内 |
| `room_bot_invitations` | 拉入他人 Bot 的所有者授权 | 唯一 pending `(room_id, owner_user_id, bot_id)`；有有效期和状态 |
| 房间列表 summary 字段 | 侧栏行/排序/提示 | 成员数、Bot 数、最后消息时间/摘要、owner 的待审批数 |
| 任务事件房间查询 | 任务活动历史 | 只读、按成员权限过滤、只返回脱敏公开 payload |

#### 数据归属

- Hub 是房间、真人成员、Bot 成员、公告、消息、任务、审批、群记忆和审计的唯一事实源。
- Host 是本地 Bot 身份、模型、Session、私有目录和本地 UI 偏好的事实源。
- 工作群客户端只缓存 Hub 读模型；不能用本地 roster 推断工作群成员或 Bot 成员。
- 目录可见性回答“能否发现/请求”，`room_bots` 回答“是否属于本房间”，二者不能混用。

#### 关键约束

1. 只有工作群 kind 能使用工作群 Bot 成员和公告行为。
2. Bot 所有者必须是房间活跃真人成员。
3. Bot 加入/邀请/移除都必须检查房间未解散。
4. Bot 所有者退出或被移除时，必须移除其 Bot 房间成员并处理关联任务。
5. Bot 移除后不能再被 @、不能被新任务选中。
6. 公告更新仅 owner/admin，长度不能超过原群聊约束。
7. 同名/重复 Bot 成员由唯一约束防止重复。
8. 所有房间修改都在服务端重新鉴权，客户端权限只影响展示。

### 迁移

- 新增字段/表全部为 additive migration。
- `rooms.notice` 旧数据默认空。
- `room_bots` 迁移时按当前 `openRoom` 的可见 Bot 口径回填：工作群内活跃真人成员拥有的、目录 visibility 为 `public`/`room` 的 Bot，视为已加入；同时回填历史任务中仍引用且所有者仍在房间的 Bot。
- 不自动创建 Bot 邀请。
- 解散状态、消息、任务、审批、群记忆、审计保持原行，不删除。
- 复制 UI 不读取旧工作群自定义视图的数据；所有数据从 Hub 新读模型进入。

---

## 核心流程

### 1. 创建工作群

```text
三个已有入口（新建菜单 / Group chats 设置 / 命令面板）
↓
打开复制原群聊的创建工作群表单
↓
填写群名、选择自己的 Bot（可选）、输入/选择要邀请的真人
↓
Host 创建 `wg:` Session 之前先调用 Hub 创建 room
↓
Hub：
  校验名称、kind
  创建 room + owner membership
  校验并创建所选 own Bot 的 room_bots
  返回 room + bots
↓
Host 创建/打开 `wg:<roomId>` Session
↓
工作群列表和工作群行出现
↓
真人邀请保持 pending，等待接受
```

创建者必须是 owner；不从原群聊复制“管理员 Bot”概念。人类管理员可在创建后设置。

### 2. 打开和侧栏同步

```text
Hub 可用
↓
工作群 roster 拉取 /rooms 列表 + 入站邀请
↓
复制侧栏渲染工作群行
↓
用户点击行
↓
enterWorkgroup 创建/打开 `wg:` Session
↓
overlay 复制群聊面挂载
↓
openRoom 读 room/members/bots/messages/tasks
↓
Bridge 事件增量更新
```

工作群行不使用本地 `roster.rooms`；防止被原群聊数据路径误认为本地群。

### 3. 发消息

```text
复制 composer
↓
Hub send（clientMessageId、replyToMessageId、mentions、attachments）
↓
Hub 校验 live room、成员、replies、mentions、attachments
↓
写 messages，分配 roomSeq
↓
事件 message.created
↓
reducer 按 id/roomSeq 去重排序
↓
复制消息区显示；失败保留草稿并标未送达
```

### 4. @ Bot 与任务

```text
用户在复制提及选择器选择房间 Bot
↓
消息 mentions 携带 ownerUserId + botId
↓
Hub 校验：
  发送者是成员
  bot 在 room_bots
  bot 所有者仍是房间成员
  房间未解散
↓
消息入库
↓
proposeTasksForMentions 创建 pending task
↓
仅 Bot 所有者看到审批卡
↓
批准 → grant → 本地 Task Session
↓
task.progress / task.shared / task.cancelled
↓
工作群活动流更新
```

任务目标 Bot 的校验必须只认 `room_bots`，不能再使用“与所有者共享任意房间”的目录可见性。

### 5. 拉入 Bot

```text
自己的 Bot：
  复制成员管理 -> 选择自己的 Bot
  -> POST /rooms/:id/bots
  -> Hub 校验 owner、member、live、directory entry
  -> room_bots 插入
  -> room.bot_added
  -> 成员列表、@ 候选更新

他人的 Bot：
  复制成员管理 -> 从可见目录选择 Bot
  -> POST /rooms/:id/bot-invitations
  -> Hub 校验请求者为 owner/admin、Bot 可见、所有者是房间成员
  -> pending bot invitation
  -> Bot 所有者收件箱
  -> 接受 -> room_bots 插入
  -> 拒绝/过期/撤销 -> 不建立关系
```

私有 Bot 不因邀请而暴露目录信息；不可见时请求方无法创建邀请。

### 6. 移除 Bot / Bot 所有者离开

```text
移除动作
↓
校验 actor：Bot 所有者本人，或房间 owner/admin
↓
标记 room_bots.removed_at
↓
取消目标/执行 Bot 的非终态任务（或按确认规则停止）
↓
撤销关联 grant
↓
审计
↓
room.bot_removed
↓
成员列表、@ 候选、任务目标立即失效
```

Bot 所有者离开/被移除时，同一流程批量处理其拥有的 Bot。

### 7. 公告

```text
复制设置页
↓
owner/admin 修改公告
↓
PATCH /rooms/:id { notice }
↓
live guard + 权限 + 长度校验
↓
事务写 rooms.notice
↓
room.notice_changed
↓
复制设置/详情/群头部同步
```

### 8. 解散

```text
群主客户端或 Hub 管理端
↓
统一 dissolve domain service
↓
校验 dissolved / actor
↓
标记 dissolved_at/by
↓
撤销真人邀请和 Bot 邀请
↓
取消未完成任务
↓
撤销 grants
↓
审计 + room.dissolved
↓
复制 UI 进入只读历史
```

### 9. 任务活动

```text
初始打开
↓
读取 messages + tasks + room task-events
↓
复制消息区和活动区按时间合并
↓
实时 task.* 事件追加活动卡
↓
任务审批/复核操作仍由 owner 在复制详情/审批区执行
```

任务活动不是消息；不占用 roomSeq，不参与消息幂等，不伪造发送者。

### 10. Hub 离线

```text
Bridge 状态变化
↓
复制 UI 显示在线/重连/离线
↓
普通群聊、私人聊天、本地 Bot 不受影响
↓
工作群停止写操作；保留已加载内容
↓
重连：消息补拉、任务/邀请重新同步
↓
未确认消息不标记成功
```

---

## 状态

### 工作群房间

```text
Active
├── 群主解散 ───────┐
└── Hub 管理端解散 ─┤
                     ▼
                 Dissolved
                 历史只读
```

- 初始：Active。
- 终态：Dissolved；不允许改名、改公告、邀请、Bot 成员修改、发消息、创建任务、审批、取消、分享。
- 触发者：群主、Hub 管理端操作员。
- 管理员和普通成员不能解散。

### 真人邀请

```text
Pending → Accepted
        → Declined
        → Expired
        → Revoked（邀请人或房间管理员）
        → RoomDissolved（房间解散时批量撤销）
```

### Bot 成员关系

```text
NotJoined
├── 自己加入 → Active
└── Bot 邀请 → PendingOwnerConsent
                  ├── 接受 → Active
                  ├── 拒绝 → Rejected
                  ├── 过期 → Expired
                  └── 撤销 → Revoked
Active → Removed（Bot 所有者移除/房间管理员移除/所有者离开）
```

- 只有 Bot 所有者可以接受/拒绝他人的 Bot 邀请。
- 移除或所有者离开后，Bot 不再可 @、不再接受新任务。
- 已解散房间只保留历史成员展示，不再允许新加入。

### 任务

沿用现有任务状态机：

```text
PENDING_APPROVAL → APPROVED → QUEUED → RUNNING → REVIEW_REQUIRED → COMPLETED/SHARED
                 → REJECTED
                 → EXPIRED
                 → CANCELLING → CANCELLED
                 → FAILED
```

- 任务决策使用版本号，已有并发保护。
- Bot 移除、成员移除或房间解散时，非终态任务必须取消。
- 终态任务不可恢复；新执行必须新任务、新审批。

### Hub 连接

```text
Online ↔ Reconnecting ↔ Offline
```

- 由 Bridge/Hub 可达性触发。
- 离线时工作群只读；本地实体不受影响。

---

## 模块职责

### 客户端

| 模块 | 职责 |
|---|---|
| 工作群复制 UI 模块 | 复制原群聊的创建、消息、composer、设置、详情、侧栏群行；只渲染，不直接持 Hub 连接 |
| 工作群数据适配器 | 把 Hub 房间/Bot/消息/任务/活动转换成复制 UI 需要的读模型；不得伪造本地 room |
| 工作群 roster/store | 工作群列表、邀请、Hub 状态、本地 pin/hide/unread 偏好 |
| 工作群 reducer | 处理消息、成员、Bot、公告、邀请、解散、任务活动事件 |
| Host bridge | Hub 连接、鉴权、Bot 发布、Room/Bot/任务 endpoint |
| 复制侧栏容器 | 渲染本地 Bot/Agent/本地群和 Hub 工作群行；打开 `wg:` Session |
| 复制创建/设置/详情 | 使用工作群语义，不修改原群聊对应组件 |

### 服务端

| 模块 | 职责 |
|---|---|
| rooms | 房间、真人成员、邀请、公告、记录房间生命周期；拥有 live guard |
| room bots | 新模块或 rooms 子模块：`room_bots`、Bot 邀请、Bot 成员权限和事件 |
| bots | Bot 目录、可见性、presence；不拥有房间成员关系 |
| tasks | 任务状态、目标 Bot 成员校验、成员变化后的取消联动 |
| approvals/grants | 现有 owner-only 审批和授权；不改变核心权限 |
| admin | 管理端查询/解散；调用统一 dissolve 服务 |
| memory/artifacts | 现有能力，工作群 UI 接入 |

### 单一规则归属

- **Bot 是否属于房间**：只在服务端房间 Bot 成员校验函数中判断。
- **房间是否可写**：只在 live room guard 中判断。
- **解散副作用**：只在统一 dissolve 服务中实现。
- **任务状态转换**：继续只在任务域中实现。
- **Bot 所有者审批**：继续只在审批域中实现。
- 客户端只负责按钮可见性和错误呈现，不复制授权判断。

---

## API

### 复用/扩展

| API | 变化 | 权限/语义 |
|---|---|---|
| `POST /api/v1/rooms` | 支持 `name`、`kind=workgroup`、可选 `botIds`（创建者自己的 Bot） | 认证用户；名称校验；room + owner + 所选 Bot 同事务 |
| `GET /api/v1/rooms` | 增加 summary 字段 | 只返回当前用户有效成员房间 |
| `GET /api/v1/rooms/:roomId` | 返回 `notice`、`bots`、`myRole`、`dissolvedAt` | 成员；非成员 404 |
| `PATCH /api/v1/rooms/:roomId` | 支持 `name`、`notice` | owner/admin；live；长度/权限错误 |
| `POST /rooms/:roomId/invitations` | 增加 live guard | owner/admin；pending 去重 |
| `GET /api/v1/invitations` | 保持 | 当前用户收件；UI 新增 |
| `POST /invitations/:id/accept` | 增加 live guard | 仅被邀请人；过期/非 pending 错误 |
| `POST /invitations/:id/decline` / `revoke` | 保持 | 现有权限 |
| `GET /rooms/:roomId/messages` | 保持 | 成员 |
| `POST /rooms/:roomId/messages` | mentions 校验改为房间 Bot 成员 | 成员；live；幂等 |
| `GET /rooms/:roomId/tasks` | 保持/可增加活动摘要 | 成员 |
| `POST /rooms/:roomId/tasks` | 目标 Bot 校验改为 `room_bots` | 成员；Bot 必须房间成员 |
| `POST /tasks/:id/decision` | 保持 | 仅 owner；版本并发 |
| `POST /tasks/:id/cancel` | 保持；成员变化联动调用 | 请求人/owner/房间管理员 |
| `POST /rooms/:roomId/dissolve` | 调用统一 dissolve 服务 | 仅 owner |
| `GET /rooms/:roomId/memories` | 保持 | 成员 + 记忆 ACL |
| `POST /bots` / `POST /bots/:id/heartbeat` | Host 新增产品调用 | 仅 Bot 所有者；目录发布/心跳 |

### 新增

| API | 输入/输出 | 权限/错误 |
|---|---|---|
| `POST /rooms/:roomId/bots` | `{botId}`；返回活动 Bot 成员 | 仅本人 Bot；成员；live；404 未发布/不可见；409 已存在 |
| `GET /rooms/:roomId/bot-candidates` | 返回自己的 Bot + 对调用者可见的其他成员 Bot | 成员；不返回私有 Bot 的额外字段 |
| `POST /rooms/:roomId/bot-invitations` | `{ownerUserId, botId}`；返回 pending 邀请 | owner/admin；Bot 对调用者可见；所有者是成员；live |
| `GET /api/v1/bot-invitations` | 当前用户收到的 pending Bot 邀请 | 仅被邀请 Bot 所有者 |
| `POST /api/v1/bot-invitations/:id/accept` | 建立 `room_bots` | 仅 Bot 所有者；live；Bot/所有者仍有效 |
| `POST /api/v1/bot-invitations/:id/decline` | 拒绝邀请 | 仅 Bot 所有者 |
| `POST /api/v1/bot-invitations/:id/revoke` | 撤销邀请 | 邀请人/房间 owner/admin |
| `DELETE /rooms/:roomId/bots/:ownerUserId/:botId` | 软移除 Bot 成员 | Bot 所有者或房间 owner/admin；live；触发任务取消 |
| `GET /rooms/:roomId/task-events` | 分页返回脱敏任务事件 | 成员；按时间/游标分页；不返回私有 scope |
| `DELETE /api/v1/admin/workgroups/:id` | 管理端解散 | 操作员；统一 dissolve；返回 cancelledTasks |

### API 设计约束

- 所有房间级响应都包含 `dissolvedAt`（存在时）和 `myRole`。
- 非成员统一 404，避免房间存在性泄露。
- 已解散房间的写接口统一 409 `ROOM_DISSOLVED`。
- Bot 不可见/不在房间的错误不暴露 Bot 私有信息。
- Bot 邀请重复请求返回同一 pending 邀请，不新增行。
- Bot 添加/移除符合唯一约束并幂等处理。
- 任务事件只返回 Hub 已脱敏的公开 payload。
- 旧客户端忽略新增字段和未知事件；新客户端在 Hub 缺少新能力时禁用相关入口并显示升级提示。

---

## 前端

### 页面入口

三个工作群入口已经存在，进入后已经显示工作群内容；本次保留入口，不新增第四个入口：

1. Bot 新建菜单中的“创建工作群聊”，位于“创建群聊”正下方；
2. Bot 设置 → Group chats 中的“创建工作群聊”；
3. 命令面板中的“创建工作群聊”。

三处入口统一改为打开复制原群聊的创建表单，创建成功后进入工作群复制会话，不直接生成日期名称。

- 工作群行进入工作群复制会话。
- 入站真人邀请和 Bot 邀请进入工作群侧栏的邀请区/徽标。

### 页面状态

复制 UI 的每个页面都有：

- loading：骨架/加载文案与原群聊相同；
- empty：无消息、无成员、无任务、无群记忆；
- error：Hub 不可达、无权限、房间解散、Bot 不可用、邀请过期；
- success：消息发送、设置保存、Bot 加入/移除、邀请接受、解散；
- offline：保留已加载内容，写操作禁用，明确状态。

### 数据来源

- 工作群列表：Hub `/rooms` + 本地缓存；
- 工作群详情：`openRoom` 快照 + Bridge 事件；
- 邀请：Hub 邀请接口 + `invitation.created`/Bot 邀请事件；
- 任务活动：任务列表 + 房间任务事件 + 实时 `task.*`；
- 群记忆：Hub memory 接口；
- 本地 pin/hide/unread：本地 UI store。

### 列表/详情关系

- 列表行读取 summary：名称、成员数、Bot 数、最后活动、未读、审批提示、Hub 状态。
- 打开详情时才读取完整成员、Bot、消息、任务和记忆。
- 列表不复制完整房间快照，避免每个行一个重请求。
- 详情快照更新后，列表摘要同步刷新。

### 复制 UI 结构

```text
工作群复制 Shell
├── 复制侧栏容器（本地实体 + 工作群行 + 邀请）
├── 复制群会话
│   ├── 群头部/公告
│   ├── 消息区（人类消息 + 任务活动卡）
│   ├── 复制 composer
│   │   ├── 文本/发送
│   │   ├── `+`：文件、引用会话、定时任务
│   │   ├── @ 提及
│   │   └── 附件/图片
│   └── 群详情抽屉
│       ├── 群概览/公告
│       ├── 成员/Bot 成员
│       ├── 工作状态/任务活动
│       ├── 审批卡（owner）
│       ├── 用量/任务统计
│       └── 群记忆
└── 复制群设置
    ├── Profile：名称/公告
    ├── Members：真人/Bot
    ├── 任务协作说明（替代原群级权限/目录）
    ├── Sidebar：pin/hide
    └── Manage：解散（owner）
```

### 权限表现

- 普通成员看不到房间管理按钮；不能解散/改设置/移除他人。
- 管理员可管理成员、Bot 成员、公告/名称、邀请；不能解散。
- 群主可解散。
- Bot 所有者可接受/拒绝 Bot 邀请，批准/拒绝自己的任务。
- 非 Bot 所有者看不到审批操作，只能看脱敏状态。

### 组件复用

- 复制件内部可以复用原群聊的非业务基础原语（颜色变量、图标、Card、Row、InlineText、RoomAvatar、BotMark）。
- 不直接 import 原群聊业务组件（GroupMessage、GroupSettingsForm、GroupOverview、RoomRow、ComposerPlus 等）；这些以复制件形式存在。
- 工作群专属卡片使用复制件的类和设计 token，不另建第二套配色/动效体系。

---

## 后端

### Controller / Service / Domain

- Controller：解析 HTTP、鉴权中间件、错误映射；不执行业务规则。
- Domain service：
  - room lifecycle + live guard；
  - member invitation/removal；
  - room Bot membership/invitation；
  - notice update；
  - dissolve；
  - task target validation and cancellation linkage。
- Repository/DB：事务、唯一约束、软删除、审计。
- Realtime publisher：事务提交后发布事件；禁止事务内广播。

### 事务边界

- 创建房间 + owner + 所选 own Bot：单事务。
- 修改公告：单事务 + 审计 + 事件后置。
- 加入/移除 Bot：单事务更新 `room_bots`、审计；关联任务取消使用同一领域操作或可靠后置补偿，不能留下可审批任务。
- 移除真人：单事务标记成员、撤销邀请、移除其 Bot 成员；关联任务取消。
- 解散：单事务标记房间、撤销邀请、取消任务、撤销 grants、写审计；事件后置。
- 消息/task：沿用现有事务与版本/幂等。

### 并发与幂等

- 消息：`clientMessageId` + 唯一约束。
- 任务：`version` 乐观并发。
- Bot 成员：唯一键；重复添加返回现有成员。
- Bot 邀请：pending 唯一；重复请求返回现有邀请。
- 公告/名称：当前按最后写入生效；事件携带最终值。若产品要求冲突提示，再引入房间版本字段；本需求不作隐式扩展。
- 解散：重复解散返回 409；管理端/群主端统一。

### 异常与事件

新增或扩展事件：

- `room.notice_changed`
- `room.bot_added`
- `room.bot_removed`
- `bot_invitation.created`
- `bot_invitation.changed`
- `room.dissolved`（扩展 `pendingTasks`/`dissolvedBy` 语义）
- `task.progress` / `task.shared` 继续使用，供活动流

所有事件必须在事务提交后发布；事件载荷不能包含 Bot 私有目录、模型、Session、工具 scope 或邀请秘密。

---

## 兼容 / 迁移

### 历史数据

- 新增 notice 默认空，不改变既有 room 读取。
- 新增 room_bots 回填当前工作群可见 Bot，保证升级后不丢失当前 Bot 列表。
- 历史任务的 target/assigned Bot 在所有者仍是房间成员时回填。
- 历史消息、回复、mentions、附件、任务、审批、群记忆、审计不迁移、不清空。
- 旧工作群没有公告，按空公告显示。
- 旧工作群没有 Bot 邀请，按空邀请列表显示。

### 老接口

- 新增字段是 additive；旧客户端可忽略。
- 旧客户端仍可能从目录自行推导 Bot；Hub 对 @/任务的房间 Bot 校验会拒绝非成员 Bot。该行为是安全降级，不泄露额外数据。
- 新的工作群 UI 需要 Hub capability 检查；Hub 不支持房间 Bot/公告时，客户端禁用相关入口并提示升级，不假装成功。
- `room.dissolved`、`room.notice_changed`、Bot 事件对旧客户端是未知事件，旧客户端忽略；新客户端负责更新。

### 老页面

- 原群聊组件和页面不改；工作群复制件独立。
- 当前工作群自有页面由新复制 UI 替换；不保留旧 `WorkgroupSettings`/自定义 thread 作为第二套入口。
- Hub 管理端继续在 `/admin/`，只改解散行为和必要展示；不新增独立前端项目。

### 默认值

- 公告默认空。
- 工作群 Bot 成员：迁移回填；新建工作群默认无 Bot。
- 工作群 pin/hide：默认 false。
- 工作群未读：默认无。
- 工作群 Hub 状态：未知 → 连接后确定。

---

# 风险

## 风险 1：清理与复制范围大，导致原群聊或复制件漂移

- **原因**：已批准的原群聊清理任务会触碰原群聊相关文件；为满足原群聊式一致，复制范围又覆盖创建、消息、composer、设置、详情、侧栏容器。
- **影响**：清理可能改变本地群行为；复制件容易与原群聊漂移；后续上游修复不会自动进入工作群。
- **处理**：清理任务单独提交，只迁移 workgroup 分支并以原群聊回归证明行为不变；建立复制件与源文件的对应清单和同步检查；视觉回归固定窗口/主题/语言/缩放；将复制件测试作为交付门槛。

## 风险 2：单 owner 槽位造成侧栏替换风险

- **原因**：`sidebar.workspaces` 单 owner；原 TeamSidebar 无扩展行 slot。
- **影响**：复制侧栏成为全局侧栏，本地 Bot/Agent/本地群也会经过复制件；任何行为差异都会伤到原群聊。
- **处理**：复制侧栏必须包含原侧栏全部行为；对原侧栏做完整回归；保留原侧栏文件不动；必要时增加静态断言防止两套数据混用。

## 风险 3：本地 Bot 发布链路当前不存在

- **原因**：产品 Host 当前没有把本地 Bot 发布到 Hub 目录的产品代码，只有测试直接调用 `/bots`。
- **影响**：没有发布就没有可拉入 Bot、没有审批目标、没有可 @ 的 Bot。
- **处理**：把 Host Bot 发布、心跳、改名/删除同步作为工作群 Bot 功能的前置能力；测试覆盖登录后目录出现、重命名、删除和离线状态。

## 风险 4：Bot 成员迁移改变既有可见列表

- **原因**：当前 Bot 列表是自动派生，升级为显式 `room_bots` 需要回填。
- **影响**：回填过多会把未意图共享的 Bot 加入；回填过少会让当前可见 Bot 消失。
- **处理**：严格按现有 `openRoom` 可见口径回填；提供迁移审计和回滚验证；升级验收必须对比升级前后 Bot 列表；不删除任何历史。

## 风险 5：Bot 所有权与房间管理权限混淆

- **原因**：原有目录可见性、房间管理员、Bot 所有者、任务 owner 是四个不同角色。
- **影响**：错误地让房间管理员代替 Bot 所有者授权，或让目录可见直接等于房间成员。
- **处理**：房间 Bot 成员和 Bot 邀请只在服务端校验；Bot 所有者接受才建立关系；任务审批仍只看任务 owner。

## 风险 6：解散/移除 Bot 与任务取消不一致

- **原因**：解散、移除 Bot、移除成员、取消任务涉及多张表和 grants。
- **影响**：房间已结束但任务仍可审批/执行；Bot 已移除但旧任务仍可派发。
- **处理**：统一 dissolve/removal domain service；事务内完成状态变化，事件提交后发布；对“取消中/已有 grant”做专项并发测试。

## 风险 7：已解散房间的写入口遗漏

- **原因**：当前改名、邀请、接受邀请、角色、移除成员等路径没有统一 live guard。
- **影响**：解散后仍能变更房间、邀请加入或改变成员，破坏只读语义。
- **处理**：所有房间写接口统一调用 live guard；测试覆盖每个入口的 409 `ROOM_DISSOLVED`。

## 风险 8：复制 UI 与 Hub 读模型错位

- **原因**：工作群不是本地 room，复制 UI 需要新的成员/Bot/活动模型。
- **影响**：复制 UI 误用本地 roster、把 Bot 当本地成员、或把任务活动当消息，导致状态不同步。
- **处理**：定义唯一工作群读模型；复制 UI 只接受适配器数据；禁止向本地 `roster.rooms` 注入工作群；加类型/契约测试。

## 风险 9：旧客户端与新 Hub 的协议漂移

- **原因**：Hub 和客户端可独立部署；Bot 成员、公告、事件是新增能力。
- **影响**：旧客户端可能看到目录 Bot 但 @ 失败，或不知道房间已解散。
- **处理**：新增字段/事件保持 additive；客户端检测 Hub capability；旧客户端安全降级并提示升级；服务端继续保持非成员 404 和 owner-only 审批。

## 风险 10：任务活动流的排序与隐私

- **原因**：消息有 `roomSeq`，任务事件按时间；两者合并展示需要排序，且任务事件必须保持脱敏。
- **影响**：活动顺序错乱可能误导用户；错误地展示私有 scope 会泄漏目录/工具。
- **处理**：服务端只返回 `publicTaskEvent`；客户端用统一时间 + 稳定 id 排序；不把活动写入 messages；不做假的 Bot 发送者。

## 风险 11：定时任务与引用会话的安全边界

- **原因**：原群聊的 `+` 菜单允许引用本地会话和定时触发；工作群跨用户。
- **影响**：可能把私人会话内容发送到 Hub，或定时绕过审批直接执行远程 Bot。
- **处理**：引用只允许调用者有权读取的数据，发送前明确预览；定时任务只发送消息或创建待审批任务，不直接执行 Bot；Host 本地调度失败必须可见。

## 风险 12：Hub 管理端与客户端状态不同步

- **原因**：Hub 管理端解散/成员操作与客户端事件并行。
- **影响**：管理端显示已解散但客户端仍可操作，或客户端已解散但任务仍可审批。
- **处理**：统一服务端 domain service 和事件；管理端/客户端都读取同一 room 状态；管理端解散返回 cancelledTasks 并广播。

---

# 技术方案摘要

```text
核心设计：
- 先执行已批准的原群聊清理任务，把历史 workgroup 分支迁入工作群复制件/集成层，恢复原群聊基线。
- 从清理后的原群聊代码复制创建、会话、composer、设置、详情和侧栏群行，形成独立工作群 UI。
- 工作群继续使用 wg:<roomId> Session 与 shell.overlay 挂载；复制完整群聊面，而不是继续自定义 WorkgroupView。
- 三个工作群入口已经存在并进入工作群内容；本次保留三个入口，统一改为打开复制创建表单。
- 因 sidebar.workspaces 是单 owner，允许扩大复制范围，用复制的 TeamSidebar 容器同时承载本地 Bot/Agent/本地群和工作群。
- Hub 新增 rooms.notice、room_bots、room_bot_invitations；Bot 目录继续负责发现/在线，房间 Bot 成员负责本群权限。
- 所有房间写入口统一 live guard；群主与 Hub 管理端解散统一调用一个 domain service。
- Host 负责把本地 Bot 发布到 Hub directory 并维持心跳；这是“拉机器人”的前置链路。

主要变化：
- 原群聊清理任务先移除历史 workgroup 分支。
- 工作群 UI 从自有实现切换为原群聊复制件。
- 三个已有入口从“立即创建日期名称”改为“打开复制创建表单”后进入工作群。
- 新增工作群列表、邀请收件箱、Bot 选择器、Bot 邀请、公告、任务活动流。
- Hub 房间模型新增公告和 Bot 成员关系；任务目标改为房间 Bot 校验。
- 解散、Bot 移除、成员移除与任务取消联动。
- 增加房间级任务事件读取接口和实时 reducer 支持。

复用：
- wg: Session、Host Hub 连接、Hub 鉴权、消息幂等/补拉、任务审批/grant、群记忆、附件、审计、管理员后台。
- 原群聊的 CSS token、图标、头像、Card/Row/InlineText 等基础展示能力作为复制基础。

新增：
- 独立工作群 UI 复制模块和工作群数据适配器。
- 工作群 roster/sidebar 状态、入站邀请、Bot 邀请。
- 本地 Bot 发布/心跳链路。
- room_bots、room_bot_invitations、rooms.notice。
- 房间级任务事件读取、公告/Bot/邀请/解散事件。
- 统一 live guard 和 dissolve domain service。

关键影响：
- application 客户端的群聊 UI、侧栏、创建、设置、详情、输入区全面重构为复制件。
- server 的房间、Bot、任务、管理端和数据库均需配套修改。
- 原群聊本地功能必须保持不变，且需要回归测试。
- 工作群列表、Bot 成员、公告和任务活动成为新的跨模块事实源。

风险：
- 原群聊清理与复制范围大，清理可能影响本地群，复制件可能与原群聊漂移。
- 单 owner 侧栏替换影响本地群/Bot/Agent。
- 本地 Bot 发布链路目前缺失。
- Bot 成员迁移可能改变既有可见列表。
- Bot 所有权、房间管理、任务审批三种权限容易混淆。
- 解散/移除 Bot/取消任务需要统一事务与事件顺序。
- 已解散房间的写入口当前未全部设防。
- 旧客户端与新 Hub 的协议兼容需要 capability/降级策略。
- 任务活动流排序和脱敏必须严格。
- 定时任务、引用会话存在跨用户隐私边界。
```
