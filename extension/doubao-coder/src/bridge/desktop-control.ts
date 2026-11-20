/**
 * 桌面端「模式 / 模型 / 推理强度」控制。
 *
 * 豆包桌面端的这些选择是 Radix 菜单，element.click() 不一定触发；
 * 这里用 CDP Input 鼠标事件点真实坐标，和用户手点等价。
 * 只通过 127.0.0.1 的调试端口操作，不读取任何凭据。
 */
import { CdpSession, DOUBAO_DEBUG_PORT, listTargets, pickChatPage } from './cdp';

export interface DesktopModeInfo {
  buttonText: string;
  isLocal: boolean;
  isChat: boolean;
}

export interface DesktopModeSwitchResult {
  ok: boolean;
  before: string;
  after: string;
  changed: boolean;
  error?: string;
}

export interface DesktopModelInfo {
  currentModel: string;
  reasoning: string;
  models?: string[];
}

export interface DesktopModelSwitchResult {
  ok: boolean;
  currentModel: string;
  reasoning: string;
  error?: string;
}

const MODE_BUTTON = '[data-testid="chat_input_action_mode"]';
const MODEL_BUTTON = '[data-testid="chat_input_action_model"]';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureChatComposer(session: CdpSession): Promise<boolean> {
  const readyExpr = "Boolean(document.querySelector('[data-testid=chat_input_input]') && document.querySelector('[data-testid=chat_input_action_mode]') && document.querySelector('[data-testid=chat_input_action_model]'))";
  if (await session.evaluate<boolean>(readyExpr)) {
    return true;
  }
  try {
    await session.send('Page.bringToFront', {}, 3000);
  } catch {
    /* ignore */
  }
  await session
    .evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); true")
    .catch(() => undefined);
  const waitReady = async (): Promise<boolean> => {
    const started = Date.now();
    while (Date.now() - started < 5000) {
      if (await session.evaluate<boolean>(readyExpr)) {
        return true;
      }
      await sleep(200);
    }
    return false;
  };
  const conversation = await session.evaluate<{ x: number; y: number } | undefined>(
    "(() => { const els = [...document.querySelectorAll('[data-testid=conversation-list-v2-item]')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }); const el = els[0]; if (!el) return undefined; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()",
  );
  if (conversation) {
    await clickPoint(session, conversation);
    if (await waitReady()) {
      return true;
    }
  }
  const point = await session.evaluate<{ x: number; y: number } | undefined>("(() => { const el = document.querySelector('[data-testid=create_conversation_button]'); if (!el) return undefined; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()");
  if (!point) {
    return false;
  }
  await clickPoint(session, point);
  return waitReady();
}

function isTargetGone(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /navigated or closed|Target closed|CDP 连接已关闭|WebSocket|socket hang up/i.test(message);
}

async function withPage<T>(port: number, fn: (session: CdpSession) => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const targets = await listTargets(port);
    const page = await pickChatPage(targets);
    if (!page) {
      throw new Error('没有找到豆包页面，请确认豆包已用调试端口启动。');
    }
    const session = await CdpSession.connect(page.webSocketDebuggerUrl);
    try {
      await ensureChatComposer(session);
      return await fn(session);
    } catch (error) {
      lastError = error;
      if (!isTargetGone(error) || attempt === 2) {
        throw error;
      }
      await sleep(700);
    } finally {
      session.close();
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function clickPoint(session: CdpSession, point: { x: number; y: number }): Promise<void> {
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

async function pressEscape(session: CdpSession): Promise<void> {
  for (const type of ['rawKeyDown', 'keyUp'] as const) {
    await session.send('Input.dispatchKeyEvent', {
      type,
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    });
  }
}

async function buttonInfo(session: CdpSession, selector: string): Promise<{ text: string; point: { x: number; y: number } } | undefined> {
  const selectorLiteral = JSON.stringify(selector);
  const script = "(() => { const els = [...document.querySelectorAll(" + selectorLiteral + ")]; let fallback; for (const el of els) { const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue; const x = r.x + r.width / 2; const y = r.y + r.height / 2; const top = document.elementFromPoint(x, y); const info = { text: (el.innerText || '').trim(), point: { x: x, y: y } }; if (!fallback) fallback = info; if (top && (top === el || el.contains(top))) return info; } return fallback; })()";
  return session.evaluate(script);
}

function menuItemsScript(last: boolean): string {
  return "(() => { const menus = [...document.querySelectorAll('[role=\"menu\"]')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }); const menu = menus[" + (last ? 'menus.length - 1' : '0') + "]; if (!menu) return []; return [...menu.querySelectorAll('[role=\"menuitem\"],[role=\"menuitemradio\"]')].map((el) => { const r = el.getBoundingClientRect(); return { text: (el.innerText || '').replace(/\\s+/g, ' ').trim(), x: r.x + r.width / 2, y: r.y + r.height / 2 }; }).filter((item) => item.text.length > 0 && item.x > 0 && item.y > 0); })()";
}

async function firstMenuItems(session: CdpSession): Promise<Array<{ text: string; x: number; y: number }>> {
  return session.evaluate(menuItemsScript(false));
}

async function lastMenuItems(session: CdpSession): Promise<Array<{ text: string; x: number; y: number }>> {
  return session.evaluate(menuItemsScript(true));
}

function parseModelButton(text: string): DesktopModelInfo {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const reasoning = lines.find((line) => line === '低' || line === '中' || line === '高' || line === '极高') ?? '';
  const currentModel = lines.find((line) => line !== reasoning) ?? '';
  return { currentModel, reasoning };
}

function stripModelSuffix(text: string): string {
  return text
    .replace(/\s+(限时优惠|新上线|小额免费).*$/, '')
    .replace(/\s+\d+(?:\.\d+)?x$/, '')
    .trim();
}

/** 读取当前桌面端模式（只读，不打开菜单）。 */
export async function getDesktopMode(port = DOUBAO_DEBUG_PORT): Promise<DesktopModeInfo> {
  return withPage(port, async (session) => {
    const info = await buttonInfo(session, MODE_BUTTON);
    const text = info?.text ?? '';
    return { buttonText: text, isLocal: text.includes('本地电脑'), isChat: text === '对话' };
  });
}

/** 切换桌面端模式：工作任务·本地电脑 / 对话。 */
export async function setDesktopMode(port: number, target: 'local' | 'chat'): Promise<DesktopModeSwitchResult> {
  return withPage(port, async (session) => {
    const beforeInfo = await buttonInfo(session, MODE_BUTTON);
    const before = beforeInfo?.text ?? '';
    if (!beforeInfo) {
      return { ok: false, before, after: before, changed: false, error: '没有找到模式按钮' };
    }
    if (target === 'local' && before.includes('本地电脑')) {
      return { ok: true, before, after: before, changed: false };
    }
    if (target === 'chat' && before === '对话') {
      return { ok: true, before, after: before, changed: false };
    }
    await pressEscape(session);
    await sleep(150);
    await clickPoint(session, beforeInfo.point);
    await sleep(500);
    const items = await firstMenuItems(session);
    const item = target === 'local'
      ? items.find((candidate) => candidate.text.includes('本地电脑'))
      : items.find((candidate) => candidate.text === '对话');
    if (!item) {
      await pressEscape(session);
      return {
        ok: false,
        before,
        after: before,
        changed: false,
        error: target === 'local' ? '桌面端模式菜单里没有找到「本地电脑」' : '桌面端模式菜单里没有找到「对话」',
      };
    }
    await clickPoint(session, item);
    await sleep(600);
    const afterInfo = await buttonInfo(session, MODE_BUTTON);
    const after = afterInfo?.text ?? '';
    const ok = target === 'local' ? after.includes('本地电脑') : after === '对话';
    return { ok, before, after, changed: true, error: ok ? undefined : '切换后模式按钮仍是「' + (after || '未知') + '」' };
  });
}

/** 读取桌面端当前模型与推理强度（只读，不打开菜单）。 */
export async function getDesktopModel(port = DOUBAO_DEBUG_PORT): Promise<DesktopModelInfo> {
  return withPage(port, async (session) => {
    const info = await buttonInfo(session, MODEL_BUTTON);
    return parseModelButton(info?.text ?? '');
  });
}

/** 打开模型菜单，列出可选模型（会短暂打开菜单，不选任何项）。 */
export async function listDesktopModels(port = DOUBAO_DEBUG_PORT): Promise<DesktopModelInfo> {
  return withPage(port, async (session) => {
    const currentInfo = await buttonInfo(session, MODEL_BUTTON);
    const current = parseModelButton(currentInfo?.text ?? '');
    if (!currentInfo) {
      return current;
    }
    await pressEscape(session);
    await sleep(150);
    await clickPoint(session, currentInfo.point);
    await sleep(500);
    const items = await firstMenuItems(session);
    await pressEscape(session);
    const models: string[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      if (item.text.includes('更多模型') || item.text.startsWith('推理强度')) {
        continue;
      }
      const name = stripModelSuffix(item.text);
      if (!name || seen.has(name) || !/^(自动|豆包|DeepSeek|Qwen|Kimi|GLM|快速|专家|极速)/i.test(name)) {
        continue;
      }
      seen.add(name);
      models.push(name);
    }
    return { ...current, models };
  });
}

/** 选择桌面端模型。 */
export async function selectDesktopModel(port: number, model: string): Promise<DesktopModelSwitchResult> {
  return withPage(port, async (session) => {
    const beforeInfo = await buttonInfo(session, MODEL_BUTTON);
    const before = parseModelButton(beforeInfo?.text ?? '');
    if (!beforeInfo) {
      return { ...before, ok: false, error: '没有找到模型按钮' };
    }
    if (before.currentModel === model) {
      return { ...before, ok: true };
    }
    await pressEscape(session);
    await sleep(150);
    await clickPoint(session, beforeInfo.point);
    await sleep(500);
    const items = await firstMenuItems(session);
    const item = items.find((candidate) => stripModelSuffix(candidate.text) === model);
    if (!item) {
      await pressEscape(session);
      return { ...before, ok: false, error: '桌面端模型列表里没有「' + model + '」' };
    }
    await clickPoint(session, item);
    await sleep(600);
    const afterInfo = await buttonInfo(session, MODEL_BUTTON);
    const after = parseModelButton(afterInfo?.text ?? '');
    const ok = after.currentModel === model || after.currentModel.startsWith(model);
    return { ...after, ok, error: ok ? undefined : '选择后模型按钮仍是「' + (after.currentModel || '未知') + '」' };
  });
}

/** 设置桌面端推理强度（低/中/高/极高）。 */
export async function setDesktopReasoning(port: number, level: '低' | '中' | '高' | '极高'): Promise<DesktopModelSwitchResult> {
  return withPage(port, async (session) => {
    const beforeInfo = await buttonInfo(session, MODEL_BUTTON);
    const before = parseModelButton(beforeInfo?.text ?? '');
    if (!beforeInfo) {
      return { ...before, ok: false, error: '没有找到模型按钮' };
    }
    await pressEscape(session);
    await sleep(150);
    await clickPoint(session, beforeInfo.point);
    await sleep(500);
    const items = await firstMenuItems(session);
    const reasoningItem = items.find((candidate) => candidate.text.startsWith('推理强度'));
    if (!reasoningItem) {
      await pressEscape(session);
      return { ...before, ok: false, error: '模型菜单里没有「推理强度」' };
    }
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: reasoningItem.x, y: reasoningItem.y });
    await sleep(600);
    const submenu = await lastMenuItems(session);
    const levelItem = submenu.find((candidate) => candidate.text === level);
    if (!levelItem) {
      await pressEscape(session);
      const available = submenu.map((candidate) => candidate.text).filter((text) => /^(低|中|高|极高)$/.test(text));
      return { ...before, ok: false, error: '推理强度子菜单里没有「' + level + '」' + (available.length ? '（可用：' + available.join('/') + '）' : '') };
    }
    await clickPoint(session, levelItem);
    await sleep(500);
    const afterInfo = await buttonInfo(session, MODEL_BUTTON);
    const after = parseModelButton(afterInfo?.text ?? '');
    const ok = after.reasoning === level;
    return { ...after, ok, error: ok ? undefined : '设置后推理强度仍是「' + (after.reasoning || '未知') + '」' };
  });
}

/** 在桌面端新建一个空对话（先点「新对话」，必要时用 Ctrl+Shift+K 兜底）。 */
export async function createDesktopConversation(
  port = DOUBAO_DEBUG_PORT,
): Promise<{ ok: boolean; error?: string }> {
  return withPage(port, async (session) => {
    try {
      await session.send('Page.bringToFront', {}, 3000);
    } catch {
      /* ignore */
    }
    const count = async (): Promise<number> =>
      session.evaluate<number>("document.querySelectorAll('[data-testid=union_message]').length");
    const beforeUrl = await session.evaluate<string>('location.href').catch(() => '');
    if ((await count()) === 0) {
      return { ok: true };
    }
    const info = await buttonInfo(session, '[data-testid="create_conversation_button"]');
    if (info) {
      await clickPoint(session, info.point);
      await sleep(900);
    }
    if ((await count()) === 0) {
      return { ok: true };
    }
    // 豆包可能把新对话开在一个新标签页里（页面上就多出一个 tab）。
    // 这时当前页的 union_message 不会清零，要去看前台标签页是不是已经换成了空对话。
    try {
      const targets = await listTargets(port);
      const page = await pickChatPage(targets);
      if (page) {
        const other = await CdpSession.connect(page.webSocketDebuggerUrl);
        try {
          const href = await other.evaluate<string>('location.href').catch(() => '');
          if (href && href !== beforeUrl) {
            const remaining = await other.evaluate<number>(
              "document.querySelectorAll('[data-testid=union_message]').length",
            );
            if (remaining === 0) {
              return { ok: true };
            }
          }
        } finally {
          other.close();
        }
      }
    } catch {
      /* 读不到新标签页就继续走 Ctrl+Shift+K 兜底 */
    }
    for (const type of ['rawKeyDown', 'keyUp'] as const) {
      await session.send('Input.dispatchKeyEvent', {
        type,
        key: 'K',
        code: 'KeyK',
        windowsVirtualKeyCode: 75,
        nativeVirtualKeyCode: 75,
        modifiers: 10,
      });
    }
    await sleep(900);
    const after = await count();
    return after === 0 ? { ok: true } : { ok: false, error: '桌面端没有切换到空对话' };
  });
}
