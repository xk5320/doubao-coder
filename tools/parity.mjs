/**
 * 对拍（differential parity）：豆包界面 vs 扩展提取结果。
 *
 * 参考侧：按**屏幕上的实际顺序**（getBoundingClientRect().top）取「计时 / 反馈步骤 / 正文」，
 *        不依赖扩展的提取逻辑，是独立的第二实现。
 * 生产侧：直接跑扩展编译产物 out/bridge/md-extractor.js 里的 readLastReplyJs()。
 * 两边都从同一个活页面读，逐块比对类型、文案、顺序、同步状态。
 *
 * 用法：
 *   node tools/parity.mjs                 # 对拍当前最后一条回复一次
 *   node tools/parity.mjs --watch 30      # 连续对拍 30 秒（每秒一次，适合任务执行中）
 *   node tools/parity.mjs --record        # 把样本写入扩展的 test/fixtures/parity/
 *   node tools/parity.mjs --json          # 输出机器可读结果
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(__dirname, '..', 'extension', 'doubao-coder');
const FIXTURE_DIR = path.join(EXT_DIR, 'test', 'fixtures', 'parity');
const require = createRequire(import.meta.url);
const PORT = Number(process.env.DOUBAO_DEBUG_PORT || 9222);

/** 延迟加载编译产物：只跑纯比较（离线回归）时不要求先 tsc。 */
let extractor;
function loadExtractor() {
  if (!extractor) {
    const entry = path.join(EXT_DIR, 'out', 'bridge', 'md-extractor.js');
    if (!fs.existsSync(entry)) {
      throw new Error('缺少编译产物 ' + entry + '，请先在扩展目录执行 npx tsc -p .');
    }
    extractor = require(entry);
  }
  return extractor;
}

/* ----------------------------- CDP 小客户端 ----------------------------- */
export async function connect(port = PORT) {
  const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const page = list.find((t) => t.type === 'page' && String(t.url).includes('doubao-chat'));
  if (!page) throw new Error('没有找到 doubao-chat 页面（需要 --remote-debugging-port）');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  };
  const call = (method, params) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text + ' ' + String(result.exceptionDetails.exception && result.exceptionDetails.exception.description || ''));
    }
    return result.result.value;
  };
  return { ws, evaluate, page };
}

/* ----------------------------- 参考实现（独立） ----------------------------- */
export function referenceExpr(index = -1) {
  return `(() => {
  const norm = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
  const assistants = [...document.querySelectorAll('[data-testid="union_message"]')]
    .filter((m) => m.querySelector('[data-message-role="assistant"]'));
  if (!assistants.length) return { none: true };
  const last = assistants[${index} < 0 ? assistants.length + ${index} : ${index}];
  const content = last.querySelector('[data-testid="message_content"]');
  if (!content) return { none: true };
  const timerEl = last.querySelector('[data-testid="preamble-elapsed-timer"]');
  const timerText = timerEl ? norm(timerEl.textContent) : '';
  const cands = [];
  let seq = 0;
  for (const node of content.querySelectorAll('[data-plugin-identifier]')) {
    const pid = node.getAttribute('data-plugin-identifier') || '';
    const type = (/block_type:(\\d+)/.exec(pid) || [])[1];
    if (type !== '10040' && type !== '10000') continue;
    const rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    if (type === '10040') {
      const rows = [...node.querySelectorAll('[data-thinking-box="step-message"]')].filter((row) => {
        const q = row.getBoundingClientRect();
        return q.width > 0 && q.height > 0;
      });
      let lastKey = '';
      for (const row of rows) {
        const q = row.getBoundingClientRect();
        const titleEl = row.querySelector('div.truncate') || row.querySelector('[data-thinking-box="title"]');
        const title = norm(titleEl ? titleEl.textContent : row.innerText);
        if (!title) continue;
        const isCommand = /^(已执行代码|正在执行代码|已执行|正在执行)/.test(title);
        const failed = !isCommand && title.length <= 40 && /超时|失败|出错|错误/.test(title);
        const state = /^正在/.test(title) ? 'running' : (failed ? 'error' : 'done');
        const key = state + '|' + title;
        if (key === lastKey) continue;
        lastKey = key;
        cands.push({ top: q.top, left: q.left, seq: seq++, kind: 'step', text: title, state: state });
      }
      if (rows.length) continue;
      const title = norm(node.innerText);
      if (!title) continue;
      const isCommand = /^(已执行代码|正在执行代码|已执行|正在执行)/.test(title);
      const failed = !isCommand && title.length <= 40 && /超时|失败|出错|错误/.test(title);
      cands.push({ top: rect.top, left: rect.left, seq: seq++, kind: 'step', text: title, state: /^正在/.test(title) ? 'running' : (failed ? 'error' : 'done') });
    } else {
      const md = node.querySelector('[data-testid="message_text_content"]');
      if (!md) continue;
      const body = norm(md.innerText);
      if (!body) continue;
      const streaming = md.dataset ? md.dataset.streaming === 'true' : false;
      cands.push({ top: rect.top, left: rect.left, seq: seq++, kind: 'text', text: body, streaming: streaming });
    }
  }
  cands.sort((a, b) => (Math.abs(a.top - b.top) > 2 ? a.top - b.top : a.left - b.left));
  const blocks = [];
  if (timerText) blocks.push({ kind: 'status', text: timerText });
  for (const c of cands) blocks.push(c);
  const parseSeconds = (t) => {
    const h = /(\\d+)\\s*(?:小时|时)/.exec(t);
    const m = /(\\d+)\\s*分/.exec(t);
    const s = /(\\d+)\\s*秒/.exec(t);
    if (!h && !m && !s) return -1;
    return (h ? +h[1] * 3600 : 0) + (m ? +m[1] * 60 : 0) + (s ? +s[1] : 0);
  };
  const busy = [...document.querySelectorAll('button,[role="button"]')].some((el) => {
    const sig = ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.getAttribute('data-testid') || '') + ' ' + (el.className || ''));
    return /停止|stop/i.test(sig) && el.getBoundingClientRect().width > 0;
  });
  const raw = last.innerText || '';
  return {
    count: assistants.length,
    blocks: blocks,
    progress: timerText,
    progressSeconds: parseSeconds(timerText),
    done: /^共用时/.test(timerText),
    streaming: cands.some((c) => c.kind === 'text' && c.streaming),
    executing: /正在执行(代码|命令)/.test(raw) || cands.some((c) => c.kind === 'step' && c.state === 'running'),
    busy: busy,
  };
})()`;
}

/** 默认对比最后一条助手回复。 */
export const REFERENCE_EXPR = referenceExpr(-1);

/* ----------------------------- 归一化与比较 ----------------------------- */
/** 把 Markdown / innerText 压成同一形态：去掉围栏、行内反引号、列表符号、所有空白。 */
export function plain(text) {
  return String(text == null ? '' : text)
    .replace(/```[a-zA-Z0-9+#.-]*\n?/g, '')
    .replace(/`/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/\s+/g, '');
}

function blocksOnly(blocks) {
  return (Array.isArray(blocks) ? blocks : []).filter((b) => b && b.text && (b.kind === 'status' || b.kind === 'step' || b.kind === 'text'));
}

export function compare(ref, prod) {
  const diffs = [];
  if (!ref || ref.none) return { ok: false, diffs: [{ at: 'page', detail: '没有找到助手回复' }] };
  if (!prod || !prod.count) return { ok: false, diffs: [{ at: 'page', detail: '生产提取器没读到回复' }] };
  if (ref.progress !== String(prod.progress || '')) {
    diffs.push({ at: 'timer', detail: '参考 ' + JSON.stringify(ref.progress) + ' / 生产 ' + JSON.stringify(prod.progress) });
  }
  if (ref.progressSeconds !== prod.progressSeconds) {
    diffs.push({ at: 'timer', detail: '秒数 参考 ' + ref.progressSeconds + ' / 生产 ' + prod.progressSeconds });
  }
  if (Boolean(ref.done) !== Boolean(prod.done)) {
    diffs.push({ at: 'timer', detail: 'done 参考 ' + ref.done + ' / 生产 ' + prod.done });
  }
  if (Boolean(ref.executing) !== Boolean(prod.executing)) {
    diffs.push({ at: 'state', detail: 'executing 参考 ' + ref.executing + ' / 生产 ' + prod.executing });
  }
  const a = blocksOnly(ref.blocks);
  const b = blocksOnly(prod.blocks);
  if (a.length !== b.length) diffs.push({ at: 'blocks', detail: '块数 参考 ' + a.length + ' / 生产 ' + b.length });
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const ra = a[i];
    const rb = b[i];
    if (!ra || !rb) { diffs.push({ at: 'block[' + i + ']', detail: ra ? '生产缺少' : '生产多出' }); continue; }
    if (ra.kind !== rb.kind) { diffs.push({ at: 'block[' + i + ']', detail: '类型 参考 ' + ra.kind + ' / 生产 ' + rb.kind }); continue; }
    if (ra.kind === 'step') {
      if (plain(ra.text) !== plain(rb.text)) {
        diffs.push({ at: 'block[' + i + ']', detail: '步骤标题不一致：' + brief(ra.text, rb.text) });
      }
      if ((ra.state || 'done') !== (rb.state || 'done')) {
        diffs.push({ at: 'block[' + i + ']', detail: '步骤状态 参考 ' + ra.state + ' / 生产 ' + rb.state });
      }
    } else if (plain(ra.text) !== plain(rb.text)) {
      diffs.push({ at: 'block[' + i + ']', detail: (ra.kind === 'status' ? '计时文案' : '正文') + '不一致：' + brief(ra.text, rb.text) });
    }
  }
  return { ok: diffs.length === 0, diffs };
}

function brief(x, y) {
  const a = String(x || '').replace(/\\s+/g, ' ').slice(0, 90);
  const b = String(y || '').replace(/\\s+/g, ' ').slice(0, 90);
  return '参考『' + a + '』 / 生产『' + b + '』';
}

/* ----------------------------- 采样与输出 ----------------------------- */
export async function snapshot(conn, index = -1) {
  const { MD_INSTALL_JS, readLastReplyJs } = loadExtractor();
  await conn.evaluate(MD_INSTALL_JS);
  const ref = await conn.evaluate(referenceExpr(index));
  const prod = await conn.evaluate(readLastReplyJs('[data-testid="receive_message"]', '[data-testid="message_text_content"]', index));
  return { at: new Date().toISOString(), ref, prod, result: compare(ref, prod) };
}

export async function assistantCount(conn) {
  return conn.evaluate("[...document.querySelectorAll('[data-testid=\"union_message\"]')].filter((m) => m.querySelector('[data-message-role=\"assistant\"]')).length");
}

function saveFixture(sample) {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const name = 'parity-' + sample.at.replace(/[:.]/g, '-') + '.json';
  fs.writeFileSync(path.join(FIXTURE_DIR, name), JSON.stringify(sample, null, 1), 'utf8');
  return name;
}

async function main() {
  const argv = process.argv.slice(2);
  const watchIdx = argv.indexOf('--watch');
  const watchSec = watchIdx >= 0 ? Number(argv[watchIdx + 1] || 20) : 0;
  const record = argv.includes('--record');
  const json = argv.includes('--json');
  const conn = await connect();
  const all = argv.includes('--all');
  if (all) {
    const n = await assistantCount(conn);
    let diffsTotal = 0;
    let failedAll = 0;
    for (let i = 0; i < n; i += 1) {
      const sample = await snapshot(conn, i);
      if (!sample.result.ok) { failedAll += 1; diffsTotal += sample.result.diffs.length; }
      const steps = sample.ref.blocks.filter((b) => b.kind === 'step').length;
      console.log(
        (sample.result.ok ? 'PASS' : 'FAIL') + '  msg#' + i +
        '  ' + (sample.ref.progress || '-') +
        '  blocks=' + sample.ref.blocks.length + '  steps=' + steps +
        (sample.result.ok ? '' : '  diffs=' + sample.result.diffs.length),
      );
      for (const d of sample.result.diffs.slice(0, 6)) console.log('      · ' + d.at + ': ' + d.detail);
      if (record && (sample.result.ok || failedAll === 1)) saveFixture(sample);
    }
    conn.ws.close();
    console.log('\n全对话对拍：' + n + ' 条助手回复，' + failedAll + ' 条有差异（共 ' + diffsTotal + ' 处）。');
    process.exit(failedAll ? 1 : 0);
  }
  const samples = [];
  const started = Date.now();
  let round = 0;
  let failed = 0;
  do {
    round += 1;
    const sample = await snapshot(conn);
    samples.push(sample);
    if (!sample.result.ok) failed += 1;
    if (watchSec === 0 || !json) {
      const hits = sample.ref.blocks.filter((b) => b.kind === 'step').length;
      console.log(
        (sample.result.ok ? 'PASS' : 'FAIL') +
        '  #' + round +
        '  ' + (sample.ref.progress || '-') +
        '  blocks=' + sample.ref.blocks.length +
        '  steps=' + hits +
        (sample.result.ok ? '' : '  diffs=' + sample.result.diffs.length),
      );
      for (const d of sample.result.diffs.slice(0, 8)) console.log('      · ' + d.at + ': ' + d.detail);
    }
    if (record && (sample.result.ok || failed === 1)) saveFixture(sample);
    if (watchSec > 0) await new Promise((r) => setTimeout(r, 1000));
  } while (watchSec > 0 && Date.now() - started < watchSec * 1000);
  conn.ws.close();
  if (json) {
    console.log(JSON.stringify({ rounds: samples.length, failed, samples: samples.slice(-3).map((s) => ({ at: s.at, ok: s.result.ok, diffs: s.result.diffs })) }, null, 1));
  }
  console.log('\n对拍结束：' + samples.length + ' 轮，' + failed + ' 轮有差异。');
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error('对拍失败：' + (err && err.message ? err.message : String(err))); process.exit(2); });
}