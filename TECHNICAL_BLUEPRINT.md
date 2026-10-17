# Workgroup AI｜完整技术方案与实施说明

> 独立新项目的首次立项技术蓝图。文中“建议接口/目录/字段”属于待实现设计；不能把源码分析直接解释为已经实机验证。调研日期：2026-10-14。详细公开源码地址见 `SOURCE_RESEARCH.md`。

## 1. 产品目标与交付边界

### 1.1 六项必达目标

1. Fork DeepSeek Harness，作为可与官方 DSH 共存的独立产品发行，保留桌面端和受支持的 Web/Host 多端能力；模型、工具、Session、Agent Loop 保留 DSH 原生实现。
2. 内置 Fork 的 DeepSeek-Bot，安装即带 Chief、下属 Bot、私人聊天和原版普通群聊，不要求用户安装第三方插件。DSH 现有**插件**入口保持在原位置，紧挨其下增加**一个 Bot 一级入口**；进入后才显示 DS Bot 自身的内部导航与全部功能。
3. 从可见界面移除**Session Log 删除操作**（具体组件/原版行为先查验），保持 Session/事件日志和归档、恢复能力。不得误删 Session 存储或隐匿必要的审计日志；本机文件所有者仍可操作系统文件，因此企业审计必须独立保存。
4. 以原版 DS Bot 群聊 UI、组件、样式和交互为基准制作**工作群聊**；原本地群聊完整保留、互不干扰。Bot 内部原“创建群聊”下方增加“创建工作群聊”。
5. 工作群为局域网真实用户协作：用户 ID 搜索/邀请、接受/拒绝、成员角色、消息同步、@真实员工与公开的远程 Bot、附件与群记忆；服务器在线可多电脑共享可见，断线后有顺序与补偿机制。
6. 财务 A 在工作群 @财务 B 的 Chief 发任务；B 本人在认证客户端审批；批准后 B 可以指定现有下属 Bot、让 Chief 选择一个下属 Bot、或新建专用 Bot 执行；仅 B 本地原生 Bot 读取获准的数据、执行任务、返回经批准的结果；拒绝/取消不可越权执行。

### 1.2 功能与非目标

- V1 必做：本机 DSH/Bot 功能回归、内置导航、真实群、人类审批、原生隔离任务、有限工具权限、审计、群记忆、任务分享、断线恢复、独立部署。
- V1 不做：让 Web 浏览器在未运行用户本地 Host 时控制本地工具、把所有人的 Agent Runtime 集中到 Hub、跨互联网 NAT 自动打洞、大规模公开社交、自动读取个人私人记忆、重新设计 DS Bot UI。
- 本地演示附加：Hub 管理端只管理工作群；用户只读；不做用户 CRUD、设备管理、审计 UI、消息搜索。
- 未来可选：外网 Hub、SSO、集群高可用、移动客户端、端到端加密群内容；**不能以将来功能替代 V1 权限边界**。

## 2. 唯一的两端项目架构

```text
                     公司局域网 HTTPS/WSS
员工 A 设备                                 员工 B 设备
application/                               application/
 Electron/Web + 本机 DSH Host               Electron/Web + 本机 DSH Host
  ├─ 原版 DSH UI/Agent                       ├─ 原版 DSH UI/Agent
  ├─ 内置 DS Bot (A 的 Chief/Bots)            ├─ 内置 DS Bot (B 的 Chief/Bots)
  ├─ Workgroup Client/Bridge                 ├─ Workgroup Client/Bridge
  └─ 本地授权/Task Session/Guard              └─ 本地授权/Task Session/Guard
       │                                           │
       └──────── TLS / WSS ────────┬───────────────┘
                                  ▼
                            server/ (Hub)
           users/devices/rooms/messages/approvals/tasks
                     group memory/audit/artifacts
```

**运行边界：** `server/` 在公司服务器独立进程运行。各员工设备运行 `application/` 自带 DSH Host；Bridge 是应用内模块，不是独立服务。Hub 是控制面与群聊消息面，不具备 DSH 工具执行权限。

**目录与部署约束：** 只允许两个顶层代码目录；协议、数据库、CI 配置、部署脚本全部在各自端内。若发布应用，打包 `application/` 的产物；若部署协作后端，仅复制 `server/` 到服务器。

## 3. 具体工程目录（目标形态，不是现成代码）

```text
Workgroup-AI/
├── application/
│   ├── apps/                         # 原 DSH apps/，包括 desktop/web
│   ├── packages/                     # 原 DSH packages/，保持上游组织
│   ├── vendor/                       # 上游实际存在时保留
│   ├── scripts/                      # 原 DSH 构建/维护脚本
│   ├── integrations/
│   │   ├── ds-bot/                   # Fork 原版 DS Bot 的 ds-bot 包
│   │   │   └── src/                  # 原版 host/client 结构尽量不改
│   │   └── workgroup/
│   │       ├── client/               # 群聊/邀请/审批/任务 React UI
│   │       ├── bridge/               # WSS 连接/重试/消息收发
│   │       ├── bot-adapter/          # 原生 Bot Task Session 生命周期
│   │       ├── policy/               # 本机审批缓存/工具 guard/文件约束
│   │       └── protocol/             # 生成的协议客户端/校验器
│   ├── docs/                         # 应用端调试与打包规范
│   └── tests/                        # 应用端真实/集成回归
│
├── server/
│   ├── src/
│   │   ├── index.js                  # 单一 Hub 进程入口（待实现）
│   │   ├── config/                   # 环境变量/安全默认值
│   │   ├── auth/                     # 用户/设备/令牌/签名鉴权
│   │   ├── api/                      # HTTP handlers
│   │   ├── realtime/                 # WSS 连接/推送/ACK
│   │   ├── modules/
│   │   │   ├── users/
│   │   │   ├── rooms/
│   │   │   ├── invitations/
│   │   │   ├── messages/
│   │   │   ├── presence/
│   │   │   ├── tasks/
│   │   │   ├── approvals/
│   │   │   ├── group-memory/
│   │   │   ├── artifacts/
│   │   │   └── audit/
│   │   └── db/                        # SQLite repository/migration runner
│   ├── contracts/                     # OpenAPI & JSON Schema 权威版本
│   ├── db/migrations/                 # Hub 专属 SQL
│   ├── deploy/                        # Docker/systemd/TLS/备份文档
│   ├── docs/                          # 服务端职责、通信设计
│   ├── tests/                         # Server API/DB/并发/安全测试
│   └── .env.example
│
├── README.md
├── AGENTS.md
├── TECHNICAL_BLUEPRINT.md
├── TASK_BOARD.md
├── ACCEPTANCE.md
└── SOURCE_RESEARCH.md
```

**说明：** `application/` 获取上游仓库后，还需保留其原生 `package.json`、`pnpm-lock.yaml`、构建资产和其它真实文件。上面只展示关键位置；实际路径在 P0 校验后记录，不得凭示意覆盖上游配置。

## 4. DSH 发行与 DS Bot 内置集成

### 4.1 独立发行

- 固定上游 Git commit/tag 与依赖 lockfile，保存来源、许可证、补丁列表；测试对应 Node/pnpm 的精确版本，不凭 `main` 自动拉最新。
- Windows/macOS Electron 与内置 Host 作为同一个兼容的发布单元。独立 appId、Protocol、更新渠道、用户数据目录、单实例锁；用户不需先安装官方 DSH。
- 与官方 DSH 并存时严禁共享可写的插件包、锁文件或 Bot/Session 数据根。新应用可提供**显式用户授权的导入**，但不能默认改写 `~/.dsh`。
- 保留 DSH Web/Host 能力；若客户端想调用用户本地工具，必须有本地运行并认证的 Host，普通浏览器不会凭空拥有本机执行能力。

### 4.2 原生 DS Bot Host

DS Bot `ds-bot/index.js` 的 `createRuntime(ctx, config)` 可作为源码接入研究入口，但**不能先创建两个相互争抢数据的 Bot Host**。优先采用单一加载路径，保障原版模块安装顺序和 DSH 注入服务可用。若遇到上游私有 API，不允许凭空构造替身；先写真实兼容测试，再小范围 Fork 扩展正式身份/生命周期接口。

### 4.3 Bot UI 导航强制验收

```text
DSH 左侧一级导航：
  ... （原样）
  插件                    ← 原入口原位置
  Bot                     ← 唯一新增一级入口
  ... （原样）

进入 Bot 页后展示完整原版 DS Bot UI：
  Chief / 下属 Bot / 私聊 / 群聊 / 设置等内部区域
  创建群聊                ← 原功能原位置
  创建工作群聊            ← 新增且正好位于它下方
```

- 不允许在 DSH 一级导航列出 Chief、机器人列表、普通群、工作群。
- 原版 DS Bot 现有侧边栏覆盖机制必须按选定 DSH 版本重构为**进入 Bot 时局部生效**，不影响 DSH 插件页、会话页或其他插件。
- UI 复刻优先直接 Fork/复用 DS Bot React 组件、原 CSS token/样式与交互；禁止平地创造另一套群聊 UI。不同群类型必须有清晰的 Hub 离线/在线状态。

### 4.4 Session Log

- 首先在锁定 DSH 版本中实测，确认“删除 Session Log”入口/操作是否存在及具体调用；存在则移除对应用户操作并检查后端越权删除路径；不存在则登记为“已满足，无须代码改动”。
- 必须保留日志写入、归档、恢复和审计，不删除底层 Session Log。服务器群审计是独立日志，适配数据保留策略。

## 5. 原版群聊与真实工作群的隔离

**原版普通群聊**：沿用 DS Bot 本地 Room、Bot 成员、原生消息与群聊模型（可运行离线）；不擅自改其历史/权限。**工作群聊**：Hub 创建全局 roomId，成员是实际 userId，机器人用 `{ownerUserId, botId}` 引用；消息由 Hub 产生顺序编号；工作群内的本地执行使用 Bridge + BotAdapter；未授权的个人 Bot 不显示/不响应。

- 创建：用户在 Bot 内部点击“创建工作群聊”，输入名称，Hub 以登录身份建立群并返回 roomId。
- 邀请：输入用户 ID，服务端解析用户 → 生成带有效期/角色范围的邀请，接收者明确接受；知道 roomId/userId 不构成访问许可。
- 成员：owner/admin/member；服务端每次读取消息、上传附件、搜索群记忆和任务状态都做成员检查；成员被移除时断开/取消该群授权，不再接收后续事件。
- 聊天：保存消息实体、发送者/时间/去重 key/群内 seq，WSS 推送，客户端离线通过 `GET /rooms/{id}/messages?after=` 补拉；按 seq 重排，避免重连重复消息。
- @：成员 mention 包含类型和稳定 ID；@远程 Bot 仅创建待审批任务候选，**不能直接触发对方本地执行**。
- 文件：先上传经过用户选择/批准的成果到 Hub 附件库（文件大小、类型、扫描和保留策略可配置）；绝不上传本地完整工作目录。
- Group Memory：将群消息摘要/规则/决策存为带 `sourceMessageId`、author、ACL、revision、validity 的长期知识；成员可检索，授权 Bot 可按需检索；必须支持修改/纠错、撤回和权限继承。旧私人 Bot Memory 与老普通群历史**不自动并入**。

### 5.1 原版群聊能力等价矩阵（工作群必须核对并继承）

| 原版 DS Bot 群聊能力 | 工作群如何继承 | 跨用户额外安全要求 |
|---|---|---|
| 群名称、成员列表、群设置及管理员 | 复用原版布局与交互，数据源换为 Hub rooms/members | 只有相应角色可改群配置 |
| 群输入框、历史消息、引用和图片/附件展示 | 继续使用 Bot 原生消息组件；接入 roomSeq/Hub 事件 | 附件需 ACL 和授权共享 |
| @ 指定 Bot，管理员默认应答 | 保留本机 Bot 行为；远程 Bot 以 ownerUserId+botId 解析 | 远程 @ 先请求本人审批，不可直接执行 |
| Bot 间接力、群内进度和任务结束 | 保留进度展示和终止入口，跨用户状态从 Task Event 映射 | 不公开私有工具日志和模型内部上下文 |
| “+ Reference a chat” 对其他聊天的引用 | 保留相同入口及交互；允许引用自己有权读取的数据 | 引用他人私人聊天必须由数据所有人逐次授权，默认拒绝 |
| 群内多机器人工作轮次与消息静默规则 | 本地可复用原版 rounds / PASS 逻辑 | 不得跨设备自动激活未经授权的 Bot |

**验收原则：** AI 必须先按锁定 DS Bot commit 枚举原版群聊真实功能与 UI 交互，再逐项做工作群兼容对照，以上是最低集合，不可把它当成原版完整功能清单。任何因安全模型改变的行为要写清差异并经确认，不能静默删除原能力。

## 6. 跨用户委派业务与状态机

### 6.1 端到端流程

A 在共享群 @B 的 Chief → Hub 校验双方成员及 B 是否公开此 Bot → 生成 `task`（AWAITING_APPROVAL）并仅把**请求摘要**发给 B 客户端 → B 本人认证后查看任务/拟使用的文件资源/工具/成果受众 → 选择拒绝或批准及分派模式（指定现有 Bot / Chief 自动分派 / 创建新 Bot）→ Hub 颁发短期一次性授权令牌，Binding 与 B 的设备和选定 Bot 关联 → B 的本地 Bridge 验证签名和范围 → BotAdapter 创建隔离原生 Task Session 并在工具层重新检查批准范围 → 群内仅同步经过脱敏的进度 → B 复核或允许自动发布范围内的最终产物 → Hub 分发给 A 和获准接收者。

### 6.2 任务状态（合法迁移必须在后端事务中校验）

`PENDING_APPROVAL → APPROVED → QUEUED → RUNNING → REVIEW_REQUIRED → COMPLETED/SHARED`；拒绝 `REJECTED`，超时 `EXPIRED`，中途 `CANCELLING → CANCELLED`，失败 `FAILED`。所有终态不可恢复执行；新的执行必须生成新 taskId 与新审批。

### 6.3 人类批准的真实含义

- 批准者是任务所有用户 B（设备登录会话 + 二次确认或强认证策略），不是 B 的管家替 B 决定；管家可以辅助解释/推荐，但不能替本人批准。
- 审批对象必须绑定：requesterUserId、ownerUserId、roomId、taskId、botId（或分派方式）、数据目录与文件白名单、允许的工具、执行过期时间、最大资源/网络边界、结果可见主体。
- 审批范围增大时再次本人审批；完成后不得延用 token 给下一任务；Hub 的数据库状态与 B 本地策略必须联合检查。

### 6.4 原生 Task Session 设计门槛（P0/G3）

DS Bot 身份由自身运行时及 Session 索引管理。禁止往普通 DSH Session 只贴一个 botId 就假装是原生 Bot；也禁止把外部请求塞入 B 的私人 Bot 对话。必须证明选中 B Bot 的角色、模型、指令、记忆访问、能力和工具策略正确绑定到独立 sessionId；保留持久映射、重启复原、释放/撤销和回收机制。

- 每次本地 save/refresh 后验证仍正确映射目标 Bot；映射可能会从 `store.js` 重建，不能仅修改内存 `groupOwners`。
- `createSession({dir})` 前做目录存在/realpath/根边界/符号链接/权限检查；无效直接拒绝，禁止默默退回默认团队工作区。
- Bot 原本拥有的 capabilities 必须与本次批准范围取交集，**权限只能收紧不能扩大**。
- Tool guard 在每次调用前检查 active grant/version、taskId、文件路径、命令、网络及参数；危险工具默认拒绝；子进程使用 OS 级隔离/资源限额，撤销杀死剩余进程并阻止重试。

## 7. 工作群协议与安全

### 7.1 服务端契约归属

- `server/contracts/openapi.yaml`：HTTP API 的权威草案。
- `server/contracts/events.schema.json`：WSS envelope 与事件格式草案。
- `application/integrations/workgroup/protocol/`：构建期生成或人工薄封装的 API 客户端/运行时校验；不可由 server import application 源码。
- 协议版本：`/api/v1`，WSS `wg.v1`，eventId、requestId、clientMsgId、createdAt、roomSeq、schemaVersion；拒绝不支持的 major 版本。

### 7.2 安全最低要求

- HTTPS/WSS，包括局域网；每设备单独密钥/凭据、短期访问令牌、刷新/吊销和服务端可信设备清单；生产禁止明文 HTTP token。
- 带签名/单次 nonce 的任务授予；设备被禁用、B 离线、批准过期、用户离群均不能自动执行受保护任务。
- 所有 HTTP 与 WSS 订阅端检查用户/群权限，客户端状态不可作为授权依据；输入校验、速率限制、审计不可省略。
- 严格区分消息可见、任务请求、数据读取、任务执行、成果共享这五类授权；群成员身份并不赋予私有 Bot 执行权限。
- 服务器不能通过 WS 向任意电脑发送 shell 命令；所有请求必须映射到本地允许的任务协议，且必须本地重新验签与授权。
- SQLite/WAL、事务+唯一约束保证消息去重、任务状态和审批不可竞态重复执行；DB/附件/证书分开备份，恢复演练。

## 8. 数据实体与迁移

详见 `server/db/migrations/0001_schema.sql`。基础实体：users、devices、rooms、room_members、invitations、messages、bot_directory、tasks、approvals、task_events、artifacts、group_memories、memory_revisions、audit_events、idempotency_keys、operators（独立管理员表）。`audit_events` 增加 `actor_operator_id`，用于记录 operator 操作。

完整群数据在 Hub 中；Bot 私人记忆、私人 Session、原生执行 logs 不上传。共享成果可在 server 对象存储（单机可用文件系统）保存，但应使用内容哈希、ACL 和引用关系管理。随着上传规模增长再引入对象存储，不因此增加第三代码项目。

## 9. 单服务器部署、升级与恢复

### 9.1 生产部署只使用 server/

将 `server/` 复制到一台无 DSH/DS Bot/Electron 源码的 Linux 服务器，安装固定 Node 版本和服务端依赖，提供持久 `data/` 目录与 TLS 证书，运行迁移，启动单一 Hub 进程。可在 `server/deploy/` 提供 systemd 和 Docker 方案，选择其一作为生产支持路线。安装应用端不需要安装 server 源码。`/admin/` 由同一个 `server/` 进程提供；默认 admin 仅限本地/内网演示，生产必须修改 `operators` 表中的密码并限制网络访问。

### 9.2 运维守则

- 容器/进程健康检查：liveness、readiness、DB 写入、WebSocket 心跳、磁盘容量；日志脱敏，审计单独保留。
- DB 升级先备份、应用可逆迁移策略，接口 major 兼容明确；客户端与 Hub 握手显示协议版本不兼容信息。
- 数据目录不得放在只读发布映像内，证书/密钥不提交 Git；设置备份频率、恢复目标及定期恢复演练。
- 单 Hub 宕机后普通 DSH/Bot 应继续工作；工作群消息断线补偿，任务审批失联需安全停止或待人工复核，不能绕过审批继续。

## 10. 质量门槛与立项阻断

- **G0** 上游锁版：有两仓库的真实 commit SHA、依赖环境与兼容矩阵，后续变更可复现。
- **G1** 应用真实构建：Windows/macOS 目标环境的 DSH 桌面及 Web/Host 基础功能回归。
- **G2** 内置 DS Bot：仅一份有效 Bot Runtime，Chief、私聊、普通群、UI 切换实际可运行。
- **G3** 隔离原生 Bot 任务：B 的下属 Bot 身份/模型/权限/记忆及生命周期在刷新、重启和撤销后保持正确。
- **G4** Hub 单独部署：只复制 server/ 到干净 Linux 可启动、可迁移、备份、升级；无 application 运行/依赖。
- **G5** 两台真机：用户邀请、群同步、实时 @、B 本人审批、隔离执行、成果共享端到端。
- **S1** 权限安全：跨群越权、伪造批准、重放、目录逃逸、符号链接、撤销后工具/子进程、附件可见性全部通过。
- **S2** 兼容恢复：断线重连、进程重启、升级和备份恢复在真实数据下完成。

发布必须全部完成对应门槛；源码存在接口、mock 测试或本机 TCP 通过，均不能表述为已通过 G1/G2/G3/G5。

## 11. 主要风险与决策点

| 风险 | 处理方式 | 阻断范围 |
|---|---|---|
| DSH 与 Bot 版本不匹配 | 固定真实 SHAs，首先做 G0-G2 | P0 |
| Bot UI 覆盖整个 DSH | 在 Fork 内将 UI 变为局部挂载 | P0 |
| 私有 rt API 在更新后失效 | 增加稳定 Task Session 扩展层与契约测试 | P0 |
| 原生 Bot 身份在索引重建后丢失 | 显式持久化绑定与恢复测试 | P0 |
| 无效任务目录回退到默认工作区 | 前置 realpath 验证、失败即拒绝 | P0 |
| 全权限继承 | 工具/路径/网络/进程的任务级强制交集 | P0 |
| SQLite 单机 Hub 吞吐瓶颈 | WAL + 压测，必要时扩展但不拆第三项目 | P1 |
| Hub 离线/移动客户端假定可用 | 降级状态与离线补偿，不承诺无 Host 本地执行 | P1 |
| 固定 admin 密码 | 仅本地/内网演示；生产修改 `operators` 密码并限制 `/admin` 网络访问 | P0 |
| 管理员可读消息正文 | 仅 operator；每次读取写审计；不记录正文 | P0 |

## 12. 开发顺序与交接方式

使用 `TASK_BOARD.md` 的逐项任务。推荐先 P0 源码/构建与 G3 技术探针，再做基础 Hub，再复用 Bot UI 开工作群，最后跨用户执行与安全。每个阶段都需提交实测证据和更新 `ACCEPTANCE.md`，不能用页面展示替代真实端到端结果。本地演示管理端按 `DOC-01 → ADM-01 → ADM-02 → ADM-03 → ADM-04` 执行，不阻塞 G0-G5。

## 13. 本地演示 Hub 管理端（范围收缩）

### 13.1 目标与边界

本地演示需要一个独立于 `application/` 的 Hub Web 管理端，只管理工作群（`rooms.kind='workgroup'`）。应用内不出现 Hub 管理、登录、注册或地址配置入口。

管理员使用独立 `operators` 表，不写入 `users` 表。默认演示账号为 `admin / abcd1234567890`，密码以 scrypt 哈希保存；生产环境通过数据库修改密码或停用。

### 13.2 数据与账号

新增 `operators` 表；`audit_events` 增加 `actor_operator_id`。admin 的登录、工作群变更和消息查看均写审计，但不记录密码、token 或消息正文。不做物理删除：工作群解散使用 `dissolved_at`，成员移除使用 `removed_at`，消息保留。

### 13.3 API 与页面

管理 API 位于 `/api/v1/admin`：登录/登出/会话；只读用户列表；工作群列表、创建、详情、改名、解散、成员增删；工作群消息正文只读分页。`/admin/` 使用 `server/web/admin` 下的原生 HTML/CSS/JS，由 `server/` 自身提供，不引入前端构建链。

### 13.4 明确不做

不做用户 CRUD、设备管理、成员角色修改、owner 转移、审计 UI、Dashboard、消息搜索、附件下载、消息编辑/删除、多管理员权限。普通 room、Bot 本地群和私人 Session 永不进入管理端。

### 13.5 验收

admin 可登录 `/admin`；工作群列表只显示 workgroup；可创建、改名、解散、增删成员；消息正文可分页只读；改名后应用端实时更新群名；guest Bearer 不能访问 admin API；无物理删除。
