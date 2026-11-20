/**
 * 行内改写（桌面端通道，免 Key）端到端实测：改一小段代码并校验结果。
 * 用法：node test/inline-edit-e2e.js
 * 前提：豆包已用 --remote-debugging-port=9222 启动且已登录。
 */
const Module = require('node:module');
const path = require('node:path');

/* ---------------- vscode 最小桩 ---------------- */
const folder = { uri: { fsPath: 'D:\\rex86\\doubao-re' }, name: 'doubao-re', index: 0 };
const stub = {
  window: {
    createOutputChannel: () => ({ appendLine: (s) => console.log('[log]', s), show() {}, dispose() {} }),
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async (m) => console.error('[err]', m),
    withProgress: async (_o, task) => task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
    activeTextEditor: undefined,
  },
  workspace: {
    workspaceFolders: [folder],
    getWorkspaceFolder: () => folder,
    isTrusted: true,
    getConfiguration: () => ({ get: () => undefined }),
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
    openTextDocument: async () => ({}),
    applyEdit: async () => true,
  },
  Uri: { parse: (s) => ({ fsPath: s, path: s, scheme: 'doubao-preview', toString: () => s }), file: (p) => ({ fsPath: p, path: p, scheme: 'file' }) },
  Range: class {},
  Position: class {},
  WorkspaceEdit: class { replace() {} insert() {} },
  ThemeColor: class {},
  StatusBarAlignment: { Right: 2 },
  ViewColumn: { One: 1 },
  ProgressLocation: { Notification: 15 },
  commands: { executeCommand: async () => undefined },
  env: { clipboard: { writeText: async () => undefined } },
  languages: { getDiagnostics: () => [] },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return stub;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { generateRewrite } = require(path.join(__dirname, '..', 'out', 'inline', 'edit.js'));
const { inlineEditMessages, stripCodeFence } = require(path.join(__dirname, '..', 'out', 'chat', 'prompt.js'));

const config = {
  authMode: 'desktop',
  baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  apiKey: '',
  model: 'doubao-seed-code',
  completionModel: 'doubao-seed-code',
  temperature: 0.2,
  maxTokens: 4096,
  maxToolIterations: 8,
  enableInlineCompletion: false,
  systemPromptFile: '',
  rulesFile: '.doubao/rules.md',
  terminalAutoRun: false,
  mcpEnabled: false,
  desktopPort: 9222,
  desktopNewChat: true,
  desktopTimeoutMs: 180000,
  desktopExePath: 'C:\\Users\\Administrator\\AppData\\Local\\Doubao\\Application\\app\\Doubao.exe',
  ptcEnabled: false,
  ptcMaxRounds: 1,
  apiKeySource: 'missing',
};

const CODE = ['function sum(a, b) {', '  return a + b;', '}', ''].join('\n');

(async () => {
  const { system, user } = inlineEditMessages({
    instruction: '改写成箭头函数形式，函数名保持 sum，不要解释，只输出代码',
    code: CODE,
    languageId: 'javascript',
    relativePath: 'demo.js',
    before: '',
    after: '',
  });

  const started = Date.now();
  const raw = await generateRewrite(config, system, user, {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose() {} }),
  });
  const text = stripCodeFence(raw).replace(/^\n+/, '').replace(/\s+$/, '');
  console.log('--- 原始返回 ---');
  console.log(raw.slice(0, 400));
  console.log('--- 清理后 ---');
  console.log(text);
  const ok =
    text.length > 0 &&
    text.includes('sum') &&
    (text.includes('=>') || text.includes('function')) &&
    !text.includes('```');
  console.log(`\n[断言] ${ok ? 'PASS' : 'FAIL'}  用时 ${Date.now() - started}ms`);
  process.exitCode = ok ? 0 : 1;
})().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
