# H-03：用户注册/登录、设备身份、令牌吊销

**任务 ID：** H-03
**执行日期：** 2026-10-14
**机器：** Windows 11 (MINGW64) / Node v26.7.0 / Fastify 5.12.7 / SQLite（`node:sqlite`，WAL）
**证据等级：** **L**（单电脑真实进程 + 真实 HTTP + 真实 SQLite）。无 N 级（双机）结论。

---

## 新增文件

| 文件 | 作用 |
|---|---|
| `server/src/auth/password.js` | scrypt 密码哈希、策略校验、参数自描述与升级判定 |
| `server/src/auth/tokens.js` | HMAC 访问令牌、不透明刷新令牌与设备密钥、哈希存储 |
| `server/src/auth/store.js` | 用户/设备/刷新令牌的仓储与审计，全部写入在一个事务内 |
| `server/src/api/identity.js` | 认证路由与请求鉴权器 |
| `server/db/migrations/0002_identity.sql` | `refresh_tokens` 表与 devices 的 label/platform 列 |
| `server/tests/h03-identity.test.js` | 36 个测试 |

`server/src/api/index.js` 现在注册 `identityRoutes`；`server/src/config/index.js` 增加注册策略与令牌生命周期配置。

---

## 关键设计决定与依据

### 1. 用 `node:sqlite` 与内置 crypto，不引入需要编译的原生依赖

Hub 必须能在**干净的 Linux 主机上仅复制 `server/`** 后安装启动。bcrypt/argon2 需要编译工具链，这与该部署约束冲突。scrypt 是 Node 内置、内存硬的密码哈希，满足需求且不增加部署风险。

### 2. 三种凭据，三种生命周期（而不是一个万能 token）

| 凭据 | 形式 | 存储 | 吊销即时性 |
|---|---|---|---|
| 访问令牌 | HMAC-SHA256 签名，`wg1.k1.<payload>.<mac>` | **不存储** | 依赖设备行检查，见下 |
| 刷新令牌 | `wgref_<32 随机字节>` | 只存 SHA-256 哈希 + 非秘密查找前缀 | 立即可吊销（数据库） |
| 设备公钥 | 客户端提供 | `devices.public_key` | 随设备吊销 |

访问令牌的设计取舍被显式记录下来：它**不查库即可验签**，所以吊销设备不会让已签发的访问令牌立刻失效。因此访问令牌有效期默认 **900 秒**，而不是数天。`makeAuthenticator` 在验签后**仍会检查设备行是否已吊销**，所以实测结果是：吊销设备后**下一个请求立即被拒绝**（见下方证据第 8 步），无需等待令牌过期。这比"只验签"或"每请求查库"两种极端都更合适。

### 3. 刷新令牌单次使用；重放即吊销整个设备

`rotateRefreshToken` 在同一事务里消费旧令牌并签发新令牌。再次出示已消费的令牌被视为**泄漏信号**（两方持有同一令牌），此时 `revokeDevice` 吊销该设备及其所有令牌，而不是猜测哪一方是合法用户。

**这带来一个真实的可用性代价，已如实记录：** 合法客户端若在收到响应前网络中断并重试，会被登出并需要重新认证。这是有意的取舍——宁可让偶发网络故障的用户重新登录，也不让被盗令牌与真实令牌并存。

### 4. 注册策略随环境变化，且"密钥错误"与"注册关闭"不可区分

| `HUB_REGISTRATION` | 行为 | 默认 |
|---|---|---|
| `open` | 任何人可注册 | `NODE_ENV != production` 时 |
| `admin_secret` | 需 `HUB_ADMIN_BOOTSTRAP_SECRET` | `NODE_ENV=production` 时 |
| `closed` | 全部拒绝 | — |

密钥比对使用 `timingSafeEqual` 且长度不等时直接返回 false。**错误的密钥与关闭的注册返回完全相同的响应体**（测试用 `deepEqual` 固定该性质），探测者无法判断自己是否猜对了密钥。

### 5. 不泄漏"用户名是否存在"

- 登录时，即使 handle 不存在也**照常对一个固定哈希做一次 scrypt 校验**，避免通过响应时间区分已存在/不存在的账号。
- 错误密码与未知 handle 返回**完全相同的 status、code、message**（测试用 `deepEqual` 固定）。
- 登出对未知令牌返回成功，避免成为"该令牌是否存在"的预言机。

### 6. 密码参数自描述，支持无感升级

存储格式 `scrypt$N$r$p$saltB64$hashB64` 把成本参数写进哈希本身。`needsRehash` 在新版本提高成本后能识别旧哈希，登录成功时**原地升级**，无需强制所有用户改密码。密码上限 512 字符，防止攻击者用超长输入把内存硬 KDF 变成内存耗尽杠杆。

### 7. Hub 数据库里不存在任何可用凭据

测试 `no credential the Hub issued is recoverable from the database` 逐表 dump 后断言：访问令牌、刷新令牌、明文密码**都不出现在任何行中**；schema 中也不存在 `access_token` 列。刷新令牌只以 SHA-256 存在，密码只以 scrypt 存在。

### 8. 审计与身份变更在同一事务

`user.created`、`device.registered`、`device.revoked`、`token.refreshed`、`user.tokens_revoked` 等事件与触发它们的写入在同一事务提交，账号不可能在无审计记录的情况下建立或撤销。审计的 `safe_details_json` 只接受调用方选定的小字段（如 label、platform），**不含密码、令牌或完整请求体**，有测试固定。

---

## 真实执行证据

### 测试：`node --test tests/*.test.js`

```
ℹ tests 71        （h01 12 + h02 23 + h03 36）
ℹ pass 71
ℹ fail 0
```

H-03 的 36 项覆盖：密码哈希正确/错误/格式错误/弱参数、令牌往返、跨密钥拒绝、载荷篡改、过期与时钟偏移、畸形令牌各错误码、注册成功与重复/非法 handle/弱密码、三种注册模式、登录成功/错误密码/未知账号/缺指纹、同设备复用与多设备、无令牌/畸形/伪造令牌被拒、删除用户后令牌失效、刷新轮换与重放吊销、登出幂等、设备吊销即时生效、跨用户吊销被拒、设备列表隔离、logout-all、审计事件、数据库无可用凭据、禁用账号。

### 真实进程端到端（两个用户，真实 HTTP，真实 SQLite）

```
[hub] migration 0001_schema.sql: applied
[hub] migration 0002_identity.sql: applied

1. 注册两个真实用户
   finance.a [201]   finance.b [201]

2. B 登录（设备绑定）
   user: 财务 B | device: B laptop | ttl: 900
   accessToken prefix: wg1.k1.eyJzd...
   refreshToken prefix: wgref_Nwks...

3. 无 token 访问受保护路由
   {"error":{"code":"MISSING_TOKEN",...}} [401]

4. 带 token 访问
   {"user":{...},"deviceId":"226738f2-..."} [200]

5. 设备列表
   {"devices":[{"label":"B laptop","platform":"win32","fingerprint":"sha256:b-laptop-001",...}]} [200]

6. 刷新令牌轮换
   rotated ok: true

7. 重放已用过的 refresh token
   {"error":{"code":"REFRESH_TOKEN_REUSED","message":"This refresh token was already used; the device has been signed out"}} [401]

8. 重放后原 access token 立即失效
   {"error":{"code":"DEVICE_REVOKED","message":"This device has been revoked"}} [403]
```

第 8 步是 H-03 的核心安全性质：**吊销不是等令牌过期，而是下一个请求即生效。**

审计记录（同一数据库读回）：

```
user.created success ×2
device.registered success
token.refreshed success
device.revoked success
```

### UTF-8 中文往返（一次真实的排查）

用 MINGW 的 `curl` 发送中文 `displayName` 时，数据库里读回的是替换字符（`���� A`，长度 6）。**排查结论：这是 MINGW curl 的请求编码问题，不是 Hub 缺陷。** 改用 Node `fetch` 发送同样内容后：

```
register status 201
displayName echoed: "财务 B 张三" length 7
stored: "财务 B 张三" length 7
round-trips equal: true
```

Hub 端未做任何修改。诚实记录：本轮的 shell 环境不适合直接用 `curl` 验证非 ASCII 载荷，后续双机测试应使用 Node 客户端或显式设置 `curl --data-binary` 与 `charset`。

---

## 开发过程中被测试暴露的真实缺陷（已修复）

1. **`registerDevice` 声明了 `displayName` 参数却从不写库。** devices 表的 `label`/`platform`/`app_version` 列在 `0002` 中加入后，函数签名没有同步，导致设备列表永远返回 `null`。测试 `login issues an access token ... and registers the device` 断言 `device.label === 'Alice laptop'` 时暴露。已改为写入 `label`/`platform`/`appVersion`，并让 `identity.js` 传递它们。

2. **旋转后重放的正确响应码比预期多一层。** 原测试期望重放后新令牌返回 403 `DEVICE_REVOKED`，实测返回 401 `REFRESH_TOKEN_REVOKED`——因为重放检测时 `revokeDevice` 会撤销该设备**所有**刷新令牌，包括刚旋转出来的那个，所以新令牌先命中"已撤销"。这是**正确且更安全的行为**（设备已被吊销，令牌自身状态无关紧要）。测试按真实行为修正，并补充断言原访问令牌此时也返回 403 `DEVICE_REVOKED`，把这条更强的性质固定下来。

3. **现有测试因新增迁移与配置而失败（测试耦合，非产品缺陷）。** 加入 `0002_identity.sql` 与 `HUB_REGISTRATION` 默认值后，h01/h02 中断言"只有 1 个迁移"和"生产环境只需签名密钥"的用例失败。已更新为反映真实新状态（2 个迁移、生产环境还需 bootstrap secret）。

---

## 未完成与需后续任务处理

| 项 | 状态 | 归属 |
|---|---|---|
| 速率限制与登录失败锁定 | **未实现**。当前登录端点无次数限制，这是可被暴力破解的真实缺口 | H-03 延伸 / H-13 安全加固 |
| 管理员角色与账号管理端点 | 未实现（`setUserStatus` 有仓储函数但无 HTTP 路由） | H-04 需要管理员概念时 |
| 设备公钥的实际使用（任务授予验签） | 只存储，未用于验签 | H-09 |
| 令牌密钥轮换（多 kid 并存） | `kid` 字段已预留，只实现 `k1` | H-09 / H-13 |
| 干净 Linux 上的部署 | 未做（本机为 Windows） | H-13 / Q-04 |
| 与应用端 A-01 的真实握手 | 未做 | A-01 |

**明确的安全欠账：登录端点缺少速率限制。** 密码策略（≥10 字符）与 scrypt 成本提高了单次尝试代价，但不能替代限流。这台 Hub 不应在无限流的情况下面向真实网络暴露。

## 下一步

H-04（创建群、成员邀请、接收/拒绝/踢出）依赖 H-03，且是 A-03/A-04/A-05 的前置。
