/**
 * 探测本机豆包 CLI：可执行文件、版本、登录状态。
 *
 * npm 安装器会把原生程序放到应用数据目录（Windows 为
 * %LOCALAPPDATA%\doubao_cli\app\current\doubao.exe），因此优先直连原生程序：
 * - 不经过 npm 的 doubao.cmd 包装脚本，避免 shell 引号与更新提示；
 * - 不依赖 PATH（VS Code 从桌面启动时 PATH 可能和终端不一致）。
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { normalizeCliText } from './runner';

export type CliSource = 'config' | 'appdata' | 'path' | 'missing';

export interface CliInfo {
  installed: boolean;
  binary?: string;
  version?: string;
  source: CliSource;
  /** 配置里写了路径但不存在等问题的说明。 */
  error?: string;
}

export interface CliAuthState {
  loggedIn: boolean;
  /** CLI 的原始输出（清理后，最多 400 字）。 */
  detail: string;
  code: number | null;
  error?: string;
}

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

const VERSION_TTL_MS = 60_000;
const AUTH_TTL_MS = 30_000;
const versionCache = new Map<string, { at: number; version?: string }>();
const authCache = new Map<string, { at: number; state: CliAuthState }>();

function runFile(file: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const err = error as (Error & { code?: number | string }) | null;
        resolve({
          code: typeof err?.code === 'number' ? err.code : err ? null : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          error: err ? err.message : undefined,
        });
      },
    );
  });
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function appDataRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'doubao_cli', 'app', 'current');
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'doubao_cli', 'app', 'current');
  }
  const xdg = env.XDG_DATA_HOME;
  if (xdg) {
    return path.join(xdg, 'doubao_cli', 'app', 'current');
  }
  const home = env.HOME || os.homedir();
  return home ? path.join(home, '.local', 'share', 'doubao_cli', 'app', 'current') : undefined;
}

/** 按「配置 → 应用数据目录 → PATH」的顺序列出候选可执行文件。 */
export function candidateBinaries(
  configured: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const names = platform === 'win32' ? ['doubao.exe'] : ['doubao'];
  const result: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string | undefined): void => {
    if (!candidate) {
      return;
    }
    const normalized = path.normalize(candidate);
    const key = platform === 'win32' ? normalized.toLowerCase() : normalized;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  };
  if (configured && configured.trim()) {
    add(configured.trim());
  }
  const root = appDataRoot(env, platform);
  if (root) {
    for (const name of names) {
      add(path.join(root, name));
    }
  }
  const pathValue = env.PATH || env.Path || '';
  for (const folder of pathValue.split(path.delimiter)) {
    if (!folder) {
      continue;
    }
    for (const name of names) {
      add(path.join(folder, name));
    }
  }
  return result;
}

async function readVersion(binary: string): Promise<string | undefined> {
  const cached = versionCache.get(binary);
  if (cached && Date.now() - cached.at < VERSION_TTL_MS) {
    return cached.version;
  }
  const result = await runFile(binary, ['--version'], 10_000);
  const text = normalizeCliText(result.stdout || result.stderr);
  const version = text.split('\n').map((line) => line.trim()).filter(Boolean)[0];
  if (result.code !== 0 || !version) {
    versionCache.set(binary, { at: Date.now(), version: undefined });
    return undefined;
  }
  const cleaned = version.replace(/^doubao(?:-cli)?\s*/i, '').trim() || version;
  versionCache.set(binary, { at: Date.now(), version: cleaned });
  return cleaned;
}

/** 探测 CLI 是否安装（会执行 doubao --version，结果缓存 60s）。 */
export async function detectCli(configured = ''): Promise<CliInfo> {
  const candidates = candidateBinaries(configured);
  if (configured && configured.trim() && !isFile(configured.trim())) {
    return {
      installed: false,
      source: 'missing',
      error: '配置的 doubao.cli.path 不存在：' + configured.trim(),
    };
  }
  const root = appDataRoot(process.env, process.platform);
  for (const candidate of candidates) {
    if (!isFile(candidate)) {
      continue;
    }
    const version = await readVersion(candidate);
    if (!version) {
      continue;
    }
    const source: CliSource =
      configured && path.normalize(configured.trim()).toLowerCase() === path.normalize(candidate).toLowerCase()
        ? 'config'
        : root && path.normalize(candidate).toLowerCase().startsWith(path.normalize(root).toLowerCase())
          ? 'appdata'
          : 'path';
    return { installed: true, binary: candidate, version, source };
  }
  return { installed: false, source: 'missing' };
}

/** 检查登录态：doubao auth status --verify（会联网校验，结果缓存 30s）。 */
export async function checkCliAuth(info: CliInfo): Promise<CliAuthState> {
  if (!info.installed || !info.binary) {
    return { loggedIn: false, detail: '未安装豆包 CLI', code: null };
  }
  const cached = authCache.get(info.binary);
  if (cached && Date.now() - cached.at < AUTH_TTL_MS) {
    return cached.state;
  }
  const result = await runFile(info.binary, ['auth', 'status', '--verify'], 30_000);
  const detail = normalizeCliText(result.stdout + '\n' + result.stderr).slice(0, 400);
  const state: CliAuthState = {
    loggedIn: result.code === 0,
    detail: detail || (result.code === 0 ? '已登录' : '未登录'),
    code: result.code,
    error: result.error,
  };
  authCache.set(info.binary, { at: Date.now(), state });
  return state;
}

/** 清掉缓存（用户登录/安装后调用）。 */
export function clearCliCache(binary?: string): void {
  if (binary) {
    versionCache.delete(binary);
    authCache.delete(binary);
    return;
  }
  versionCache.clear();
  authCache.clear();
}

/** 登录命令：二维码用 png，终端里能直接给出图片路径。 */
export function cliLoginArgs(): string[] {
  return ['login', '--qr=png'];
}
