# Desktop Workgroup Hub URL Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复桌面端 `NOT_CONFIGURED`：让桌面 Host 能从用户自己的 Harness-home `.env` 读取 `WORKGROUP_HUB_URL`，同时保留项目 `.env` 不得设置该变量的安全边界，并补齐 macOS 登录 shell、文档、迁移和真实桌面验证。

**Architecture:** 桌面 Host 已经通过 `loadLayeredEnv('dsh')` 读取 `$WORKGROUP_HOME/.env`，但当前 `app-boot` 把所有 `WORKGROUP_*` 都当作 bootstrap-only，连合法的 `WORKGROUP_HUB_URL` 也拒绝；桌面登录 shell 合并又会过滤 `WORKGROUP_*`。本计划只对这两个位置增加精确的 `WORKGROUP_HUB_URL` 例外，不放开整个前缀，也不新增 Hub 配置 UI。`application/.env` 不是桌面配置源；桌面配置统一迁移到 `$WORKGROUP_HOME/.env`。

**Tech Stack:** Node.js 24、TypeScript、Electron Desktop、`@deepseek-ai/dsh-app-boot`、Vitest、现有 Workgroup AI 协议层。

## Context and Root Cause

### 当前错误

桌面端进入 Bot 后显示：

```text
NOT_CONFIGURED: No Hub address is configured.
Set WORKGROUP_HUB_URL to the address your operator gave you
(for example https://hub.intranet.example).
```

错误来自：

```text
application/integrations/workgroup/protocol/hub-client.mjs:475-480
```

```js
const raw = env.WORKGROUP_HUB_URL ?? env.HUB_PUBLIC_URL
if (raw === undefined || String(raw).trim() === '') {
  throw new HubProtocolError('No Hub address is configured...', HUB_ERROR_CODES.NOT_CONFIGURED)
}
```

### 实际调用链

```text
pnpm run dev:desktop
  → Electron main
  → DesktopHostProcess
  → cwd = $WORKGROUP_HOME/profiles/desktop
  → desktop-host/src/index.ts: loadLayeredEnv('dsh')
  → process.env
  → ds-bot/src/host/workgroup-hub.js: resolveHubUrl(process.env)
```

### 三个根因

1. **`application/.env` 不在桌面读取路径**
   - 桌面 Host 的 `cwd` 是 `$WORKGROUP_HOME/profiles/desktop`：
     `application/apps/desktop/src/host-process.ts:198-199`
   - `profile` 路径是 `$WORKGROUP_HOME/profiles/desktop`：
     `application/apps/desktop/src/paths.ts:17-20`
   - 开发模式的 `$WORKGROUP_HOME` 是：
     `application/apps/desktop/.desktop-build/development/home`
     `application/apps/desktop/scripts/dev.ts:66-70`
   - 因此 `loadLayeredEnv` 只读取：
     ```text
     $WORKGROUP_HOME/profiles/desktop/.env
     $WORKGROUP_HOME/.env
     ```
   - `application/.env` 不属于以上任何一个目录。

2. **`app-boot` 拒绝 `WORKGROUP_HUB_URL`**
   - `application/packages/boot/app-boot/src/index.ts:166`
     ```ts
     const BOOTSTRAP_PREFIXES = ['WORKGROUP_', 'DSH_', 'XDG_', 'DYLD_', 'BASH_FUNC_']
     ```
   - `isBootstrapOnly()` 会对所有 `WORKGROUP_*` 返回 true：
     `application/packages/boot/app-boot/src/index.ts:184-186`
   - 因此即使把 `WORKGROUP_HUB_URL` 放进 Harness-home `.env`，当前代码仍会抛错：
     ```text
     dsh: .../.env sets "WORKGROUP_HUB_URL",
     which only the launching environment may set
     ```
   - 这不是路径问题，而是 env 加载策略需要精确例外。

3. **桌面登录 shell 过滤 `WORKGROUP_*`**
   - `application/apps/desktop/src/login-shell-environment.ts:24`
     ```ts
     const LAUNCHER_OWNED_PREFIXES = ['WORKGROUP_', 'DSH_', 'ELECTRON_']
     ```
   - 合并登录 shell 环境时：
     `application/apps/desktop/src/login-shell-environment.ts:103-107`
   - 在 macOS 上，即使用户把变量写进 `~/.zshrc`，从 Finder/Dock 启动时也可能被过滤。
   - Windows 开发模式下，只要变量存在于启动 Electron 的那个进程环境中，通常可以继承；安装包从开始菜单启动时则依赖系统环境变量。

### 已确认的事实

当前开发 home 中不存在：

```text
application/apps/desktop/.desktop-build/development/home/.env
application/apps/desktop/.desktop-build/development/home/profiles/desktop/.env
```

当前 shell 中也没有：

```text
WORKGROUP_HUB_URL is not set
```

开发 home 下没有保存的：

```text
workgroup/hub-config.json
workgroup/installation.json
```

因此没有保存值可以兜底，最终到达 `resolveHubUrl` 的 `process.env` 中没有 URL。

## Global Constraints

- 只修改 `application/` 内的桌面启动、env 加载和文档；不修改 `server/` 的 Hub 协议。
- 不允许项目目录 `.env` 设置 `WORKGROUP_HUB_URL`。项目 `.env` 随仓库分发，放开会把工作群流量重定向到不可信 Hub。
- 只允许 Harness-home `.env` 设置 `WORKGROUP_HUB_URL`；不要放开整个 `WORKGROUP_` 前缀。
- 不新增 Hub 地址设置 UI；应用内仍然不出现 Hub 地址、登录或注册配置。
- 不改变 `WORKGROUP_HOME`、`WORKGROUP_AGENTS_HOME` 等 bootstrap 变量的保护和优先级。
- 不新增依赖；使用 Node 24 已有能力和现有 `app-boot`。
- 不记录、不打印任何 token、密码或 `.env` 中的敏感值；`WORKGROUP_HUB_URL` 本身是非敏感配置。
- 保持现有错误码和用户可见文案，除非本计划明确要求补充路径说明。
- 当前工作区可能有其他改动；执行时只 `git add` 本计划列出的文件，不回滚他人改动。

## Out of Scope

- 不做 Hub 地址自动发现。
- 不做 Hub 地址设置 UI。
- 不把 `application/.env` 变成桌面配置源。
- 不修改 Hub 服务端 `.env` 或 `server/src/`。
- 不调整 `WORKGROUP_HUB_URL` 与 `HUB_PUBLIC_URL` 的现有协议优先级。
- 不处理工作群其他功能（消息、任务、审批、管理端）的独立缺陷。

## File Structure

### Modify

| File | Responsibility |
|---|---|
| `application/packages/boot/app-boot/src/index.ts` | 在 Harness-home 层精确允许 `WORKGROUP_HUB_URL`，项目层继续拒绝 |
| `application/packages/boot/app-boot/tests/app-boot.spec.ts` | 覆盖 home 层接受、project 层拒绝、继承环境优先 |
| `application/apps/desktop/src/login-shell-environment.ts` | 允许登录 shell 提供 `WORKGROUP_HUB_URL`，继续过滤其他 launcher-owned 变量 |
| `application/apps/desktop/tests/login-shell-environment.spec.ts` | 覆盖 Hub URL 通过、其他 `WORKGROUP_*` 继续被过滤 |
| `application/docs/workgroup-ai/APPLICATION_README.md` | 写明桌面端真实配置位置和 `application/.env` 不适用 |
| `application/apps/desktop/README.md` | 英文桌面配置说明 |
| `application/apps/desktop/README.zh.md` | 中文桌面配置说明 |
| `README.md` | 顶层快速开始补充桌面端配置位置 |

### Do Not Modify

- `server/src/**`
- `server/contracts/**`
- `application/packages/bundle/ds-bot/src/host/workgroup-hub.js`
- `application/integrations/workgroup/protocol/hub-client.mjs`
- `application/integrations/workgroup/client/**`

---

## Task 1: Allow `WORKGROUP_HUB_URL` from Harness-home `.env`

**Files:**
- Modify: `application/packages/boot/app-boot/src/index.ts:159-226`
- Test: `application/packages/boot/app-boot/tests/app-boot.spec.ts`

**Interfaces:**
- Consumes: existing `loadLayeredEnv(binName, cwd, warn)` and `readEnvLayer`.
- Produces: `HOME_LAYER_RUNTIME_NAMES` behavior; `WORKGROUP_HUB_URL` may be supplied by the Harness-home `.env`, never by the project `.env`.

- [ ] **Step 1: Write the failing test**

Add this test near the existing `HOME_LAYER_PROXY_NAMES` tests in `application/packages/boot/app-boot/tests/app-boot.spec.ts`:

```ts
it('accepts WORKGROUP_HUB_URL from the Harness-home .env, never from a project .env', () => {
  const home = tmp()
  const project = tmp()
  Reflect.deleteProperty(process.env, 'WORKGROUP_HUB_URL')
  vi.stubEnv('WORKGROUP_HOME', home)
  writeFileSync(join(home, '.env'), 'WORKGROUP_HUB_URL=http://127.0.0.1:8443\n')
  try {
    const snapshot = loadLayeredEnv(NAME, project, vi.fn())
    expect(snapshot.get('WORKGROUP_HUB_URL')).toEqual({
      value: 'http://127.0.0.1:8443',
      source: 'user-env',
      path: join(home, '.env'),
    })
    expect(process.env.WORKGROUP_HUB_URL).toBe('http://127.0.0.1:8443')

    Reflect.deleteProperty(process.env, 'WORKGROUP_HUB_URL')
    writeFileSync(join(project, '.env'), 'WORKGROUP_HUB_URL=http://attacker.example\n')
    expect(() => loadLayeredEnv(NAME, project, vi.fn()))
      .toThrow(/only the launching environment may set/)
  } finally {
    Reflect.deleteProperty(process.env, 'WORKGROUP_HUB_URL')
    vi.unstubAllEnvs()
  }
})
```

Add this second test immediately after it to lock precedence:

```ts
it('lets an exported WORKGROUP_HUB_URL outrank the Harness-home .env', () => {
  const home = tmp()
  const project = tmp()
  writeFileSync(join(home, '.env'), 'WORKGROUP_HUB_URL=http://from-home:8443\n')
  vi.stubEnv('WORKGROUP_HOME', home)
  vi.stubEnv('WORKGROUP_HUB_URL', 'http://from-process:8443')
  try {
    const snapshot = loadLayeredEnv(NAME, project, vi.fn())
    expect(snapshot.get('WORKGROUP_HUB_URL')).toEqual({
      value: 'http://from-process:8443',
      source: 'process',
    })
    expect(process.env.WORKGROUP_HUB_URL).toBe('http://from-process:8443')
  } finally {
    vi.unstubAllEnvs()
  }
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run from `application/`:

```bash
npx vitest run packages/boot/app-boot/tests/app-boot.spec.ts
```

Expected: the new home-layer test fails with a message containing:

```text
sets "WORKGROUP_HUB_URL", which only the launching environment may set
```

Do not implement yet.

- [ ] **Step 3: Implement the home-layer allowlist**

In `application/packages/boot/app-boot/src/index.ts`, add a constant next to `HOME_LAYER_PROXY_NAMES`:

```ts
/**
 * Runtime configuration the Harness-home `.env` may set.
 *
 * `WORKGROUP_` is otherwise bootstrap-only: `WORKGROUP_HOME` must not be
 * relocatable by a discovered file. `WORKGROUP_HUB_URL` is not a bootstrap
 * fact; it is the user's Hub address and belongs in the user's own home file.
 */
const HOME_LAYER_RUNTIME_NAMES = new Set(['WORKGROUP_HUB_URL'])
```

Replace the `readEnvLayer` validation block:

```ts
  // Parse once so validation and materialization use exactly the same entries.
  const values = parseEnv(content) as Record<string, string>
  for (const name of Object.keys(values)) {
    const upper = name.toUpperCase()
    if (!isBootstrapOnly(name)) continue
    const proxyName = HOME_LAYER_PROXY_NAMES.has(upper)
    const homeRuntime = HOME_LAYER_RUNTIME_NAMES.has(upper)
    const homeOnly = proxyName || homeRuntime
    if (isHome && homeOnly) continue
    // A home-only name has a second way out that other bootstrap names do not.
    const remedy = homeOnly
      ? `export ${name}, or put it in ${resolve(home, '.env')}, which is the user's own file`
      : `export ${name} instead of putting it in a .env file`
    throw new Error(
      `${binName}: ${path} sets "${name}", which only the launching environment may set`
      + ' (it decides how this process starts, where its code and instructions load from, or how it'
      + ` reaches the network); ${remedy}`,
    )
  }
```

Update the JSDoc above `readEnvLayer` so it says the Harness-home file accepts proxies and the Hub URL, while the project layer accepts neither.

- [ ] **Step 4: Run the test and verify it passes**

Run from `application/`:

```bash
npx vitest run packages/boot/app-boot/tests/app-boot.spec.ts
```

Expected: all tests pass, including the two new cases. The suite should report a passing count increased by 2.

- [ ] **Step 5: Commit**

```bash
git add application/packages/boot/app-boot/src/index.ts \
  application/packages/boot/app-boot/tests/app-boot.spec.ts
git commit -m "fix(app-boot): allow WORKGROUP_HUB_URL from the home env layer"
```

---

## Task 2: Allow `WORKGROUP_HUB_URL` through Desktop login-shell environment

**Files:**
- Modify: `application/apps/desktop/src/login-shell-environment.ts:16-24,98-110`
- Test: `application/apps/desktop/tests/login-shell-environment.spec.ts`

**Interfaces:**
- Consumes: `mergeLoginShellEnvironment(base, shell)`.
- Produces: `WORKGROUP_HUB_URL` from a login shell is retained; all other `WORKGROUP_*` launcher-owned names remain filtered.

- [ ] **Step 1: Write the failing test**

Add this test inside `describe('mergeLoginShellEnvironment', ...)` in `application/apps/desktop/tests/login-shell-environment.spec.ts`:

```ts
it('lets WORKGROUP_HUB_URL through while filtering other WORKGROUP_ names', () => {
  const merged = mergeLoginShellEnvironment({}, {
    PATH: '/login/bin:/usr/bin',
    WORKGROUP_HUB_URL: 'http://127.0.0.1:8443',
    WORKGROUP_HOME: '/rc-home',
    WORKGROUP_DESKTOP_DSH_DIR: '/rc',
    ELECTRON_RUN_AS_NODE: '1',
  })
  expect(merged).toEqual({
    PATH: '/login/bin:/usr/bin',
    WORKGROUP_HUB_URL: 'http://127.0.0.1:8443',
  })
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run from `application/`:

```bash
npx vitest run apps/desktop/tests/login-shell-environment.spec.ts
```

Expected: the new test fails because `WORKGROUP_HUB_URL` is currently filtered by the `WORKGROUP_` prefix.

- [ ] **Step 3: Implement the exact-name exception**

In `application/apps/desktop/src/login-shell-environment.ts`, replace the launcher-owned comment and constant with:

```ts
/**
 * Variables that describe the launching shell rather than user configuration.
 *
 * Both products' prefixes are excluded: `WORKGROUP_` is this fork's managed namespace,
 * and `DSH_` stays refused so an installed official harness's shell facts cannot be
 * adopted. `WORKGROUP_HUB_URL` is the one non-bootstrap exception: it is the user's
 * Hub address, not a path or process-startup fact.
 */
const LAUNCHER_OWNED_PREFIXES = ['WORKGROUP_', 'DSH_', 'ELECTRON_'] as const
const LOGIN_SHELL_ALLOWED_NAMES = new Set(['WORKGROUP_HUB_URL'])
```

Replace the loop in `mergeLoginShellEnvironment`:

```ts
for (const [key, value] of Object.entries(shell)) {
  const launcherOwned = LAUNCHER_OWNED_PREFIXES.some(prefix => key.startsWith(prefix))
    && !LOGIN_SHELL_ALLOWED_NAMES.has(key.toUpperCase())
  if (SHELL_SESSION_KEYS.has(key) || launcherOwned) continue
  merged[key] = value
}
```

Do not remove the `WORKGROUP_` prefix filter; the exception must be exact.

- [ ] **Step 4: Run the test and verify it passes**

Run from `application/`:

```bash
npx vitest run apps/desktop/tests/login-shell-environment.spec.ts
```

Expected: all tests pass; the new case proves `WORKGROUP_HUB_URL` survives while `WORKGROUP_HOME` and `WORKGROUP_DESKTOP_DSH_DIR` do not.

- [ ] **Step 5: Commit**

```bash
git add application/apps/desktop/src/login-shell-environment.ts \
  application/apps/desktop/tests/login-shell-environment.spec.ts
git commit -m "fix(desktop): allow WORKGROUP_HUB_URL from the login shell"
```

---

## Task 3: Document the real Desktop config location and migrate local setup

**Files:**
- Modify: `application/docs/workgroup-ai/APPLICATION_README.md:17`
- Modify: `application/apps/desktop/README.md`
- Modify: `application/apps/desktop/README.zh.md`
- Modify: `README.md:30`

**Interfaces:**
- No code interface. This task establishes one rule:
  - Desktop reads `$WORKGROUP_HOME/.env`.
  - `application/.env` is not a desktop config source.
  - Installed app uses the default home `~/.workgroup-ai` unless `WORKGROUP_HOME` is set.

- [ ] **Step 1: Add the desktop configuration section to `APPLICATION_README.md`**

Replace the existing sentence at `application/docs/workgroup-ai/APPLICATION_README.md:17` with:

````markdown
首次启动有 Chief；DSH 一级导航“插件”正下方只有 Bot。进入 Bot 后才能看到原版内部功能，“创建群聊”下方增加“创建工作群聊”。Hub 地址由启动环境或 `$WORKGROUP_HOME/.env` 中的 `WORKGROUP_HUB_URL` 提供，应用内不出现 Hub 地址、登录或注册配置；首次进入 Bot 自动完成匿名快速认证。原版私聊和普通群仍可用。

### 桌面端 Hub 地址

桌面端不读取 `application/.env`，也不允许项目目录的 `.env` 设置 `WORKGROUP_HUB_URL`。桌面 Host 只从用户自己的 Harness-home 读取：

```text
开发模式：
  application/apps/desktop/.desktop-build/development/home/.env

安装包（Windows）：
  %USERPROFILE%\.workgroup-ai\.env

安装包（macOS/Linux）：
  ~/.workgroup-ai/.env
```

如果设置了 `WORKGROUP_HOME`，使用 `$WORKGROUP_HOME/.env`。文件内容示例：

```env
WORKGROUP_HUB_URL=http://127.0.0.1:8443
```

修改后必须完全退出并重启 Desktop。`127.0.0.1` 只适用于 Hub 与 Desktop 在同一台机器；跨机器请填写 Hub 的局域网地址。
````

- [ ] **Step 2: Add the same section to the Desktop README files**

Add a short English section to `application/apps/desktop/README.md`:

````markdown
## Hub URL configuration

The Desktop Host reads `$WORKGROUP_HOME/.env`, not `application/.env`.

- Development: `apps/desktop/.desktop-build/development/home/.env`
- Installed Windows: `%USERPROFILE%\.workgroup-ai\.env`
- Installed macOS/Linux: `~/.workgroup-ai/.env`

```env
WORKGROUP_HUB_URL=http://127.0.0.1:8443
```

Restart the whole Desktop process after changing it. `127.0.0.1` only works when the Hub is on the same machine.
````

Add the equivalent Chinese section to `application/apps/desktop/README.zh.md`:

````markdown
## Hub 地址配置

Desktop Host 读取 `$WORKGROUP_HOME/.env`，不读取 `application/.env`。

- 开发模式：`apps/desktop/.desktop-build/development/home/.env`
- Windows 安装包：`%USERPROFILE%\.workgroup-ai\.env`
- macOS/Linux 安装包：`~/.workgroup-ai/.env`

```env
WORKGROUP_HUB_URL=http://127.0.0.1:8443
```

修改后必须完全退出并重启 Desktop。`127.0.0.1` 只适用于 Hub 与 Desktop 在同一台机器。
````

- [ ] **Step 3: Clarify the top-level README**

At `README.md:30`, replace:

```markdown
3. 管理员通过安装包/启动环境注入 `WORKGROUP_HUB_URL`；应用首次进入 Bot 时自动匿名快速认证，应用内不提供 Hub 地址、登录或注册配置。不同员工通过工作群交换消息，但所有实际 Bot 操作仍在任务所有人本地执行。
```

with:

```markdown
3. 管理员通过安装包/启动环境或用户自己的 `$WORKGROUP_HOME/.env` 设置 `WORKGROUP_HUB_URL`；应用首次进入 Bot 时自动匿名快速认证，应用内不提供 Hub 地址、登录或注册配置。`application/.env` 不是桌面端配置源。不同员工通过工作群交换消息，但所有实际 Bot 操作仍在任务所有人本地执行。
```

- [ ] **Step 4: Check that the docs contain the required paths and do not imply `application/.env` works**

Run from repository root:

```bash
grep -n "WORKGROUP_HUB_URL\|application/.env\|\.workgroup-ai" README.md \
  application/docs/workgroup-ai/APPLICATION_README.md \
  application/apps/desktop/README.md \
  application/apps/desktop/README.zh.md
```

Expected: all four files contain the new configuration wording; the docs explicitly say `application/.env` is not the Desktop source.

- [ ] **Step 5: Migrate the current local development configuration (do not commit this file)**

After Task 1 is implemented, create:

```text
application/apps/desktop/.desktop-build/development/home/.env
```

with:

```env
WORKGROUP_HUB_URL=http://127.0.0.1:8443
```

Do not put this file in Git. The development home is under `.desktop-build/`, which is a build directory; it is local state, not source.

Before Task 1 is merged, the temporary alternatives are:

- Export the variable in the shell that launches Desktop:
  ```powershell
  $env:WORKGROUP_HUB_URL = "http://127.0.0.1:8443"
  pnpm run dev:desktop
  ```
- Or use the supported fallback name in the same Harness-home `.env`:
  ```env
  HUB_PUBLIC_URL=http://127.0.0.1:8443
  ```

Do not add `WORKGROUP_HUB_URL` to `application/.env` and expect Desktop to use it.

- [ ] **Step 6: Commit the documentation**

```bash
git add README.md \
  application/docs/workgroup-ai/APPLICATION_README.md \
  application/apps/desktop/README.md \
  application/apps/desktop/README.zh.md
git commit -m "docs(desktop): document the Hub URL configuration location"
```

---

## Task 4: End-to-end verification with a real Hub and a real Desktop process

**Files:**
- No source changes.
- Local runtime only:
  - `server/.env`
  - `application/apps/desktop/.desktop-build/development/home/.env`

- [ ] **Step 1: Start the Hub with the local env file**

From `server/`, use `--env-file`; `npm start` alone does not load `.env`:

```bash
cd server
node --env-file=.env src/index.js
```

Expected startup includes a listening line for `127.0.0.1:8443` and the process remains running.

Keep this terminal open.

- [ ] **Step 2: Confirm the Hub is healthy**

In a second terminal:

```bash
curl http://127.0.0.1:8443/api/v1/health/live
```

Expected: HTTP 200 with `status: "ok"`.

- [ ] **Step 3: Verify the Desktop process does not inherit a Hub URL from the shell**

Open a clean PowerShell window and check:

```powershell
if ($env:WORKGROUP_HUB_URL) { Write-Output "UNEXPECTED: inherited from shell" } else { Write-Output "clean: no shell override" }
```

Expected: `clean: no shell override`.

Do not use the temporary `HUB_PUBLIC_URL` fallback for this test; the point is to prove the new `WORKGROUP_HUB_URL` home-layer path works.

- [ ] **Step 4: Ensure the development home file exists**

```text
application/apps/desktop/.desktop-build/development/home/.env
```

Content:

```env
WORKGROUP_HUB_URL=http://127.0.0.1:8443
```

- [ ] **Step 5: Start Desktop from the clean PowerShell window**

```powershell
cd D:\code\ai\DeepSeek-Bot\Workgroup-AI\application
pnpm run dev:desktop
```

Expected:

- Desktop starts normally.
- Entering Bot does not show `NOT_CONFIGURED`.
- The workgroup entry is available.
- Creating a workgroup creates a room on the Hub.

- [ ] **Step 6: Verify the room exists on the Hub**

Open:

```text
http://127.0.0.1:8443/admin/
```

Log in with the local demo operator, then confirm the newly created workgroup appears in the workgroup list.

If the Hub is on another machine, use its LAN address instead of `127.0.0.1` and ensure the Hub binds to an interface reachable from the Desktop machine.

- [ ] **Step 7: Verify the packaged-app path**

For an installed build:

```text
Windows: %USERPROFILE%\.workgroup-ai\.env
macOS/Linux: ~/.workgroup-ai/.env
```

Create the file with `WORKGROUP_HUB_URL`, fully quit the installed app, and launch it again. Expected: no `NOT_CONFIGURED`.

- [ ] **Step 8: Record evidence**

Record:

- Hub startup command and health response;
- Desktop command and the fact that the shell had no `WORKGROUP_HUB_URL`;
- the development home `.env` path (not its secret content, if any);
- the absence of `NOT_CONFIGURED`;
- the created workgroup name/id shown in `/admin/`.

Do not record tokens, passwords, or private message bodies.

---

## Task 5: Regression checks and completion

**Files:**
- No additional source changes.

- [ ] **Step 1: Run the focused app-boot suite**

From `application/`:

```bash
npx vitest run packages/boot/app-boot/tests/app-boot.spec.ts
```

Expected: pass; the suite includes the new home-layer acceptance, project-layer rejection, and inherited precedence tests.

- [ ] **Step 2: Run the focused desktop environment suite**

From `application/`:

```bash
npx vitest run apps/desktop/tests/login-shell-environment.spec.ts
```

Expected: pass; the new login-shell test passes and existing launcher-owned filtering still passes.

- [ ] **Step 3: Run the workgroup provider regression tests**

From `application/`:

```bash
npx vitest run integrations/workgroup/tests/a11-hub-provider.spec.ts integrations/workgroup/tests/a14-hub-settings.spec.ts
```

Expected: pass. This confirms the existing Hub URL resolution and settings wiring were not changed.

- [ ] **Step 4: Check the diff**

From repository root:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only the files listed in this plan are changed, plus any intentional local `.env` files that must not be staged.

- [ ] **Step 5: Close the plan**

This task is verification-only; Task 1, Task 2, and Task 3 already created the required commits. Do not create an empty commit. If Task 4 required a correction to the top-level README only, commit that file with:

```bash
git add README.md
git commit -m "docs(desktop): correct the Hub URL migration note"
```

Do not commit local `.env` files.

---

## Acceptance Checklist

- [ ] `WORKGROUP_HUB_URL` in `$WORKGROUP_HOME/.env` is accepted by `loadLayeredEnv`.
- [ ] `WORKGROUP_HUB_URL` in a project `.env` is still rejected.
- [ ] An exported `WORKGROUP_HUB_URL` still outranks the home file.
- [ ] `WORKGROUP_HUB_URL` from a macOS login shell survives `mergeLoginShellEnvironment`.
- [ ] Other `WORKGROUP_*` names remain launcher-owned and filtered.
- [ ] `application/.env` is documented as not a Desktop source.
- [ ] Development and installed-app configuration paths are documented.
- [ ] A clean-shell Desktop run using only the development home `.env` no longer shows `NOT_CONFIGURED`.
- [ ] A workgroup created from Desktop appears in the Hub admin workgroup list.
- [ ] Existing app-boot and workgroup provider tests still pass.

## Risks and Decisions

| Risk / Decision | Mitigation |
|---|---|
| Allowing `WORKGROUP_HUB_URL` from project `.env` could let a cloned repository redirect workgroup traffic. | Allow only from Harness-home `.env`; keep project-layer rejection and test it. |
| Removing the whole `WORKGROUP_` login-shell filter could let `WORKGROUP_HOME` or desktop launcher settings be overwritten. | Add an exact `LOGIN_SHELL_ALLOWED_NAMES` exception; keep prefix filtering for all other names. |
| Existing users have the URL only in `application/.env`. | Document migration; do not silently load project `.env`. |
| Packaged app launched from a shortcut may not inherit shell variables. | Use `$WORKGROUP_HOME/.env`; after Task 1 this works without OS-level environment changes. |
| A saved `hub-config.json` or `installation.json` may outrank the new home `.env`. | Document the existing precedence; this plan only fixes the missing-config path. |
| Hub on a different machine cannot be reached through `127.0.0.1`. | Use the Hub LAN address and bind the Hub to a reachable interface. |
| Running Hub from `npm start` does not load `server/.env`. | Validate with `node --env-file=.env src/index.js`; this is an existing server startup constraint, not part of this fix. |

## Execution Notes

- Task 1 and Task 2 are independent code changes but should be committed separately.
- Task 3 documents the new behavior and must not be merged before the code change if the docs claim `.env` works.
- Task 4 is a manual acceptance step, not a unit test; record the actual commands and visible result.
- Do not modify `server/` in this plan.
- Do not add a third Hub configuration UI or a second config file format.

## Execution Record (2026-10-18)

- Task 1 completed in `1dd44117`; `app-boot` suite: 85/85 passed.
- Task 2 completed in `3a087732`; desktop login-shell suite: 17 passed, 5 skipped.
- Task 3 completed in `7832e5e4` and `e3fc1dc1`; local development home `.env` created at `application/apps/desktop/.desktop-build/development/home/.env` and ignored by Git.
- Task 4 partially verified: the real development home `.env` was loaded as `user-env`, `resolveHubUrl` returned `http://127.0.0.1:8443/api/v1`, and the Hub health endpoint returned HTTP 200. A real Electron GUI launch was not executed in this tool session; no background job or GUI controller was available.
- Task 5 verification: `npx vitest run integrations/workgroup/tests/a11-hub-provider.spec.ts integrations/workgroup/tests/a14-hub-settings.spec.ts` passed 16/16; `npx tsc -b apps/desktop/tsconfig.host.json --pretty false` passed. The full `pnpm run typecheck` is blocked by an unrelated baseline Typert path error under `packages/interaction/permission-presets`. The full `pnpm run test:docs` is blocked by pre-existing translation-pairing, package README, archived-note, and doc-standard timeout failures; `markdown wrap`, links, type-equivalence, and budgets passed. No new concrete-terms finding was reported for the changed docs.
- Acceptance items requiring a real Desktop click-through remain open: the visible `NOT_CONFIGURED` disappearance, workgroup creation from the UI, and appearance in `/admin/`.

## Plan Self-Check

- Spec coverage: root cause, home-layer allowlist, project-layer rejection, macOS shell, docs, migration, tests, and E2E are each mapped to a task.
- Placeholder scan: no TBD/TODO/unwritten test or implementation steps.
- Interface consistency: `HOME_LAYER_RUNTIME_NAMES`, `HOME_LAYER_PROXY_NAMES`, `LOGIN_SHELL_ALLOWED_NAMES`, and `mergeLoginShellEnvironment` names are used consistently across tasks.
