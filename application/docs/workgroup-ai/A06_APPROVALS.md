# A-06 交付：B 客户端本人审批卡与三种派发方式

| 字段 | 内容 |
|---|---|
| 任务 ID | A-06 |
| 状态 | **PASS**（27/27 测试，全部针对**真实 Hub**；每个"人"是独立客户端 + 独立设备 + 独立令牌 + 独立真实 WebSocket） |
| 涉及路径 | `application/integrations/workgroup/client/approvals.mjs`（新增）、`tests/a06-approvals.spec.ts`（新增） |
| 前置条件 | A-05、H-08、H-09 |

## 达成条件

| 条件 | 结果 |
|---|---|
| 非 B 不能审批 | 通过：请求人、第三方成员、**房间管理员**三类都试过，Hub 全部拒绝；任务仍是 B 的 |
| 本人用自己的客户端审批 | 通过：B 从 `/tasks/pending` 读到自己的队列；批准/拒绝都由 B 的令牌发出 |
| 三种派发方式 | 通过：`existing_bot`（指名 Bot）、`chief_auto`（Chief 选）、`create_bot`（新建），授权范围各自记录 |
| 授权内容可核 | 通过：scope 逐字回读，含 taskId/roomId/双方 userId |
| 先授权后执行 | 通过：批准本身**不**铸造凭据；铸造是 B 自己的独立一步 |

## 两个关键设计（由真实测试确认，不是自定）

### 1. 批准 ≠ 铸造凭据

`POST /tasks/:id/decision` 记录 B 的**长期答复**；`POST /tasks/:id/grant` 才是铸造一个**短期、一次性、绑定botId 与设备**的凭据。测试断言"批准后凭据列表为空"，这正是两段式的意义：B 批准一次，之后按需发放若干凭据，撤销即停止授权而不必重新决策。

凭据的 nonce **只返回一次**、不以可读形式存储，列表里也不回传（有断言）；`publicGrant` 不含 owner 字段——**凭据的属主是认证调用者本身，永远不是某个字段**。一个"凭据可以指定属主"的接口，正是铸造环节最不该允许的事。

### 2. 拒绝也会留下 approval 记录

一次拒绝写入 `approvals` 行，scope 里**有**标识字段（taskId/roomId/ownerUserId）但**没有**派发模式与botId。这是对的：记录必须回答"是谁拒绝了什么"，但拒绝不得留下任何可执行的授权。测试同时断言`mintGrant` 在被拒绝的任务上失败——闸门不能靠"没人会去调"来守。

## 修正的客户端缺陷

| 缺陷 | 后果 | 修复 |
|---|---|---|
| `consumeGrant(grantId, nonce)` | 请求体字段错（Hub 要的是 `{nonce, taskId}`），**任何派发都会 404 `UNKNOWN_GRANT`** | 改为 `consumeGrant(nonce, taskId)`，并注释说明为何按 nonce 而非 id 查找：nonce 是秘密，id 不是 |
| `reject` 通过 `this.decide` 调用 | `const { reject } = approvals` 是 UI 最自然的写法，解构后 `this` 丢失，**点按钮立刻抛错** | 把 `decide` 提为具名函数，`reject` 直接调用它 |
| `revokeGrants(taskId, grantId)` | Hub 的路由是**整任务撤销**，没有单凭据撤销 | 改为 `revokeGrants(taskId)`，并说明为何不做部分撤销：执行器无法判断多个凭据中哪个授权了它正要发出的调用 |

## 真实命令与结果

```bash
cd application && npx vitest run integrations/workgroup/tests/a06-approvals.spec.ts
# → Test Files 1 passed | Tests 27 passed (27)

cd application && npx vitest run integrations/workgroup/tests/
# → Test Files 5 passed | Tests 115 passed (115)

cd server && /d/Develop/nvm/v24.19.0/node.exe --test tests/*.test.js
# → tests 307, pass 307, fail 0
```

## 设计要点

| 决定 | 理由 |
|---|---|
| `isMineToDecide(task, userId)` 是唯一谓词 | 整个特性的核心判断只写一次；散落在三个组件里的条件必然互相漂移 |
| `approvalChoices` 返回数据而非直接渲染 | 审批卡里真正有行为意义的是"有哪些选项"，而不是它们的标记 |
| 没有已发布 Bot 时不提供 `existing_bot`/`chief_auto` | 提供了也完不成，点下去只会得到员工无法处理的拒绝 |
| `create_bot` 永远可用 | 它不需要已有 Bot |
| scope 未指定目录时**不含** `workDir` 字段 | 执行器找不到目录就必须拒绝；客户端填默认值会把"拒绝"变成"静默回落到团队目录"，正是需求禁止的行为 |
| 空数组视为"未声明"而非"全部禁止" | 空工具列表读起来是"授权了零个工具"，与省略无法区分 |
| `expectedVersion` 必填 | 两台设备同时看着一个任务是常态而不是例外 |
| 非成员读任务返回 404 | 403 会确认该 id 指向真实任务 |
| 凭据列表只有 owner 能读 | "发过凭据"是关于 owner 那台机器的事实，不是房间的事 |

## 未解决风险

| 项 | 状态 |
|---|---|
| **真实两台电脑** | 本机不具备。已用两个独立客户端覆盖到"第二台机器"之下的每一层（独立设备、令牌、WebSocket、时钟），物理双机归 Q-01（预期 BLOCKED） |
| **审批卡的实际渲染** | 本任务交付的是审批**逻辑层**（决策、范围、凭据、队列）。卡片的 React 组件尚未接入 `workgroup.js`，属 A-03 剩余工作 |
| 凭据过期边界 | 有 TTL，未测"刚好过期"；`consumeGrant` 会报 `GRANT_EXPIRED` |
| `chief_auto` 的实际选 Bot | Hub 只记录模式；"Chief 选哪个 Bot"发生在本地 BotAdapter，归 A-08 |
| 子进程终止 | 撤销后正在运行的子进程是否真的被杀，**未实现也未测试**（H-09 已登记，归 A-07/Q-02） |
| 消息上的结构化 @Bot | 仍缺（A-05 已登记）。当前派发靠任务本身携带 `ownerUserId`/`targetBotId`，不依赖消息文本解析 |

## 下一步

A-07：本地 Bridge 严格验签并绑定已批准任务。它是"伪造或撤销不执行"的执行层，也是补上"子进程终止"的地方。
