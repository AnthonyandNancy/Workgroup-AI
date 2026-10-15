# H-07：可公开远程 Bot 目录及在线状态

**任务 ID：** H-07
**执行日期：** 2026-10-15
**机器：** Windows 11 (MINGW64) / Node v26.7.0 / Fastify 5.12.7 / SQLite（`node:sqlite`，WAL）
**证据等级：** **L**（单电脑真实进程 + 真实 HTTP + 真实 SQLite）。无 N 级（双机）结论。

## 完成条件与结论

| 条件 | 结果 |
|---|---|
| 可公开的远程 Bot 目录 | **PASS** — `private` / `room` / `public` 三级可见性，由所有者逐 Bot 设定 |
| 在线状态 | **PASS** — 由心跳新鲜度派生，发布本身不等于在线 |
| **只可见用户授权 Bot** | **PASS** — 非授权条目返回 404，且与"不存在"逐字节相同 |

## 新增文件

| 文件 | 作用 |
|---|---|
| `server/db/migrations/0003_bot_directory.sql` | 补 `last_seen_at` / `published_at` 列与索引 |
| `server/src/modules/bots/store.js` | 目录仓储、可见性判定、presence 派生 |
| `server/src/api/bots.js` | 6 条路由：自有列表、发布、收回、心跳、浏览、单个解析 |
| `server/tests/h07-bot-directory.test.js` | 15 个测试 |

## 关键设计决策与依据

### 1. 目录**只**存元数据，不存任何关于所有者机器的信息
`bot_directory` 的列只有：`owner_user_id`、`bot_id`、`display_name`、`visibility`、`state`、`updated_at`、`last_seen_at`、`published_at`。

**刻意不存**：模型名、Session id、能力/工具清单、工作目录、任何文件路径、任何凭据。理由：目录是**发现**界面，是最容易过度暴露的地方。同事需要知道"某个 Bot 存在且可以请它干活"；其余属于所有者自己的事。测试 `a directory entry carries no model, Session, path, or capability information` 同时从 schema 列名与响应字段两处固定这一点。

### 2. 默认 private，且没有任何路径能隐式发布
新建条目未指定 visibility 时是 `private`。`public` 与 `room` 只能由所有者**显式**设定。测试 `a new Bot starts private` 断言：所有者自己的管理列表能看到它，其他人**在所有三个读接口上都看不到**。

### 3. 非授权条目返回 404，且与"不存在"不可区分
```
GET /bots/directory/<owner>/secret-bot     (private，非所有者) → 404
GET /bots/directory/<owner>/no-such-bot                        → 404
```
测试用 `deepEqual` 固定两者响应**完全一致**，因此目录不能被用作"探测某个 Bot 是否存在"的工具。

### 4. `room` 可见性是**活的**关系，不是历史关系
`room` 语义是"与我共享至少一个群的人能看到"。判定每次查库（`sharesAnyRoom`，两侧都要求 `removed_at IS NULL`）。测试的末尾显式把对方移出群，再断言可见性**立即收回**——共享是当下事实，不是曾经发生过的注册。

### 5. presence 由心跳新鲜度派生，不信客户端自报的状态
`presenceOf()` 的规则：`last_seen_at` 为空或超过 90 秒 → `offline`，否则 `online`。

这是本模块最重要的正确性点：**崩溃的客户端不会发送"我离线了"**。若 Hub 只是存储并回放客户端最后一次自报的状态，一个断电的机器会永远显示为在线，而实际上没人能应答。测试 `presence is derived from heartbeat freshness, not from the stored claim` 覆盖四种情况，包含"存储的 state 是 online 但时间已过期"这一关键反例。

响应同时给出 `presence`（Hub 派生，无法被崩溃欺骗）与 `state`（客户端自报，供所有者自己的管理视图标注 Bot 正在做什么）。二者用途不同，因此都需要。

### 6. 发布**不**隐含在线（开发中被测试暴露的真实缺陷）
最初实现里 `publishEntry` 首次写入时设 `last_seen_at = now`，导致刚发布的 Bot 立刻显示 `online`——而没有任何运行时能应答。

测试 `a public Bot is visible to any authenticated user` 与 `a heartbeat marks a Bot online` 同时失败，暴露了这一点。**修复：** 新建条目 `last_seen_at` 初始为 `NULL`，且**修改可见性时也不再触碰 `last_seen_at`**。presence 只能由心跳变成 online。真实验证第 4 步确认：

```
=== 4. presence：发布本身不等于在线 ===
  B 看到 presence = offline（应为 offline，尚无心跳）
```

### 7. 写操作只作用于调用者自己的条目
所有写路由（发布/收回/心跳）从**已认证会话**取 owner id，**没有任何路由接受请求体里的 owner id**。因此用户不可能替他人发布，即使猜到对方 id。测试 `only the owner can publish, change, or withdraw an entry` 断言：B 对 A 的条目做 heartbeat/withdraw 得到 404，且 A 的条目**未被改动**（直接查库确认 `visibility` 仍为 `public`）。

### 8. 可见性收窄在下一个请求立即生效
解析单个条目的路由**重新**检查可见性，而不是信任先前的列表结果。测试 `narrowing visibility takes effect on the very next request` 先 public 后 private，断言第二次解析就返回 404。

### 9. 目录变更进审计，心跳不进
`bot.published` / `bot.visibility_changed` / `bot.withdrawn` 记入 `audit_events`；心跳是高频且不携带决策，不记。测试固定 `bot.heartbeat` **不出现**在审计里，避免审计表被心跳淹没。

## 真实执行证据

### 测试

```sh
$ node --test tests/h07-bot-directory.test.js
 ℹ tests 15
 ℹ pass 15
 ℹ fail 0

$ node --test tests/*.test.js          # 全量
 ℹ tests 150
 ℹ pass 150
 ℹ fail 0
```

15 项覆盖：presence 四种派生情况（含"存储 online 但过期"）、新建即 private 且他人不可见、public 带所有者信息、无 token 全部 401、**room 可见性只在同群者可见且移出后收回**、**private 与不存在响应逐字节相同**、收窄立即生效、仅所有者可写且他人条目不变、同 botId 跨所有者独立、id/名称/可见性校验、按所有者与名称过滤、心跳转 online 与过期转 offline、state 可设 busy/offline 且拒绝未知值、**schema 与响应均不含模型/会话/路径/能力**、审计含发布与收回但不含心跳。

### 真实进程端到端

```
1. A 发布 Chief，先设为 private
   [201] visibility=private presence=offline

2. B 与 C 都看不到 private Bot
   B 目录: 0 条
   C 探测: 404

3. A 改为 room 可见（需与 B 同群）
   [201] visibility=room
   B（同群）看到: Chief(presence=offline)
   C（无共同群）看到: 0 条

4. presence：发布本身不等于在线
   B 看到 presence = offline（尚无心跳）

5. A 的客户端发送心跳
   [200] state=online presence=online
   B 现在看到 presence = online

6. 改为 public，C 也能看到
   C 看到: 财务 A 的 Chief presence=online

7. A 收回（withdraw），所有人都看不到
   B: 0 条   C: 0 条

8. B 不能对 A 的 Bot 做任何写操作
   B heartbeat: 404   B withdraw: 404
```

## 未完成与风险

| 项 | 状态 |
|---|---|
| 在线状态的实时推送 | 未做。`presence` 变化不会经 WSS 推送（`EVENT_TYPES` 里也没有 `bot.presence`），客户端需轮询目录。归 A-05/A-06 的客户端设计 |
| 心跳的速率限制 | 未实现。心跳是高频接口，缺少限流意味着一个行为异常的客户端可以刷写数据库 |
| `room` 可见性的粒度 | 当前是"共享任一群即可见"。技术蓝图提到的是"只可见用户授权 Bot"，V1 未实现按群逐个授权；**这是一个已记录的设计收窄**，若产品需要逐群授权需扩展 schema |
| Bot 能力/角色的公开 | 未实现。目录不暴露 Bot 能做什么，因此 A 在工作群 @B 的 Bot 时，Hub 无法在 UI 上预告其能力——这是 H-08 审批卡需要解决的信息缺口 |
| 与 DS Bot 真实 Bot 列表的同步 | 未做。当前目录条目由客户端显式发布；A-07 需要让 Bridge 在 Bot 增删时同步目录 |
| 双机目录可见性实测 | 未做，归 Q-01 |

## 下一步

H-08（创建任务、审批、状态机、任务事件记录），依赖 H-04/H-07。这是跨用户委派的核心，也是本项目最高的安全门槛之一。
