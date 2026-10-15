# F-04 证据截图

由 `application/tests/app-f04-ui-check.mjs` 在真实运行的 DSH Web 上抓取。 环境：Windows 11 / Node v26.7.0 / DSH `dsh-v0.2.1-alpha.3`（SHA 见 UPSTREAM_LOCK.md）（0.2.1-alpha.3）/ DS Bot `v0.1.5`（SHA 见 UPSTREAM_LOCK.md）（0.1.5）/ Chrome headless，`locale: en-US`。

| 文件 | 内容 |
|---|---|
| `f04-01-team.png` | DS Bot 团队界面：Chief tile、Writer/Coder 行、普通群聊行、`Connect plugins` |
| `f04-02-chief-chat.png` | Chief 私人聊天，含 DSH composer（占位符 `Message Chief`） |
| `f04-03-details.png` | 详情面板展开：Model `deepseek-v4-pro`、Permissions、Working `Team`、Memory、Usage、Schedule |
| `f04-04-group-chat.png` | 普通群聊会话 |

对应测试结论：`f04 ui: 15/15 checks passed`，退出码 0。 完整说明见 `../VERIFICATION_F01_F04.md`。
