/**
 * 设置中心前端冒烟测试：在伪 DOM 里真实执行 media/settings.js，
 * 验证渲染、连接方式切换、配置更新、动作按钮与 toast。
 * 用法：node test/settings-ui.test.js
 */
const fs = require('node:fs');
const path = require('node:path');
const { createHarness } = require('./dom-harness.js');

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

const harness = createHarness();
const doc = harness.document;
for (const id of ['app', 'modeSub', 'versionBadge', 'toast']) {
  const node = doc.createElement('div');
  node.id = id;
  doc.body.appendChild(node);
}
const refreshNode = doc.createElement('button');
refreshNode.id = 'refreshBtn';
doc.body.appendChild(refreshNode);

const source = fs.readFileSync(path.join(__dirname, '..', 'media', 'settings.js'), 'utf8');
let bootError = null;
try {
  harness.load(source, 'media/settings.js');
} catch (err) {
  bootError = err;
}
check('启动：settings.js 在伪 DOM 中执行不抛错', !bootError, bootError && (bootError.stack || String(bootError)));
check('启动：向扩展发送 ready', harness.posted.some((item) => item && item.type === 'ready'), JSON.stringify(harness.posted));

const state = {
  authMode: 'cli',
  version: '0.51.0',
  cli: {
    installed: true,
    version: '2.37.2',
    binary: 'C:\\doubao_cli\\app\\current\\doubao.exe',
    source: 'appdata',
    error: '',
    loggedIn: null,
    authDetail: '',
    path: '',
    permissionMode: 'ask_risky',
    model: '',
    effort: 'High',
    timeoutMs: 600000,
  },
  desktop: {
    installed: true,
    exePath: 'C:\\Doubao\\Doubao.exe',
    port: 9222,
    connected: false,
    error: '端口未开',
    workMode: 'local',
    model: 'DeepSeek V4.1 Flash',
    reasoning: '高',
  },
  ark: {
    hasKey: false,
    source: 'missing',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seed-code',
    maxTokens: 4096,
  },
  general: {
    enableInlineCompletion: true,
    terminalAutoRun: true,
    reviewEdits: true,
    autoContinue: true,
    autoContinueSeconds: 5,
    autoVerifyAfterAccept: true,
  },
  installCommand: "npm install -g '@bytedance/doubao-cli'",
};

const errors = harness.send({ type: 'state', state });
check('渲染：state 消息不抛错', errors.length === 0, errors.map((e) => e && e.stack).join('\n'));
const app = harness.byId('app');
check('渲染：显示连接方式标题', app.textContent.includes('连接方式'));
const radios = app.querySelectorAll('input').filter((item) => item.type === 'radio' && item.name === 'authMode');
check('渲染：三张模式卡片', radios.length === 3, String(radios.length));
check('渲染：CLI 配置区', app.textContent.includes('豆包 CLI 配置'));
check('渲染：显示版本与登录状态', app.textContent.includes('2.37.2') && app.textContent.includes('登录状态未验证'));
check('渲染：通用配置区', app.textContent.includes('通用') && app.textContent.includes('行内补全'));

/* 切换连接方式：radio change */
const desktopRadio = radios[1];
desktopRadio.checked = true;
desktopRadio.dispatchEvent({ type: 'change', target: desktopRadio });
check(
  '交互：切换到桌面版会发 setMode',
  harness.posted.some((item) => item && item.type === 'setMode' && item.mode === 'desktop'),
  JSON.stringify(harness.posted.slice(-3)),
);

/* 切换后重新渲染桌面版 */
const desktopState = Object.assign({}, state, { authMode: 'desktop' });
desktopState.desktop = Object.assign({}, state.desktop, { connected: true, error: '' });
const errors2 = harness.send({ type: 'state', state: desktopState });
check('渲染：桌面版配置区', errors2.length === 0 && app.textContent.includes('豆包桌面版配置'));
check('渲染：桌面版已连接', app.textContent.includes('调试端口已连接'));

/* 配置更新：select change */
const selects = app.querySelectorAll('select');
const permission = selects.find((item) => item.dataset.key === 'desktop.workMode');
permission.value = 'chat';
app.dispatchEvent({ type: 'change', target: permission });
check(
  '交互：修改配置会发 update',
  harness.posted.some((item) => item && item.type === 'update' && item.key === 'desktop.workMode' && item.value === 'chat'),
  JSON.stringify(harness.posted.slice(-4)),
);

/* 动作按钮 */
const buttons = app.querySelectorAll('button');
const connectBtn = buttons.find((item) => item.dataset.action === 'desktopConnect');
app.dispatchEvent({ type: 'click', target: connectBtn });
check(
  '交互：动作按钮发 action',
  harness.posted.some((item) => item && item.type === 'action' && item.value === 'desktopConnect'),
  JSON.stringify(harness.posted.slice(-3)),
);

/* 刷新按钮 */
harness.byId('refreshBtn').click();
check(
  '交互：重新检测发 refresh',
  harness.posted.some((item) => item && item.type === 'refresh'),
);

/* 提示 */
harness.send({ type: 'saved', key: 'desktop.workMode' });
check('提示：保存成功 toast', harness.byId('toast').textContent.includes('已保存'));
harness.send({ type: 'authResult', ok: false, detail: '未登录' });
check('提示：登录失败 toast', harness.byId('toast').textContent.includes('未登录'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) {
  process.exitCode = 1;
}
