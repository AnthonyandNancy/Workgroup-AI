# A-08 交付：三种派发流程与真实子进程终止

| 字段 | 内容 |
|---|---|
| 任务 ID | A-08 |
| 状态 | **PASS**（30/30 测试；子进程终止用**真实子进程**验证：真 `spawn`、真退出事件、真 SIGTERM） |
| 涉及路径 | `application/integrations/workgroup/bot-adapter/flows.mjs`（新增）、`bot-adapter/cancellation.mjs`（新增）、`tests/a08-flows.spec.ts`（新增） |
| 前置条件 | A-07、F-11、F-13 |

## 达成条件

| 条件 | 结果 |
|---|---|
| 三种流程各有实现 | 通过：`existing_bot` 逐字使用批准的 Bot；`chief_auto` 由 Chief 提名；`create_bot` 新建并绑定 |
| 不假冒原生 Bot | 通过：三种模式**汇聚到同一个 runner**，Bot 与目录原样传入，不存在"用普通 Agent 顶上"的分支 |
| 只跑 owner 授权的 Bot | 通过：**三个 Bot id 必须一致**（凭据的、审批记录的、选出的），两两独立校验 |
| 子进程真的被终止 | 通过：真实长驻子进程被 SIGTERM 终止并 `waitForExit` 确认；未确认的情况**如实上报** |
| 撤销后不再执行 | 通过：终止后仍撤销绑定，重试/排队调用/成果发布全部拒绝 |

## 子进程终止：补齐登记三次的缺口

H-09、F-13、A-07 都登记过同一件事：**撤销会停止下一次工具调用，但已经 spawn 的子进程从未被终止**。这是"任务被取消"与"任务还在下载、还在写文件、还在花钱"之间的差别。

实现分三层，因为停一层不等于停住任务：

| 层 | 做法 |
|---|---|
| 回合 | 先走 Agent 的 cancel 路径结束循环并拒绝后续工具调用 |
| 进程 | 按 taskId 登记的活句柄逐个 `terminate()`，再对每个 `waitForExit()` **等待** |
| 绑定 | 标记本地授权失效，使重试、排队的调用、成果发布即便有残留也被拒绝 |

顺序是刻意的：**先停回合再杀进程**——反过来会留下一个窗口让循环再 spawn 一个。

**它不假装自己做到了做不到的事**：`waitForExit` 超时、provider 丢失托管范围、回合无法停止，三种情况都报 `UNCONFIRMED` 而非成功。一个以为进程已死、其实没死的运维人员不会再去查。

**登记是调用方的义务**，这一点在注释与用例里都写明：没登记的进程取消够不到。测试用两个子进程证明"只终止属于该任务的那个，邻居的不动"。

## 三个 id 的绑定

运行前必须三个 id 一致：**凭据的 botId**、**审批记录的 assignedBotId**、**选出的 botId**。两两独立校验，因为它们在 `chief_auto` / `create_bot` 下可以独立地不一致。两个一致不足以放行——那说明第三方是过期或被伪造的，而"挑代码恰好偏好的那个"正是要避免的。

## 真实命令与结果

```bash
cd application && npx vitest run integrations/workgroup/tests/a08-flows.spec.ts
# → Test Files 1 passed | Tests 30 passed (30)

cd application && npx vitest run integrations/workgroup/tests/
# → Test Files 7 passed | Tests 166 passed (166)

cd server && /d/Develop/nvm/v24.19.0/node.exe --test tests/*.test.js
# → tests 307, pass 307, fail 0
```

真实进程用例的实测行为：

```
✓ terminates a real child process and confirms it is gone        109ms✓ cancels only the task it was asked about                        85ms✓ reports UNCONFIRMED when a provider cannot say its process exited✓ reports UNCONFIRMED when the turn could not be stopped, even if the processes died
```

## 进度的脱敏（A-09 的输入契约）

进度**在生产处**就脱敏，而不是发出前过滤：没进入更新的字段，无法被后续改动泄漏。

- `starting` / `running` 只报阶段，**不带 botId 与 sessionId**：哪个 Bot 跑任务、Session 叫什么，是 owner 的事。
- 结果**不在进度里**：分享成果是 A-09 的复核步骤，带结果的进度更新等于顺手公开私有工作。
- 任务与事件的可见字段是**正向白名单**（`ROOM_VISIBLE_TASK_FIELDS`）。负向列表（"除路径外都行"）在有人新增字段之前都是对的，而那一刻正是它泄漏的时刻。
- 取消通知只带 `state`，**不带**"有进程未能确认终止"。房间没有理由读到某台机器的内部状态。

## 未解决风险

| 项 | 状态 |
|---|---|
| **真实原生 Bot 执行的端到端** | 本任务交付流程层与取消层，用真实子进程验证终止。**真正跑一次原生 Bot（真模型 + 真 Session）未做**——需要 DEEPSEEK_API_KEY 与本机 DSH 环境，归 Q-01/Q-03 |
| **Terminal 会话成员** | DSH 的 `terminal` 类型另有 `terminate()`，本模块只处理 subprocess 句柄；持久终端里的进程不在覆盖内 |
| Windows 的进程树 | `SIGTERM` 对 Windows 子进程树的行为与 POSIX 不同；本机实测通过，但**未在 Windows 上验证孙进程**（`taskkill /T` 语义） |
| 网络出站限制 | 未实现 |
| 真实双机 | 归 Q-01（预期 BLOCKED） |
| Task Session 内存隔离 | 未验证（F-13 已登记） |

## 下一步

A-09：任务进度脱敏、成果复核与受控分享。本任务已交付脱敏的**生产侧**，A-09 要补复核流程与受控分发。
