/**
 * Chrome DevTools Protocol 最小客户端。
 *
 * 用途：连接本机豆包桌面端（Chromium 147）的调试端口，把「已登录的官方页面」当成后端。
 * 只在 127.0.0.1 上通信；不读取、不导出任何 Cookie / 凭据文件。
 */
import { MiniWebSocket } from './ws';

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export interface CdpVersion {
  Browser: string;
  'Protocol-Version': string;
  webSocketDebuggerUrl: string;
}

export const DOUBAO_DEBUG_PORT = 9222;

/**
 * 选出要驱动的豆包对话页。
 *
 * 桌面端会同时存在多个标签页（对话页、网页版 doubao.com、官网…），
 * 直接取 `find(url.includes('doubao-chat'))` 可能拿到隐藏的后台标签页，
 * 表现就是「扩展说发了，豆包界面没切过去」。
 *
 * 规则：
 *  1. 只用 `doubao://doubao-chat/...`（客户端内对话页，含新建后的 `/chat`）；没有时才退到网页版；
 *  2. 多个候选时，优先 `document.visibilityState === 'visible'` 的那个（用户正在看的标签页）；
 *  3. 都不可见时取第一个，由调用方 `Page.bringToFront` 切过去。
 */
export function chatPageCandidates(targets: CdpTarget[]): CdpTarget[] {
  const pages = targets.filter((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string');
  if (!pages.length) {
    return [];
  }
  // 注意：新建对话后 URL 是 `doubao://doubao-chat/chat`（没有会话 id、也没有结尾斜杠），
  // 所以只匹配到 `/doubao-chat/` 这一段，别再要求 `/chat/`。
  const desktopChats = pages.filter((t) => t.url.startsWith('doubao://doubao-chat/'));
  const webChats = pages.filter((t) => t.url.startsWith('https://www.doubao.com/chat/'));
  const pool = desktopChats.length
    ? desktopChats
    : webChats.length
      ? webChats
      : pages.filter((t) => t.url.includes('doubao'));
  return pool.length ? pool : [pages[0]];
}

export async function pickChatPage(targets: CdpTarget[]): Promise<CdpTarget | undefined> {
  const candidates = chatPageCandidates(targets);
  if (!candidates.length) {
    return undefined;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }
  // 多标签页：问一下每个页面自己是不是前台可见
  for (const target of candidates) {
    let session: CdpSession | undefined;
    try {
      session = await CdpSession.connect(target.webSocketDebuggerUrl);
      const visibility = await session.evaluate<string>('document.visibilityState', 2500);
      if (visibility === 'visible') {
        return target;
      }
    } catch {
      /* 某个标签页连不上就跳过 */
    } finally {
      session?.close();
    }
  }
  return candidates[0];
}

function httpJson<T>(port: number, path: string, timeoutMs = 3000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const http = require('node:http') as typeof import('node:http');
    const req = http.get(
      { host: '127.0.0.1', port, path, timeout: timeoutMs, headers: { Host: `127.0.0.1:${port}` } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(text) as T);
          } catch (err) {
            reject(new Error(`返回不是 JSON：${text.slice(0, 120)}`));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`请求 /${path} 超时`)));
    req.on('error', (err) => reject(err));
  });
}

export function getVersion(port = DOUBAO_DEBUG_PORT): Promise<CdpVersion> {
  return httpJson<CdpVersion>(port, '/json/version');
}

export function listTargets(port = DOUBAO_DEBUG_PORT): Promise<CdpTarget[]> {
  return httpJson<CdpTarget[]>(port, '/json/list');
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class CdpSession {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** 没有 id 的 CDP 事件（Network.* / Runtime.* 等）。 */
  private readonly events: Array<{ method: string; params: unknown }> = [];
  private closed = false;

  private constructor(private readonly ws: MiniWebSocket) {
    ws.on('message', (text: string) => this.onMessage(text));
    ws.on('close', () => this.onClose(new Error('CDP 连接已关闭')));
    ws.on('error', (err: Error) => this.onClose(err));
  }

  public static async connect(wsUrl: string, timeoutMs = 5000): Promise<CdpSession> {
    const ws = await MiniWebSocket.connect(wsUrl, timeoutMs);
    return new CdpSession(ws);
  }

  public send<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15000): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error('CDP 连接已关闭'));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 调用超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** 在页面里执行表达式并取回 JSON 值。 */
  public async evaluate<T = unknown>(expression: string, timeoutMs = 15000): Promise<T> {
    const result = await this.send<{
      result?: { value?: T; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '未知异常';
      throw new Error(`页面脚本异常：${detail.slice(0, 300)}`);
    }
    return result.result?.value as T;
  }

  /** 取走已到达的事件；没有就等 waitMs 毫秒。 */
  public async takeEvents(waitMs = 200): Promise<Array<{ method: string; params: unknown }>> {
    if (this.events.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    return this.events.splice(0, this.events.length);
  }

  public close(): void {
    this.onClose(new Error('主动关闭'));
  }

  private onMessage(text: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string; code?: number } };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof msg.id !== 'number') {
      const evt = msg as unknown as { method?: string; params?: unknown };
      if (typeof evt.method === 'string') {
        this.events.push({ method: evt.method, params: evt.params });
        if (this.events.length > 4000) {
          this.events.splice(0, 1000);
        }
      }
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) {
      return;
    }
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) {
      pending.reject(new Error(msg.error.message ?? `CDP 错误 ${msg.error.code ?? ''}`));
    } else {
      pending.resolve(msg.result);
    }
  }

  private onClose(err: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
    this.ws.close();
  }
}
