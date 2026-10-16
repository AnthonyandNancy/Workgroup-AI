# 工作群验证与证据收口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 S/M/L/N/P 证据等级验证 W1–W3，重新建立生成产物和任务板基线，并只把实际可复现的结果写回旧文档。

**Architecture:** W4 不创造新的运行边界；它对 `application/`、`server/` 和现有 Hub/Host/Browser 实例做范围受限验证。测试失败、环境阻断、未确认终止和跨平台缺失都保留原始状态，不能用组件级测试替代真实产品证据。

**Tech Stack:** pnpm/Vitest、现有 Hub/Host、浏览器自动化工具（若环境已提供）、Git diff/生成产物比较、Markdown 文档。

## Global Constraints

- W4 依赖 W1–W3 的实际改动和 focused tests；没有通过的前置计划不进入相应真实验证。
- 不写入、显示或复制任何密码、token、注册 key、设备私钥或模型凭据。
- S/M 不能替代 L/N/P；任何非零退出码都是未通过。
- `TASK_BOARD.md`、`REQUIREMENTS_GAP_FILL.md`、`TECH_DESIGN_GAP_FILL.md` 只在新证据建立后更新。
- 当前 Git 工作树有预先变更，所有 diff、构建和生成操作必须限制在明确文件范围。
- 不执行永久删除，不使用 `git clean`、reset 或覆盖式生成。

---

### Task 1: 建立 W1–W3 focused baseline

**Files:**
- Test scope: `application/integrations/workgroup/tests/`
- Evidence: 本次执行记录或项目已有验证目录

**Interfaces:**
- Consumes: W1–W3 的 source/test changes。
- Produces: 每个计划的命令、退出码、passed/failed 数和非零警告记录。

- [ ] **Step 1: 运行 Bot/provider/view focused suite**

工作目录：`Workgroup-AI/application`。

```text
pnpm exec vitest run integrations/workgroup/tests/a11-hub-provider.spec.ts integrations/workgroup/tests/a02-workgroup-view.spec.ts integrations/workgroup/tests/bot-entry.spec.ts
```

- [ ] **Step 2: 运行协作/安全/恢复 suite**

```text
pnpm exec vitest run integrations/workgroup/tests/a05-workgroup.spec.ts integrations/workgroup/tests/a09-review.spec.ts integrations/workgroup/tests/q02-security.spec.ts integrations/workgroup/tests/q03-recovery.spec.ts
```

- [ ] **Step 3: 读取完整输出并分类**

分别记录：断言失败、运行时异常、HTTP 503、未处理 Promise、fixture 异常、弃用 warning。只记录真实输出，不按预期结果填表。

- [ ] **Step 4: 若有失败，回到对应计划**

W1 失败停在 W1；W2 失败停在 W2；W3 安全或执行失败停在 W3。使用 systematic-debugging 找根因，不能在 W4 修改代码掩盖前置缺口。

---

### Task 2: S 级静态契约和凭据边界检查

**Files:**
- Read-only: W1–W3 touched source files
- Test: 对应 contract/security tests

- [ ] **Step 1: 检查入口和本地 fallback**

确认：

- `BOT_PANEL_ID` 仍为 `conversation`。
- `order` 仍为 `1`。
- 本地群继续使用本地 state/普通 Session ID。
- 工作群使用 `wg:<roomId>`。
- 本地群不调用 Hub action。

- [ ] **Step 2: 检查三层方法对齐**

逐项比较 Browser Provider、Host endpoint、integration client：`configure/register/signIn/resume/rooms/create/open/watch/dissolve/upload/send/approve`。

- [ ] **Step 3: 检查凭据不外泄**

对 `hub-view`、Browser response、公共 task event、presence、directory 和日志断言不含 token、password、bootstrap key、私钥、模型凭据、机器绝对路径或 storage key。

- [ ] **Step 4: 检查执行边界**

确认 Hub 没有命令执行；approved task 只能进入 owner Host 的 native Bot/isolated Task Session；工具/路径/网络/进程调用均重新鉴权。

- [ ] **Step 5: 运行静态验证**

```text
git diff --check -- application/packages/bundle/ds-bot application/integrations/workgroup server/src
```

Expected: 只检查本次交付范围；若输出已有变更的格式问题，记录文件和行，不覆盖其他人的修改。

---

### Task 3: 生成产物和构建验证

**Files:**
- Generated: `application/packages/bundle/ds-bot/client.js`
- Generated: `application/packages/bundle/ds-bot/lib/client.js`
- Read: `application/package.json`、对应 bundle package scripts

- [ ] **Step 1: 确认生成命令**

读取现有 package scripts，选择仓库已经定义的 bundle/client 生成命令；不手工编辑生成产物，不凭记忆发明 script。

- [ ] **Step 2: 运行生成命令**

在 `application/` 执行已确认的命令，记录退出码和所有 warning/error。

- [ ] **Step 3: 比较两个 artifact**

使用项目已有比较命令；若没有专用命令，使用只读 Python byte comparison：

```text
python -c "from pathlib import Path; a=Path('packages/bundle/ds-bot/client.js').read_bytes(); b=Path('packages/bundle/ds-bot/lib/client.js').read_bytes(); print('equal=', a == b, 'bytes=', len(a), len(b)); raise SystemExit(0 if a == b else 1)"
```

- [ ] **Step 4: 运行 W1–W3 focused suite**

生成产物更新后重新运行 Task 1 的两个命令，确认 bundle 变化没有破坏源码测试。

- [ ] **Step 5: Task checkpoint**

若生成文件不一致、构建非零退出或 warning 暴露未处理异常，W4 不进入真实产品验证。

---

### Task 4: L 级单机真实验证

**Files:**
- Evidence only: 使用项目已有不含秘密的验证记录位置
- Read-only: `server/` runtime、Host runtime、真实 Bot UI

**Preconditions:** W1–W3 focused suites通过；有独立 Hub、Host、真实浏览器、owner Host 和实际模型端点。缺少其中任何一项则记录 BLOCKED，不执行替代性 mock。

- [ ] **Step 1: 启动独立 Hub**

使用环境变量名配置 `HUB_REGISTRATION`、`HUB_PUBLIC_URL`、`HUB_TOKEN_SIGNING_KEY` 等，不在命令记录真实值。

- [ ] **Step 2: 配置 Host 并登录**

使用 `WORKGROUP_HUB_URL` 或当前实现实际采用的 URL 配置键，从 Bot UI 完成配置、注册/登录、恢复，并验证账号 ID/handle 显示和复制。

- [ ] **Step 3: 验证工作群协作**

创建房间、邀请/接受、重新打开、发送消息、回复、mention、附件、成员设置、presence、断线恢复。

- [ ] **Step 4: 验证任务闭环**

确认 mention 只生成 pending；owner 查看完整 scope 并批准；任务在 owner Host 的 native Bot/isolated Task Session 执行；公共状态脱敏；owner 复核并按 recipient 分享。

- [ ] **Step 5: 验证负向边界**

测试非成员、非 owner、移除成员、撤销设备、无效路径、越权工具、无效 grant、取消、模型端点不可用和下载 ACL。

- [ ] **Step 6: 记录 L 证据**

记录 Hub/Host 版本、操作顺序、状态转移、退出结果和不含秘密的日志摘要。若某一步失败，记录失败点和 NO-GO，不改写为部分通过。

---

### Task 5: N 级双机验证

**Files:**
- Evidence only: 现有验证记录位置
- Read-only: 两个独立客户端和 Hub realtime

**Preconditions:** L 级核心流程通过；有两台独立设备或两个隔离客户端网络环境。

- [ ] **Step 1: 邀请和成员可见性**

A 创建房间，B 接受邀请；验证入群前不可枚举，入群后可查看同群成员。

- [ ] **Step 2: 实时消息和 presence**

A/B 实时收发消息、回复、mention 和 presence；不显示精确时间戳。

- [ ] **Step 3: 断线 catch-up**

断开一端并产生消息，再重连；确认无漏失、无重复，状态从 reconnecting 恢复 connected。

- [ ] **Step 4: 审批和取消**

请求人发起任务，owner 端审批/取消，另一端只看到脱敏状态；撤销 grant 后新的调用/retry 被拒绝。

- [ ] **Step 5: 记录 N 结论**

当前环境不可用时明确记 `BLOCKED`，不以单机结果替代 N。

---

### Task 6: P 级平台和门禁

**Files:**
- Read/modify only after evidence: `TASK_BOARD.md`, `REQUIREMENTS_GAP_FILL.md`, `TECH_DESIGN_GAP_FILL.md`
- Existing gate scripts and package configs

- [ ] **Step 1: 运行 Linux/Windows 可用验证**

记录实际构建、运行、退出码和平台版本；Windows/macOS 不能由 Linux 结果代替。

- [ ] **Step 2: 记录 macOS 状态**

没有 Mac 主机或签名证据时保持 BLOCKED，不写成 PASS。

- [ ] **Step 3: 运行项目既有门禁**

使用仓库既有 gate script，包括 `verify-third-party-notices` 已纳入的检查；不新增无关门禁。

- [ ] **Step 4: 更新旧文档状态**

只有在前置测试和真实证据已保存后，更新 `TASK_BOARD.md`、`REQUIREMENTS_GAP_FILL.md`、`TECH_DESIGN_GAP_FILL.md`。把旧的“未挂载/无 CSS/无 provider”修正为当前事实，同时保留未完成、失败、BLOCKED 和 NO-GO。

- [ ] **Step 5: Task checkpoint**

逐行对照五份规格和索引矩阵；任何没有命令或真实记录支持的 PASS 改为“组件级”“M 级”或“未完成”。

---

### Task 7: W4 完整交付门禁

- [ ] **Step 1: 汇总 W1–W3 的任务结果**

每个任务记录：任务 ID、涉及路径、前置条件、修改摘要、实际测试命令、结果与证据、未解决风险。

- [ ] **Step 2: 运行最终 verification**

重新执行所有声明对应的命令；不引用旧输出作为当前成功证据。

- [ ] **Step 3: 形成放行结论**

只有 W1 Provider、W2 协作实时、W3 owner-only 原生执行和必要证据等级均满足，才将工作群从 NO-GO 改为 GO；否则保留 NO-GO 并列出阻塞。

- [ ] **Step 4: 交给 code review**

对所有源码和文档变更发起范围受限 review；Critical/Important 问题修复后重新运行对应验证。
