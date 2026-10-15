# A-01 交付：应用端 Hub 配置、登录/设备登记与协议握手

| 字段 | 内容 |
|---|---|
| 任务 ID | A-01 |
| 状态 | **PASS**（26/26 测试，全部针对**真实 Hub** 的真实 HTTP 端口；不依赖 mock） |
| 涉及路径 | `application/integrations/workgroup/protocol/`（新增 `index.mjs`、`hub-client.mjs`）、`application/integrations/workgroup/tests/a01-hub-client.spec.ts`（新增）、`server/src/api/identity.js`（修协议字段）、`server/db/migrations/0007_device_fingerprint_scope.sql`（新增）、`server/tests/h02-database.test.js`、`server/tests/h03-identity.test.js` |
| 前置条件 | H-03（身份）、F-08（Bot 入口）；本机无第二台物理机 |

## 达成条件

| 条件 | 结果 |
|---|---|
| 应用端能配置 Hub 地址并识别错误配置 | 通过：接受 6 种操作员实际会输入的形式；拒绝相对地址、非 http(s)、带 query/fragment 的地址，并指出要设的变量名 |
| 能与**单独运行的 Hub** 完成协议握手 | 通过：真实 Hub 上报 `wg.v1`，客户端接受；版本不同则**拒绝并指明该升级哪一侧** |
| 登录与**设备登记**可用 | 通过：注册（`admin_secret` 闸门）、登录、刷新、登出全部对真实 Hub 跑通 |
| 设备身份稳定且不泄漏主机名 | 通过：指纹为 sha256；同一机器重启复用同一 device 行，另一台机器得到不同指纹 |
| 凭据安全落盘 | 通过：原子写入 + 0600；文件内不含密码；损坏文件不阻止启动 |
| 令牌过期前自动刷新 | 通过：健康令牌不轮换；进入 skew 窗口则刷新并落盘 |

## 实现摘要

### 应用端（新增，此前 5 个目录只有 README）

- **`protocol/index.mjs`**：`PROTOCOL_VERSION`（`wg.v1`）、`checkHubProtocol`（按**主版本**比较， 同类内新增字段不算破坏）、`apiRootOf`（归一化 `/api/v1` 前缀）、`tokenNeedsRefresh`。
- **`protocol/hub-client.mjs`**：`createHubClient` —— 握手、注册、登录、刷新、登出、`me`、`devices`， 以及给后续 A-02…A-10 复用的 `request`。设计要点见下。

### 客户端的关键取舍（每条都有对应测试）

| 取舍 | 理由 |
|---|---|
| 握手在**注册之前** | 否则会在不兼容的 Hub 上留下一台随后无法使用的设备记录 |
| 传输失败报 `HUB_UNREACHABLE`，不是认证失败 | 离线必须继续本地工作，而不是把用户登出 |
| 401 时刷新**一次**再重试 | Hub 可能提前吊销令牌；但无限重试就成了死循环 |
| 刷新后**先落盘**再返回 | Hub 轮换 refresh token 且把二次使用视为泄漏信号；崩溃会让客户端持有已被作废的令牌 |
| 指纹 = sha256(platform+arch+hostname) | 公司 Hub 没有理由存明文机器名；同时保证两台配置相同的笔记本不共用一行 |
| 凭据文件原子写（临时文件 + rename），0600 | 中途崩溃不会留下截断文件把用户登出；权限在 rename 前设好，不存在短暂可读窗口 |
| 密码从不落盘 | 只保存 Hub 签发、且可服务端吊销的凭据 |

## 修复的两个服务端缺陷（均由本任务的真实测试暴露）

### 1. `/auth/config` 把**构建版本**当作协议版本返回（严重）

```js
// 修复前protocol: fastify.hub.version,   // → "0.1.0"// 修复后protocol: protocolVersion,       // → "wg.v1"hubVersion: fastify.hub.version, // 构建版本另给，便于报障时引用
```

任何按契约校验 `protocol` 的客户端都会**拒绝每一台配置正确的 Hub**。原测试只断言了`registrationMode` 与 `accessTokenTtlSeconds`，恰好没查这个字段，所以缺陷一直存在。现在 `h03` 明确断言 `protocol` 匹配 `^wg\.v\d+$` 且不等于 `hubVersion`。

### 2. `devices.fingerprint` 被设为**全局** UNIQUE，但所有查询都是按用户作用域（严重）

```sql
-- 0001：全局唯一 fingerprint TEXT NOT NULL UNIQUE -- 0007：真正被代码假设的约束 CREATE UNIQUE INDEX idx_devices_user_fingerprint ON devices (user_id, fingerprint);
```

`login` 查的是 `(user_id, fingerprint)`，`findDeviceByFingerprint` 收 `userId`，`DEVICE_ALREADY_REGISTERED` 也在"**该用户**的指纹已存在"时抛出——约束与查询对"指纹是什么"的理解不一致。后果：**同一台共用工作站上的两名员工、或一名员工的工作账号与测试账号，第二个永远无法注册**，报错还是"这台设备已注册"，而实际上那台设备不是他的，运维除了删掉别人的记录别无他法。

A 系列后续任务（A-05 邀请、A-06 本人审批）本身就需要两个身份能在一台机器上各自登录与审批，所以这个约束必须按代码已经假设的语义修正。

**修复过程本身也暴露了一个教训**：0007 重建表时我漏抄了 `last_login_at`，迁移成功、schema "current"，但**每一次登录都 500**。已补回，并新增测试「a migration that rebuilds a table keeps every column the earlier migrations added」——它既按名字核对 0001/0002 加过的每个列，也用一次真实 INSERT/UPDATE 证明列可写，避免下次重建再静默丢列。

## 真实命令与结果

```bash
# 应用端（真实 Hub 由测试自己拉起：production 配置、真实迁移、真实 HTTP 端口）
cd application && npx vitest run integrations/workgroup/tests/a01-hub-client.spec.ts
# → Test Files 1 passed | Tests 26 passed (26)

# 服务端（Node 24 —— 产品要求的版本）
cd server && /d/Develop/nvm/v24.19.0/node.exe --test tests/*.test.js
# → tests 307, pass 307, fail 0, duration_ms 16563
```

## 环境发现：请使用 Node 24

同一套服务端测试在 **Node 26.7.0** 下无法跑完（>900 s）：`node:sqlite` 的 `backup()` 会间歇性阻塞约 30 秒。同一段代码在 **Node 24.19.0** 下每次 15 ms。已做 A/B：

| 运行 | 结果 |
|---|---|
| Node 26.7.0，8 次 `backup()` | 测试文件 200 s 未结束 |
| Node 24.19.0，8 次 `backup()` | worst backup 15 ms，文件 0.56 s |
| Node 26.7.0，全部服务端测试 | >900 s，未完成 |
| Node 24.19.0，全部服务端测试 | 307/307，16.5 s |

这**不是**本项目代码的问题（阻塞发生在 `node:sqlite` 内部），但会让计划备份不可预测，因此 `DEPLOYMENT.md` 已新增一节记录该基准，容器镜像与 systemd 均固定 24 LTS。

## 未解决风险

| 项 | 状态 |
|---|---|
| Hub 端 TLS 由反代终止 | 客户端按 `https://` 配置，未在真机验证自签/内网 CA 的信任链 |
| 令牌刷新与设备吊销的**竞态** | 已测"吊销后刷新失败"，未测"刷新与吊销同时发生" |
| 客户端凭据落盘的平台差异 | Windows 忽略 POSIX 权限位；已跳过该断言，实际依赖用户目录 ACL |
| 真实多机 | 本机无第二台物理机，归 Q-01（预期 BLOCKED） |
| 限速对客户端的影响 | Hub 返回 429 时客户端只上报错误，未实现退避重试（A-02 重连逻辑再处理） |

## 下一步

A-02：Bridge 的 WSS ACK / 重连 / 离线补拉。它复用本任务的 `createHubClient`，并在其上加WebSocket 与重连状态机。
