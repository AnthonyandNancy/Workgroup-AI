# server/｜Workgroup Hub（唯一独立部署的服务）

此目录必须在没有 application、DSH、DS Bot、Electron 的 Linux 主机上单独安装并启动。仅负责用户、设备、工作群成员、消息、审批、任务协调、群记忆、受控分享/审计；**不执行 Agent、不存储用户模型密钥或私有 Session**。

## 推荐技术

Node.js 24 LTS，Fastify（HTTP），WebSocket（WSS），SQLite + WAL（单 Hub 实例部署）；可选进程管理器 systemd 或容器。若后续压力测试证明需数据库升级，仍然只在 `server/` 内修改存储实现。

## 代码结构

- `src/`：唯一 server runtime；此包目前未包含可执行实现，开发者根据实施任务编写。
- `contracts/`：API/WSS 协议唯一权威文件。
- `db/migrations/`：Hub 自有数据库迁移。
- `deploy/`：TLS、systemd/容器、备份与恢复说明，部署包只用本目录。
- `docs/` 与 `tests/`：服务器设计、单测/安全/负载及运维验收。

## 发布门槛

一台干净 Linux 主机仅复制 server/，安装依赖、执行迁移、配置 HTTPS/WSS 和持久数据目录，即可供多位员工的 application 使用；不允许跨目录 import 应用端代码，也不允许以 Hub 假冒财务 B 审批。
