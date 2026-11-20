/**
 * M1：把豆包窗口的画面推出来（截屏投送）。
 *
 * 用的是 CDP 的 `Page.startScreencast`：由 Chromium 在画面变化时主动推 JPEG 帧，
 * 比 `Page.captureScreenshot` 轮询省得多（实测 47 fps、66 KB/帧；降到 8~12 fps 足够看）。
 *
 * 只做「显示」：本文件不转发任何输入，交互留到 M2。
 */
import { CdpSession, DOUBAO_DEBUG_PORT, listTargets, pickChatPage } from './cdp';
import { log, warn } from '../log';

export interface CastFrame {
  /** base64（不含 data: 前缀）。 */
  data: string;
  /** 画面尺寸（CSS 像素）。 */
  width: number;
  height: number;
  /** 豆包页面报告的设备像素比。 */
  scale: number;
  at: number;
}

export interface CastOptions {
  port?: number;
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
  /** 每 N 帧取 1 帧（越大越省 CPU/带宽）。 */
  everyNthFrame?: number;
  onFrame?: (frame: CastFrame) => void;
  onStop?: (reason: string) => void;
}

export class Screencast {
  private stopped = false;
  private pump: Promise<void> | undefined;
  private frameCount = 0;
  private lastFrameAt = 0;

  private constructor(
    private readonly session: CdpSession,
    private readonly options: CastOptions,
  ) {}

  /** 开始投送。调用方负责 `stop()`。 */
  public static async start(options: CastOptions = {}): Promise<Screencast> {
    const port = options.port ?? DOUBAO_DEBUG_PORT;
    const targets = await listTargets(port);
    const page = await pickChatPage(targets);
    if (!page) {
      throw new Error('没有找到豆包聊天气泡页面（需要以调试端口启动豆包）');
    }
    const session = await CdpSession.connect(page.webSocketDebuggerUrl);
    const cast = new Screencast(session, options);
    await session.send('Page.enable', {}, 5000);
    // 让窗口到前台：最小化时 Chromium 不出帧
    await session.send('Page.bringToFront', {}, 3000).catch(() => undefined);
    await session.send(
      'Page.startScreencast',
      {
        format: 'jpeg',
        quality: Math.max(20, Math.min(95, options.quality ?? 70)),
        maxWidth: options.maxWidth ?? 1000,
        maxHeight: options.maxHeight ?? 700,
        everyNthFrame: Math.max(1, options.everyNthFrame ?? 3),
      },
      5000,
    );
    log('镜像投送已启动', `quality=${options.quality ?? 70}`, `everyNth=${options.everyNthFrame ?? 3}`);
    cast.startPump();
    return cast;
  }

  /** 已推送帧数（用于判断是否真的收到画面）。 */
  public get frames(): number {
    return this.frameCount;
  }

  public get lastAt(): number {
    return this.lastFrameAt;
  }

  private startPump(): void {
    this.pump = (async () => {
      while (!this.stopped) {
        const events = await this.session.takeEvents(120).catch(() => []);
        for (const event of events) {
          if (event.method === 'Page.screencastFrame') {
            const params = event.params as {
              data?: string;
              sessionId?: number;
              metadata?: { deviceWidth?: number; deviceHeight?: number; pageScaleFactor?: number };
            };
            const data = params?.data;
            if (!data) {
              continue;
            }
            this.frameCount += 1;
            this.lastFrameAt = Date.now();
            this.options.onFrame?.({
              data,
              width: params.metadata?.deviceWidth ?? 0,
              height: params.metadata?.deviceHeight ?? 0,
              scale: params.metadata?.pageScaleFactor ?? 1,
              at: this.lastFrameAt,
            });
            // 必须 ack，否则 Chromium 不再推下一帧
            if (typeof params.sessionId === 'number') {
              await this.session.send('Page.screencastFrameAck', { sessionId: params.sessionId }, 2000).catch(() => undefined);
            }
          }
        }
      }
    })();
  }

  public async stop(reason = '主动停止'): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    try {
      await this.session.send('Page.stopScreencast', {}, 2000);
    } catch (err) {
      warn('停止投送失败', err instanceof Error ? err.message : String(err));
    }
    await this.pump?.catch(() => undefined);
    this.session.close();
    log('镜像投送已停止', reason, `共 ${this.frameCount} 帧`);
    this.options.onStop?.(reason);
  }
}
