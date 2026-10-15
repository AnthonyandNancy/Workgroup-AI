# Q-03：升级 / 断线 / 进程崩溃 / DB 恢复 —— **PASS**

| 字段 | 内容 |
|---|---|
| 任务 ID | Q-03 |
| 状态 | **PASS**（9/9 用例；SIGKILL 是真 kill，恢复是真恢复，备份是真文件） |
| 验收条件 | 无重复执行和数据越界 |
| 证据等级 | **L 级**（单机真实端到端） |
| 测试 | `application/integrations/workgroup/tests/q03-recovery.spec.ts` |

## 覆盖矩阵

| 场景 | 做法 | 结果 |
|---|---|---|
| **崩溃** | 真实 `SIGKILL`（无 shutdown handler，留下 WAL） | 已提交的消息/记忆在重启后仍在；重启报告 `schema is current`；崩溃前签发的令牌仍可用 |
| **不重复** | 崩溃后重启 | 房间仍恰好 1 条消息、1 条记忆——重启不重放、不重建 |
| **崩溃在取消途中** | 取消后立即 SIGKILL | 任务处于终态且 `revocationVersion > 0`；不存在"取消了一半" |
| **升级（幂等）** | 连续两次 `hub migrate` | 第二次为 no-op，输出 `Schema is current` |
| **升级（备份）** | 升级前 `hub backup` | 快照 + manifest + objects 三件齐全；`backup-drill` 逐实体计数一致 |
| **升级（schema）** | `hub status` | `migrations: N applied, current=true` |
| **回滚（更晚的发布）** | 手工写入一个本包没有的迁移版本 | **拒绝启动**并点名该迁移（"this package does not contain"），不半应用 |
| **恢复** | 备份后销毁数据库 + 侧车 + 附件字节，再 `hub restore` | 用户/成员/消息/任务/审批/记忆/附件**全部回来**；附件字节按 sha256 还原并可下载比对 |
| **恢复（拒绝坏源）** | 用一个非数据库文件做 restore 源 | 拒绝，且**现有数据库未被破坏** |

## 真实命令与结果

```bash
cd application && npx vitest run integrations/workgroup/tests/q03-recovery.spec.ts
# → Test Files 1 passed | Tests 9 passed (9)

# 崩溃恢复与总量损毁恢复另有一份真实 Linux 证据
server/docs/evidence/h13/total-loss-restore.txt   # 数据库/侧车/附件/全部备份销毁后恢复，NRestarts=0
server/docs/evidence/h13/drill-systemd.txt        # systemd 崩溃自动拉起 + 计划备份
```

## 已知缺口

| 项 | 状态 |
|---|---|
| **客户端崩溃** | 未测客户端进程被杀后的恢复（本套件测的是 Hub）；客户端凭据是原子写入，但未做真实 kill 演练 |
| **长时断网** | 用 `stop()`/`start()` 模拟，未做真实长时间断网（需双机，归 Q-01） |
| **游标持久化** | Bridge 的 `roomSeq` 游标只在内存；进程重启后从 0 号补拉。需要跨重启续传时要落盘 |
| **升级时的并发写入** | 迁移要求 Hub 已停止；未测"忘了停 Hub 就升级"的拒绝路径是否总能给出清晰提示 |
| 双机断线 | 归 Q-01（BLOCKED） |

## 结论

**Q-03 = PASS（L 级）。** 无重复执行、无数据越界；缺 N 级（双机断线）证据，归 Q-01。
