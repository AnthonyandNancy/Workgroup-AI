# 验收结论汇总（Q 系列）

本目录记录 Q 系列验收的实际结论。**结论按验收方案自己的规则给**：S/M 级证据不能代替 L/N/P 级，
任何阻断条件未 PASS 时结论必须包含 `NO-GO`。

## 一、结论一览

| 任务 | 结论 | 证据等级 | 文件 |
|---|---|---|---|
| Q-01 双机真实协作 | **BLOCKED** | 无法取得 N | [Q01_TWO_MACHINE_E2E.md](Q01_TWO_MACHINE_E2E.md) |
| Q-02 安全负向用例 | **PASS** | L | [Q02_SECURITY.md](Q02_SECURITY.md) |
| Q-03 升级/断线/崩溃/恢复 | **PASS** | L | [Q03_RECOVERY.md](Q03_RECOVERY.md) |
| Q-04 打包与发布 | **部分 PASS**（macOS BLOCKED） | P/L | [Q04_PACKAGING.md](Q04_PACKAGING.md) |

## 二、最终结论

**`NO-GO`（不可作为正式发布）。** 原因不是功能未实现，而是**两条验收阻断条件无法在本环境取得证据**：

1. **N 级（两台真实电脑 + 真实 Hub）缺失** —— Q-01 BLOCKED。本机只有一台主机，局域网上没有第二台机器。
2. **macOS 产物缺失** —— Q-04 的 macOS 部分 BLOCKED。项目自身拒绝在非 macOS 主机上打包
   （`packageTargets` 明确校验宿主平台），且 mac-arm64 需要 Apple Silicon。

此外，Windows 安装包未产出：需要发布基础设施取值（强制更新源、测试发布 ID），用占位值会生成
更新源不可用的**坏产物**而非已验证发布物。

## 三、已取得的证据（可复现）

| 范围 | 数字 | 命令 |
|---|---|---|
| 服务端测试 | **307/307** | `cd server && node --test tests/*.test.js`（**Node 24**） |
| 应用端集成测试 | **231/231** | `cd application && npx vitest run integrations/workgroup/tests/` |
| DS Bot 单元测试 | **574/575** | `cd application/integrations/ds-bot/upstream/ds-bot && npm test` |
| 产物构建 | **7/7 gates** | `cd application && npx tsx scripts/build.ts --scope artifacts` |
| DS Bot 客户端 bundle | 与源码一致 | `node scripts/build-client.mjs --check` |
| 真实 Linux 部署 | 容器 + systemd 双路线 | `server/docs/evidence/h13/` |

**唯一的 DS Bot 失败是既有的 `test/dsh-update.test.js`**，与本轮改动无关（见 F-10 记录）。

## 四、必须运行 Node 24（实测结论）

同一套服务端测试在 **Node 26.7.0** 下无法跑完（>900 s）：`node:sqlite` 的 `backup()` 会间歇性阻塞约 30 秒；
Node 24.19.0 下每次 15 ms、全量 307/307 用时 16.5 s。这**不是**本项目代码的问题，但会让计划备份不可预测，
因此容器镜像与 systemd 单元均固定 24 LTS。详见 `server/deploy/DEPLOYMENT.md`。

## 五、发布前仍需完成的事项

| # | 事项 | 属于 |
|---|---|---|
| 1 | 两台真实电脑上的完整双机 E2E（含真实模型执行） | Q-01 |
| 2 | Apple Silicon 或 Intel Mac 上的 macOS 打包与签名 | Q-04 |
| 3 | 发布基础设施取值 + Windows 安装包与签名 | Q-04 |
| 4 | 双机断线/长时间断网恢复 | Q-03 延伸 |
| 5 | 派发凭据改为非对称签名链（当前是 nonce + 设备绑定 + 一次性 + 版本校验） | Q-02 缺口 |
| 6 | 子进程终止在 Windows 上的孙进程验证（`taskkill /T` 语义） | Q-02 缺口 |
| 7 | 网络出站限制 | 需求列出，未实现 |
| 8 | 成果内容 DLP（当前只控制"谁收到引用"） | Q-02 缺口 |
| 9 | 登录以外端点的速率限制 | H-13 延伸 |
| 10 | 群记忆语义检索与容量配额 | H-10 延伸 |
