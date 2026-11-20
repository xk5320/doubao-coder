// 豆包编程助手 Webview 前端：原生 JS，无框架、无打包。
// 与扩展侧 src/chat/panel.ts 的消息协议：user / assistant_delta / assistant_done /
// tool_start / tool_end / image / error / state（另有 clear 用于清空界面）。
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const messagesEl = document.getElementById('messages');
// 任务标签栏（类似编辑器标签页）
let tabBarEl = null;
let syncBarEl = null;
function ensureSyncBar() {
  if (syncBarEl || !messagesEl || !messagesEl.parentElement) {
    return syncBarEl;
  }
  syncBarEl = el('div', 'sync-loading');
  syncBarEl.id = 'sync-loading';
  syncBarEl.appendChild(el('span', 'sync-spinner'));
  syncBarEl.appendChild(el('span', 'sync-loading-text'));
  messagesEl.parentElement.insertBefore(syncBarEl, messagesEl);
  return syncBarEl;
}
function renderVerify(message) {
  const card = el('div', 'verify-card' + (message.ok ? ' ok' : ' fail'));
  const label = message.kind === 'test' ? '测试' : '构建';
  card.appendChild(el('div', 'verify-title', label + (message.ok ? ' 已通过' : ' 失败') + (message.command ? ' · ' + message.command : '')));
  if (message.error) {
    card.appendChild(el('div', 'verify-error', String(message.error)));
  }
  if (message.output) {
    const pre = el('pre', 'verify-output');
    pre.textContent = String(message.output);
    card.appendChild(pre);
  }
  const locations = Array.isArray(message.locations) ? message.locations : [];
  if (locations.length > 0) {
    const locBox = el('div', 'verify-locations');
    for (const loc of locations) {
      const btn = el('button', 'btn verify-location', String(loc.path) + ':' + loc.line);
      btn.type = 'button';
      btn.title = '打开 ' + loc.path + ':' + loc.line;
      btn.addEventListener('click', function () {
        vscode.postMessage({ type: 'openFile', path: loc.path, line: loc.line });
      });
      locBox.appendChild(btn);
    }
    card.appendChild(locBox);
  }
  const actions = el('div', 'verify-actions');
  const ask = el('button', 'btn verify-ask', '问豆包修这个');
  ask.type = 'button';
  ask.addEventListener('click', function () {
    vscode.postMessage({ type: 'verifyAsk' });
  });
  actions.appendChild(ask);
  card.appendChild(actions);
  messagesEl.appendChild(card);
  scrollToBottom();
}

let taskStripEl = null;
function renderTasks(tasks) {
  if (!taskStripEl) {
    taskStripEl = el('div', 'task-strip');
    taskStripEl.id = 'task-strip';
    if (messagesEl && messagesEl.parentElement) {
      messagesEl.parentElement.insertBefore(taskStripEl, messagesEl);
    }
  }
  const list = Array.isArray(tasks) ? tasks : [];
  taskStripEl.innerHTML = '';
  taskStripEl.classList.toggle('hidden', list.length === 0);
  for (const task of list) {
    const running = task.status === 'running';
    const row = el('div', 'task-row ' + (running ? 'running' : 'done'));
    row.appendChild(el('span', 'task-dot'));
    row.appendChild(el('span', 'task-title', task.title || '任务'));
    row.appendChild(el('span', 'task-status', running ? (task.progress || '执行中') : (task.status === 'failed' ? '失败' : '已完成')));
    taskStripEl.appendChild(row);
  }
}

let sourcesCardEl = null;
function renderSources(items) {
  if (sourcesCardEl) {
    sourcesCardEl.remove();
    sourcesCardEl = null;
  }
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    return;
  }
  sourcesCardEl = el('div', 'sources-card');
  sourcesCardEl.appendChild(el('div', 'sources-title', '引用来源（' + list.length + '）'));
  for (const item of list) {
    const btn = el('button', 'btn sources-item', String(item.path) + ':' + item.line);
    btn.type = 'button';
    btn.title = '打开 ' + item.path + ':' + item.line;
    btn.addEventListener('click', function () {
      vscode.postMessage({ type: 'openFile', path: item.path, line: item.line });
    });
    sourcesCardEl.appendChild(btn);
  }
  messagesEl.appendChild(sourcesCardEl);
  scrollToBottom();
}

function renderProposal(message) {
  const card = el('div', 'proposal-card');
  const title = el('div', 'proposal-title', '待审阅改动 · ' + String(message.path || '').split(/[\\/]/).pop());
  title.title = message.path || '';
  card.appendChild(title);
  card.appendChild(el('div', 'proposal-meta', '旧 ' + String(message.before || '').length + ' 字 → 新 ' + String(message.after || '').length + ' 字'));

  const hunks = Array.isArray(message.hunks) ? message.hunks : [];
  const selected = new Set();
  hunks.forEach(function (_, index) { selected.add(index); });
  const rows = [];
  if (hunks.length > 0) {
    const list = el('div', 'proposal-hunks');
    hunks.forEach(function (hunk, index) {
      const row = el('div', 'proposal-hunk selected');
      row.setAttribute('data-hunk', String(index));
      row.appendChild(el('span', 'proposal-hunk-check', '✓'));
      row.appendChild(el('span', 'proposal-hunk-title', '@@ 行 ' + (Number(hunk.oldStart) + 1) + '（+' + (hunk.newLines || []).length + ' / -' + (hunk.oldLines || []).length + '）'));
      const previewText = ((hunk.newLines || []).length ? hunk.newLines : (hunk.oldLines || [])).slice(0, 2).join(' / ').slice(0, 90);
      row.appendChild(el('div', 'proposal-hunk-preview', previewText));
      row.addEventListener('click', function () {
        if (card.classList.contains('decided')) {
          return;
        }
        if (selected.has(index)) {
          selected.delete(index);
          row.classList.remove('selected');
        } else {
          selected.add(index);
          row.classList.add('selected');
        }
      });
      list.appendChild(row);
      rows.push(row);
    });
    card.appendChild(list);
  }

  const actions = el('div', 'proposal-actions');
  function finish(text) {
    card.classList.add('decided');
    rows.forEach(function (row) { row.classList.add('disabled'); });
    actions.textContent = text;
  }
  const acceptSelected = el('button', 'btn btn-primary proposal-accept-selected', '接受选中');
  acceptSelected.type = 'button';
  acceptSelected.addEventListener('click', function () {
    const picked = Array.from(selected).sort(function (a, b) { return a - b; });
    if (hunks.length > 0 && picked.length === 0) {
      return;
    }
    vscode.postMessage({ type: 'proposalAction', id: message.id, action: 'accept', hunks: picked });
    finish('已接受 ' + picked.length + ' 块');
  });
  const acceptAll = el('button', 'btn proposal-accept', '全部接受');
  acceptAll.type = 'button';
  acceptAll.addEventListener('click', function () {
    vscode.postMessage({ type: 'proposalAction', id: message.id, action: 'accept' });
    finish('已接受全部改动');
  });
  const reject = el('button', 'btn proposal-reject', '拒绝');
  reject.type = 'button';
  reject.addEventListener('click', function () {
    vscode.postMessage({ type: 'proposalAction', id: message.id, action: 'reject' });
    finish('已拒绝');
  });
  const diff = el('button', 'btn proposal-diff', '查看差异');
  diff.type = 'button';
  diff.addEventListener('click', function () {
    vscode.postMessage({ type: 'proposalAction', id: message.id, action: 'diff' });
  });
  actions.appendChild(diff);
  actions.appendChild(acceptSelected);
  actions.appendChild(acceptAll);
  actions.appendChild(reject);
  card.appendChild(actions);
  messagesEl.appendChild(card);
  scrollToBottom();
}

function renderSyncLoading(message) {
  const bar = ensureSyncBar();
  if (!bar) {
    return;
  }
  bar.classList.toggle('hidden', !message.on);
  if (message.on) {
    const text = bar.querySelector('.sync-loading-text');
    if (text) {
      text.textContent = message.text || '正在同步…';
    }
  }
}
function ensureTabBar() {
  if (tabBarEl || !messagesEl || !messagesEl.parentElement) {
    return tabBarEl;
  }
  tabBarEl = el('div', 'tab-bar');
  tabBarEl.id = 'tab-bar';
  messagesEl.parentElement.insertBefore(tabBarEl, messagesEl);
  return tabBarEl;
}
function renderTabs(tabs) {
  const bar = ensureTabBar();
  if (!bar) {
    return;
  }
  bar.innerHTML = '';
  bar.classList.toggle('hidden', !(tabs && tabs.length));
  for (const tab of tabs || []) {
    const item = el('button', 'tab-item' + (tab.active ? ' active' : ''));
    item.type = 'button';
    item.title = tab.desktopTitle || tab.title || '';
    if (tab.running) {
      item.appendChild(el('span', 'tab-dot', ''));
    }
    item.appendChild(el('span', 'tab-label', tab.title || '未命名任务'));
    const close = el('span', 'tab-close', '×');
    close.addEventListener('click', function (event) {
      event.stopPropagation();
      vscode.postMessage({ type: 'closeTab', id: tab.id });
    });
    item.appendChild(close);
    item.addEventListener('click', function () {
      if (!tab.active) {
        vscode.postMessage({ type: 'activateTab', id: tab.id });
      }
    });
    bar.appendChild(item);
  }
}
  const emptyEl = document.getElementById('empty');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('btn-send');
  const stopBtn = document.getElementById('btn-stop');
  const newBtn = document.getElementById('btn-new');
  const historyBtn = document.getElementById('btn-history');
  const taskBtn = document.getElementById('btn-task');
  const logsBtn = document.getElementById('btn-logs');
  const settingsBtn = document.getElementById('btn-settings');
  const metaEl = document.getElementById('meta');
  const statusEl = document.getElementById('status');
const runningBarEl = document.getElementById('running-bar');
const runningTextEl = document.getElementById('running-text');
  const contextHint = document.getElementById('context-hint');
  let contextTokens = 0;
  const chipMode = document.getElementById('chip-mode');
  const quickSkillsEl = document.getElementById('quick-skills');
  const quickChatEl = document.getElementById('quick-chat');
/** 当前选中的生成能力（图像/视频/PPT），同一时间只能选一个。 */
let quickAction = '';
const QUICK_PROMPTS = { image: '生成图片：', video: '生成视频：', ppt: '生成PPT：' };
function applyQuickAction(action) {
  const previous = QUICK_PROMPTS[quickAction] || '';
  const next = QUICK_PROMPTS[action] || '';
  if (quickAction === action) {
    quickAction = '';
    if (previous && inputEl.value === previous) {
      inputEl.value = '';
    }
  } else {
    quickAction = action || '';
    if (previous && inputEl.value === previous) {
      inputEl.value = '';
    }
    if (next && !inputEl.value) {
      inputEl.value = next;
    }
  }
  Array.from(document.querySelectorAll('.mention-action')).forEach(function (mentionBtn) {
    mentionBtn.addEventListener('click', function () {
      requestWorkspaceFiles();
    });
  });
  const quickVerifyEl = document.getElementById('quick-verify');
  if (quickVerifyEl) {
    Array.from(quickVerifyEl.querySelectorAll('[data-verify]')).forEach(function (button) {
      button.addEventListener('click', function () {
        vscode.postMessage({ type: 'verify', value: button.getAttribute('data-verify') || 'build' });
      });
    });
  }
  if (quickChatEl) {
    Array.from(quickChatEl.querySelectorAll('[data-chat-action]')).forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-chat-action') === quickAction);
    });
  }
  inputEl.focus();
  inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
  inputEl.style.height = '';
}
  const chipProject = document.getElementById('chip-project');
  const chipPermission = document.getElementById('chip-permission');
  const chipSkills = document.getElementById('chip-skills');
  const chipPlugins = document.getElementById('chip-plugins'); // 已移除，保持 null 安全
  const chipModel = document.getElementById('chip-model');
  const plusBtn = document.getElementById('btn-plus');
  const historyOverlay = document.getElementById('history-overlay');
  const historyListEl = document.getElementById('history-list');
  const historySearchEl = document.getElementById('history-search');
  const historyBatchBar = document.getElementById('history-batchbar');
  const historySelectedCount = document.getElementById('history-selected-count');

  const refs = { currentFile: true, selection: true, diagnostics: false };
  let currentMode = 'local';
  let currentPermission = 'risk';
  let currentDesktopMode = '';
  let currentProject = '';
  let currentPlugins = 0;
  let currentSkills = false;
  let currentSkillsCount = 0;
  let currentPluginsCount = 0;
  let catalog = { skills: [], plugins: [] };
  let slashPending = false;
  let historyOpen = false;
  let historyTab = 'local';
  let historyBatch = false;
  let historyQuery = '';
  let historySelected = new Set();
  let historyData = { local: [], desktop: { ok: false, items: [] } };
/** 历史面板：豆包列表是否正在加载（打开/重试时显示进度）。 */
let historyLoading = false;
let historyLoadedOnce = false;
/** 历史加载文案（带已同步条数）。 */
let historyLoadingText = '';
  let currentModel = '';
  let currentReasoning = '';
  let popup = null;
  /** 豆包原生分块容器（可选：没有原生分块时为 null）。 */
  let nativeBlocksWrap = null;
  /** 执行中的等待提示行（转圈 + 文案 + 计时），对标 Claude Code / 豆包。 */
  let pendingRow = null;
  let pendingLabel = null;
  let pendingTimer = null;
  let pendingStart = 0;
  let lastElapsed = 0;

  /** @type {HTMLElement | null} 当前正在流式输出的 assistant 内容容器 */
  let streamingBody = null;
  let streamingBuffer = '';
  let pendingFrame = 0;
  let busy = false;

  const toolCards = new Map();
  /** 当前这一轮的工具调用次数与助手文本，用来生成建议。 */
  let turnTools = 0;
  /** 本轮开始时间，用于在助手气泡下显示「共用时 N 秒」。 */
  let turnStartedAt = 0;
  /** 本轮用户原话（「重新生成」要复用它）。 */
  let lastSentText = '';
  /** 回答之间的分隔线（显示耗时）。 */
  let turnDivider = null;
  let turnDividerLabel = null;
  let turnDividerTimer = null;
  /** 豆包上报的已处理秒数；>=0 时计时以它为准（本地只补两次上报之间的增量）。 */
  let turnReportedSeconds = -1;
  let turnReportedAt = 0;
  /** 本轮是否已经结束（显示「共用时」）：结束后的陈旧 busy 不能把计时重新点亮。 */
  let turnFinished = false;
  /** 回合结束后自动选「继续说」的倒计时（可在设置里关掉）。 */
  let autoContinueEnabled = true;
  let autoContinueSeconds = 5;
  let autoContinueTimer = null;
  let autoContinueTick = null;
  let autoContinueChip = null;
  let autoContinueLabel = '';
  /** 本轮累计执行过的步骤（豆包折叠时旧步骤会从 DOM 消失，这里保留一份供展开查看）。 */
  let stepHistory = [];
  /** 展开的执行过程列表是否保持打开，以及锚定的步骤 key（重渲染后仍保持）。 */
  let stepLogOpen = false;
  let stepLogAnchor = '';
  /** 步骤分组（执行过程 · N 步）是否展开。 */
  let stepsGroupOpen = false;
  /** 回合结束后，输入框提示「继续说」，回车可直接发送。 */
  let suggestContinue = false;
  /** 最近一次收到的 blocks（结束时过滤残留的“正在…”用）。 */
  let lastBlocks = [];
  let turnText = '';

  /* --------------------------- 工具函数 --------------------------- */

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function showEmpty(show) {
    if (emptyEl) {
      emptyEl.classList.toggle('hidden', !show);
    }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (typeof text === 'string') {
      node.textContent = text;
    }
    return node;
  }

  /* --------------------------- Markdown 极简渲染 --------------------------- */

  function inline(text) {
    let html = escapeHtml(text);
    // 行内代码
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    // 粗体
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // 图片（Markdown）
    html = html.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, '<img class="inline-image" src="$2" alt="$1">');
    // 链接
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
    return html;
  }

  function codeBlock(lang, code) {
    const wrap = el('div', 'code-block');
    const bar = el('div', 'code-bar');
    bar.appendChild(el('span', 'code-lang', lang || 'code'));
    const actions = el('div', 'code-actions');

    const copyBtn = el('button', 'code-btn', '复制');
    copyBtn.addEventListener('click', function () {
      copyText(code).then(function () {
        copyBtn.textContent = '已复制';
        setTimeout(function () { copyBtn.textContent = '复制'; }, 1500);
      });
    });

    const insertBtn = el('button', 'code-btn', '插入');
    insertBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'insertCode', code: code });
    });

    actions.appendChild(copyBtn);
    actions.appendChild(insertBtn);
    bar.appendChild(actions);

    const pre = el('pre');
    pre.appendChild(el('code', null, code));
    wrap.appendChild(bar);
    wrap.appendChild(pre);
    return wrap;
  }

  function markdown(text) {
    const fragment = document.createDocumentFragment();
    const parts = String(text).split(/```(\w*)\n?([\s\S]*?)```/g);
    // 拆分后：文本, lang, code, 文本, lang, code ...
    for (let i = 0; i < parts.length; i += 1) {
      if (i % 3 === 0) {
        renderTextBlock(parts[i], fragment);
      } else if (i % 3 === 1) {
        const code = parts[i + 1] || '';
        fragment.appendChild(codeBlock(parts[i], code.replace(/\n$/, '')));
      }
    }
    return fragment;
  }

  function renderTextBlock(text, fragment) {
    const trimmed = (text || '').replace(/^\n+|\n+$/g, '');
    if (!trimmed) {
      return;
    }
    const lines = trimmed.split('\n');
    let list = null;
    let paragraph = [];

    const flushParagraph = function () {
      if (paragraph.length > 0) {
        const p = el('p');
        p.innerHTML = inline(paragraph.join(' '));
        fragment.appendChild(p);
        paragraph = [];
      }
    };
    const flushList = function () {
      if (list) {
        fragment.appendChild(list);
        list = null;
      }
    };

    for (const line of lines) {
      if (/^\s*[-*+]\s+/.test(line)) {
        flushParagraph();
        if (!list) {
          list = el('ul');
        }
        const li = el('li');
        li.innerHTML = inline(line.replace(/^\s*[-*+]\s+/, ''));
        list.appendChild(li);
        continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        flushParagraph();
        if (!list || list.tagName !== 'OL') {
          flushList();
          list = el('ol');
        }
        const li = el('li');
        li.innerHTML = inline(line.replace(/^\s*\d+\.\s+/, ''));
        list.appendChild(li);
        continue;
      }
      const heading = /^(#{1,4})\s+(.*)$/.exec(line);
      if (heading) {
        flushParagraph();
        flushList();
        const h = el('h' + Math.min(4, heading[1].length + 2));
        h.innerHTML = inline(heading[2]);
        fragment.appendChild(h);
        continue;
      }
      if (/^>\s?/.test(line)) {
        flushParagraph();
        flushList();
        const quote = el('blockquote');
        quote.innerHTML = inline(line.replace(/^>\s?/, ''));
        fragment.appendChild(quote);
        continue;
      }
      if (line.trim() === '') {
        flushParagraph();
        flushList();
        continue;
      }
      paragraph.push(line.trim());
    }
    flushParagraph();
    flushList();
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () {
        return fallbackCopy(text);
      });
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
    } catch (err) {
      /* ignore */
    }
    document.body.removeChild(area);
  }

  /* --------------------------- 消息渲染 --------------------------- */

  function clockText(ts) {
    const d = new Date(ts || Date.now());
    const pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function addMessage(role, text, images, files) {
    showEmpty(false);
    const wrap = el('div', 'msg msg-' + role);
    const body = el('div', 'msg-body');
    if (role === 'user') {
      const bubble = el('div', 'msg-bubble');
      if (Array.isArray(images) && images.length) {
        const box = el('div', 'bubble-images');
        for (const src of images) {
          const pic = document.createElement('img');
          pic.src = src;
          pic.alt = '粘贴的图片';
          pic.loading = 'lazy';
          box.appendChild(pic);
        }
        bubble.appendChild(box);
      }
      if (Array.isArray(files) && files.length) {
        const box = el('div', 'bubble-files');
        for (const name of files) {
          const chip = el('span', 'bubble-file');
          chip.appendChild(el('span', 'bubble-file-icon', '📎'));
          chip.appendChild(el('span', 'bubble-file-name', String(name)));
          box.appendChild(chip);
        }
        bubble.appendChild(box);
      }
      bubble.appendChild(el('div', 'plain', text));
      const foot = el('div', 'msg-foot');
      foot.appendChild(el('span', 'msg-time', clockText()));
      bubble.appendChild(foot);
      body.appendChild(bubble);
    } else {
      body.appendChild(markdown(text));
    }
    wrap.appendChild(body);
    messagesEl.appendChild(wrap);
    scrollToBottom();
    return body;
  }

  /** 两个回答之间的分隔线：生成中显示计时，结束后显示「共用时」。 */


  /* ================= 历史加载中的动效 ================= */

  let historyLoadingRow = null;
  let historyLoadingTimer = null;

  function showHistoryLoading(text) {
    hideHistoryLoading();
    const row = el('div', 'history-loading');
    row.appendChild(el('span', 'history-spinner'));
    row.appendChild(el('span', 'history-loading-text', text || '正在加载…'));
    messagesEl.appendChild(row);
    historyLoadingRow = row;
    scrollToBottom();
    // 30 秒兜底：避免异常情况下一直转
    historyLoadingTimer = window.setTimeout(function () {
      hideHistoryLoading();
    }, 30000);
  }

  function hideHistoryLoading() {
    if (historyLoadingTimer) {
      window.clearTimeout(historyLoadingTimer);
      historyLoadingTimer = null;
    }
    if (historyLoadingRow) {
      historyLoadingRow.remove();
      historyLoadingRow = null;
    }
  }

  /* ================= 处理中指示：只要 busy 就一直在动 ================= */

  /** busy=true 保证有「已处理 N 秒 •••」；busy=false 收掉省略号。 */
  function syncBusyIndicator(isBusy) {
    if (isBusy) {
      if (turnFinished) {
        return;
      }
      // 还没有任何内容（连接/切换会话中）：不要凭空造一条「已处理 0 秒」分隔线，
      // 等真有消息/分块了再由 startAssistant / renderAst 接手。
      const hasContent = Boolean(streamingBody) || Boolean(messagesEl.querySelector('.msg, .ast-blocks'));
      if (!hasContent && !turnDivider) {
        return;
      }
      if (!turnDivider || !turnDivider.isConnected) {
        ensureTurnDivider(turnContentAnchor());
      }
      if (!turnDivider.querySelector('.turn-dots')) {
        const dots = el('span', 'turn-dots');
        dots.appendChild(el('i', 'dot'));
        dots.appendChild(el('i', 'dot'));
        dots.appendChild(el('i', 'dot'));
        turnDivider.insertBefore(dots, turnDivider.querySelector('.turn-rule'));
      }
      if (!turnDividerTimer) {
        turnDividerTimer = setInterval(tickTurnDivider, 500);
        tickTurnDivider();
      }
      return;
    }
    if (turnDividerTimer) {
      clearInterval(turnDividerTimer);
      turnDividerTimer = null;
    }
    if (turnDivider) {
      const dots = turnDivider.querySelector('.turn-dots');
      if (dots) {
        dots.remove();
      }
    }
  }

  /** 本轮内容锚点：只认本轮自己的分块容器（send 时已置空），否则会把分隔线插到上一轮回答上方。 */
  function turnContentAnchor() {
    if (nativeBlocksWrap && nativeBlocksWrap.isConnected) {
      return nativeBlocksWrap;
    }
    return null;
  }

  /** 新建一条分隔线；给了 beforeNode 就插在它前面（顶部），否则追加到末尾。 */
  function ensureTurnDivider(beforeNode) {
    if (turnDivider && turnDivider.isConnected) {
      return turnDivider;
    }
    const row = el('div', 'turn-divider');
    row.appendChild(el('span', 'turn-rule'));
    const label = el('span', 'turn-label', '已处理 0 秒');
    row.appendChild(label);
    const dots = el('span', 'turn-dots');
    dots.appendChild(el('i', 'dot'));
    dots.appendChild(el('i', 'dot'));
    dots.appendChild(el('i', 'dot'));
    row.appendChild(dots);
    row.appendChild(el('span', 'turn-rule'));
    row.title = '点击折叠 / 展开本轮执行过程';
    row.style.cursor = 'pointer';
    row.addEventListener('click', function () {
      stepsGroupOpen = !stepsGroupOpen;
      applyStepsGroupOpen();
    });
    if (beforeNode && beforeNode.parentNode === messagesEl) {
      messagesEl.insertBefore(row, beforeNode);
    } else {
      messagesEl.appendChild(row);
    }
    turnDivider = row;
    turnDividerLabel = label;
    return row;
  }




  /** 与豆包一致的时长写法：52 秒 / 5 分 52 秒 / 1 小时 2 分 3 秒。 */
  function humanElapsed(secs) {
    const total = Math.max(0, Math.round(Number(secs) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) {
      return h + ' 小时 ' + m + ' 分 ' + s + ' 秒';
    }
    if (m > 0) {
      return m + ' 分 ' + s + ' 秒';
    }
    return s + ' 秒';
  }

  /** 当前已处理秒数：没有起点就是 0；异常值（负数/非有限/超过 24h）一律按 0，避免把时间戳当秒数显示。 */
  function elapsedSecondsNow() {
    const hasReport = turnReportedSeconds >= 0 && turnReportedAt > 0;
    let secs;
    if (hasReport) {
      secs = turnReportedSeconds + (Date.now() - turnReportedAt) / 1000;
    } else if (turnStartedAt > 0) {
      secs = (Date.now() - turnStartedAt) / 1000;
    } else {
      secs = 0;
    }
    // 上限 7 天：超过它基本可以确定是把时间戳/毫秒当秒用了（真实任务不会跑这么久）。
    if (!isFinite(secs) || secs < 0 || secs > 7 * 86400) {
      return 0;
    }
    return Math.max(0, Math.round(secs));
  }

  function tickTurnDivider() {
    if (!turnDividerLabel || turnFinished) {
      return;
    }
    // 有豆包上报的秒数就以它为准，本地只补上报间隔内的增量，避免两边秒数对不上。
    turnDividerLabel.textContent = '已处理 ' + humanElapsed(elapsedSecondsNow());
  }

  /** 新一轮开始：旧分隔线留在原地显示「共用时」，本轮重新建一条（豆包每条回答顶部一条）。 */
  function beginTurnDivider() {
    stepHistory = [];
    lastBlocks = [];
    stepLogOpen = false;
    stepLogAnchor = '';
    stepsGroupOpen = false;
    if (turnDividerTimer) {
      clearInterval(turnDividerTimer);
      turnDividerTimer = null;
    }
    turnDivider = null;
    turnDividerLabel = null;
    turnFinished = false;
  }

  function startAssistant() {
    // 同一用户轮里的后续输出（PTC 多轮 / 工具调用后继续）会再次开始输出：
    // 这一轮又活了，恢复计时（否则上一段结束时的「共用时」会卡住不更新）。
    turnFinished = false;
    if (!turnStartedAt) {
      turnStartedAt = Date.now();
      turnReportedSeconds = -1;
      turnReportedAt = 0;
    }
    // 同一轮里多次 startAssistant（工具调用后继续输出）复用同一条分隔线
    if (!turnDivider || !turnDivider.isConnected) {
      ensureTurnDivider();
      if (turnDividerTimer) {
        clearInterval(turnDividerTimer);
      }
      turnDividerTimer = setInterval(tickTurnDivider, 500);
      tickTurnDivider();
    } else if (!turnDividerTimer) {
      // 上一段输出结束时停过表；同一轮继续输出要把表重新走起来。
      turnDividerTimer = setInterval(tickTurnDivider, 500);
      tickTurnDivider();
    }
    streamingBody = addMessage('assistant', '');
    streamingBody.classList.add('streaming');
    streamingBuffer = '';
    return streamingBody;
  }

  function renderStreaming() {
    pendingFrame = 0;
    if (!streamingBody) {
      return;
    }
    streamingBody.innerHTML = '';
    streamingBody.appendChild(renderMarkdownWithTables(streamingBuffer));

    scrollToBottom();
  }

  function scheduleStreamingRender() {
    if (pendingFrame) {
      return;
    }
    pendingFrame = requestAnimationFrame(renderStreaming);
  }

  function finishAssistant(final) {
    if (!streamingBody) {
      return;
    }
    streamingBody.classList.remove('streaming');
    if (!streamingBuffer.trim()) {
      // 只有工具调用的轮次：不要把空气泡渲染成「（没有返回内容）」。
      const wrap = streamingBody.closest('.msg');
      if (wrap) {
        wrap.remove();
      }
      streamingBody = null;
      streamingBuffer = '';
      return;
    }
    streamingBody.innerHTML = '';
    streamingBody.appendChild(renderMarkdownWithTables(streamingBuffer));
    // 与豆包一致：分隔线显示「共用时 N 秒」，回答底部挂操作条
    if (turnStartedAt || turnReportedSeconds >= 0) {
      const secs = elapsedSecondsNow();
      if (turnDividerTimer) {
        clearInterval(turnDividerTimer);
        turnDividerTimer = null;
      }
      if (turnDividerLabel) {
        // 豆包在回复结束后会把「已处理」换成「共用时」
        turnFinished = true;
        turnDividerLabel.textContent = '共用时 ' + humanElapsed(Math.max(1, secs));
      }
      if (turnDivider && !busy) {
        const dots = turnDivider.querySelector('.turn-dots');
        if (dots) {
          dots.remove();
        }
      }
      const wrap = streamingBody.closest('.msg');
      if (wrap && final && !wrap.querySelector('.msg-foot-assistant')) {
        const foot = el('div', 'msg-foot msg-foot-assistant');
        foot.appendChild(el('span', 'msg-time', clockText()));
        wrap.appendChild(foot);
        addAssistantActions(wrap, streamingBuffer);
      }
      turnStartedAt = 0;
    }
    streamingBody = null;
    streamingBuffer = '';
    scrollToBottom();
  }

  function toolSummary(name, args) {
    if (!args || typeof args !== 'object') {
      return '';
    }
    if (typeof args.path === 'string') {
      return args.path;
    }
    if (typeof args.command === 'string') {
      return args.command;
    }
    if (typeof args.pattern === 'string') {
      return '/' + args.pattern + '/';
    }
    return '';
  }

  const toolLabels = {
    read_file: '读取文件',
    list_dir: '列出目录',
    grep: '搜索代码',
    write_file: '写入文件',
    apply_patch: '修改代码',
    run_terminal: '执行命令',
    run_checks: '工程自检',
    get_diagnostics: '读取诊断',
  };

  function toolLabel(name) {
    if (toolLabels[name]) {
      return toolLabels[name];
    }
    if (typeof name === 'string' && name.indexOf('mcp__') === 0) {
      return '插件 · ' + name.slice(5).split('__').join(' / ');
    }
    return name;
  }

  function toolStart(id, name, args) {
    // 先把当前正在流式输出的气泡收尾，保证卡片按时间顺序出现。
    finishAssistant();
    showEmpty(false);
    turnTools += 1;
    showPending('正在执行 ' + toolLabel(name));

    const isShell = name === 'run_terminal';
    const card = el('div', 'tool-line running');
    const head = el('div', 'tool-line-head');

    head.appendChild(el('span', 'tool-line-chip', isShell ? '</>' : 'tool'));

    const label = el('span', 'tool-line-text');
    if (isShell && args && typeof args.command === 'string') {
      label.textContent = '正在执行代码 ' + args.command;
      card.setAttribute('data-cmd', args.command);
    } else {
      label.textContent = toolLabel(name) + ' ' + toolSummary(name, args);
    }
    head.appendChild(label);

    const state = el('span', 'tool-line-state', '●');
    head.appendChild(state);

    card.appendChild(head);

    const detail = el('div', 'tool-line-detail hidden');
    const argsPre = el('pre', 'tool-detail');
    argsPre.textContent = JSON.stringify({ name: name, arguments: args || {} }, null, 2);
    detail.appendChild(argsPre);
    card.appendChild(detail);

    head.addEventListener('click', function () {
      detail.classList.toggle('hidden');
      card.classList.toggle('expanded');
    });

    messagesEl.appendChild(card);
    toolCards.set(id, { card: card, detail: detail, state: state, argsPre: argsPre });
    scrollToBottom();
  }

  function toolEnd(id, name, ok, content) {
    const entry = toolCards.get(id);
    if (!entry) {
      return;
    }
    entry.card.classList.remove('running');
    entry.card.classList.add(ok ? 'ok' : 'failed');
    entry.state.textContent = ok ? '✓' : '✗';
    const cmd = entry.card.getAttribute('data-cmd');
    if (cmd) {
      const label = entry.card.querySelector('.tool-line-text');
      if (label) {
        label.textContent = '已执行代码 ' + cmd;
      }
    }
    entry.state.title = ok ? '已执行' : '执行失败';

    const text = String(content || '');
    const lines = text.split('\n').filter(function (line) { return line.trim().length > 0; });
    const hint = el('span', 'tool-line-hint', ok ? lines.length + ' 行输出' : '失败');
    entry.state.parentElement.insertBefore(hint, entry.state);

    const resultPre = el('pre', 'tool-result');
    resultPre.textContent = text.length > 4000 ? text.slice(0, 4000) + '\n…（已截断显示）' : text;
    entry.detail.appendChild(resultPre);
    showPending('继续处理');
    scrollToBottom();
  }

  function addAssistantActions(wrap, plainText) {
    if (!wrap || !plainText) {
      return;
    }
    const row = el('div', 'msg-actions');
    const copyBtn = el('button', 'msg-action', '复制');
    copyBtn.addEventListener('click', function () {
      copyText(plainText);
      copyBtn.textContent = '已复制';
      setTimeout(function () { copyBtn.textContent = '复制'; }, 1200);
    });
    const retryBtn = el('button', 'msg-action', '重新生成');
    retryBtn.addEventListener('click', function () {
      if (busy) {
        statusEl.textContent = '正在生成中，稍后再试';
        return;
      }
      vscode.postMessage({ type: 'regenerate', text: lastSentText });
    });
    const delBtn = el('button', 'msg-action', '删除');
    delBtn.title = '从界面与本地记忆中删除这一轮';
    delBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'deleteTurn', text: plainText });
      wrap.remove();
      statusEl.textContent = '已删除这一轮';
    });
    const shareBtn = el('button', 'msg-action', '分享');
    shareBtn.title = '复制这条回复的 Markdown';
    shareBtn.addEventListener('click', function () {
      copyText(plainText);
      shareBtn.textContent = '已复制';
      setTimeout(function () { shareBtn.textContent = '分享'; }, 1200);
    });
    row.appendChild(copyBtn);
    row.appendChild(shareBtn);
    row.appendChild(retryBtn);
    row.appendChild(delBtn);
    wrap.appendChild(row);
  }

  /** 从助手回复里抽 2~3 条建议；只有明确是"建议/下一步"时才用，避免和建议正文重复。 */
  function suggestFor(text, tools) {
    const body = String(text || '');
    const wantsSuggestions = /建议|下一步|接下来|你可以|可以试试/.test(body);
    const out = [];
    if (wantsSuggestions) {
      const lines = body.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
      for (let i = lines.length - 1; i >= 0 && out.length < 3; i -= 1) {
        const m = /^(?:\d+[.、)]|[-*•])\s*(.{2,40})$/.exec(lines[i]);
        if (m) {
          out.unshift(m[1].replace(/[。；;：:]+$/, ''));
        }
      }
    }
    if (out.length >= 2) {
      return out.slice(-3);
    }
    if (tools > 0) {
      return ['继续', '看看改了什么', '跑一次自检'];
    }
    return ['继续说', '给个代码例子', '解释得更简单些'];
  }

  function clearAutoContinue() {
    if (autoContinueTimer) {
      clearTimeout(autoContinueTimer);
      autoContinueTimer = null;
    }
    if (autoContinueTick) {
      clearInterval(autoContinueTick);
      autoContinueTick = null;
    }
    if (autoContinueChip && autoContinueChip.isConnected) {
      autoContinueChip.textContent = autoContinueLabel;
    }
    autoContinueChip = null;
    autoContinueLabel = '';
  }

  function autoContinueDelayMs() {
    if (!autoContinueEnabled) {
      return -1;
    }
    // 测试钩子：允许 0ms（harness 只推进 <=40ms 的定时器）
    if (typeof window.__DC_AUTO_CONTINUE_MS === 'number') {
      return window.__DC_AUTO_CONTINUE_MS;
    }
    return autoContinueSeconds > 0 ? autoContinueSeconds * 1000 : -1;
  }

  /** 回合结束后：倒计时 N 秒，自动点「继续说」。用户发消息/停止/新输出都会取消。 */
  function armAutoContinue(chip, text) {
    clearAutoContinue();
    var delay = autoContinueDelayMs();
    if (delay < 0) {
      return;
    }
    autoContinueChip = chip;
    autoContinueLabel = chip.textContent;
    var total = Math.max(1, Math.round(delay / 1000));
    var left = total;
    chip.textContent = text + ' → (' + left + 's)';
    if (delay > 0) {
      autoContinueTick = setInterval(function () {
        left -= 1;
        if (left > 0 && autoContinueChip === chip) {
          chip.textContent = text + ' → (' + left + 's)';
        }
      }, 1000);
    }
    autoContinueTimer = setTimeout(function () {
      clearAutoContinue();
      if (busy) {
        return;
      }
      inputEl.value = text;
      send();
    }, delay);
  }

  /** 追加一行建议 chip（点一下即发送）。 */
  function addSuggestions(items) {
    if (!items || !items.length) {
      return;
    }
    const row = el('div', 'suggest-row');
    var autoChip = null;
    var autoText = '';
    items.forEach(function (text) {
      const chip = el('button', 'suggest-chip', text + ' \u2192');
      chip.addEventListener('click', function () {
        clearAutoContinue();
        if (busy) {
          return;
        }
        inputEl.value = text;
        send();
      });
      if (!autoChip && String(text).indexOf('继续') >= 0) {
        autoChip = chip;
        autoText = text;
      }
      row.appendChild(chip);
    });
    messagesEl.appendChild(row);
    scrollToBottom();
    // 只对「继续说 / 继续」自动倒计时（挂在那一个 chip 上，而不是最后一个）
    if (autoChip && !busy) {
      armAutoContinue(autoChip, autoText);
    }
  }


  /* ================= 执行中的等待反馈（转圈 + 计时） ================= */

  function ensurePendingRow() {
    if (pendingRow) {
      return pendingRow;
    }
    const row = el('div', 'pending');
    const spinner = el('span', 'pending-spinner');
    const label = el('span', 'pending-label', '正在思考');
    const dots = el('span', 'pending-dots');
    dots.appendChild(el('i', 'dot'));
    dots.appendChild(el('i', 'dot'));
    dots.appendChild(el('i', 'dot'));
    const time = el('span', 'pending-time', '0.0s');
    const cancel = el('button', 'pending-cancel', '取消');
    cancel.title = '取消当前操作';
    cancel.addEventListener('click', function (ev) {
      ev.stopPropagation();
      vscode.postMessage({ type: 'cancelPending' });
      statusEl.textContent = '已取消';
      hidePending();
    });
    row.appendChild(spinner);
    row.appendChild(label);
    row.appendChild(dots);
    row.appendChild(time);
    row.appendChild(cancel);
    messagesEl.appendChild(row);
    pendingRow = row;
    pendingLabel = label;
    row.setAttribute('data-time', '0.0s');
    row.__timer = time;
    return row;
  }

  function tickPending() {
    if (!pendingRow) {
      return;
    }
    const elapsed = (Date.now() - pendingStart) / 1000;
    lastElapsed = elapsed;
    const text = elapsed < 60 ? elapsed.toFixed(1) + 's' : Math.floor(elapsed / 60) + 'm' + Math.floor(elapsed % 60) + 's';
    if (pendingRow.__timer) {
      pendingRow.__timer.textContent = text;
    }

  }


  /** 延迟显示等待行：小于 delay 的快速操作不会闪一下提示。 */
  let pendingDelayTimer = null;
  function showPendingDelayed(label, delay) {
    if (pendingRow) {
      showPending(label);
      return;
    }
    if (pendingDelayTimer) {
      clearTimeout(pendingDelayTimer);
    }
    pendingDelayTimer = setTimeout(function () {
      pendingDelayTimer = null;
      showPending(label);
    }, delay || 350);
  }

  function cancelPendingDelayed() {
    if (pendingDelayTimer) {
      clearTimeout(pendingDelayTimer);
      pendingDelayTimer = null;
    }
    hidePending();
  }


  /* ================= 工具栏溢出：放不下就收进「更多 »」 ================= */

  const overflowBtn = document.getElementById('btn-overflow');
  const toolbarLeftEl = document.querySelector('.toolbar-left');
  /** 被收进「更多」的按钮。 */
  let overflowItems = [];

  /** 模式决定"应该显示"的按钮集合，layoutToolbar 只在这些里做溢出。 */
  let toolbarWanted = null;

  function collectToolbarNodes() {
    if (!toolbarLeftEl) {
      return [];
    }
    const out = [];
    for (const node of Array.from(toolbarLeftEl.children)) {
      if (node === overflowBtn || node === plusBtn || node === chipMode) {
        continue;
      }
      if (node.classList.contains('quick-skills') || node.classList.contains('quick-chat')) {
        out.push(...Array.from(node.children));
      } else {
        out.push(node);
      }
    }
    return out;
  }

  /** 按可用宽度决定哪些按钮收进「更多 »」（显式宽度求和，确定性强）。 */
  function layoutToolbar() {
    if (!overflowBtn || !toolbarLeftEl) {
      return;
    }
    const nodes = collectToolbarNodes();
    for (const node of nodes) {
      node.hidden = toolbarWanted ? !toolbarWanted.has(node) : false;
    }
    if (plusBtn) {
      plusBtn.hidden = false;
    }
    if (chipMode) {
      chipMode.hidden = false;
    }
    overflowBtn.hidden = true;
    overflowItems = [];

    const box = document.querySelector('.composer-box');
    const right = document.querySelector('.toolbar-right');
    if (!box) {
      return;
    }
    const boxWidth = box.clientWidth || box.getBoundingClientRect().width;
    const rightWidth = right ? right.getBoundingClientRect().width : 0;
    const reserve = 82;
    let budget = boxWidth - rightWidth - reserve - 40;
    if (budget <= 0) {
      budget = boxWidth * 0.45;
    }

    const visible = nodes.filter(function (node) {
      return !node.hidden;
    });
    let sum = 0;
    for (const node of visible) {
      sum += node.getBoundingClientRect().width + 6;
    }
    while (visible.length > 0 && sum > budget) {
      const node = visible.pop();
      sum -= node.getBoundingClientRect().width + 6;
      node.hidden = true;
      overflowItems.unshift(node);
    }
    if (overflowItems.length > 0) {
      overflowBtn.hidden = false;
    }
  }

  if (overflowBtn) {
    overflowBtn.addEventListener('click', function () {
      if (overflowItems.length === 0) {
        return;
      }
      openPopup(overflowBtn, overflowItems.map(function (node) {
        return {
          label: (node.textContent || '').trim() || '…',
          onSelect: function () {
            node.hidden = false;
            node.click();
          },
        };
      }));
    });
    let resizeTimer = null;
    window.addEventListener('resize', function () {
      if (resizeTimer) {
        clearTimeout(resizeTimer);
      }
      resizeTimer = setTimeout(layoutToolbar, 120);
    });
  }

  /** 显示/更新等待提示；label 为 null 时隐藏。 */
  function showPending(label) {
    // 注意：这里只处理等待提示，**绝不创建计时分隔线**。
    // 粘贴附件、同步技能等也会调用 showPending，如果在这里建线，
    // 就会出现“还没发送就显示已处理 0 秒且不走表”的假状态。
    // 计时只从 startAssistant（真正发送后）或豆包上报的 syncStatus 开始。
    if (!label) {
      hidePending();
    }
  }

  function hidePending() {
    if (!pendingRow) {
      return;
    }
    if (pendingTimer) {
      clearInterval(pendingTimer);
      pendingTimer = null;
    }
    pendingRow.classList.remove('show');
    pendingRow.remove();
    pendingRow = null;
    pendingLabel = null;
  }

  /** 这一轮结束：把用时写进状态栏。 */
  function finishPending() {
    const elapsed = pendingRow ? (Date.now() - pendingStart) / 1000 : lastElapsed;
    hidePending();
    if (elapsed > 0.3) {
      statusEl.textContent = '完成 · 用时 ' + elapsed.toFixed(1) + 's';
    }
  }



  /* ================= 粘贴图片/文件（与 + 上传等价） ================= */

  function toBase64(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function pasteFiles(files) {
    const list = Array.from(files || []);
    if (list.length === 0) {
      return false;
    }
    Promise.all(
      list.map(function (file) {
        const fallbackExt = (file.type && file.type.split('/')[1]) || 'bin';
        const d = new Date();
        const pad = function (n) { return (n < 10 ? '0' : '') + n; };
        const stamp = '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' +
          pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
        const autoName = (file.type && file.type.indexOf('image/') === 0 ? '粘贴图片-' : '粘贴文件-') + stamp + '.' + fallbackExt;
        const name = file.name && file.name !== 'image.png' && file.name.indexOf('blob') !== 0
          ? file.name
          : autoName;
        return file.arrayBuffer().then(function (buffer) {
          return { name: name, mime: file.type || 'application/octet-stream', base64: toBase64(buffer) };
        });
      }),
    )
      .then(function (payload) {
        showPendingDelayed('正在添加附件');
        vscode.postMessage({ type: 'pasteFiles', files: payload });
      })
      .catch(function (err) {
        statusEl.textContent = '粘贴失败：' + (err && err.message ? err.message : String(err));
      });
    return true;
  }

  /** 整个面板粘贴（焦点不在输入框时）也接受文件。 */
  document.addEventListener('paste', function (event) {
    if (event.__doubaoPasteHandled) {
      return;
    }
    const data = event.clipboardData;
    if (!data) {
      return;
    }
    const files = [];
    for (const item of Array.from(data.items || [])) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      }
    }
    if (files.length === 0) {
      return;
    }
    event.__doubaoPasteHandled = true;
    event.preventDefault();
    event.stopPropagation();
    pasteFiles(files);
  });


  /* ================= 首次使用引导：安装 → 登录 → 启动 ================= */

  let setupCard = null;

  const SETUP_STEPS = [
    { key: 'install', title: '安装豆包桌面端', action: 'download', button: '去下载' },
    { key: 'launch', title: '以调试端口启动豆包', action: 'launch', button: '启动豆包' },
    { key: 'login', title: '在豆包窗口里登录你的账号', action: 'open', button: '打开豆包' },
  ];

  function stepStatus(state, key) {
    if (key === 'install') {
      return state.installed ? 'done' : 'todo';
    }
    if (key === 'launch') {
      if (!state.installed) {
        return 'todo';
      }
      return state.running ? 'done' : 'todo';
    }
    if (key === 'login') {
      if (!state.running) {
        return 'todo';
      }
      return state.loggedIn ? 'done' : 'todo';
    }
    return 'todo';
  }

  function renderSetup(state) {
    if (state && state.ready) {
      if (setupCard) {
        setupCard.remove();
        setupCard = null;
      }
      // 就绪后如果对话区是空的，把欢迎页放回来（别留一片白）
      const hasContent = messagesEl.querySelector('.msg, .tool-line, .native-blocks, .round-card, .suggest-row');
      if (!hasContent) {
        showEmpty(true);
      }
      return;
    }
    showEmpty(false);
    if (!setupCard) {
      setupCard = el('div', 'setup-card');
      messagesEl.appendChild(setupCard);
    }
    setupCard.innerHTML = '';

    const head = el('div', 'setup-head');
    head.appendChild(el('span', 'setup-title', '开始前还需要几步'));
    head.appendChild(el('span', 'setup-sub', state && state.detail ? state.detail : '检测中…'));
    setupCard.appendChild(head);

    const list = el('div', 'setup-steps');
    SETUP_STEPS.forEach(function (step, index) {
      const row = el('div', 'setup-step ' + stepStatus(state || {}, step.key));
      row.appendChild(el('span', 'setup-dot', stepStatus(state || {}, step.key) === 'done' ? '✓' : String(index + 1)));
      row.appendChild(el('span', 'setup-step-title', step.title));
      if (stepStatus(state || {}, step.key) !== 'done') {
        const btn = el('button', 'setup-action', step.button);
        btn.addEventListener('click', function () {
          showPendingDelayed('正在处理…');
          vscode.postMessage({ type: 'setupAction', value: step.action });
        });
        row.appendChild(btn);
      }
      list.appendChild(row);
    });
    setupCard.appendChild(list);

    // 连不上调试端口时，给出「安装 → 重启 → 登录 → 重试」的明确指引
    if (state && !state.ready) {
      const hint = el('div', 'setup-hint');
      hint.appendChild(el('div', 'setup-hint-title', '连接不上调试端口？按这个顺序排查：'));
      const steps = [
        '① 确认已安装豆包桌面版（可从上方「下载豆包」）',
        '② 重启计算机（让调试端口设置生效）',
        '③ 打开豆包并登录账号，进入对话页',
        '④ 回到这里点「重新检测」',
      ];
      for (const text of steps) {
        hint.appendChild(el('div', 'setup-hint-line', text));
      }
      setupCard.appendChild(hint);
    }

    const foot = el('div', 'setup-foot');
    const recheck = el('button', 'setup-action ghost', '重新检测');
    recheck.addEventListener('click', function () {
      showPendingDelayed('正在检测环境');
      vscode.postMessage({ type: 'recheckSetup' });
    });
    foot.appendChild(recheck);
    if (state && state.install && state.install.exePath) {
      foot.appendChild(el('span', 'setup-path', state.install.exePath));
    }
    setupCard.appendChild(foot);
    scrollToBottom();
  }

  /* ================= 附件（+ 上传的文件/图片） ================= */

  const attachmentsEl = document.getElementById('attachments');

  function renderAttachments(items) {
    if (!attachmentsEl) {
      return;
    }
    attachmentsEl.innerHTML = '';
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) {
      attachmentsEl.hidden = true;
      return;
    }
    attachmentsEl.hidden = false;
    list.forEach(function (name, index) {
      const chip = el('span', 'attachment-chip');
      chip.appendChild(el('span', 'attachment-name', name));
      const del = el('button', 'attachment-del', '×');
      del.title = '移除';
      del.addEventListener('click', function () {
        vscode.postMessage({ type: 'removeAttachment', index: index });
      });
      chip.appendChild(del);
      attachmentsEl.appendChild(chip);
    });
  }

  function addImage(url, full, alt) {
    if (!/^(data:image\/|https?:|file:|blob:)/i.test(String(url || ''))) {
      const chip = el('span', 'img-missing', '🖼 ' + (alt || String(url || '图片')));
      chip.title = '本地找不到图片文件：' + url;
      messagesEl.appendChild(chip);
      scrollToBottom();
      return;
    }
    if (!url) {
      return;
    }
    showEmpty(false);
    const figure = el('figure', 'msg-image');
    const image = document.createElement('img');
    image.src = url;
    image.alt = alt || '豆包生成的图片';
    image.loading = 'lazy';
    image.addEventListener('click', function () {
      vscode.postMessage({ type: 'openExternal', url: full || url });
    });
    image.addEventListener('error', function () {
      figure.classList.add('failed');
    });
    figure.appendChild(image);
    const open = el('button', 'image-open', '打开原图');
    open.addEventListener('click', function () {
      vscode.postMessage({ type: 'openExternal', url: full || url });
    });
    figure.appendChild(open);
    messagesEl.appendChild(figure);
    scrollToBottom();
  }

  function addError(message) {
    showEmpty(false);
    const box = el('div', 'msg msg-error error-card');
    box.appendChild(el('div', 'msg-head')).appendChild(el('span', 'role', '错误'));
    const body = el('div', 'msg-body');
    body.appendChild(el('div', 'plain', String(message)));
    box.appendChild(body);
    messagesEl.appendChild(box);
    scrollToBottom();
  }

  function clearAll() {
    suggestContinue = false;
    inputEl.value = '';
    hideRunningBar();
    stepHistory = [];
    lastBlocks = [];
    stepLogOpen = false;
    stepLogAnchor = '';
    clearAutoContinue();
    if (quickSkillsEl) {
      quickSkillsEl.innerHTML = '';
    }
    if (turnDividerTimer) {
      clearInterval(turnDividerTimer);
      turnDividerTimer = null;
    }
    turnDivider = null;
    turnDividerLabel = null;
    turnStartedAt = 0;
    turnReportedSeconds = -1;
    turnReportedAt = 0;
    turnFinished = false;
    messagesEl.innerHTML = '';
    messagesEl.appendChild(emptyEl);
    emptyEl.classList.remove('hidden');
    nativeBlocksWrap = null;
    toolCards.clear();
    streamingBody = null;
    streamingBuffer = '';
    busy = false;
  }

  /* --------------------------- 状态更新 --------------------------- */

  const PERMISSION_LABEL = { ask: '始终询问', risk: '按需确认', allow: '全部允许' };
  const REASONING_LEVELS = ['低', '中', '高', '极高'];

  function updateContextHint() {
    const active = [];
    if (refs.currentFile) active.push('文件');
    if (refs.selection) active.push('选区');
    if (refs.diagnostics) active.push('诊断');
    if (contextHint) {
      const base = active.length ? '上下文：' + active.join(' + ') : '无上下文';
    contextHint.textContent = contextTokens > 0 ? base + ' · 约 ' + Math.round(contextTokens) + ' tokens' : base;
    }
  }

  /* 输入框上方的「正在执行中 · 已处理 N 秒」状态条 */
  let runningBaseSeconds = 0;
  let runningBaseAt = 0;
  let runningTickTimer = null;

  function paintRunningBar() {
    if (!runningTextEl) {
      return;
    }
    const seconds = runningBaseSeconds + (Date.now() - runningBaseAt) / 1000;
    const whole = Math.max(0, Math.floor(seconds));
    const mm = Math.floor(whole / 60);
    const ss = whole % 60;
    runningTextEl.textContent =
      '正在执行中 · 已处理 ' + (mm > 0 ? mm + ' 分 ' + ss + ' 秒' : ss + ' 秒');
  }

  function showRunningBar(seconds) {
    if (!runningBarEl) {
      return;
    }
    const wasHidden = runningBarEl.classList.contains('hidden');
    if (typeof seconds === 'number' && seconds >= 0) {
      runningBaseSeconds = seconds;
      runningBaseAt = Date.now();
    } else if (wasHidden) {
      runningBaseSeconds = 0;
      runningBaseAt = Date.now();
    }
    runningBarEl.classList.remove('hidden');
    paintRunningBar();
    if (!runningTickTimer) {
      runningTickTimer = setInterval(paintRunningBar, 1000);
    }
  }

  function hideRunningBar() {
    if (runningBarEl) {
      runningBarEl.classList.add('hidden');
    }
    if (runningTickTimer) {
      clearInterval(runningTickTimer);
      runningTickTimer = null;
    }
  }

  /** 豆包的询问卡片：把选项搬到面板里，点选后回传给豆包。 */
  function renderAskCard(question) {
    if (!question || !Array.isArray(question.options) || !question.options.length) {
      return;
    }
    const card = el('div', 'ask-card');
    card.appendChild(el('div', 'ask-title', question.title || '请选择'));
    question.options.forEach(function (opt) {
      const btn = el('button', 'ask-option');
      btn.type = 'button';
      const label = String(opt.label || '').replace(/^\d+\s*/, '');
      btn.appendChild(el('span', 'ask-option-label', label));
      btn.addEventListener('click', function () {
        vscode.postMessage({ type: 'askAnswer', value: opt.value });
        for (const b of card.querySelectorAll('button')) {
          b.disabled = true;
        }
        card.classList.add('answered');
        statusEl.textContent = '已选择：' + label.slice(0, 40);
      });
      card.appendChild(btn);
    });
    if (question.allowCustom) {
      card.appendChild(el('div', 'ask-custom', '也可以直接在豆包输入框里写自定义描述'));
    }
    messagesEl.appendChild(card);
    scrollToBottom();
  }

  function applyState(state) {
    const wasBusy = busy;
    autoContinueEnabled = state.autoContinue !== false;
    if (typeof state.autoContinueSeconds === 'number') {
      autoContinueSeconds = state.autoContinueSeconds;
    }
    if (state.busy) {
      clearAutoContinue();
    }
    busy = Boolean(state.busy);
    // 扩展可能在「还没收到任何一条回复」时就报 busy（连接/切换会话中）；
    // 这里必须给计时器一个真实起点，否则 Date.now() - 0 会显示成 49 万小时。
    if (busy && !turnStartedAt && !turnFinished) {
      turnStartedAt = Date.now();
      turnReportedSeconds = -1;
      turnReportedAt = 0;
    }
    syncBusyIndicator(busy);
    if (busy) {
      showRunningBar();
    } else {
      hideRunningBar();
    }
    const local = state.mode === 'local';
    currentMode = local ? 'local' : 'chat';
    currentPermission = state.permission || 'risk';
    currentDesktopMode = state.desktopMode || '';
    currentProject = state.project || '';
    currentPlugins = state.mcpTools || 0;
    currentSkills = Boolean(state.rules);
    currentSkillsCount = state.skillsCount || 0;
    currentPluginsCount = state.pluginsCount || 0;
    currentModel = state.model || '未配置模型';
    currentReasoning = state.reasoning || '';
    const model = currentModel;
    metaEl.textContent =
      model +
      (state.authMode === 'desktop' ? ' · 桌面端免 Key' : state.apiKeyConfigured ? (state.apiKeySource === 'env' ? ' · 环境变量 Key' : '') : ' · 未配置 API Key') +
      (state.version ? ' · v' + state.version : '');
    statusEl.textContent = busy
      ? (local ? '本地电脑执行中…' : '生成中…')
      : state.turns
        ? state.turns + ' 轮对话'
        : '就绪';
    sendBtn.disabled = busy;
    stopBtn.classList.toggle('hidden', !busy);
    const idlePlaceholder = local
      ? '发消息或创建任务… Enter 执行，Shift+Enter 换行'
      : '问点什么，Enter 发送，Shift+Enter 换行';
    // 默认就把「继续说」的作用写在提示后面（执行中/空闲都一样）
    inputEl.placeholder = idlePlaceholder + ' · 继续说：让豆包接着当前任务继续';
    if (chipMode) {
      chipMode.textContent = (local ? '工作任务 · 本地电脑' : '对话') + ' ▾';
    }
    if (chipMode) {
      chipMode.classList.toggle('active', local);
    }
    // 对话模式只保留图像/视频/PPT生成；本地电脑模式只保留技能与插件。
    if (quickChatEl) {
      quickChatEl.hidden = local;
    }
    if (quickSkillsEl) {
      quickSkillsEl.hidden = true;
    }
    if (chipProject) {
      chipProject.hidden = !local;
    }
    if (chipPermission) {
      chipPermission.hidden = !local;
    }
    if (chipSkills) {
      chipSkills.hidden = !local;
    }
    if (chipPlugins) {
      chipPlugins.hidden = !local;
    }
    toolbarWanted = new Set();
    if (chipMode) {
      toolbarWanted.add(chipMode);
    }
    if (local) {
      [chipProject, chipPermission, chipSkills, chipPlugins].forEach(function (node) {
        if (node) {
          toolbarWanted.add(node);
        }
      });
    } else if (quickChatEl) {
      Array.from(quickChatEl.children).forEach(function (node) {
        toolbarWanted.add(node);
      });
    }
    chipPermission.textContent = (PERMISSION_LABEL[currentPermission] || '按需确认') + ' ▾';
    chipProject.textContent = '项目';
    chipProject.title = currentProject ? '当前项目：' + currentProject : '当前没有打开工作区';
    if (chipPlugins) {
      chipPlugins.textContent = currentPluginsCount > 0 ? '插件 ' + currentPluginsCount : '插件';
    }
    if (chipPlugins) {
      chipPlugins.title = currentPluginsCount > 0 ? '已从豆包同步 ' + currentPluginsCount + ' 个插件' : '点击从豆包同步插件';
    }
    chipSkills.classList.toggle('on', currentSkillsCount > 0 || currentSkills);
    chipSkills.textContent = currentSkillsCount > 0 ? '更多技能 ' + currentSkillsCount : '更多技能';
    chipSkills.title = currentSkillsCount > 0 ? '已从豆包同步 ' + currentSkillsCount + ' 个技能' : '点击从豆包同步技能';
    chipModel.textContent = model + ' ▾';
    if (typeof layoutToolbar === 'function') {
      setTimeout(layoutToolbar, 0);
    }
    chipModel.title = '当前模型：' + model + (currentReasoning ? '（推理 ' + currentReasoning + '）' : '');
    updateContextHint();
    if (state.trusted === false) {
      statusEl.textContent = '受限模式：写文件/命令被禁用';
    }
  }

  /* --------------------------- 弹出菜单（对齐豆包） --------------------------- */

  function closePopup() {
    if (popup) {
      popup.remove();
      popup = null;
    }
  }

  function openPopup(anchor, items, options) {
    if (!anchor) {
      return;
    }
    closePopup();
    const opts = options || {};
    const menu = el('div', 'popup-menu');
    let searchInput = null;
    if (opts.searchable) {
      searchInput = document.createElement('input');
      searchInput.className = 'menu-search';
      searchInput.type = 'search';
      searchInput.placeholder = opts.placeholder || '搜索...';
      searchInput.addEventListener('input', function () {
        const query = searchInput.value.trim().toLowerCase();
        for (const row of menu.querySelectorAll('.menu-item')) {
          const text = String(row.getAttribute('data-search') || '').toLowerCase();
          row.style.display = !query || text.indexOf(query) >= 0 ? '' : 'none';
        }
      });
      menu.appendChild(searchInput);
    }
    for (const item of items) {
      if (!item) {
        continue;
      }
      if (item.separator) {
        menu.appendChild(el('div', 'menu-sep'));
        continue;
      }
      if (item.heading) {
        menu.appendChild(el('div', 'menu-heading', item.heading));
        continue;
      }
      const row = el('button', 'menu-item');
      row.type = 'button';
      row.setAttribute('data-search', (item.label || '') + ' ' + (item.description || ''));
      row.appendChild(el('span', 'menu-check', item.checked ? '✓' : ''));
      row.appendChild(el('span', 'menu-label', item.label));
      if (item.description) {
        row.appendChild(el('span', 'menu-desc', item.description));
      }
      row.addEventListener('click', function (event) {
        event.stopPropagation();
        closePopup();
        if (typeof item.onSelect === 'function') {
          item.onSelect();
        }
      });
      if (typeof item.onContextMenu === 'function') {
        row.addEventListener('contextmenu', function (event) {
          event.preventDefault();
          event.stopPropagation();
          item.onContextMenu(row);
        });
      }
      menu.appendChild(row);
    }
    document.body.appendChild(menu);
    const rect = anchor.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
    let top = rect.top - height - 6;
    if (top < 8) {
      top = Math.min(window.innerHeight - height - 8, rect.bottom + 6);
    }
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    popup = menu;
    if (searchInput) {
      searchInput.focus();
    }
  }

  function toggleRef(key) {
    refs[key] = !refs[key];
    updateContextHint();
  }

  /** 模式菜单：只有两种 —— 对话 / 工作任务（本地电脑）。 */
  function openModeMenu() {
    const local = currentMode === 'local';
    openPopup(chipMode, [
      {
        label: '对话',
        description: '普通聊天，不执行本地任务',
        checked: !local,
        onSelect: function () {
          vscode.postMessage({ type: 'setMode', value: 'chat' });
          vscode.postMessage({ type: 'setDesktopMode', value: 'chat' });
        },
      },
      {
        label: '工作任务 · 本地电脑',
        description: '在你的电脑上执行（计划 → 逐步执行）',
        checked: local,
        onSelect: function () {
          vscode.postMessage({ type: 'setMode', value: 'local' });
          vscode.postMessage({ type: 'setDesktopMode', value: 'local' });
        },
      },
    ]);
  }

  function openPermissionMenu() {
    openPopup(chipPermission, [
      { label: '按需确认', checked: currentPermission === 'risk', description: '只对高风险操作确认', onSelect: function () { vscode.postMessage({ type: 'setPermission', value: 'risk' }); } },
      { label: '始终询问', checked: currentPermission === 'ask', description: '每个有副作用的操作都确认', onSelect: function () { vscode.postMessage({ type: 'setPermission', value: 'ask' }); } },
      { label: '全部允许', checked: currentPermission === 'allow', description: '不弹确认，慎用', onSelect: function () { vscode.postMessage({ type: 'setPermission', value: 'allow' }); } },
    ]);
  }

  /** 历史菜单：本地记忆 + 豆包里的对话。 */
  /* ------------------------- 历史对话管理面板 ------------------------- */

  function openHistoryManager() {
    historyOpen = true;
    historyBatch = false;
    historySelected = new Set();
    historyQuery = '';
    historyTab = 'local';
    historyLoading = true;
    historyLoadedOnce = false;
    if (historySearchEl) historySearchEl.value = '';
    if (historyOverlay) historyOverlay.classList.remove('hidden');
    if (historyBatchBar) historyBatchBar.classList.add('hidden');
    renderHistoryManager();
    vscode.postMessage({ type: 'listHistory' });
  }

  function closeHistoryManager() {
    historyOpen = false;
    if (historyOverlay) historyOverlay.classList.add('hidden');
  }

  function updateHistoryBatchBar() {
    if (!historyBatchBar) return;
    const show = historyBatch && historyTab === 'local';
    historyBatchBar.classList.toggle('hidden', !show);
    if (historySelectedCount) historySelectedCount.textContent = '已选 ' + historySelected.size + ' 项';
    const all = document.getElementById('history-select-all');
    if (all) {
      const ids = (historyData.local || []).map(function (item) { return item.id; });
      all.checked = ids.length > 0 && ids.every(function (id) { return historySelected.has(id); });
    }
  }

  function renderHistoryManager(message) {
    if (message) {
      historyLoading = Boolean(message.loading);
      historyLoadingText = message.loading ? String(message.loadingText || '') : '';
      if (!message.loading) {
        historyData = {
          local: message.local || [],
          desktop: message.desktop || { ok: false, items: [] },
        };
        if (!historyLoadedOnce) {
          historyLoadedOnce = true;
          // 首次加载：本地没有记录、豆包有列表时，直接切到「豆包对话」
          const desktopList = historyData.desktop && historyData.desktop.ok ? historyData.desktop.items || [] : [];
          if (historyTab === 'local' && !(historyData.local || []).length && desktopList.length) {
            historyTab = 'desktop';
            const tabs = historyOverlay ? historyOverlay.querySelectorAll('.history-tab') : [];
            for (const tab of tabs) {
              tab.classList.toggle('on', tab.getAttribute('data-tab') === 'desktop');
            }
          }
        }
      }
    }
    if (!historyOpen || !historyListEl) return;
    historyListEl.innerHTML = '';
    const desktop = historyData.desktop || { ok: false, items: [] };
    const source = historyTab === 'local' ? (historyData.local || []) : (desktop.items || []);
    const query = historyQuery.trim().toLowerCase();
    const items = source.filter(function (item) {
      return !query || String(item.title || '').toLowerCase().indexOf(query) >= 0;
    });
    // 豆包列表还在读：先给出进度，避免面板看起来是空的。
    if (historyLoading) {
      const loadingRow = el('div', 'history-loading');
      loadingRow.appendChild(el('span', 'history-spinner'));
      loadingRow.appendChild(
        el('span', 'history-loading-text', historyLoadingText || (historyTab === 'desktop' ? '正在加载豆包对话列表…' : '正在同步豆包对话列表…')),
      );
      historyListEl.appendChild(loadingRow);
      if (historyTab === 'desktop') {
        updateHistoryBatchBar();
        return;
      }
    }
    if (!items.length) {
      if (historyTab === 'desktop' && !historyLoading && !desktop.ok) {
        const box = el('div', 'history-empty');
        box.appendChild(el('div', '', desktop.error || '没有读取到豆包对话'));
        const retry = el('button', 'suggest-chip', '重试');
        retry.type = 'button';
        retry.addEventListener('click', function () {
          historyLoading = true;
          renderHistoryManager();
          vscode.postMessage({ type: 'listHistory' });
        });
        box.appendChild(retry);
        historyListEl.appendChild(box);
        updateHistoryBatchBar();
        return;
      }
      const hint = historyTab === 'local'
        ? (query ? '没有匹配的本地会话' : '还没有本地记录，聊几轮会自动保存')
        : (desktop.ok ? (query ? '没有匹配的豆包对话' : '豆包还没有对话') : (desktop.error || '没有读取到豆包对话'));
      historyListEl.appendChild(el('div', 'history-empty', hint));
      updateHistoryBatchBar();
      return;
    }
    for (const item of items) {
      const local = historyTab === 'local';
      const row = el('div', 'history-row');
      if (historyBatch && local) {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'history-checkbox';
        cb.checked = historySelected.has(item.id);
        cb.addEventListener('change', function () {
          if (cb.checked) historySelected.add(item.id);
          else historySelected.delete(item.id);
          updateHistoryBatchBar();
        });
        row.appendChild(cb);
      }
      const main = el('button', 'history-main');
      main.type = 'button';
      const title = el('span', 'history-row-title', (item.pinned ? '📌 ' : '') + (item.title || '未命名'));
      const metaText = local
        ? (item.time || '') + (item.archived ? ' · 已归档' : '') + (item.desktopMissing ? ' · 对话已不存在' : '')
        : '在豆包中打开' + (item.time ? ' · ' + item.time : '');
      const meta = el('span', 'history-row-meta', metaText);
      if (!local && item.status) {
        const badge = el('span', 'history-badge' + (item.running ? ' running' : ''), item.status);
        title.appendChild(badge);
      }
      main.appendChild(title);
      main.appendChild(meta);
      main.addEventListener('click', function () {
        if (local) {
          showHistoryLoading('正在加载本地记忆…');
          showPending('正在回放会话');
          vscode.postMessage({ type: 'openSession', id: item.id });
        } else {
          if (item.running) {
            statusEl.textContent = '这个任务在豆包那边还在执行，导入的是当前进度';
          }
          showHistoryLoading('正在导入豆包对话…');
          showPendingDelayed('正在导入豆包对话');
          vscode.postMessage({ type: 'openDesktopChat', index: item.index, title: item.title, id: item.id });
        }
        closeHistoryManager();
      });
      row.appendChild(main);
      if (local) {
        const actions = el('div', 'history-actions');
        const rename = el('button', 'history-action', '✎');
        rename.type = 'button';
        rename.title = '重命名';
        rename.addEventListener('click', function () {
          vscode.postMessage({ type: 'sessionAction', id: item.id, action: 'rename' });
        });
        const exportBtn = el('button', 'history-action', '⤓');
        exportBtn.type = 'button';
        exportBtn.title = '导出为 Markdown';
        exportBtn.addEventListener('click', function () {
          vscode.postMessage({ type: 'sessionAction', id: item.id, action: 'export' });
        });
        const del = el('button', 'history-action', '🗑');
        del.type = 'button';
        del.title = '删除';
        del.addEventListener('click', function () {
          vscode.postMessage({ type: 'sessionAction', id: item.id, action: 'delete' });
        });
        actions.appendChild(rename);
        actions.appendChild(exportBtn);
        actions.appendChild(del);
        row.appendChild(actions);
      }
      historyListEl.appendChild(row);
    }
    updateHistoryBatchBar();
  }

  if (historySearchEl) {
    historySearchEl.addEventListener('input', function () {
      historyQuery = historySearchEl.value || '';
      renderHistoryManager();
    });
  }
  if (historyOverlay) {
    const tabs = historyOverlay.querySelectorAll('.history-tab');
    for (const tab of tabs) {
      tab.addEventListener('click', function () {
        historyTab = tab.getAttribute('data-tab') || 'local';
        for (const other of tabs) other.classList.toggle('on', other === tab);
        renderHistoryManager();
      });
    }
  }
  const historyBackBtn = document.getElementById('history-back');
  if (historyBackBtn) historyBackBtn.addEventListener('click', closeHistoryManager);
  const historyCloseBtn = document.getElementById('history-close');
  if (historyCloseBtn) historyCloseBtn.addEventListener('click', closeHistoryManager);
  const historyBatchBtn = document.getElementById('history-batch');
  if (historyBatchBtn) {
    historyBatchBtn.addEventListener('click', function () {
      historyBatch = !historyBatch;
      historySelected = new Set();
      historyBatchBtn.classList.toggle('on', historyBatch);
      renderHistoryManager();
    });
  }
  const historySelectAll = document.getElementById('history-select-all');
  if (historySelectAll) {
    historySelectAll.addEventListener('change', function () {
      if (historySelectAll.checked) {
        for (const item of historyData.local || []) historySelected.add(item.id);
      } else {
        historySelected.clear();
      }
      renderHistoryManager();
    });
  }
  const historyBatchDelete = document.getElementById('history-batch-delete');
  if (historyBatchDelete) {
    historyBatchDelete.addEventListener('click', function () {
      if (historySelected.size === 0) return;
      vscode.postMessage({ type: 'sessionBatch', action: 'delete', ids: Array.from(historySelected) });
      historySelected.clear();
      updateHistoryBatchBar();
    });
  }

  function openHistoryMenu(message) {
    cancelPendingDelayed();
    const items = [];
    const desktop = message.desktop || { ok: false, items: [] };
    items.push({ heading: desktop.ok ? '豆包里的对话' : '豆包里的对话（不可用）' });
    if (desktop.ok && (desktop.items || []).length) {
      for (const item of desktop.items.slice(0, 15)) {
        items.push({
          label: item.title,
          description: item.time || '',
          onSelect: (function (index) {
            return function () {
              showPendingDelayed('正在导入豆包对话');
              vscode.postMessage({ type: 'openDesktopChat', index: index });
            };
          })(item.index),
        });
      }
    } else {
      items.push({ label: desktop.error || '没有读到对话列表', onSelect: function () {} });
    }

    items.push({ separator: true });
    items.push({ heading: '本地记忆（右键管理）' });
    const local = message.local || [];
    if (local.length) {
      for (const item of local.slice(0, 15)) {
        items.push({
          label: item.title,
          description: item.time || '',
          onSelect: (function (id) {
            return function () {
              showPending('正在回放会话');
              vscode.postMessage({ type: 'openSession', id: id });
            };
          })(item.id),
          onContextMenu: (function (id, pinned, archived) {
            return function (anchorRow) {
              openPopup(anchorRow, [
                {
                  label: pinned ? '取消置顶' : '置顶',
                  onSelect: function () { vscode.postMessage({ type: 'sessionAction', id: id, action: 'pin' }); },
                },
                {
                  label: '重命名',
                  onSelect: function () { vscode.postMessage({ type: 'sessionAction', id: id, action: 'rename' }); },
                },
                {
                  label: '复制对话 ID',
                  onSelect: function () { vscode.postMessage({ type: 'sessionAction', id: id, action: 'copyId' }); },
                },
                {
                  label: archived ? '取消归档' : '归档',
                  onSelect: function () { vscode.postMessage({ type: 'sessionAction', id: id, action: 'archive' }); },
                },
                { separator: true },
                {
                  label: '删除',
                  onSelect: function () { vscode.postMessage({ type: 'sessionAction', id: id, action: 'delete' }); },
                },
              ]);
            };
          })(item.id, Boolean(item.pinned), Boolean(item.archived)),
        });
      }
    } else {
      items.push({ label: '还没有本地记录（聊几轮就会自动保存）', onSelect: function () {} });
    }
    openPopup(historyBtn, items, { searchable: true, placeholder: '搜索历史…' });
  }

  /** 回放一个本地会话。 */
  function renderHistory(message) {
    hidePending();
    hideHistoryLoading();
    clearAll();
    showEmpty(false);
    const turns = Array.isArray(message.turns) ? message.turns : [];
    for (const turn of turns) {
      const body = addMessage(turn.role === 'user' ? 'user' : 'assistant', turn.text);
      if (turn.role !== 'user' && body) {
        // 历史回放也走「Markdown + 管道表」渲染，避免表格显示成原始竖线
        body.innerHTML = '';
        body.appendChild(renderMarkdownWithTables(turn.text || ''));
      }
    }
    statusEl.textContent = '已载入历史：' + (message.title || '') + '（继续提问会接着这个会话）';
    scrollToBottom();
  }

  function openModelMenu(message) {
    const items = [{ heading: '模型' }];
    const models = Array.isArray(message.models) ? message.models : [];
    for (const model of models) {
      items.push({
        label: model,
        checked: model === message.currentModel,
        onSelect: (function (value) {
          return function () { vscode.postMessage({ type: 'selectModel', value: value }); };
        })(model),
      });
    }
    if (message.allowReasoning !== false) {
      items.push({ separator: true });
      items.push({ heading: '推理强度' });
      for (const level of REASONING_LEVELS) {
        items.push({
          label: level,
          checked: level === message.reasoning,
          onSelect: (function (value) {
            return function () { vscode.postMessage({ type: 'setReasoning', value: value }); };
          })(level),
        });
      }
    }
    openPopup(chipModel, items);
  }


  /* ================= 快捷技能（图像生成 / 视频生成 / PPT 生成 …） ================= */

  /** 豆包底栏那几个常用技能的优先级（有就排前面）。 */
  const QUICK_SKILL_ORDER = ['图像生成', '视频生成', 'PPT 生成', 'PPT生成', '帮我写作', 'AI 播客', '深度研究', '翻译'];

  function renderQuickSkills() {
    if (!quickSkillsEl) {
      return;
    }
    const all = [];
    for (const group of catalog.skills || []) {
      for (const item of group.items || []) {
        const name = String(item.name || '').replace(/\(\d+\)$/, '').trim();
        if (name && all.indexOf(name) < 0) {
          all.push(name);
        }
      }
    }
    const picked = [];
    for (const want of QUICK_SKILL_ORDER) {
      if (picked.length >= 4) break;
      const hit = all.find(function (name) { return name.indexOf(want) >= 0; });
      if (hit && picked.indexOf(hit) < 0) {
        picked.push(hit);
      }
    }
    for (const name of all) {
      if (picked.length >= 4) break;
      if (picked.indexOf(name) < 0) {
        picked.push(name);
      }
    }

    quickSkillsEl.innerHTML = '';
    for (const name of picked) {
      const chip = el('button', 'pill quick-skill', name);
      chip.title = '把「' + name + '」插入输入框';
      chip.addEventListener('click', function () {
        insertMention(name);
      });
      quickSkillsEl.appendChild(chip);
    }
  }

  let workspaceFilesCache = null;
  let fileMenuPending = false;
  function openFileMentionMenu() {
    const files = Array.isArray(workspaceFilesCache) ? workspaceFilesCache : [];
    const items = [{ heading: '工作区文件（点击插入 @路径）' }];
    if (files.length === 0) {
      items.push({ label: '没有可用的文件', onSelect: function () {} });
    }
    for (const file of files.slice(0, 120)) {
      items.push({
        label: file,
        onSelect: (function (value) {
          return function () { insertMention(value); };
        })(file),
      });
    }
    openPopup(inputEl, items, { searchable: true, placeholder: '搜索文件...' });
  }
  function requestWorkspaceFiles() {
    if (Array.isArray(workspaceFilesCache)) {
      openFileMentionMenu();
      return;
    }
    fileMenuPending = true;
    vscode.postMessage({ type: 'listWorkspaceFiles' });
    openPopup(inputEl, [{ heading: '文件' }, { label: '正在读取工作区文件…', onSelect: function () {} }], { searchable: false });
  }

  function insertMention(name) {
    const text = String(name || '').trim();
    if (!text) {
      return;
    }
    const prefix = inputEl.value && !/\s$/.test(inputEl.value) ? ' ' : '';
    inputEl.value += prefix + '@' + text + ' ';
    inputEl.focus();
  }

  function openSkillMenu(groups, ok) {
    cancelPendingDelayed();
    const items = [];
    const list = Array.isArray(groups) ? groups : [];
    if (ok === false) {
      items.push({ heading: '同步失败' });
      items.push({ label: '没有打开豆包技能面板，点此重试', onSelect: function () { vscode.postMessage({ type: 'listSkills' }); } });
      openPopup(chipSkills, items, { searchable: false });
      return;
    }
    if (list.length === 0) {
      items.push({ heading: '技能' });
      items.push({ label: '豆包没有可用技能', onSelect: function () {} });
      openPopup(chipSkills, items);
      return;
    }
    for (const group of list) {
      items.push({ heading: group.title || '技能' });
      for (const skill of group.items || []) {
        items.push({
          label: skill.name,
          description: skill.description ? skill.description.slice(0, 28) : '',
          onSelect: (function (name) {
            return function () { insertMention(name); };
          })(skill.name),
        });
      }
    }
    openPopup(chipSkills, items, { searchable: true, placeholder: '搜索技能...' });
  }

  function openPluginMenu(plugins, ok) {
    cancelPendingDelayed();
    const items = [];
    if (ok === false) {
      items.push({ heading: '同步失败' });
      items.push({ label: '没有打开豆包插件面板，点此重试', onSelect: function () { vscode.postMessage({ type: 'listPlugins' }); } });
      openPopup(chipPlugins, items, { searchable: false });
      return;
    }
    items.push({ heading: '豆包插件' });
    for (const plugin of Array.isArray(plugins) ? plugins : []) {
      items.push({
        label: plugin.name,
        description: plugin.description ? plugin.description.slice(0, 28) : '',
        onSelect: (function (name) {
          return function () { insertMention(name); };
        })(plugin.name),
      });
    }
    if (!plugins || plugins.length === 0) {
      items.push({ label: '豆包没有已安装插件', onSelect: function () {} });
    }
    openPopup(chipPlugins, items, { searchable: true, placeholder: '搜索插件...' });
  }

  function openSlashMenu() {
    const skills = Array.isArray(catalog.skills) ? catalog.skills : [];
    const plugins = Array.isArray(catalog.plugins) ? catalog.plugins : [];
    if (skills.length === 0 && plugins.length === 0) {
      slashPending = true;
      vscode.postMessage({ type: 'syncCatalog' });
      openPopup(inputEl, [{ heading: '技能' }, { label: '正在同步豆包技能…', onSelect: function () {} }], { searchable: false });
      return;
    }
    const items = [];
    if (skills.length > 0) {
      items.push({ heading: '技能' });
      for (const group of skills) {
        for (const skill of group.items || []) {
          items.push({
            label: skill.name,
            description: skill.description ? skill.description.slice(0, 26) : '',
            onSelect: (function (name) {
              return function () { insertMention(name); };
            })(skill.name),
          });
        }
      }
    }
    if (plugins.length > 0) {
      if (items.length > 0) {
        items.push({ separator: true });
      }
      items.push({ heading: '插件' });
      for (const plugin of plugins) {
        items.push({
          label: plugin.name,
          description: plugin.description ? plugin.description.slice(0, 26) : '',
          onSelect: (function (name) {
            return function () { insertMention(name); };
          })(plugin.name),
        });
      }
    }
    openPopup(inputEl, items, { searchable: true, placeholder: '搜索技能或插件...' });
  }

  /* --------------------------- 事件绑定 --------------------------- */

  /** 立刻把用户自己说的话画到对话区（不依赖扩展往返）。 */
  let lastLocalEcho = { text: '', at: 0 };
  /** 本地回显的那条气泡，便于后续补充附件。 */
  let lastLocalBubble = null;

  /* 原生分块 → AST（这两个函数之前在某次重构里被删了，导致代码行完全不渲染） */
  function rememberSteps(blocks) {
    var list = Array.isArray(blocks) ? blocks : [];
    for (var i = 0; i < list.length; i += 1) {
      var b = list[i];
      if (!b || b.kind !== 'step' || !b.text) {
        continue;
      }
      // 「正在思考 / 正在执行代码 / 正在调度资源」是瞬时状态，执行完就被替换；
      // 历史里只保留执行结果，避免列表里堆积一堆过期的“正在…”。
      if (b.state === 'running') {
        continue;
      }
      var key = String(b.state || 'done') + '|' + String(b.text);
      var exists = stepHistory.some(function (s) { return s.key === key; });
      if (!exists) {
        stepHistory.push({ key: key, text: String(b.text), state: b.state || 'done', icon: b.icon || '', images: Array.isArray(b.images) ? b.images : undefined });
        if (stepHistory.length > 300) {
          stepHistory.shift();
        }
      }
    }
  }

  function stepKey(block) {
    return String((block && block.state) || 'done') + '|' + String((block && block.text) || '');
  }

  function renderNativeBlocks(blocks) {
    // blocks 是权威内容：先移除同轮的流式气泡，避免同一段文字显示两遍
    if (streamingBody) {
      const streamMsg = streamingBody.closest('.msg');
      if (streamMsg) {
        streamMsg.remove();
      }
      streamingBody = null;
      streamingBuffer = '';
    }
    lastBlocks = Array.isArray(blocks) ? blocks.slice() : [];
    rememberSteps(blocks);
    // 计时块在「本轮还在跑」时由底部 turn-divider 统一显示，避免出现两条不一样的时间；
    // 历史回放（没有 divider）时仍把「已处理 / 共用时」画进消息里。
    const skipStatus = Boolean(turnDividerLabel);
    const mapped = (Array.isArray(blocks) ? blocks : [])
      .filter(function (b) { return Boolean(b); })
      .filter(function (b) { return !(skipStatus && b.kind === 'status'); })
      .map(function (b) {
        if (b.kind === 'code') {
          return { kind: 'code', text: b.text || '', isCommand: true };
        }
        if (b.kind === 'status') {
          return { kind: 'status', text: b.text || '' };
        }
        if (b.kind === 'step') {
          return { kind: 'step', text: b.text || '', detail: b.detail || '', state: b.state || 'done', icon: b.icon || '', images: Array.isArray(b.images) ? b.images : undefined };
        }
        return { kind: 'paragraph', text: b.text || '' };
      });
    renderAst(mapped);
    ensureFoldBar(nativeBlocksWrap);
  }

  function addNativeBlock(kind, text) {
    const content = String(text || '');
    if (!content) {
      return;
    }
    const block = kind === 'code'
      ? { kind: 'code', text: content, isCommand: true }
      : kind === 'status'
        ? { kind: 'status', text: content }
        : kind === 'step'
          ? { kind: 'step', text: content, state: 'done' }
          : { kind: 'paragraph', text: content };
    renderAst([block]);
  }

  /* ================= AST 长内容折叠 / 代码复制 ================= */

  /** 折叠阈值：超过 12 行或 800 字就折叠（代码块不折叠，代码块自己带滚动条）。 */
  const AST_FOLD_LINES = 12;
  const AST_FOLD_CHARS = 800;

  /** 只有 paragraph / list / table 块折叠；code 块不折叠。 */
  function isFoldableAstBlock(node) {
    if (!node || !node.classList) {
      return false;
    }
    return node.classList.contains('ast-p') ||
      node.classList.contains('ast-list') ||
      node.classList.contains('ast-table');
  }

  /** 内容是否超过 12 行或 800 字：文本行数、渲染高度折算任一超限即折叠。 */
  function shouldFoldAst(node) {
    const text = String(node.textContent || '');
    if (text.length > AST_FOLD_CHARS) {
      return true;
    }
    if (text.split('\n').length > AST_FOLD_LINES) {
      return true;
    }
    const style = window.getComputedStyle ? window.getComputedStyle(node) : null;
    const lineHeight = style ? parseFloat(style.lineHeight) : 0;
    const rect = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
    if (!rect || !lineHeight || !isFinite(lineHeight)) {
      return false;
    }
    return rect.height > lineHeight * AST_FOLD_LINES;
  }

  /** 给超长块套一层折叠容器，底部放「展开全部 / 收起」按钮。 */
  function applyAstFold(node) {
    if (!isFoldableAstBlock(node) || !node.parentNode || !shouldFoldAst(node)) {
      return;
    }
    const holder = el('div', 'ast-fold collapsed');
    const body = el('div', 'ast-fold-body');
    const button = el('button', 'ast-expand', '展开全部');
    button.type = 'button';
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', function () {
      const collapsed = holder.classList.toggle('collapsed');
      button.textContent = collapsed ? '展开全部' : '收起';
      button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });
    node.parentNode.insertBefore(holder, node);
    holder.appendChild(body);
    body.appendChild(node);
    holder.appendChild(button);
  }


  /* ================= 图片点击放大 ================= */

  let zoomLayer = null;

  function openImageZoom(src) {
    if (!src) {
      return;
    }
    if (!zoomLayer) {
      zoomLayer = el('div', 'img-zoom');
      const pic = document.createElement('img');
      pic.className = 'img-zoom-img';
      zoomLayer.appendChild(pic);
      zoomLayer.addEventListener('click', closeImageZoom);
      document.body.appendChild(zoomLayer);
    }
    const pic = zoomLayer.querySelector('.img-zoom-img');
    if (pic) {
      pic.src = src;
    }
    zoomLayer.classList.add('on');
  }

  function closeImageZoom() {
    if (zoomLayer) {
      zoomLayer.classList.remove('on');
    }
  }

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      closeImageZoom();
    }
  });

  /* 任何消息里的图片都可点开放大 */
  document.addEventListener('click', function (event) {
    const target = event.target;
    if (!target || target.tagName !== 'IMG') {
      return;
    }
    if (target.classList && target.classList.contains('img-zoom-img')) {
      return;
    }
    openImageZoom(target.currentSrc || target.src);
  });

  /* ================= 执行反馈图标：按动作类型区分（对齐豆包） ================= */

  var STEP_ICON_SVG = {
    read: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.6 3.5c1.8-.8 3.5-.8 5.4 0v9c-1.9-.8-3.6-.8-5.4 0z"/><path d="M8 3.5c1.9-.8 3.6-.8 5.4 0v9c-1.8-.8-3.5-.8-5.4 0z"/></svg>',
    search: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.2"/><path d="M10.1 10.1 14 14"/></svg>',
    edit: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13l.8-3 6.6-6.6 2.2 2.2L6 12.2z"/><path d="M9.6 4.4l2.2 2.2"/></svg>',
    write: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2.6h6l3 3v7.8H3z"/><path d="M9 2.6v3h3"/></svg>',
    browser: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M2.7 8h10.6M8 2.5c2.5 3.2 2.5 7.8 0 11M8 2.5c-2.5 3.2-2.5 7.8 0 11"/></svg>',
    skill: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.3l1.4 3.3 3.6.4-2.7 2.4.8 3.5L8 10.1l-3.1 1.8.8-3.5L3 6l3.6-.4z"/></svg>',
    agent: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="8" r="2"/><circle cx="12" cy="8" r="2"/><path d="M6 8h4"/></svg>'
  };

  /** 与豆包一致：不同类型动作不同图标；运行中用转圈，失败用感叹号。 */
  function stepIconKind(block) {
    var title = String((block && block.text) || '').trim();
    if (/^(正在|已)?执行(代码|命令)/.test(title)) return 'code';
    if (/^(正在|已)?读取|^(正在|已)?查看文件/.test(title)) return 'read';
    if (/^(正在|已)?查找|查找文件|搜索文件|grep/i.test(title)) return 'search';
    if (/^(正在|已)?(写入|修改|编辑|应用)/.test(title)) return 'edit';
    if (/浏览器|网页|browser/i.test(title)) return 'browser';
    if (/技能|插件|skill|plugin/i.test(title)) return 'skill';
    if (block && block.icon) return String(block.icon);
    return 'step';
  }

  function stepIconNode(block) {
    var span = el('span', 'ast-step-icon');
    if (block && block.state === 'running') {
      span.classList.add('icon-running');
      span.appendChild(el('span', 'step-spin'));
      return span;
    }
    if (block && block.state === 'error') {
      span.classList.add('icon-error');
      span.textContent = '!';
      return span;
    }
    var icon = stepIconKind(block);
    span.classList.add('icon-' + icon);
    span.setAttribute('data-icon', icon);
    if (icon === 'code') {
      span.textContent = '</>';
    } else if (STEP_ICON_SVG[icon]) {
      span.innerHTML = STEP_ICON_SVG[icon];
    } else {
      span.textContent = '›';
    }
    return span;
  }

  /** 本轮累计的执行过程列表（点击步骤行展开）。 */
  function buildStepLog() {
    var log = el('div', 'ast-step-log hidden');
    stepHistory.filter(function (s) { return s.state !== 'running'; }).forEach(function (s) {
      var line = el('div', 'ast-step-log-row');
      line.appendChild(stepIconNode({ state: s.state, icon: s.icon, text: s.text }));
      line.appendChild(el('span', 'ast-step-log-title', String(s.text || '').split('\n')[0]));
      log.appendChild(line);
    });
    return log;
  }

  /** 统一切换所有步骤分组（计时分隔线 / 分组头都走这里）。 */
  function applyStepsGroupOpen() {
    const bodies = messagesEl.querySelectorAll('.ast-steps-body');
    for (const body of bodies) {
      body.classList.toggle('hidden', !stepsGroupOpen);
    }
    const collapseButtons = messagesEl.querySelectorAll('.ast-steps-collapse');
    for (const btn of collapseButtons) {
      // 收起时按钮仍在，文案变成「展开执行过程」，方便就地再展开
      btn.textContent = stepsGroupOpen ? '收起执行过程' : '展开执行过程';
      btn.classList.remove('hidden');
    }
    const chevrons = messagesEl.querySelectorAll('.ast-steps-chevron');
    for (const c of chevrons) {
      c.textContent = stepsGroupOpen ? '⌃' : '⌄';
    }
  }

  /** 单条执行反馈行（有详情先展开详情，否则可展开本轮累计执行过程）。 */
  function buildStepRow(block, openStepKey) {
    const state = block.state === 'running' ? ' is-running' : block.state === 'error' ? ' is-error' : '';
    const row = el('div', 'ast-step' + state);
    const head = el('div', 'ast-step-head');
    head.appendChild(stepIconNode(block));
    head.appendChild(el('span', 'ast-step-title', String(block.text || '').split('\n')[0]));
    if (Array.isArray(block.images) && block.images.length) {
      const gallery = el('div', 'ast-step-images');
      block.images.forEach(function (src) {
        const pic = document.createElement('img');
        pic.src = src;
        pic.alt = '生成结果';
        pic.loading = 'lazy';
        pic.addEventListener('click', function (ev) {
          ev.stopPropagation();
          vscode.postMessage({ type: 'openExternal', url: src });
        });
        gallery.appendChild(pic);
      });
      row.appendChild(gallery);
    }
    if (block.state === 'running') {
      const dots = el('span', 'ast-step-dots');
      dots.appendChild(el('i'));
      dots.appendChild(el('i'));
      dots.appendChild(el('i'));
      head.appendChild(dots);
    }
    const key = stepKey(block);
    const canOpenLog = stepHistory.length > 1;
    const openHere = Boolean(openStepKey) && key === openStepKey && canOpenLog && !block.detail;
    if (block.detail || canOpenLog) {
      head.appendChild(el('span', 'ast-step-chevron', openHere ? '⌃' : '⌄'));
    }
    if (openHere) {
      row.classList.add('is-open');
    }
    row.appendChild(head);
    if (block.detail) {
      const chevron = head.querySelector('.ast-step-chevron');
      const out = el('pre', 'ast-step-detail hidden');
      out.textContent = String(block.detail);
      head.addEventListener('click', function () {
        const open = !out.classList.toggle('hidden');
        row.classList.toggle('is-open', open);
        if (chevron) chevron.textContent = open ? '⌃' : '⌄';
      });
      row.appendChild(out);
    } else if (canOpenLog) {
      // 豆包折叠时旧步骤会从 DOM 消失；点击该行展开本轮累计的执行过程。
      const chevron = head.querySelector('.ast-step-chevron');
      const log = buildStepLog();
      if (openHere) {
        log.classList.remove('hidden');
      }
      head.addEventListener('click', function () {
        const willOpen = log.classList.contains('hidden');
        stepLogOpen = willOpen;
        stepLogAnchor = willOpen ? key : '';
        log.classList.toggle('hidden', !willOpen);
        row.classList.toggle('is-open', willOpen);
        if (chevron) chevron.textContent = willOpen ? '⌃' : '⌄';
      });
      row.appendChild(log);
    }
    return row;
  }

  /** 把连续的多条步骤收进一个可折叠分组：执行过程 · N 步。 */
  function buildStepGroup(list, openStepKey) {
    const outer = el('div', 'ast-steps-wrap');
    const box = el('div', 'ast-steps');
    // 当前正在执行的那一步永远排在最上面，且收起时也保留可见（像豆包那样）。
    const runningIndex = list.findIndex(function (item) { return item.state === 'running'; });
    const preview = runningIndex >= 0 ? list[runningIndex] : null;
    const rest = runningIndex >= 0 ? list.filter(function (_item, i) { return i !== runningIndex; }) : list;
    const head = el('div', 'ast-steps-head');
    head.appendChild(el('span', 'ast-steps-title', '执行过程 · ' + list.length + ' 步'));
    const chevron = el('span', 'ast-steps-chevron', stepsGroupOpen ? '⌃' : '⌄');
    head.appendChild(chevron);
    const body = el('div', 'ast-steps-body' + (stepsGroupOpen ? '' : ' hidden'));
    for (const item of rest) {
      body.appendChild(buildStepRow(item, openStepKey));
    }
    head.addEventListener('click', function () {
      stepsGroupOpen = !stepsGroupOpen;
      applyStepsGroupOpen();
    });
    box.appendChild(head);
    if (preview) {
      box.appendChild(buildStepRow(preview, openStepKey));
    }
    box.appendChild(body);
    outer.appendChild(box);
    const collapse = el('button', 'ast-steps-collapse', stepsGroupOpen ? '收起执行过程' : '展开执行过程');
    collapse.type = 'button';
    collapse.addEventListener('click', function (ev) {
      ev.stopPropagation();
      stepsGroupOpen = !stepsGroupOpen;
      applyStepsGroupOpen();
      if (box.scrollIntoView) {
        box.scrollIntoView({ block: 'nearest' });
      }
    });
    outer.appendChild(collapse);
    return outer;
  }
  /** 把 "| a | b |" 拆成单元格。 */
  function splitPipeRow(line) {
    return String(line || '').trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (s) { return s.trim(); });
  }

  /** 从纯文本里识别一段 Markdown 管道表（blocks 通道也可能给文本）。 */
  function takePipeTable(text) {
    const lines = String(text || '').split('\n');
    for (let i = 0; i < lines.length - 1; i += 1) {
      if (!/^\s*\|/.test(lines[i])) { continue; }
      if (!/^\s*\|?\s*:?-{2,}/.test(lines[i + 1]) || lines[i + 1].indexOf('|') < 0) { continue; }
      const head = splitPipeRow(lines[i]);
      const rows = [];
      let j = i + 2;
      while (j < lines.length && /^\s*\|/.test(lines[j])) {
        rows.push(splitPipeRow(lines[j]));
        j += 1;
      }
      return {
        head: head,
        rows: rows,
        before: lines.slice(0, i).join('\n').trim(),
        after: lines.slice(j).join('\n').trim(),
      };
    }
    // 兜底：表格被压成一行（换行丢失）时，按分隔单元格数量分列还原
    const flat = String(text || '').replace(/\r?\n/g, ' ');
    const start = flat.indexOf('|');
    if (start >= 0) {
      const cells = flat.slice(start).split('|').map(function (s) { return s.trim(); }).filter(function (s, i, arr) {
        return !((i === 0 || i === arr.length - 1) && s === '');
      });
      const sepIdx = cells.findIndex(function (c) { return /^:?-{2,}:?$/.test(c); });
      if (sepIdx > 0) {
        const cols = sepIdx;
        const sepRun = cells.slice(sepIdx, sepIdx + cols);
        if (sepRun.length === cols && sepRun.every(function (c) { return /^:?-{2,}:?$/.test(c); })) {
          const head = cells.slice(0, cols);
          const rest = cells.slice(sepIdx + cols);
          const rows = [];
          // 行之间常用空单元格（| |）分隔：先按空单元格切行，没有再按列数分组
          const segments = [];
          let current = [];
          for (const cell of rest) {
            if (cell === '') {
              if (current.length) {
                segments.push(current);
                current = [];
              }
              continue;
            }
            current.push(cell);
          }
          if (current.length) {
            segments.push(current);
          }
          if (segments.length > 1) {
            for (const seg of segments) {
              const row = seg.slice();
              while (row.length < cols) {
                row.push('');
              }
              rows.push(row.slice(0, cols));
            }
          } else {
            for (let i = 0; i + cols <= rest.length; i += cols) {
              rows.push(rest.slice(i, i + cols));
            }
          }
          if (rows.length) {
            return { head: head, rows: rows, before: flat.slice(0, start).trim(), after: '' };
          }
        }
      }
    }
    return null;
  }

  /** 渲染表格（两种通道共用）。 */
  function buildAstTable(head, rows) {
    const table = document.createElement('table');
    table.className = 'ast-table';
    const thead = document.createElement('thead');
    const tr = document.createElement('tr');
    for (const cell of head || []) {
      const th = document.createElement('th');
      th.textContent = cell;
      tr.appendChild(th);
    }
    thead.appendChild(tr);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const row of rows || []) {
      const bodyRow = document.createElement('tr');
      for (const cell of row) {
        const td = document.createElement('td');
        td.textContent = cell;
        bodyRow.appendChild(td);
      }
      tbody.appendChild(bodyRow);
    }
    table.appendChild(tbody);
    return table;
  }
  /** 行内 Markdown + 管道表混合渲染（流式输出用）。 */
  function renderMarkdownWithTables(text) {
    const frag = document.createDocumentFragment();
    let rest = String(text || '');
    for (let guard = 0; guard < 20; guard += 1) {
      const pipe = takePipeTable(rest);
      if (!pipe) {
        frag.appendChild(markdown(rest));
        break;
      }
      if (pipe.before) {
        frag.appendChild(markdown(pipe.before));
      }
      frag.appendChild(buildAstTable(pipe.head, pipe.rows));
      rest = pipe.after || '';
      if (!rest.trim()) {
        break;
      }
    }
    return frag;
  }

  /** Claude Code 风格：输出块统一折叠头（代码 / 表格）。 */
  const foldedBlockKeys = new Set();
  let foldsAllClosed = false;
  function foldBlock(title, meta, content, key) {
    const card = el('div', 'ast-fold');
    const head = el('div', 'ast-fold-head');
    head.appendChild(el('span', 'ast-fold-title', title));
    if (meta) {
      head.appendChild(el('span', 'ast-fold-meta', meta));
    }
    const closed = foldsAllClosed || foldedBlockKeys.has(key);
    const chevron = el('span', 'ast-fold-chevron', closed ? '⌄' : '⌃');
    head.appendChild(chevron);
    const body = el('div', 'ast-fold-body' + (closed ? ' hidden' : ''));
    body.appendChild(content);
    head.addEventListener('click', function () {
      const hidden = body.classList.toggle('hidden');
      if (hidden) {
        foldedBlockKeys.add(key);
      } else {
        foldedBlockKeys.delete(key);
      }
      chevron.textContent = hidden ? '⌄' : '⌃';
    });
    card.appendChild(head);
    card.appendChild(body);
    return card;
  }

  function setAllFolds(wrap, open) {
    foldsAllClosed = !open;
    // 直接按顶层子节点操作：即使旧消息没有 ast-msg-content 标记也能折叠
    for (const child of Array.from(wrap.children)) {
      if (child.classList.contains('ast-fold-bar')) {
        continue;
      }
      child.classList.toggle('hidden', !open);
    }
    for (const node of wrap.querySelectorAll('.ast-msg-content')) {
      node.classList.toggle('hidden', !open);
    }
    for (const body of wrap.querySelectorAll('.ast-fold-body')) {
      body.classList.toggle('hidden', !open);
    }
    for (const chev of wrap.querySelectorAll('.ast-fold-chevron')) {
      chev.textContent = open ? '⌃' : '⌄';
    }
    if (open) {
      foldedBlockKeys.clear();
    }
    stepsGroupOpen = open;
    applyStepsGroupOpen();
  }

  var FILE_RE = /((?:[A-Za-z]:[\\/][^\s"'<>|]+?|\/[\w./-]+?|(?:[\w.-]+[\\/])*[\w.-]+\.(?:ts|tsx|js|jsx|json|md|py|cpp|hpp|h|cs|rs|go|java|kt|css|html|yml|yaml|toml|sh|ps1|txt))(:(\d+))?)(?=\s|$|[,;)，。、])/g;

  /** 把正文/步骤里的「文件:行」变成可点击链接（不处理代码块内）。 */
  function linkifyFiles(root) {
    if (!root || typeof document.createTreeWalker !== 'function') {
      return;
    }
    var walker = document.createTreeWalker(root, 4, null, false);
    var texts = [];
    var node;
    while ((node = walker.nextNode())) {
      var parent = node.parentElement;
      if (!parent || parent.closest('a, pre, code')) {
        continue;
      }
      if (!FILE_RE.test(node.nodeValue || '')) {
        FILE_RE.lastIndex = 0;
        continue;
      }
      FILE_RE.lastIndex = 0;
      texts.push(node);
    }
    for (const textNode of texts) {
      var value = textNode.nodeValue || '';
      var frag = document.createDocumentFragment();
      var last = 0;
      var match;
      while ((match = FILE_RE.exec(value))) {
        var full = match[1];
        var line = match[3] ? Number(match[3]) : 0;
        if (match.index > last) {
          frag.appendChild(document.createTextNode(value.slice(last, match.index)));
        }
        var link = el('a', 'file-link', full);
        link.href = '#';
        link.setAttribute('data-path', match[2] ? full.slice(0, full.lastIndexOf(':')) : full);
        link.setAttribute('data-line', String(line));
        link.title = '打开 ' + full;
        frag.appendChild(link);
        last = match.index + full.length;
      }
      FILE_RE.lastIndex = 0;
      if (last < value.length) {
        frag.appendChild(document.createTextNode(value.slice(last)));
      }
      if (textNode.parentNode) {
        textNode.parentNode.replaceChild(frag, textNode);
      }
    }
  }

  function ensureFoldBar(wrap) {
    if (!wrap) {
      return;
    }
    const existing = wrap.querySelector('.ast-fold-bar');
    const hasFold = wrap.querySelector('.ast-msg-content') || wrap.querySelector('.ast-fold') || wrap.querySelector('.ast-steps');
    if (!hasFold) {
      if (existing) {
        existing.remove();
      }
      return;
    }
    if (existing) {
      return;
    }
    const bar = el('div', 'ast-fold-bar');
    const collapse = el('button', 'ast-fold-all', '全部收起');
    collapse.type = 'button';
    collapse.addEventListener('click', function () {
      setAllFolds(wrap, false);
    });
    const expand = el('button', 'ast-fold-all', '全部展开');
    expand.type = 'button';
    expand.addEventListener('click', function () {
      setAllFolds(wrap, true);
    });
    bar.appendChild(collapse);
    bar.appendChild(expand);
    wrap.insertBefore(bar, wrap.firstChild);
  }

  /* ================= AST 渲染：标题 / 列表 / 表格 / 代码 ================= */

  function renderAst(blocks) {
    if (!Array.isArray(blocks) || blocks.length === 0) {
      return;
    }
    // 命令后面紧跟的段落 = 该命令的输出，挂到命令行里折叠展示
    const mergedBlocks = [];
    for (let i = 0; i < blocks.length; i += 1) {
      const cur = blocks[i];
      const next = blocks[i + 1];
      // 只有「较长的一段」才当作命令输出；短句仍按普通段落渲染
      const nextLen = next && next.kind === 'paragraph' ? String(next.text || '').trim().length : 0;
      if (cur && cur.kind === 'code' && cur.isCommand && next && next.kind === 'paragraph' && nextLen >= 40) {
        mergedBlocks.push(Object.assign({}, cur, { output: next.text || '' }));
        i += 1;
        continue;
      }
      mergedBlocks.push(cur);
    }
    blocks = mergedBlocks;
    finishAssistant();
    // 记录展开的执行过程列表：重渲染（下一条执行焦点）后保持原来的展开/收起状态。
    const stepKeys = [];
    for (let si = 0; si < blocks.length; si += 1) {
      if (blocks[si] && blocks[si].kind === 'step') {
        stepKeys.push(stepKey(blocks[si]));
      }
    }
    const lastStepKey = stepKeys.length ? stepKeys[stepKeys.length - 1] : '';
    const openStepKey = stepLogOpen && lastStepKey
      ? (stepKeys.indexOf(stepLogAnchor) >= 0 ? stepLogAnchor : lastStepKey)
      : '';
    // 注意：不能用 `.ast-blocks:last-child` —— 计时分隔线在忙时会被移到对话最底部，
    // 此时 .ast-blocks 不是 last-child，每次都匹配失败 → 每秒追加一份完整分块（整段内容重复）。
    // 只认“本轮自己的容器”：发送新一轮时 send() 会把 nativeBlocksWrap 置空，
    // 这里就新建一个，绝不去接管上一轮的容器（否则会把上一条回答覆盖掉）。
    let wrap = nativeBlocksWrap && nativeBlocksWrap.isConnected ? nativeBlocksWrap : null;
    if (!wrap) {
      wrap = el('div', 'ast-blocks');
      messagesEl.appendChild(wrap);
    }
    nativeBlocksWrap = wrap;
    // 更新会重建 DOM：先记住执行列表内部滚动位置，避免用户往回翻时被重置到顶部
    const prevStepsBody = wrap.querySelector('.ast-steps-body');
    const prevStepsScroll = prevStepsBody ? prevStepsBody.scrollTop : 0;
    const distance = (messagesEl.scrollHeight || 0) - (messagesEl.scrollTop || 0) - (messagesEl.clientHeight || 0);
    const wasNearBottom = distance < 80;
    wrap.innerHTML = '';
    for (let bi = 0; bi < blocks.length; bi += 1) {
      const block = blocks[bi];
      if (!block) {
        continue;
      }
      try {
      if (block.kind === 'step') {
        const run = [];
        while (bi < blocks.length && blocks[bi] && blocks[bi].kind === 'step') {
          run.push(blocks[bi]);
          bi += 1;
        }
        bi -= 1;
        // 一组步骤后面还有步骤时，这一组不单独渲染：执行过程只保留最下面最新的那一组，
        // 否则每段文字之间都会重复出现一份同样的历史列表。
        const hasLaterSteps = blocks.some(function (b, idx) {
          return idx > bi && b && b.kind === 'step';
        });
        if (hasLaterSteps) {
          continue;
        }
        // 豆包执行中往往只把「当前这一步」放进 DOM；分组用本轮累计历史 + 当前运行中的步骤，
        // 否则标题会永远停在「1 步」。
        const merged = stepHistory.map(function (s) {
          return { kind: 'step', text: s.text, state: s.state, icon: s.icon, images: s.images };
        });
        for (const item of run) {
          if (!merged.some(function (m) { return stepKey(m) === stepKey(item); })) {
            merged.push(item);
          }
        }
        // 快照本身完整时按快照顺序；只有快照被豆包折叠成更少步骤时才拼接历史
        const list = stepHistory.length > run.length ? merged : run;
        wrap.appendChild(buildStepGroup(list, openStepKey));
        continue;
      }
      if (block.kind === 'heading') {
        const h = el('div', 'ast-h ast-h' + Math.min(6, block.level || 2));
        h.textContent = block.text || '';
        wrap.appendChild(h);
      } else if (block.kind === 'list') {
        const list = document.createElement(block.ordered ? 'ol' : 'ul');
        list.className = 'ast-list';
        for (const item of block.items || []) {
          const li = document.createElement('li');
          li.className = 'ast-li lv' + Math.min(3, item.level || 0);
          li.textContent = item.text || '';
          list.appendChild(li);
        }
        wrap.appendChild(list);
      } else if (block.kind === 'table') {
        wrap.appendChild(
          foldBlock('表格', ((block.rows || []).length || 0) + ' 行', buildAstTable(block.head, block.rows), 'table|' + JSON.stringify(block.head || []).slice(0, 40)),
        );
      } else if (block.kind === 'code') {
        const isCmd = Boolean(block.isCommand);
        const box = el('div', isCmd ? 'ast-cmd' : 'ast-code');
        if (isCmd) {
          // 命令结果保持单行 `</> 命令` 样式，整行可点击复制命令原文。
          box.title = '点击复制命令';
          box.appendChild(el('span', 'tool-line-chip', '</>'));
          box.appendChild(el('span', 'ast-cmd-text', block.text || ''));
          if (block.output) {
            const tip = el('button', 'ast-cmd-toggle', '输出');
            tip.type = 'button';
            tip.title = '展开/收起输出';
            const out = el('pre', 'ast-cmd-out hidden');
            out.textContent = String(block.output);
            tip.addEventListener('click', function (ev) {
              ev.stopPropagation();
              out.classList.toggle('hidden');
            });
            box.appendChild(tip);
            box.appendChild(out);
          }
          box.addEventListener('click', function () {
            Promise.resolve(copyText(String(block.text || ''))).catch(function () {
              /* 复制失败时保持静默，不打断对话 */
            });
          });
        } else {
          const pre = document.createElement('pre');
          pre.textContent = block.text || '';
          box.appendChild(pre);
          if (block.lang) {
            box.setAttribute('data-lang', block.lang);
          }
          const copyBtn = el('button', 'ast-code-copy', '复制');
          copyBtn.type = 'button';
          copyBtn.title = '复制代码';
          copyBtn.addEventListener('click', function () {
            Promise.resolve(copyText(String(block.text || ''))).then(function () {
              copyBtn.textContent = '已复制';
              copyBtn.classList.add('copied');
              setTimeout(function () {
                copyBtn.textContent = '复制';
                copyBtn.classList.remove('copied');
              }, 1200);
            }).catch(function () {
              copyBtn.textContent = '复制失败';
              setTimeout(function () {
                copyBtn.textContent = '复制';
              }, 1200);
            });
          });
          box.appendChild(copyBtn);
        }
        if (isCmd) {
          wrap.appendChild(box);
        } else {
          const codeLines = String(block.text || '').split('\n').length;
          const codeKey = 'code|' + String(block.text || '').slice(0, 40);
          wrap.appendChild(
            foldBlock(block.lang ? String(block.lang).toUpperCase() : '代码', codeLines + ' 行', box, codeKey),
          );
        }
      } else if (block.kind === 'status') {
        wrap.appendChild(el('div', 'block-status', block.text || ''));
      } else {
        const pipe = takePipeTable(block.text || '');
        if (pipe) {
          if (pipe.before) {
            const before = el('div', 'ast-p');
            before.appendChild(markdown(pipe.before));
            wrap.appendChild(before);
          }
          wrap.appendChild(
            foldBlock('表格', (pipe.rows.length || 0) + ' 行', buildAstTable(pipe.head, pipe.rows), 'table|' + JSON.stringify(pipe.head || []).slice(0, 40)),
          );
          if (pipe.after) {
            const after = el('div', 'ast-p');
            after.appendChild(markdown(pipe.after));
            wrap.appendChild(after);
          }
        } else {
          const p = el('div', 'ast-p');
          p.appendChild(markdown(block.text || ''));
          wrap.appendChild(p);
        }
      }
      } catch (err) {
        // 某一块渲染失败（图标/SVG 等异常）不能拖累后面的步骤和正文：退化成纯文本。
        const p = el('div', 'ast-p');
        p.textContent = String(block.text || '');
        if (block.kind === 'step') {
          p.classList.add('ast-step-fallback');
        }
        wrap.appendChild(p);
      }
    }
    messagesEl.appendChild(wrap);
    // 非执行过程的输出内容：统一打标，供「全部收起/全部展开」操作
    for (const child of Array.from(wrap.children)) {
      if (child.classList.contains('ast-fold-bar')) {
        continue;
      }
      child.classList.add('ast-msg-content');
      if (foldsAllClosed) {
        child.classList.add('hidden');
      }
    }
    ensureFoldBar(wrap);
    linkifyFiles(wrap);
    // 执行列表内部滚动位置恢复（用户往回翻时不被更新重置到顶部）
    const nextStepsBody = wrap.querySelector('.ast-steps-body');
    if (nextStepsBody && prevStepsScroll) {
      nextStepsBody.scrollTop = prevStepsScroll;
    }
    // 挂载后再量高度：超长段落/列表/表格折叠到 12 行，底部给「展开全部」。
    for (const child of Array.from(wrap.children)) {
      applyAstFold(child);
    }
    // 只有原本就贴着底部时才跟随；用户上翻查看时不要把他拽回最下面
    if (wasNearBottom) {
      scrollToBottom();
    }
  }

  function echoUserMessage(text, echoImages) {
    const content = String(text || '').trim();
    if (!content) {
      return;
    }
    lastLocalEcho = { text: content, at: Date.now() };
    nativeBlocksWrap = null;
    statusEl.textContent = '已发送，等待豆包响应…';
    lastSentText = content;
    turnTools = 0;
    turnText = '';
    turnStartedAt = 0;
    beginTurnDivider();
    renderAttachments([]);
    const body = addMessage('user', content, echoImages);
    lastLocalBubble = body && body.closest ? body.closest('.msg').querySelector('.msg-bubble') : null;
    startAssistant();
    showPending('正在思考');
    const wrap = body && body.closest ? body.closest('.msg') : null;
    if (wrap && wrap.scrollIntoView) {
      wrap.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } else {
      scrollToBottom();
    }
  }

  function send() {
    clearAutoContinue();
    let text = inputEl.value.trim();
    if (!text && suggestContinue && !busy) {
      // 输入框空着回车：直接把提示里的「继续说」发出去
      text = '继续说';
    }
    if (!text) {
      return;
    }
    suggestContinue = false;
    echoUserMessage(text, []);
    // 生成中也照样发出去：面板侧会回显 + 排队，等上一轮结束自动执行。
    vscode.postMessage({ type: 'user', text: text, refs: { currentFile: refs.currentFile, selection: refs.selection, diagnostics: refs.diagnostics } });
    inputEl.value = '';
    inputEl.style.height = '';
    inputEl.placeholder = (currentMode === 'local'
      ? '发消息或创建任务… Enter 执行，Shift+Enter 换行'
      : '问点什么，Enter 发送，Shift+Enter 换行') + ' · 继续说：让豆包接着当前任务继续';
    if (busy) {
      statusEl.textContent = '已发送，排队等当前任务结束';
    }
  }

  sendBtn.addEventListener('click', send);
  inputEl.addEventListener('keydown', function () { clearAutoContinue(); });
  inputEl.addEventListener('keydown', function (event) {
    if (event.key === '@' && !event.shiftKey) {
      event.preventDefault();
      requestWorkspaceFiles();
    }
  });
  stopBtn.addEventListener('click', function () {
    clearAutoContinue();
    vscode.postMessage({ type: 'abort' });
  });
  newBtn.addEventListener('click', function () {
    vscode.postMessage({ type: 'newChat' });
  });
  if (historyBtn) {
    historyBtn.addEventListener('click', function () {
      openHistoryManager();
    });
  }
  if (taskBtn) {
    taskBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'newTask' });
      inputEl.focus();
    });
  }

  if (quickChatEl) {
    Array.from(quickChatEl.querySelectorAll('[data-chat-action]')).forEach(function (button) {
      button.addEventListener('click', function () {
        applyQuickAction(button.getAttribute('data-chat-action') || '');
      });
    });
  }
  if (chipMode) {
    chipMode.addEventListener('click', openModeMenu);
  }
  chipPermission.addEventListener('click', openPermissionMenu);
  chipProject.addEventListener('click', function () { vscode.postMessage({ type: 'revealProject' }); });
  chipSkills.addEventListener('click', function () {
    showPendingDelayed('正在同步技能'); vscode.postMessage({ type: 'listSkills' }); });
  if (chipPlugins) {
    chipPlugins.addEventListener('click', function () { vscode.postMessage({ type: 'listPlugins' }); });
  }
  chipModel.addEventListener('click', function () { vscode.postMessage({ type: 'listModels' }); });
  plusBtn.addEventListener('click', function () {
    vscode.postMessage({ type: 'pickFiles' });
  });

  messagesEl.addEventListener('click', function (event) {
    var linkEl = event.target;
    while (linkEl && linkEl !== messagesEl && !(linkEl.classList && linkEl.classList.contains('file-link'))) {
      linkEl = linkEl.parentElement;
    }
    if (linkEl && linkEl.classList && linkEl.classList.contains('file-link')) {
      event.preventDefault();
      vscode.postMessage({
        type: 'openFile',
        path: linkEl.getAttribute('data-path') || '',
        line: Number(linkEl.getAttribute('data-line') || '0'),
      });
    }
  });
  document.addEventListener('mousedown', function (event) {
    if (popup && !popup.contains(event.target)) {
      closePopup();
    }
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      closePopup();
    }
  });
  window.addEventListener('resize', closePopup);

  inputEl.addEventListener('keydown', function (event) {
    if (event.key === '/' && !event.shiftKey && inputEl.value.trim() === '') {
      event.preventDefault();
      openSlashMenu();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });

  inputEl.addEventListener('input', function () {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(160, inputEl.scrollHeight) + 'px';
  });

  window.addEventListener('message', function (event) {
    const message = event.data;
    if (!message || typeof message.type !== 'string') {
      return;
    }
    switch (message.type) {
      case 'user': {
          suggestContinue = false;
        const incoming = String(message.text || '').trim();
        if (incoming === lastLocalEcho.text && Date.now() - lastLocalEcho.at < 5000) {
          // 本地已经画过这条：把扩展侧带来的图片/文件补上去
          if (lastLocalBubble) {
            if (Array.isArray(message.images) && message.images.length && !lastLocalBubble.querySelector('.bubble-images')) {
              const box = el('div', 'bubble-images');
              for (const src of message.images) {
                const pic = document.createElement('img');
                pic.src = src;
                pic.alt = '粘贴的图片';
                box.appendChild(pic);
              }
              lastLocalBubble.insertBefore(box, lastLocalBubble.firstChild);
            }
            if (Array.isArray(message.files) && message.files.length && !lastLocalBubble.querySelector('.bubble-files')) {
              const box = el('div', 'bubble-files');
              for (const name of message.files) {
                const chip = el('span', 'bubble-file');
                chip.appendChild(el('span', 'bubble-file-icon', '📎'));
                chip.appendChild(el('span', 'bubble-file-name', String(name)));
                box.appendChild(chip);
              }
              lastLocalBubble.insertBefore(box, lastLocalBubble.firstChild);
            }
          }
          break;
        }
        nativeBlocksWrap = null;
        statusEl.textContent = '已发送，等待豆包响应…';
        lastSentText = String(message.text || '');
        turnTools = 0;
        turnText = '';
        turnStartedAt = 0;
        beginTurnDivider();
        renderAttachments([]);
        const userBody = addMessage('user', message.text, message.images, message.files);
        startAssistant();
        showPending('正在思考');
        // 先保证自己的话在视野里（顶部对齐），后续回答再自然往下推
        const userWrap = userBody && userBody.closest ? userBody.closest('.msg') : null;
        if (userWrap && userWrap.scrollIntoView) {
          userWrap.scrollIntoView({ block: 'start', behavior: 'smooth' });
        } else {
          scrollToBottom();
        }
        break;
      }
      case 'assistant_delta':
        clearAutoContinue();
        // 同一用户轮里的后续输出（PTC 多轮）可能紧跟在一次「共用时」之后：
        // 还有正文进来就说明没结束，把计时恢复成「已处理」。
        if (turnFinished) {
          turnFinished = false;
          if (turnDivider && turnDivider.isConnected && !turnDividerTimer) {
            turnDividerTimer = setInterval(tickTurnDivider, 500);
            tickTurnDivider();
          }
        }
        if (!streamingBody) {
          startAssistant();
        }
        if (pendingRow) {
          showPending(null);
        }
        streamingBuffer += message.text;
        turnText += message.text;
        scheduleStreamingRender();
        break;
      case 'assistant_done':
        finishAssistant(true);
        finishPending();
        suggestContinue = true;
        inputEl.placeholder = (currentMode === 'local'
          ? '发消息或创建任务… Enter 执行，Shift+Enter 换行'
          : '问点什么，Enter 发送，Shift+Enter 换行') + ' · 继续说：让豆包接着当前任务继续';
        // autoSuppress：面板已经排队了「继续说」，不要再让 webview 5 秒后重复发一次
        if (!message.autoSuppress) {
          addSuggestions(suggestFor(turnText, turnTools));
        }
        break;
      case 'tool_start':
        toolStart(message.id, message.name, message.arguments);
        break;
      case 'tool_end':
        toolEnd(message.id, message.name, message.ok, message.content);
        break;
      case 'ask':
        renderAskCard(message.question);
        break;
      case 'image':
        addImage(message.url, message.full, message.alt);
        break;
      case 'generating':
        if (message.text) {
          statusEl.textContent = message.text;
          showPending(message.text);
        } else {
          hidePending();
        }
        break;
      case 'error':
        hideHistoryLoading();
        finishAssistant();
        hidePending();
        addError(message.message);
        break;
      case 'clear':
        if (sourcesCardEl) { sourcesCardEl.remove(); sourcesCardEl = null; }
        if (taskStripEl) { taskStripEl.innerHTML = ''; taskStripEl.classList.add('hidden'); }
        clearAutoContinue();
        hidePending();
        clearAll();
        break;
      case 'state':
        applyState(message);
        break;
      case 'setup':
        cancelPendingDelayed();
        renderSetup(message.state);
        break;
      case 'mcpState': {
        const st = message.state || {};
        const finished = st.finished === true || st.phase === 'done' || st.phase === 'failed';
        syncBusyIndicator(!finished);
        if (st.summary && turnDividerLabel) {
          turnDividerLabel.textContent = String(st.summary);
        } else if (typeof st.elapsed_seconds === 'number' && turnDividerLabel) {
          turnDividerLabel.textContent = '已处理 ' + Math.round(st.elapsed_seconds) + ' 秒';
        }
        if (st.command) {
          statusEl.textContent = '正在执行：' + String(st.command).slice(0, 80);
        }
        break;
      }
      case 'ast':
        renderAst(message.blocks);
        break;
      case 'syncStatus': {
        // 豆包界面上的同步状态原样透传：已处理 5 分 52 秒 / 共用时 4 分 55 秒
        const text = String(message.text || '');
        const secs = typeof message.seconds === 'number' ? message.seconds : -1;
        const finished = message.done === true || /^共用时/.test(text);
        turnFinished = finished;
        if (secs >= 0) {
          turnReportedSeconds = secs;
          turnReportedAt = Date.now();
        }
        if (!turnDivider || !turnDivider.isConnected) {
          ensureTurnDivider(turnContentAnchor());
        }
        if (turnDividerLabel) {
          turnDividerLabel.textContent = text || ('已处理 ' + humanElapsed(Math.max(1, secs)));
        }
        if (finished) {
          // 回合结束：把还挂着“正在…”的步骤从当前列表移除，只保留执行结果。
          const cleaned = lastBlocks.filter(function (b) { return !(b && b.kind === 'step' && b.state === 'running'); });
          if (cleaned.length !== lastBlocks.length) {
            renderNativeBlocks(cleaned);
          }
        }
        syncBusyIndicator(!finished);
        if (finished) {
          hideRunningBar();
        } else {
          showRunningBar(secs);
        }
        if (finished && turnDividerTimer) {
          clearInterval(turnDividerTimer);
          turnDividerTimer = null;
        }
        break;
      }
      case 'blocks':
        renderNativeBlocks(message.blocks);
        break;
      case 'block':
        addNativeBlock(message.kind, message.text);
        break;
      case 'round':
        hidePending();
        addRoundBlock(message.index || 0, message.plan || []);
        break;
      case 'attachments':
        cancelPendingDelayed();
        renderAttachments(message.items);
        break;
      case 'historyMenu':
        renderHistoryManager(message);
        break;
      case 'history':
        renderHistory(message);
        break;
      case 'tabs':
        renderTabs(message.tabs);
        break;
      case 'syncLoading':
        renderSyncLoading(message);
        break;
      case 'proposal':
        renderProposal(message);
        break;
      case 'tasks':
        renderTasks(message.tasks);
        break;
      case 'sources':
        renderSources(message.items);
        break;
      case 'contextInfo':
        contextTokens = Number(message.total || 0);
        if (contextHint && Array.isArray(message.items) && message.items.length > 0) {
          contextHint.title = message.items.map(function (item) { return item.label + ' ≈ ' + item.tokens + ' tokens'; }).join('\n');
        }
        updateContextHint();
        break;
      case 'workspaceFiles':
        workspaceFilesCache = Array.isArray(message.files) ? message.files : [];
        if (fileMenuPending) {
          fileMenuPending = false;
          openFileMentionMenu();
        }
        break;
      case 'verifyStart':
        renderGenerating((message.kind === 'test' ? '正在运行测试' : '正在构建') + '…');
        break;
      case 'verifyResult':
        renderVerify(message);
        break;
      case 'modelMenu':
        openModelMenu(message);
        break;
      case 'skillMenu':
        openSkillMenu(message.groups, message.ok);
        break;
      case 'pluginMenu':
        openPluginMenu(message.plugins, message.ok);
        break;
      case 'notice':
        if (!busy) {
          statusEl.textContent = message.text;
        }
        break;
      case 'catalog':
        catalog = { skills: message.skills || [], plugins: message.plugins || [] };
        renderQuickSkills();
        if (slashPending) {
          slashPending = false;
          openSlashMenu();
        }
        break;
      default:
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
