import { TextDecoder } from 'node:util';
import type { DoubaoConfig } from '../config';
import { debug, log, warn } from '../log';

/* -------------------------------------------------------------------------- */
/* OpenAI 兼容协议类型（Ark / 火山方舟）                                        */
/* -------------------------------------------------------------------------- */

export type ArkRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ArkFunctionCall {
  name: string;
  arguments: string;
}

export interface ArkToolCall {
  id: string;
  type: 'function';
  function: ArkFunctionCall;
}

export interface ArkMessage {
  role: ArkRole;
  content: string | null;
  /** assistant 消息里可能带有工具调用。 */
  tool_calls?: ArkToolCall[];
  /** role=tool 时指向被回应的 tool_call id。 */
  tool_call_id?: string;
  name?: string;
}

export interface ArkToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ArkUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** 单块流式增量，回调给上层渲染 / 聚合。 */
export interface ArkStreamDelta {
  deltaText: string;
  toolCallDelta?: {
    index: number;
    id?: string;
    name?: string;
    argumentsText?: string;
  };
  finishReason?: string;
}

export interface ArkChatResult {
  text: string;
  toolCalls: ArkToolCall[];
  finishReason?: string;
  usage?: ArkUsage;
  /** 原始聚合后的 arguments 字符串（未 JSON.parse），便于调试。 */
  rawToolArguments: string[];
}

export interface ArkRequestOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: ArkToolSchema[];
  toolChoice?: 'auto' | 'none' | 'required';
  signal?: AbortSignal;
  /** 单次请求整体超时，默认 120s。 */
  timeoutMs?: number;
  systemPrompt?: string;
}

/** 带 HTTP 状态与响应体片段的错误，便于面板直接展示。 */
export class ArkError extends Error {
  public readonly status?: number;
  public readonly body?: string;
  public readonly aborted: boolean;

  constructor(message: string, options?: { status?: number; body?: string; aborted?: boolean }) {
    super(message);
    this.name = 'ArkError';
    this.status = options?.status;
    this.body = options?.body;
    this.aborted = options?.aborted ?? false;
  }
}

/** 流式聚合器：文本、tool_calls 分片、finishReason、usage。 */
interface StreamAccumulator {
  content: string;
  calls: Map<number, { index: number; id: string; name: string; arguments: string }>;
  finishReason?: string;
  usage?: ArkUsage;
}

/* -------------------------------------------------------------------------- */
/* 流式读取所需的最小结构类型（避免依赖 DOM lib）                                */
/* -------------------------------------------------------------------------- */

interface ByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel?(reason?: unknown): Promise<void> | void;
  releaseLock?(): void;
}

interface ByteStream {
  getReader(): ByteReader;
}

interface FetchResponseLike {
  ok: boolean;
  status: number;
  statusText: string;
  body: unknown;
  text(): Promise<string>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const ERROR_BODY_LIMIT = 500;

/* -------------------------------------------------------------------------- */
/* ArkClient                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 火山方舟 Ark 的 OpenAI 兼容客户端。
 *
 * - `chatStream`: SSE 流式对话，支持 tool_calls 增量拼接。
 * - `completeFIM`: 行内补全（优先 /completions FIM，失败回退 chat）。
 * - `abort`: 中止当前所有进行中的请求。
 */
export class ArkClient {
  private readonly controllers = new Set<AbortController>();

  constructor(private readonly config: DoubaoConfig) {}

  /** 中止所有进行中的请求（用于“停止生成”按钮 / 扩展停用）。 */
  public abort(reason = '用户中止'): void {
    for (const controller of this.controllers) {
      try {
        controller.abort(reason);
      } catch {
        /* ignore */
      }
    }
    this.controllers.clear();
  }

  public get model(): string {
    return this.config.model;
  }

  private endpoint(path: string): string {
    return `${this.config.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${this.config.apiKey}`,
    };
  }

  private createController(options: ArkRequestOptions): { controller: AbortController; dispose: () => void } {
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      try {
        controller.abort(`请求超时（${Math.round(timeoutMs / 1000)}s）`);
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    const onExternalAbort = (): void => {
      try {
        controller.abort(options.signal?.reason);
      } catch {
        /* ignore */
      }
    };
    if (options.signal) {
      if (options.signal.aborted) {
        onExternalAbort();
      } else {
        options.signal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }
    this.controllers.add(controller);
    return {
      controller,
      dispose: () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onExternalAbort);
        this.controllers.delete(controller);
      },
    };
  }

  /* ---------------------------------------------------------------------- */
  /* 流式对话                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * 发起一次流式 chat completions 请求。
   * `onDelta` 会被逐块调用；返回值为聚合后的完整结果。
   */
  public async chatStream(
    messages: ArkMessage[],
    onDelta: (delta: ArkStreamDelta) => void,
    options: ArkRequestOptions = {},
  ): Promise<ArkChatResult> {
    if (!this.config.apiKey) {
      throw new ArkError('未配置 Ark API Key：请在设置中填写 doubao.apiKey，或设置环境变量 ARK_API_KEY。');
    }

    const payload: Record<string, unknown> = {
      model: options.model ?? this.config.model,
      messages,
      stream: true,
      temperature: options.temperature ?? this.config.temperature,
      max_tokens: options.maxTokens ?? this.config.maxTokens,
    };
    if (options.tools && options.tools.length > 0) {
      payload.tools = options.tools;
      payload.tool_choice = options.toolChoice ?? 'auto';
    }

    const { controller, dispose } = this.createController(options);
    const url = this.endpoint('/chat/completions');
    debug('POST', url, `model=${String(payload.model)}`, `messages=${messages.length}`);

    let response: FetchResponseLike;
    try {
      response = (await fetch(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(payload),
        signal: controller.signal,
      })) as unknown as FetchResponseLike;
    } catch (err) {
      dispose();
      throw this.toAbortOrNetworkError(err, controller);
    }

    if (!response.ok) {
      const body = await safeText(response);
      dispose();
      const message = `Ark 请求失败（HTTP ${response.status} ${response.statusText}）：${body.slice(0, ERROR_BODY_LIMIT)}`;
      warn(message);
      throw new ArkError(message, { status: response.status, body });
    }

    if (!response.body) {
      dispose();
      throw new ArkError('Ark 返回了空响应体（response.body 为 null）。');
    }

    const acc: StreamAccumulator = { content: '', calls: new Map(), finishReason: undefined, usage: undefined };
    try {
      await this.pumpSse(response.body as ByteStream, onDelta, acc, controller);
    } catch (err) {
      if (controller.signal.aborted) {
        throw new ArkError(`请求已中止：${String(controller.signal.reason ?? '')}`, { aborted: true });
      }
      throw err;
    } finally {
      dispose();
    }

    const sortedCalls = [...acc.calls.values()].sort((a, b) => a.index - b.index);
    const result: ArkChatResult = {
      text: acc.content,
      toolCalls: sortedCalls.map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: call.arguments },
      })),
      finishReason: acc.finishReason,
      usage: acc.usage,
      rawToolArguments: sortedCalls.map((c) => c.arguments),
    };
    log('Ark 流式结束', `text=${result.text.length}字`, `toolCalls=${result.toolCalls.length}`, `finish=${result.finishReason ?? '-'}`);
    return result;
  }

  private async pumpSse(
    body: ByteStream,
    onDelta: (delta: ArkStreamDelta) => void,
    acc: StreamAccumulator,
    controller: AbortController,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let sawDone = false;

    try {
      for (;;) {
        if (controller.signal.aborted) {
          throw new ArkError('请求已中止', { aborted: true });
        }
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (!value) {
          continue;
        }
        buffer += decoder.decode(value, { stream: true });
        // SSE 事件之间用空行分隔；逐行处理已完整的行即可。
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex >= 0) {
          const rawLine = buffer.slice(0, newlineIndex).replace(/\r$/, '');
          buffer = buffer.slice(newlineIndex + 1);
          newlineIndex = buffer.indexOf('\n');
          if (rawLine.length === 0 || rawLine.startsWith(':')) {
            continue;
          }
          if (!rawLine.startsWith('data:')) {
            // Ark 偶尔会插入 event: 之类字段，忽略。
            continue;
          }
          const data = rawLine.slice(5).trim();
          if (!data) {
            continue;
          }
          if (data === '[DONE]') {
            sawDone = true;
            continue;
          }
          this.handleData(data, onDelta, acc);
        }
      }
      // flush 尾部残留（极少见：最后一行无换行符）。
      const tail = buffer.trim();
      if (tail.startsWith('data:')) {
        const data = tail.slice(5).trim();
        if (data && data !== '[DONE]') {
          this.handleData(data, onDelta, acc);
        } else if (data === '[DONE]') {
          sawDone = true;
        }
      }
    } finally {
      try {
        reader.releaseLock?.();
      } catch {
        /* ignore */
      }
    }
    if (!sawDone) {
      debug('SSE 结束但未收到 [DONE] 标记');
    }
  }

  private handleData(
    data: string,
    onDelta: (delta: ArkStreamDelta) => void,
    acc: StreamAccumulator,
  ): void {
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      warn('无法解析 SSE 数据块（已忽略）', data.slice(0, 200));
      return;
    }
    if (!isRecord(json)) {
      return;
    }
    if (isRecord(json.usage)) {
      acc.usage = json.usage as ArkUsage;
    }
    const choices = json.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      return;
    }
    const choice = choices[0];
    if (!isRecord(choice)) {
      return;
    }
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
      acc.finishReason = choice.finish_reason;
    }
    const delta = choice.delta;
    if (!isRecord(delta)) {
      return;
    }

    let deltaText = '';
    if (typeof delta.content === 'string') {
      deltaText = delta.content;
      acc.content += deltaText;
    }

    let toolCallDelta: ArkStreamDelta['toolCallDelta'] | undefined;
    const toolCalls = delta.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const rawCall of toolCalls) {
        if (!isRecord(rawCall)) {
          continue;
        }
        const index = typeof rawCall.index === 'number' ? rawCall.index : 0;
        const fn = isRecord(rawCall.function) ? rawCall.function : undefined;
        const id = typeof rawCall.id === 'string' ? rawCall.id : undefined;
        const name = fn && typeof fn.name === 'string' ? fn.name : undefined;
        const argsText = fn && typeof fn.arguments === 'string' ? fn.arguments : undefined;

        const entry = acc.calls.get(index) ?? {
          index,
          id: '',
          name: '',
          arguments: '',
        };
        if (id) {
          entry.id = id;
        }
        if (name) {
          entry.name += name;
        }
        if (argsText) {
          entry.arguments += argsText;
        }
        acc.calls.set(index, entry);

        toolCallDelta = { index, id, name, argumentsText: argsText };
      }
    }

    if (deltaText.length > 0 || toolCallDelta) {
      onDelta({ deltaText, toolCallDelta, finishReason: acc.finishReason });
    }
  }

  private toAbortOrNetworkError(err: unknown, controller: AbortController): Error {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      return new ArkError(`请求已中止：${typeof reason === 'string' ? reason : '用户取消'}`, { aborted: true });
    }
    if (err instanceof Error) {
      return new ArkError(`无法连接 Ark 服务：${err.message}（请检查网络 / 代理 / baseUrl）`);
    }
    return new ArkError(`无法连接 Ark 服务：${String(err)}`);
  }

  /* ---------------------------------------------------------------------- */
  /* 行内补全（FIM）                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * 行内补全：优先使用 Ark 的 `/completions` FIM 接口（prompt + suffix），
   * 若接口不可用（404/400）则自动回退到 chat 补全。
   */
  public async completeFIM(
    prefix: string,
    suffix: string,
    options: ArkRequestOptions = {},
  ): Promise<string> {
    const model = options.model ?? this.config.completionModel ?? this.config.model;
    const maxTokens = options.maxTokens ?? 128;
    const temperature = options.temperature ?? 0;

    try {
      const text = await this.completeViaCompletions(prefix, suffix, model, maxTokens, temperature, options);
      if (text.trim().length > 0) {
        return text;
      }
    } catch (err) {
      if (err instanceof ArkError && err.aborted) {
        throw err;
      }
      debug('FIM /completions 不可用，回退 chat 补全', err instanceof Error ? err.message : String(err));
    }

    return this.completeViaChat(prefix, suffix, model, maxTokens, temperature, options);
  }

  private async completeViaCompletions(
    prefix: string,
    suffix: string,
    model: string,
    maxTokens: number,
    temperature: number,
    options: ArkRequestOptions,
  ): Promise<string> {
    const { controller, dispose } = this.createController({ ...options, timeoutMs: options.timeoutMs ?? 30_000 });
    try {
      const response = (await fetch(this.endpoint('/completions'), {
        method: 'POST',
        headers: { ...this.headers(), Accept: 'application/json' },
        body: JSON.stringify({ model, prompt: prefix, suffix, max_tokens: maxTokens, temperature, stream: false }),
        signal: controller.signal,
      })) as unknown as FetchResponseLike;
      if (!response.ok) {
        const body = await safeText(response);
        throw new ArkError(`FIM 接口不可用（HTTP ${response.status}）：${body.slice(0, ERROR_BODY_LIMIT)}`, {
          status: response.status,
          body,
        });
      }
      const raw = await response.text();
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed) || !Array.isArray(parsed.choices) || parsed.choices.length === 0) {
        return '';
      }
      const first = parsed.choices[0];
      if (!isRecord(first)) {
        return '';
      }
      if (typeof first.text === 'string') {
        return first.text;
      }
      if (isRecord(first.message) && typeof first.message.content === 'string') {
        return first.message.content;
      }
      return '';
    } catch (err) {
      if (controller.signal.aborted) {
        throw new ArkError('补全请求已中止', { aborted: true });
      }
      throw err;
    } finally {
      dispose();
    }
  }

  private async completeViaChat(
    prefix: string,
    suffix: string,
    model: string,
    maxTokens: number,
    temperature: number,
    options: ArkRequestOptions,
  ): Promise<string> {
    const system =
      '你是代码补全引擎。只会输出需要插入到光标处的一小段代码，不要解释、不要 markdown 代码块、不要重复已有代码。' +
      '如果不需要补全就输出空字符串。';
    const user = [
      '请补全下面 <PRE> 与 <POST> 之间的代码。',
      '<PRE>',
      prefix,
      '</PRE>',
      '<POST>',
      suffix,
      '</POST>',
    ].join('\n');

    let result = '';
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort('补全超时'), options.timeoutMs ?? 30_000);
    const onOuterAbort = (): void => {
      try {
        abort.abort(options.signal?.reason ?? '补全被取消');
      } catch {
        /* ignore */
      }
    };
    if (options.signal) {
      if (options.signal.aborted) {
        onOuterAbort();
      } else {
        options.signal.addEventListener('abort', onOuterAbort, { once: true });
      }
    }
    try {
      await this.chatStream(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        (delta) => {
          if (delta.deltaText) {
            result += delta.deltaText;
          }
        },
        { ...options, model, maxTokens, temperature, signal: abort.signal, timeoutMs: options.timeoutMs ?? 30_000 },
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onOuterAbort);
    }
    return result;
  }
}

/* -------------------------------------------------------------------------- */
/* 工具函数                                                                     */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function safeText(response: FetchResponseLike): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/** 容错解析 tool_call 的 arguments 字符串。 */
export function parseToolArguments(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecord(parsed)) {
      return parsed;
    }
    return { value: parsed };
  } catch (err) {
    warn('tool_call arguments 不是合法 JSON，已按空对象处理', err instanceof Error ? err.message : String(err));
    return {};
  }
}

/** 把 assistant 结果转成 OpenAI 协议消息。 */
export function toAssistantMessage(result: ArkChatResult): ArkMessage {
  if (result.toolCalls.length === 0) {
    return { role: 'assistant', content: result.text };
  }
  return {
    role: 'assistant',
    content: result.text.length > 0 ? result.text : null,
    tool_calls: result.toolCalls,
  };
}
