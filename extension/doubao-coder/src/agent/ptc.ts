/**
 * PTC 模式（Programmatic Tool Calling）
 *
 * 背景：桌面端通道只能拿到「纯文本」。官方网页不会按 OpenAI 的 `tool_calls` 协议返回结构化调用，
 * 所以这里用**文本工具体**实现同样的效果：
 *
 *   模型在回复里输出      ```tool
 *                        {"name":"read_file","arguments":{"path":"src/a.ts"}}
 *                        ```
 *   扩展解析 → 执行 → 把结果以 <tool_result> 形式**发回同一个豆包会话** → 模型继续
 *
 * 这样免 API Key 的桌面端通道也能读写工作区（否则只能聊天）。
 *
 * 代价：每一轮工具调用 = 在用户会话里多一条消息，所以默认轮数较小（4），并允许关闭。
 */
import type { DoubaoConfig } from '../config';
import { askDesktop, type DesktopImage } from '../bridge/desktop';
import type { ReplyBlock } from '../bridge/blocks';
import { log, warn } from '../log';
import { MAX_TOOL_RESULT_CHARS, TOOL_DEFINITIONS, executeTool, truncate, type ToolDefinition, type ToolRuntime } from './tools';
import { guardToolCall } from './guard';

/** 允许的围栏语言标记（大小写不敏感）。 */
const FENCE_LANGS = ['tool', 'ptc'];

export interface PtcToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  raw: string;
  /** 解析失败时的原因（此时不执行）。 */
  error?: string;
}

export interface ParsedPtc {
  calls: PtcToolCall[];
  /** 去掉工具块之后的可展示正文。 */
  prose: string;
  /** 是否还有未闭合的工具块（流式过程中会出现）。 */
  incomplete: boolean;
}

interface Block {
  startLine: number;
  endLine: number;
  body: string;
}

function isFenceOpen(line: string): boolean {
  const m = /^\s*```(\w+)\s*$/.exec(line.trim());
  return Boolean(m && FENCE_LANGS.includes(m[1].toLowerCase()));
}

function isFenceClose(line: string): boolean {
  return /^\s*```\s*$/.test(line);
}

function scanBlocks(text: string): { blocks: Block[]; incomplete: boolean; proseLines: Set<number> } {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  const consumed = new Set<number>();
  let incomplete = false;

  for (let i = 0; i < lines.length; i += 1) {
    if (consumed.has(i) || !isFenceOpen(lines[i])) {
      continue;
    }
    let close = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (isFenceClose(lines[j])) {
        close = j;
        break;
      }
    }
    if (close === -1) {
      incomplete = true;
      // 未闭合：把从这里到结尾都视为「不可展示」
      for (let j = i; j < lines.length; j += 1) {
        consumed.add(j);
      }
      break;
    }
    blocks.push({ startLine: i, endLine: close, body: lines.slice(i + 1, close).join('\n') });
    for (let j = i; j <= close; j += 1) {
      consumed.add(j);
    }
    i = close;
  }
  return { blocks, incomplete, proseLines: consumed };
}

/** 从一段文本里抽取「第一个完整的 JSON 对象」。 */
function firstJsonObject(body: string): unknown {
  const trimmed = body.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* 继续尝试截取 */
  }
  const start = trimmed.indexOf('{');
  if (start < 0) {
    return undefined;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/** 解析模型回复：抽出工具调用，并给出可展示正文。 */
export function parsePtc(text: string): ParsedPtc {
  const { blocks, incomplete, proseLines } = scanBlocks(text);
  const calls: PtcToolCall[] = [];

  blocks.forEach((block, index) => {
    const parsed = firstJsonObject(block.body) as
      | { name?: unknown; arguments?: unknown; args?: unknown }
      | undefined;
    const id = `ptc_${index + 1}`;
    if (!parsed || typeof parsed !== 'object') {
      calls.push({ id, name: '?', arguments: {}, raw: block.body, error: '工具块不是合法 JSON' });
      return;
    }
    const name = typeof parsed.name === 'string' ? parsed.name : '';
    const rawArgs = parsed.arguments ?? parsed.args ?? {};
    const args =
      rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {};
    if (!name) {
      calls.push({ id, name: '?', arguments: {}, raw: block.body, error: '缺少 name 字段' });
      return;
    }
    calls.push({ id, name, arguments: args, raw: block.body });
  });

  const lines = text.split('\n');
  let prose = lines
    .filter((_, i) => !proseLines.has(i))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // 流式中间态：结尾可能刚好是「```」或「```to」这种半个围栏。
  // 这类尾巴不能展示（否则用户会看到一闪而过的反引号），也会破坏"可见文本单调增长"。
  const lastLine = lines[lines.length - 1] ?? '';
  if (/^[ \t]*`{1,3}/.test(lastLine) && !/^[ \t]*```[ \t]*$/.test(lastLine)) {
    const proseLinesArr = prose.split('\n');
    if (proseLinesArr.length > 0 && proseLinesArr[proseLinesArr.length - 1].trim() === lastLine.trim()) {
      proseLinesArr.pop();
      prose = proseLinesArr.join('\n').replace(/\s+$/, '');
    }
  }

  return { calls, prose, incomplete };
}

/** 只保留可展示的正文（工具块与未闭合块都不展示）。 */
export function visibleProse(text: string): string {
  return parsePtc(text).prose;
}

/** 面向模型的协议说明 + 工具目录（可附加外部工具，例如 MCP server）。 */
export function buildPtcPromptSection(extraTools: ToolDefinition[] = []): string {
  const catalog = [...TOOL_DEFINITIONS, ...extraTools].map((tool) => {
    const params = tool.parameters as { properties?: Record<string, { description?: string }>; required?: string[] };
    const required = new Set(params.required ?? []);
    const args = Object.keys(params.properties ?? {})
      .map((key) => {
        const description = params.properties?.[key]?.description ?? '';
        return `${key}${required.has(key) ? '' : '?'}（${description.slice(0, 40)}）`;
      })
      .join('，');
    return `- ${tool.name}(${args}) —— ${tool.description}`;
  }).join('\n');

  return [
    '## 工具调用协议（PTC）',
    '你可以读写用户当前打开的工程。需要访问文件/终端/诊断时，**必须**单独输出一个语言标记为 tool 的代码块，内容是一个 JSON 对象：',
    '',
    '```tool',
    '{"name":"read_file","arguments":{"path":"src/main.ts","start_line":1,"end_line":80}}',
    '```',
    '',
    '规则（务必遵守）：',
    '1. 一个回复里可以输出多个 tool 块，按出现顺序执行；工具块之外可以写简短说明。',
    '2. 工具块必须是**合法 JSON**，不要加注释、不要用单引号、不要在 JSON 里换行字符串。',
    '3. 路径一律相对工作区根目录，禁止 `..`；写文件前先用 read_file 看一眼原文。',
    '4. 收到 `<tool_result>` 之后再决定下一步；如果已经能回答，就**正常作答、不要再输出 tool 块**。',
    '5. 只允许使用下面列出的工具名，不要臆造工具或参数。',
    '',
    '## 可用工具',
    catalog,
    '',
    '## 运行环境',
    `- 系统：${process.platform === 'win32' ? 'Windows' : process.platform}；终端是 ${process.platform === 'win32' ? 'cmd.exe / PowerShell' : '/bin/sh'}。`,
    process.platform === 'win32'
      ? '- **不要使用 Unix 命令**（`head`/`tail`/`grep`/`ls`/`cat`/`sed`），用 PowerShell 等价物（`Get-Content -TotalCount 40`、`Select-String`、`Get-ChildItem`）。'
      : '- 使用 POSIX 命令。',
    '- 读文件优先用 read_file 工具，不要用终端去 cat/head。',
    '- 参数名严格按上面列出的写（`path` 不是 `file_path`，`old_text`/`new_text` 不是 `old_string`/`new_string`）。',
  ].join('\n');
}

/** 工具结果回灌给模型的格式。 */
function buildToolResultsMessage(
  results: Array<{ id: string; name: string; ok: boolean; content: string }>,
): string {
  const body = results
    .map(
      (r) =>
        `<tool_result id="${r.id}" name="${r.name}" ok="${r.ok ? 'true' : 'false'}">\n${r.content}\n</tool_result>`,
    )
    .join('\n\n');
  return [
    body,
    '',
    '（以上是工具执行结果。需要就继续按 PTC 协议调用工具；如果信息已经足够，请直接给出最终回答，不要再输出 tool 块。）',
  ].join('\n');
}

export interface PtcEvents {
  onTextDelta(text: string): void;
  /** 回复里出现新图片（例如豆包生图）。 */
  onImage?(image: DesktopImage): void;
  /** 豆包界面的分块（正文/命令/状态），用于与界面同源同步。 */
  onBlocks?(blocks: ReplyBlock[]): void;
  onToolStart(event: { id: string; name: string; arguments: Record<string, unknown>; raw: string }): void;
  onToolEnd(event: { id: string; name: string; ok: boolean; content: string }): void;
  onRoundStart?(round: number): void;
  onDone?(info: { rounds: number; aborted: boolean; messages: number }): void;
}

export interface PtcRunResult {
  text: string;
  rounds: number;
  aborted: boolean;
  toolCalls: number;
}

export class PtcAgent {
  constructor(
    private readonly config: DoubaoConfig,
    private readonly runtime: ToolRuntime,
    private readonly events: PtcEvents,
    /** 覆盖 doubao.desktop.newChat（用户点“新建对话”时强制新开一个豆包会话）。 */
    private readonly newChatOverride?: boolean,
  ) {}

  /**
   * 跑一轮 PTC 会话。
   * @param prompt 首轮要发的完整内容（系统提示 + 协议 + 上下文 + 用户问题）
   */
  public async run(prompt: string, signal: AbortSignal): Promise<PtcRunResult> {
    const maxRounds = Math.max(1, this.config.ptcMaxRounds);
    let round = 0;
    let toolCalls = 0;
    let answer = '';
    let aborted = false;
    let followUp = '';

    while (round < maxRounds) {
      if (signal.aborted) {
        aborted = true;
        break;
      }
      round += 1;
      this.events.onRoundStart?.(round);
      const isFirst = round === 1;
      const message = isFirst ? prompt : followUp;

      let raw = '';
      let emitted = 0;
      const ask = await askDesktop(message, {
        port: this.config.desktopPort,
        // 只有第一轮允许新开会话；后续轮必须留在同一个会话里，否则会丢上下文
        newChat: isFirst ? (this.newChatOverride ?? this.config.desktopNewChat) : false,
        timeoutMs: this.config.desktopTimeoutMs,
        onImage: (image) => this.events.onImage?.(image),
        onBlocks: (blocks) => this.events.onBlocks?.(blocks),
        signal,
        onDelta: (delta) => {
          raw += delta;
          const visible = visibleProse(raw);
          if (visible.length > emitted) {
            const piece = visible.slice(emitted);
            emitted = visible.length;
            this.events.onTextDelta(piece);
          }
        },
      });

      aborted = ask.aborted;
      if (ask.aborted) {
        break;
      }
      // askDesktop 的最后一个 delta 之后 raw 已经是全量；这里以最终文本为准再兜一次底
      if (ask.text.length > raw.length) {
        raw = ask.text;
        const visible = visibleProse(raw);
        if (visible.length > emitted) {
          const piece = visible.slice(emitted);
          emitted = visible.length;
          this.events.onTextDelta(piece);
        }
      }

      const parsed = parsePtc(raw);
      answer = parsed.prose;
      if (parsed.calls.length === 0) {
        log('PTC 结束', `rounds=${round}`, `answer=${answer.length}字`);
        break;
      }

      const results: Array<{ id: string; name: string; ok: boolean; content: string }> = [];
      for (const call of parsed.calls) {
        if (signal.aborted) {
          aborted = true;
          break;
        }
        toolCalls += 1;
        this.events.onToolStart({ id: call.id, name: call.name, arguments: call.arguments, raw: call.raw });

        let ok = false;
        let content: string;
        if (call.error) {
          content = `工具块解析失败：${call.error}`;
        } else {
          const denied = await guardToolCall(call.name, call.arguments, this.runtime);
          if (denied) {
            content = denied;
            this.events.onToolEnd({ id: call.id, name: call.name, ok: false, content: truncate(content, MAX_TOOL_RESULT_CHARS) });
            results.push({ id: call.id, name: call.name, ok: false, content: truncate(content, MAX_TOOL_RESULT_CHARS) });
            continue;
          }
          try {
            const outcome = await executeTool(call.name, call.arguments, this.runtime);
            ok = outcome.ok;
            content = outcome.content;
          } catch (err) {
            content = `工具执行异常：${err instanceof Error ? err.message : String(err)}`;
          }
        }
        const clipped = truncate(content, MAX_TOOL_RESULT_CHARS);
        this.events.onToolEnd({ id: call.id, name: call.name, ok, content: clipped });
        results.push({ id: call.id, name: call.name, ok, content: clipped });
      }

      if (aborted) {
        break;
      }
      if (round === maxRounds) {
        warn(`PTC 已达最大轮数 ${maxRounds}，停止继续调用工具`);
        break;
      }
      followUp = buildToolResultsMessage(results);
    }

    const result: PtcRunResult = { text: answer, rounds: round, aborted, toolCalls };
    this.events.onDone?.({ rounds: round, aborted, messages: round });
    return result;
  }
}
