/**
 * 独立 MCP（Model Context Protocol）stdio server。
 *
 * 运行方式：
 *   node out/mcp/server.js
 * 环境变量：
 *   DOUBAO_MCP_ROOT     限制访问的根目录（默认 WORKSPACE_FOLDER，其次 cwd）
 *
 * 协议：JSON-RPC 2.0，按行分隔（每行一条消息）。只使用 stdout 通信，
 * 所有日志/错误写到 stderr，避免污染协议流。
 *
 * 注意：本文件不依赖 vscode 模块，可脱离编辑器独立运行。
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline';

const SERVER_NAME = 'doubao-coder-mcp';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';
const MAX_OUTPUT = 8000;
const MAX_FILE_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'out', 'dist', 'build', 'target', '.vscode-test']);

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface ToolOutcome {
  ok: boolean;
  text: string;
}

/** 允许访问的根目录。 */
const ROOT = resolveRoot();
const REAL_ROOT = realPathForBoundary(ROOT);

function resolveRoot(): string {
  const raw = process.env.DOUBAO_MCP_ROOT ?? process.env.WORKSPACE_FOLDER ?? process.cwd();
  const resolved = path.resolve(raw);
  try {
    if (fs.statSync(resolved).isDirectory()) {
      return resolved;
    }
  } catch {
    /* ignore */
  }
  return process.cwd();
}

function logStderr(...parts: unknown[]): void {
  process.stderr.write(`${parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ')}\n`);
}

/**
 * 取真实路径；目标不存在时取最近存在祖先的真实路径再拼回剩余段。
 * 用来识别 junction / symlink 指向根目录外的情况。
 */
function realPathForBoundary(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    /* 目标不存在，继续找祖先 */
  }
  let current = target;
  const suffix: string[] = [];
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) {
      return target;
    }
    suffix.unshift(path.basename(current));
    current = parent;
    try {
      return path.join(fs.realpathSync.native(current), ...suffix);
    } catch {
      /* 继续向上 */
    }
  }
}

/** 把入参路径解析为根目录内的绝对路径，越界（含符号链接逃逸）直接抛错。 */
function insideRoot(input: unknown, fallback = '.'): string {
  const raw = typeof input === 'string' && input.trim().length > 0 ? input.trim() : fallback;
  const target = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(ROOT, raw);
  const realTarget = realPathForBoundary(target);
  const rootWithSep = REAL_ROOT.endsWith(path.sep) ? REAL_ROOT : `${REAL_ROOT}${path.sep}`;
  const comparable = realTarget.endsWith(path.sep) ? realTarget : `${realTarget}${path.sep}`;
  if (!comparable.toLowerCase().startsWith(rootWithSep.toLowerCase()) && realTarget.toLowerCase() !== REAL_ROOT.toLowerCase()) {
    throw new Error(`路径越界：${raw} 不在根目录 ${ROOT} 内（或经符号链接指向了根目录外）`);
  }
  return target;
}

function truncate(text: string, limit = MAX_OUTPUT): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…（已截断，原长 ${text.length} 字符）`;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/* -------------------------------------------------------------------------- */
/* 工具定义                                                                    */
/* -------------------------------------------------------------------------- */

type StateListener = (state: Record<string, unknown>) => void;
let stateListener: StateListener | undefined;
/** 由扩展注册：MCP 工具 report_state 收到的状态转给面板。 */
export function onMcpState(listener: StateListener): void {
  stateListener = listener;
}

function emitState(state: Record<string, unknown>): void {
  try {
    stateListener?.(state);
  } catch {
    /* 忽略 */
  }
}

const TOOLS: McpTool[] = [
  {
    name: 'report_state',
    description: '把当前对话/任务状态推给 VS Code 扩展（阶段、进度、命令、是否结束）。扩展据此渲染与豆包一致的对话框状态。',
    inputSchema: {
      type: 'object',
      properties: {
        phase: { type: 'string', description: 'thinking | executing | done | failed' },
        elapsed_seconds: { type: 'number', description: '已处理秒数' },
        command: { type: 'string', description: '正在/刚执行的命令' },
        summary: { type: 'string', description: '一句话进度描述' },
        finished: { type: 'boolean', description: '这一轮是否结束' },
      },
      required: ['phase'],
    },
  },
  {
    name: 'read_file',
    description: '读取根目录内某个文件的文本内容（可指定行范围）。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，相对根目录。' },
        start_line: { type: 'number', description: '起始行号（1 基，可选）。' },
        end_line: { type: 'number', description: '结束行号（可选）。' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_dir',
    description: '列出目录内容。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径，默认根目录。' },
        recursive: { type: 'boolean', description: '是否递归，默认 false。' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'grep',
    description: '按正则搜索文本，返回 文件:行号:内容。',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式。' },
        path: { type: 'string', description: '搜索目录，默认根目录。' },
        max_results: { type: 'number', description: '最多命中条数，默认 50。' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_file',
    description: '创建或覆盖根目录内的文件。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，相对根目录。' },
        content: { type: 'string', description: '完整文件内容。' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_shell',
    description: '在根目录下执行一条 shell 命令（同步，最长 60 秒），返回输出。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '命令行。' },
        cwd: { type: 'string', description: '工作目录，默认根目录。' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
];

/* -------------------------------------------------------------------------- */
/* 工具实现                                                                    */
/* -------------------------------------------------------------------------- */

async function readFileTool(args: Record<string, unknown>): Promise<ToolOutcome> {
  const target = insideRoot(args.path);
  const stats = await fsp.stat(target);
  if (!stats.isFile()) {
    return { ok: false, text: `${target} 不是文件` };
  }
  if (stats.size > MAX_FILE_BYTES) {
    return { ok: false, text: `文件过大（${stats.size} 字节）` };
  }
  const content = await fsp.readFile(target, 'utf8');
  const lines = content.split(/\r?\n/);
  const start = Math.max(1, Math.floor(num(args.start_line) ?? 1));
  const end = Math.min(lines.length, Math.floor(num(args.end_line) ?? lines.length));
  const slice = lines.slice(start - 1, Math.max(start, end)).join('\n');
  return {
    ok: true,
    text: truncate(`文件：${path.relative(ROOT, target)}（共 ${lines.length} 行）\n${slice}`),
  };
}

async function listDirTool(args: Record<string, unknown>): Promise<ToolOutcome> {
  const target = insideRoot(args.path, '.');
  const recursive = args.recursive === true;
  const entries: string[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (entries.length >= 300 || depth > 4) {
      return;
    }
    const dirents = await fsp.readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      if (entries.length >= 300) {
        return;
      }
      const abs = path.join(dir, dirent.name);
      const rel = path.relative(ROOT, abs).split(path.sep).join('/');
      if (dirent.isDirectory()) {
        entries.push(`[目录] ${rel}/`);
        if (recursive && !SKIP_DIRS.has(dirent.name)) {
          await walk(abs, depth + 1);
        }
      } else {
        entries.push(`[文件] ${rel}`);
      }
    }
  };

  await walk(target, 0);
  return { ok: true, text: entries.length > 0 ? entries.join('\n') : '（空目录）' };
}

async function grepTool(args: Record<string, unknown>): Promise<ToolOutcome> {
  const pattern = typeof args.pattern === 'string' ? args.pattern : '';
  if (!pattern) {
    return { ok: false, text: '缺少 pattern 参数' };
  }
  const regex = new RegExp(pattern, 'i');
  const start = insideRoot(args.path, '.');
  const maxResults = Math.max(1, Math.floor(num(args.max_results) ?? 50));
  const hits: string[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (hits.length >= maxResults || depth > 8) {
      return;
    }
    const dirents = await fsp.readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      if (hits.length >= maxResults || SKIP_DIRS.has(dirent.name)) {
        continue;
      }
      const abs = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        await walk(abs, depth + 1);
        continue;
      }
      try {
        const stats = await fsp.stat(abs);
        if (stats.size > MAX_FILE_BYTES) {
          continue;
        }
        const content = await fsp.readFile(abs, 'utf8');
        if (content.includes('\u0000')) {
          continue;
        }
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length && hits.length < maxResults; i += 1) {
          if (regex.test(lines[i])) {
            hits.push(`${path.relative(ROOT, abs).split(path.sep).join('/')}:${i + 1}: ${lines[i].slice(0, 300)}`);
          }
        }
      } catch {
        /* 忽略不可读文件 */
      }
    }
  };

  await walk(start, 0);
  return { ok: true, text: hits.length > 0 ? truncate(hits.join('\n')) : `未找到匹配 /${pattern}/ 的内容` };
}

async function writeFileTool(args: Record<string, unknown>): Promise<ToolOutcome> {
  const target = insideRoot(args.path);
  const content = typeof args.content === 'string' ? args.content : '';
  if (content.length > 512 * 1024) {
    return { ok: false, text: '内容过大（>512KB），已拒绝写入' };
  }
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, content, 'utf8');
  return { ok: true, text: `已写入 ${path.relative(ROOT, target)}（${content.length} 字）` };
}

function runShellTool(args: Record<string, unknown>): ToolOutcome {
  const command = typeof args.command === 'string' ? args.command.trim() : '';
  if (!command) {
    return { ok: false, text: '缺少 command 参数' };
  }
  const cwd = insideRoot(args.cwd, '.');
  const result = spawnSync(command, {
    cwd,
    shell: true,
    timeout: 60_000,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  const parts = [`命令：${command}`, `退出码：${String(result.status)}`];
  if (result.stdout) {
    parts.push('--- stdout ---', String(result.stdout).trimEnd());
  }
  if (result.stderr) {
    parts.push('--- stderr ---', String(result.stderr).trimEnd());
  }
  if (result.error) {
    parts.push(`错误：${result.error.message}`);
  }
  return { ok: result.status === 0, text: truncate(parts.join('\n')) };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (name === 'report_state') {
    emitState(args);
    return { ok: true, text: '状态已同步给扩展' };
  }
  switch (name) {
    case 'read_file':
      return readFileTool(args);
    case 'list_dir':
      return listDirTool(args);
    case 'grep':
      return grepTool(args);
    case 'write_file':
      return writeFileTool(args);
    case 'run_shell':
      return runShellTool(args);
    default:
      return { ok: false, text: `未知工具：${name}` };
  }
}

/* -------------------------------------------------------------------------- */
/* JSON-RPC 分发                                                               */
/* -------------------------------------------------------------------------- */

function send(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function sendResult(id: string | number | null, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id: string | number | null, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleRequest(request: JsonRpcRequest): Promise<void> {
  const method = request.method ?? '';
  const hasId = Object.prototype.hasOwnProperty.call(request, 'id');
  const id = request.id ?? null;
  const params = (request.params ?? {}) as Record<string, unknown>;

  if (!hasId) {
    // 通知（notification）不需要响应。
    if (method === 'notifications/initialized' || method === 'initialized') {
      logStderr('客户端初始化完成');
    }
    return;
  }

  switch (method) {
    case 'initialize':
      sendResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: `根目录：${ROOT}。提供的工具都被限制在该目录内。`,
      });
      return;
    case 'ping':
      sendResult(id, {});
      return;
    case 'tools/list':
      sendResult(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const toolArgs =
        typeof params.arguments === 'object' && params.arguments !== null
          ? (params.arguments as Record<string, unknown>)
          : {};
      if (!name) {
        sendError(id, -32602, 'tools/call 缺少 name 参数');
        return;
      }
      try {
        const outcome = await callTool(name, toolArgs);
        sendResult(id, {
          content: [{ type: 'text', text: outcome.text }],
          isError: !outcome.ok,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logStderr('工具执行失败', name, message);
        sendResult(id, { content: [{ type: 'text', text: `工具执行失败：${message}` }], isError: true });
      }
      return;
    }
    case 'shutdown':
      sendResult(id, null);
      return;
    default:
      sendError(id, -32601, `不支持的方法：${method}`);
  }
}

/** 未完成的异步请求数：stdin 关闭后要等它们都回包再退出。 */
let pending = 0;
let stdinClosed = false;
let exiting = false;

function maybeExit(): void {
  if (!stdinClosed || pending !== 0 || exiting) {
    return;
  }
  exiting = true;
  logStderr('退出');
  // 不能直接 process.exit：最后一次 sendResult 可能还在 stdout 的异步写队列里。
  // 写一个空串并在回调里退出，等于等前面所有写入都 flush。
  process.stdout.write('', () => process.exit(0));
}

function handleLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    logStderr('无法解析 JSON-RPC 消息', err instanceof Error ? err.message : String(err));
    sendError(null, -32700, 'JSON 解析失败');
    return;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    sendError(null, -32600, '无效的 JSON-RPC 请求');
    return;
  }
  pending += 1;
  void handleRequest(parsed as JsonRpcRequest)
    .catch((err: unknown) => {
      logStderr('处理请求异常', err instanceof Error ? err.message : String(err));
    })
    .finally(() => {
      pending -= 1;
      maybeExit();
    });
}

export function runServer(): void {
  logStderr(`[${SERVER_NAME}] v${SERVER_VERSION} 已启动，根目录 = ${ROOT}`);
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', handleLine);
  rl.on('close', () => {
    stdinClosed = true;
    logStderr('stdin 已关闭');
    maybeExit();
  });
  process.stdout.on('error', (err) => {
    logStderr('stdout 写入失败', err.message);
  });
}

if (require.main === module) {
  runServer();
}
