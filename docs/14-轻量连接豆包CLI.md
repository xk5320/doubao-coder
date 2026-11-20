# 14. 轻量连接豆包 CLI：方案、取舍与落地

> 版本：0.53.0
> 相关代码：`src/cli/runner.ts`、`src/cli/detect.ts`、`src/chat/panel.ts`（runCli）、`src/extension.ts`（连接方式选择）
> 官方文档：https://www.doubao.com/work/docs/zh-cn/doubao-cli
> 终端使用：https://www.doubao.com/work/docs/zh-cn/articles/870164132353-cli-terminal
> 命令参考：https://www.doubao.com/work/docs/zh-cn/articles/376493082444-cli-commands

## 结论

1. **对已经能装、能登录豆包 CLI 的用户，轻量连接 CLI 明显优于现在的桌面端 CDP 通道**：
   它走官方文档化的非交互入口 `doubao -p`，不依赖桌面窗口的 DOM/协议，不抢焦点，
   工具、权限、技能、子 Agent 全部由 CLI 自己执行。
2. **不要在扩展里再做一套完整 Agent**。CLI 已经带 Bash/文件读写/Grep/Glob、权限策略、
   AGENTS.md、本地 Skills、子 Agent、定时任务；扩展重复实现只会得到两套不一致的权限模型、
   两份上下文拼装和双倍维护成本。
3. 安装后**首次激活**让用户三选一：**豆包 CLI（轻量，推荐）/ 豆包桌面版（免 Key）/ Ark API Key**，
   写入 `doubao.authMode`；之后可随时用命令「豆包: 选择连接方式」切换。
4. 扩展的差异化留在 IDE 侧：选区/诊断/@文件、行内改写、Diff 审阅、撤销、行内补全；
   这些是 CLI 做不了、也不该由 CLI 做的部分。

---

## 1. 官方文档里的豆包 CLI

### 1.1 安装与登录

- Node.js 18+，npm/npx，Windows x64 / macOS ARM64 / Linux x64；
- `npm install -g '@bytedance/doubao-cli' --registry=https://registry.npmjs.org/`
- 原生程序由 npm 安装脚本下载，落在应用数据目录：
  Windows 为 `%LOCALAPPDATA%\doubao_cli\app\current\doubao.exe`；
- `doubao login --qr=png` 扫码登录，`doubao auth status --verify` 在线校验；
- 目前仅对「豆包团队订阅」和「豆包企业订阅」账号开放。

### 1.2 两种使用模式

| 模式 | 入口 | 适合 |
| --- | --- | --- |
| 交互模式 | `doubao` | 多轮澄清、排错、创建定时任务 |
| 非交互模式 | `doubao -p "<prompt>"` | 脚本、自动化、被其他 Agent 调用 |

非交互模式的关键参数：

| 参数 | 作用 |
| --- | --- |
| `-p "<prompt>"` | 一次性任务，执行完退出；提示词整体作为一个参数 |
| `-C <dir>` | 指定工作目录 |
| `--resume <session-id>` | 续接历史会话（配合 `--list` 取 ID） |
| `--model <model>` | 指定模型，默认 Auto |
| `--effort Low\|Medium\|High` | 推理强度 |
| `--permission-mode ask_always\|ask_risky\|always_allow` | 文件/网络操作权限 |
| `--service-start` | 作为后台服务，供其他设备派发任务 |

### 1.3 CLI 自带的能力（这正是「不用再做 Agent」的原因）

- 本地工具：文件读写、终端命令（Bash）、Grep、Glob；
- 项目约定：读取工作区的 `AGENTS.md`；
- Skills：自动扫描 `~/.doubao/skills`、`~/.claude/skills`、`~/.agents/skills` 等工作区/用户目录；
- 子 Agent：交互与非交互模式都能调用（如 OrganizerAgent）；
- 定时任务：交互模式下用自然语言创建；
- 权限策略：始终询问 / 按需询问 / 全部允许；
- 会话：`--list`、`--resume`，支持跨设备恢复；
- 后台服务：`--service-start`，同一设备只能开一个。

---

## 2. 三种连接方式对比

| 维度 | 豆包 CLI（新） | 桌面版 CDP（现有） | Ark API Key（现有） |
| --- | --- | --- | --- |
| 接口性质 | 官方文档化的 `-p` | 非官方 CDP 驱动窗口 | 官方 OpenAI 兼容 API |
| 稳定性 | 高，版本升级只影响参数 | 低，依赖 DOM/协议/页面结构 | 高 |
| 登录 | CLI 自己的扫码登录 | 复用桌面端登录态 | API Key |
| 是否抢焦点 | 否 | 是（会切窗口/写输入框） | 否 |
| 工具执行 | CLI 内，官方权限模型 | 扩展 PTC/工具层 | 扩展 AgentLoop 工具层 |
| 上下文 | CLI 自己读工作区、AGENTS.md、Skills | 扩展拼提示词 + 桌面端 | 扩展拼提示词 |
| 跨平台 | Win x64 / macOS ARM64 / Linux x64 | 基本只有 Windows 桌面端 | 全平台 |
| 资源占用 | 一个短生命周期进程 | 常驻桌面端 + CDP | 无额外进程 |
| 计费 | 订阅额度 | 订阅额度 | 按 token |
| 行内补全 | 不支持（无 FIM 接口） | 不支持 | 支持 |
| 扩展代码量 | 小（进程 + 输出解析） | 大（CDP/同步/选择器） | 大（工具/循环） |

**结论**：CLI 是「官方 Agent + 官方登录 + 官方权限」，扩展只做 IDE 界面；
桌面版继续保留给没有 CLI 订阅/装不了 CLI 的用户；Ark 保留给需要 API Key 或行内补全的用户。

---

## 3. 为什么「轻量连接」更好

### 3.1 从「逆向 UI」回到「官方接口」

桌面版通道要模拟输入、轮询 DOM、解析流式回复，桌面端每次改版都可能失效；
`doubao -p` 是文档明确写给脚本和 Agent 用的入口，输出是文本，契约小得多。

### 3.2 权限与工具只有一个来源

CLI 自己执行文件/终端操作，权限由 `--permission-mode` 控制，和用户在终端里用 CLI 的体验一致。
扩展不再需要 PTC 文本工具协议，也不会出现「扩展允许、CLI 拒绝」两套策略打架。

### 3.3 不抢焦点、可并行

CLI 没有窗口；任务在子进程里跑，可以超时、可以中断、可以后台执行。
桌面版必须把内容写进当前豆包窗口，会打断用户正在做的事。

### 3.4 跨平台

CLI 官方支持三平台；桌面版 CDP 实际上绑定 Windows 豆包客户端。
对 mac/Linux 用户，CLI 是唯一可用的「免 Key」通道。

### 3.5 维护成本

新增的 CLI 适配层只有两个文件：
- `runner.ts`：拼参数、起进程、收输出、超时/中断、会话 ID 捕获；
- `detect.ts`：找可执行文件、读版本、查登录态。

没有新增任何工具、提示词模板或权限逻辑。

---

## 4. 为什么不做「完整的 agents 功能」

这里的「完整 agents」指：扩展自己实现工具集、计划-执行循环、子 Agent 调度、技能加载、定时任务。

不建议做，原因：

1. **重复且更弱**：CLI 的工具/权限/技能/子 Agent 是官方实现，扩展再写一套只能做到近似；
2. **权限模型冲突**：用户在 CLI 里选「按需确认」，扩展又弹一套确认，体验割裂；
3. **上下文双份**：扩展拼系统提示 + 工作区，CLI 又读 AGENTS.md/Skills，模型收到两份互相矛盾的约定；
4. **维护面爆炸**：桌面端、Ark、CLI 三套 Agent 都要跟着模型/协议升级；
5. **IDE 的价值不在重复 Agent**：选区、诊断、@文件、Diff 审阅、撤销、补全才是扩展的护城河。

因此本版只做「传输层替换」：CLI 模式下把用户消息交给 `doubao -p`，把结果流回面板。
Ark 模式的 AgentLoop 保留（没有订阅/需要 Key 的用户），但不再扩展。

---

## 5. 落地实现（0.51.0）

### 5.1 模块

```text
src/cli/
├─ runner.ts   纯 Node：buildCliArgs / normalizeCliText / runCliTask
└─ detect.ts   探测：candidateBinaries / detectCli / checkCliAuth
```

`runCliTask` 负责：
- 参数顺序：`-C` → `--resume` → `--model` → `--effort` → `--permission-mode` → `-p <prompt>`；
- `stdio: ['ignore','pipe','pipe']`：stdin 关闭，避免 CLI 交互提示挂住；
- 环境变量 `DOUBAO_CLI_NO_UPDATE_CHECK=1`、`NO_COLOR=1`；
- stdout 缓冲（上限 8MB），结束时清理 ANSI/回车进度，作为回答；
- stderr 按行转成「正在执行」状态提示（限流 700ms）；
- 超时/AbortSignal 杀进程；退出码非 0 时返回错误详情；
- 从输出里用启发式捕获 `session id: xxx` / `--resume xxx`，下一轮自动 `--resume`；
  若 CLI 明确说会话失效，自动清空 ID 重试一次。

### 5.2 面板路由

`handleUser` 在 CLI 模式下直接调用 `runCli`，不进入 PTC/TaskRunner/桌面端：
- 对话与「本地电脑」在 CLI 侧没有区别，统一交给 `-p`；
- 附件仍以文本形式拼进提示词；
- 支持「停止」：AbortController → 杀子进程；
- 结束后落盘会话、刷新来源面板、排空排队消息。

### 5.3 首次选择（安装后第一次激活）

VS Code 扩展没有真正的「安装时回调」，最接近的时机是 **首次激活**（打开侧边栏/执行命令）。
首次激活时弹 QuickPick，三选一 + 「暂不选择」：

- 选项上直接显示探测结果：CLI 是否已安装/版本、桌面端调试端口是否就绪、Key 是否已配置；
- 选 CLI 且未安装 → 给安装命令/文档/终端入口；
- 选 CLI 且未登录 → 直接引导 `doubao login`；
- 选桌面版且端口未开 → 直接触发「以调试端口启动」；
- 选 Ark 且无 Key → 打开设置 Key 命令。

已经手动设置过 `doubao.authMode` 的老用户不会被弹窗打断，只补记「已选择」标记。

### 5.4 配置项

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `doubao.authMode` | `desktop` | `cli` / `desktop` / `ark` |
| `doubao.cli.path` | 空 | CLI 可执行文件；留空自动探测应用数据目录与 PATH |
| `doubao.cli.permissionMode` | `ask_risky` | 传给 `--permission-mode` |
| `doubao.cli.model` | 空 | 传给 `--model`；空 = Auto |
| `doubao.cli.effort` | 空 | `Low/Medium/High`；空 = 不传 |
| `doubao.cli.timeoutMs` | 600000 | 单次任务超时 |

### 5.5 设置中心

首次选择只解决「第一次用哪个通道」。之后所有切换、登录和常用配置集中在
侧边栏标题齿轮 / 命令「豆包: 设置中心」打开的 Webview 面板里：

- **连接方式**：三张卡片（CLI / 桌面版 / Ark），卡片上直接显示安装、登录、端口、Key 状态；
- **未安装 CLI 的自动引导**：安装卡片 + Node/npm 环境检测 + 「一键自动安装」（面板内实时日志、
  通知进度、可取消）；安装完成自动检测版本并打开登录；失败可回退终端安装 / 下载 Node.js；
  从其他通道切到 CLI、聊天里发现 CLI 缺失、或打开设置中心时，都会询问/提供自动安装；
- **登录与连接**：CLI 登录、检查登录、安装方式、终端、后台服务；桌面版连接检测、以调试端口启动；Ark 设置/清除 Key；
- **CLI 配置**：权限策略、模型、推理强度、超时、可执行文件；
- **桌面版配置**：端口、路径、工作模式、模型、推理强度；
- **Ark 配置**：模型、maxTokens、基础地址（只读展示）；
- **通用**：行内补全、终端自动执行、写文件前审阅、接受后自动验证、自动继续与倒计时。

面板只通过 `src/settings/schema.ts` 的白名单写配置：枚举、数字范围、布尔类型逐项校验，
webview 不能借消息改写任意 settings.json 键。

### 5.6 命令

| 命令 | 作用 |
| --- | --- |
| 豆包: 选择连接方式 | 首次选择/随时切换 |
| 豆包: 登录 CLI | 在集成终端跑 `doubao login --qr=png` |
| 豆包: 检查 CLI 安装与登录 | 版本 + `auth status --verify` |
| 豆包: 查看 CLI 安装方式 | 复制安装命令/打开文档/在终端里填命令 |
| 豆包: 自动安装 CLI | 打开设置中心并立即执行 npm 安装（可取消、实时日志） |
| 豆包: 在终端打开 CLI（交互模式） | 打开官方 TUI，用于多轮、/resume、定时任务 |
| 豆包: 启动 CLI 后台服务（远程派发） | `doubao --service-start`，手机/其他设备可派发任务 |

### 5.7 三种形态的分工

官方文档把 CLI 分成交互模式、非交互模式和后台服务，扩展按场景各接一条：

| 场景 | 扩展入口 | 底层 |
| --- | --- | --- |
| 侧边栏一问一答/执行任务 | 输入框发送 | `doubao -p`（可 `--resume` 续接） |
| 需要完整 TUI、定时任务、子 Agent 进度 | 命令「在终端打开 CLI」 | `doubao` |
| 让手机/其他设备给这台机器派任务 | 命令「启动 CLI 后台服务」 | `doubao --service-start` |

这样侧边栏不会去模拟 TUI，也不需要解析全屏转义序列；
复杂交互直接交给官方终端界面，能力不打折。

---

## 6. 使用步骤

1. 安装 Node.js 18+，执行：
   ```powershell
   npm install -g '@bytedance/doubao-cli' --registry=https://registry.npmjs.org/
   doubao --version
   ```
2. 登录：
   ```powershell
   doubao login
   doubao auth status --verify
   ```
3. VS Code 里执行「豆包: 选择连接方式」→ 选「豆包 CLI（轻量 · 推荐）」；
4. 在侧边栏发任务，扩展会调用：
   ```text
   doubao.exe -C <工作区> --permission-mode ask_risky -p "<你的任务>"
   ```
5. 需要换回免 Key 桌面版：再执行一次「选择连接方式」。

---

## 7. 已知限制与后续

1. **非流式**：v1 把 stdout 缓冲到结束再显示，过程状态来自 stderr；如果 CLI 某版本不写 stderr，
   界面只显示「执行中」。后续可按行解析进度。
2. **权限确认无法在侧边栏点**：`-p` 是非交互模式，`ask_always` 可能被 CLI 直接拒绝；
   无人值守建议 `always_allow`，日常建议 `ask_risky`。
3. **会话续接是启发式**：从输出捕获 session id；捕获不到时，扩展把最近 3 轮对话文本作为
   上下文前缀降级发送（有长度截断），后续可改为解析 `doubao --list` 的表格输出。
4. **行内补全仍走 Ark**：CLI 没有 FIM 接口；没有 Key 时建议关闭 `doubao.enableInlineCompletion`。
5. **订阅门槛**：CLI 仅团队/企业订阅可用，个人用户继续用桌面版/Ark。
6. 需要处理 CLI 升级带来的参数变化（`--effort` 取值等）。
7. 自动安装依赖能在 PATH / 常见目录里找到标准安装的 Node.js；nvm/Volta 等非标准布局失败时，
   用安装卡片里的「在终端中安装」即可（命令与官方文档一致）。

---

## 8. 验证

- 新增 `test/cli.test.js`：33 项离线断言（参数顺序、ANSI/回车清理、会话 ID、resume 失效、
  成功/失败/中断/超时）；
- 设置中心：`settings.test.js` 33 项（白名单/归一化/清单/产物）+ `settings-ui.test.js` 26 项
  （伪 DOM 真跑 settings.js：渲染、切换、配置更新、动作、安装卡片/进度/toast）；
- 自动安装器：`cli-install.test.js` 17 项（npm 参数、node/npm-cli 定位、成功/失败/取消/超时）；
- 受影响模块测试：`model-label`、`webview-mode`、`mode-switch`、`task-isolation`、
  `mcp-templates`、`parity` 全绿；
- 手动清单：选择 CLI → 未安装引导 → 安装 → 登录 → 发任务 → 停止 → 超时 → 切换桌面版/Ark。

> 注：当前开发沙箱禁止子进程通过管道捕获输出，`checks`/`mcp-client` 等会真实 spawn 的用例
> 在本机会报 `spawn EPERM`；这是环境限制，不是本功能回归。CI（GitHub Actions）里跑全量即可。

## 7. 验证结果

- `npm test` 退出码 0（全量套件；桌面端 CDP 相关集成测试在无调试端口时标记 SKIP）；
- `test/cli.test.js` 33/33：参数顺序、stdout 解析、ANSI/进度清理、超时、中断、非 0 退出码、session id 捕获；
- 本机 CLI 探测：未安装（`{ installed: false, source: "missing" }`），扩展走“引导安装/登录”分支，不阻塞其它连接方式；
- CLI 相关命令/配置已注册：`doubao.cliLogin / cliCheck / cliInstall / cliOpenTerminal / cliStartService`，
  `doubao.authMode=cli`、`doubao.cli.*` 配置项齐全。
## 8. 优先级调整（0.55.0）

实测 CLI 通道在未登录/未开通订阅时会出现“长时间无任何反馈”，体验不如桌面端。因此调整优先级：

1. **第一优先：豆包桌面版（免 Key）** —— 复用桌面登录态，扩展自带工具循环（PTC），反馈实时；
2. **第二优先：扩展自带 Agent 能力（PTC 工具循环）** —— 不依赖 CLI，桌面端/Ark 都能用；
3. **可选：豆包 CLI** —— 需要团队/企业订阅；仅作为可选通道保留。

对应改动：首次选择与设置中心的连接方式改为「桌面版（推荐）→ CLI（需订阅）→ Ark」，
新增命令「豆包：切换到豆包桌面版」；CLI 运行超过 60 秒无输出会提示并可直接切换回桌面版。