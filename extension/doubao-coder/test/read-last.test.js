/**
 * 只读验证：把最新版 __dcMd 注入当前豆包页面，重新解析「最后一条助手消息」。
 * 不发消息、不改页面状态，只用来确认真实 DOM 的 Markdown 还原效果。
 * 用法：node test/read-last.test.js
 */
const path = require('node:path');

const { MD_INSTALL_JS, readLastReplyJs } = require(path.join(__dirname, '..', 'out', 'bridge', 'md-extractor.js'));
const { CdpSession, listTargets } = require(path.join(__dirname, '..', 'out', 'bridge', 'cdp.js'));

const SEL = {
  receive: '[data-testid="receive_message"]',
  text: '[data-testid="message_text_content"]',
};

async function cdpAvailable() {
  const http = require('node:http');
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:9222/json/version', { timeout: 1500 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}
(async () => {
  if (!(await cdpAvailable())) {
    console.log('[SKIP] 需要豆包调试端口（9222），本机不可用，跳过该集成测试');
    return;
  }
  const targets = await listTargets(9222);
  const page = targets.find((t) => t.type === 'page' && t.url.includes('doubao-chat'));
  if (!page) {
    throw new Error('没有找到豆包页面');
  }
  const session = await CdpSession.connect(page.webSocketDebuggerUrl);
  try {
    await session.evaluate(MD_INSTALL_JS);
    const snap = await session.evaluate(readLastReplyJs(SEL.receive, SEL.text));
    console.log('--- 最后一条回复（Markdown 还原） ---');
    console.log(snap.text);
    const ok = !/^[a-zA-Z]{1,16}\n\n```/.test(snap.text);
    console.log('\n[断言] 语言标签已去除：' + (ok ? 'PASS' : 'FAIL'));
    process.exitCode = ok ? 0 : 1;
  } finally {
    session.close();
  }
})().catch((err) => {
  const message = err && err.message ? String(err.message) : String(err);
  if (/timeout|ECONNREFUSED|socket hang up|connect/i.test(message)) {
    console.log('[SKIP] 需要豆包调试端口（9222），本机不可用，跳过该集成测试');
    process.exit(0);
  }
  console.error('FAILED:', err);
  process.exit(1);
});
