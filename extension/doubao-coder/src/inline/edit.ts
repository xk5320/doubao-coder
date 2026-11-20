import * as path from 'node:path';
import * as vscode from 'vscode';
import { ArkClient, ArkError } from '../ark/client';
import {
  LAST_EDIT_KEY,
  lastEdit,
  replaceRange,
  replaceWholeFile,
  type LastEditRecord,
} from '../agent/tools';
import { askDesktop } from '../bridge/desktop';
import { ensureConfigured, readConfig, type DoubaoConfig } from '../config';
import { buildSystemPrompt, inlineEditMessages, stripCodeFence } from '../chat/prompt';
import { getDesktopModel } from '../bridge/desktop-control';
import { log, logError } from '../log';

/** 预览/对比用的虚拟文档 scheme。 */
export const PREVIEW_SCHEME = 'doubao-preview';

const previewContents = new Map<string, string>();
let previewSeq = 0;

/** 注册一个 TextDocumentContentProvider，为 vscode.diff 提供左侧内容。 */
export class DoubaoTextContentProvider implements vscode.TextDocumentContentProvider {
  public provideTextDocumentContent(uri: vscode.Uri): string {
    return previewContents.get(uri.path) ?? '（内容已失效，请重新执行命令）';
  }
}

/** 把一段文本注册成虚拟文档，返回可用于 vscode.diff 的 Uri。 */
export function registerPreviewContent(content: string, extension: string): vscode.Uri {
  previewSeq += 1;
  const ext = extension.startsWith('.') ? extension : extension ? `.${extension}` : '.txt';
  const uri = vscode.Uri.parse(`${PREVIEW_SCHEME}:/preview-${Date.now()}-${previewSeq}${ext}`);
  previewContents.set(uri.path, content);
  if (previewContents.size > 40) {
    const oldest = [...previewContents.keys()].slice(0, 20);
    for (const key of oldest) {
      previewContents.delete(key);
    }
  }
  return uri;
}

/** 用户取消改写（桌面端通道用）。 */
class RewriteCancelled extends Error {
  constructor() {
    super('用户取消行内改写');
    this.name = 'RewriteCancelled';
  }
}

/**
 * 生成改写结果：
 * - `ark` 模式：ArkClient 流式；
 * - `desktop` 模式：已登录的豆包桌面端（免 Key），一次问答，不做工具循环（改写只需要代码）。
 */
export async function generateRewrite(
  config: DoubaoConfig,
  systemPrompt: string,
  user: string,
  token: vscode.CancellationToken,
): Promise<string> {
  if (config.authMode === 'desktop') {
    const controller = new AbortController();
    const sub = token.onCancellationRequested(() => controller.abort());
    try {
      const result = await askDesktop(
        `${systemPrompt}\n\n----- 以下是需要改写的代码与要求 -----\n${user}`,
        {
          port: config.desktopPort,
          newChat: config.desktopNewChat,
          timeoutMs: Math.min(config.desktopTimeoutMs, 180_000),
          signal: controller.signal,
          onDelta: () => undefined,
        },
      );
      if (result.aborted) {
        throw new RewriteCancelled();
      }
      return result.text;
    } finally {
      sub.dispose();
    }
  }

  const client = new ArkClient(config);
  const sub = token.onCancellationRequested(() => client.abort('用户取消行内改写'));
  let buffer = '';
  try {
    await client.chatStream(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: user },
      ],
      (delta) => {
        if (delta.deltaText) {
          buffer += delta.deltaText;
        }
      },
      {
        maxTokens: Math.max(1024, Math.min(config.maxTokens, 8192)),
        temperature: config.temperature,
        timeoutMs: 120_000,
      },
    );
  } finally {
    sub.dispose();
  }
  return buffer;
}

function relativePath(document: vscode.TextDocument): string {  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!folder) {
    return document.uri.fsPath;
  }
  return path.relative(folder.uri.fsPath, document.uri.fsPath).split(path.sep).join('/');
}

/**
 * 行内改写：选区 → 指令 → Ark → diff 预览 → WorkspaceEdit 应用。
 * 绑定快捷键 Ctrl+Alt+I（见 package.json keybindings）。
 */
export async function runInlineEdit(context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('请先打开一个文件，再选中代码执行行内改写。');
    return;
  }
  const document = editor.document;
  const selection = editor.selection;
  if (selection.isEmpty) {
    vscode.window.showInformationMessage('请先选中要改写的代码，再按 Ctrl+Alt+I。');
    return;
  }
  if (document.uri.scheme !== 'file') {
    vscode.window.showInformationMessage('行内改写只支持本地文件。');
    return;
  }

  const config = readConfig();
  if (!(await ensureConfigured(config))) {
    return;
  }

  const lastInstruction = context.workspaceState.get<string>('doubao.lastInstruction', '');
  const instruction = await vscode.window.showInputBox({
    title: '豆包 · 行内改写',
    prompt: '描述你希望如何改写选中的代码（例如：改成 async/await、补充错误处理、加日志）',
    value: lastInstruction,
    ignoreFocusOut: true,
    placeHolder: '改写要求…',
  });
  if (!instruction || !instruction.trim()) {
    return;
  }
  await context.workspaceState.update('doubao.lastInstruction', instruction.trim());

  const selected = document.getText(selection);
  if (selected.length > 20000) {
    vscode.window.showWarningMessage('选中的代码太长（超过 20000 字符），请缩小选区。');
    return;
  }

  const relative = relativePath(document);
  const fullText = document.getText();
  const beforeOffset = document.offsetAt(selection.start);
  const afterOffset = document.offsetAt(selection.end);
  const before = fullText.slice(Math.max(0, beforeOffset - 1500), beforeOffset);
  const after = fullText.slice(afterOffset, Math.min(fullText.length, afterOffset + 800));

  const { system, user } = inlineEditMessages({
    instruction: instruction.trim(),
    code: selected,
    languageId: document.languageId,
    relativePath: relative,
    before,
    after,
  });
  // 桌面端通道下，提示词里的模型要和豆包界面里实际选中的一致
  const desktopModel = config.authMode === 'desktop'
    ? await getDesktopModel(config.desktopPort).catch(() => undefined)
    : undefined;
  const systemPrompt = `${await buildSystemPrompt(
    config,
    desktopModel ? { model: desktopModel.currentModel, reasoning: desktopModel.reasoning } : undefined,
  )}\n\n${system}`;

  let raw = '';
  try {
    raw = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: config.authMode === 'desktop' ? '豆包（桌面端）正在改写选中代码…' : '豆包正在改写选中代码…',
        cancellable: true,
      },
      async (_progress, token) => generateRewrite(config, systemPrompt, user, token),
    );
  } catch (err) {
    if (err instanceof ArkError && err.aborted) {
      vscode.window.showInformationMessage('已取消行内改写，原文件未修改。');
      return;
    }
    if (err instanceof RewriteCancelled) {
      vscode.window.showInformationMessage('已取消行内改写，原文件未修改。');
      return;
    }
    logError('行内改写失败', err);
    vscode.window.showErrorMessage(`行内改写失败：${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  let newText = stripCodeFence(raw);
  newText = newText.replace(/^\n+/, '').replace(/\s+$/, '');
  if (!newText.trim()) {
    vscode.window.showWarningMessage('豆包没有返回可用的改写结果，请换个说法再试。');
    return;
  }
  if (newText === selected) {
    vscode.window.showInformationMessage('豆包返回的内容与原代码一致，未做修改。');
    return;
  }

  const previewFull = `${fullText.slice(0, beforeOffset)}${newText}${fullText.slice(afterOffset)}`;
  const previewUri = registerPreviewContent(previewFull, path.extname(document.uri.fsPath));
  const title = `豆包改写预览：${relative}（左=当前，右=改写后）`;
  await vscode.commands.executeCommand('vscode.diff', document.uri, previewUri, title);

  const choice = await vscode.window.showInformationMessage(
    '是否应用豆包的改写？',
    { modal: true, detail: `文件：${relative}\n范围：第 ${selection.start.line + 1}–${selection.end.line + 1} 行\n\n应用后可用命令“查看/撤销上一次改动”回退。` },
    '应用改动',
  );
  if (choice !== '应用改动') {
    vscode.window.showInformationMessage('已取消改写，原文件未修改。');
    return;
  }

  try {
    const fresh = await vscode.workspace.openTextDocument(document.uri);
    const range = fresh.validateRange(selection);
    await replaceRange(context, fresh, range, newText, 'inline-edit');
    log('行内改写已应用', relative, `${selected.length}字 → ${newText.length}字`);
    vscode.window.showInformationMessage('已应用豆包的改写。');
  } catch (err) {
    logError('应用改写失败', err);
    vscode.window.showErrorMessage(`应用改写失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 打开“上一次改动”的 diff；并可一键撤销。 */
export async function showLastDiff(context: vscode.ExtensionContext): Promise<void> {
  const record = lastEdit(context);
  if (!record) {
    vscode.window.showInformationMessage('还没有可对比的改动。先让 Agent 改文件，或用 Ctrl+Alt+I 行内改写。');
    return;
  }
  const uri = vscode.Uri.parse(record.uri);
  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(uri);
  } catch {
    vscode.window.showWarningMessage('上次改动对应的文件已不存在，无法对比。');
    return;
  }

  const oldUri = registerPreviewContent(record.oldText, path.extname(uri.fsPath));
  const title = `豆包改动对比：${relativePath(document)}（左=改动前，右=当前）`;
  await vscode.commands.executeCommand('vscode.diff', oldUri, uri, title);

  const choice = await vscode.window.showInformationMessage(
    '这是豆包上一次对文件的改动。',
    { modal: false, detail: `来源：${record.source}\n时间：${new Date(record.timestamp).toLocaleString()}` },
    '撤销这次改动',
    '关闭',
  );
  if (choice === '撤销这次改动') {
    await undoLastEdit(context);
  }
}

/** 撤销上一次改动（恢复到旧内容）。 */
export async function undoLastEdit(context: vscode.ExtensionContext): Promise<boolean> {
  const record = lastEdit(context);
  if (!record) {
    vscode.window.showInformationMessage('没有可撤销的改动。');
    return false;
  }
  const uri = vscode.Uri.parse(record.uri);
  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(uri);
  } catch {
    vscode.window.showWarningMessage('上次改动对应的文件已不存在，无法撤销。');
    return false;
  }

  try {
    if (record.kind === 'range' && record.range) {
      const range = document.validateRange(
        new vscode.Range(
          record.range.startLine,
          record.range.startCharacter,
          record.range.endLine,
          record.range.endCharacter,
        ),
      );
      const current = document.getText(range);
      if (current !== record.newText) {
        const proceed = await vscode.window.showWarningMessage(
          '该范围的内容在改动后又被修改过，撤销会覆盖这些修改，是否继续？',
          { modal: true },
          '仍然撤销',
        );
        if (proceed !== '仍然撤销') {
          return false;
        }
      }
      await replaceRange(context, document, range, record.oldText, 'undo');
    } else {
      await replaceWholeFile(context, uri, record.oldText, 'undo');
    }
    await context.workspaceState.update(LAST_EDIT_KEY, undefined);
    vscode.window.showInformationMessage('已撤销豆包上一次改动。');
    log('已撤销改动', uri.fsPath, record.kind);
    return true;
  } catch (err) {
    logError('撤销改动失败', err);
    vscode.window.showErrorMessage(`撤销失败：${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** 供诊断/状态栏使用：当前是否有可撤销的改动。 */
export function describeLastEdit(context: vscode.ExtensionContext): string {
  const record: LastEditRecord | undefined = lastEdit(context);
  if (!record) {
    return '无';
  }
  return `${path.basename(record.uri)} (${record.source})`;
}
