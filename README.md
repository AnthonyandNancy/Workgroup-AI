# Workgroup AI｜新项目开发交接包

**项目定位：** 基于 Fork 的 DeepSeek Harness (DSH) 打造一款独立发行、保留本地 Agent 能力的桌面/Web 应用；将 DeepSeek-Bot (DS Bot) 内置为原生功能，并新增局域网跨用户工作群及有审批的跨用户 Bot 任务委派。

**这是一个独立新项目的首次交付资料。** 阅读本包不需要任何之前的技术方案；本包不包含从其他交接包复制的代码或版本变更说明。

## 仅有两个业务项目

- **`application/`**：用户安装或使用的应用。负责 Fork DSH、完整内置 DS Bot、DSH UI 中单一的 Bot 入口、Bot 内部创建工作群入口、本地用户身份、与 Hub 通信的 Bridge、任务级 BotAdapter、工具 guard、文件沙箱、桌面和 Web 构建。用户的模型凭据、私人 Session、原生 Bot 和本地工具执行保留在此处及用户私有数据目录。
- **`server/`**：独立部署在公司内网常开主机上的 Workgroup Hub。负责用户/设备身份、群成员、消息同步、在线状态、任务状态、审批协同、群记忆、文件共享元数据、审计及备份。**绝不承载 DSH Agent Loop、DS Bot 或员工私人 Session。**

顶层另外存在少量 Markdown 文档；这些是交接说明文件，**不是第三个项目或第三个服务**。

```text
Workgroup-AI/
├── application/     # 唯一的应用端源码及产物
├── server/          # 唯一需要单独部署的服务端源码及产物
├── README.md        # 本文档
├── AGENTS.md        # AI 编程代理的全局规则
├── TECHNICAL_BLUEPRINT.md
├── TASK_BOARD.md
├── ACCEPTANCE.md
└── SOURCE_RESEARCH.md
```

## 正式交付拓扑

1. 每位员工安装 `application/` 构建的 Windows/macOS 桌面包；Web 模式复用受支持的 DSH Web/Host 路径，不承诺仅靠远端浏览器就能执行本地工具。
2. 管理员将 **`server/` 单独部署** 到一台内网服务器/NAS/常开主机（可用容器或系统服务）；服务器不需要安装 `application/`、Electron、DSH 或 DS Bot。
3. 管理员通过安装包/启动环境或用户自己的 `$WORKGROUP_HOME/.env` 设置 `WORKGROUP_HUB_URL`；应用首次进入 Bot 时自动匿名快速认证，应用内不提供 Hub 地址、登录或注册配置。`application/.env` 不是桌面端配置源。不同员工通过工作群交换消息，但所有实际 Bot 操作仍在任务所有人本地执行。
4. 客户端本地可以不连接 Hub 而继续使用 DSH、Chief、下属 Bot、私人聊天、普通群聊；此时工作群显示离线/受限状态。

## 交给 AI 的开始指令

先阅读 `AGENTS.md`、`TECHNICAL_BLUEPRINT.md`、`TASK_BOARD.md`、`ACCEPTANCE.md`、`SOURCE_RESEARCH.md`。从 P0 的上游仓库锁版与可运行验证开始，不允许跳过真实构建而直接声称“已集成”。每一阶段写明证据类型、命令、环境、失败原因和所做最小改动。

> 本交接包包含开发计划、协议/SQL 初稿和目录责任说明；**不包含完整 DSH/DS Bot 上游源码，不是可直接运行的完成品**。任何具体包名、Slot 和 API 都要在锁定的真实版本上确认后实现。
