/**
 * 聊天路径策略门测试：ask/risk/allow 三档 + run_terminal 自身确认 + 只读工具。
 * 用法：node test/guard.test.js
 */
const path = require('node:path');
const Module = require('node:module');

const ROOT = 'D:\\rex86\\demo';
const folder = { uri: { fsPath: ROOT }, name: 'demo', index: 0 };
const stub = {
  window: { createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }) },
  workspace: {
    getConfiguration: () => ({ get: () => undefined }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    workspaceFolders: [folder],
    getWorkspaceFolder: () => folder,
  },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return stub;
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { guardToolCall } = require(path.join(__dirname, '..', 'out', 'agent', 'guard.js'));

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
function runtime(mode, approve) {
  return {
    config: { taskPermission: mode },
    extensionContext: {},
    confirmTerminal: async () => true,
    confirmRisk: async () => approve,
  };
}

(async () => {
  check('read_file：safe 不确认', (await guardToolCall('read_file', { path: 'a.ts' }, runtime('ask', false))) === undefined);

  const denied = await guardToolCall('write_file', { path: 'a.ts' }, runtime('ask', false));
  check('ask：写工作区内要确认，拒绝则拦截', typeof denied === 'string' && denied.includes('拒绝'), denied);
  check('ask：同意则放行', (await guardToolCall('write_file', { path: 'a.ts' }, runtime('ask', true))) === undefined);

  let asked = 0;
  const riskRuntime = runtime('risk', true);
  riskRuntime.confirmRisk = async () => { asked += 1; return true; };
  check('risk：工作区内写入不确认', (await guardToolCall('write_file', { path: 'a.ts' }, riskRuntime)) === undefined && asked === 0, 'asked=' + asked);
  const outside = await guardToolCall('write_file', { path: '../outside.txt' }, riskRuntime);
  check('risk：工作区外写入要确认', outside === undefined && asked === 1, 'asked=' + asked);

  check('allow：工作区外也不确认', (await guardToolCall('write_file', { path: '../outside.txt' }, runtime('allow', false))) === undefined);

  const term = await guardToolCall('run_terminal', { command: 'git push' }, runtime('ask', false));
  check('run_terminal：交给工具自身确认，不重复弹窗', term === undefined);
  const checks = await guardToolCall('run_checks', {}, runtime('ask', false));
  check('run_checks：交给工具自身确认', checks === undefined);

  console.log('\n结果：PASS ' + pass + '，FAIL ' + fail);
  process.exitCode = fail === 0 ? 0 : 1;
})().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
