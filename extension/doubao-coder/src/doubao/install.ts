/**
 * 豆包安装资源探测与引导
 *
 * 需求：凡是依赖"本地资源"的能力，必须先确认用户装了豆包，并**直接用豆包安装目录里的资源**，
 * 而不是我们自己造一份。
 *
 * 能真正复用的资源（已实测）：
 *   - `task-mode-resource/python-packages/gac_runtime/**`  ← Computer Use / Browser Use 的官方 SDK（Python）
 *     可以用 `PYTHONPATH=<该目录>` 直接 import，读出 20 个动作名 + 真实签名 + docstring
 *   - `清单文件`（产品版本）、`terminal_conpty/`、`mcp_helper.dll`、`runtime 组件/`
 *
 * 有一个硬约束（已实测）：SDK 只能**在豆包拉起的进程里**工作 ——
 * 直接调用会报 `GUI as Coding is not available: missing CUA_GAC_SERVER_PORT`，
 * 因为 GAC 管道的 secret/端口是宿主注入的环境变量。所以：
 *   - 能读出"动作面"（真资源）；
 *   - 执行要么在 GAC 可用时走官方 SDK，要么退化为本地 Win32 后端，并**明确告知用户原因**。
 */
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { log, warn } from '../log';

export interface DoubaoInstall {
  /** 安装根（含 Application/app 的父级）。 */
  root: string;
  /** `...\Application\app` 目录。 */
  appDir: string;
  exePath: string;
  version?: string;
  channel?: string;
  /** 官方 Computer Use SDK 目录（python-packages）。 */
  pythonPackagesDir: string;
  hasGacRuntime: boolean;
  hasConpty: boolean;
  hasMcpHelper: boolean;
  hasRuntimeBundle: boolean;
}

export class DoubaoNotInstalledError extends Error {
  constructor() {
    super('需要先安装「豆包」桌面端：本扩展的本地能力直接复用豆包安装目录里的运行时资源。');
    this.name = 'DoubaoNotInstalledError';
  }
}

const DOWNLOAD_URL = 'https://www.doubao.com/download/desktop';

/** 候选安装位置（配置优先）。 */
export function candidateExePaths(preferred?: string): string[] {
  const list: string[] = [];
  if (preferred) {
    list.push(preferred);
  }
  const local = process.env.LOCALAPPDATA;
  if (local) {
    list.push(join(local, 'Doubao', 'Application', 'app', 'Doubao.exe'));
  }
  const pf = process.env.ProgramFiles;
  if (pf) {
    list.push(join(pf, 'Doubao', 'Doubao.exe'));
  }
  return list;
}

/** 探测安装（不做 UI 交互）。 */
export async function detectInstall(preferred?: string): Promise<DoubaoInstall | undefined> {
  for (const exe of candidateExePaths(preferred)) {
    if (!existsSync(exe)) {
      continue;
    }
    const appDir = join(exe, '..');
    const taskMode = join(appDir, 'task-mode-resource');
    const pythonPackagesDir = join(taskMode, 'python-packages');
    let version: string | undefined;
    let channel: string | undefined;
    try {
      const manifest = JSON.parse(await readFile(join(appDir, '清单文件'), 'utf8')) as {
        version?: string;
        channel?: string;
      };
      version = manifest.version;
      channel = manifest.channel;
    } catch {
      /* manifest 可选 */
    }
    return {
      root: join(exe, '..', '..', '..'),
      appDir,
      exePath: exe,
      version,
      channel,
      pythonPackagesDir,
      hasGacRuntime: existsSync(join(pythonPackagesDir, 'gac_runtime', 'computer_use')),
      hasConpty: existsSync(join(appDir, 'terminal_conpty', 'OpenConsole.exe')),
      hasMcpHelper: existsSync(join(appDir, 'mcp_helper.dll')),
      hasRuntimeBundle: existsSync(join(taskMode, 'runtime 组件', '清单文件')),
    };
  }
  return undefined;
}

/** 探测；没装就弹窗引导安装，装了就返回。 */
export async function requireInstall(preferred?: string): Promise<DoubaoInstall> {
  const found = await detectInstall(preferred);
  if (found) {
    return found;
  }
  log('未检测到豆包安装，弹出安装引导');
  const pick = await vscode.window.showWarningMessage(
    '这个功能要用到「豆包」桌面端的本地运行时（Computer Use SDK / 终端 / MCP 宿主）。',
    {
      modal: true,
      detail: [
        '会使用安装目录里的这些资源：',
        '· task-mode-resource\\python-packages（官方 Computer Use / Browser Use SDK）',
        '· terminal_conpty（ConPTY 终端）',
        '· mcp_helper.dll（MCP 宿主）',
        '',
        '检测位置：%LOCALAPPDATA%\\Doubao\\Application\\app\\Doubao.exe',
        '也可以先用命令「豆包: 设置安装路径」手动指定。',
      ].join('\n'),
    },
    '打开下载页',
    '重新检测',
  );
  if (pick === '打开下载页') {
    await vscode.env.openExternal(vscode.Uri.parse(DOWNLOAD_URL));
  } else if (pick === '重新检测') {
    return requireInstall(preferred);
  }
  throw new DoubaoNotInstalledError();
}

/* -------------------------------------------------------------------------- */
/* 从安装目录读取"动作面"（真资源，避免我们自己手写漂移）                        */
/* -------------------------------------------------------------------------- */

export interface CuActionSurface {
  name: string;
  signature: string;
  doc: string;
}

/**
 * 用安装目录里的 SDK 读出官方动作面。
 * 需要本机有 Python（3.9+）；没有则返回 undefined（调用方回退到内置清单）。
 */
export async function readComputerUseSurface(
  install: DoubaoInstall,
  pythonPath = 'python',
  timeoutMs = 20_000,
): Promise<CuActionSurface[] | undefined> {
  if (!install.hasGacRuntime) {
    return undefined;
  }
  const script = `
import sys, json, inspect
sys.path.insert(0, r"${install.pythonPackagesDir}")
try:
    import seed_computer_use as cu
except Exception as e:
    print(json.dumps({"ok": False, "error": "%s: %s" % (type(e).__name__, e)}))
    raise SystemExit(0)
names = list(getattr(cu, "__all__", []))
out = []
for n in names:
    fn = getattr(cu, n, None)
    try:
        sig = str(inspect.signature(fn)) if fn else ""
    except Exception:
        sig = ""
    out.append({"name": n, "signature": sig, "doc": (inspect.getdoc(fn) or "").split("\\n")[0]})
print(json.dumps({"ok": True, "actions": out}, ensure_ascii=False))
`;
  try {
    const stdout = await runPython(pythonPath, script, timeoutMs);
    const parsed = JSON.parse(stdout.trim().split(/\r?\n/).pop() ?? '{}') as {
      ok?: boolean;
      actions?: CuActionSurface[];
      error?: string;
    };
    if (!parsed.ok || !parsed.actions) {
      warn('读取官方动作面失败', parsed.error ?? 'unknown');
      return undefined;
    }
    log('已从豆包安装目录读取动作面', `${parsed.actions.length} 个动作`);
    return parsed.actions;
  } catch (err) {
    warn('读取官方动作面异常', err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

function runPython(pythonPath: string, code: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(pythonPath, ['-c', code], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Python 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      err += c.toString('utf8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code2) => {
      clearTimeout(timer);
      if (code2 === 0) {
        resolve(out);
      } else {
        reject(new Error(`Python 退出码 ${code2}: ${err.slice(0, 300)}`));
      }
    });
  });
}

/* -------------------------------------------------------------------------- */
/* GAC 通道可用性探测                                                           */
/* -------------------------------------------------------------------------- */

export interface GacProbe {
  available: boolean;
  reason: string;
}

/**
 * 探测官方 SDK 能否真正执行动作。
 * 只有在豆包拉起的环境里（注入了 CUA_GAC_SERVER_PORT/SECRET）才会 available。
 */
export async function probeGacChannel(
  install: DoubaoInstall,
  pythonPath = 'python',
  timeoutMs = 15_000,
): Promise<GacProbe> {
  if (!install.hasGacRuntime) {
    return { available: false, reason: '安装目录里没有 gac_runtime（版本过旧？）' };
  }
  const missing = ['CUA_GAC_SERVER_PORT', 'CUA_GAC_SECRET'].filter((k) => !process.env[k]);
  if (missing.length) {
    return {
      available: false,
      reason: `当前进程没有 GAC 通道（缺少 ${missing.join('/')}）——该通道只在豆包拉起的子进程里注入`,
    };
  }
  const script = `
import sys, json
sys.path.insert(0, r"${install.pythonPackagesDir}")
try:
    import seed_computer_use as cu
    apps = cu.list_apps()
    print(json.dumps({"ok": True, "apps": len(apps)}))
except Exception as e:
    print(json.dumps({"ok": False, "error": "%s: %s" % (type(e).__name__, e)}))
`;
  try {
    const stdout = await runPython(pythonPath, script, timeoutMs);
    const parsed = JSON.parse(stdout.trim().split(/\r?\n/).pop() ?? '{}') as {
      ok?: boolean;
      apps?: number;
      error?: string;
    };
    return parsed.ok
      ? { available: true, reason: `GAC 通道可用（list_apps 返回 ${parsed.apps} 个应用）` }
      : { available: false, reason: parsed.error ?? '未知错误' };
  } catch (err) {
    return { available: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** 统计安装目录里可被复用的大件（用于诊断命令）。 */
export async function summarizeResources(install: DoubaoInstall): Promise<Array<{ name: string; detail: string }>> {
  const out: Array<{ name: string; detail: string }> = [];
  out.push({ name: '产品版本', detail: install.version ? `${install.version} (channel ${install.channel ?? '?'})` : '读不到 清单文件' });
  out.push({ name: 'Computer Use SDK', detail: install.hasGacRuntime ? install.pythonPackagesDir : '缺失' });
  out.push({ name: 'ConPTY 终端', detail: install.hasConpty ? 'terminal_conpty\\OpenConsole.exe' : '缺失' });
  out.push({ name: 'MCP 宿主', detail: install.hasMcpHelper ? 'mcp_helper.dll' : '缺失' });
  out.push({ name: '任务运行时 bundle', detail: install.hasRuntimeBundle ? 'runtime 组件/清单文件' : '缺失' });
  try {
    const dir = join(install.pythonPackagesDir, 'gac_runtime');
    const entries = await readdir(dir);
    out.push({ name: 'gac_runtime 子模块', detail: `${entries.length} 项：${entries.slice(0, 6).join(', ')}` });
  } catch {
    /* ignore */
  }
  try {
    const s = await stat(install.exePath);
    out.push({ name: '主程序', detail: `${install.exePath}（${(s.size / 1048576).toFixed(1)} MB）` });
  } catch {
    /* ignore */
  }
  return out;
}
