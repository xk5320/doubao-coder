/**
 * 工程自检运行器：让 Agent 在改完代码后自行验证 compile / lint / test。
 *
 * 纯 Node 实现，不依赖 vscode；所有命令都以 argv 形式传给
 * spawn(command, args, { shell: false })，不做任意 shell 字符串拼接。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface CheckCommand {
  id: string;
  label: string;
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
}

export interface CheckResult {
  id: string;
  label: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  output: string;
  truncated: boolean;
  timedOut: boolean;
}

export interface CheckReport {
  ok: boolean;
  results: CheckResult[];
  startedAt: string;
  durationMs: number;
}

export interface RunChecksOptions {
  checks?: CheckCommand[];
  maxOutputChars?: number;
  signal?: AbortSignal;
  onStart?: (check: CheckCommand) => void;
  onDone?: (result: CheckResult) => void;
}

export interface ParsedDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning';
  message: string;
  code?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_CHARS = 8_000;
const MAX_DIAGNOSTICS = 20;
const MAX_ERROR_SUMMARY = 220;
const MAX_TAIL_PER_CHECK = 2_000;
const HARD_KILL_GRACE_MS = 5_000;

/** 去掉 ANSI 颜色 / 光标控制序列，避免把终端转义码带进给模型的 Markdown。 */
const ANSI_PATTERN = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\)|[@-_])/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readScripts(root: string): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(path.join(root, 'package.json'), 'utf8');
    const data: unknown = JSON.parse(raw);
    if (!isRecord(data) || !isRecord(data.scripts)) {
      return {};
    }
    const scripts: Record<string, string> = {};
    for (const [name, value] of Object.entries(data.scripts)) {
      if (typeof value === 'string' && value.trim().length > 0) {
        scripts[name] = value;
      }
    }
    return scripts;
  } catch {
    // 没有 package.json 或 JSON 损坏时按“无脚本”处理，交给 tsconfig 回退。
    return {};
  }
}

function scriptCheck(id: string, label: string, script: string, root: string): CheckCommand {
  return {
    id,
    label,
    command: 'npm',
    args: ['run', script],
    cwd: root,
  };
}

/** 读取 package.json / tsconfig.json，生成可安全执行的检查命令（不执行、不抛错）。 */
export async function detectChecks(root: string): Promise<CheckCommand[]> {
  const absRoot = path.resolve(root);
  const scripts = await readScripts(absRoot);
  const hasScript = (name: string): boolean => Object.prototype.hasOwnProperty.call(scripts, name);
  const hasTsconfig = existsSync(path.join(absRoot, 'tsconfig.json'));
  const checks: CheckCommand[] = [];

  if (hasScript('typecheck')) {
    checks.push(scriptCheck('typecheck', '类型检查 (typecheck)', 'typecheck', absRoot));
  } else if (hasTsconfig && !hasScript('compile')) {
    // 没有 typecheck/compile 脚本时，只要项目有 tsconfig 就尝试本地 tsc。
    // 找不到 tsc 会在运行时由 npx 报错，检测阶段不抛异常。
    checks.push({
      id: 'typecheck',
      label: '类型检查 (tsc --noEmit)',
      command: 'npx',
      args: ['--no-install', 'tsc', '--noEmit'],
      cwd: absRoot,
    });
  }

  if (hasScript('compile')) {
    checks.push(scriptCheck('compile', '编译 (compile)', 'compile', absRoot));
  }
  if (hasScript('lint')) {
    checks.push(scriptCheck('lint', '代码检查 (lint)', 'lint', absRoot));
  }
  if (hasScript('test')) {
    checks.push(scriptCheck('test', '测试 (test)', 'test', absRoot));
  }

  return checks;
}

function normalizeMaxOutputChars(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_MAX_OUTPUT_CHARS;
  }
  return Math.floor(value);
}

function normalizeTimeout(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.floor(value);
}

/**
 * Windows 上 npm / npx 实际是 .cmd，Node 在 shell:false 下不能直接 spawn .cmd
 * （会抛 EINVAL）。这里换成当前 Node 安装目录里的 npm-cli.js / npx-cli.js，
 * 仍然保持 shell:false，不引入 cmd.exe 字符串解析。
 */
function resolveSpawnCommand(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform === 'win32' && (command === 'npm' || command === 'npx')) {
    const cliName = command === 'npm' ? 'npm-cli.js' : 'npx-cli.js';
    const cliPath = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', cliName);
    if (existsSync(cliPath)) {
      return { command: process.execPath, args: [cliPath, ...args] };
    }
  }
  return { command, args };
}

class TailBuffer {
  private text = '';
  total = 0;

  constructor(private readonly limit: number) {}

  append(chunk: string): void {
    if (chunk.length === 0) {
      return;
    }
    this.total += chunk.length;
    this.text += chunk;
    if (this.text.length > this.limit) {
      this.text = this.text.slice(-this.limit);
    }
  }

  value(maxChars: number): string {
    const keep = Math.min(maxChars, this.text.length);
    return this.text.slice(this.text.length - keep);
  }
}

/** 杀掉整个进程树：Windows 用 taskkill /T /F，类 Unix 用负 PID（子进程需 detached）。 */
function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) {
    try {
      child.kill('SIGKILL');
    } catch {
      // 进程可能已退出。
    }
    return;
  }

  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
    const taskkillExe = path.join(systemRoot, 'System32', 'taskkill.exe');
    const taskkillCommand = existsSync(taskkillExe) ? taskkillExe : 'taskkill';
    try {
      const killer = spawn(taskkillCommand, ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
      });
      killer.on('error', () => {
        try {
          child.kill('SIGKILL');
        } catch {
          // 进程可能已退出。
        }
      });
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // 进程可能已退出。
      }
    }
    return;
  }

  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // 进程可能已退出。
    }
  }
}

function runOne(
  root: string,
  check: CheckCommand,
  maxOutputChars: number,
  signal?: AbortSignal,
): Promise<CheckResult> {
  const startedMs = Date.now();
  const timeoutMs = normalizeTimeout(check.timeoutMs);
  const cwd = check.cwd ? path.resolve(root, check.cwd) : root;
  const tail = new TailBuffer(Math.max(maxOutputChars * 2, 65_536));

  return new Promise<CheckResult>((resolve) => {
    let child: ChildProcess | undefined;
    let settled = false;
    let terminating = false;
    let timedOut = false;
    let aborted = false;
    let exitCode: number | null = null;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let hardKillTimer: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;

    const cleanup = (): void => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      if (hardKillTimer) {
        clearTimeout(hardKillTimer);
        hardKillTimer = undefined;
      }
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
        abortHandler = undefined;
      }
    };

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();

      let output = tail.value(maxOutputChars);
      if (tail.total > maxOutputChars) {
        output += `\n…[输出已截断：原始 ${tail.total} 字符，仅保留末尾 ${maxOutputChars} 字符]`;
      }
      if (timedOut) {
        output += `\n…[超时：超过 ${timeoutMs}ms，已终止整个进程树]`;
      }
      if (aborted) {
        output += '\n…[已中止：收到取消信号，已终止整个进程树]';
      }

      resolve({
        id: check.id,
        label: check.label,
        ok: !timedOut && !aborted && exitCode === 0,
        exitCode,
        durationMs: Date.now() - startedMs,
        output,
        truncated: tail.total > maxOutputChars,
        timedOut,
      });
    };

    const terminate = (): void => {
      if (terminating || settled || !child) {
        return;
      }
      terminating = true;
      killProcessTree(child);
      // taskkill / kill 之后如果 close 迟迟不来，兜底结束，避免调用方永久挂住。
      if (!hardKillTimer) {
        hardKillTimer = setTimeout(finish, HARD_KILL_GRACE_MS);
      }
    };

    if (signal?.aborted) {
      aborted = true;
      finish();
      return;
    }

    const spec = resolveSpawnCommand(check.command, check.args);
    try {
      child = spawn(spec.command, spec.args, {
        cwd,
        env: process.env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      tail.append(`…[启动失败: ${errorMessage(error)}]`);
      finish();
      return;
    }

    child.stdout?.on('data', (chunk: Buffer | string) => {
      tail.append(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      tail.append(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
    child.on('error', (error) => {
      tail.append(`\n…[启动失败: ${errorMessage(error)}]`);
      finish();
    });
    child.on('close', (code) => {
      exitCode = code;
      finish();
    });

    timeoutTimer = setTimeout(() => {
      if (settled) {
        return;
      }
      timedOut = true;
      terminate();
    }, timeoutMs);

    if (signal) {
      abortHandler = () => {
        if (settled) {
          return;
        }
        aborted = true;
        terminate();
      };
      signal.addEventListener('abort', abortHandler, { once: true });
      if (signal.aborted) {
        abortHandler();
      }
    }
  });
}

/**
 * 顺序执行检查命令。默认 120s/条，输出只保留末尾 maxOutputChars 字符并标记原长。
 * 失败不会中断后续检查（除非收到 AbortSignal），方便一次看到全部问题。
 */
export async function runChecks(root: string, options: RunChecksOptions = {}): Promise<CheckReport> {
  const absRoot = path.resolve(root);
  const checks = options.checks ?? (await detectChecks(absRoot));
  const maxOutputChars = normalizeMaxOutputChars(options.maxOutputChars);
  const signal = options.signal;
  const startedAt = new Date();
  const startedMs = Date.now();
  const results: CheckResult[] = [];
  let aborted = false;

  for (const check of checks) {
    if (signal?.aborted) {
      aborted = true;
      break;
    }
    options.onStart?.(check);
    const result = await runOne(absRoot, check, maxOutputChars, signal);
    results.push(result);
    options.onDone?.(result);
    if (signal?.aborted) {
      aborted = true;
      break;
    }
  }

  const durationMs = Date.now() - startedMs;
  const ok = results.length > 0 && !aborted && results.every((result) => result.ok);
  return { ok, results, startedAt: startedAt.toISOString(), durationMs };
}

const TS_DIAGNOSTIC = /^\s*(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+)?\s*:?\s*(.*)$/;
const ESLINT_DIAGNOSTIC = /^\s*(.+?):(\d+):(\d+)\s+-\s+(error|warning)\s+(.+)$/;

/** 容错解析 tsc（file(line,col): error TSxxxx: msg）与 ESLint（file:line:col - error msg）。 */
export function parseDiagnostics(text: string): ParsedDiagnostic[] {
  const diagnostics: ParsedDiagnostic[] = [];
  const lines = stripAnsi(text).split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }

    const tsMatch = TS_DIAGNOSTIC.exec(line);
    if (tsMatch) {
      const lineNumber = Number.parseInt(tsMatch[2], 10);
      const column = Number.parseInt(tsMatch[3], 10);
      if (lineNumber > 0 && column > 0) {
        diagnostics.push({
          file: tsMatch[1].trim(),
          line: lineNumber,
          column,
          severity: tsMatch[4] === 'warning' ? 'warning' : 'error',
          message: tsMatch[6].trim(),
          ...(tsMatch[5] ? { code: tsMatch[5] } : {}),
        });
      }
      continue;
    }

    const eslintMatch = ESLINT_DIAGNOSTIC.exec(line);
    if (eslintMatch) {
      const lineNumber = Number.parseInt(eslintMatch[2], 10);
      const column = Number.parseInt(eslintMatch[3], 10);
      if (lineNumber > 0 && column > 0) {
        diagnostics.push({
          file: eslintMatch[1].trim(),
          line: lineNumber,
          column,
          severity: eslintMatch[4] === 'warning' ? 'warning' : 'error',
          message: eslintMatch[5].trim(),
        });
      }
    }
  }

  return diagnostics;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return '0ms';
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function rightSize(text: string, max: number): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}

function singleLine(text: string, max: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

function formatDiagnostic(diagnostic: ParsedDiagnostic): string {
  return `${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ${diagnostic.severity}${
    diagnostic.code ? ` ${diagnostic.code}` : ''
  }: ${diagnostic.message}`;
}

function firstOutputLine(result: CheckResult | undefined): string {
  if (!result) {
    return '';
  }
  return (
    stripAnsi(result.output)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  );
}

/** 生成给模型看的紧凑 Markdown：PASS/FAIL、逐条命令、首条错误、诊断与失败输出尾部。 */
export function formatCheckReport(report: CheckReport): string {
  const total = report.results.length;
  const passed = report.results.filter((result) => result.ok).length;
  const lines: string[] = [`## 自检结果：${report.ok ? 'PASS' : 'FAIL'}`, ''];

  if (total === 0) {
    lines.push('- 没有运行任何检查（未检测到 typecheck/compile/lint/test 脚本，也没有 tsconfig.json，或任务已取消）。');
    return lines.join('\n');
  }

  lines.push(`- 通过 ${passed}/${total} 项，总耗时 ${formatDuration(report.durationMs)}`);
  lines.push('');

  for (const result of report.results) {
    const bits: string[] = [`${result.ok ? '✅' : '❌'} ${result.label}（${result.id}）`, formatDuration(result.durationMs)];
    if (!result.ok) {
      if (result.timedOut) {
        bits.push('超时');
      } else if (result.exitCode === null) {
        bits.push('未正常退出');
      } else {
        bits.push(`退出码 ${result.exitCode}`);
      }
    }
    lines.push(`- ${bits.join(' · ')}`);
  }

  if (report.ok) {
    lines.push('');
    lines.push('未发现错误。');
    return lines.join('\n');
  }

  const failed = report.results.filter((result) => !result.ok);
  const diagnostics: ParsedDiagnostic[] = [];
  for (const result of failed) {
    diagnostics.push(...parseDiagnostics(result.output));
  }

  const summary = diagnostics.length > 0 ? formatDiagnostic(diagnostics[0]) : firstOutputLine(failed[0]);
  if (summary.length > 0) {
    lines.push('');
    lines.push(`首条错误：${singleLine(summary, MAX_ERROR_SUMMARY)}`);
  }

  if (diagnostics.length > 0) {
    const shown = Math.min(diagnostics.length, MAX_DIAGNOSTICS);
    lines.push('');
    lines.push(`### 诊断（显示 ${shown}/${diagnostics.length} 条，最多 ${MAX_DIAGNOSTICS} 条）`);
    for (const diagnostic of diagnostics.slice(0, MAX_DIAGNOSTICS)) {
      const code = diagnostic.code ? ` ${diagnostic.code}` : '';
      lines.push(
        `- \`${diagnostic.file}:${diagnostic.line}:${diagnostic.column}\` ${diagnostic.severity}${code}: ${singleLine(
          diagnostic.message,
          300,
        )}`,
      );
    }
  }

  const outputSections: string[] = [];
  for (const result of failed) {
    const cleaned = stripAnsi(result.output).trim();
    if (cleaned.length === 0) {
      continue;
    }
    const tail = rightSize(cleaned, MAX_TAIL_PER_CHECK);
    outputSections.push(`**${result.id}（${result.label}）**\n\`\`\`text\n${tail}\n\`\`\``);
  }
  if (outputSections.length > 0) {
    lines.push('');
    lines.push('### 输出尾部');
    lines.push(outputSections.join('\n\n'));
  }

  return lines.join('\n');
}
