import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { resolveInsideRoot, workspaceRoot, type DoubaoConfig } from '../config';
import { debug, warn } from '../log';
import { truncate } from '../agent/tools';
import { describeModel } from './model-label';

const RULES_LIMIT = 6000;
const SELECTION_LIMIT = 12000;
const MENTION_FILE_LIMIT = 8000;
const DIAGNOSTIC_LIMIT = 60;

/** 内置系统提示词（中文），强调工具使用与最小改动。 */
export const BASE_SYSTEM_PROMPT = `你是「豆包编程助手」，一个运行在 VS Code 里的工程级编程 Agent。

## 工作方式
- 先理解再动手：需要了解代码时，用 read_file / list_dir / grep 查看真实内容，不要凭记忆猜测。
- 修改代码优先用 apply_patch 做精确替换；只有新建文件或整体重写时才用 write_file。
- 需要编译、运行测试或查看环境时用 run_terminal。命令必须是单次、非交互、可在 Windows PowerShell/cmd 下执行完成的。
- 改动后用 get_diagnostics 自检；涉及编译/测试的改动优先用 run_checks 跑工程自检，失败就根据诊断继续修。
- 一次只解决用户当前提出的问题；不要顺手重构无关代码，不要删除用户没要求的文件。

## 输出要求
- 用中文回答，简洁、直接、可执行；先给结论，再给关键步骤。
- 代码块要标注语言，代码块内容应是最终可用的完整片段。
- 提到文件时用 \`相对路径:行号\` 的形式，方便用户跳转。
- 不要在回复里粘贴超长文件内容；需要展示时只贴改动片段。
- 不确定的地方要明确说明，并给出验证方式（编译/测试/复现步骤）。

## 安全约束
- 不要执行危险命令（删除仓库、格式化磁盘、修改全局配置、上传密钥等）。
- 不要在代码或命令里暴露用户的 API Key。
- 涉及破坏性操作时，先解释再请求确认。`;

/** 读取自定义系统提示词文件（绝对路径或工作区相对路径）。 */
async function readCustomPrompt(config: DoubaoConfig): Promise<string> {
  if (!config.systemPromptFile) {
    return '';
  }
  const root = workspaceRoot();
  const target = path.isAbsolute(config.systemPromptFile)
    ? config.systemPromptFile
    : root
      ? resolveInsideRoot(root, config.systemPromptFile)
      : '';
  if (!target) {
    return '';
  }
  try {
    const text = await fs.readFile(target, 'utf8');
    debug('已加载自定义系统提示词', target, `${text.length}字`);
    return text;
  } catch (err) {
    warn('读取 systemPromptFile 失败', target, err instanceof Error ? err.message : String(err));
    return '';
  }
}

/** 读取项目规则文件（默认 .doubao/rules.md）。 */
export async function readRules(config: DoubaoConfig): Promise<string> {
  if (!config.rulesFile) {
    return '';
  }
  const root = workspaceRoot();
  if (!root) {
    return '';
  }
  let target: string;
  try {
    target = path.isAbsolute(config.rulesFile) ? config.rulesFile : resolveInsideRoot(root, config.rulesFile);
  } catch (err) {
    warn('rulesFile 路径越界', err instanceof Error ? err.message : String(err));
    return '';
  }
  try {
    const text = await fs.readFile(target, 'utf8');
    debug('已加载规则文件', target, `${text.length}字`);
    return text.trim().slice(0, RULES_LIMIT);
  } catch {
    return '';
  }
}

/** 拼装最终系统提示词：自定义/内置 + 项目规则 + 环境信息。 */
export async function buildSystemPrompt(
  config: DoubaoConfig,
  effective?: { model?: string; reasoning?: string },
): Promise<string> {
  const custom = await readCustomPrompt(config);
  const rules = await readRules(config);
  const parts = [custom.trim() || BASE_SYSTEM_PROMPT];

  // 用户实际选择的模型/推理强度（不要写死，界面和提示词必须一致）。
  // 桌面端通道下，真正生效的是豆包界面里选中的模型（如 DeepSeek V4.1 Flash），
  // 不是 Ark 的 config.model；调用方要把工具栏上的值传进来。
  const model = String(effective?.model || config.model || '').trim() || '未指定';
  const reasoning = String(effective?.reasoning ?? config.desktopReasoning ?? '').trim();
  parts.unshift(
    `你是「豆包编程助手」，一个运行在 VS Code 里的工程级编程 Agent。\n` +
      `${describeModel(model, reasoning)}\n` +
      `能力边界：你能读写文件、搜索代码、执行命令、跑测试；不能长期驻留服务、不能操作浏览器之外的 GUI。`,
  );

  parts.push(`## 运行环境\n- 操作系统：${process.platform}（${process.arch}）\n- 编辑器：VS Code ${vscode.version}`);

  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length > 0) {
    parts.push(`## 工作区\n${folders.map((folder) => `- ${folder.name}: ${folder.uri.fsPath}`).join('\n')}`);
  } else {
    parts.push('## 工作区\n- 当前没有打开文件夹，文件类工具不可用。');
  }
  if (vscode.workspace.isTrusted === false) {
    parts.push('## 注意\n- 当前是受限模式（Restricted Mode），写文件与执行命令会被拒绝。');
  }
  if (rules) {
    parts.push(`## 项目规则（来自 ${config.rulesFile}）\n${rules}`);
  }
  return parts.join('\n\n');
}

export interface ContextRefs {
  /** 附带当前打开文件的路径与语言。 */
  currentFile?: boolean;
  /** 附带当前选区文本。 */
  selection?: boolean;
  /** 附带当前文件的诊断信息。 */
  diagnostics?: boolean;
}

function diagnosticText(uri: vscode.Uri): string {
  const diagnostics = vscode.languages.getDiagnostics(uri);
  if (diagnostics.length === 0) {
    return '';
  }
  const lines = diagnostics.slice(0, DIAGNOSTIC_LIMIT).map((diagnostic) => {
    const severity = vscode.DiagnosticSeverity[diagnostic.severity] ?? 'Unknown';
    return `- [${severity}] 第 ${diagnostic.range.start.line + 1} 行：${diagnostic.message}`;
  });
  const more = diagnostics.length > DIAGNOSTIC_LIMIT ? `\n- …（共 ${diagnostics.length} 条）` : '';
  return lines.join('\n') + more;
}

/** 从消息里解析 @path 形式的手动引用。 */
export function extractMentions(text: string): string[] {
  const mentions = new Set<string>();
  const regex = /(?:^|\s)@([\w./\\-]+)/g;
  let match = regex.exec(text);
  while (match) {
    const value = match[1].replace(/[.,;:]+$/, '');
    if (value && !value.startsWith('@')) {
      mentions.add(value);
    }
    match = regex.exec(text);
  }
  return [...mentions];
}

/** 读取被 @ 的文件内容，拼成上下文段落。 */
async function readMentionedFiles(text: string): Promise<string[]> {
  const mentions = extractMentions(text);
  if (mentions.length === 0) {
    return [];
  }
  const root = workspaceRoot();
  if (!root) {
    return [];
  }
  const sections: string[] = [];
  for (const mention of mentions.slice(0, 6)) {
    let target: string;
    try {
      target = resolveInsideRoot(root, mention);
    } catch {
      sections.push(`### @${mention}\n（路径越界，已忽略）`);
      continue;
    }
    const stats = await fs.stat(target).catch(() => null);
    if (stats && stats.isDirectory()) {
      const entries = await fs.readdir(target).catch(() => [] as string[]);
      sections.push(
        `### @${mention}（目录，${entries.length} 项）` +
          '\n' + entries.slice(0, 80).map((entry) => '- ' + entry).join('\n'),
      );
      continue;
    }
    try {
      const content = await fs.readFile(target, 'utf8');
      sections.push(`### @${mention}\n\`\`\`\n${truncate(content, MENTION_FILE_LIMIT)}\n\`\`\``);
    } catch {
      sections.push(`### @${mention}\n（文件不存在或无法读取）`);
    }
  }
  return sections;
}

/**
 * 组装一条用户消息：原始文本 + @文件 + 当前文件/选区/诊断上下文。
 * 上下文用 <context> 包裹，便于模型区分“指令”和“素材”。
 */
export async function buildUserContent(rawText: string, refs: ContextRefs): Promise<string> {
  const sections: string[] = [];

  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const document = editor.document;
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    const relative = folder ? path.relative(folder.uri.fsPath, document.uri.fsPath).split(path.sep).join('/') : document.uri.fsPath;

    if (refs.currentFile) {
      sections.push(`### 当前文件\n- 路径：${relative}\n- 语言：${document.languageId}\n- 行数：${document.lineCount}`);
    }
    if (refs.selection) {
      const selection = editor.selection;
      if (!selection.isEmpty) {
        const selected = document.getText(selection);
        sections.push(
          `### 当前选区（${relative}:${selection.start.line + 1}-${selection.end.line + 1}）\n\`\`\`${document.languageId}\n${truncate(selected, SELECTION_LIMIT)}\n\`\`\``,
        );
      }
    }
    if (refs.diagnostics) {
      const text = diagnosticText(document.uri);
      if (text) {
        sections.push(`### 当前文件诊断\n${text}`);
      }
    }
  }

  const mentioned = await readMentionedFiles(rawText);
  sections.push(...mentioned);

  if (sections.length === 0) {
    return rawText;
  }
  return `${rawText}\n\n<context>\n${sections.join('\n\n')}\n</context>`;
}

/** 解释选中代码时使用的固定指令。 */
export function explainInstruction(languageId: string): string {
  return `请解释下面这段 ${languageId} 代码：先说明它的整体作用，再逐段说明关键逻辑、边界条件和潜在问题；语言要通俗，必要时给出更简洁的等价写法。`;
}

/** 行内改写时使用的提示词。 */
export function inlineEditMessages(input: {
  instruction: string;
  code: string;
  languageId: string;
  relativePath: string;
  before: string;
  after: string;
}): { system: string; user: string } {
  const system = [
    '你是代码改写引擎，只输出改写后的代码本身。',
    '严格要求：不要输出解释、不要输出 markdown 代码块标记、不要重复原代码前后的内容。',
    '保持原有的缩进风格与引号风格；如果不需要改动，原样返回输入代码。',
  ].join('\n');

  const user = [
    `文件：${input.relativePath}`,
    `语言：${input.languageId}`,
    `改写要求：${input.instruction}`,
    '',
    '待改写代码（只返回这一段的改写结果）：',
    '<<<CODE',
    input.code,
    'CODE>>>',
    '',
    '前文（仅供参考，不要输出）：',
    '<<<BEFORE',
    input.before,
    'BEFORE>>>',
    '',
    '后文（仅供参考，不要输出）：',
    '<<<AFTER',
    input.after,
    'AFTER>>>',
  ].join('\n');

  return { system, user };
}

/** 去掉模型可能带上的 ``` 包裹。 */
export function stripCodeFence(text: string): string {
  let result = text.trim();
  const fence = /^```[a-zA-Z0-9_+-]*\s*\n([\s\S]*?)\n?```$/;
  const match = fence.exec(result);
  if (match) {
    result = match[1];
  }
  return result.replace(/^\uFEFF/, '').replace(/\s+$/, '');
}
