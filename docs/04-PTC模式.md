# PTC 模式：让桌面端通道也能读写工作区

> PTC = **Programmatic Tool Calling**：模型不靠原生 `tool_calls` 字段，而是**在回复正文里写"程序化调用"**，
> 由宿主解析并执行，再把结果喂回去。
>
> 在豆包桌面端通道上这是唯一可行的工具调用方式——因为官方网页只返回纯文本。
> 默认开启（`doubao.ptc.enabled = true`），最大 4 轮（`doubao.ptc.maxRounds`）。

---

## 1. 为什么需要它

| 通道 | 工具调用机制 | 能力 |
|---|---|---|
| Ark API（`authMode=ark`） | 原生 `tools` + `tool_calls` | 7 个工具、结构化、可靠 |
| 桌面端通道（`authMode=desktop`） | **纯文本**，官方不返回 `tool_calls` | 原本只能聊天 |

PTC 就是给"纯文本通道"补上工具能力：**协议是我们自己定的，落在文本里**。

```
┌────────────┐  ① prompt（含协议+工具目录）  ┌──────────────────┐
│ VS Code    │ ───────────────────────────▶ │ 豆包桌面端（已登录）│
│ 扩展       │                              │ 网页里的模型      │
│            │  ② 回复里出现 ```tool 代码块    │                  │
│            │ ◀─────────────────────────── │                  │
│  ③ 解析→执行工具（读写文件/跑命令）           └──────────────────┘
│            │  ④ 把 <tool_result> 发回同一会话 ──────────────────▶
│            │  ⑤ 模型给最终回答（或继续调工具） ◀──────────────────
└────────────┘
```

---

## 2. 协议（模型侧）

系统提示里会注入下面这段（`buildPtcPromptSection()` 生成）：

````markdown
## 工具调用协议（PTC）
需要访问文件/终端/诊断时，必须单独输出一个语言标记为 tool 的代码块，内容是一个 JSON 对象：

```tool
{"name":"read_file","arguments":{"path":"src/main.ts","start_line":1,"end_line":80}}
```

规则：
1. 一个回复里可以输出多个 tool 块，按顺序执行；工具块外可写简短说明。
2. 必须是合法 JSON；不要注释、不要单引号。
3. 路径一律相对工作区根目录，禁止 `..`；写文件前先 read_file。
4. 收到 <tool_result> 再决定下一步；能回答了就直接答，不要再输出 tool 块。
5. 只用下面列出的工具名，不要臆造。

## 可用工具
- read_file(path, start_line?, end_line?) —— 读取工作区内某个文件…
- list_dir(path?, recursive?) —— 列出目录内容…
- grep(pattern, path?, max_results?) —— 正则搜索…
- write_file(path, content) —— 覆盖写…
- apply_patch(path, old_text, new_text) —— 精确替换…
- run_terminal(command, cwd?, timeout_ms?) —— 执行命令（需确认）…
- get_diagnostics(path?) —— 读取 VS Code 诊断…
````

工具结果回灌格式：

```xml
<tool_result id="ptc_1" name="list_dir" ok="true">
[目录] 本机调试输出/
[目录] docs/
...
</tool_result>

（以上是工具执行结果。需要就继续按 PTC 协议调用工具；如果信息已经足够，请直接给出最终回答，不要再输出 tool 块。）
```

---

## 3. 实现（扩展侧）

```
src/agent/ptc.ts
├─ parsePtc(text)            解析出 calls[] + 可展示正文 prose + incomplete 标记
├─ visibleProse(text)        流式过程中「只展示正文」的过滤函数
├─ buildPtcPromptSection()   协议说明 + 工具目录（直接从 TOOL_DEFINITIONS 生成，不会漂移）
└─ class PtcAgent
     run(prompt, signal):
       for round in 1..maxRounds:
         ① askDesktop(round===1 ? prompt : <tool_result 汇总>)
               newChat = 仅第一轮（后续必须留在同一会话，否则丢上下文）
         ② 边流式边用 visibleProse 过滤 → 只把正文推给 webview
         ③ parsePtc(全文)：没有工具块 → 结束
         ④ 依次 executeTool(...)（复用 Ark 模式的 7 个执行器 + 同一套安全校验）
            每步发 tool_start / tool_end 事件 → webview 渲染工具卡片
         ⑤ 拼 <tool_result> 进入下一轮
```

关键设计点：

1. **流式净化**：工具块永远不进正文。`visibleProse` 会剔除完整块、
   也会**扣住未闭合块的尾巴**（包括刚写出的半个围栏 `` ``` ``、`` ```to ``），
   保证 UI 上不会闪过 JSON、可见文本也保持单调增长（有单测覆盖）。
2. **未闭合不执行**：只有围栏闭合、JSON 完整的块才会被执行，避免"半截参数"误操作。
3. **多调用按序执行**：一个回复里可以连续调多个工具（批量读取很常见），结果一次性回灌，省轮次。
4. **轮数硬上限**：默认 4 轮。因为**每一轮都会在你的豆包会话里多一条消息**，太多会很难看。
5. **新会话策略**：第一轮可 `newChat`，后续强制留在同一会话。
   实测"只点新对话按钮"可能不跳转，所以 `ensureFreshChat()` 做了三级兜底
   （点按钮 → `Ctrl+Shift+K` → 再点），并用"消息数是否为 0"校验，日志里会打印是否成功。

---

## 4. 实测（2026-11-18，真机，免 Key）

输入请求：*"用 list_dir 工具看一下工作区根目录有哪些文件和目录（path 用 "."），然后用一句话总结。"*

```
===== 第 1 轮 =====
[doubao][INFO] 桌面端通道：新开会话 成功
[doubao][INFO] 桌面端通道：已写入提示词 1555 字符
[doubao][INFO] 桌面端通道：基线消息 0 字符 streaming=false
[tool_start] list_dir {"path":".","recursive":false}
[tool_end] list_dir ok=true chars=84

===== 第 2 轮 =====
[doubao][INFO] 桌面端通道：连接页面 doubao://doubao-chat/chat/38454381240793858
[tool_end] → 模型直接给答案

工作区根目录包含 artifacts、docs、extension、tools 四个文件夹以及 README.md 文件。

{"rounds":2,"aborted":false,"toolCalls":1,"elapsedMs":22445}
[断言] PASS
```

- 工具块被正确识别（`list_dir` + 参数 `{"path":"."}`），扩展真实执行并回传结果；
- 第二轮模型不再输出工具块，直接作答；
- 新会话确实建出来了（新会话 id `38454381240793858`），两轮都在其中，没有污染旧对话；
- 端到端 **22 s**（首轮含 1555 字符 prompt）。

离线单测：`test/ptc-parser.test.js` —— **23/23 PASS**（单块/多块/未闭合/别名 `args`/非法 JSON/普通代码块不误判/流式单调）。

---

## 5. 代价与边界

| 项 | 说明 |
|---|---|
| 会话污染 | **每轮 = 会话里一条消息**。默认 4 轮上限；建议 `doubao.desktop.newChat = true`，让每次任务在新会话里跑 |
| 延迟 | 每轮要等模型生成，通常 8–20 s；两轮任务 ≈ 20–50 s |
| 可靠性 | 依赖模型"守协议"。实测豆包对 `tool` 代码块遵从度不错，但偶发会漏写围栏或写坏 JSON —— 解析器会报错并让模型重试 |
| 安全 | 与 Ark 模式**共用同一套执行器**：路径必须在工作区内、写文件走 `WorkspaceEdit` 并可撤销、`run_terminal` 默认逐条模态确认 |
| 不适用 | 需要精确结构化调用的重活（大规模重构、需要严格 schema 校验的批处理）仍建议 Ark 模式 |

### 关掉它

```jsonc
{ "doubao.ptc.enabled": false }   // 桌面端通道退化为纯对话
```

---

## 6. 和 Ark 模式的取舍

| | PTC（桌面端） | 原生 tools（Ark） |
|---|---|---|
| 需要 Key | ❌ | ✅ |
| 工具调用可靠性 | 中（靠模型守文本协议） | 高（结构化） |
| 每轮成本 | 你的豆包额度 | token 计费 |
| 会话可见性 | 会出现在豆包历史里 | 只在扩展内 |
| 适用 | 个人、免 Key、轻中量任务 | 产品化、复杂重构 |

两者共用**同一套工具实现与安全策略**（`agent/tools.ts`），切换只改 `doubao.authMode`。

---

## 7. 顺带打通：行内改写（Ctrl+Alt+I）也免 Key 了

PTC 解决的是"多轮 + 工具"；而**行内改写只需要一段代码**，所以走**单轮**桌面端问答即可，
不必开工具循环（多轮只会更慢、更污染会话）：

```
选中代码 + Ctrl+Alt+I
  → inlineEditMessages()（要求模型只输出代码）
  → authMode==='desktop' ? generateRewrite() → askDesktop()（单轮，180s 上限）
  → stripCodeFence() → vscode.diff 预览 → 确认 → WorkspaceEdit 应用（可撤销）
```

真机实测（免 Key）：

```
输入：function sum(a, b) { return a + b; }
指令：改写成箭头函数形式，函数名保持 sum，不要解释，只输出代码
输出：const sum = (a, b) => { return a + b; };
[断言] PASS  用时 5699ms
```

行为差异：

| | Ark 模式 | 桌面端模式 |
|---|---|---|
| 调用 | `ArkClient.chatStream`（流式） | `askDesktop`（一次问答） |
| 取消 | abort HTTP 流 | abort CDP 轮询 + 尽力点"停止生成" |
| 落点 | 都是 `vscode.diff` 预览 → 确认 → `WorkspaceEdit`（可撤销） | 同左 |

> 行内**补全**仍只支持 Ark（官方不开放 FIM）；行内**改写**、**解释选中代码**、**对话 + PTC 工具** 现在都免 Key。
