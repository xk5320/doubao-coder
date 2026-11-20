import * as vscode from 'vscode';
import { ArkClient } from '../ark/client';
import { readConfig } from '../config';
import { debug, log, warn } from '../log';
import { stripCodeFence } from '../chat/prompt';

const DEBOUNCE_MS = 300;
const CACHE_TTL_MS = 2000;
const CACHE_MAX_ENTRIES = 80;
const PREFIX_LIMIT = 3000;
const SUFFIX_LIMIT = 1000;
const MAX_COMPLETION_CHARS = 2000;
const MAX_COMPLETION_LINES = 40;

/** 这些语言不做行内补全（补全价值低且容易打扰）。 */
const SKIP_LANGUAGES = new Set([
  'plaintext',
  'markdown',
  'log',
  'git-commit',
  'git-rebase',
  'search-result',
  'vscode-output',
]);

interface CacheEntry {
  text: string;
  at: number;
}

/**
 * 行内补全 Provider：
 * - 无 triggerCharacters，完全基于 provideInlineCompletionItems；
 * - 300ms 防抖 + token 取消；
 * - 同一文档/版本/位置的结果缓存 2 秒，避免重复请求。
 */
export class DoubaoInlineCompletionProvider implements vscode.InlineCompletionItemProvider, vscode.Disposable {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Set<string>();
  private disposed = false;

  public async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    if (this.disposed || token.isCancellationRequested) {
      return undefined;
    }
    const config = readConfig();
    // 桌面端登录态模式没有可用的补全接口（官方客户端不对外提供 FIM），直接跳过。
    if (!config.enableInlineCompletion || config.authMode !== 'ark' || !config.apiKey) {
      return undefined;
    }
    if (document.uri.scheme !== 'file' || SKIP_LANGUAGES.has(document.languageId)) {
      return undefined;
    }
    if (document.lineCount > 20000) {
      return undefined;
    }

    const key = this.cacheKey(document, position);
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return [makeItem(cached.text, position)];
    }
    if (this.inflight.has(key)) {
      return undefined;
    }

    // 300ms 防抖：用户还在打字时直接放弃，不占用请求额度。
    const stillWanted = await sleepUnlessCancelled(DEBOUNCE_MS, token);
    if (!stillWanted || token.isCancellationRequested) {
      return undefined;
    }

    const { prefix, suffix } = buildContext(document, position);
    if (!prefix.trim() && !suffix.trim()) {
      return undefined;
    }

    this.inflight.add(key);
    const abortController = new AbortController();
    const cancelListener = token.onCancellationRequested(() => {
      abortController.abort('补全被取消');
    });

    try {
      const client = new ArkClient(config);
      debug('请求行内补全', document.uri.fsPath, `${position.line + 1}:${position.character}`);
      const raw = await client.completeFIM(prefix, suffix, {
        model: config.completionModel,
        maxTokens: 160,
        temperature: 0,
        signal: abortController.signal,
        timeoutMs: 15_000,
      });
      const text = sanitize(raw, document, position);
      if (!text) {
        return undefined;
      }
      this.remember(key, text);
      return [makeItem(text, position)];
    } catch (err) {
      if (abortController.signal.aborted) {
        return undefined;
      }
      warn('行内补全失败', err instanceof Error ? err.message : String(err));
      return undefined;
    } finally {
      cancelListener.dispose();
      this.inflight.delete(key);
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.cache.clear();
    this.inflight.clear();
  }

  private cacheKey(document: vscode.TextDocument, position: vscode.Position): string {
    return `${document.uri.toString()}#${document.version}#${position.line}:${position.character}`;
  }

  private remember(key: string, text: string): void {
    this.cache.set(key, { text, at: Date.now() });
    if (this.cache.size > CACHE_MAX_ENTRIES) {
      const oldest = [...this.cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 20);
      for (const [entryKey] of oldest) {
        this.cache.delete(entryKey);
      }
      log('补全缓存已清理', `剩余 ${this.cache.size} 条`);
    }
  }
}

function makeItem(text: string, position: vscode.Position): vscode.InlineCompletionItem {
  return new vscode.InlineCompletionItem(text, new vscode.Range(position, position));
}

/** 取光标前后文，按行边界裁剪，避免把半个字/半行代码丢给模型。 */
export function buildContext(
  document: vscode.TextDocument,
  position: vscode.Position,
): { prefix: string; suffix: string } {
  const offset = document.offsetAt(position);
  const full = document.getText();
  let prefix = full.slice(Math.max(0, offset - PREFIX_LIMIT), offset);
  let suffix = full.slice(offset, Math.min(full.length, offset + SUFFIX_LIMIT));

  const firstNewline = prefix.indexOf('\n');
  if (firstNewline > 0 && prefix.length >= PREFIX_LIMIT) {
    prefix = prefix.slice(firstNewline + 1);
  }
  const lastNewline = suffix.lastIndexOf('\n');
  if (lastNewline >= 0 && suffix.length >= SUFFIX_LIMIT) {
    suffix = suffix.slice(0, lastNewline + 1);
  }
  return { prefix, suffix };
}

/** 清洗模型输出：去围栏、去重复行首空白、限制行数/长度。 */
export function sanitize(raw: string, document: vscode.TextDocument, position: vscode.Position): string {
  let text = stripCodeFence(raw);
  if (!text.trim()) {
    return '';
  }
  // 模型偶尔会把光标所在行已存在的前缀重复一遍。
  const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
  if (linePrefix.trim().length > 3 && text.startsWith(linePrefix)) {
    text = text.slice(linePrefix.length);
    if (!text.trim()) {
      return '';
    }
  }
  const lines = text.split(/\r?\n/);
  if (lines.length > MAX_COMPLETION_LINES) {
    text = lines.slice(0, MAX_COMPLETION_LINES).join('\n');
  }
  if (text.length > MAX_COMPLETION_CHARS) {
    text = text.slice(0, MAX_COMPLETION_CHARS);
  }
  // 只有空白（空格/换行）没有意义。
  if (!text.replace(/\s/g, '')) {
    return '';
  }
  return text;
}

function sleepUnlessCancelled(ms: number, token: vscode.CancellationToken): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        listener.dispose();
        resolve(true);
      }
    }, ms);
    const listener = token.onCancellationRequested(() => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(false);
      }
    });
  });
}
