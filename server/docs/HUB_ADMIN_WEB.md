# Hub 本地演示管理端（/admin）

## 范围

`/admin/` 是 `server/` 自带的本地演示管理端，只管理工作群（`rooms.kind='workgroup'`）。

包含：

- 固定 admin 登录/登出
- 只读用户列表（用于选择 owner/成员）
- 工作群列表、创建、详情、改名、解散
- 工作群成员添加/移除
- 工作群消息正文只读分页

不包含：

- 用户 CRUD、设备管理、成员角色修改、owner 转移
- 审计 UI、Dashboard、消息搜索、附件下载、消息编辑/删除
- 普通 room、Bot 本地群、私人 Session、Bot 记忆
- 物理删除

## 管理员账号

默认演示账号：

```text
admin / abcd1234567890
```

- 账号保存在独立 `operators` 表，不属于 `users` 表。
- 密码以 scrypt 哈希保存，不保存明文。
- 生产环境通过数据库修改 `operators.password_hash` 或 `status`，并限制 `/admin` 网络访问。
- 默认账号只用于本地/内网演示，不应暴露到公网。

## 数据

- `operators`：管理员身份。
- `audit_events.actor_operator_id`：管理员操作归属。
- 工作群复用 `rooms` / `room_members` / `messages` / `audit_events`。
- 工作群解散使用 `rooms.dissolved_at`；成员移除使用 `room_members.removed_at`；消息保留。

## API

```text
POST   /api/v1/admin/login
POST   /api/v1/admin/logout
GET    /api/v1/admin/session

GET    /api/v1/admin/users?query=&limit=
GET    /api/v1/admin/workgroups?query=&status=live|dissolved|all&limit=
POST   /api/v1/admin/workgroups
GET    /api/v1/admin/workgroups/:id
PATCH  /api/v1/admin/workgroups/:id
DELETE /api/v1/admin/workgroups/:id

POST   /api/v1/admin/workgroups/:id/members
DELETE /api/v1/admin/workgroups/:id/members/:userId

GET    /api/v1/admin/workgroups/:id/messages?beforeSeq=&limit=50
```

所有工作群接口只接受 `kind='workgroup'`。admin API 只接受管理员 cookie，不接受 guest Bearer token。

## 页面

- `/admin/`：登录 + 工作群列表/详情
- 工作群详情：改名、成员增删、解散、消息正文
- 消息正文按纯文本渲染；不执行 HTML

## 安全

- 管理员 cookie：`HttpOnly; SameSite=Strict`；`HUB_PUBLIC_URL` 为 https 时加 `Secure`。
- 管理端登录限流。
- 管理端只读消息正文时写审计，不记录正文。
- 固定 admin 密码仅用于本地演示；生产必须替换并限制网络访问。
