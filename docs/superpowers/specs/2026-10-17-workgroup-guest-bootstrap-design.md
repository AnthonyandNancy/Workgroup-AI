# Workgroup Guest Bootstrap Design

> 状态：已获用户确认，按演示优先方案进入实现。
>
> 目标：Hub 保持独立部署，application 首次进入 Bot 时自动获得一个持久的匿名 Hub 用户；Bot 内不显示 Hub 注册、登录、URL 配置或退出页面。

## 1. 目标与范围

本次交付只解决演示所需的身份建立和工作群入口可用性：用户能够启动独立 Hub，打开 application 的 Bot，在没有手工登录的情况下自动获得一个 Hub 用户，并创建、邀请和打开工作群。

Hub 继续是 `server/` 下唯一独立部署的服务。application 只保存本机的安装标识和 Hub 会话，通过 Host 连接 Hub。浏览器渲染端不接触 access token、refresh token 或任何引导凭据。

本次不引入独立 Hub 管理前端，也不把 Hub 的认证设置放回 Bot Settings。正式用户登录、账号恢复、跨设备迁移和管理员身份管理保留为后续认证工作；演示部署通过配置开关启用匿名 bootstrap。

## 2. 已确认的现状

- `server/src/auth/store.js` 已有用户、设备、refresh token、审计、设备吊销和 refresh token 轮换能力。
- `server/src/auth/tokens.js` 已有 access token、refresh token 和设备密钥生成逻辑。
- `server/src/api/identity.js` 目前只提供密码注册、登录、刷新、退出和设备操作。
- `server/src/config/index.js` 已有注册模式、token 生命周期和限流配置，但没有匿名 bootstrap 开关。
- `application/integrations/workgroup/protocol/hub-client.mjs` 已有 Hub URL 解析和 Host 会话路径。
- `application/packages/bundle/ds-bot/src/host/workgroup-hub.js` 已由 Host 持有 Hub client、token 和 WSS Bridge。
- `application/packages/bundle/ds-bot/src/client/settings.js` 当前包含 Hub 设置页，需要移除该页面的用户认证职责。

## 3. 演示版架构

首次进入 Bot 时，调用链为：

```text
Bot provider 初始化
  -> Host 读取 Hub URL
  -> Host 读取本地 guest installation state
  -> 无有效会话时生成 installationId
  -> POST /api/v1/auth/bootstrap
  -> Hub 创建匿名 user + device
  -> Hub 返回 access token + refresh token
  -> Host 保存 hub session
  -> Host 启动 WSS Bridge
  -> workgroupHub.available = true
  -> 显示 Create workgroup chat
```

后续启动优先使用本地 refresh token。refresh token 过期、被吊销或设备失效时，Host 清理当前会话并重新执行 bootstrap；重新 bootstrap 会产生新的匿名用户。清空本机 application 用户数据也会产生新的匿名用户。

Hub 的普通业务接口仍然要求 Bearer access token。"能连通服务端"表示 application 能完成 bootstrap 或恢复有效会话；服务端不会信任客户端单独提交的 userId。

## 4. Bootstrap 接口

新增 `POST /api/v1/auth/bootstrap`。

请求不携带 Bearer token，只在 `HUB_ANONYMOUS_BOOTSTRAP=true` 时开放。请求字段：

```json
{
  "installationId": "uuid",
  "deviceLabel": "DSH Bot",
  "platform": "web",
  "appVersion": "..."
}
```

`installationId` 由 Host 首次生成并保存；客户端不得提交 userId、handle、角色或权限。Hub 生成 canonical userId、随机 guest handle 和 display name，并登记一个设备。设备使用现有 fingerprint/public-key 字段；演示版沿用当前设备注册模型，不向浏览器返回设备密钥。

响应只包含公开身份和会话字段：

```json
{
  "user": {
    "id": "uuid",
    "userHandle": "guest-...",
    "displayName": "Guest ...",
    "status": "active"
  },
  "device": {
    "id": "uuid",
    "label": "DSH Bot",
    "platform": "web",
    "appVersion": "..."
  },
  "accessToken": "...",
  "refreshToken": "...",
  "accessTokenExpiresAt": "...",
  "refreshTokenExpiresAt": "..."
}
```

access token 和 refresh token 只返回给 Host。Host 对浏览器只投影 `user.id`、`userHandle`、`displayName` 和连接状态。

服务端在一次事务中创建用户、设备、初始 refresh token 和审计事件。用户使用现有 `users` 表的 active 状态；bootstrap 生成不可交互使用的随机内部密码哈希，以复用现有用户存储和停用逻辑，绝不向客户端返回该密码。

演示 bootstrap 的配置要求：

```text
HUB_ANONYMOUS_BOOTSTRAP=true
```

默认值为关闭。bootstrap 需要沿用现有来源限流机制，并设置独立的 bootstrap 次数上限，防止一个来源无限创建匿名用户。失败响应不返回 token、内部数据库错误或密码字段。

## 5. application Host 行为

`workgroup-hub.js` 增加 Host 内部的 `ensureGuestSession()`：

1. 解析 `config.hubUrl`、已保存 Hub URL、`WORKGROUP_HUB_URL` 或 `HUB_PUBLIC_URL`。
2. 读取现有 `hubStatePath(dshHome)` 的会话和新增的安装标识文件。
3. 有效 access token 时直接启动 Bridge。
4. access token 失效但 refresh token 可用时执行现有 refresh 流程。
5. 没有会话时生成并持久化 installationId，调用 bootstrap 并保存返回的 Hub 会话。
6. bootstrap 或 refresh 成功后启动 Bridge，并通知 Browser provider。
7. Hub 不可达时保留本地 Bot 能力，工作群 provider 保持不可用并返回稳定错误类别。

installation state 只保存非敏感 installationId、Hub URL 关联信息和版本元数据。token 继续写入现有 Host 用户数据目录，使用当前原子写入和文件权限策略。浏览器端不调用 bootstrap，也不保存任何 Hub credential。

为了保持实现范围最小，首次 bootstrap 的用户身份以本地 installation state 为生命周期边界：同一数据目录重启后保持同一会话；清除该目录后视为新设备和新用户。

## 6. Bot UI 行为

- 从 `SETTINGS_PAGES` 移除 Hub 设置页及其 URL、注册、登录、退出和邀请管理入口。
- 保留 `Create group chat` 的本地行为。
- 保留 `Create workgroup chat`，其显示条件仍是 `workgroups !== undefined`，但 provider 的 available 状态由 Host 自动 bootstrap/refresh 驱动。
- 工作群身份和成员信息继续由现有 Workgroup UI 展示；需要邀请时使用现有成员/目录能力，不新增 Hub 认证页面。
- Hub 不可达时不影响本地 Bot、普通群和本地 Session。
- renderer 只看到连接状态、匿名用户的公开 handle/display name 和工作群数据。

## 7. 服务端配置与兼容性

新增配置读取和校验：

```text
HUB_ANONYMOUS_BOOTSTRAP
HUB_BOOTSTRAP_MAX_ATTEMPTS
HUB_BOOTSTRAP_WINDOW_SECONDS
```

`HUB_ANONYMOUS_BOOTSTRAP` 默认为 `false`，演示 Hub 显式设为 `true`。现有密码注册、登录和 Bearer 认证路径保持兼容。bootstrap 关闭时，Hub 返回稳定的 `ANONYMOUS_BOOTSTRAP_DISABLED`，application 将其表现为工作群连接不可用，不在 Bot Settings 中引导用户输入密码。

本次不修改 room、message、task、grant 或附件权限模型。匿名用户完成 bootstrap 后与普通 active user 使用相同的成员、ACL、审计和设备吊销规则。

## 8. 测试与验收

服务端测试：

- bootstrap 关闭时拒绝请求；
- bootstrap 开启时创建 user、device、refresh token 和 audit row；
- 响应不包含 password hash、内部 secret 或不可投影字段；
- 返回的 access token 可以访问 `/rooms`；
- refresh token 可以轮换，设备吊销后不能继续刷新；
- bootstrap 限流按配置生效；
- malformed installationId、过长 deviceLabel 和未知字段按现有错误规则处理。

application 测试：

- 无会话首次进入时自动 bootstrap；
- 已有会话优先恢复，不重复创建用户；
- refresh 失败后清理失效会话并重新 bootstrap；
- Hub 不可达时本地 Bot 仍可用；
- renderer 收不到 token；
- Hub 设置页不再出现在 Bot Settings；
- Hub 可用后创建入口顺序为 `Create group chat`、`Create workgroup chat`、`Add DSH Agent`。

执行验证命令：

```sh
pnpm --filter @deepseek-ai/dsh-bot build
pnpm exec vitest run integrations/workgroup/tests/a04-workgroup-entry-wiring.spec.ts integrations/workgroup/tests/bot-entry.spec.ts
node packages/bundle/ds-bot/scripts/build-client.mjs --check
git diff --check
```

另加本次 bootstrap 相关的服务端和 Host 聚焦测试。最终报告区分源码/单测证据与真实 Hub 双端演示证据。

## 9. 已知演示边界

匿名 bootstrap 允许能够访问并通过 Hub 配置检查的客户端自动创建用户，适合当前局域网演示。它不提供账号恢复、跨设备身份迁移或管理员审批。正式部署应关闭该开关并接入独立 Hub Web 认证或 application 统一登录；这些后续能力不改变 Bot 内工作群创建入口。
