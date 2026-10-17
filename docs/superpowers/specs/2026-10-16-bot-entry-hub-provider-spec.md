# Bot 入口与 Hub Provider 契约专项规格

> 状态：需求与设计基线，未执行源码修改、测试、构建、部署或提交。
>
> 总索引：[Workgroup Bot 功能补齐需求拆解索引](./2026-10-16-workgroup-bot-gaps-index.md)

## 1. 目标

补齐从 Bot 一级入口到 Hub 配置、准入、登录、恢复、房间发现和工作群 Session 创建的完整契约，使用户可以在 Bot 内部完成 Hub 连接管理，并让浏览器只看到身份与状态，不接触 Hub token、密码持久值、注册 key 或其他凭据。

本专项只处理入口、Provider、Host 适配器、账户/Hub 设置和房间发现。消息实时分发、审批执行和真实模型证据分别由 W2、W3、W4 处理。

## 2. 当前事实

### 已实现

- `application/packages/bundle/ds-bot/src/client/index.js` 注册一个 Bot 一级入口。
- 入口 ID 为 `conversation`，排序为 `1`，位于 Plugins 和 Schedules 之间。
- Bot panel 激活后才替换 Bot shell 和 Conversation surface。
- 本地群创建路径仍独立存在。
- `workgroup-entry.js` 使用 `wg:<roomId>` 创建或打开工作群 Session。
- `src/host/workgroup-hub.js` 已有 Hub URL 解析、状态持久化、登录、登出、恢复和多个 Hub endpoint。
- `hubView()` 已有不返回凭据的设计意图。

### 已确认断点

- 浏览器 Provider 没有完整暴露 `configured`、`configure()`、`register()` 和 `rooms()`。
- 浏览器 Provider 没有暴露 `dissolve()` 和 `uploadArtifact()`，但工作群 pane 已调用这些能力。
- `available` 当前未同时判断 `configured` 和 `signedIn`。
- 当前没有完整 Hub URL 配置、注册、登录/恢复、邀请和房间发现 UI。
- 当前身份 helper 主要在已打开工作群的设置页可见，缺少全局账户入口。
- 现有 A11 测试有两个失败：`configured` 未暴露、`configure()` 不存在。

## 3. 用户流程

### 3.1 首次配置和注册

```text
Bot 一级入口
  -> Hub 设置
  -> 输入 Hub URL
  -> Host 保存非敏感配置
  -> 选择注册或登录
  -> Host 向 Hub 发起请求
  -> 浏览器收到身份/状态/错误分类
```

注册 key、密码和登录凭据只能作为一次性请求数据送到 Host，再由 Host 调用 Hub；不得写入浏览器持久状态、Hub view、日志或返回值。Hub token、刷新 token、设备私钥等只保留在 Host/local state 的既有边界内。

### 3.2 恢复与房间发现

```text
Bot 一级入口
  -> Host hub-resume
  -> Hub session 恢复
  -> rooms() 获取当前用户可见工作群
  -> 用户选择工作群
  -> 创建/保留 wg:<roomId> Session
  -> WorkgroupPane 打开房间
```

恢复失败时必须返回可解释的状态，例如“未配置”“需要重新登录”“设备已撤销”“Hub 不可达”，不能静默创建本地群或切换到其他 Hub。

### 3.3 本地 fallback

Hub 未配置或未登录时：

- Bot 一级入口仍然显示。
- 本地 Bot、普通会话和本地群继续可用。
- 工作群创建入口隐藏或明确显示不可用原因。
- 不得把工作群房间伪装成本地群，也不得把本地群数据上传到 Hub。

## 4. Provider 对外契约

Browser Provider 应保持一个稳定的工作群服务对象，至少提供以下只读状态和方法。具体 JS 实现应遵循当前项目的服务注册方式，不新增第三套 RPC。

### 4.1 状态

| 名称 | 类型/语义 | 约束 |
|---|---|---|
| `configured` | `boolean` | 仅表示有效 Hub URL 已配置，不代表已登录 |
| `signedIn` | `boolean` | 仅表示 Host 当前有可用 Hub session |
| `available` | `boolean` | 必须等于 `configured && signedIn` |
| `state` | 状态对象 | 只包含连接状态、错误分类、最近同步状态等非敏感信息 |
| `identity` | 身份对象或 `undefined` | 可包含 user ID、handle、display name、设备状态，不包含 token/密码 |
| `view` | Host 安全投影 | 不得包含 token、密码、注册 key、私钥或模型凭据 |
| `workgroups` | 响应式房间源 | 只包含当前用户有权看到的工作群摘要 |

### 4.2 配置和准入方法

```js
configure({ url }) -> Promise<HubView>
register({ userHandle, password, displayName, bootstrapSecret, deviceLabel }) -> Promise<IdentityView>
signIn({ userHandle, password, label }) -> Promise<IdentityView>
signOut() -> Promise<HubView>
resume() -> Promise<HubView>
rooms() -> Promise<RoomSummary[]>
me() -> Promise<IdentityView>
devices() -> Promise<DeviceSummary[]>
```

约束：

- `configure()` 只保存经过校验的 URL 和连接配置，不保存登录密码或注册 key。
- `register()` 和 `signIn()` 的敏感输入仅在请求期间经过 Browser → Host，不由 Browser Provider 持久化。
- `resume()` 使用 Host 持有的 session；恢复失败必须保留明确状态。
- `rooms()` 返回 Hub 当前用户有权访问的工作群，不查询未加入用户或隐藏用户目录。
- `me()` 返回用于“我的 ID / handle”展示的身份数据。

### 4.3 房间和附件方法

```js
createRoom(name) -> Promise<RoomSummary>
openRoom(roomId) -> Promise<RoomState>
watch(roomId) -> Promise<void>
dissolve(roomId) -> Promise<HubResult>
uploadArtifact(roomId, { fileName, bytes, contentType, recipients }) -> Promise<ArtifactSummary>
```

`dissolve()` 和 `uploadArtifact()` 必须由 Browser Provider、Host endpoint、integration client 三层同时提供；任何一层缺失都视为契约未完成。

### 4.4 消息方法

```js
sendMessage(roomId, text, {
  clientMessageId,
  replyToMessageId,
  mentions,
  attachments,
}) -> Promise<SendResult>
```

`mentions` 和 `attachments` 只能发送稳定的用户/Bot/artifact ID 及必要的展示信息。Host 不得只转发 `text` 和 `replyToMessageId`，否则 UI 选择的 Bot 或附件会在边界处丢失。

## 5. Host endpoint 约束

Host 继续通过现有 `/api/bot` 单请求通道处理 Browser 请求。新增或补齐 endpoint 时遵守以下规则：

- `hub-view` 不要求已连接即可返回状态。
- `hub-configure` 只处理 URL 和非敏感连接配置。
- `hub-register`、`hub-sign-in`、`hub-resume` 在 Host 内完成 Hub client 调用。
- `hub-rooms` 调用 Hub 的当前用户房间列表。
- `hub-dissolve` 只调用 Hub dissolve，不调用本地 `delete-room`。
- `hub-upload-artifact` 走 Host 持有的 Hub client，按既有上传大小和 ACL 规则处理字节。
- 所有错误都要转换成稳定的非敏感错误类别，不把 Hub token、密码、注册 key 或响应中的私密字段回传浏览器。

## 6. UI 需求

### 6.1 Hub 设置页

Bot 内部应有明确的 Hub 设置入口，至少包含：

- Hub URL 配置和格式错误提示。
- 当前配置/未配置状态。
- 注册入口，包括 registration mode 需要的 key 输入。
- 登录、退出和恢复操作。
- Hub 不可达、令牌失效、设备撤销和注册关闭的状态文案。
- 当前账号 ID、handle、display name 和设备状态。
- 可复制的“我的用户 ID / handle”。
- 当前用户所属工作群列表及重新打开入口。
- 收到的邀请列表、接受和拒绝操作。

### 6.2 创建入口门控

`Create workgroup chat` 在新建聊天菜单、设置 → 群聊和命令面板三处始终可见。点击后调用 Host；Hub 未配置、未登录或不可达时由现有错误路径显示稳定原因，不调用本地 `createRoom()`。匿名 bootstrap 由 Host 自动执行，Bot 内不提供 Hub 登录页。

本地 `Create group chat` 始终保持原行为，并且不读取 Hub token、身份或远程房间数据作为本地群成员。

## 7. 错误和安全要求

- Hub URL 解析失败不得静默回退到默认地址。
- 注册失败和注册关闭必须遵循服务端防探测语义，UI 可显示通用失败，不显示可用于探测的内部状态。
- 配置变化后必须使旧连接和房间缓存失效，再按新 URL 恢复。
- 登出、设备撤销或 Hub 令牌失效后，已打开的工作群显示受限状态，不继续发送请求；创建入口保留，调用返回稳定错误。
- 任何日志和错误消息不得包含密码、token、注册 key、私钥或模型凭据。
- Host 保存的本地状态路径必须继续通过现有 `hubStatePath(dshHome)` 机制管理。

## 8. 验收标准

1. A11 Provider 测试不再因 `configured`、`configure()`、`register()` 或 `rooms()` 缺失而失败。
2. 未配置、已配置未登录、已登录三种状态的 `available` 值分别为 `false`、`false`、`true`。
3. 配置、注册、登录、恢复和房间列表均可从 Bot 内部 UI 触发。
4. 浏览器可显示身份和状态，但无法读取 Hub token、密码、注册 key 或私钥。
5. 创建工作群、打开已有房间、解散房间和上传附件均有完整三层 adapter。
6. 本地群创建和本地 Bot 功能的现有测试保持通过。
7. 真实浏览器在 Hub 不可达时仍能使用本地 Bot 和本地群。

## 9. 直接影响文件

- `application/packages/bundle/ds-bot/src/client/workgroup-hub.js`
- `application/packages/bundle/ds-bot/src/host/workgroup-hub.js`
- `application/integrations/workgroup/protocol/hub-client.mjs`
- `application/packages/bundle/ds-bot/src/client/settings.js`
- `application/packages/bundle/ds-bot/src/client/sidebar.js`
- `application/packages/bundle/ds-bot/src/client/new-chat.js`
- `application/packages/bundle/ds-bot/src/client/workgroup-entry.js`
- `application/integrations/workgroup/tests/a11-hub-provider.spec.ts`
- 与上述源码对应的生成 `client.js`、`lib/client.js`。

明确不改：`BOT_PANEL_ID = 'conversation'`、`order: 1`、本地群数据模型和 DSH Agent Loop。
