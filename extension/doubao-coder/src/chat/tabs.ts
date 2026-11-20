/** 任务标签页的纯逻辑：新增/去重/关闭后的激活/恢复过滤/标题刷新。 */

export interface TabMeta {
  id: string;
  title: string;
  active: boolean;
  desktopTitle: string;
}

export const MAX_TABS = 12;

/** 追加标签：已存在时**保持原顺序**，不因切换而移动；超过上限丢最旧的。 */
export function addTab(order: string[], id: string, limit = MAX_TABS): string[] {
  if (!id || order.includes(id)) {
    return order.slice();
  }
  const next = order.concat([id]);
  while (next.length > limit) {
    next.shift();
  }
  return next;
}

/** 移除标签。 */
export function removeTab(order: string[], id: string): string[] {
  return order.filter((item) => item !== id);
}

/** 关闭某个标签后应激活的标签：优先右侧邻居，其次左侧，最后空串。 */
export function nextActiveAfterClose(order: string[], closingId: string, activeId: string): string {
  if (activeId !== closingId) {
    return activeId;
  }
  const idx = order.indexOf(closingId);
  if (idx < 0) {
    return activeId;
  }
  const remaining = removeTab(order, closingId);
  if (remaining.length === 0) {
    return '';
  }
  return remaining[Math.min(idx, remaining.length - 1)];
}

/** 恢复持久化的标签：过滤已不存在的会话，并保证当前会话在列表里（放在末尾）。 */
export function restoreTabs(saved: string[], exists: (id: string) => boolean, current: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of saved) {
    if (!id || seen.has(id) || !exists(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  if (current && !seen.has(current)) {
    out.push(current);
  }
  return out.slice(-MAX_TABS);
}

/** 切换标签时是否要中止正在执行的回合：只在使用中且目标不是当前会话时。 */
export function shouldAbortOnSwitch(busy: boolean, fromId: string, toId: string): boolean {
  return busy && Boolean(fromId) && Boolean(toId) && fromId !== toId;
}

/** 豆包回复后刷新会话/标签标题：标题或 desktopId 有变化才算改动。 */
export function refreshTitle(args: {
  currentTitle?: string;
  currentDesktopTitle?: string;
  currentDesktopId?: string;
  nextTitle: string;
  nextDesktopId?: string;
}): { changed: boolean; title: string; desktopTitle: string; desktopId: string } {
  const title = String(args.nextTitle || '').trim();
  const desktopId = String(args.nextDesktopId || '').trim();
  const beforeTitle = String(args.currentTitle || '').trim();
  const beforeDesktopTitle = String(args.currentDesktopTitle || '').trim();
  const beforeDesktopId = String(args.currentDesktopId || '').trim();
  const changed =
    Boolean(title) &&
    (title !== beforeTitle || title !== beforeDesktopTitle || (Boolean(desktopId) && desktopId !== beforeDesktopId));
  return { changed, title: title || beforeTitle, desktopTitle: title || beforeDesktopTitle, desktopId: desktopId || beforeDesktopId };
}
