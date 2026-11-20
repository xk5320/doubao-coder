/**
 * 「历史任务」新实现：把豆包侧边栏里的对话**完整收集**并支持按 id 打开。
 * 旧 listDesktopConversations 只读当前渲染的节点（虚拟列表 + 「展开更多」），所以看不到全部。
 */
import { CdpSession, DOUBAO_DEBUG_PORT, listTargets, pickChatPage } from './cdp';

export interface AllConversation {
  index: number;
  id: string;
  title: string;
  time: string;
  status: string;
  running: boolean;
}

export interface CollectResult {
  ok: boolean;
  items: AllConversation[];
  rounds: number;
  error?: string;
}

const STEP_JS = String.raw`
(() => {
  const nodes = [...document.querySelectorAll('button,div,span')];
  const more = nodes.find((el) => {
    const r = el.getBoundingClientRect();
    return (el.innerText || '').trim() === '展开更多' && r.width > 0 && r.height > 0;
  });
  if (more) { more.click(); }
  const root = document.querySelector('[data-testid="chat_list_wrapper"]');
  let box = null;
  let n = root;
  while (n) {
    const cs = getComputedStyle(n);
    if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && n.scrollHeight > n.clientHeight + 10) { box = n; break; }
    n = n.parentElement;
  }
  if (!box && root) { box = root; }
  if (box) { box.scrollTop = box.scrollHeight; }
  const STATUS = /待确认|执行中|运行中|生成中|处理中|已完成|失败|中断/;
  const items = [...document.querySelectorAll('[data-testid="conversation-list-v2-item"]')].map((node) => {
    const id = node.getAttribute('data-conversation-id') || '';
    const text = (node.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const title = text[0] || '';
    const rest = text.slice(1);
    const statusLine = rest.find((line) => STATUS.test(line)) || '';
    const time = rest.find((line) => /今天|昨天|\d{1,2}[:：]\d{2}|\d{1,2}\/\d{1,2}/.test(line)) || '';
    const status = statusLine ? (STATUS.exec(statusLine) || [''])[0] : '';
    return { id, title, time, status, running: /待确认|执行中|运行中|生成中|处理中/.test(status) };
  }).filter((x) => x.id && x.title);
  return JSON.stringify({ items, atBottom: box ? box.scrollTop + box.clientHeight >= box.scrollHeight - 4 : true });
})()`;

async function openPage(port: number): Promise<{ session: CdpSession; error?: string }> {
  const targets = await listTargets(port);
  const page = await pickChatPage(targets);
  if (!page) {
    return { session: undefined as unknown as CdpSession, error: '没有找到豆包页面' };
  }
  const session = await CdpSession.connect(page.webSocketDebuggerUrl);
  return { session };
}

/** 反复「展开更多 + 滚到底」收集全部对话，直到连续 3 轮没有新条目。 */
export async function collectAllDesktopConversations(
  port = DOUBAO_DEBUG_PORT,
  onProgress?: (count: number) => void,
): Promise<CollectResult> {
  const { session, error } = await openPage(port);
  if (error || !session) {
    return { ok: false, items: [], rounds: 0, error };
  }
  const seen = new Map<string, AllConversation>();
  let idle = 0;
  let rounds = 0;
  try {
    for (let i = 0; i < 60 && idle < 3; i += 1) {
      rounds += 1;
      const raw = await session
        .evaluate<string>(STEP_JS, 8000)
        .catch(() => '');
      if (!raw) {
        break;
      }
      let parsed: { items?: Array<Omit<AllConversation, 'index'>>; atBottom?: boolean } = {};
      try {
        parsed = JSON.parse(raw);
      } catch {
        break;
      }
      const before = seen.size;
      for (const item of parsed.items || []) {
        if (!item.id || seen.has(item.id)) {
          continue;
        }
        seen.set(item.id, {
          index: seen.size,
          id: item.id,
          title: item.title,
          time: item.time || '',
          status: item.status || '',
          running: Boolean(item.running),
        });
      }
      onProgress?.(seen.size);
      if (seen.size === before) {
        idle += 1;
      } else {
        idle = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    return { ok: true, items: [...seen.values()], rounds };
  } catch (err) {
    return { ok: false, items: [...seen.values()], rounds, error: err instanceof Error ? err.message : String(err) };
  } finally {
    session.close();
  }
}

/** 按 id 打开对话：必要时展开更多/滚动寻找，点击后校验 active id。 */
export async function openDesktopConversationById(
  id: string,
  port = DOUBAO_DEBUG_PORT,
): Promise<{ ok: boolean; title?: string; error?: string }> {
  const { session, error } = await openPage(port);
  if (error || !session) {
    return { ok: false, error };
  }
  const safe = JSON.stringify(String(id || ''));
  try {
    for (let i = 0; i < 50; i += 1) {
      const raw = await session
        .evaluate<string>(String.raw`
          (() => {
            const wanted = ${safe};
            const node = document.querySelector('[data-testid="conversation-list-v2-item"][data-conversation-id="' + wanted + '"]');
            if (node) {
              const r = node.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) { node.scrollIntoView({ block: 'center' }); node.click(); return JSON.stringify({ clicked: true, title: ((node.innerText || '').split('\\n')[0] || '').trim() }); }
            }
            const nodes = [...document.querySelectorAll('button,div,span')];
            const more = nodes.find((el) => { const rr = el.getBoundingClientRect(); return (el.innerText || '').trim() === '展开更多' && rr.width > 0; });
            if (more) { more.click(); }
            const root = document.querySelector('[data-testid="chat_list_wrapper"]');
            let box = null; let n = root;
            while (n) { const cs = getComputedStyle(n); if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && n.scrollHeight > n.clientHeight + 10) { box = n; break; } n = n.parentElement; }
            if (!box) { box = root; }
            if (box) { box.scrollTop = Math.min(box.scrollTop + box.clientHeight * 0.8, box.scrollHeight); }
            return JSON.stringify({ clicked: false });
          })()
        `, 6000)
        .catch(() => '');
      let parsed: { clicked?: boolean; title?: string } = {};
      try {
        parsed = JSON.parse(raw || '{}');
      } catch {
        parsed = {};
      }
      if (parsed.clicked) {
        let hrefId = '';
        let activeAttr = '';
        for (let k = 0; k < 12; k += 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          const probe = await session
            .evaluate<string>("(() => { const el = document.querySelector('[data-conversation-active=" + JSON.stringify('true') + "]'); return location.href + '|' + (el ? (el.getAttribute('data-conversation-id') || '') : ''); })()", 3000)
            .catch(() => '');
          const parts = String(probe || '').split('|');
          hrefId = (parts[0] || '').match(/\/chat\/(\d+)/)?.[1] || '';
          activeAttr = parts[1] || '';
          if (hrefId === String(id) || activeAttr === String(id)) {
            return { ok: true, title: parsed.title };
          }
        }
        return { ok: false, error: '点击后 active 对话 id 不一致（href=' + hrefId + ' attr=' + activeAttr + '）' };
      }
      await new Promise((resolve) => setTimeout(resolve, 450));
    }
    return { ok: false, error: '滚动/展开后仍未找到该对话' };
  } finally {
    session.close();
  }
}