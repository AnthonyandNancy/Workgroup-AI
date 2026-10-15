# F-12：真实路径校验与无效 dir 拒绝

**任务 ID：** F-12

**执行日期：** 2026-10-15

**DS Bot 版本：** `v0.1.5`（SHA 见 UPSTREAM_LOCK.md）（含本任务补丁）

**证据等级：** **L**（真实文件系统与真实符号链接）。无 N 级（双机）结论。

## 完成条件与结论

| 条件 | 结果 |
|---|---|
| 真实路径校验（realpath） | **PASS** — 符号链接解析为真实目标，Session 记录的是真实路径 |
| 无效 dir 拒绝 | **PASS** — 相对路径、不存在的路径、文件、根目录、含数据目录的路径全部拒绝 |
| **不发生默认目录回退** | **PASS** — 每个拒绝路径都断言**没有创建任何 Session** |

## 发现并修复的真实缺陷

### 缺陷 1（安全相关）：数据根默认值仍指向官方 DSH 的 `.dsh`

F-05 已把产品的数据根改为 `~/.workgroup-ai`，但 DS Bot 的 `dshHomeOf` 仍回退到 `~/.dsh`：

```js
// 修复前
export const dshHomeOf = value => resolve(expandHome(value?.trim() ? value : join(homedir(), '.dsh')))
```

**后果：** 未设置 `DSH_HOME` 时，DS Bot 会把团队数据（`state.json`、各 Bot 的 Session、记忆、附件）写进**官方 DeepSeek Harness 的数据目录**。两个产品写同一棵树——正是 F-05 存在的理由。而且这个失败是**静默的**：不报错，只在事后表现为数据不一致。

**修复：** 默认值改为 `DATA_ROOT_DIR_NAME = '.workgroup-ai'`，与 Fork 的 `home-paths` 常量一致。`DSH_HOME` 仍然完全优先，所以测试台与运维不受影响。

**发现方式：** 该改动让上游既有的 `work-dir.test.js` 的 `DSH_HOME is read as DSH reads it` 立即失败——它断言默认是 `.dsh`。这证明改动确实生效，也说明这个常量此前没有测试覆盖两个模块之间的一致性。

**补充的守卫：** 新测试断言 `DATA_ROOT_DIR_NAME === '.workgroup-ai'`，并把该字面量与 Fork 的常量绑在一起（DS Bot 的 host 半边不能 import 客户端包，所以用断言而不是 import 来防止漂移）。

### 缺陷 2：文件系统根目录被接受

`D:\` 或 `/` 会通过原有的全部检查：它存在、是目录、不含 DSH 数据。于是所有者"批准在 `D:\` 工作"就等于批准 Bot 写整台机器——那次批准不再有任何含义。

**修复：** `dirname(path) === path` 判定为根，明确拒绝并说明原因：

```js
if (dirname(path) === path) {
  throw new Error(`${path} is a filesystem root, which would let a Bot write anywhere; choose a folder inside it`)
}
```

判定在 `realpath` **之后**，因此通过符号链接到达的根同样被拦截。

### 关于符号链接：行为已正确，补上了可见性

原有实现已经先用 `realpath` 解析再保存，所以符号链接**不会**造成越界——记录的是真实目标。测试确认了这一点（junction 指向 `project`，保存的 `cwd` 是 `project` 而非链接）。

补上的是**可见性**：解析跨卷或跨目录时打一条 warning，让"我指了 `D:\work`，结果它跑到另一个卷"这件事有迹可循，而不是静默发生。

## 修改文件

| 文件 | 改动 |
|---|---|
| `application/packages/bundle/ds-bot/src/host/folders.js` | 数据根默认值改为 Fork 的目录名；拒绝文件系统根；符号链接解析打 warning |
| `application/packages/bundle/ds-bot/test/work-dir.test.js` | 更新数据根断言；新增 5 个路径校验用例 |

## 真实执行证据

### 测试

```sh
$ node --import ./test/harness-resolve.mjs --test test/work-dir.test.js
 ℹ tests 18 / ℹ pass 18 / ℹ fail 0

$ npm test                                    # DS Bot 全量
 ℹ tests 560 / ℹ pass 558 / ℹ fail 2
```

**560 项（新增 5 个），558 通过。** 那 2 个失败在 F-04 就已定位为 DS Bot 测试 harness 对 DSH 安装布局的假设，与本次改动无关。

### 新增用例覆盖的拒绝路径

| 输入 | 结果 | 关键断言 |
|---|---|---|
| `/`（文件系统根） | 拒绝 | 错误含 "filesystem root, which would let a Bot write anywhere"；**`created` 为空** |
| 符号链接指向真实目录 | 接受 | `cwd` 是**真实目标**，不是链接；Bot 保存的 `workDir` 也是真实路径 |
| `project`（相对路径） | 拒绝 | 错误含 "Give the full path"；`created` 为空 |
| 不存在的目录 | 拒绝 | 错误含 "There is no folder at"；**目录未被创建**；`created` 为空 |
| DSH 数据目录 / 数据目录的父目录 / 树的根 | 全部拒绝 | 错误含 "holds DeepSeek Harness data"；`created` 为空 |
| 正常项目目录 | 接受 | `created` 恰好为 `[{ cwd: project }]` |

每个拒绝用例都断言 `created` 为空，这是"不发生回退"的直接证据——一个回退的实现会在这里出现一条记录。

## 未完成与风险

| 项 | 状态 |
|---|---|
| 群级工作目录的同样校验 | **未逐一验证**。群也有 `workDir`，走同一个 `cleanWorkDir`，但本轮测试只覆盖了 Bot 维度 |
| Windows 上的 junction 与 symlink 差异 | 测试用 `junction` 类型并在平台拒绝时 `skip`——本机实测通过，但未在无特权账户下验证 symlink 类型 |
| 大小写不敏感文件系统的路径比较 | `within()` 用字符串前缀比较。Windows 上 `D:\Work` 与 `d:\work` 是同一目录但字符串不同。**这会影响 `guarded()` 的判定**，本轮未处理 |
| 网络路径 / UNC | 未验证 |
| 任务侧目录校验的真实运行 | F-11 的测试覆盖了拒绝逻辑，但未在真实运行中演练无效目录 |

**一条明确的边界：** 本轮证明的是"无效目录被拒绝、不创建 Session"。它**没有**证明"Bot 在获准目录内无法逃逸（例如通过 `..` 或链接访问目录之外）"——那是**运行时工具层**的强制边界，归 F-13。

## 下一步

F-13（Bot 任务工具 guard/进程撤销与最小权限 PoC），依赖 F-11。这是 P0 阻断项，完成它之后 application 端的 P0 门槛（G3）才基本齐备。
