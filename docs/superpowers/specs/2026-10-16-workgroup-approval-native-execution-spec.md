# 审批到原生 Bot 执行专项规格

> 状态：需求与设计基线，未执行源码修改、测试、构建、部署或提交。
>
> 总索引：[Workgroup Bot 功能补齐需求拆解索引](./2026-10-16-workgroup-bot-gaps-index.md)

## 1. 目标

把工作群中的远程 Bot mention 连接到“任务候选 → owner-only 审批 → 授权 scope → 任务所有者本机原生 Bot → 隔离 Task Session → 脱敏进度 → 取消/失败 → 复核 → 受控分享”的完整链路。

执行必须发生在任务所有者已有的本机 DSH/Bot 运行边界内。Hub 负责身份、成员、任务状态、审批、授权和脱敏事件，不直接执行远程命令；不得重写 DSH Agent Loop，不新增第三个执行进程。

## 2. 当前事实与断点

### 已存在

- `server/src/api/messages.js` 在消息 mention 后调用 `proposeTasksForMentions()`。
- mention 产生的任务初始状态为 `PENDING_APPROVAL`，服务端注释明确禁止 mention 直接执行。
- `server/src/api/tasks.js` 提供实际决策路由：`POST /api/v1/tasks/:taskId/decision`。
- 决策接口支持 `expectedVersion`、`assignmentMode`、`assignedBotId` 和 `approvedScope`。
- owner-only、assignment mode、scope、grant、进度、取消、review 和分享 helper 已部分存在。
- `task-sessions.js`、`task-grants.js` 已提供原生隔离 Task Session 和工具授权基础。
- `bot-adapter/flows.mjs` 已有 `existing_bot`、`chief_auto`、`create_bot` 流程 helper。

### 已确认断点

- Host `hub-approve-task` 当前调用 `/tasks/:taskId/approve`，与服务端实际 `/tasks/:taskId/decision` 不一致。
- `WorkgroupTasks` 只按 `PENDING_APPROVAL` 过滤，没有证明按 `ownerUserId/selfUserId` 过滤。
- UI 没有显示和确认完整 scope、assignment mode、目标 Bot、工具范围、工作目录、收件人和期限。
- 没有找到 approved Hub task 到 `acceptDispatch`、grant consume、`runDispatch` 和 Task Session 的生产消费者。
- 没有找到完整进度、取消、review 和受控分享在工作群 UI 中的可达链路。

## 3. 安全模型

### 3.1 五种权限分离

以下权限不能互相推导：

1. 消息可见。
2. 任务请求。
3. 数据读取。
4. 任务执行。
5. 成果共享。

工作群成员身份不自动赋予私有 Bot 的执行权；能看到一条消息不代表能读取 owner 的目录、工具或模型凭据；能请求任务不代表能批准任务；能看到脱敏进度不代表能看到私有工具日志。

### 3.2 owner-only 审批

只有任务的 `ownerUserId` 在其认证客户端可以审批或拒绝：

- 请求人不能替 owner 批准。
- 房间管理员不能替 owner 批准。
- 其他成员不能替 owner 批准。
- UI 可隐藏非 owner 的操作按钮，但服务端必须继续拒绝非 owner 请求。
- 每次决策都必须携带 `expectedVersion`，避免旧页面覆盖新状态。

### 3.3 凭据边界

- Hub token、密码、注册 key、设备私钥、模型凭据不进入消息、任务公共事件或浏览器可见状态。
- approved scope 只返回给 owner；公共任务事件只包含脱敏状态和必要的阶段信息。
- grant 必须绑定 task、owner、目标 Bot、scope、nonce、有效期和撤销版本。
- 伪造、过期、撤销和重放的凭据都拒绝，并且不能因失败消耗有效凭据。

## 4. 端到端流程

### 4.1 创建任务候选

```text
工作群用户选择远程 Bot
  -> 发送消息 mentions: [{ userId, botId }]
  -> Hub 校验 Bot 和房间关系
  -> 创建 PENDING_APPROVAL task
  -> 发布 redacted task.approval_requested
```

此时不得调用本地 Bot，不得创建执行进程，不得发放 grant。

### 4.2 owner 查看和决策

```text
owner 收到 task.approval_requested
  -> 获取任务详情
  -> 只在 owner 客户端显示批准表单
  -> 选择 assignment mode 和 approved scope
  -> POST /tasks/:taskId/decision
  -> Hub 校验 owner、版本、scope 和目标 Bot
```

实际请求路径和字段必须与服务端一致：

```js
POST /api/v1/tasks/:taskId/decision
{
  decision: 'approve' | 'reject',
  expectedVersion,
  assignmentMode,
  assignedBotId,
  approvedScope: {
    mode,
    assignedBotId,
    workDir,
    tools,
    recipients,
    expiresAt,
  },
}
```

拒绝不创建执行；批准只记录授权并发布 `task.approved`，不能由 Hub 直接运行命令。

### 4.3 owner 本机接管执行

owner Host 收到 approved task 后：

1. 验证任务状态、owner、版本和 approved scope。
2. 调用现有 `acceptDispatch` 或等价策略入口。
3. 用现有 grant client 取得一次性或短期授权。
4. 选择 `existing_bot`、`chief_auto` 或 `create_bot` 中已批准的模式。
5. 在 owner Host 上创建隔离的 native Bot Task Session。
6. 通过现有 DSH Bot 执行，不修改 Agent Loop。
7. 每次工具调用再次经过路径、realpath、工具和 grant guard。
8. 将脱敏阶段通过 Hub progress endpoint 回写。

如果 owner Host 未在线、模型端点不可用、工作目录无效、工具范围不满足或 grant 验证失败，任务应明确失败或保持可解释阻塞；不得静默切换到默认工作区、默认模型或未经批准的 Bot。

### 4.4 进度、取消和结果

公共进度只允许发布：

- 任务状态。
- 非敏感阶段名。
- 必要的错误分类。
- 可供请求人判断是否继续等待的摘要。

不得发布：

- owner 本地绝对路径。
- 私有工具参数和完整工具日志。
- 模型凭据。
- 未授权文件内容。
- 其他任务或其他房间信息。

取消流程：

```text
owner 或有权限的控制入口发起取消
  -> Hub transition/cancel
  -> revoke grants
  -> owner Host 观察取消信号
  -> 终止 Task Session 和其子进程
  -> 发布脱敏 task.cancelled
```

Windows 子进程无法确认全部终止时，状态必须明确标记“未确认”，不能伪造成功。

### 4.5 复核和受控分享

任务完成后，结果默认只保留在 owner 侧等待复核。owner 选择：

- `keep`：保留但不发布。
- `reject`：拒绝结果并结束任务，不发布成果。
- `share`：指定至少一个明确 recipient，Hub 再次检查成员和 ACL。

成果分享只发送受控 artifact/reference，不把 owner 工作目录、内部 storage key 或未经 DLP 检查的原始结果直接广播到房间。

## 5. UI 需求

### 5.1 任务卡片可见性

工作群任务列表：

- 普通成员可以看到经过脱敏的公共任务状态。
- 只有 owner 看到可操作的批准/拒绝表单。
- 只有 owner 看到工作目录、工具范围、机器信息和批准 scope。
- 请求人看到任务已提交、批准、执行中、完成、失败、取消和分享状态。
- 非 owner 的批准按钮不显示；即使手动调用接口，服务端仍拒绝。

### 5.2 审批表单

批准前必须明确展示：

- 请求人和请求文本。
- 目标 Bot 与 Bot owner。
- assignment mode：使用已有 Bot、Chief 自动选择或创建 Bot。
- working directory。
- 允许的工具列表。
- 任务有效期。
- 结果接收者。
- 取消和拒绝的后果。

批准按钮只有在 scope 完整、目录通过 realpath 校验、工具列表符合策略、recipient 有效且版本未过期时可提交。

### 5.3 进度和复核

UI 需要区分：

- 等待 owner 审批。
- 已批准，等待 owner Host。
- 执行中。
- owner Host 离线。
- 失败且原因可见。
- 已完成，等待复核。
- 已保留但未分享。
- 已按指定收件人分享。
- 已取消或终止未确认。

## 6. 服务端和 Host 接口要求

### 6.1 必须使用的现有接口

- `POST /api/v1/rooms/:roomId/messages`
- `POST /api/v1/tasks/:taskId/decision`
- `GET /api/v1/tasks/:taskId`
- `POST /api/v1/tasks/:taskId/progress`
- `POST /api/v1/tasks/:taskId/cancel`
- 现有 grant mint/consume/revoke 接口。
- 现有 review 和受控分享接口。

### 6.2 适配器修正

- `hub-approve-task` 改为调用 `/tasks/:taskId/decision`，发送 `decision`、`expectedVersion`、`assignmentMode`、`assignedBotId`、`approvedScope`。
- `createApprovalClient().decide()` 与 Host endpoint 共用同一字段名，避免 Browser、Host 和 integration 三层各自变形。
- `WorkgroupTasks` 接收 `selfUserId` 或 owner 过滤结果，并只为 owner 创建可操作回调。
- approved task 事件必须进入 owner Host 的 dispatch consumer，而不是只更新 UI。

## 7. 安全剩余项

以下 WP-E 项必须单独有证据，不能因为已有 helper 而标记完成：

- E1：非对称派发凭据链、撤销、过期和重放防护。
- E2：撤销后真实终止进程，包括 Windows 子进程；无法确认时如实报告。
- E3：默认拒绝的网络出站范围和审计。
- E4：成果内容 DLP，发布前检查内容本身。
- E5：注册、登录、心跳、消息、webhook 等全端点持久化限速。

## 8. 验收标准

1. mention 创建任务后状态为 `PENDING_APPROVAL`，无本地执行副作用。
2. Host 审批调用服务端真实存在的 `/decision` 路由。
3. 非 owner 的审批请求在服务端拒绝，UI 不显示可操作按钮。
4. 批准请求包含 owner 确认的完整 scope、assignment mode、目标 Bot、期限和 recipients。
5. 批准后只在 owner Host 使用原生 Bot 和隔离 Task Session 执行。
6. 未批准、grant 无效、路径无效、工具越权、模型不可用和 owner 离线都不会静默执行。
7. 公共事件不泄露 owner 私有目录、工具参数或凭据。
8. 取消会撤销 grant 并传递取消信号；子进程终止状态如实记录。
9. 结果先由 owner review，只有明确指定收件人后才分享。
10. 至少完成一次 L 级真实模型闭环后，才能把本专项标记为通过。

## 9. 直接影响文件

- `application/packages/bundle/ds-bot/src/client/workgroup.js`
- `application/packages/bundle/ds-bot/src/client/workgroup-pane.js`
- `application/packages/bundle/ds-bot/src/host/workgroup-hub.js`
- `application/packages/bundle/ds-bot/src/host/channel.js`
- `application/packages/bundle/ds-bot/src/host/task-sessions.js`
- `application/packages/bundle/ds-bot/src/host/task-grants.js`
- `application/integrations/workgroup/client/approvals.mjs`
- `application/integrations/workgroup/policy/dispatch.mjs`
- `application/integrations/workgroup/bot-adapter/flows.mjs`
- `server/src/api/tasks.js`、`server/src/modules/tasks/store.js`（先按契约验证）
- 对应审批、grant、执行、取消、review 和安全测试。

明确不改：DSH Agent Loop、Hub 直接执行命令的设计、owner-only 服务端原则和两个运行边界。
