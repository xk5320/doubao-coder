/**
 * 安装资源对接实测：
 *   1) 能否在真实安装目录里发现豆包、读出官方动作面（20 个动作 + 签名）
 *   2) 我们的 TS 端口径是否与安装目录版本一致（漂移检测）
 *   3) GAC 执行通道是否可用（预期：不可用，并给出原因）
 *   4) 后端选择是否按预期退化
 *
 * 用法：node test/cu-install.test.js [pythonPath]
 */
const Module = require('node:module');
const path = require('node:path');

const stub = {
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
  },
  workspace: { getConfiguration: () => ({ get: () => undefined }), onDidChangeConfiguration: () => ({ dispose() {} }) },
  env: { openExternal: async () => undefined },
  Uri: { parse: (s) => s },
  commands: { executeCommand: async () => undefined },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return stub;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const OUT = path.join(__dirname, '..', 'out');
const { detectInstall, readComputerUseSurface, probeGacChannel, summarizeResources } = require(path.join(OUT, 'doubao', 'install.js'));
const { selectBackend, describeSelection } = require(path.join(OUT, 'cu', 'backend-select.js'));

const pythonPath = process.argv[2] || 'python';

/** 我们的 TS 端实现的 20 个动作（与 actions.ts 对应）。 */
const OUR_ACTIONS = [
  'switch_desktop', 'screenshot', 'list_apps', 'launch_app', 'click', 'left_double', 'triple_click',
  'right_single', 'hover', 'drag', 'scroll', 'type', 'hotkey', 'press', 'key_down', 'key_up',
  'wait', 'get_clipboard', 'set_clipboard', 'copy_selection',
];

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

(async () => {
  console.log('=== 1) 检测安装 ===');
  const install = await detectInstall();
  check('发现豆包安装', Boolean(install), '未找到 Doubao.exe');
  if (!install) {
    console.log(`\n[结果] pass=${pass} fail=${fail}`);
    process.exitCode = 1;
    return;
  }
  console.log(`  目录：${install.appDir}`);
  console.log(`  版本：${install.version}  GAC SDK：${install.hasGacRuntime}`);

  const res = await summarizeResources(install);
  for (const r of res) {
    console.log(`  · ${r.name}: ${r.detail}`);
  }
  check('安装目录含 gac_runtime', install.hasGacRuntime === true);

  console.log('\n=== 2) 从安装目录读动作面 ===');
  const surface = await readComputerUseSurface(install, pythonPath);
  check('读到了动作面', Array.isArray(surface) && surface.length > 0, '未读到（Python 不可用？）');
  if (surface) {
    const names = surface.map((a) => a.name);
    check('动作数 = 20', names.length === 20, String(names.length));
    const missing = OUR_ACTIONS.filter((n) => !names.includes(n));
    const extra = names.filter((n) => !OUR_ACTIONS.includes(n));
    check('与 TS 端动作名一致（无漂移）', missing.length === 0 && extra.length === 0, `missing=${missing} extra=${extra}`);
    const sig = Object.fromEntries(surface.map((a) => [a.name, a.signature]));
    check('screenshot 签名对齐', sig.screenshot === '(*, tag=None, show=True)', sig.screenshot);
    check('click 签名对齐', sig.click === '(x, y)', sig.click);
    check('hotkey 是可变位置参数', sig.hotkey === '(*keys)', sig.hotkey);
    check('wait 默认 3 秒', sig.wait.includes('3'), sig.wait);
    console.log('  示例：', surface.slice(0, 4).map((a) => `${a.name}${a.signature}`).join('  '));
  }

  console.log('\n=== 3) GAC 执行通道探测 ===');
  const probe = await probeGacChannel(install, pythonPath);
  console.log(`  available=${probe.available}  reason=${probe.reason}`);
  check('不带 GAC 环境时判定不可用', probe.available === false);
  check('原因里点名 CUA_GAC', /CUA_GAC|GUI as Coding/.test(probe.reason), probe.reason);

  console.log('\n=== 4) 后端选择（auto） ===');
  const sel = await selectBackend({ mode: 'auto', pythonPath, promptIfMissing: false });
  check('auto → 退化到 win32', sel.kind === 'win32', sel.kind);
  check('退化原因非空', Boolean(sel.reason), String(sel.reason));
  console.log('  ' + describeSelection(sel));

  const forced = await selectBackend({ mode: 'win32', pythonPath, promptIfMissing: false });
  check('强制 win32 生效', forced.kind === 'win32');
  let throwMsg = '';
  try {
    await selectBackend({ mode: 'doubao', pythonPath, promptIfMissing: false });
  } catch (err) {
    throwMsg = err.message;
  }
  check('强制 doubao 时报错并说明原因', throwMsg.includes('强制使用豆包 SDK 失败'), throwMsg);

  console.log(`\n[结果] pass=${pass} fail=${fail}`);
  process.exitCode = fail === 0 ? 0 : 1;
})().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
