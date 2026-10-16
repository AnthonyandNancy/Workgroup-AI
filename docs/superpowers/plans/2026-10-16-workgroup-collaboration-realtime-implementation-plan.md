# 工作群协作 UI 与实时链路 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将工作群组件接入完整消息、附件、远程 Bot 目录、成员设置、Bridge 事件、presence 和重连状态链路。

**Architecture:** Hub 是工作群事实源；首屏由 `openRoom()` 提供 baseline，Bridge 通过 Host 既有事件通道发布增量，Provider 使用 reducer 管理 room state。Browser 不新增 WebSocket；本地群 action 与工作群 Hub action 分开。mention 只创建待审批任务，不启动执行。

**Tech Stack:** JavaScript/React、DSH Gateway remote events、WebSocket Bridge、Hub client、Vitest、pnpm。

## Global Constraints

- 依赖 W1 的 signed-in Provider、房间发现和安全状态。
- 不新增第三个运行边界、浏览器独立 WebSocket 或远程执行器。
- `mentions`、`attachments`、`replyToMessageId` 和 `clientMessageId` 不得在任一 adapter 边界丢失。
- presence 只对同群成员可见，不显示精确时间戳；人类在线与 Bot 执行 state 分离。
- 工作群 settings 不调用本地 `updateRoom/deleteRoom`。
- 所有新行为先测试失败，再最小实现；事件重复必须幂等。

---

### Task 1: 建立消息字段透传失败测试

**Files:**
- Modify: `application/integrations/workgroup/tests/a05-workgroup.spec.ts` 或现有消息 client suite
- Modify: `application/integrations/workgroup/tests/a02-workgroup-view.spec.ts`
- Test: `application/packages/bundle/ds-bot/src/client/workgroup.js`, `workgroup-pane.js`, Host fake route

**Interfaces:**
- Consumes: `WorkgroupView.onSend(text, reply, { mentions, attachments })`。
- Produces: `sendMessage(roomId, text, { clientMessageId, replyToMessageId, mentions, attachments })` 的全链路断言。

- [ ] **Step 1: 写失败测试**

用真实 `sendMessage` client 和可记录请求的 fake transport，断言请求 body 同时包含：

```js
{
  body: 'ask the Bot',
  replyToMessageId: 'm1',
  mentions: [{ userId: 'owner-1', botId: 'bot-1' }],
  attachments: [{ artifactId: 'artifact-1' }],
  clientMessageId: expect.any(String),
}
```

再对 Host `hub-send` 增加同样的 body 断言。

- [ ] **Step 2: 运行 RED**

```text
pnpm exec vitest run integrations/workgroup/tests/a05-workgroup.spec.ts integrations/workgroup/tests/a02-workgroup-view.spec.ts
```

Expected: Host route 或 pane 丢失 `mentions/attachments`。

- [ ] **Step 3: 实现最小透传**

Browser pane 调用 Provider 时保留 `mentions` 和 attachment IDs；Host `hub-send` 将它们原样交给 `workgroup.sendMessage()`；integration client 继续由 Hub 校验房间和 ACL。

- [ ] **Step 4: 运行 GREEN**

```text
pnpm exec vitest run integrations/workgroup/tests/a05-workgroup.spec.ts integrations/workgroup/tests/a02-workgroup-view.spec.ts
```

- [ ] **Step 5: Task checkpoint**

确认未把文件 bytes、路径或完整工作目录放入消息 body；消息只携带 artifact IDs。

---

### Task 2: 接入远程 Bot directory 和 mention roster

**Files:**
- Backup before editing: `application/packages/bundle/ds-bot/src/client/workgroup.js`, `workgroup-pane.js`
- Modify: `application/packages/bundle/ds-bot/src/client/workgroup.js`
- Modify: `application/packages/bundle/ds-bot/src/client/workgroup-pane.js`
- Modify: `application/packages/bundle/ds-bot/src/client/workgroup-hub.js`
- Modify: `application/integrations/workgroup/client/index.mjs`
- Test: workgroup view/client directory tests

**Interfaces:**
- Consumes: `publishedBots({ ownerUserId, query })`、`openRoom()`、现有 mention picker。
- Produces: `bots` roster entries包含稳定 `botId/ownerUserId/displayName`，并只列出当前调用者可见的 published Bot。

- [ ] **Step 1: 写失败测试**

给 fake Hub directory 返回一个 published Bot 和一个未发布/无权条目，断言 mention picker 只显示前者，发送 mention 使用 `{ userId, botId }` 稳定 ID。

- [ ] **Step 2: 运行 RED**

```text
pnpm exec vitest run integrations/workgroup/tests/a02-workgroup-view.spec.ts integrations/workgroup/tests/a05-workgroup.spec.ts
```

- [ ] **Step 3: 实现 directory merge**

在打开房间后加载可见 directory，合并到工作群 `bots` state；不把全局用户目录暴露给 Browser，不对未加入用户做搜索。

- [ ] **Step 4: 运行 GREEN**

```text
pnpm exec vitest run integrations/workgroup/tests/a02-workgroup-view.spec.ts integrations/workgroup/tests/a05-workgroup.spec.ts
```

- [ ] **Step 5: Task checkpoint**

检查 directory 数据不包含 owner 私有 Bot memory、模型 key、私有路径或执行工具细节。

---

### Task 3: 让 reducer 成为实时工作群状态源

**Files:**
- Backup before editing: `application/integrations/workgroup/client/index.mjs`, `application/integrations/workgroup/bridge/index.mjs`
- Modify: `application/integrations/workgroup/client/index.mjs`
- Modify: `application/integrations/workgroup/bridge/index.mjs`
- Modify: `application/packages/bundle/ds-bot/src/client/workgroup-hub.js`
- Modify: `application/packages/bundle/ds-bot/src/client/workgroup-pane.js`
- Test: `application/integrations/workgroup/tests/a05-workgroup.spec.ts`, recovery/bridge tests

**Interfaces:**
- Consumes: Bridge event envelope、`openRoom()` baseline、`messagesAfter()` catch-up。
- Produces: `reduceWorkgroup(state, event)` 处理 message/member/presence/invitation/task 事件并幂等返回新状态。

- [ ] **Step 1: 写 presence、duplicate 和 task event 失败测试**

测试：

```js
const next = reduceWorkgroup(state, {
  type: 'presence.changed',
  roomId: 'room-1',
  userId: 'u1',
  online: true,
})
expect(next.members.find(member => member.userId === 'u1').online).toBe(true)
expect(reduceWorkgroup(next, sameEvent)).toEqual(next)
```

为 `task.approval_requested`、`task.approved`、`task.progress`、`task.cancelled` 增加状态更新断言。

- [ ] **Step 2: 运行 RED**

```text
pnpm exec vitest run integrations/workgroup/tests/a05-workgroup.spec.ts integrations/workgroup/tests/q03-recovery.spec.ts
```

Expected: `presence.changed` 未处理或事件重复导致数组重复。

- [ ] **Step 3: 实现 reducer**

按 event id/room sequence 去重；处理 `message.created`、`member.changed`、`presence.changed`、`invitation.created` 和任务事件；未知事件保持 state 不变并记录非敏感诊断。

- [ ] **Step 4: 连接 Bridge 输出**

将 Host `onEvent` 从可选丢弃回调接到实际 runtime workgroup store；Browser provider 的订阅更新只使用现有 DSH Gateway remote event 通道或已有应用事件注册机制，不创建第二条浏览器 WebSocket。

- [ ] **Step 5: 实现重连状态**

连接状态按 `connected/reconnecting/restricted/offline` 表达；重连先用 `afterSeq/head` catch-up，再切回 `connected`；room 被移除或解散时取消 watch。

- [ ] **Step 6: 运行 GREEN**

```text
pnpm exec vitest run integrations/workgroup/tests/a05-workgroup.spec.ts integrations/workgroup/tests/q03-recovery.spec.ts
```

- [ ] **Step 7: Task checkpoint**

只读检查 Host Bridge 生命周期、事件 disposer 和 reconnect cleanup，确认无 listener 泄漏和重复 watch。

---

### Task 4: 工作群成员、presence 和设置 action

**Files:**
- Modify: `application/packages/bundle/ds-bot/src/client/workgroup.js`
- Modify: `application/packages/bundle/ds-bot/src/client/group-settings.js`
- Modify: `application/packages/bundle/ds-bot/src/client/workgroup-presence.js`
- Modify: `application/packages/bundle/ds-bot/src/client/workgroup-pane.js`
- Test: `application/integrations/workgroup/tests/a02-workgroup-view.spec.ts`, membership/security tests

**Interfaces:**
- Consumes: Hub action adapter：`renameRoom`、`invite`、`respondToInvitation`、`revokeInvitation`、`setRole`、`removeMember`、`leave`、`dissolve`。
- Produces: Workgroup settings 只调用 Hub action；成员显示 online/offline/restricted；身份 ID 可复制。

- [ ] **Step 1: 写失败测试**

提供 spy local actions 和 spy Hub actions，打开工作群设置后断言 rename/invite/setRole/remove/leave/dissolve 不调用 local `updateRoom/deleteRoom`，而调用对应 Hub action。

- [ ] **Step 2: 运行 RED**

```text
pnpm exec vitest run integrations/workgroup/tests/a02-workgroup-view.spec.ts integrations/workgroup/tests/q02-security.spec.ts
```

- [ ] **Step 3: 实现独立 Hub settings adapter**

将本地 `GroupSettingsForm` 需要的 action 形状映射到 Hub 方法；owner/admin 权限仍由 Hub 强制，UI 只做按钮门控。

- [ ] **Step 4: 实现成员 presence**

用 reducer 提供的 `member.online` 或 `presence` 状态渲染在线/离线/受限，不渲染精确时间戳，不把 Bot execution state 当人类 presence。

- [ ] **Step 5: 运行 GREEN**

```text
pnpm exec vitest run integrations/workgroup/tests/a02-workgroup-view.spec.ts integrations/workgroup/tests/q02-security.spec.ts
```

- [ ] **Step 6: Task checkpoint**

确认本地群继续使用原有 `GroupSettingsForm` action，不被工作群 adapter 全局替换。

---

### Task 5: 完成附件展示、下载 ACL 和 chat reference

**Files:**
- Modify: `application/packages/bundle/ds-bot/src/client/workgroup.js`
- Modify: `application/packages/bundle/ds-bot/src/client/workgroup-pane.js`
- Modify: `application/packages/bundle/ds-bot/src/client/at-menu.js`
- Modify: `application/integrations/workgroup/client/index.mjs`
- Test: artifact/security/reference tests

**Interfaces:**
- Consumes: `uploadArtifact()`、artifact download/list helpers、原版 `+ Reference a chat` controller。
- Produces: 工作群附件以 artifact reference 展示；无权限下载明确失败；有权聊天可引用，无权私聊拒绝。

- [ ] **Step 1: 写失败测试**

覆盖：

- 跨房间 artifact 不能作为 message attachment。
- 非接收人下载得到拒绝。
- 已移除成员不能继续下载。
- 有权限的本地/工作群 Session 可进入 reference picker。
- 他人私人聊天没有权限时 reference 操作返回明确错误，不发送全文。

- [ ] **Step 2: 运行 RED**

```text
pnpm exec vitest run integrations/workgroup/tests/a09-review.spec.ts integrations/workgroup/tests/q02-security.spec.ts
```

- [ ] **Step 3: 实现附件渲染和下载**

消息只渲染 `artifactId/fileName`，点击下载再次走 Host/Hub ACL；错误不暴露本地 storage key 或机器路径。

- [ ] **Step 4: 接入受控 chat reference**

复用原版 reference picker 的 session 可见性判断；跨权限边界时拒绝；传递 reference metadata，不把私聊全文复制到 Hub。

- [ ] **Step 5: 运行 GREEN**

```text
pnpm exec vitest run integrations/workgroup/tests/a09-review.spec.ts integrations/workgroup/tests/q02-security.spec.ts
```

- [ ] **Step 6: Task checkpoint**

检查工作群上传只读取用户明确选择的文件，不读取完整工作目录。

---

### Task 6: W2 完整门禁

**Files:**
- Source files modified by Tasks 1–5
- Test files modified by Tasks 1–5
- Generated: `application/packages/bundle/ds-bot/client.js`, `lib/client.js`

- [ ] **Step 1: 运行 W2 focused suite**

```text
pnpm exec vitest run integrations/workgroup/tests/a02-workgroup-view.spec.ts integrations/workgroup/tests/a05-workgroup.spec.ts integrations/workgroup/tests/a09-review.spec.ts integrations/workgroup/tests/q02-security.spec.ts integrations/workgroup/tests/q03-recovery.spec.ts
```

- [ ] **Step 2: 检查异常输出**

任何未处理 Promise rejection、`HTTP 503`、fake conversation `registerSource` 异常或未解释 warning 都记录并阻塞 W2 放行。

- [ ] **Step 3: 生成并比较 bundle artifacts**

使用仓库现有 bundle 生成脚本重建 `client.js`、`lib/client.js`，再确认两者字节一致。

- [ ] **Step 4: W2 checkpoint**

范围受限 review：Provider state、Host event consumer、Bridge/reducer、WorkgroupView、GroupSettings adapter、artifact/reference ACL 和直接测试。W2 未通过不进入 W3。
