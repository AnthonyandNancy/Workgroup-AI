# 工作群验证与证据矩阵专项规格

> 状态：需求与设计基线，未执行源码修改、测试、构建、部署或提交。
>
> 总索引：[Workgroup Bot 功能补齐需求拆解索引](./2026-10-16-workgroup-bot-gaps-index.md)

## 1. 目标

建立一套可复现的验证口径，区分静态事实、mock/unit 证据、单机真实产品证据、双机协作证据和跨平台打包证据，防止“helper 存在”“组件测试通过”被误写成真实工作群或真实 Bot 执行已完成。

本专项只定义验证方法、通过条件、阻塞条件和文档更新规则；本批次不执行验证命令。

## 2. 证据等级

| 等级 | 含义 | 可证明 | 不能证明 |
|---|---|---|---|
| S | 静态检查 | 文件、调用关系、生成产物、配置键和安全边界是否存在 | 运行时可达、真实网络协作 |
| M | mock/unit/component | 纯函数、adapter、组件和错误分支在测试环境中的行为 | 真实 Hub、真实浏览器、真实模型 |
| L | 单机真实 | 一个真实 Hub、一个真实 Host、一个真实浏览器和实际 Bot/模型端点 | 双机网络协作、跨平台打包 |
| N | 双机真实 | 两个独立客户端的邀请、实时同步、断线恢复和权限边界 | 所有平台的安装包质量 |
| P | 跨平台打包 | 指定平台构建、运行和签名结果 | 未覆盖平台、未运行环境 |

规则：

- 一个需求只有达到它要求的最低证据等级才可标记 PASS。
- S/M 不能替代 L/N/P。
- 任意阻断条件失败时结论必须包含 `NO-GO`。
- 非零退出码、未处理异常、HTTP 503、网络不可达和“未确认”不能写成通过。

## 3. 当前基线

### 已有聚焦结果

- `integrations/workgroup/tests/a02-workgroup-view.spec.ts`：6 passed。
- `integrations/workgroup/tests/bot-entry.spec.ts`：16 passed。
- `integrations/workgroup/tests/a11-hub-provider.spec.ts`：10 个测试中 2 failed；已知失败为缺少 `configured` 和 `configure()`。
- 聚焦总计：30 passed，2 failed。
- `client.js` 与 `lib/client.js` 当前字节比较结果为 0。

### 当前不能直接采用的状态

- Gap 文档中的“视图未挂载”“无 CSS”“无 provider”与当前源代码冲突，应以源码和新测试重建状态。
- Task Board 的 PASS 标签必须拆成证据等级，尤其是 A-03、A-04 至 A-10、Q-01 和 Q-04。
- 测试 harness 的 `HTTP 503`、fake conversation `registerSource` 异常和弃用警告必须在新基线中记录，不能仅看断言数量。

## 4. 需求证据矩阵

| 需求 | 最低等级 | 当前证据 | 通过门槛 | 当前判定 |
|---|---:|---|---|---|
| A0 Bot 入口和工作群 Session | S/M | Bot entry 测试和源码 | 入口 `conversation`、`order:1`、`wg:<roomId>` 路由、普通会话隔离 | 部分已证实 |
| A1 视觉和样式 | L | `.bt-wg` 源码与组件测试 | 真实浏览器同尺寸、主题、缩放比对 | 未完成 |
| A2 mention 和远程 Bot | M/L | 服务端 mention helper、UI picker | 字段不丢失；任务为 pending；L 级不执行证明 | 未闭合 |
| A3 附件 ACL | M/L | artifact/client/server helper | 上传、引用、下载、跨房间和移除成员 ACL 真实通过 | 未闭合 |
| A4 chat reference | M/L | 原版 at-menu helper | 有权限可引用，无权限明确拒绝 | 未完成 |
| A5 设置/成员管理 | M/L | 组件级设置 | 所有 action 走 Hub，owner/admin 规则和真实邀请通过 | 未闭合 |
| A6 进度/终止 | M/L | progress/cancel helper | 脱敏进度、取消、子进程状态真实可验证 | 未闭合 |
| A7 presence | M/N | server presence helper | 事件、reducer、UI、断线回落和成员可见性通过 | 未闭合 |
| A8 能力矩阵 | S/M/L | 文档和源码 | 每个原版能力有继承/差异/未继承结论 | 未完成 |
| A9 视觉验证 | L | 暂无稳定截图基线 | 差异登记并复测 | 未完成 |
| B1-B7 准入和身份 | M/L | server config/identity/ratelimit | 注册 key、限制、可信代理、账号展示和 Host-only 凭据通过 | Provider 未闭合 |
| C1-C6 在线状态 | M/N | server realtime/presence | 双机实时 presence、成员可见、重连回落 | 未完成 |
| D1-D6 群记忆 | M/L | memory store/API | 配额、软淘汰、审计、ACL 和回归证据 | 需专门重跑 |
| E1-E5 安全剩余项 | M/L | helper 和 server 部分代码 | 每项有攻击/失败测试和真实执行边界证据 | 未完成 |
| F 原生 Bot 真实执行 | L | helper 级代码 | 提交→审批→隔离执行→进度→复核→分享完整通过 | NO-GO |
| G1-G4 文档配置 | S/M | 现有文档和源码 | 文档能由当前代码和命令复现 | 未完成 |
| H1-H3 零散缺口 | M/L | 部分已有记录 | 各自聚焦测试和门禁结果 | 未完成 |
| I 延后项 | N/P | Task Board | 清楚标记未执行，不误报完成 | 记录中 |

## 5. 分阶段验证清单

### 5.1 S：静态和契约验证

检查：

- Bot 一级入口仍为 `conversation`，排序仍为 `1`。
- 本地群仍使用本地状态和普通 Session ID。
- 工作群只使用 `wg:<roomId>`。
- Browser Provider、Host endpoint、integration client 的方法一一对应。
- `available` 等于已配置且已登录。
- `hubView()` 和所有 Browser response 不含 token、密码、注册 key、私钥或模型凭据。
- `hub-send` 保留 `mentions`、`attachments`、`replyToMessageId` 和幂等 ID。
- 生成的 `client.js` 与 `lib/client.js` 一致。
- 既有 DSH Agent Loop、两个运行边界和本地群 action 没有被改写。

### 5.2 M：聚焦测试

基线命令，工作目录为 `Workgroup-AI/application`：

```text
pnpm exec vitest run integrations/workgroup/tests/a11-hub-provider.spec.ts integrations/workgroup/tests/a02-workgroup-view.spec.ts integrations/workgroup/tests/bot-entry.spec.ts
```

必须补充的测试行为：

- `configured`、`configure()`、`register()`、`rooms()`、`dissolve()` 和 `uploadArtifact()` 存在并正确转发。
- configured but signed out 时不显示创建工作群入口。
- 配置 URL 后可以注册、登录、恢复和列出房间。
- Browser response 永不返回凭据。
- mention 和 attachment 从 WorkgroupView 到 Hub endpoint 不丢失。
- `/tasks/:taskId/decision` 的字段与 server route 一致。
- 非 owner 看不到可操作审批控件，服务端也拒绝手工请求。
- `presence.changed` 能更新成员在线状态。
- Bridge 重连后 catch-up 无漏消息、无重复消息。
- 工作群 settings 不调用本地 `updateRoom/deleteRoom`。
- 跨房间附件、非接收人下载和已移除成员访问被拒绝。
- unknown/duplicate events 不使 reducer 崩溃或重复渲染。

测试不能留下：

- 未处理 Promise rejection。
- fake conversation `registerSource` 异常。
- 未解释的 HTTP 503。
- 仅通过字符串存在性却没有实际调用链的断言。

### 5.3 L：单机真实产品验证

环境使用配置键名描述，不记录任何实际凭据值。执行顺序：

1. 启动独立 Hub，配置 `HUB_REGISTRATION`、`HUB_PUBLIC_URL` 或项目实际采用的 Hub 配置键。
2. 在 Host 配置 `WORKGROUP_HUB_URL` 或等价 URL 配置。
3. 从 Bot 设置完成注册或登录，验证我的用户 ID/handle 可见且可复制。
4. 创建工作群、邀请成员身份、接受邀请、重新打开房间。
5. 发送普通消息、回复、mention 和附件。
6. 确认 mention 只生成 `PENDING_APPROVAL`，没有执行副作用。
7. owner 在自己的客户端检查 scope、assignment mode、Bot、目录、工具和 recipient 后批准。
8. 确认任务在 owner Host 使用原生 Bot 和隔离 Task Session 执行。
9. 查看脱敏进度，测试取消、失败和模型端点不可用。
10. owner review 结果并按指定 recipient 受控分享。
11. 用非 owner、非成员、移除成员和已撤销设备验证读写边界。
12. 在 Bot、Agent、普通会话和本地群之间切换，确认入口和本地功能未回归。

L 级通过必须保存：测试时间、Hub/Host 版本、操作步骤、关键状态转移、失败情况和不含秘密的日志摘要。

### 5.4 N：双机真实验证

使用两个独立客户端：

- A 创建工作群，B 接受邀请。
- A/B 实时收发消息、回复、mention 和 presence。
- 任一端断线重连，验证 catch-up 无漏失、无重复。
- A 发起任务，owner 端审批，另一端只看到脱敏状态。
- owner 取消任务，另一端收到取消状态。
- 移除成员、撤销设备或解散房间，验证连接和读取立即失效。

当前 N 级仍为 BLOCKED，单机 mock 不可替代双机证据。

### 5.5 P：跨平台

分别记录：

- Linux 运行结果。
- Windows 构建和运行结果。
- macOS 构建/签名结果；无 Mac 主机时保持 BLOCKED。

Windows 安装包和策略 origin 若按当前范围延后，不得混入本次 PASS。

## 6. 失败分类

| 分类 | 处理 |
|---|---|
| Adapter contract mismatch | 阻塞对应 M/L 流程，先修 Browser/Host/integration 三层契约 |
| Hub unreachable | 记录环境不可用；本地功能仍应可用；不能标记远程流程通过 |
| Permission failure | 若符合预期则记录为安全通过；若 UI 与服务端不一致则阻塞 |
| Runtime exception | 直接阻塞对应等级，保留堆栈和最小复现 |
| Network or proxy mismatch | 检查 URL、可信代理和限速配置，不静默换地址 |
| Model endpoint unavailable | 任务必须失败或阻塞并提示原因，不能回退默认模型 |
| Child process termination unconfirmed | 标记未确认，不写成成功终止 |
| Documentation mismatch | 先修状态结论，再更新任务板，不覆盖失败证据 |

## 7. 交付和文档更新规则

在代码实现和验证完成前，不更新旧文档中的 PASS。实现后按以下顺序：

1. 保存聚焦测试和构建输出。
2. 记录生成产物比较结果。
3. 记录 L/N/P 证据或明确阻塞。
4. 更新 `TASK_BOARD.md` 的证据等级和状态。
5. 更新 `REQUIREMENTS_GAP_FILL.md`、`TECH_DESIGN_GAP_FILL.md` 的当前系统段落。
6. 保留未完成项、失败项和延后项，不用“组件已存在”替代完成结论。

## 8. 最终放行条件

只有同时满足以下条件，才能把 Bot 工作群功能从 NO-GO 改为 GO：

- W1 Provider、配置、准入、身份和房间发现 M/L 通过。
- W2 消息、mention、附件、成员、presence、实时事件和重连 M/L 通过。
- W3 owner-only 审批、scope、grant、原生 Bot、隔离 Task Session、进度、取消、review 和分享 L 通过。
- 所有凭据边界和权限拒绝测试通过。
- 生成产物同步。
- 文档状态能被当前命令和实际环境复现。
- N/P 阻塞项按要求明确标记，未被误写为完成。

当前结论：Bot 一级入口可按 S/M 级标记已实现；工作群端到端协作和远程 Bot 原生执行继续保持 NO-GO，直到上述门禁全部有证据。
