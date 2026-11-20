import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

/**
 * 全局 OutputChannel 日志。所有模块统一通过这里输出，便于用户在
 * “输出 → 豆包编程助手”里排查问题。
 */
let channel: vscode.OutputChannel | undefined;
/** 本地日志文件：OutputChannel 不落盘，出问题后没法事后排查。 */
let logFile: string | undefined;
let started = Date.now();

export function initLog(context: vscode.ExtensionContext): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('豆包编程助手');
    context.subscriptions.push(channel);
    started = Date.now();
    try {
      fs.mkdirSync(context.logUri.fsPath, { recursive: true });
      const file = path.join(context.logUri.fsPath, 'doubao.log');
      // 超过 2MB 轮转一份，避免无限增长
      if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) {
        fs.renameSync(file, file + '.1');
      }
      logFile = file;
    } catch {
      logFile = undefined;
    }
  }
  return channel;
}

function write(level: string, args: unknown[]): void {
  const text = args
    .map((item) => {
      if (item instanceof Error) {
        return item.stack ?? `${item.name}: ${item.message}`;
      }
      if (typeof item === 'string') {
        return item;
      }
      try {
        return JSON.stringify(item);
      } catch {
        return String(item);
      }
    })
    .join(' ');
  if (!channel) {
    // 未初始化时退化到 console，方便单元测试 / 早期启动阶段。
    // eslint-disable-next-line no-console
    console.log(`[doubao][${level}] ${text}`);
    return;
  }
  const line = `[${new Date().toISOString()}] [${level}] ${text}`;
  channel.appendLine(line);
  if (logFile) {
    try {
      fs.appendFileSync(logFile, line + '\n', 'utf8');
    } catch {
      /* 日志写失败不影响主流程 */
    }
  }
}

export function log(...args: unknown[]): void {
  write('INFO', args);
}

export function debug(...args: unknown[]): void {
  write('DEBUG', args);
}

export function warn(...args: unknown[]): void {
  write('WARN', args);
}

export function error(...args: unknown[]): void {
  write('ERROR', args);
}

export function logError(prefix: string, err: unknown): void {
  if (err instanceof Error) {
    error(prefix, err);
  } else {
    error(prefix, String(err));
  }
}

export function showLogs(): void {
  if (!channel) {
    channel = vscode.window.createOutputChannel('豆包编程助手');
  }
  channel.show(true);
}

export function uptimeSeconds(): number {
  return Math.round((Date.now() - started) / 1000);
}
