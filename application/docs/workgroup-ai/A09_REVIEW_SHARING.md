# A-09 交付：任务进度脱敏、成果复核与受控分享

| 字段 | 内容 |
|---|---|
| 任务 ID | A-09 |
| 状态 | **PASS**（17/17 测试对**真实 Hub**；请求人经真实 WebSocket 订阅，逐字段断言收到的内容） |
| 涉及路径 | `application/integrations/workgroup/client/review.mjs`（新增）、`client/approvals.mjs`、`tests/a09-review.spec.ts`（新增）、`server/src/api/tasks.js`、`server/src/modules/tasks/store.js`、`server/tests/h08-tasks.test.js` |
| 前置条件 | A-08、H-11 |

## 达成条件

| 条件 | 结果 |
|---|---|
| 不自动公开私有中间数据 | 通过：进度事件只带 `state`/`stage`；任务视图不含 Bot/mode/scope；事件载荷剥离到只剩状态名 |
| 成果只在本人复核后离开本机 | 通过：`keep`/`reject` 不发布任何东西；只有 `share` 且必须指名接收人 |
| 受控分享 | 通过：接收人必须是房间成员；**请求人总是被加入**；命名者随事件送达 |
| 非本人不能复核 | 通过：请求人与房间管理员都不能 `keep`/`reject`/`share` |
| 不能写他人进度 | 通过：请求人写进度被 403 拒绝 |

## 修复的三处真实泄漏

均由本任务的逐字段断言暴露。

### 1. 房间能看到 owner 选用的 Bot 与派发模式（严重）

`publicTask` 无条件返回 `assignedBotId` 与 `assignmentMode`。**房间里的任何成员**——包括只是被邀请进来的第三方——都能读到"B 用哪个 Bot、以哪种模式"跑这个任务。这是关于 B 那台机器的事实：房间要的是一个成果，不是一份机器清单。

改为显式 `includeMachine` 门控，**默认关闭**：新写的路由如果没想过脱敏，发布的会是安全形态而不是泄漏形态。owner 自己的客户端显式要求这些字段。

`server/tests/h08-tasks.test.js` 里有一条测试把这个泄漏**写成了期望值**（逐字列出 `assignedBotId`/`assignmentMode`为应有字段）。已改为断言它们**不在**房间视图中，并新增：owner 能读、请求人不能读。

### 2. `task.approved` 事件的公开载荷带上了派发模式（严重）

`decideTask` 把 `assignmentMode` 写进 `task_events.public_payload_json`，而 `listTaskEvents` 把这个字段**服务给房间里的每个成员**。也就是说即使任务列表修好了，事件流仍在泄漏。

这是因为测试断言 "requester 的原始响应里不应出现 `existing_bot`" 才发现的——**只查字段名会漏掉**，必须查原始报文。已改为公开载荷只含 `{ state }`。

### 3. 详情路由把 owner 的 scope 发给请求人（严重）

原来 `includeScope: isOwner || task.state !== 'PENDING_APPROVAL'`：任务一旦离开待审批，**请求人**就收到owner 批准的工作目录与工具清单。改为只有 owner 能读。

三条都是同一个模式：**"房间需要知道进度"被当成了"房间可以知道一切"**。

## 设计要点

| 决定 | 理由 |
|---|---|
| 脱敏在**生产处**做，不在发出前过滤 | 没进入对象的私有值，无法被后续改动泄漏；发出前过滤离"被第二条发送路径绕过"只差一次重构 |
| 正向字段白名单 | 负向列表（"除这些外都行"）在有人新增字段之前都是对的，而那一刻正是它泄漏的时刻 |
| 未知阶段报为 `failed` 而非丢弃 | 房间静默收不到某任务的消息，与任务停止推进无法区分 |
| `assertPublishable` **拒绝**而非过滤私有字段 | 过滤会静默剥掉，泄漏因此不可见；拒绝会点名该字段，加它的人会去修 |
| `keep`/`reject` 都不发布 | "完成了"与"失败了"都是状态，不是内容 |
| `share` 必须指名接收人 | 空列表是**没回答的问题**，不是对房间的授权 |
| `share` 总是加入请求人 | 成果分享给第三方却不给提出请求的人，比不分享更糟 |
| 空摘要不进载荷 | 让接收人自己判断"没摘要"与"摘要是空串"是不同的两件事 |
| artifact 只引用不内联 | 字节留在 artifact 自己的 ACL 之后，由 Hub 按读者与请求逐个校验 |

## 真实命令与结果

```bash
cd application && npx vitest run integrations/workgroup/tests/a09-review.spec.ts
# → Test Files 1 passed | Tests 17 passed (17)

cd application && npx vitest run integrations/workgroup/tests/
# → Test Files 8 passed | Tests 183 passed (183)

cd server && /d/Develop/nvm/v24.19.0/node.exe --test tests/*.test.js
# → tests 307, pass 307, fail 0
```

## 未解决风险

| 项 | 状态 |
|---|---|
| **成果内容本身的 DLP** | 未实现。本任务控制的是"谁收到什么引用"；成果文件里**写了什么**（是否含密钥、私人数据）没有扫描（H-11 已登记"无扫描"） |
| **模型链路与推理过程** | 未公开（这是本任务的目标），但没有机制**阻止** owner 自己把推理粘贴进摘要 |
| 分享后的撤回 | 撤回会移出 ACL，但**已下载的副本无法收回**；需求本身承认"合法已下载副本"的边界 |
| 接收人通知 | 事件里带接收人，但没有逐个推送的"你收到一个成果"通知 |
| 真实双机 | 归 Q-01（预期 BLOCKED） |
| 附件容量配额 | 未实现（H-11 已登记） |

## 下一步

A-10：工作群长期记忆与授权 Bot 检索。之后进入 Q 系列验收。
