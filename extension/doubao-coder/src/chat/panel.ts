import * as fs from 'node:fs';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ArkMessage } from '../ark/client';
import { AgentLoop, trimHistory, type ToolStartEvent } from '../agent/loop';
import type { ExternalToolRouter, ToolRuntime } from '../agent/tools';
import { ArkError, ArkClient } from '../ark/client';
import { ensureConfigured, readConfig, resolveInsideRoot, validateConfig, workspaceRoot, type DoubaoConfig } from '../config';
import { askDesktop, chooseDesktopOption, isDesktopRunning, readDesktopConversationId, readDesktopTitle, watchDesktop } from '../bridge/desktop';
import { SyncPoller, type SyncSnapshot } from '../bridge/sync-poller';
import type { ReplyBlock } from '../bridge/blocks';
import {
  createDesktopConversation,
  getDesktopMode,
  getDesktopModel,
  listDesktopModels,
  selectDesktopModel,
  setDesktopMode,
  setDesktopReasoning,
} from '../bridge/desktop-control';
import { checkEnvironment, type SetupState } from '../doubao/setup';
import { listDesktopPlugins, listDesktopSkills, type DesktopPlugin, type DesktopSkillGroup } from '../bridge/desktop-catalog';
import { PtcAgent, buildPtcPromptSection } from '../agent/ptc';
import { TaskRunner } from '../agent/task';
import { error as logErrorLevel, log, warn } from '../log';
import { buildSystemPrompt, buildUserContent, type ContextRefs } from './prompt';
import { convertLocalImages, localImagePath, mimeForImage } from './local-images';
import { activeDesktopId, activeDesktopTitle, desktopTarget, hasConversation, localTarget, matchConversation, noneTarget, normalizeTitle, shouldRestoreLastWindow, type ActiveTarget } from './active-target';
import { addTab, nextActiveAfterClose, refreshTitle, removeTab, restoreTabs as restoreTabList, shouldAbortOnSwitch } from './tabs';
import { runVerify, type VerifyKind } from './verify';
import { applyHunks, computeHunks, type DiffHunk } from './diff';
import { pickEffectiveModel } from './model-label';
import { parseMarkdownBlocks } from './ast';
import { SessionStore, newSessionId } from './sessions';
import { listDesktopConversations, openDesktopConversation, readDesktopConversation } from '../bridge/desktop-history';
import { collectAllDesktopConversations, openDesktopConversationById } from '../bridge/desktop-history-all';
import { CLI_DOC_URL, CLI_INSTALL_COMMAND, isResumeRejected, runCliTask, statusLine } from '../cli/runner';
import { checkCliAuth, detectCli } from '../cli/detect';
import { startCliLogin, readQrFile } from '../cli/login';

/** Webview → 扩展 的消息。 */
interface IncomingMessage {
  type: string;
  text?: string;
  refs?: ContextRefs;
  code?: string;
  id?: string;
  value?: string;
  url?: string;
  /** 历史菜单里点某条豆包对话时带的序号。 */
  index?: number;
  /** 审阅卡片勾选的 hunk 序号。 */
  hunks?: number[];
  /** 回复里点「文件:行」时带的路径与行号。 */
  path?: string;
  line?: number;
  /** 历史对话标题（用于按标题重新定位）。 */
  title?: string;
  /** 会话操作类型（pin/rename/archive/copyId/export/delete）。 */
  action?: string;
  /** 粘贴进来的文件（base64）。 */
  files?: Array<{ name: string; mime: string; base64: string }>;
  /** 批量操作选中的本地会话 ID。 */
  ids?: string[];
}

/** 扩展 → Webview 的消息类型（与 media/chat.js 约定一致）。 */
type OutgoingMessage =
  | { type: 'user'; text: string; at: number; images?: string[]; files?: string[] }
  | { type: 'assistant_delta'; text: string }
  | { type: 'assistant_done'; aborted: boolean; at: number; autoSuppress?: boolean }
  | { type: 'tool_start'; id: string; name: string; arguments: Record<string, unknown> }
  | { type: 'tool_end'; id: string; name: string; ok: boolean; content: string }
  | { type: 'image'; url: string; full?: string; alt?: string }
  | { type: 'ask'; question: { title: string; options: Array<{ value: string; label: string }>; allowCustom?: boolean } }
  | { type: 'generating'; text: string }
  | { type: 'modelMenu'; models: string[]; currentModel: string; reasoning: string; allowReasoning: boolean }
  | { type: 'skillMenu'; ok: boolean; groups: Array<{ title: string; items: Array<{ name: string; description: string }> }> }
  | { type: 'pluginMenu'; ok: boolean; plugins: Array<{ name: string; description: string }> }
  | { type: 'notice'; text: string }
  | { type: 'round'; index: number; plan: string[] }
  | { type: 'block'; kind: 'text' | 'code' | 'status' | 'step'; text: string; detail?: string; state?: string }
  | { type: 'blocks'; blocks: ReplyBlock[] }
  | { type: 'syncStatus'; text: string; seconds: number; done: boolean }
  | { type: 'ast'; blocks: ReturnType<typeof parseMarkdownBlocks> }
  | { type: 'mcpState'; state: Record<string, unknown> }
  | { type: 'attachments'; items: string[] }
  | { type: 'setup'; state: SetupState }
  | { type: 'historyMenu'; loading?: boolean; loadingText?: string; local: Array<{ id: string; title: string; time: string; pinned?: boolean; archived?: boolean; desktopTitle?: string; desktopId?: string; desktopMissing?: boolean }>; desktop: { ok: boolean; items: Array<{ index: number; id?: string; title: string; time: string; status?: string; running?: boolean }>; error?: string } }
  | { type: 'history'; title: string; turns: Array<{ role: 'user' | 'assistant'; text: string }> }
  | { type: 'tabs'; tabs: Array<{ id: string; title: string; active: boolean; running: boolean; desktopTitle: string }> }
  | { type: 'syncLoading'; on: boolean; text?: string }
  | { type: 'proposal'; id: string; path: string; before: string; after: string; hunks?: DiffHunk[] }
  | { type: 'workspaceFiles'; files: string[] }
  | { type: 'contextInfo'; total: number; items: Array<{ label: string; tokens: number }> }
  | { type: 'tasks'; tasks: Array<{ id: string; title: string; status: 'running' | 'done' | 'failed'; progress?: string; startedAt: number }> }
  | { type: 'sources'; items: Array<{ path: string; line: number }> }
  | { type: 'verifyStart'; kind: VerifyKind }
  | { type: 'verifyResult'; kind: VerifyKind; ok: boolean; code: number | null; command: string; output: string; error?: string; locations?: Array<{ path: string; line: number }> }
  | { type: 'catalog'; skills: DesktopSkillGroup[]; plugins: DesktopPlugin[] }
  | { type: 'error'; message: string }
  | {
      type: 'state';
      busy: boolean;
      model: string;
      apiKeyConfigured: boolean;
      apiKeySource: string;
      trusted: boolean;
      turns: number;
      mode: 'chat' | 'local';
      permission: 'ask' | 'risk' | 'allow';
      authMode: 'cli' | 'desktop' | 'ark';
      project: string;
      mcpTools: number;
      rules: boolean;
      reasoning: string;
      desktopMode: string;
      skillsCount: number;
      pluginsCount: number;
      version?: string;
      autoContinue: boolean;
      autoContinueSeconds: number;
    }
  | { type: 'clear' };

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'doubao.chatView';

  private view: vscode.WebviewView | undefined;
  private history: ArkMessage[] = [];
  private running = false;
  /** 用户点了“新建对话”：桌面端模式下下次提问强制新开一个豆包会话。 */
  private forceNewChat = false;
  private client: ArkClient | undefined;
  private abortController: AbortController | undefined;
  private disposed = false;
  /** 本地电脑模式：发送时走 TaskRunner（计划 → 单步动作 → 确认 → 执行）。 */
  private localMode = readConfig().chatMode === 'local';
  /** 桌面端当前状态缓存（模式/模型/推理强度），由 refreshDesktopInfo 刷新。 */
  private desktopModeText = '';
  private desktopModel = '';
  private desktopReasoning = '';
  private desktopSkillsCount = 0;
  private desktopPluginsCount = 0;
  /** 同步后的技能/插件列表缓存：点击菜单和按 / 都不再重新打开桌面面板。 */
  private skillGroups: DesktopSkillGroup[] = [];
  private pluginItems: DesktopPlugin[] = [];
  private catalogLoaded = false;
  /** 预读取的模型列表：对话固定快速/专家，任务列表启动时读一次后缓存。 */
  private taskModels: string[] = [
    '自动',
    '豆包 2.1 Lite',
    '豆包 2.1 Pro',
    'DeepSeek V4.1 Flash',
    'Qwen 4 Max',
    'Kimi K3.1 Pro',
    'Kimi K3.1 Pro 高速',
    'Kimi K3',
    'GLM 5.3',
    'GLM 5.3 Flash',
  ];
  private taskModel = '';
  private taskReasoning = '';
  /** 上次成功同步技能/插件的时间（毫秒），用于缓存判断。 */
  private catalogSyncAt = 0;
  /** 缓存有效期：10 分钟。 */
  private static readonly CATALOG_TTL_MS = 10 * 60 * 1000;
  /** 正在进行的技能/插件同步，避免新对话和新任务并发打开面板。 */
  private catalogSyncing: Promise<void> | undefined;
  /** 启动时只预读取一次，之后新建对话/任务不重复刷新。 */
  private preloaded = false;
  /** webview 是否已完成脚本加载并发出 ready。 */
  private webviewReady = false;
  /** webview 未 ready 前的消息先排队，避免首条消息丢失。 */
  private pendingPosts: OutgoingMessage[] = [];
  private readyWaiters: Array<() => void> = [];
  /** 生成中收到的用户消息：先回显到界面，等当前任务结束后自动发送（不丢消息）。 */
  private queuedUser: Array<{ text: string; refs: ContextRefs }> = [];
  /** 打开正在执行的历史任务时，结束后自动续一句「继续说」。 */
  private pendingContinue = false;
  /** 每个面板实例只尝试恢复一次上次窗口。 */
  private restoreAttempted = false;
  /** 本轮自动续「继续说」的次数上限，防止无限循环。 */
  private autoResumeCount = 0;
  /** 本地图片 → data URL 缓存（避免每次同步都读盘）。 */
  private imageDataCache = new Map<string, string | undefined>();
  /** 豆包询问卡片去重：同一张卡不要每个轮询都推一遍。 */
  private lastAsk = '';
  /** 当前面板绑定的豆包对话标题，用于校验没被切走。 */
  private lastDesktopTitle = '';
  /** 唯一激活目标：历史任务 / 豆包对话都归一到它。 */
  private activeTarget: ActiveTarget = noneTarget();
  /** 用户最近一次主动激活的时间，用于恢复上次窗口时让位。 */
  private userActivatedAt = 0;
  /** 本地会话记忆（自己管理的历史）。 */
  private readonly sessions: SessionStore;
  private sessionId = newSessionId();
  /** 本轮用户原文 / 助手累积文本，用于落盘成一条会话记录。 */
  private lastUserText = '';
  /** 待发送的附件（+ 上传的文件/图片）。 */
  private pendingAttachments: Array<{ name: string; text?: string; note?: string; path?: string; dataUrl?: string }> = [];
  /** 粘贴去重：同一次 Ctrl+V 可能被触发两次。 */
  private lastPasteSignature = '';
  /** 最近一次环境检查结果（安装/登录/启动）。 */
  private setupState: SetupState | undefined;
  /** 定时同步器：任务期间持续抓豆包状态。 */
  private syncPoller: SyncPoller | undefined;
  /** 打开的标签（本地会话 id，类似编辑器标签页）。 */
  private openTabs: string[] = [];
  /** 本轮是否已尝试过用豆包标题刷新标签（首段回复时刷一次即可）。 */
  private tabTitleDirty = false;
  /** 切换标签后从豆包读到的执行状态（用于标签小圆点）。 */
  private tabRunning = false;
  /** 后台任务（旁观/长任务），供任务中心展示。 */
  private backgroundTasks: Array<{ id: string; title: string; status: 'running' | 'done' | 'failed'; progress?: string; startedAt: number }> = [];
  /** 待审阅的改动（AI 提议、用户接受后才落盘）。 */
  private pendingProposals = new Map<string, { path: string; before: string; after: string; hunks: DiffHunk[] }>();
  /** 已接受改动的撤销栈（最多 20 条）。 */
  private acceptedStack: Array<{ path: string; before: string }> = [];
  /** 最近一次构建/测试输出，用于「问豆包修这个」。 */
  private lastVerify: { kind: VerifyKind; command: string; output: string } | undefined;
  /** CLI 模式：当前标签续接的 CLI 会话 ID（由 CLI 输出里捕获，失败则新开会话）。 */
  private cliSessionId: string | undefined;
  /** 登录等待循环的令牌，新的登录流程会作废旧循环。 */
  private cliLoginToken = 0;
  /** CLI 模式：最近几轮对话，仅在拿不到会话 ID 时作为降级上下文发给 CLI。 */
  private cliHistory: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  /** CLI 环境提示每个面板只发一次，避免每次打开侧边栏都刷屏。 */
  private cliSetupPosted = false;
  private lastPasteAt = 0;
  private assistantBuf = '';

  constructor(
    private readonly context: vscode.ExtensionContext,
    /** 外部工具（MCP）路由器；每次取最新值，MCP 重连后无需重建面板。 */
    private readonly externalTools?: () => ExternalToolRouter | undefined,
  ) {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath.toLowerCase()).sort();
    const scopedFolder = folders.length === 1 ? folders[0] : folders.join('|');
    const scopeHash = scopedFolder
      ? crypto.createHash('sha1').update(scopedFolder).digest('hex').slice(0, 8)
      : 'global';
    this.sessions = new SessionStore(context.globalState, 'doubao.sessions:' + scopeHash);
    this.sessions.migrateFrom(context.globalState, 'doubao.sessions');
    this.sessions.migrate();
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.webviewReady = false;
    this.pendingPosts = [];
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot],
    };
    view.webview.html = this.getHtml(view.webview, mediaRoot);
    // 每个视图自己的订阅在 dispose 时释放，避免反复开关侧边栏后订阅累积。
    const messageSub = view.webview.onDidReceiveMessage((message: IncomingMessage) => {
      if (!message || typeof message.type !== 'string') {
        return;
      }
      void this.onMessage(message);
    });
    let disposeSub: vscode.Disposable | undefined;
    disposeSub = view.onDidDispose(() => {
      messageSub.dispose();
      disposeSub?.dispose();
      // 视图重建时旧 dispose 可能晚于新 resolve：只清理仍属于当前视图的状态。
      if (this.view === view) {
        this.view = undefined;
        this.webviewReady = false;
        this.abort();
      }
    });
    this.postState();
    this.restoreTabs();
    void this.refreshDesktopInfo();
    void this.preloadDesktopData();
    void this.restoreLastDesktop();
    log('聊天视图已就绪');
  }

  /** 供命令（解释选中代码等）调用：打开侧边栏并自动发送一条消息。 */
  public async askFromCommand(text: string, refs: ContextRefs): Promise<void> {
    if (!this.view || !this.webviewReady) {
      await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
      await this.waitForReady(2000);
    }
    await this.handleUser(text, refs);
  }

  public dispose(): void {
    this.disposed = true;
    this.abort();
    this.view = undefined;
  }

  /** 视图是否已经被解析（用户是否打开过侧边栏）。 */
  public hasView(): boolean {
    return Boolean(this.view);
  }

  /** 新建对话：清空扩展历史，并把桌面端切到「对话」+ 新会话。 */
  public newChat(): void {
    void this.newSession('chat');
  }

  /** 新建任务/对话：清空扩展状态，按类型选择本地电脑或对话，并新建桌面端会话。 */
  private async newSession(kind: 'task' | 'chat'): Promise<void> {
    this.abort();
    // 换一个会话 ID：否则新建的对话会继续往旧记录里追加，历史里就只剩一条。
    this.sessionId = newSessionId();
    this.tabTitleDirty = false;
    // 新任务/新对话立刻出现在标签栏，豆包回复后再用豆包标题刷新
    try {
      this.sessions.upsert({
        id: this.sessionId,
        title: kind === 'task' ? '新任务' : '新对话',
        updatedAt: Date.now(),
        turns: [],
      });
      this.ensureTab(this.sessionId);
    } catch (err) {
      warn('创建标签失败', err instanceof Error ? err.message : String(err));
    }
    this.lastUserText = '';
    this.assistantBuf = '';
    this.history = [];
    this.localMode = kind === 'task';
    this.forceNewChat = false;
    this.cliSessionId = undefined;
    this.cliHistory = [];
    this.post({ type: 'clear' });
    await this.updateConfig('chat.mode', kind === 'task' ? 'local' : 'chat');
    this.postState();
    const config = readConfig();
    let switched = config.authMode !== 'desktop';
    if (config.authMode === 'desktop') {
      try {
        const created = await createDesktopConversation(config.desktopPort);
        switched = created.ok;
        this.forceNewChat = !created.ok;
        if (!created.ok) {
          warn('新建桌面端会话失败', created.error ?? '');
        }
        await this.ensureDesktopWorkMode(kind === 'task' ? 'local' : 'chat');
      } catch (err) {
        switched = false;
        this.forceNewChat = true;
        warn('新建桌面端会话失败', err instanceof Error ? err.message : String(err));
      }
    }
    // 用户在没切过去时最需要知道“为什么”：失败不要只写日志，直接显示在对话区。
    const failText = '没切到豆包新会话：发送时会再试一次。可先看「输出 → 豆包编程助手」，或在豆包窗口里手动点「新对话」。';
    this.post({
      type: 'notice',
      text:
        config.authMode !== 'desktop'
          ? kind === 'task'
            ? '已新建本地电脑任务'
            : '已新建对话'
          : switched
            ? kind === 'task'
              ? '已切到豆包新会话（工作任务 · 本地电脑）'
              : '已切到豆包新会话'
            : failText,
    });
    this.postState();
    if (!this.catalogLoaded) {
      void this.syncDesktopCatalog(kind === 'task' ? '新任务' : '新对话', { silent: true });
    }
    void vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
  }

  /* ---------------------------------------------------------------------- */
  /* 消息处理                                                                */
  /* ---------------------------------------------------------------------- */

  private async onMessage(message: IncomingMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.markWebviewReady();
        void this.pushSetup();
        return;
      case 'user':
        this.postContextInfo(message.text ?? '', message.refs ?? {});
        await this.handleUser(message.text ?? '', message.refs ?? {});
        return;
      case 'abort':
        this.abort();
        return;
      case 'newChat':
        this.setActiveTarget(noneTarget());
        this.newChat();
        return;
      case 'newTask':
        await this.newSession('task');
        return;
      case 'cancelPending':
        this.opSeq += 1;
        this.post({ type: 'notice', text: '已取消当前操作' });
        log('用户取消操作', String(this.opSeq));
        return;
      case 'pasteFiles':
        await this.acceptPastedFiles(message.files ?? []);
        return;
      case 'pickFiles':
        await this.pickFiles();
        return;
      case 'removeAttachment':
        this.pendingAttachments.splice(Number(message.index) || 0, 1);
        this.postAttachments();
        return;
      case 'regenerate':
        this.post({ type: 'notice', text: '正在重新生成…' });
        await this.handleUser(message.text ?? '', {});
        return;
      case 'deleteTurn':
        this.deleteTurn(message.text ?? '');
        return;
      case 'sessionAction':
        await this.handleSessionAction(message.id ?? '', message.action ?? '', message.value ?? '');
        return;
      case 'sessionBatch':
        await this.handleSessionBatch(message.action ?? '', Array.isArray(message.ids) ? message.ids : []);
        return;
      case 'recheckSetup':
        await this.pushSetup();
        return;
      case 'setupAction':
        await this.handleSetupAction(message.value ?? '');
        return;
      case 'listHistory':
        await this.sendHistory();
        return;
      case 'listWorkspaceFiles':
        void this.sendWorkspaceFiles();
        return;
      case 'verify':
        void this.runVerification((message.value === 'test' ? 'test' : 'build') as VerifyKind);
        return;
      case 'verifyAsk':
        void this.askAboutVerification();
        return;
      case 'proposalAction':
        await this.handleProposal(message.id ?? '', message.action ?? '', message.hunks);
        return;
      case 'openFile':
        await this.openFileAt(message.path ?? '', Number(message.line ?? 0));
        return;
      case 'openSession':
        this.openSession(message.id ?? '');
        return;
      case 'activateTab':
        this.activateTab(message.id ?? '');
        return;
      case 'closeTab':
        this.closeTab(message.id ?? '');
        return;
      case 'openDesktopChat':
        await this.openDesktopChat(Number(message.index), message.title, message.id);
        return;
      case 'askAnswer': {
        const ok = await chooseDesktopOption(message.value ?? '', readConfig().desktopPort).catch(() => false);
        if (!ok) {
          this.post({ type: 'notice', text: '没能在豆包里点到这个选项，请手动选择。' });
        }
        return;
      }
      case 'deleteSession':
        this.sessions.remove(message.id ?? '');
        await this.sendHistory();
        return;
      case 'insertCode':
        await this.insertCode(message.code ?? '');
        return;
      case 'openSettings':
        await vscode.commands.executeCommand('doubao.openSettings');
        return;
      case 'showLogs':
        await vscode.commands.executeCommand('doubao.showLogs');
        return;
      case 'applyLastDiff':
        await vscode.commands.executeCommand('doubao.applyLastDiff');
        return;
      case 'setMode':
        await this.setMode(message.value === 'local' ? 'local' : 'chat');
        return;
      case 'setPermission':
        await this.setPermission(message.value ?? '');
        return;
      case 'mcpStatus':
        await vscode.commands.executeCommand('doubao.mcpStatus');
        return;
      case 'openRules':
        await this.openRules();
        return;
      case 'revealProject':
        await this.revealProject();
        return;
      case 'listModels':
        await this.sendModelMenu();
        return;
      case 'selectModel':
        await this.applyDesktopModel(message.value ?? '');
        return;
      case 'setReasoning':
        await this.applyReasoning(message.value ?? '');
        return;
      case 'setDesktopMode':
        await this.chooseDesktopMode(message.value === 'local' ? 'local' : 'chat');
        return;
      case 'listSkills':
        await this.sendSkillMenu();
        return;
      case 'listPlugins':
        await this.sendPluginMenu();
        return;
      case 'syncCatalog':
        if (!this.catalogLoaded) {
          await this.syncDesktopCatalog('按 / 打开技能');
        }
        this.post({ type: 'catalog', skills: this.skillGroups, plugins: this.pluginItems });
        return;
      case 'pickModel':
        await this.pickModel();
        return;
      case 'pickReasoning':
        await this.pickReasoning();
        return;
      case 'pickDesktopMode':
        await this.pickDesktopMode();
        return;
      case 'openExternal': {
        const url = message.url ?? '';
        if (/^https?:\/\//i.test(url)) {
          await vscode.env.openExternal(vscode.Uri.parse(url));
        }
        return;
      }
      default:
        warn('收到未知的 webview 消息', message.type);
    }
  }

  private async insertCode(code: string): Promise<void> {
    if (!code.trim()) {
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('没有打开的编辑器，无法插入代码。');
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.insert(editor.document.uri, editor.selection.active, code);
    const applied = await vscode.workspace.applyEdit(edit);
    if (applied) {
      vscode.window.showInformationMessage('已把代码插入到光标处。');
    } else {
      vscode.window.showWarningMessage('插入失败，请重试。');
    }
  }

  private abort(): void {
    if (this.abortController) {
      this.abortController.abort('用户停止');
      this.abortController = undefined;
    }
    this.client?.abort('用户停止');
    this.client = undefined;
    if (this.running) {
      this.running = false;
      this.postState();
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 主流程                                                                  */
  /* ---------------------------------------------------------------------- */

  private async handleUser(rawText: string, refs: ContextRefs): Promise<void> {
    const text = rawText.trim();
    if (!text) {
      return;
    }
    // 用户主动发话，重置自动续跑计数
    this.autoResumeCount = 0;
    if (this.running) {
      // 不丢消息：立即回显，然后排队；当前任务结束后自动发送。
      this.post({ type: 'user', text, at: Date.now() });
      this.post({ type: 'notice', text: '已排队：当前任务结束后自动发送（也可以点「停止」取消）' });
      this.queuedUser.push({ text, refs });
      if (this.queuedUser.length > 5) {
        this.queuedUser.shift();
        this.post({ type: 'notice', text: '排队超过 5 条，最早的一条已丢弃' });
      }
      return;
    }

    // 先回显：不管后面走哪条分支（任务/对话/Ark），你的话都要立刻出现在界面上。
    const echoImages = this.pendingAttachments
      .map((item) => item.dataUrl)
      .filter((url): url is string => typeof url === 'string');
    const echoFiles = this.pendingAttachments.map((item) => item.name);
    this.post({
      type: 'user',
      text,
      at: Date.now(),
      images: echoImages.length ? echoImages : undefined,
      files: echoFiles.length ? echoFiles : undefined,
    });
    // 同时把对话视图切到前台：先展开侧边栏容器，再聚焦视图（两步都做才稳）
    void (async () => {
      try {
        await vscode.commands.executeCommand('workbench.view.extension.doubao-coder');
        await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
      } catch (err) {
        warn('切换到对话视图失败', err instanceof Error ? err.message : String(err));
      }
    })();
    this.post({ type: 'notice', text: '已发送，等待豆包响应…' });
    this.lastUserText = text;
    this.assistantBuf = '';
    const withAttachments = this.composeWithAttachments(text);
    const config = readConfig();
    // 桌面端模式不需要 API Key：登录态在豆包客户端里，由它自己维护。
    if (config.authMode === 'ark' && !(await ensureConfigured(config))) {
      const validation = validateConfig(config);
      this.post({ type: 'error', message: validation.problems.join('\n') });
      return;
    }

    // CLI 模式：工具/权限/技能/子 Agent 全部由官方 CLI 执行，扩展只做界面；
    // 对话与「本地电脑」在 CLI 侧没有区别，统一交给 doubao -p。
    if (config.authMode === 'cli') {
      await this.runCli(config, withAttachments);
      return;
    }

    // 本地电脑模式：直接进入任务模式（计划 → 逐步执行 → 确认），不发送普通聊天上下文。
    if (this.localMode) {
      // 原生模式：直接把目标交给豆包自己的「本地电脑」agent，
      // 过程（正文/已执行代码/状态）与豆包界面同源，才能 1:1 还原。
      if (config.taskNative && config.authMode === 'desktop') {
        this.post({ type: 'notice', text: '已交给豆包本地电脑执行（过程与豆包界面同步）' });
        await this.runDesktop(config, withAttachments);
        return;
      }
      await this.runTask(withAttachments);
      return;
    }

    const userContent = await buildUserContent(withAttachments, refs).catch((err: unknown) => {
      warn('构建上下文失败', err instanceof Error ? err.message : String(err));
      return text;
    });

    if (config.authMode === 'desktop') {
      await this.runDesktop(config, userContent);
      return;
    }
    await this.runAgent(config, userContent);
  }

  /**
   * 桌面端通道：把「系统提示 + 工作区上下文 + 用户问题」整段发给已登录的豆包窗口，
   * 再把回复流式读回来。工具调用交给豆包自己的 Agent（或通过 MCP server 反向提供）。
   */
  /**
   * 任务模式：把"本地执行面"跑起来（计划 → 单动作 → 风险确认 → 执行 → 回灌）。
   * 模型侧可以走桌面端（免 Key）或 Ark，取决于 authMode。
   */
  public async runTask(goal: string): Promise<void> {
    const text = goal.trim();
    if (!text) {
      return;
    }
    if (this.running) {
      // 同样不丢：回显 + 排队
      this.post({ type: 'user', text: `【任务模式】${text}`, at: Date.now() });
      this.post({ type: 'notice', text: '已排队：当前任务结束后自动发送' });
      this.queuedUser.push({ text, refs: {} });
      return;
    }

    this.lastUserText = `【任务模式】${text}`;
    this.assistantBuf = '';
    // 先把消息回显出来（立刻可见），再去做同步/等待豆包。
    this.running = true;
    this.postState();
    // 技能/插件清单已在启动时预读取；未加载时才补一次，新建任务不重复刷新。
    if (!this.catalogLoaded) {
      void this.syncDesktopCatalog('首次任务', { silent: true });
    }

    const config = readConfig();
    const runtime: ToolRuntime = {
      config,
      extensionContext: this.context,
      confirmTerminal: (command, cwd) => this.confirmTerminal(command, cwd),
      externalTools: this.externalTools?.(),
      confirmRisk: (call, verdict) => this.confirmRisky(call.name, call.args, verdict.level, verdict.reason),
      reviewEdit: async (filePath, before, after) => this.requestReview(filePath, before, after),
    };

    const controller = new AbortController();
    this.abortController = controller;

    let complete: (prompt: string) => Promise<string>;
    let ark: ArkClient | undefined;
    if (config.authMode === 'desktop') {
      await this.ensureDesktopWorkMode(config.desktopWorkMode === 'chat' ? 'chat' : 'local');
      await this.ensureDesktopConversation(this.lastDesktopTitle);
      let first = true;
      complete = async (prompt: string): Promise<string> => {
        const result = await askDesktop(prompt, {
          port: config.desktopPort,
          newChat: first || config.desktopNewChat,
          timeoutMs: config.desktopTimeoutMs,
          signal: controller.signal,
          onDelta: () => undefined,
          onBlock: (block) => this.post({ type: 'block', kind: block.kind, text: block.text }),
        onBlocks: (blocks) => {
          this.post({ type: 'blocks', blocks: this.localizeBlocks(blocks) });
        },
            onQuestion: (question) => {
              const key = JSON.stringify(question);
              if (key === this.lastAsk) {
                return;
              }
              this.lastAsk = key;
              this.post({ type: 'ask', question });
            },
        onImage: (image) => this.postImage(image),
          onStatus: (text) => this.post({ type: 'generating', text }),
        });
        first = false;
        return result.text;
      };
    } else {
      if (!(await ensureConfigured(config))) {
        this.running = false;
        this.abortController = undefined;
        this.post({ type: 'error', message: validateConfig(config).problems.join('\n') });
        this.postState();
        return;
      }
      ark = new ArkClient(config);
      const client = ark;
      complete = async (prompt: string): Promise<string> => {
        let buffer = '';
        await client.chatStream(
          [
            { role: 'system', content: '你是一个在本机执行任务的 Agent，回答尽量简短。' },
            { role: 'user', content: prompt },
          ],
          (delta) => {
            if (delta.deltaText) {
              buffer += delta.deltaText;
            }
          },
          { maxTokens: Math.min(config.maxTokens, 8192), temperature: 0.15, timeoutMs: 120_000 },
        );
        return buffer;
      };
    }

    const runner = new TaskRunner({
      goal: text,
      root: workspaceRoot() ?? '',
      config,
      runtime,
      complete,
      signal: controller.signal,
      permission: config.taskPermission,
      maxSteps: config.taskMaxSteps,
      confirm: (call, verdict) => this.confirmRisky(call.name, call.args, verdict.level, verdict.reason),
      events: {
        onPlan: (plan) => {
          this.post({
            type: 'assistant_delta',
            text: `**执行计划**\n\n${plan.map((p, i) => `${i + 1}. ${p}`).join('\n')}\n\n`,
          });
        },
        onRound: (event) => this.post({ type: 'round', index: event.index, plan: event.plan }),
        onTextDelta: (delta) => {
          this.assistantBuf += delta;
          this.post({ type: 'assistant_delta', text: this.localizeText(delta) });
        },
        onToolStart: (event) =>
          this.post({ type: 'tool_start', id: event.id, name: event.name, arguments: event.arguments }),
        onToolEnd: (event) =>
          this.post({ type: 'tool_end', id: event.id, name: event.name, ok: event.ok, content: event.content }),
        onDone: (result) => {
          log('任务模式：完成', `steps=${result.steps.length}`, `aborted=${result.aborted}`);
          if (result.steps.length > 0) {
            const risky = result.steps.filter((s) => s.risk !== 'safe').length;
            this.post({
              type: 'assistant_delta',
              text: `\n\n---\n> 共执行 ${result.steps.length} 步${risky ? `（其中 ${risky} 步有副作用）` : ''}；可用「查看/撤销上一次改动」回退文件改动。`,
            });
          }
        },
      },
    });

    try {
      const result = await runner.run();
      this.post({ type: 'assistant_done', aborted: result.aborted, at: Date.now() });
    } catch (err) {
      logErrorLevel('任务模式失败', err);
      this.post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      this.post({ type: 'assistant_done', aborted: true, at: Date.now() });
    } finally {
      ark?.abort('任务结束');
      this.running = false;
      this.abortController = undefined;
      if (!this.disposed) {
        this.postState();
      }
      this.persistTurn();
      this.drainQueuedUser();
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 本地电脑模式 / 工具栏                                                    */
  /* ---------------------------------------------------------------------- */

  /** 桌面端该用哪种工作模式：auto 跟随 chat.mode，显式配置优先。 */
  private desktopModeFor(config: DoubaoConfig): 'local' | 'chat' {
    if (config.desktopWorkMode === 'auto') {
      return config.chatMode === 'local' ? 'local' : 'chat';
    }
    return config.desktopWorkMode;
  }

  private async setMode(mode: 'chat' | 'local'): Promise<void> {
    this.localMode = mode === 'local';
    try {
      await vscode.workspace.getConfiguration('doubao').update('chat.mode', mode, vscode.ConfigurationTarget.Global);
      // 桌面端工作模式跟着一起落盘：否则 desktop.workMode 还是 local 时，发送又会切回工作任务
      await vscode.workspace.getConfiguration('doubao').update('desktop.workMode', mode, vscode.ConfigurationTarget.Global);
    } catch (err) {
      warn('保存 chat.mode 失败', err instanceof Error ? err.message : String(err));
    }
    log('模式切换', mode === 'local' ? '本地电脑' : '对话');
    // 扩展模式与桌面端模式实时联动，避免显示「对话」但模型仍是任务模型。
    await this.ensureDesktopWorkMode(mode === 'local' ? 'local' : 'chat');
    this.postState();
  }

  private async setPermission(raw: string): Promise<void> {
    if (raw !== 'ask' && raw !== 'risk' && raw !== 'allow') {
      return;
    }
    try {
      await vscode.workspace
        .getConfiguration('doubao')
        .update('task.permission', raw, vscode.ConfigurationTarget.Global);
    } catch (err) {
      warn('保存 task.permission 失败', err instanceof Error ? err.message : String(err));
    }
    log('本地电脑权限切换', raw);
    this.postState();
  }

  /** 「技能」：打开项目规则文件（不存在则创建模板）。 */
  private async openRules(): Promise<void> {
    const config = readConfig();
    const root = workspaceRoot();
    if (!root) {
      vscode.window.showInformationMessage('当前没有打开工作区文件夹，无法使用项目规则。');
      return;
    }
    let target: string;
    try {
      target = path.isAbsolute(config.rulesFile) ? config.rulesFile : resolveInsideRoot(root, config.rulesFile);
    } catch (err) {
      vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
      return;
    }
    if (!fs.existsSync(target)) {
      try {
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.writeFile(
          target,
          '# 项目规则（技能）\n\n- 写在这里的约定会追加到豆包的系统提示词。\n- 例如：使用 npm；不要改动 generated/；提交前必须跑 npm test。\n',
          'utf8',
        );
      } catch (err) {
        vscode.window.showErrorMessage(`创建规则文件失败：${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    await vscode.window.showTextDocument(doc, { preview: false });
    this.postState();
  }

  private async revealProject(): Promise<void> {
    const root = workspaceRoot();
    if (!root) {
      vscode.window.showInformationMessage('当前没有打开工作区文件夹。');
      return;
    }
    await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(root));
  }

  /** 保存配置；旧窗口还没加载新 manifest 时 update 会报「没有注册配置」，只记录不阻断操作。 */
  private async updateConfig(key: string, value: unknown): Promise<void> {
    try {
      await vscode.workspace.getConfiguration('doubao').update(key, value, vscode.ConfigurationTarget.Global);
    } catch (err) {
      warn(`保存配置 ${key} 失败（可能需要 Reload Window）`, err instanceof Error ? err.message : String(err));
    }
  }

  /** 刷新桌面端模式/模型/推理强度（只读，不打开菜单）。 */
  private async refreshDesktopInfo(): Promise<void> {
    const config = readConfig();
    if (config.authMode !== 'desktop') {
      return;
    }
    try {
      const [mode, model] = await Promise.all([
        getDesktopMode(config.desktopPort),
        getDesktopModel(config.desktopPort),
      ]);
      this.desktopModeText = mode.buttonText;
      this.desktopModel = model.currentModel;
      this.desktopReasoning = model.reasoning;
      this.postState();
    } catch (err) {
      warn('读取桌面端模式/模型失败', err instanceof Error ? err.message : String(err));
    }
  }

  /** 发送前确保桌面端在目标模式；失败只记录日志，不中断发送。 */
  /** 发送前确保豆包当前打开的就是本面板绑定的对话，避免把消息发进别的任务。 */
  private async ensureDesktopConversation(title: string): Promise<boolean> {
    const wanted = normalizeTitle(title);
    if (!wanted) {
      return false;
    }
    const port = readConfig().desktopPort;
    const wantedId = activeDesktopId(this.activeTarget);
    const current = normalizeTitle(await readDesktopTitle(port).catch(() => ''));
    const currentId = await readDesktopConversationId(port).catch(() => '');
    // 已在该对话：标题归一化后必须**完全相等**，或 id 相同；禁止子串匹配（同名/相似任务会串台）。
    if ((wantedId && currentId && currentId === wantedId) || (current && current === wanted)) {
      return true;
    }
    const list = await listDesktopConversations(port).catch(() => undefined);
    if (!list || !list.ok) {
      warn('发送前读取对话列表失败', list?.error ?? '');
      return false;
    }
    const byId = wantedId ? list.items.find((item) => item.id === wantedId) : undefined;
    const matched = byId ? { item: byId, candidates: [byId], error: undefined } : matchConversation(wanted, list.items);
    const hit = matched.item;
    if (!hit) {
      warn('发送前找不到目标对话', wanted, '当前是', current);
      this.post({ type: 'notice', text: `豆包当前打开的是「${current}」，找不到目标对话「${wanted}」，这条消息可能发错会话。` });
      return false;
    }
    log('发送前切回目标对话', hit.title);
    await openDesktopConversation(hit.index, port, hit.id).catch((err) => {
      warn('切回目标对话失败', err instanceof Error ? err.message : String(err));
    });
    await new Promise((resolve) => setTimeout(resolve, 900));
    const after = normalizeTitle(await readDesktopTitle(port).catch(() => ''));
    const afterId = await readDesktopConversationId(port).catch(() => '');
    const ok = (hit.id && afterId && afterId === hit.id) || (after && after === normalizeTitle(hit.title));
    if (!ok) {
      warn('切回目标对话后校验失败', after, '≠', hit.title);
    }
    return Boolean(ok);
  }
  private async ensureDesktopWorkMode(target: 'local' | 'chat'): Promise<void> {
    const config = readConfig();
    if (config.authMode !== 'desktop') {
      return;
    }
    try {
      const info = await getDesktopMode(config.desktopPort);
      this.desktopModeText = info.buttonText;
      const already = (target === 'local' && info.isLocal) || (target === 'chat' && info.isChat);
      if (!already) {
        log('切换桌面端模式', target, '当前', info.buttonText);
        const result = await setDesktopMode(config.desktopPort, target);
        if (result.ok) {
          this.desktopModeText = result.after;
          log('桌面端模式已切换', result.after);
        } else {
          warn('切换桌面端模式失败', result.error ?? '');
        }
      }
      if (target === 'local') {
        await this.ensureDesktopModelChoice();
      } else {
        let model = await getDesktopModel(config.desktopPort);
        // 对话模式只认快速/专家；如果还停留在任务模型，强制切回默认「快速」。
        if (model.currentModel !== '快速' && model.currentModel !== '专家') {
          const switched = await selectDesktopModel(config.desktopPort, '快速');
          if (switched.ok) {
            model = { currentModel: switched.currentModel, reasoning: switched.reasoning };
          }
        }
        this.desktopModel = model.currentModel === '专家' ? '专家' : '快速';
        this.desktopReasoning = '';
        this.postState();
      }
    } catch (err) {
      warn('桌面端模式检查失败', err instanceof Error ? err.message : String(err));
    }
  }

  /** 本地电脑模式下把桌面端模型/推理强度对齐到配置值。 */
  private async ensureDesktopModelChoice(): Promise<void> {
    const config = readConfig();
    const port = config.desktopPort;
    // 即使配置里没写模型，也要读一次桌面端当前模型：
    // 否则工具栏会退回硬编码的默认名，提示词里的「当前模型」也跟着错。
    let current = await getDesktopModel(port);
    if (!current.currentModel) {
      await new Promise((resolve) => setTimeout(resolve, 900));
      current = await getDesktopModel(port);
    }
    const beforeModel = this.taskModel;
    this.desktopModel = current.currentModel || config.desktopModel || '';
    this.desktopReasoning = current.reasoning || config.desktopReasoning || '';
    this.taskModel = this.desktopModel;
    this.taskReasoning = this.desktopReasoning;
    let changed = false;
    if (beforeModel !== this.taskModel) {
      this.postState();
    }
    if (config.desktopModel && current.currentModel !== config.desktopModel) {
      const result = await selectDesktopModel(port, config.desktopModel);
      if (result.ok) {
        current = { currentModel: result.currentModel, reasoning: result.reasoning };
        this.desktopModel = result.currentModel;
        this.desktopReasoning = result.reasoning;
        this.taskModel = result.currentModel;
        this.taskReasoning = result.reasoning;
        changed = true;
        log('桌面端模型已对齐配置', result.currentModel);
      } else {
        warn('对齐桌面端模型失败', result.error ?? '');
      }
    }
    if (config.desktopReasoning && current.reasoning !== config.desktopReasoning) {
      const result = await setDesktopReasoning(port, config.desktopReasoning);
      if (result.ok) {
        if (result.currentModel && result.currentModel !== '未知') {
          this.desktopModel = result.currentModel;
        }
        this.desktopReasoning = result.reasoning;
        this.taskReasoning = result.reasoning;
        changed = true;
        log('桌面端推理强度已对齐配置', result.reasoning);
      } else {
        warn('对齐推理强度失败', result.error ?? '');
      }
    }
    if (changed) {
      this.postState();
    }
  }

  /** 「模型」：Ark 模式写 doubao.model；桌面端模式直接操作桌面端模型菜单。 */
  private async pickModel(): Promise<void> {
    const config = readConfig();
    if (config.authMode === 'desktop') {
      let info;
      try {
        info = await listDesktopModels(config.desktopPort);
      } catch (err) {
        vscode.window.showWarningMessage(`读取桌面端模型列表失败：${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      const models = info.models ?? [];
      if (models.length === 0) {
        vscode.window.showWarningMessage('桌面端模型列表为空，请先在豆包窗口里打开一次模型菜单。');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        models.map((model) => ({ label: model, description: model === info?.currentModel ? '当前' : undefined })),
        { placeHolder: `选择豆包桌面端模型（当前：${info.currentModel}）`, ignoreFocusOut: true },
      );
      if (!picked) {
        return;
      }
      try {
        const result = await selectDesktopModel(config.desktopPort, picked.label);
        if (!result.ok) {
          vscode.window.showWarningMessage(`切换桌面端模型失败：${result.error ?? '未知原因'}`);
          return;
        }
        this.desktopModel = result.currentModel;
        this.desktopReasoning = result.reasoning;
        await this.updateConfig('desktop.model', result.currentModel);
        await this.updateConfig('desktop.reasoning', result.reasoning || '');
        log('桌面端模型已切换', result.currentModel, `推理强度=${result.reasoning || '?'}`);
        this.postState();
        await this.pickReasoning();
      } catch (err) {
        vscode.window.showWarningMessage(`切换桌面端模型失败：${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    const presets = ['doubao-seed-code', 'doubao-seed-1.6', 'doubao-seed-1.6-flash', 'doubao-seed-1.6-thinking'];
    const custom = '自定义模型…';
    const items: vscode.QuickPickItem[] = [
      ...presets.map((model) => ({
        label: model,
        description: model === config.model ? '当前' : undefined,
      })),
      { label: custom, description: '输入任意模型 ID / 推理接入点' },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `选择模型（当前：${config.model}）`,
      ignoreFocusOut: true,
    });
    if (!picked) {
      return;
    }
    let model = picked.label;
    if (picked.label === custom) {
      const input = await vscode.window.showInputBox({
        title: '豆包 / 方舟模型 ID',
        value: config.model,
        prompt: '例如 doubao-seed-code，或 Ark 控制台里的推理接入点 ID',
        ignoreFocusOut: true,
      });
      if (!input || !input.trim()) {
        return;
      }
      model = input.trim();
    }
    await vscode.workspace.getConfiguration('doubao').update('model', model, vscode.ConfigurationTarget.Global);
    log('模型已切换', model);
    this.postState();
  }

  /** 「推理」：设置桌面端推理强度（低/中/高/极高）。 */
  private async pickReasoning(): Promise<void> {
    const config = readConfig();
    if (config.authMode !== 'desktop') {
      vscode.window.showInformationMessage('推理强度是豆包桌面端模型的选项；Ark 模式请直接在模型侧配置。');
      return;
    }
    const levels = ['低', '中', '高', '极高'] as const;
    const current = this.desktopReasoning || '高';
    const picked = await vscode.window.showQuickPick(
      levels.map((level) => ({ label: level, description: level === current ? '当前' : undefined })),
      { placeHolder: `推理强度（当前：${current}）`, ignoreFocusOut: true },
    );
    if (!picked) {
      return;
    }
    const level = picked.label as (typeof levels)[number];
    try {
      const result = await setDesktopReasoning(config.desktopPort, level);
      if (!result.ok) {
        vscode.window.showWarningMessage(`设置推理强度失败：${result.error ?? '未知原因'}`);
        return;
      }
      this.desktopReasoning = result.reasoning || level;
      await this.updateConfig('desktop.reasoning', this.desktopReasoning);
      log('桌面端推理强度已切换', this.desktopReasoning);
      this.postState();
    } catch (err) {
      vscode.window.showWarningMessage(`设置推理强度失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 「桌面模式」：切换桌面端 工作任务·本地电脑 / 对话。 */
  private async pickDesktopMode(): Promise<void> {
    const config = readConfig();
    if (config.authMode !== 'desktop') {
      vscode.window.showInformationMessage('当前是 Ark 模式，没有桌面端工作模式可切换。');
      return;
    }
    try {
      const info = await getDesktopMode(config.desktopPort);
      const picked = await vscode.window.showQuickPick(
        [
          { label: '工作任务 · 本地电脑', description: info.isLocal ? '当前' : undefined },
          { label: '对话', description: info.isChat ? '当前' : undefined },
        ],
        { placeHolder: `桌面端模式（当前：${info.buttonText}）`, ignoreFocusOut: true },
      );
      if (!picked) {
        return;
      }
      const target = picked.label.includes('本地电脑') ? 'local' : 'chat';
      const result = await setDesktopMode(config.desktopPort, target);
      if (!result.ok) {
        vscode.window.showWarningMessage(`切换桌面端模式失败：${result.error ?? '未知原因'}`);
        return;
      }
      this.desktopModeText = result.after;
      log('桌面端模式已切换', result.after);
      this.localMode = target === 'local';
      await this.updateConfig('chat.mode', target === 'local' ? 'local' : 'chat');
      if (target === 'local') {
        await this.ensureDesktopModelChoice();
      } else {
        const model = await getDesktopModel(config.desktopPort);
        this.desktopModel = model.currentModel;
        this.desktopReasoning = model.reasoning;
      }
      this.postState();
    } catch (err) {
      vscode.window.showWarningMessage(`切换桌面端模式失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 给 webview 的模型菜单：桌面端读真实列表，Ark 模式给常用预设。 */
  private async sendModelMenu(): Promise<void> {
    const config = readConfig();
    if (config.authMode !== 'desktop') {
      const presets = ['doubao-seed-code', 'doubao-seed-1.6', 'doubao-seed-1.6-flash', 'doubao-seed-1.6-thinking'];
      const models = [config.model, ...presets.filter((model) => model !== config.model)];
      this.post({ type: 'modelMenu', models, currentModel: config.model, reasoning: '', allowReasoning: false });
      return;
    }
    try {
      if (!this.localMode) {
        const current = this.desktopModel === '专家' ? '专家' : '快速';
        this.post({
          type: 'modelMenu',
          models: ['快速', '专家'],
          currentModel: current,
          reasoning: '',
          allowReasoning: false,
        });
        return;
      }
      const current = this.taskModel || config.desktopModel || 'DeepSeek V4.1 Flash';
      const reasoning = this.taskReasoning || config.desktopReasoning || '';
      const models = this.taskModels.includes(current) ? this.taskModels : [current, ...this.taskModels];
      this.post({
        type: 'modelMenu',
        models,
        currentModel: current,
        reasoning,
        allowReasoning: true,
      });
    } catch (err) {
      vscode.window.showWarningMessage(`读取桌面端模型列表失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async applyDesktopModel(model: string): Promise<void> {
    const value = model.trim();
    if (!value) {
      return;
    }
    const config = readConfig();
    if (config.authMode !== 'desktop') {
      await this.updateConfig('model', value);
      log('模型已切换', value);
      this.postState();
      return;
    }
    try {
      const result = await selectDesktopModel(config.desktopPort, value);
      if (!result.ok) {
        vscode.window.showWarningMessage(`切换桌面端模型失败：${result.error ?? '未知原因'}`);
        return;
      }
      let currentModel = result.currentModel;
      let currentReasoning = result.reasoning;
      if (this.localMode && config.desktopReasoning && currentReasoning !== config.desktopReasoning) {
        const reasoning = await setDesktopReasoning(config.desktopPort, config.desktopReasoning);
        if (reasoning.ok) {
          currentModel = reasoning.currentModel;
          currentReasoning = reasoning.reasoning;
        }
      }
      this.desktopModel = currentModel;
      this.desktopReasoning = currentReasoning;
      if (this.localMode) {
        this.taskModel = currentModel;
        this.taskReasoning = currentReasoning;
        await this.updateConfig('desktop.model', currentModel);
        await this.updateConfig('desktop.reasoning', currentReasoning || '');
      }
      log('桌面端模型已切换', result.currentModel, `推理强度=${result.reasoning || '?'}`);
      this.postState();
    } catch (err) {
      vscode.window.showWarningMessage(`切换桌面端模型失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async applyReasoning(level: string): Promise<void> {
    const config = readConfig();
    if (config.authMode !== 'desktop') {
      vscode.window.showInformationMessage('推理强度是豆包桌面端模型的选项；Ark 模式请直接在模型侧配置。');
      return;
    }
    if (level !== '低' && level !== '中' && level !== '高' && level !== '极高') {
      return;
    }
    try {
      const result = await setDesktopReasoning(config.desktopPort, level);
      if (!result.ok) {
        vscode.window.showWarningMessage(`设置推理强度失败：${result.error ?? '未知原因'}`);
        return;
      }
      this.desktopModel = result.currentModel;
      this.desktopReasoning = result.reasoning || level;
      await this.updateConfig('desktop.reasoning', this.desktopReasoning);
      log('桌面端推理强度已切换', this.desktopReasoning);
      this.postState();
    } catch (err) {
      vscode.window.showWarningMessage(`设置推理强度失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async chooseDesktopMode(target: 'local' | 'chat'): Promise<void> {
    const config = readConfig();
    if (config.authMode !== 'desktop') {
      vscode.window.showInformationMessage('当前是 Ark 模式，没有桌面端工作模式可切换。');
      return;
    }
    try {
      const result = await setDesktopMode(config.desktopPort, target);
      if (!result.ok) {
        vscode.window.showWarningMessage(`切换桌面端模式失败：${result.error ?? '未知原因'}`);
        return;
      }
      this.desktopModeText = result.after;
      log('桌面端模式已切换', result.after);
      this.localMode = target === 'local';
      await this.updateConfig('chat.mode', target === 'local' ? 'local' : 'chat');
      if (target === 'local') {
        await this.ensureDesktopModelChoice();
      } else {
        const model = await getDesktopModel(config.desktopPort);
        this.desktopModel = model.currentModel;
        this.desktopReasoning = model.reasoning;
      }
      this.postState();
    } catch (err) {
      vscode.window.showWarningMessage(`切换桌面端模式失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 技能菜单：优先用新对话/新任务时缓存好的列表，不再每次打开桌面面板。 */
  private async sendSkillMenu(): Promise<void> {
    const config = readConfig();
    if (config.authMode !== 'desktop') {
      vscode.window.showInformationMessage('技能清单需要从豆包桌面端读取；Ark 模式请使用项目规则文件。');
      return;
    }
    if (!this.catalogLoaded) {
      await this.syncDesktopCatalog('技能菜单');
    }
    if (!this.catalogLoaded) {
      this.post({ type: 'skillMenu', ok: false, groups: [] });
      return;
    }
    this.post({ type: 'skillMenu', ok: true, groups: this.skillGroups });
  }

  /** 插件菜单：优先用缓存列表。 */
  private async sendPluginMenu(): Promise<void> {
    const config = readConfig();
    if (config.authMode !== 'desktop') {
      vscode.window.showInformationMessage('插件清单需要从豆包桌面端读取。');
      return;
    }
    if (!this.catalogLoaded) {
      await this.syncDesktopCatalog('插件菜单');
    }
    if (!this.catalogLoaded) {
      this.post({ type: 'pluginMenu', ok: false, plugins: [] });
      return;
    }
    this.post({ type: 'pluginMenu', ok: true, plugins: this.pluginItems });
  }

  /**
   * 开新对话/新任务时同步一次技能、插件与模型。
   * 同步失败会重试，并把结果写到状态栏；不会阻塞用户使用。
   */
  /** 启动时预读取技能/插件与任务模型列表；新建对话/任务只切换缓存，不再刷新。 */
  private async preloadDesktopData(): Promise<void> {
    if (this.preloaded) {
      return;
    }
    this.preloaded = true;
    const config = readConfig();
    if (config.authMode !== 'desktop') {
      return;
    }
    void this.syncDesktopCatalog('启动预读取', { silent: true });
    void this.refreshTaskModels();
  }

  /** 只在桌面端处于本地电脑模式时读取任务模型列表，避免为了预读而切换模式。 */
  private async refreshTaskModels(): Promise<void> {
    const config = readConfig();
    if (config.authMode !== 'desktop') {
      return;
    }
    try {
      const mode = await getDesktopMode(config.desktopPort);
      if (!mode.isLocal) {
        return;
      }
      const info = await listDesktopModels(config.desktopPort);
      if (info.models && info.models.length > 0) {
        this.taskModels = info.models;
      }
      if (info.currentModel && info.currentModel !== '快速' && info.currentModel !== '专家') {
        this.taskModel = info.currentModel;
      }
      if (info.reasoning) {
        this.taskReasoning = info.reasoning;
      }
    } catch (err) {
      warn('预读取任务模型失败', err instanceof Error ? err.message : String(err));
    }
  }

  private async syncDesktopCatalog(reason: string, options?: { force?: boolean; silent?: boolean }): Promise<void> {
    const config = readConfig();
    if (config.authMode !== 'desktop') {
      return;
    }
    // 缓存命中：不碰 CDP，直接用内存里的（新建对话/任务时几乎零成本）
    const fresh = Date.now() - this.catalogSyncAt < ChatViewProvider.CATALOG_TTL_MS;
    if (!options?.force && fresh && this.catalogLoaded) {
      return;
    }
    // 启动时从 globalState 恢复
    if (!this.catalogLoaded) {
      const saved = this.context.globalState.get<{
        at: number;
        skills: DesktopSkillGroup[];
        plugins: DesktopPlugin[];
      }>('doubao.catalog');
      if (saved && Array.isArray(saved.skills)) {
        this.skillGroups = saved.skills;
        this.pluginItems = saved.plugins ?? [];
        this.desktopSkillsCount = this.skillGroups.reduce((n, g) => n + (g.items?.length ?? 0), 0);
        this.desktopPluginsCount = this.pluginItems.length;
        this.catalogLoaded = true;
        this.catalogSyncAt = saved.at ?? 0;
        this.post({ type: 'catalog', skills: this.skillGroups, plugins: this.pluginItems });
        if (!options?.force && Date.now() - this.catalogSyncAt < ChatViewProvider.CATALOG_TTL_MS) {
          log('技能/插件来自本地缓存', `${Math.round((Date.now() - this.catalogSyncAt) / 1000)}s 前`);
          return;
        }
      }
    }
    // 任务执行中不要去抢桌面端技能/插件面板，否则会把正在生成的消息打断。
    if (this.running) {
      if (!this.catalogLoaded) {
        log('任务执行中，跳过技能/插件同步，稍后用缓存');
      }
      return;
    }
    if (this.catalogSyncing) {
      await this.catalogSyncing;
      return;
    }
    const run = (async () => {
      // 技能/插件面板只在「本地电脑」模式下存在：先确保模式正确，同步完再切回。
      let restoreTo: 'chat' | undefined;
      try {
        const mode = await getDesktopMode(config.desktopPort);
        if (!mode.isLocal) {
          const switched = await setDesktopMode(config.desktopPort, 'local');
          if (switched.ok) {
            restoreTo = 'chat';
            log('为同步技能临时切到本地电脑模式', switched.before, '->', switched.after);
          } else {
            warn('切换到本地电脑模式失败', switched.error ?? '');
          }
        }
      } catch (err) {
        warn('读取/切换桌面端模式失败', err instanceof Error ? err.message : String(err));
      }

      let lastError = '';
      let bestSkills: Awaited<ReturnType<typeof listDesktopSkills>> | undefined;
      let bestPlugins: Awaited<ReturnType<typeof listDesktopPlugins>> | undefined;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const skills = await listDesktopSkills(config.desktopPort);
          if (skills.ok) {
            bestSkills = skills;
          }
          const plugins = await listDesktopPlugins(config.desktopPort);
          if (plugins.ok) {
            bestPlugins = plugins;
          }
          // 部分成功也采纳：一个面板打不开不再让整次同步失败
          if (skills.ok || plugins.ok) {
            const finalSkills = bestSkills ?? skills;
            const finalPlugins = bestPlugins ?? plugins;
            this.desktopSkillsCount = finalSkills.ok ? finalSkills.count : this.desktopSkillsCount;
            this.desktopPluginsCount = finalPlugins.ok ? finalPlugins.count : this.desktopPluginsCount;
            if (finalSkills.ok) {
              this.skillGroups = finalSkills.groups;
            }
            if (finalPlugins.ok) {
              this.pluginItems = finalPlugins.plugins;
            }
            this.catalogLoaded = true;
            this.catalogSyncAt = Date.now();
            void this.context.globalState.update('doubao.catalog', {
              at: this.catalogSyncAt,
              skills: this.skillGroups,
              plugins: this.pluginItems,
            });
            this.post({ type: 'catalog', skills: this.skillGroups, plugins: this.pluginItems });
            void this.refreshDesktopInfo();
            this.postState();
            const bits = [
              finalSkills.ok ? `技能 ${finalSkills.count}` : '技能（沿用上次）',
              finalPlugins.ok ? `插件 ${finalPlugins.count}` : '插件（沿用上次）',
            ];
            this.post({ type: 'notice', text: `已同步豆包：${bits.join(' · ')}` });
            log('同步完成', reason, bits.join(' / '));
            if (restoreTo) {
              void setDesktopMode(config.desktopPort, restoreTo).catch(() => undefined);
            }
            return;
          }
          lastError = !skills.ok ? '技能面板未打开' : '插件面板未打开';
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
      if (restoreTo) {
        await setDesktopMode(config.desktopPort, restoreTo).catch(() => undefined);
      }
      warn('同步技能/插件失败', reason, lastError);
      if (!options?.silent) {
        this.post({ type: 'notice', text: '豆包技能/插件没读到（豆包窗口可能被遮挡），点「更多技能」可重试' });
      }
    })();
    this.catalogSyncing = run;
    try {
      await this.runWithBudget(
        '同步技能/插件',
        60_000,
        async () => {
          await run;
          return true;
        },
        { silent: true },
      );
    } finally {
      if (this.catalogSyncing === run) {
        this.catalogSyncing = undefined;
      }
    }
  }

  private hasRules(config: DoubaoConfig): boolean {
    const root = workspaceRoot();
    if (!root || !config.rulesFile) {
      return false;
    }
    try {
      return fs.existsSync(resolveInsideRoot(root, config.rulesFile));
    } catch {
      return false;
    }
  }

  /** 任务模式的风险确认（模态）。 */
  private async confirmRisky(
    name: string,
    args: Record<string, unknown>,
    level: string,
    reason: string,
  ): Promise<boolean> {
    const detail = [
      `工具：${name}`,
      `参数：${JSON.stringify(args).slice(0, 400)}`,
      `风险：${level}（${reason}）`,
      '',
      '允许后会在你的本机执行；拒绝则该步会跳过并告知模型。',
    ].join('\n');
    const answer = await vscode.window.showWarningMessage('豆包请求在本机执行操作', { modal: true, detail }, '允许');
    log('任务模式：风险确认', name, level, answer ?? '拒绝');
    return answer === '允许';
  }

  /**
   * CLI 通道：doubao -C <workspace> --permission-mode <mode> -p "<prompt>"。
   *
   * 为什么不在这里再实现一套 Agent：CLI 已经带工具、权限、技能、子 Agent，
   * 还会读取 AGENTS.md 与本地 Skills 目录；扩展重复实现只会得到两套不一致的
   * 权限模型和两份维护成本。这里只负责起进程、显示结果、支持中断。
   */
  private async runCli(config: DoubaoConfig, userContent: string): Promise<void> {
    const controller = new AbortController();
    this.abortController = controller;
    this.running = true;
    this.postState();

    try {
      const info = await detectCli(config.cliPath);
      if (!info.installed || !info.binary) {
        this.post({ type: 'assistant_done', aborted: true, at: Date.now() });
        const message = info.error || '没有找到豆包 CLI。请先安装：' + CLI_INSTALL_COMMAND;
        this.post({ type: 'error', message });
        const action = await vscode.window.showErrorMessage(message, '自动安装', '打开设置中心', '查看安装文档');
        if (action === '自动安装') {
          await vscode.commands.executeCommand('doubao.cliAutoInstall');
        } else if (action === '打开设置中心') {
          await vscode.commands.executeCommand('doubao.openSettingsPanel');
        } else if (action === '查看安装文档') {
          await vscode.env.openExternal(vscode.Uri.parse(CLI_DOC_URL));
        }
        return;
      }

      const cwd = workspaceRoot() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
      this.post({
        type: 'notice',
        text:
          '已交给本机豆包 CLI 执行' +
          (info.version ? '（v' + info.version + '）' : '') +
          '，工具调用与权限确认由 CLI 负责。',
      });

      let lastStatus = '';
      let lastStatusAt = 0;
      const onStderrChunk = (chunk: string): void => {
        const line = statusLine(chunk);
        if (!line || line === lastStatus || Date.now() - lastStatusAt < 700) {
          return;
        }
        lastStatus = line;
        lastStatusAt = Date.now();
        this.post({ type: 'generating', text: line });
      };

      const promptFor = (resumeId: string | undefined): string => {
        if (resumeId || this.cliHistory.length === 0) {
          return userContent;
        }
        const recent = this.cliHistory
          .slice(-6)
          .map((item) => (item.role === 'user' ? '用户：' : '豆包：') + item.text.trim().slice(0, 1500))
          .join('\n');
        return '以下是同一会话此前的对话，供参考：\n' + recent + '\n\n本轮请求：\n' + userContent;
      };

      const runOnce = (resumeId: string | undefined): Promise<import('../cli/runner').CliTaskResult> =>
        runCliTask({
          binary: info.binary as string,
          prompt: promptFor(resumeId),
          cwd,
          permissionMode: config.cliPermissionMode,
          model: config.cliModel,
          effort: config.cliEffort || undefined,
          resumeId,
          timeoutMs: config.cliTimeoutMs,
          signal: controller.signal,
          onStderrChunk,
        });

      const started = Date.now();
      let result = await runOnce(this.cliSessionId);
      if (!result.ok && /conflict|正在切换账号|please retry/i.test(result.stderr)) {
        this.post({ type: 'notice', text: 'CLI 正在切换账号，稍等 3 秒自动重试…' });
        await new Promise((resolve) => setTimeout(resolve, 3000));
        result = await runOnce(this.cliSessionId);
      }
      if (!result.ok && this.cliSessionId && isResumeRejected(result.stderr)) {
        this.cliSessionId = undefined;
        this.post({ type: 'notice', text: 'CLI 会话已失效，改为新会话重试…' });
        result = await runOnce(undefined);
      }
      if (result.sessionId) {
        this.cliSessionId = result.sessionId;
      }

      if (result.aborted) {
        this.post({ type: 'assistant_done', aborted: true, at: Date.now() });
        return;
      }
      if (result.timedOut) {
        this.post({
          type: 'error',
          message:
            '豆包 CLI 执行超时（' +
            Math.round(config.cliTimeoutMs / 1000) +
            's），可在设置里调大 doubao.cli.timeoutMs。',
        });
        this.post({ type: 'assistant_done', aborted: true, at: Date.now() });
        return;
      }
      if (!result.ok) {
        const detail = statusLine(result.stderr, 500) || result.error || '退出码 ' + result.code;
        const loginRequired = /login_required|未登录|not logged|login required|unauthorized|401/i.test(result.stderr + ' ' + detail);
        if (loginRequired) {
          this.post({
            type: 'error',
            message: '豆包 CLI 执行失败：' + detail + '\n\n已自动打开登录终端；扫码登录成功后会重试刚才的任务。',
          });
          this.post({ type: 'assistant_done', aborted: true, at: Date.now() });
          void this.handleCliLoginRequired(config, userContent);
          return;
        }
        this.post({ type: 'error', message: '豆包 CLI 执行失败：' + detail });
        this.post({ type: 'assistant_done', aborted: true, at: Date.now() });
        return;
      }

      const text = result.text;
      if (!text) {
        this.post({ type: 'notice', text: '豆包 CLI 没有输出文本（任务可能已完成，可到终端里查看 CLI 日志）。' });
      } else {
        this.assistantBuf += text;
        this.post({ type: 'assistant_delta', text });
        this.post({ type: 'ast', blocks: this.localizeBlocks(parseMarkdownBlocks(this.assistantBuf)) });
        this.cliHistory.push({ role: 'user', text: userContent }, { role: 'assistant', text });
        if (this.cliHistory.length > 8) {
          this.cliHistory = this.cliHistory.slice(-8);
        }
      }
      this.post({
        type: 'notice',
        text: '豆包 CLI 已完成，用时 ' + Math.max(1, Math.round((Date.now() - started) / 1000)) + 's',
      });
      this.post({ type: 'assistant_done', aborted: false, at: Date.now() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logErrorLevel('CLI 通道失败', err);
      this.post({ type: 'error', message: '豆包 CLI 调用失败：' + message });
      this.post({ type: 'assistant_done', aborted: true, at: Date.now() });
    } finally {
      this.running = false;
      this.abortController = undefined;
      this.persistTurn();
      this.postSources(this.assistantBuf);
      if (!this.disposed) {
        this.postState();
      }
      this.drainQueuedUser();
    }
  }

  private async runDesktop(config: DoubaoConfig, userContent: string): Promise<void> {
    // 先把桌面端模式/模型对齐，再拼提示词：保证「当前模型：…」和工具栏显示的是同一个。
    const desktopMode = this.desktopModeFor(config);
    await this.ensureDesktopWorkMode(desktopMode);
    await this.ensureDesktopConversation(this.lastDesktopTitle);
    const effective = pickEffectiveModel({
      mode: desktopMode,
      taskModel: this.taskModel,
      taskReasoning: this.taskReasoning,
      desktopModel: this.desktopModel,
      desktopReasoning: this.desktopReasoning,
      configDesktopModel: config.desktopModel,
      configDesktopReasoning: config.desktopReasoning,
      configModel: config.model,
      authMode: config.authMode,
    });
    const systemPrompt = await buildSystemPrompt(config, effective);
    const controller = new AbortController();
    this.abortController = controller;
    this.running = true;
    this.postState();

    const runtime: ToolRuntime = {
      config,
      extensionContext: this.context,
      confirmTerminal: (command, cwd) => this.confirmTerminal(command, cwd),
      externalTools: this.externalTools?.(),
      confirmRisk: (call, verdict) => this.confirmRisky(call.name, call.args, verdict.level, verdict.reason),
    };

    // 任务期间持续定时同步（1000ms），与一问一答的轮询互不干扰
    SyncPoller.start({
      port: config.desktopPort,
      intervalMs: 1000,
      onSnapshot: (snap: SyncSnapshot) => {
        void this.pushSyncSnapshot(snap);
      },
    })
      .then((poller: SyncPoller) => {
        this.syncPoller = poller;
      })
      .catch((err: unknown) => warn('启动定时同步失败', err instanceof Error ? err.message : String(err)));

    try {
      if (config.ptcEnabled) {
        // PTC 模式：文本工具体 + 多轮，能读写工作区
        const prompt = [
          systemPrompt,
          buildPtcPromptSection(runtime.externalTools?.definitions() ?? []),
          '----- 以下是编辑器上下文与用户请求 -----',
          userContent,
        ].join('\n\n');
        log('PTC：开始', `${prompt.length} 字符`, `port=${config.desktopPort}`, `maxRounds=${config.ptcMaxRounds}`);

        const force = this.forceNewChat;
        this.forceNewChat = false;
        const agent = new PtcAgent(
          config,
          runtime,
          {
            onTextDelta: (text) => {
            this.assistantBuf += text;
            this.post({ type: 'assistant_delta', text: this.localizeText(text) });
          },
            onImage: (image) => this.post({ type: 'image', url: image.url, full: image.fullUrl, alt: image.alt }),
            onToolStart: (event) =>
              this.post({ type: 'tool_start', id: event.id, name: event.name, arguments: event.arguments }),
            onToolEnd: (event) =>
              this.post({ type: 'tool_end', id: event.id, name: event.name, ok: event.ok, content: event.content }),
            onRoundStart: (round) => log('PTC：第', round, '轮'),
            onDone: (info) => log('PTC：结束', `rounds=${info.rounds}`, `aborted=${info.aborted}`),
          },
          force || undefined,
        );

        const result = await agent.run(prompt, controller.signal);
        if (result.toolCalls > 0) {
          this.post({
            type: 'assistant_delta',
            text: `\n\n> 本轮共执行 ${result.toolCalls} 次工具调用（${result.rounds} 轮）。`,
          });
        }
        this.post({ type: 'assistant_done', aborted: result.aborted, at: Date.now() });
        return;
      }

      // 纯对话（关闭 PTC 时）
      const prompt = `${systemPrompt}\n\n----- 以下是编辑器上下文与用户请求 -----\n${userContent}`;
      log('桌面端通道：开始提问', `${prompt.length} 字符`, `port=${config.desktopPort}`);
      const result = await askDesktop(prompt, {
        port: config.desktopPort,
        newChat: config.desktopNewChat,
        timeoutMs: config.desktopTimeoutMs,
        signal: controller.signal,
        onDelta: (text) => {
          this.assistantBuf += text;
          this.post({ type: 'assistant_delta', text });
          if (!this.tabTitleDirty) {
            this.tabTitleDirty = true;
            void this.refreshTabTitleFromDesktop();
          }
        },
        onImage: (image) => this.post({ type: 'image', url: image.url, full: image.fullUrl, alt: image.alt }),
        onStatus: (text) => this.post({ type: 'generating', text }),
      });
      if (result.timedOut) {
        this.post({ type: 'error', message: `等待豆包回复超时（${config.desktopTimeoutMs}ms），可调大 doubao.desktop.timeoutMs。` });
      }
      if (this.assistantBuf.trim()) {
        this.post({ type: 'ast', blocks: this.localizeBlocks(parseMarkdownBlocks(this.assistantBuf)) });
      }
      this.post({ type: 'assistant_done', aborted: result.aborted, at: Date.now() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logErrorLevel('桌面端通道失败', err);
      this.post({ type: 'error', message });
      this.post({ type: 'assistant_done', aborted: true, at: Date.now() });
    } finally {
      this.syncPoller?.stop('本轮结束');
      this.syncPoller = undefined;
      this.running = false;
      this.abortController = undefined;
      this.persistTurn();
      this.postSources(this.assistantBuf);
      void this.refreshTabTitleFromDesktop();
      if (!this.disposed) {
        this.postState();
      }
      // 这一轮结束了，但豆包还在执行：自动续一句「继续说」并持续同步，状态不再是「就绪」
      {
        void (async () => {
          const stillRunning = await isDesktopRunning(readConfig().desktopPort).catch(() => false);
          if (stillRunning && !this.disposed && !this.running) {
            if (this.autoResumeCount >= 20) {
              log('回合结束但豆包仍在执行：自动续跑达到上限，停止续发');
              return;
            }
            this.autoResumeCount += 1;
            log('回合结束但豆包仍在执行，自动续「继续说」', this.autoResumeCount);
            this.resumeRunningHistory(this.lastDesktopTitle || '当前任务');
          }
        })();
      }
      this.drainQueuedUser();
    }
  }

  private async runAgent(config: DoubaoConfig, userContent: string): Promise<void> {
    const systemPrompt = await buildSystemPrompt(config, { model: config.model, reasoning: '' });
    const client = new ArkClient(config);
    const controller = new AbortController();
    this.client = client;
    this.abortController = controller;
    this.running = true;
    this.postState();

    const runtime: ToolRuntime = {
      config,
      extensionContext: this.context,
      confirmTerminal: (command, cwd) => this.confirmTerminal(command, cwd),
      externalTools: this.externalTools?.(),
      confirmRisk: (call, verdict) => this.confirmRisky(call.name, call.args, verdict.level, verdict.reason),
    };

    const loop = new AgentLoop(client, runtime, {
      onTextDelta: (text) => {
        this.assistantBuf += text;
        this.post({ type: 'assistant_delta', text });
      },
      onToolStart: (event: ToolStartEvent) => {
        this.post({ type: 'tool_start', id: event.id, name: event.name, arguments: event.arguments });
      },
      onToolEnd: (event) => {
        this.post({ type: 'tool_end', id: event.id, name: event.name, ok: event.ok, content: event.content });
      },
      onRoundStart: (round) => {
        log('Agent 开始第', round, '轮');
      },
    }, config.maxToolIterations);

    try {
      const result = await loop.run(trimHistory(this.history), userContent, controller.signal, systemPrompt);
      this.history = trimHistory(result.messages);
      this.post({ type: 'assistant_done', aborted: result.aborted, at: Date.now() });
    } catch (err) {
      if (err instanceof ArkError && err.aborted) {
        log('Agent 已中止');
      } else if (err instanceof ArkError) {
        this.post({ type: 'error', message: err.message });
      } else if (err instanceof Error) {
        logErrorLevel('Agent 运行失败', err);
        this.post({ type: 'error', message: `出错了：${err.message}` });
      } else {
        this.post({ type: 'error', message: `出错了：${String(err)}` });
      }
      this.post({ type: 'assistant_done', aborted: true, at: Date.now() });
    } finally {
      this.running = false;
      this.client = undefined;
      this.abortController = undefined;
      if (!this.disposed) {
        this.postState();
      }
      this.persistTurn();
      this.drainQueuedUser();
    }
  }

  /** 接收 webview 粘贴进来的图片/文件：落盘到工作区 .doubao/attachments 后作为附件。 */
  private async acceptPastedFiles(
    files: Array<{ name: string; mime: string; base64: string }>,
  ): Promise<void> {
    if (!Array.isArray(files) || files.length === 0) {
      return;
    }
    // 同一次粘贴被重复触发时直接忽略
    const signature = files.map((f) => `${f.name}:${f.mime}:${(f.base64 || '').length}`).join('|');
    if (signature === this.lastPasteSignature && Date.now() - this.lastPasteAt < 1000) {
      log('忽略重复的粘贴事件');
      return;
    }
    this.lastPasteSignature = signature;
    this.lastPasteAt = Date.now();
    const root = workspaceRoot();
    let dirUri: vscode.Uri | undefined;
    if (root) {
      dirUri = vscode.Uri.joinPath(vscode.Uri.file(root), '.doubao', 'attachments');
      try {
        await vscode.workspace.fs.createDirectory(dirUri);
      } catch (err) {
        warn('创建附件目录失败', err instanceof Error ? err.message : String(err));
        dirUri = undefined;
      }
    }

    for (const file of files) {
      const mime = String(file.mime || '');
      const name = String(file.name || '粘贴文件');
      const buffer = Buffer.from(String(file.base64 || ''), 'base64');
      if (!buffer.length) {
        continue;
      }
      const isImage = mime.startsWith('image/');
      if (dirUri) {
        const safe = name.replace(/[\\/:*?"<>|]/g, '_');
        const target = vscode.Uri.joinPath(dirUri, `${Date.now()}_${safe}`);
        try {
          await vscode.workspace.fs.writeFile(target, buffer);
          const rel = vscode.workspace.asRelativePath(target, false);
          this.pendingAttachments.push({
            name: safe,
            path: rel,
            dataUrl:
              isImage && buffer.length <= 2 * 1024 * 1024
                ? `data:${mime || 'image/png'};base64,${buffer.toString('base64')}`
                : undefined,
            note: isImage
              ? `粘贴的图片（${Math.round(buffer.length / 1024)} KB）`
              : `粘贴的文件（${Math.round(buffer.length / 1024)} KB）`,
          });
          continue;
        } catch (err) {
          warn('保存粘贴文件失败', safe, err instanceof Error ? err.message : String(err));
        }
      }
      if (!isImage && buffer.length <= 256 * 1024) {
        this.pendingAttachments.push({ name, text: buffer.toString('utf8') });
      } else {
        this.pendingAttachments.push({ name, note: `粘贴的图片（${Math.round(buffer.length / 1024)} KB，未能保存）` });
      }
    }
    this.postAttachments();
    log('粘贴附件', `${files.length} 个`);
  }

  /** 选择本地文件/图片作为附件（+ 按钮）。 */
  private async pickFiles(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: '添加',
      title: '上传文件或图片（会随下一条消息一起发送）',
      filters: {
        代码与文本: ['ts', 'tsx', 'js', 'jsx', 'json', 'md', 'txt', 'py', 'c', 'h', 'cpp', 'hpp', 'cs', 'java', 'go', 'rs', 'html', 'css', 'yml', 'yaml', 'sh', 'ps1', 'toml', 'ini'],
        图片: ['png', 'jpg', 'jpeg', 'webp', 'gif'],
      },
    });
    if (!picked || picked.length === 0) {
      return;
    }
    const TEXT_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'json', 'md', 'txt', 'py', 'c', 'h', 'cpp', 'hpp', 'cs', 'java', 'go', 'rs', 'html', 'css', 'yml', 'yaml', 'sh', 'ps1', 'toml', 'ini']);
    for (const uri of picked) {
      const name = uri.path.split('/').pop() || uri.fsPath;
      const ext = (name.split('.').pop() || '').toLowerCase();
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (TEXT_EXT.has(ext) && stat.size <= 256 * 1024) {
          const bytes = await vscode.workspace.fs.readFile(uri);
          this.pendingAttachments.push({ name, text: Buffer.from(bytes).toString('utf8') });
        } else if (TEXT_EXT.has(ext)) {
          this.pendingAttachments.push({ name, note: `文件较大（${Math.round(stat.size / 1024)} KB），只附文件名` });
        } else {
          this.pendingAttachments.push({ name, note: `图片（${Math.round(stat.size / 1024)} KB，仅附文件名）` });
        }
      } catch (err) {
        warn('读取附件失败', name, err instanceof Error ? err.message : String(err));
      }
    }
    this.postAttachments();
    log('已添加附件', this.pendingAttachments.map((a) => a.name).join(', '));
  }

  /** 把附件内容拼进用户消息（发完即清空）。 */
  private composeWithAttachments(text: string): string {
    if (this.pendingAttachments.length === 0) {
      return text;
    }
    const blocks = this.pendingAttachments.map((item) => {
      if (item.text !== undefined) {
        return `【附件：${item.name}】\n\`\`\`\n${item.text}\n\`\`\``;
      }
      if (item.path) {
        return `【附件：${item.name}】路径 ${item.path}${item.note ? `（${item.note}）` : ''}`;
      }
      return `【附件：${item.name}】${item.note ? `（${item.note}）` : ''}`;
    });
    const merged = `${blocks.join('\n\n')}\n\n----- 用户消息 -----\n${text}`;
    this.pendingAttachments = [];
    this.postAttachments();
    return merged;
  }

  private postAttachments(): void {
    this.post({ type: 'attachments', items: this.pendingAttachments.map((a) => a.name) });
  }

  /** 当前操作的代号：取消时自增，让在途结果作废。 */
  private opSeq = 0;

  /**
   * 给一次可能卡住的操作套上总预算：超时就报错返回 undefined。
   * CDP 调用本身有单次超时，但串联多步时仍可能长时间无反馈，这里兜底。
   */
  private async runWithBudget<T>(
    label: string,
    budgetMs: number,
    fn: (gen: number) => Promise<T>,
    options?: { silent?: boolean },
  ): Promise<T | undefined> {
    const gen = ++this.opSeq;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raced = await Promise.race<T | undefined>([
        fn(gen),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), budgetMs);
        }),
      ]);
      if (raced === undefined) {
        warn('操作超时', label, `${budgetMs}ms`);
        if (!options?.silent) {
          this.post({
            type: 'error',
            message: `${label}超时（${Math.round(budgetMs / 1000)}s）已中止，可再点一次重试；也可以先把豆包窗口切到前台再试。`,
          });
        }
      }
      return raced;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  /** 去掉我们注入的提示词/上下文，只留用户真正说的话（回放历史时用）。 */
  private stripInjectedPrompt(text: string): string {
    let out = String(text || '');
    const markers = [
      '----- 以下是编辑器上下文与用户请求 -----',
      '----- 用户消息 -----',
    ];
    for (const marker of markers) {
      const at = out.lastIndexOf(marker);
      if (at >= 0) {
        out = out.slice(at + marker.length);
      }
    }
    out = out.replace(/^【任务模式】/, '').trim();
    return out || text;
  }

  /** 删除某一轮（按助手回复文本匹配），并从本地记忆里一并移除。 */
  private deleteTurn(assistantText: string): void {
    const target = String(assistantText || '').trim();
    const record = this.sessions.get(this.sessionId);
    if (!record || !target) {
      return;
    }
    const turns = record.turns.slice();
    const idx = turns.findIndex((turn) => turn.role === 'assistant' && turn.text.trim() === target);
    if (idx < 0) {
      this.post({ type: 'notice', text: '本地记忆里没找到这一轮（可能已被裁剪）' });
      return;
    }
    const start = idx > 0 && turns[idx - 1].role === 'user' ? idx - 1 : idx;
    turns.splice(start, idx - start + 1);
    this.sessions.upsert({ ...record, turns });
    this.post({ type: 'notice', text: '已从本地记忆删除这一轮' });
    log('删除一轮', record.id, `${turns.length} 条剩余`);
  }

  /** 把本轮对话写入本地会话记忆（可跨重启回放）。 */
  private persistTurn(): void {
    const user = this.lastUserText.trim();
    const assistant = this.assistantBuf.trim();
    if (!user || !assistant) {
      return;
    }
    try {
      const record = this.sessions.append(this.sessionId, { user, assistant });
      this.ensureTab(record.id);
      log('会话已记忆', record.id, record.title, `${record.turns.length} 条`);
    } catch (err) {
      warn('会话记忆失败', err instanceof Error ? err.message : String(err));
    }
  }

  /** 批量删除本地会话。 */
  private async handleSessionBatch(action: string, ids: string[]): Promise<void> {
    if (action !== 'delete' || ids.length === 0) {
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `确定删除选中的 ${ids.length} 个本地会话？`,
      { modal: true },
      '删除',
    );
    if (answer !== '删除') {
      return;
    }
    for (const id of ids) {
      this.sessions.remove(id);
      if (this.sessionId === id) {
        this.sessionId = newSessionId();
      }
    }
    this.post({ type: 'notice', text: `已删除 ${ids.length} 个会话` });
    log('批量删除会话', `${ids.length} 个`);
    await this.sendHistory();
  }

  /** 导出单个会话为 Markdown。 */
  private async exportSession(record: { id: string; title: string; turns: Array<{ role: string; text: string }> }): Promise<void> {
    const safeTitle = (record.title || '会话').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
    const uri = await vscode.window.showSaveDialog({
      title: '导出会话',
      saveLabel: '导出',
      defaultUri: vscode.Uri.file(path.join(workspaceRoot() ?? '', `${safeTitle}.md`)),
      filters: { Markdown: ['md'] },
    });
    if (!uri) {
      return;
    }
    const lines: string[] = [`# ${record.title}`, '', `> 会话 ID：${record.id}`, ''];
    for (const turn of record.turns) {
      lines.push(turn.role === 'user' ? '## 你' : '## 豆包', '', turn.text, '');
    }
    await fs.promises.writeFile(uri.fsPath, lines.join('\n'), 'utf8');
    this.post({ type: 'notice', text: `已导出到 ${path.basename(uri.fsPath)}` });
    log('会话已导出', uri.fsPath);
  }

  /** 把「本地记忆 + 豆包对话列表」推给 webview 渲染成菜单。 */
  /** 会话操作：置顶 / 重命名 / 复制 ID / 归档 / 删除。 */
  private async handleSessionAction(id: string, action: string, _value: string): Promise<void> {
    const record = this.sessions.get(id);
    if (!record) {
      this.post({ type: 'notice', text: '这个会话已经不存在了' });
      return;
    }
    switch (action) {
      case 'pin':
        this.sessions.setPinned(id, !record.pinned);
        this.post({ type: 'notice', text: record.pinned ? '已取消置顶' : '已置顶' });
        break;
      case 'archive':
        this.sessions.setArchived(id, !record.archived);
        this.post({ type: 'notice', text: record.archived ? '已取消归档' : '已归档' });
        break;
      case 'rename': {
        const input = await vscode.window.showInputBox({
          title: '重命名会话',
          value: record.title,
          prompt: '最多 60 个字符',
          ignoreFocusOut: true,
        });
        if (input && this.sessions.rename(id, input)) {
          this.post({ type: 'notice', text: `已重命名为「${input.trim()}」` });
        }
        break;
      }
      case 'copyId':
        await vscode.env.clipboard.writeText(id);
        this.post({ type: 'notice', text: `已复制会话 ID：${id}` });
        break;
      case 'export':
        await this.exportSession(record);
        break;
      case 'delete':
        this.sessions.remove(id);
        this.post({ type: 'notice', text: '已删除这个会话' });
        if (this.sessionId === id) {
          this.sessionId = newSessionId();
        }
        break;
      default:
        break;
    }
    await this.sendHistory();
  }

  /** MCP 工具 report_state 推来的状态：转给界面，作为"仍在处理"的权威信号。 */
  public applyMcpState(state: Record<string, unknown>): void {
    this.post({ type: 'mcpState', state });
  }

  /** 推送「安装 / 登录 / 启动」检查结果给界面。 */
  private async pushSetup(): Promise<void> {
    const config = readConfig();
    if (config.authMode === 'cli') {
      if (this.cliSetupPosted) {
        return;
      }
      this.cliSetupPosted = true;
      void detectCli(config.cliPath)
        .then((info) => {
          if (this.disposed) {
            return;
          }
          this.post({
            type: 'notice',
            text: info.installed
              ? '豆包 CLI 已就绪' + (info.version ? '（v' + info.version + '）' : '') + '，任务会交给 CLI 执行。'
              : '未检测到豆包 CLI：执行「豆包: 选择连接方式」按提示安装并登录。',
          });
        })
        .catch(() => undefined);
      return;
    }
    if (config.authMode !== 'desktop') {
      return;
    }
    const state = await checkEnvironment(config.desktopPort);
    this.setupState = state;
    this.post({ type: 'setup', state });
    log('环境检查', state.step, state.detail);
  }

  /** 引导卡片上的按钮：打开下载页 / 打开豆包 / 以调试端口启动 / 重新检测。 */
  private async handleSetupAction(action: string): Promise<void> {
    switch (action) {
      case 'download':
        await vscode.env.openExternal(vscode.Uri.parse('https://www.doubao.com/download'));
        break;
      case 'open':
      case 'launch': {
        await vscode.commands.executeCommand('doubao.launchDesktop');
        await new Promise((resolve) => setTimeout(resolve, 2500));
        break;
      }
      default:
        break;
    }
    await this.pushSetup();
  }

  private async sendHistory(): Promise<void> {
    const local = this.sessions.list().map((item) => ({
      id: item.id,
      title: (item.pinned ? '📌 ' : '') + item.title,
      time: `${new Date(item.updatedAt).toLocaleString()} · ${item.id.slice(-4)}`,
      pinned: Boolean(item.pinned),
      archived: Boolean(item.archived),
      desktopTitle: item.desktopTitle || '',
      desktopId: item.desktopId || '',
    }));
    const config = readConfig();
    let desktop: { ok: boolean; items: Array<{ index: number; id?: string; title: string; time: string; status?: string; running?: boolean }>; error?: string } = {
      ok: false,
      items: [],
      error: '仅桌面端免 Key 模式可读取豆包对话列表',
    };
    if (config.authMode === 'desktop') {
      this.post({ type: 'historyMenu', loading: true, loadingText: '正在同步豆包对话…', local, desktop: { ok: true, items: [] } });
      const collected = await collectAllDesktopConversations(config.desktopPort, (count) => {
        this.post({
          type: 'historyMenu',
          loading: true,
          loadingText: '正在同步豆包对话…（已 ' + count + ' 条）',
          local,
          desktop: { ok: true, items: [] },
        });
      });
      desktop = { ok: collected.ok, items: collected.items, error: collected.error };
    }
    const reconciled = desktop.ok
      ? local.map((item) => ({
          ...item,
          desktopMissing: Boolean(item.desktopTitle) && !hasConversation(item.desktopTitle, desktop.items),
        }))
      : local;
    this.post({ type: 'historyMenu', local: reconciled, desktop });
    if (this.setupState && !this.setupState.ready) {
      this.post({ type: 'setup', state: this.setupState });
    }
  }

  /** 回放本地会话（渲染成消息流，继续对话沿用同一 sessionId）。 */
  /** 工作区文件列表（@ 文件选择器用）。 */
  private async sendWorkspaceFiles(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.post({ type: 'workspaceFiles', files: [] });
      return;
    }
    const uris = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**}', 300);
    const files = uris
      .map((uri) => path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/'))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    this.post({ type: 'workspaceFiles', files });
  }

  /** 撤销最近一次被接受的 AI 改动。 */
  public async undoLastAccepted(): Promise<void> {
    const last = this.acceptedStack.pop();
    if (!last) {
      this.post({ type: 'notice', text: '没有可撤销的已接受改动' });
      return;
    }
    try {
      await vscode.workspace.fs.writeFile(vscode.Uri.file(last.path), Buffer.from(last.before, 'utf8'));
      this.post({ type: 'notice', text: '已撤销改动：' + last.path + '（剩余可撤销 ' + this.acceptedStack.length + ' 次）' });
    } catch (err) {
      this.post({ type: 'error', message: '撤销失败：' + (err instanceof Error ? err.message : String(err)) });
    }
  }

  /** 接受改动后自动构建；失败自动把输出发给豆包修复。 */
  private async autoVerifyAfterAccept(): Promise<void> {
    const config = readConfig();
    if (!config.autoVerifyAfterAccept || this.running || this.disposed) {
      return;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    if (!root) {
      return;
    }
    this.post({ type: 'notice', text: '已接受改动，正在自动构建验证…' });
    const result = await this.runVerification('build');
    if (result.ok) {
      return;
    }
    if (!result.command) {
      return;
    }
    if (!this.running && !this.disposed) {
      this.post({ type: 'notice', text: '自动验证失败，已把输出交给豆包定位修复。' });
      await this.askAboutVerification();
    }
  }

  /** 估算本次上下文规模并推给界面。 */
  private postContextInfo(rawText: string, refs: ContextRefs): void {
    const items: Array<{ label: string; tokens: number }> = [];
    const editor = vscode.window.activeTextEditor;
    try {
      if (refs.currentFile && editor) {
        items.push({ label: '当前文件', tokens: Math.ceil(Math.min(editor.document.getText().length, 4000) / 4) });
      }
      if (refs.selection && editor && !editor.selection.isEmpty) {
        items.push({ label: '选区', tokens: Math.ceil(editor.document.getText(editor.selection).length / 4) });
      }
      if (refs.diagnostics && editor) {
        const count = vscode.languages.getDiagnostics(editor.document.uri).length;
        if (count > 0) {
          items.push({ label: '诊断 ' + count + ' 条', tokens: count * 40 });
        }
      }
    } catch {
      /* 忽略读取失败 */
    }
    const mentions = Array.from(String(rawText || '').matchAll(/@([\w./\\-]+)/g)).slice(0, 6);
    let mentionTokens = 0;
    mentionTokens = mentions.length * 800;
    if (mentions.length > 0) {
      items.push({ label: mentions.length + ' 个 @ 引用', tokens: mentionTokens });
    }
    const total = items.reduce((sum, item) => sum + item.tokens, 0);
    this.post({ type: 'contextInfo', total, items });
  }

  /** 断线重连：重新检测并尝试以调试端口启动豆包。 */
  public async reconnectDesktop(): Promise<void> {
    const config = readConfig();
    if (config.authMode !== 'desktop') {
      this.post({ type: 'notice', text: '当前不是桌面端模式，无需重连。' });
      return;
    }
    this.post({ type: 'notice', text: '正在重新检测豆包连接…' });
    const state = await checkEnvironment(config.desktopPort);
    this.setupState = state;
    this.post({ type: 'setup', state });
    if (state.ready) {
      this.post({ type: 'notice', text: '豆包连接已恢复。' });
      return;
    }
    this.post({ type: 'notice', text: state.detail });
    if (state.installed && (state.code === 'port-closed' || state.code === 'port-not-cdp')) {
      try {
        await vscode.commands.executeCommand('doubao.launchDesktop');
      } catch (err) {
        warn('断线重连启动失败', err instanceof Error ? err.message : String(err));
      }
    }
  }

  /** 运行构建/测试并把输出回填到面板。 */
  private async runVerification(kind: VerifyKind): Promise<import('./verify').VerifyResult> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const config = readConfig();
    const override = kind === 'build' ? config.verifyBuildCommand : config.verifyTestCommand;
    this.post({ type: 'verifyStart', kind });
    const result = await runVerify(root, kind, override);
    this.lastVerify = { kind, command: result.command, output: result.output };
    this.post({
      type: 'verifyResult',
      kind,
      ok: result.ok,
      code: result.code,
      command: result.command,
      output: result.output,
      error: result.error,
      locations: parseVerifyLocations(result.output),
    });
    log(result.ok ? '验证通过' : '验证失败', kind, result.command || '(无命令)');
    return result;
  }

  /** 把失败的构建/测试输出作为上下文，让豆包修。 */
  private async askAboutVerification(): Promise<void> {
    const last = this.lastVerify;
    if (!last) {
      this.post({ type: 'notice', text: '还没有构建/测试结果' });
      return;
    }
    const label = last.kind === 'build' ? '构建' : '测试';
    await this.askFromCommand(
      `以下是最近一次${label}的输出（命令：${last.command}），请定位失败原因并修复；修改代码用 apply_patch（会先进入审阅）。\n\n\x60\x60\x60\n${last.output}\n\x60\x60\x60`,
      {},
    );
  }

  /** AI 写文件前的审阅：先发提案给界面，用户接受后才落盘。 */
  private requestReview(filePath: string, before: string, after: string): 'apply' | 'review' | 'reject' {
    if (!readConfig().reviewEdits) {
      return 'apply';
    }
    const id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    const hunks = computeHunks(before, after);
    this.pendingProposals.set(id, { path: filePath, before, after, hunks });
    this.post({ type: 'proposal', id, path: filePath, before, after, hunks });
    log('待审阅改动', filePath, after.length + ' 字');
    return 'review';
  }

  /** 处理审阅卡片：接受写盘 / 拒绝 / 查看差异。 */
  private async handleProposal(id: string, action: string, selectedHunks?: number[]): Promise<void> {
    const proposal = this.pendingProposals.get(id);
    if (!proposal) {
      this.post({ type: 'notice', text: '这个改动已经处理过了' });
      return;
    }
    if (action === 'reject') {
      this.pendingProposals.delete(id);
      this.post({ type: 'notice', text: '已拒绝改动：' + proposal.path });
      return;
    }
    if (action === 'diff') {
      const original = vscode.Uri.file(proposal.path);
      const previewDir = vscode.Uri.joinPath(this.context.workspaceState ? vscode.Uri.file(this.projectRootForPreview()) : vscode.Uri.file('.'), '.doubao', 'preview');
      try {
        await vscode.workspace.fs.createDirectory(previewDir);
        const previewUri = vscode.Uri.joinPath(previewDir, 'proposal-' + id + '.new');
        await vscode.workspace.fs.writeFile(previewUri, Buffer.from(proposal.after, 'utf8'));
        await vscode.commands.executeCommand('vscode.diff', original, previewUri, '审阅改动：' + path.basename(proposal.path));
      } catch (err) {
        warn('打开差异失败', err instanceof Error ? err.message : String(err));
      }
      return;
    }
    try {
      const selected = Array.isArray(selectedHunks) && selectedHunks.length > 0
        ? selectedHunks
        : proposal.hunks.map((_, index) => index);
      const content = proposal.hunks.length > 0 ? applyHunks(proposal.before, proposal.hunks, selected) : proposal.after;
      await vscode.workspace.fs.writeFile(vscode.Uri.file(proposal.path), Buffer.from(content, 'utf8'));
      this.pendingProposals.delete(id);
      this.acceptedStack.push({ path: proposal.path, before: proposal.before });
      if (this.acceptedStack.length > 20) {
        this.acceptedStack.shift();
      }
      const skipped = proposal.hunks.length - selected.length;
      this.post({ type: 'notice', text: '已接受改动：' + proposal.path + (proposal.hunks.length > 0 ? '（应用 ' + selected.length + ' 块' + (skipped > 0 ? '，跳过 ' + skipped + ' 块' : '') + '）' : '') });
      void this.autoVerifyAfterAccept();
    } catch (err) {
      this.post({ type: 'error', message: '写入失败：' + (err instanceof Error ? err.message : String(err)) });
    }
  }

  private projectRootForPreview(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? folder.uri.fsPath : os.tmpdir();
  }

  /** 打开回复里点到的「文件:行」。 */
  private async openFileAt(pathText: string, line: number): Promise<void> {
    const wanted = String(pathText || '').replace(/^["']|["']$/g, '').trim();
    if (!wanted) {
      return;
    }
    const candidates: string[] = [];
    if (/^[A-Za-z]:[\\/]/.test(wanted)) {
      candidates.push(wanted);
    } else {
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        candidates.push(vscode.Uri.joinPath(folder.uri, wanted).fsPath);
      }
      candidates.push(wanted);
    }
    for (const candidate of candidates) {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(candidate));
        const lineIndex = Math.max(0, Math.min(doc.lineCount - 1, line > 0 ? line - 1 : 0));
        const position = new vscode.Position(lineIndex, 0);
        await vscode.window.showTextDocument(doc, {
          preview: false,
          selection: new vscode.Range(position, position),
        });
        return;
      } catch {
        /* 尝试下一个候选路径 */
      }
    }
    this.post({ type: 'notice', text: '没找到文件：' + wanted });
  }

  private openSession(id: string): void {
    const record = this.sessions.get(id);
    if (!record) {
      this.post({ type: 'notice', text: '这个会话已经不存在了' });
      return;
    }
    this.sessionId = record.id;
    this.cliSessionId = undefined;
    this.cliHistory = [];
    this.history = [];
    // 本地会话如果对应豆包里的某个对话，切回去并绑定，避免接着发到别的任务
    this.setActiveTarget(localTarget(record.id, record.desktopTitle || '', record.desktopId || ''));
    if (record.desktopTitle) {
      void this.ensureDesktopConversation(record.desktopTitle);
    }
    this.post({ type: 'history', title: record.title, turns: record.turns.map((t) => ({ role: t.role, text: t.text })) });
    log('回放会话', record.id, record.title, `${record.turns.length} 条`);
    this.ensureTab(record.id);
  }

  /** 切到豆包里的某个对话，并把它的历史内容同步到面板（后续提问接着它聊）。 */
  /** 从历史打开一个正在执行的任务时，恢复「进行中」状态并跟着刷新。 */
  private postTasks(): void {
    this.post({ type: 'tasks', tasks: this.backgroundTasks.slice(0, 8) });
  }

  private startBackgroundTask(id: string, title: string): void {
    this.backgroundTasks = this.backgroundTasks.filter((item) => item.id !== id);
    this.backgroundTasks.unshift({ id, title, status: 'running', startedAt: Date.now() });
    this.postTasks();
  }

  private updateBackgroundTask(id: string, progress: string, status: 'running' | 'failed' = 'running'): void {
    const task = this.backgroundTasks.find((item) => item.id === id);
    if (task) {
      task.progress = progress;
      task.status = status;
      this.postTasks();
    }
  }

  private finishBackgroundTask(id: string, status: 'done' | 'failed'): void {
    const task = this.backgroundTasks.find((item) => item.id === id);
    if (task) {
      task.status = status;
      this.postTasks();
    }
  }

  /** 收集回复里引用的「文件:行」，供来源面板。 */
  private postSources(text: string): void {
    const re = /([A-Za-z]:[\\/][^\s:()]+|(?:[\w.-]+[\\/])*[\w.-]+\.(?:ts|tsx|js|jsx|cs|cpp|hpp|h|py|rs|go|java|kt|md|json))[:(](\d+)/g;
    const seen = new Set<string>();
    const items: Array<{ path: string; line: number }> = [];
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) && items.length < 12) {
      const key = match[1] + ':' + match[2];
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      items.push({ path: match[1], line: Number(match[2]) });
    }
    if (items.length > 0) {
      this.post({ type: 'sources', items });
    }
  }

  private async watchRunningTask(title: string): Promise<void> {
    this.running = true;
    const controller = new AbortController();
    this.abortController = controller;
    this.postState();
    this.post({ type: 'notice', text: `「${title}」仍在豆包侧执行，正在同步进度…` });
    this.startBackgroundTask('watch:' + title, title);
    try {
      const result = await watchDesktop({
        port: readConfig().desktopPort,
        // 长任务可能跑很久，旁观上限放到 30 分钟
        timeoutMs: 30 * 60_000,
        expectTitle: title,
        signal: controller.signal,
        onBlocks: (blocks) => {
          this.post({ type: 'blocks', blocks });
          this.postSources(blocks.map((block) => (block.text || '') + ' ' + (block.detail || '')).join('\n'));
          this.updateBackgroundTask('watch:' + title, '同步中');
        },
        onStatus: (text) => {
          this.postIfActive(title, { type: 'notice', text });
        },
        onProgress: (state) => {
          this.postIfActive(title, { type: 'syncStatus', text: state.text, seconds: state.seconds, done: state.done });
          this.updateBackgroundTask('watch:' + title, state.text);
        },
      });
      log('旁观结束', result.reason);
    } catch (err) {
      warn('旁观任务失败', err instanceof Error ? err.message : String(err));
    } finally {
      this.running = false;
      this.abortController = undefined;
      this.finishBackgroundTask('watch:' + title, 'done');
      const suppress = this.pendingContinue;
      this.pendingContinue = false;
      const aborted = controller.signal.aborted;
      if (!this.disposed) {
        this.postState();
        this.post({ type: 'notice', text: aborted ? '已停止旁观' : '任务已结束' });
        // 由面板负责续「继续说」时，抑制 webview 的 5 秒自动继续，避免重复发送
        this.post({ type: 'assistant_done', aborted, at: Date.now(), autoSuppress: suppress });
        if (suppress) {
          if (aborted) {
            const idx = this.queuedUser.findIndex((item) => item.text === '继续说');
            if (idx >= 0) {
              this.queuedUser.splice(idx, 1);
            }
          } else {
            this.drainQueuedUser();
          }
        }
      }
    }
  }

  /** 打开的历史任务仍在执行：排队「继续说」，并旁观到结束。 */
  private resumeRunningHistory(title: string): void {
    if (this.running || this.disposed) {
      return;
    }
    if (readConfig().autoContinue && !this.pendingContinue) {
      this.pendingContinue = true;
      this.queuedUser.push({ text: '继续说', refs: {} });
      this.post({ type: 'notice', text: '检测到任务仍在执行：已自动排队「继续说」，本次执行结束后继续推进' });
    }
    void this.watchRunningTask(title);
  }

  /** CLI 未登录：在对话里渲染登录二维码，轮询登录状态，成功后自动重试一次。 */
  private cliLoginProcess: import('node:child_process').ChildProcess | undefined;

  private async handleCliLoginRequired(config: DoubaoConfig, retryText: string): Promise<void> {
    const token = (this.cliLoginToken += 1);
    const info = await detectCli(config.cliPath).catch(() => undefined);
    if (!info || !info.installed || !info.binary) {
      this.post({ type: 'notice', text: '没有检测到豆包 CLI，请先安装后再登录。' });
      return;
    }
    this.post({ type: 'notice', text: '检测到 CLI 未登录：正在获取登录二维码…' });
    let qrShown = false;
    try {
      const child = startCliLogin({
        binary: info.binary,
        cwd: workspaceRoot() || undefined,
        onQr: (qrPath) => {
          qrShown = true;
          void this.showCliLoginQr(qrPath);
        },
      });
      this.cliLoginProcess = child;
      child.on('exit', () => {
        if (this.cliLoginProcess === child) {
          this.cliLoginProcess = undefined;
        }
      });
      for (let i = 0; i < 45; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 4000));
        if (token !== this.cliLoginToken || this.disposed) {
          return;
        }
        if (!qrShown && i === 2) {
          this.post({ type: 'notice', text: '未拿到二维码图片，改为在终端里扫码登录；完成后会自动重试。' });
          void vscode.commands.executeCommand('doubao.cliLogin');
        }
        const auth = await checkCliAuth(info).catch(() => ({ loggedIn: false, detail: '' }));
        if (auth.loggedIn) {
          this.post({ type: 'notice', text: 'CLI 登录成功，正在自动重试刚才的任务…' });
          if (!this.running && !this.disposed) {
            void this.handleUser(retryText, {});
          }
          return;
        }
        if (i > 0 && i % 5 === 0) {
          this.post({ type: 'notice', text: '等待扫码登录中…（' + i * 4 + ' 秒）' });
        }
      }
      this.post({ type: 'notice', text: '还没检测到登录完成：完成扫码后再发一次即可。' });
    } finally {
      this.cliLoginProcess?.kill();
      this.cliLoginProcess = undefined;
    }
  }

  /** 把 CLI 生成的二维码图片渲染进对话。 */
  private async showCliLoginQr(pathText: string): Promise<void> {
    const data = await readQrFile(pathText, 6000);
    if (!data) {
      this.post({ type: 'notice', text: '二维码图片还没生成好，可执行「豆包: 登录 CLI」在终端扫码。' });
      return;
    }
    const mime = /\.jpe?g$/i.test(pathText) ? 'image/jpeg' : 'image/png';
    this.post({ type: 'image', url: 'data:' + mime + ';base64,' + data.toString('base64'), alt: '豆包 CLI 登录二维码' });
    this.post({ type: 'notice', text: '请用豆包 App 扫描上方二维码登录；登录成功后会自动重试刚才的任务。' });
  }
  /** 本地图片 → data URL（带缓存；只处理盘符/file: 路径）。 */
  private imageFileData(src: string): string | undefined {
    if (this.imageDataCache.has(src)) {
      return this.imageDataCache.get(src);
    }
    const local = localImagePath(src) ?? (/^[A-Za-z]:[\\/]/.test(src) ? src : undefined);
    let data: string | undefined;
    const candidates: string[] = [];
    if (local) {
      candidates.push(local);
    } else if (!/^(data:|https?:|blob:|file:)/i.test(src) && /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(src)) {
      // 相对路径：依次尝试工作区、当前项目目录
      const roots = [
        ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
        'C:\\project-x',
      ];
      for (const root of roots) {
        candidates.push(path.join(root, src));
      }
    }
    for (const candidate of candidates) {
      try {
        const stat = fs.statSync(candidate);
        const type = mimeForImage(candidate);
        if (stat.isFile() && stat.size <= 12 * 1024 * 1024 && type) {
          data = `data:${type};base64,${fs.readFileSync(candidate).toString('base64')}`;
          break;
        }
      } catch {
        /* 继续尝试下一个根目录 */
      }
    }
    this.imageDataCache.set(src, data);
    return data;
  }

  /** 单段文本里的本地图片路径 → data URL（流式增量也要处理）。 */
  private localizeText(text: string): string {
    return convertLocalImages(text, (file) => this.imageFileData(file));
  }

  /** 图片消息统一先本地化，避免 webview 拿到盘符路径。 */
  private postImage(image: { url: string; fullUrl?: string; alt?: string }): void {
    const url = this.imageFileData(image.url) ?? image.url;
    const full = image.fullUrl ? (this.imageFileData(image.fullUrl) ?? image.fullUrl) : url;
    this.post({ type: 'image', url, full, alt: image.alt });
  }

  /** 把 Markdown 里的本地图片路径 / 步骤图片转成 data URL，webview 才能预览。 */
  private localizeBlocks<T>(blocks: T[]): T[] {
    return blocks.map((block) => {
      type WithImages = { text?: string; images?: string[] };
      const next = { ...(block as unknown as WithImages) };
      if (next.text) {
        next.text = convertLocalImages(next.text, (file) => this.imageFileData(file));
      }
      if (next.images && next.images.length) {
        next.images = next.images.map((src) => this.imageFileData(src) ?? src);
      }
      return next as unknown as T;
    });
  }
  /** 设置唯一激活目标，并派生 lastDesktopTitle。 */
  private setActiveTarget(target: ActiveTarget, markUser = true): void {
    const prev = activeDesktopTitle(this.activeTarget);
    const next = activeDesktopTitle(target);
    if (prev !== next && this.syncPoller) {
      this.syncPoller.stop('激活目标切换');
      this.syncPoller = undefined;
    }
    this.activeTarget = target;
    this.lastDesktopTitle = activeDesktopTitle(target);
    if (markUser) {
      this.userActivatedAt = Date.now();
    }
  }

  /** 只在「该对话仍是激活目标」时才推送到面板；后台任务反馈只记日志，不抢界面。 */
  private postIfActive(title: string, message: OutgoingMessage): boolean {
    const wanted = activeDesktopTitle(this.activeTarget);
    const actual = normalizeTitle(title);
    if (wanted && actual && wanted !== actual) {
      log('忽略后台任务消息', actual, '≠', wanted);
      return false;
    }
    this.post(message);
    return true;
  }

  /** 任务标签：记录打开过的任务/对话，像编辑器标签页一样切换。 */
  private tabsPayload(): Array<{ id: string; title: string; active: boolean; running: boolean; desktopTitle: string }> {
    return this.openTabs
      .filter((id) => Boolean(this.sessions.get(id)))
      .map((id) => {
        const record = this.sessions.get(id)!;
        return { id, title: record.title, active: id === this.sessionId, running: id === this.sessionId && (this.running || this.tabRunning), desktopTitle: record.desktopTitle || '' };
      });
  }

  private postTabs(): void {
    this.post({ type: 'tabs', tabs: this.tabsPayload() });
    void this.context.workspaceState.update('doubao.openTabs', this.openTabs);
  }

  private ensureTab(id: string): void {
    if (!id) {
      return;
    }
    this.openTabs = addTab(this.openTabs, id);
    this.postTabs();
  }

  private restoreTabs(): void {
    const saved = this.context.workspaceState.get<string[]>('doubao.openTabs') ?? [];
    this.openTabs = restoreTabList(saved, (id) => Boolean(this.sessions.get(id)), this.sessionId);
    this.postTabs();
  }

  private activateTab(id: string): void {
    const record = this.sessions.get(id);
    if (!record) {
      this.openTabs = removeTab(this.openTabs, id);
      this.postTabs();
      return;
    }
    if (shouldAbortOnSwitch(this.running, this.sessionId, id)) {
      this.abort();
    }
    this.openSession(id);
    if (record && (record.desktopTitle || record.desktopId)) {
      this.post({ type: 'syncLoading', on: true, text: '正在同步任务内容…' });
      void this.refreshActiveTabContent(id).finally(() => {
        this.post({ type: 'syncLoading', on: false });
      });
    }
  }

  /** 切换标签后把最新内容从豆包同步回来（有 desktop 绑定时）。 */
  private async refreshActiveTabContent(id: string): Promise<void> {
    const record = this.sessions.get(id);
    if (!record || (!record.desktopTitle && !record.desktopId) || this.disposed) {
      return;
    }
    try {
      this.post({ type: 'notice', text: '正在同步任务内容…' });
      if (record.desktopTitle) {
        const switched = await this.ensureDesktopConversation(record.desktopTitle);
        if (!switched) {
          this.post({ type: 'notice', text: '没能切到对应豆包对话，先显示本地内容' });
          return;
        }
        // 等 SPA 切完再读，避免读到上一个对话的残留
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
      const config = readConfig();
      // 读之前再确认当前页面就是这条任务，否则会把别的任务内容写进本标签
      const pageId = await readDesktopConversationId(config.desktopPort).catch(() => '');
      const pageTitle = normalizeTitle(await readDesktopTitle(config.desktopPort).catch(() => ''));
      if (record.desktopId && pageId && pageId !== record.desktopId) {
        log('跳过同步：页面不是目标任务', pageId, '≠', record.desktopId);
        return;
      }
      if (!record.desktopId && pageTitle && normalizeTitle(record.desktopTitle) !== pageTitle) {
        log('跳过同步：标题不匹配', pageTitle, '≠', normalizeTitle(record.desktopTitle));
        return;
      }
      const content = await readDesktopConversation(config.desktopPort, 40);
      if (!content.ok || content.messages.length === 0 || this.sessionId !== id) {
        return;
      }
      const now = Date.now();
      const turns = content.messages.map((m) => ({
        role: m.role,
        text: m.role === 'user' ? this.stripInjectedPrompt(m.text) : m.text,
        at: now,
      }));
      this.sessions.upsert({ ...record, turns, updatedAt: now });
      this.history = [];
      this.post({ type: 'history', title: record.title, turns: turns.map((t) => ({ role: t.role, text: t.text })) });
      const running = await isDesktopRunning(config.desktopPort).catch(() => false);
      this.tabRunning = running;
      this.post({ type: 'syncStatus', text: running ? '仍在执行' : '已同步', seconds: 0, done: !running });
      this.postTabs();
      this.postState();
    } catch (err) {
      warn('切换标签同步内容失败', err instanceof Error ? err.message : String(err));
    }
  }

  /** 后台任务的分块：只写入它自己的本地会话，不抢当前标签。 */
  private storeBackgroundBlocks(blocks: ReplyBlock[]): void {
    const text = blocks.filter((b) => b.kind === 'text').map((b) => b.text).join('\n').trim();
    if (!text) {
      return;
    }
    void (async () => {
      const title = normalizeTitle(await readDesktopTitle(readConfig().desktopPort).catch(() => ''));
      if (!title) {
        return;
      }
      const record = this.sessions.list().find((item) => normalizeTitle(item.desktopTitle || '') === title);
      if (!record) {
        return;
      }
      const last = record.turns[record.turns.length - 1];
      if (last && last.role === 'assistant' && last.text === text) {
        return;
      }
      this.sessions.upsert({
        ...record,
        updatedAt: Date.now(),
        turns: record.turns.concat([{ role: 'assistant', text, at: Date.now() }]).slice(-40),
      });
      this.postTabs();
    })();
  }

  /** 豆包回复后，用豆包侧标题刷新当前标签名。 */
  private async refreshTabTitleFromDesktop(): Promise<void> {
    const id = this.sessionId;
    if (!id || !this.openTabs.includes(id)) {
      return;
    }
    const port = readConfig().desktopPort;
    const rawTitle = (await readDesktopTitle(port).catch(() => '')).trim();
    const record = this.sessions.get(id);
    if (!record) {
      return;
    }
    // 豆包标题为空/仍是占位名时，用首条用户消息兜底，保证标签能更新
    const fallback = (record.turns.find((turn) => turn.role === 'user')?.text || this.lastUserText || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 20);
    const generic = !rawTitle || ['新对话', '新任务', '豆包对话', '对话'].includes(rawTitle);
    const title = generic ? fallback || rawTitle : rawTitle;
    if (!title) {
      return;
    }
    const desktopId = await readDesktopConversationId(port).catch(() => '');
    const next = refreshTitle({
      currentTitle: record.title,
      currentDesktopTitle: record.desktopTitle,
      currentDesktopId: record.desktopId,
      nextTitle: title,
      nextDesktopId: desktopId,
    });
    if (next.changed) {
      this.sessions.upsert({
        ...record,
        title: next.title,
        desktopTitle: next.desktopTitle,
        desktopId: next.desktopId,
        updatedAt: Date.now(),
      });
      this.setActiveTarget(desktopTarget(next.title, id, next.desktopId || undefined));
      log('标签名已按豆包标题刷新', next.title);
      this.postTabs();
    }
  }

  private closeTab(id: string): void {
    const next = nextActiveAfterClose(this.openTabs, id, this.sessionId);
    this.openTabs = removeTab(this.openTabs, id);
    if (this.sessionId === id) {
      if (this.running) {
        this.abort();
      }
      if (next) {
        this.openSession(next);
      } else {
        this.sessionId = newSessionId();
        this.history = [];
        this.post({ type: 'clear' });
      }
    }
    this.postTabs();
  }
  /** 定时同步快照：只推「激活目标」的对话，后台任务只记日志。 */
  private async pushSyncSnapshot(snap: SyncSnapshot): Promise<void> {
    if (this.disposed) {
      return;
    }
    const wanted = activeDesktopTitle(this.activeTarget);
    if (wanted) {
      const current = await readDesktopTitle(readConfig().desktopPort).catch(() => '');
      if (current && normalizeTitle(current) !== wanted) {
        log('后台任务快照：写入对应会话', normalizeTitle(current), '!=', wanted);
        this.storeBackgroundBlocks(snap.blocks);
        return;
      }
    }
    if (snap.blocks.length > 0) {
      log('同步分块', 'steps=' + snap.blocks.filter((b) => b.kind === 'step').length, 'kinds=' + snap.blocks.map((b) => b.kind).join(','));
      this.post({ type: 'blocks', blocks: this.localizeBlocks(snap.blocks) });
    }
    if (snap.progress) {
      this.post({ type: 'syncStatus', text: snap.progress, seconds: snap.progressSeconds, done: snap.done });
    }
  }
  /** 打开面板时恢复上次打开的豆包对话；若仍在执行则自动续「继续说」。 */
  private async restoreLastDesktop(): Promise<void> {
    // 默认不自动抢占豆包当前窗口，只有显式开启才恢复
    if (!readConfig().restoreLastWindow) {
      return;
    }
    if (this.restoreAttempted || this.disposed) {
      return;
    }
    this.restoreAttempted = true;
    const config = readConfig();
    if (config.authMode !== 'desktop') {
      return;
    }
    const saved = this.context.globalState.get<{ title?: string; at?: number }>('doubao.lastDesktop');
    const title = normalizeTitle(saved?.title ?? '');
    if (!shouldRestoreLastWindow({ savedTitle: title, savedAt: saved?.at, userActivatedAt: this.userActivatedAt, hasActiveTarget: this.activeTarget.kind !== 'none' })) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
    if (this.running || this.disposed) {
      return;
    }
    try {
      const list = await listDesktopConversations(config.desktopPort);
      if (!list.ok) {
        log('恢复上次窗口失败', list.error ?? '');
        return;
      }
      const hit =
        list.items.find((item) => item.title === title) ||
        list.items.find((item) => item.title && (title.includes(item.title) || item.title.includes(title)));
      if (!hit) {
        log('恢复上次窗口：未找到', title);
        return;
      }
      log('恢复上次窗口', hit.title, `#${hit.index}`);
      await this.openDesktopChat(hit.index);
    } catch (err) {
      warn('恢复上次窗口失败', err instanceof Error ? err.message : String(err));
    }
  }
  private async openDesktopChat(index: number, titleHint?: string, idHint?: string): Promise<void> {
    const config = readConfig();
    // 列表 index 可能因新建对话而偏移：优先按标题重新定位
    let realIndex = index;
    if (titleHint) {
      const fresh = await listDesktopConversations(config.desktopPort).catch(() => undefined);
      if (fresh && fresh.ok) {
        const byId = idHint ? fresh.items.find((item) => item.id === idHint) : undefined;
        const matched = byId ? { item: byId, candidates: [byId] } : matchConversation(titleHint, fresh.items);
        if (matched.item) {
          realIndex = matched.item.index;
          if (matched.error === 'ambiguous') {
            log('按标题匹配到多个对话，取最近一个', titleHint, String(matched.item.index));
          }
        }
      }
    }
    index = realIndex;
    const budget = await this.runWithBudget('导入豆包对话', 25_000, async (gen) => {
      const opened = idHint
        ? await openDesktopConversationById(idHint, config.desktopPort)
        : await openDesktopConversation(index, config.desktopPort, idHint);
      if (!opened.ok) {
        throw new Error(opened.error ?? '切换豆包对话失败');
      }
      // 等页面把消息渲染出来（豆包是 SPA，切换后异步挂载）
      await new Promise((resolve) => setTimeout(resolve, 900));
      let content = await readDesktopConversation(config.desktopPort, 40);
      if (!content.ok || content.messages.length === 0) {
        // 再等一会儿重试一次（虚拟列表有时挂载慢）
        await new Promise((resolve) => setTimeout(resolve, 1200));
        content = await readDesktopConversation(config.desktopPort, 40);
      }
      if (gen !== this.opSeq) {
        return undefined;
      }
      return { opened, content };
    });

    if (!budget) {
      return;
    }
    const { opened, content } = budget;
    const title = opened.title || content.title || '豆包对话';
    const desktopId = await readDesktopConversationId(config.desktopPort).catch(() => '');
    this.setActiveTarget(desktopTarget(title, undefined, desktopId));
    void this.context.globalState.update('doubao.lastDesktop', { title, at: Date.now() });
    // 先问页面：这个对话是不是还在执行（内容读不到时也要能进入旁观/同步）
    const stillRunning = await isDesktopRunning(config.desktopPort).catch(() => false);

    if (!content.ok || content.messages.length === 0) {
      // 任务还在跑的时候内容往往读不到，这时**保留切换结果**，并开始同步执行状态。
      this.post({
        type: 'notice',
        text: stillRunning
          ? `已切到豆包对话「${title}」，任务仍在执行，正在同步进度…`
          : `已切到豆包对话「${title}」，但暂时读不到内容（${content.error ?? '可能仍在执行'}）。可以直接在这里继续发消息。`,
      });
      if (stillRunning) {
        this.resumeRunningHistory(title);
      }
      return;
    }

    // 同一豆包对话只保留一个本地会话：按 desktopTitle 复用
    const existingSession = this.sessions.list().find((item) => {
      if (desktopId && item.desktopId) {
        return item.desktopId === desktopId;
      }
      const bound = normalizeTitle(item.desktopTitle || '');
      return bound !== '' && bound === normalizeTitle(title);
    });
    this.sessionId = existingSession ? existingSession.id : newSessionId();
    const now = Date.now();
    const turns = content.messages.map((m) => ({
      role: m.role,
      text: m.role === 'user' ? this.stripInjectedPrompt(m.text) : m.text,
      at: now,
    }));
    try {
      this.sessions.upsert({ id: this.sessionId, title, updatedAt: now, desktopTitle: title, desktopId, turns });
    } catch (err) {
      warn('同步豆包对话到本地记忆失败', err instanceof Error ? err.message : String(err));
    }
    this.setActiveTarget(desktopTarget(title, this.sessionId, desktopId));
    this.ensureTab(this.sessionId);
    this.history = [];
    this.post({
      type: 'history',
      title: `${title}（来自豆包 · 共 ${turns.length} 条）`,
      turns: turns.map((t) => ({ role: t.role, text: t.text })),
    });
    log('同步豆包对话', title, `${turns.length} 条`);
    if (stillRunning) {
      this.resumeRunningHistory(title);
    }
  }

  /** 当前任务结束后，自动发送排队中的用户消息（保证不丢消息）。 */
  private drainQueuedUser(): void {
    if (this.running || this.disposed) {
      return;
    }
    const next = this.queuedUser.shift();
    if (!next) {
      return;
    }
    log('发送排队消息', `${this.queuedUser.length} 条仍在排队`);
    void this.handleUser(next.text, next.refs);
  }

  private async confirmTerminal(command: string, cwd: string): Promise<boolean> {
    const answer = await vscode.window.showWarningMessage(
      '豆包编程助手请求执行终端命令',
      {
        modal: true,
        detail: `命令：${command}\n目录：${cwd}\n\n确认后会在工作区执行该命令，输出会回传给模型。`,
      },
      '允许执行',
    );
    log('终端命令确认结果', answer ?? '拒绝');
    return answer === '允许执行';
  }

  /* ---------------------------------------------------------------------- */
  /* 与 webview 的通信 / HTML                                                */
  /* ---------------------------------------------------------------------- */

  private post(message: OutgoingMessage): void {
    if (!this.view) {
      return;
    }
    if (!this.webviewReady) {
      // webview 脚本还没加载完，先排队，ready 后统一 flush。
      this.pendingPosts.push(message);
      if (this.pendingPosts.length > 100) {
        this.pendingPosts.shift();
      }
      return;
    }
    void this.view.webview.postMessage(message);
  }

  private markWebviewReady(): void {
    this.webviewReady = true;
    const queued = this.pendingPosts;
    this.pendingPosts = [];
    for (const message of queued) {
      void this.view?.webview.postMessage(message);
    }
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
    this.postState();
    if (this.catalogLoaded) {
      this.post({ type: 'catalog', skills: this.skillGroups, plugins: this.pluginItems });
    }
  }

  private waitForReady(timeoutMs: number): Promise<void> {
    if (this.webviewReady) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      this.readyWaiters.push(finish);
      setTimeout(finish, timeoutMs);
    });
  }

  /** 扩展版本（测试里的 mock context 可能没有 extension 字段）。 */
  private extensionVersion(): string {
    const ctx = this.context as unknown as { extension?: { packageJSON?: { version?: string } } };
    return String(ctx.extension?.packageJSON?.version || '0.0.0');
  }

  public postState(): void {
    const config = readConfig();
    const localModel = this.taskModel || config.desktopModel || 'DeepSeek V4.1 Flash';
    const localReasoning = this.taskReasoning || config.desktopReasoning || '';
    const model = config.authMode === 'cli'
      ? (config.cliModel || 'Auto') + (config.cliEffort ? ' · ' + config.cliEffort : '')
      : config.authMode === 'desktop'
        ? this.localMode
          ? `${localModel}${localReasoning ? ` · ${localReasoning}` : ''}`
          : this.desktopModel === '专家'
            ? '专家'
            : '快速'
        : config.model;
    this.post({
      type: 'state',
      busy: this.running,
      model,
      apiKeyConfigured: Boolean(config.apiKey),
      apiKeySource: config.apiKeySource,
      trusted: vscode.workspace.isTrusted,
      turns: this.history.filter((message) => message.role === 'user').length,
      mode: this.localMode ? 'local' : 'chat',
      permission: config.taskPermission,
      authMode: config.authMode,
      project: vscode.workspace.workspaceFolders?.[0]?.name ?? '',
      mcpTools: this.externalTools?.()?.definitions().length ?? 0,
      rules: this.hasRules(config),
      reasoning: this.desktopReasoning,
      desktopMode: this.desktopModeText,
      skillsCount: this.desktopSkillsCount,
      pluginsCount: this.desktopPluginsCount,
      version: this.extensionVersion(),
      autoContinue: config.autoContinue,
      autoContinueSeconds: config.autoContinueSeconds,
    });
  }

  public getHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
    const nonce = randomNonce();
    // 带上版本号：否则 VS Code webview 可能复用旧 chat.css/js 缓存，界面看不到新效果。
    const version = this.extensionVersion();
    // 测试里的 mock Uri 没有 .with，做一下兼容
    const withVersion = (uri: vscode.Uri): vscode.Uri => {
      const candidate = uri as unknown as { with?: (change: { query: string }) => vscode.Uri };
      return typeof candidate.with === 'function' ? candidate.with({ query: `v=${version}` }) : uri;
    };
    const cssUri = withVersion(webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'chat.css')));
    const jsUri = withVersion(webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'chat.js')));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data: https:`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    const iconUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'doubao-icon.png'));
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>豆包编程助手</title>
<link rel="stylesheet" href="${cssUri.toString()}" />
</head>
<body>
  <header class="topbar">
    <img class="logo" src="${iconUri.toString()}" alt="豆包" />
    <div class="title">
      <span class="name">豆包编程助手</span>
      <span class="meta" id="meta">正在读取配置…</span>
    </div>
    <div class="actions">
      <button id="btn-new" title="新建对话">＋ 对话</button>
      <button id="btn-task" title="新建本地电脑任务">＋ 任务</button>
      <button id="btn-history" title="历史对话（本地记忆 + 豆包记录）">⟲ 历史</button>
      <button id="btn-stop" class="danger hidden" title="停止生成">■ 停止</button>
    </div>
  </header>

  <main id="messages" class="messages" aria-live="polite">
    <div class="empty" id="empty">
      <div class="empty-icon"><img src="${iconUri.toString()}" alt="豆包" /></div>
      <p class="empty-title">开始和豆包一起写代码</p>
      <ul class="hints">
        <li>直接提问，或用 <code>@src/app.ts</code> 引用文件</li>
        <li>勾选下方“当前文件 / 选区 / 诊断”附带上下文</li>
        <li>选中代码后按 <kbd>Ctrl+Alt+I</kbd> 可做行内改写</li>
      </ul>
    </div>
  </main>

  <footer class="composer">
    <div class="running-bar hidden" id="running-bar">
      <span class="ast-step-dots"><i></i><i></i><i></i></span>
      <span class="running-text" id="running-text">正在执行中…</span>
    </div>
    <div class="attachments" id="attachments" hidden></div>
    <div class="composer-box">
      <textarea id="input" rows="2" placeholder="发消息或创建任务… Enter 发送，Shift+Enter 换行"></textarea>
      <div class="composer-toolbar">
        <div class="toolbar-left">
          <button id="btn-plus" class="icon-btn" title="上传文件或图片">＋</button>
          <button id="chip-mode" class="pill mode-pill active" title="模式：对话 / 工作任务（本地电脑）">工作任务 · 本地电脑 <span class="caret">▾</span></button>
          <span class="quick-chat" id="quick-chat" hidden>
            <button class="pill chat-action" type="button" data-chat-action="image">图像生成</button>
            <button class="pill chat-action" type="button" data-chat-action="video">视频生成</button>
            <button class="pill chat-action" type="button" data-chat-action="ppt">PPT 生成</button>
        <button class="pill mention-action" type="button" data-mention="file">@ 文件</button>
      </span>
      <span class="quick-chat" id="quick-verify">
        <button class="pill verify-action" type="button" data-verify="build">构建</button>
        <button class="pill verify-action" type="button" data-verify="test">测试</button>
          </span>
          <button id="chip-project" class="pill" title="当前项目">项目</button>
          <button id="chip-permission" class="pill" title="确认策略">按需确认 <span class="caret">▾</span></button>
          <button id="chip-skills" class="pill" title="更多技能（来自豆包）">更多技能</button>
          <button id="chip-plugins" class="pill" title="插件（来自豆包）">插件</button>
          <button id="btn-overflow" class="pill overflow-btn" title="显示放不下的按钮" hidden>更多 »</button>
        </div>
        <div class="toolbar-right">
          <button id="chip-model" class="pill model-pill" title="模型与推理强度">模型 <span class="caret">▾</span></button>
          <button id="btn-send" class="send-btn" title="执行 / 发送">↑</button>
        </div>
      </div>
    </div>
    <div class="composer-hints">
      <span class="status" id="status"></span>
      <span class="hint" id="context-hint"></span>
    </div>
  </footer>

  <div class="history-overlay hidden" id="history-overlay">
    <div class="history-sheet">
      <div class="history-head">
        <button id="history-back" class="icon-btn" title="返回">←</button>
        <strong class="history-title">历史对话</strong>
        <button id="history-batch" class="pill" title="批量选择">批量操作</button>
        <button id="history-close" class="icon-btn" title="关闭">×</button>
      </div>
      <div class="history-tools">
        <input id="history-search" class="history-search" type="search" placeholder="搜索历史对话" />
        <div class="history-tabs">
          <button class="history-tab on" data-tab="local">本地记忆</button>
          <button class="history-tab" data-tab="desktop">豆包对话</button>
        </div>
      </div>
      <div class="history-list" id="history-list"></div>
      <div class="history-batchbar hidden" id="history-batchbar">
        <label class="history-select-all"><input type="checkbox" id="history-select-all" /> 全选</label>
        <span class="history-count" id="history-selected-count">已选 0 项</span>
        <button id="history-batch-delete" class="danger">删除所选</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}" src="${jsUri.toString()}"></script>
</body>
</html>`;
  }
}

export function randomNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i += 1) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

/** 从构建/测试输出里提取「文件:行」位置（去重，最多 8 个）。 */
function parseVerifyLocations(output: string): Array<{ path: string; line: number }> {
  const re = /([A-Za-z]:[\\/][^\s:()]+|(?:[\w.-]+[\\/])*[\w.-]+\.(?:ts|tsx|js|jsx|cs|cpp|hpp|h|py|rs|go|java|kt))[:(](\d+)(?:[,:]\d+)?/g;
  const seen = new Set<string>();
  const out: Array<{ path: string; line: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(output)) && out.length < 8) {
    const key = match[1] + ':' + match[2];
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({ path: match[1], line: Number(match[2]) });
  }
  return out;
}