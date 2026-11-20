/**
 * M1 镜像面板：在 VS Code 里开一个窗口，显示豆包的真实画面。
 *
 * 这一版只做「看」：起流 → 收帧 → 贴到 <img>；停止/重连；帧率与状态显示。
 * 输入转发（点哪里、打字）留到 M2。
 */
import * as vscode from 'vscode';

import { Screencast } from '../bridge/screencast';
import { DesktopInput, modifierBits } from '../bridge/desktop-input';
import { log, warn } from '../log';
import { randomNonce } from '../chat/panel';

export class MirrorPanel {
  private static current: MirrorPanel | undefined;
  private cast: Screencast | undefined;
  private input: DesktopInput | undefined;
  /** 看门狗：超过 6 秒没有新帧就认为投送断了，自动重连。 */
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private lastFrameAt = 0;
  private disposed = false;

  public static show(context: vscode.ExtensionContext): MirrorPanel {
    if (MirrorPanel.current) {
      MirrorPanel.current.panel.reveal();
      return MirrorPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'doubaoMirror',
      '豆包镜像',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      },
    );
    const mirror = new MirrorPanel(panel, context);
    MirrorPanel.current = mirror;
    return mirror;
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
  ) {
    this.panel.webview.html = this.getHtml();
    this.panel.onDidDispose(() => this.dispose());
    this.panel.webview.onDidReceiveMessage((message: { type?: string }) => {
      switch (message?.type) {
        case 'ready':
          void this.start();
          break;
        case 'start':
          void this.start();
          break;
        case 'stop':
          void this.stop('用户点击停止');
          break;
        case 'mirrorInput':
          void this.handleInput(message as unknown as Record<string, unknown>);
          break;
        case 'mirrorResize':
          void this.input?.refreshViewport();
          break;
        default:
          break;
      }
    });
  }

  private async start(): Promise<void> {
    if (this.cast) {
      return;
    }
    try {
      this.post({ type: 'status', text: '正在连接豆包窗口…' });
      const cfg = vscode.workspace.getConfiguration('doubao');
      const quality = Math.round(cfg.get<number>('mirror.quality') ?? 70);
      const fps = Math.max(2, Math.round(cfg.get<number>('mirror.fps') ?? 8));
      const maxWidth = Math.round(cfg.get<number>('mirror.maxWidth') ?? 1000);
      // 目标帧率换算成 everyNthFrame（豆包在画面变化时约 55~60 fps 推帧）
      const everyNth = Math.max(1, Math.round(60 / Math.max(1, fps)));
      const cast = await Screencast.start({
        quality,
        maxWidth,
        maxHeight: Math.round(maxWidth * 0.7),
        everyNthFrame: everyNth,
        onFrame: (frame) => {
          this.lastFrameAt = Date.now();
          if (this.disposed) {
            return;
          }
          this.post({
            type: 'frame',
            data: frame.data,
            width: frame.width,
            height: frame.height,
            at: frame.at,
          });
        },
        onStop: (reason) => {
          this.post({ type: 'status', text: `已停止：${reason}` });
        },
      });
      this.cast = cast;
      this.lastFrameAt = Date.now();
      this.startWatchdog();
      this.input = await DesktopInput.connect().catch((err: unknown) => {
        warn('连接输入通道失败', err instanceof Error ? err.message : String(err));
        return undefined;
      });
      this.post({ type: 'status', text: `镜像中（目标 ${fps} fps · 质量 ${quality}）` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warn('启动镜像失败', message);
      this.post({ type: 'error', message });
      this.post({
        type: 'status',
        text: '启动失败：请确认豆包已用调试端口启动、窗口没有最小化',
      });
    }
  }

  /** 投送断了（窗口最小化/重开/页面跳转）时自动重连。 */
  private startWatchdog(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog);
    }
    this.watchdog = setInterval(() => {
      if (this.disposed || !this.cast) {
        return;
      }
      if (Date.now() - this.lastFrameAt < 6000) {
        return;
      }
      this.post({ type: 'status', text: '画面停住了，正在重连…' });
      void this.reconnect();
    }, 4000);
  }

  private async reconnect(): Promise<void> {
    this.lastFrameAt = Date.now();
    const cast = this.cast;
    const input = this.input;
    this.cast = undefined;
    this.input = undefined;
    await cast?.stop('看门狗重连').catch(() => undefined);
    input?.close();
    await this.start();
  }

  /** 把镜像面板里的输入转发到豆包窗口。 */
  private async handleInput(message: Record<string, unknown>): Promise<void> {
    const input = this.input;
    if (!input) {
      return;
    }
    const kind = String(message.kind ?? '');
    const x = Number(message.x ?? 0);
    const y = Number(message.y ?? 0);
    try {
      switch (kind) {
        case 'click':
          await input.click(x, y, message.button === 'right' ? 'right' : 'left');
          break;
        case 'move':
          await input.move(x, y);
          break;
        case 'wheel':
          await input.wheel(x, y, Number(message.deltaY ?? 0), Number(message.deltaX ?? 0));
          break;
        case 'key': {
          const modifiers = modifierBits({
            ctrl: Boolean(message.ctrl),
            shift: Boolean(message.shift),
            alt: Boolean(message.alt),
            meta: Boolean(message.meta),
          });
          const type = message.eventType === 'keyUp' ? 'keyUp' : 'keyDown';
          await input.key(type, String(message.key ?? ''), String(message.code ?? ''), modifiers);
          break;
        }
        case 'text':
          await input.text(String(message.text ?? ''));
          break;
        default:
          break;
      }
    } catch (err) {
      warn('镜像输入转发失败', kind, err instanceof Error ? err.message : String(err));
    }
  }

  private async stop(reason: string): Promise<void> {
    const cast = this.cast;
    this.cast = undefined;
    this.input?.close();
    this.input = undefined;
    await cast?.stop(reason);
  }

  private post(message: Record<string, unknown>): void {
    if (this.disposed) {
      return;
    }
    void this.panel.webview.postMessage(message);
  }

  private dispose(): void {
    this.disposed = true;
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = undefined;
    }
    MirrorPanel.current = undefined;
    void this.stop('窗口关闭');
    log('镜像面板已关闭');
  }

  private getHtml(): string {
    const nonce = randomNonce();
    const webview = this.panel.webview;
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'mirror.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'mirror.js'));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>豆包镜像</title>
<link rel="stylesheet" href="${cssUri.toString()}" />
</head>
<body>
  <header class="bar">
    <span class="title">豆包镜像</span>
    <span class="status" id="status">准备中…</span>
    <span class="spacer"></span>
    <button id="btn-fit" type="button">原始大小</button>
    <button id="btn-immersive" type="button">沉浸</button>
    <button id="btn-start" type="button">重新开始</button>
    <button id="btn-stop" type="button">停止</button>
  </header>
  <main class="stage" id="stage">
    <img id="cast" alt="豆包窗口画面" />
    <div class="placeholder" id="placeholder">点「重新开始」连接豆包窗口</div>
  </main>
  <footer class="foot">
    <span id="fps">—</span>
    <span id="size">—</span>
  </footer>
  <script nonce="${nonce}" src="${jsUri.toString()}"></script>
</body>
</html>`;
  }
}

export function openMirror(context: vscode.ExtensionContext): void {
  MirrorPanel.show(context);
}
