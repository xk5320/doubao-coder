/**
 * 豆包 CLI 的本机 npm 安装器。
 *
 * - 只使用当前 VS Code 进程同一个 Node（process.execPath），避免 PATH 里没有 node/npm；
 * - 直接执行 npm-cli.js，不经过 npm.cmd / shell，参数不会被二次解释；
 * - 输出按行回调给设置中心，安装过程可见、可取消；
 * - 不依赖 vscode，便于离线单测。
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeCliText } from './runner';

export const CLI_PACKAGE = '@bytedance/doubao-cli';
export const CLI_REGISTRY = 'https://registry.npmjs.org/';
export const CLI_INSTALL_ARGS = [
  'install',
  '-g',
  CLI_PACKAGE,
  '--registry=' + CLI_REGISTRY,
  '--no-audit',
  '--no-fund',
];

export interface NpmRuntime {
  ok: boolean;
  nodeExec?: string;
  nodeVersion?: string;
  npmVersion?: string;
  npmCli?: string;
  error?: string;
}

export interface NpmInstallResult {
  ok: boolean;
  code: number | null;
  output: string;
  error?: string;
  aborted: boolean;
  timedOut: boolean;
}

const RUNTIME_TTL_MS = 60_000;
let cachedRuntime: { at: number; value: NpmRuntime } | undefined;

/**
 * 找到真正的 node 可执行文件。
 *
 * VS Code 扩展进程的 process.execPath 是 Code.exe（Electron），不能直接当 node 用；
 * 所以优先从 PATH / 常见安装目录找 node.exe，找不到才回退到非 Electron 的 execPath。
 */
export function nodeCandidates(execPath: string = process.execPath, env: NodeJS.ProcessEnv = process.env): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string | undefined): void => {
    if (!candidate) {
      return;
    }
    const normalized = path.normalize(candidate);
    if (isUselessNodePath(normalized)) {
      return;
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  };
  const names = process.platform === 'win32' ? ['node.exe'] : ['node'];
  const execName = path.basename(execPath).toLowerCase();
  if (!process.versions.electron && (execName === 'node.exe' || execName === 'node')) {
    add(execPath);
  }
  for (const folder of (env.PATH || env.Path || '').split(path.delimiter)) {
    if (!folder) {
      continue;
    }
    for (const name of names) {
      add(path.join(folder, name));
    }
  }
  if (process.platform === 'win32') {
    add(path.join(env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'));
    add(path.join(env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe'));
  } else {
    add('/usr/local/bin/node');
    add('/opt/homebrew/bin/node');
    add('/usr/bin/node');
  }
  return result;
}

/** 解析 node --version 输出；空输出/异常输出不返回版本（避免被误判成 0.x）。 */
export function parseNodeVersion(text: string): { version?: string; major?: number } {
  const match = /v(\d+)\.(\d+)\.(\d+)/.exec(String(text || ''));
  if (!match) {
    return {};
  }
  const version = 'v' + match[1] + '.' + match[2] + '.' + match[3];
  return { version, major: Number(match[1]) };
}

/** Windows 商店别名 / 非真实 node 的路径，跳过。 */
export function isUselessNodePath(candidate: string): boolean {
  return /\\WindowsApps\\/i.test(candidate) || /\\Microsoft\\WindowsApps\\/i.test(candidate);
}

export function resolveNodeExec(execPath: string = process.execPath, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const candidate of nodeCandidates(execPath, env)) {
    try {
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      /* 继续找 */
    }
  }
  return undefined;
}

/** npm-cli.js 的可能位置（npm_execpath / node 安装目录 / PATH 里的 npm 目录）。 */
export function npmCliCandidates(nodeExec: string = process.execPath, env: NodeJS.ProcessEnv = process.env): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string | undefined): void => {
    if (!candidate) {
      return;
    }
    const normalized = path.normalize(candidate);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  };
  add(env.npm_execpath && path.basename(env.npm_execpath) === 'npm-cli.js' ? env.npm_execpath : undefined);
  const nodeDir = path.dirname(nodeExec);
  add(path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  add(path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  for (const folder of (env.PATH || env.Path || '').split(path.delimiter)) {
    if (!folder) {
      continue;
    }
    add(path.join(folder, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }
  return result;
}

export function resolveNpmCli(
  nodeExec: string = process.execPath,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const candidate of npmCliCandidates(nodeExec, env)) {
    try {
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      /* 继续找 */
    }
  }
  return undefined;
}

function runFile(file: string, args: string[], timeoutMs: number): Promise<{ code: number | null; text: string; error?: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const err = error as (Error & { code?: number | string }) | null;
        resolve({
          code: typeof err?.code === 'number' ? err.code : err ? null : 0,
          text: normalizeCliText(String(stdout || '') + '\n' + String(stderr || '')),
          error: err ? err.message : undefined,
        });
      },
    );
  });
}

/** 检测当前 Node / npm 是否可用；结果缓存 60 秒。 */
export async function detectNpmRuntime(force = false): Promise<NpmRuntime> {
  if (!force && cachedRuntime && Date.now() - cachedRuntime.at < RUNTIME_TTL_MS) {
    return cachedRuntime.value;
  }
  // 逐个候选验证：必须真的能跑出 vX.Y.Z 才算可用（商店别名的 node.exe 会执行失败）。
  const candidates = nodeCandidates();
  const failures: string[] = [];
  let lowVersion: string | undefined;
  let nodeExec: string | undefined;
  let nodeVersion: string | undefined;
  for (const candidate of candidates) {
    const probe = await runFile(candidate, ['--version'], 8000);
    const parsed = parseNodeVersion(probe.text);
    if (!parsed.version) {
      failures.push(candidate + '（' + (probe.error || '没有输出版本') + '）');
      continue;
    }
    if ((parsed.major ?? 0) < 18) {
      lowVersion = parsed.version;
      continue;
    }
    nodeExec = candidate;
    nodeVersion = parsed.version;
    break;
  }
  if (!nodeExec) {
    const value: NpmRuntime = lowVersion
      ? {
          ok: false,
          nodeVersion: lowVersion,
          error: 'Node.js 版本过低（' + lowVersion + '），豆包 CLI 需要 18 或以上。',
        }
      : {
          ok: false,
          error:
            '无法运行 Node.js（尝试了 ' + candidates.length + ' 个路径' + (failures[0] ? '，例如：' + failures[0] : '') + '）。' +
            '请安装 Node.js 18+ 后点「重新检测」。',
        };
    cachedRuntime = { at: Date.now(), value };
    return value;
  }
  const npmCli = resolveNpmCli(nodeExec);
  if (!npmCli) {
    const value: NpmRuntime = {
      ok: false,
      nodeExec,
      nodeVersion,
      error: '找到了 Node.js，但没有找到 npm-cli.js；请重新安装 Node.js（包含 npm）。',
    };
    cachedRuntime = { at: Date.now(), value };
    return value;
  }
  const npm = await runFile(nodeExec, [npmCli, '--version'], 15_000);
  const npmVersion = npm.text.split('\n').map((line) => line.trim()).filter(Boolean)[0];
  if (npm.code !== 0 || !npmVersion) {
    const value: NpmRuntime = {
      ok: false,
      nodeExec,
      nodeVersion,
      npmCli,
      error: 'npm 不可用（' + (npm.error || '未知错误') + '）',
    };
    cachedRuntime = { at: Date.now(), value };
    return value;
  }
  const value: NpmRuntime = { ok: true, nodeExec, nodeVersion, npmVersion, npmCli };
  cachedRuntime = { at: Date.now(), value };
  return value;
}

export function clearNpmRuntimeCache(): void {
  cachedRuntime = undefined;
}

export interface NpmInstallOptions {
  /** 真正的 node 可执行文件（不是 Code.exe）。 */
  nodeExec: string;
  npmCli: string;
  onLine?: (line: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  spawnImpl?: typeof spawn;
  /** 测试用：不调用 taskkill。 */
  disableKillTree?: boolean;
}

/** 执行 npm install -g @bytedance/doubao-cli，按行回报输出。 */
export function runNpmInstall(options: NpmInstallOptions): Promise<NpmInstallResult> {
  const spawnImpl = options.spawnImpl ?? spawn;
  const args = [options.npmCli, ...CLI_INSTALL_ARGS];
  return new Promise<NpmInstallResult>((resolve) => {
    let output = '';
    let lineBuffer = '';
    let aborted = false;
    let timedOut = false;
    let settled = false;
    let error: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    let forceKill: NodeJS.Timeout | undefined;

    const emitLine = (line: string): void => {
      const text = line.trim();
      if (!text) {
        return;
      }
      try {
        options.onLine?.(text.length > 300 ? text.slice(0, 300) + '…' : text);
      } catch {
        /* 忽略回调异常 */
      }
    };

    const consume = (chunk: string): void => {
      if (output.length < 2 * 1024 * 1024) {
        output += chunk;
      }
      lineBuffer += chunk;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        emitLine(normalizeCliText(line));
      }
    };

    let child: ChildProcess;
    try {
      child = spawnImpl(options.nodeExec, args, {
        env: { ...process.env, npm_config_update_notifier: 'false' },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ ok: false, code: null, output: '', error: err instanceof Error ? err.message : String(err), aborted: false, timedOut: false });
      return;
    }

    const finish = (code: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (lineBuffer.trim()) {
        emitLine(normalizeCliText(lineBuffer));
      }
      if (timer) {
        clearTimeout(timer);
      }
      if (forceKill) {
        clearTimeout(forceKill);
      }
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        ok: code === 0 && !aborted && !timedOut && !error,
        code,
        output,
        error,
        aborted,
        timedOut,
      });
    };

    const killChild = (): void => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      if (!forceKill) {
        forceKill = setTimeout(() => {
          if (process.platform === 'win32' && child.pid && !options.spawnImpl && !options.disableKillTree) {
            try {
              spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).unref();
            } catch {
              /* ignore */
            }
          }
          try {
            child.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }, 3000);
      }
    };

    const onAbort = (): void => {
      aborted = true;
      killChild();
    };
    if (options.signal) {
      if (options.signal.aborted) {
        aborted = true;
        killChild();
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killChild();
      }, timeoutMs);
    }

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string | Buffer) => consume(typeof chunk === 'string' ? chunk : chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: string | Buffer) => consume(typeof chunk === 'string' ? chunk : chunk.toString('utf8')));
    child.once('error', (err) => {
      error = err.message;
      finish(null);
    });
    child.once('close', (code) => finish(code));
  });
}
