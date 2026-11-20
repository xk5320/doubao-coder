/**
 * 读豆包桌面端的「对话列表」，并可切换到指定对话。
 *
 * 只读 + 点击，不读取任何账号信息；靠的是页面自带的
 * `[data-testid="conversation-list-v2-item"]` 钩子（实测 40 条左右，虚拟滚动）。
 */
import { CdpSession, DOUBAO_DEBUG_PORT, listTargets, pickChatPage } from './cdp';
import { MD_INSTALL_JS } from './md-extractor';

export interface DesktopConversation {
  /** 豆包对话 id（data-conversation-id）。 */
  id?: string;
  /** 在列表里的序号（0 基），用于点击切换。 */
  index: number;
  title: string;
  /** 列表里显示的相对时间（今天/昨天/日期），读不到就是空。 */
  time: string;
  /** 状态徽标：待确认 / 执行中 / 已完成 …（豆包在条目上自己标的，读不到就是空）。 */
  status?: string;
  /** 是否仍在执行（有待确认/执行中之类标记）。 */
  running?: boolean;
}

export interface DesktopHistoryResult {
  ok: boolean;
  items: DesktopConversation[];
  error?: string;
}

/** 读取当前可见的对话列表（不改变任何状态）。 */
export async function listDesktopConversations(port = DOUBAO_DEBUG_PORT): Promise<DesktopHistoryResult> {
  let session: CdpSession | undefined;
  try {
    const targets = await listTargets(port);
    const page = await pickChatPage(targets);
    if (!page) {
      return { ok: false, items: [], error: '没有找到豆包页面，请先「以调试端口启动桌面端」' };
    }
    session = await CdpSession.connect(page.webSocketDebuggerUrl);
    const raw = await session.evaluate<string>(`
      (() => {
        const nodes = [...document.querySelectorAll('[data-testid="conversation-list-v2-item"]')];
        const STATUS = /待确认|执行中|运行中|生成中|处理中|已完成|失败|中断/;
        const out = nodes.map((node, index) => {
          const text = (node.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean);
          const title = text[0] || '';
          const rest = text.slice(1);
          const statusLine = rest.find((line) => STATUS.test(line)) || '';
          const time = rest.find((line) => /今天|昨天|\\d{1,2}[:：]\\d{2}|\\d{1,2}\\/\\d{1,2}/.test(line)) || '';
          const status = statusLine ? STATUS.exec(statusLine)[0] : '';
          const id = node.getAttribute('data-conversation-id') || '';
          return { index, id, title, time, status, running: /待确认|执行中|运行中|生成中|处理中/.test(status) };
        }).filter((x) => x.title);
        return JSON.stringify(out);
      })()
    `);
    const items = JSON.parse(raw || '[]') as DesktopConversation[];
    return { ok: true, items };
  } catch (err) {
    return { ok: false, items: [], error: err instanceof Error ? err.message : String(err) };
  } finally {
    session?.close();
  }
}

/** 点击列表里的第 index 条对话，切过去。 */
export async function openDesktopConversation(
  index: number,
  port = DOUBAO_DEBUG_PORT,
  id = '',
): Promise<{ ok: boolean; title?: string; error?: string }> {
  let session: CdpSession | undefined;
  try {
    const targets = await listTargets(port);
    const page = await pickChatPage(targets);
    if (!page) {
      return { ok: false, error: '没有找到豆包页面' };
    }
    session = await CdpSession.connect(page.webSocketDebuggerUrl);
    const raw = await session.evaluate<string>(`
      (() => {
        const nodes = [...document.querySelectorAll('[data-testid="conversation-list-v2-item"]')];
        const wanted = ${JSON.stringify(String(id || ''))};
        const node = wanted
          ? nodes.find((n) => n.getAttribute('data-conversation-id') === wanted)
          : nodes[${Math.max(0, Math.round(index))}];
        if (!node) return JSON.stringify({ ok: false, error: '列表里没有这一条（可能被滚动隐藏）' });
        const title = ((node.innerText || '').split('\\n')[0] || '').trim();
        node.click();
        return JSON.stringify({ ok: true, title });
      })()
    `);
    const parsed = JSON.parse(raw || '{}') as { ok?: boolean; title?: string; error?: string };
    return { ok: Boolean(parsed.ok), title: parsed.title, error: parsed.error };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    session?.close();
  }
}

/* -------------------------------------------------------------------------- */
/* 读取当前打开的豆包对话内容（用于「点历史 → 同步到面板」）                     */
/* -------------------------------------------------------------------------- */

export interface DesktopMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface DesktopConversationContent {
  ok: boolean;
  title?: string;
  messages: DesktopMessage[];
  error?: string;
}

/** 读当前对话页里的消息（最多取最后 limit 条）。 */
export async function readDesktopConversation(
  port = DOUBAO_DEBUG_PORT,
  limit = 40,
): Promise<DesktopConversationContent> {
  let session: CdpSession | undefined;
  try {
    const targets = await listTargets(port);
    const page = await pickChatPage(targets);
    if (!page) {
      return { ok: false, messages: [], error: '没有找到豆包页面' };
    }
    session = await CdpSession.connect(page.webSocketDebuggerUrl);
    await session.evaluate(MD_INSTALL_JS);
    const raw = await session.evaluate<string>(`
      (() => {
        const title = (document.title || '').replace(/\\s*-\\s*豆包$/, '').trim();
        const nodes = [...document.querySelectorAll('[data-testid="union_message"]')];
        const out = [];
        for (const node of nodes) {
          const isUser = Boolean(node.querySelector('[data-testid="send_message"]'));
          const body = node.querySelector('[data-testid="message_text_content"]');
          if (!body) continue;
          const text = (window.__dcMd ? window.__dcMd(body) : (body.innerText || '')).trim();
          if (!text) continue;
          out.push({ role: isUser ? 'user' : 'assistant', text });
        }
        return JSON.stringify({ title, messages: out.slice(${Math.max(1, Math.round(limit)) * -1 }) });
      })()
    `);
    const parsed = JSON.parse(raw || '{}') as { title?: string; messages?: DesktopMessage[] };
    return { ok: true, title: parsed.title, messages: parsed.messages ?? [] };
  } catch (err) {
    return { ok: false, messages: [], error: err instanceof Error ? err.message : String(err) };
  } finally {
    session?.close();
  }
}