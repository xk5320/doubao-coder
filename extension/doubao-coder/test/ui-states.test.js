/**
 * 回归测试：锁住对话区的 24 类状态渲染 + 关键渲染函数存在性。
 *
 * 背景：media/chat.js 是 IIFE 纯 JS，直接用 document / window。项目没有 jsdom，
 * 所以用 test/dom-harness.js 里手写的最小 DOM 宿主，在 node:vm 中执行 chat.js，
 * 再向 window 派发消息，断言真实渲染出来的类名 / 文本 / 结构。
 *
 * 用法：node test/ui-states.test.js（工作目录：扩展根目录）
 *
 * 注意：本文件只读 media/chat.js，不修改任何产品代码。
 */

'use strict';

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

function textOf(node) {
  return node ? String(node.textContent || '') : '';
}

function hasText(node, expected) {
  return textOf(node).indexOf(expected) >= 0;
}

const chatPath = path.join(__dirname, '..', 'media', 'chat.js');
const source = fs.readFileSync(chatPath, 'utf8');
const harness = createHarness();

/* ------------------------------ 启动 ------------------------------ */

let bootError = null;
try {
  harness.load(source, chatPath);
} catch (err) {
  bootError = err;
}
check('启动：chat.js 在伪 DOM 中执行不抛错', !bootError, bootError && (bootError.stack || String(bootError)));
check('启动：#messages 与 #empty 存在且 #empty 在对话区里', Boolean(harness.byId('messages') && harness.byId('empty') && harness.messages.contains(harness.empty)));
check('启动：向扩展发送 ready', harness.posted.some(function (item) { return item && item.type === 'ready'; }), JSON.stringify(harness.posted));

const dispatchErrors = [];
function dispatch(message) {
  const errors = harness.send(message);
  for (const err of errors) {
    dispatchErrors.push({ type: message.type, error: err });
    console.log('  !!  分派 ' + message.type + ' 时抛错：' + (err && err.stack ? err.stack : String(err)));
  }
}

/* ------------------------------ 1. 用户消息 ------------------------------ */

// 说明：真实本地发送时 send() 会先 echoUserMessage() 写入 lastLocalEcho，
// 扩展侧随后（5 秒内）回显同一条 user 会命中 lastLocalBubble，把附件补进去。
// 本用例按任务要求「直接派发」，验证渲染器对 user 消息本身的完整支持，
// 因此下面的 attachments 断言若失败，是产品代码的真实缺口，不是 harness 限制。
dispatch({
  type: 'user',
  text: '你好',
  at: 1,
  images: ['data:image/png;base64,AAA'],
  files: ['a.json'],
});
check('user：出现 .msg-user 气泡', Boolean(harness.query('.msg-user')));
check('user：气泡文本为「你好」', hasText(harness.query('.msg-user .plain'), '你好'), 'plain=' + textOf(harness.query('.msg-user .plain')));
check(
  'user：出现 .bubble-images（图片）',
  Boolean(harness.query('.msg-user .bubble-images')),
  'chat.js 收到 user 消息时，仅当「文本命中 5 秒内的本地回显」才把 message.images 补进 lastLocalBubble；' +
    '直接派发（扩展侧/排队/超时到达）走的是 addMessage(user, text) 分支，images 被丢弃。',
);
check(
  'user：出现 .bubble-files（附件）',
  Boolean(harness.query('.msg-user .bubble-files')),
  '同上：message.files 只在本地回显分支被插入，直接派发的 user 消息不会渲染附件 chip。',
);

/* ------------------------------ 2. 正文流式 ------------------------------ */

dispatch({ type: 'assistant_delta', text: '正文' });
check('assistant_delta：出现 .msg-assistant', Boolean(harness.query('.msg-assistant')));
check('assistant_delta：正文写入气泡', hasText(harness.query('.msg-assistant'), '正文'), 'text=' + textOf(harness.query('.msg-assistant')));

/* ------------------------------ 3. AST：标题 ------------------------------ */

dispatch({ type: 'ast', blocks: [{ kind: 'heading', level: 2, text: '标题' }] });
check('ast heading：出现 .ast-h2', Boolean(harness.query('.ast-h2')), 'html=' + (harness.query('.ast-blocks') ? harness.query('.ast-blocks').innerHTML : '(无 .ast-blocks)'));
check('ast heading：文本为「标题」', hasText(harness.query('.ast-h2'), '标题'), 'text=' + textOf(harness.query('.ast-h2')));

/* ------------------------------ 4. AST：有序列表 ------------------------------ */

dispatch({ type: 'ast', blocks: [{ kind: 'list', ordered: true, items: [{ level: 0, text: '一' }] }] });
const listEl = harness.query('.ast-list');
check('ast list：出现 .ast-list', Boolean(listEl));
check('ast list：有序列表使用 <ol>', Boolean(listEl && listEl.tagName === 'OL'), 'tag=' + (listEl ? listEl.tagName : '(无)'));
const listItems = listEl ? listEl.querySelectorAll('li') : [];
check('ast list：渲染 li 项并保留文本', listItems.length === 1 && hasText(listItems[0], '一'), 'li 数量=' + listItems.length + '，text=' + textOf(listItems[0]));

/* ------------------------------ 5. AST：表格 ------------------------------ */

dispatch({ type: 'ast', blocks: [{ kind: 'table', head: ['A'], rows: [['1']] }] });
check('ast table：出现 .ast-table', Boolean(harness.query('.ast-table')));
check('ast table：表头 th 文本为「A」', hasText(harness.query('.ast-table th'), 'A'), 'th=' + textOf(harness.query('.ast-table th')));
check('ast table：单元格 td 文本为「1」', hasText(harness.query('.ast-table td'), '1'), 'td=' + textOf(harness.query('.ast-table td')));

/* ------------------------------ 6. AST：普通代码 ------------------------------ */

dispatch({ type: 'ast', blocks: [{ kind: 'code', text: 'x=1', lang: 'js' }] });
const codeBox = harness.query('.ast-code');
const codePre = codeBox ? codeBox.querySelector('pre') : null;
check('ast code：出现 .ast-code', Boolean(codeBox));
check('ast code：出现 pre 且代码为「x=1」', Boolean(codePre) && hasText(codePre, 'x=1'), 'pre=' + textOf(codePre));
check('ast code：data-lang 记录语言 js', Boolean(codeBox && codeBox.getAttribute('data-lang') === 'js'), 'data-lang=' + (codeBox ? codeBox.getAttribute('data-lang') : '(无)'));

/* ------------------------------ 7. AST：命令代码 ------------------------------ */

dispatch({ type: 'ast', blocks: [{ kind: 'code', text: 'dir', isCommand: true }] });
const cmdBox = harness.query('.ast-cmd');
check('ast cmd：出现 .ast-cmd', Boolean(cmdBox));
check('ast cmd：命令文本包含 dir', hasText(cmdBox, 'dir'), 'text=' + textOf(cmdBox));

/* ------------------------------ 8. AST：状态行 ------------------------------ */

dispatch({ type: 'ast', blocks: [{ kind: 'status', text: '已处理 3 秒' }] });
check('ast status：出现 .block-status', Boolean(harness.query('.block-status')));
check('ast status：文本为「已处理 3 秒」', hasText(harness.query('.block-status'), '已处理 3 秒'), 'text=' + textOf(harness.query('.block-status')));

/* ------------------------------ 9. 原生分块协议 ------------------------------ */

dispatch({ type: 'blocks', blocks: [{ kind: 'code', text: 'dir' }, { kind: 'text', text: '说明' }] });
check('blocks：code 分块渲染为 .ast-cmd', Boolean(harness.query('.ast-cmd')));
check('blocks：text 分块渲染为 .ast-p', Boolean(harness.query('.ast-p')));
check('blocks：说明文本写入 .ast-p', hasText(harness.query('.ast-p'), '说明'), 'text=' + textOf(harness.query('.ast-p')));

/* ------------- 9a2. 执行反馈图标：不同类型不同图标 ------------- */

dispatch({
  type: 'blocks',
  blocks: [
    { kind: 'step', text: '已执行代码 dir', state: 'done' },
    { kind: 'step', text: '已读取 C:\\a.txt', state: 'done' },
    { kind: 'step', text: '已查找文件内容 foo', state: 'done' },
    { kind: 'step', text: '已写入 a.ts', state: 'done' },
    { kind: 'step', text: '正在读取 b.txt', state: 'running' },
    { kind: 'step', text: '桌面授权超时', state: 'error' },
  ],
});
check('图标：代码步骤显示 </>', Boolean(harness.query('.ast-step-icon.icon-code')) && textOf(harness.query('.ast-step-icon.icon-code')) === '</>', 'text=' + textOf(harness.query('.ast-step-icon.icon-code')));
check('图标：读取步骤标成 read', Boolean(harness.query('.ast-step-icon.icon-read[data-icon="read"]')));
check('图标：查找步骤标成 search', Boolean(harness.query('.ast-step-icon.icon-search[data-icon="search"]')));
check('图标：写入步骤标成 edit', Boolean(harness.query('.ast-step-icon.icon-edit[data-icon="edit"]')));
check('图标：运行中显示转圈而不是静态图标', Boolean(harness.query('.ast-step-icon.icon-running .step-spin')));
check('图标：失败步骤显示感叹号', Boolean(harness.query('.ast-step-icon.icon-error')) && textOf(harness.query('.ast-step-icon.icon-error')) === '!');
/* ---------------------- 9b. 执行反馈（step）与同步状态 ---------------------- */

dispatch({ type: 'clear' });
dispatch({
  type: 'blocks',
  blocks: [
    { kind: 'step', text: '已执行代码 dir /b', state: 'done' },
    { kind: 'step', text: '正在执行代码 npm test', state: 'running' },
    { kind: 'step', text: '桌面授权超时', state: 'error' },
    { kind: 'text', text: '正文' },
  ],
});
const stepRows = harness.queryAll('.ast-step');
check('step：三条反馈各渲染成 .ast-step', stepRows.length === 3, 'count=' + stepRows.length);
check('step：标题单行文本写入', hasText(stepRows[0], '已执行代码 dir /b'), 'text=' + textOf(stepRows[0]));
check('step：running 态带 .is-running', stepRows.some(function (r) { return r.classList.contains('is-running'); }));
check('step：error 态带 .is-error', stepRows.some(function (r) { return r.classList.contains('is-error'); }));
check('step：正文仍渲染为 .ast-p', Boolean(harness.query('.ast-p')));

dispatch({ type: 'syncStatus', text: '已处理 5 分 52 秒', seconds: 352, done: false });
const turnLabel = harness.query('.turn-label');
check('syncStatus：计时分隔线文案与豆包一致', turnLabel && textOf(turnLabel).indexOf('5 分 52 秒') >= 0, 'label=' + textOf(turnLabel));
check('syncStatus：进行中保留动效', Boolean(harness.query('.turn-dots')));
dispatch({ type: 'syncStatus', text: '共用时 5 分 58 秒', seconds: 358, done: true });
check('syncStatus：结束后文案切到「共用时」', turnLabel && textOf(turnLabel).indexOf('共用时') === 0, 'label=' + textOf(turnLabel));

/* --------------- 9c. 计时器健壮性：没有回合时绝不能显示时间戳 --------------- */

// 复现：新建任务后扩展先报 busy（连接/切换会话中），此时还没有任何一条回复；
// 旧实现用 Date.now() - 0 当秒数，界面会显示「已处理 498624 小时…」。
dispatch({ type: 'clear' });
dispatch({ type: 'state', busy: true, mode: 'local', permission: 'risk', authMode: 'desktop', turns: 0 });
const freshLabel = harness.query('.turn-label');
check('busy 无回合：空对话不凭空造分隔线', !harness.query('.turn-divider'), 'html=' + (harness.byId('messages') ? harness.byId('messages').innerHTML.slice(0, 200) : ''));
check('busy 无回合：即使有计时也绝不出现「小时/分」级别的异常时长', !freshLabel || !/小时|分/.test(textOf(freshLabel)), 'label=' + textOf(freshLabel));

dispatch({ type: 'clear' });
check('clear：分隔线与计时文本一并清掉', !harness.query('.turn-divider') && !harness.query('.turn-label'));

/* ------------- 9c2. 回合结束后自动「继续说」（5 秒倒计时） ------------- */

harness.window.__DC_AUTO_CONTINUE_MS = 0;
dispatch({ type: 'state', busy: false, autoContinue: true, autoContinueSeconds: 5, mode: 'local', permission: 'risk', authMode: 'desktop', turns: 0 });
const beforeAuto = harness.posted.filter(function (m) { return m && m.type === 'user' && m.text === '继续说'; }).length;
dispatch({ type: 'assistant_done', aborted: false, at: Date.now() });
const afterAuto = harness.posted.filter(function (m) { return m && m.type === 'user' && m.text === '继续说'; }).length;
check('自动继续：回合结束后自动发送「继续说」', afterAuto === beforeAuto + 1, 'before=' + beforeAuto + ' after=' + afterAuto);

dispatch({ type: 'state', busy: false, autoContinue: false, autoContinueSeconds: 5, mode: 'local', permission: 'risk', authMode: 'desktop', turns: 0 });
const beforeOff = harness.posted.filter(function (m) { return m && m.type === 'user' && m.text === '继续说'; }).length;
dispatch({ type: 'assistant_done', aborted: false, at: Date.now() });
const afterOff = harness.posted.filter(function (m) { return m && m.type === 'user' && m.text === '继续说'; }).length;
check('自动继续：关闭设置后不再自动发送', afterOff === beforeOff, 'count=' + afterOff);
delete harness.window.__DC_AUTO_CONTINUE_MS;
/* ---------- 9c3. 未发送（粘贴附件/同步技能）不能出现「已处理 0 秒」 ---------- */

dispatch({ type: 'clear' });
const postedBefore = harness.posted.length;
dispatch({ type: 'generating', text: '正在添加附件' });
check('未发送：粘贴附件不创建计时分隔线', !harness.query('.turn-divider') && !harness.query('.turn-label'));
check('未发送：也没有偷偷发送消息', harness.posted.length === postedBefore);

// 上一轮结束后，再贴附件也不能把「共用时」变成「已处理 0 秒」
dispatch({ type: 'user', text: '上一轮', at: Date.now() });
dispatch({ type: 'blocks', blocks: [{ kind: 'text', text: '回答' }] });
dispatch({ type: 'syncStatus', text: '共用时 1 分 0 秒', seconds: 60, done: true });
const finishedLabel = textOf(harness.query('.turn-label'));
dispatch({ type: 'generating', text: '正在添加附件' });
check('未发送：已结束的回合不会被附件改成「已处理 0 秒」', textOf(harness.query('.turn-label')) === finishedLabel, 'before=' + finishedLabel + ' after=' + textOf(harness.query('.turn-label')));
dispatch({ type: 'clear' });
/* ------------- 9c4. 点击步骤行展开本轮累计执行过程 ------------- */

dispatch({ type: 'clear' });
dispatch({ type: 'user', text: '展开执行过程', at: Date.now() });
dispatch({ type: 'blocks', blocks: [
  { kind: 'step', text: '第一步：查找文件', state: 'done', icon: 'search' },
  { kind: 'step', text: '第二步：读取文件', state: 'done', icon: 'read' },
] });
dispatch({ type: 'blocks', blocks: [{ kind: 'step', text: '第三步：读取完成', state: 'done', icon: 'code' }] });
const stepHeads = harness.queryAll('.ast-step-head');
const lastHead = stepHeads[stepHeads.length - 1];
check('步骤行：可点击（有展开箭头）', Boolean(harness.query('.ast-step-chevron')));
if (lastHead && lastHead.click) lastHead.click();
const log = harness.queryAll('.ast-step-log').filter(function (n) { return !n.classList.contains('hidden'); })[0];
check('步骤行：点击后展开累计执行过程', Boolean(log));
const logRows = harness.queryAll('.ast-step-log-row');
check('执行过程：包含本轮此前所有步骤', logRows.length >= 3, 'rows=' + logRows.length);
check('执行过程：包含第一步标题', logRows.some(function (r) { return textOf(r).indexOf('第一步') >= 0; }));
/* ------------- 9c5. 展开/收起状态在更新后保持 ------------- */

dispatch({ type: 'clear' });
dispatch({ type: 'user', text: '持久化测试', at: Date.now() });
dispatch({ type: 'blocks', blocks: [
  { kind: 'step', text: '甲：第一步', state: 'done', icon: 'search' },
  { kind: 'step', text: '乙：第二步', state: 'done', icon: 'read' },
] });
const openTarget = harness.queryAll('.ast-step-head');
if (openTarget.length && openTarget[openTarget.length - 1].click) openTarget[openTarget.length - 1].click();
dispatch({ type: 'blocks', blocks: [{ kind: 'step', text: '丙：新的焦点', state: 'running', icon: 'code' }] });
const logAfter = harness.queryAll('.ast-step-log').filter(function (n) { return !n.classList.contains('hidden'); })[0];
check('执行过程：更新后仍保持展开', Boolean(logAfter));
check('执行过程：更新后仍包含历史步骤', textOf(logAfter).indexOf('甲：第一步') >= 0, 'text=' + textOf(logAfter).slice(0, 80));

const openHead = harness.query('.ast-step.is-open .ast-step-head');
if (openHead && openHead.click) openHead.click();
dispatch({ type: 'blocks', blocks: [{ kind: 'step', text: '丁：再次更新', state: 'running', icon: 'code' }] });
const hiddenLog = harness.query('.ast-step-log');
check('执行过程：收起后更新保持收起', !hiddenLog || hiddenLog.classList.contains('hidden'));

dispatch({ type: 'user', text: '新一轮', at: Date.now() });
dispatch({ type: 'blocks', blocks: [{ kind: 'step', text: '新轮第一步', state: 'running', icon: 'code' }] });
const newTurnLog = harness.query('.ast-step-log');
check('执行过程：新一轮默认收起', !newTurnLog || newTurnLog.classList.contains('hidden'));
dispatch({ type: 'clear' });
/* ------------- 9c6. 连续步骤分组「执行过程 · N 步」默认为收起 ------------- */

dispatch({ type: 'clear' });
dispatch({ type: 'user', text: '分组测试', at: Date.now() });
dispatch({ type: 'blocks', blocks: [
  { kind: 'step', text: '甲：步骤一', state: 'done', icon: 'read' },
  { kind: 'step', text: '乙：步骤二', state: 'done', icon: 'code' },
  { kind: 'step', text: '丙：步骤三', state: 'running', icon: 'search' },
] });
const groupHead = harness.query('.ast-steps-head');
const groupBody = harness.query('.ast-steps-body');
check('步骤分组：出现「执行过程 · 3 步」', Boolean(groupHead) && textOf(groupHead).indexOf('3 步') >= 0, 'head=' + textOf(groupHead));
check('步骤分组：默认收起，列表隐藏', Boolean(groupBody) && groupBody.classList.contains('hidden'));
check('步骤分组：默认按钮为「展开执行过程」', textOf(harness.query('.ast-steps-collapse')).indexOf('展开执行过程') >= 0);
check('步骤分组：收起时当前步骤仍可见', Boolean(harness.query('.ast-step.is-running')));
if (groupHead && groupHead.click) groupHead.click();
check('步骤分组：点开后展开并显示 3 条', !harness.query('.ast-steps-body').classList.contains('hidden') && harness.query('.ast-steps').querySelectorAll('.ast-step').length === 3);
check('步骤分组：展开后按钮为「收起执行过程」', textOf(harness.query('.ast-steps-collapse')).indexOf('收起执行过程') >= 0);
dispatch({ type: 'blocks', blocks: [{ kind: 'step', text: '丁：步骤四', state: 'running', icon: 'code' }] });
check('步骤分组：更新后保持展开', !harness.query('.ast-steps-body').classList.contains('hidden'));
const groupHead2 = harness.query('.ast-steps-head');
if (groupHead2 && groupHead2.click) groupHead2.click();
check('步骤分组：再点后收起', harness.query('.ast-steps-body').classList.contains('hidden'));
dispatch({ type: 'blocks', blocks: [{ kind: 'step', text: '戊：步骤五', state: 'running', icon: 'code' }] });
check('步骤分组：更新后保持收起', harness.query('.ast-steps-body').classList.contains('hidden'));
// 时间线也可以折叠/展开
const dividerEl = harness.query('.turn-divider');
if (dividerEl && dividerEl.click) dividerEl.click();
check('步骤分组：点计时线可展开', !harness.query('.ast-steps-body').classList.contains('hidden'));
if (dividerEl && dividerEl.click) dividerEl.click();
check('步骤分组：再点计时线可收起', harness.query('.ast-steps-body').classList.contains('hidden'));
dispatch({ type: 'clear' });
/* ------------- 9c7. 「正在…」是瞬时状态，结束后不留在列表里 ------------- */

dispatch({ type: 'clear' });
dispatch({ type: 'user', text: '瞬时状态测试', at: Date.now() });
dispatch({ type: 'blocks', blocks: [
  { kind: 'step', text: '正在思考', state: 'running', icon: 'step' },
  { kind: 'step', text: '已读取 A', state: 'done', icon: 'read' },
  { kind: 'step', text: '已执行代码 B', state: 'done', icon: 'code' },
] });
const stepsNow = harness.queryAll('.ast-step');
check('瞬时状态：当前列表里仍显示正在执行的步骤', stepsNow.some(function (r) { return r.classList.contains('is-running'); }));
const doneHead = stepsNow.filter(function (r) { return !r.classList.contains('is-running'); })[0].querySelector('.ast-step-head');
if (doneHead && doneHead.click) doneHead.click();
const logNow = harness.query('.ast-step-log');
check('瞬时状态：展开列表里不包含过期的“正在思考”', Boolean(logNow) && textOf(logNow).indexOf('正在思考') < 0, 'log=' + textOf(logNow).slice(0, 80));
check('瞬时状态：展开列表保留执行结果', textOf(logNow).indexOf('已读取 A') >= 0 && textOf(logNow).indexOf('已执行代码 B') >= 0);

dispatch({ type: 'blocks', blocks: [
  { kind: 'step', text: '已读取 A', state: 'done', icon: 'read' },
  { kind: 'step', text: '正在调度资源', state: 'running', icon: 'step' },
] });
dispatch({ type: 'syncStatus', text: '共用时 1 分 0 秒', seconds: 60, done: true });
const leftRunning = harness.queryAll('.ast-step.is-running');
check('瞬时状态：回合结束后移除残留的“正在…”', leftRunning.length === 0, 'count=' + leftRunning.length);
check('瞬时状态：分组计数同步减少（历史结果保留）', textOf(harness.query('.ast-steps-head')).indexOf('2 步') >= 0, 'head=' + textOf(harness.query('.ast-steps-head')));
dispatch({ type: 'clear' });
/* ------------- 9c8. autoSuppress：面板已排队时 webview 不再自动发 ------------- */

dispatch({ type: 'clear' });
harness.window.__DC_AUTO_CONTINUE_MS = 0;
dispatch({ type: 'state', busy: false, autoContinue: true, autoContinueSeconds: 5, mode: 'local', permission: 'risk', authMode: 'desktop', turns: 0 });
const beforeSuppress = harness.posted.filter(function (m) { return m && m.type === 'user' && m.text === '继续说'; }).length;
dispatch({ type: 'assistant_done', aborted: false, at: Date.now(), autoSuppress: true });
const afterSuppress = harness.posted.filter(function (m) { return m && m.type === 'user' && m.text === '继续说'; }).length;
check('autoSuppress：不再重复自动发送「继续说」', afterSuppress === beforeSuppress, 'before=' + beforeSuppress + ' after=' + afterSuppress);
delete harness.window.__DC_AUTO_CONTINUE_MS;
dispatch({ type: 'clear' });
/* ------------- 9c9. 底部按钮：默认「展开」，展开后「收起」 ------------- */

dispatch({ type: 'clear' });
dispatch({ type: 'user', text: '底部收起', at: Date.now() });
dispatch({ type: 'blocks', blocks: [
  { kind: 'step', text: '甲：一步', state: 'done', icon: 'read' },
  { kind: 'step', text: '乙：二步', state: 'done', icon: 'code' },
  { kind: 'step', text: '丙：三步', state: 'running', icon: 'search' },
] });
const bottomBtn = harness.query('.ast-steps-collapse');
check('执行过程：底部按钮默认「展开执行过程」', Boolean(bottomBtn) && textOf(bottomBtn).indexOf('展开执行过程') >= 0);
check('执行过程：默认列表隐藏', harness.query('.ast-steps-body').classList.contains('hidden'));
if (bottomBtn && bottomBtn.click) bottomBtn.click();
check('底部展开：列表显示', !harness.query('.ast-steps-body').classList.contains('hidden'));
check('底部展开：按钮变「收起执行过程」', textOf(harness.query('.ast-steps-collapse')).indexOf('收起执行过程') >= 0);
harness.query('.ast-steps-collapse').click();
check('底部收起：列表隐藏', harness.query('.ast-steps-body').classList.contains('hidden'));
check('底部收起：按钮变回「展开执行过程」', textOf(harness.query('.ast-steps-collapse')).indexOf('展开执行过程') >= 0);
dispatch({ type: 'clear' });
/* ------------- 9c10. 执行中的当前条目带三个跳动点 ------------- */

dispatch({ type: 'clear' });
dispatch({ type: 'user', text: '动效', at: Date.now() });
dispatch({ type: 'blocks', blocks: [{ kind: 'step', text: '正在执行代码 dotnet build', state: 'running', icon: 'code' }] });
const runningRow = harness.query('.ast-step.is-running');
const dots = runningRow ? runningRow.querySelectorAll('.ast-step-dots i') : [];
check('执行中条目：标题后有三个点', Boolean(runningRow) && dots.length === 3, 'dots=' + dots.length);
dispatch({ type: 'clear' });
/* ------------- 9c11. 回合结束后输入框提示「继续说」，空回车直接发送 ------------- */

dispatch({ type: 'clear' });
dispatch({ type: 'state', busy: false, autoContinue: false, autoContinueSeconds: 5, mode: 'local', permission: 'risk', authMode: 'desktop', turns: 1 });
dispatch({ type: 'assistant_done', aborted: false, at: Date.now() });
check('输入框：结束后提示「继续说」并说明作用', String(harness.input.placeholder || '').indexOf('继续说') >= 0 && String(harness.input.placeholder || '').indexOf('接着') >= 0, 'placeholder=' + harness.input.placeholder);
check('输入框：结束后不默认填入（只留提示）', harness.input.value === '' || harness.input.value !== '继续说', 'value=' + harness.input.value);
harness.input.value = '';
dispatch({ type: 'state', busy: true, mode: 'local', permission: 'risk', authMode: 'desktop', turns: 1 });
check('输入框：执行中不默认填入（只留提示）', harness.input.value !== '继续说', 'value=' + harness.input.value);
check('输入框：执行中提示仍带「继续说」作用', String(harness.input.placeholder || '').indexOf('继续说') >= 0 && String(harness.input.placeholder || '').indexOf('接着') >= 0, 'placeholder=' + harness.input.placeholder);
dispatch({ type: 'state', busy: false, autoContinue: false, mode: 'local', permission: 'risk', authMode: 'desktop', turns: 1 });
harness.input.value = '';
const beforeHintSend = harness.posted.filter(function (m) { return m && m.type === 'user' && m.text === '继续说'; }).length;
const sendBtnEl = harness.byId('btn-send');
if (sendBtnEl && sendBtnEl.click) sendBtnEl.click();
const afterHintSend = harness.posted.filter(function (m) { return m && m.type === 'user' && m.text === '继续说'; }).length;
check('输入框：空着回车/点发送会发「继续说」', afterHintSend === beforeHintSend + 1, 'before=' + beforeHintSend + ' after=' + afterHintSend);
check('输入框：发送后提示仍带「继续说」作用', String(harness.input.placeholder || '').indexOf('继续说：让豆包接着') >= 0, 'placeholder=' + harness.input.placeholder);
dispatch({ type: 'clear' });
/* ------------- 9c12. 多个步骤段只保留最下面最新的一组 ------------- */

dispatch({ type: 'clear' });
dispatch({ type: 'user', text: '只留最新组', at: Date.now() });
dispatch({ type: 'blocks', blocks: [
  { kind: 'step', text: '早段：第一步', state: 'done', icon: 'read' },
  { kind: 'paragraph', text: '中间的说明文字' },
  { kind: 'step', text: '晚段：第二步', state: 'done', icon: 'code' },
  { kind: 'paragraph', text: '末尾的文字' },
] });
const groups = harness.queryAll('.ast-steps');
check('多个步骤段：只渲染一组执行过程', groups.length === 1, 'groups=' + groups.length);
check('多个步骤段：计数包含两段', textOf(groups[0]).indexOf('2 步') >= 0, 'head=' + textOf(groups[0]));
check('多个步骤段：中间文字仍保留', harness.messages.textContent.indexOf('中间的说明文字') >= 0);
check('多个步骤段：执行过程在最后一段位置', harness.messages.lastElementChild === groups[0].parentElement || harness.messages.textContent.lastIndexOf('末尾的文字') > harness.messages.textContent.lastIndexOf('中间的说明文字'));
dispatch({ type: 'clear' });
/* ------------- 9c13. 生图步骤显示缩略图 ------------- */

dispatch({ type: 'clear' });
dispatch({ type: 'user', text: '生图', at: Date.now() });
dispatch({ type: 'blocks', blocks: [{ kind: 'step', text: '已完成图片生成', state: 'done', icon: 'image', images: ['https://x/a.png', 'https://x/b.png'] }] });
const stepImgs = harness.queryAll('.ast-step-images img');
check('生图步骤：显示两张缩略图', stepImgs.length === 2, 'count=' + stepImgs.length);
check('生图步骤：图片地址正确', stepImgs[0] && stepImgs[0].src === 'https://x/a.png', 'src=' + (stepImgs[0] && stepImgs[0].src));
dispatch({ type: 'clear' });
/* ------------- 9c14. blocks 文本里的管道表要渲染成表格 ------------- */

dispatch({ type: 'clear' });
dispatch({ type: 'user', text: '表格', at: Date.now() });
dispatch({ type: 'blocks', blocks: [{ kind: 'text', text: '表格\n| 时间 | 产物 |\n| --- | --- |\n| 14:17 | report.json |\n| 14:36 | steps.json |' }] });
const astTable = harness.query('.ast-table');
check('管道表：渲染成 .ast-table', Boolean(astTable));
check('管道表：表头两列', astTable && astTable.querySelectorAll('th').length === 2);
check('管道表：两行数据', astTable && astTable.querySelectorAll('tbody tr').length === 2, 'rows=' + (astTable ? astTable.querySelectorAll('tbody tr').length : 0));
check('管道表：不再显示原始竖线', harness.messages.textContent.indexOf('| 时间 |') < 0);
dispatch({ type: 'clear' });
/* ------------- 9c15. 流式输出里的管道表也要渲染 ------------- */

dispatch({ type: 'clear' });
dispatch({ type: 'user', text: '流式表格', at: Date.now() });
dispatch({ type: 'assistant_delta', text: '原因：\n| 文件 | 报错符号 |\n| --- | --- |\n| SaveService.cs | Encoding |\n' });
harness.flush();
const streamTable = harness.query('.msg-assistant .ast-table') || harness.query('.ast-table');
check('流式管道表：渲染成表格', Boolean(streamTable));
check('流式管道表：两列一行数据', streamTable && streamTable.querySelectorAll('th').length === 2 && streamTable.querySelectorAll('tbody tr').length === 1);
dispatch({ type: 'assistant_done', aborted: false, at: Date.now() });
check('流式管道表：结束后仍在', Boolean(harness.query('.ast-table')));
dispatch({ type: 'clear' });
/* ------------- 9c16. 表格被压成一行时也能还原 ------------- */

dispatch({ type: 'clear' });
dispatch({ type: 'user', text: '塌缩表格', at: Date.now() });
dispatch({ type: 'blocks', blocks: [{ kind: 'text', text: '表格 | 文件 | 报错符号 | 缺失的 using | --- | --- | --- | A.cs | Encoding | System.Text |' }] });
const flatTable = harness.query('.ast-table');
check('单行表格：能还原成表格', Boolean(flatTable));
check('单行表格：三列', flatTable && flatTable.querySelectorAll('th').length === 3, 'th=' + (flatTable ? flatTable.querySelectorAll('th').length : 0));
check('单行表格：一行数据', flatTable && flatTable.querySelectorAll('tbody tr').length === 1);
dispatch({ type: 'clear' });
/* ------------- 9c17. 豆包询问卡片渲染与回传 ------------- */

dispatch({ type: 'clear' });
dispatch({ type: 'ask', question: { title: '「登录后的参考皮」指哪种形态？', options: [
  { value: 'option_1', label: '1 重定向覆盖登录后' },
  { value: 'option_2', label: '2 登录后直接用原版帧' },
], allowCustom: true } });
const askCard = harness.query('.ask-card');
check('询问卡片：渲染标题', Boolean(askCard) && textOf(askCard).indexOf('指哪种形态') >= 0);
check('询问卡片：两个选项', askCard && askCard.querySelectorAll('.ask-option').length === 2);
check('询问卡片：提示可自定义', Boolean(askCard) && textOf(askCard).indexOf('自定义') >= 0);
const askBtn = askCard && askCard.querySelector('.ask-option');
if (askBtn && askBtn.click) askBtn.click();
const askPost = harness.posted.filter(function (m) { return m && m.type === 'askAnswer'; });
check('询问卡片：点选后回传 value', askPost.length === 1 && askPost[0].value === 'option_1', JSON.stringify(askPost));
dispatch({ type: 'clear' });
/* ------------- 9c18. 塌缩表格用空单元格分隔行 ------------- */

dispatch({ type: 'clear' });
dispatch({ type: 'user', text: '塌缩行', at: Date.now() });
dispatch({ type: 'blocks', blocks: [{ kind: 'text', text: '表格 | 批次 | 屏 | 新增条目 | --- | --- | --- | joystick | 2 | | 二 | talk | 4 | | 三 | mainui | 2 |' }] });
const segTable = harness.query('.ast-table');
check('空单元格分行的表格：渲染', Boolean(segTable));
check('空单元格分行的表格：三行', segTable && segTable.querySelectorAll('tbody tr').length === 3, 'rows=' + (segTable ? segTable.querySelectorAll('tbody tr').length : 0));
dispatch({ type: 'clear' });
/* ------------- 9c19. Claude 风格：代码/表格可折叠 ------------- */

dispatch({ type: 'clear' });
dispatch({ type: 'user', text: '折叠', at: Date.now() });
dispatch({ type: 'ast', blocks: [
  { kind: 'code', text: 'const a = 1;\nconst b = 2;', lang: 'js' },
  { kind: 'table', head: ['A', 'B'], rows: [['1', '2']] },
] });
const folds = harness.queryAll('.ast-fold');
check('折叠：代码与表格各一个折叠块', folds.length === 2, 'count=' + folds.length);
check('折叠：代码头显示语言/行数', textOf(folds[0]).indexOf('JS') >= 0 && textOf(folds[0]).indexOf('2 行') >= 0);
check('折叠：表格头显示行数', textOf(folds[1]).indexOf('表格') >= 0 && textOf(folds[1]).indexOf('1 行') >= 0);
const foldHead = folds[0].querySelector('.ast-fold-head');
if (foldHead && foldHead.click) foldHead.click();
check('折叠：点代码头收起内容', folds[0].querySelector('.ast-fold-body').classList.contains('hidden'));
if (foldHead && foldHead.click) foldHead.click();
check('折叠：再点展开', !folds[0].querySelector('.ast-fold-body').classList.contains('hidden'));
dispatch({ type: 'clear' });
/* ------------- 9c20. 操作条只出现在整轮结束 ------------- */

dispatch({ type: 'clear' });
dispatch({ type: 'user', text: '分段', at: Date.now() });
dispatch({ type: 'assistant_delta', text: '第一段' });
dispatch({ type: 'tool_start', id: 't1', name: 'read_file', arguments: { path: 'a.cs' } });
dispatch({ type: 'tool_end', id: 't1', name: 'read_file', ok: true, content: 'ok' });
dispatch({ type: 'assistant_delta', text: '第二段' });
dispatch({ type: 'assistant_done', aborted: false, at: Date.now() });
const foots = harness.queryAll('.msg-foot-assistant');
check('分段输出：操作条只出现一次', foots.length === 1, 'count=' + foots.length);
const msgNodes = harness.messages.querySelectorAll('.msg');
check('分段输出：操作条在最后一轮气泡里', foots[0] && msgNodes.length > 0 && msgNodes[msgNodes.length - 1].contains(foots[0]));
dispatch({ type: 'clear' });
/* ------------- 9c21. 全部收起 / 全部展开 ------------- */

dispatch({ type: 'clear' });
dispatch({ type: 'user', text: '全折叠', at: Date.now() });
dispatch({ type: 'ast', blocks: [
  { kind: 'step', text: '步骤一', state: 'done', icon: 'read' },
  { kind: 'code', text: 'const a = 1;', lang: 'js' },
  { kind: 'table', head: ['A'], rows: [['1']] },
] });
const foldBar = harness.query('.ast-fold-bar');
check('全部折叠：出现工具栏', Boolean(foldBar) && foldBar.querySelectorAll('button').length === 2);
const btnAll = foldBar ? foldBar.querySelectorAll('button') : [];
if (btnAll[0] && btnAll[0].click) btnAll[0].click();
const bodiesClosed = harness.queryAll('.ast-fold-body').every(function (b) { return b.classList.contains('hidden'); });
const stepsClosed = harness.query('.ast-steps-body');
check('全部收起：代码/表格/执行过程都收起', bodiesClosed && (!stepsClosed || stepsClosed.classList.contains('hidden')) && (!harness.query('.ast-steps-wrap') || harness.query('.ast-steps-wrap').classList.contains('hidden')));
if (btnAll[1] && btnAll[1].click) btnAll[1].click();
const bodiesOpen = harness.queryAll('.ast-fold-body').every(function (b) { return !b.classList.contains('hidden'); });
check('全部展开：代码/表格都展开', bodiesOpen && (!harness.query('.ast-steps-body') || !harness.query('.ast-steps-body').classList.contains('hidden')));
dispatch({ type: 'clear' });
/* ------------- 9c22. 全部收起操作非执行内容 + 流式与 blocks 不重复 ------------- */

dispatch({ type: 'clear' });
dispatch({ type: 'user', text: '内容折叠', at: Date.now() });
dispatch({ type: 'ast', blocks: [{ kind: 'paragraph', text: '普通说明文字' }, { kind: 'code', text: 'x=1', lang: 'js' }] });
const contentBar = harness.query('.ast-fold-bar');
check('内容折叠：工具栏存在', Boolean(contentBar));
if (contentBar) contentBar.querySelectorAll('button')[0].click();
const contents = harness.queryAll('.ast-msg-content');
check('内容折叠：全部收起后正文隐藏', contents.length > 0 && contents.every(function (n) { return n.classList.contains('hidden'); }));
if (contentBar) contentBar.querySelectorAll('button')[1].click();
check('内容折叠：全部展开后正文可见', harness.queryAll('.ast-msg-content').every(function (n) { return !n.classList.contains('hidden'); }));

dispatch({ type: 'clear' });
dispatch({ type: 'user', text: '重复', at: Date.now() });
dispatch({ type: 'assistant_delta', text: '同一段文字' });
dispatch({ type: 'blocks', blocks: [{ kind: 'text', text: '同一段文字' }] });
const occurrences = (harness.messages.textContent.match(/同一段文字/g) || []).length;
check('去重：流式与 blocks 同段只显示一次', occurrences === 1, 'count=' + occurrences);
dispatch({ type: 'clear' });
/* ------------- 9c23. 收起后新内容也保持收起 ------------- */

dispatch({ type: 'clear' });
dispatch({ type: 'user', text: '持续收起', at: Date.now() });
dispatch({ type: 'ast', blocks: [{ kind: 'paragraph', text: '第一段' }] });
const bar2 = harness.query('.ast-fold-bar');
if (bar2) bar2.querySelectorAll('button')[0].click();
dispatch({ type: 'ast', blocks: [{ kind: 'paragraph', text: '第二段' }] });
const contents2 = harness.queryAll('.ast-msg-content');
check('持续收起：新内容仍保持隐藏', contents2.length >= 1 && contents2.every(function (n) { return n.classList.contains('hidden'); }), 'count=' + contents2.length);
dispatch({ type: 'clear' });
/* ------------- 9c24. 历史回放里的表格 ------------- */

dispatch({ type: 'clear' });
dispatch({ type: 'history', title: '历史测试', turns: [
  { role: 'user', text: '问' },
  { role: 'assistant', text: '表格 | A | B | --- | --- | | 1 | 2 |' },
] });
const historyTable = harness.query('.msg-assistant .ast-table') || harness.query('.ast-table');
check('历史回放：表格渲染成表格', Boolean(historyTable));
check('历史回放：两列', historyTable && historyTable.querySelectorAll('th').length === 2);
dispatch({ type: 'clear' });
/* ------------- 9c25. 找不到的图片显示占位，不裂图 ------------- */

dispatch({ type: 'clear' });
dispatch({ type: 'image', url: 'parity-step-14-enter-city.png', alt: 'parity-step-14-enter-city.png' });
check('图片缺失：显示占位 chip', Boolean(harness.query('.img-missing')));
check('图片缺失：不渲染破图 img', !harness.query('.msg img[src="parity-step-14-enter-city.png"]'));
dispatch({ type: 'clear' });
/* ------------- 9c27. 任务标签页 ------------- */

dispatch({ type: 'clear' });
dispatch({ type: 'tabs', tabs: [
  { id: 'tab-a', title: '任务A', active: true, desktopTitle: '豆包A' },
  { id: 'tab-b', title: '任务B', active: false, desktopTitle: '' },
] });
check('标签页：渲染两个', harness.queryAll('.tab-item').length === 2);
check('标签页：当前项高亮', Boolean(harness.query('.tab-item.active')));
check('标签页：每项有关闭按钮', harness.queryAll('.tab-close').length === 2);
dispatch({ type: 'tabs', tabs: [
  { id: 'tab-a', title: '任务A', active: true, running: true, desktopTitle: '' },
] });
check('标签页：执行中显示小圆点', Boolean(harness.query('.tab-dot')));
dispatch({ type: 'tabs', tabs: [] });
const chatSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.js'), 'utf8');
check('子智能体步骤：注册 agent 图标', chatSource.indexOf("agent: '<svg") >= 0);
dispatch({ type: 'clear' });
dispatch({ type: 'proposal', id: 'p1', path: 'src/a.ts', before: 'old', after: 'new content' });
check('审阅卡片：渲染标题与按钮', Boolean(harness.query('.proposal-card')) && harness.queryAll('.proposal-actions .btn').length === 3);
dispatch({ type: 'clear' });
dispatch({ type: 'verifyResult', kind: 'build', ok: false, code: 1, command: 'npm run build', output: 'error TS1005' });
check('验证卡片：显示失败与输出', Boolean(harness.query('.verify-card.fail')) && harness.query('.verify-output').textContent.indexOf('TS1005') >= 0);
check('验证卡片：问豆包按钮', Boolean(harness.query('.verify-ask')));
dispatch({ type: 'verifyResult', kind: 'build', ok: false, code: 1, command: 'npm run build', output: 'x', locations: [{ path: 'src/a.ts', line: 12 }] });
check('验证定位：错误位置可点击', harness.queryAll('.verify-location').length === 1 && harness.query('.verify-location').getAttribute('data-line') !== undefined || harness.queryAll('.verify-location').length === 1);
dispatch({ type: 'clear' });
dispatch({ type: 'setup', state: { installed: true, running: false, loggedIn: false, ready: false, step: 'launch', detail: '调试端口连接不成功' } });
check('初始化指引：提示安装/重启/登录/重试', harness.body.textContent.indexOf('重启计算机') >= 0 && harness.body.textContent.indexOf('登录账号') >= 0);
dispatch({ type: 'setup', state: { installed: true, running: true, loggedIn: true, ready: true, step: 'ready', detail: 'ok' } });
/* 生成能力单选互斥 */
const quickButtons = harness.queryAll('.chat-action');
const quickImage = quickButtons.find(function (b) { return b.getAttribute('data-chat-action') === 'image'; });
const quickVideo = quickButtons.find(function (b) { return b.getAttribute('data-chat-action') === 'video'; });
if (quickImage && quickVideo) {
  quickImage.click ? quickImage.click() : null;
  check('生成能力：选中图像', quickImage.classList.contains('active') && harness.byId('input').value === '生成图片：');
  quickVideo.click ? quickVideo.click() : null;
  check('生成能力：切换为视频且互斥', quickVideo.classList.contains('active') && !quickImage.classList.contains('active') && harness.byId('input').value === '生成视频：');
  quickVideo.click ? quickVideo.click() : null;
  check('生成能力：再点取消', !quickVideo.classList.contains('active') && harness.byId('input').value === '');
}

check('标签页：为空时隐藏', harness.query('.tab-bar').classList.contains('hidden'));
dispatch({ type: 'syncLoading', on: true, text: '正在同步任务内容…' });
const syncBar = harness.query('.sync-loading');
check('同步加载条：显示 spinner 与文案', Boolean(syncBar) && !syncBar.classList.contains('hidden') && Boolean(harness.query('.sync-spinner')) && syncBar.textContent.indexOf('正在同步任务内容') >= 0);
dispatch({ type: 'syncLoading', on: false });
check('同步加载条：完成后隐藏', harness.query('.sync-loading').classList.contains('hidden'));
dispatch({ type: 'clear' });
/* ------------- 9d. 重复下发 blocks 不能把整段内容再追加一份 ------------- */

// 回归：计时分隔线在忙时会被移到最底部，旧代码用 `.ast-blocks:last-child` 找容器，
// 每次都找不到 → 每秒追加一份完整对话，界面上整段内容重复。
dispatch({ type: 'blocks', blocks: [{ kind: 'text', text: '去重甲' }] });
dispatch({ type: 'state', busy: true, mode: 'local', permission: 'risk', authMode: 'desktop', turns: 1 });
dispatch({ type: 'blocks', blocks: [{ kind: 'text', text: '去重乙' }] });
const blockWraps = harness.queryAll('.ast-blocks');
check('blocks 重复下发：只保留一份 .ast-blocks', blockWraps.length === 1, 'count=' + blockWraps.length);
check('blocks 重复下发：内容被整体替换而不是叠加',
  blockWraps.length === 1 && textOf(blockWraps[0]).indexOf('去重甲') < 0 && textOf(blockWraps[0]).indexOf('去重乙') >= 0,
  'text=' + (blockWraps[0] ? textOf(blockWraps[0]) : '(无)'));

// 新一轮必须新建容器：上一轮的回答要保留，不能被新分块覆盖。
dispatch({ type: 'user', text: '下一轮', at: Date.now() });
dispatch({ type: 'blocks', blocks: [{ kind: 'text', text: '第二轮' }] });
const turnWraps = harness.queryAll('.ast-blocks');
check('新一轮：上一轮分块保留 + 新分块进新容器',
  turnWraps.length === 2 && textOf(turnWraps[0]).indexOf('去重乙') >= 0 && textOf(turnWraps[1]).indexOf('第二轮') >= 0,
  'count=' + turnWraps.length + ' texts=' + Array.prototype.map.call(turnWraps, textOf).join(' | '));
dispatch({ type: 'clear' });
/* ------------- 9e. 「已处理」放在回答顶部，且每条回答各一条 ------------- */

dispatch({ type: 'clear' });
dispatch({ type: 'user', text: '顶部定位测试' });
function kidsOfMessages() {
  return Array.prototype.slice.call(harness.byId('messages').children || []);
}
function indexOfClass(kids, name) {
  for (let i = 0; i < kids.length; i += 1) {
    if (String(kids[i].className || '').indexOf(name) >= 0) return i;
  }
  return -1;
}
const kids1 = kidsOfMessages();
const divIdx1 = indexOfClass(kids1, 'turn-divider');
const asIdx1 = indexOfClass(kids1, 'msg-assistant');
check('分隔线：发送后位于回答上方', divIdx1 >= 0 && asIdx1 > divIdx1, 'order=' + kids1.map(function (k) { return String(k.className || ''); }).join(' | '));

dispatch({ type: 'blocks', blocks: [{ kind: 'text', text: '顶部内容' }] });
const kids2 = kidsOfMessages();
const divIdx2 = indexOfClass(kids2, 'turn-divider');
const blkIdx2 = indexOfClass(kids2, 'ast-blocks');
check('分隔线：分块渲染后仍在内容上方', divIdx2 >= 0 && blkIdx2 > divIdx2, 'order=' + kids2.map(function (k) { return String(k.className || ''); }).join(' | '));
check('分隔线：没有被挪到对话最底部', divIdx2 >= 0 && divIdx2 < kids2.length - 1, 'div=' + divIdx2 + ' last=' + (kids2.length - 1));

dispatch({ type: 'syncStatus', text: '共用时 1 分 0 秒', seconds: 60, done: true });
check('分隔线：结束后文案切到「共用时」', textOf(harness.query('.turn-label')).indexOf('共用时') === 0, 'label=' + textOf(harness.query('.turn-label')));
dispatch({ type: 'state', busy: true, mode: 'local', permission: 'risk', authMode: 'desktop', turns: 2 });
check('分隔线：结束后的陈旧 busy 不会把「共用时」切回「已处理」', textOf(harness.query('.turn-label')).indexOf('共用时') === 0, 'label=' + textOf(harness.query('.turn-label')));
dispatch({ type: 'user', text: '第二轮顶部测试' });
const labels = harness.queryAll('.turn-label');
check('分隔线：新一轮各建一条，旧的一条保留', labels.length === 2, 'count=' + labels.length);
check('分隔线：旧的一条仍显示「共用时」', labels.length === 2 && textOf(labels[0]).indexOf('共用时') === 0, 'first=' + (labels[0] ? textOf(labels[0]) : '(无)'));
const kids3 = kidsOfMessages();
const firstBlocksIdx = indexOfClass(kids3, 'ast-blocks');
const secondDivIdx = kids3.map(function (k) { return String(k.className || ''); }).lastIndexOf('turn-divider');
check('分隔线：新一轮的分隔线在上一轮分块之后（不会插到上面）', secondDivIdx > firstBlocksIdx, 'blocks=' + firstBlocksIdx + ' divider2=' + secondDivIdx);

// 同一用户轮里的后续输出（PTC 多轮）应恢复计时，而不是被「共用时」卡住
dispatch({ type: 'syncStatus', text: '共用时 2 分 0 秒', seconds: 120, done: true });
check('分隔线：第二轮结束后显示「共用时」', textOf(labels[1]).indexOf('共用时') === 0, 'label=' + textOf(labels[1]));
dispatch({ type: 'assistant_delta', text: '继续输出' });
check('分隔线：同一轮后续输出恢复为「已处理」', textOf(labels[1]).indexOf('已处理') === 0, 'label=' + textOf(labels[1]));
dispatch({ type: 'clear' });
/* ------------------------------ 10. 错误 ------------------------------ */

dispatch({ type: 'error', message: 'boom' });
const errorBox = harness.query('.msg-error');
check('error：出现 .msg-error 错误卡片', Boolean(errorBox));
check('error：错误信息包含 boom', hasText(errorBox, 'boom'), 'text=' + textOf(errorBox));

/* ------------------------------ 11. 工具调用 ------------------------------ */

dispatch({ type: 'tool_start', id: 't1', name: 'run_terminal', arguments: { command: 'dir' } });
const toolLine = harness.query('.tool-line');
check('tool_start：出现 .tool-line', Boolean(toolLine));
check('tool_start：初始为 running 状态', Boolean(toolLine && toolLine.classList.contains('running')), 'class=' + (toolLine ? toolLine.className : '(无)'));
check('tool_start：命令文本包含 dir', hasText(toolLine, 'dir'), 'text=' + textOf(toolLine));

dispatch({ type: 'tool_end', id: 't1', name: 'run_terminal', ok: true, content: 'ok' });
const doneLine = harness.query('.tool-line');
check('tool_end：工具卡片标记 ok', Boolean(doneLine && doneLine.classList.contains('ok')), 'class=' + (doneLine ? doneLine.className : '(无)'));
check('tool_end：状态点变为 ✓', Boolean(doneLine && hasText(doneLine.querySelector('.tool-line-state'), '✓')), 'state=' + (doneLine ? textOf(doneLine.querySelector('.tool-line-state')) : '(无)'));
check('tool_end：结果 pre 内容为 ok', Boolean(doneLine && hasText(doneLine.querySelector('.tool-result'), 'ok')), 'result=' + (doneLine ? textOf(doneLine.querySelector('.tool-result')) : '(无)'));

/* ------------------------------ 12. 清空 ------------------------------ */

dispatch({ type: 'clear' });
check('#messages 里只剩 #empty', harness.messages.children.length === 1 && harness.messages.children[0] === harness.empty, 'children=' + harness.messages.children.map(function (node) { return node.id || node.className; }).join(','));
check('clear：旧消息与工具卡片都被移除', !harness.query('.msg') && !harness.query('.tool-line'));
check('clear：#empty 恢复可见', !harness.empty.classList.contains('hidden'));

/* ------------------------------ 13. 关键函数存在性 ------------------------------ */

// 这里故意用「函数声明」精确匹配，避免 showPending 命中 showPendingDelayed、
// addNativeBlock 命中 renderNativeBlocks 这类前缀误报。
const requiredFunctions = [
  'renderAst',
  'renderNativeBlocks',
  'addNativeBlock',
  'echoUserMessage',
  'showPending',
  'showPendingDelayed',
  'hidePending',
  'addMessage',
  'markdown',
];
for (const name of requiredFunctions) {
  const pattern = new RegExp('function\\s+' + name + '\\s*\\(', 'g');
  const count = (source.match(pattern) || []).length;
  check('函数存在且唯一定义：function ' + name, count === 1, '匹配 ' + count + ' 次');
}

/* ------------------------------ 汇总 ------------------------------ */

check('全部消息分派过程中无异常', dispatchErrors.length === 0, dispatchErrors.map(function (item) { return item.type + ': ' + (item.error && item.error.message ? item.error.message : String(item.error)); }).slice(0, 3).join(' | '));

console.log('\n结果：PASS ' + pass + '，FAIL ' + fail);
if (fail > 0 && bootError) {
  console.log('启动失败，后续状态断言均不可信：' + (bootError.stack || bootError));
}
harness.dispose();
process.exitCode = fail === 0 ? 0 : 1;
