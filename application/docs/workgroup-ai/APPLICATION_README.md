# application/｜用户应用（独立发行）

**这个目录不是服务器发布目录。** 获取并 Fork DSH 完整源码后，将其原生 root（`apps/`、`packages/`、脚本、锁文件等）放在 `application/` 下保留工作区结构；把 Fork DS Bot 内置模块固化到 `packages/bundle/ds-bot/`（嵌套 upstream clone 保留在 `integrations/ds-bot/upstream/` 作为上游归属与差异证据），把工作群本地客户端与任务执行适配放在 `integrations/workgroup/`。

## 运行的内容

- 每个用户本地的 DSH Host：模型、Agent Loop、Session、工具、权限与执行。
- DeepSeek-Bot：原版 Chief、下属 Bot、私聊、普通群聊及全套 Bot UI。
- Workgroup：工作群 React UI、Hub Bridge、鉴权/审批 UI、隔离原生 Bot Task Session、执行层强制权限。

## 项目内文件归属

`docs/` 为应用的操作/开发规范；`tests/` 为 app UI 与真实 Host 集成回归；`integrations/workgroup/protocol/` 只生成/保留服务端契约的客户端视图，不定义新的服务器规则。

## 用户安装后的默认行为

首次启动有 Chief；DSH 一级导航“插件”正下方只有 Bot。进入 Bot 后才能看到原版内部功能，“创建群聊”下方增加“创建工作群聊”。Hub 地址由启动环境或 `$WORKGROUP_HOME/.env` 中的 `WORKGROUP_HUB_URL` 提供，应用内不出现 Hub 地址、登录或注册配置；首次进入 Bot 自动完成匿名快速认证。原版私聊和普通群仍可用。

## 桌面端 Hub 地址

桌面端不读取 `application/.env`，也不允许项目目录的 `.env` 设置 `WORKGROUP_HUB_URL`。桌面 Host 只从用户自己的 Harness-home 读取：开发模式为 `application/apps/desktop/.desktop-build/development/home/.env`，Windows 安装包为 `%USERPROFILE%\.workgroup-ai\.env`，macOS/Linux 安装包为 `~/.workgroup-ai/.env`。如果设置了 `WORKGROUP_HOME`，使用 `$WORKGROUP_HOME/.env`。

```env
WORKGROUP_HUB_URL=http://127.0.0.1:8443
```

修改后必须完全退出并重启 Desktop。`127.0.0.1` 只适用于 Hub 与 Desktop 在同一台机器；跨机器请填写 Hub 的局域网地址。

## 起步门禁

必须先真实克隆并锁定上游，运行原版 Desktop/Web/DS Bot，再做最小 Fork。此交接包没有把空目录当成已内置的源码。
