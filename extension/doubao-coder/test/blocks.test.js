/** 纯函数回归：计时解析 / 格式化 / 块归一化（不依赖页面）。 */
'use strict';

const { parseElapsedSeconds, formatElapsed, formatElapsedLabel, isFinishedElapsed, normalizeReplyBlocks, blocksToMarkdown, stepTitle, inferStepIcon } =
  require('../out/bridge/blocks.js');

let pass = 0;
let fail = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + ' → ' + JSON.stringify(actual) + ' != ' + JSON.stringify(expected)); }
}

eq('秒：已处理 12 秒', parseElapsedSeconds('已处理 12 秒'), 12);
eq('分秒：已处理 5 分 52 秒', parseElapsedSeconds('已处理 5 分 52 秒'), 352);
eq('共用时：共用时 4 分 55 秒', parseElapsedSeconds('共用时 4 分 55 秒'), 295);
eq('时分秒：1 小时 2 分 3 秒', parseElapsedSeconds('1 小时 2 分 3 秒'), 3723);
eq('读不到：空串', parseElapsedSeconds(''), -1);
eq('读不到：正在执行代码', parseElapsedSeconds('正在执行代码'), -1);

eq('格式化：45 秒', formatElapsed(45), '45 秒');
eq('格式化：352 秒', formatElapsed(352), '5 分 52 秒');
eq('格式化：3723 秒', formatElapsed(3723), '1 小时 2 分 3 秒');
eq('标签：已处理', formatElapsedLabel(352), '已处理 5 分 52 秒');
eq('标签：共用时', formatElapsedLabel(295, '共用时'), '共用时 4 分 55 秒');
eq('结束判定：共用时', isFinishedElapsed('共用时 4 分 55 秒'), true);
eq('结束判定：已处理', isFinishedElapsed('已处理 4 分 55 秒'), false);

const blocks = normalizeReplyBlocks([
  { kind: 'status', text: '已处理 5 分 52 秒' },
  { kind: 'text', text: '正文' },
  { kind: 'step', text: '已执行代码 dir', state: 'running' },
  { kind: 'step', text: '桌面授权超时', state: 'error', detail: '详情' },
  { kind: 'step', text: '空详情', detail: '空详情' },
  { kind: 'unknown', text: '丢弃' },
  { kind: 'text', text: '   ' },
]);
eq('归一化：丢掉未知块与空块', blocks.length, 5);
eq('归一化：running 状态保留', blocks[2].state, 'running');
eq('归一化：error 详情保留', blocks[3].detail, '详情');
eq('归一化：detail 与标题相同则不重复', blocks[4].detail, undefined);
eq('正文只拼 text 块', blocksToMarkdown(blocks), '正文');
eq('步骤标题取首行', stepTitle({ kind: 'step', text: '第一行\n第二行' }), '第一行');

eq('图标：已执行代码 → code', inferStepIcon('已执行代码 dir'), 'code');
eq('图标：已读取 → read', inferStepIcon('已读取 C:\\a.txt'), 'read');
eq('图标：已查找文件内容 → search', inferStepIcon('已查找文件内容 foo'), 'search');
eq('图标：已写入 → edit', inferStepIcon('已写入 a.ts'), 'edit');
eq('图标：页面图标兜底 shellexec → code', inferStepIcon('Unity 项目信息', 'shellexec'), 'code');
eq('图标：页面图标兜底 fileview → read', inferStepIcon('验证历史运行状态', 'fileview'), 'read');
eq('图标：识别不出 → step', inferStepIcon('提交本轮操作报告'), 'step');
eq('图标：裸「读取…」也算 read', inferStepIcon('读取会话状态文件'), 'read');
eq('图标：页面图标优先于无法识别的标题', inferStepIcon('当前主 UI 界面特征', 'shellexec'), 'code');
const icons = normalizeReplyBlocks([{ kind: 'step', text: '已读取 x', state: 'done' }]);
eq('归一化：step 带图标类型', icons[0].icon, 'read');

const { parseMarkdownBlocks } = require('../out/chat/ast.js');
const mdTable = parseMarkdownBlocks('| 文件 | 改动 |\n| --- | --- |\n| A.cs | 新增 |\n');
const tb = mdTable.find(function (b) { return b.kind === 'table'; });
eq('table：管道表解析为 table 分块', Boolean(tb), true);
eq('table：表头两列', tb && tb.head, ['文件', '改动']);
eq('table：一行数据', tb && tb.rows, [['A.cs', '新增']]);

const imgBlocks = normalizeReplyBlocks([
  { kind: 'step', text: '已完成图片生成', state: 'done', images: ['https://x/a.png', 'data:image/png;base64,AAA', 'javascript:bad'] },
  { kind: 'step', text: '普通步骤' },
]);
eq('步骤图片：保留合法图片', imgBlocks[0].images, ['https://x/a.png', 'data:image/png;base64,AAA']);
eq('步骤图片：无图片时不带字段', imgBlocks[1].images, undefined);

console.log('\n结果：PASS ' + pass + '，FAIL ' + fail);
process.exit(fail ? 1 : 0);