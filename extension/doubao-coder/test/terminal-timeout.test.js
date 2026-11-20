/**
 * run_terminal 超时测试：必须杀掉整个进程树，不能留下孙进程继续写文件。
 * 用法：node test/terminal-timeout.test.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-term-'));
const folder = { uri: { fsPath: tmp }, name: 'tmp', index: 0 };
const stub = {
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    showWarningMessage: async () => true,
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
    applyEdit: async () => true,
  },
  Uri: { file: (p) => ({ fsPath: p, scheme: 'file', path: p, toString: () => p }) },
  ThemeColor: class {},
  StatusBarAlignment: { Right: 2 },
  commands: { executeCommand: async () => undefined },
  env: { clipboard: { writeText: async () => undefined } },
  Position: class {},
  Range: class {},
  WorkspaceEdit: class {},
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return stub;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { executeTool } = require(path.join(__dirname, '..', 'out', 'agent', 'tools.js'));

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const marker = path.join(tmp, 'grandchild-ran.txt');
fs.writeFileSync(path.join(tmp, 'grandchild.js'), "const fs = require('node:fs'); const path = require('node:path'); setTimeout(() => fs.writeFileSync(path.join(__dirname, 'grandchild-ran.txt'), 'ran'), 9000); setTimeout(() => {}, 10000);\n");
fs.writeFileSync(path.join(tmp, 'spawner.js'), "const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['grandchild.js'], { stdio: 'ignore' }); console.log('grandchild pid=' + c.pid); setInterval(() => {}, 1000);\n");

const config = {
  authMode: 'desktop', baseUrl: '', apiKey: '', model: '', completionModel: '', temperature: 0.2,
  maxTokens: 4096, maxToolIterations: 8, enableInlineCompletion: false, systemPromptFile: '',
  rulesFile: '', terminalAutoRun: true, mcpEnabled: false, desktopPort: 9222, desktopNewChat: false,
  desktopTimeoutMs: 180000, desktopExePath: '', ptcEnabled: true, ptcMaxRounds: 3,
  taskPermission: 'risk', taskMaxSteps: 10, installPath: '', pythonPath: 'python',
  computerBackend: 'auto', apiKeySource: 'missing', mcpServers: [],
};
const context = { workspaceState: { get: () => undefined, update: async () => undefined }, subscriptions: [] };

(async () => {
  try {
    const started = Date.now();
    const outcome = await executeTool('run_terminal', { command: 'node spawner.js', timeout_ms: 700 }, {
      config, extensionContext: context, confirmTerminal: async () => true,
    });
    const elapsed = Date.now() - started;
    check('超时：ok=false 且提示超时', outcome.ok === false && outcome.content.includes('超时'), outcome.content);
    check('超时：及时返回（<5s）', elapsed < 5000, 'elapsed=' + elapsed);
    await sleep(9600);
    check('超时：孙进程被杀死（未写标记）', !fs.existsSync(marker), 'marker exists');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('\n结果：PASS ' + pass + '，FAIL ' + fail);
    process.exitCode = fail === 0 ? 0 : 1;
  }
})().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
