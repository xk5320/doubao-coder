import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ChatViewProvider } from './chat/panel';
import { explainInstruction, type ContextRefs } from './chat/prompt';
import { readGitDiff } from './chat/git-context';
import { DoubaoInlineCompletionProvider } from './completion/provider';
import { sendSelectionToDoubaoApp } from './doubao/bridge';
import { DoubaoTextContentProvider, PREVIEW_SCHEME, runInlineEdit, showLastDiff, undoLastEdit } from './inline/edit';
import { defaultDoubaoExe, ensureConfigured, loadSecretApiKey, readConfig, saveSecretApiKey, validateConfig, watchConfig, workspaceRoot } from './config';
import { probeDesktop } from './bridge/desktop';
import { captureProtocol, defaultCapturePath, type ProtocolEvent } from './bridge/ws-stream';
import { openMirror } from './mirror/panel';
import { onMcpState } from './mcp/server';
import { showDiagnostics } from './cu/backend-select';
import { detectInstall } from './doubao/install';
import { applyNoWatermark } from './doubao/watermark';
import { error as logError, initLog, log, showLogs, uptimeSeconds } from './log';
import { McpManager } from './mcp/manager';
import { MCP_TEMPLATES, mergeMcpTemplate } from './mcp/templates';
import { detectChecks, formatCheckReport, runChecks } from './agent/checks';
import { checkCliAuth, clearCliCache, cliLoginArgs, detectCli, type CliInfo } from './cli/detect';
import { CLI_DOC_URL, CLI_INSTALL_COMMAND } from './cli/runner';

let chatProvider: ChatViewProvider | undefined;
let statusBar: vscode.StatusBarItem | undefined;
let mcpManager: McpManager | undefined;
/** 最近一次 CLI 探测结果，供状态栏同步显示（探测是异步的）。 */
let cliInfoCache: CliInfo | undefined;
/** 安装后是否已经问过用户选哪种连接方式（全局一次，不按工作区）。 */
const CONNECTION_MODE_KEY = 'doubao.connectionModeChosen';

const execFileAsync = promisify(execFile);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 在另一台电脑上，豆包安装位置可能不是默认路径：配置 → 默认路径 → 运行中进程。 */
async function resolveDoubaoExe(configured: string): Promise<string | undefined> {
  const candidates = [
    configured,
    defaultDoubaoExe(),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Doubao', 'Doubao.exe') : '',
    process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, 'Doubao', 'Doubao.exe') : '',
    process.env['PROGRAMFILES(X86)'] ? path.join(process.env['PROGRAMFILES(X86)'], 'Doubao', 'Doubao.exe') : '',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      /* ignore */
    }
  }
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-Command', "(Get-CimInstance Win32_Process -Filter \"Name='Doubao.exe'\" | Select-Object -First 1 -ExpandProperty ExecutablePath)"],
      { timeout: 6000, windowsHide: true },
    );
    const found = stdout.trim().split(/\r?\n/)[0]?.trim();
    if (found && fs.existsSync(found)) {
      return found;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

async function isDoubaoRunning(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('tasklist', ['/FI', 'IMAGENAME eq Doubao.exe', '/NH'], { timeout: 5000, windowsHide: true });
    return /Doubao\.exe/i.test(stdout);
  } catch {
    return false;
  }
}

const SOURCE_LABEL: Record<string, string> = {
  secret: 'SecretStorage',
  settings: '设置项 doubao.apiKey',
  env: '环境变量 ARK_API_KEY',
  missing: '未配置',
};

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initLog(context);
  log('扩展激活', `vscode=${vscode.version}`, `platform=${process.platform}`, `trusted=${vscode.workspace.isTrusted}`);

  // API Key 存在 SecretStorage 里（优先级最高），先加载再读配置。
  await loadSecretApiKey(context);

  // ---------- 外部 MCP server（可选） ----------
  const mcp = new McpManager();
  mcpManager = mcp;

  // ---------- 侧边栏聊天 ----------
  const provider = new ChatViewProvider(context, () => mcpManager?.router);
  chatProvider = provider;

  // 豆包作为 MCP 客户端调用 report_state 时，把状态转给面板
  onMcpState((state) => {
    try {
      provider.applyMcpState(state);
    } catch {
      /* 忽略 */
    }
  });
  context.subscriptions.push(
    vscode.commands.registerCommand('doubao.openMirror', () => {
      openMirror(context);
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('doubao.captureProtocol', async () => {
      const seconds = await vscode.window.showInputBox({
        title: '抓取豆包协议帧',
        prompt: '采集多少秒？（这期间请在豆包里跑一个任务）',
        value: '60',
      });
      const secs = Math.max(5, Math.min(300, Number(seconds) || 60));
      const outPath = defaultCapturePath(context.extensionPath);
      vscode.window.showInformationMessage(`开始采集 ${secs} 秒协议帧，结果会写到 ${outPath}`);
      try {
        const events = await captureProtocol({
          seconds: secs,
          onEvent: (event: ProtocolEvent) => log('协议帧', `cmd=${event.cmd ?? '?'}`),
          saveTo: outPath,
        });
        vscode.window.showInformationMessage(`采集完成：${events.length} 帧 → ${outPath}`);
      } catch (err) {
        vscode.window.showErrorMessage(`采集失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('doubao.applyNoWatermark', async () => {
      const result = await applyNoWatermark(readConfig().desktopPort);
      if (result.ok) {
        vscode.window.showInformationMessage(`豆包水印已设置为无水印（${result.state.map((s) => s.label).join('、')}）`);
      } else {
        vscode.window.showWarningMessage(`设置无水印失败：${result.error || '未知原因'}（详见输出 → 豆包编程助手）`);
      }
    }),
  );

  // 初始化：只做一次（按扩展版本记录），避免每次启动都抢焦点去点设置。
  void (async () => {
    const config = readConfig();
    if (config.authMode !== 'desktop' || !config.applyNoWatermark) {
      return;
    }
    const version = String(context.extension.packageJSON.version || '');
    if (context.globalState.get<string>('doubao.noWatermarkApplied') === version) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const result = await applyNoWatermark(config.desktopPort).catch((err) => ({
      ok: false,
      changed: [],
      state: [],
      error: err instanceof Error ? err.message : String(err),
    }));
    if (result.ok) {
      await context.globalState.update('doubao.noWatermarkApplied', version);
      log('初始化：已设置无水印', result.changed.length ? `本次修改 ${result.changed.join('、')}` : '两项本来就是无水印');
    } else {
      log('初始化：设置无水印失败', result.error || '未知原因');
    }
  })();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // ---------- 行内补全 ----------
  const completionProvider = new DoubaoInlineCompletionProvider();
  context.subscriptions.push(
    completionProvider,
    vscode.languages.registerInlineCompletionItemProvider({ scheme: 'file' }, completionProvider),
  );

  // ---------- 预览/对比虚拟文档 ----------
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, new DoubaoTextContentProvider()),
  );

  // ---------- 状态栏 ----------
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'doubao.focusChat';
  statusBar.show();
  context.subscriptions.push(statusBar);
  refreshStatusBar();
  void refreshCliInfo();

  // 首次安装后只问一次：轻量 CLI / 豆包桌面版 / Ark API Key。
  // 已经显式设置过 doubao.authMode 的老用户不打断，只补记标记。
  void (async () => {
    await sleep(800);
    if (context.globalState.get<boolean>(CONNECTION_MODE_KEY)) {
      return;
    }
    if (authModeExplicitlyChosen()) {
      await context.globalState.update(CONNECTION_MODE_KEY, true);
      return;
    }
    await chooseConnectionMode(context, true);
  })();

  // ---------- 命令 ----------
  context.subscriptions.push(
    vscode.commands.registerCommand('doubao.newChat', async () => {
      log('命令：新建对话');
      if (!provider.hasView()) {
        await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
      }
      provider.newChat();
    }),

    vscode.commands.registerCommand('doubao.explainSelection', async () => {
      log('命令：解释选中代码');
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage('请先打开一个文件并选中要解释的代码。');
        return;
      }
      const config = readConfig();
      if (!(await ensureConfigured(config))) {
        return;
      }
      const hasSelection = !editor.selection.isEmpty;
      const text = hasSelection
        ? explainInstruction(editor.document.languageId)
        : `请解释 ${editor.document.fileName} 这个文件的主要作用与结构。`;
      const refs: ContextRefs = { currentFile: true, selection: hasSelection, diagnostics: true };
      if (!hasSelection) {
        vscode.window.showInformationMessage('未选中代码，将解释整个文件的概要。');
      }
      await provider.askFromCommand(text, refs);
    }),

    vscode.commands.registerCommand('doubao.refactorSelection', async () => {
      log('命令：重构选中代码');
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showInformationMessage('请先选中要重构的代码。');
        return;
      }
      if (!(await ensureConfigured(readConfig()))) {
        return;
      }
      await provider.askFromCommand('请重构选中的代码：保持行为不变，先读相关文件，给出修改后的代码与原因。', { currentFile: true, selection: true, diagnostics: true });
    }),

    vscode.commands.registerCommand('doubao.writeTests', async () => {
      log('命令：为选中代码写测试');
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showInformationMessage('请先选中要覆盖的代码。');
        return;
      }
      if (!(await ensureConfigured(readConfig()))) {
        return;
      }
      await provider.askFromCommand('请为选中的代码编写单元测试：覆盖主要分支与边界，先读相关文件，必要时用 write_file 提交测试文件（会先进入审阅）。', { currentFile: true, selection: true, diagnostics: true });
    }),

    vscode.commands.registerCommand('doubao.fixDiagnostics', async () => {
      log('命令：修复当前文件诊断');
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage('请先打开要修复的文件。');
        return;
      }
      if (!(await ensureConfigured(readConfig()))) {
        return;
      }
      await provider.askFromCommand('请修复当前文件里的诊断/编译错误：先读相关文件确认原因，修改用 apply_patch（会先进入审阅）。', { currentFile: true, selection: false, diagnostics: true });
    }),
    vscode.commands.registerCommand('doubao.attachGitDiff', async () => {
      log('命令：把 git diff 作为上下文');
      const root = workspaceRoot();
      const diff = await readGitDiff(root || '');
      if (!diff.ok) {
        vscode.window.showErrorMessage('读取 git diff 失败：' + (diff.error || '未知错误'));
        return;
      }
      if (!(await ensureConfigured(readConfig()))) {
        return;
      }
      await provider.askFromCommand(
        '以下是当前工作区未提交的 git 改动，请审阅：指出风险与问题，并给出建议的修改；如需改文件用 apply_patch（会先进入审阅）。\n\n' + '\x60\x60\x60diff\n' + diff.text + '\n\x60\x60\x60',
        {},
      );
    }),

    vscode.commands.registerCommand('doubao.addMcpTemplate', async () => {
      const root = workspaceRoot() || process.cwd();
      const picked = await vscode.window.showQuickPick(
        MCP_TEMPLATES.map((template) => ({ label: template.name, description: template.description, template })),
        { title: '添加 MCP 模板', placeHolder: '选择一个常用 MCP server 写入配置' },
      );
      if (!picked) {
        return;
      }
      const config = vscode.workspace.getConfiguration('doubao');
      const merged = mergeMcpTemplate(config.get<unknown>('mcp.servers'), picked.template.build(root));
      await config.update('mcp.servers', merged, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('已添加 MCP 模板：' + picked.label + '（重新加载窗口后生效）');
    }),

    vscode.commands.registerCommand('doubao.reconnectDesktop', async () => {
      log('命令：重连豆包桌面端');
      await provider.reconnectDesktop();
    }),

    vscode.commands.registerCommand('doubao.selectConnectionMode', async () => {
      log('命令：选择连接方式');
      await chooseConnectionMode(context, false);
    }),

    vscode.commands.registerCommand('doubao.cliLogin', async () => {
      log('命令：登录豆包 CLI');
      await loginCli();
    }),

    vscode.commands.registerCommand('doubao.cliCheck', async () => {
      log('命令：检查豆包 CLI');
      await checkCli();
    }),

    vscode.commands.registerCommand('doubao.cliInstall', async () => {
      log('命令：安装豆包 CLI');
      await openCliInstall();
    }),

    vscode.commands.registerCommand('doubao.undoAcceptedEdit', async () => {
      log('命令：撤销已接受的 AI 改动');
      await provider.undoLastAccepted();
    }),

    vscode.commands.registerCommand('doubao.editSelection', async () => {
      log('命令：行内改写');
      await runInlineEdit(context);
    }),

    vscode.commands.registerCommand('doubao.applyLastDiff', async () => {
      log('命令：查看/撤销上一次改动');
      await showLastDiff(context);
    }),

    vscode.commands.registerCommand('doubao.sendSelectionToDoubaoApp', async () => {
      log('命令：投送选区到豆包客户端');
      await sendSelectionToDoubaoApp();
    }),

    vscode.commands.registerCommand('doubao.openSettings', async () => {
      log('命令：打开设置');
      await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:doubao-rex86.doubao-coder');
    }),

    // 把 API Key 写入 SecretStorage：不进 settings.json，也不会被提交到仓库。
    vscode.commands.registerCommand('doubao.setApiKey', async () => {
      log('命令：设置 API Key');
      const value = await vscode.window.showInputBox({
        title: '豆包 / 火山方舟 API Key',
        prompt: '粘贴 Ark API Key（保存在 VS Code SecretStorage，不写入 settings.json）',
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'ARK_API_KEY',
        validateInput: (input) => (input.trim().length === 0 ? '不能为空' : /\s/.test(input) ? '不能包含空白字符' : undefined),
      });
      if (value === undefined) {
        return;
      }
      await saveSecretApiKey(context, value);
      refreshStatusBar();
      provider.postState();
      log('API Key 已更新', value.trim() ? '已保存' : '已清空');
      vscode.window.showInformationMessage(value.trim() ? 'API Key 已保存到 SecretStorage。' : 'API Key 已清空。');
    }),

    vscode.commands.registerCommand('doubao.clearApiKey', async () => {
      const pick = await vscode.window.showWarningMessage('确定要清除已保存的 API Key 吗？', { modal: true }, '清除');
      if (pick !== '清除') {
        return;
      }
      await saveSecretApiKey(context, '');
      refreshStatusBar();
      provider.postState();
      log('API Key 已清除');
    }),

    // ---------- 桌面端登录态直连 ----------
    vscode.commands.registerCommand('doubao.connectDesktop', async () => {
      log('命令：连接豆包桌面端');
      const config = readConfig();
      const status = await probeDesktop(config.desktopPort);
      log('桌面端探测结果', JSON.stringify({ ok: status.ok, browser: status.browser, page: status.pageUrl, err: status.error }));
      if (status.ok) {
        const action = await vscode.window.showInformationMessage(
          `已连接豆包桌面端\n浏览器：${status.browser ?? '?'}\n页面：${status.pageTitle ?? ''} (${status.pageUrl ?? ''})`,
          '开始对话',
        );
        if (action === '开始对话') {
          await vscode.commands.executeCommand('doubao.focusChat');
        }
        return;
      }
      const pick = await vscode.window.showWarningMessage(
        `连接失败：${status.error ?? '未知原因'}`,
        '显示日志',
        '以调试端口启动豆包',
      );
      if (pick === '显示日志') {
        showLogs();
      } else if (pick === '以调试端口启动豆包') {
        await vscode.commands.executeCommand('doubao.launchDesktop');
      }
    }),

    vscode.commands.registerCommand('doubao.launchDesktop', async () => {
      const config = readConfig();
      const existing = await probeDesktop(config.desktopPort);
      if (existing.ok) {
        vscode.window.showInformationMessage('豆包已经在调试端口上运行，无需重复启动。');
        return;
      }
      const exe = await resolveDoubaoExe(config.desktopExePath);
      if (!exe) {
        const action = await vscode.window.showErrorMessage(
          '没有找到豆包安装路径。请在设置里填写 doubao.desktop.exePath（例如 C:\\Users\\你\\AppData\\Local\\Doubao\\Application\\app\\Doubao.exe）。',
          '打开设置',
        );
        if (action === '打开设置') {
          await vscode.commands.executeCommand('doubao.openSettings');
        }
        return;
      }
      // 豆包单实例会吞掉新加的调试参数，已经在运行时必须重启；登录态保存在本地用户数据里，不会丢。
      if (await isDoubaoRunning()) {
        const action = await vscode.window.showWarningMessage(
          '豆包正在运行，但没有开启调试端口，扩展连不上。需要重启豆包才能连接（已登录状态会保留）。',
          { modal: true },
          '重启并连接',
        );
        if (action !== '重启并连接') {
          return;
        }
        log('重启豆包（调试端口）', exe, `port=${config.desktopPort}`);
        await execFileAsync('taskkill', ['/IM', 'Doubao.exe', '/F'], { timeout: 8000, windowsHide: true }).catch(() => undefined);
        await sleep(1500);
      }
      log('启动豆包（调试端口）', exe, `port=${config.desktopPort}`);
      try {
        const { spawn } = require('node:child_process') as typeof import('node:child_process');
        const child = spawn(exe, [`--remote-debugging-port=${config.desktopPort}`], {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        });
        child.unref();
      } catch (err) {
        logError('启动豆包失败', err);
        vscode.window.showErrorMessage(`启动失败：${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: '正在等待豆包调试端口就绪…', cancellable: false },
        async () => {
          for (let i = 0; i < 40; i += 1) {
            await sleep(1000);
            const status = await probeDesktop(config.desktopPort);
            if (status.ok) {
              vscode.window.showInformationMessage('豆包已就绪：现在可以直接在侧边栏对话（使用这台电脑上已登录的账号）。');
              return;
            }
          }
          vscode.window.showWarningMessage(
            '40 秒内没有连上调试端口。请确认豆包已在该电脑登录；若安装路径特殊，请设置 doubao.desktop.exePath 后重试。',
          );
        },
      );
    }),

    // ---------- 豆包安装与本地资源 ----------
    vscode.commands.registerCommand('doubao.checkInstall', async () => {
      log('命令：检测豆包安装与本地资源');
      const config = readConfig();
      await showDiagnostics({ installPath: config.installPath, pythonPath: config.pythonPath });
    }),

    vscode.commands.registerCommand('doubao.setInstallPath', async () => {
      const config = readConfig();
      const picked = await vscode.window.showInputBox({
        title: '豆包安装路径',
        prompt: '填 Doubao.exe 的完整路径（留空表示自动检测 %LOCALAPPDATA%\\Doubao\\Application\\app\\Doubao.exe）',
        value: config.installPath,
        ignoreFocusOut: true,
        placeHolder: 'C:\\Users\\<你>\\AppData\\Local\\Doubao\\Application\\app\\Doubao.exe',
      });
      if (picked === undefined) {
        return;
      }
      await vscode.workspace
        .getConfiguration('doubao')
        .update('installPath', picked.trim(), vscode.ConfigurationTarget.Global);
      const install = await detectInstall(picked.trim());
      vscode.window.showInformationMessage(
        install
          ? `已识别：${install.appDir}（版本 ${install.version ?? '?'}）`
          : '这个路径下没找到豆包（需要 Doubao.exe 与 task-mode-resource 目录）。',
      );
      refreshStatusBar();
    }),

    vscode.commands.registerCommand('doubao.runTask', async () => {      log('命令：任务模式');
      const config = readConfig();
      if (!(await ensureConfigured(config))) {
        return;
      }
      const goal = await vscode.window.showInputBox({
        title: '豆包 · 任务模式（本地电脑执行面）',
        prompt: '描述要让豆包在你电脑上完成的任务，例如：把 src/util.ts 里的回调改写成 async/await 并跑一次 tsc 验证',
        ignoreFocusOut: true,
        placeHolder: '任务目标…',
      });
      if (!goal || !goal.trim()) {
        return;
      }
      if (!provider.hasView()) {
        await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
      }
      await provider.runTask(goal.trim());
    }),

    vscode.commands.registerCommand('doubao.showLogs', async () => {
      showLogs();
    }),

    // ---------- 工程自检 ----------
    vscode.commands.registerCommand('doubao.runChecks', async () => {
      const root = workspaceRoot();
      if (!root) {
        vscode.window.showWarningMessage('当前没有打开工作区文件夹，无法运行工程检查。');
        return;
      }
      const checks = await detectChecks(root);
      if (checks.length === 0) {
        vscode.window.showWarningMessage(
          '没有检测到可运行的检查：需要 package.json 的 typecheck/compile/lint/test 脚本，或 tsconfig.json。',
        );
        return;
      }
      const controller = new AbortController();
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: '豆包：运行工程检查…', cancellable: true },
        async (progress, token) => {
          token.onCancellationRequested(() => controller.abort());
          const report = await runChecks(root, {
            checks,
            signal: controller.signal,
            onStart: (check) => progress.report({ message: check.label }),
          });
          const text = formatCheckReport(report);
          log('工程检查结果', text);
          const action = await vscode.window.showInformationMessage(
            report.ok ? '工程检查通过。' : '工程检查失败，详情已写入日志。',
            '显示日志',
          );
          if (action === '显示日志') {
            showLogs();
          }
        },
      );
    }),

    // ---------- MCP 状态 ----------
    vscode.commands.registerCommand('doubao.mcpStatus', async () => {
      const snapshot = mcp.snapshot();
      if (snapshot.servers.length === 0) {
        await vscode.window.showInformationMessage(
          '没有配置外部 MCP server。可在 settings.json 的 doubao.mcp.servers 里添加。',
          '打开设置',
        ).then((action) => {
          if (action === '打开设置') {
            void vscode.commands.executeCommand('doubao.openSettings');
          }
        });
        return;
      }
      const lines = snapshot.servers.map((server) =>
        server.ok ? `✅ ${server.name}：${server.toolCount} 个工具` : `❌ ${server.name}：${server.error ?? '不可用'}`,
      );
      const message = `MCP：${snapshot.toolCount} 个外部工具\n${lines.join('\n')}`;
      log('MCP 状态', message);
      const action = await vscode.window.showInformationMessage(message, '显示日志');
      if (action === '显示日志') {
        showLogs();
      }
    }),

    vscode.commands.registerCommand('doubao.indexWorkspace', async () => {
      await indexWorkspace();
    }),

    // 内部命令：把焦点给聊天视图（状态栏点击 / newChat 使用）。
    vscode.commands.registerCommand('doubao.focusChat', async () => {
      await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
    }),

    // 撤销上一次改动（也用于命令面板里的快速回退）。
    vscode.commands.registerCommand('doubao.undoLastEdit', async () => {
      await undoLastEdit(context);
    }),
  );

  // ---------- 配置变化 ----------
  context.subscriptions.push(
    watchConfig(() => {
      refreshStatusBar();
      provider.postState();
      void mcpManager?.reload(readConfig().mcpServers);
    }),
  );

  const startupConfig = readConfig();
  void mcp.reload(startupConfig.mcpServers).catch((err) => logError('MCP 初始化失败', err));
  if (startupConfig.mcpEnabled) {
    const serverPath = vscode.Uri.joinPath(context.extensionUri, 'out', 'mcp', 'server.js').fsPath;
    log('MCP stdio server 可用（实验性）', serverPath, '可用环境变量 DOUBAO_MCP_ROOT 指定根目录');
  }

  const validation = validateConfig(startupConfig);
  if (!validation.ok) {
    log('配置尚未就绪', validation.problems.join(' | '));
    void vscode.window
      .showInformationMessage(`${validation.problems[0]}`, '打开设置')
      .then((action) => {
        if (action === '打开设置') {
          void vscode.commands.executeCommand('doubao.openSettings');
        }
      });
  } else if (startupConfig.authMode === 'desktop') {
    // 桌面端模式：启动时静默自检一次，失败只写日志，不打断用户。
    void probeDesktop(startupConfig.desktopPort)
      .catch((err: unknown) => {
        log('桌面端自检异常', err instanceof Error ? err.message : String(err));
        return { ok: false, port: startupConfig.desktopPort, error: '自检异常' } as Awaited<ReturnType<typeof probeDesktop>>;
      })
      .then((status) => {
      log('桌面端自检', status.ok ? `已连接（${status.browser ?? '?'}）` : `未连接：${status.error ?? ''}`);
      if (!status.ok) {
        void vscode.window
          .showInformationMessage('豆包桌面端还没连上：需要以调试端口启动才能免 Key 使用。', '一键启动')
          .then((action) => {
            if (action === '一键启动') {
              void vscode.commands.executeCommand('doubao.launchDesktop');
            }
          });
      }
    });
  }
}


/* -------------------------------------------------------------------------- */
/* 连接方式：轻量 CLI / 桌面版 / Ark API Key                                   */
/* -------------------------------------------------------------------------- */

function authModeExplicitlyChosen(): boolean {
  const inspect = vscode.workspace.getConfiguration('doubao').inspect<string>('authMode');
  return Boolean(inspect?.globalValue ?? inspect?.workspaceValue ?? inspect?.workspaceFolderValue);
}

async function refreshCliInfo(): Promise<void> {
  try {
    cliInfoCache = await detectCli(readConfig().cliPath);
  } catch {
    cliInfoCache = undefined;
  }
  refreshStatusBar();
}

/** 安装引导：给命令、给文档、或直接在终端里填好命令（不替用户执行）。 */
async function openCliInstall(): Promise<void> {
  const pick = await vscode.window.showInformationMessage(
    '豆包 CLI 需要 Node.js 18+，目前仅对豆包团队/企业订阅账号开放。安装命令：' + CLI_INSTALL_COMMAND,
    '复制命令',
    '在终端里安装',
    '查看文档',
  );
  if (pick === '复制命令') {
    await vscode.env.clipboard.writeText(CLI_INSTALL_COMMAND);
    vscode.window.showInformationMessage('安装命令已复制。');
  } else if (pick === '在终端里安装') {
    const terminal = vscode.window.createTerminal({ name: '安装豆包 CLI' });
    terminal.show();
    terminal.sendText(CLI_INSTALL_COMMAND, false);
  } else if (pick === '查看文档') {
    await vscode.env.openExternal(vscode.Uri.parse(CLI_DOC_URL));
  }
}

/** 在集成终端里跑 doubao login --qr=png，扫码在官方 CLI 里完成。 */
async function loginCli(): Promise<void> {
  const config = readConfig();
  const info = await detectCli(config.cliPath);
  cliInfoCache = info;
  refreshStatusBar();
  if (!info.installed || !info.binary) {
    await openCliInstall();
    return;
  }
  clearCliCache(info.binary);
  const terminal = vscode.window.createTerminal({
    name: '豆包 CLI 登录',
    shellPath: info.binary,
    shellArgs: cliLoginArgs(),
  });
  terminal.show();
  const action = await vscode.window.showInformationMessage(
    '已打开登录终端：用豆包或飞书移动端扫码完成授权。二维码图片路径会打印在终端里。',
    '我已完成登录',
    '查看文档',
  );
  if (action === '我已完成登录') {
    await checkCli();
  } else if (action === '查看文档') {
    await vscode.env.openExternal(vscode.Uri.parse(CLI_DOC_URL));
  }
}

/** 检查 CLI 是否安装、登录是否有效。 */
async function checkCli(): Promise<void> {
  const config = readConfig();
  const info = await detectCli(config.cliPath);
  cliInfoCache = info;
  refreshStatusBar();
  if (!info.installed) {
    await openCliInstall();
    return;
  }
  const auth = await checkCliAuth(info);
  if (auth.loggedIn) {
    vscode.window.showInformationMessage('豆包 CLI 可用：v' + (info.version ?? '?') + '，登录有效。');
    return;
  }
  const action = await vscode.window.showWarningMessage(
    '豆包 CLI v' + (info.version ?? '?') + ' 还没有有效登录：' + auth.detail,
    '去登录',
    '查看文档',
  );
  if (action === '去登录') {
    await loginCli();
  } else if (action === '查看文档') {
    await vscode.env.openExternal(vscode.Uri.parse(CLI_DOC_URL));
  }
}

interface ConnectionPick extends vscode.QuickPickItem {
  mode: 'cli' | 'desktop' | 'ark';
}

/**
 * 首次安装后（以及命令「豆包: 选择连接方式」）让用户选连接方式。
 * 选完写 doubao.authMode，并立刻做一次可用性检查/引导。
 */
async function chooseConnectionMode(context: vscode.ExtensionContext, firstRun: boolean): Promise<void> {
  const config = readConfig();
  const [cliInfo, desktopOk] = await Promise.all([
    detectCli(config.cliPath).catch(() => undefined),
    probeDesktop(config.desktopPort)
      .then((status) => status.ok)
      .catch(() => false),
  ]);
  if (cliInfo) {
    cliInfoCache = cliInfo;
    refreshStatusBar();
  }

  const items: ConnectionPick[] = [
    {
      label: '$(terminal) 豆包 CLI（轻量 · 推荐）',
      description: cliInfo?.installed ? '已安装 v' + (cliInfo.version ?? '') : '未安装，选择后引导安装',
      detail:
        'Agent、文件读写、终端、技能、子 Agent 都由官方 CLI 执行，扩展只做侧边栏界面；需要豆包团队/企业订阅。',
      mode: 'cli',
    },
    {
      label: '$(window) 豆包桌面版（免 API Key）',
      description: desktopOk ? '调试端口已就绪' : '需要安装并以调试端口启动',
      detail: '复用桌面版登录态，不需要 API Key；通过 CDP 驱动桌面窗口，可能抢占焦点。',
      mode: 'desktop',
    },
    {
      label: '$(key) 火山方舟 API Key',
      description: config.apiKey ? '已配置 Key' : '需要配置 Key',
      detail: '直接调用 Ark OpenAI 兼容接口，按 token 计费；行内补全也走它。',
      mode: 'ark',
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: firstRun ? '选择豆包的连接方式' : '切换豆包的连接方式',
    placeHolder: '以后可用命令「豆包: 选择连接方式」随时切换',
    ignoreFocusOut: true,
  });
  if (!picked) {
    // 首次跳过不等于选好了：下次激活再问一次。
    return;
  }

  await vscode.workspace.getConfiguration('doubao').update('authMode', picked.mode, vscode.ConfigurationTarget.Global);
  await context.globalState.update(CONNECTION_MODE_KEY, true);
  clearCliCache();
  void refreshCliInfo();
  chatProvider?.postState();
  log('连接方式已选择', picked.mode);
  await afterModeChosen(picked.mode);
}

/** 选完模式后的下一步：缺什么就补什么，不让用户自己猜。 */
async function afterModeChosen(mode: 'cli' | 'desktop' | 'ark'): Promise<void> {
  const config = readConfig();
  if (mode === 'cli') {
    const info = await detectCli(config.cliPath);
    cliInfoCache = info;
    refreshStatusBar();
    if (!info.installed) {
      const action = await vscode.window.showInformationMessage(
        '已切到豆包 CLI 模式，但本机还没检测到 CLI。安装命令：' + CLI_INSTALL_COMMAND,
        '安装说明',
        '复制命令',
      );
      if (action === '安装说明') {
        await openCliInstall();
      } else if (action === '复制命令') {
        await vscode.env.clipboard.writeText(CLI_INSTALL_COMMAND);
      }
      return;
    }
    const auth = await checkCliAuth(info);
    if (!auth.loggedIn) {
      const action = await vscode.window.showWarningMessage(
        '豆包 CLI 已安装（v' + (info.version ?? '?') + '），但还没有有效登录。',
        '去登录',
        '稍后',
      );
      if (action === '去登录') {
        await loginCli();
      }
      return;
    }
    vscode.window.showInformationMessage('已切到豆包 CLI 模式（v' + (info.version ?? '?') + '，登录有效）。');
    return;
  }

  if (mode === 'desktop') {
    const status = await probeDesktop(config.desktopPort);
    if (!status.ok) {
      const action = await vscode.window.showWarningMessage(
        '已切到豆包桌面版模式，但连接还没就绪：' + (status.error ?? '未知原因'),
        '以调试端口启动',
        '稍后',
      );
      if (action === '以调试端口启动') {
        await vscode.commands.executeCommand('doubao.launchDesktop');
      }
    }
    return;
  }

  if (!config.apiKey) {
    const action = await vscode.window.showInformationMessage('已切到 Ark API Key 模式，还需要配置 Key。', '设置 API Key');
    if (action === '设置 API Key') {
      await vscode.commands.executeCommand('doubao.setApiKey');
    }
  }
}

export function deactivate(): void {
  log('扩展停用', `运行 ${uptimeSeconds()}s`);
  void mcpManager?.dispose();
  mcpManager = undefined;
  chatProvider?.dispose();
  chatProvider = undefined;
  statusBar?.dispose();
  statusBar = undefined;
}

function refreshStatusBar(): void {
  if (!statusBar) {
    return;
  }
  const config = readConfig();
  const configured =
    config.authMode === 'cli'
      ? Boolean(cliInfoCache?.installed)
      : config.authMode === 'desktop'
        ? Boolean(config.desktopExePath)
        : Boolean(config.apiKey);
  statusBar.text = configured ? '$(sparkle) 豆包' : '$(sparkle) 豆包 (未配置)';
  const keyLine =
    config.authMode === 'cli'
      ? `接入方式：豆包 CLI（${cliInfoCache?.installed ? 'v' + cliInfoCache.version : '未检测到'}）`
      : config.authMode === 'desktop'
        ? `接入方式：桌面端登录态（端口 ${config.desktopPort}，无需 API Key）`
        : `API Key：${config.apiKey ? `已配置（${SOURCE_LABEL[config.apiKeySource] ?? config.apiKeySource}）` : '未配置'}`;
  statusBar.tooltip = [
    '豆包编程助手',
    `模型：${config.model}`,
    `补全模型：${config.completionModel}`,
    keyLine,
    `行内补全：${config.enableInlineCompletion ? '开' : '关'}`,
    `终端自动执行：${config.terminalAutoRun ? '开' : '关（需确认）'}`,
    `外部 MCP 工具：${mcpManager?.toolCount ?? 0} 个`,
    '点击打开对话面板',
  ].join('\n');
  statusBar.color = configured ? undefined : new vscode.ThemeColor('statusBarItem.warningForeground');
  statusBar.backgroundColor = configured ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground');
}

/** 简单版“索引工作区”：统计文件数量与扩展名分布，不做向量化。 */
async function indexWorkspace(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showWarningMessage('当前没有打开工作区文件夹。');
    return;
  }
  const exclude = '**/{node_modules,.git,out,dist,build,target,.vscode-test}/**';

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: '正在统计工作区文件…',
      cancellable: false,
    },
    async () => {
      try {
        const started = Date.now();
        const files = await vscode.workspace.findFiles('**/*', exclude, 20000);
        const byExt = new Map<string, number>();
        for (const file of files) {
          const ext = file.path.slice(file.path.lastIndexOf('.') + 1).toLowerCase() || '(无扩展名)';
          byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
        }
        const top = [...byExt.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([ext, count]) => `${ext}: ${count}`)
          .join('，');
        const elapsed = Date.now() - started;
        const message = `共 ${files.length} 个文件（已排除 node_modules/.git/out/dist 等），耗时 ${elapsed}ms。主要类型：${top || '无'}`;
        log('索引工作区', message);
        const action = await vscode.window.showInformationMessage(message, '复制结果');
        if (action === '复制结果') {
          await vscode.env.clipboard.writeText(`${files.length} 个文件\n${top}`);
        }
      } catch (err) {
        logError('索引工作区失败', err);
        vscode.window.showErrorMessage(`统计失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
