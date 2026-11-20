/**
 * 不依赖第三方库的 MCP（Model Context Protocol）stdio 客户端。
 *
 * 设计要点：
 * - 只用 Node 内置模块（child_process / readline），不 import 'vscode'，可脱离编辑器运行；
 * - 协议为 JSON-RPC 2.0，按行分隔（一行一条消息）；readline 天然处理半行与粘包；
 * - 单行非法 JSON 只记日志，不影响连接；
 * - 子进程退出 / 启动失败时会拒绝所有 pending 请求，不产生 unhandled rejection；
 * - 日志走 onLog 回调，且做脱敏，不输出完整 env / 密钥。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as readline from 'node:readline';

/** 客户端支持的 MCP 协议版本。 */
export const MCP_PROTOCOL_VERSION = '2024-11-05';

const CLIENT_NAME = 'doubao-coder';
const CLIENT_VERSION = '0.1.0';
const HANDSHAKE_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const CLOSE_GRACE_MS = 1_000;
const MAX_LIST_PAGES = 100;
const MAX_LOG_CHARS = 2_000;
const MAX_STDERR_TAIL = 20;

/* -------------------------------------------------------------------------- */
/* 公开类型                                                                    */
/* -------------------------------------------------------------------------- */

/** 单个外部 MCP server 的启动配置。 */
export interface McpServerConfig {
  /** 唯一名称，用于日志与工具名限定（mcp__<server>__<tool>）。 */
  name: string;
  /** 可执行文件，例如 node / npx / python。 */
  command: string;
  args?: string[];
  /** 额外环境变量（会与 process.env 合并，但永远不会被写进日志）。 */
  env?: Record<string, string>;
  cwd?: string;
  /** 默认 true；false 时 pool 不会启动它。 */
  enabled?: boolean;
  /** tools/call 的默认超时（毫秒），默认 60000。握手固定 15 秒。 */
  timeoutMs?: number;
}

/** 聚合后的工具描述。 */
export interface McpToolInfo {
  server: string;
  name: string;
  /** mcp__<sanitized-server>__<sanitized-tool>。 */
  qualifiedName: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** 单个 server 的状态快照。 */
export interface McpServerStatus {
  name: string;
  ok: boolean;
  error?: string;
  toolCount: number;
}

export interface McpServerInfo {
  name: string;
  version?: string;
}

export type McpLogLevel = 'info' | 'warn' | 'error';

export interface McpLogEvent {
  server: string;
  level: McpLogLevel;
  /** 已脱敏、已截断的消息。 */
  message: string;
}

export type McpLogHandler = (event: McpLogEvent) => void;

export interface McpClientOptions {
  /** stderr 与生命周期日志回调；回调抛错不会影响客户端。 */
  onLog?: McpLogHandler;
}

/** tools/call 返回的 content block（保留原始字段）。 */
export interface McpToolContent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface McpToolResult {
  server: string;
  tool: string;
  content: McpToolContent[];
  /** 所有 text block 拼起来的文本（没有 text 时回退为 JSON）。 */
  text: string;
  isError: boolean;
  structuredContent?: unknown;
  raw?: unknown;
}

export interface McpCallOptions {
  timeoutMs?: number;
}

export interface McpClientPoolOptions {
  onLog?: McpLogHandler;
}

/* -------------------------------------------------------------------------- */
/* 错误类型                                                                    */
/* -------------------------------------------------------------------------- */

export class McpError extends Error {
  readonly code: number | undefined;
  readonly server: string;

  constructor(message: string, options: { code?: number; server?: string; cause?: unknown } = {}) {
    super(message);
    this.name = 'McpError';
    this.code = options.code;
    this.server = options.server ?? '';
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export class McpToolError extends McpError {
  readonly tool: string;
  readonly text: string;

  constructor(message: string, options: { server: string; tool: string; text?: string }) {
    super(message, { server: options.server });
    this.name = 'McpToolError';
    this.tool = options.tool;
    this.text = options.text ?? message;
  }
}

/* -------------------------------------------------------------------------- */
/* 工具函数                                                                    */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/** 只保留字母、数字、下划线；中文等非 ASCII 字符逐个替换为下划线。 */
export function sanitizeNamePart(value: string): string {
  const cleaned = String(value ?? '').replace(/[^A-Za-z0-9_]/gu, '_');
  return cleaned.length > 0 ? cleaned : '_';
}

export function qualifiedToolName(server: string, tool: string): string {
  return `mcp__${sanitizeNamePart(server)}__${sanitizeNamePart(tool)}`;
}

const SECRET_ASSIGNMENT = /((?:api[_-]?key|apikey|access[_-]?key|token|secret|password|authorization)\s*[=:]\s*)([^\s,;]+)/gi;
const BEARER_TOKEN = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;

/** 日志脱敏：把 key=value / Bearer token 形式的值抹掉。 */
function redactLog(text: string): string {
  return text.replace(SECRET_ASSIGNMENT, '$1***').replace(BEARER_TOKEN, '$1***');
}

function formatRpcError(error: unknown): { code: number | undefined; message: string } {
  if (isRecord(error)) {
    const code = typeof error.code === 'number' ? error.code : undefined;
    let message = typeof error.message === 'string' ? error.message : '';
    if (!message) {
      try {
        message = JSON.stringify(error);
      } catch {
        message = '未知错误';
      }
    }
    return { code, message };
  }
  if (typeof error === 'string') {
    return { code: undefined, message: error };
  }
  return { code: undefined, message: '未知错误' };
}

interface PendingRequest {
  method: string;
  timer: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/* -------------------------------------------------------------------------- */
/* 单 server 客户端                                                            */
/* -------------------------------------------------------------------------- */

export class McpClient {
  readonly name: string;

  private readonly config: McpServerConfig;
  private readonly onLog: McpLogHandler | undefined;
  private readonly defaultTimeoutMs: number;

  private child: ChildProcessWithoutNullStreams | undefined;
  private stdoutReader: readline.Interface | undefined;
  private stderrReader: readline.Interface | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private nextRequestId = 1;

  private starting: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private ready = false;
  private gone = false;
  private disposed = false;

  private lastErrorText: string | undefined;
  private serverInfoValue: McpServerInfo | undefined;
  private protocolVersionValue: string | undefined;
  private cachedTools: McpToolInfo[] | undefined;
  private readonly stderrTail: string[] = [];

  constructor(config: McpServerConfig, options: McpClientOptions = {}) {
    if (!config || typeof config.name !== 'string' || config.name.trim().length === 0) {
      throw new McpError('MCP server 配置缺少 name');
    }
    if (typeof config.command !== 'string' || config.command.trim().length === 0) {
      throw new McpError(`MCP server "${config.name}" 缺少 command`, { server: config.name });
    }
    const env = config.env
      ? Object.fromEntries(Object.entries(config.env).map(([key, value]) => [key, String(value)]))
      : undefined;
    this.config = {
      ...config,
      name: config.name.trim(),
      command: config.command.trim(),
      args: Array.isArray(config.args) ? config.args.map((arg) => String(arg)) : [],
      env,
    };
    this.name = this.config.name;
    this.onLog = options.onLog;
    this.defaultTimeoutMs = positiveNumber(config.timeoutMs, DEFAULT_CALL_TIMEOUT_MS);
  }

  get connected(): boolean {
    return this.ready && !this.gone && !this.disposed;
  }

  get serverInfo(): McpServerInfo | undefined {
    return this.serverInfoValue;
  }

  get protocolVersion(): string | undefined {
    return this.protocolVersionValue;
  }

  get lastError(): string | undefined {
    return this.lastErrorText;
  }

  /** 启动子进程并完成 initialize 握手（15 秒超时）。 */
  start(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new McpError(`MCP server "${this.name}" 已关闭，无法重新启动`, { server: this.name }));
    }
    if (this.ready) {
      return Promise.resolve();
    }
    if (!this.starting) {
      this.starting = this.doStart().catch(async (err: unknown) => {
        this.starting = undefined;
        this.ready = false;
        this.lastErrorText = err instanceof McpError ? err.message : `启动失败：${errorMessage(err)}`;
        const child = this.child;
        if (child && !this.gone) {
          this.closeReaders();
          await this.stopChild(child);
        }
        this.gone = true;
        throw err instanceof McpError
          ? err
          : new McpError(`MCP server "${this.name}" 启动失败：${errorMessage(err)}`, {
              server: this.name,
              cause: err,
            });
      });
    }
    return this.starting;
  }

  /** tools/list，自动跟随 cursor 分页。 */
  async listTools(): Promise<McpToolInfo[]> {
    this.ensureUsable('列出工具');
    if (this.cachedTools) {
      return this.cachedTools.map((tool) => ({ ...tool }));
    }
    const tools: McpToolInfo[] = [];
    const seenNames = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const params = cursor === undefined ? {} : { cursor };
      const result = await this.request<unknown>('tools/list', params, this.defaultTimeoutMs);
      const payload = isRecord(result) ? result : {};
      const rawTools = Array.isArray(payload.tools) ? payload.tools : [];
      for (const raw of rawTools) {
        if (!isRecord(raw) || typeof raw.name !== 'string' || raw.name.trim().length === 0) {
          continue;
        }
        const toolName = raw.name.trim();
        if (seenNames.has(toolName)) {
          continue;
        }
        seenNames.add(toolName);
        tools.push({
          server: this.name,
          name: toolName,
          qualifiedName: qualifiedToolName(this.name, toolName),
          description: typeof raw.description === 'string' ? raw.description : undefined,
          inputSchema: isRecord(raw.inputSchema) ? raw.inputSchema : { type: 'object', properties: {} },
        });
      }
      const next = typeof payload.nextCursor === 'string' ? payload.nextCursor.trim() : '';
      if (!next || seenCursors.has(next)) {
        break;
      }
      seenCursors.add(next);
      cursor = next;
    }
    this.cachedTools = tools;
    return tools.map((tool) => ({ ...tool }));
  }

  /** tools/call，默认 60 秒超时。工具返回 isError 时不会抛错，由调用方决定。 */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    options: McpCallOptions = {},
  ): Promise<McpToolResult> {
    this.ensureUsable('调用工具');
    const toolName = typeof name === 'string' ? name.trim() : '';
    if (!toolName) {
      throw new McpError(`MCP server "${this.name}" 的工具名不能为空`, { server: this.name });
    }
    if (!isRecord(args)) {
      throw new McpError(`调用 ${toolName} 的参数必须是对象`, { server: this.name });
    }
    const timeoutMs = positiveNumber(options.timeoutMs, this.defaultTimeoutMs);
    const raw = await this.request<unknown>('tools/call', { name: toolName, arguments: args }, timeoutMs);
    return this.normalizeToolResult(toolName, raw);
  }

  /** 可选 ping，用于探活。 */
  async ping(timeoutMs: number = HANDSHAKE_TIMEOUT_MS): Promise<void> {
    this.ensureUsable('ping');
    await this.request<unknown>('ping', {}, positiveNumber(timeoutMs, HANDSHAKE_TIMEOUT_MS));
  }

  /** 幂等关闭：拒绝 pending、结束子进程；重复调用返回同一个 Promise。 */
  close(): Promise<void> {
    if (!this.closing) {
      this.disposed = true;
      this.ready = false;
      this.closing = this.doClose();
    }
    return this.closing;
  }

  dispose(): Promise<void> {
    return this.close();
  }

  /** 当前状态快照。 */
  status(): McpServerStatus {
    const ok = this.connected;
    let error: string | undefined;
    if (!ok) {
      if (this.disposed) {
        error = this.lastErrorText ?? '已关闭';
      } else if (!this.ready) {
        error = this.lastErrorText ?? '未启动';
      }
    }
    return {
      name: this.name,
      ok,
      error,
      toolCount: this.cachedTools?.length ?? 0,
    };
  }

  /* ------------------------------------------------------------------------ */
  /* 内部实现                                                                  */
  /* ------------------------------------------------------------------------ */

  private async doStart(): Promise<void> {
    const args = this.config.args ?? [];
    const env: NodeJS.ProcessEnv = { ...process.env, ...(this.config.env ?? {}) };
    this.log('info', `启动子进程：${this.config.command}（${args.length} 个参数）`);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.config.command, args, {
        cwd: this.config.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      throw new McpError(`MCP server "${this.name}" 启动失败：${errorMessage(err)}`, {
        server: this.name,
        cause: err,
      });
    }
    this.child = child;
    this.gone = false;
    child.on('error', (err) => this.handleProcessError(err));
    child.on('exit', (code, signal) => this.handleExit(code, signal));
    child.stdin.on('error', (err) => this.log('warn', `写入 stdin 失败：${redactLog(err.message)}`));
    this.stdoutReader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.stdoutReader.on('line', (line) => this.handleLine(line));
    this.stdoutReader.on('error', (err) => this.log('warn', `读取 stdout 失败：${err.message}`));
    this.stderrReader = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
    this.stderrReader.on('line', (line) => this.handleStderrLine(line));
    this.stderrReader.on('error', (err) => this.log('warn', `读取 stderr 失败：${err.message}`));

    await this.initializeSession();
    this.ready = true;
    this.lastErrorText = undefined;
    this.log(
      'info',
      `初始化完成（${this.serverInfoValue?.name ?? '未知 server'} / 协议 ${this.protocolVersionValue ?? MCP_PROTOCOL_VERSION}）`,
    );
  }

  private async initializeSession(): Promise<void> {
    const result = await this.request<unknown>(
      'initialize',
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
      },
      HANDSHAKE_TIMEOUT_MS,
    );
    if (!isRecord(result)) {
      throw new McpError(`MCP server "${this.name}" 的 initialize 响应无效`, { server: this.name });
    }
    this.protocolVersionValue =
      typeof result.protocolVersion === 'string' ? result.protocolVersion : undefined;
    const info = isRecord(result.serverInfo) ? result.serverInfo : undefined;
    this.serverInfoValue =
      info && typeof info.name === 'string'
        ? { name: info.name, version: typeof info.version === 'string' ? info.version : undefined }
        : undefined;
    if (!this.protocolVersionValue) {
      this.protocolVersionValue = MCP_PROTOCOL_VERSION;
      this.log('warn', `server 未返回 protocolVersion，按 ${MCP_PROTOCOL_VERSION} 继续`);
    } else if (this.protocolVersionValue !== MCP_PROTOCOL_VERSION) {
      this.log(
        'warn',
        `协议版本不一致：server=${this.protocolVersionValue}，client=${MCP_PROTOCOL_VERSION}，继续尝试`,
      );
    }
    this.sendNotification('notifications/initialized');
  }

  private request<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.disposed) {
        reject(new McpError(`MCP server "${this.name}" 已关闭，无法调用 ${method}`, { server: this.name }));
        return;
      }
      if (this.gone) {
        reject(
          new McpError(
            `MCP server "${this.name}" 未运行（${this.lastErrorText ?? '子进程已退出'}），无法调用 ${method}`,
            { server: this.name },
          ),
        );
        return;
      }
      const id = this.nextRequestId;
      this.nextRequestId += 1;
      const key = String(id);
      const timer = setTimeout(() => {
        if (!this.pending.has(key)) {
          return;
        }
        this.pending.delete(key);
        reject(
          new McpError(`MCP server "${this.name}" 的 ${method} 请求超时（${timeoutMs} ms）`, {
            server: this.name,
            code: -32000,
          }),
        );
      }, timeoutMs);
      this.pending.set(key, {
        method,
        timer,
        resolve: (value) => resolve(value as T),
        reject,
      });
      try {
        this.writeMessage({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(key);
        reject(
          err instanceof McpError
            ? err
            : new McpError(`MCP server "${this.name}" 写入 ${method} 请求失败：${errorMessage(err)}`, {
                server: this.name,
                cause: err,
              }),
        );
      }
    });
  }

  private writeMessage(message: Record<string, unknown>): void {
    const child = this.child;
    if (!child || this.gone) {
      throw new McpError(`MCP server "${this.name}" 未运行`, { server: this.name });
    }
    if (!child.stdin.writable) {
      throw new McpError(`MCP server "${this.name}" 的标准输入已关闭`, { server: this.name });
    }
    let line: string;
    try {
      line = JSON.stringify(message);
    } catch (err) {
      throw new McpError(`无法序列化 JSON-RPC 消息：${errorMessage(err)}`, {
        server: this.name,
        cause: err,
      });
    }
    child.stdin.write(`${line}\n`);
  }

  private sendNotification(method: string, params?: unknown): void {
    try {
      this.writeMessage(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params });
    } catch (err) {
      this.log('warn', `发送通知 ${method} 失败：${errorMessage(err)}`);
    }
  }

  private respondResult(id: string | number, result: unknown): void {
    try {
      this.writeMessage({ jsonrpc: '2.0', id, result });
    } catch (err) {
      this.log('warn', `回复 server 请求失败：${errorMessage(err)}`);
    }
  }

  private respondError(id: string | number, code: number, message: string): void {
    try {
      this.writeMessage({ jsonrpc: '2.0', id, error: { code, message } });
    } catch (err) {
      this.log('warn', `回复 server 请求失败：${errorMessage(err)}`);
    }
  }

  private handleLine(raw: string): void {
    const line = raw.trim();
    if (!line) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      this.log(
        'warn',
        `忽略无法解析的 JSON-RPC 行（${errorMessage(err)}）：${truncate(redactLog(line), 200)}`,
      );
      return;
    }
    try {
      this.handleMessage(parsed);
    } catch (err) {
      this.log('error', `处理 JSON-RPC 消息失败：${errorMessage(err)}`);
    }
  }

  private handleMessage(message: unknown): void {
    if (!isRecord(message)) {
      this.log('warn', '忽略非对象的 JSON-RPC 消息');
      return;
    }
    const method = typeof message.method === 'string' ? message.method : undefined;
    if (method) {
      this.handleServerMethod(message, method);
      return;
    }
    const rawId = message.id;
    if (rawId === undefined || rawId === null) {
      this.log('warn', '收到缺少 id 的响应，已忽略');
      return;
    }
    const entry = this.pending.get(String(rawId));
    if (!entry) {
      this.log('warn', `收到未知请求 id 的响应：${String(rawId)}`);
      return;
    }
    this.pending.delete(String(rawId));
    clearTimeout(entry.timer);
    if (message.error !== undefined) {
      const rpcError = formatRpcError(message.error);
      const suffix = rpcError.code === undefined ? '' : `（code ${rpcError.code}）`;
      entry.reject(
        new McpError(
          `MCP server "${this.name}" 的 ${entry.method} 失败：${redactLog(rpcError.message)}${suffix}`,
          { server: this.name, code: rpcError.code },
        ),
      );
      return;
    }
    entry.resolve(message.result);
  }

  private handleServerMethod(message: Record<string, unknown>, method: string): void {
    const rawId = message.id;
    const hasId = typeof rawId === 'string' || typeof rawId === 'number';
    if (!hasId) {
      if (method === 'notifications/tools/list_changed') {
        this.cachedTools = undefined;
        this.log('info', 'server 通知：工具列表已变化');
      }
      return;
    }
    const id = rawId as string | number;
    if (method === 'ping') {
      this.respondResult(id, {});
      return;
    }
    if (method === 'roots/list') {
      this.respondResult(id, { roots: [] });
      return;
    }
    this.respondError(id, -32601, `客户端不支持的方法：${method}`);
  }

  private handleStderrLine(line: string): void {
    const trimmed = line.trimEnd();
    if (!trimmed) {
      return;
    }
    const safe = truncate(redactLog(trimmed), 500);
    this.stderrTail.push(safe);
    if (this.stderrTail.length > MAX_STDERR_TAIL) {
      this.stderrTail.shift();
    }
    this.log('info', `stderr: ${safe}`);
  }

  private handleProcessError(err: Error): void {
    if (this.gone) {
      return;
    }
    this.gone = true;
    this.ready = false;
    this.lastErrorText = `启动失败：${err.message}`;
    this.log('error', this.lastErrorText);
    this.rejectAllPending(
      new McpError(`MCP server "${this.name}" 启动失败：${err.message}`, {
        server: this.name,
        cause: err,
      }),
    );
    this.closeReaders();
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.gone) {
      return;
    }
    this.gone = true;
    this.ready = false;
    const reason = signal ? `信号 ${signal}` : `退出码 ${String(code)}`;
    const tail =
      this.stderrTail.length > 0 ? `；最近 stderr：${this.stderrTail[this.stderrTail.length - 1]}` : '';
    this.lastErrorText = `子进程已退出（${reason}）${tail}`;
    this.log('warn', `子进程已退出（${reason}）`);
    this.rejectAllPending(
      new McpError(
        `MCP server "${this.name}" 子进程已退出（${reason}），未完成的请求已取消${tail}`,
        { server: this.name },
      ),
    );
    if (!this.closing) {
      this.closeReaders();
    }
  }

  private rejectAllPending(error: McpError): void {
    if (this.pending.size === 0) {
      return;
    }
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      try {
        entry.reject(error);
      } catch {
        /* 忽略 */
      }
    }
  }

  private closeReaders(): void {
    if (this.stdoutReader) {
      try {
        this.stdoutReader.close();
      } catch {
        /* 忽略 */
      }
      this.stdoutReader = undefined;
    }
    if (this.stderrReader) {
      try {
        this.stderrReader.close();
      } catch {
        /* 忽略 */
      }
      this.stderrReader = undefined;
    }
  }

  private stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (): void => {
        if (done) {
          return;
        }
        done = true;
        if (timer) {
          clearTimeout(timer);
        }
        resolve();
      };
      child.once('exit', finish);
      if (child.exitCode !== null || child.signalCode !== null) {
        finish();
        return;
      }
      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* 忽略 */
        }
        finish();
      }, CLOSE_GRACE_MS);
      timer.unref();
      try {
        child.stdin.end();
      } catch {
        /* 忽略 */
      }
      try {
        child.kill('SIGTERM');
      } catch {
        finish();
      }
    });
  }

  private async doClose(): Promise<void> {
    this.ready = false;
    this.rejectAllPending(new McpError(`MCP server "${this.name}" 客户端已关闭`, { server: this.name }));
    this.closeReaders();
    const child = this.child;
    if (child && !this.gone) {
      await this.stopChild(child);
    }
    this.gone = true;
    this.lastErrorText = '已关闭';
    this.cachedTools = undefined;
    this.log('info', '已关闭');
  }

  private ensureUsable(action: string): void {
    if (this.disposed) {
      throw new McpError(`MCP server "${this.name}" 已关闭，无法${action}`, { server: this.name });
    }
    if (this.gone) {
      throw new McpError(
        `MCP server "${this.name}" 未运行（${this.lastErrorText ?? '子进程已退出'}），无法${action}`,
        { server: this.name },
      );
    }
    if (!this.ready) {
      throw new McpError(`MCP server "${this.name}" 尚未完成初始化，无法${action}`, { server: this.name });
    }
  }

  private normalizeToolResult(tool: string, raw: unknown): McpToolResult {
    const record = isRecord(raw) ? raw : {};
    const contentRaw = Array.isArray(record.content) ? record.content : [];
    const content: McpToolContent[] = [];
    for (const item of contentRaw) {
      if (isRecord(item)) {
        content.push({ ...item, type: typeof item.type === 'string' ? item.type : 'text' });
      } else if (typeof item === 'string') {
        content.push({ type: 'text', text: item });
      }
    }
    const textParts = content
      .filter((item) => item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text as string);
    let text = textParts.join('\n');
    if (!text) {
      if (record.structuredContent !== undefined) {
        try {
          text = JSON.stringify(record.structuredContent);
        } catch {
          text = String(record.structuredContent);
        }
      } else if (raw !== undefined) {
        try {
          text = JSON.stringify(raw);
        } catch {
          text = String(raw);
        }
      }
    }
    return {
      server: this.name,
      tool,
      content,
      text,
      isError: record.isError === true,
      structuredContent: record.structuredContent,
      raw,
    };
  }

  private log(level: McpLogLevel, message: string): void {
    const handler = this.onLog;
    if (!handler) {
      return;
    }
    const safe = truncate(redactLog(message), MAX_LOG_CHARS);
    try {
      handler({ server: this.name, level, message: safe });
    } catch {
      /* 用户回调异常不影响客户端 */
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 多 server 连接池                                                            */
/* -------------------------------------------------------------------------- */

interface PoolRoute {
  server: string;
  tool: string;
}

export class McpClientPool {
  private readonly entries = new Map<string, McpClient>();
  private readonly statuses = new Map<string, McpServerStatus>();
  private statusOrder: string[] = [];
  private readonly routes = new Map<string, PoolRoute>();
  private activeLog: McpLogHandler | undefined;
  private starting: Promise<McpServerStatus[]> | undefined;
  private disposing: Promise<void> | undefined;
  private disposed = false;
  private started = false;

  constructor(options: McpClientPoolOptions = {}) {
    this.activeLog = options.onLog;
  }

  /**
   * 并发启动所有 enabled 的 server：用 Promise.allSettled 隔离单个失败。
   * 重复调用返回同一次启动的结果。
   */
  start(configs: McpServerConfig[], options: McpClientPoolOptions = {}): Promise<McpServerStatus[]> {
    if (this.disposed) {
      return Promise.reject(new McpError('MCP 客户端池已关闭，无法启动'));
    }
    if (options.onLog) {
      this.activeLog = options.onLog;
    }
    if (!this.starting) {
      this.starting = this.doStart(Array.isArray(configs) ? configs : []);
    }
    return this.starting;
  }

  /** 汇总所有可用 server 的工具（每个 server 内部已处理分页）。 */
  async listTools(): Promise<McpToolInfo[]> {
    this.ensureStarted();
    const entries = [...this.entries.entries()];
    const settled = await Promise.allSettled(
      entries.map(async ([name, client]) => {
        const tools = await client.listTools();
        const status = this.statuses.get(name);
        if (status) {
          status.ok = true;
          status.error = undefined;
          status.toolCount = tools.length;
        }
        return tools;
      }),
    );
    const all: McpToolInfo[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < settled.length; index += 1) {
      const result = settled[index];
      const entry = entries[index];
      if (!entry) {
        continue;
      }
      const [name] = entry;
      if (result.status === 'fulfilled') {
        this.registerRoutes(name, result.value);
        for (const tool of result.value) {
          if (seen.has(tool.qualifiedName)) {
            continue;
          }
          seen.add(tool.qualifiedName);
          all.push(tool);
        }
      } else {
        const status = this.statuses.get(name);
        if (status) {
          status.ok = false;
          status.error = `列出工具失败：${errorMessage(result.reason)}`;
        }
        this.log(name, 'error', `列出工具失败：${errorMessage(result.reason)}`);
      }
    }
    return all;
  }

  /** 按 mcp__<server>__<tool> 路由并返回文本；工具报错时抛出 McpToolError。 */
  async callTool(
    qualifiedName: string,
    args: Record<string, unknown> = {},
    options: McpCallOptions = {},
  ): Promise<string> {
    this.ensureStarted();
    const name = typeof qualifiedName === 'string' ? qualifiedName.trim() : '';
    if (!name) {
      throw new McpError('MCP 工具名不能为空');
    }
    const route = this.resolveRoute(name);
    if (!route) {
      const available = [...this.routes.keys()].slice(0, 8);
      const suffix = available.length > 0 ? `（可用：${available.join(', ')}）` : '';
      throw new McpError(`未找到 MCP 工具：${name}${suffix}`);
    }
    const client = this.entries.get(route.server);
    if (!client) {
      throw new McpError(`MCP server "${route.server}" 未启动，无法调用工具 ${name}`);
    }
    const result = await client.callTool(route.tool, args, options);
    if (result.isError) {
      throw new McpToolError(result.text || `MCP 工具 ${name} 执行失败`, {
        server: route.server,
        tool: route.tool,
        text: result.text,
      });
    }
    return result.text;
  }

  /** 每个 server 的状态快照（保持配置顺序）。 */
  status(): McpServerStatus[] {
    return this.statusOrder.map((name) => {
      const status = this.statuses.get(name);
      return status ? { ...status } : { name, ok: false, error: '未启动', toolCount: 0 };
    });
  }

  getClient(server: string): McpClient | undefined {
    return this.entries.get(server);
  }

  /** 关闭全部 server；幂等。 */
  dispose(): Promise<void> {
    if (this.disposing) {
      return this.disposing;
    }
    this.disposed = true;
    this.disposing = this.doDispose();
    return this.disposing;
  }

  private async doDispose(): Promise<void> {
    const entries = [...this.entries.entries()];
    const results = await Promise.allSettled(entries.map(([, client]) => client.close()));
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      const entry = entries[index];
      if (!entry) {
        continue;
      }
      const [name] = entry;
      if (result.status === 'rejected') {
        this.log(name, 'warn', `关闭失败：${errorMessage(result.reason)}`);
      }
      const status = this.statuses.get(name);
      if (status) {
        status.ok = false;
        status.error = '已关闭';
      }
    }
    this.routes.clear();
    this.entries.clear();
    this.started = false;
  }

  private async doStart(configs: McpServerConfig[]): Promise<McpServerStatus[]> {
    const tasks = configs.map(async (config) => {
      if (!config || typeof config.name !== 'string' || config.name.trim().length === 0) {
        this.log('(未命名)', 'warn', 'MCP server 配置缺少 name，已忽略');
        return;
      }
      const name = config.name.trim();
      if (this.statuses.has(name)) {
        this.log(name, 'warn', 'MCP server 名称重复，已忽略');
        return;
      }
      const status: McpServerStatus = { name, ok: false, error: '启动中', toolCount: 0 };
      this.statuses.set(name, status);
      this.statusOrder.push(name);
      if (config.enabled === false) {
        status.error = '已禁用（enabled=false）';
        return;
      }
      let client: McpClient;
      try {
        client = new McpClient(config, { onLog: this.activeLog });
      } catch (err) {
        status.error = `配置无效：${errorMessage(err)}`;
        this.log(name, 'error', status.error);
        return;
      }
      this.entries.set(name, client);
      try {
        await client.start();
        let tools: McpToolInfo[];
        try {
          tools = await client.listTools();
        } catch (err) {
          status.ok = false;
          status.error = `已连接，但列出工具失败：${errorMessage(err)}`;
          this.log(name, 'error', status.error);
          await client.close().catch(() => undefined);
          return;
        }
        status.ok = true;
        status.error = undefined;
        status.toolCount = tools.length;
        this.registerRoutes(name, tools);
      } catch (err) {
        status.ok = false;
        status.error = `启动失败：${errorMessage(err)}`;
        this.log(name, 'error', status.error);
      }
    });
    await Promise.allSettled(tasks);
    this.started = true;
    return this.status();
  }

  private registerRoutes(server: string, tools: McpToolInfo[]): void {
    for (const tool of tools) {
      const existing = this.routes.get(tool.qualifiedName);
      if (existing) {
        if (existing.server !== server || existing.tool !== tool.name) {
          this.log(
            server,
            'warn',
            `工具名冲突：${tool.qualifiedName}，保留 ${existing.server}/${existing.tool}`,
          );
        }
        continue;
      }
      this.routes.set(tool.qualifiedName, { server, tool: tool.name });
    }
  }

  private resolveRoute(qualifiedName: string): PoolRoute | undefined {
    const known = this.routes.get(qualifiedName);
    if (known) {
      return known;
    }
    if (!qualifiedName.startsWith('mcp__')) {
      return undefined;
    }
    const rest = qualifiedName.slice('mcp__'.length);
    const servers = [...this.entries.keys()].sort(
      (left, right) => sanitizeNamePart(right).length - sanitizeNamePart(left).length,
    );
    for (const server of servers) {
      const prefix = `${sanitizeNamePart(server)}__`;
      if (rest.startsWith(prefix) && rest.length > prefix.length) {
        return { server, tool: rest.slice(prefix.length) };
      }
    }
    return undefined;
  }

  private ensureStarted(): void {
    if (this.disposed) {
      throw new McpError('MCP 客户端池已关闭');
    }
    if (!this.started) {
      throw new McpError('MCP 客户端池尚未启动，请先调用 await pool.start(configs)');
    }
  }

  private log(server: string, level: McpLogLevel, message: string): void {
    const handler = this.activeLog;
    if (!handler) {
      return;
    }
    const safe = truncate(redactLog(message), MAX_LOG_CHARS);
    try {
      handler({ server, level, message: safe });
    } catch {
      /* 忽略 */
    }
  }
}
