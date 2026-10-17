# Implementation Plan

**Feature:** Hub Workgroup Admin — Local Demo

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `server/` 内建立一个只面向本地/内网演示的工作群管理端：固定 admin 登录、工作群最小 CRUD、成员增删、消息正文只读、群名实时更新；同时把“缩小后的范围”写回实施书和关联文档。

**Architecture:** 新增独立 `operators` 表与 cookie 会话认证；新增 `/api/v1/admin/*` 只读/工作群 CRUD API 和 `/admin/` 静态页面；新增 `room.renamed` 实时事件并由应用端 reducer 消费。应用端继续只使用 `WORKGROUP_HUB_URL` 环境变量和现有匿名 bootstrap，不新增 Hub UI。

**Tech Stack:** Node.js 24、Fastify 5、SQLite/WAL、原生 HTML/CSS/JS、`node:test`、Vitest、现有 `@deepseek-ai/dsh-workgroup` 客户端。

## Global Constraints

- 只允许 `application/` 与 `server/` 两个代码/运行边界；不新增第三个项目。
- admin 只存在于独立 `operators` 表，不写入 `users` 表。
- 管理端只处理 `rooms.kind = 'workgroup'`；不读取、不修改普通 room 或 Bot 本地群。
- 不执行物理删除：用户禁用、工作群解散、成员 `removed_at`、消息保留。
- 应用内不出现 Hub 地址、登录、注册、管理入口；Hub 地址只从 `WORKGROUP_HUB_URL` 读取。
- 不把 access token、refresh token、password_hash 暴露给 renderer 或管理端响应。
- 不修改工作群消息、任务、审批、附件权限模型。
- 保持现有代码风格；不顺手重构无关模块。
- 当前工作区已有未提交文档/测试改动；执行时只触碰本 Plan 列出的文件，不回滚他人改动。

---

# 1. Goal

## 1.1 本次修改目标

1. 让 Hub 具备独立 admin 身份：`operators` 表、固定 `admin` 登录、cookie 会话。
2. 提供本地演示用 `/admin` 页面，只管理工作群：
   - 工作群列表/详情
   - 创建工作群
   - 群名修改并实时同步
   - 添加/移除成员
   - 解散工作群
   - 消息正文只读分页查看
3. 用户只读列表/搜索，用于选择 owner 和成员；不做用户 CRUD。
4. 增加 `room.renamed` 实时事件，应用端打开中的工作群无需重开即可更新群名。
5. 修改 `技术实施任务书.docx`、`TECHNICAL_BLUEPRINT.md`、`TASK_BOARD.md`、`ACCEPTANCE.md` 及关联 README/部署文档，把“本地演示范围”写成正式范围。

## 1.2 本次不包含

- 用户创建/编辑/禁用/删除/密码重置。
- 设备管理、设备撤销、审计 UI、Dashboard。
- 成员角色修改、owner 转移。
- 消息发送、编辑、删除、搜索、附件下载。
- 多管理员、管理员角色分级、管理员账号 CRUD。
- 应用端登录/注册。
- 普通 room、Bot 本地群、私人 Session、Bot 记忆管理。
- 物理删除任何业务数据。

## 1.3 成功标准

- admin 可用 `admin / abcd1234567890` 登录 `/admin`；错误密码被拒绝。
- admin 不在 `users` 表；guest Bearer 不能访问 admin API。
- `/admin` 可完成工作群创建、改名、解散、成员增删；所有查询只出现 workgroup。
- 管理端消息页能分页看到 `messages.body`，正文按纯文本显示。
- 管理端改名后，已打开该工作群的应用端实时更新群名。
- 普通 room 和 Bot 本地群不出现在管理端。
- 实施书、蓝图、任务板、验收、README、部署文档与上述范围一致。

---

# 2. Current Understanding

## 2.1 当前实现方式

**应用端入口与快速认证：**

- 三个入口调用同一个 `workgroups.create`：
  - `src/client/new-chat.js:106-107`
  - `src/client/settings.js:134-136`
  - `src/client/palette.js:87`
- `src/client/index.js:762-776` 调用 `workgroupHub.createRoom`。
- `src/client/index.js:740-743` 启动 `createHubBridge`；`src/client/workgroup-hub.js:66-69` 立即发 `hub-view`。
- Host `src/host/workgroup-hub.js:152-182` 在无会话时调用 `bootstrap()`。
- 服务端 `server/src/api/identity.js:147-201` 提供匿名 bootstrap。
- 应用内没有 Hub 登录/注册/配置 UI；`settings.js` 的 `SETTINGS_PAGES` 无 Hub 页。

**Hub 数据：**

- `users`、`devices`、`rooms`、`room_members`、`messages`、`tasks`、`audit_events` 等表已存在。
- `rooms.kind` 取 `ordinary | workgroup`：`server/src/modules/rooms/store.js:42-43`。
- `messages.body` 最大 50,000 字符：`server/src/modules/messages/store.js:31-42`。
- `rooms` 解散使用 `dissolved_at` 软状态：`server/db/migrations/0011_room_dissolution.sql`。
- 成员移除使用 `room_members.removed_at`。
- 实时事件类型在 `server/src/realtime/events.js`；当前没有 `room.renamed`。
- 应用端 `reduceWorkgroup` 对未知事件返回原状态：`application/integrations/workgroup/client/index.mjs:287-337`。

**Hub 管理端现状：**

- `server/package.json` 只有 Fastify/WebSocket，没有静态页面。
- `server/src/server.js` 只注册 JSON API、health、WebSocket；404 返回 JSON。
- 没有 `operators` 表、没有 admin 路由、没有 admin 页面。
- `server/src/api/audit.js:5-15` 明确说明当前没有 operator role。
- `setUserStatus` 只有 store 函数，没有 HTTP 路由。
- `TECH_DESIGN_GAP_FILL.md:220` 记录“管理端不存在”。

## 2.2 涉及模块

- 应用端：`application/packages/bundle/ds-bot/src/client/index.js`、`workgroup-hub.js`、`workgroup-entry.js`；`application/integrations/workgroup/client/index.mjs`。
- 服务端：`server/src/server.js`、`server/src/api/*`、`server/src/modules/rooms/store.js`、`server/src/realtime/*`、`server/db/migrations/*`。
- 文档：`技术实施任务书.docx`、`TECHNICAL_BLUEPRINT.md`、`TASK_BOARD.md`、`ACCEPTANCE.md`、`README.md`、`REQUIREMENTS_GAP_FILL.md`、`TECH_DESIGN_GAP_FILL.md`、`application/docs/workgroup-ai/APPLICATION_README.md`、`server/deploy/DEPLOYMENT.md`。

## 2.3 数据流 / 调用链

### 应用端快速认证

```text
DS Bot client plugin apply
  -> createHubBridge.start()
  -> POST /api/bot { endpoint: 'hub-view' }
  -> Host ensureGuestSession()
  -> POST /api/v1/auth/bootstrap
  -> operators? 否；创建 users(guest-*) + devices + refresh_tokens + audit
  -> Host 保存 hub-session.json
```

### 管理端工作群

```text
GET /admin/
  -> login POST /api/v1/admin/login
  -> operators 表校验 + 内存 session + HttpOnly cookie
  -> GET /api/v1/admin/workgroups
  -> admin store 查询 rooms WHERE kind='workgroup'
  -> 创建/改名/解散/成员增删
  -> 写 audit_events (actor_operator_id)
  -> 通过 realtime 推送 member.changed / room.dissolved / room.renamed
```

### 消息正文

```text
GET /api/v1/admin/workgroups/:id/messages
  -> operator 权限
  -> 校验 room.kind='workgroup'
  -> SELECT messages JOIN users
  -> 返回 body / sender / createdAt / roomSeq
  -> 写 admin.workgroup_messages_viewed 审计
  -> Web 用 textContent 渲染
```

## 2.4 已确认的影响范围

- admin 身份只新增 `operators` 表；不改变 guest 用户认证。
- 工作群 API 复用现有 room store，但需要 operator 覆盖路径。
- 消息读取新增 admin 专用查询，不复用要求成员身份的 `readMessages`。
- 群名实时更新需要新增 `room.renamed` 事件、契约枚举、应用端 reducer。
- 普通 room 和本地群完全不进入管理端。
- 无物理删除。

## 2.5 文档与现状不一致

- `README.md:30` 仍写“员工在客户端配置 Hub 地址并完成认证”。
- `REQUIREMENTS_GAP_FILL.md:93` 仍写“客户端填 Hub 地址 → 注册（提交 key）”。
- `application/docs/workgroup-ai/APPLICATION_README.md:17` 仍写“未配置 Hub 时工作群提示配置”。
- `TECH_DESIGN_GAP_FILL.md:220` 仍写“管理端不存在，不需要”。
- 实施书任务表没有 admin 任务；验收 A-E 没有管理端章节。

---

# 3. Implementation Steps

## Step 0: DOC-01 — 收缩范围并同步实施书/文档

#### Target

- Modify: `技术实施任务书.docx`
- Modify: `TECHNICAL_BLUEPRINT.md`
- Modify: `TASK_BOARD.md`
- Modify: `ACCEPTANCE.md`
- Modify: `README.md`
- Modify: `REQUIREMENTS_GAP_FILL.md`
- Modify: `TECH_DESIGN_GAP_FILL.md`
- Modify: `application/docs/workgroup-ai/APPLICATION_README.md`
- Modify: `server/deploy/DEPLOYMENT.md`
- Add: `server/docs/HUB_ADMIN_WEB.md`

#### Current Behavior

实施书仍描述完整产品范围，没有 Hub 管理端任务；README/需求文档仍要求客户端配置 Hub 地址；`TECH_DESIGN_GAP_FILL.md` 声明管理端不存在且不需要。

#### Change

1. `技术实施任务书.docx`：
   - 在 `1.2 功能与非目标` 增加“本地演示附加：Hub 工作群管理端（只管理工作群；用户只读；不做用户 CRUD/设备管理/审计 UI/消息搜索）”。
   - 新增 `13. 本地演示 Hub 管理端（范围收缩）`，包含：
     - 目标与边界
     - `operators` 表与固定 admin
     - API 清单
     - `/admin` 页面清单
     - 明确不做项
     - 验收条件
   - 修改 `8. 数据实体与迁移`：增加 `operators`；admin 不属于 `users`。
   - 修改 `9.1 生产部署只使用 server/`：说明 `/admin` 静态页面、默认 admin 仅限本地/内网。
   - 修改 `11. 主要风险与决策点`：固定 admin 密码、消息正文查看、生产改数据库密码。
   - 修改 `12. 开发顺序与交接方式`：管理端排在 Hub 基础之后，不阻塞 G0-G5。
   - 在任务表新增 `ADM-01`、`ADM-02`、`ADM-03`、`ADM-04`、`DOC-01` 五行。
   - 在验收方案新增 `F. Hub 管理端（本地演示）`。
2. `TECHNICAL_BLUEPRINT.md` 同步上述章节与范围。
3. `TASK_BOARD.md` 新增：

   | ID | 端 | 任务 | 前置 | 完成条件 |
   |---|---|---|---|---|
   | DOC-01 | 文档 | 收缩范围并同步实施书/验收/README | — | 文档不再宣称完整后台 |
   | ADM-01 | server | operators 表 + 固定 admin 登录/会话 | H-13 | admin 独立表；可登录/登出 |
   | ADM-02 | server | 管理端工作群 API（仅 workgroup） | ADM-01/H-04 | CRUD/成员增删/消息只读 |
   | ADM-03 | server | `/admin` Web UI | ADM-02 | 登录、列表/详情、消息正文 |
   | ADM-04 | server+application | `room.renamed` 实时事件 | ADM-02/A-05 | 改名后应用端实时更新 |

4. `ACCEPTANCE.md` 新增 `F. Hub 管理端（本地演示）`：
   - admin 在 `operators` 表，不在 `users` 表。
   - 固定 admin 可登录 `/admin`，错误密码拒绝。
   - 工作群列表只显示 `kind='workgroup'`。
   - 可创建工作群、改名、解散、添加/移除成员。
   - 消息正文只读分页可见，按纯文本渲染。
   - 改名后应用端实时更新。
   - 用户只读；无用户 CRUD。
   - 普通 room、本地群不可见。
   - 无物理删除。
5. `README.md:30` 改为：
   - 管理员通过安装包/启动环境注入 `WORKGROUP_HUB_URL`。
   - 应用首次进入 Bot 自动匿名认证；应用内不提供 Hub 地址/登录/注册配置。
6. `REQUIREMENTS_GAP_FILL.md:93` 改为：
   - 新同事由管理员预置 Hub 地址；首次进入 Bot 自动快速认证；不再填写地址或提交 key。
7. `application/docs/workgroup-ai/APPLICATION_README.md:17` 改为：
   - Hub 地址由环境变量提供；应用内无配置页；首次进入 Bot 自动认证。
8. `TECH_DESIGN_GAP_FILL.md:220` 改为：
   - “管理端：本地演示管理端，仅工作群；用户只读。”
9. `server/deploy/DEPLOYMENT.md`：
   - 增加 `/admin` 访问路径。
   - 说明默认 admin 仅限本地/内网。
   - 说明生产通过数据库修改 `operators.password_hash/status`。
   - 说明不把 `/admin` 暴露到公网。
10. 新增 `server/docs/HUB_ADMIN_WEB.md`：记录当前管理端范围、账号、API、页面、验收。

#### Reason

先把收缩后的范围写进实施书和验收，避免后续 Coding 继续按“完整管理后台”扩散；同时修正 README/需求文档与当前“环境变量 + 自动认证”实现的矛盾。

#### Risk

- `.docx` 是二进制文档，修改时可能破坏样式；使用 `python-docx` 只追加段落/表格行，保留现有样式。
- 当前工作区已有未提交文档改动；只修改本 Plan 列出的文件，不回滚已有改动。
- 文档改动量大，容易与 Markdown/实施书不同步；完成后用标题/关键词提取核对。

#### Verification

```bash
cd Workgroup-AI
git diff --check
```

人工核对：
- `技术实施任务书.docx` 中存在 `13. 本地演示 Hub 管理端（范围收缩）`。
- 任务表存在 `ADM-01..04`、`DOC-01`。
- 验收存在 `F. Hub 管理端（本地演示）`。
- 所有文档不再宣称“客户端配置 Hub 地址”或“管理端不存在”。

---

## Step 1: ADM-01 — operators 表、迁移与备份计数

#### Target

- Add: `server/db/migrations/0013_operators.sql`
- Modify: `server/src/db/backup.js`
- Test: `server/tests/adm-auth.test.js`（迁移断言部分）

#### Current Behavior

没有 `operators` 表；admin 只能存在于 `users` 或代码中。`audit_events` 不能区分 operator 与普通用户。

#### Change

新增迁移：

```sql
-- Hub operator identities are separate from application users.
-- The fixed admin row is a local-demo bootstrap; production changes it in the database.
CREATE TABLE IF NOT EXISTS operators (
  id TEXT PRIMARY KEY,
  user_handle TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE audit_events ADD COLUMN actor_operator_id TEXT REFERENCES operators(id);
CREATE INDEX IF NOT EXISTS idx_audit_operator ON audit_events (actor_operator_id, occurred_at);

INSERT OR IGNORE INTO operators
  (id, user_handle, display_name, password_hash, status, created_at, updated_at)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  'admin',
  'Administrator',
  'scrypt$16384$8$1$yCWEJIv9pao80WyQcGRJsA==$thYmkdr7S13vfcs3eHQhlF4tRXMouGvP6hEAs8865FByCK6Oji91EvdLcuuvb6IdaGw03WPGu5ShTQfcyZT+Yg==',
  'active',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
);
```

`server/src/db/backup.js` 的 `entityCounts` 表数组加入 `'operators'`，位置放在 `users` 之前或之后均可，但必须与迁移后的实际表一致。

#### Reason

admin 必须独立于用户表；审计需要能标识 operator；备份恢复必须统计新表。

#### Risk

- `ALTER TABLE` 只能执行一次；迁移 runner 已保证一次性。
- 已存在数据库升级时，`operators` 插入使用 `INSERT OR IGNORE`，不会覆盖生产环境已修改的密码。
- `password_hash` 是 scrypt 格式；不要换成明文。

#### Verification

```bash
cd Workgroup-AI/server
node --test tests/adm-auth.test.js
```

测试断言：
- 迁移后 `operators` 表存在。
- `admin` 行的 `user_handle='admin'`、`status='active'`。
- `audit_events` 有 `actor_operator_id` 列。
- `verifyPassword('abcd1234567890', admin.password_hash) === true`。
- `entityCounts(db).operators === 1`。

---

## Step 2: ADM-01 — admin 认证模块、登录/登出路由

#### Target

- Add: `server/src/admin/auth.js`
- Add: `server/src/api/admin.js`（登录/会话部分）
- Modify: `server/src/api/index.js`
- Modify: `server/src/server.js`
- Test: `server/tests/adm-auth.test.js`

#### Current Behavior

没有 admin 登录；Fastify 只注册用户 Bearer 认证；没有 cookie 会话。

#### Change

新增 `createAdminAuth({ db, secureCookies })`：

- 常量：
  ```js
  const ADMIN_COOKIE = 'hub_admin_session'
  const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000
  ```
- `login({ userHandle, password })`：
  - 查询 `operators WHERE user_handle = ?`。
  - `status !== 'active'` 拒绝。
  - `verifyPassword(password, operator.password_hash)` 失败拒绝。
  - 生成 `randomBytes(32).toString('base64url')` session id。
  - `sessions.set(sessionId, { operatorId, expiresAt: Date.now() + TTL })`。
  - 更新 `last_login_at`。
  - 写 `admin.login` 审计（`actor_operator_id`）。
- `logout(sessionId)`：删除 session，写 `admin.logout` 审计。
- `session(sessionId)`：过期删除；重新读取 operator；`status !== 'active'` 删除并返回 `undefined`。
- `cookie(sessionId)`：
  ```text
  hub_admin_session=<id>; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800[; Secure]
  ```
- `clearCookie()`：`Max-Age=0`。
- `makeRequireOperator({ adminAuth })`：
  - 从 `request.headers.cookie` 解析 `hub_admin_session`。
  - `adminAuth.session()` 失败返回 `401 { error: { code: 'ADMIN_UNAUTHORIZED' } }`。
  - 成功把 `request.operator`、`request.adminSessionId` 挂上。
- 同源校验：`POST/PATCH/DELETE` 若带 `Origin`，必须等于 `request.protocol + '://' + request.host`；否则 403。

`server/src/server.js`：

- 创建 `adminAuth = createAdminAuth({ db, secureCookies: String(config.publicUrl ?? '').startsWith('https:') })`。
- 创建 `adminLoginLimiter = new PersistentLimiter({ db, maxAttempts: config.security.loginMaxAttempts, windowSeconds: config.security.loginWindowSeconds, lockoutSeconds: config.security.loginLockoutSeconds })`。
- `server.decorate('hub', { ..., adminAuth, adminLoginLimiter })`。
- `server.decorateRequest('operator', null)`。
- `buildRoutePlugins({ requireAuth, adminAuth, requireOperator })` 传入 admin 依赖。

`server/src/api/admin.js` 登录部分：

```js
export function makeAdminRoutes({ adminAuth, requireOperator }) {
  return async function adminRoutes(fastify) {
    fastify.post('/api/v1/admin/login', async (request, reply) => {
      const key = `admin-login:${request.ip}`
      const verdict = fastify.hub.adminLoginLimiter.check(key)
      if (!verdict.allowed) {
        reply.header('retry-after', String(verdict.retryAfterSeconds))
        return reply.code(429).send({ error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many admin login attempts' } })
      }
      const result = await adminAuth.login(request.body ?? {})
      if (result === undefined) {
        fastify.hub.adminLoginLimiter.recordFailure(key)
        return reply.code(401).send({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid administrator credentials' } })
      }
      fastify.hub.adminLoginLimiter.clear(key)
      reply.header('set-cookie', adminAuth.cookie(result.sessionId))
      return reply.code(200).send({ operator: result.operator })
    })

    fastify.get('/api/v1/admin/session', { preHandler: requireOperator }, async (request) => ({ operator: request.operator }))

    fastify.post('/api/v1/admin/logout', { preHandler: requireOperator }, async (request, reply) => {
      adminAuth.logout(request.adminSessionId)
      reply.header('set-cookie', adminAuth.clearCookie())
      return reply.code(200).send({ ok: true })
    })
  }
}
```

#### Reason

管理端不能复用 guest Bearer；独立 cookie session 可以在不引入完整用户登录体系的情况下完成本地演示认证。

#### Risk

- 固定密码很弱；只允许本地/内网。生产必须改数据库。
- 内存 session 在服务重启后失效，符合演示预期。
- `Secure` cookie 取决于 `HUB_PUBLIC_URL` 是否 https；本地 HTTP 不加 Secure。
- 登录限流按 IP；反代部署需正确配置 `trustProxy`。

#### Verification

```bash
cd Workgroup-AI/server
node --test tests/adm-auth.test.js
```

测试断言：
- `admin / abcd1234567890` 登录成功，返回 200 + Set-Cookie。
- 错误密码 401；连续失败触发 429。
- 无 cookie `GET /api/v1/admin/session` 返回 401。
- admin cookie 登出后 session 失效。
- guest Bearer 访问 admin API 返回 401/403。
- 响应不含 `password_hash`。

---

## Step 3: ADM-02 — admin 只读用户与工作群 API

#### Target

- Add: `server/src/admin/store.js`
- Modify: `server/src/api/admin.js`（读接口）
- Modify: `server/src/api/index.js`
- Test: `server/tests/adm-workgroups.test.js`

#### Current Behavior

`GET /api/v1/rooms` 只返回调用者自己的房间；没有全局用户/工作群查询；没有 operator 权限。

#### Change

`server/src/admin/store.js` 增加：

```js
export class AdminError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'AdminError'
    this.code = code
  }
}

export function listUsers(db, { query, limit = 50 } = {}) { ... }
export function findAdminUser(db, userId) { ... }
export function listWorkgroups(db, { query, status, limit = 50 } = {}) { ... }
export function findAdminWorkgroup(db, workgroupId) { ... }
export function listMessages(db, { workgroupId, beforeSeq, limit = 50 } = {}) { ... }
```

`listWorkgroups` SQL：

```sql
SELECT r.id, r.name, r.kind, r.created_at, r.dissolved_at,
       u.user_handle AS owner_handle, u.display_name AS owner_display_name,
       (SELECT count(*) FROM room_members m WHERE m.room_id = r.id AND m.removed_at IS NULL) AS member_count,
       (SELECT count(*) FROM messages msg WHERE msg.room_id = r.id) AS message_count,
       (SELECT max(msg.created_at) FROM messages msg WHERE msg.room_id = r.id) AS last_message_at
FROM rooms r
JOIN users u ON u.id = r.owner_user_id
WHERE r.kind = 'workgroup'
  AND (? = '' OR r.name LIKE '%' || ? || '%')
  AND (? = 'all' OR (? = 'live' AND r.dissolved_at IS NULL) OR (? = 'dissolved' AND r.dissolved_at IS NOT NULL))
ORDER BY r.created_at DESC
LIMIT ?
```

`listMessages` SQL：

```sql
SELECT m.id, m.room_id, m.room_seq, m.sender_user_id,
       u.user_handle AS sender_handle, u.display_name AS sender_display_name,
       m.body, m.reply_to_message_id, m.created_at
FROM messages m
JOIN users u ON u.id = m.sender_user_id
WHERE m.room_id = ?
  AND (? IS NULL OR m.room_seq < ?)
ORDER BY m.room_seq DESC
LIMIT ?
```

`findAdminWorkgroup` 先查 `rooms`，若 `kind !== 'workgroup'` 抛 `AdminError('No such workgroup','NO_SUCH_WORKGROUP')`；再查活跃成员。

`server/src/api/admin.js` 增加：

```text
GET /api/v1/admin/users?query=&limit=
GET /api/v1/admin/workgroups?query=&status=live|dissolved|all&limit=
GET /api/v1/admin/workgroups/:id
```

全部使用 `{ preHandler: requireOperator }`。

#### Reason

管理端需要全局视图；现有用户作用域接口不能复用。用户只读用于选择 owner/成员。

#### Risk

- `LIKE '%' || ? || '%'` 参数绑定，禁止字符串拼接。
- 普通 room 必须通过 `kind` 过滤；详情接口也要检查。
- 用户列表包含 guest；这是预期，因为快速认证自动创建 guest。
- 不返回 password_hash、token、设备公钥。

#### Verification

```bash
cd Workgroup-AI/server
node --test tests/adm-workgroups.test.js
```

测试断言：
- admin 能列出 users，但响应无 `password_hash`。
- `GET /workgroups` 只返回 `kind='workgroup'`。
- 插入一个 `ordinary` room 后，它不出现在列表，详情返回 404。
- 搜索/状态过滤/limit 有效。

---

## Step 4: ADM-02 — 工作群创建、改名、解散、成员增删

#### Target

- Modify: `server/src/modules/rooms/store.js`
- Modify: `server/src/admin/store.js`
- Modify: `server/src/api/admin.js`
- Modify: `server/src/api/rooms.js`
- Test: `server/tests/adm-workgroups.test.js`

#### Current Behavior

- `createRoom` 把 `ownerUserId` 记为审计 actor。
- `renameRoom` 需要路由先做房间管理员检查。
- `removeMember` 拒绝 `userId === actorUserId`，并由路由检查房间管理员。
- `dissolveRoom` 只允许 owner。
- 没有管理员直接添加成员的 store 函数。

#### Change

1. `rooms/store.js` 的 `audit()` 增加 `actorOperatorId`，插入 `audit_events.actor_operator_id`。
2. `createRoom` 增加可选 `actorOperatorId`；有 operator 时 `actor_user_id=null`，否则保持 owner。
3. `renameRoom` 增加可选 `actorOperatorId`，审计写 operator。
4. `removeMember` 增加可选 `actorOperatorId`；有 operator 时跳过 `userId === actorUserId` 检查，审计写 operator；owner 仍不可移除。
5. `dissolveRoom` 增加可选 `actorOperatorId`：
   - operator 路径跳过“必须是 owner”检查，但仍检查 room 存在、未解散；
   - `dissolved_by = null`，审计写 operator；
   - 保留取消未完成任务、撤回邀请的现有事务逻辑。
6. `admin/store.js` 增加：
   - `createWorkgroup(db, { name, ownerUserId, operatorId })`：校验 owner active，调用 `createRoom`，`kind:'workgroup'`，`ownerDeviceId:null`，`actorOperatorId:operatorId`。
   - `renameWorkgroup(db, { workgroupId, name, operatorId })`：校验 workgroup，调用 `renameRoom`，`actorUserId:null`，`actorOperatorId`。
   - `dissolveWorkgroup(db, { workgroupId, operatorId })`：调用 `dissolveRoom`，`actorUserId:null`，`actorOperatorId`。
   - `addMember(db, { workgroupId, userId, operatorId })`：事务插入 `room_members`，角色固定 `member`，写 `room.member_added` 审计；拒绝非 active、已存在成员、已解散群。
   - `removeMemberAsOperator(db, { workgroupId, userId, operatorId })`：调用 `removeMember`，`actorUserId:null`，`actorOperatorId`。
7. `api/admin.js` 增加：

```text
POST   /api/v1/admin/workgroups
PATCH  /api/v1/admin/workgroups/:id
DELETE /api/v1/admin/workgroups/:id
POST   /api/v1/admin/workgroups/:id/members
DELETE /api/v1/admin/workgroups/:id/members/:userId
```

8. 路由在成功后发布：
   - 改名：`makeEvent('room.renamed', { roomId, name }, { roomId })`
   - 解散：`makeEvent('room.dissolved', { roomId, dissolvedBy: null }, { roomId })`
   - 成员增删：`makeEvent('member.changed', { roomId, reason: 'added'|'removed' }, { roomId })`
9. `api/rooms.js` 的现有 `PATCH /rooms/:id` 改名后也发布 `room.renamed`，保证普通路径一致。

#### Reason

管理端需要工作群 CRUD，但不能把 operator 伪装成 owner；审计必须能区分 operator。软删除/解散复用现有事务。

#### Risk

- `dissolveRoom` 的 operator 分支必须保留原有的任务取消/邀请撤回；不能复制一份简化逻辑。
- `dissolved_by=null` 是刻意选择：operator 不是 `users` 行；操作者在审计中。
- 添加成员绕过邀请流程；这是 operator 明确操作，必须写审计。
- 现有普通用户路径必须保持不变；所有 `operatorId` 参数必须可选。

#### Verification

```bash
cd Workgroup-AI/server
node --test tests/adm-workgroups.test.js tests/h04-rooms.test.js tests/d-dissolve.test.js
```

测试断言：
- admin 创建工作群，`kind='workgroup'`，owner 正确。
- admin 改名，`room.renamed` 审计有 `actor_operator_id`，并发布事件。
- admin 解散，room `dissolved_at` 非空，消息保留，普通用户解散路径仍只允许 owner。
- admin 添加/移除成员，`removed_at` 非空，事件发布。
- admin 不能通过 API 创建 ordinary room。
- 普通 room 不能通过这些接口读写。

---

## Step 5: ADM-02 — 管理端消息正文只读

#### Target

- Modify: `server/src/admin/store.js`
- Modify: `server/src/api/admin.js`
- Modify: `server/src/admin/web.js`（后续页面消费）
- Test: `server/tests/adm-messages.test.js`

#### Current Behavior

`GET /api/v1/rooms/:roomId/messages` 要求房间成员身份；没有全局消息读取；`publicMessage` 已包含 body，但管理端不能复用该路由。

#### Change

`admin/store.js` 的 `listMessages` 返回：

```js
{
  messages: [{
    id, roomSeq, senderUserId, senderHandle, senderDisplayName,
    body, replyToMessageId, createdAt
  }],
  nextBeforeSeq,
  hasMore
}
```

`api/admin.js` 增加：

```text
GET /api/v1/admin/workgroups/:id/messages?beforeSeq=&limit=50
```

- `limit` clamp 1..100。
- 先 `findAdminWorkgroup` 校验 workgroup。
- 写审计：
  ```js
  writeOperatorAudit(db, {
    operatorId: request.operator.id,
    eventType: 'admin.workgroup_messages_viewed',
    objectType: 'room',
    objectId: roomId,
    details: { beforeSeq: beforeSeq ?? null, count: messages.length },
  })
  ```
- 不返回 token、password_hash、附件字节。
- 不做消息编辑/删除/发送。

#### Reason

管理员需要查看消息正文；现有成员路由不能给 operator 使用，又不能放宽普通用户权限，因此新增独立查询。

#### Risk

- 消息正文可能含敏感信息；固定 admin 密码使 `/admin` 必须限制在本地/内网。
- 审计只记录查看范围和条数，不记录正文。
- 长正文 50k 字符；前端需要折叠/滚动，不能一次性撑爆页面。

#### Verification

```bash
cd Workgroup-AI/server
node --test tests/adm-messages.test.js
```

测试断言：
- admin 可读取 workgroup 消息，`body` 原样返回。
- 普通 room 的消息接口 404。
- `beforeSeq` 分页正确，`hasMore` 正确。
- 每次读取写 `admin.workgroup_messages_viewed`，详情不含正文。
- 非 operator 401/403。

---

## Step 6: ADM-03 — `/admin` 静态 Web UI

#### Target

- Add: `server/web/admin/index.html`
- Add: `server/web/admin/app.js`
- Add: `server/web/admin/style.css`
- Add: `server/src/admin/web.js`
- Modify: `server/src/server.js`

#### Current Behavior

`server/` 只返回 JSON；没有 `/admin` 页面；`setNotFoundHandler` 对未知路径返回 JSON 404。

#### Change

`server/src/admin/web.js`：

- 常量 `ADMIN_WEB_ROOT = fileURLToPath(new URL('../../web/admin/', import.meta.url))`。
- 注册：
  ```text
  GET /admin        -> 302 /admin/
  GET /admin/       -> index.html
  GET /admin/app.js -> app.js
  GET /admin/style.css -> style.css
  ```
- 只服务上述三个文件，不使用通配路径，避免目录穿越。
- 响应头：
  - `content-type` 按文件
  - `cache-control: no-store`（HTML）
  - `x-content-type-options: nosniff`
  - `x-frame-options: DENY`
  - `referrer-policy: no-referrer`
  - `content-security-policy: default-src 'self'; script-src 'self'; style-src 'self'`

`index.html`：

- 登录面板：`#login-form`、`#admin-handle`、`#admin-password`、`#login-error`。
- 应用面板：`#app`、`#workgroup-list`、`#workgroup-detail`。
- 外部引用 `app.js`、`style.css`，无内联脚本/样式。

`app.js`：

- `api(path, options)` 使用 `fetch('/api/v1/admin' + path, { credentials: 'same-origin' })`。
- 401 时显示登录面板。
- hash 路由：`#/workgroups`、`#/workgroups/:id`。
- 工作群列表：名称、owner、成员数、状态、最后消息时间。
- 创建工作群表单：名称 + owner select（`GET /users?query=`）。
- 详情页：
  - 改名输入 + 保存
  - 成员列表 + 移除按钮
  - 添加成员 select + 按钮
  - 消息列表 + “加载更早”
  - 解散按钮 + 二次确认
- 消息正文用 `textContent` 写入 `<pre>`；禁止 `innerHTML` 拼接 body。
- 长正文用 CSS `white-space: pre-wrap; max-height; overflow:auto`。
- 无用户 CRUD、无审计页、无普通 room。

`server/src/server.js`：

- `import { registerAdminWeb } from './admin/web.js'`
- 在注册 API 后调用 `registerAdminWeb(server)`。
- 静态页面注册必须在 `setNotFoundHandler` 之前或之后均可；Fastify 路由优先于 notFound。

#### Reason

本地演示需要一个无需构建链的独立页面；原生 HTML/JS 可以保持在 `server/` 内独立部署。

#### Risk

- XSS：任何用户数据都必须 `textContent`/`createElement`；禁止用 `innerHTML` 渲染消息、群名、成员名。
- 静态路径只允许三个文件，避免目录穿越。
- 固定 admin 密码 + 消息正文是高敏感组合；必须在文档中标注仅本地/内网。

#### Verification

```bash
cd Workgroup-AI/server
node --test tests/adm-auth.test.js
```

手工：
- 打开 `/admin/`，登录成功。
- 创建工作群、改名、加成员、移除成员、解散。
- 打开消息页，确认正文按纯文本显示，HTML 标签不执行。
- 普通 room 不出现在列表。

---

## Step 7: ADM-04 — `room.renamed` 实时事件与应用端更新

#### Target

- Modify: `server/src/realtime/events.js`
- Modify: `server/contracts/events.schema.json`
- Modify: `server/src/api/rooms.js`
- Modify: `server/src/api/admin.js`
- Modify: `application/integrations/workgroup/client/index.mjs`
- Modify: `application/integrations/workgroup/tests/a05-workgroup.spec.ts`
- Modify: `application/packages/bundle/ds-bot/client.js`（构建产物）

#### Current Behavior

`EVENT_TYPES` 没有 `room.renamed`；`PATCH /rooms/:id` 只更新数据库；应用端 `reduceWorkgroup` 对未知事件返回原状态，因此改名不会实时显示。

#### Change

1. `server/src/realtime/events.js` 的 `EVENT_TYPES` 增加 `'room.renamed'`。
2. `server/contracts/events.schema.json` 的 enum 增加 `"room.renamed"`。
3. `server/src/api/rooms.js` 的 `PATCH /rooms/:id` 成功后：
   ```js
   fastify.hub.realtime.publishToRoom(request.params.roomId,
     makeEvent('room.renamed', { roomId: request.params.roomId, name: room.name }, { roomId: request.params.roomId }))
   ```
4. `server/src/api/admin.js` 的 admin 改名成功后发布同一事件。
5. `application/integrations/workgroup/client/index.mjs` 的 `reduceWorkgroup` 增加：

```js
case 'room.renamed': {
  const payload = event.payload ?? {}
  if (payload.roomId !== undefined && payload.roomId !== state.room?.id) return state
  if (typeof payload.name !== 'string' || payload.name === state.room?.name) return state
  return { ...state, room: { ...state.room, name: payload.name } }
}
```

6. `a05-workgroup.spec.ts` 增加 reducer 测试：
   - 事件 `{ type:'room.renamed', roomId:'room-1', payload:{ roomId:'room-1', name:'New name' } }` 更新 `state.room.name`。
   - 不同 roomId 不更新。
   - 无 name 不更新。

#### Reason

群名修改需要实时反映到已打开的应用端；现有 unknown-event fallback 会静默忽略，必须显式处理。

#### Risk

- 这是新增协议事件；`EVENT_TYPES` 与 `events.schema.json` 必须同时更新，否则发布会抛错或契约不一致。
- 旧客户端会忽略未知事件，属于兼容行为；新客户端必须更新。
- 应用端 `client.js` 是构建产物，必须重建。

#### Verification

```bash
cd Workgroup-AI/server
node --test tests/adm-workgroups.test.js

cd Workgroup-AI/application
pnpm exec vitest run integrations/workgroup/tests/a05-workgroup.spec.ts

cd Workgroup-AI/application/packages/bundle/ds-bot
node scripts/build-client.mjs
node scripts/build-client.mjs --check
```

测试断言：
- 管理端改名发布 `room.renamed`。
- 应用端 reducer 更新 `state.room.name`。
- 其他事件/其他 room 不受影响。

---

## Step 8: 集成构建与最终验证

#### Target

- Modified files from Steps 0-7.
- No new feature scope.

#### Current Behavior

各模块单独完成后，需要验证 server 独立运行、admin 页面、应用端构建与事件契约一致。

#### Change

- 安装/启动 Hub：`cd server && npm start`（使用现有依赖，不新增依赖）。
- 运行 targeted tests。
- 重建 ds-bot client bundle。
- 手工走通 admin 主流程与应用端群名实时更新。
- 更新 `TASK_BOARD.md` 状态和证据（仅在验证通过后）。

#### Reason

确认收缩范围在真实进程/真实页面中可用，而不仅是单测。

#### Risk

- 真实浏览器/真实 Hub 证据未做前，不得把 ADM 标为 PASS。
- 当前工作区有既有未提交改动；提交时只 add 本 Plan 文件。

#### Verification

见第 5 节 Verification Checklist。

---

# 4. Changed Files Tracking

| File | Action | Change |
| ---- | ------ | ------ |
| `docs/plans/2026-10-17-hub-workgroup-admin-local-demo-implementation-plan.md` | Add | 本执行计划 |
| `技术实施任务书.docx` | Modify | 新增第 13 节、F 验收、ADM/DOC 任务行、数据/部署/风险/顺序说明 |
| `TECHNICAL_BLUEPRINT.md` | Modify | 同步本地管理端范围、数据实体、部署、风险、开发顺序 |
| `TASK_BOARD.md` | Modify | 新增 DOC-01/ADM-01..04 并记录当前证据状态 |
| `ACCEPTANCE.md` | Modify | 新增 F. Hub 管理端（本地演示）验收 |
| `README.md` | Modify | Hub 地址改为 `WORKGROUP_HUB_URL` + 自动认证 |
| `REQUIREMENTS_GAP_FILL.md` | Modify | 新同事接入改为管理员预置地址 + 自动快速认证 |
| `TECH_DESIGN_GAP_FILL.md` | Modify | 管理端从“不存在”改为本地演示范围 |
| `application/docs/workgroup-ai/APPLICATION_README.md` | Modify | 应用内无 Hub 配置 UI，首次进入自动认证 |
| `server/deploy/DEPLOYMENT.md` | Modify | 增加 `/admin`、默认 admin、生产改库与网络限制 |
| `server/docs/HUB_ADMIN_WEB.md` | Add | 管理端范围、账号、API、安全说明 |
| `server/db/migrations/0013_operators.sql` | Add | operators 表、audit actor_operator_id、固定 admin seed |
| `server/src/admin/auth.js` | Add | admin 登录/session/cookie/requireOperator |
| `server/src/admin/store.js` | Add | 用户/工作群/消息查询与 operator 变更 |
| `server/src/admin/web.js` | Add | `/admin` 静态文件路由与安全头 |
| `server/src/api/admin.js` | Add | admin 登录、工作群 CRUD、成员、消息 API |
| `server/src/server.js` | Modify | adminAuth、限流、admin 路由注册、静态页面注册 |
| `server/src/modules/rooms/store.js` | Modify | audit actor_operator_id、operator 覆盖路径、软解散 |
| `server/src/api/rooms.js` | Modify | 普通改名路径发布 `room.renamed` |
| `server/src/realtime/events.js` | Modify | 增加 `room.renamed` 事件类型 |
| `server/contracts/events.schema.json` | Modify | 增加 `room.renamed` enum |
| `server/contracts/openapi.yaml` | Modify | 增加 admin API 与 operatorCookie 契约 |
| `server/src/db/backup.js` | Modify | `entityCounts` 增加 `operators` |
| `server/web/admin/index.html` | Add | 管理端页面骨架 |
| `server/web/admin/app.js` | Add | 登录/列表/详情/成员/消息/CRUD |
| `server/web/admin/style.css` | Add | 管理端基础样式 |
| `server/tests/adm-auth.test.js` | Add | 迁移、admin 登录、限流、guest 拒绝、静态页 |
| `server/tests/adm-workgroups.test.js` | Add | 工作群 CRUD、范围过滤、成员、事件 |
| `server/tests/adm-messages.test.js` | Add | 消息正文、分页、审计、普通 room 拒绝 |
| `application/integrations/workgroup/client/index.mjs` | Modify | reducer 处理 `room.renamed` |
| `application/integrations/workgroup/tests/a05-workgroup.spec.ts` | Modify | 群名实时更新测试 |
| `application/packages/bundle/ds-bot/client.js` | Modify | 重新生成的客户端产物 |

### Plan Adjustment

- **原计划：** 通过 `server/src/api/index.js` 注册 admin 路由。
- **实际：** 保持 `server/src/api/index.js` 原样，在 `server/src/server.js` 中直接 `server.register(makeAdminRoutes(...))`。
- **原因：** 该文件使用 CRLF；若在其中追加路由，`git diff --check` 会把整文件行尾变化报为新增尾随空白。直接注册到已在 Plan 内的 `server.js` 行为相同，且避免无关行尾 churn。
- **新增范围：** 无；`server.js` 本身已在 Plan 内。

---

# 5. Verification Checklist

## 5.1 主流程验证

- [ ] `admin / abcd1234567890` 登录 `/admin/` 成功。
- [ ] 工作群列表只显示 `kind='workgroup'`。
- [ ] 创建工作群：名称 + owner 用户，创建后出现在列表。
- [ ] 工作群详情显示名称、owner、成员、消息数量。
- [ ] 改名后，应用端已打开的工作群实时更新名称。
- [ ] 添加成员、移除成员成功；成员列表更新。
- [ ] 解散工作群后状态变为 dissolved，消息仍保留。
- [ ] 消息页可分页查看正文。

## 5.2 关联流程验证

- [ ] 应用端 `WORKGROUP_HUB_URL` 环境变量生效；首次进入 Bot 自动 bootstrap。
- [ ] 应用端不出现 Hub 地址/登录/注册/管理 UI。
- [ ] Hub 不可达时，本地 Bot/普通群/私聊不受影响。
- [ ] 普通用户 `PATCH /rooms/:id` 改名仍只允许 owner/admin，且发布 `room.renamed`。
- [ ] 现有 `dissolveRoom` 的普通用户路径仍只允许 owner。
- [ ] 现有 `removeMember` 的普通用户路径仍拒绝移除 owner/自己。
- [ ] 备份 `entityCounts` 包含 `operators`。

## 5.3 边界情况验证

- [ ] 错误 admin 密码 401；连续失败 429。
- [ ] admin 登出后 cookie 失效。
- [ ] guest Bearer 访问 admin API 401/403。
- [ ] 普通 room 不出现在管理端列表；详情/消息返回 404。
- [ ] 普通 room 不能通过 admin 创建接口创建。
- [ ] 已解散工作群不能改名/加成员。
- [ ] owner 不能被 admin 移除。
- [ ] 消息正文含 HTML 标签时按文本显示，不执行。
- [ ] 消息 `beforeSeq` 分页无重复/遗漏。
- [ ] 无物理删除：用户禁用、工作群 dissolved、成员 removed_at、消息保留。
- [ ] 响应不含 password_hash/token/设备公钥。

## 5.4 Test

```bash
cd Workgroup-AI/server
node --test tests/adm-auth.test.js
node --test tests/adm-workgroups.test.js
node --test tests/adm-messages.test.js
node --test tests/h15-guest-bootstrap.test.js
```

```bash
cd Workgroup-AI/application
pnpm exec vitest run \
  integrations/workgroup/tests/a05-workgroup.spec.ts \
  integrations/workgroup/tests/a11-hub-provider.spec.ts \
  integrations/workgroup/tests/a14-hub-settings.spec.ts
```

## 5.5 Build

```bash
cd Workgroup-AI/application/packages/bundle/ds-bot
node scripts/build-client.mjs
node scripts/build-client.mjs --check
```

```bash
cd Workgroup-AI/application
pnpm run build:check
```

## 5.6 Lint

```bash
cd Workgroup-AI/application/packages/bundle/ds-bot
node scripts/lint.mjs
```

已知基线：`scripts/build-lib.mjs` 存在未使用 `cpSync` 的既有 error。本次只要求不新增 lint 问题；如仍失败，记录为既有基线，不作为本次功能通过证据。

## 5.7 Typecheck

- 服务端是 JavaScript，无独立 typecheck 脚本。
- 应用端使用 `pnpm run build:check`；必须通过。
- `server/contracts/events.schema.json` 与 `EVENT_TYPES` 手工一致性检查：两边都包含 `room.renamed`。

## 5.8 最终手工验证

1. 启动 Hub（`HUB_ANONYMOUS_BOOTSTRAP=true`）。
2. 应用设置 `WORKGROUP_HUB_URL`，首次进入 Bot，确认 Hub 出现 `guest-*` 用户。
3. admin 登录 `/admin/`，创建用户可见的工作群。
4. 应用端打开该工作群；admin 改名，确认应用端实时更新。
5. admin 加/移除成员、解散；确认应用端事件/状态。
6. 打开消息页，确认正文分页显示且 HTML 被转义。
7. 插入/保留一个 ordinary room，确认管理端看不到。
8. 检查浏览器网络响应无 token/password_hash。

---

# 6. Execution Log

### Step 0 Completed

Modified:
- `技术实施任务书.docx`
- `TECHNICAL_BLUEPRINT.md`
- `TASK_BOARD.md`
- `ACCEPTANCE.md`
- `README.md`
- `REQUIREMENTS_GAP_FILL.md`
- `TECH_DESIGN_GAP_FILL.md`
- `application/docs/workgroup-ai/APPLICATION_README.md`
- `server/deploy/DEPLOYMENT.md`
- `server/docs/HUB_ADMIN_WEB.md`

Changes:
- 写入本地演示管理端范围、独立 operators、固定 admin、用户只读、消息正文只读、无物理删除。
- 修正 Hub 地址为 `WORKGROUP_HUB_URL` + 自动快速认证。

Verification:
- 已从 docx 提取确认第 13 节、F 验收、ADM-01/DOC-01 存在。

### Step 1 Completed

Modified:
- `server/db/migrations/0013_operators.sql`
- `server/src/db/backup.js`

Changes:
- 新增 operators 表、audit_events.actor_operator_id、固定 admin scrypt seed。
- backup `entityCounts` 纳入 operators。

Verification:
- `adm-auth` 迁移测试通过；`h02-database` 24/24 通过。

### Step 2 Completed

Modified:
- `server/src/admin/auth.js`
- `server/src/api/admin.js`
- `server/src/server.js`

Changes:
- 固定 admin 登录、内存 session、HttpOnly/SameSite cookie、登录限流、同源检查。
- 管理路由直接注册到 server.js；`api/index.js` 保持原样。

Verification:
- `adm-auth` 5/5；真实 HTTP 登录/静态页 smoke 通过。

### Step 3-5 Completed

Modified:
- `server/src/admin/store.js`
- `server/src/admin/web.js`
- `server/src/api/admin.js`
- `server/src/modules/rooms/store.js`
- `server/src/api/rooms.js`
- `server/src/server.js`
- `server/web/admin/*`

Changes:
- 工作群列表/创建/详情/改名/解散、成员增删、消息正文分页；只允许 workgroup。
- operator 审计与软删除/解散；无用户 CRUD。

Verification:
- `adm-workgroups` 4/4、`adm-messages` 2/2；`h04/d-dissolve/h05` 57/57；真实 HTTP CRUD smoke 通过。

### Step 6 Completed

Modified:
- `server/web/admin/index.html`
- `server/web/admin/app.js`
- `server/web/admin/style.css`
- `server/src/admin/web.js`
- `server/src/server.js`

Changes:
- `/admin/` 登录、工作群列表/详情、成员、消息正文、改名/解散；消息用 textContent 渲染。

Verification:
- 静态页/资源/CSP 测试通过；真实 HTTP 页面 smoke 通过；真实浏览器自动化未跑。

### Step 7 Completed

Modified:
- `server/src/realtime/events.js`
- `server/contracts/events.schema.json`
- `server/src/api/rooms.js`
- `server/src/api/admin.js`
- `application/integrations/workgroup/client/index.mjs`
- `application/integrations/workgroup/tests/a05-workgroup.spec.ts`
- `application/packages/bundle/ds-bot/client.js`

Changes:
- 新增 `room.renamed` 契约/发布/reducer；普通与 admin 改名路径都发布。

Verification:
- `d-contract-parity` 3/3；`a05` 35/35；`build-client.mjs --check` 通过。

### Step 8 Completed

Verification:
- `adm-*` 11/11；`h01` 12/12；`h02` 24/24；`h04/d-dissolve/h05` 57/57；`h15` 6/6；`a05/a11/a14` 51/51；`build:check` 2/2；`lint` 20 warnings/0 errors；`git diff --check` clean；真实 HTTP smoke 通过。
- 未执行真实浏览器 UI CRUD 与真实双端 WebSocket 验证，保留为风险。
