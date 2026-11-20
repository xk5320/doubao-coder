/* M2 端到端：把鼠标点转发到豆包窗口，验证焦点真的落到输入框。 */
const path = require('node:path');
const Module = require('node:module');

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') {
    return { window: { createOutputChannel: () => ({ appendLine() {}, show() {} }) } };
  }
  return origLoad.apply(this, arguments);
};

const { DesktopInput } = require(path.join(__dirname, '..', 'out', 'bridge', 'desktop-input.js'));
const { CdpSession, listTargets } = require(path.join(__dirname, '..', 'out', 'bridge', 'cdp.js'));

(async () => {
  const input = await DesktopInput.connect();
  const size = input.size;
  console.log(`视口: ${size.width}×${size.height}`);
  if (!size.width || !size.height) {
    console.log('[FAIL] 视口尺寸为空');
    process.exit(1);
  }

  // 用原生连接读一下输入框的坐标（只读 DOM）
  const targets = await listTargets(9222);
  const page = targets.find((t) => t.type === 'page' && t.url.includes('doubao-chat'));
  const session = await CdpSession.connect(page.webSocketDebuggerUrl);
  const rect = await session.evaluate(
    `(() => {
      const ed = document.querySelector('[data-testid="chat_input_input"] [contenteditable="true"]');
      if (!ed) return null;
      const r = ed.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
    })()`,
  );
  if (!rect) {
    console.log('[FAIL] 页面里没有输入框');
    process.exit(1);
  }
  console.log(`输入框中心: (${Math.round(rect.x)}, ${Math.round(rect.y)})`);

  // 用脚本让焦点离开输入框（点顶栏可能打开下拉，导致后续点击被遮挡）
  await session.evaluate(
    `(() => { const el = document.activeElement; if (el && el.blur) el.blur(); return true; })()`,
  );
  await new Promise((r) => setTimeout(r, 300));
  const before = await session.evaluate(
    `(() => { const ed = document.querySelector('[data-testid="chat_input_input"]'); return Boolean(ed && ed.contains(document.activeElement)); })()`,
  );

  // 再点输入框中心
  await input.click(rect.x / size.width, rect.y / size.height);
  await new Promise((r) => setTimeout(r, 400));
  const after = await session.evaluate(
    `(() => { const ed = document.querySelector('[data-testid="chat_input_input"]'); return Boolean(ed && ed.contains(document.activeElement)); })()`,
  );

  console.log(`点击前焦点在输入框: ${before} → 点击后: ${after}`);
  input.close();
  session.close();

  if (!after) {
    console.log('[FAIL] 点击没有把焦点给到输入框');
    process.exit(1);
  }
  console.log('[PASS] M2 输入转发可用（点击命中输入框）');
})();
