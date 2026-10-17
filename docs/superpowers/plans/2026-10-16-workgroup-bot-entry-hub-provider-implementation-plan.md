# Bot 入口与 Hub Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 补齐 Bot Provider、Host Hub adapter、配置/准入 UI、房间发现和身份展示，使 `available`、凭据边界与本地 fallback 可复现。

**Architecture:** Browser Provider 只持有响应式状态和非敏感身份，Host 通过现有 `/api/bot` 持有 Hub client、session 和配置；Hub URL 作为 Host 连接配置保存，token/密码/注册 key 不进入 Browser 持久状态或 response。工作群创建仍产生 `wg:<roomId>` Session，本地群路径不变。

**Tech Stack:** JavaScript/React、Cordis、Node.js、Hub HTTP client、Vitest、pnpm。

## Global Constraints

- 只修改 `application/` 和本计划列出的测试/生成产物。
- 保持 `BOT_PANEL_ID = 'conversation'`、`order: 1` 和本地群创建行为。
- `available === configured && signedIn`。
- Browser 只能得到 identity/status/view，不得得到 token、密码、注册 key、私钥或模型凭据。
- 配置变化必须使旧 Hub client、Bridge、房间缓存和错误状态失效后再恢复。
- 不新增独立 RPC、WebSocket、项目或进程。
- 每个行为先写失败测试并实际看到 RED，再写最小实现。

---

### Task 1: 建立 W1 基线和 Provider 契约失败测试

**Files:**
- Modify: `application/integrations/workgroup/tests/a11-hub-provider.spec.ts`
- Test: 同一文件中的 Provider surface、configured state、configuration forwarding cases

**Interfaces:**
- Consumes: 当前 `createWorkgroupHub()`、Host fake `/api/bot` transport。
- Produces: 对后续实现稳定的 `configured`、`signedIn`、`available`、`configure()`、`register()`、`rooms()`、`dissolve()`、`uploadArtifact()` 断言。

- [x] **Step 1: 复用现有失败测试并核对覆盖范围**

当前 `a11-hub-provider.spec.ts` 已经包含 `configured`、`configure()`、`register()`、`rooms()` 和“已配置但未登录不可用”的行为覆盖。先确认这些测试就是本 Task 的 RED 证据，不重复添加同名测试；只在运行结果显示缺少 `dissolve()` 或 `uploadArtifact()` 覆盖时补充对应最小断言。

现有关键断言包括：

```js
expect(hub.configured).toBe(true)
expect(hub.available).toBe(false)
await hub.configure('https://hub.example')
await hub.register({ userHandle: 'bob', displayName: 'Bob', password: 'temporary', bootstrapSecret: 'temporary-secret' })
expect(await hub.rooms()).toEqual([{ id: 'room-1', kind: 'workgroup' }])
```

- [x] **Step 2: 运行 RED**

Run from `application/`:

```text
pnpm exec vitest run integrations/workgroup/tests/a11-hub-provider.spec.ts
```

Expected: 当前测试因 `hub.configured` 未暴露和/或 `hub.configure` 不存在失败；若测试因 fixture 错误报错，先修 fixture，不进入生产代码。

- [x] **Step 3: 核对失败根因**

确认失败来自 Browser Provider 的返回对象，而不是 Host fake、路径解析或测试导入错误。记录堆栈和当前返回对象的非敏感字段；同时确认 `dissolve()`、`uploadArtifact()` 是否已有测试覆盖。

- [x] **Step 4: 保留 RED 证据**

将失败测试名称和最小错误记录在本 Task 的执行记录中；不修改旧任务板状态。

- [x] **Step 5: Task checkpoint**

只检查 `a11-hub-provider.spec.ts` 的 diff，确认没有把凭据值写入 fixture；若现有覆盖已完整，Task 1 不产生测试文件修改。

---

### Task 2: 实现 Browser Provider 状态和基础调用

**Files:**
- Modify: `application/packages/bundle/ds-bot/src/client/workgroup-hub.js`
- Modify: `application/integrations/workgroup/tests/a11-hub-provider.spec.ts`

**Interfaces:**
- Consumes: `api()` 现有 `/api/bot` request/response；Host `hub-view` 返回的非敏感状态。
- Produces:

```js
{
  configured,
  signedIn,
  available,
  state,
  identity,
  view,
  configure({ url }),
  register(payload),
  signIn(payload),
  signOut(),
  resume(),
  rooms(),
  dissolve(roomId),
  uploadArtifact(roomId, payload),
}
```

- [x] **Step 1: 写 `available` 和 surface 的失败/边界测试**

增加三种状态测试：

```js
expect(createHub({ configured: false, signedIn: false }).available).toBe(false)
expect(createHub({ configured: true, signedIn: false }).available).toBe(false)
expect(createHub({ configured: true, signedIn: true }).available).toBe(true)
```

增加调用转发测试：每个方法发送 endpoint 名和非敏感 payload；返回值原样映射为业务对象。

- [x] **Step 2: 运行 RED**

```text
pnpm exec vitest run integrations/workgroup/tests/a11-hub-provider.spec.ts
```

Expected: 新增方法缺失或状态断言失败。

- [x] **Step 3: 写最小 Provider 实现**

在现有服务对象中公开状态 getter，并把 `available` 定义为：

```js
const available = configured === true && signedIn === true
```

为每个方法调用已有 `call(endpoint, body)`，不得在 Browser 保存密码、注册 key 或 token。`configure()` 只发送 URL；`register()`、`signIn()` 的输入仅作为当前调用参数传给 Host。

- [x] **Step 4: 运行 GREEN**

```text
pnpm exec vitest run integrations/workgroup/tests/a11-hub-provider.spec.ts
```

Expected: Task 2 新增断言通过；若已有 A11 的其他失败仍在，保留具体失败，不扩大修改范围。

- [x] **Step 5: 检查凭据边界**

对 fake response 做断言：`hub.view`、`hub.identity`、所有方法返回对象均不含 `token`、`password`、`bootstrapSecret`、私钥字段。

- [x] **Step 6: Task checkpoint**

只读检查 Provider 的调用链，确认没有引入第二套 RPC 或浏览器持久化。

---

### Task 3: 补齐 Host 配置、注册、房间和附件 endpoint

**Files:**
- Backup before editing: `application/packages/bundle/ds-bot/src/host/workgroup-hub.js` to project-root `backups/`
- Modify: `application/packages/bundle/ds-bot/src/host/workgroup-hub.js`
- Modify: `application/integrations/workgroup/protocol/hub-client.mjs`
- Modify: `application/integrations/workgroup/tests/a11-hub-provider.spec.ts`

**Interfaces:**
- Consumes: Provider endpoint calls from Task 2; existing `hubStatePath(dshHome)`, `resolveHubUrl()`, `client.request()`, `workgroup` client.
- Produces:

```js
hub-configure -> { configured, url: redactedUrl, signedIn, state }
hub-register -> identity/status only
hub-rooms -> RoomSummary[]
hub-dissolve -> HubResult
hub-upload-artifact -> ArtifactSummary
```

- [x] **Step 1: 写 Host contract tests**

在 A11 fake Host tests 中断言：

- `configure({ url })` 只保存 URL 配置。
- `register()`、`signIn()` 的返回值不含凭据。
- `rooms()` 调用 `GET /rooms`。
- `dissolve()` 调用 integration client 的 `dissolve(roomId)`。
- `uploadArtifact()` 调用 integration client 的 `uploadArtifact(roomId, payload)`。

- [x] **Step 2: 运行 RED**

```text
pnpm exec vitest run integrations/workgroup/tests/a11-hub-provider.spec.ts
```

Expected: 缺少 Host endpoint 或 fake route 不匹配。

- [x] **Step 3: 备份重要 Host 文件**

确认 `backups/` 的绝对路径是项目根目录下的 `Workgroup-AI/backups/`，再复制当前 Host 文件；不删除或覆盖现有备份。

- [x] **Step 4: 实现配置持久化**

把 URL 配置放在 Host/local state 的既有路径中，配置值只保留经过 URL 校验的公共连接地址。配置变化时：

1. 停止旧 Bridge。
2. 清空旧 watched rooms 和非当前 Hub 的缓存。
3. 创建新 Hub client。
4. 返回不含秘密的状态。

- [x] **Step 5: 实现注册和房间 endpoint**

在 Host endpoint switch 中加入 `hub-configure`、`hub-register`、`hub-rooms`；注册和登录的密码/key只在 Host 请求作用域使用，不记录日志、不写 `hubView()`。

`hub-rooms` 只返回 Hub 当前认证用户有权访问的房间；不新增全局用户搜索。

- [x] **Step 6: 实现 dissolve/upload endpoint**

在现有 `hub-dissolve` 和 `hub-upload-artifact` 分支上补齐 Browser 可调用的 adapter，复用 integration client 的 ACL、大小和房间检查。

- [x] **Step 7: 运行 GREEN**

```text
pnpm exec vitest run integrations/workgroup/tests/a11-hub-provider.spec.ts
```

Expected: Provider contract、Host forwarding 和凭据不回传断言通过。

- [x] **Step 8: Task checkpoint**

检查 Host diff，只允许出现 W1 endpoint、配置状态和必要的 integration client 适配；不改 server 路由来掩盖 adapter mismatch。

---

### Task 4: 接通消息字段、创建入口和 Hub 设置 UI

**Files:**
- Backup before editing: `application/packages/bundle/ds-bot/src/client/workgroup-hub.js`, `src/client/new-chat.js`, `src/client/settings.js`, `src/client/sidebar.js`
- Modify: `application/packages/bundle/ds-bot/src/client/workgroup-hub.js`
- Modify: `application/packages/bundle/ds-bot/src/client/new-chat.js`
- Modify: `application/packages/bundle/ds-bot/src/client/settings.js`
- Modify: `application/packages/bundle/ds-bot/src/client/sidebar.js`
- Modify: `application/packages/bundle/ds-bot/src/client/workgroup-entry.js`
- Test: `application/integrations/workgroup/tests/bot-entry.spec.ts`, `a11-hub-provider.spec.ts`

**Interfaces:**
- Consumes: `hub.available`, `hub.configure/register/signIn/resume/rooms`, existing Bot settings and new-chat shell.
- Produces: 可从 Bot 内部打开的 Hub settings、account identity、invitation/room discovery、正确门控的 `Create workgroup chat`。

- [x] **Step 1: 写失败组件测试**

新增断言：

- configured but signed out 时不渲染 `Create workgroup chat`。
- signed in 时渲染并调用 `createRoom()`。
- Hub settings 可触发 `configure()`、`register()`、`signIn()`、`resume()`、`rooms()`。
- 账户区域能显示并复制 ID/handle。
- 本地 `Create group chat` 仍调用本地 action。

- [x] **Step 2: 运行 RED**

```text
pnpm exec vitest run integrations/workgroup/tests/bot-entry.spec.ts integrations/workgroup/tests/a11-hub-provider.spec.ts
```

Expected: signed-out gate 或 settings surface 断言失败。

- [x] **Step 3: 实现最小 UI**

复用现有 Bot settings/card/button 样式；不创建新的顶层 DSH sidebar entry。Hub settings 只显示非敏感状态，表单输入交给 Provider 方法。

- [x] **Step 4: 运行 GREEN**

```text
pnpm exec vitest run integrations/workgroup/tests/bot-entry.spec.ts integrations/workgroup/tests/a11-hub-provider.spec.ts
```

Expected: W1 UI 和 Provider contract 通过。

- [x] **Step 5: 验证本地 fallback**

运行 `bot-entry.spec.ts` 全集，确认普通 Bot、本地群和 Agent surface 断言没有新增失败。

- [x] **Step 6: Task checkpoint**

只读检查入口注册和 settings route，确认没有增加第二个一级 Bot 入口，也没有把 Hub 房间写入本地 roster。

---

### Task 5: 房间重开、邀请和身份入口

**Files:**
- Modify: `application/packages/bundle/ds-bot/src/client/workgroup-entry.js`
- Modify: `application/packages/bundle/ds-bot/src/client/workgroup-pane.js`
- Modify: `application/packages/bundle/ds-bot/src/client/settings.js`
- Modify: `application/packages/bundle/ds-bot/src/client/sidebar.js`
- Test: `application/integrations/workgroup/tests/a02-workgroup-view.spec.ts`, `a11-hub-provider.spec.ts`

**Interfaces:**
- Consumes: `rooms()`, `openRoom()`, `watch()`, `identity`, invitation methods。
- Produces: 已登录用户可从列表重新打开 `wg:<roomId>`，邀请和身份入口不依赖先打开某个房间。

- [x] **Step 1: 写失败测试**

测试房间摘要点击会创建/打开 `wg:<roomId>`，邀请接受后调用 `watch(roomId)`，身份入口在无当前房间时仍可见。

- [x] **Step 2: 运行 RED**

```text
pnpm exec vitest run integrations/workgroup/tests/a02-workgroup-view.spec.ts integrations/workgroup/tests/a11-hub-provider.spec.ts
```

- [x] **Step 3: 实现房间/邀请/身份入口**

使用 Provider 的房间列表和邀请方法，不调用本地 `createRoom/updateRoom/deleteRoom`；错误显示为非敏感状态。

- [x] **Step 4: 运行 GREEN**

```text
pnpm exec vitest run integrations/workgroup/tests/a02-workgroup-view.spec.ts integrations/workgroup/tests/a11-hub-provider.spec.ts
```

- [x] **Step 5: Task checkpoint**

验证旧的本地群设置和普通会话没有被本 Task 的导航状态污染。

---

### Task 6: 生成产物与 W1 完整门禁

**Files:**
- Modify: `application/packages/bundle/ds-bot/client.js`
- Modify: `application/packages/bundle/ds-bot/lib/client.js`
- Test: W1 focused suite

**Interfaces:**
- Consumes: W1 source changes和仓库现有生成命令。
- Produces: 源码、发布 bundle 和 lib artifact 同步。

- [x] **Step 1: 运行 W1 focused suite**

```text
pnpm exec vitest run integrations/workgroup/tests/a11-hub-provider.spec.ts integrations/workgroup/tests/a02-workgroup-view.spec.ts integrations/workgroup/tests/bot-entry.spec.ts
```

Expected: W1 相关断言全部通过；若 harness 仍输出未处理异常，W1 不放行。

- [x] **Step 2: 使用仓库现有 bundle 生成命令**

先读取 `application/package.json` 和 bundle package scripts，执行仓库已有的生成命令，不手工改写生成文件。

- [x] **Step 3: 比较生成文件**

使用仓库现有比较方式确认 `application/packages/bundle/ds-bot/client.js` 与 `lib/client.js` 字节一致；输出比较结果。

- [x] **Step 4: 运行本地回归**

```text
pnpm exec vitest run integrations/workgroup/tests/bot-entry.spec.ts
```

- [x] **Step 5: W1 checkpoint**

完成范围受限 review：Provider、Host、Hub client、settings、entry 和对应 tests。若凭据边界、W1 focused tests 或生成文件不一致，停止并按 systematic-debugging 返回根因。
