# A-03 / A-04 交付：工作群视图复用原版群聊组件、菜单入口置于原入口正下方

| 字段 | 内容 |
|---|---|
| 任务 ID | A-03、A-04 |
| 状态 | **A-04 PASS**（入口位置与可见性由真实客户端的 `apply` 注册与源码结构断言，6 项新增检查全过）；**A-03 部分 PASS**（视图组件已实现并随 `client.js` 发布，组件复用与本地群无耦合的关系已验证；**"视觉与原版逐像素一致"未做**，见风险节） |
| 涉及路径 | `application/packages/bundle/ds-bot/src/client/workgroup.js`（新增）、`src/client/new-chat.js`、`src/client/overlays.js`、`src/client/index.js`、`src/client/i18n.js`、`client.js`（重新构建）、`application/integrations/workgroup/tests/bot-entry.spec.ts` |
| 前置条件 | F-07/F-08/F-09（Bot 入口与局部挂载）、H-04（Hub 房间） |

## 达成条件

| 条件 | 结果 |
|---|---|
| A-04 原"创建群聊"入口仍在且未被修改 | 通过：`Create group chat` 一行未动，未被任何 Hub 条件包裹 |
| A-04 其正下方新增"创建工作群聊" | 通过：新建聊天、设置→群聊、命令面板三处入口都紧邻本地群入口，并复用同一 `workgroups.create`（断言实际源码位置） |
| A-04 普通群功能不受影响 | 通过：原入口的 admin 流程断言仍在（`Choose the group admin`） |
| A-03 复用原版群聊组件 | 通过：视图挂载原版 `GroupSettingsForm` 与 `RoomAvatar`，不自建第二套 |
| A-03 不把工作群当本地群 | 通过：视图不含 `createRoom(`，也不直接 `call(...)`；所有数据经 props 进入 |
| A-03 视觉与原版一致 | **未验证**——见风险节 |

## 实现要点

### A-04：入口

```js
options.push({ key: 'group', icon: h(PeopleIcon), label: t('Create group chat'), run: ... })
// 工作群入口紧跟其后，原入口一行未改
if (workgroups !== undefined) {
  options.push({ key: 'workgroup', icon: h(PlugIcon), label: t('Create workgroup chat'), run: () => run(workgroups.create) })
}
```

三个刻意的选择：

- **用 `<PlugIcon>`（产品已有的图标）而不是群聊图标**：两行相邻的入口若同图标，读起来像同一动作做了两遍。复用既有图标也避免自助画新图（上游禁止自创素材）。
- **门控在 prop 上，不在 Hub 可用状态上**：`workgroups === undefined` 时菜单与上游完全一致；本 fork 的 provider 始终提供该动作对象，因此 Hub 未配置或暂时不可达时入口仍然显示，点击后由 Host 返回稳定错误，而不是把功能藏起来。三处入口共享同一动作。
- **普通群入口不被任何 Hub 条件包裹**：添加一个实体，不改原有流程。

### A-03：视图

`workgroup.js` 渲染工作群：消息线程、成员列表、待审批任务条、输入框，以及设置视图。

**复用**：`GroupSettingsForm`（群设置表单）、`RoomAvatar`（房间头像）、`.bt-*` 既有样式与外壳。工作群的管理界面因此与群聊长得一样、行为一样，这是"复用"的机械含义。

**不复用**：任何会让工作群看起来是本地群的东西。视图里没有 `createRoom(`，也不直接调用 host——全部数据通过 props 进入。这不是风格偏好，而是范围约束的直接结果：入站帧到"执行"之间必须没有代码路径，而 `workgroup.js` 是渲染层。

几个具体判断（均有检查）：

| 判断 | 理由 |
|---|---|
| 消息按 `roomSeq` 排序后才渲染 | 补拉页与实时事件可能乱序到达，聊天乱序比迟到更糟 |
| 人类成员排在 Bot 之前 | 工作群的意义是同事在另一头；Bot 排前面会把这件事埋掉 |
| Bot 条目显示其 owner | 工作群里的 Bot 是"代某人行事"，读者第一个问题就是"这是谁的 Bot" |
| 只显示发给自己的审批 | 审批是个人授权。任何人可代批就废掉了闸门；这是 A-06 的核心约束 |
| 发送失败显示"未送达" | 静默丢弃会让员工以为同事已收到 |
| 输入框只在 Hub 接受后才清空 | 先清空再失败会丢掉员工刚打的内容 |

**会话 id 命名空间**：`wg:<roomId>`。Hub 房间与本地房间是两个不同实体，绝不能落到同一个会话 id 上；`isWorkgroupSession` 是纯函数，重启后仍成立。

## 真实命令与结果

```bash
cd application/packages/bundle/ds-bot
npm run build                       # src/client → client.js（上游硬规则：client.js 由构建产生）
node scripts/build-client.mjs --check   # client.js 与 src/client 一致
npm run lint                        # 0 errors（18 个既有 warning 为上游接受的风格建议）
npm test                            # 575 tests, 574 pass, 1 fail（dsh-update.test.js，既有失败，与本改动无关）

cd application
npx vitest run integrations/workgroup/tests/
# → Test Files 3 passed | Tests 56 passed (56)
#   其中 bot-entry.spec.ts 16 项（原 10 项 + A-03/A-04 新增 6 项）
```

## 过程中被既有测试拦下的问题

1. **`Reject` 键重复**：客户端构建脚本把 esbuild warning 当错误抛出，`Duplicate key "Reject"` 当场失败。既有的 `Reject` 翻译与我要加的一模一样，我的那行是多余的——已删除。
2. **硬编码文案**：`test/i18n.test.js` 扫描 `src/client/*.js` 中每个 `t('…')` 字面量并要求字典有条目。我最初在组件默认参数里写了一个 `t('This workgroup has no messages yet.')`，测试立刻报出。改为在调用点用已有的 `t('No messages yet')`。
3. **`no-unused-vars` × 3**：lint 指出我导入了 `WorkgroupView` 却没用，两个辅助函数没导入，以及此前 F-11 留下的一个未使用 `randomUUID` 导入。三处都已修正。

这三条都不是我主动检查发现的，而是项目既有的门禁发现的——这也是先跑门禁、再声称完成的意义。

## 未解决风险

| 项 | 状态 |
|---|---|
| **A-03「视觉与原版逐像素一致」** | **未验证**。已做的是组件级复用（挂载原版表单与头像、使用同一套 `.bt-*` 样式）；未做的是截图比对——需要真实浏览器与真实 Hub 房间，且工作群需要 Hub 数据才能渲染出内容 |
| **浏览器端 E2E** | 本轮的浏览器检查未能复现 F-07 当时的环境（既有的、当时通过的 `app-f07-ui-check.mjs` 在同一环境下同样失败，说明是我这次启动方式的问题而非代码回归）。A-03/A-04 的结论改由 `apply` 级 harness 支撑，覆盖注册与源码结构，但不覆盖像素 |
| **工作群实际渲染内容** | 视图需要 Hub 提供的房间/成员/消息数据；本地无 Hub 时只能验证到组件存在与契约正确 |
| 群聊功能对照矩阵 | 原版群聊的逐项回归（@Bot、任务接力、附件/引用）属 A-05/A-06 的输入，本轮未做 |

## 下一步

A-05：ID 邀请、成员管理、真人消息与 @Bot UI。它把本任务的视图接到真实 Hub 数据上，届时 A-03 的像素级验证才有条件做。
