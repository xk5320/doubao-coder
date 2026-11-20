/** 历史任务 ↔ 豆包对话：激活目标的纯函数模型（可单测，不依赖 vscode）。 */

export interface ConversationItem {
  index: number;
  /** 豆包对话 id（data-conversation-id）。 */
  id?: string;
  title: string;
  time?: string;
  running?: boolean;
}

export type ActiveTarget =
  | { kind: 'desktop'; title: string; id?: string; sessionId?: string; updatedAt: number }
  | { kind: 'local'; sessionId: string; desktopTitle?: string; desktopId?: string; updatedAt: number }
  | { kind: 'none'; updatedAt: number };

export type MatchError = 'not-found' | 'ambiguous';

export interface MatchResult {
  item?: ConversationItem;
  error?: MatchError;
  candidates: ConversationItem[];
}

/** 标题归一化：去首尾空白、全角空格转半角、连续空白压缩。 */
export function normalizeTitle(raw: unknown): string {
  return String(raw == null ? '' : raw)
    .replace(/\u3000/g, ' ')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

export function titleKey(raw: unknown): string {
  return normalizeTitle(raw).toLowerCase();
}

/** 最近更新的一个：列表 index 越小越新。 */
function newest(items: ConversationItem[]): ConversationItem {
  return items.slice().sort((a, b) => a.index - b.index)[0];
}

/**
 * 按标题匹配豆包对话：精确 → 忽略大小写/空白 → 前缀；
 * 禁止任意子串（避免同名/相似标题串台）。
 */
export function matchConversation(target: string, items: ConversationItem[]): MatchResult {
  const key = titleKey(target);
  if (!key) {
    return { candidates: [], error: 'not-found' };
  }
  const list = Array.isArray(items) ? items.filter((item) => item && normalizeTitle(item.title)) : [];
  const exact = list.filter((item) => titleKey(item.title) === key);
  if (exact.length === 1) {
    return { item: exact[0], candidates: exact };
  }
  if (exact.length > 1) {
    return { item: newest(exact), error: 'ambiguous', candidates: exact };
  }
  const prefix = list.filter((item) => titleKey(item.title).startsWith(key));
  if (prefix.length === 1) {
    return { item: prefix[0], candidates: prefix };
  }
  if (prefix.length > 1) {
    return { item: newest(prefix), error: 'ambiguous', candidates: prefix };
  }
  return { candidates: [], error: 'not-found' };
}

export function desktopTarget(title: string, sessionId?: string, id?: string): ActiveTarget {
  return { kind: 'desktop', title: normalizeTitle(title), id: String(id || ''), sessionId, updatedAt: Date.now() };
}

export function localTarget(sessionId: string, desktopTitle?: string, desktopId?: string): ActiveTarget {
  return { kind: 'local', sessionId, desktopTitle: normalizeTitle(desktopTitle || ''), desktopId: String(desktopId || ''), updatedAt: Date.now() };
}

export function noneTarget(): ActiveTarget {
  return { kind: 'none', updatedAt: Date.now() };
}

/** 当前激活目标绑定的豆包标题（没有则空串）。 */
export function activeDesktopTitle(target: ActiveTarget | null | undefined): string {
  if (!target) {
    return '';
  }
  if (target.kind === 'desktop') {
    return normalizeTitle(target.title);
  }
  if (target.kind === 'local') {
    return normalizeTitle(target.desktopTitle || '');
  }
  return '';
}

/**
 * 是否执行“恢复上次窗口”：
 * 仅当本次还没有激活目标、且保存时间晚于用户最近操作时才恢复。
 */
export function shouldRestoreLastWindow(args: {
  savedTitle?: string;
  savedAt?: number;
  userActivatedAt?: number;
  hasActiveTarget?: boolean;
}): boolean {
  if (!normalizeTitle(args.savedTitle || '')) {
    return false;
  }
  if (args.hasActiveTarget) {
    return false;
  }
  const savedAt = Number(args.savedAt || 0);
  const userAt = Number(args.userActivatedAt || 0);
  return savedAt >= userAt;
}

/** 豆包列表里是否还有这个标题（归一化后精确相等，用于本地会话对账）。 */
export function hasConversation(title: string, items: ConversationItem[]): boolean {
  const key = titleKey(title);
  if (!key) {
    return false;
  }
  return (Array.isArray(items) ? items : []).some((item) => item && titleKey(item.title) === key);
}

/** 当前激活目标绑定的豆包对话 id（没有则空串）。 */
export function activeDesktopId(target: ActiveTarget | null | undefined): string {
  if (!target) {
    return '';
  }
  if (target.kind === 'desktop') {
    return String(target.id || '');
  }
  if (target.kind === 'local') {
    return String(target.desktopId || '');
  }
  return '';
}
