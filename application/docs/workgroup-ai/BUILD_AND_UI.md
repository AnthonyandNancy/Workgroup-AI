# 应用构建与 UI 验收

1. 记录上游完整 SHA 与 pnpm lockfile；核对受支持 Node/Electron 环境。
2. 先原版冷启动，再内置 DS Bot，证明没有重复 Host。
3. DSH 插件入口原位置、Bot 单一入口在正下方；Chief/Bots/私聊/普通群/工作群都仅在进入 Bot 后出现。
4. 原版创建群聊按钮仍在，创建工作群聊紧贴其下。
5. 原版 CSS/组件作为 UI 基准；切换页面无覆盖泄漏。
6. 正常与官方 DSH 并存，所有存储路径隔离。
7. 记录 Windows/macOS 真实构建、安装、签名与启动证据。
