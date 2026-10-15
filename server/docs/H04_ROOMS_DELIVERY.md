# H-04：创建群、成员邀请、接收/拒绝/踢出

**任务 ID：** H-04
**执行日期：** 2026-10-15
**机器：** Windows 11 (MINGW64) / Node v26.7.0 / Fastify 5.12.7 / SQLite（`node:sqlite`，WAL）
**证据等级：** **L**（单电脑真实进程 + 真实 HTTP + 真实 SQLite）。无 N 级（双机）结论。

## 完成条件与结论

| 条件 | 结果 |
|---|---|
| 创建群 | **PASS** — 创建者为 owner 且是首个成员，同事务写入 |
| 成员邀请 | **PASS** — 具名邀请 + 有效期 + 角色约束，需群管理员 |
| 接收 / 拒绝 | **PASS** — 仅被邀请人本人可操作；过期与重复被拒 |
| 踢出 | **PASS** — 删除为时间戳；owner 不可移除；即刻失效访问 |
| **非成员不能读群数据** | **PASS** — 且与"群不存在"返回**完全相同**的响应 |

## 新增文件

| 文件 | 作用 |
|---|---|
| `server/src/modules/rooms/store.js` | 群、成员、邀请的仓储与全部权限规则 |
| `server/src/api/rooms.js` | 14 条路由（群 CRUD、成员管理、邀请流转） |
| `server/src/auth/request.js` | **提取**出的共享请求鉴权器（原在 `api/identity.js` 内） |
| `server/tests/h04-rooms.test.js` | 24 个测试 |

## 顺带做的一次真实重构

`requireAuth` 原先定义在 `api/identity.js` 内部。rooms 模块需要同一规则，若复制一份就会产生两套"谁在调用"的判断并逐渐分叉。已提取到 `src/auth/request.js`：

- `makeAuthenticator({ config, db })` — 签发校验 + 用户状态 + 设备吊销检查
- `makeRequireAuth(...)` — 产出 Fastify `preHandler`
- `server.js` 构造**一个**实例，放进 `server.decorate('hub', {...})`，各路由模块从 `fastify.hub.requireAuth` 读取

`src/api/index.js` 从"插件数组"改为 `buildRoutePlugins({ requireAuth })` 工厂，使依赖注入显式化。重构后 H-01/H-02/H-03 全部回归通过（71/71，随后 95/95）。

## 关键安全决策与依据

### 1. 非成员访问返回 404，不返回 403
群 id 不是秘密——它出现在 URL、日志、客户端状态里。若对"存在但无权"返回 403、对"不存在"返回 404，攻击者就能用状态码枚举有效群 id。因此两者返回**完全相同的 code 与 message**，测试用 `deepEqual` 固定该性质：

```
real = GET /rooms/<真实群id>  (非成员)  → 404 {"code":"NO_SUCH_ROOM","message":"No such room, or you are not a member"}
fake = GET /rooms/00000000-…-000000000000 → 404 同上（逐字节相同）
```

同理，邀请 id 被非收件人使用时返回 `NO_SUCH_INVITATION`，不泄漏该邀请存在。

### 2. 成员资格每次请求都查库，绝不由客户端声明推断
`requireMember()` 是每个群级路由的第一步，且移除用时间戳而非删除行——`membershipOf()` 把 `removed_at` 非空的行视为**非成员**，调用方无须记住第二个条件。这直接支撑了"移除后老 token 不能恢复访问"。

### 3. 邀请是给具名用户的**要约**，不是指派
`acceptInvitation` 检查 `invitation.target_user_id === userId`，不匹配即返回"无此邀请"。测试里的攻击场景是：陌生人 C 拿到邀请 id 后尝试接受 → 404，且 B 的要约仍然有效。

### 4. 角色边界
- `owner` **不在** `INVITABLE_ROLES` 内 → 邀请无法分发所有权（`role: 'owner'` → 400 `INVALID_ROLE`）。
- owner 不可被移除（`CANNOT_REMOVE_OWNER`，409）——无 owner 的群无人可管理。
- owner 不可离开（`OWNER_CANNOT_LEAVE`，409）。V1 无所有权转移，这是刻意保留的限制，已记录。
- 不可通过 `remove` 移除自己（`CANNOT_REMOVE_SELF`，403）——离开是另一个意图，走 `leave`。

### 5. 移除会撤销在途邀请
`removeMember` 在同一事务里把该用户对该群的 pending 邀请置为 `revoked`。否则"移除"可被一个已在途的邀请撤销掉，使删除形同虚设。测试覆盖了这条（`removal revokes an in-flight invitation`）。

### 6. 重新加入按邀请给定的角色，不恢复旧角色
成员行有唯一约束，`INSERT … ON CONFLICT DO UPDATE` 会重置 `role` 与 `removed_at`。因此一个曾被提为 admin 的成员被移除后重新加入时是 `member`——旧的提权不会因为一次移除+重邀而悄悄回来。测试固定了这一点。

### 7. 重复邀请不累积
对同一群同一用户的 pending 邀请若已存在，直接返回该邀请而不是新建。否则反复点击"邀请"会堆出多个待处理要约，接受其中一个后其余仍可被接受。

### 8. 每种变更都留审计
`room.created` / `invitation.created` / `invitation.accepted` / `invitation.declined` / `invitation.revoked` / `room.member_removed` / `room.left` / `room.role_changed` / `room.renamed` 均在自己的事务内写入 `audit_events`，`safe_details_json` 只含调用方选定的小字段（如 roomId、role、被移除者 id），**不含消息正文或令牌**。

## 真实执行证据

### 测试

```sh
$ node --test tests/h04-rooms.test.js
 ℹ tests 24
 ℹ pass 24
 ℹ fail 0

$ node --test tests/*.test.js          # 全量
 ℹ tests 95
 ℹ pass 95
 ℹ fail 0
```

24 项覆盖：创建即 owner、名称校验、群列表按成员过滤、非成员读/改被拒、**猜测 id 与不存在 id 响应相同**、全部群路由无 token 返回 401、邀请需接受、仅收件人可接受、重复接受 409、拒绝/过期不可用（410 且标记 expired）、邀请需 admin、不可邀 owner 角色、已是成员 409、重复邀请返回同一要约、未知/禁用用户被拒、撤回权限（仅邀请人或群管理员）、移除即刻失效、移除撤销在途邀请、owner 不可移除、不可自我移除、非成员移除 404、普通成员无权移除、离开、重新加入按新角色、改角色权限、owner 角色固定、**owner 不是可指派角色**、重命名需 admin、审计事件齐全且无敏感内容、登出后 refresh 失效。

### 真实双用户端到端（真实进程 + 真实 HTTP + 真实 SQLite）

```
[hub] applied 2 migration(s): 0001_schema.sql, 0002_identity.sql
Workgroup AI Hub is listening

1. 注册并登录 A、B
   A: 财务 A (deed9453…)  B: 财务 B (f2fdf288…)

2. A 创建工作群
   [201] room=财务协作群 myRole=owner

3. B 在收到邀请前访问群（应 404）
   [404] {"error":{"code":"NO_SUCH_ROOM","message":"No such room, or you are not a member"}}

4. A 邀请 B
   [201] status=pending role=member

5. B 查看自己的邀请
   [200] 财务协作群（来自 财务 A）

6. 陌生人 C 拿邀请 id 尝试接受（应 404）
   [404] {"error":{"code":"NO_SUCH_INVITATION","message":"No such invitation"}}

7. B 本人接受
   [200] 加入 财务协作群，角色 member

8. B 现在可以读群与成员
   [200] 成员: 财务 A(owner), 财务 B(member)

9. C 仍然读不到
   [404]

10. A 移除 B
    [200] removedAt=2026-10-14T17:24:20.031Z

11. B 立即失去访问
    读群: [404]  群列表数量: 0
```

中文群名与显示名正确往返（`财务协作群`、`财务 A(owner), 财务 B(member)`），未出现编码问题——本轮用 Node `fetch` 而非 MINGW `curl`。

## 未完成与风险

| 项 | 状态 |
|---|---|
| 干净 Linux 部署下的群功能实测 | 未做（本机 Windows），归 H-13 |
| 群与消息/任务/群记忆的实际联动 | 未做，分别是 H-05 / H-08 / H-10 |
| 所有权转移 | **未实现**。owner 既不能离开也不能被移除，V1 只能建新群或由管理员直接改库。这是已记录的功能缺口 |
| 群级速率限制 | 未实现（与 H-03 的登录限流欠账同源） |
| WSS 实时推送邀请/成员变更 | 未做，归 H-06 |
| 邀请的撤销通知到被邀请人 | 未做（无实时通道），客户端需轮询 `/invitations` |

## 下一步

H-05（消息写入、roomSeq、幂等去重、补拉），依赖 H-04。
