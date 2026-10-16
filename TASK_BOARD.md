# Workgroup AI｜新项目开发任务清单

**使用方式：** 逐项在真实环境执行。每个任务定义完成条件，而不是仅要求“写了代码”。状态默认 `TODO`；未实际运行不得修改为 `PASS`。

## 状态总览（2026-10-14 首轮）

### 2026-10-15 返工：两项返工与 3 项门禁回归

用户指出「Bot 入口需要显示在插件入口下方」与「本应用独立于 dsh，环境变量需要更改」两点未做到。核实后**两点都成立**，已完成修复：

| 项 | 原状态 | 返工后 |
|---|---|---|
| Bot 入口 | 代码里 `order: 1` 位置正确，但真实产品中 bundle 无法解析、**整个插件不加载** | 迁入 `packages/bundle/ds-bot`，真实产品路径 UI **13/13** |
| 环境变量 | 只改了默认目录名，变量名全共用（`DSH_HOME` 等） | **382 个变量、5225 处**改名；数据根 / agents 根 / 受管 shell 前缀 / 秘密命名空间全部独立 |
| 打包身份 | 模板里仍是官方 appId，且优先级高于 Fork 默认值 | 已隔离并实测；新增 3 项身份门禁 |
| 附带修出的真实缺陷 | — | `ctx.workgroupHub` 属性代理误用（导致 Bot 入口在任何未配置 Hub 的安装上加载失败）；嵌套 `node_modules` 未被门禁排除；两项门禁回归见下 |

### 复验（工作区变更后重跑，发现并修复两个首轮漏掉的门禁）

首轮只跑了 `integrations` 车道，漏了 `scripts` 车道，因此两个失败未被发现。两个都已修复：

| 门禁 | 首轮 | 原因 | 修复 |
|---|---|---|---|
| `third-party-notices` | **1 failed / 36 passed** | 该门禁对每个 `dsh.client` 包真打包其 browser 入口，而 `react` 从 ds-bot 解析不到（22 处报错） | 声明 `react`/`react-dom` 为 devDependencies（与仓库其它 client 包一致），现 **37/37** |
| `doc-standard` | **1 failed** | 包迁入 `packages/` 后须符合 README 骨架规范，DS Bot 的 README 缺 `## Table of Contents` 与 `## Dev Note` | 补齐两个骨架段，现 **22/22** |

注：`verify-third-party-notices` **不在** `run-gates.ts`（grep 计数 0），所以 `hygiene` 看不到它——这是验证覆盖面的缺口。

复验后：构建 **9/9**；集成 **256/256**；UI（本项目应用，非 bench）**13/13**；hygiene **18 passed / 2 failed**。`scripts` 车道其余失败逐条核为既有环境问题（本机 GNU tar 对 `-C` 绝对路径退出码 2、`npm config` 环境差异、默认 5 s 超时不足），涉及的 spec 与实现均未被本轮改动，且其中 `WORKGROUP_`/`ds-bot` 字面量计数为 0。

**验证约束（用户指令）：** 禁止把本项目任何插件安装到本机已装的 DSH 应用；测试必须打开本项目应用。已遵守——本次全部 `dsh` 启动一律 `WORKGROUP_HOME=D:/tmp/wg-*`，从不写 `~/.dsh`。`~/.dsh/profiles/desktop` 里的 `ds-bot@0.1.5` 来自上游 `github.com/Fei2411/DeepSeek-Bot`，安装于 10-14，早于本次工作，非本项目。

**验证：** 构建 9/9；集成 256/256；DS Bot 574/575（与迁移前基线一致）；hygiene 由 **15 passed / 5 failed** 改善为 **18 passed / 2 failed**（剩余 2 项已逐条确认为既有，与本轮无关）。

**证据：** `application/docs/workgroup-ai/REWORK_BOT_ENTRY_AND_ENV.md`，截图在 `application/docs/workgroup-ai/evidence/f07-product/`。

| 状态 | 任务 | 证据文件 |
|---|---|---|
| PASS | F-01, F-02 | `application/docs/workgroup-ai/UPSTREAM_LOCK.md` |
| PASS | F-03（构建 9/9；官方测试部分失败已定位） | `application/docs/workgroup-ai/VERIFICATION_F01_F04.md` |
| PASS | F-04（smoke 40/40 + UI 15/15，L 级） | `application/docs/workgroup-ai/VERIFICATION_F01_F04.md` |
| PASS | F-05（身份隔离 16/16，含 3 项新增；打包 appId 实测已隔离。**2026-10-15 返工修正**：原记录的"身份完全不相交"不成立——打包模板仍是官方 appId 且优先级高于 Fork 默认值，环境变量名全部共用） | `application/docs/workgroup-ai/F05_PRODUCT_IDENTITY.md` |
| PASS | F-06（内置 bundle；冷启动/重启 Host 数=1。**2026-10-15 返工**：原实现用裸包名 `ds-bot`，真实产品路径无法解析，已迁入 `packages/bundle/ds-bot` 并接线构建管线） | `application/docs/workgroup-ai/F06_BUILTIN_BOT_HOST.md` |
| PASS | F-07 / F-08 / F-09（**2026-10-15 返工复验**：真实产品路径 13/13。原 18/18 跑在 bench 环境，该环境手工 `link:` 补上了一个产品没有的解析步骤，故原 PASS 结论不成立） | `application/docs/workgroup-ai/F07_F08_F09_NAVIGATION.md` |
| PASS | F-10（无删除入口，无须改动，S 级） | `application/docs/workgroup-ai/F10_SESSION_LOG_AUDIT.md` |
| PASS | F-11（11/11 测试 + 真实重启后身份保持；G3 核心门槛；记忆隔离未验证） | `application/docs/workgroup-ai/F11_TASK_SESSION_IDENTITY.md` |
| PASS | F-12（18/18 测试；修复数据根默认值与根目录接受两处真实缺陷） | `application/docs/workgroup-ai/F12_PATH_VALIDATION.md` |
| PASS | F-13（12/12 测试 + 真实运行时越权/撤销验证） | `application/docs/workgroup-ai/F13_TOOL_GUARD.md` |
| PASS | 网络出站限制（原 F-13 欠账，WP-E3 关闭） | `application/integrations/workgroup/policy/egress.mjs` + `tests/m4-egress.spec.ts`（10/10） |
| PASS | H-01（12/12 测试 + server-only 独立启动） | `server/docs/H01_H02_DELIVERY.md` |
| PASS | H-02（23/23 测试 + 真实备份恢复演练 + server-only 独立部署复验） | `server/docs/H01_H02_DELIVERY.md` |
| PASS | H-03（36/36 测试 + 真实进程两端登录/轮换/吊销，含安全欠账记录） | `server/docs/H03_IDENTITY_DELIVERY.md` |
| PASS | H-04（24/24 测试 + 真实双用户邀请/接受/移除） | `server/docs/H04_ROOMS_DELIVERY.md` |
| PASS | H-05（20/20 测试 + 真实断线补拉不丢不重） | `server/docs/H05_MESSAGES_DELIVERY.md` |
| PASS | H-06（20/20 测试 + 真实双客户端实时推送；修复握手前鉴权缺陷） | `server/docs/H06_REALTIME_DELIVERY.md` |
| PASS | H-07（15/15 测试 + 真实三用户可见性矩阵） | `server/docs/H07_BOT_DIRECTORY_DELIVERY.md` |
| PASS | H-08（29/29 测试 + 真实核心业务场景；修复事件白名单与目录存在性缺陷） | `server/docs/H08_TASKS_DELIVERY.md` |
| PASS | H-09（23/23 测试×3 + 真实派发链路与跨设备绑定验证） | `server/docs/H09_GRANTS_DELIVERY.md` |
| PASS | H-10（27/27 测试 + 真实越权/纠错/删除轨迹验证；修复删除路径泄漏） | `server/docs/H10_GROUP_MEMORY_DELIVERY.md` |
| PASS | H-11（22/22 测试 + 真实上传下载；修复非 ASCII 文件名致下载 500） | `server/docs/H11_ARTIFACTS_DELIVERY.md` |
| PASS | H-12（15/15 测试 + 真实破坏恢复演练，逐实体计数一致） | `server/docs/H12_AUDIT_BACKUP_DELIVERY.md` |
| PASS | H-13（40/40 新增测试；真实 Linux 上容器与 systemd 双路线演练：计划备份、总量损毁恢复、附件字节往返、限速、密钥轮换、沙箱加固实测生效；修复 10 项仅真机暴露的缺陷） | `server/docs/H13_DEPLOYMENT_DELIVERY.md` |
| PASS | A-01（26/26 测试对真实 Hub；修复协议版本字段与设备指纹作用域两处缺陷） | `application/docs/workgroup-ai/A01_HUB_CLIENT.md` |
| PASS | A-02（14/14 测试，真实 Hub + 真实 WebSocket；ACK/重连/离线补拉无重复） | `application/docs/workgroup-ai/A02_BRIDGE.md` |
| PASS | A-04（原入口正下方新增工作群入口，原群聊流程未改） | `application/docs/workgroup-ai/A03_A04_WORKGROUP_UI.md` |
| 部分 PASS（M 级已实现，L 级待补） | A-03（工作群视图**已在 Bot 面板内真实挂载**：`shell.overlay` + `wg:<roomId>` 会话身份，先 `sessions.create` 再导航；组件级复用已验证。**像素级比对与真实浏览器 L 级对照未做**） | `application/docs/workgroup-ai/A03_A04_WORKGROUP_UI.md` |
| PASS | A-05（32/32 测试对真实 Hub；邀请/成员管理/真人消息/目录可见性；修复三处服务端缺陷） | `application/docs/workgroup-ai/A05_MEMBERSHIP_MESSAGES.md` |
| PASS | A-06（27/27 测试对真实 Hub；只有 B 能审批；三种派发方式；批准与铸造凭据分离；修正 3 处客户端缺陷） | `application/docs/workgroup-ai/A06_APPROVALS.md` |
| PASS | A-07（21/21 测试；伪造/撤销/越界目录/符号链接逃逸全部拒绝；目录校验先于消耗凭据） | `application/docs/workgroup-ai/A07_DISPATCH.md` |
| PASS | A-08（30/30 测试；三种派发流程 + 真实子进程终止已确认，未确认情况如实上报） | `application/docs/workgroup-ai/A08_FLOWS_CANCELLATION.md` |
| PASS | A-09（17/17 测试对真实 Hub；修复三处真实脱敏泄漏；`keep`/`reject` 不发布、`share` 必须指名接收人） | `application/docs/workgroup-ai/A09_REVIEW_SHARING.md` |
| PASS | A-10（16/16 测试对真实 Hub；记忆可追溯/可纠错/可删除；Bot 以 owner 凭据检索） | `application/docs/workgroup-ai/A10_GROUP_MEMORY.md` |
| PASS | Q-02（23/23 负向安全用例对真实 Hub） | `docs/acceptance/Q02_SECURITY.md` |
| PASS | Q-03（9/9 崩溃/升级/恢复用例；真实 SIGKILL 与 restore） | `docs/acceptance/Q03_RECOVERY.md` |
| 部分 | Q-04（Linux 发布 PASS、Windows 构建 PASS、macOS BLOCKED） | `docs/acceptance/Q04_PACKAGING.md` |
| BLOCKED | Q-01（无双机；条件与等价证据已列明） | `docs/acceptance/Q01_TWO_MACHINE_E2E.md` |
| TODO | 其余全部 | — |

**证据等级说明：** 上述 PASS 中，F-04 为 **L 级**（单电脑真实端到端，真实 DSH + 真实 DS Bot + 真实浏览器）。
F-10 为 **S 级**（静态源码核对）。**尚无任何 N 级（双机）或 P 级（跨平台打包）结论。**

| ID | 所属端 | 任务 | 前置 | 可检查的完成条件 | 状态 |
|---|---|---|---|---|---|
| F-01 | application | 克隆/锁定官方 DSH commit，保存完整来源与 lockfile | — | SHA+构建环境记录 | PASS |
| F-02 | application | 克隆/锁定 DS Bot commit，保存 NOTICE 和许可证 | F-01 | SHA、差异清单 | PASS |
| F-03 | application | 构建 DSH Desktop/Web/Host，跑官方测试 | F-01 | 实际命令、日志、截图 | PASS（构建）；官方测试部分失败见证据文件 |
| F-04 | application | 安装并运行原版 DS Bot 做兼容基线 | F-02/F-03 | Chief、私聊、群聊真实可用 | PASS（L 级） |
| F-05 | application | 独立 appId/协议/数据根/更新源及共存测试 | F-03 | 可与官方 DSH 同时启动 | PASS（身份与配置级；双安装实测待 Q-04） |
| F-06 | application | 单一 Bot Host 内置/自动加载，不重复初始化 | F-04 | 冷启动/重启无重复 Host | PASS（L 级） |
| F-07 | application | Bot 顶级导航唯一按钮置于插件正下方 | F-06 | UI 自动化/截图比对 | PASS（L 级） |
| F-08 | application | 进入 Bot 后完整保留原版 Chief/Bots/私聊/群聊 | F-07 | UI 功能回归 | PASS（L 级） |
| F-09 | application | 仅将 DS Bot 全局 shadow/slot 挂载改为 Bot 页面内局部生效 | F-07 | 切 DSH 插件/会话正常 | PASS（L 级） |
| F-10 | application | 检查并移除 Session Log 删除动作（若实际存在） | F-03 | 保留归档和日志、删除入口缺失 | PASS（无须改动；UI 实测待 F-07/F-08 补） |
| F-11 | application | Task Session 原生 Bot 身份持久化 PoC（G3） | F-06 | 刷新/重启不丢身份 | PASS（L 级；记忆隔离与真实模型请求待补） |
| F-12 | application | 真实路径校验与无效 dir 拒绝 | F-11 | 不发生默认目录回退 | PASS（L 级；大小写不敏感比较未处理） |
| F-13 | application | Bot 任务工具 guard/进程撤销与最小权限 PoC | F-11 | 越权拒绝、撤销停止 | PASS（L 级）。**三项欠账的后续处置**：①子进程终止——A-08 已用真实子进程补齐（原生 SIGTERM + 确认），**Windows 孙进程在 WP-E2 中实现但无法在本机确认**，已如实上报；②网络限制——**WP-E3 已实现**（`policy/egress.mjs`，默认拒绝、按 `host[:port]` 精确匹配）；③符号链接绕过——F-12 在设置目录时用 realpath，运行时的路径比较在 WP-E3/目录校验中按 `realpath` 语义处理（见 `policy/dispatch.mjs`） |
| H-01 | server | Node/SQLite 初始化、配置校验、health endpoint | — | 仅 server/ 可独立运行 | PASS |
| H-02 | server | DB migrations、事务和 SQLite WAL | H-01 | 初始化/重复迁移/备份恢复 | PASS（L 级，含真实恢复演练） |
| H-03 | server | 用户注册/登录、设备身份、令牌吊销 | H-02 | 无授权无法访问 | PASS（L 级；速率限制未做，见记录） |
| H-04 | server | 创建群、成员邀请、接收/拒绝/踢出 | H-03 | 非成员不能读群数据 | PASS（L 级） |
| H-05 | server | 消息写入、roomSeq、幂等去重、补拉 | H-04 | 重连不丢不重 | PASS（L 级） |
| H-06 | server | WSS 鉴权、订阅、ACK、心跳和事件恢复 | H-05 | 离线/断链恢复 | PASS（L 级） |
| H-07 | server | 可公开远程 Bot 目录及在线状态 | H-03 | 只可见用户授权 Bot | PASS（L 级） |
| H-08 | server | 创建任务、审批、状态机、任务事件记录 | H-04/H-07 | 不能跳过本人审批 | PASS（L 级；真实本地执行归 F-11/F-13/A-08） |
| H-09 | server | 授权凭据/nonce/一次性派发与撤销广播 | H-08 | 重放拒绝、过期拒绝 | PASS（L 级） |
| H-10 | server | 群记忆 ACL/来源/检索/纠错/删除 | H-05 | 越权搜索为空/403 | PASS（L 级；无语义检索、无容量上限） |
| H-11 | server | 受控附件上传、下载、元数据 ACL | H-04 | 非接收人不能下载 | PASS（L 级；无扫描、无容量配额） |
| H-12 | server | 审计、备份、恢复、保留策略 | H-08/H-10 | 恢复真实群和状态 | PASS（L 级；两项遗留——备份调度、附件字节入备份——已由 H-13 关闭） |
| H-13 | server | 独立系统部署/容器部署、安全配置 | H-12 | 干净 Linux 仅 server/ 部署 | PASS（L 级真实 Linux：容器 + systemd 双路线跑通完整演练；未在独立 Linux 主机/k8s 上部署） |
| A-01 | application | Hub 配置、登录/设备登记及协议握手 | H-03/F-08 | 可与单独 Hub 建连 | PASS（26/26 测试对真实 Hub 的真实 HTTP；修复 /auth/config 协议字段与 devices 指纹全局唯一两处服务端缺陷） |
| A-02 | application | Bridge WSS ACK/重连/离线补拉 | A-01/H-06 | 真实双端无重复 | PASS（14/14 测试；真实 Hub 进程 + 真实 ws 客户端；重连后 roomSeq 序列恰为 [1..6] 无重复） |
| A-03 | application | 复用原版群聊 UI，新建工作群视图 | F-08/H-04 | 视觉与原版一致、功能对照矩阵通过 | **部分 PASS（M 级已实现，L 级待补）**：挂载路径已实测（须先 `sessions.create({sessionId:'wg:<roomId>'})`，否则 `sessions.retain` 对未知 id 抛错；`installShell()` 仅在 Bot 面板选中时执行）；组件级复用已验证（原版 GroupSettingsForm/RoomAvatar、不含本地群耦合）。**像素级比对与真实浏览器功能对照矩阵未做**，故不写 PASS |
| A-04 | application | 原创建群聊下方新增创建工作群聊 | A-03 | 普通群功能不受影响 | PASS（入口紧邻原入口、原入口未改；未配置 Hub 时菜单与上游完全一致） |
| A-05 | application | ID 邀请/成员管理/真人消息/@Bot UI | A-02/A-04/H-07 | 两电脑群聊可见 | PASS（32/32 测试对真实 Hub，两个独立客户端与令牌；修复邀请缺房间名、私有 Bot 目录不可见、回复字段被静默忽略三处服务端缺陷。真实双机归 Q-01） |
| A-06 | application | B 客户端本人审批卡和三种派发方式 | A-05/H-08 | 非 B 无审批权限 | PASS（27/27 测试对真实 Hub；请求人/第三方/房间管理员均无法审批；三种派发方式；批准不等于铸造凭据。审批卡的 React 组件待接入，归 A-03 剩余） |
| A-07 | application | 本地 Bridge 严格验签并绑定已批准任务 | F-11/A-06 | 伪造或撤销不执行 | PASS（21/21 + 新增 2 例；伪造/撤销/非法目录全部拒绝且不消耗凭据；不回落默认目录。**WP-E1 已把凭据升级为非对称签名链**：`acceptDispatch` 增加 `verifyGrant` 前置，位于本机可判定检查之后、出示 nonce 之前，无验签器即拒绝。**执行侧子进程树终止（WP-E2）在 Windows 上无法确认**，已如实上报，归 Q-02） |
| A-08 | application | 指定下属/管家分配/新建机器人三种流程 | A-07 | 真正原生 Bot 执行 | PASS（30/30 测试；三种流程汇聚同一 runner；三 id 绑定校验；**真实子进程被 SIGTERM 终止并确认**，补齐登记三次的缺口。真模型端到端归 Q-01/Q-03） |
| A-09 | application | 任务进度脱敏、成果复核/受控分享 | A-08/H-11 | 不自动公开私有中间数据 | PASS（17/17 + 新增 3 例；修复三处真实泄漏：房间可见选用 Bot/mode、事件载荷带 mode、详情把 scope 发给请求人。**WP-E4 成果内容检查已实现**：`assertContentPolicy` 在加入 artifact 前检查说明与摘要，命中即阻止且提示原因） |
| A-10 | application | 工作群长期记忆与授权 Bot 检索 | A-05/H-10 | 可追溯、可纠错 | PASS（16/16 测试对真实 Hub；可追溯/可纠错/可删除；Bot 以 owner 凭据检索并标注 retrievedAs。无语义检索、无容量上限） |
| Q-01 | 两端 | E2E 双机真实协作：A @ B、本人审批、Bot 执行 | A-09 | 带完整日志的视频/截图 | **BLOCKED**（本机仅一台主机、局域网无第二台机器；已列出所需条件与单机等价证据清单） |
| Q-02 | 两端 | 安全测试：跨群/越权/目录/工具/取消 | Q-01 | 全部负向用例通过 | PASS（23/23 负向用例对真实 Hub；L 级。缺 N 级双机，归 Q-01） |
| Q-03 | 两端 | 升级/断线/进程崩溃/DB 恢复 | Q-01 | 无重复执行和数据越界 | PASS（9/9 用例；真实 SIGKILL、真实 restore、真实附件字节恢复；L 级。缺双机断线，归 Q-01） |
| Q-04 | 两端 | Windows/macOS 安装与 server-only Linux 发布 | Q-03 | 签名/构建/环境记录 | **部分 PASS**：Linux server-only 发布 L 级 PASS（H-13）；Windows 构建 7/7 PASS，安装包未产出（缺发布基础设施取值）；**macOS BLOCKED**（项目自身拒绝非 macOS 主机打包） |

## 依赖规则（不可交换）

`F-01..F-04` → `F-06..F-13` 的内置原生任务门槛；`H-01..H-06` → `A-01..A-05` 的双端通信；`H-08/H-09` + `F-11/F-13` → `A-06..A-09` 的真实审批执行。UI 可以并行制作，但**真实委派不能在 G3 未通过时标成已完成**。

## 每个任务的完成报告模板

```text
任务ID：
分支/commit：
修改文件（仅 application/ 或 server/）：
真实运行环境（OS/Node/pnpm/DSH SHA/DS Bot SHA）：
前置条件：
执行命令：
结果：PASS / FAIL / BLOCKED
截图/日志/测试编号：
安全或兼容风险：
下一个任务：
```
