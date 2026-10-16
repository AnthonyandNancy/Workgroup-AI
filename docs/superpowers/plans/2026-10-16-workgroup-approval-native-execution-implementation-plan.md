# 审批到原生 Bot 执行 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将工作群 mention 形成的待审批任务接入 owner-only scope 审批、grant、owner Host 原生 Bot 隔离 Task Session、脱敏进度、取消、复核和受控分享。

**Architecture:** Hub 只负责任务、成员、审批、授权和脱敏事件；owner Host 收到批准事件后调用现有 dispatch/policy/bot adapter，使用 owner 已有原生 Bot 创建隔离 Task Session。所有工具、路径、网络、进程和成果发布都在执行层重新鉴权。

**Tech Stack:** JavaScript、Fastify/SQLite Hub task API、DSH native Bot Task Session、grant/policy helpers、Vitest、pnpm。

## Global Constraints

- 依赖 W1 的身份/房间和 W2 的 mention、任务事件状态。
- Hub 不直接执行命令，不新增远程执行进程，不重写 DSH Agent Loop。
- 只有任务 owner 在认证客户端可批准；请求人、房间管理员和其他成员不能代批。
- 决策必须使用服务端真实路由 `/api/v1/tasks/:taskId/decision` 和 `expectedVersion`。
- Approved scope 只对 owner 可见；公共事件只能包含脱敏状态和阶段。
- 所有 grant 必须绑定 task、owner、Bot、scope、nonce、有效期和撤销版本。
- 每个修复先写失败测试并观察 RED；遇到安全边界失败先做根因调查，不叠加猜测性修复。

---

### Task 1: 固化任务决策 API mismatch 的失败测试

**Files:**
- Modify: `application/integrations/workgroup/tests/a11-hub-provider.spec.ts` 或审批 client focused suite
- Modify: `application/integrations/workgroup/tests/q02-security.spec.ts`
- Test: `application/packages/bundle/ds-bot/src/host/workgroup-hub.js`, `integrations/workgroup/client/approvals.mjs`

**Interfaces:**
- Consumes: `hub-approve-task`、`createApprovalClient().decide()`、server `POST /tasks/:taskId/decision`。
- Produces: 统一 `decision/expectedVersion/assignmentMode/assignedBotId/approvedScope` 请求契约。

- [ ] **Step 1: 写失败测试**

使用记录请求的 fake Hub transport，断言 approve 使用：

```js
{
  method: 'POST',
  path: '/tasks/task-1/decision',
  body: {
    decision: 'approve',
    expectedVersion: 3,
    assignmentMode: 'existing_bot',
    assignedBotId: 'bot-1',
    approvedScope: {
      mode: 'existing_bot',
      assignedBotId: 'bot-1',
      workDir: 'approved-dir',
      tools: ['read'],
      recipients: ['requester-1'],
      expiresAt: expect.any(String),
    },
  },
}
```

- [ ] **Step 2: 运行 RED**

```text
pnpm exec vitest run integrations/workgroup/tests/a11-hub-provider.spec.ts integrations/workgroup/tests/q02-security.spec.ts
```

Expected: 当前调用 `/tasks/:taskId/approve` 或字段不完整导致失败。

- [ ] **Step 3: 根因确认**

对照 `server/src/api/tasks.js` 的实际路由和 `approvals.mjs` 的 `decide()` body，确认错误发生在 Host endpoint adapter，而非服务端新增路由缺失。

- [ ] **Step 4: 保留 RED 记录**

记录 path mismatch 和实际 body 字段，不修改 server route 以掩盖客户端错误。

---

### Task 2: 修正决策 adapter 和 owner-only UI 过滤

**Files:**
- Backup before editing: `application/packages/bundle/ds-bot/src/host/workgroup-hub.js`, `application/packages/bundle/ds-bot/src/client/workgroup.js`
- Modify: `application/packages/bundle/ds-bot/src/host/workgroup-hub.js`
- Modify: `application/integrations/workgroup/client/approvals.mjs`
- Modify: `application/packages/bundle/ds-bot/src/client/workgroup.js`
- Modify: `application/packages/bundle/ds-bot/src/client/workgroup-pane.js`
- Test: approval UI/security suites

**Interfaces:**
- Consumes: `tasks`, `selfUserId`, `ownerUserId`, `approvalScope()`。
- Produces: `WorkgroupTasks({ tasks, selfUserId, onDecision })` 只为 owner 渲染可操作审批；Host 决策调用 `/decision`。

- [ ] **Step 1: 写失败测试**

构造 requester、owner 和普通成员三种 viewer：

```js
expect(renderTasks({ selfUserId: 'owner', task: { ownerUserId: 'owner', state: 'PENDING_APPROVAL' } })).toHaveApproveButton()
expect(renderTasks({ selfUserId: 'requester', task: { ownerUserId: 'owner', state: 'PENDING_APPROVAL' } })).not.toHaveApproveButton()
```

并断言服务端/adapter 仍拒绝 requester 的手工 decision。

- [ ] **Step 2: 运行 RED**

```text
pnpm exec vitest run integrations/workgroup/tests/a02-workgroup-view.spec.ts integrations/workgroup/tests/q02-security.spec.ts
```

- [ ] **Step 3: 实现最小修正**

`hub-approve-task` 调用 `/tasks/${taskId}/decision`；审批 client 传递 `approvedScope`；UI 只对 `task.ownerUserId === selfUserId` 绑定 approve/reject callback，公共任务状态仍可显示给有权成员。

- [ ] **Step 4: 运行 GREEN**

```text
pnpm exec vitest run integrations/workgroup/tests/a02-workgroup-view.spec.ts integrations/workgroup/tests/q02-security.spec.ts
```

- [ ] **Step 5: Task checkpoint**

检查 owner/private scope、machine fields 和 grant data 没有进入非 owner 的 task list 或事件 payload。

---

### Task 3: 接入完整 scope 和 assignment mode 审批表单

**Files:**
- Modify: `application/packages/bundle/ds-bot/src/client/workgroup.js`
- Modify: `application/packages/bundle/ds-bot/src/client/workgroup-pane.js`
- Modify: `application/integrations/workgroup/client/approvals.mjs`
- Test: `application/integrations/workgroup/tests/a09-review.spec.ts`, approval tests

**Interfaces:**
- Consumes: `approvalScope({ mode, botId, workDir, tools, recipients })`。
- Produces: owner 侧提交的完整 decision body，并在 scope 不完整时本地拒绝。

- [ ] **Step 1: 写失败测试**

测试 owner 必须选择/确认：

- `existing_bot`、`chief_auto` 或 `create_bot`。
- target Bot。
- realpath-validated working directory。
- tools。
- expiry。
- recipients。

缺少任一必要字段时，断言不发送请求；scope 完整时断言 body 与 server route 一致。

- [ ] **Step 2: 运行 RED**

```text
pnpm exec vitest run integrations/workgroup/tests/a09-review.spec.ts integrations/workgroup/tests/q02-security.spec.ts
```

- [ ] **Step 3: 实现 owner 审批表单**

只在 owner 显示私有 scope 字段；请求人和普通成员只显示脱敏任务状态。工作目录和 tools 选择调用现有 policy/realpath guard，不在 UI 自己实现授权。

- [ ] **Step 4: 运行 GREEN**

```text
pnpm exec vitest run integrations/workgroup/tests/a09-review.spec.ts integrations/workgroup/tests/q02-security.spec.ts
```

- [ ] **Step 5: Task checkpoint**

检查 UI 文案和状态不会暴露 owner 本地绝对路径、工具参数、模型凭据或私有日志。

---

### Task 4: 连接 approved task 到 owner Host dispatch

**Files:**
- Backup before editing: `application/packages/bundle/ds-bot/src/host/channel.js`, `task-sessions.js`, `task-grants.js`
- Modify: `application/packages/bundle/ds-bot/src/host/workgroup-hub.js`
- Modify: `application/packages/bundle/ds-bot/src/host/channel.js`
- Modify: `application/packages/bundle/ds-bot/src/host/task-sessions.js`
- Modify: `application/packages/bundle/ds-bot/src/host/task-grants.js`
- Modify: `application/integrations/workgroup/policy/dispatch.mjs`
- Modify: `application/integrations/workgroup/bot-adapter/flows.mjs`
- Test: dispatch/grant/task session tests

**Interfaces:**
- Consumes: redacted/owner-scoped approved task event、`acceptDispatch`、grant consume、`runDispatch`、native Bot session factory。
- Produces: owner Host 上一次且可取消的 isolated Task Session，所有工具调用重新校验。

- [ ] **Step 1: 写失败执行链测试**

使用真实 policy/flow helper 和可控 native Bot test double，断言：

- `PENDING_APPROVAL` 不能启动 session。
- approved task 只能由匹配 owner/assigned Bot 接管。
- 无效或已撤销 grant 不能执行。
- session 使用 `wg:<roomId>` 任务隔离标识之外的独立 Task Session，不复用用户当前聊天 session。

- [ ] **Step 2: 运行 RED**

```text
pnpm exec vitest run integrations/workgroup/tests/q02-security.spec.ts integrations/workgroup/tests/q03-recovery.spec.ts
```

Expected: 当前没有 approved event consumer 或 grant/session 链路，测试失败。

- [ ] **Step 3: 根因调查**

逐层记录 event 进入 Host、task 状态读取、grant consume、dispatch policy、Bot adapter 和 native session 的输入/输出；不得先添加多个修复。

- [ ] **Step 4: 实现最小 consumer**

在 owner Host 的 workgroup runtime 中注册 approved task consumer：验证 owner/task/version/scope，消费 grant，调用既有 `runDispatch()`，并通过 Task Session 的 cancellation signal 连接 Hub cancel。

- [ ] **Step 5: 实现工具/路径/网络边界**

每次调用继续走 realpath、限定根目录、tool allowlist、grant nonce/revocation 和默认拒绝的 network guard；策略失败直接拒绝。

- [ ] **Step 6: 运行 GREEN**

```text
pnpm exec vitest run integrations/workgroup/tests/q02-security.spec.ts integrations/workgroup/tests/q03-recovery.spec.ts
```

- [ ] **Step 7: Task checkpoint**

范围受限 review 执行链，确认没有 Hub-side command execution、Agent Loop 改写或未经批准的 fallback。

---

### Task 5: 接入脱敏进度、取消和 review/share

**Files:**
- Modify: `application/packages/bundle/ds-bot/src/host/channel.js`
- Modify: `application/packages/bundle/ds-bot/src/host/task-sessions.js`
- Modify: `application/packages/bundle/ds-bot/src/client/workgroup.js`
- Modify: `application/packages/bundle/ds-bot/src/client/workgroup-pane.js`
- Modify: `application/integrations/workgroup/client/approvals.mjs`
- Test: progress/cancel/review/security suites

**Interfaces:**
- Consumes: Hub progress/cancel/review endpoints、Task Session signal、artifact ACL。
- Produces: 公共脱敏进度、取消状态、owner review 和指定 recipient 分享。

- [ ] **Step 1: 写失败测试**

覆盖：

- 进度事件不含绝对路径、工具参数、凭据或原始文件内容。
- cancel 撤销 grant 并使新的调用/retry 被拒绝。
- child process 终止无法确认时状态为“未确认”。
- `keep` 不分享，`reject` 不分享，`share` 必须有明确 recipients。

- [ ] **Step 2: 运行 RED**

```text
pnpm exec vitest run integrations/workgroup/tests/a09-review.spec.ts integrations/workgroup/tests/q02-security.spec.ts integrations/workgroup/tests/q03-recovery.spec.ts
```

- [ ] **Step 3: 实现最小进度/取消/review adapter**

Host 只向 Hub 回写允许的 stage/state/error category；取消先 revoke grant，再发 cancellation signal；review 通过已有 client 方法和 artifact ACL，不广播机器路径或 storage key。

- [ ] **Step 4: 运行 GREEN**

```text
pnpm exec vitest run integrations/workgroup/tests/a09-review.spec.ts integrations/workgroup/tests/q02-security.spec.ts integrations/workgroup/tests/q03-recovery.spec.ts
```

- [ ] **Step 5: Task checkpoint**

检查公开 task events 和 artifact references，确保不同角色看到的数据范围一致且无秘密。

---

### Task 6: W3 focused gate and execution blocker decision

**Files:**
- Source/test files from Tasks 1–5
- Generated: `application/packages/bundle/ds-bot/client.js`, `lib/client.js`

- [ ] **Step 1: 运行 W3 suite**

```text
pnpm exec vitest run integrations/workgroup/tests/a02-workgroup-view.spec.ts integrations/workgroup/tests/a09-review.spec.ts integrations/workgroup/tests/q02-security.spec.ts integrations/workgroup/tests/q03-recovery.spec.ts
```

- [ ] **Step 2: 验证 mention 未直接执行**

以测试事件记录确认消息 POST 只产生 `PENDING_APPROVAL`，在 decision 之前没有 Task Session、grant consume 或工具调用。

- [ ] **Step 3: 验证非 owner**

使用 requester、room admin 和普通 member 三个身份请求 decision，确认 UI 不显示操作且 server 返回拒绝。

- [ ] **Step 4: 记录 L 级前置条件**

若没有实际模型端点、owner Host 和隔离工作目录，明确记录 W3 L 级为 BLOCKED，不用 mock 结论替代。

- [ ] **Step 5: W3 checkpoint**

review dispatch、grant、Task Session、progress/cancel/review 直接依赖。任何未解释失败回到 systematic-debugging，不进入真实模型验证。
