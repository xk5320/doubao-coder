/**
 * 豆包设置中心：一个 Webview 面板，集中处理
 * - 连接方式切换（CLI / 桌面版 / Ark）
 * - 对应登录与可用性检查
 * - 各通道与通用常用配置
 *
 * 面板只通过白名单 schema 写配置，不接收任意 key。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { probeDesktop } from '../bridge/desktop';
import { checkCliAuth, clearCliCache, detectCli, type CliAuthState } from '../cli/detect';
import { CLI_DOC_URL, CLI_INSTALL_COMMAND, normalizeCliText } from '../cli/runner';
import { clearNpmRuntimeCache, detectNpmRuntime, runNpmInstall, type NpmRuntime } from '../cli/install';
import { readConfig } from '../config';
import { isAuthMode, normalizeSettingValue } from './schema';

let panel: vscode.WebviewPanel | undefined;
let disposables: vscode.Disposable[] = [];
let lastAuth: CliAuthState | undefined;
let pendingAutoInstall = false;
let webviewReady = false;

export function openSettingsPanel(context: vscode.ExtensionContext): void {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
    void pushState(context);
    return;
  }
  panel = vscode.window.createWebviewPanel('doubao.settings', '豆包设置', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
  panel.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
  webviewReady = false;
  panel.webview.html = buildHtml(panel.webview, mediaRoot, context);
  panel.webview.onDidReceiveMessage(
    (message: unknown) => {
      void onMessage(context, message as Record<string, unknown>);
    },
    undefined,
    disposables,
  );
  panel.onDidDispose(
    () => {
      panel = undefined;
      webviewReady = false;
      lastAuth = undefined;
      for (const item of disposables) {
        item.dispose();
      }
      disposables = [];
    },
    undefined,
    disposables,
  );
  void pushState(context);
}

export function refreshSettingsPanel(context: vscode.ExtensionContext): void {
  if (panel) {
    void pushState(context);
  }
}

/** 从命令/其他面板发起：打开设置中心，等 webview ready 后立即开始自动安装。 */
export function startCliAutoInstall(context: vscode.ExtensionContext): void {
  missingPrompted = true;
  if (panel && webviewReady) {
    void autoInstallCli(context);
    return;
  }
  pendingAutoInstall = true;
  openSettingsPanel(context);
}

export function disposeSettingsPanel(): void {
  panel?.dispose();
  panel = undefined;
}

async function pushState(context: vscode.ExtensionContext): Promise<void> {
  const target = panel;
  if (!target) {
    return;
  }
  const state = await buildState(context);
  if (!panel || panel !== target) {
    return;
  }
  void panel.webview.postMessage({ type: 'state', state });
  const cli = state.cli as { installed?: boolean } | undefined;
  if (!missingPrompted && state.authMode === 'cli' && cli && cli.installed === false) {
    missingPrompted = true;
    void promptMissingCli(context);
  }
}

let missingPrompted = false;

/** 打开设置/切到 CLI 时发现没装：一次询问是否自动安装。 */
async function promptMissingCli(context: vscode.ExtensionContext): Promise<void> {
  const action = await vscode.window.showInformationMessage(
    '未检测到豆包 CLI，是否现在自动安装？需要 Node.js 18+。',
    '自动安装',
    '安装说明',
    '稍后',
  );
  if (action === '自动安装') {
    await autoInstallCli(context);
  } else if (action === '安装说明') {
    await vscode.commands.executeCommand('doubao.cliInstall');
  }
}

async function buildState(context: vscode.ExtensionContext): Promise<Record<string, unknown>> {
  const config = readConfig();
  const cli = await detectCli(config.cliPath);
  const desktop = await probeDesktop(config.desktopPort).catch((err: unknown) => ({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  }));
  const desktopInstalled = Boolean(config.desktopExePath) && fs.existsSync(config.desktopExePath);
  const runtime: NpmRuntime | undefined = cli.installed ? undefined : await detectNpmRuntime();
  return {
    authMode: config.authMode,
    version: String(context.extension.packageJSON.version || ''),
    installCommand: CLI_INSTALL_COMMAND,
    docs: CLI_DOC_URL,
    cli: {
      installed: cli.installed,
      version: cli.version || '',
      binary: cli.binary || '',
      source: cli.source,
      error: cli.error || '',
      loggedIn: lastAuth ? lastAuth.loggedIn : null,
      authDetail: lastAuth ? lastAuth.detail : '',
      path: config.cliPath,
      permissionMode: config.cliPermissionMode,
      model: config.cliModel,
      effort: config.cliEffort,
      timeoutMs: config.cliTimeoutMs,
      runtime: runtime || null,
    },
    desktop: {
      installed: desktopInstalled,
      exePath: config.desktopExePath,
      port: config.desktopPort,
      connected: Boolean(desktop.ok),
      error: String(desktop.error || ''),
      workMode: config.desktopWorkMode,
      model: config.desktopModel,
      reasoning: config.desktopReasoning,
    },
    ark: {
      hasKey: Boolean(config.apiKey),
      source: config.apiKeySource,
      baseUrl: config.baseUrl,
      model: config.model,
      maxTokens: config.maxTokens,
    },
    general: {
      enableInlineCompletion: config.enableInlineCompletion,
      terminalAutoRun: config.terminalAutoRun,
      reviewEdits: config.reviewEdits,
      autoContinue: config.autoContinue,
      autoContinueSeconds: config.autoContinueSeconds,
      autoVerifyAfterAccept: config.autoVerifyAfterAccept,
    },
  };
}

async function onMessage(context: vscode.ExtensionContext, message: Record<string, unknown>): Promise<void> {
  if (!message || typeof message.type !== 'string') {
    return;
  }
  switch (message.type) {
    case 'ready':
    case 'refresh':
      if (message.type === 'ready') {
        webviewReady = true;
      }
      lastAuth = undefined;
      await pushState(context);
      if (message.type === 'ready' && pendingAutoInstall) {
        pendingAutoInstall = false;
        await autoInstallCli(context);
      }
      return;
    case 'setMode':
      await setMode(context, message.mode);
      return;
    case 'update':
      await updateSetting(message);
      return;
    case 'action':
      await runAction(context, String(message.value || ''));
      return;
    default:
      return;
  }
}

async function setMode(context: vscode.ExtensionContext, raw: unknown): Promise<void> {
  if (!isAuthMode(raw)) {
    post({ type: 'error', message: '未知的连接方式' });
    return;
  }
  const config = readConfig();
  if (config.authMode === raw) {
    return;
  }
  try {
    await vscode.workspace.getConfiguration('doubao').update('authMode', raw, writeTarget('authMode'));
    lastAuth = undefined;
    clearCliCache();
    post({ type: 'notice', message: '已切换到' + modeLabel(raw) + '，可在上方检查登录/连接状态。' });

  } catch (err) {
    post({ type: 'error', message: '切换失败：' + errorText(err) });
  }
  await pushState(context);
}

async function updateSetting(message: Record<string, unknown>): Promise<void> {
  const key = String(message.key || '');
  const result = normalizeSettingValue(key, message.value);
  if (!result.ok) {
    post({ type: 'error', message: result.error || '取值不合法' });
    return;
  }
  try {
    await vscode.workspace.getConfiguration('doubao').update(key, result.value, writeTarget(key));
    if (key === 'cli.path') {
      clearCliCache();
    }
    post({ type: 'saved', key, value: result.value });
  } catch (err) {
    post({ type: 'error', message: '保存失败：' + errorText(err) });
  }
}

async function runAction(context: vscode.ExtensionContext, action: string): Promise<void> {
  try {
    switch (action) {
      case 'cliLogin':
        await vscode.commands.executeCommand('doubao.cliLogin');
        post({ type: 'notice', message: '已打开登录终端；扫码完成后点「检查登录」。' });
        break;
      case 'cliCheck': {
        const config = readConfig();
        const info = await detectCli(config.cliPath);
        if (!info.installed || !info.binary) {
          post({ type: 'error', message: '还没检测到豆包 CLI，请先安装。' });
          break;
        }
        const auth = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: '正在验证豆包 CLI 登录状态…' },
          () => checkCliAuth(info),
        );
        lastAuth = auth;
        void vscode.commands.executeCommand('doubao.internal.refreshCli');
        post({
          type: 'authResult',
          ok: auth.loggedIn,
          detail: auth.detail || (auth.loggedIn ? '登录有效' : '未登录'),
        });
        break;
      }
      case 'cliInstall':
        await vscode.commands.executeCommand('doubao.cliInstall');
        break;
      case 'cliAutoInstall':
        await autoInstallCli(context);
        return;
      case 'openTerminalInstall': {
        const terminal = vscode.window.createTerminal({ name: '安装豆包 CLI' });
        terminal.show();
        terminal.sendText(CLI_INSTALL_COMMAND, true);
        post({ type: 'notice', message: '已在终端里执行安装命令，完成后点「重新检测」。' });
        break;
      }
      case 'openNodeDownload':
        await vscode.env.openExternal(vscode.Uri.parse('https://nodejs.org/zh-cn/download'));
        break;
      case 'cliTerminal':
        await vscode.commands.executeCommand('doubao.cliOpenTerminal');
        break;
      case 'cliService':
        await vscode.commands.executeCommand('doubao.cliStartService');
        break;
      case 'desktopConnect':
        await vscode.commands.executeCommand('doubao.connectDesktop');
        await delay(800);
        break;
      case 'desktopLaunch':
        await vscode.commands.executeCommand('doubao.launchDesktop');
        await delay(1200);
        break;
      case 'setApiKey':
        await vscode.commands.executeCommand('doubao.setApiKey');
        break;
      case 'clearApiKey':
        await vscode.commands.executeCommand('doubao.clearApiKey');
        break;
      case 'openVscodeSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:doubao-rex86.doubao-coder');
        break;
      case 'openDocs':
        await vscode.env.openExternal(vscode.Uri.parse(CLI_DOC_URL));
        break;
      case 'copyInstall':
        await vscode.env.clipboard.writeText(CLI_INSTALL_COMMAND);
        post({ type: 'notice', message: '安装命令已复制到剪贴板。' });
        break;
      case 'refresh':
        lastAuth = undefined;
        break;
      default:
        return;
    }
  } catch (err) {
    post({ type: 'error', message: '操作失败：' + errorText(err) });
  }
  await pushState(context);
}


let installing = false;

/** 一键安装：同一时间只允许一个安装任务。 */
async function autoInstallCli(context: vscode.ExtensionContext): Promise<void> {
  if (installing) {
    post({ type: 'notice', message: '安装正在进行中，请稍候…' });
    return;
  }
  installing = true;
  try {
    await runAutoInstall(context);
  } finally {
    installing = false;
  }
}

/** 实际安装流程：用当前进程的 Node 执行 npm install -g，输出实时回报到面板。 */
async function runAutoInstall(context: vscode.ExtensionContext): Promise<void> {
  const runtime = await detectNpmRuntime(true);
  if (!runtime.ok || !runtime.npmCli || !runtime.nodeExec) {
    const message = '自动安装需要 Node.js 18+ 和 npm：' + (runtime.error || '未找到 Node.js / npm');
    post({ type: 'installDone', ok: false, error: message });
    post({ type: 'error', message });
    await pushState(context);
    return;
  }

  post({ type: 'installStart' });
  const controller = new AbortController();
  let lastProgressAt = 0;
  let result: Awaited<ReturnType<typeof runNpmInstall>>;
  try {
    result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: '正在安装豆包 CLI…', cancellable: true },
      async (progress, token) => {
        const sub = token.onCancellationRequested(() => controller.abort());
        try {
          return await runNpmInstall({
            nodeExec: runtime.nodeExec as string,
            npmCli: runtime.npmCli as string,
            signal: controller.signal,
            onLine: (line) => {
              post({ type: 'installProgress', line });
              if (Date.now() - lastProgressAt > 300) {
                lastProgressAt = Date.now();
                progress.report({ message: line.slice(0, 90) });
              }
            },
          });
        } finally {
          sub.dispose();
        }
      },
    );
  } catch (err) {
    post({ type: 'installDone', ok: false, error: errorText(err) });
    post({ type: 'error', message: '安装失败：' + errorText(err) });
    await pushState(context);
    return;
  }

  clearNpmRuntimeCache();
  clearCliCache();
  if (!result.ok) {
    const detail = result.aborted
      ? '已取消安装。'
      : result.timedOut
        ? '安装超时（15 分钟）。'
        : result.error || (result.output ? normalizeCliText(result.output).slice(-600) : 'npm 退出码 ' + result.code);
    post({ type: 'installDone', ok: false, error: detail });
    post({ type: 'error', message: '安装失败：' + detail });
    await pushState(context);
    return;
  }

  let info = await detectCli(readConfig().cliPath);
  for (let attempt = 0; attempt < 10 && !info.installed; attempt += 1) {
    await delay(1000);
    clearCliCache();
    info = await detectCli(readConfig().cliPath);
  }
  post({ type: 'installDone', ok: true, version: info.version || '' });
  post({
    type: 'notice',
    message: info.installed
      ? '豆包 CLI 安装完成，正在打开登录…'
      : 'npm 已完成，但暂未检测到 doubao；可点右上角「重新检测」。',
  });
  await pushState(context);
  if (info.installed) {
    void vscode.commands.executeCommand('doubao.cliLogin');
  }
}

/** 跟随用户当前的配置层级：workspace 里覆盖过的键不要偷偷写回 global。 */
function writeTarget(key: string): vscode.ConfigurationTarget {
  const info = vscode.workspace.getConfiguration('doubao').inspect(key);
  if (info?.workspaceFolderValue !== undefined) {
    return vscode.ConfigurationTarget.WorkspaceFolder;
  }
  if (info?.workspaceValue !== undefined) {
    return vscode.ConfigurationTarget.Workspace;
  }
  return vscode.ConfigurationTarget.Global;
}

function post(message: Record<string, unknown>): void {
  if (panel) {
    void panel.webview.postMessage(message);
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function modeLabel(mode: string): string {
  if (mode === 'cli') {
    return '豆包 CLI';
  }
  if (mode === 'ark') {
    return 'Ark API Key';
  }
  return '豆包桌面版';
}

function buildHtml(webview: vscode.Webview, mediaRoot: vscode.Uri, context: vscode.ExtensionContext): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const version = encodeURIComponent(String(context.extension.packageJSON.version || '0'));
  const css = String(webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'settings.css'))) + '?v=' + version;
  const js = String(webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'settings.js'))) + '?v=' + version;
  const csp = [
    "default-src 'none'",
    'style-src ' + webview.cspSource,
    'img-src ' + webview.cspSource + ' data: https:',
    "script-src 'nonce-" + nonce + "'",
    'font-src ' + webview.cspSource,
  ].join('; ');
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta http-equiv="Content-Security-Policy" content="' + csp + '">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<link rel="stylesheet" href="' + css + '">',
    '<title>豆包设置</title>',
    '</head>',
    '<body>',
    '<header class="head">',
    '<div class="head-main">',
    '<div class="head-title">豆包设置</div>',
    '<div class="head-sub" id="modeSub">连接方式与常用配置</div>',
    '</div>',
    '<div class="head-actions">',
    '<span class="badge" id="versionBadge"></span>',
    '<button id="refreshBtn" class="ghost" data-action="refresh">重新检测</button>',
    '</div>',
    '</header>',
    '<main id="app" class="app"><div class="loading">正在读取配置…</div></main>',
    '<div id="toast" class="toast hidden"></div>',
    '<script nonce="' + nonce + '" src="' + js + '"></script>',
    '</body>',
    '</html>',
  ].join('\n');
}
