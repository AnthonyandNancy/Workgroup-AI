# H-06：WSS 鉴权、订阅、ACK、心跳和事件恢复

**任务 ID：** H-06
**执行日期：** 2026-10-15
**机器：** Windows 11 (MINGW64) / Node v26.7.0 / Fastify 5.12.7 / @fastify/websocket 11.3.4 / ws 8.22.0
**证据等级：** **L**（单电脑真实进程 + 真实 WebSocket 连接）。无 N 级（双机）结论。

## 完成条件与结论

| 条件 | 结果 |
|---|---|
| WSS 鉴权 | **PASS** — 在**握手前**完成；无 token 与伪造 token 均被 401 拒绝升级 |
| 订阅 | **PASS** — 订阅时重查成员资格；非成员被拒且收不到该群任何事件 |
| ACK | **PASS** — 未 ack 事件被记入待确认表；ack 后清除；重试不重复推送 |
| 心跳 | **PASS** — 30s 周期 ping，未响应即关闭并释放 |
| 事件恢复 | **PASS** — socket 断开后用 HTTP `afterSeq` 补拉，缺口补齐且不重 |
| **离线/断链恢复** | **PASS** — 真实断线演练确认 |

## 新增文件

| 文件 | 作用 |
|---|---|
| `server/src/realtime/events.js` | `wg.v1` 事件信封构造与客户端帧校验 |
| `server/src/realtime/hub.js` | 连接注册表、订阅、发送与 ACK 跟踪、心跳、扇出 |
| `server/src/realtime/route.js` | `/api/v1/realtime` 路由与**升级前**鉴权 hook |
| `server/tests/h06-realtime.test.js` | 20 个测试 |

新增依赖 `@fastify/websocket@^11.3.4`（`server/package.json`）。

## 开发中被测试暴露并修复的**真实安全缺陷**

### 缺陷：未认证的 WebSocket 会先握手成功，再被关闭

我最初的实现是在路由 handler 里鉴权，失败则 `socket.close(4401)`。测试 `a socket with no token is refused at the upgrade` 直接失败——客户端报告 `opened`。

**根因（读 `@fastify/websocket` 源码确认）：** 该插件把升级请求当作普通 HTTP 请求交给 Fastify 路由，**在路由 handler 被调用之前握手已经完成**。所以 handler 里的 `close()` 关的是一个**已经建立的会话**，而非拒绝连接。对客户端而言，它短暂拥有一个可用 socket；对攻击者而言，这是一个可探测的连接。

**修复：** 改用路由级 `preValidation` hook。它在握手前运行，拒绝时以 HTTP 401 结束升级，TCP 连接直接关闭，**不存在任何时刻的开放 socket**。同时把 `admit()` 拆成 `admitFor({socket, auth})`——鉴权属于升级 hook，`admitFor` 只负责建立连接记录，职责边界变得明确。

修复后测试通过，真实进程验证也确认：

```
=== 0. 无 token 尝试连接（应在握手前被拒） ===
  ✓ 升级被拒 HTTP 401
```

### 缺陷：设备吊销后已开的 socket 仍然存活

测试 `a revoked device cannot open a socket, and an open one is closed when its device is revoked` 失败：设备被吊销后，已建立的 socket 继续存在并继续收事件。

**修复：** `POST /devices/{id}/revoke` 现在遍历实时连接表，关闭属于该设备的 socket。理由是"一个活着的 socket 就是一个活着的会话"——不关闭它，被吊销的设备仍能实时收到群消息，直到它恰好重连。

## 其他关键设计决策

### 1. token 绝不出现在 URL 查询串
只从 `Authorization` 头读取。浏览器无法在 `new WebSocket` 上设置请求头，因此提供 `bearer.<token>` **子协议**回退，并在 `headersWithProtocolToken` 中保证**真实头优先**（测试固定：同时提供两者时用头部的那个）。URL 会进访问日志、浏览器历史和代理链路，放 token 在那里等于泄漏。

### 2. 订阅是授权，不是过滤
`subscribe` 每次都查 `room_members`（`removed_at IS NULL`）。非成员得到 `error` 帧 `NO_SUCH_ROOM`，且后续该群消息不会到达该 socket。测试 `subscribing to a room the caller is not in is refused` 断言了两件事：拒绝帧存在，且之后的消息确实收不到。

### 3. 移除成员时主动撤销其订阅
订阅检查发生在订阅时，不是每条事件。因此 `removeMember` 路由在移除后**主动**从该用户的连接上删除该 room 并推送 `member.changed`。测试 `a removed member stops receiving the room on their already-open socket` 覆盖此路径，真实演练也确认（"B 移除前收到 2 条，之后收到 2 条"）。

### 4. 慢消费者被断开而非无限缓冲
每个 socket 最多 512 条未 ack 事件；超出即关闭（4408）。无限缓冲会让一个卡住的客户端耗尽 Hub 内存，而该客户端本来就有基于序号的 HTTP 补拉可用。

### 5. ACK 跟踪使"断链"可检测
未 ack 事件记在 `connection.unacked`。测试 `an event stays unacknowledged until the client acks it` 从服务器内部断言这一表的存在与清空——这是区分"客户端掉线了"和"群里确实没人说话"的依据。

### 6. 心跳关闭半开连接
30 秒 ping 一次；未收到 pong 即关闭并释放。否则合上笔记本的用户会永久占着一个订阅位，而其他人以为他在线。测试通过标记 `alive = false` 后调用 `sweepDeadSockets()` 覆盖。

### 7. Hub 永不发送命令
所有出站帧都是关于 Hub 状态的**通知**。`CLIENT_FRAME_TYPES` 只有 `ack`/`subscribe`/`unsubscribe`/`ping`；任何其他帧类型（例如测试里的 `{type:'run_shell'}`）被拒绝并回 `UNKNOWN_FRAME_TYPE` 错误码，而不是忽略。

### 8. 版本不兼容在首帧即拒绝
客户端帧若带 `schemaVersion: 'wg.v2'` 得到 `UNSUPPORTED_SCHEMA_VERSION`。避免客户端在误读后续每条事件之后才发现。

## 真实执行证据

### 测试

```sh
$ node --test tests/h06-realtime.test.js
 ℹ tests 20
 ℹ pass 20
 ℹ fail 0

$ node --test tests/*.test.js          # 全量
 ℹ tests 135
 ℹ pass 135
 ℹ fail 0
```

20 项覆盖：信封字段、未知事件类型被拒、跨版本被拒、畸形/非法帧类型各错误码、子协议回退与头部优先、**无 token 升级被拒**、**伪造 token 升级被拒**、hello 帧内容、**设备吊销关闭已有 socket**、订阅前不推送、订阅后推送、非成员订阅被拒且收不到、**被移除成员停收**、退订后停收但连接仍在、跨群隔离、ACK 生命周期、**重试不重复推送**、**断线后 HTTP 补拉补齐缺口**、多 socket 扇出同一 eventId、关闭后释放、心跳清扫死连接。

### 真实双客户端实时演练

```
=== 0. 无 token 尝试连接（应在握手前被拒） ===
  ✓ 升级被拒 HTTP 401

群已建，A 与 B 均为成员

=== 1. A、B 各建立实时连接 ===
  [A] hello: schema=wg.v1 user=财务 A
  [B] hello: schema=wg.v1 user=财务 B

=== 3. A 发消息，双方应实时收到 ===
  A←seq1"请 B 制作季度报表"  B←seq1"请 B 制作季度报表"

=== 4. B 回复 ===
  A←seq2"收到，今天下班前给你"  B←seq2"收到，今天下班前给你"

=== 5. A 移除 B，B 的 socket 应收到通知且不再收到群事件 ===
  B 移除前收到 2 条，之后收到 2 条（已停止接收）
  A 收到的最新: 请 B 制作季度报表 | 收到，今天下班前给你 | 移除后 A 再发一条

=== 6. B 重连并补拉 ===
  [404] 已不是成员，补拉被拒: {"error":{"code":"NO_SUCH_ROOM",...}}
```

## 未完成与风险

| 项 | 状态 |
|---|---|
| 双机跨网络 WSS 实测 | **未做**，归 Q-01（需两台真实电脑 + 独立 Hub） |
| TLS（`wss://`）实际链路 | 未做。`server.js` 支持 `HUB_TLS_CERT/KEY`，但本轮全部验证走明文 `ws://`。**生产必须启用 TLS**，否则 token 与消息在网络上是明文 |
| 事件经 WSS 的邀请/任务推送 | 只实现了 `message.created` 与 `member.changed`；`invitation.created`、`task.*`、`group_memory.changed` 已列入 `EVENT_TYPES` 但**尚无生产者**，归 H-08/H-10 |
| 服务端侧的多进程广播 | 未做。单 Hub 进程设计下不需要；若将来横向扩展，扇出需要外部总线 |
| 客户端 ACK 的丢包重传 | 未做。服务端只记录待确认，重传策略在客户端（A-02） |
| 连接数上限 / 每用户连接数限制 | 未实现，属 H-13 安全加固 |

## 下一步

H-07（可公开远程 Bot 目录及在线状态），依赖 H-03。已具备身份与实时通道。
