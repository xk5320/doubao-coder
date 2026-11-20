/**
 * 离线单测：把 __dcMd 注入一个 about:blank 页面，喂合成 HTML，验证 Markdown 还原。
 * 不触碰豆包会话，纯本地验证。
 * 用法：node test/md-extractor.test.js
 */
const path = require('node:path');
const http = require('node:http');

const { MD_INSTALL_JS } = require(path.join(__dirname, '..', 'out', 'bridge', 'md-extractor.js'));

function httpJson(method, p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: 9222, path: p, method, timeout: 5000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

/* 直接复用扩展里的 WS/CDP 客户端（已编译产物） */
const { CdpSession } = require(path.join(__dirname, '..', 'out', 'bridge', 'cdp.js'));

const HTML = `
<div id="root">
  <div data-testid="message_text_content" data-streaming="false">
    <div class="code-header">python</div>
    <pre><code class="language-python">def f(x):\n    return x + 1</code></pre>
    <p>说明：<strong>加粗</strong> 与行内 <code>foo()</code>。</p>
    <h3>小节标题</h3>
    <ul><li>第一项</li><li>第二项</li></ul>
    <table><tr><td>a</td><td>b</td></tr></table>
  </div>
</div>`;

(async () => {
  const target = await httpJson('PUT', '/json/new?about:blank');
  const session = await CdpSession.connect(target.webSocketDebuggerUrl, 5000);
  try {
    await session.evaluate(`document.body.innerHTML = ${JSON.stringify(HTML)}; true`);
    await session.evaluate(MD_INSTALL_JS);
    const md = await session.evaluate(
      `window.__dcMd(document.querySelector('[data-testid="message_text_content"]'))`,
    );
    console.log('--- 还原结果 ---');
    console.log(md);
    const ok =
      md.includes('```python') &&
      md.includes('def f(x):') &&
      md.includes('**') === false && // 不还原 strong（刻意简化，只要文本即可）
      md.includes('`foo()`') &&
      md.includes('### 小节标题') &&
      md.includes('- 第一项') &&
      !md.startsWith('python');
    console.log('\n[断言] ' + (ok ? 'PASS' : 'FAIL'));
    process.exitCode = ok ? 0 : 1;
  } finally {
    session.close();
    await httpJson('GET', `/json/close/${target.id}`).catch(() => undefined);
  }
})().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
