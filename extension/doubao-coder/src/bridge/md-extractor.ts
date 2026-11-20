/**
 * 把豆包页面里渲染好的富文本节点还原成 Markdown。
 *
 * 为什么需要：`message_text_content` 的 innerText 会把代码块拍平成纯文本
 * （围栏、语言标记都丢了），直接进 VS Code 的 Markdown 渲染会变成一坨。
 * 这里在页面上下文里装一个 `window.__dcMd(node)`，把常见结构还原成 MD。
 *
 * 注意：用 String.raw 生成要注入页面的 JS 源码，且源串里**不出现反引号**
 * （代码围栏用 String.fromCharCode(96) 拼），避免模板字符串把生成的 JS 弄坏。
 */
export const MD_INSTALL_JS = String.raw`
(() => {
  // 带版本号：改了实现就升版本，避免页面里残留旧函数（网页存活期间不会自动失效）
  if (window.__dcMdVersion === 5) { return true; }
  window.__dcMdVersion = 5;
  const FENCE = String.fromCharCode(96, 96, 96);
  const TICK = String.fromCharCode(96);
  window.__dcMd = function (root) {
    if (!root) { return ''; }
    const out = [];
    const push = (s) => { if (s) { out.push(s); } };
    const walk = (n) => {
      if (!n) { return; }
      if (n.nodeType === 3) { push(n.nodeValue); return; }
      if (n.nodeType !== 1) { return; }
      const tag = n.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'svg' || tag === 'button') { return; }
      if (tag === 'pre') {
        const code = n.querySelector('code');
        const cls = code ? String(code.className || '') : '';
        const m = /language-([\w+#.-]+)/.exec(cls);
        const body = (code ? code.innerText : n.innerText) || '';
        push('\n\n' + FENCE + (m ? m[1] : '') + '\n' + body.replace(/\s+$/, '') + '\n' + FENCE + '\n\n');
        return;
      }
      if (tag === 'br') { push('\n'); return; }
      if (tag === 'img') {
        const src = n.currentSrc || n.src || '';
        if (/^https?:\/\//.test(src)) { push('\n\n![' + (n.alt || 'image') + '](' + src + ')\n\n'); }
        return;
      }
      if (tag === 'hr') { push('\n\n---\n\n'); return; }
      if (/^h[1-6]$/.test(tag)) {
        push('\n' + '#'.repeat(Number(tag[1])) + ' ' + String(n.innerText || '').trim() + '\n');
        return;
      }
      if (tag === 'li') {
        push('\n- ');
        n.childNodes.forEach(walk);
        return;
      }
      if (tag === 'table') {
        // 表格必须保留成 Markdown 管道表，否则 blocks 通道会把表格压成纯文本行
        const rows = [];
        for (const tr of n.querySelectorAll('tr')) {
          const cells = [];
          for (const cell of tr.children) {
            cells.push(String(cell.innerText || '').replace(/\s*\n\s*/g, ' ').trim());
          }
          if (cells.length) rows.push(cells);
        }
        if (rows.length) {
          const width = Math.max.apply(null, rows.map(function (cells) { return cells.length; }));
          const pad = function (cells) {
            const copy = cells.slice();
            while (copy.length < width) copy.push('');
            return copy;
          };
          push('\n\n| ' + pad(rows[0]).join(' | ') + ' |\n');
          push('| ' + pad(rows[0]).map(function () { return '---'; }).join(' | ') + ' |\n');
          for (const row of rows.slice(1)) {
            push('| ' + pad(row).join(' | ') + ' |\n');
          }
          push('\n');
          return;
        }
        push('\n\n' + String(n.innerText || '').trim() + '\n\n');
        return;
      }
      if (tag === 'code' && n.parentElement && n.parentElement.tagName.toLowerCase() !== 'pre') {
        push(TICK + String(n.innerText || '') + TICK);
        return;
      }
      if (tag === 'p' || tag === 'div' || tag === 'section') {
        n.childNodes.forEach(walk);
        if (tag === 'p') { push('\n\n'); }
        return;
      }
      n.childNodes.forEach(walk);
    };
    walk(root);
    let text = out.join('')
      .replace(/\r/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\s+|\s+$/g, '');
    // 代码块左上角会渲染一个语言标签（如 "python"），可能先被当正文收进来；
    // 若首行是短标签、且紧接着一个同语言的围栏，则把标签行去掉。
    const lines = text.split('\n');
    if (lines.length > 2 && lines[1] === '' && lines[0].length <= 16 &&
        lines[2].indexOf(FENCE + lines[0]) === 0) {
      lines.splice(0, 2);
      text = lines.join('\n');
    }
    return text;
  };
  return true;
})()
`;

/**
 * 展开「已处理 N 秒」折叠区。
 * 豆包把每步的 `已执行代码 …` 与输出放在这个折叠体里，**折叠时 DOM 里根本没有内容**，
 * 必须点开才能读到（实测 textContent 也只有 20 个字符）。
 */
export function expandStepsJs(): string {
  return `(() => {
    const now = Date.now();
    if (window.__dbExpandAt && now - window.__dbExpandAt < 2000) {
      return 0;
    }
    window.__dbExpandAt = now;
    let clicked = 0;
    for (const sec of document.querySelectorAll('[data-testid="preamble-elapsed"]')) {
      const btn = sec.querySelector('button[aria-expanded="false"]') || sec.querySelector('button');
      if (!btn || btn.disabled) continue;
      const collapsed = sec.getAttribute('data-message-content-collapsed') === 'true' || btn.getAttribute('aria-expanded') === 'false';
      if (!collapsed) continue;
      btn.click();
      clicked += 1;
    }
    return clicked;
  })()`;
}

/**
 * 读取「最后一条助手回复」的结构化快照。
 *
 * 关键改动（0.32.0）：不再按 innerText 的行首关键字去猜分块。
 * 豆包每条回复本身就是按 `data-plugin-identifier` 排好序的块：
 *   10091 = 同步状态（已处理 / 共用时 计时）  10040 = 一步执行反馈  10000 = 正文
 * 直接按 DOM 顺序取块，块序、文案、状态和豆包界面同源，才能「对拍」得上。
 */
export function readLastReplyJs(receiveSelector: string, textSelector: string, index = -1): string {
  return String.raw`(() => {
  const EMPTY = {
    count: 0, text: '', streaming: false, images: [], generating: '', confirming: false,
    busy: false, progress: '', progressSeconds: -1, executing: false, done: false, blocks: [],
  };
  const list = [...document.querySelectorAll(${JSON.stringify(receiveSelector)})];
  if (!list.length) { return EMPTY; }
  // index 默认 -1 = 最后一条；负数从末尾数，方便对拍/回放历史消息。
  const at = ${index};
  const last = list[at < 0 ? list.length + at : at];
  if (!last) { return EMPTY; }
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  // ---- 同步状态：已处理 5 分 52 秒 / 共用时 4 分 55 秒 ----
  const timerEl = last.querySelector('[data-testid="preamble-elapsed-timer"]');
  const timerText = timerEl ? norm(timerEl.textContent) : '';
  const hours = /(\d+)\s*(?:小时|时)/.exec(timerText);
  const minutes = /(\d+)\s*分/.exec(timerText);
  const seconds = /(\d+)\s*秒/.exec(timerText);
  const progressSeconds = (!hours && !minutes && !seconds)
    ? -1
    : (hours ? Number(hours[1]) * 3600 : 0) + (minutes ? Number(minutes[1]) * 60 : 0) + (seconds ? Number(seconds[1]) : 0);
  const done = /^共用时/.test(timerText);

  // ---- 按 DOM 顺序取块：timer → step → 正文 → step → … ----
  const content = last.querySelector('[data-testid="message_content"]') || last;
  const blocks = [];
  const seenStatus = new Set();
  let streaming = false;
  const textParts = [];
  for (const node of content.querySelectorAll('[data-plugin-identifier]')) {
    const pid = node.getAttribute('data-plugin-identifier') || '';
    const type = (/block_type:(\d+)/.exec(pid) || [])[1];
    if (!type) { continue; }
    if (type === '10091') {
      if (timerText && !seenStatus.has(timerText)) {
        seenStatus.add(timerText);
        blocks.push({ kind: 'status', text: timerText });
      }
      continue;
    }
    if (type === '10040') {
      // 一个 10040 块里可能装着**一整段执行过程**（几十个 21px 的步骤行），
      // 不能拿块级 innerText 当一个标题，否则会变成一长串拼接、后面的步骤全丢。
      // 正确做法：逐行取 [data-thinking-box=step-message] 的可见标题。
      const rows = [...node.querySelectorAll('[data-thinking-box="step-message"]')].filter((row) => {
        const q = row.getBoundingClientRect();
        return q.width > 0 && q.height > 0;
      });
      const items = rows.length ? rows : [node];
      let lastKey = '';
      for (const row of items) {
        const titleEl = row.querySelector('div.truncate') || row.querySelector('[data-thinking-box="title"]');
        const title = norm(titleEl ? titleEl.textContent : row.innerText);
        if (!title) { continue; }
        const running = /^正在/.test(title);
        // 命令行的标题里常带「错误 / 失败」字样（比如日志里的 error），不能据此判失败。
        const isCommand = /^(已执行代码|正在执行代码|已执行|正在执行)/.test(title);
        const failed = !isCommand && title.length <= 40 && /超时|失败|出错|错误/.test(title);
        const state = running ? 'running' : failed ? 'error' : 'done';
        const key = state + '|' + title;
        if (key === lastKey) { continue; }
        lastKey = key;
        const detailEl = row.querySelector('[data-thinking-box="step-end-expanded"]');
        const detail = detailEl ? String(detailEl.innerText || '').trim() : '';
        // 豆包每类动作有自己的小图标（shellexec=终端/fileview=文件…），按 href 归类。
        const iconImg = row.querySelector('[data-thinking-icon-image] image');
        const iconHref = iconImg ? String(iconImg.getAttribute('href') || iconImg.getAttribute('src') || '') : '';
        const icon = /shellexec|shellview/i.test(iconHref) ? 'code' : /fileview/i.test(iconHref) ? 'read' : '';
        const block = { kind: 'step', text: title, state: state };
        // 生成类步骤（如「已完成图片生成」）会把图片缩略图挂在这一行里
        const imgs = [...row.querySelectorAll('img')]
          .filter((img) => {
            if (img.closest('[data-thinking-icon-image]')) { return false; }
            const src = img.currentSrc || img.src || '';
            return /^(https?:|data:|file:)/.test(src) && (img.naturalWidth || 0) > 40;
          })
          .map((img) => img.currentSrc || img.src || '')
          .filter(Boolean);
        if (imgs.length) { block.images = imgs.slice(0, 8); }
        if (icon) { block.icon = icon; }
        if (detail && detail !== title) { block.detail = detail; }
        blocks.push(block);
      }
      continue;
    }
    if (type === '10000') {
      const mdNode = node.querySelector('[data-testid="message_text_content"]');
      if (!mdNode) { continue; }
      if (mdNode.dataset && mdNode.dataset.streaming === 'true') { streaming = true; }
      const md = window.__dcMd ? window.__dcMd(mdNode) : (mdNode.innerText || '');
      const body = String(md || '').trim();
      if (!body) { continue; }
      blocks.push({ kind: 'text', text: body });
      textParts.push(body);
      continue;
    }
  }
  // ---- 子智能体 / 子线程（complex-task）：豆包委派后独立更新状态 ----
  const subagents = [...last.querySelectorAll('.complex-task-block-wrapper')]
    .map((el) => {
      const lines = String(el.innerText || '').split('\n').map((line) => line.trim()).filter(Boolean);
      return { name: lines[0] || '', status: lines.slice(1).join(' ') || '' };
    })
    .filter((item) => item.name);
  if (/已委派子智能体执行/.test((last.innerText || ''))) {
    blocks.push({ kind: 'step', text: '已委派子智能体执行', detail: timerText || '', state: done ? 'done' : 'running', icon: 'agent' });
  }
  for (const sub of subagents) {
    blocks.push({
      kind: 'step',
      text: sub.name,
      detail: sub.status,
      state: /完成|结束/.test(sub.status) ? 'done' : 'running',
      icon: 'agent',
    });
  }
  // 正文兜底：结构变更时至少别把文字丢了
  const text = textParts.join('\n\n');

  // ---- 图片（生图/附件预览） ----
  const images = [];
  const seen = new Set();
  const addImage = (url, full, alt) => {
    if (!url || !/^https?:\/\//.test(url) || seen.has(url)) { return; }
    seen.add(url);
    images.push({ url: url, fullUrl: full || '', alt: alt || '' });
  };
  const boxes = [...last.querySelectorAll('[data-testid=message_image_content]')];
  for (const box of boxes) {
    const imgs = [...box.querySelectorAll('img')];
    const srcs = imgs.map((img) => img.currentSrc || img.src || '');
    const thumb = srcs.find((src) => src.includes('cthumb')) || srcs.find((src) => /^https?:/.test(src) && !src.includes('cgen_lwm3'));
    const full = srcs.find((src) => src.includes('cgen_lwm3')) || '';
    const alt = imgs.map((img) => img.alt).find(Boolean) || '';
    addImage(thumb || full, full, alt);
  }

  const raw = ((last.innerText || '') + ' ' + (timerText || ''));
  let generating = '';
  if (/正在生成(图片|图像)|图片生成中|正在绘制/.test(raw)) { generating = '正在生成图片…'; }
  else if (/正在生成视频|视频生成中/.test(raw)) { generating = '正在生成视频…'; }
  else if (/PPT.*生成中|正在生成\s*PPT/i.test(raw)) { generating = '正在生成 PPT…'; }
  if (images.length === 0) {
    for (const img of last.querySelectorAll('img')) {
      const src = img.currentSrc || img.src || '';
      if (!/^https?:/.test(src)) { continue; }
      const width = img.naturalWidth || img.width || 0;
      if (width > 80) { addImage(src, '', img.alt || ''); }
    }
  }
  const confirming = /确认生成任务|确认生成/.test(raw);
  const busy = [...document.querySelectorAll('button,[role="button"]')].some((el) => {
    const sig = ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.getAttribute('data-testid') || '') + ' ' + (el.className || '') + ' ' + ((el.innerText || '').slice(0, 20)));
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && /停止|stop/i.test(sig);
  });
  let question = null;
  {
    const radios = [...document.querySelectorAll('input[type="radio"][value^="option_"]')].filter((r) => {
      const sec = r.closest('section');
      const rect = r.getBoundingClientRect();
      return Boolean(sec) && rect.width > 0 && rect.height > 0;
    });
    if (radios.length) {
      const sec = radios[0].closest('section');
      const head = sec.querySelector('h2,h3');
      const options = radios
        .map((r) => {
          const label = r.closest('label');
          const text = String((label ? label.innerText : '') || '').replace(/\s+/g, ' ').trim();
          return { value: r.value, label: text };
        })
        .filter((o) => o.value && o.label);
      question = {
        title: head ? String(head.innerText || '').replace(/\s+/g, ' ').trim() : '请选择',
        options: options,
        allowCustom: Boolean(sec.querySelector('textarea')),
      };
    }
  }
  const stepRunning = blocks.some((b) => b.kind === 'step' && b.state === 'running');
  const executing = /正在执行(代码|命令)/.test(raw) || stepRunning;
  return {
    count: list.length,
    text: text,
    streaming: streaming,
    images: images.slice(0, 6),
    generating: generating,
    confirming: confirming,
    busy: busy,
    progress: timerText,
    progressSeconds: progressSeconds,
    executing: executing,
    done: done,
    blocks: blocks,
    question: question,
  };
})()`;
}
