/**
 * PTC 端到端实测：通过桌面端通道跑一轮真实的工具调用（会动用你的豆包账号）。
 * 用法：node test/ptc-e2e.js
 * 前提：豆包已用 --remote-debugging-port=9222 启动且已登录。
 */
const Module = require('node:module');
const path = require('node:path');

const WORKSPACE = 'D:\\rex86\\doubao-re';

/* ---------------- vscode 最小桩（够 tools/panel 用） ---------------- */
const output = [];
const folder = { uri: { fsPath: WORKSPACE }, name: 'doubao-re', index: 0 };
const stub = {
  window: {
    createOutputChannel: () => ({
      appendLine: (s) => {
        output.push(s);
        console.log('[log]', s);
      },
      show: () => undefined,
      dispose: () => undefined,
    }),
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showQuickPick: async () => undefined,
    activeTextEditor: undefined,
  },
  workspace: {
    workspaceFolders: [folder],
    getWorkspaceFolder: () => folder,
    isTrusted: true,
    getConfiguration: () => ({ get: () => undefined }),
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
    applyEdit: async () => true,
    findFiles: async () => [],
    textDocuments: [],
  },
  Uri: {
    file: (p) => ({ fsPath: p, scheme: 'file', path: p, toString: () => p }),
    parse: (p) => ({ fsPath: p, scheme: 'file', path: p, toString: () => p }),
    joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }),
  },
  Range: class {},
  Position: class {},
  WorkspaceEdit: class {
    replace() {}
    insert() {}
  },
  ThemeColor: class {},
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  StatusBarAlignment: { Right: 2 },
  ViewColumn: { One: 1 },
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

const { PtcAgent, buildPtcPromptSection, parsePtc } = require(path.join(__dirname, '..', 'out', 'agent', 'ptc.js'));

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
  desktopNewChat: true, // 测试用：新开一个会话，别污染已有对话
  desktopTimeoutMs: 180000,
  desktopExePath: 'C:\\Users\\Administrator\\AppData\\Local\\Doubao\\Application\\app\\Doubao.exe',
  ptcEnabled: true,
  ptcMaxRounds: 3,
  apiKeySource: 'missing',
};

const context = {
  workspaceState: { get: () => undefined, update: async () => undefined },
  subscriptions: [],
};

const runtime = {
  config,
  extensionContext: context,
  confirmTerminal: async () => false,
};

const userRequest = '用 list_dir 工具看一下工作区根目录有哪些文件和目录（path 用 "."），然后用一句话总结。';

(async () => {
  const prompt = [
    '你是一个在 VS Code 里工作的编程助手。',
    buildPtcPromptSection(),
    '----- 用户请求 -----',
    userRequest,
  ].join('\n\n');

  const agent = new PtcAgent(config, runtime, {
    onTextDelta: (t) => process.stdout.write(t),
    onToolStart: (e) => console.log(`\n[tool_start] ${e.name} ${JSON.stringify(e.arguments)}`),
    onToolEnd: (e) => console.log(`[tool_end] ${e.name} ok=${e.ok} chars=${e.content.length}\n`),
    onRoundStart: (r) => console.log(`\n===== 第 ${r} 轮 =====`),
    onDone: (info) => console.log('\n[done]', JSON.stringify(info)),
  });

  const controller = new AbortController();
  const started = Date.now();
  const result = await agent.run(prompt, controller.signal);
  console.log('\n===== 汇总 =====');
  console.log(JSON.stringify({ ...result, elapsedMs: Date.now() - started }, null, 1));
  const ok = result.toolCalls >= 1 && result.text.length > 0 && !result.aborted;
  console.log('[断言] ' + (ok ? 'PASS' : 'FAIL'));
  process.exitCode = ok ? 0 : 1;
})().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
