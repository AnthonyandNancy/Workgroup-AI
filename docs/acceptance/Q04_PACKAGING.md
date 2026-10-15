# Q-04：Windows / macOS 安装与 server-only Linux 发布 —— **部分 PASS / macOS BLOCKED**

| 字段 | 内容 |
|---|---|
| 任务 ID | Q-04 |
| 状态 | **Windows 与 Linux 部分 PASS；macOS 部分 BLOCKED**（项目自身拒绝在非 macOS 主机上打包） |
| 验收条件 | 签名/构建/环境记录 |
| 证据等级 | Windows 构建 **P 级部分**（真实构建通过，未产出签名安装包）；Linux 服务器发布 **L 级**（真实 Linux 容器与 systemd） |

## 三部分的实际结论

### 1. server-only Linux 发布 —— **PASS**

见 `server/docs/H13_DEPLOYMENT_DELIVERY.md` 与 `server/docs/evidence/h13/`：

- 真实 Linux（Debian 13 + systemd 作为 PID 1）与真实容器（`node:24-alpine`）**双路线**跑通
- 镜像内**无 DSH / DS Bot / Electron**，`node_modules` 无三者，Hub 进程环境无模型 API Key
- 干净主机：迁移、健康检查、systemd 加固（实测 `ProtectSystem=strict` 生效）、计划备份、
  总量损毁恢复、附件字节往返
- 部署自检 `hub deploy-check` 在容器内通过

### 2. Windows 构建 —— **构建 PASS，安装包未产出**

```bash
cd application && npx tsx scripts/build.ts --scope artifacts
# → run-gates: 7 passed, 0 failed, 0 skipped in 78.11s
# → build: recorded 321 client artifact(s) with 3 public value(s)
```

真实 Windows 主机上完整构建通过（Host bundle、Desktop bundle、client compiler、Client bundle、Web build）。

**未产出安装包的原因**：`package-target.ts` 在任何变体（含 `--unsigned`）下都要求
`apps/desktop/.env.windows`，其中包含**发布基础设施**的取值（强制更新源、测试发布 ID 等）。
用占位值能生成文件，但那会是一个更新源不可用的**坏产物**，而不是一个已验证的发布物——
因此不生成，如实记为未完成，而不是产出一个看起来成功的空壳。

**解除条件**：提供发布基础设施取值（更新源 origin、`DOWNLOAD_TEST_RELEASE_ID`），
并可选择提供签名凭据（`secrets/windows-signing.env`）。

### 3. macOS 打包 —— **BLOCKED**

项目自身在代码里拒绝，不是本机"懒得试"：

```bash
$ npx tsx apps/desktop/scripts/package-target.ts mac-arm64 --dir
Error: desktop package: mac-arm64 requires a macOS build host
```

```
# apps/desktop/scripts/package-target.ts
if (target.platform === 'darwin' && hostPlatform !== 'darwin') {
  throw new Error(`desktop package: ${name} requires a macOS build host`)
}
if (name === 'mac-arm64' && hostArch !== 'arm64') {
  throw new Error('desktop package: mac-arm64 requires an Apple Silicon build host')
}
```

**解除条件**：
- `mac-x64`：一台 Intel Mac（或装了 Rosetta 的 Apple Silicon）
- `mac-arm64`：一台 **Apple Silicon** Mac
- 签名：`secrets/macos-signing.env`（证书、notarization 凭据）

## 身份与共存（F-05 的打包侧核对）

打包配置已把 fork 自己的身份写进 `extraMetadata`，运行时的 `product-identity.ts` 读同一组字段：

| 项 | 值 | 与上游的关系 |
|---|---|---|
| appId | `ai.workgroup.workgroup-ai` | ≠ `ai.deepseek.harness` |
| 深链协议 | `wgai` | ≠ `dsh`（否则谁后装谁劫持对方链接） |
| 数据根目录名 | `.workgroup-ai` | ≠ `.dsh`（否则两个写入方互相破坏会话） |
| productName | `Workgroup AI` | 决定 Electron `app.name`，即默认 userData 目录名 |
| 产物名 | `workgroup-ai-${version}-${os}-${arch}…` | 未签名构建带独立后缀 |

## 已知缺口

| 项 | 状态 |
|---|---|
| Windows 安装包（NSIS）与签名 | 未产出（缺发布基础设施取值） |
| macOS 任何产物 | BLOCKED（需 macOS 主机） |
| Windows 安装/升级实测 | 未做：需要安装包 |
| 未签名构建可安装性 | 未验证 |
| Linux 桌面端 | 本项目的桌面产物面向 Windows/macOS；Linux 只有服务器侧 |

## 结论

**Q-04 = Windows 构建 PASS / Linux 服务器发布 PASS / macOS BLOCKED。**
按验收方案，macOS 部分未 PASS，最终结论中保留 `NO-GO` 的适用性说明。
