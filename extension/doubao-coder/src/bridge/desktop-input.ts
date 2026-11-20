/**
 * M2：把镜像面板里的鼠标/键盘/滚轮转发回豆包窗口。
 *
 * 坐标用「归一化 0..1」传：webview 只知道自己相对于画面的位置，
 * 扩展启动时从 `Page.getLayoutMetrics` 拿到豆包视口尺寸再做乘法。
 */
import { CdpSession, DOUBAO_DEBUG_PORT, listTargets, pickChatPage } from './cdp';
import { log, warn } from '../log';

export interface Viewport {
  width: number;
  height: number;
}

export class DesktopInput {
  private viewport: Viewport = { width: 0, height: 0 };

  private constructor(private readonly session: CdpSession) {}

  public static async connect(port = DOUBAO_DEBUG_PORT): Promise<DesktopInput> {
    const targets = await listTargets(port);
    const page = await pickChatPage(targets);
    if (!page) {
      throw new Error('没有找到豆包页面（需要以调试端口启动）');
    }
    const session = await CdpSession.connect(page.webSocketDebuggerUrl);
    const input = new DesktopInput(session);
    await input.refreshViewport();
    return input;
  }

  public get size(): Viewport {
    return this.viewport;
  }

  /** 刷新视口尺寸（窗口缩放后必须刷新，否则点击会偏）。 */
  public async refreshViewport(): Promise<Viewport> {
    try {
      const metrics = await this.session.send<{
        cssLayoutViewport?: { clientWidth?: number; clientHeight?: number };
      }>('Page.getLayoutMetrics', {}, 5000);
      const view = metrics.cssLayoutViewport ?? {};
      this.viewport = { width: view.clientWidth ?? 0, height: view.clientHeight ?? 0 };
    } catch (err) {
      warn('读取视口尺寸失败', err instanceof Error ? err.message : String(err));
    }
    return this.viewport;
  }

  private toPage(xNorm: number, yNorm: number): { x: number; y: number } {
    const width = this.viewport.width || 1000;
    const height = this.viewport.height || 700;
    return {
      x: Math.max(0, Math.min(width - 1, Math.round(xNorm * width))),
      y: Math.max(0, Math.min(height - 1, Math.round(yNorm * height))),
    };
  }

  public async move(xNorm: number, yNorm: number): Promise<void> {
    const { x, y } = this.toPage(xNorm, yNorm);
    await this.session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 }, 4000);
  }

  public async click(xNorm: number, yNorm: number, button: 'left' | 'right' = 'left'): Promise<void> {
    const { x, y } = this.toPage(xNorm, yNorm);
    const buttons = button === 'left' ? 1 : 2;
    await this.session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 }, 4000);
    await this.session.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x, y, button, buttons, clickCount: 1 },
      4000,
    );
    await this.session.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 },
      4000,
    );
  }

  public async wheel(xNorm: number, yNorm: number, deltaY: number, deltaX = 0): Promise<void> {
    const { x, y } = this.toPage(xNorm, yNorm);
    await this.session.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseWheel', x, y, deltaX, deltaY, buttons: 0 },
      4000,
    );
  }

  public async key(
    type: 'keyDown' | 'keyUp',
    key: string,
    code: string,
    modifiers: number,
  ): Promise<void> {
    const vk = virtualKey(key);
    await this.session.send(
      'Input.dispatchKeyEvent',
      {
        type: type === 'keyDown' ? 'rawKeyDown' : 'keyUp',
        key,
        code,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
        modifiers,
      },
      4000,
    );
  }

  /** 文本输入（中文/粘贴走这个，避免 IME 与 key 事件打架）。 */
  public async text(value: string): Promise<void> {
    if (!value) {
      return;
    }
    await this.session.send('Input.insertText', { text: value }, 5000);
  }

  public close(): void {
    this.session.close();
  }
}

/** 常见按键的 Windows 虚拟键码（够用即可，未知返回 0）。 */
function virtualKey(key: string): number {
  if (key.length === 1) {
    const upper = key.toUpperCase();
    const code = upper.charCodeAt(0);
    if (code >= 65 && code <= 90) {
      return code;
    }
    if (code >= 48 && code <= 57) {
      return code;
    }
  }
  const map: Record<string, number> = {
    Enter: 13,
    Tab: 9,
    Escape: 27,
    Backspace: 8,
    Delete: 46,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    Home: 36,
    End: 35,
    PageUp: 33,
    PageDown: 34,
    ' ': 32,
  };
  return map[key] ?? 0;
}

export function modifierBits(input: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean }): number {
  let bits = 0;
  if (input.alt) {
    bits |= 1;
  }
  if (input.ctrl) {
    bits |= 2;
  }
  if (input.meta) {
    bits |= 4;
  }
  if (input.shift) {
    bits |= 8;
  }
  return bits;
}

export function logInput(kind: string, detail: string): void {
  log('镜像输入', kind, detail);
}
