import * as vscode from 'vscode';
import { log, warn } from './log';
import type { McpServerConfig } from './mcp/client';

export const CONFIG_SECTION = 'doubao';

export interface DoubaoConfig {
  /**
   * 接入模式：
   * - `desktop`：用已登录的豆包桌面端（CDP 驱动），不需要 API Key；
   * - `ark`：走火山方舟 OpenAI 兼容接口，需要 API Key。
   */
  authMode: 'desktop' | 'ark';
  baseUrl: string;
  apiKey: string;
  model: string;
  completionModel: string;
  temperature: number;
  maxTokens: number;
  maxToolIterations: number;
  enableInlineCompletion: boolean;
  systemPromptFile: string;
  rulesFile: string;
  terminalAutoRun: boolean;
  mcpEnabled: boolean;
  /** 桌面端调试端口（默认 9222）。 */
  desktopPort: number;
  /** 每次提问前是否新开一个对话。 */
  desktopNewChat: boolean;
  /** 等待桌面端回复的最长时间。 */
  desktopTimeoutMs: number;
  /** 豆包可执行文件路径（用于“以调试端口启动”）。 */
  desktopExePath: string;
  /** 桌面端通道下是否启用 PTC（文本工具调用）。 */
  ptcEnabled: boolean;
  /** PTC 最大工具轮数。 */
  ptcMaxRounds: number;
  /** 任务模式的本地执行确认策略。 */
  taskPermission: 'ask' | 'risk' | 'allow';
  /** 任务模式最多执行多少步。 */
  taskMaxSteps: number;
  /** 本地模式直接交给豆包自己的本地电脑 agent（过程与豆包界面一致）。 */
  taskNative: boolean;
  /** 豆包安装路径（手动指定时优先）。 */
  installPath: string;
  /** 调用安装目录里的 Python SDK 时用的解释器。 */
  pythonPath: string;
  /** 本地电脑后端选择。 */
  computerBackend: 'auto' | 'doubao' | 'win32';
  /** apiKey 来源：secret / settings / env / missing，用于状态提示与日志。 */
  apiKeySource: 'secret' | 'settings' | 'env' | 'missing';
  /** 外部 MCP server 列表（doubao.mcp.servers），空数组表示不启用。 */
  mcpServers: McpServerConfig[];
  /** 侧边栏默认模式：chat=普通对话；local=本地电脑（任务模式）。 */
  chatMode: 'chat' | 'local';
  /** 桌面端工作模式：auto=跟着扩展模式；local=工作任务·本地电脑；chat=对话。 */
  desktopWorkMode: 'auto' | 'local' | 'chat';
  /** 本地电脑模式下希望使用的桌面端模型（空=不改，跟随桌面端当前选择）。 */
  desktopModel: string;
  /** 本地电脑模式下希望使用的推理强度（空=不改）。 */
  desktopReasoning: '低' | '中' | '高' | '极高' | '';
  /** 回合结束后是否自动选「继续说」（默认开）。 */
  autoContinue: boolean;
  /** 自动继续的倒计时秒数；0 表示关闭。 */
  autoContinueSeconds: number;
  /** 初始化时把豆包「AI 生成水印」设为无水印（默认开）。 */
  applyNoWatermark: boolean;
  /** 面板打开时是否自动切回上次豆包窗口（默认关，避免抢当前任务）。 */
  restoreLastWindow: boolean;
  /** 写文件前先进入审阅（默认开，AI 改动需用户接受才落盘）。 */
  reviewEdits: boolean;
  /** 构建/测试验证命令（空则自动检测）。 */
  verifyBuildCommand: string;
  verifyTestCommand: string;
  /** 接受 AI 改动后自动运行构建/测试（默认开）。 */
  autoVerifyAfterAccept: boolean;
}

/**
 * SecretStorage 里的 API Key（优先级最高）。
 * 模块级缓存：readConfig() 是同步函数，而 SecretStorage 是异步的，
 * 因此激活时先 loadSecretApiKey() 把值取到内存，之后同步读取。
 */
let secretApiKey = '';
const SECRET_KEY = 'doubao.apiKey';

export async function loadSecretApiKey(context: vscode.ExtensionContext): Promise<void> {
  try {
    secretApiKey = (await context.secrets.get(SECRET_KEY)) ?? '';
  } catch (err) {
    secretApiKey = '';
    warn('读取 SecretStorage 失败', err instanceof Error ? err.message : String(err));
  }
}

export async function saveSecretApiKey(context: vscode.ExtensionContext, value: string): Promise<void> {
  const trimmed = value.trim();
  if (trimmed) {
    await context.secrets.store(SECRET_KEY, trimmed);
  } else {
    await context.secrets.delete(SECRET_KEY);
  }
  secretApiKey = trimmed;
}

export function hasSecretApiKey(): boolean {
  return secretApiKey.length > 0;
}

export interface ConfigValidation {
  ok: boolean;
  problems: string[];
}

const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

function getWorkspaceConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(CONFIG_SECTION);
}

function envFirst(names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return '';
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function asNumber(value: unknown, fallback: number, min?: number, max?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  let result = value;
  if (typeof min === 'number') {
    result = Math.max(min, result);
  }
  if (typeof max === 'number') {
    result = Math.min(max, result);
  }
  return result;
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** 只取用户显式写入的值（忽略 manifest 默认值），用于“默认允许”的权限项。 */
function explicitConfigValue<T>(cfg: vscode.WorkspaceConfiguration, key: string): T | undefined {
  if (typeof cfg.inspect !== 'function') {
    return undefined;
  }
  const info = cfg.inspect<T>(key);
  return info?.globalValue ?? info?.workspaceValue ?? info?.workspaceFolderValue ?? undefined;
}

function normalizePermission(value: unknown): 'ask' | 'risk' | 'allow' {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return raw === 'ask' || raw === 'risk' ? raw : 'allow';
}

function normalizeBackend(value: unknown): 'auto' | 'doubao' | 'win32' {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return raw === 'doubao' || raw === 'win32' ? raw : 'auto';
}

function normalizeDesktopWorkMode(value: unknown): 'auto' | 'local' | 'chat' {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return raw === 'local' || raw === 'chat' ? raw : 'auto';
}

function normalizeReasoning(value: unknown): '低' | '中' | '高' | '极高' | '' {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw === '低' || raw === '中' || raw === '高' || raw === '极高' ? raw : '';
}


/**
 * 解析 `doubao.mcp.servers`。
 * 配置项是用户在 settings.json 里手写的，这里做一次宽容归一化：
 * 缺 name/command、名字重复、类型不对的条目直接忽略，不让坏配置拖垮激活。
 */
function parseMcpServers(value: unknown): McpServerConfig[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: McpServerConfig[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    const command = typeof record.command === 'string' ? record.command.trim() : '';
    if (!name || !command || seen.has(name)) {
      continue;
    }
    const server: McpServerConfig = { name, command };
    if (Array.isArray(record.args)) {
      server.args = record.args.filter((arg): arg is string => typeof arg === 'string');
    }
    if (typeof record.env === 'object' && record.env !== null && !Array.isArray(record.env)) {
      const env: Record<string, string> = {};
      for (const [key, envValue] of Object.entries(record.env as Record<string, unknown>)) {
        if (typeof envValue === 'string') {
          env[key] = envValue;
        }
      }
      if (Object.keys(env).length > 0) {
        server.env = env;
      }
    }
    if (typeof record.cwd === 'string' && record.cwd.trim()) {
      server.cwd = record.cwd.trim();
    }
    if (typeof record.enabled === 'boolean') {
      server.enabled = record.enabled;
    }
    if (typeof record.timeoutMs === 'number' && Number.isFinite(record.timeoutMs)) {
      server.timeoutMs = record.timeoutMs;
    }
    result.push(server);
    seen.add(name);
  }
  return result;
}

/**
 * 读取并归一化所有 `doubao.*` 配置。
 * API Key 优先级：SecretStorage > settings(doubao.apiKey) > ARK_API_KEY / DOUBAO_API_KEY 环境变量。
 */
export function readConfig(): DoubaoConfig {
  const cfg = getWorkspaceConfig();

  const settingsKey = asString(cfg.get<string>('apiKey'), '');
  const envKey = envFirst(['ARK_API_KEY', 'DOUBAO_API_KEY']);
  const apiKey = secretApiKey || settingsKey || envKey;
  const apiKeySource: DoubaoConfig['apiKeySource'] = secretApiKey
    ? 'secret'
    : settingsKey
      ? 'settings'
      : envKey
        ? 'env'
        : 'missing';

  const model = asString(cfg.get<string>('model'), envFirst(['ARK_MODEL', 'DOUBAO_MODEL']) || 'doubao-seed-code');
  const completionModel = asString(cfg.get<string>('completionModel'), model);
  const baseUrl = normalizeBaseUrl(
    asString(cfg.get<string>('baseUrl'), envFirst(['ARK_BASE_URL', 'DOUBAO_BASE_URL']) || DEFAULT_BASE_URL),
  );
  const authModeRaw = asString(cfg.get<string>('authMode'), 'desktop').toLowerCase();
  const authMode: DoubaoConfig['authMode'] = authModeRaw === 'ark' ? 'ark' : 'desktop';

  return {
    authMode,
    baseUrl,
    apiKey,
    model,
    completionModel,
    temperature: asNumber(cfg.get<number>('temperature'), 0.2, 0, 2),
    maxTokens: Math.round(asNumber(cfg.get<number>('maxTokens'), 4096, 1)),
    maxToolIterations: Math.round(asNumber(cfg.get<number>('maxToolIterations'), 16, 1, 80)),
    enableInlineCompletion: asBool(cfg.get<boolean>('enableInlineCompletion'), true),
    systemPromptFile: asString(cfg.get<string>('systemPromptFile'), ''),
    rulesFile: asString(cfg.get<string>('rulesFile'), '.doubao/rules.md'),
    terminalAutoRun: explicitConfigValue<boolean>(cfg, 'terminal.autoRun') ?? true,
    mcpEnabled: asBool(cfg.get<boolean>('mcp.enabled'), false),
    desktopPort: Math.round(asNumber(cfg.get<number>('desktop.port'), 9222, 1, 65535)),
    desktopNewChat: asBool(cfg.get<boolean>('desktop.newChat'), false),
    desktopTimeoutMs: Math.round(asNumber(cfg.get<number>('desktop.timeoutMs'), 180_000, 10_000, 900_000)),
    desktopExePath: asString(cfg.get<string>('desktop.exePath'), defaultDoubaoExe()),
    ptcEnabled: asBool(cfg.get<boolean>('ptc.enabled'), true),
    ptcMaxRounds: Math.round(asNumber(cfg.get<number>('ptc.maxRounds'), 8, 1, 24)),
    taskPermission: normalizePermission(explicitConfigValue<string>(cfg, 'task.permission') ?? 'allow'),
    taskMaxSteps: Math.round(asNumber(cfg.get<number>('task.maxSteps'), 30, 1, 80)),
    taskNative: cfg.get<boolean>('task.native') !== false,
    installPath: asString(cfg.get<string>('installPath'), ''),
    pythonPath: asString(cfg.get<string>('pythonPath'), 'python'),
    computerBackend: normalizeBackend(cfg.get<string>('computer.backend')),
    apiKeySource,
    mcpServers: parseMcpServers(cfg.get<unknown>('mcp.servers')),
    chatMode: cfg.get<string>('chat.mode') === 'local' ? 'local' : 'chat',
    desktopWorkMode: normalizeDesktopWorkMode(cfg.get<string>('desktop.workMode')),
    desktopModel: asString(cfg.get<string>('desktop.model'), ''),
    desktopReasoning: normalizeReasoning(cfg.get<string>('desktop.reasoning')),
    autoContinue: asBool(cfg.get<boolean>('autoContinue'), true),
    autoContinueSeconds: Math.round(asNumber(cfg.get<number>('autoContinueSeconds'), 5, 0, 120)),
    applyNoWatermark: asBool(cfg.get<boolean>('applyNoWatermark'), true),
    restoreLastWindow: asBool(cfg.get<boolean>('restoreLastWindow'), false),
    reviewEdits: asBool(cfg.get<boolean>('reviewEdits'), true),
    verifyBuildCommand: String(cfg.get<string>('verify.buildCommand') || '').trim(),
    verifyTestCommand: String(cfg.get<string>('verify.testCommand') || '').trim(),
    autoVerifyAfterAccept: asBool(cfg.get<boolean>('verify.afterAccept'), true),
  };
}

/** 默认的豆包可执行文件位置（按当前用户 %LOCALAPPDATA% 推导）。 */
export function defaultDoubaoExe(): string {
  const base = process.env.LOCALAPPDATA || '';
  if (!base) {
    return '';
  }
  const path = require('node:path') as typeof import('node:path');
  return path.join(base, 'Doubao', 'Application', 'app', 'Doubao.exe');
}

export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim();
  if (!url) {
    return DEFAULT_BASE_URL;
  }
  url = url.replace(/\/+$/, '');
  // 允许用户只填域名，自动补上 /api/v3。
  if (/^https?:\/\/[^/]+$/i.test(url)) {
    url = `${url}/api/v3`;
  }
  return url;
}

/** 校验配置，返回中文问题列表；ok 为 true 时表示可以发起请求。 */
export function validateConfig(config: DoubaoConfig): ConfigValidation {
  const problems: string[] = [];
  if (config.authMode === 'ark') {
    if (!config.apiKey) {
      problems.push('未配置 API Key：请执行「豆包: 设置 API Key」，或设置环境变量 ARK_API_KEY。');
    }
    if (!/^https?:\/\//i.test(config.baseUrl)) {
      problems.push(`baseUrl 不合法：${config.baseUrl}`);
    }
    if (!config.model) {
      problems.push('未配置模型：请填写 doubao.model（例如 doubao-seed-code）。');
    }
    if (config.apiKey && /[\s]/.test(config.apiKey)) {
      problems.push('apiKey 中包含空白字符，请检查是否复制错误。');
    }
  } else if (!config.desktopExePath) {
    problems.push('没有找到豆包安装路径：请配置 doubao.desktop.exePath。');
  }
  return { ok: problems.length === 0, problems };
}

/** 校验失败时弹出一次带“打开设置”按钮的提示。 */
export async function ensureConfigured(config: DoubaoConfig): Promise<boolean> {
  const validation = validateConfig(config);
  if (validation.ok) {
    return true;
  }
  warn('配置校验失败', validation.problems.join(' | '));
  const action = await vscode.window.showWarningMessage(
    validation.problems[0],
    { modal: false },
    '打开设置',
    '显示日志',
  );
  if (action === '打开设置') {
    await vscode.commands.executeCommand('doubao.openSettings');
  } else if (action === '显示日志') {
    await vscode.commands.executeCommand('doubao.showLogs');
  }
  return false;
}

/** 工作区根目录（单根工作区取第一个文件夹；多根工作区取活动编辑器所在根）。 */
export function workspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active && folders.length > 1) {
    const owner = vscode.workspace.getWorkspaceFolder(active);
    if (owner) {
      return owner.uri.fsPath;
    }
  }
  return folders[0].uri.fsPath;
}

/**
 * 取路径的真实路径；目标还不存在（例如要新建文件）时，取最近的已存在祖先的真实路径，
 * 再把剩余路径段拼回去。用于识破 junction / symlink 指向工作区外的情况。
 */
function realPathForBoundary(target: string): string {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  try {
    return fs.realpathSync.native(target);
  } catch {
    /* 目标不存在，继续找祖先 */
  }
  let current = target;
  const suffix: string[] = [];
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) {
      return target;
    }
    suffix.unshift(path.basename(current));
    current = parent;
    try {
      return path.join(fs.realpathSync.native(current), ...suffix);
    } catch {
      /* 继续向上 */
    }
  }
}

/** 把相对路径解析成绝对路径，拒绝越界（`..` 逃逸与 symlink/junction 逃逸）。 */
export function resolveInsideRoot(root: string, relativeOrAbsolute: string): string {
  const path = require('node:path') as typeof import('node:path');
  const target = path.isAbsolute(relativeOrAbsolute)
    ? path.normalize(relativeOrAbsolute)
    : path.resolve(root, relativeOrAbsolute);
  const realRoot = realPathForBoundary(root);
  const realTarget = realPathForBoundary(target);
  const comparable = realTarget.endsWith(path.sep) ? realTarget : realTarget + path.sep;
  const rootCmp = (realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep).toLowerCase();
  if (!comparable.toLowerCase().startsWith(rootCmp) && realTarget.toLowerCase() !== realRoot.toLowerCase()) {
    throw new Error(`路径越界：${relativeOrAbsolute} 不在工作区 ${root} 内（或经符号链接指向了工作区外）`);
  }
  return target;
}

export function configSignature(config: DoubaoConfig): string {
  return [config.baseUrl, config.model, config.apiKeySource, String(config.enableInlineCompletion), String(config.mcpServers.length)].join('|');
}

/** 配置变更时记录一条日志，方便排查“改了设置没生效”。 */
export function watchConfig(onChange: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(CONFIG_SECTION)) {
      const cfg = readConfig();
      log('配置已更新', configSignature(cfg), `maxToolIterations=${cfg.maxToolIterations}`);
      onChange();
    }
  });
}
