# 工作群协作 UI 与实时链路专项规格

> 状态：需求与设计基线，未执行源码修改、测试、构建、部署或提交。
>
> 总索引：[Workgroup Bot 功能补齐需求拆解索引](./2026-10-16-workgroup-bot-gaps-index.md)

## 1. 目标

把工作群从组件级视图接成可持续协作的产品链路：消息、回复、@人类成员、@远程 Bot、附件、邀请、成员角色、在线状态、进度事件和重连 catch-up 都由 Hub 作为事实源，并通过现有 Host/Bridge/Client 边界进入工作群面板。

本专项不启动远程命令，不决定审批结果；mention 只产生待审批任务候选，执行由 [审批到原生 Bot 执行专项](./2026-10-16-workgroup-approval-native-execution-spec.md) 处理。

## 2. 当前事实与缺口

### 已存在

- `workgroup.js` 已有消息线程、回复、@选择、附件控件、成员显示和任务卡片。
- `workgroup-pane.js` 已识别 `wg:<roomId>`，打开工作群并轮询消息/任务。
- `workgroup-style.js` 已有 `.bt-wg*` 样式和 Bot theme token。
- `workgroup-identity.js` 有身份展示 helper。
- `workgroup-presence.js` 有 presence helper，但没有确认生产消费者。
- `client/index.mjs` 有房间、消息、成员、附件、目录和 reducer 基础。
- Bridge 有 ACK、重连、catch-up 和去重基础。
- 服务端已有房间成员 presence、消息 mention、附件 ACL 和任务事件。

### 未闭合

- Host `hub-send` 没有透传 `mentions` 和 `attachments`。
- 远程 Bot 目录没有确认进入工作群 roster 和 mention picker。
- Bridge 的 `onEvent` 输出到 `rt.onWorkgroupEvent`，但没有生产消费者。
- reducer 没有处理 `presence.changed`，也没有成为工作群 UI 的实时状态源。
- 工作群设置中的成员 action 仍采用本地群 action 形状。
- `+ Reference a chat` 的原版引用流程在工作群中没有完整证据。
- 附件控件有选择/上传调用，但下载渲染、接收者 ACL 和失败状态仍需要真实验证。

## 3. 目标数据流

```text
Hub HTTP/WSS
  -> application/integrations/workgroup/bridge
  -> Host workgroup-hub
  -> 现有 DSH Gateway/Remote Event 通道或等价 Host-to-Client 事件通道
  -> workgroup provider 的响应式状态
  -> WorkgroupPane / WorkgroupView
```

事件流必须使用现有两个运行边界中的通道，不新增第三个进程或独立实时协议。首屏打开房间时使用 `openRoom()` 做 baseline；事件通道建立后再接收增量事件；重连使用 `afterSeq/head` catch-up，不能依赖固定轮询作为实时性证明。

## 4. 统一工作群状态

Provider 维护每个 `roomId` 的状态，至少包含：

```js
{
  room,
  members,
  bots,
  messages,
  tasks,
  invitations,
  head,
  presence,
  connection: 'connected' | 'reconnecting' | 'restricted' | 'offline',
  lastError,
}
```

状态规则：

- Hub 的房间、成员和消息是事实源；本地缓存只用于首屏和重连期间显示。
- 同一 event id 或同一 room sequence 重复到达时，状态不重复插入。
- 成员被移除、房间解散、设备撤销或 token 失效时，状态立即变为受限或不可用。
- 断线时保留已读内容，但不伪造新消息、在线状态或任务状态。
- 重新连接后先 catch-up，再恢复 `connected`。

## 5. 消息、回复和 mention

### 5.1 消息发送契约

`WorkgroupView` 的 composer 产生以下数据：

```js
{
  text,
  replyToMessageId,
  mentions: [{ userId, botId }],
  attachments: [{ artifactId }],
  clientMessageId,
}
```

数据必须经过以下链路且字段不丢失：

```text
WorkgroupView.onSend
  -> workgroup-pane.onSend
  -> workgroups.sendMessage
  -> Host hub-send
  -> integration client.sendMessage
  -> POST /rooms/:roomId/messages
```

服务端继续负责检查：

- mention 的 user/Bot 是否属于该工作群的可见范围。
- `replyToMessageId` 是否属于同一房间。
- attachment 是否属于同一房间并满足当前发送者权限。
- `clientMessageId` 幂等重试。

### 5.2 远程 Bot 目录

打开房间或进入 mention picker 时，Provider 应加载当前调用者可见的 published Bot directory。目录项至少需要能表达：

```js
{
  botId,
  ownerUserId,
  displayName,
  ownerDisplayName,
  capabilities: publicSummary,
}
```

目录不得枚举未加入用户的账号。未发布或当前调用者无权使用的 Bot 不进入 roster 和 mention picker。

用户选择远程 Bot 后只发送稳定的 `botId`、必要的 `ownerUserId` 和消息文本；Hub 创建 `PENDING_APPROVAL` 任务，禁止客户端或 Hub 消息路由直接启动命令。

### 5.3 回复和本地引用

工作群必须保留当前 `replyToMessageId` 行为。原版 `+ Reference a chat` 需要在工作群中明确处理：

- 可以引用当前用户有权读取的本地或工作群会话。
- 跨房间或他人私人会话默认拒绝。
- 需要授权的引用必须先经过已有访问控制，不得靠 prompt 或 UI 隐藏代替权限。
- 引用内容优先传递受控 reference，而不是把私聊全文复制到 Hub。
- Hub 消息中不携带超出收件者权限的原始内容。

## 6. 附件和 ACL

附件流程：

```text
选择文件
  -> Host 读取用户明确选择的文件
  -> hub-upload-artifact(roomId, fileName, bytes, contentType, recipients)
  -> Hub 生成 artifact
  -> 消息只引用 artifactId
  -> 读取/下载时再次检查 ACL
```

验收规则：

- 不上传完整工作目录。
- 附件必须属于当前工作群。
- 消息只保存 artifact ID 和展示文件名，不携带机器本地路径。
- 非接收人不能下载。
- 跨房间 artifact 不能被引用。
- 成员被移除或任务分享范围改变后，下载权限按 Hub 当前 ACL 重新判断。
- 上传大小、类型、失败和重试状态在 UI 中可见。

## 7. 实时事件与 presence

### 7.1 事件消费者

Host 创建 Bridge 时，必须将事件接入实际 runtime consumer。不得停留在可选回调：

```js
onEvent: event => runtimeWorkgroupStore.apply(event)
```

若复用 DSH Gateway 的 `registerRemoteEvents()` / `$events` 通道，则事件源、allowlist、生命周期和重连必须由现有 Gateway 管理；不得另起一套 WebSocket 给浏览器。

### 7.2 reducer

`reduceWorkgroup(state, event)` 至少处理：

- `message.created`
- `member.changed`
- `presence.changed`
- `invitation.created`
- `task.approval_requested`
- `task.approved`
- `task.cancelled`
- `task.progress`
- 任务完成、失败和 review 事件。

未知事件保持状态不变并记录非敏感诊断。重复事件必须幂等。

### 7.3 在线状态

- 在线由活跃连接推导，不由数据库持久化的长期标志决定。
- 任一设备在线即视为该人在线。
- 只有同一工作群成员可以查看成员在线状态。
- UI 显示在线/离线或受限，不显示精确时间戳。
- Hub 重启、Bridge 断线、令牌撤销和成员移除后正确回落离线或受限。
- 人类 presence 与 Bot 自身执行 `state` 分开显示。

## 8. 工作群设置与成员管理

工作群设置必须使用独立的 Hub action adapter，不把本地 `actions.updateRoom()`、`actions.deleteRoom()` 或本地 `roster` 传给 Hub 视图。

建议的 action 形状：

```js
{
  renameRoom(roomId, name),
  invite(roomId, { targetUserId, role }),
  respondToInvitation(invitationId, decision),
  revokeInvitation(invitationId),
  setRole(roomId, userId, role),
  removeMember(roomId, userId),
  leave(roomId),
  dissolve(roomId),
}
```

规则：

- owner/admin 权限由 Hub 再次判断，UI 只负责减少误操作。
- owner 解散工作群使用 `dissolve`，不调用本地删除房间。
- 成员离开、被移除和房间解散后，客户端取消 watch 并清理实时订阅。
- 邀请只按用户 ID 发送，不提供可枚举全局用户搜索。
- 自己的 ID/handle 在账户区域和工作群设置中都可复制。

## 9. UI 状态和错误处理

每个工作群面板至少要能表达：

- 正常同步。
- 正在重连。
- Hub 离线但已有缓存。
- 需要重新登录。
- 已不再是成员。
- 房间已解散。
- 上传失败或无下载权限。
- 消息发送失败但草稿仍保留。

发送失败时不得先清空草稿、reply、mention 或 attachment；只有 Hub 接受后才清理。

## 10. 验收标准

1. 消息中的 mention 和 attachment 从 UI 到 Hub 不丢字段。
2. 远程 Bot 能出现在有权用户的 mention picker 中，未发布或无权 Bot 不出现。
3. mention 只生成待审批任务，不启动任何执行。
4. Bridge 事件实际更新工作群消息、成员、任务和 presence。
5. 重连 catch-up 无漏消息、无重复消息；重复事件不会重复渲染。
6. 工作群设置的成员和解散操作不调用本地 room action。
7. 非成员、跨房间附件和无 ACL 的下载全部被拒绝。
8. 人类在线状态只对同群成员可见，且不泄漏精确时间。
9. `+ Reference a chat` 对无权数据明确拒绝。
10. 普通 Bot、普通会话和本地群行为保持原状。

## 11. 直接影响文件

- `application/packages/bundle/ds-bot/src/client/workgroup.js`
- `application/packages/bundle/ds-bot/src/client/workgroup-pane.js`
- `application/packages/bundle/ds-bot/src/client/group-settings.js`
- `application/packages/bundle/ds-bot/src/client/workgroup-presence.js`
- `application/packages/bundle/ds-bot/src/client/at-menu.js`
- `application/packages/bundle/ds-bot/src/host/workgroup-hub.js`
- `application/packages/bundle/ds-bot/src/client/workgroup-hub.js`
- `application/packages/bundle/ds-bot/src/client/api.js` 或现有 Gateway 事件接线处
- `application/integrations/workgroup/client/index.mjs`
- `application/integrations/workgroup/bridge/index.mjs`
- `application/integrations/workgroup/tests/a02-workgroup-view.spec.ts`
- 相关事件、附件、presence 和恢复测试。

服务端 `server/src/api/messages.js`、`rooms.js`、`realtime/events.js`、`realtime/hub.js` 首先作为协议事实源验证；只有契约测试显示服务端缺失时才扩大修改范围。
