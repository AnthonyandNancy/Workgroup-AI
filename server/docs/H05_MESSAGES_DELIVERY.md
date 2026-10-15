# H-05：消息写入、roomSeq、幂等去重、补拉

**任务 ID：** H-05
**执行日期：** 2026-10-15
**机器：** Windows 11 (MINGW64) / Node v26.7.0 / Fastify 5.12.7 / SQLite（`node:sqlite`，WAL）
**证据等级：** **L**（单电脑真实进程 + 真实 HTTP + 真实 SQLite）。无 N 级（双机）结论。

## 完成条件与结论

| 条件 | 结果 |
|---|---|
| 消息写入 | **PASS** — 成员校验 → 分配序号 → 插入 → 审计，同一事务 |
| roomSeq 单调递增 | **PASS** — 由 `rooms.next_seq` 分配，并发下无冲突无空洞 |
| 幂等去重 | **PASS** — 同发送者同群同 `clientMessageId` 只写一条；重试返回原消息且**不消耗序号** |
| 补拉 | **PASS** — `afterSeq` 精确返回缺口，`nextAfterSeq` 可安全续传 |
| **重连不丢不重** | **PASS** — 真实断线演练确认 |

## 新增文件

| 文件 | 作用 |
|---|---|
| `server/src/modules/messages/store.js` | 发送、读取、分页、序号分配与成员强制 |
| `server/src/api/messages.js` | 3 条路由：发送、补拉、head |
| `server/tests/h05-messages.test.js` | 20 个测试 |

## 关键设计决策与依据

### 1. 序号由 `rooms.next_seq` 分配，**不用 `max(room_seq)+1`**
这是本模块最重要的一条。`max(room_seq)+1` 在中间行被删除后会**重用**已发放过的序号：客户端已经见过 seq=2，新消息又拿到 seq=2，客户端的补拉游标从此永久错位，且**不会报错**。

测试 `sequence numbers do not restart when a message is deleted from the middle` 直接驱动这个反例：删掉中间一条后再发，断言新消息拿到 seq=4 而非 2。

分配与插入在同一事务内，因此崩溃不会让 `next_seq` 越过一条从未写入的消息。

### 2. 幂等键的作用域是（群 + 发送者 + clientMessageId）
数据库层已有 `UNIQUE (room_id, sender_user_id, client_message_id)`。作用域包含发送者是有意的：两个人在同一个群里各自用 `client-msg-000001` 是两条不同的消息，不是重复。

### 3. 重试返回原消息，即使正文变了
客户端因响应丢失而重试时，不能保证重试的正文与首次相同（用户可能已编辑）。返回**存储的原文**并标记 `duplicate: true`，使客户端无法用重试改写历史。测试 `a retry with a changed body still returns the stored message` 固定该行为。

### 4. 并发重试的胜者由数据库唯一约束决定
两个同时到达的同键请求会让其中一个撞上唯一约束。此时**不回滚成错误**，而是读出胜者的行当作重复返回——对客户端而言与串行重试完全一致。测试并发 8 次同键请求，断言恰好 1 个 201、7 个 200、库里只有 1 行。

### 5. 游标非法值明确拒绝，不静默当作 0
`afterSeq=-1` / `abc` / `1.5` 返回 400 `INVALID_CURSOR`。若把非法游标当作 0，一次客户端 bug 会让它重放整个群历史而不自知。

### 6. 分页上限夹取而非拒绝
`limit=100000` 被夹到上限（500）；`limit=0` 被夹到 1。夹取保证客户端**总拿到合法的一页**并可通过 `hasMore` 继续，而拒绝会让一个只是想多取一点的客户端彻底失败。

### 7. 成员校验在 store 层，不由路由负责
`readMessages`/`latestSeq`/`sendMessage` 内部都调用 `requireMember`。测试 `the store-level reader enforces membership, not just the route above it` 直接以 store API 断言非成员抛错——将来某个新路由忘记加检查时，规则仍然生效。

### 8. 审计记录序号，不记录正文
`message.created` 的 `safe_details_json` 只含 `{roomId, roomSeq}`。消息正文属于协作内容，审计是另一套更长保留期的存储，把正文复制进去会让"删除消息"永远无法真正生效。测试断言正文不出现在审计里。

### 9. 空页返回不变的游标
`afterSeq` 已达 head 时返回空数组且 `nextAfterSeq` 等于传入值。轮询的客户端因此不会丢失位置。

## 真实执行证据

### 测试

```sh
$ node --test tests/h05-messages.test.js
 ℹ tests 20
 ℹ pass 20
 ℹ fail 0

$ node --test tests/*.test.js          # 全量
 ℹ tests 115
 ℹ pass 115
 ℹ fail 0
```

20 项覆盖：序号从 1 递增、**20 条并发发送得到 1..20 无重复**、删除中间行后序号不回退、重试返回原消息且不消耗序号、改正文重试仍返回原文、两个发送者可复用同键、**8 次并发同键只写一条**、正文与 clientMessageId 校验边界、多字节与换行往返、非成员读写被拒、被移除成员立即失去读写、精确补拉缺口、**分页遍历 25 条恰好各一次且有序**、页大小夹取、非法游标 400、head 语义、两个群序号独立、审计含序号不含正文、store 层强制成员资格。

### 真实断线重连演练（真实进程 + 真实 HTTP）

```
群已建，A 与 B 均为成员

A 发 3 条，B 在线收到（模拟）
  [201] seq=1 A 的第 1 条
  [201] seq=2 A 的第 2 条
  [201] seq=3 A 的第 3 条

B 记录最后看到的 seq = 3，然后"断线"

断线期间 A 又发 2 条
  [201] seq=4 A 的第 4 条（断线期间）
  [201] seq=5 A 的第 5 条（断线期间）

B 重连，补拉 afterSeq=3
  [200] 收到 2 条: seq4, seq5
  nextAfterSeq=5 hasMore=false
  内容: A 的第 4 条（断线期间） | A 的第 5 条（断线期间）

幂等：A 重发第 5 条（同一 clientMessageId）
  [200] duplicate=true seq=5（仍为 5，未消耗新的序号）

再次补拉 afterSeq=3，应仍只有 2 条（无重复）
  [200] 2 条: seq4, seq5

群 head
  latestSeq=5
```

**缺口恰好 2 条、内容正确、重试不产生第 6 条、重复补拉不翻倍**——这就是"重连不丢不重"的真实验证。

## 未完成与风险

| 项 | 状态 |
|---|---|
| WSS 实时推送（在线用户即时收到） | **未做**，归 H-06。当前只有 HTTP 拉取，客户端需轮询 |
| 消息编辑 / 删除 | **未实现**。表中无 `edited_at` / `deleted_at`；这会影响 H-10 群记忆的纠错路径设计 |
| 消息附件 | 未做，归 H-11 |
| @ 提及的结构化表示 | **未实现**。正文是纯文本，`@某人` 没有独立字段，因此服务端无法据提及做通知或任务触发。H-07/H-08 需要时会要求 schema 扩展 |
| 群级限流 | 未实现（与已有欠账同源） |
| 分页游标的分片一致性 | 单 Hub 进程下无问题；若将来多进程写入，`BEGIN IMMEDIATE` 仍需保证（当前依赖单写入者设计） |

## 下一步

H-06（WSS 鉴权、订阅、ACK、心跳和事件恢复），依赖 H-05。
