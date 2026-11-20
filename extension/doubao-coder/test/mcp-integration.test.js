/**
 * MCP 集成测试：manager 启动真实 mock server → ToolDefinition 适配 → PTC 提示词 → executeTool 路由。
 * 用法：node test/mcp-integration.test.js
 */
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..');
const folder = { uri: { fsPath: ROOT }, name: 'doubao-coder', index: 0 };
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

const { McpManager } = require(path.join(ROOT, 'out', 'mcp', 'manager.js'));
const { executeTool } = require(path.join(ROOT, 'out', 'agent', 'tools.js'));
const { buildPtcPromptSection } = require(path.join(ROOT, 'out', 'agent', 'ptc.js'));

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

const fixture = path.join(__dirname, 'fixtures', 'mock-mcp-server.js');
const config = {
  authMode: 'desktop', baseUrl: '', apiKey: '', model: '', completionModel: '', temperature: 0.2,
  maxTokens: 4096, maxToolIterations: 8, enableInlineCompletion: false, systemPromptFile: '',
  rulesFile: '', terminalAutoRun: false, mcpEnabled: false, desktopPort: 9222, desktopNewChat: false,
  desktopTimeoutMs: 180000, desktopExePath: '', ptcEnabled: true, ptcMaxRounds: 3,
  taskPermission: 'risk', taskMaxSteps: 10, installPath: '', pythonPath: 'python',
  computerBackend: 'auto', apiKeySource: 'missing', mcpServers: [],
};
const context = { workspaceState: { get: () => undefined, update: async () => undefined }, subscriptions: [] };

(async () => {
  const manager = new McpManager();
  try {
    await manager.reload([
      { name: 'mock', command: process.execPath, args: [fixture] },
      { name: 'broken', command: 'definitely-not-a-real-binary-xyz', args: [] },
    ]);
    check('manager：部分失败仍就绪', manager.toolCount >= 2, 'toolCount=' + manager.toolCount);
    const defs = manager.router.definitions();
    const names = defs.map((d) => d.name);
    check('manager：工具名为 mcp__mock__echo', names.includes('mcp__mock__echo'), names.join(','));
    check('manager：broken server 不影响 mock', names.every((n) => n.startsWith('mcp__mock__')), names.join(','));
    check('manager：description 带 server 标签', defs[0] && defs[0].description.includes('MCP:mock'), defs[0] && defs[0].description);
    check('manager：has() 正确', manager.router.has('mcp__mock__echo') && !manager.router.has('mcp__mock__nope'));
    const snapshot = manager.snapshot();
    check('manager：snapshot 两个 server', snapshot.servers.length === 2, JSON.stringify(snapshot.servers));
    check('manager：broken 标记不可用', snapshot.servers.find((s) => s.name === 'broken').ok === false);

    const prompt = buildPtcPromptSection(defs);
    check('PTC：提示词包含 MCP 工具', prompt.includes('mcp__mock__echo'));
    check('PTC：提示词保留内置工具', prompt.includes('read_file') && prompt.includes('run_checks'));

    const runtime = {
      config,
      extensionContext: context,
      confirmTerminal: async () => true,
      externalTools: manager.router,
    };
    const outcome = await executeTool('mcp__mock__echo', { text: 'hello-mcp' }, runtime);
    check('executeTool：路由到 MCP 成功', outcome.ok === true, JSON.stringify(outcome));
    check('executeTool：返回 echo 文本', outcome.ok && outcome.content.includes('hello-mcp'), outcome.content);
    const bad = await executeTool('mcp__mock__fail', {}, runtime);
    check('executeTool：MCP 工具报错转 ok=false', bad.ok === false && bad.content.includes('失败'), JSON.stringify(bad));
    const unknown = await executeTool('mcp__mock__nope', {}, runtime);
    check('executeTool：未知 MCP 工具可读报错', unknown.ok === false && unknown.content.includes('未知工具'), unknown.content);
  } finally {
    await manager.dispose();
  }
  console.log('\n结果：PASS ' + pass + '，FAIL ' + fail);
  process.exitCode = fail === 0 ? 0 : 1;
})().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
