# F-05：独立 appId / 协议 / 数据根 / 更新源及共存测试

**任务 ID：** F-05

**执行日期：** 2026-10-15

**DSH 版本：** `dsh-v0.2.1-alpha.3`（SHA 见 UPSTREAM_LOCK.md）（0.2.1-alpha.3，含本任务补丁）

**证据等级：** **L**（本机真实测试与真实构建）。**未做**：与官方 DSH 同时安装的双应用实测（P 级，需真实安装包）。

## 结论

> **本节于 2026-10-15 更正。** 原结论称身份"完全不相交"，但打包实际读取的模板仍写着官方 appId（且其优先级高于 Fork 默认值），环境变量名也全部共用。详见 [REWORK_BOT_ENTRY_AND_ENV.md](REWORK_BOT_ENTRY_AND_ENV.md)。下表为更正后的状态。

Fork 现在拥有一套与官方产品**不相交**的身份。三处关键值的失败模式都是静默的，因此每一处都有测试固定。

| 值 | 官方 DeepSeek Harness | Workgroup AI Fork | 共享时的失败模式 |
|---|---|---|---|
| appId | `ai.deepseek.harness` | `ai.workgroup.workgroup-ai` | 操作系统视为同一产品；安装/卸载互相覆盖注册 |
| 协议 scheme | `dsh` | `wgai` | 后安装者抢走对方的深链 |
| 默认数据根 | `~/.dsh` | `~/.workgroup-ai` | 两个写入者交错写同一份 Session，**无报错**，只在事后表现为数据不一致 |
| 数据根变量 | `DSH_HOME` | `WORKGROUP_HOME` | 为官方产品导出一个变量会同时搬走本产品的数据 |
| agents 根 | `~/.agents` / `DSH_AGENTS_HOME` | `~/.workgroup-ai-agents` / `WORKGROUP_AGENTS_HOME` | 两个产品互读对方的共享 agent 指令 |
| 受管 shell 命名空间 | `DSH_*` | `WORKGROUP_*` | 一个产品注入的子 shell 事实被另一个读取 |
| 产物名 | `deepseek-harness-…` | `workgroup-ai-…` | 下载文件被误认为官方发行版 |
| 更新通道 | `nightly` / `latest` | **刻意保留**（官方更新协议的预发布开关，改名后更新器无法工作）| — |
| 更新源站与路径前缀 | `download.deepseek.com` / `dsh-desk/` | **未隔离**（见 REWORK 文档"未完成"）| 两个产品读写同一个发布目录 |

环境变量的完整清点与改名范围见 [REWORK_BOT_ENTRY_AND_ENV.md](REWORK_BOT_ENTRY_AND_ENV.md)：382 个变量、5225 处。

## 修改文件

| 文件 | 改动 |
|---|---|
| `application/integrations/product/identity.mjs`（新增） | 产品身份唯一来源：常量、环境覆盖、校验、`resolveDataRoot`、`assertCoexistence` |
| `application/apps/desktop/src/product-identity.ts`（新增） | 从打包后的 app manifest 读取身份，含 Fork 默认回退与非法值拒绝 |
| `application/apps/desktop/scripts/electron-builder-config.mjs` | appId / productName / protocols / artifactName / extraMetadata 取自产品模块 |
| `application/apps/desktop/src/main.ts` | 深链 scheme 改为 `productIdentity.protocol` |
| `application/packages/util/home-paths/src/index.ts` | `DSH_HOME_DIR_NAME` 默认值 `.dsh` → `.workgroup-ai`（**仅默认值**，`DSH_HOME` 覆盖不变） |
| `application/vitest.config.ts` | 测试收录范围加入 `integrations/*/tests/**` |
| `application/integrations/product/tests/identity.spec.ts`（新增） | 14 个测试 |

**未改动**：DSH Agent Loop、Session 格式、插件体系、DS Bot 源码。

## 设计要点

1. **身份只有一处定义。** 打包脚本与运行时都读 `integrations/product/identity.mjs`，因此"安装器注册的 scheme"与"运行时监听的 scheme"不可能不同——那正是这类 Fork 最典型的事故。

2. **`DSH_HOME` 仍然完全有效。** 只改了默认值。这是刻意的：测试台（F-04 的 bench）与运维都靠 `DSH_HOME` 指向临时目录，破坏它会让已有验证失效。

3. **环境变量可改品牌但必须合法。** `WORKGROUP_APP_ID` / `WORKGROUP_PROTOCOL` / `WORKGROUP_PRODUCT_NAME` / `WORKGROUP_DATA_DIR_NAME` 可覆盖，非法值在**构建时报错**而不是产生一个注册不了协议处理器、或把数据写到主目录之外的安装包。数据根名拒绝 `../`、分隔符与非隐藏名。

4. **`DSH_DESKTOP_APP_ID` 仍优先。** 保留上游发布路径可用，但协议与产品名仍走 Fork 值——重新命名的发行版不应认领官方 scheme。

## 真实执行证据

```sh
# F-05 身份与共存测试
$ pnpm vitest run integrations/product packages/util/home-paths
 Test Files  2 passed (2)
      Tests  31 passed (31)

# 构建（确认改动可编译，无类型错误）
$ pnpm run build
 run-gates: 9 passed, 0 failed, 0 skipped in 71.70s.
 build: recorded 321 client artifact(s) with 3 public value(s)
 BUILD_EXIT=0
```

测试覆盖：

- 三项关键值均与官方不同，且各自格式合法（reverse-DNS / URL scheme / 隐藏目录名）。
- `assertCoexistence` 对官方值通过；对**任一**共享值抛出并**指名**是哪一个冲突。
- 环境覆盖生效且被校验；非法 appId、非法 scheme、空白产品名、逃逸数据根名均被拒。
- `resolveDataRoot` 默认落在 Fork 目录；`DSH_HOME`（含空白值）行为不变。
- 运行时身份：打包值被采用、开发态回退到 Fork 默认、非法密封值被拒。
- 打包配置实测返回 `appId`/`productName`/`protocols`/`artifactName`/`extraMetadata`，且 `artifactName` 不含 `deepseek-harness`。

## 顺带修正的上游测试（因身份变化而失效）

Fork 换身份后，上游 6 个测试文件中断言旧值的用例失败。这些是**预期的断言同步**，不是产品缺陷：

| 文件 | 原断言 | 现断言 |
|---|---|---|
| `installer-packaging.spec.ts` | artifactName `deepseek-harness-…` | `workgroup-ai-…` |
| `macos-signature.spec.ts` | protocols `{DeepSeek Harness, dsh}` | `{Workgroup AI, wgai}`；artifactName 同上 |
| `windows-update-publisher.spec.ts` | artifactName `deepseek-harness-…` | `workgroup-ai-…` |
| `welcome-startup.spec.ts` | 深链 `dsh://open` | `wgai://open`（2 处） |
| `home-paths.spec.ts` | 默认根 `.dsh` | `.workgroup-ai`（`expandHomePath` 的纯字符串用例保留 `.dsh`，与产品默认无关） |

**定位方法（可复现）：** 用 `git stash` 回到纯净上游状态运行同一用例，确认失败确实由本次改动引入，而非既有问题。`welcome-startup` 就是这样被定位到 `main.ts` 的协议改动上的。

## desktop 测试现状（诚实记录）

```
Test Files  2 failed | 143 passed | 5 skipped (150)
     Tests  1 failed | 1535 passed | 66 skipped (1602)
```

唯一失败：`windows-cli-signals.spec.ts > delivers SIGINT before process exit`（5s 超时）。

**已用 stash 验证与本次改动无关** —— 在纯净上游状态下同样失败。根因是本机**未安装 MSVC 工具链**（`vswhere` 存在但 `cl.exe` 不存在），该用例需要用 `cl` 编译一个 C++ 控制台探针。这是环境限制，归入 Q-04 的平台环境记录，**不记为产品缺陷，也不记为已通过**。

## 未完成与风险

| 项 | 状态 |
|---|---|
| 与官方 DSH **同时安装**的双应用实测 | **未做**。需要两个真实安装包在同一台机器安装并同时启动，属 P 级证据。当前只有静态与配置级证明 |
| Windows 安装包实际构建 | 未做（需完整打包流程与签名环境） |
| macOS 侧身份验证 | 未做（本机非 macOS） |
| 更新源隔离 | 只改了产物名与 appId；`dshDesktopUpdateChannel` 仍沿用上游字段。真正的更新源隔离需在发布流水线中配置，未在本轮验证 |

**F-05 的完成条件是"可与官方 DSH 同时启动"，该条件需要两个安装包才能实测。** 本轮的结论准确表述为：**身份隔离已在静态配置与运行时解析两层实现并测试通过，双安装共存的实际启动验证仍待 P 级环境。**

## 下一步

F-06（单一 Bot Host 内置/自动加载，不重复初始化），依赖 F-04。
