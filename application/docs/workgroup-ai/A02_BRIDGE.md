# A-02 交付：Bridge WSS ACK / 重连 / 离线补拉

| 字段 | 内容 |
|---|---|
| 任务 ID | A-02 |
| 状态 | **PASS**（14/14 测试，两端均为真实实现：真实 Hub 进程 + 真实 `ws` 客户端 + 真实 WebSocket） |
| 涉及路径 | `application/integrations/workgroup/bridge/index.mjs`（新增）、`application/integrations/workgroup/tests/a02-bridge.spec.ts`（新增）、`application/integrations/workgroup/protocol/hub-client.mjs`（暴露 `accessToken` getter） |
| 前置条件 | A-01、H-06（实时事件） |

## 达成条件

| 条件 | 结果 |
|---|---|
| 真实双端无重复 | 通过：重连后逐条比对 `roomSeq`，断言序列恰为 `[1..6]` 且无重复 |
| 断线期间的事件不丢 | 通过：断线期间写入 2 条，重连后补拉恰好得到这 2 条，顺序正确 |
| 每个事件都被 ACK | 通过：Hub 侧未确认集合的容量上限依赖客户端确认，测试核对 `acknowledged ≥ delivered` |
| 重连后恢复全部订阅 | 通过：两个房间各写一条，重连后两条都收到 |

## 实现要点

Bridge 只做一件事：让本设备对所属房间的视图保持最新，不重复、不遗漏。三种朴素实现的失败模式与对应处理：

| 失败模式 | 处理 |
|---|---|
| 断线后事件丢失且无记录 | 每房间维护 `roomSeq` 游标（**仅在订阅者处理完成后**推进），重连时按游标拉取 `afterSeq` |
| 重连导致事件重放 | 按 `eventId` 去重，并按 `roomSeq` 过滤；订阅者可按至少一次语义编写 |
| 重连风暴 | 指数退避 + 抖动；认证类拒绝（4401/4403）**完全不重试** |

关键取舍（每条都有测试）：

- **ACK 在订阅者返回之后发送**，不是收到就发。崩溃时事件仍未确认，Hub 仍持有它；先 ACK 更快，但恰好会在最需要的时候丢事件。
- **传输帧（`hello`/`ack`/`error`）不进订阅者**：`error` 通过 `onStateChange('hub-error')` 上报（有测试）。
- **`stop()` 保留游标**，`start()` 是"接着上次继续"；想要重新开始就新建 Bridge。把两者合成一个语义必然丢掉其中一种意图。
- **令牌放在握手 header**，不放 query string：URL 会进访问日志，日志里的 bearer token 就是凭据泄漏。
- **`seen` 与全局去重集合都有上限**：订阅者要在机器上跑数周，无界集合就是内存泄漏。
- **`catch-up` 先于连接**：先补齐历史再信任实时事件，订阅者看到的顺序天然正确。

**Bridge 不执行任何远程指令**：入站帧只被投递给本地订阅者。唯一会"执行"的是 `bot-adapter`，且必须先通过本地策略检查（A-07）。这条分界正是"被攻陷的 Hub 也无法让客户端跑命令"的原因——从入站帧到执行之间不存在代码路径。

## 真实命令与结果

```bash
# 真实 Hub 由测试自行拉起（production 配置、真实迁移、真实端口），真实 ws 客户端连接
cd application && npx vitest run integrations/workgroup/tests/a02-bridge.spec.ts
# → Test Files 1 passed | Tests 14 passed (14)

# 三个 integration 套件一起
npx vitest run integrations/workgroup/tests/
# → Test Files 3 passed | Tests 50 passed (50)
```

## 过程中修正的问题

1. **`stop()`/`start()` 语义一开始是含糊的**：测试用"新建一个 Bridge 再 start"模拟重连，结果整个房间被重放（`1..6,1..6`）。这暴露的不是去重缺陷，而是 API 没有说明游标是否跨 stop 存活。已在 `stop()` 的文档里写明：**游标存活**，重连即续传；重新开始请新建实例。
2. **`ws` 的解析**：`integrations/workgroup` 是源码目录而非 workspace 包，没有自己的依赖。按裸名 `import 'ws'` 只是碰巧被兄弟包提升，已改为从声明该依赖的 `apps/web` 显式解析，并注明原因。

## 未解决风险

| 项 | 状态 |
|---|---|
| 真实网络抖动/长时断网 | 用 `stop()`/`start()` 模拟，未做长时间真实断网（需双机，归 Q-01） |
| `MAX_PENDING_ACKS` 触顶路径 | Hub 侧会以 4408 关闭；客户端把它当普通断线重连，未单独测该关闭码 |
| 游标持久化 | 目前只在内存；进程重启后从第 0 号消息重新补拉。需要跨重启续传时要把 `cursors()` 落盘 |
| 限速 429 的退避 | Hub 登录限速返回 429 时客户端只报错，未实现针对 429 的退避（重连退避已实现） |
| 多设备同账号 | 未测同一账号两设备同时订阅（需双机） |

## 下一步

A-03：复用原版群聊 UI 建立工作群视图。
