import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ArkToolSchema } from '../ark/client';
import { resolveInsideRoot, workspaceRoot, type DoubaoConfig } from '../config';
import { log, warn } from '../log';
import { detectChecks, formatCheckReport, runChecks, type CheckCommand } from './checks';
import type { RiskVerdict, ToolCall } from './policy';
import { decodeConsoleBuffer } from '../util/encoding';

/** 单个工具结果最多回传给模型的字符数（loop 里还会再兜底截断一次）。 */
export const MAX_TOOL_RESULT_CHARS = 8000;

/** 工作区状态里保存“上一次改动”的 key，供 doubao.applyLastDiff 撤销。 */
export const LAST_EDIT_KEY = 'doubao.lastEdit';

const MAX_READ_CHARS = 40000;
const MAX_GREP_FILE_BYTES = 512 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'out', 'dist', 'build', '.vscode-test', 'target', 'bin', 'obj']);
const MAX_LIST_ENTRIES = 300;

/* -------------------------------------------------------------------------- */
/* 工具定义（JSON Schema）                                                      */
/* -------------------------------------------------------------------------- */

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * 外部工具（例如 MCP server）的路由器。
 * 由 mcp/manager.ts 实现；tools.ts 只依赖这个最小接口，避免和 MCP 客户端互相引用。
 */
export interface ExternalToolRouter {
  definitions(): ToolDefinition[];
  has(name: string): boolean;
  call(name: string, args: Record<string, unknown>): Promise<ToolOutcome>;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'read_file',
    description: '读取工作区内某个文件的文本内容，可指定起止行号。写文件前建议先读一遍。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，相对于工作区根目录（也接受绝对路径，但不能越界）。' },
        start_line: { type: 'number', description: '起始行号（1 开始），可选。' },
        end_line: { type: 'number', description: '结束行号（含），可选。' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_dir',
    description: '列出目录内容（文件与子目录），用于了解工程结构。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径，默认工作区根目录。' },
        recursive: { type: 'boolean', description: '是否递归列出，默认 false。' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'grep',
    description: '在工作区内按正则表达式搜索文本，返回 文件:行号:内容。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript 正则表达式，例如 "class\\s+Foo"。' },
        path: { type: 'string', description: '搜索起点目录，默认工作区根目录。' },
        include: { type: 'string', description: '文件名过滤，简单通配，例如 "*.ts"，可选。' },
        max_results: { type: 'number', description: '最多返回多少条命中，默认 50。' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_file',
    description: '创建或整体覆盖一个文件（通过 VS Code WorkspaceEdit，可撤销）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目标文件路径（相对工作区根目录）。' },
        content: { type: 'string', description: '完整的文件内容。' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'apply_patch',
    description: '对文件做精确文本替换：把 old_string 替换为 new_string。old_string 必须与文件内容完全一致（含缩进）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目标文件路径（相对工作区根目录）。' },
        old_string: { type: 'string', description: '要被替换的原文，建议包含足够上下文以保证唯一。' },
        new_string: { type: 'string', description: '替换后的新文本，允许为空字符串表示删除。' },
        replace_all: { type: 'boolean', description: '是否替换所有匹配，默认 false（要求唯一匹配）。' },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_terminal',
    description:
      '在 workspace root 下执行一条 shell 命令并返回输出。默认需要用户确认；命令不要交互，不要启动长期运行的服务。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令行。' },
        cwd: { type: 'string', description: '工作目录，默认 workspace root。' },
        timeout_ms: { type: 'number', description: '超时毫秒数，默认 60000，最大 300000。' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_checks',
    description:
      '运行工程自检（类型检查 / 编译 / lint / 测试），返回成功与否和错误诊断。改完代码后建议调用一次；默认会先请用户确认。',
    parameters: {
      type: 'object',
      properties: {
        only: {
          type: 'string',
          description: '只运行某一类检查：typecheck / compile / lint / test，可选；不填则全部运行。',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'get_diagnostics',
    description: '获取 VS Code 当前收集到的编译/语法诊断（错误与警告），用于自检改动。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '只看某个文件或目录，默认全部工作区。' },
      },
      required: [],
      additionalProperties: false,
    },
  },
];

/** 转成 Ark / OpenAI tools 字段。 */
export function arkToolSchemas(definitions: ToolDefinition[] = TOOL_DEFINITIONS): ArkToolSchema[] {
  return definitions.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

/* -------------------------------------------------------------------------- */
/* 运行期依赖                                                                   */
/* -------------------------------------------------------------------------- */

export interface ToolRuntime {
  config: DoubaoConfig;
  extensionContext: vscode.ExtensionContext;
  /** run_terminal 的确认回调（实现里弹模态对话框）。 */
  confirmTerminal: (command: string, cwd: string) => Promise<boolean>;
  /** 外部工具（MCP server 等）；没有配置时为空。 */
  externalTools?: ExternalToolRouter;
  /** 聊天路径的风险确认（ask/危险操作）；不提供时默认拒绝需要确认的操作。 */
  confirmRisk?: (call: ToolCall, verdict: RiskVerdict) => Promise<boolean>;
  /** 写文件前的审阅钩子：apply=直接写，review=挂起等用户接受，reject=拒绝。 */
  reviewEdit?: (path: string, before: string, after: string) => Promise<'apply' | 'review' | 'reject'>;
}

export interface ToolOutcome {
  ok: boolean;
  content: string;
}

export interface LastEditRecord {
  uri: string;
  oldText: string;
  newText: string;
  kind: 'file' | 'range';
  range?: { startLine: number; startCharacter: number; endLine: number; endCharacter: number };
  timestamp: number;
  source: string;
}

/* -------------------------------------------------------------------------- */
/* 入口                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * 参数别名归一化。
 *
 * 实测（PTC / 桌面端通道）模型经常把参数名写成 OpenAI 工具风格：
 * `read_file({"file_path": ...})`、`apply_patch({"old_string": ...})`。
 * 与其让每次调用失败，不如在入口做一次宽容映射（不改语义，只改键名）。
 */
const ARG_ALIASES: Record<string, string> = {
  file_path: 'path',
  filepath: 'path',
  filename: 'path',
  dir_path: 'path',
  directory: 'path',
  start: 'start_line',
  end: 'end_line',
  startLine: 'start_line',
  endLine: 'end_line',
  old_text: 'old_string',
  new_text: 'new_string',
  oldText: 'old_string',
  newText: 'new_string',
  old: 'old_string',
  new: 'new_string',
  query: 'pattern',
  regex: 'pattern',
  search: 'pattern',
  maxResults: 'max_results',
  max_results: 'max_results',
  content_to_write: 'content',
  text: 'content',
  cmd: 'command',
  shell_command: 'command',
  timeout: 'timeout_ms',
};

export function normalizeToolArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!args || typeof args !== 'object') {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    // text 只在 write_file 里当 content 的别名，其他工具保留原名（避免误伤）
    if (key === 'text' && toolName !== 'write_file') {
      out[key] = value;
      continue;
    }
    const mapped = ARG_ALIASES[key];
    if (mapped && !(mapped in args)) {
      out[mapped] = value;
    } else {
      out[key] = value;
    }
  }
  // 数值字段容忍字符串数字（模型常把 line 传成 "1"）
  for (const key of ['start_line', 'end_line', 'max_results', 'timeout_ms']) {
    if (typeof out[key] === 'string' && /^\d+$/.test(out[key] as string)) {
      out[key] = Number(out[key]);
    }
  }
  return out;
}

export async function executeTool(
  name: string,
  rawArgs: Record<string, unknown>,
  runtime: ToolRuntime,
): Promise<ToolOutcome> {
  const started = Date.now();
  const args = normalizeToolArgs(name, rawArgs);
  try {
    const result = await dispatch(name, args, runtime);
    log(`工具 ${name} 完成`, `${Date.now() - started}ms`, `${result.content.length}字`, result.ok ? 'ok' : 'failed');
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warn(`工具 ${name} 抛错`, message);
    return { ok: false, content: `工具 ${name} 执行失败：${message}` };
  }
}

function dispatch(name: string, args: Record<string, unknown>, runtime: ToolRuntime): Promise<ToolOutcome> {
  switch (name) {
    case 'read_file':
      return readFileTool(args);
    case 'list_dir':
      return listDirTool(args);
    case 'grep':
      return grepTool(args);
    case 'write_file':
      return writeFileTool(args, runtime);
    case 'apply_patch':
      return applyPatchTool(args, runtime);
    case 'run_terminal':
      return runTerminalTool(args, runtime);
    case 'get_diagnostics':
      return diagnosticsTool(args);
    case 'run_checks':
      return runChecksTool(args, runtime);
    default: {
      const external = runtime.externalTools;
      if (external?.has(name)) {
        return external.call(name, args);
      }
      return Promise.resolve({ ok: false, content: `未知工具：${name}` });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 通用工具函数                                                                 */
/* -------------------------------------------------------------------------- */

function requireRoot(): string {
  const root = workspaceRoot();
  if (!root) {
    throw new Error('当前没有打开任何工作区文件夹，无法使用文件类工具。');
  }
  return root;
}

function requireTrusted(): void {
  if (!vscode.workspace.isTrusted) {
    throw new Error('当前工作区处于受限模式（Restricted Mode），已拒绝写文件/执行命令。请先信任该工作区。');
  }
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function truncate(text: string, limit = MAX_TOOL_RESULT_CHARS): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n…（已截断，原长 ${text.length} 字符）`;
}

function toRelative(root: string, absolute: string): string {
  const rel = path.relative(root, absolute);
  return rel.length === 0 ? '.' : rel.split(path.sep).join('/');
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * 读取文件：优先用已打开（可能未保存）的文档内容，保证与用户看到的一致。
 */
export async function readTextFile(absolute: string): Promise<string> {
  const uri = vscode.Uri.file(absolute);
  const openDoc = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri.toString());
  if (openDoc) {
    return openDoc.getText();
  }
  return fs.readFile(absolute, 'utf8');
}

async function statOrUndefined(absolute: string): Promise<import('node:fs').Stats | undefined> {
  try {
    return await fs.stat(absolute);
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* 只读工具                                                                     */
/* -------------------------------------------------------------------------- */

async function readFileTool(args: Record<string, unknown>): Promise<ToolOutcome> {
  const root = requireRoot();
  const target = resolveInsideRoot(root, str(args.path));
  const stats = await statOrUndefined(target);
  if (!stats) {
    return { ok: false, content: `文件不存在：${toRelative(root, target)}` };
  }
  if (stats.isDirectory()) {
    return { ok: false, content: `${toRelative(root, target)} 是目录，请用 list_dir。` };
  }
  if (stats.size > 2 * 1024 * 1024) {
    return { ok: false, content: `文件过大（${stats.size} 字节），请用 grep 定位后再读取。` };
  }
  const text = await readTextFile(target);
  const lines = text.split(/\r?\n/);
  const startLine = Math.max(1, Math.floor(num(args.start_line) ?? 1));
  const endLine = Math.min(lines.length, Math.floor(num(args.end_line) ?? lines.length));
  if (startLine > lines.length) {
    return { ok: false, content: `起始行 ${startLine} 超过文件总行数 ${lines.length}。` };
  }
  const slice = lines.slice(startLine - 1, Math.max(startLine, endLine)).join('\n');
  const header = `文件：${toRelative(root, target)}（共 ${lines.length} 行，显示 ${startLine}-${Math.max(startLine, endLine)}）`;
  return { ok: true, content: truncate(`${header}\n${slice}`, MAX_READ_CHARS) };
}

async function listDirTool(args: Record<string, unknown>): Promise<ToolOutcome> {
  const root = requireRoot();
  const target = resolveInsideRoot(root, str(args.path, '.') || '.');
  const recursive = bool(args.recursive, false);
  const entries: string[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (entries.length >= MAX_LIST_ENTRIES) {
      return;
    }
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    dirents.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      if (entries.length >= MAX_LIST_ENTRIES) {
        return;
      }
      const abs = path.join(dir, dirent.name);
      const rel = toRelative(root, abs);
      if (dirent.isDirectory()) {
        entries.push(`[目录] ${rel}/`);
        if (recursive && depth < 4 && !SKIP_DIRS.has(dirent.name)) {
          await walk(abs, depth + 1);
        }
      } else {
        const stats = await statOrUndefined(abs);
        entries.push(`[文件] ${rel} (${stats ? stats.size : '?'} 字节)`);
      }
    }
  };

  await walk(target, 0);
  const body = entries.length === 0 ? '（空目录）' : entries.join('\n');
  const more = entries.length >= MAX_LIST_ENTRIES ? '\n（条目过多已截断）' : '';
  return { ok: true, content: `目录：${toRelative(root, target)}\n${body}${more}` };
}

async function grepTool(args: Record<string, unknown>): Promise<ToolOutcome> {
  const root = requireRoot();
  const patternRaw = str(args.pattern);
  if (!patternRaw) {
    return { ok: false, content: '缺少 pattern 参数。' };
  }
  let regex: RegExp;
  try {
    regex = new RegExp(patternRaw, 'i');
  } catch (err) {
    return { ok: false, content: `正则表达式非法：${err instanceof Error ? err.message : String(err)}` };
  }
  const start = resolveInsideRoot(root, str(args.path, '.') || '.');
  const include = str(args.include);
  const includeRe = include ? globToRegExp(include) : undefined;
  const maxResults = Math.max(1, Math.floor(num(args.max_results) ?? 50));
  const hits: string[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (hits.length >= maxResults || depth > 8) {
      return;
    }
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      if (hits.length >= maxResults) {
        return;
      }
      if (SKIP_DIRS.has(dirent.name)) {
        continue;
      }
      const abs = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        await walk(abs, depth + 1);
        continue;
      }
      if (includeRe && !includeRe.test(dirent.name)) {
        continue;
      }
      const stats = await statOrUndefined(abs);
      if (!stats || stats.size > MAX_GREP_FILE_BYTES) {
        continue;
      }
      let content: string;
      try {
        content = await fs.readFile(abs, 'utf8');
      } catch {
        continue;
      }
      if (content.includes('\u0000')) {
        continue; // 二进制文件
      }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (regex.test(lines[i])) {
          hits.push(`${toRelative(root, abs)}:${i + 1}: ${lines[i].slice(0, 300)}`);
          if (hits.length >= maxResults) {
            return;
          }
        }
      }
    }
  };

  await walk(start, 0);
  if (hits.length === 0) {
    return { ok: true, content: `未找到匹配 /${patternRaw}/ 的内容。` };
  }
  return { ok: true, content: truncate(`匹配 ${hits.length} 条：\n${hits.join('\n')}`) };
}

async function diagnosticsTool(args: Record<string, unknown>): Promise<ToolOutcome> {
  const root = workspaceRoot();
  const filterArg = str(args.path);
  let filter: string | undefined;
  if (filterArg && root) {
    filter = resolveInsideRoot(root, filterArg);
  }
  const all = vscode.languages.getDiagnostics();
  const lines: string[] = [];
  let total = 0;
  for (const [uri, diagnostics] of all) {
    if (uri.scheme !== 'file') {
      continue;
    }
    if (filter && !uri.fsPath.toLowerCase().startsWith(filter.toLowerCase())) {
      continue;
    }
    for (const diagnostic of diagnostics) {
      total += 1;
      if (lines.length >= 120) {
        continue;
      }
      const severity = vscode.DiagnosticSeverity[diagnostic.severity] ?? 'Unknown';
      const rel = root ? toRelative(root, uri.fsPath) : uri.fsPath;
      lines.push(
        `${rel}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} [${severity}] ${diagnostic.message}`,
      );
    }
  }
  if (total === 0) {
    return { ok: true, content: '当前没有诊断信息（没有错误/警告）。' };
  }
  return { ok: true, content: truncate(`共 ${total} 条诊断：\n${lines.join('\n')}`) };
}

/* -------------------------------------------------------------------------- */
/* 写文件（统一走 WorkspaceEdit + workspaceState 记录旧内容）                    */
/* -------------------------------------------------------------------------- */

export function rememberLastEdit(context: vscode.ExtensionContext, record: LastEditRecord): Thenable<void> {
  return context.workspaceState.update(LAST_EDIT_KEY, record);
}

export function lastEdit(context: vscode.ExtensionContext): LastEditRecord | undefined {
  const value = context.workspaceState.get<LastEditRecord>(LAST_EDIT_KEY);
  if (!value || typeof value.uri !== 'string' || typeof value.newText !== 'string') {
    return undefined;
  }
  return value;
}

/**
 * 用 WorkspaceEdit 覆盖整个文件内容（新文件则创建）。返回旧内容（新文件为空串）。
 */
export async function replaceWholeFile(
  context: vscode.ExtensionContext,
  uri: vscode.Uri,
  newText: string,
  source: string,
  /** apply_patch 传入读取时的快照；写入前若文档已变，取消写入而不是覆盖用户编辑。 */
  expectedOldText?: string,
): Promise<string> {
  const stats = await statOrUndefined(uri.fsPath);
  let oldText = '';
  let document: vscode.TextDocument | undefined;

  if (stats && stats.isFile()) {
    document = await vscode.workspace.openTextDocument(uri);
    oldText = document.getText();
    if (expectedOldText !== undefined && oldText !== expectedOldText) {
      throw new Error(`文件 ${uri.fsPath} 在读取后被修改，已取消本次写入。请重新读取后再试。`);
    }
  } else if (expectedOldText !== undefined && expectedOldText !== '') {
    throw new Error(`文件 ${uri.fsPath} 在读取后消失，已取消本次写入。`);
  }

  const edit = new vscode.WorkspaceEdit();
  if (document) {
    const end = document.positionAt(oldText.length);
    edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), end), newText);
  } else {
    edit.createFile(uri, { ignoreIfExists: true, contents: Buffer.from(newText, 'utf8') });
  }

  // 应用前先把旧内容写入 workspaceState，确保任何情况下都能撤销。
  await rememberLastEdit(context, {
    uri: uri.toString(),
    oldText,
    newText,
    kind: 'file',
    timestamp: Date.now(),
    source,
  });

  // rememberLastEdit 是异步的；期间用户可能改了文档，再核对一次，避免静默覆盖。
  if (document && document.getText() !== oldText) {
    await context.workspaceState.update(LAST_EDIT_KEY, undefined);
    throw new Error(`文件 ${uri.fsPath} 在写入前被修改，已取消本次写入。请重新读取后再试。`);
  }

  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    await context.workspaceState.update(LAST_EDIT_KEY, undefined);
    throw new Error(`WorkspaceEdit 未能应用：${uri.fsPath}`);
  }

  log('已写入文件', uri.fsPath, `旧内容 ${oldText.length} 字 → 新内容 ${newText.length} 字`);
  return oldText;
}

/** 用 WorkspaceEdit 替换某个 range（行内改写用）。 */
export async function replaceRange(
  context: vscode.ExtensionContext,
  document: vscode.TextDocument,
  range: vscode.Range,
  newText: string,
  source: string,
): Promise<string> {
  const oldText = document.getText(range);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, range, newText);

  // 应用前先记录旧内容，供撤销/对比使用。
  await rememberLastEdit(context, {
    uri: document.uri.toString(),
    oldText,
    newText,
    kind: 'range',
    range: {
      startLine: range.start.line,
      startCharacter: range.start.character,
      endLine: range.end.line,
      endCharacter: range.end.character,
    },
    timestamp: Date.now(),
    source,
  });

  // rememberLastEdit 是异步的；期间用户可能改了这段文本，位置/内容都会变。
  if (document.getText(range) !== oldText) {
    await context.workspaceState.update(LAST_EDIT_KEY, undefined);
    throw new Error(`文件 ${document.uri.fsPath} 在写入前被修改，已取消本次改写。请重新执行。`);
  }

  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    await context.workspaceState.update(LAST_EDIT_KEY, undefined);
    throw new Error(`WorkspaceEdit 未能应用到 ${document.uri.fsPath}`);
  }
  return oldText;
}

async function writeFileTool(args: Record<string, unknown>, runtime: ToolRuntime): Promise<ToolOutcome> {
  requireTrusted();
  const root = requireRoot();
  const target = resolveInsideRoot(root, str(args.path));
  const content = str(args.content);
  const existing = await statOrUndefined(target);
  if (existing?.isDirectory()) {
    return { ok: false, content: `${toRelative(root, target)} 是目录，不能写入。` };
  }
  if (runtime.reviewEdit) {
    const before = existing?.isFile() ? await readTextFile(target).catch(() => '') : '';
    const decision = await runtime.reviewEdit(target, before, content);
    if (decision === 'reject') {
      return { ok: false, content: '用户拒绝了这次写入：' + toRelative(root, target) };
    }
    if (decision === 'review') {
      return { ok: true, content: '已提交审阅：' + toRelative(root, target) + '（用户在面板接受后才会写入）' };
    }
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  const oldText = await replaceWholeFile(runtime.extensionContext, vscode.Uri.file(target), content, 'write_file');
  const action = existing ? '已覆盖' : '已创建';
  return {
    ok: true,
    content: `${action} ${toRelative(root, target)}（${content.length} 字，旧内容 ${oldText.length} 字已保存，可用“查看/撤销上一次改动”回退）。`,
  };
}

async function applyPatchTool(args: Record<string, unknown>, runtime: ToolRuntime): Promise<ToolOutcome> {
  requireTrusted();
  const root = requireRoot();
  const target = resolveInsideRoot(root, str(args.path));
  const oldString = str(args.old_string) || str(args.old_text);
  const newString = str(args.new_string) || str(args.new_text);
  const replaceAll = bool(args.replace_all, false);
  if (!oldString) {
    return { ok: false, content: 'old_string 不能为空；新建文件请用 write_file。' };
  }
  const stats = await statOrUndefined(target);
  if (!stats || !stats.isFile()) {
    return { ok: false, content: `文件不存在：${toRelative(root, target)}` };
  }
  const original = await readTextFile(target);
  const occurrences = countOccurrences(original, oldString);
  if (occurrences === 0) {
    return { ok: false, content: `old_string 在 ${toRelative(root, target)} 中找不到，请先用 read_file 确认原文（注意缩进与换行）。` };
  }
  if (occurrences > 1 && !replaceAll) {
    return {
      ok: false,
      content: `old_string 匹配到 ${occurrences} 处，存在歧义。请增加上下文，或设置 replace_all=true。`,
    };
  }
  const patched = replaceAll ? original.split(oldString).join(newString) : replaceFirst(original, oldString, newString);
  if (runtime.reviewEdit) {
    const decision = await runtime.reviewEdit(target, original, patched);
    if (decision === 'reject') {
      return { ok: false, content: '用户拒绝了这次修改：' + toRelative(root, target) };
    }
    if (decision === 'review') {
      return { ok: true, content: '已提交审阅：' + toRelative(root, target) + '（用户在面板接受后才会写入）' };
    }
  }
  await replaceWholeFile(runtime.extensionContext, vscode.Uri.file(target), patched, 'apply_patch', original);
  return {
    ok: true,
    content: `已修改 ${toRelative(root, target)}（替换 ${replaceAll ? occurrences : 1} 处）。旧内容已保存，可用“查看/撤销上一次改动”回退。`,
  };
}

/** 只替换第一处，且不解释 newString 里的 $& 等替换模式（代码里常见）。 */
function replaceFirst(haystack: string, needle: string, replacement: string): string {
  const index = haystack.indexOf(needle);
  if (index < 0) {
    return haystack;
  }
  return haystack.slice(0, index) + replacement + haystack.slice(index + needle.length);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/* -------------------------------------------------------------------------- */
/* 终端执行                                                                     */
/* -------------------------------------------------------------------------- */

async function runTerminalTool(args: Record<string, unknown>, runtime: ToolRuntime): Promise<ToolOutcome> {
  requireTrusted();
  const root = requireRoot();
  const command = str(args.command).trim();
  if (!command) {
    return { ok: false, content: 'command 不能为空。' };
  }
  const cwd = args.cwd ? resolveInsideRoot(root, str(args.cwd)) : root;
  const timeoutMs = Math.min(300_000, Math.max(1_000, Math.floor(num(args.timeout_ms) ?? 60_000)));

  if (!runtime.config.terminalAutoRun) {
    const approved = await runtime.confirmTerminal(command, cwd);
    if (!approved) {
      return {
        ok: false,
        content:
          '用户拒绝执行该命令。请改用只读工具（read_file/list_dir/grep/get_diagnostics）继续排查，或建议用户手动执行。',
      };
    }
  } else {
    log('terminal.autoRun=true，直接执行', command);
  }

  return new Promise<ToolOutcome>((resolve) => {
    const shell = process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : '/bin/sh';
    const child = spawn(command, {
      cwd,
      shell,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: { ...process.env, DOUBAO_AGENT: '1' },
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    const cap = 200_000;
    const stdoutText = (): string => decodeConsoleBuffer(Buffer.concat(stdoutChunks));
    const stderrText = (): string => decodeConsoleBuffer(Buffer.concat(stderrChunks));

    const finish = (outcome: ToolOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const timeoutOutcome = (): ToolOutcome => ({
      ok: false,
      content: truncate(`命令超时（${timeoutMs}ms）已被终止。\n命令：${command}\n输出：\n${stdoutText()}\n${stderrText()}`),
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
      // 给 taskkill / 进程组 2 秒收尾；close 正常到达时会先 finish。
      setTimeout(() => finish(timeoutOutcome()), 2000).unref();
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBytes < cap) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes < cap) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      }
    });
    child.on('error', (err) => {
      finish({ ok: false, content: `无法启动命令：${err.message}` });
    });
    child.on('close', (code) => {
      if (timedOut) {
        finish(timeoutOutcome());
        return;
      }
      const stdout = stdoutText();
      const stderr = stderrText();
      const output = [`命令：${command}`, `退出码：${code ?? 'null'}`];
      if (stdout.trim()) {
        output.push('--- stdout ---', stdout.trimEnd());
      }
      if (stderr.trim()) {
        output.push('--- stderr ---', stderr.trimEnd());
      }
      if (!stdout.trim() && !stderr.trim()) {
        output.push('（无输出）');
      }
      finish({ ok: code === 0, content: truncate(output.join('\n')) });
    });
  });
}

/** 终止整个进程树（Windows 用 taskkill /T，POSIX 用进程组）。 */
function killProcessTree(pid: number | undefined): void {
  if (!pid) {
    return;
  }
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 工程自检                                                                     */
/* -------------------------------------------------------------------------- */

async function runChecksTool(args: Record<string, unknown>, runtime: ToolRuntime): Promise<ToolOutcome> {
  requireTrusted();
  const root = requireRoot();
  const only = str(args.only).trim().toLowerCase();

  let all: CheckCommand[];
  try {
    all = await detectChecks(root);
  } catch (err) {
    return { ok: false, content: `检测工程检查命令失败：${err instanceof Error ? err.message : String(err)}` };
  }
  if (all.length === 0) {
    return {
      ok: false,
      content:
        '没有检测到可运行的工程检查。支持 package.json 的 typecheck/compile/lint/test 脚本，或带 tsconfig.json 的 TypeScript 工程。',
    };
  }

  const selected = only
    ? all.filter((check) => check.id.toLowerCase() === only || check.label.toLowerCase().includes(only))
    : all;
  if (selected.length === 0) {
    return {
      ok: false,
      content: `没有匹配 "${only}" 的检查。可用：${all.map((check) => check.id).join(', ')}`,
    };
  }

  const commandLine = selected.map((check) => `${check.command} ${check.args.join(' ')}`).join('  &&  ');
  if (!runtime.config.terminalAutoRun) {
    const approved = await runtime.confirmTerminal(commandLine, root);
    if (!approved) {
      return {
        ok: false,
        content: '用户拒绝运行工程检查。请改用只读工具继续排查，或在回答里说明需要用户手动运行的命令。',
      };
    }
  } else {
    log('terminal.autoRun=true，直接运行工程检查', commandLine);
  }

  log('运行工程检查', selected.map((check) => check.id).join(', '));
  const report = await runChecks(root, { checks: selected });
  return { ok: report.ok, content: formatCheckReport(report) };
}
