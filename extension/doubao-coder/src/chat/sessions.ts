/**
 * 本地会话记忆（"自己管理的记忆"）
 *
 * 豆包那边的对话记录在它自己的账号里；扩展这边需要**自己记住**：
 * 每个会话的首条用户消息作为标题、最后 N 条消息作为可回放的转录。
 * 存 `globalState`（跨窗口、跨重启），单条会话最多 200 条消息，最多保留 30 个会话。
 */
import type * as vscode from 'vscode';

export interface SessionTurn {
  role: 'user' | 'assistant';
  text: string;
  at: number;
}

export interface SessionRecord {
  id: string;
  title: string;
  updatedAt: number;
  /** 关联的豆包会话标题（桌面端通道下，方便对照找回）。 */
  desktopTitle?: string;
  /** 关联的豆包会话 id（data-conversation-id，标题之外的第二层对应）。 */
  desktopId?: string;
  /** 置顶：排序优先。 */
  pinned?: boolean;
  /** 归档：默认列表里不显示。 */
  archived?: boolean;
  turns: SessionTurn[];
}

const MAX_SESSIONS = 30;
const MAX_TURNS = 200;


/** 去掉我们注入的提示词前缀，只留用户真正说的话。 */
export function stripInjected(text: string): string {
  let out = String(text || '');
  const markers = ['----- 以下是编辑器上下文与用户请求 -----', '----- 用户消息 -----'];
  for (const marker of markers) {
    const at = out.lastIndexOf(marker);
    if (at >= 0) {
      out = out.slice(at + marker.length);
    }
  }
  out = out.replace(/^【任务模式】/, '').trim();
  return out || String(text || '');
}

export class SessionStore {
  constructor(
    private readonly memento: vscode.Memento,
    private readonly key: string = 'doubao.sessions',
  ) {}

  /** 把旧版（全局）会话迁移到当前工作区作用域，只迁移一次。 */
  public migrateFrom(memento: vscode.Memento, legacyKey = 'doubao.sessions'): void {
    if (this.key === legacyKey) {
      return;
    }
    const legacy = memento.get<SessionRecord[]>(legacyKey);
    if (!Array.isArray(legacy) || legacy.length === 0 || this.list().length > 0) {
      return;
    }
    void this.memento.update(this.key, legacy.slice(0, MAX_SESSIONS));
    void memento.update(legacyKey, undefined);
  }


  /** 一次性迁移：把历史会话里的注入提示词剥掉（0.10.3 之前存的老数据）。 */
  public migrate(): void {
    const version = this.memento.get<number>('doubao.sessions.version', 0);
    if (version >= 2) {
      return;
    }
    const all = this.list();
    const upgraded = all.map((record) => ({
      ...record,
      turns: record.turns.map((turn) =>
        turn.role === 'user' ? { ...turn, text: stripInjected(turn.text) } : turn,
      ),
    }));
    void this.memento.update(this.key, upgraded);
    void this.memento.update('doubao.sessions.version', 2);
  }

  public list(includeArchived = false): SessionRecord[] {
    const raw = this.memento.get<SessionRecord[]>(this.key, []);
    const all = Array.isArray(raw) ? raw.slice() : [];
    return all
      .filter((item) => includeArchived || !item.archived)
      .sort((a, b) => {
        if (Boolean(a.pinned) !== Boolean(b.pinned)) {
          return a.pinned ? -1 : 1;
        }
        return b.updatedAt - a.updatedAt;
      });
  }

  /** 置顶 / 取消置顶。 */
  public setPinned(id: string, pinned: boolean): boolean {
    return this.patch(id, { pinned });
  }

  /** 归档 / 取消归档。 */
  public setArchived(id: string, archived: boolean): boolean {
    return this.patch(id, { archived });
  }

  /** 重命名。 */
  public rename(id: string, title: string): boolean {
    const clean = title.trim().slice(0, 60);
    if (!clean) {
      return false;
    }
    return this.patch(id, { title: clean });
  }

  private patch(id: string, fields: Partial<SessionRecord>): boolean {
    const raw = this.memento.get<SessionRecord[]>(this.key, []);
    const all = Array.isArray(raw) ? raw.slice() : [];
    const index = all.findIndex((item) => item.id === id);
    if (index < 0) {
      return false;
    }
    all[index] = { ...all[index], ...fields };
    void this.memento.update(this.key, all);
    return true;
  }

  public get(id: string): SessionRecord | undefined {
    return this.list().find((item) => item.id === id);
  }

  /** 新建或覆盖一个会话。 */
  public upsert(record: SessionRecord): void {
    const all = this.list().filter((item) => item.id !== record.id);
    all.unshift({ ...record, turns: record.turns.slice(-MAX_TURNS) });
    void this.memento.update(this.key, all.slice(0, MAX_SESSIONS));
  }

  /** 追加一轮对话（不存在则创建）。 */
  public append(
    id: string,
    input: { title?: string; desktopTitle?: string; user?: string; assistant?: string },
  ): SessionRecord {
    const existing = this.get(id);
    const now = Date.now();
    const turns = existing ? existing.turns.slice() : [];
    if (input.user) {
      turns.push({ role: 'user', text: input.user, at: now });
    }
    if (input.assistant) {
      turns.push({ role: 'assistant', text: input.assistant, at: now });
    }
    const record: SessionRecord = {
      id,
      title: existing?.title || input.title || (input.user || '未命名会话').slice(0, 40),
      updatedAt: now,
      desktopTitle: input.desktopTitle ?? existing?.desktopTitle,
      turns,
    };
    this.upsert(record);
    return record;
  }

  public remove(id: string): void {
    const all = this.list().filter((item) => item.id !== id);
    void this.memento.update(this.key, all);
  }

  public clear(): void {
    void this.memento.update(this.key, []);
  }
}

/** 生成一个会话 id（不依赖 crypto，够用）。 */
export function newSessionId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
