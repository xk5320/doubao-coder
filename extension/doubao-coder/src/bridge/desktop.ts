/**
 * 「豆包桌面端登录态」直连通道。
 *
 * 原理：豆包桌面端就是 Chromium，用 `--remote-debugging-port` 启动后可以走 CDP（DevTools 协议）
 * 操作它已经登录好的页面。登录态、请求签名、风控全部由官方客户端自己完成，
 * 扩展只负责「把问题写进输入框 → 点发送 → 把回复读回来」。
 *
 * 这等价于「和桌面版一样登录」，不需要 Ark API Key；代价是必须让豆包以调试端口启动，
 * 且依赖页面结构（data-testid 是豆包前端自带的稳定测试钩子，见 docs/04）。
 */
import { CdpSession, DOUBAO_DEBUG_PORT, getVersion, listTargets, pickChatPage, type CdpTarget } from './cdp';
import { MD_INSTALL_JS, expandStepsJs, readLastReplyJs } from './md-extractor';
import type { ReplyBlock } from './blocks';
import { stallDecision } from './activity';
import * as net from 'node:net';
import { log, warn } from '../log';

/* ------------------------------- 页面选择器 ------------------------------- */
/* 全部来自对真实页面的实测（docs/04-桌面端登录态直连.md 记录了取证过程） */
const SEL = {
  inputRoot: '[data-testid="chat_input_input"]',
  editor: '[data-testid="chat_input_input"] [contenteditable="true"]',
  sendButton: '[data-testid="chat_input_send_button"]',
  receiveMessage: '[data-testid="receive_message"]',
  messageText: '[data-testid="message_text_content"]',
  messageList: '[data-testid="message-list"]',
  newChatButton: '[data-testid="create_conversation_button"]',
} as const;

const POLL_INTERVAL_MS = 200;

export interface DesktopStatus {
  ok: boolean;
  port: number;
  browser?: string;
  pageUrl?: string;
  pageTitle?: string;
  loggedIn?: boolean;
  hasEditor?: boolean;
  error?: string;
  targets?: Array<{ type: string; url: string; title: string }>;
}

export interface DesktopImage {
  /** 适合聊天里展示的缩略图 URL（桌面端 CDN，带签名）。 */
  url: string;
  /** 原图 URL（可选，点击图片时打开）。 */
  fullUrl?: string;
  alt?: string;
}

export interface DesktopAskOptions {
  port?: number;
  /** 每次提问前点「新对话」，默认沿用当前会话 */
  newChat?: boolean;
  /** 最长等待时间（毫秒） */
  timeoutMs?: number;
  onDelta: (text: string) => void;
  /** 豆包界面上的分块（正文 / 执行反馈 / 计时），用于 1:1 还原过程。 */
  onBlock?: (block: ReplyBlock) => void;
  /** 整体下发当前这条回复的分块（文本会随流式增长，界面用整体替换最稳）。 */
  onBlocks?: (blocks: ReplyBlock[]) => void;
  onQuestion?: (question: AskQuestion) => void;
  /** 回复里出现新图片时回调（用于 VS Code 面板显示生成图）。 */
  onImage?: (image: DesktopImage) => void;
  /** 生成类任务（图片/视频/PPT）的等待状态，空字符串表示结束。 */
  onStatus?: (text: string) => void;
  /** 豆包界面上的同步状态（已处理 5 分 52 秒 / 共用时 4 分 55 秒），原样透传。 */
  onProgress?: (state: { text: string; seconds: number; done: boolean }) => void;
  signal: AbortSignal;
}

export interface DesktopAskResult {
  text: string;
  aborted: boolean;
  timedOut: boolean;
  messageCount: number;
  images: DesktopImage[];
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** 探测本机豆包是否以调试端口在运行，并报告页面状态。 */
/** 端口是否可连接（用于区分“未启动”和“被占用”）。 */
export function isPortOpen(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (value: boolean) => {
      if (done) {
        return;
      }
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, '127.0.0.1');
  });
}

export async function probeDesktop(port = DOUBAO_DEBUG_PORT): Promise<DesktopStatus> {
  let browser: string | undefined;
  try {
    const version = await getVersion(port);
    browser = version.Browser;
  } catch (err) {
    return {
      ok: false,
      port,
      error:
        `连接 127.0.0.1:${port} 失败：${err instanceof Error ? err.message : String(err)}\n` +
        '请完全退出豆包，然后执行命令「豆包: 以调试端口启动桌面端」。',
    };
  }

  let targets: CdpTarget[] = [];
  try {
    const listed = await listTargets(port);
    if (!Array.isArray(listed)) {
      return {
        ok: false,
        port,
        browser,
        error: `端口 ${port} 返回的不是 CDP 页面列表：可能被其他本地服务占用，或豆包没有以调试端口启动。`,
      };
    }
    targets = listed;
  } catch (err) {
    return { ok: false, port, browser, error: `读取页面列表失败：${err instanceof Error ? err.message : String(err)}` };
  }

  const page = await pickChatPage(targets);
  const listed = targets.map((t) => ({ type: t.type, url: t.url, title: t.title }));
  if (!page) {
    return { ok: false, port, browser, error: '没有可用的页面目标（豆包可能还没把窗口创建出来）', targets: listed };
  }

  let session: CdpSession | undefined;
  try {
    session = await CdpSession.connect(page.webSocketDebuggerUrl);
    const info = await session.evaluate<{ hasEditor: boolean; loggedIn: boolean }>(`
      (() => {
        const editor = document.querySelector(${JSON.stringify(SEL.editor)});
        const root = document.querySelector(${JSON.stringify(SEL.inputRoot)});
        const list = document.querySelector(${JSON.stringify(SEL.messageList)});
        const loginText = /登录|扫码登录|手机号登录/.test(document.body.innerText || '');
        return { hasEditor: Boolean(editor || root), loggedIn: Boolean(list) || (!loginText && Boolean(root)) };
      })()
    `);
    return {
      ok: info.hasEditor,
      port,
      browser,
      pageUrl: page.url,
      pageTitle: page.title,
      loggedIn: info.loggedIn,
      hasEditor: info.hasEditor,
      targets: listed,
      error: info.hasEditor ? undefined : '页面里没有找到输入框：可能停在了登录页或首页引导，请先在豆包窗口里进入对话页。',
    };
  } catch (err) {
    return {
      ok: false,
      port,
      browser,
      pageUrl: page.url,
      error: `页面脚本执行失败：${err instanceof Error ? err.message : String(err)}`,
      targets: listed,
    };
  } finally {
    session?.close();
  }
}

/**
 * 通过已登录的豆包窗口提问，并把流式回复回调出去。
 * 注意：这是「驱动官方客户端」，所以调用会体现在用户的豆包会话记录里。
 */
export interface AskQuestion {
  title: string;
  options: Array<{ value: string; label: string }>;
  allowCustom?: boolean;
}

export async function askDesktop(prompt: string, options: DesktopAskOptions): Promise<DesktopAskResult> {
  const port = options.port ?? DOUBAO_DEBUG_PORT;
  const timeoutMs = options.timeoutMs ?? 180_000;
  const { onDelta, signal } = options;

  const targets = await listTargets(port);
  const page = await pickChatPage(targets);
  if (!page) {
    throw new Error('没有找到豆包页面，请确认豆包已用调试端口启动（命令「豆包: 以调试端口启动桌面端」）。');
  }
  log('桌面端通道：连接页面', page.url);

  const session = await CdpSession.connect(page.webSocketDebuggerUrl);
  // 多标签页时把目标页切到前台：否则消息发在后台标签页里，界面上看起来“没切到对话框”。
  await session.send('Page.bringToFront', {}, 3000).catch(() => undefined);
  let lastProgressSeconds = -1;
  /** 已推送过的分块数（豆包这条回复是追加式的）。 */
  /** 上一次下发的分块快照（避免每 200ms 重复推送）。 */
  let lastBlocksSerialized = '';
  let lastProgressText = '';
  let executingPolls = 0;
  const desktopBusyNow = () => executingPolls > 0;
  try {
    // 1) 等编辑器就绪（页面可能还在渲染）
    let ready = false;
    for (let i = 0; i < 50; i += 1) {
      ready = await session.evaluate<boolean>(
        `Boolean(document.querySelector(${JSON.stringify(SEL.editor)}))`,
        5000,
      );
      if (ready) {
        break;
      }
      await sleep(200, signal);
      if (signal.aborted) {
        return { text: '', aborted: true, timedOut: false, messageCount: 0, images: [] };
      }
    }
    if (!ready) {
      throw new Error(
        '豆包页面里没有找到输入框。请先在豆包窗口里打开「对话」页并确认已登录，然后重试。',
      );
    }

    // 2) 可选：新开一个对话（点击可能只是建草稿，所以要用键盘快捷键兜底并校验）
    if (options.newChat) {
      const fresh = await ensureFreshChat(session);
      log('桌面端通道：新开会话', fresh ? '成功' : '未能确认（可能仍停留在原会话）');
    }

    // 2.5) 当前页面没有任何消息时，先确保有一个对话（否则发出去也看不到气泡）
    const hasConversation = await session.evaluate<boolean>(
      `Boolean(document.querySelector('[data-testid="message-list"]')) || document.querySelectorAll('[data-testid="union_message"]').length > 0`,
      5000,
    ).catch(() => true);
    if (!hasConversation) {
      const fresh = await ensureFreshChat(session).catch(() => false);
      log('桌面端通道：页面是空的，先建对话', fresh ? '成功' : '未能确认');
      await sleep(600, signal);
    }

    // 3) 清空并聚焦编辑器
    const cleared = await session.evaluate<string>(`
      (() => {
        const ed = document.querySelector(${JSON.stringify(SEL.editor)});
        if (!ed) return 'no-editor';
        ed.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(ed);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('delete');
        return 'ok';
      })()
    `);
    if (cleared !== 'ok') {
      throw new Error(`清空输入框失败：${cleared}`);
    }

    // 4) 写入提示词（Input.insertText 对 ProseMirror 最稳）
    await session.send('Input.insertText', { text: prompt });
    const typed = await session.evaluate<number>(
      `(() => { const ed = document.querySelector(${JSON.stringify(SEL.editor)}); return ed ? (ed.innerText || '').length : -1; })()`,
    );
    if (typed <= 0) {
      throw new Error('输入框没有接收到内容，可能是页面版本变化导致编辑器选择器失效。');
    }
    log('桌面端通道：已写入提示词', `${typed} 字符`);

    // 5) 安装 Markdown 还原器，记录基线
    //    注意：豆包消息列表是虚拟滚动的，不能靠「消息条数」判断，
    //    必须用「最后一条助手消息的文本 + data-streaming 标记」来跟踪。
    await session.evaluate<boolean>(MD_INSTALL_JS);
    await session.evaluate<number>(expandStepsJs()).catch(() => undefined);
    const readReply = readLastReplyJs(SEL.receiveMessage, SEL.messageText);
    const baseline = await session.evaluate<{ count: number; text: string; streaming: boolean; images?: DesktopImage[] }>(readReply);
    const baselineImages = new Set((baseline.images ?? []).map((image) => image.url));
    const newImages = new Map<string, DesktopImage>();
    log('桌面端通道：基线消息', `${baseline.text.length} 字符`, `streaming=${baseline.streaming}`);

    // 让窗口到前台：后台窗口会被 Chromium 节流，导致流式渲染变慢甚至停滞
    try {
      await session.send('Page.bringToFront', {}, 3000);
    } catch {
      /* 非致命 */
    }

    const clicked = await session.evaluate<boolean>(`
      (() => {
        const btn = document.querySelector(${JSON.stringify(SEL.sendButton)});
        if (!btn) return false;
        btn.click();
        return true;
      })()
    `);
    const pressEnter = async (): Promise<void> => {
      for (const type of ['rawKeyDown', 'keyUp'] as const) {
        await session.send('Input.dispatchKeyEvent', {
          type,
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
        });
      }
    };
    if (!clicked) {
      await pressEnter();
    }

    // 5.5) 校验「消息真的发出去了」：等用户气泡出现（最多 3 次尝试）
    const probe = `(() => {
      const list = [...document.querySelectorAll('[data-testid="union_message"]')];
      const sends = list.filter((n) => n.querySelector('[data-testid="send_message"]'));
      const last = sends[sends.length - 1];
      const text = last ? (last.innerText || '') : '';
      return JSON.stringify({ count: sends.length, text: text.slice(0, 120) });
    })()`;
    const hook = prompt.slice(0, 12);
    let sent = false;
    for (let attempt = 0; attempt < 3 && !sent; attempt += 1) {
      for (let i = 0; i < 25; i += 1) {
        const raw = await session.evaluate<string>(probe, 4000).catch(() => '{}');
        try {
          const parsed = JSON.parse(raw || '{}') as { count?: number; text?: string };
          if ((parsed.count ?? 0) > 0 && String(parsed.text || '').includes(hook)) {
            sent = true;
            break;
          }
        } catch {
          /* 忽略解析失败 */
        }
        await sleep(240, signal);
      }
      if (!sent) {
        log('桌面端通道：消息似乎没发出去，重试提交', `第 ${attempt + 1} 次`);
        // 重新聚焦输入框并回车（有时按钮处于禁用态，回车更可靠）
        await session.evaluate(`(() => {
          const ed = document.querySelector(${JSON.stringify(SEL.editor)});
          if (ed) { ed.focus(); }
          return true;
        })()`);
        await pressEnter();
      }
    }
    if (!sent) {
      throw new Error('消息没有发出去：豆包窗口里的发送按钮/回车都没生效（窗口可能被最小化，或停在登录/首页）。请把豆包窗口还原到前台后重试。');
    }
    log('桌面端通道：已提交', clicked ? '(点击发送按钮)' : '(回车兜底)');

    // 6) 轮询最后一条助手消息，流式 diff
    let lastText = '';
    let lastChange = Date.now();
  /** 连续「没动静」的自动重试次数；有活动就归零。 */
  let stallRetries = 0;
  let lastSnapBusy = false;
  let lastSnapExecuting = false;
    const started = Date.now();
    let messageCount = 0;
    let sawReply = false;
    let lastStatus = '';
    let confirmedGeneration = false;
    let lastConfirmTry = 0;

    while (Date.now() - started < timeoutMs) {
      if (signal.aborted) {
        const stopped = await tryStop(session);
        options.onStatus?.(stopped ? '已在豆包侧停止' : '已中止（豆包可能仍在执行）');
        return { text: lastText, aborted: true, timedOut: false, messageCount, images: [...newImages.values()] };
      }
      const snap = await session.evaluate<{ count: number; text: string; streaming: boolean; images?: DesktopImage[]; generating?: string; confirming?: boolean; busy?: boolean; progress?: string; progressSeconds?: number; executing?: boolean; done?: boolean; blocks?: ReplyBlock[]; question?: AskQuestion }>(readReply);
    lastSnapBusy = Boolean(snap.busy);
    lastSnapExecuting = Boolean(snap.executing);
    if (Date.now() - lastChange < 30_000) {
      stallRetries = 0;
    }
      if (snap.question && snap.question.options && snap.question.options.length) {
      options.onQuestion?.(snap.question);
    }
    messageCount = snap.count;
      const generating = snap.generating || (/正在生成(图片|图像|视频)|图片生成中|正在绘制|PPT.*生成中/.test(snap.text)
        ? /视频/.test(snap.text) ? '正在生成视频…' : /PPT/i.test(snap.text) ? '正在生成 PPT…' : '正在生成图片…'
        : '');
      const statusText = generating;
      if (statusText && statusText !== lastStatus) {
        lastStatus = statusText;
        options.onStatus?.(statusText);
      } else if (!statusText && lastStatus && (!confirmedGeneration || newImages.size > 0)) {
        lastStatus = '';
        options.onStatus?.('');
      }
      // 生图前需要点「确认生成任务」，扩展自动确认，否则桌面端会一直停住。
      const needsConfirm = !confirmedGeneration && (snap.confirming || /确认生成任务|确认生成/.test(snap.text));
      if (needsConfirm && Date.now() - lastConfirmTry > 2500) {
        lastConfirmTry = Date.now();
        const clicked = await clickGenerationConfirm(session);
        if (clicked) {
          confirmedGeneration = true;
          lastChange = Date.now();
          lastStatus = '已确认，正在生成图片…';
          options.onStatus?.(lastStatus);
        } else {
          lastStatus = '等待确认生成任务…';
          options.onStatus?.(lastStatus);
        }
      }
      // 同步桌面端「已处理 5 分 52 秒」等中间状态，文案与豆包界面完全一致。
      const progressText = !generating && !needsConfirm ? snap.progress || '' : '';
      if (progressText && progressText !== lastProgressText) {
        lastProgressText = progressText;
        options.onProgress?.({
          text: progressText,
          seconds: typeof snap.progressSeconds === 'number' ? snap.progressSeconds : -1,
          done: Boolean(snap.done),
        });
      }
      let newImageSeen = false;
      for (const image of snap.images ?? []) {
        if (!image || !image.url || newImages.has(image.url) || baselineImages.has(image.url)) {
          continue;
        }
        newImages.set(image.url, image);
        newImageSeen = true;
        options.onImage?.(image);
      }

      // 把豆包的分块增量推出去（正文 / 已执行代码 / 状态行），保持与它界面同序
      const blocks = snap.blocks;
      if (Array.isArray(blocks)) {
        const serialized = JSON.stringify(blocks);
        if (serialized !== lastBlocksSerialized) {
          lastBlocksSerialized = serialized;
          options.onBlocks?.(blocks.filter((b) => b && b.text));
          lastChange = Date.now();
        }
      }

      // 进度秒数在涨 / 出现「正在执行代码」→ 说明桌面端仍在跑，不能判定结束
      if (typeof snap.progressSeconds === 'number' && snap.progressSeconds > lastProgressSeconds) {
        lastProgressSeconds = snap.progressSeconds;
        lastChange = Date.now();
      }
      if (snap.executing) {
        executingPolls += 1;
        lastChange = Date.now();
        if (executingPolls === 1) {
          options.onStatus?.('正在执行命令…');
        }
      } else {
        executingPolls = 0;
      }

      // 新回复 = 文本非空且与基线不同
      if (snap.text.length > 0 && snap.text !== baseline.text) {
        sawReply = true;
        if (snap.text !== lastText) {
          const delta = diffSuffix(lastText, snap.text);
          if (delta.length > 0) {
            onDelta(delta);
          }
          lastText = snap.text;
          lastChange = Date.now();
        }
        if (newImageSeen) {
          lastChange = Date.now();
        }
        // 正在生成图片/视频、等待确认、或已确认但图片还没出现时，都不能结束。
        const pendingConfirm = !confirmedGeneration && (snap.confirming || /确认生成任务|确认生成/.test(snap.text));
        const waitingConfirmed = confirmedGeneration && newImages.size === 0 && !/已生成|画好了|生成完成|已完成/.test(snap.text);
        const stillGenerating = (Boolean(generating) || pendingConfirm || waitingConfirmed) && newImages.size === 0;
        // 桌面端停止按钮还在时，即使文本暂时静止也说明它仍在处理（工具调用/等待模型），不能结束。
        const desktopBusy = Boolean(snap.busy) || Boolean(snap.executing) || executingPolls > 0;
        if (!snap.streaming && !desktopBusy && !stillGenerating && Date.now() - lastChange > 4000) {
          break;
        }
        if (!desktopBusy && !stillGenerating && Date.now() - lastChange > 8000) {
          break;
        }
      } else if (newImageSeen) {
        // 纯图片回复（生图）没有文本，也要算作收到回复。
        sawReply = true;
        lastChange = Date.now();
        if (!snap.streaming && !desktopBusyNow() && !generating && confirmedGeneration) {
          break;
        }
      } else {
        // 用户要求：先自动重试几次（每次重新计时 90 秒），仍然没动静才提示。
        const decision = stallDecision({
          sawReply,
          idleMs: Date.now() - lastChange,
          busy: Boolean(snap.busy) || executingPolls > 0,
          executing: Boolean(snap.executing),
          retries: stallRetries,
          maxRetries: 2,
        });
        if (decision === 'retry') {
          stallRetries += 1;
          lastChange = Date.now();
          log('桌面端通道：90 秒没有动静，自动重试', `${stallRetries}/2`);
        } else if (decision === 'give-up') {
          throw new Error(
            '重试 2 次后仍没有看到豆包的任何动静（既没有正文，也没有步骤/计时更新）。请确认：豆包窗口没有被弹窗遮住、没有被要求重新登录、当前会话可以正常发言。',
          );
        }
      }
      await sleep(POLL_INTERVAL_MS, signal);
    }

    // 回合结束后豆包才把整段执行过程渲染出来（运行中展开按钮可能是 disabled）：
    // 收尾前再展开一次并重读分块，保证面板拿到完整步骤列表。
    await session.evaluate(expandStepsJs(), 4000).catch(() => undefined);
    await sleep(350);
    const finalSnap = await session
      .evaluate<{ blocks?: ReplyBlock[] }>(readReply, 6000)
      .catch(() => undefined);
    if (finalSnap && Array.isArray(finalSnap.blocks)) {
      const serializedFinal = JSON.stringify(finalSnap.blocks);
      if (serializedFinal !== lastBlocksSerialized) {
        lastBlocksSerialized = serializedFinal;
        options.onBlocks?.(finalSnap.blocks.filter((b) => b && b.text));
      }
    }

    const deadlineHit = Date.now() - started >= timeoutMs;
    // 还在执行/刚有活动：不要停豆包，也不要报错，交给后续同步继续观察。
    const stillWorking = lastSnapBusy || lastSnapExecuting || Date.now() - lastChange < 60_000;
    const timedOut = deadlineHit && !stillWorking;
    if (timedOut) {
      warn('桌面端通道：等待回复超时', `${timeoutMs}ms`);
      await tryStop(session);
    } else if (deadlineHit) {
      warn('桌面端通道：到达单轮上限但豆包仍在执行，转为持续同步', `${timeoutMs}ms`);
    }
    if (lastStatus) {
      options.onStatus?.('');
    }
    return { text: lastText, aborted: false, timedOut, messageCount, images: [...newImages.values()] };
  } finally {
    session.close();
  }
}


/** 生图前桌面端会要求点「确认生成任务」；按可见文本找到并点它。 */
async function clickGenerationConfirm(session: CdpSession): Promise<boolean> {
  const target = await session.evaluate<{ x: number; y: number } | undefined>(
    "(() => {" +
      "  const wanted = ['确认生成任务', '确认生成']; " +
      "  const nodes = [...document.querySelectorAll('button,[role=button],div,span')]; " +
      "  const hits = []; " +
      "  for (const el of nodes) {" +
      "    const text = (el.innerText || '').replace(/\\s+/g, ' ').trim(); " +
      "    if (!wanted.includes(text)) continue; " +
      "    const r = el.getBoundingClientRect(); " +
      "    if (!r.width || !r.height) continue; " +
      "    hits.push({ el: el, r: r, area: r.width * r.height, text: text }); " +
      "  } " +
      "  if (!hits.length) return undefined; " +
      "  hits.sort((a, b) => a.area - b.area); " +
      "  const r = hits[0].r; " +
      "  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; " +
      "})()",
  );
  if (!target) {
    return false;
  }
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 });
  return true;
}

/**
 * 确保当前是「空会话」（PTC 多轮会往会话里追加消息，最好在新会话里跑）。
 * 实测：只点 `create_conversation_button` 不一定会真正跳转，所以这里做三级兜底 + 结果校验。
 */
async function ensureFreshChat(session: CdpSession): Promise<boolean> {
  const countMessages = async (): Promise<number> =>
    session.evaluate<number>(`document.querySelectorAll('[data-testid="union_message"]').length`);

  if ((await countMessages()) === 0) {
    return true;
  }

  const clickNewChat = async (): Promise<void> => {
    await session.evaluate(`
      (() => {
        const btn = document.querySelector(${JSON.stringify(SEL.newChatButton)});
        if (btn) { btn.click(); return true; }
        return false;
      })()
    `);
    await sleep(900);
  };

  await clickNewChat();
  if ((await countMessages()) === 0) {
    return true;
  }

  // 兜底 1：Ctrl+Shift+K（侧栏「新对话」的快捷键）
  for (const type of ['rawKeyDown', 'keyUp'] as const) {
    await session.send('Input.dispatchKeyEvent', {
      type,
      key: 'K',
      code: 'KeyK',
      windowsVirtualKeyCode: 75,
      nativeVirtualKeyCode: 75,
      modifiers: 10, // Ctrl(2) | Shift(8)
    });
  }
  await sleep(900);
  if ((await countMessages()) === 0) {
    return true;
  }

  // 兜底 2：再点一次
  await clickNewChat();
  return (await countMessages()) === 0;
}

/** 计算新增后缀：若新文本不是以旧文本开头（页面重排/引用回填），退化为整段替换。 */function diffSuffix(previous: string, next: string): string {
  if (!previous) {
    return next;
  }
  if (next.startsWith(previous)) {
    return next.slice(previous.length);
  }
  let i = 0;
  const max = Math.min(previous.length, next.length);
  while (i < max && previous[i] === next[i]) {
    i += 1;
  }
  return next.slice(i);
}

/** 尽力点一下「停止生成」，失败也不影响主流程。 */
async function tryStop(session: CdpSession): Promise<boolean> {
  // 1) 找候选按钮（sto 选择器 + 文案），拿坐标
  const locate = `(() => {
    const cands = [
      '[data-testid="chat_input_stop_button"]',
      '[data-testid*="stop"]',
      'button[aria-label*="停止"]',
      '[aria-label*="停止"]',
      'button[class*="stop"]',
      '[class*="stopButton"]',
    ];
    for (const sel of cands) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      return { how: sel, x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }
    // 生成中「发送按钮」通常原地变成「停止」，兜底点同一个位置
    const send = document.querySelector('[data-testid="chat_input_send_button"]');
    if (send) {
      const r = send.getBoundingClientRect();
      if (r.width && r.height) {
        return { how: 'send-button-slot', x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
    }
    return null;
  })()`;

  const point = await session
    .evaluate<{ how: string; x: number; y: number } | null>(locate, 4000)
    .catch(() => null);

  if (point) {
    // 真实鼠标事件（React 的 onClick 对合成 click 有时不响应）
    await session
      .send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, buttons: 0 }, 3000)
      .catch(() => undefined);
    await session
      .send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 }, 3000)
      .catch(() => undefined);
    await session
      .send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 }, 3000)
      .catch(() => undefined);
    log('停止豆包：点了', point.how, `(${Math.round(point.x)}, ${Math.round(point.y)})`);
  } else {
    warn('停止豆包：没找到停止按钮，改发 Escape');
  }

  // 2) 兜底：Escape（豆包取消生成通常可用）
  await session
    .send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, 3000)
    .catch(() => undefined);
  await session
    .send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, 3000)
    .catch(() => undefined);

  // 3) 校验：2.5 秒后还有没有「正在执行代码」
  await new Promise((r) => setTimeout(r, 1200));
  const still = await session
    .evaluate<boolean>(
      `(document.body.innerText || '').includes('正在执行代码') || Boolean(document.querySelector('[data-testid*="stop"]'))`,
      4000,
    )
    .catch(() => false);
  if (still) {
    warn('停止豆包：点了之后仍在执行，再点一次');
    if (point) {
      await session
        .send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 }, 3000)
        .catch(() => undefined);
      await session
        .send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 }, 3000)
        .catch(() => undefined);
    }
  }
  return !still;
}

/**
 * 旁观一个「已经在跑」的任务：不发新消息，只把它的进度/分块持续读回来。
 * 用于「从历史里点开一个正在执行的任务」时恢复现场。
 */
/** 在豆包的询问卡片里选择一个选项（并尝试点提交）。 */
export async function chooseDesktopOption(value: string, port = DOUBAO_DEBUG_PORT): Promise<boolean> {
  const targets = await listTargets(port);
  const page = await pickChatPage(targets);
  if (!page) {
    return false;
  }
  const session = await CdpSession.connect(page.webSocketDebuggerUrl);
  try {
    const safe = JSON.stringify(String(value || ''));
    return await session
      .evaluate<boolean>(
        `(() => {
          const wanted = ${safe};
          const radio = document.querySelector('input[type="radio"][value="' + wanted + '"]');
          if (!radio) return false;
          const label = radio.closest('label') || radio;
          label.click();
          const section = radio.closest('section');
          if (section) {
            const btn = [...section.querySelectorAll('button')].find((b) => {
              const sig = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '') + ' ' + (b.innerText || '');
              return /发送|提交|确认|继续|submit/i.test(sig);
            });
            if (btn) btn.click();
          }
          return true;
        })()`,
        3000,
      )
      .catch(() => false);
  } finally {
    session.close();
  }
}

/** 读当前激活对话的 id（优先 URL /chat/<id>，其次 active 列表项）。 */
export async function readDesktopConversationId(port = DOUBAO_DEBUG_PORT): Promise<string> {
  const targets = await listTargets(port);
  const page = await pickChatPage(targets);
  if (!page) {
    return '';
  }
  const session = await CdpSession.connect(page.webSocketDebuggerUrl);
  try {
    return (
      (await session
        .evaluate<string>(
          "(() => { const m = location.href.match(/\\/chat\\/(\\d+)/); if (m) return m[1]; const el = document.querySelector('[data-conversation-active=\"true\"]'); return el ? (el.getAttribute('data-conversation-id') || '') : ''; })()",
          3000,
        )
        .catch(() => '')) || ''
    );
  } finally {
    session.close();
  }
}

/** 读当前激活对话的标题（豆包顶部可编辑标题）。 */
export async function readDesktopTitle(port = DOUBAO_DEBUG_PORT): Promise<string> {
  const targets = await listTargets(port);
  const page = await pickChatPage(targets);
  if (!page) {
    return '';
  }
  const session = await CdpSession.connect(page.webSocketDebuggerUrl);
  try {
    return (
      (await session
        .evaluate<string>(
          "(() => { const el = document.querySelector('[data-testid=\"editable_conversation_name\"]'); return el ? String(el.innerText || '').trim() : ''; })()",
          3000,
        )
        .catch(() => '')) || ''
    );
  } finally {
    session.close();
  }
}

export async function watchDesktop(options: {
  port?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onBlocks?: (blocks: ReplyBlock[]) => void;
  onStatus?: (text: string) => void;
  onProgress?: (state: { text: string; seconds: number; done: boolean }) => void;
  /** 期望当前打开的就是这个对话；切到别的对话就停止，避免把别的任务结果写进来。 */
  expectTitle?: string;
} = {}): Promise<{ ok: boolean; reason: string }> {
  const port = options.port ?? DOUBAO_DEBUG_PORT;
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const targets = await listTargets(port);
  const page = await pickChatPage(targets);
  if (!page) {
    return { ok: false, reason: '没有找到豆包页面' };
  }
  const session = await CdpSession.connect(page.webSocketDebuggerUrl);
  const readReply = readLastReplyJs(SEL.receiveMessage, SEL.messageText);
  let lastSerialized = '';
  let idlePolls = 0;
  const started = Date.now();
  try {
    await session.evaluate(MD_INSTALL_JS, 5000).catch(() => undefined);
    let pollIndex = 0;
    const normTitle = (value: string): string =>
      String(value || '')
        .replace(/\u3000/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const expectedTitle = normTitle(options.expectTitle || '');
    while (Date.now() - started < timeoutMs) {
      pollIndex += 1;
      if (expectedTitle && pollIndex % 4 === 1) {
        const currentTitle = await session
          .evaluate<string>(
            "(() => { const el = document.querySelector('[data-testid=\"editable_conversation_name\"]'); return el ? String(el.innerText || '').trim() : ''; })()",
            3000,
          )
          .catch(() => '');
        if (currentTitle && normTitle(currentTitle) !== expectedTitle) {
          warn('旁观中止：豆包已切到其它对话', currentTitle, '≠', expectedTitle);
          return { ok: false, reason: '对话已切换，停止旁观' };
        }
      }
      if (options.signal?.aborted) {
        return { ok: true, reason: '用户停止旁观' };
      }
      await session.evaluate(expandStepsJs(), 3000).catch(() => undefined);
      const snap = await session
        .evaluate<{
          blocks?: ReplyBlock[];
          executing?: boolean;
          progress?: string;
          progressSeconds?: number;
          streaming?: boolean;
          done?: boolean;
        }>(readReply, 6000)
        .catch(() => undefined);
      if (!snap) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      const serialized = JSON.stringify(snap.blocks ?? []);
      if (serialized !== lastSerialized) {
        lastSerialized = serialized;
        options.onBlocks?.(snap.blocks ?? []);
        idlePolls = 0;
      } else {
        idlePolls += 1;
      }
      if (snap.progress) {
        options.onProgress?.({
          text: snap.progress,
          seconds: typeof snap.progressSeconds === 'number' ? snap.progressSeconds : -1,
          done: Boolean(snap.done),
        });
      } else if (snap.executing) {
        options.onStatus?.('正在执行命令…');
      }
      const working = Boolean(snap.executing) || Boolean(snap.streaming);
      if (!working && idlePolls >= 4) {
        return { ok: true, reason: '任务已结束' };
      }
      await new Promise((r) => setTimeout(r, 800));
    }
    return { ok: true, reason: '旁观超时' };
  } finally {
    session.close();
  }
}

/** 直接问页面：现在是否还在执行（正在执行代码 / 已处理 N 秒 / 流式中）。 */
export async function isDesktopRunning(port = DOUBAO_DEBUG_PORT): Promise<boolean> {
  const targets = await listTargets(port);
  const page = await pickChatPage(targets);
  if (!page) {
    return false;
  }
  const session = await CdpSession.connect(page.webSocketDebuggerUrl);
  try {
    const readReply = readLastReplyJs(SEL.receiveMessage, SEL.messageText);
    const snap = await session
      .evaluate<{ executing?: boolean; streaming?: boolean; busy?: boolean; done?: boolean }>(readReply, 6000)
      .catch(() => undefined);
    if (!snap) {
      return false;
    }
    // 注意：不能拿 progressSeconds > 0 判断「还在跑」——已完成的回复也有「共用时 4 分 55 秒」。
    if (snap.done) {
      return false;
    }
    return Boolean(snap.executing) || Boolean(snap.streaming) || Boolean(snap.busy);
  } finally {
    session.close();
  }
}
