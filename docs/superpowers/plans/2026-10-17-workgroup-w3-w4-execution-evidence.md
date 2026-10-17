# Workgroup W3-T3 至 W3-T6 / W4 执行与证据（2026-10-17）

> 续接计划：`docs/superpowers/plans/2026-10-16-workgroup-approval-native-execution-remaining-implementation-plan.md`
>
> 执行方式：`executing-plans`，Task 1 → 7。工作区保持 `main` 的既有 dirty/untracked 修改，未 commit、未 reset、未 clean。
>
> 证据等级沿用 `ACCEPTANCE.md` / 验证矩阵：S 静态、M mock/组件/单测、L 单机真实产品、N 双机、P 打包。

## 0. 结论摘要

- W3-T3（批准 → owner Host 原生 Bot 隔离 Task Session）与 W3-T4（脱敏进度、取消、复核、受控分享）**代码与聚焦测试完成**，证据为 **M 级**；真实 Loader 组合测试覆盖插件激活、`/api/bot` provider 路径与"待审批事件不启动"的拒绝路径。
- **L 级未执行**：真实浏览器 + 独立 Hub + owner Host + 真实模型闭环没有跑通，`DEEPSEEK_API_KEY` 在本会话环境缺席。**N 级（双机）与 P 级（打包）仍 BLOCKED**。
- 因此本轮结论为 **NO-GO**（发布门禁未满足 L），不得把 M 级证据写成真实端到端完成。
- W1/W2 聚焦回归门禁重跑通过（见 Task 6）。发现并修正两类 stale 断言：A-03 设置表单复用口径、A-04/Host 模块列表样式断言；修正后门禁通过，历史 PASS 结论按新证据修正说明。

## 1. 最终聚焦门禁（Task 5/6 汇总，实际输出）

工作目录 `Workgroup-AI/application`，命令：

```text
pnpm exec vitest run integrations/workgroup/tests/a02-workgroup-view.spec.ts integrations/workgroup/tests/a05-workgroup.spec.ts integrations/workgroup/tests/a06-approvals.spec.ts integrations/workgroup/tests/a07-dispatch.spec.ts integrations/workgroup/tests/a08-flows.spec.ts integrations/workgroup/tests/a09-review.spec.ts integrations/workgroup/tests/a11-hub-provider.spec.ts integrations/workgroup/tests/a13-hub-provider-host.spec.ts integrations/workgroup/tests/a16-workgroup-interactions.spec.ts integrations/workgroup/tests/a17-workgroup-loader-composition.spec.ts integrations/workgroup/tests/a18-task-dispatch.host.spec.ts integrations/workgroup/tests/bot-entry.spec.ts integrations/workgroup/tests/e-attachments.host.spec.ts integrations/workgroup/tests/q02-security.spec.ts integrations/workgroup/tests/q03-recovery.spec.ts
```

结果（2026-10-17，exit 0）：

| 文件 | 测试数 | 说明 |
|---|---:|---|
| `a02-workgroup-view` | 6 | 入口/挂载/`wg:` 路由 |
| `a05-workgroup` | 34 | 真实 Hub：成员/消息/任务列表 |
| `a06-approvals` | 28 | 真实 Hub：owner-only、三种模式、scope+expiry、grant |
| `a07-dispatch` | 23 | 真实 Hub + 真实目录/symlink/Ed25519 |
| `a08-flows` | 30 | 三种流程、三 id 绑定、真实子进程终止 |
| `a09-review` | 21 | 真实 Hub：进度脱敏、keep/reject/share、DLP |
| `a11-hub-provider` | 13 | provider/配置/身份门禁 |
| `a13-hub-provider-host` | 9 | Host adapter：事件、决策、复核、目录校验拒绝 |
| `a16-workgroup-interactions` | 16 | UI：审批表单、owner-only、复核 |
| `a17-workgroup-loader-composition` | 3 | 真实 Loader + test-only cordis.yml + `/api/bot` |
| `a18-task-dispatch.host` | 17 | 执行链消费器（真实模块 + stub Hub） |
| `bot-entry` | 17 | 一级入口与面板 |
| `e-attachments.host` | 7 | 附件与 mention → PENDING_APPROVAL 无副作用 |
| `q02-security` | 23 | 真实 Hub 负向安全 |
| `q03-recovery` | 9 | 真实 SIGKILL/restore |
| **合计** | **256** | `Test Files 15 passed (15)`，`EXIT=0` |

构建后重跑同一命令（2026-10-17，生成物已同步）：`256 passed (256)`，`EXIT=0`。

`packages/bundle/ds-bot` 自身的测试（`npm test`）：**628 passed / 1 failed (629)**；唯一失败为既有的 `dsh-update` "without a running version there is nothing to compare against"（与本次改动无关，见 TASK_BOARD 既有记录）。

构建产物：

```text
pnpm --filter @deepseek-ai/dsh-bot build        → EXIT=0
client.js vs lib/client.js                      → equal=True bytes=955667
lib/src/host/{task-dispatch,channel,workgroup-hub}.js vs src → IDENTICAL
git diff --check                                → EXIT=0
```

## 2. 逐任务记录（格式：任务ID → 涉及路径 → 前置条件 → 修改摘要 → 实际测试命令 → 结果与证据 → 未解决风险）

### Task 1（W3-T3 RED 基线与范围核对）

- **任务ID**：T1 / W3-T3 baseline
- **涉及路径**：`integrations/workgroup/tests/a16-workgroup-interactions.spec.ts`、`server/src/api/tasks.js`、`server/src/modules/tasks/store.js`、`server/contracts/openapi.yaml`
- **前置条件**：`main` dirty 工作区保留；不 reset/clean。
- **修改摘要**：只读核对；`a16` 重跑取得真实 RED。
- **实际测试命令**：`pnpm exec vitest run integrations/workgroup/tests/a16-workgroup-interactions.spec.ts`
- **结果与证据**：RED = `9 passed | 2 failed (11)`，失败为缺少审批表单与 assignment selector（`[data-wg-approval-form]`、`[data-wg-assignment-mode]` 为 null）。决策契约核对：真实路由 `POST /api/v1/tasks/:taskId/decision`；`approvedScope` 在 `contracts/openapi.yaml` 为 `additionalProperties: true`，store 原文记录 scope，并单独以服务端 TTL 派生 `approvals.expires_at`；应用侧既有 `a13` 已按 `approvedScope.expiresAt` 断言。
- **未解决风险**：服务端仍不校验客户端 `approvedScope.expiresAt`，只作为 owner 声明记录；授权上界由服务端 `approvals.expires_at` 单独约束，执行器需取二者较小值（本轮的本地 grant 取 Hub 签发 grant 的 `expiresAt`）。

### Task 2（owner-only 审批表单与完整 scope）

- **任务ID**：W3-T2 剩余（审批表单 + scope/expiry 传播）
- **涉及路径**：`packages/bundle/ds-bot/src/client/{workgroup.js,workgroup-pane.js,workgroup-hub.js,i18n.js}`、`packages/bundle/ds-bot/src/host/workgroup-hub.js`、`integrations/workgroup/client/approvals.mjs`、`integrations/workgroup/package.json`、测试 `a16`/`a06`/`a13`
- **前置条件**：备份 `backups/w3-remaining-20261017-153504/`（workgroup.js、pane、client/host hub、approvals、i18n、a06/a13/a16/q02/bot-entry 及两个生成产物）。
- **修改摘要**：
  - `approvalScope()` 改为记录唯一 `expiresAt`（ISO，必须是未来时间；过去/非法值 `INVALID_EXPIRY` 本地拒绝），移除 `expiresInSeconds` 字段；`decide()` 传播 `expiresAt`。
  - 新增 owner-only 审批表单：assignment mode、owner 已发布 Bot（`workgroups.directory({ownerUserId})`，不使用房间混合目录）、`FolderMenu` 工作目录、工具列表、有效期、recipients、`expectedVersion`；任一缺失/非法 → 不发请求并显示错误；不提供默认目录。
  - 新增 `hub-review-task` Host 端点和 `reviewTask` 浏览器适配器（keep/share/reject）。
  - Host `hub-approve-task` 改为调用同一个 `createApprovalClient().decide()`（单点字段映射），并在转发前用 `rt.cleanWorkDir` 校验工作目录：缺失、团队默认目录、不可解析、守卫不可用一律 fail closed。
  - `workgroups.reviewTask`/`answerTask` 的决策链路携带 owner 确认的全部字段。
- **实际测试命令**：
  - `pnpm exec vitest run integrations/workgroup/tests/a16-workgroup-interactions.spec.ts` → `16 passed (16)`
  - `pnpm exec vitest run integrations/workgroup/tests/a06-approvals.spec.ts integrations/workgroup/tests/q02-security.spec.ts` → `51 passed (51)`（a06 28，含新增 expiry 记录/拒绝；q02 23）
  - `pnpm exec vitest run integrations/workgroup/tests/a13-hub-provider-host.spec.ts` → `9 passed (9)`（含目录校验拒绝与不可用守卫拒绝）
- **结果与证据**：RED 记录见 Task 1；GREEN 为上述命令。`a16` 断言表单只在 owner 出现，requester/room admin/普通成员均无控件；缺字段逐项无请求；完整 scope 与约 1h 的 `expiresAt` 通过 pane 传给 Hub adapter；非 owner 文本中不出现 workDir/tools/bot。
- **未解决风险**：服务端不校验客户端 expiry（见 Task 1）；`recipients` 的成员资格由服务端在 share 时校验，审批时未校验（表单只提供房间成员）。

### Task 3（批准 → owner Host 原生 Bot 隔离 Task Session）

- **任务ID**：W3-T3
- **涉及路径**：新增 `packages/bundle/ds-bot/src/host/task-dispatch.js`；修改 `packages/bundle/ds-bot/index.js`（MODULES）、`src/host/workgroup-hub.js`（暴露 `rt.hubClient`）、`src/host/channel.js`（删除无审批来源的 `task-session-open`/`task-grant-set`）；测试新增 `a18-task-dispatch.host.spec.ts`、`a17-workgroup-loader-composition.spec.ts`
- **前置条件**：备份同 Task 2 目录（channel/task-sessions/task-grants/index/dispatch/flows）。
- **修改摘要**：
  - 新消费器：`rt.onWorkgroupEvent` 接收 Bridge 事件；`task.approved` → owner-scoped `GET /tasks/:id` → 校验 owner/state/version/scope/expiry/Bot 一致 → `resolveTaskDirectory` 先验目录 → `mintGrant` → `GET /dispatch/keys` → `acceptDispatch`（真实验签、单次 consume）→ `QUEUED` → `RUNNING` → `runDispatch` → `openTaskSession` + 持久绑定 + 本地 grant（工具/目录/expiry/revocationVersion）+ `ensureCapabilities` + 真实 prompt。
  - 失败即拒绝并回写终态：`EXPIRED` 或 `FAILED`，不回落默认 Bot/目录/模型；runner 抛错也会把 RUNNING 任务推进到 FAILED。
  - 重复事件合并到同一 in-flight；已存在绑定（含已关闭）不再启动第二次。
  - `create_bot` 走团队真实 `rt.createBot`；`chief_auto` 因 Host 无 Chief 决策器而 fail closed（`NO_CHIEF`）。
  - 移除 `task-session-open`/`task-grant-set` 两个无审批来源的浏览器端点，保留停止方向端点（close/revoke/check/resolve）。
  - 真实组合测试：test-only `cordis.yml` + 真实 Loader + 25 个真实服务行 + 真实 `@deepseek-ai/dsh-bot`；断言全部行激活、Bot 工具已注册、`/api/bot` 的 `hub-view`/`hub-approve-task` 可达；再经真实 Bridge 投递 `task.approved`，在 Hub 详情为 `PENDING_APPROVAL` 时无 grant/consume/Session。
- **实际测试命令**：
  - `pnpm exec vitest run integrations/workgroup/tests/a18-task-dispatch.host.spec.ts` → `17 passed (17)`
  - `pnpm exec vitest run integrations/workgroup/tests/a17-workgroup-loader-composition.spec.ts` → `3 passed (3)`
  - `pnpm exec vitest run integrations/workgroup/tests/a07-dispatch.spec.ts integrations/workgroup/tests/a08-flows.spec.ts integrations/workgroup/tests/q02-security.spec.ts integrations/workgroup/tests/q03-recovery.spec.ts` → `85 passed (85)`
- **结果与证据**：见上；`a18` 真实模块（task-sessions/task-grants/workgroup-hub/task-dispatch）+ stub Hub（真实 Ed25519 签名）覆盖：PENDING/rejected/terminal/wrong owner/wrong Bot/expired/no workDir/consume 403/stale version 均不启动；合法批准恰好一次 Session 且不等于 Bot 普通会话；重复事件一次；关闭后不重启；真实 Bridge 事件路径。
- **未解决风险**：
  - 删除 `task-session-open`/`task-grant-set` 后，`dev/task-session-poc.mjs` 与 `dev/task-grant-poc.mjs` 仍引用它们，运行会得到 `bot/invalid`；它们是开发者脚本、不在产品路径与门禁中，本轮未改。
  - `task.approved` 只推送给**已订阅房间**的 socket；owner 未打开该工作群时不会触发，重启后 watched 为空（没有 Hub 侧 "approved 待执行队列"端点；新增该端点属于协议变更，未获批）。
  - 仅 `existing_bot`/`create_bot` 可执行；`chief_auto` 无决策器 → 明确拒绝。
  - 房间管理端/请求方的 Host 也会收到事件，靠重新拉取详情比对 owner 拒绝；已覆盖。
  - `a17` 中真实浏览器 `conversation` 面板注册不可观测（client-only），该子项 BLOCKED（需 `test:web` + Chromium + 构建产物）。

### Task 4（脱敏进度、取消、复核、受控分享）

- **任务ID**：W3-T4
- **涉及路径**：`src/host/task-dispatch.js`、`src/client/{workgroup.js,workgroup-pane.js,i18n.js}`、`src/host/workgroup-hub.js`、`src/client/workgroup-hub.js`；测试 `a18`/`a16`/`a13`/`a09`
- **前置条件**：同 Task 3 备份。
- **修改摘要**：
  - `turn/end`（task Session）→ 重新读 owner 详情 → `REVIEW_REQUIRED` 或 `FAILED`，每任务只报一次；`aborted` 交由取消路径。
  - `task.cancelled` → 重读详情校验 owner/state → **先** `revokeGrant` **再** `closeTaskSession` → 绑定记录 `{sessionStopped:true, processTree:'unconfirmed'}`；后续工具调用按 grant 拒绝。
  - 进度只发 allowlist 的 stage/state；不写路径、工具参数、Session id。
  - UI：非 pending 任务显示脱敏状态条；owner 在 `REVIEW_REQUIRED` 看到 keep/reject/share；share 必须勾选 recipient，否则本地拒绝。
- **实际测试命令**：
  - `pnpm exec vitest run integrations/workgroup/tests/a18-task-dispatch.host.spec.ts` → `17 passed (17)`
  - `pnpm exec vitest run integrations/workgroup/tests/a16-workgroup-interactions.spec.ts integrations/workgroup/tests/a13-hub-provider-host.spec.ts` → `25 passed (25)`
  - `pnpm exec vitest run integrations/workgroup/tests/a09-review.spec.ts integrations/workgroup/tests/q02-security.spec.ts integrations/workgroup/tests/q03-recovery.spec.ts` → `53 passed (53)`
- **结果与证据**：取消顺序 `['revoke','close']` 被断言；`checkTaskToolCallForProbe` 取消后返回 withdrawn；`binding.cancel.processTree === 'unconfirmed'`；turn completed→REVIEW_REQUIRED(expectedVersion=5)、error→FAILED；重复 turn/end 不上报；a09 覆盖服务端 keep 不发布、reject 不发布、share 收件人必须在房间且 requester 自动包含、发布前 DLP。
- **未解决风险**：
  - 无法观察模型工具派生的 OS 子进程；如实记录 `unconfirmed`。
  - owner Host 离线期间的取消事件会丢失，只能靠 grant 到期兜底；没有 Hub 侧对账。
  - 失败原因（code/message）只留在 owner 本机日志；进度端点仅发布 stage/state，房间看不到具体原因（服务端契约未变）。

### Task 5（W3 focused gate 与执行判定）

- **任务ID**：W3 exit gate
- **涉及路径**：Task 2-4 的测试范围
- **前置条件**：无新增。
- **修改摘要**：无源码修改（仅 `e-attachments.host.spec.ts` 增加 mention 无副作用断言）。
- **实际测试命令**：见第 1 节 15 文件命令；另有 `e-attachments.host.spec.ts`（7 passed）。
- **结果与证据**：mention 后任务 = `PENDING_APPROVAL`，owner grant 列表为空，事件序列无 `task.approved`/`task.progress`；非 owner 服务端拒绝见 a06（requester/第三方/room admin，真实 HTTP）。
- **未解决风险**：L 级未执行 → W3 不能标 PASS；本轮标 **M 级完成 / L BLOCKED / NO-GO**。

### Task 6（W4 验证、产物与证据收口）

- **任务ID**：W4
- **涉及路径**：`application/package.json` 等只读；生成物 `packages/bundle/ds-bot/client.js`、`lib/client.js`；状态文档
- **前置条件**：先备份 `client.js`/`lib/client.js`（同 Task 2 目录）。
- **修改摘要**：重新构建；字节比对；文档更新。
- **实际测试命令**：
  - W1 回归：`a11-hub-provider a02-workgroup-view bot-entry` → `36 passed (36)`
  - W2 回归：`a05-workgroup a09-review q02-security q03-recovery` → `87 passed (87)`
  - 构建：`pnpm --filter @deepseek-ai/dsh-bot build` → `EXIT=0`
  - 比对：`client.js`/`lib/client.js` `equal=True bytes=954937`
  - `git diff --check` → `EXIT=0`
- **结果与证据**：S 级合同复核（只读）：一级入口仍为 `conversation`/`order 1`（a11/bot-entry）；本地群动作未被工作群调用（a16/a02）；工作群 Session 仍 `wg:<roomId>`；Browser/Host/integration 字段一致（a13/a16）；决策路由与契约一致（a06）。生成物同步。修正 A-03/A-04 两处 stale 断言（见风险）。
- **未解决风险**：L/N/P BLOCKED；`bot-entry` 的 `conversation` 面板证据仍是 fake-shell + bundle 检查，真实浏览器面板未重跑；A-03 的"复用原版 GroupSettingsForm"旧口径已不成立（当前为 Hub 专用 `WorkgroupSettings` + 共享 Card/Row/RoomAvatar），旧证据需按本文件修正。
- **为通过包内门禁所做的最小测试/样式修正**：补 `bt-wg-approval*`/`bt-wg-review` 六条样式规则与两条中文文案（`User ID`、复制 ID 提示，后者为既有 dirty 工作区缺口）；`workgroup-mentions` 单测 fixture 由 `id` 改为 Hub 目录形状 `botId`；`install.test.js` 的注册顺序追加审批消费器的 `on session/event`；`workgroup-dissolve.test.js` 改为断言 Hub 专用设置表单的 `onDissolve`。这些均是把断言对齐当前实现，不改变产品行为。

### Task 7（证据闭合与发布判定）

- **任务ID**：W1-W4 closeout
- **涉及路径**：本文件、`TASK_BOARD.md`、`REQUIREMENTS_GAP_FILL.md`、`TECH_DESIGN_GAP_FILL.md`、续接计划
- **前置条件**：上述命令输出已保存。
- **修改摘要**：记录逐任务证据；修正状态；给出 NO-GO。
- **实际测试命令**：同第 1 节。
- **结果与证据**：见第 1 节与 TASK_BOARD 新增段落。
- **未解决风险**：见第 3 节。

## 3. 阻塞项与所需资源

| 项 | 等级 | 状态 | 缺什么 |
|---|---|---|---|
| 真实浏览器 UI（审批表单/复核/状态条/`conversation` 面板） | L | BLOCKED | 真实 app/process + 浏览器运行（`apps/web` `test:web` 需要构建产物 + Chromium），本轮未启动 |
| 独立 Hub + owner Host + 真实模型闭环 | L | BLOCKED | 本会话环境无 `DEEPSEEK_API_KEY`（shell/.env 均不存在）；未启动真实 Host 与独立 Hub 组合 |
| 真实取消与子进程终止确认 | L | BLOCKED | 无真实工具派生的 OS 进程可观测；代码只声明 `unconfirmed` |
| 双机邀请/实时同步/审批 | N | BLOCKED | 只有一台主机 |
| Windows/macOS 打包与运行 | P | BLOCKED | 本轮未执行打包；无 macOS 主机 |

## 4. 明确未做（防止误读）

- 未修改 `server/contracts/` 或新增服务端路由/schema；未新增第三运行项目。
- 未重写 DSH Agent Loop；未用普通 Agent 代替原生 Bot；执行仍走原生 Bot 的隔离 Task Session。
- 未提交、未 reset、未 clean；既有 dirty/untracked 全部保留。
- 未把 M 级结果写成 L/N/P 通过。

## 5. 2026-10-17 续接：剩余代码 + L 级真实模型（单机、无浏览器）

按用户新一轮指示（"按 Plan 执行剩余项，除双机测试；真实模型用历史环境记录"），本轮补完：

| 项 | 状态 | 证据 |
|---|---|---|
| A1 每次工具调用的撤销版本重校验 | 完成（M） | `task-grants.js` 新增 `recordRevocationVersion` 与逐次比较；consume 后与每次 owner 读取后更新；`a18` 20/20 |
| A4 `chief_auto` 决策器 | 完成（M） | `task-dispatch.js` 的 `askChief` 经 `ctx.llm` 单次调用，`flows` 仍校验答案属于 owner 的 Bot；`a18` 用例 |
| 任务取消 UI + Host 端点 | 完成（M） | `hub-cancel-task` + `cancelTask` + 状态条取消控件（requester/owner/admin，终态不显示）；`a16` 19/19、`a13` 10/10 |
| 任务 Session 输入隔离 | 完成（M） | `channel.js` 的 `send` 拒绝写入 task Session；ds-bot `install` 4/4 |
| **L 级真实模型执行（后端链路）** | **通过** | `a19` 2/2：真实 Hub 进程 + 真实 Loader Host + 真实模型端点 |
| A2 OS 进程树终止 | **未完成（BLOCKED）** | DSH `subprocess` 服务没有按 session/任务的注册表或生命周期事件；`cancellation.mjs` 仍无生产调用方。需要 DSH 侧能力或新计划 |
| B5 owner 未订阅时的 approved 投递 | **未完成（需协议批准）** | 需 Hub 的 approved 队列端点；续接计划禁止未批准协议变更 |
| B6 失败原因对房间可见 | **未完成（需协议批准）** | 进度路由只发布 stage/state |
| 真实浏览器 UI L / N / P | **BLOCKED** | 未运行真实浏览器/桌面 app；无双机；未打包 |

### L 级实际执行（a19）

- 命令（凭据以环境变量传入；历史记录位置为 `application/apps/desktop/.desktop-build/development/home/.credentials.yaml`，值不记录、不输出）：

```text
LOCATION_API_KEY=<historical record> pnpm exec vitest run integrations/workgroup/tests/a19-workgroup-real-model-execution.host.spec.ts
```

- 结果：`2 passed (2)`，gate 内约 8.7s。
- 断言链：mention → `PENDING_APPROVAL`；审批前无 taskSession/taskGrants；审批后 Hub 状态 `APPROVED → QUEUED(task.dispatched) → RUNNING → REVIEW_REQUIRED`；durable binding（sessionId ≠ Main Bot chat）；真实 JSONL transcript 含 `assistant/message`（"pong"）与 `turn/end completed`；requester 读到 REVIEW_REQUIRED 且无 approval/assignedBotId/workDir；owner 复核 share → `SHARED`，事件 recipients 计数 = 1。
- 端点/模型：`http://127.0.0.1:8317/v1`，`api: openai-responses`，模型 `deepseek-v4.1-flash`；`/v1/models` 返回 40 个模型（含该模型）。

### 最终门禁（2026-10-17 续接）

- 16 个 focused 文件：`265 passed (16 files)`，exit 0（含 a19）。`a07`/`a13`/`a18` 的 teardown 在满载下会超默认 hook 时限，已显式放宽 hook 超时；测试断言未改。
- `packages/bundle/ds-bot`：`628 passed / 1 failed (629)`，唯一失败为既有 `dsh-update`。
- 构建：`pnpm --filter @deepseek-ai/dsh-bot build` exit 0；`client.js` = `lib/client.js` **957722 bytes**。
- `git diff --check` exit 0；`server/` 零改动。
- **并发编辑说明**：本轮结束前 `src/client/settings.js` 与 `src/client/styles.js` 被另一进程/会话修改（设置页新增“创建工作群聊”入口与对应样式），不是本轮改动；已保留，并按当前源码重建产物（957722 bytes），随后重跑 a02/a11/bot-entry 36/36 与 ds-bot 客户端相关测试 15/15。该改动的功能完成度不由本轮背书。

### 结论修正

执行链已从 "L BLOCKED" 变为 **"L-exec 通过（单机、真实 Hub + 真实 Host + 真实模型，无浏览器）"**。但验收仍为 **NO-GO**：真实浏览器 UI（审批/复核/取消的视觉与交互）、N 级、P 级未做；A2 与 B5/B6 仍需 DSH 能力或协议批准。

## 6. 2026-10-17 协议批准后的收口（approved 队列 + 失败原因）

用户批准后，补完两项此前因"需协议批准"而阻塞的工作：

| 项 | 状态 | 证据 |
|---|---|---|
| owner Host 离线/未订阅时的 approved 投递 | 完成（M；Host 侧真实链路见 a19） | Hub 新增 owner-only `GET /api/v1/tasks/approved`：只返回调用者自己的 `APPROVED` 任务并携带其批准的 scope；`openapi.yaml` 已记录。Host 在 `hub-sign-in`、`hub-resume`、`hub-open-room` 以及 60 秒定时器上 reconcile；已有绑定的任务跳过。`a18` 21/21（owner 过滤、重复不重启）、`a06` 31/31（owner-only、scope、requester 空队列） |
| 失败原因对房间可见 | 完成（M/L-exec） | `POST /tasks/:taskId/progress` 接受并校验 `reason` 分类码（`^[A-Z][A-Z0-9_]{1,63}$`，自由文本 400 `INVALID_REASON`）；分类码写入公共 `task_events` payload 与房间任务列表的 `lastReason`；UI 以 `[data-wg-task-reason]` 显示。`a06` 31/31（分类码入库、自由文本拒绝）、`a16` 20/20（渲染） |
| OS 进程树终止（A2） | **仍 BLOCKED** | DSH `subprocess` 服务没有按 session/任务的注册表或生命周期事件，shell 工具也不把 session 传给 `spawn`；`cancellation.mjs` 仍无生产调用方。**本轮未改 DSH 核心**；需要单独立项 |
| 真实浏览器 UI L / N / P | **BLOCKED** | 未运行真实浏览器/桌面 app；无双机；未打包 |

**最终门禁（协议收口后）**

- 16 个 focused 文件：`270 passed (16 files)`，exit 0（含 a19 L-exec、a06 31、a16 20、a18 21）。
- 构建：`pnpm --filter @deepseek-ai/dsh-bot build` exit 0；`client.js` = `lib/client.js` **958890 bytes**。
- `git diff --check` exit 0；`server/` 的改动只有本轮批准的协议项（`tasks.js`、`store.js`、`openapi.yaml`）。
- 服务端整套测试：`server/package.json` 的 `node --test tests/` 在本机 Node 26 下报 `Cannot find module .../tests`（脚本/Node 版本的既有问题）；改用 `node --test tests/*.test.js` 运行，**70 项通过、0 失败后长时间未结束**，已停止并如实记录（未完成 ≠ 通过）。其中 `tests/d-contract-parity.test.js` 单独运行 **3/3 通过**。改动的路由同时被真实 Hub 的聚焦集成测试覆盖（a06/a05/q02/a07/a19）。

**结论：** 两项协议项已关闭；A2、真实浏览器 UI L、N、P 仍阻塞。发布判定维持 **NO-GO**。
