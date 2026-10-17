# Workgroup AI｜验收方案与拒绝发布条件

## A. 目录与部署（硬性）

- [ ] 根目录只有 `application/` 和 `server/` 两个代码/构建项目，无额外独立进程项目。
- [ ] 在干净 Linux 将 **`server/` 单独复制**，不包含 `application/`；可安装依赖、初始化 DB、启动 Hub、健康检查、迁移、备份恢复。
- [ ] 服务器进程列表与发布清单不含 DSH/DS Bot/Electron 或 DSH 模型密钥。
- [ ] 应用端包含本地 DSH Host 和 Bot，单独打包并能脱离 Hub 使用私有聊天与原版普通群。

## B. UI（必须逐像素尽量贴合原版视觉）

- [ ] DSH 原“插件”入口未被移动；其紧下只有一个新增的一级 `Bot` 菜单。
- [ ] DSH 一级侧边栏没有 Chief、下属 Bot、私人聊天、普通群聊、工作群的独立菜单。
- [ ] 点击 Bot 才看到完整 DS Bot 内部功能。
- [ ] Bot 内原“创建群聊”入口仍在；紧下新增“创建工作群聊”，不修改原本创建逻辑。
- [ ] 工作群整体沿用 DS Bot 原版群聊组件、排版、配色、输入交互及群管理模式。
- [ ] 原版群聊功能逐项建立对照并回归：@Bot、任务接力和状态、群设置、附件/引用，以及“+ Reference a chat”在工作群中的授权边界。
- [ ] 切回 DSH 会话、插件、设置后正常，不残留 Bot 覆盖 UI。
- [ ] Session Log 删除操作不可在 UI 触发；归档、恢复、历史日志正常。

## C. 工作群与身份

- [ ] 两台真实电脑上的两名不同用户注册/登录到同一 Hub。
- [ ] A 创建工作群，按 B 的 userId 邀请；B 接受后双方可互相看到群消息。
- [ ] 非成员不能通过猜测 roomId 读取消息、群记忆、附件或任务。
- [ ] 消息 clientMsgId 幂等，重连不重复；按 roomSeq 补拉缺失消息。
- [ ] 移除 B 后 B 不再收到新消息，不得通过老 token 恢复订阅。
- [ ] 原版普通群不依赖 Hub，不共享其私有旧历史。

## D. 授权委派（P0 阻断）

- [ ] A @ B 的 Chief 发起任务后，仅显示待审批，不运行任何 B 的模型/工具/文件。
- [ ] 本人 B 登录认证客户端执行批准/拒绝；其他群成员或 Chief 不能代批。
- [ ] 三种分派模式：已有 Bot、Chief 自动选 Bot、新建 Bot，在 B 端有真实执行结果。
- [ ] Task Session 与 B 私人 Session 隔离，真实绑定正确的 Bot 角色、模型、指令、记忆、能力。
- [ ] B 限定目录和工具；尝试不允许目录、符号链接越界、无效目录，均明确拒绝，不会回落到默认团队目录。
- [ ] 任务执行期间撤销：新的工具调用/重试/成果发布全部拒绝，子进程实际终止或安全隔离。
- [ ] 成果只分享经批准的文件/摘要和指定接收人；模型链路、私人聊天和原始文件不默认公开。

## E. 群记忆与运维

- [ ] 群记忆有来源、作者、修订、权限、时效、纠错与删除权限。
- [ ] 非成员/被踢出成员不得检索历史群记忆（依据明确的群政策处理合法已下载副本）。
- [ ] Hub 退出后，DSH 与 DS Bot 本地普通聊天正常。
- [ ] 备份与恢复验证用户、成员、消息、任务状态、审批、群记忆及审计一致性。
- [ ] 签名/重放/过期/设备撤销/日志脱敏测试均通过。

## 必须记录的证据等级

S = 文档/静态源码核对；M = mock/单测；L = 单电脑真实端到端；N = **两台真实电脑+真实 Hub**；P = Windows/macOS/Linux 发布实测。S/M 不能代替 L/N/P。所有阻断条件未 PASS 时结论必须为 `NO-GO`。

---

# G4：本轮终态基线（2026-10-16）

本节是**当前代码状态的事实记录**，不是发布判定。判定规则见文末"必须记录的证据等级"与本轮结论段。

## 一、实测基线与命令

| 车道 | 命令（在 `Workgroup-AI/` 下） | 结果 |
|---|---|---|
| 服务端 | `cd server && <node24> --test "tests/*.test.js"` | **371 / 371 通过** |
| 应用集成 | `cd application && npx vitest run integrations/workgroup/tests/` | **286 通过 / 2 失败**；2 项为既有 `f13-child-process.host.spec.ts`（超时，与本轮无关） |
| ds-bot 包 | `cd application/packages/bundle/ds-bot && node --import ./test/harness-resolve.mjs --test "test/*.test.js"` | **624 项 / 623 通过**；1 项为上游既有 `dsh-update.test.js` |
| client bundle | `node scripts/build-client.mjs --check` | 通过（无陈旧产物） |
| ds-bot lint | `node scripts/lint.mjs` | 18 warnings + **1 error**（`scripts/build-lib.mjs` 的未用 `cpSync`，基线既有） |
| 门禁聚合 | `cd application && npx tsx scripts/run-gates.ts ci-static` | 含 `verify-third-party-notices`（H3） |

## 二、本轮新增能力与证据等级

| 需求项 | 实现 | 证据等级 | 说明 |
|---|---|---|---|
| WP-E1 非对称签名链 | `server/src/modules/tasks/signing.js`、`grants.js`、`api/grants.js`、`policy/grant-signature.mjs` | **M + L（跨项目一致性）** | 服务端 `e1-dispatch-signing` 11/11；`e1-signature-parity` 4/4（以子进程驱动 Hub 真实签名器，验证两侧编码一致，含"不同字节必被拒"对照）。**未做真实双机凭据流转（N 级）** |
| WP-E2 Windows 孙进程终止 | `bot-adapter/cancellation.mjs` 的 `terminateProcessTree` | **M**；L 级未确认 | 单测 5/5 覆盖 `taskkill /T /F` 参数与"无法确认时如实上报"；**未在真实 Windows 上验证孙进程确实终止**——需求要求"无法确认时如实报告未确认"，故此处记 M |
| WP-E3 网络出站受限 | `policy/egress.mjs`（唯一实现）、`host/task-grants.js` 的 `checkEgress` | **M** | 10/10 + 4/4；默认拒绝、按 `host[:port]` 精确匹配。`NETWORK_ARGUMENTS` 是**弱半环**，已注释说明 |
| WP-E4 成果内容检查 | `client/review.mjs` 的 `assertContentPolicy` | **M** | 21/21（新增 3 例） |
| WP-E5 全端点限速 | `security/ratelimit-store.js` + `api/{bots,messages}.js` | **M** | 12/12。**语义差异须记录**：登录/注册"失败才计数"，心跳/消息"每次调用计数"（无失败路径） |
| WP-A0 工作群真实挂载 | `shell.overlay` + `wg:<roomId>` | **M + 单机真实进程（L）** | `m3-presence-e2e.host.spec.ts` 2/2 起真实 Hub |
| D 工作群解散 | 迁移 `0011`、`dissolveRoom`、`POST /rooms/:id/dissolve` | **M** | 服务端 10/10；契约一致性 3/3。解散是**状态**而非删除（`room_members`/`messages` 对 `rooms` 有级联，删除会抹掉会话） |
| E @成员/@远程 Bot、附件 | 迁移 `0012`、`mentions_json`/`attachments_json`、`proposeTasksForMentions` | **M + L（真实 Hub）** | 服务端 11/11；`e-attachments.host.spec.ts` 7/7 起真实 Hub；客户端提及规则 9/9。**@远程 Bot 只创建 `PENDING_APPROVAL`，不审批、不铸造凭据、不触达对方机器** |

## 三、本轮修正的既有事实性缺陷（非新增能力）

| 缺陷 | 影响 | 处置 |
|---|---|---|
| `contracts/events.schema.json` 缺 `member.changed` | 该事件自房间路由存在起就在发出，但从未列入契约；按 schema 校验的客户端会拒绝真实事件 | 补入，并加 `d-contract-parity.test.js` 双向校验（3/3） |
| 消息路由遇 `TaskError` 答 500 | `BOT_NOT_AVAILABLE`/`SELF_TASK` 被当成服务端故障 | 复用任务路由既有映射（403/409） |
| `server/src/security/egress.js` 与 `policy/egress.mjs` 重复实现 | 同一规则两份，可能漂移 | 移除服务端重复件，保留应用侧唯一实现 |
| `client/review.mjs` 不检查成果内容 | 策略命中时仍能发布 | 加 `assertContentPolicy`（E4） |

## 四、BLOCKED / DEFERRED（不伪装为 PASS）

| 项 | 状态 | 所需条件 |
|---|---|---|
| WP-F 真实模型链路（L 级） | **部分关闭（L-exec 通过，浏览器 UI 仍 BLOCKED）** | 历史记录 `application/apps/desktop/.desktop-build/development/home/.credentials.yaml` 中有 `LOCATION_API_KEY`；以环境变量传给 `a19-workgroup-real-model-execution.host.spec.ts` 后，真实 Hub 进程 + 真实 Loader Host + `deepseek-v4.1-flash` 跑通"提交 → 本人审批 → 隔离执行 → 脱敏进度 → 复核 → 受控分享"（2/2）。**仍未做**：真实浏览器下的审批/复核/取消视觉与 `conversation` 面板（需构建产物 + Chromium）。**未打印密钥**；无凭据时不得以 mock 记作真实调用成功 |
| B 本人真实审批端到端 | **BLOCKED** | 需真实 B 用户在其认证客户端亲自批准。开发阶段可用模拟，但必须标注；**不得由 A 冒充 B，不得由脚本伪造 B 的人工确认** |
| Windows 安装包实测 | **BLOCKED** | 独立环境；**不得用 Linux 构建证明 Windows 成功** |
| macOS 签名与公证 | **BLOCKED** | 独立环境 |
| 双机联调（N 级） | **BLOCKED** | 两台真实电脑；**不得用本机双进程模拟代替** |
| H2 Session Log 无删除入口（L 级实测） | **BLOCKED** | 需真实浏览器车道 + 已构建 profile；静态核对（无删除 UI 入口）已完成，但不作 L 级 |
| Webhook 限速覆盖 | **DEFERRED** | 该端点在本项目中不存在（源码零命中），来源为既有文档欠账。需求方已批准划为非目标 |
| 限速语义差异（心跳/消息每调用计数） | 需记录 | 非缺陷，但属行为变更，须写入交付文档与升级说明 |
| E1 凭据格式变更 | 需记录 | 未配置签名私钥的 Hub **拒绝所有派发**（失败关闭，刻意）；升级需配置 `HUB_GRANT_SIGNING_KEY` |

## 五、本轮结论

- 核心功能（工作群建立/邀请/消息/@/附件/引用/进度/审批/派发/撤销/成果分享/记忆/限速/presence/解散）**已实现且有测试覆盖**。
- **本次不判定 GO**：上表 BLOCKED 项均未取得 L/N/P 级证据，按文末规则"所有阻断条件未 PASS 时结论必须为 NO-GO"。
- 本轮回写不改变任何既有 NO-GO 结论，也不把 BLOCKED 改写为 PASS。
