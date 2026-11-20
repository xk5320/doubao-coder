/**
 * 豆包 CLI 的轻量调用层。
 *
 * 设计原则：
 * - 不依赖 vscode，纯 Node + child_process，方便离线单测；
 * - 只负责「起一个 doubao -p」，不实现工具/权限/技能——这些都由官方 CLI 自己做；
 * - stdout 缓冲后作为回答，stderr 作为状态提示（CLI 的进度输出走 stderr）。
 */
import { spawn, type ChildProcess } from 'node:child_process';

export const CLI_DOC_URL = 'https://www.doubao.com/work/docs/zh-cn/doubao-cli';
export const CLI_INSTALL_COMMAND =
  "npm install -g '@bytedance/doubao-cli' --registry=https://registry.npmjs.org/";

export type CliPermissionMode = 'ask_always' | 'ask_risky' | 'always_allow';
export type CliEffort = 'Low' | 'Medium' | 'High';

export interface CliTaskOptions {
  /** doubao 可执行文件绝对路径（扩展侧负责探测）。 */
  binary: string;
  prompt: string;
  /** 工作目录：CLI 的 -C。 */
  cwd?: string;
  permissionMode?: CliPermissionMode;
  model?: string;
  effort?: CliEffort;
  /** 续接历史会话：doubao --resume <session-id>。 */
  resumeId?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** 流式拿到 stdout 片段（默认只缓冲，结束时给最终文本）。 */
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
  onSpawn?: (child: ChildProcess) => void;
  /** 测试注入。 */
  spawnImpl?: typeof spawn;
  killGraceMs?: number;
}

export interface CliTaskResult {
  ok: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** 清理 ANSI / 进度回车后的最终文本。 */
  text: string;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  sessionId?: string;
  /** 进程启动失败（如 ENOENT）时的错误信息。 */
  error?: string;
}

const MAX_CAPTURE = 8 * 1024 * 1024;

/** 去掉 ANSI 转义（颜色、光标、OSC 标题等）。 */
export function stripAnsi(input: string): string {
  return String(input ?? '')
    // OSC：ESC ] ... BEL 或 ST
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    // CSI：ESC [ 参数 终止符
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    // 其他两字节 ESC 序列
    .replace(/\u001b[@-_]/g, '')
    // 单独的 \r 进度条残留
    .replace(/\u0008/g, '');
}

/**
 * 把终端里的「回车覆盖」还原成最终可见文本：
 * 同一行出现多个 \r 时，只保留最后一段（进度条常见的写法）。
 */
export function collapseCarriageReturns(input: string): string {
  const lines = String(input ?? '').split('\n');
  return lines
    .map((line) => {
      if (!line.includes('\r')) {
        return line;
      }
      const parts = line.split('\r').filter((part, index, all) => part.length > 0 || index === all.length - 1);
      return parts.length > 0 ? parts[parts.length - 1] : '';
    })
    .join('\n');
}

/** 清理 CLI 输出：ANSI、进度回车、行尾空白，压缩连续空行。 */
export function normalizeCliText(input: string): string {
  const text = collapseCarriageReturns(stripAnsi(input))
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text;
}

export function buildCliArgs(options: {
  prompt: string;
  cwd?: string;
  permissionMode?: CliPermissionMode;
  model?: string;
  effort?: CliEffort;
  resumeId?: string;
}): string[] {
  const args: string[] = [];
  if (options.cwd && options.cwd.trim()) {
    args.push('-C', options.cwd.trim());
  }
  if (options.resumeId && options.resumeId.trim()) {
    args.push('--resume', options.resumeId.trim());
  }
  if (options.model && options.model.trim()) {
    args.push('--model', options.model.trim());
  }
  if (options.effort) {
    args.push('--effort', options.effort);
  }
  if (options.permissionMode) {
    args.push('--permission-mode', options.permissionMode);
  }
  // -p 放最后：提示词整体作为一个参数，CLI 文档要求英文引号包裹，spawn 不经过 shell 天然满足。
  args.push('-p', options.prompt);
  return args;
}

/** 从 CLI 输出里找会话 ID（不同版本可能用 session id / resume 提示）。 */
export function extractSessionId(raw: string): string | undefined {
  const text = stripAnsi(String(raw ?? ''));
  if (!text) {
    return undefined;
  }
  const patterns = [
    /(?:session[\s_-]?id|会话\s*id)\s*[:：=]\s*([A-Za-z0-9][A-Za-z0-9_-]{5,})/i,
    /--resume\s+["']?([A-Za-z0-9][A-Za-z0-9_-]{5,})["']?/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match && match[1]) {
      return match[1];
    }
  }
  return undefined;
}

/** 判断失败是否因为 --resume 的会话 ID 失效（可以安全地新开一轮）。 */
export function isResumeRejected(raw: string): boolean {
  const text = stripAnsi(String(raw ?? ''));
  return /(resume|会话|session).{0,24}(not found|不存在|无效|失效|expired|invalid)/i.test(text)
    || /(not found|不存在|无效|失效|expired|invalid).{0,24}(resume|会话|session)/i.test(text);
}

/** 把 stderr 的一行整理成可显示的状态；返回空串表示不值得显示。 */
export function statusLine(raw: string, maxLength = 160): string {
  const text = normalizeCliText(raw)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
  if (!text) {
    return '';
  }
  return text.length > maxLength ? text.slice(0, maxLength) + '…' : text;
}

function appendCapped(target: string, chunk: string): string {
  if (target.length >= MAX_CAPTURE) {
    return target;
  }
  const next = target + chunk;
  return next.length > MAX_CAPTURE ? next.slice(0, MAX_CAPTURE) : next;
}

/**
 * 执行一次非交互任务：doubao -C <cwd> [--resume id] [-p prompt]。
 * 只结束本次进程，不改动 CLI 的登录态 / 配置。
 */
export function runCliTask(options: CliTaskOptions): Promise<CliTaskResult> {
  const prompt = String(options.prompt ?? '');
  const args = buildCliArgs({ ...options, prompt });
  const spawnImpl = options.spawnImpl ?? spawn;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    // 自动更新检查在非 TTY 下本来就会跳过，这里再显式关掉，避免子进程等待输入。
    DOUBAO_CLI_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };

  return new Promise<CliTaskResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let error: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    let forceKill: NodeJS.Timeout | undefined;

    let child: ChildProcess;
    try {
      child = spawnImpl(options.binary, args, {
        cwd: options.cwd && options.cwd.trim() ? options.cwd : undefined,
        env,
        windowsHide: true,
        // stdin 必须关闭：CLI 若弹交互提示，直接 EOF 而不是挂住。
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({
        ok: false, code: null, signal: null, stdout: '', stderr: '', text: '',
        timedOut: false, aborted: false, truncated: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    try {
      options.onSpawn?.(child);
    } catch {
      /* 回调失败不影响主流程 */
    }

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (forceKill) {
        clearTimeout(forceKill);
      }
      options.signal?.removeEventListener('abort', onAbort);
      const text = normalizeCliText(stdout);
      resolve({
        ok: code === 0 && !timedOut && !aborted && !error,
        code,
        signal,
        stdout,
        stderr,
        text,
        timedOut,
        aborted,
        truncated,
        sessionId: extractSessionId(stdout + '\n' + stderr),
        error,
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
          // Windows 上升级为整棵进程树，避免 CLI 派生的子进程残留。
          if (process.platform === 'win32' && child.pid && !options.spawnImpl) {
            try {
              spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
                stdio: 'ignore',
                windowsHide: true,
              }).unref();
            } catch {
              /* ignore */
            }
          }
          try {
            child.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }, Math.max(200, options.killGraceMs ?? 3000));
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

    if (typeof options.timeoutMs === 'number' && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killChild();
      }, options.timeoutMs);
    }

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const next = appendCapped(stdout, text);
      if (next.length === stdout.length) {
        truncated = true;
      }
      stdout = next;
      try {
        options.onStdoutChunk?.(text);
      } catch {
        /* ignore */
      }
    });
    child.stderr?.on('data', (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const next = appendCapped(stderr, text);
      if (next.length === stderr.length) {
        truncated = true;
      }
      stderr = next;
      try {
        options.onStderrChunk?.(text);
      } catch {
        /* ignore */
      }
    });
    child.once('error', (err) => {
      error = err.message;
      finish(null, null);
    });
    child.once('close', (code, signal) => finish(code, signal));
  });
}
