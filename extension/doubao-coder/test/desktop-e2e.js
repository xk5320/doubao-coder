/**
 * 端到端自测：直接调用编译后的桌面端桥（不经过 VS Code），验证「提问 → 流式读回」。
 * 用法：node test/desktop-e2e.js "提示词"
 */
const Module = require('node:module');
const path = require('node:path');

/* ------------------------- vscode 模块最小桩 ------------------------- */
const outputLines = [];
const stub = {
  window: {
    createOutputChannel: () => ({
      appendLine: (s) => {
        outputLines.push(s);
        console.log('[log]', s);
      },
      show: () => undefined,
      dispose: () => undefined,
    }),
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
  },
  workspace: {
    getConfiguration: () => ({ get: () => undefined }),
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
    workspaceFolders: [],
    isTrusted: true,
  },
  ThemeColor: class {},
  StatusBarAlignment: { Right: 2 },
  Uri: { parse: (s) => s, file: (s) => s },
  ViewColumn: { One: 1, Beside: -2 },
  commands: { executeCommand: async () => undefined, registerCommand: () => ({ dispose() {} }) },
  env: { clipboard: { writeText: async () => undefined } },
  ProgressLocation: { Notification: 15 },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return stub;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const desktop = require(path.join(__dirname, '..', 'out', 'bridge', 'desktop.js'));

(async () => {
  const prompt = process.argv[2] || '只回复两个字：收到';
  console.log('=== 1) 探测 ===');
  const status = await desktop.probeDesktop(9222);
  console.log(JSON.stringify(status, null, 1));
  if (!status.ok) {
    process.exitCode = 2;
    return;
  }

  console.log('=== 2) 提问 ===');
  console.log('prompt:', prompt);
  const controller = new AbortController();
  const started = Date.now();
  let chunks = 0;
  const result = await desktop.askDesktop(prompt, {
    port: 9222,
    newChat: true,
    timeoutMs: 120000,
    signal: controller.signal,
    onDelta: (text) => {
      chunks += 1;
      process.stdout.write(text);
    },
  });
  console.log('\n=== 3) 结果 ===');
  console.log(JSON.stringify({ ...result, chunks, elapsedMs: Date.now() - started }, null, 1));
})().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
