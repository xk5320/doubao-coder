/** 启动豆包 CLI 扫码登录并解析二维码图片路径。 */
import { spawn, type ChildProcess } from 'node:child_process';

export interface StartLoginOptions {
  binary: string;
  /** 默认 ['login', '--qr=png']；测试可覆盖。 */
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onLine?: (line: string) => void;
  onQr?: (path: string) => void;
}

/** 从 CLI 输出行里解析 `QR_IMAGE=<path>`。 */
export function parseQrLine(line: string): string | undefined {
  const match = /QR_IMAGE\s*=\s*(.+)$/im.exec(String(line || ''));
  if (!match) {
    return undefined;
  }
  return match[1].trim().replace(/^["']|["']$/g, '');
}

/** 启动登录进程；输出行回调，二维码路径回调后主界面渲染图片。 */
export function startCliLogin(options: StartLoginOptions): ChildProcess {
  const args = options.args ?? ['login', '--qr=png'];
  const child = spawn(options.binary, args, {
    cwd: options.cwd,
    env: options.env ?? { ...process.env, NO_COLOR: '1', DOUBAO_CLI_NO_UPDATE_CHECK: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const handle = (chunk: Buffer): void => {
    const lines = String(chunk || '').split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) {
        continue;
      }
      options.onLine?.(line);
      const qr = parseQrLine(line);
      if (qr) {
        options.onQr?.(qr);
      }
    }
  };
  child.stdout?.on('data', handle);
  child.stderr?.on('data', handle);
  return child;
}

/** 等待二维码文件写完（CLI 先打印路径再写文件）。 */
export async function readQrFile(pathText: string, timeoutMs = 5000): Promise<Buffer | undefined> {
  const fs = await import('node:fs');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const data = fs.readFileSync(pathText);
      if (data.length > 100) {
        return data;
      }
    } catch {
      /* 还没写好 */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}
