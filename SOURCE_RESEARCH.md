# Workgroup AI｜上游源码研究与核验边界

**核验日期：2026-10-14。** 本表为 AI 初次开发必须重新核实的上游定位；GitHub `main/master` 不保证与最终锁定版一致。交接包本身未包含完整上游 checkout，也未完成本机/双机真实构建测试。

| 研究对象 | 已确认的公开线索 | 开发行动 |
|---|---|---|
| DSH 主仓库 | https://github.com/deepseek-ai/deepseek-harness | 固定 exact commit、clone 完整仓库、记录 Node/pnpm/构建命令 |
| DSH 架构说明 | https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md | Desktop 运行内置 Host、Web UI、插件/RPC 体系；以锁定 SHA 为准 |
| DSH Desktop | https://github.com/deepseek-ai/deepseek-harness/tree/master/apps/desktop | 核对实际打包/资源/配置/单实例/用户数据目录 |
| DSH 侧边栏 | https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-sidebar/README.md | 插件入口的组件真实位置、主视图挂载方案 |
| DS Bot 主仓库 | https://github.com/Fei2411/DeepSeek-Bot | 固定 exact commit、LICENSE/NOTICE、依赖与兼容性 |
| DS Bot index | https://github.com/Fei2411/DeepSeek-Bot/blob/main/ds-bot/index.js | 源码可见 `createRuntime(ctx,config)`，须验证单一 Host 生命周期 |
| DS Bot package | https://github.com/Fei2411/DeepSeek-Bot/blob/main/ds-bot/package.json | Host/Client peerDependencies、打包、版本关联 |
| DS Bot store | https://github.com/Fei2411/DeepSeek-Bot/blob/main/ds-bot/src/host/store.js | 状态重建、groupOwners 生命周期、锁与数据恢复 |
| DS Bot roster | https://github.com/Fei2411/DeepSeek-Bot/blob/main/ds-bot/src/host/roster.js | 本地群成员/创建 Session、目录回退风险 |
| DS Bot groups | https://github.com/Fei2411/DeepSeek-Bot/blob/main/ds-bot/src/host/groups.js | 原群聊消息、@Bot 和群 UI 语义 |
| DS Bot Client | https://github.com/Fei2411/DeepSeek-Bot/blob/main/ds-bot/src/client/index.js | 现有全局 shadow/Slot 与 Bot 页面化改造 |

## 源码归属与许可证

DSH 依其仓库 MIT 许可证；DS Bot 依其仓库 Apache-2.0，包含 NOTICE；发布产品必须依法保留许可证、归属、NOTICE 并检查最终合并依赖的第三方许可。不得使用上游官方商标暗示官方发行。

## 明确未证明的事项

- 选定版本的 DSH 与 DS Bot 可以自动兼容。
- 已存在稳定的 Bot Task Session 公开扩展 API。
- 原生 Bot 身份在跨用户 Task Session 中正确继承。
- Hub/桌面应用现已构建成功或两台真实电脑已联通。
- 只靠取消按钮就足以终止已经启动的命令/网络请求。

以上均属于首期必须以真实源码和运行证据解决的问题。不得将架构上“可设计”写成“已通过”。
