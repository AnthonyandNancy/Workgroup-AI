# A-05 交付：ID 邀请 / 成员管理 / 真人消息 / @Bot

| 字段 | 内容 |
|---|---|
| 任务 ID | A-05 |
| 状态 | **PASS**（32/32 测试，全部针对**真实 Hub**；两个独立 Hub 客户端、各自设备与令牌、各自真实 WebSocket。唯一缺的是第二台物理机，归 Q-01） |
| 涉及路径 | `application/integrations/workgroup/client/index.mjs`（新增）、`tests/a05-workgroup.spec.ts`（新增）、`server/src/modules/rooms/store.js`、`server/src/modules/messages/store.js`、`server/src/api/messages.js`、`server/src/modules/bots/store.js`、`server/db/migrations/0008_message_replies.sql`（新增） |
| 前置条件 | A-01/A-02/A-04、H-04/H-05/H-07/H-08 |

## 达成条件

| 条件 | 结果 |
|---|---|
| 邀请按 userId | 通过：邀请→收件人可见→接受成为成员→可读房间；`roomName` 随邀请到达 |
| 成员管理 | 通过：改角色、移除、主动退出；非管理员一律被拒（含给自己升权） |
| 真人消息 | 通过：**两个独立客户端**互相看到对方消息，顺序与作者名正确 |
| 幂等 | 通过：同一 `clientMessageId` 重发得到同一条消息，`duplicate: true`，房间内仍只有 1 条 |
| @Bot 候选 | 通过：目录只列出 Hub 允许调用方看到的条目，且不含模型/Session/路径/能力字段 |
| 非成员不可见 | 通过：房间、成员、消息、head、发消息全部 404（不是 403） |

## 修复的三个服务端缺陷

均由本任务的真实多用户测试暴露：

### 1. 邀请的创建响应缺少房间名（中等）

`createInvitation` 返回 `findInvitation`，而后者是 `SELECT * FROM invitations`（无 JOIN），`listInvitationsFor` 却有 `r.name AS room_name`。于是**列表**响应带 `roomName`，**创建**响应没有——邀请人刚发出一条邀请，却看不到它是发给哪个房间的。

已让 `findInvitation` 使用与列表相同的两个 JOIN，并在注释里写明原因（`publicInvitation` 会在字段存在时发布它）。

### 2. 目录把 owner 自己的私有 Bot 排除掉了（中等）

```sql
-- 修复前：在 isVisibleTo 之前就过滤掉WHERE d.visibility <> 'private'
```

`isVisibleTo` 里明确写着 "An owner always sees their own entry, whatever its visibility"，但这个前置过滤在它之前就把私有条目删掉了。结果：owner 通过 `findEntry` 能读到自己的 Bot，它确实存在也确实属于他，却不出现在唯一用于浏览的列表里，且没有任何错误说明原因。

已移除该前置过滤，只由 `isVisibleTo` 判定可见性（它的 `private` 分支仍然拒绝其他所有人）。

### 3. 回复（`replyToMessageId`）被静默忽略（中等）

工作群视图提供回复功能，但 Hub 没有这个字段，而 Fastify 不拒绝多余字段：客户端发出 `replyToMessageId`，Hub 当作未知字段丢掉，消息以普通消息落库。**发送方看到自己在回复，其他人看到一条没有上下文的孤立消息**，且哪一层都不会报错。

新增迁移 `0008_message_replies.sql`（列 + 部分索引）与 `assertReplyTarget`：目标必须在**同一房间**，否则报与"目标不存在"相同的错误——这样回复字段就不能被用来探测别的房间里是否有某个 message id。

## 真实命令与结果

```bash
# 真实 Hub 由测试自行拉起；每个"人"是独立客户端 + 独立设备 + 独立令牌 + 独立真实 WebSocket
cd application && npx vitest run integrations/workgroup/tests/a05-workgroup.spec.ts
# → Test Files 1 passed | Tests 32 passed (32)

cd application && npx vitest run integrations/workgroup/tests/
# → Test Files 4 passed | Tests 88 passed (88)

cd server && /d/Develop/nvm/v24.19.0/node.exe --test tests/*.test.js
# → tests 307, pass 307, fail 0
```

## 设计要点

| 决定 | 理由 |
|---|---|
| 邀请以 **userId** 而非 handle | Hub 没有人员搜索，加一个就成了枚举公司账号的手段 |
| 成员列表永远从 Hub 重读，不与本地合并 | 本地缓存的成员列表会让被移除的人在刷新前一直显示在群里 |
| 移除成员由 Hub 就地退订其 socket | 客户端"不再显示"只是礼貌，不是边界 |
| 空消息/非法角色**同步**抛错 | 这是调用方错误而非服务端拒绝，发出请求还会白白消耗一个 roomSeq |
| 目录条目不携带 model/Session/路径/能力 | 这是 owner 的私有事实；H-07 在服务端断言同一件事 |
| 被移除的成员再读房间返回 404 | 403 会确认该 id 指向真实房间，正是探测者想知道的 |
| reducer 是纯函数 | Bridge 至少一次投递，去重必须在某一层发生；纯函数意味着可无 socket/无 Hub/无浏览器地测试 |

## 未解决风险

| 项 | 状态 |
|---|---|
| **真实两台电脑** | 本机不具备。已用两个独立客户端 + 独立令牌 + 独立 WebSocket 覆盖到"第二台机器"之下的每一层，但物理双机（含真实网络、真实时钟差、真实 N 台设备）归 Q-01（预期 BLOCKED） |
| 邀请过期 | Hub 有 TTL，但未测"刚好过期"的边界 |
| 目录分页 | 当前一次返回全部可见条目；公司规模大时需要分页 |
| 消息编辑/删除 | **未实现**（H-05 已登记） |
| @ 提及的结构化字段 | **未实现**：消息体是纯文本，@Bot 目前只是文本约定，没有 `mentions` 字段。A-06 的派发需要在消息上绑定目标 Bot，届时必须补 |
| 附件与引用 | 归 H-11/A-09 |

## 下一步

A-06：B 客户端本人审批卡与三种派发方式。它需要先补"消息上的结构化 @Bot 目标"，否则派发只能靠文本解析。
