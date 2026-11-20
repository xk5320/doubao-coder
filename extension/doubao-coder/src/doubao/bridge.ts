import * as path from 'node:path';
import * as vscode from 'vscode';
import { log, warn } from '../log';

/** 豆包桌面客户端的 deep link scheme + 路由。 */
export const DOUBAO_SCHEME = 'doubao';
export const DOUBAO_ACTIVE_CHAT = 'doubaoapp/active-chat';

/** deep link 里正文的最大长度，超长会被截断（URL 太长客户端也可能拒绝）。 */
const MAX_LINK_TEXT = 6000;

export interface SelectionPayload {
  /** 投送的正文（已包含文件信息）。 */
  text: string;
  /** 相对工作区的文件路径。 */
  filePath?: string;
  /** 1 基行号。 */
  line?: number;
  languageId?: string;
}

/** 构造 `doubao://doubaoapp/active-chat?...` 链接。 */
export function buildDeepLink(payload: SelectionPayload): string {
  const params = new URLSearchParams();
  params.set('text', payload.text.slice(0, MAX_LINK_TEXT));
  params.set('source', 'vscode');
  params.set('from', 'doubao-coder');
  if (payload.filePath) {
    params.set('file', payload.filePath);
  }
  if (typeof payload.line === 'number' && payload.line > 0) {
    params.set('line', String(payload.line));
  }
  if (payload.languageId) {
    params.set('lang', payload.languageId);
  }
  // 用 encodeURIComponent 再包一层，避免部分客户端对 + 号处理不一致。
  return `${DOUBAO_SCHEME}://${DOUBAO_ACTIVE_CHAT}?${params.toString().replace(/\+/g, '%20')}`;
}

/** 把选区/整篇文件包装成投送给豆包客户端的提问文本。 */
export function buildPromptText(input: {
  code: string;
  fileName: string;
  line: number;
  languageId: string;
  wholeFile: boolean;
}): string {
  const label = input.wholeFile ? '整个文件' : '选中的代码';
  return [
    `请帮我分析 ${input.fileName} 第 ${input.line} 行附近的${label}：`,
    '```' + input.languageId,
    input.code,
    '```',
  ].join('\n');
}

function relativeToWorkspace(document: vscode.TextDocument): string {
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!folder) {
    return document.uri.fsPath;
  }
  return path.relative(folder.uri.fsPath, document.uri.fsPath).split(path.sep).join('/');
}

/** 从当前编辑器收集要投送的内容（优先选区，没有选区则整篇）。 */
export function collectPayload(): SelectionPayload | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return undefined;
  }
  const document = editor.document;
  const selection = editor.selection;
  const wholeFile = selection.isEmpty;
  const code = wholeFile ? document.getText() : document.getText(selection);
  if (!code.trim()) {
    return undefined;
  }
  const fileName = relativeToWorkspace(document);
  const line = (wholeFile ? 1 : selection.start.line + 1) as number;
  return {
    text: buildPromptText({
      code,
      fileName,
      line,
      languageId: document.languageId,
      wholeFile,
    }),
    filePath: fileName,
    line,
    languageId: document.languageId,
  };
}

/** 命令实现：把选区投送到豆包桌面客户端。 */
export async function sendSelectionToDoubaoApp(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('请先打开一个文件并选中要投送的内容。');
    return;
  }
  const payload = collectPayload();
  if (!payload) {
    vscode.window.showInformationMessage('当前没有可投送的内容（选区或文件为空）。');
    return;
  }

  const truncated = payload.text.length > MAX_LINK_TEXT;
  const link = buildDeepLink(payload);

  // 先复制到剪贴板：即使客户端没装/协议未注册，用户也能手动粘贴。
  try {
    await vscode.env.clipboard.writeText(payload.text);
  } catch (err) {
    warn('写入剪贴板失败', err instanceof Error ? err.message : String(err));
  }

  let opened = false;
  try {
    opened = await vscode.env.openExternal(vscode.Uri.parse(link));
  } catch (err) {
    warn('openExternal 失败', err instanceof Error ? err.message : String(err));
  }

  log('deep link 投送', payload.filePath ?? '(未命名)', opened ? '已打开' : '打开失败', `${payload.text.length}字`);
  if (!opened) {
    const action = await vscode.window.showWarningMessage(
      '没能直接唤起豆包桌面客户端（可能未安装，或系统未注册 doubao:// 协议）。内容已复制到剪贴板。',
      '查看日志',
      '打开设置',
    );
    if (action === '查看日志') {
      await vscode.commands.executeCommand('doubao.showLogs');
    } else if (action === '打开设置') {
      await vscode.commands.executeCommand('doubao.openSettings');
    }
    return;
  }

  if (truncated) {
    vscode.window.showInformationMessage(
      `已投送到豆包客户端；内容超过 ${MAX_LINK_TEXT} 字符，已截断。完整内容已在剪贴板中。`,
    );
  } else {
    vscode.window.showInformationMessage('已投送到豆包桌面客户端（完整内容同时复制到了剪贴板）。');
  }
}
