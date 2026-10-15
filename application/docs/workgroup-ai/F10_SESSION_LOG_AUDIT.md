# F-10：Session Log 删除入口核查

**任务 ID：** F-10

**执行日期：** 2026-10-14

**DSH 版本：** `dsh-v0.2.1-alpha.3`（SHA 见 UPSTREAM_LOCK.md）（0.2.1-alpha.3）

**证据等级：** S（静态源码核对，本轮未做 UI 点击实测；UI 实测见“未做完的部分”）

需求原文：核对真实源码中的 Session Log 删除功能。如存在删除入口，移除或禁用对应操作；保留必要的 Session 归档、历史、日志、恢复及系统排错能力。

## 结论

**在锁定版本中不存在面向用户的“删除 Session Log”操作。** 因此本任务**无须代码改动即可满足**，登记为“已满足”。

## 核查过程与证据

### 1. 名称核对：“Session Log”在 DSH 中不是可删除对象

全仓库检索 `Session Log` 仅命中一处，且是**设置项标题**，与删除无关：

```
packages/client/ui-settings-session-log/src/client/locales.ts:3:
  title: 'Upload Session Log when using the official model API',
packages/client/ui-settings-session-log/src/client/locales.ts:11:
  title: '在使用官方模型 API 时上传 Session Log',
```

另有一个 `session-log-export` 包，提供的是**导出**能力（`Download session log` 菜单项与 `/export` 斜杠命令，把会话树打包为 ZIP 下载），属需求要求**保留**的归档能力。

### 2. 会话行菜单的完整动作列表（关键证据）

`packages/client/ui-workspace/src/client/index.ts:316-324` 注册了会话行菜单的全部条目：

| 顺序 | id | 动作 | 是否删除数据 |
|---|---|---|---|
| 100 | `pin` | 置顶 | 否 |
| 200 | `rename` | 重命名 | 否 |
| 300 | `fork` | 分叉会话 | 否（产生新会话） |
| 400 | `archive` | 归档 | **否** |
| 450 | `session-id` | 复制会话 ID | 否 |

会话行悬停操作（`sidebar.workspaces.session.row.action`）只注册了 `archive` 一项。

**没有任何 `delete` 条目。** 需求原文担心的“UI 可触发的删除操作”在会话维度不存在。

### 3. 唯一的 UI 删除操作属于 workspace，不属于 session

`packages/client/ui-workspace/src/client/rows/Rows.tsx:226,240`：

```
actions?: { rename: () => void; delete: () => void } | undefined
{ id: 'delete', label: t('delete.workspace'), icon: <IconTrashOutlineRegular />, danger: true },
```

该 `delete` 绑定的是 **workspace（工作区）行**，删除对象是工作区实体而非 Session Log， 与需求所指的 Session Log 删除不是同一目标。本轮未改动它；若后续产品要求限制，应作为独立决策记录。

### 4. 归档不删除数据（满足“保留归档、历史、恢复”）

`packages/workspace/workspace/src/index.ts:365` `archiveSession()` 的真实行为：
- 把 sessionId 追加进 durable 的 `archivedSessionIds`；
- 同时移除 pin；
- 写入前做 session 存在性检查；
- 有未完成工作时默认**拒绝**归档（除非显式 `stopActivity`）。

归档只改注册表状态，**不删除任何 Session 文件或事件日志**；`unarchiveSession()` 可完整恢复。 Session 存储与写入能力保持原样。

### 5. 存储层的 `rm` 属于系统内部机制，不是用户入口

`packages/session/session-persistence-jsonl/src/generation.ts` 中的 `fs.rm` 调用点：

- `removeTemporary()`：迁移失败后清理临时文件，并把清理失败与主失败一起 `AggregateError` 抛出；
- `removeCommittedTemporary()`：目标已验证提交后删除冗余中间产物；
- `index.ts` 的 `rm(tmp)`：写入失败时清理临时文件。

这些是格式迁移与原子写入的内部清理，**没有任何用户可触发的调用路径**， 且不得删除它们（删除会破坏运行时的失败恢复能力，正是需求禁止的“错误删除 Agent 依赖的日志机制”）。

## 判定表

| 需求项 | 实测结论 |
|---|---|
| Session Log 删除入口是否存在 | **不存在**（会话菜单只有 pin/rename/fork/archive/session-id） |
| 是否需要移除/禁用 | **不需要**，已满足 |
| 归档能力是否保留 | 是（`archiveSession` / `unarchiveSession`，durable） |
| 历史与日志是否保留 | 是（会话事件日志、`session-log-export` 导出均未改动） |
| 恢复能力是否保留 | 是（unarchive 可恢复；迁移与原子写入机制未改动） |
| 系统排错能力是否保留 | 是（diagnostics 与日志写入未改动） |

## 未做完的部分（不得当作已通过）

1. 本轮为**静态源码核对（S 级）**，没有在 UI 上逐个点击会话菜单来确认渲染结果与源码注册表一致。 若要升级为 L 级证据，应在 F-04 的 bench 上驱动浏览器展开每个会话的 “...” 菜单并断言其中 不存在 delete 项。该 UI 实测归入 F-07/F-08 的回归步骤一并完成。
2. 未核查 DS Bot 自己是否有会话级删除入口。DS Bot 的 Bot/群聊删除（`delete the group`、 `delete the copy`，见 F-04 smoke）删除的是 **Bot 与群聊实体**，不是 Session Log； 其会话归档走 DSH 的 `archiveSession`。此点已在 F-04 smoke 中实际执行过。

## 下一步

- F-10 不需代码改动，任务状态可标 **PASS（S 级）**，并在 F-07/F-08 的 UI 回归中补一次菜单级实测以升级证据。
- 进入 F-11（Task Session 原生 Bot 身份持久化 PoC），这是 G3 门槛。
