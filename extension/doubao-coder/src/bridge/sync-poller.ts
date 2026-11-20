/**
 * 定时同步器：独立于"一问一答"的轮询，持续抓豆包当前回复的状态与分块。
 *
 * 为什么需要它：
 *  - `askDesktop` 的一次调用只覆盖一轮；轮与轮之间、以及"回答写完但命令还在跑"的空档会断流；
 *  - 这里用一个常驻 CDP 会话，每 1s 读一次页面，发现变化就推给界面。
 *
 * 只读：不点发送、不改输入框，唯一副作用是展开折叠的步骤区（否则命令与输出读不到）。
 */
import { CdpSession, DOUBAO_DEBUG_PORT, listTargets, pickChatPage } from './cdp';
import { MD_INSTALL_JS, expandStepsJs, readLastReplyJs } from './md-extractor';
import type { ReplyBlock } from './blocks';
import { log, warn } from '../log';

export interface SyncSnapshot {
  at: number;
  blocks: ReplyBlock[];
  /** 是否仍在执行（正在执行代码 / 流式中）。 */
  working: boolean;
  /** 已处理秒数，-1 表示读不到。 */
  progressSeconds: number;
  /** 豆包界面上的原始计时文案：已处理 5 分 52 秒 / 共用时 4 分 55 秒。 */
  progress: string;
  /** 本轮是否已结束（豆包把 已处理 换成 共用时）。 */
  done: boolean;
}

const SEL = {
  receiveMessage: '[data-testid="receive_message"]',
  messageText: '[data-testid="message_text_content"]',
} as const;

export interface SyncPollerOptions {
  port?: number;
  /** 轮询间隔，默认 1000ms。 */
  intervalMs?: number;
  /** 连续多少次"没变化且不在执行"后自动停止，默认 6 次。 */
  idleStopCount?: number;
  /** 最长运行时间，默认 20 分钟。 */
  maxMs?: number;
  onSnapshot?: (snap: SyncSnapshot) => void;
  onIdle?: (reason: string) => void;
}

export class SyncPoller {
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private lastKey = '';
  private idle = 0;
  private startedAt = 0;
  private session: CdpSession | undefined;
  private ticking = false;

  private constructor(private readonly options: SyncPollerOptions) {}

  public static async start(options: SyncPollerOptions = {}): Promise<SyncPoller> {
    const poller = new SyncPoller(options);
    await poller.connect();
    poller.begin();
    return poller;
  }

  private get intervalMs(): number {
    return Math.max(300, this.options.intervalMs ?? 1000);
  }

  private async connect(): Promise<void> {
    const port = this.options.port ?? DOUBAO_DEBUG_PORT;
    const targets = await listTargets(port);
    const page = await pickChatPage(targets);
    if (!page) {
      throw new Error('没有找到豆包页面（需要以调试端口启动）');
    }
    this.session = await CdpSession.connect(page.webSocketDebuggerUrl);
    await this.session.evaluate(MD_INSTALL_JS, 5000).catch(() => undefined);
    // 折叠的步骤区不点开就没有内容
    await this.session.evaluate(expandStepsJs(), 5000).catch(() => undefined);
  }

  private begin(): void {
    this.startedAt = Date.now();
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    log('定时同步已启动', `每 ${this.intervalMs}ms`);
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.ticking || !this.session) {
      return;
    }
    this.ticking = true;
    try {
      // 折叠的步骤区在 DOM 里没有内容；每轮 tick 前补一次展开（内部 2s 节流），
      // 否则长时间任务里新折叠的步骤会读不到，界面只剩正文。
      await this.session.evaluate(expandStepsJs(), 4000).catch(() => undefined);
      const snap = await this.session.evaluate<{
        blocks?: ReplyBlock[];
        executing?: boolean;
        streaming?: boolean;
        progress?: string;
        progressSeconds?: number;
        done?: boolean;
      }>(readLastReplyJs(SEL.receiveMessage, SEL.messageText), 6000);

      if (snap) {
        const blocks = Array.isArray(snap.blocks) ? snap.blocks.filter((b) => b && b.text) : [];
        const working = Boolean(snap.executing) || Boolean(snap.streaming);
        const progressSeconds = typeof snap.progressSeconds === 'number' ? snap.progressSeconds : -1;
        const progress = typeof snap.progress === 'string' ? snap.progress : '';
        const done = Boolean(snap.done);
        const key = JSON.stringify({ blocks, working, progressSeconds, progress, done });
        if (key !== this.lastKey) {
          this.lastKey = key;
          this.idle = 0;
          this.options.onSnapshot?.({ at: Date.now(), blocks, working, progressSeconds, progress, done });
        } else if (!working) {
          this.idle += 1;
          if (this.idle >= (this.options.idleStopCount ?? 6)) {
            // 收尾前再展开一次：回合结束豆包才会把完整执行过程渲染出来，
            // 直接停掉会永远漏掉后面的步骤。
            const expanded = await this.session.evaluate<number>(expandStepsJs(), 4000).catch(() => 0);
            if (expanded > 0) {
              this.idle = 0;
            } else {
              this.stop('空闲自动停止');
              this.options.onIdle?.('空闲自动停止');
            }
          }
        }
      }
      if (Date.now() - this.startedAt > (this.options.maxMs ?? 20 * 60_000)) {
        this.stop('超时自动停止');
        this.options.onIdle?.('超时自动停止');
      }
    } catch (err) {
      warn('定时同步读取失败', err instanceof Error ? err.message : String(err));
    } finally {
      this.ticking = false;
    }
  }

  public stop(reason = '主动停止'): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.session?.close();
    this.session = undefined;
    log('定时同步已停止', reason);
  }
}
