/**
 * 任务模式（本地执行面）端到端实测：通过桌面端通道跑「计划 → 工具 → 答复」。
 * 用法：node test/task-e2e.js
 * 前提：豆包已用 --remote-debugging-port=9222 启动且已登录。
 */
const Module = require('node:module');
const path = require('node:path');

const WORKSPACE = 'D:\\rex86\\doubao-re';
const folder = { uri: { fsPath: WORKSPACE }, name: 'doubao-re', index: 0 };
const stub = {
  window: {
    createOutputChannel: () => ({ appendLine: (s) => console.log('[log]', s), show() {}, dispose() {} }),
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showErrorMessage: async (m) => console.error('[err]', m),
    activeTextEditor: undefined,
  },
  workspace: {
    workspaceFolders: [folder],
    getWorkspaceFolder: () => folder,
    isTrusted: true,
    getConfiguration: () => ({ get: () => undefined }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    applyEdit: async () => true,
    textDocuments: [],
  },
  Uri: { file: (p) => ({ fsPath: p, scheme: 'file', path: p }), parse: (p) => ({ fsPath: p, scheme: 'file', path: p }) },
  Range: class {},
  Position: class {},
  WorkspaceEdit: class { replace() {} insert() {} },
  ThemeColor: class {},
  DiagnosticSeverity: { Error: 0, Warning: 1 },
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

const { TaskRunner } = require(path.join(__dirname, '..', 'out', 'agent', 'task.js'));
const { askDesktop } = require(path.join(__dirname, '..', 'out', 'bridge', 'desktop.js'));

const config = {
  authMode: 'desktop', baseUrl: '', apiKey: '', model: 'm', completionModel: 'm', temperature: 0.2,
  maxTokens: 4096, maxToolIterations: 8, enableInlineCompletion: false, systemPromptFile: '',
  rulesFile: '', terminalAutoRun: false, mcpEnabled: false, desktopPort: 9222, desktopNewChat: true,
  desktopTimeoutMs: 180000, desktopExePath: 'x', ptcEnabled: true, ptcMaxRounds: 4,
  taskPermission: 'risk', taskMaxSteps: 5, apiKeySource: 'missing',
};
const runtime = {
  config,
  extensionContext: { workspaceState: { get: () => undefined, update: async () => undefined }, subscriptions: [] },
  confirmTerminal: async () => true,
};

(async () => {
  let first = true;
  const complete = async (prompt) => {
    const r = await askDesktop(prompt, {
      port: 9222,
      newChat: first,
      timeoutMs: 180000,
      signal: new AbortController().signal,
      onDelta: () => undefined,
    });
    first = false;
    return r.text;
  };

  const started = Date.now();
  const runner = new TaskRunner({
    goal: '读一下 README.md 的前 40 行，用两句话总结这个仓库是做什么的。',
    root: WORKSPACE,
    config,
    runtime,
    complete,
    permission: 'risk',
    maxSteps: 4,
    confirm: async () => true,
    events: {
      onPlan: (p) => console.log('\n[计划]', p.join(' / ')),
      onTextDelta: (t) => process.stdout.write(t),
      onToolStart: (e) => console.log(`\n[tool_start] ${e.name} ${JSON.stringify(e.arguments)}`),
      onToolEnd: (e) => console.log(`[tool_end] ${e.name} ok=${e.ok} chars=${e.content.length}`),
    },
  });

  const result = await runner.run();
  console.log('\n===== 汇总 =====');
  console.log(JSON.stringify({ plan: result.plan, steps: result.steps.map((s) => ({ tool: s.tool, ok: s.ok, risk: s.risk })), answer: result.answer.slice(0, 300), elapsedMs: Date.now() - started }, null, 1));
  const ok = result.plan.length > 0 && result.steps.length >= 1 && result.answer.length > 10;
  console.log('[断言] ' + (ok ? 'PASS' : 'FAIL'));
  process.exitCode = ok ? 0 : 1;
})().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
