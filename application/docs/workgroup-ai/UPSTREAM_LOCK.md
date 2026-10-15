# 上游源码锁版记录

**核验日期：** 2026-10-14

**核验机器：** Windows (MINGW64_NT-10.0-26100) / Node v26.7.0 / npm 11.19.0 / pnpm 10.34.5（实际安装用 11.28.5） / Git 2.55.0.windows.2

本文件记录 F-01、F-02 的真实执行结果。所有 SHA 均由 `git rev-parse HEAD` 在本机实际 clone 后读取，未从 README 或网页推断。

## 锁定结果

| 依赖 | Git 地址 | 固定 commit SHA | 版本 | 实测 Node/pnpm | 许可证 |
|---|---|---|---|---|---|
| DSH | https://github.com/deepseek-ai/deepseek-harness | `571902028a75c64c1d767f4ae5fd099485f0ddf0` | 0.2.1-alpha.3 | Node v26.7.0 / pnpm 11.28.5 | MIT |
| DS Bot | https://github.com/Fei2411/DeepSeek-Bot | `ff2ce12b9ff1f09b0223a514d76abea8604e91b2` | 0.1.5 | Node v26.7.0 | Apache-2.0（含 NOTICE） |

DSH 锁定 commit 的提交信息：`Merge pull request #6241 from deepseek-harness/worktree/sync-dsh-0.2.1-alpha.3-to-master`（2026-10-14 21:15:15 +0800）。 DS Bot 锁定 commit 的提交信息：`Merge pull request #186 from Fei2411/docs/collab-rules`（2026-10-14 22:31:15 +0800）。

**为什么不用 tag：** DSH 最新 tag 为 `dsh-v0.2.1-alpha.3`，但 master HEAD 已在其之后包含同步提交；DS Bot 最新 tag 为 `v0.1.5`，而 HEAD 含 `Unreleased` 中的群权限与状态修复。两个上游都处于快速迭代期，锁 HEAD SHA 比锁 tag 更能保证可复现，同时保留完整 Git 历史以便日后 rebase 上游。

## 落位与目录结构

| 内容 | 位置 | 说明 |
|---|---|---|
| DSH 完整工程（含 `.git`、`pnpm-lock.yaml`、`apps/`、`packages/`、`native/`、`vendor/`、`scripts/`、`website/`） | `application/` | 作为 Fork 根，保留上游 Git 历史与工作区约定 |
| DS Bot 包（含 `src/host`、`src/client`、`test/`、`dev/`、`scripts/`），已固化为一等 bundle，包名 `@deepseek-ai/dsh-bot` | `application/packages/bundle/ds-bot/` | 完整包副本，未裁剪；作为工作区成员由 `apps/cli` 依赖解析 |
| DS Bot 嵌套 clone 与仓库级 `LICENSE` / `NOTICE` / `AGENTS`（承载上游 SHA 与差异证据） | `application/integrations/ds-bot/upstream/` | Apache-2.0 归属保留；`ds-bot/` 子目录已移出到 `packages/bundle/ds-bot/` |
| 项目自有应用文档 | `application/docs/workgroup-ai/` | 与 DSH 上游 `docs/` 分离，避免污染上游文档树 |
| 项目自有测试说明 | `application/tests/` | 应用端真实回归 |

`application/` 内 `docs/`、`apps/`、`packages/`、`scripts/` 等均为 DSH 上游原样内容（`packages/bundle/ds-bot/` 为 Fork 新增的工作区成员）。

## Clone 命令（实际执行）

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git dsh
git clone https://github.com/Fei2411/DeepSeek-Bot.git dsbot
```

DSH clone 传输 592989 个对象、约 287 MB；工作区 467 MB（含 308 MB `.git`）。退出码 0。

## 依赖安装与构建（F-03）

```sh
cd application
pnpm install --frozen-lockfile      # 退出码 0，耗时 44.3s，未改动 lockfile
pnpm run build                      # 退出码 0，9 gates 全通过
```

`pnpm install` 使用上游 `pnpm-lock.yaml`（1,079,295 字节），未出现 lockfile 不匹配。

## DS Bot 对 DSH 版本的要求（源码实际声明）

`application/packages/bundle/ds-bot/package.json`（迁移前为上游的 `ds-bot/package.json`，peer 声明保持不变；工作区版本要求四个 peer 同时进 `devDependencies`，包名已改为 `@deepseek-ai/dsh-bot`）：

```json
"peerDependencies": {
  "@deepseek-ai/cordis": "*",
  "@deepseek-ai/dsh-llm": "*",
  "@deepseek-ai/dsh-tools": "*",
  "@deepseek-ai/dsh-web": "*"
},
"dsh": {
  "client": { "platform": "web" },
  "bundle": { "patch": "./cordis.patch.yml" }
}
```

DS Bot 的 peerDependencies 全部为 `*`，未硬性锁定 DSH 版本；但其 `README.zh.md` 徽章声明面向 DSH `0.2.0-rc.2`，而本项目锁定的是 `0.2.1-alpha.3`。**这是一个必须在 F-04 用真实运行验证的兼容性差距**，不得假定自动兼容。

## 未证明事项（继承自 SOURCE_RESEARCH.md，尚未消除）

- 0.2.1-alpha.3 与 DS Bot 0.1.5 的实际运行兼容性 —— F-04 验证中。
- Bot Task Session 是否存在稳定的公开扩展 API。
- 原生 Bot 身份在跨用户 Task Session 中正确继承。

## 发布合规待办

- `application/THIRD_PARTY_NOTICES.md`（DSH 上游生成物，24780 字节）需在内置 DS Bot 后重新生成以纳入 Apache-2.0 依赖。
- 不得使用上游官方商标暗示官方发行，见 DSH 的 `BRAND_GUIDELINES.md`。
