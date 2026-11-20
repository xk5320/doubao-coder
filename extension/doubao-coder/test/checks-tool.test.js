/**
 * run_checks 工具集成测试：临时工程 → detectChecks → 用户确认 → 执行 → 诊断回灌。
 * 用法：node test/checks-tool.test.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..');
let workspace = '';
const folder = { uri: { fsPath: '' }, name: 'tmp', index: 0 };
const stub = {
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    activeTextEditor: undefined,
  },
  workspace: {
    workspaceFolders: [folder],
    getWorkspaceFolder: () => folder,
    isTrusted: true,
    getConfiguration: () => ({ get: () => undefined }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    textDocuments: [],
  },
  Uri: { file: (p) => ({ fsPath: p, scheme: 'file', path: p, toString: () => p }) },
  ThemeColor: class {},
  StatusBarAlignment: { Right: 2 },
  commands: { executeCommand: async () => undefined },
  env: { clipboard: { writeText: async () => undefined } },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return stub;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { executeTool } = require(path.join(ROOT, 'out', 'agent', 'tools.js'));

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('  PASS  ' + name);
  } else {
    fail += 1;
    console.log('  FAIL  ' + name + (detail ? ' → ' + detail : ''));
  }
}

const config = {
  authMode: 'desktop', baseUrl: '', apiKey: '', model: '', completionModel: '', temperature: 0.2,
  maxTokens: 4096, maxToolIterations: 8, enableInlineCompletion: false, systemPromptFile: '',
  rulesFile: '', terminalAutoRun: false, mcpEnabled: false, desktopPort: 9222, desktopNewChat: false,
  desktopTimeoutMs: 180000, desktopExePath: '', ptcEnabled: true, ptcMaxRounds: 3,
  taskPermission: 'risk', taskMaxSteps: 10, installPath: '', pythonPath: 'python',
  computerBackend: 'auto', apiKeySource: 'missing', mcpServers: [],
};
const context = { workspaceState: { get: () => undefined, update: async () => undefined }, subscriptions: [] };

function makeProject(scripts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-checks-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'tmp', version: '1.0.0', scripts }, null, 2));
  return dir;
}

function useWorkspace(dir) {
  workspace = dir;
  folder.uri.fsPath = dir;
  stub.workspace.workspaceFolders = [folder];
}

(async () => {
  try {
    /* 1) 通过 */
    const okDir = makeProject({ typecheck: 'node pass.js' });
    fs.writeFileSync(path.join(okDir, 'pass.js'), "console.log('typecheck-ok');\n");
    useWorkspace(okDir);
    let confirmed = '';
    const okOutcome = await executeTool('run_checks', {}, {
      config, extensionContext: context,
      confirmTerminal: async (cmd) => { confirmed = cmd; return true; },
    });
    check('通过：ok=true', okOutcome.ok === true, JSON.stringify(okOutcome));
    check('通过：报告含 PASS 与检查名', okOutcome.content.includes('PASS') && okOutcome.content.includes('typecheck'), okOutcome.content);
    check('通过：先请求确认', confirmed.includes('npm run typecheck'), confirmed);

    // terminalAutoRun=true 时不再请求确认
    let autoConfirmCalls = 0;
    const autoOutcome = await executeTool('run_checks', {}, {
      config: { ...config, terminalAutoRun: true },
      extensionContext: context,
      confirmTerminal: async () => { autoConfirmCalls += 1; return true; },
    });
    check('autoRun：不再请求确认', autoConfirmCalls === 0, 'calls=' + autoConfirmCalls);
    check('autoRun：检查仍然执行', autoOutcome.ok === true, JSON.stringify(autoOutcome));

    /* 2) 失败 + TS 诊断 */
    const badDir = makeProject({ typecheck: 'node fail.js' });
    fs.writeFileSync(path.join(badDir, 'fail.js'), "console.log('src/a.ts(3,5): error TS1000: boom');\nprocess.exit(1);\n");
    useWorkspace(badDir);
    const badOutcome = await executeTool('run_checks', {}, {
      config, extensionContext: context, confirmTerminal: async () => true,
    });
    check('失败：ok=false', badOutcome.ok === false, JSON.stringify(badOutcome));
    check('失败：保留 TS 诊断', badOutcome.content.includes('TS1000') && badOutcome.content.includes('boom'), badOutcome.content);

    /* 3) 用户拒绝 */
    let confirmCalls = 0;
    const denied = await executeTool('run_checks', {}, {
      config, extensionContext: context,
      confirmTerminal: async () => { confirmCalls += 1; return false; },
    });
    check('拒绝：不执行且提示可读', denied.ok === false && denied.content.includes('拒绝') && confirmCalls === 1, denied.content);

    /* 4) only 过滤 */
    const mixedDir = makeProject({ typecheck: 'node pass.js', test: 'node pass.js' });
    fs.writeFileSync(path.join(mixedDir, 'pass.js'), "console.log('only-filter-ok');\n");
    useWorkspace(mixedDir);
    const onlyOutcome = await executeTool('run_checks', { only: 'test' }, {
      config, extensionContext: context, confirmTerminal: async () => true,
    });
    check('only：只跑 test', onlyOutcome.ok === true && onlyOutcome.content.includes('测试 (test)') && !onlyOutcome.content.includes('typecheck'), onlyOutcome.content);

    /* 5) 没有检查 */
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-empty-'));
    useWorkspace(emptyDir);
    const emptyOutcome = await executeTool('run_checks', {}, {
      config, extensionContext: context, confirmTerminal: async () => true,
    });
    check('空工程：给可读说明', emptyOutcome.ok === false && emptyOutcome.content.includes('没有检测到'), emptyOutcome.content);
  } finally {
    console.log('\n结果：PASS ' + pass + '，FAIL ' + fail);
    process.exitCode = fail === 0 ? 0 : 1;
  }
})().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
