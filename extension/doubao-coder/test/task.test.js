/**
 * 任务模式离线单测：用假的 complete() 驱动「计划 → 单动作 → 执行 → 答复」，
 * 不联网、不碰豆包会话。
 * 用法：node test/task.test.js
 */
const Module = require('node:module');
const path = require('node:path');

const WORKSPACE = path.join(__dirname, '..');
const folder = { uri: { fsPath: WORKSPACE }, name: 'doubao-coder', index: 0 };
const stub = {
  window: {
    createOutputChannel: () => ({ appendLine: (s) => console.log('[log]', s), show() {}, dispose() {} }),
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
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
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

const { TaskRunner, parsePlan } = require(path.join(__dirname, '..', 'out', 'agent', 'task.js'));

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ' → ' + detail : ''}`);
  }
}

const FENCE = String.fromCharCode(96, 96, 96);
const config = {
  authMode: 'desktop', baseUrl: '', apiKey: '', model: 'm', completionModel: 'm', temperature: 0.2,
  maxTokens: 2048, maxToolIterations: 8, enableInlineCompletion: false, systemPromptFile: '',
  rulesFile: '', terminalAutoRun: false, mcpEnabled: false, desktopPort: 9222, desktopNewChat: false,
  desktopTimeoutMs: 1000, desktopExePath: 'x', ptcEnabled: true, ptcMaxRounds: 4,
  taskPermission: 'risk', taskMaxSteps: 6, apiKeySource: 'missing',
};
const runtime = {
  config,
  extensionContext: { workspaceState: { get: () => undefined, update: async () => undefined }, subscriptions: [] },
  confirmTerminal: async () => true,
};

/* 计划解析 */
{
  const p1 = parsePlan('```json\n["a","b","c"]\n```');
  check('parsePlan: 代码块', p1.length === 3 && p1[0] === 'a');
  const p2 = parsePlan('前言 ["x","y"] 后记');
  check('parsePlan: 裸数组', p2.length === 2);
  const p3 = parsePlan('这不是 JSON');
  check('parsePlan: 非法输入返回空', p3.length === 0);
}

/* 正常流程：计划 → list_dir → 答复 */
(async () => {
  const calls = [];
  const outputs = [
    '```json\n["看看目录结构", "给出结论"]\n```',
    FENCE + 'tool\n{"name":"list_dir","arguments":{"path":"src"}}\n' + FENCE,
    '目录里有若干 .ts 文件，结论：结构清晰。',
  ];
  const complete = async (prompt) => {
    calls.push(prompt.slice(0, 40));
    return outputs[Math.min(calls.length - 1, outputs.length - 1)];
  };

  const events = { plan: null, tools: [], text: '', answer: null };
  const runner = new TaskRunner({
    goal: '看看 src 目录并总结',
    root: WORKSPACE,
    config,
    runtime,
    complete,
    permission: 'risk',
    maxSteps: 6,
    confirm: async () => true,
    events: {
      onPlan: (p) => { events.plan = p; },
      onTextDelta: (t) => { events.text += t; },
      onToolStart: (e) => events.tools.push(e.name),
      onToolEnd: () => undefined,
      onDone: (r) => { events.answer = r.answer; },
    },
  });

  const result = await runner.run();
  check('计划已产生', Array.isArray(events.plan) && events.plan.length === 2, JSON.stringify(events.plan));
  check('执行了 1 次工具', events.tools.length === 1 && events.tools[0] === 'list_dir', JSON.stringify(events.tools));
  check('步数记录 1 条', result.steps.length === 1, String(result.steps.length));
  check('工具执行成功', result.steps[0] && result.steps[0].ok === true, JSON.stringify(result.steps[0] && result.steps[0].ok));
  check('最终答复非空', result.answer.length > 0, result.answer);
  check('onDone 被调用', events.answer === result.answer);
  check('模型被调用 3 次（计划+动作+收尾）', calls.length === 3, String(calls.length));
})()
  .then(async () => {
    /* 危险动作被拒绝：不会执行，且把拒绝原因回灌 */
    let denied = 0;
    let executed = 0;
    const outputs = [
      '```json\n["尝试推送"]\n```',
      FENCE + 'tool\n{"name":"run_terminal","arguments":{"command":"git push origin main"}}\n' + FENCE,
      '推送被拒绝，改为只给建议。',
    ];
    let i = 0;
    const runner = new TaskRunner({
      goal: '帮我推送代码',
      root: WORKSPACE,
      config,
      runtime,
      complete: async () => outputs[Math.min(i++, outputs.length - 1)],
      permission: 'risk',
      maxSteps: 3,
      confirm: async () => {
        denied += 1;
        return false;
      },
      events: {
        onToolStart: () => { executed += 1; },
      },
    });
    const result = await runner.run();
    check('危险动作弹了确认', denied === 1, String(denied));
    check('被拒绝后未执行工具', executed === 0, String(executed));
    check('拒绝原因进入步骤记录', result.steps[0] && result.steps[0].ok === false);
    check('后续得到答复', result.answer.includes('拒绝'), result.answer);

    console.log(`\n[结果] pass=${pass} fail=${fail}`);
    process.exitCode = fail === 0 ? 0 : 1;
  })
  .catch((err) => {
    console.error('FAILED:', err && err.stack ? err.stack : err);
    process.exitCode = 1;
  });
