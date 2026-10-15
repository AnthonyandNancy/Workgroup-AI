# F-03 / F-04 验证记录与证据

**执行日期：** 2026-10-14

**机器：** Windows 11 (MINGW64_NT-10.0-26100) / Node v26.7.0 / pnpm 11.28.5 / Git 2.55.0.windows.2 / Chrome（本机已装）

**DSH 版本：** `dsh-v0.2.1-alpha.3`（SHA 见 UPSTREAM_LOCK.md）（0.2.1-alpha.3）

**DS Bot 版本：** `v0.1.5`（SHA 见 UPSTREAM_LOCK.md）（ds-bot 0.1.5）

证据等级按 `ACCEPTANCE.md`：**L** = 单电脑真实端到端。本文件全部为 L 级或 M 级，无 N 级（双机）与 P 级（跨平台打包）结论。

---

## F-03：构建 DSH Desktop/Web/Host 并运行官方测试

### 执行命令与结果

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm install --frozen-lockfile` | 0 | 44.3s，未改动 `pnpm-lock.yaml` |
| `pnpm run build` | 0 | 9 gates 全通过，194.84s，记录 321 个 client artifact |
| `pnpm test`（全量） | 1 | 41467 passed / 126 failed / 260 skipped（2012 文件，3006s） |
| `pnpm vitest run packages/core packages/host packages/session packages/core/agent` | 1 | 4419 passed / 2 failed（均为 5s 超时） |
| `pnpm vitest run packages/workflow packages/guard packages/sandbox` | 1 | 428 passed / 14 failed |

### 失败性质判定（重要，不得记为 PASS 也不得记为产品缺陷）

**已证实为 Windows 主机环境限制，非本 Fork 改动引起：**

1. `packages/core/agent-default-model` 的 2 个失败在**隔离重跑时全部通过**（3/3 passed，退出码 0）。这是高并发下的 5s 测试超时（vitest 配置 `testTimeout: 5000`），属 flaky。
2. `packages/workflow/workflow-ptc`、`packages/guard`、`packages/sandbox` 的失败根因是 `EPERM: operation not permitted, lstat 'D:\'`（7 次）。 MSYS/MinGW 下 Node 无法 `lstat` 盘符根目录，导致 `realpathSync` → ESM `finalizeResolution` 抛错、worker 进程退出（`worker-exit`）。这发生在 DSH 自己的工作流沙箱测试里，与 DS Bot 或本项目的集成代码无关。

**未在本轮消除的不确定性：** 完整 126 个失败中只有上述两类被定位。其余失败分布未逐一归类。**不得声称“DSH 官方测试全部通过”**；准确表述是：构建 9/9 通过；核心包实测 4433 项中 4419 通过，2 项失败已证明为隔离可复现的并发超时；沙箱/工作流类失败的已定位根因是 Windows 盘符 `lstat` EPERM。

### 构建产物

- `pnpm run build` 记录的 client artifact：321 个。
- Desktop bundle、Host bundle、Web build、native addon 四个 gate 均 PASS。

---

## F-04：在真实 DSH 中安装并运行原版 DS Bot

### 验证环境搭建（Windows 无 `setsid`，按 `dev/bench.sh` 等价步骤手工搭建）

#### 1. profile

`integrations/ds-bot/upstream/.dsh-test-f04/profiles/web/package.json`（该 bench 目录随嵌套 clone 保留在 `upstream/` 下）以 `link:` 指向本仓库内的 `packages/bundle/ds-bot`，bundles 为 `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@deepseek-ai/dsh-bot"]`（迁移后；当时为裸包名 `ds-bot`，正是本文件之后暴露的解析缺陷）。`DSH_HOME` 指向 bench 目录，未触碰用户真实的 `~/.dsh`。

#### 2. overlay

等价写入 `bench.patch.yml`，设置 `bot.checkRatio=0.45` 与 `llm-deepseek` 的 `contextWindow=100000`、`maxTokens=8000`。

#### 3. mock 模型

命令：`node dev/mock-llm.mjs`，`MOCK_PORT=8981`。

#### 4. DSH Web

```
DSH_HOME=<bench> DEEPSEEK_BASE_URL=http://127.0.0.1:8981/v1 DEEPSEEK_API_KEY=mock-key \
  node --import tsx/esm apps/cli/src/bin.ts --profile web \
  --patch apps/web/tests/pin-browse-picker.overlay.yml \
  --patch <bench>/bench.patch.yml --no-open --port 3180
```

8 秒内输出 `dsh web: http://127.0.0.1:3180/?token=…`，真实监听。

### 证据 1：DS Bot 官方 smoke（API 级真实端到端）

命令：

```sh
node dev/smoke.mjs f04 3180 --out <transcript>
```

**结果：`smoke: all 40 steps passed`（退出码 0）**

覆盖并实测通过的关键流程（原样摘录步骤名）：

| 能力 | 实测步骤 |
|---|---|
| Chief 初始化 | `bootstrap: Chief waits for a model`、`user picks a model; Chief greets and asks in its reply` |
| 创建下属 Bot | `Chief creates Writer, who replies`、`user creates Coder, who keeps the default model` |
| 私人聊天 | `Writer answers in its private chat`（UI 检查）、`Writer writes long reply 1/2/3` |
| 普通群聊 | `Chief creates a group`、`user talks in the group`、`admin calls everyone`、`Chief posts to the group`、`Chief sets the group notice`、`Chief reads the group`、`delete the group` |
| Bot 间接力 | `exchange log between Chief and Writer` |
| 上下文管理 | `Writer searches its own chat across parts`、`earlier part pages load`、`Writer condensed in place, not switched`、`Writer finds a condensed message` |
| 工作目录 | `Coder works in a folder of its own`、`Coder answers from its folder`、`Coder goes back to the team workspace` |
| 主 Bot 角色 | `make Coder a Main Bot and back`、`duplicate Coder` |
| 能力（MCP/技能） | `Chief sees its attached MCP and skill`、`Chief first group turn sees its attached MCP and skill`、`Coder does not inherit Chief capabilities`、`detached capabilities disappear from Chief` |

**关键结论：`Coder does not inherit Chief capabilities` 实测通过 —— Chief 与下属 Bot 的能力隔离在真实运行中成立。**

### 证据 2：真实浏览器 UI 检查

命令：

```sh
CHROME_BIN="<chrome>" node tests/app-f04-ui-check.mjs <dsh-repo> f04 3180 <out-dir>
```

**结果：`f04 ui: 15/15 checks passed`（退出码 0）**

| # | 检查项 | 结果 |
|---|---|---|
| 1 | DS Bot 团队侧边栏在 dsh Web 内渲染（`.bt-row` / `.bt-tile` 出现） | PASS |
| 2 | Chief 出现在 Bot 列表 | PASS |
| 3 | `state.json` 中存在真实 Chief Bot | PASS |
| 4 | Chief 解析出 Session id | PASS |
| 5 | 第二个 Bot（Writer）存在 | PASS |
| 6 | 存在包含 2 个 Bot 成员的普通群聊 | PASS |
| 7 | Chief 私人聊天显示 DSH composer | PASS |
| 8 | 私人聊天用 DS Bot 自己的消息气泡渲染（`.bt-msg`） | PASS |
| 9 | 英文界面下 conversation-details 控件存在 | PASS |
| 10 | 详情面板显示模型选择器 | PASS |
| 11 | 模型选择器给出模型名（`deepseek-v4-pro`） | PASS |
| 12 | 普通群聊显示 DSH composer | PASS |
| 13 | 普通群聊渲染消息历史 | PASS |
| 14 | 侧边栏 "new" 控件存在 | PASS |
| 15 | **原版 "Create group chat" 入口可从 new 菜单触达** | PASS |

第 15 项是 F-07/F-08 的前置事实：**原版“创建群聊”位于侧边栏 “new” 弹出菜单中**。

### 证据 3：截图

| 截图 | 内容 |
|---|---|
| `f04-01-team.png` | DS Bot 团队界面（Chief tile、Writer/Coder 行、群聊行、Connect plugins） |
| `f04-02-chief-chat.png` | Chief 私人聊天，含 DSH composer（`Message Chief`） |
| `f04-03-details.png` | 详情面板展开：Model `deepseek-v4-pro`、Permissions `Read…`、Working `Team`、Memory、Usage、Schedule |
| `f04-04-group-chat.png` | 普通群聊 |
| `f04-05-new-menu.png` | new 菜单，可见原版 “Create group chat” |

---

## 真实发现的兼容性问题（必须在后续任务处理）

1. **DS Bot 0.1.5 的客户端 bundle 需要 esbuild 安装脚本获批** `npm install` 默认拦截 `esbuild@0.28.2` 的 postinstall，导致 `client.js` 无法构建、 `client-bundle.test.js` 等 6 个测试失败。执行 `npm install-scripts approve esbuild` 并 `npm run build` 后恢复。**CI/打包脚本必须显式处理这一步**，否则干净环境构建会失败。

2. **DS Bot 与 DSH 的版本差：DS Bot README 徽章声明面向 DSH `0.2.0-rc.2`，本项目锁定 `0.2.1-alpha.3`** 在 0.2.1-alpha.3 上 40/40 smoke 与 15/15 UI 实测通过，兼容性在本机得到真实验证； 但 DS Bot 自身单测有 2 项失败与版本差无关（见下条），此处记录为已实测兼容，未做长期承诺。

3. **DS Bot 自身单测：544 项中 542 通过，2 项失败**
   - `test/at-menu.test.js`：`Cannot find package '@deepseek-ai/dsh-session-reference'`。 该包位于 DSH `packages/context/session-reference`，仅被 `@deepseek-ai/dsh-web-app` 声明，未链接进 `packages/bundle/base` 的解析路径；DS Bot 的 `test/harness-resolve.mjs` 把 `@deepseek-ai/*` 解析锚点指向 base bundle，因此找不到。 **这是 DS Bot 测试 harness 对 DSH 安装布局的假设，不是运行时缺陷** —— 真实 Web 运行未报此错。
   - `test/dsh-update.test.js` 的 `without a running version there is nothing to compare against`： 期望 `current === null`，实测为 `'0.2.1-alpha.3'`。DS Bot 的 `currentDsh()` 在 loader 路径不可见时会向上查找最近的 `@deepseek-ai` `package.json`，在 workspace 布局下 找到了真实 DSH 版本。属测试对“非 profile 安装布局”的假设差异。

4. **DS Bot 的 `dev/ui-shots.mjs` 假设英文界面** 本机 Chrome 为中文，`aria-label` 被本地化为“查看对话详情”，脚本在 `getByRole('button', { name: 'View conversation details' })` 处超时； 且 Playwright 不能直接执行 `.sh`/`.cmd` 包装器（`spawn EFTYPE`）。 本项目用 `tests/app-f04-ui-check.mjs` 以 `locale: 'en-US'` 直接驱动 Chromium 规避， 后续 F-07/F-08 的 UI 自动化沿用同一方式。

---

## 本阶段未完成、需后续任务解决

| 项 | 状态 | 归属 |
|---|---|---|
| Desktop (Electron) 真实启动与截图 | 未做 | F-03 补充 / Q-04 |
| macOS 构建 | 未做（本机非 macOS） | Q-04 |
| 双电脑真实协作 | 未做 | Q-01/Q-05（N 级证据） |
| Session Log 删除入口核查 | 未做 | F-10 |
| Task Session 身份持久化 | 未做 | F-11 |
| 目录 realpath 校验与拒绝回退 | 未做 | F-12 |
