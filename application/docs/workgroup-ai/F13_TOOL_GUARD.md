# F-13：Bot 任务工具 guard / 进程撤销与最小权限 PoC

**任务 ID：** F-13

**执行日期：** 2026-10-15

**DS Bot 版本：** `v0.1.5`（SHA 见 UPSTREAM_LOCK.md）（含本任务补丁）

**证据等级：** **L**（真实 DSH Web + 真实 DS Bot + 真实运行时）。无 N 级（双机）结论。

## 完成条件与结论

| 条件 | 结果 |
|---|---|
| 越权拒绝 | **PASS** — 未批准的工具、目录外路径、`..` 穿越、跨卷全部拒绝 |
| 撤销停止 | **PASS** — 撤销后所有调用被拒，并取消正在运行的 turn |
| 最小权限 | **PASS** — 工具白名单 + 目录限定，二者取交集 |

## 核心设计：Session 时限制不够，必须每次调用检查

`sessions 时的限制是**对未来的承诺**；本模块是**让承诺生效的检查**。它挂在 `ctx.tools.guard` 上，**每次工具调用**都跑，因此一个被撤销、过期或被绕过白名单的调用会在**下一步**被拦下，而不是等到下一个 Session。

**提示词不参与判定。** 模型可能被说服去请求它曾被禁止的东西；guard 的答案与请求如何措辞无关。

## 四条独立规则

| 规则 | 拒绝码/文本 | 为什么独立 |
|---|---|---|
| **白名单** | `does not include <tool>` | 即使 Bot 本身拥有该工具，未批准就不能用 |
| **版本** | `approval was withdrawn` | 撤销通过版本差传达 |
| **时间窗** | `approval expired at <t>` | 撤销与过期是两件不同的事 |
| **路径** | `limits file work to <dir>` | 白名单说"能做什么"，路径说"能对哪里做" |

### 关于"批准未列工具"：沉默不是许可

`allowedTools: []` 意味着**一个工具都不允许**，而不是"全部允许"。测试固定：`Allowed: (none)`，且 `bash` 被拒。

### 关于报告工具：拒绝后仍要能说话

`ask_user` 与 `present` 在白名单之外**始终可用**——前提是 grant 未被撤销/过期。**一个无法报告自己被拒绝的任务是静默失败的任务。**

但撤销后它们也被拒：被撤销的任务不该继续对群说话。

### 关于撤销：两个动作缺一不可

```js
grant.revokedAt = Date.now()   // 停掉下一次调用
agent.cancel({ kind: 'user', reason })  // 停掉正在跑的 turn
```

只做第一件，一个长步骤会跑完；只做第二件，队列里的下一条消息会开启新一轮。测试断言两件事都发生。

**`agent.cancel` 只结束当前 turn，不删除任何东西**，所以所有者仍能回看任务做了什么。

## 新增文件

| 文件 | 作用 |
|---|---|
| `application/packages/bundle/ds-bot/src/host/task-grants.js`（新增） | 授权记录、每次调用的 guard、撤销 |
| `application/packages/bundle/ds-bot/test/task-grants.test.js`（新增） | 12 个测试 |
| `application/packages/bundle/ds-bot/dev/task-grant-poc.mjs`（新增） | 真实运行 PoC |

修改：`index.js`（注册模块）、`src/host/store.js`（`taskGrants` 加入保存形状）、`src/host/channel.js`（三个端点）、`test/install.test.js`（注册顺序）。

## 真实执行证据

### 测试

```sh
$ node --import ./test/harness-resolve.mjs --test test/task-grants.test.js
 ℹ tests 12 / ℹ pass 12 / ℹ fail 0

$ npm test                                    # DS Bot 全量
 ℹ tests 572 / ℹ pass 570 / ℹ fail 2
```

**572 项（新增 12 个），570 通过**，与基线一致。

### 真实运行时验证（真实 DSH Web + 真实 DS Bot）

```
=== 1. 打开 Task Session 并授予批准的范围 ===
grant: tools=["read_file","write_file"] workDir=…\.dsh-test-f11\approved

=== 2. 允许范围内的调用 ===
  read_file(批准目录内)      -> allowed=true
  write_file(批准目录内)     -> allowed=true
  read_file(relative.csv)   -> allowed=true

=== 3. 越权调用（应全部拒绝） ===
  未批准的工具（Bash）: allowed=false
     → The approval for this task does not include bash. Allowed: read_file, write_file. …
  批准目录之外: allowed=false
     → The approval for this task limits file work to …\approved, so read_file on …\outside\secret.txt will not run. …
  上级目录穿越: allowed=false
     → limits file work to …\approved, so read_file on …\outside\secret.txt will not run. …
  另一个卷: allowed=false
     → limits file work to …\approved, so read_file on D:/private/x.txt will not run. …

=== 4. 上报工具仍可用 ===
  ask_user -> allowed=true

=== 5. 撤销后所有调用被拒（含上报工具） ===
  read_file -> allowed=false
     → This task's approval was withdrawn (requester cancelled), so read_file will not run. …
  ask_user -> allowed=false
     → This task's approval was withdrawn (requester cancelled), so ask_user will not run. …

=== 6. 过期后调用被拒 ===
  allowed=false
     → This task's approval expired at …, so read_file will not run. …
```

`..` 穿越在真实运行中被解析（`…\approved\..\outside\secret.txt` → `…\outside\secret.txt`）并拒绝，这是路径规则最重要的一条证据。

## 开发中被暴露的缺陷

1. **`tools guard` 注册顺序**：我新增的 guard 让 `test/install.test.js` 的固定顺序断言失败。原因是注册在末尾（在所有拥有工具的模块之后，这正是它应有的位置——这样没有工具能在它背后注册）。更新断言，并在注释里说明为什么第二个 guard 在末尾。
2. **`resolveAgent` 的返回值形状**：我最初写 `agent?.agent?.cancel`，多了一层。对照 `turns.js` 的真实用法（`const agent = await rt.resolveAgent(id); agent.cancel(...)`）后修正。**这个 bug 让"撤销停止正在运行的 turn"这一半完全无效，而测试因为断言错误而通过了**——我随后把 fake 的返回值改成与上游一致，测试才真正生效。

## 未完成与风险

| 项 | 状态 |
|---|---|
| **子进程的实际终止** | **未实现，也未验证**。`agent.cancel` 停止 agent loop 与后续工具调用；**已经 spawn 的子进程是否被杀死，本轮没有测试**。这是本任务最重要的缺口，需要 OS 级进程管理（进程组终止）才能声称"子进程实际终止" |
| **网络出站限制** | **未实现**。批准范围可以包含 `maxRuntimeSeconds` 等字段，但 guard **不检查网络**。一个被允许的 `fetch` 工具可以访问任何地址 |
| **工具参数白名单** | 只检查路径类参数。`bash` 的 `command` 内容未检查——因为 `bash` 本身就在白名单之外，这是"不批准就不给"的策略，而非"批准后限制参数" |
| **符号链接绕过路径规则** | guard 用 `resolve()` 做字符串比较，**不调用 realpath**。一个位于批准目录内、指向外部的符号链接会被判定为"在目录内"。F-12 在**设置目录时**用了 realpath，但**运行时**这一层没有 |
| 中断后已产出的副作用回滚 | 未做，也无法完全做到 |
| 真实双机撤销 | 未做，归 Q-01 |
| 与 Hub 授权凭据的实际接线 | 未做。本轮的 grant 由 PoC 直接给定，H-09 的一次性凭据尚未接入，归 A-07 |

**必须记录的边界：** 本轮证明的是"越权调用被拒绝、撤销后调用被拒并取消 turn"。它**没有**证明"撤销后已经启动的子进程被杀死"，也**没有**证明"网络被限制"。这两项是本项目安全声明中的明确欠账。

## 下一步

F-13 是 application 端最后一个 P0 任务。至此 F-01~F-13 全部有结论。下一步进入服务端剩余任务（H-10 群记忆、H-11 附件、H-12 审计备份、H-13 部署），然后是两端联动的 A 系列与验收的 Q 系列。
