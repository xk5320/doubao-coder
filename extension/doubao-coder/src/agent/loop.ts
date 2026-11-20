import type { ArkClient, ArkMessage, ArkToolCall } from '../ark/client';
import { ArkError, parseToolArguments, toAssistantMessage } from '../ark/client';
import { log, logError, warn } from '../log';
import { MAX_TOOL_RESULT_CHARS, TOOL_DEFINITIONS, arkToolSchemas, executeTool, truncate, type ToolRuntime } from './tools';
import { guardToolCall } from './guard';

export interface ToolStartEvent {
  id: string;
  name: string;
  rawArguments: string;
  arguments: Record<string, unknown>;
}

export interface AgentEvents {
  /** 文本增量（直接推给 webview）。 */
  onTextDelta(text: string): void;
  /** 工具开始执行。 */
  onToolStart(event: ToolStartEvent): void;
  /** 工具执行结束。 */
  onToolEnd(event: { id: string; name: string; ok: boolean; content: string }): void;
  /** 新一轮模型调用开始（round 从 1 开始）。 */
  onRoundStart?(round: number): void;
  /** 整轮结束（正常完成或被中止）。 */
  onDone?(event: { rounds: number; aborted: boolean }): void;
}

export interface AgentRunResult {
  /** 不含 system 的完整会话消息，可直接作为下一轮 history。 */
  messages: ArkMessage[];
  aborted: boolean;
  rounds: number;
}

/**
 * Agent 主循环：OpenAI 风格的 tools / tool_calls 多轮对话。
 *
 * - 每轮最多执行 maxToolIterations 次模型调用；
 * - 单条工具结果截断到 8000 字符；
 * - 支持 AbortSignal（用户点“停止”立即中断）。
 */
export class AgentLoop {
  constructor(
    private readonly client: ArkClient,
    private readonly runtime: ToolRuntime,
    private readonly events: AgentEvents,
    private readonly maxToolIterations: number,
  ) {}

  public async run(
    history: ArkMessage[],
    userContent: string,
    signal: AbortSignal,
    systemPrompt: string,
  ): Promise<AgentRunResult> {
    const messages: ArkMessage[] = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: userContent },
    ];
    const external = this.runtime.externalTools?.definitions() ?? [];
    const tools = arkToolSchemas([...TOOL_DEFINITIONS, ...external]);
    const maxRounds = Math.max(1, this.maxToolIterations);
    let rounds = 0;
    let aborted = false;

    for (let round = 1; round <= maxRounds; round += 1) {
      if (signal.aborted) {
        aborted = true;
        break;
      }
      rounds = round;
      this.events.onRoundStart?.(round);

      let result;
      try {
        result = await this.client.chatStream(
          messages,
          (delta) => {
            if (delta.deltaText) {
              this.events.onTextDelta(delta.deltaText);
            }
          },
          { tools, signal, toolChoice: 'auto' },
        );
      } catch (err) {
        if (signal.aborted || (err instanceof ArkError && err.aborted)) {
          aborted = true;
          log('Agent 已中止（第', round, '轮）');
          break;
        }
        logError(`Agent 第 ${round} 轮请求失败`, err);
        throw err;
      }

      messages.push(toAssistantMessage(result));

      if (result.toolCalls.length === 0) {
        log('Agent 完成', `rounds=${round}`, `text=${result.text.length}字`);
        break;
      }

      log('Agent 请求工具', result.toolCalls.map((call) => call.function.name).join(', '));
      for (const call of result.toolCalls) {
        if (signal.aborted) {
          aborted = true;
          break;
        }
        await this.runOneTool(call, messages);
      }

      if (aborted) {
        break;
      }
      if (round === maxRounds) {
        warn(`已达到最大工具调用轮数 ${maxRounds}，停止继续调用工具。`);
        this.events.onTextDelta(`\n\n> 已达到最大工具调用轮数（${maxRounds}），已停止。可在设置中调整 doubao.maxToolIterations。\n`);
      }
    }

    const result: AgentRunResult = { messages: messages.slice(1), aborted, rounds };
    this.events.onDone?.({ rounds, aborted });
    return result;
  }

  private async runOneTool(call: ArkToolCall, messages: ArkMessage[]): Promise<void> {
    const name = call.function.name;
    const rawArguments = call.function.arguments;
    const parsed = parseToolArguments(rawArguments);

    this.events.onToolStart({ id: call.id, name, rawArguments, arguments: parsed });

    let content: string;
    let ok = false;
    const denied = await guardToolCall(name, parsed, this.runtime);
    if (denied) {
      content = denied;
      this.events.onToolEnd({ id: call.id, name, ok: false, content });
      messages.push({ role: 'tool', tool_call_id: call.id, name, content });
      return;
    }
    try {
      const outcome = await executeTool(name, parsed, this.runtime);
      ok = outcome.ok;
      content = truncate(outcome.content, MAX_TOOL_RESULT_CHARS);
    } catch (err) {
      content = truncate(`工具执行异常：${err instanceof Error ? err.message : String(err)}`, MAX_TOOL_RESULT_CHARS);
      logError(`工具 ${name} 异常`, err);
    }

    this.events.onToolEnd({ id: call.id, name, ok, content });
    messages.push({
      role: 'tool',
      tool_call_id: call.id,
      name,
      content,
    });
  }
}

/** 把历史消息裁剪到大致 token 预算内（保留最近若干条完整消息）。 */
export function trimHistory(messages: ArkMessage[], maxMessages = 40): ArkMessage[] {
  if (messages.length <= maxMessages) {
    return messages;
  }
  let trimmed = messages.slice(messages.length - maxMessages);
  // 会话必须以 user 消息开头：否则可能出现孤立的 tool 消息或只有半截 tool_calls，
  // Ark 会直接返回 400。
  const firstUser = trimmed.findIndex((message) => message.role === 'user');
  if (firstUser > 0) {
    trimmed = trimmed.slice(firstUser);
  } else if (firstUser < 0) {
    trimmed = [];
  }
  return trimmed;
}
