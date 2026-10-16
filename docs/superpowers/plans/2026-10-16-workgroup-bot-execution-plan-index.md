# Workgroup Bot 功能补齐执行计划索引

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement these plans task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Current session has no callable subagent tool, so execute inline with review checkpoints.

**Goal:** 按已批准的 W1–W4 规格，补齐 Bot 入口后的 Hub、工作群协作、审批执行和证据链，并保持本地 Bot 与 DSH 原生行为不变。

**Architecture:** 继续使用两个运行边界：`application/` 负责 Fork 后 DSH、Host、Browser 和本地 Bot；`server/` 负责独立 Hub。Browser 通过现有 `/api/bot` 与 Host 通信，Host 持有 Hub 凭据和 Bridge，Hub 通过 HTTP/WSS 提供协作状态；任务执行只发生在 owner Host 的原生 Bot 和隔离 Task Session 中。

**Tech Stack:** JavaScript/React、Cordis/DSH Gateway、Node.js、Fastify、WebSocket、SQLite、Vitest、pnpm。

## Global Constraints

- 项目只保留 `application/` 与 `server/` 两个代码/运行边界。
- Bot 一级入口保持单一 `conversation` 入口和 `order: 1`，本地群入口保持原行为。
- 不重写 DSH Agent Loop，不把远程 Hub 当作命令执行器。
- Hub token、密码、注册 key、设备私钥、模型凭据只留在 Host/既有安全边界，不返回浏览器或写入文档。
- 所有任务必须经过 owner-only 审批、scope、grant、工具/路径/网络/进程边界。
- 任何路径必须 realpath 校验并限制在批准根目录；失败即拒绝，不静默回退。
- 每个生产行为先写一个会正确失败的测试，再写最小实现；每个测试必须观察到 RED 和 GREEN。
- 修改重要配置或核心文件前备份到项目根目录 `backups/`；不执行永久删除。
- 现有工作树包含预先变更，禁止 reset、clean、覆盖式生成或宽泛 `git add .`。
- 生成的 `client.js` 与 `lib/client.js` 必须在源代码修改后重新生成并比较。
- S/M 证据不能替代 L/N/P；未完成或被环境阻断的能力保持 `NO-GO`。

## Plan Set

| 计划 | 文件 | 依赖 | 交付 |
|---|---|---|---|
| W1 | [Bot 入口与 Hub Provider](./2026-10-16-workgroup-bot-entry-hub-provider-implementation-plan.md) | 无 | Provider 契约、Hub 配置/准入、房间发现、身份和安全门控 |
| W2 | [工作群协作与实时链路](./2026-10-16-workgroup-collaboration-realtime-implementation-plan.md) | W1 | 消息/附件/目录/设置/事件/presence/重连 |
| W3 | [审批到原生 Bot 执行](./2026-10-16-workgroup-approval-native-execution-implementation-plan.md) | W1、W2 | owner-only 审批、授权、Task Session、进度、取消、复核分享 |
| W4 | [验证与证据收口](./2026-10-16-workgroup-verification-evidence-implementation-plan.md) | W1、W2、W3 | S/M/L/N/P 验证、生成产物、旧文档状态和放行结论 |

## Execution Order

1. 先在当前变更不被覆盖的前提下建立执行分支或隔离工作树。
2. 执行 W1。W1 的 focused tests 和凭据边界未通过时停止，不进入 W2。
3. 执行 W2。实时事件消费者、消息字段透传和设置 action 未闭合时停止，不进入 W3。
4. 执行 W3。无法证明 owner Host 的原生隔离执行时保持 NO-GO，不进入 L 级成功结论。
5. 执行 W4。先收集实际命令输出，再更新 `TASK_BOARD.md`、`REQUIREMENTS_GAP_FILL.md`、`TECH_DESIGN_GAP_FILL.md`。

## Checkpoints

每个计划完成一个 Task 后：

- 只运行该 Task 的 focused tests。
- 运行一次范围受限的只读 review，范围是 Task 修改文件和直接依赖。
- 检查 `git diff --check`、凭据边界和本地群回归。
- 只记录该 Task 实际结果；不把后续计划的目标写成当前完成。

每个计划结束时：

- 运行该计划指定的完整 focused suite。
- 记录通过数、失败数、警告和阻塞环境。
- 重新核对本计划的验收条件。
- 只有全部通过才进入下一个计划；失败则按 systematic-debugging 回到根因调查。

## Stop Conditions

遇到以下任一情况立即停止当前计划并报告：

- 测试失败原因无法由当前代码和调用链解释。
- 需要修改 DSH Agent Loop、增加第三运行边界或放宽权限。
- 发现凭据进入 Browser response、公共事件或仓库。
- 发现本地群被调用 Hub action，或工作群调用本地删除/执行 action。
- 需要覆盖当前已有变更、重置分支或永久删除文件。
- 三次最小修复仍不能解决同一根因，需要重新评估架构。
- 环境缺少 L/N/P 所需资源；记录为 BLOCKED，不用 mock 冒充通过。

## Final Handoff

完成 W1–W4 后，使用 `verification-before-completion` 重新验证所有声明；若确需合并、提交或清理，再使用 `finishing-a-development-branch`，并保留本次已有变更的边界。
